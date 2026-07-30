import express from "express";
import cors from "cors";
import multer from "multer";
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
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Could not check job status." });
  }
});

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
