<p align="center">
  <img src="sugpatuben-cs/public/sugpatuben-trans.png" alt="Sug på tuben" width="720">
</p>

<h1 align="center">Sug på tuben</h1>

<p align="center">
  Ladda ner ljud och video från YouTube, SVT, TV4, SR m.fl. — klistra in en länk, välj format, ladda ner.
</p>

---

A small self-hosted video/audio downloader with a graph-paper aesthetic (see
`public/tilingpaper.png` for the tiling background). Built on
[Deno](https://deno.com) + [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg,
with a single-page frontend that streams progress over Server-Sent Events.

Videos with **variable frame rate** (common from TikTok/Instagram/Facebook) are
automatically detected and converted to **constant frame rate** before the file
is handed over, with the conversion step visible in the progress UI. MP3
extraction, format selection, filename cleanup and a 10-minute self-cleaning
download store are included.

## Two implementations

| | `sugpatuben-ss/` (server-side) | `sugpatuben-cs/` (client-side) |
|---|---|---|
| Extraction & download | server (yt-dlp) | server (yt-dlp) |
| Merge / mp3 | server (ffmpeg) | server (ffmpeg) |
| VFR→CFR re-encode | server (libx264) | **visitor's browser** (self-hosted [ffmpeg.wasm](https://ffmpegwasm.netlify.app/)) |
| Server CPU needs | real (x264 encodes) | minimal — runs happily on an Intel N150 |
| Default port | 3000 | 3001 |

Both serve the same UI and produce the same output; `-cs` shifts the only
CPU-heavy step onto the client, so the server is essentially I/O-bound.

## Run

```bash
cd sugpatuben-cs   # or sugpatuben-ss
deno run --allow-net --allow-read --allow-write=downloads \
  --allow-run=/usr/local/bin/yt-dlp,/usr/bin/ffprobe server.ts
```

Requirements: `deno`, `yt-dlp`, `ffmpeg`/`ffprobe`. The server-side variant
also needs `/usr/bin/ffmpeg` in its `--allow-run` list.

## Deploy (Proxmox LXC + Nginx Proxy Manager)

`setup/setup-lxc.sh` provisions a fresh Ubuntu LTS LXC container end to end:
installs dependencies (yt-dlp as a standalone binary with a weekly auto-update
timer), creates a sandboxed systemd service for `sugpatuben-cs`, fetches the
app straight from this repository, and prints ready-to-paste Nginx Proxy
Manager settings for your chosen domain — including the SSE-critical
`proxy_buffering off` snippet.

```bash
# inside the container, as root:
curl -fsSL https://raw.githubusercontent.com/inthevidual/sugpatuben/main/setup/setup-lxc.sh -o setup-lxc.sh
chmod +x setup-lxc.sh
./setup-lxc.sh your.domain.example
```

## Notes

- The Nordic geo-gate reads Cloudflare's `cf-ipcountry` header and only works
  behind the Cloudflare proxy; without it, all visitors are allowed.
- `public/vendor/ffmpeg/` in `-cs` is a pinned, self-hosted ffmpeg.wasm
  (single-threaded core — no COOP/COEP headers required).
- Downloads are stored under a random UUID and deleted after 10 minutes.
