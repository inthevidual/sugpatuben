import { serveFile } from "jsr:@std/http/file-server";
import { join } from "jsr:@std/path";

// sugpatuben-cs: client-side conversion variant.
// The server only extracts/downloads/merges; VFR→CFR re-encoding is done
// in the visitor's browser with ffmpeg.wasm (see public/index.html).
const PORT = 3001;
const DOWNLOADS_DIR = join(Deno.cwd(), "downloads");
const PUBLIC_DIR = join(Deno.cwd(), "public");
const YT_DLP = "/usr/local/bin/yt-dlp";
const FFPROBE = "/usr/bin/ffprobe";

// Clean up old files periodically (older than 10 minutes)
setInterval(async () => {
  try {
    for await (const entry of Deno.readDir(DOWNLOADS_DIR)) {
      if (entry.name.startsWith(".")) continue; // e.g. .cache (Deno's dep cache lives here)
      const path = join(DOWNLOADS_DIR, entry.name);
      try {
        const stat = await Deno.stat(path);
        if (Date.now() - (stat.mtime?.getTime() ?? 0) > 10 * 60 * 1000) {
          await Deno.remove(path, { recursive: true });
        }
      } catch (e) {
        console.error(`Cleanup failed for ${entry.name}:`, e);
      }
    }
  } catch (e) {
    console.error("Cleanup sweep failed:", e);
  }
}, 60_000);

function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    // YouTube: strip playlist/radio params
    if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) {
      return `https://www.youtube.com/watch?v=${u.searchParams.get("v")}`;
    }
    if (u.hostname === "youtu.be") {
      return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
    }
    // SVT: /video/ID/... → svt:ID (bypasses broken webpage extractor)
    if (u.hostname.includes("svtplay.se")) {
      const m = u.pathname.match(/^\/video\/([A-Za-z0-9]+)/);
      if (m) return `svt:${m[1]}`;
    }
  } catch { /* fall through */ }
  return url;
}

// SR slug articles don't have a numeric ID in the URL — fetch the page and extract it
async function resolveSRUrl(url: string): Promise<string> {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("sverigesradio.se")) return url;
    // Already has numeric ID
    if (u.searchParams.has("artikel") || u.pathname.match(/\/artikel\/\d+/)) return url;
    // Slug-based article URL — fetch page to get publicationId
    if (u.pathname.match(/\/artikel\//)) {
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const html = await resp.text();
      const m = html.match(/publicationId=(\d+)/);
      if (m) {
        return `https://sverigesradio.se/sida/artikel.aspx?artikel=${m[1]}`;
      }
    }
  } catch { /* fall through */ }
  return url;
}

// TV4/TV4Play: yt-dlp's extractor only knows old numeric-id URLs, not the
// newer hex-id paths (/korthet/, /klipp/, /video/). Resolve those through
// TV4's playback API instead (same approach as the Privatkopiera extension)
// and hand yt-dlp the HLS manifest directly. Login-gated/DRM content still fails.
async function resolveTV4Url(
  url: string,
): Promise<{ url: string; title: string; isManifest: boolean }> {
  const passthrough = { url, title: "", isManifest: false };
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== "tv4play.se") return passthrough;
    const m = u.pathname.match(/^\/(?:video|program|klipp|korthet)\/([0-9a-f]+)/);
    if (!m) return passthrough;
    const api = `https://playback2.a2d.tv/play/${m[1]}?service=tv4play&device=browser&protocol=hls%2Cdash&drm=widevine&browser=GoogleChrome&capabilities=live-drm-adstitch-2%2Cyospace3`;
    const resp = await fetch(api, { headers: { accept: "application/json" } });
    if (!resp.ok) return passthrough;
    const data = await resp.json();
    const manifest = data?.playbackItem?.manifestUrl;
    if (!manifest) return passthrough;
    return {
      url: manifest,
      title: (data?.metadata?.title ?? "").trim(),
      isManifest: true,
    };
  } catch {
    return passthrough;
  }
}

