import { Client } from "@gradio/client";
import sharp from "sharp";
import { config } from "../config.js";

/**
 * Free-tier provider — calls the public Hugging Face Space
 * "multimodalart/stable-video-diffusion" (Stable Video Diffusion XT,
 * running on free ZeroGPU hardware). No paid API, no card.
 *
 * Verified against the Space's actual source (app.py) on 2026-07-30:
 *   - api endpoint name: "/video"
 *   - inputs (in order): image, seed, randomize_seed, motion_bucket_id, fps_id
 *   - outputs: video, seed
 *
 * Known limitations of this free model (be upfront with users about these):
 *   - SVD is IMAGE-ONLY — it has no text-prompt input. There is no free
 *     model we could find that does true text-guided image-to-video
 *     without a paid API. To still make the prompt useful, this provider
 *     scans it for motion keywords ("slow"/"gentle" vs "fast"/"dramatic")
 *     and maps that to the model's motion_bucket_id parameter. It's a
 *     real, working approximation, not full prompt-conditioning.
 *   - Public Space, shared GPU queue: expect 30s-3min depending on load,
 *     and occasional "queue full" or "GPU quota exceeded" errors — this
 *     provider surfaces those as a clear, retryable error message.
 *   - Output is a fixed ~4 second clip (25 frames at 6fps).
 *
 * Swapping to a commercial provider later: create
 * providers/<name>Provider.js with the same generate()/checkStatus()
 * shape (see provider.interface.js), then set VIDEO_PROVIDER in .env.
 * server.js and the entire frontend stay unchanged.
 */

// In-memory job store. Fine for a single prototype server; replace with
// Redis/a database before running more than one server instance.
const jobs = new Map();

// How long a generation typically takes on this Space, used only to
// pace the progress bar when the Space doesn't report exact percentages.
const EXPECTED_DURATION_MS = 75_000;

// The Space was trained/tuned at 1024x576. We crop the uploaded photo to
// match the requested aspect ratio before sending it, so the output
// video actually comes back in the shape the user picked.
const TARGET_DIMENSIONS = {
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "1:1": { width: 768, height: 768 },
};

let clientPromise = null;
async function getClient() {
  if (!clientPromise) {
    clientPromise = Client.connect(config.huggingface.spaceId, {
      hf_token: config.huggingface.apiToken || undefined,
    });
  }
  return clientPromise;
}

export const huggingfaceProvider = {
  async generate({ imageBuffer, mimeType, prompt, aspectRatio }) {
    const jobId = `hf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, { status: "queued", progress: 3, startedAt: Date.now() });

    // Runs in the background — the HTTP request returns immediately
    // with the jobId so the frontend can poll for progress.
    runJob(jobId, { imageBuffer, mimeType, prompt, aspectRatio }).catch((err) => {
      jobs.set(jobId, {
        status: "failed",
        message: friendlyErrorMessage(err),
      });
    });

    return { jobId };
  },

  async checkStatus(jobId) {
    const job = jobs.get(jobId);
    if (!job) return { status: "failed", message: "Unknown job." };
    // Don't leak internal bookkeeping fields to the frontend.
    const { status, progress, videoUrl, message } = job;
    return { status, progress, videoUrl, message };
  },
};

async function runJob(jobId, { imageBuffer, mimeType, prompt, aspectRatio }) {
  const startedAt = jobs.get(jobId).startedAt;
  jobs.set(jobId, { status: "queued", progress: 8, startedAt });

  // 1. Crop the source photo to match the chosen aspect ratio.
  const dims = TARGET_DIMENSIONS[aspectRatio] || TARGET_DIMENSIONS["9:16"];
  const preparedImage = await sharp(imageBuffer)
    .rotate() // respect EXIF orientation from phone cameras
    .resize(dims.width, dims.height, { fit: "cover", position: "centre" })
    .jpeg({ quality: 92 })
    .toBuffer();

  // 2. Turn the free-text prompt into the model's motion parameter.
  const motionBucketId = motionBucketFromPrompt(prompt);

  // 3. Connect to the Space and submit the job.
  const client = await getClient();
  const imageBlob = new Blob([preparedImage], { type: "image/jpeg" });

  const submission = client.submit("/video", [
    imageBlob, // image
    Math.floor(Math.random() * 1_000_000), // seed (arbitrary; randomize_seed below overrides it anyway)
    true, // randomize_seed
    motionBucketId, // motion_bucket_id (1-255)
    6, // fps_id
  ]);

  jobs.set(jobId, { status: "processing", progress: 15, startedAt });

  for await (const event of submission) {
    if (event.type === "status") {
      if (event.stage === "error") {
        throw new Error(event.message || "The model host reported an error.");
      }

      // Different @gradio/client versions expose progress differently —
      // use a real number if one is available, otherwise pace the bar
      // by elapsed time so the UI still feels alive.
      const reported = extractReportedProgress(event);
      const elapsedPct = Math.min(
        90,
        Math.round(((Date.now() - startedAt) / EXPECTED_DURATION_MS) * 90)
      );
      const progress = Math.max(15, reported ?? elapsedPct);

      jobs.set(jobId, {
        status: "processing",
        progress,
        startedAt,
      });
    }

    if (event.type === "data") {
      const videoUrl = extractVideoUrl(event.data?.[0]);
      if (videoUrl) {
        jobs.set(jobId, { status: "complete", progress: 100, videoUrl, startedAt });
        return;
      }
    }
  }

  throw new Error(
    "The Space finished but didn't return a video. It may have changed its output format."
  );
}

function motionBucketFromPrompt(prompt = "") {
  const text = prompt.toLowerCase();
  const gentle = /(gentle|subtle|slow|calm|slight|still|soft|barely)/.test(text);
  const strong = /(fast|dramatic|energetic|wild|intense|rapid|explosive|violent|shake)/.test(text);
  if (gentle && !strong) return 60;
  if (strong && !gentle) return 200;
  return 127; // balanced default
}

function extractReportedProgress(event) {
  if (typeof event.progress === "number") return Math.round(event.progress * 100);
  const item = event.progress_data?.[0];
  if (item && typeof item.progress === "number") return Math.round(item.progress * 100);
  return null;
}

function extractVideoUrl(output) {
  if (!output) return null;
  if (typeof output === "string") return output;
  if (output.video?.url) return output.video.url;
  if (output.url) return output.url;
  return null;
}

function friendlyErrorMessage(err) {
  const msg = (err && err.message) || "";
  if (/quota/i.test(msg)) {
    return "The free model has hit its usage quota for now. Wait a few minutes and try again, or add a free Hugging Face account token (see README) for a higher quota.";
  }
  if (/queue/i.test(msg)) {
    return "The free model's queue is full right now. Please wait a minute and try again.";
  }
  if (/timeout|timed out/i.test(msg)) {
    return "The free model took too long to respond. Please try again — it can be slow at busy times.";
  }
  return msg || "Generation failed. Please try again.";
}
