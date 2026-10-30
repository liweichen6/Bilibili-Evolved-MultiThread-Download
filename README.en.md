# Bilibili Evolved Multi-Thread Download

[中文](README.md) | English

A [Bilibili Evolved](https://github.com/the1812/Bilibili-Evolved) plugin that adds two multi-connection, multi-CDN outputs to 下载视频 (Download Video):

- **多线程（保存到文件夹）/ Save to folder**: each video or audio stream is written straight into a folder you pick. There is no memory limit, so 4K and files over 2 GB work.
- **多线程 + WASM 混流 / WASM mux**: video and audio are downloaded with multiple connections, then merged into one file in the browser with FFmpeg (WASM).

## Why

The built-in download has two problems:

1. **It can save an error page as the video.**
   - Some Mirror nodes (for example `upos-sz-mirrorcosov.bilivideo.com`) answer any **request without a Range header** with HTTP 567 and an HTML error page of about 8.5 KB.
   - The 下载地址偏好 (preferred URL type) setting defaults to Mirror and takes only the first matching address. On an overseas network it picked that node for about 87% of 4K requests in testing.
   - The StreamSaver output doesn't check the response status, so it saves the error page as the video file. Pressing 开始 (Start) again sometimes works because Bilibili occasionally lists a working node first.
2. **One connection is slow.** Nodes often cap each connection; one connection got about 0.3–0.55 MB/s in testing.

This plugin only sends Range requests, uses several connections across several nodes, and works around slow or failing nodes on its own.

## Features

- **Only correct data is kept.** Every request carries a Range header, and only a 206 response for exactly the bytes asked for is written to the file.
- **Every address is used.**
  - Both the main and the backup addresses Bilibili returns are used.
  - Optionally, the same signed address is also tried on up to 13 other nodes, mostly Mirror nodes ([Bilibili-Evolved#3234](https://github.com/the1812/Bilibili-Evolved/issues/3234#issuecomment-1504764774) documents that Mirror nodes are interchangeable).
  - Each node is tested first, and nodes that don't work are skipped.
- **Multi-connection chunked download**
  - 6 connections and 8 MB chunks by default, all taken from one shared queue.
  - Each node's speed is measured throughout, and faster nodes get more chunks.
- **Automatic recovery**
  - A connection with no first byte after 10 s, or no new data for 6 s, is aborted, and the rest of its chunk resumes on another node.
  - A connection running at under a quarter of the best node's speed gives its chunk back.
  - Failing nodes are paused for a while; nodes answering 403 / 404 / 410 are dropped.
  - Near the end, idle connections take over half of what other connections still have left.
- **Unaffected by other scripts.** Requests go through the `fetch` of a blank iframe, so changes the page or other scripts (such as playback accelerators) make to `window.fetch` don't affect downloads.
- **Cancellable.** The progress toast shows speed, connections and nodes; clicking 取消 (Cancel) stops the download and deletes unfinished files.
- **Hides the built-in StreamSaver output**, so the broken one can't be picked by mistake. To keep it, set `HIDE_STREAMSAVER` near the top of the file to `false`.

## Installation

1. Install [Bilibili Evolved](https://github.com/the1812/Bilibili-Evolved) first.
2. Open Evolved's settings panel and go to the 插件 (Plugins) page.
3. Under 添加插件 (Add plugin), either:
   - paste one of these links into the input box and add it:
     - `https://raw.githubusercontent.com/liweichen6/Bilibili-Evolved-MultiThread-Download/main/multi-thread-download.js`
     - `https://cdn.jsdelivr.net/gh/liweichen6/Bilibili-Evolved-MultiThread-Download@main/multi-thread-download.js` (if GitHub is hard to reach)
   - or download [`multi-thread-download.js`](multi-thread-download.js), click 浏览 (Browse) and choose that file.
4. Refresh the Bilibili page.

## Usage

1. Open 下载视频 and choose quality and other options as usual.
2. Under 输出方式 (Output), pick 多线程（保存到文件夹） or 多线程 + WASM 混流.
3. Click 开始 (Start).

**Save to folder**

- The first time, a folder picker opens, and Chrome asks whether the site may write to that folder.
- If too much time passes between clicking 开始 and the picker opening, the browser refuses to open it directly. A 点击这里选择保存文件夹 (click here to choose a folder) prompt appears instead; click it.
- File names match the built-in download, with video and audio saved separately. If a file with the same name exists, a number such as "(1)" is added.
- Only Chrome / Edge can write straight to a folder. Other browsers download the file into memory first and then save it as a normal download.

**WASM mux**

- The first use loads about 30 MB of FFmpeg files. They share a cache with Evolved's own WASM 混流输出 plugin, so nothing is downloaded again if you've used that one.
- Because of browser limits, only video and audio up to 2 GB in total can be merged. Use Save to folder for anything larger.

## Settings

Each output has its settings below it:

| Setting | Default | Description |
|---|---|---|
| 连接数 (Connections) | 6 | Concurrent connections: 2 / 4 / 6 / 8 / 12 / 16 |
| 分块大小 (Chunk size) | 8 MB | Size of each chunk: 2 / 4 / 8 / 16 MB. Larger chunks suit high-latency networks |
| 扩展 CDN 节点 (Extra CDN nodes) | On | Also try other nodes besides the addresses Bilibili returns |
| 输出格式 (Output format) | auto | WASM mux only: auto / mp4 / matroska. With MP4, lossless audio is re-encoded from FLAC to ALAC |
| 写入元数据 (Write metadata) | Off | WASM mux only; needs the 保存视频元数据 (Save video metadata) component |
| 附加封面 (Attach cover) | Off | WASM mux only; needs the 查看封面 (View cover) component |

## Test results

Environment: overseas network, Chrome 156, Tampermonkey 5.5.1, Bilibili Evolved 2.11.5, video BV1tZxj6ZEVa.

| Test | Result |
|---|---|
| One plain connection, 720P video (56 MB) | 237 s |
| This plugin, save to folder, 720P video + audio (68 MB total) | 21.9 s; video byte-identical to the single-connection download |
| This plugin, WASM mux, same video | 12.3 s; 68.6 MB MP4 |
| This plugin, 1080P | about 10.6 MB/s, 6 connections on 6 nodes |

Speed depends heavily on your network and the nodes at the time, so treat these numbers as a rough guide.

## Known limitations

- The node list behind 扩展 CDN 节点 comes from observation, not from rules Bilibili publishes. Nodes that reject the signature are skipped during testing, but Bilibili can change this at any time.
- Only the addresses Bilibili returns, and nodes derived from them, can be used. If every address fails, click 开始 again to get fresh ones.
- Not yet tested much: files over 2 GB, writing metadata and attaching covers, batch downloads, old FLV-only videos, and browsers other than Chrome. Issues are welcome.

## Credits

- [Bilibili Evolved](https://github.com/the1812/Bilibili-Evolved) (the1812) provides the plugin API and the 下载视频 component.
- The muxing follows Bilibili Evolved's WASM 混流输出 plugin (WakelessSloth56, LainIO24; MIT): the same FFmpeg files, cache and arguments.
- Node types and which nodes are interchangeable follow the [write-up in Bilibili-Evolved#3234](https://github.com/the1812/Bilibili-Evolved/issues/3234#issuecomment-1504764774).

## License

[MIT](LICENSE)