function parseFps(frac: string | undefined): number {
  if (!frac) return 0;
  const [num, den] = frac.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

// Probe a video file: is it VFR, and what CFR frame rate should it get?
async function probeFrameRate(
  path: string,
): Promise<{ vfr: boolean; targetFps: number; durationSec: number } | null> {
  try {
    const proc = new Deno.Command(FFPROBE, {
      args: [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,avg_frame_rate:format=duration",
        "-of", "json",
        path,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await proc.output();
    if (!out.success) return null;
    const info = JSON.parse(new TextDecoder().decode(out.stdout));
    const stream = info.streams?.[0];
    if (!stream) return null;

    const rFps = parseFps(stream.r_frame_rate);
    const avgFps = parseFps(stream.avg_frame_rate);
    const durationSec = parseFloat(info.format?.duration) || 0;

    // VFR heuristic: container/base rate disagrees with the measured average
    const vfr = rFps > 0 && avgFps > 0 && Math.abs(rFps - avgFps) > 0.05;

    // Snap the average rate to the nearest standard frame rate
    const STANDARD = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
    const base = avgFps > 0 ? avgFps : (rFps > 0 ? rFps : 30);
    let targetFps = STANDARD.reduce((a, b) =>
      Math.abs(b - base) < Math.abs(a - base) ? b : a
    );
    if (Math.abs(targetFps - base) > 3) targetFps = Math.round(base);
    if (targetFps < 1) targetFps = 30;
    if (targetFps > 60) targetFps = 60;

    return { vfr, targetFps, durationSec };
  } catch {
    return null;
  }
}

// === RATE LIMITING ===
// Deliberately aggressive: the service is meant for a handful of users.
const IP_WINDOW_MS = 60_000; //         per-IP: more than IP_MAX_REQUESTS
const IP_MAX_REQUESTS = 10; //          download requests per minute
const IP_BLOCK_MS = 15 * 60_000; //     → blocked for 15 minutes
const SURGE_WINDOW_MS = 5 * 60_000; //  surge guard: more than SURGE_MAX_IPS
const SURGE_MAX_IPS = 8; //             distinct IPs within 5 minutes
const SURGE_BLOCK_MS = 10 * 60_000; //  → everyone locked out for 10 minutes

const ipHits = new Map<string, number[]>();
const blockedIps = new Map<string, number>();
const recentIps = new Map<string, number>();
let surgeUntil = 0;

// Real client IP. cf-connecting-ip is set by Cloudflare (the proxy's own
// address is what nginx/NPM sees as remote). Spoofable only by traffic that
// bypasses Cloudflare entirely, which never reaches these vhosts.
function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";
}

// Returns the rejection (message + seconds until allowed again), else null.
function rateLimit(req: Request): { error: string; retryAfter: number } | null {
  const now = Date.now();
  const ip = clientIp(req);

  if (now < surgeUntil) {
    return {
      error: "Tjänsten är hårt belastad just nu. Försök igen om en stund.",
      retryAfter: Math.ceil((surgeUntil - now) / 1000),
    };
  }

  const blockedUntil = blockedIps.get(ip) ?? 0;
  if (now < blockedUntil) {
    return {
      error: "För många förfrågningar. Försök igen senare.",
      retryAfter: Math.ceil((blockedUntil - now) / 1000),
    };
  }
  if (blockedUntil) blockedIps.delete(ip);

  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  if (hits.length > IP_MAX_REQUESTS) {
    blockedIps.set(ip, now + IP_BLOCK_MS);
    ipHits.delete(ip);
    console.warn(`Rate limit: blocked ${ip} for ${IP_BLOCK_MS / 60_000} min`);
    return {
      error: "För många förfrågningar. Försök igen senare.",
      retryAfter: Math.ceil(IP_BLOCK_MS / 1000),
    };
  }

  // Surge/botnet heuristic: many distinct IPs at once is not our 5 users
  recentIps.set(ip, now);
  for (const [k, t] of recentIps) {
    if (now - t > SURGE_WINDOW_MS) recentIps.delete(k);
  }
  if (recentIps.size > SURGE_MAX_IPS) {
    surgeUntil = now + SURGE_BLOCK_MS;
    recentIps.clear();
    ipHits.clear();
    console.warn(
      `Surge guard: >${SURGE_MAX_IPS} distinct IPs within ${SURGE_WINDOW_MS / 60_000} min — locked down for ${SURGE_BLOCK_MS / 60_000} min`,
    );
    return {
      error: "Tjänsten är hårt belastad just nu. Försök igen om en stund.",
      retryAfter: Math.ceil(SURGE_BLOCK_MS / 1000),
    };
  }
  return null;
}

// The frontend listens on an EventSource, so rejections are sent as a
// well-formed SSE error event rather than an HTTP error status.
function sseError(limited: { error: string; retryAfter: number }): Response {
  return new Response(
    `event: error_msg\ndata: ${JSON.stringify(limited)}\n\n`,
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
  );
}

async function handleDownload(req: Request): Promise<Response> {
  try {
    const limited = rateLimit(req);
    if (limited) return sseError(limited);
    const url = new URL(req.url);
    const rawUrl = url.searchParams.get("url")?.trim();
    const mode = url.searchParams.get("mode") || "audio";

    if (!rawUrl || !rawUrl.match(/^https?:\/\//)) {
      return Response.json({ error: "Ogiltig URL" }, { status: 400 });
    }

    // Domain whitelist — top sites supported by yt-dlp
    const ALLOWED_DOMAINS = [
      // YouTube
      "youtube.com", "youtu.be",
      // Swedish media
      "svtplay.se", "sverigesradio.se", "tv4play.se", "tv4.se",
      // Major platforms
      "vimeo.com", "dailymotion.com", "twitch.tv",
      "tiktok.com", "instagram.com", "facebook.com", "fb.watch",
      "twitter.com", "x.com",
      "reddit.com", "v.redd.it",
      "soundcloud.com", "bandcamp.com", "mixcloud.com",
      "bilibili.com", "b23.tv", "nicovideo.jp",
      "rutube.ru", "ok.ru", "vk.com",
      "bitchute.com", "rumble.com", "odysee.com",
      // News & media
      "bbc.co.uk", "bbc.com",
      "cnn.com", "washingtonpost.com", "nytimes.com",
      "theguardian.com",
      "arte.tv", "zdf.de", "ard.de",
      "nrk.no", "dr.dk", "yle.fi", "ruv.is",
      // Streaming clips
      "crunchyroll.com", "funimation.com",
      "ted.com", "cbsnews.com", "nbcnews.com",
      "archive.org", "c-span.org",
      // Podcasts & audio
      "podcasts.apple.com", "spotify.com",
      // Adult
      "pornhub.com", "xvideos.com", "xhamster.com",
      "redtube.com", "youporn.com", "spankbang.com",
      "eporner.com", "tube8.com", "xnxx.com",
      "beeg.com", "4tube.com",
    ];
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.replace(/^www\./, "");
      if (!ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d))) {
        return Response.json({ error: "Domänen stöds inte." }, { status: 400 });
      }
    } catch {
      return Response.json({ error: "Ogiltig URL" }, { status: 400 });
    }

    const tv4 = await resolveTV4Url(await resolveSRUrl(cleanUrl(rawUrl)));
    const videoUrl = tv4.url;
    const id = crypto.randomUUID();
    const ext = mode === "audio" ? "mp3" : "mp4";
    const outTemplate = join(DOWNLOADS_DIR, `${id}.%(ext)s`);

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        function send(event: string, data: unknown) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        }

        // Heartbeat every 15s to keep proxies from killing the connection
        const heartbeat = setInterval(() => {
          if (closed) { clearInterval(heartbeat); return; }
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            closed = true;
            clearInterval(heartbeat);
          }
        }, 15_000);

        try {
          // Step 1: get title (already known when a playback API resolved the URL)
          send("progress", { percent: 0, status: "Hämtar videoinformation..." });

          let title = tv4.title;
          let duration = "";
          if (!title) {
            const infoProc = new Deno.Command(YT_DLP, {
              args: ["--get-title", "--get-duration", "--no-warnings", "--no-playlist", "--", videoUrl],
              stdout: "piped",
              stderr: "piped",
            });
            const infoResult = await infoProc.output();
            const infoLines = new TextDecoder().decode(infoResult.stdout).trim().split("\n");
            title = infoLines[0] || "nedladdning";
            duration = infoLines[1] || "";
          }

          send("info", { title, duration });
          send("progress", { percent: 2, status: `Laddar ner: ${title}` });

          // Step 2: download with progress
          const args = [
            "--no-playlist", "--no-warnings", "--newline",
            "--no-exec",                  // no post-processing commands
            "--no-cache-dir",             // no persistent cache
            "--restrict-filenames",       // safe filenames only
            "--max-filesize", "2G",       // limit file size
            "-o", outTemplate,
          ];

          if (mode === "audio") {
            args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
          } else {
            args.push(
              // HLS manifests carry split video/audio without ext=m4a audio,
              // so they need a looser selector than regular site URLs
              "-f", tv4.isManifest
                ? "bestvideo[height<=1080]+bestaudio/best"
                : "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
              "--merge-output-format", "mp4",
            );
          }

          args.push("--", videoUrl);

          const proc = new Deno.Command(YT_DLP, {
            args,
            stdout: "piped",
            stderr: "piped",
          });

          const child = proc.spawn();

          // Read stdout line by line for progress (yt-dlp --newline sends progress to stdout)
          const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          let lastPercent = 2;

          // Also drain stderr in background
          const stderrDrain = (async () => {
            const r = child.stderr.getReader();
            while (true) {
              const { done } = await r.read();
              if (done) break;
            }
          })();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += value;
            const lines = buf.split("\n");
            buf = lines.pop() || "";

            for (const line of lines) {
              // Match: [download]  45.8% of  105.98MiB at ...
              const m = line.match(/\[download\]\s+([\d.]+)%/);
              if (m) {
                // Scale: 2-95% range for download, leave room for conversion
                const raw = parseFloat(m[1]);
                const scaled = 2 + raw * 0.93;
                if (scaled > lastPercent) {
                  lastPercent = scaled;
                  send("progress", { percent: Math.round(scaled), status: `Laddar ner: ${title}` });
                }
              }
              // Detect merge/conversion step
              if (line.includes("[Merger]") || line.includes("[ExtractAudio]")) {
                send("progress", { percent: 96, status: "Konverterar..." });
              }
            }
          }

          await stderrDrain;

          const status = await child.status;

          if (!status.success) {
            send("error_msg", { error: "Nedladdning misslyckades. Kontrollera URL:en." });
            clearInterval(heartbeat);
        controller.close();
            return;
          }

          // Verify file exists
          const expectedFile = join(DOWNLOADS_DIR, `${id}.${ext}`);
          try {
            await Deno.stat(expectedFile);
          } catch {
            send("error_msg", { error: "Filen kunde inte hittas efter nedladdning." });
            clearInterval(heartbeat);
        controller.close();
            return;
          }

          // Video: probe for variable frame rate. The conversion itself happens
          // in the visitor's browser (ffmpeg.wasm) — we just tell it what to do.
          let cfr: { needsCfr: boolean; targetFps: number; durationSec: number } = {
            needsCfr: false,
            targetFps: 0,
            durationSec: 0,
          };
          if (mode === "video") {
            send("progress", { percent: 97, status: "Analyserar bildfrekvens..." });
            const probe = await probeFrameRate(expectedFile);
            if (probe?.vfr) {
              cfr = { needsCfr: true, targetFps: probe.targetFps, durationSec: probe.durationSec };
            }
          }

          const safeTitle = title
            .replace(/[^\w\sÅÄÖåäö\-]/g, "")
            .replace(/\s+/g, "_")
            .substring(0, 100);
          const filename = `${safeTitle}.${ext}`;

          send("progress", { percent: 100, status: "Klar!" });
          send("done", { file: `${id}.${ext}`, filename, ...cfr });
        } catch (e) {
          console.error("SSE handler error:", e);
          send("error_msg", { error: "Serverfel" });
        }

        clearInterval(heartbeat);
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (e) {
    console.error("Handler error:", e);
    return Response.json({ error: "Serverfel" }, { status: 500 });
  }
}

