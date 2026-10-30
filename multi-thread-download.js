// 下载视频 - 多线程下载
//
// Bilibili Evolved plugin. Adds two outputs to 下载视频 that fetch every stream with several
// connections spread over several CDN nodes:
//   - 多线程下载（保存到文件夹）: each stream is written straight into a file in a folder you
//     pick (File System Access API, Chrome / Edge). Without that API the file is kept in memory
//     and saved as an ordinary browser download.
//   - 多线程下载 + WASM 混流: video and audio are muxed into one file with FFmpeg (WASM), with
//     the same FFmpeg files, cache and arguments as Evolved's own "WASM 混流输出"
//     (WakelessSloth56, LainIO24; MIT).
//
// Why: 下载视频 picks one address per stream and fetches it whole. Some upos mirror nodes
// (upos-sz-mirrorcosov, for one) answer a request without a Range header with HTTP 567 and an
// 8.5 KB error page, which the built-in StreamSaver output saves as the video. This plugin
// - only sends Range requests and keeps a response only if it is a 206 for the bytes asked;
// - uses every address Bilibili returned and, optionally, the same signed path on other
//   Mirror nodes (Bilibili-Evolved#3234), testing each node before using it;
// - downloads fixed-size chunks over N connections, gives faster nodes more of them, aborts a
//   connection that stalls or lags far behind and resumes its chunk elsewhere, splits the last
//   chunks between idle connections, and bans failing nodes for a while;
// - fetches through a blank iframe's fetch, so scripts that hook window.fetch (playback
//   accelerators, for one) cannot take the requests over.
// The built-in StreamSaver output is taken out of the list (HIDE_STREAMSAVER).
!function (root, factory) {
  "object" == typeof exports && "object" == typeof module ? module.exports = factory()
    : "function" == typeof define && define.amd ? define([], factory)
      : "object" == typeof exports ? exports["video/download/multi-thread"] = factory()
        : root["video/download/multi-thread"] = factory();
}(globalThis, () => {
  "use strict";

  const TITLE = "多线程下载";
  const HIDE_STREAMSAVER = true;
  const MiB = 1024 * 1024;
  const THREAD_CHOICES = [2, 4, 6, 8, 12, 16];
  const CHUNK_CHOICES = [2, 4, 8, 16];
  const OUTPUT_TYPES = ["auto", "mp4", "matroska"];
  const DEFAULT_OPTIONS = { threads: 6, chunkMB: 8, expandHosts: true, outputType: "auto", muxWithMetadata: false, attachCover: false };
  const OPTION_KEYS = {
    threads: "multiThreadThreads",
    chunkMB: "multiThreadChunkMB",
    expandHosts: "multiThreadExpandHosts",
    outputType: "multiThreadOutputType",
    muxWithMetadata: "multiThreadMuxWithMetadata",
    attachCover: "multiThreadAttachCover",
  };
  // A node test that has not answered by then counts as failed.
  const PROBE_MS = 6000;
  // A connection without its first byte for FIRST_BYTE_MS, or without any byte for STALL_MS, is
  // aborted and its chunk resumed elsewhere.
  const FIRST_BYTE_MS = 10000;
  const STALL_MS = 6000;
  // A connection running for SLOW_AFTER_MS at under SLOW_RATIO of the best node's speed hands
  // its chunk back, so a slow node does not hold a connection slot.
  const SLOW_AFTER_MS = 4000;
  const SLOW_RATIO = 0.25;
  // Received bytes are written out in pieces of about this size.
  const FLUSH_BYTES = MiB;
  // The last chunks are split between idle connections down to this size.
  const MIN_SPLIT_BYTES = MiB;
  const MAX_CHUNK_FAILURES = 8;
  // 2000 MiB, Evolved's own limit for muxing in the browser.
  const MAX_MUX_BYTES = 2097152000;
  const CACHE_DB = "bilibili-evolved-wasm-output";
  const CACHE_STORE = "cache";
  // Mirror and UPOS nodes that accepted a signed upos address moved over from another node.
  const EXTRA_HOSTS = [
    "upos-sz-mirrorali.bilivideo.com",
    "upos-sz-mirrorhw.bilivideo.com",
    "upos-sz-mirrorbos.bilivideo.com",
    "upos-sz-mirror08c.bilivideo.com",
    "upos-sz-mirrorbd.bilivideo.com",
    "upos-sz-mirror14b.bilivideo.com",
    "upos-sz-mirrorcos.bilivideo.com",
    "upos-sz-mirrorcoso1.bilivideo.com",
    "upos-sz-estgoss.bilivideo.com",
    "upos-sz-mirrorcosov.bilivideo.com",
    "upos-sz-mirroraliov.bilivideo.com",
    "cn-hk-eq-01-01.bilivideo.com",
    "cn-hk-eq-01-03.bilivideo.com",
  ];

  const page = typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;
  const api = () => coreApis;

  class CancelledError extends Error {
    constructor(message = "已取消") {
      super(message);
      this.name = "CancelledError";
    }
  }
  const throwIfCancelled = signal => {
    if (signal?.aborted) throw signal.reason instanceof CancelledError ? signal.reason : new CancelledError();
  };
  const escapeHtml = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const hostOf = url => { try { return new URL(url).hostname; } catch (_error) { return ""; } };

  // ---------------------------------------------------------------- network

  // A blank iframe's fetch is the browser's own, whatever the page or other scripts did to
  // window.fetch. It sends no Referer by itself, and the CDN answers 403 without one.
  let cleanFrame = null;
  function cleanFetch(url, init = {}) {
    const doc = page.document;
    if (!cleanFrame?.isConnected) {
      cleanFrame = doc.createElement("iframe");
      cleanFrame.style.display = "none";
      cleanFrame.setAttribute("aria-hidden", "true");
      (doc.body || doc.documentElement).appendChild(cleanFrame);
    }
    const frameWindow = cleanFrame.contentWindow;
    const fetcher = typeof frameWindow?.fetch === "function" ? frameWindow.fetch.bind(frameWindow) : globalThis.fetch.bind(globalThis);
    return fetcher(url, { ...init, referrer: page.location.href, credentials: "omit", cache: "no-store" });
  }

  function contentRange(response) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get("content-range") || "");
    return match ? { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? null : Number(match[3]) } : null;
  }

  // A P2P / edge relay (mcdn, a bare IP:port, /v1/resource/) wraps the file in its own path and
  // signature, so its address cannot be moved to another node.
  function isRelay(url) {
    try {
      const parsed = new URL(url);
      return /mcdn/i.test(parsed.hostname) || (parsed.port !== "" && parsed.port !== "443")
        || /^\/v1\/resource\//.test(parsed.pathname) || parsed.searchParams.get("os") === "mcdn";
    } catch (_error) {
      return true;
    }
  }

  function candidateUrls(fragment, expandHosts) {
    const originals = [...new Set([fragment.url, ...(fragment.allUrls || [])]
      .filter(Boolean)
      .map(url => String(url).replace(/^http:/, "https:")))];
    if (!expandHosts) return originals;
    const movable = originals.filter(url => !isRelay(url));
    const donor = movable.find(url => !hostOf(url).endsWith(".akamaized.net")) || movable[0];
    if (!donor) return originals;
    const moved = EXTRA_HOSTS.map(host => {
      const url = new URL(donor);
      url.hostname = host;
      url.port = "";
      return url.href;
    });
    return [...new Set([...originals, ...moved])];
  }

  // Tests every candidate with a one-byte Range request. The file size most nodes agree on
  // wins; a node reporting another size serves another file and is left out.
  async function probeNodes(urls, signal, knownSpeeds) {
    const results = await Promise.all(urls.map(async url => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_MS);
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const started = performance.now();
      try {
        const response = await cleanFetch(url, { headers: { Range: "bytes=0-0" }, signal: controller.signal });
        const ttfb = performance.now() - started;
        response.body?.cancel().catch(() => {});
        const range = contentRange(response);
        if (response.status === 206 && range?.total > 0) return { url, ttfb, total: range.total };
        return { url, error: `HTTP ${response.status}` };
      } catch (error) {
        return { url, error: error?.name === "AbortError" ? "超时" : String(error?.message || error) };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    }));
    throwIfCancelled(signal);
    const answered = results.filter(result => result.total);
    const votes = new Map();
    for (const { total } of answered) votes.set(total, (votes.get(total) || 0) + 1);
    const total = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const nodes = answered.filter(result => result.total === total).map(({ url, ttfb }) => ({
      url,
      host: hostOf(url),
      ttfb,
      speed: knownSpeeds.get(hostOf(url)) || 0,
      active: 0,
      failures: 0,
      bannedUntil: 0,
      dead: false,
    }));
    if (!nodes.length) {
      const reasons = results.map(result => `${hostOf(result.url)}: ${result.error || "文件大小不一致"}`).join("；");
      throw new Error(`没有可用的下载节点（${reasons}）`);
    }
    return { total, nodes, tested: urls.length };
  }

  // ---------------------------------------------------------------- multi-threaded download

  // Downloads [0, total) from the nodes into writer. Calls onProgress(received, stats).
  async function downloadChunks({ nodes, total, threads, chunkBytes, writer, signal, onProgress }) {
    const queue = [];
    for (let start = 0; start < total; start += chunkBytes) {
      queue.push({ pos: start, end: Math.min(total, start + chunkBytes) - 1, failures: 0, node: null });
    }
    const active = new Set();
    let received = 0;
    let fatal = null;
    const waiters = new Set();
    const notify = () => {
      for (const resolve of waiters) resolve();
      waiters.clear();
    };
    const wait = ms => new Promise(resolve => {
      waiters.add(resolve);
      setTimeout(() => { waiters.delete(resolve); resolve(); }, ms);
    });
    const report = () => onProgress(received, {
      connections: active.size,
      nodes: new Set([...active].map(chunk => chunk.node?.host)).size,
      usable: nodes.filter(node => !node.dead).length,
    });

    const bestSpeed = exclude => Math.max(0, ...nodes.filter(node => node !== exclude && !node.dead && node.speed > 0).map(node => node.speed));

    // The node with the most speed left per connection. A node not measured yet is assumed as
    // fast as the best one, but gets a single connection until it has been measured.
    function pickNode() {
      const now = Date.now();
      const usable = nodes.filter(node => !node.dead && node.bannedUntil <= now);
      const assumed = bestSpeed() || 1;
      let best = null;
      let bestScore = -Infinity;
      for (const node of usable) {
        if (!node.speed && node.active >= 1) continue;
        const score = (node.speed || assumed) / (node.active + 1) - node.ttfb / 1e9;
        if (score > bestScore) { best = node; bestScore = score; }
      }
      return best;
    }

    // With nothing queued, an idle connection takes the second half of the chunk with the most
    // left, unless that chunk is already on the same node.
    function split(node) {
      let victim = null;
      for (const chunk of active) {
        const left = chunk.end - chunk.pos + 1;
        if (chunk.node !== node && left >= 2 * MIN_SPLIT_BYTES && (!victim || left > victim.end - victim.pos + 1)) victim = chunk;
      }
      if (!victim) return null;
      const at = victim.pos + Math.ceil((victim.end - victim.pos + 1) / 2);
      const piece = { pos: at, end: victim.end, failures: 0, node: null };
      victim.end = at - 1;
      return piece;
    }

    function fail(chunk, node, error, status) {
      node.failures += 1;
      // 403 / 404 / 410: the node refuses this address for good.
      if ([403, 404, 410].includes(status)) node.dead = true;
      else node.bannedUntil = Date.now() + Math.min(60000, 5000 * 2 ** (node.failures - 1));
      chunk.failures += 1;
      console.warn(`[${TITLE}] ${node.host} 失败（${chunk.failures}/${MAX_CHUNK_FAILURES}），从 ${chunk.pos} 续传`, error);
      if (chunk.failures >= MAX_CHUNK_FAILURES) fatal ||= new Error(`分块 ${chunk.pos}-${chunk.end} 多次下载失败：${error?.message || error}`);
      else if (nodes.every(item => item.dead)) fatal ||= new Error("所有下载节点都拒绝了请求");
    }

    async function runChunk(chunk, node) {
      chunk.node = node;
      node.active += 1;
      active.add(chunk);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const started = performance.now();
      let firstByteAt = 0;
      let lastByteAt = started;
      let got = 0;
      let reason = "";
      let status = 0;
      const pending = [];
      let pendingBytes = 0;
      let pendingAt = chunk.pos;
      const flush = async () => {
        if (!pendingBytes) return;
        const data = pending.length === 1 ? pending[0] : new Uint8Array(pendingBytes);
        if (pending.length > 1) {
          let offset = 0;
          for (const piece of pending) { data.set(piece, offset); offset += piece.byteLength; }
        }
        const at = pendingAt;
        pending.length = 0;
        pendingAt += pendingBytes;
        pendingBytes = 0;
        await writer.write(at, data);
      };
      const watchdog = setInterval(() => {
        const now = performance.now();
        if (!firstByteAt && now - started > FIRST_BYTE_MS) { reason = "首字节超时"; controller.abort(); return; }
        if (firstByteAt && now - lastByteAt > STALL_MS) { reason = "停止传输"; controller.abort(); return; }
        if (now - started > SLOW_AFTER_MS) {
          const rate = got * 1000 / (now - started);
          const best = bestSpeed(node);
          if (best > 0 && rate < best * SLOW_RATIO) { reason = "slow"; controller.abort(); }
        }
      }, 500);
      try {
        const response = await cleanFetch(node.url, { headers: { Range: `bytes=${chunk.pos}-${chunk.end}` }, signal: controller.signal });
        status = response.status;
        const range = contentRange(response);
        if (status !== 206 || range?.start !== chunk.pos || (range.total !== null && range.total !== total)) {
          response.body?.cancel().catch(() => {});
          throw new Error(status === 206 ? "返回的范围不符" : `HTTP ${status}`);
        }
        firstByteAt = performance.now();
        const reader = response.body.getReader();
        while (chunk.pos <= chunk.end) {
          const { done, value } = await reader.read();
          if (done) break;
          lastByteAt = performance.now();
          // chunk.end can shrink while this runs, when an idle connection takes the rest.
          const take = Math.min(value.byteLength, chunk.end - chunk.pos + 1);
          if (take <= 0) break;
          pending.push(take === value.byteLength ? value : value.subarray(0, take));
          pendingBytes += take;
          chunk.pos += take;
          got += take;
          received += take;
          if (pendingBytes >= FLUSH_BYTES) await flush();
          report();
        }
        reader.cancel().catch(() => {});
        await flush();
        if (chunk.pos <= chunk.end) throw new Error("连接提前结束");
        const rate = got * 1000 / Math.max(1, performance.now() - started);
        node.speed = node.speed ? node.speed * 0.6 + rate * 0.4 : rate;
      } catch (error) {
        try {
          await flush();
        } catch (writeError) {
          fatal ||= writeError;
        }
        if (!signal.aborted && !fatal && chunk.pos <= chunk.end) {
          if (reason === "slow") {
            node.speed = got * 1000 / Math.max(1, performance.now() - started);
            queue.unshift(chunk);
          } else {
            fail(chunk, node, reason ? new Error(reason) : error, status);
            queue.unshift(chunk);
          }
        }
      } finally {
        clearInterval(watchdog);
        signal.removeEventListener("abort", cancel);
        node.active -= 1;
        active.delete(chunk);
        report();
        notify();
      }
    }

    async function worker() {
      while (!fatal && !signal.aborted) {
        if (!queue.length && !active.size) return;
        const node = pickNode();
        if (!node) {
          const now = Date.now();
          const next = Math.min(...nodes.filter(item => !item.dead).map(item => item.bannedUntil));
          await wait(Math.max(200, Math.min(5000, next - now)));
          continue;
        }
        const chunk = queue.shift() || split(node);
        if (!chunk) {
          await wait(1000);
          continue;
        }
        await runChunk(chunk, node);
      }
    }

    await Promise.all(Array.from({ length: threads }, worker));
    throwIfCancelled(signal);
    if (fatal) throw fatal;
    if (received !== total) throw new Error(`下载不完整：${received} / ${total} 字节`);
  }

  // ---------------------------------------------------------------- writers

  function memoryWriter(total) {
    const buffer = new Uint8Array(total);
    return {
      buffer,
      write: async (position, data) => { buffer.set(data, position); },
      close: async () => {},
      abort: async () => {},
    };
  }

  function safeFileName(name) {
    const cleaned = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
    return (cleaned || "video").slice(0, 200);
  }

  async function freeFileName(directory, name) {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let index = 0; ; index++) {
      const candidate = index ? `${base} (${index})${extension}` : name;
      try {
        await directory.getFileHandle(candidate);
      } catch (error) {
        if (error?.name === "NotFoundError") return candidate;
        throw error;
      }
    }
  }

  // Writes land at their own positions, so chunks can arrive in any order. The browser keeps
  // them in a temporary file until close(); abort() throws it away.
  async function fileWriter(directory, name, total) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.truncate(total);
    let chain = Promise.resolve();
    return {
      write(position, data) {
        chain = chain.then(() => writable.write({ type: "write", position, data }));
        return chain;
      },
      close: async () => { await chain; await writable.close(); },
      // getFileHandle(create) has already made an empty file; it goes along with the partial data.
      abort: async () => {
        await chain.catch(() => {});
        await writable.abort().catch(() => {});
        await directory.removeEntry(name).catch(() => {});
      },
    };
  }

  // ---------------------------------------------------------------- progress toast

  function formatSpeedLine(received, total, speed) {
    const { formatFileSize, formatPercent, formatDuration } = api().utils.formatters;
    let text = `${formatFileSize(received)} / ${formatFileSize(total)} @ ${formatPercent(total ? received / total : 1)}`;
    if (speed > 0 && total > received) text += ` (${formatFileSize(speed)}/s) - ${formatDuration((total - received) / speed)}`;
    return text;
  }

  // One toast per run with a 取消 link. Lines are escaped; rendering is throttled.
  function createRunToast(title, controller) {
    const { Toast } = api().toast;
    const toast = Toast.info("", title);
    const lines = [];
    let timer = 0;
    let closed = false;
    const render = () => {
      timer = 0;
      if (closed) return;
      toast.message = [...lines.filter(line => line != null).map(escapeHtml), '<a class="link" data-action="cancel">取消</a>'].join("\n");
    };
    Promise.resolve(toast.element).then(element => {
      element?.addEventListener?.("click", event => {
        if (event.target?.closest?.("[data-action='cancel']")) controller.abort(new CancelledError());
      });
    }).catch(() => {});
    return {
      set(index, text) {
        lines[index] = text;
        timer ||= setTimeout(render, 250);
      },
      clear() { lines.length = 0; },
      finish(message, duration = 5000) {
        clearTimeout(timer);
        closed = true;
        toast.message = escapeHtml(message);
        toast.duration = duration;
      },
      close() {
        clearTimeout(timer);
        closed = true;
        toast.close();
      },
    };
  }

  function speedMeter() {
    let mark = { at: performance.now(), bytes: 0 };
    let speed = 0;
    return received => {
      const now = performance.now();
      if (now - mark.at >= 1000) {
        speed = (received - mark.bytes) * 1000 / (now - mark.at);
        mark = { at: now, bytes: received };
      }
      return speed;
    };
  }

  // Tests the nodes of one stream, unless that was done already (probed), and downloads it
  // into writerFor(total).
  async function downloadStream({ fragment, label, options, signal, progress, line, knownSpeeds, writerFor, probed }) {
    if (!probed) {
      const urls = candidateUrls(fragment, options.expandHosts);
      progress.set(line, `${label}: 正在测试 ${urls.length} 个节点`);
    }
    const { total, nodes, tested } = probed || await probeNodes(candidateUrls(fragment, options.expandHosts), signal, knownSpeeds);
    const writer = await writerFor(total);
    const meter = speedMeter();
    try {
      await downloadChunks({
        nodes,
        total,
        threads: options.threads,
        chunkBytes: options.chunkMB * MiB,
        writer,
        signal,
        onProgress: (received, stats) => {
          progress.set(line, `${label}: ${formatSpeedLine(received, total, meter(received))}`);
          progress.set(line + 1, `  ${stats.connections} 个连接 · ${stats.nodes} 个节点在用 · 可用节点 ${stats.usable} / ${tested}`);
        },
      });
      await writer.close();
    } catch (error) {
      await writer.abort();
      throw error;
    } finally {
      for (const node of nodes) if (node.speed) knownSpeeds.set(node.host, node.speed);
    }
    progress.set(line, `${label}: ${formatSpeedLine(total, total, 0)} · 完成`);
    progress.set(line + 1, null);
    return { total, writer };
  }

  // ---------------------------------------------------------------- output: save to folder

  async function pickDirectory(signal) {
    if (typeof page.showDirectoryPicker !== "function") return null;
    const open = () => page.showDirectoryPicker({ id: "bilibili-evolved-multi-thread", mode: "readwrite", startIn: "downloads" });
    try {
      return await open();
    } catch (error) {
      if (error?.name === "AbortError") throw new CancelledError("已取消选择文件夹");
      if (error?.name !== "SecurityError" && error?.name !== "NotAllowedError") throw error;
    }
    // The click on 开始 was too long ago for the browser to open a picker; ask for a new click.
    const { Toast } = api().toast;
    const toast = Toast.show('<a class="link" data-action="pick">点击这里选择保存文件夹</a>\n<a class="link" data-action="cancel">取消</a>', TITLE);
    const element = await toast.element;
    return new Promise((resolve, reject) => {
      const done = () => { toast.close(); signal.removeEventListener("abort", onAbort); };
      const onAbort = () => { done(); reject(new CancelledError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      element.addEventListener("click", async event => {
        if (event.target?.closest?.("[data-action='cancel']")) { onAbort(); return; }
        if (!event.target?.closest?.("[data-action='pick']")) return;
        try {
          const directory = await open();
          done();
          resolve(directory);
        } catch (error) {
          if (error?.name === "AbortError") { done(); reject(new CancelledError("已取消选择文件夹")); }
          else console.warn(`[${TITLE}] 无法打开文件夹选择`, error);
        }
      });
    });
  }

  async function runSaveToFolder(action, options) {
    const controller = new AbortController();
    const { signal } = controller;
    const directory = await pickDirectory(signal);
    const fragments = action.infos.flatMap(info => info.titledFragments);
    const progress = createRunToast(`${TITLE} - 保存到文件夹`, controller);
    const knownSpeeds = new Map();
    const saved = [];
    try {
      for (let index = 0; index < fragments.length; index++) {
        const fragment = fragments[index];
        progress.clear();
        progress.set(0, `文件 ${index + 1} / ${fragments.length}${directory ? ` · 保存到「${directory.name}」` : " · 浏览器下载"}`);
        const wanted = safeFileName(fragment.title);
        const name = directory ? await freeFileName(directory, wanted) : wanted;
        const { writer } = await downloadStream({
          fragment,
          label: name,
          options,
          signal,
          progress,
          line: 1,
          knownSpeeds,
          writerFor: total => (directory ? fileWriter(directory, name, total) : memoryWriter(total)),
        });
        if (!directory) await api().download.DownloadPackage.single(name, new Blob([writer.buffer]));
        saved.push(name);
      }
      progress.finish(`完成：${saved.length} 个文件${directory ? `已保存到「${directory.name}」` : ""}\n${saved.join("\n")}`);
    } catch (error) {
      progress.close();
      throw error;
    }
  }

  // ---------------------------------------------------------------- output: WASM mux

  // Client for the FFmpeg worker Evolved ships (the @ffmpeg/ffmpeg 0.12 message protocol).
  class FFmpegWorker {
    #worker = null;
    #pending = new Map();
    #nextId = 0;
    onProgress = null;

    get loaded() { return Boolean(this.#worker); }

    async load(config) {
      this.#worker = new Worker(config.workerLoadURL, { type: "classic" });
      this.#worker.onmessage = ({ data }) => this.#receive(data);
      this.#worker.onerror = event => this.#failAll(new Error(event.message || "FFmpeg Worker 出错"));
      try {
        await this.#send("LOAD", config);
      } catch (error) {
        this.terminate();
        throw error;
      }
    }

    exec(args) { return this.#send("EXEC", { args, timeout: -1 }); }
    writeFile(path, data) { return this.#send("WRITE_FILE", { path, data }, [data.buffer]); }
    readFile(path) { return this.#send("READ_FILE", { path, encoding: "binary" }); }
    deleteFile(path) { return this.#send("DELETE_FILE", { path }); }

    terminate() {
      this.#worker?.terminate();
      this.#worker = null;
      this.#failAll(new Error("FFmpeg 已终止"));
    }

    #receive({ id, type, data }) {
      if (type === "PROGRESS") {
        this.onProgress?.(data);
        return;
      }
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (type === "ERROR") pending.reject(data instanceof Error ? data : new Error(String(data)));
      else pending.resolve(data);
    }

    #send(type, data, transfer = []) {
      if (!this.#worker) return Promise.reject(new Error("FFmpeg 未加载"));
      return new Promise((resolve, reject) => {
        const id = this.#nextId++;
        this.#pending.set(id, { resolve, reject });
        this.#worker.postMessage({ id, type, data }, transfer);
      });
    }

    #failAll(error) {
      for (const { reject } of this.#pending.values()) reject(error);
      this.#pending.clear();
    }
  }

  const ffmpeg = new FFmpegWorker();
  let ffmpegLoading = null;
  // FFmpeg's virtual files ("video", "audio", ...) are shared, so one mux runs at a time.
  let muxQueue = Promise.resolve();

  function openCache() {
    return new Promise((resolve, reject) => {
      // No version: open what Evolved's WASM output created, or create it with the same store.
      const request = page.indexedDB.open(CACHE_DB);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function cacheRequest(mode, operate) {
    const db = await openCache();
    try {
      if (!db.objectStoreNames.contains(CACHE_STORE)) return undefined;
      return await new Promise((resolve, reject) => {
        const request = operate(db.transaction(CACHE_STORE, mode).objectStore(CACHE_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async function httpGetBytes(url, onProgress) {
    const response = await cleanFetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length")) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  async function loadLibrary(key, library, onProgress) {
    try {
      const cached = await cacheRequest("readonly", store => store.get(key));
      if (cached) return cached;
    } catch (error) {
      console.warn(`[${TITLE}] 读取 FFmpeg 缓存失败`, error);
    }
    const bytes = await httpGetBytes(library.url, onProgress);
    const sha256 = await api().runtimeLibrary.RuntimeLibrary.sha256(bytes);
    if (sha256 !== library.sha256) throw new Error(`${library.url} 校验失败：应为 ${library.sha256}，实际为 ${sha256}`);
    await cacheRequest("readwrite", store => store.put(bytes, key))
      .catch(error => console.warn(`[${TITLE}] 写入 FFmpeg 缓存失败`, error));
    return bytes;
  }

  async function loadFFmpeg(progress, line) {
    const { formatFileSize } = api().utils.formatters;
    const library = api().meta.meta.compilationInfo.altCdn.library.ffmpeg;
    const parts = [
      ["ffmpeg-worker", library.worker, "text/javascript"],
      ["ffmpeg-core", library.core, "text/javascript"],
      ["ffmpeg-wasm", library.wasm, "application/wasm"],
    ];
    const loaded = parts.map(() => 0);
    const urls = await Promise.all(parts.map(async ([key, definition, mime], index) => {
      const bytes = await loadLibrary(key, definition, received => {
        loaded[index] = received;
        progress.set(line, `正在加载 FFmpeg: ${formatFileSize(loaded.reduce((a, b) => a + b, 0))}`);
      });
      return URL.createObjectURL(new Blob([bytes], { type: mime }));
    }));
    await ffmpeg.load({ workerLoadURL: urls[0], coreURL: urls[1], wasmURL: urls[2] });
  }

  function ensureFFmpeg(progress, line) {
    if (ffmpeg.loaded) return Promise.resolve();
    ffmpegLoading ||= loadFFmpeg(progress, line).finally(() => { ffmpegLoading = null; });
    return ffmpegLoading;
  }

  const FORMATS = {
    mp4: { extension: "mp4", mime: "video/mp4" },
    matroska: { extension: "mkv", mime: "video/x-matroska" },
  };

  function muxPlan(outputType, isFlac, hasCover, hasMetadata) {
    if (!FORMATS[outputType]) {
      // auto: FLAC, or a cover together with metadata, needs Matroska.
      outputType = isFlac || (hasCover && hasMetadata) ? "matroska" : "mp4";
    }
    const args = ["-i", "video", "-i", "audio"];
    if (outputType === "mp4") {
      if (hasCover) args.push("-i", "cover");
      if (hasMetadata) args.push("-i", "metadata");
      if (hasCover) {
        args.push("-map", "0", "-map", "1", "-map", "2", "-disposition:2", "attached_pic");
        // The cover and mdta-style tags interfere, so +use_metadata_tags only without a cover.
        if (hasMetadata) args.push("-map_metadata", "3");
      } else if (hasMetadata) {
        args.push("-map_metadata", "2", "-movflags", "+use_metadata_tags");
      }
      // MP4 cannot carry FLAC; it is re-encoded to ALAC.
      args.push("-codec:v", "copy", "-codec:a", isFlac ? "alac" : "copy", "-f", "mp4");
    } else {
      if (hasMetadata) args.push("-i", "metadata");
      if (hasCover) args.push("-attach", "cover");
      if (hasCover && hasMetadata) args.push("-map", "0", "-map", "1");
      if (hasMetadata) args.push("-map_metadata", "2");
      if (hasCover) args.push("-metadata:s:t:0", "mimetype=image/jpeg", "-metadata:s:t:0", "filename=cover.jpg");
      args.push("-codec", "copy", "-f", "matroska");
    }
    args.push("output");
    return { ...FORMATS[outputType], args };
  }

  function mux(plan, inputs, onProgress) {
    const run = muxQueue.then(async () => {
      const names = Object.keys(inputs);
      try {
        for (const name of names) await ffmpeg.writeFile(name, inputs[name]);
        ffmpeg.onProgress = onProgress;
        console.debug(`[${TITLE}] ffmpeg ${plan.args.join(" ")}`);
        const code = await ffmpeg.exec(plan.args);
        if (typeof code === "number" && code !== 0) throw new Error(`FFmpeg 混流失败（退出码 ${code}）`);
        const output = await ffmpeg.readFile("output");
        return new Blob([output], { type: plan.mime });
      } finally {
        ffmpeg.onProgress = null;
        await Promise.all([...names, "output"].map(name => ffmpeg.deleteFile(name).catch(() => {})));
      }
    });
    muxQueue = run.catch(() => {});
    return run;
  }

  // Takes the ffmetadata / cover assets this output writes into the file, so 下载视频 does not
  // also save them separately.
  async function takeAssets(action, options) {
    const { infos } = action;
    let metadata = null;
    let covers = null;
    if (options.muxWithMetadata) {
      action.extraAssets = (await Promise.all(action.extraAssets.map(async entry => {
        if (!metadata && entry.asset.name === "saveVideoMetadata" && entry.instance?.type === "ffmetadata") {
          metadata = await entry.asset.getAssets(infos, entry.instance);
          return null;
        }
        return entry;
      }))).filter(Boolean);
    }
    if (options.attachCover) {
      action.extraOnlineAssets = (await Promise.all(action.extraOnlineAssets.map(async entry => {
        if (!covers && entry.asset.name === "downloadCover" && entry.instance?.type === "jpg") {
          covers = await entry.asset.getUrls(infos, entry.instance);
          return null;
        }
        return entry;
      }))).filter(Boolean);
    }
    return { metadata, covers };
  }

  async function runWasm(action, options) {
    const { metadata, covers } = await takeAssets(action, options);
    const { infos } = action;
    const { formatFileSize, formatPercent } = api().utils.formatters;
    const knownSpeeds = new Map();
    for (let index = 0; index < infos.length; index++) {
      const fragments = infos[index].titledFragments;
      const video = fragments.find(fragment => fragment.type === "video");
      const audio = fragments.find(fragment => fragment.type !== "video" && fragment.type !== "flv");
      if (fragments.length !== 2 || !video || !audio) throw new Error("WASM 混流仅支持 DASH 格式的视频和音频");
      const controller = new AbortController();
      const { signal } = controller;
      const progress = createRunToast(`${TITLE} + WASM 混流 - ${index + 1} / ${infos.length}`, controller);
      try {
        // Both sizes first, so a file over the limit fails before anything is downloaded.
        progress.set(0, "正在测试节点");
        const [videoProbe, audioProbe] = await Promise.all([
          probeNodes(candidateUrls(video, options.expandHosts), signal, knownSpeeds),
          probeNodes(candidateUrls(audio, options.expandHosts), signal, knownSpeeds),
        ]);
        if (videoProbe.total + audioProbe.total > MAX_MUX_BYTES) {
          throw new Error(`WASM 混流仅支持 2GB 内的音视频（${formatFileSize(videoProbe.total + audioProbe.total)}），请改用「保存到文件夹」`);
        }
        progress.set(0, null);
        const streams = {};
        for (const [key, fragment, probed, label, line] of [["video", video, videoProbe, "视频流", 0], ["audio", audio, audioProbe, "音频流", 2]]) {
          const { writer } = await downloadStream({ fragment, label, options, signal, progress, line, knownSpeeds, writerFor: memoryWriter, probed });
          streams[key] = writer.buffer;
        }
        const inputs = { video: streams.video, audio: streams.audio };
        const coverUrl = covers?.[index]?.url;
        if (coverUrl) {
          progress.set(4, "正在下载封面");
          inputs.cover = await httpGetBytes(coverUrl);
        }
        const ffmetadata = metadata?.[index]?.data;
        if (ffmetadata) inputs.metadata = new TextEncoder().encode(ffmetadata);
        throwIfCancelled(signal);
        const plan = muxPlan(options.outputType, audio.type === "flacAudio", Boolean(inputs.cover), Boolean(inputs.metadata));
        progress.set(4, "等待 FFmpeg");
        await ensureFFmpeg(progress, 4);
        throwIfCancelled(signal);
        const output = await mux(plan, inputs, event => progress.set(4, `混流中: ${formatPercent(event.progress)}`));
        const name = `${safeFileName(video.title).replace(/\.[^/.]+$/, "")}.${plan.extension}`;
        await api().download.DownloadPackage.single(name, output);
        progress.finish(`完成：${name}`, 3000);
      } catch (error) {
        progress.close();
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------- options

  function storedOptions() {
    const stored = api().settings.getComponentSettings("downloadVideo").options;
    return Object.fromEntries(Object.entries(OPTION_KEYS).map(([key, storedKey]) => [key, stored[storedKey] ?? DEFAULT_OPTIONS[key]]));
  }

  function createConfigComponent(withMux) {
    const { SwitchBox, VDropdown } = api().ui;
    const { isComponentEnabled } = api().settings;
    return Vue.extend({
      data() {
        const options = storedOptions();
        const hasMetadata = withMux && isComponentEnabled("saveVideoMetadata");
        const hasCover = withMux && isComponentEnabled("viewCover");
        return {
          ...options,
          hasMetadata,
          hasCover,
          muxWithMetadata: hasMetadata && options.muxWithMetadata,
          attachCover: hasCover && options.attachCover,
        };
      },
      methods: {
        save() {
          const stored = api().settings.getComponentSettings("downloadVideo").options;
          for (const [key, storedKey] of Object.entries(OPTION_KEYS)) stored[storedKey] = this[key];
        },
      },
      render(h) {
        const item = (label, control, description) => h("div", { staticClass: "download-video-config-item", staticStyle: { "flex-wrap": "wrap" } }, [
          h("div", { staticClass: "download-video-config-title" }, label),
          control,
          description && h("div", { staticClass: "download-video-config-description", staticStyle: { width: "100%" } }, description),
        ]);
        const model = key => ({ value: this[key], callback: value => { this[key] = value; }, expression: key });
        const dropdown = (key, items, format) => h(VDropdown, {
          attrs: { items },
          on: { change: () => this.$nextTick(this.save) },
          model: model(key),
          scopedSlots: { item: ({ item: value }) => format(value) },
        });
        const toggle = key => h(SwitchBox, { on: { change: () => this.$nextTick(this.save) }, model: model(key) });
        return h("div", { staticClass: "multi-thread-download-config" }, [
          item("连接数：", dropdown("threads", THREAD_CHOICES, value => `${value} 个`)),
          item("分块大小：", dropdown("chunkMB", CHUNK_CHOICES, value => `${value} MB`)),
          item("扩展 CDN 节点：", toggle("expandHosts"), "除了 B 站返回的地址，也尝试把同一地址换到其他 Mirror 节点；每个节点先测试，不可用的会被跳过"),
          withMux && item("输出格式：", dropdown("outputType", OUTPUT_TYPES, value => value), "非特殊需求请保持自动；指定 MP4 时，无损音轨会从 FLAC 重新编码为 ALAC"),
          this.hasMetadata && item("写入元数据：", toggle("muxWithMetadata"), "支持元数据类型「ffmetadata」"),
          this.hasCover && item("附加封面：", toggle("attachCover"), this.hasMetadata ? "附加封面至 MP4 格式会导致元数据自定义字段失效" : null),
        ]);
      },
    });
  }

  function optionsFrom(instance) {
    const stored = storedOptions();
    if (!instance) return stored;
    return Object.fromEntries(Object.keys(DEFAULT_OPTIONS).map(key => [key, instance[key] ?? stored[key]]));
  }

  async function runOutput(run, action, instance) {
    try {
      await run(action, optionsFrom(instance));
    } catch (error) {
      if (error instanceof CancelledError || error?.name === "CancelledError") {
        api().toast.Toast.info(error.message || "已取消", TITLE, 3000);
        return;
      }
      console.error(`[${TITLE}]`, error);
      api().toast.Toast.error(String(error?.message || error), TITLE);
    }
  }

  return {
    name: "downloadVideo.outputs.multiThread",
    displayName: `下载视频 - ${TITLE}`,
    description: "为下载视频添加两个多线程输出：「保存到文件夹」直接写入你选择的文件夹（Chrome / Edge），「WASM 混流」下载后在浏览器中合并音视频。只发送带 Range 的请求，使用 B 站返回的所有地址（可选扩展到其他 Mirror 节点），多连接分块下载并自动避开慢节点和故障节点。同时隐藏内置的 StreamSaver 输出。",
    setup: ({ addData }) => {
      addData("downloadVideo.outputs", outputs => {
        if (HIDE_STREAMSAVER) {
          const index = outputs.findIndex(output => output.name === "steamSaver");
          if (index >= 0) outputs.splice(index, 1);
        }
        outputs.push({
          name: "multiThreadFolder",
          displayName: "多线程（保存到文件夹）",
          description: "多连接、多节点下载，每个视频 / 音频流直接写入你选择的文件夹，不受内存限制。需要 Chrome / Edge；其他浏览器下载完成后作为普通下载保存。",
          component: () => Promise.resolve(createConfigComponent(false)),
          runAction: (action, instance) => runOutput(runSaveToFolder, action, instance),
        });
        outputs.push({
          name: "multiThreadWasm",
          displayName: "多线程 + WASM 混流",
          description: "多连接、多节点下载音视频，再用 WASM 在浏览器中混流为一个文件，支持批量下载。运行过程中请勿关闭页面，初次使用需要加载约 30 MB 的 WASM 文件。由于浏览器限制，仅支持合并 2GB 以内的音视频。",
          component: () => Promise.resolve(createConfigComponent(true)),
          runAction: (action, instance) => runOutput(runWasm, action, instance),
        });
      });
    },
  };
});
