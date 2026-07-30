import express from "express";
import cors from "cors";
import multer from "multer";
import { Readable } from "node:stream";
import { config } from "./config.js";
import { huggingfaceProvider } from "./providers/huggingfaceProvider.js";

/**
 * Provider registry. To add a commercial provider later:
 *   1. Create providers/runwayProvider.js (or similar) implementing
 *      generate()/checkStatus() — see providers/provider.interface.js
 *   2. Import it here and add it to this map.
 *   3. Set VIDEO_PROVIDER in .env to select it.
 * server.js and the entire frontend stay unchanged.
 */
const providers = {
  huggingface: huggingfaceProvider,
};

const provider = providers[config.provider];
if (!provider) {
  throw new Error(`Unknown VIDEO_PROVIDER "${config.provider}"`);
}

const app = express();
app.use(cors());

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

app.post("/api/generate", upload.single("image"), async (req, res) => {
  try {
    const { prompt, aspectRatio } = req.body;
    const image = req.file;

    if (!image) {
      return res.status(400).json({ message: "No image was uploaded." });
    }
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ message: "A motion prompt is required." });
    }

    const validRatios = ["9:16", "16:9", "1:1"];
    const safeAspectRatio = validRatios.includes(aspectRatio) ? aspectRatio : "9:16";

    const { jobId } = await provider.generate({
      imageBuffer: image.buffer,
      mimeType: image.mimetype,
      prompt: prompt.trim(),
      aspectRatio: safeAspectRatio,
    });

    res.json({ jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not start generation. Please try again." });
  }
});

app.get("/api/status/:jobId", async (req, res) => {
  try {
    const result = await provider.checkStatus(req.params.jobId);

    // IMPORTANT: never send the raw Hugging Face file URL to the
    // browser. HF's file host rejects requests that don't come from
    // huggingface.co ("Forbidden embedding"), so the frontend can't
    // load it directly. Instead we hand back a path on OUR OWN
    // backend, which fetches the real file server-side and streams it
    // through — see /api/video/:jobId below.
    if (result.status === "complete") {
      return res.json({
        status: "complete",
        progress: 100,
        videoUrl: `/api/video/${req.params.jobId}`,
      });
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not check job status." });
  }
});

// Streams the generated video from Hugging Face through our own
// backend, so the browser only ever talks to our domain — this is
// what fixes the "Forbidden embedding" error. Supports HTTP range
// requests so scrubbing/seeking works in mobile video players too.
app.get("/api/video/:jobId", async (req, res) => {
  try {
    const job = await provider.checkStatus(req.params.jobId);

    if (job.status !== "complete" || !job.videoUrl) {
      return res.status(404).json({
        message: "This video isn't available anymore. Please generate a new one.",
      });
    }

    if (req.query.download) {
      res.setHeader("Content-Disposition", 'attachment; filename="reel-video.mp4"');
    }

    await proxyVideo(job.videoUrl, req, res);
  } catch (err) {
    console.error("Video proxy error:", err);
    if (!res.headersSent) {
      res.status(502).json({
        message: "Could not retrieve the generated video. Please try generating a new one.",
      });
    } else {
      res.end();
    }
  }
});

/**
 * Fetches a video from an upstream URL (server-side, so HF's
 * hotlink/embedding restriction never applies) and pipes it straight
 * through to the browser with the right headers for playback and
 * range requests.
 */
async function proxyVideo(sourceUrl, req, res) {
  const upstreamHeaders = {
    // Some HF-hosted file URLs only serve requests that look like they
    // came from huggingface.co — this is exactly the check that
    // rejects direct-from-Netlify requests. A server-to-server fetch
    // with this Referer set satisfies it.
    Referer: "https://huggingface.co/",
  };
  if (config.huggingface.apiToken) {
    upstreamHeaders.Authorization = `Bearer ${config.huggingface.apiToken}`;
  }
  if (req.headers.range) {
    upstreamHeaders.Range = req.headers.range;
  }

  const upstream = await fetch(sourceUrl, { headers: upstreamHeaders });

  if (!upstream.ok && upstream.status !== 206) {
    throw new Error(`Upstream video host returned status ${upstream.status}`);
  }
  if (!upstream.body) {
    throw new Error("Upstream video host returned an empty response.");
  }

  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.setHeader("Content-Length", contentLength);

  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.setHeader("Content-Range", contentRange);

  await new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.pipe(res);
    nodeStream.on("end", resolve);
    nodeStream.on("error", reject);
    res.on("close", resolve);
  });
}

app.get("/api/health", (_req, res) => res.json({ ok: true, provider: config.provider }));

// Catches multer errors (oversized file, etc.) with a friendly message
// instead of a raw stack trace.
app.use((err, _req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ message: "That image is over 10MB. Please choose a smaller file." });
  }
  console.error(err);
  res.status(500).json({ message: "Something went wrong on the server." });
});

app.listen(config.port, () => {
  console.log(`Reel backend listening on http://localhost:${config.port}`);
  console.log(`Active provider: ${config.provider}`);
});