async function handleServeFile(filePath: string, displayName: string): Promise<Response> {
  const path = join(DOWNLOADS_DIR, filePath);
  if (!path.startsWith(DOWNLOADS_DIR)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const file = await Deno.open(path, { read: true });
    const stat = await Deno.stat(path);
    const ext = filePath.split(".").pop();
    const contentType = ext === "mp3" ? "audio/mpeg" : "video/mp4";
    const encoded = encodeURIComponent(displayName);

    return new Response(file.readable, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      },
    });
  } catch {
    return new Response("Filen hittades inte", { status: 404 });
  }
}

// Nordic countries + common bot/internal codes
const ALLOWED_COUNTRIES = new Set(["SE", "NO", "DK", "FI", "IS", "FO", "AX", "GL", "SJ", "PL", "T1"]);

const BOT_PATTERNS = [
  "facebookexternalhit", "Facebot",         // Meta
  "Twitterbot",                             // X
  "Slackbot", "Slack-ImgProxy",             // Slack
  "LinkedInBot",                            // LinkedIn
  "Discordbot",                             // Discord
  "TelegramBot",                            // Telegram
  "Googlebot", "bingbot",                   // Search engines
];

function isAllowed(req: Request): boolean {
  const country = req.headers.get("cf-ipcountry") || "";
  if (ALLOWED_COUNTRIES.has(country)) return true;

  const ua = req.headers.get("user-agent") || "";
  if (BOT_PATTERNS.some((p) => ua.includes(p))) return true;

  // No CF header = direct/local access (not through Cloudflare)
  if (!country) return true;

  return false;
}

// Optional CORS: allow a static frontend (e.g. a GitHub Pages failover site)
// to call /api/* cross-origin. Set ALLOWED_ORIGIN to that page's origin,
// e.g. "https://inthevidual.github.io" — scheme + host, no path.
const ALLOWED_ORIGIN = (() => {
  try {
    return Deno.env.get("ALLOWED_ORIGIN") || "";
  } catch {
    return ""; // no --allow-env granted
  }
})();

function applyCors(req: Request, res: Response): Response {
  if (!ALLOWED_ORIGIN) return res;
  const origin = req.headers.get("origin");
  if (origin !== ALLOWED_ORIGIN) return res;
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Vary", "Origin");
  return res;
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  const country = req.headers.get("cf-ipcountry") || "-";
  const ua = req.headers.get("user-agent") || "-";
  console.log(`${req.method} ${url.pathname} [${country}] ${ua.substring(0, 80)}`);

  if (!isAllowed(req)) {
    return new Response("Denna tjänst är bara tillgänglig i Norden.", { status: 403 });
  }

  if (url.pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") {
      return applyCors(req, new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Methods": "GET, OPTIONS" },
      }));
    }
    // Lightweight health endpoint for the failover page to probe
    if (url.pathname === "/api/health") {
      return applyCors(req, Response.json({ ok: true }));
    }
  }

  // SSE download endpoint
  if (url.pathname === "/api/download" && req.method === "GET") {
    return applyCors(req, await handleDownload(req));
  }

  if (url.pathname.startsWith("/api/file/")) {
    const file = url.pathname.replace("/api/file/", "");
    if (!file.match(/^[a-f0-9\-]+\.(mp3|mp4)$/)) {
      return new Response("Ogiltig fil", { status: 400 });
    }
    const limited = rateLimit(req);
    if (limited) {
      return applyCors(req, Response.json(limited, {
        status: 429,
        headers: { "Retry-After": String(limited.retryAfter) },
      }));
    }
    const displayName = url.searchParams.get("name") || file;
    return applyCors(req, await handleServeFile(file, displayName));
  }

  if (url.pathname === "/" || url.pathname === "") {
    return serveFile(req, join(PUBLIC_DIR, "index.html"));
  }

  const filePath = join(PUBLIC_DIR, url.pathname);
  if (filePath.startsWith(PUBLIC_DIR)) {
    try {
      return await serveFile(req, filePath);
    } catch {
      // fall through to 404
    }
  }

  return new Response("404", { status: 404 });
});

console.log(`Sug på tuben körs på http://localhost:${PORT}`);
