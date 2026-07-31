import { Client } from "@gradio/client";
import sharp from "sharp";
import { config } from "./config.js";

/**
 * Free-tier provider — calls the public Hugging Face Space
 * "zerogpu-aoti/wan2-2-fp8da-aoti-faster": Wan 2.2 14B Image-to-Video
 * with Lightning LoRA distillation, FP8 quantization + AOT compile,
 * running on free ZeroGPU (H200) hardware. No paid API, no card.
 *
 * Verified against the Space's actual source (app.py) on 2026-07-30:
 *   - underlying fn: generate_video(input_image, prompt, steps,
 *       negative_prompt, duration_seconds, guidance_scale,
 *       guidance_scale_2, seed, randomize_seed) -> (video_path, seed)
 *   - bound as: generate_button.click(fn=generate_video, inputs=[
 *       input_image, prompt, steps, negative_prompt, duration_seconds,
 *       guidance_scale, guidance_scale_2, seed, randomize_seed])
 *   - REAL text-prompt conditioning (unlike the old SVD provider —
 *     no more motion-keyword guessing; the prompt goes to the model).
 *   - Resolution handling is dynamic: square input -> 640x640; other
 *     aspect ratios are clamped/cropped between 480-832px per side, in
 *     multiples of 16. We pre-crop to the Space's own native target
 *     sizes below so ITS internal cropping is a no-op and nothing gets
 *     stretched or unexpectedly re-framed.
 *   - Fixed 16fps, 8-80 frames (0.5s-5.0s duration).
 *
 * One thing we could NOT verify by executing code (no outbound network
 * access from where this was written): the exact auto-assigned Gradio
 * api_name, since the Space's app.py doesn't set one explicitly. Gradio
 * defaults to "/<function_name>" ("/generate_video" here), but this
 * function is wired to TWO events (the Generate button, and a cached
 * Examples gallery) — Gradio may suffix the second one. CANDIDATE_API_NAMES
 * below tries "/generate_video" first; if that call ends WITHOUT ever
 * receiving a single event from the Space (meaning the name itself was
 * rejected before any GPU time was spent), it retries once with
 * "/generate_video_1". Once real events start arriving, no more fallback
 * attempts happen — a genuine generation failure is never mistaken for a
 * routing problem or retried at GPU cost. If both candidates ever stop
 * working (the Space's code changed), the error message will say so
 * clearly, and this is the one line to check first.
 *
 * Swapping to a commercial provider later: create
 * providers/<name>Provider.js with the same generate()/checkStatus()
 * shape (see provider.interface.js), then set VIDEO_PROVIDER in .env.
 * server.js and the entire frontend stay unchanged.
 */

const CANDIDATE_API_NAMES = ["/generate_video", "/generate_video_1"];

// In-memory job store. Fine for a single prototype server; replace with
// Redis/a database before running more than one server instance.
const jobs = new Map();

// How long a generation typically takes on this Space, used only to
// pace the progress bar when it doesn't report exact percentages.
const EXPECTED_DURATION_MS = 60_000;

// This Space's own native target resolutions (see resize_image() in
// its app.py: MAX_DIM=832, MIN_DIM=480, SQUARE_DIM=640, multiples of
// 16). Pre-cropping to these exact sizes means the Space's internal
// resize is a no-op — no extra cropping/reframing happens server-side.
const TARGET_DIMENSIONS = {
  "16:9": { width: 832, height: 480 },
  "9:16": { width: 480, height: 832 },
  "1:1": { width: 640, height: 640 },
};

// Generation settings. Steps 6 and duration 3s match this Space's own
// UI defaults closely while keeping generation time reasonable on a
// shared free GPU. guidance_scale 1 is correct for the Lightning LoRA
// distilled steps this Space uses (higher values are for non-distilled
// models and would just slow things down here).
const STEPS = 6;
const DURATION_SECONDS = 3;
const GUIDANCE_SCALE = 1;
const GUIDANCE_SCALE_2 = 1;

// Copied verbatim from the Space's own app.py — this is the negative
// prompt the model's authors tuned it against, not creative text.
const NEGATIVE_PROMPT =
  "色调艳丽, 过曝, 静态, 细节模糊不清, 字幕, 风格, 作品, 画作, 画面, 静止, 整体发灰, 最差质量, 低质量, JPEG压缩残留, 丑陋的, 残缺的, 多余的手指, 画得不好的手部, 画得不好的脸部, 畸形的, 毁容的, 形态畸形的肢体, 手指融合, 静止不动的画面, 杂乱的背景, 三条腿, 背景人很多, 倒着走";

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
    const { status, progress, videoUrl, message } = job;
    return { status, progress, videoUrl, message };
  },
};

async function runJob(jobId, { imageBuffer, mimeType, prompt, aspectRatio }) {
  const startedAt = jobs.get(jobId).startedAt;
  jobs.set(jobId, { status: "queued", progress: 8, startedAt });

  // 1. Crop the source photo to this Space's own native target size
  //    for the chosen aspect ratio (see TARGET_DIMENSIONS comment above).
  const dims = TARGET_DIMENSIONS[aspectRatio] || TARGET_DIMENSIONS["9:16"];
  const preparedImage = await sharp(imageBuffer)
    .rotate() // respect EXIF orientation from phone cameras
    .resize(dims.width, dims.height, { fit: "cover", position: "centre" })
    .jpeg({ quality: 92 })
    .toBuffer();

  const client = await getClient();
  const imageBlob = new Blob([preparedImage], { type: "image/jpeg" });

  const args = [
    imageBlob, // input_image
    prompt, // prompt — sent to the model directly, real conditioning
    STEPS, // steps
    NEGATIVE_PROMPT, // negative_prompt
    DURATION_SECONDS, // duration_seconds
    GUIDANCE_SCALE, // guidance_scale
    GUIDANCE_SCALE_2, // guidance_scale_2
    Math.floor(Math.random() * 2_147_483_647), // seed (overridden by randomize_seed below anyway)
    true, // randomize_seed
  ];

  jobs.set(jobId, { status: "processing", progress: 15, startedAt });

  let lastRoutingError;
  for (let i = 0; i < CANDIDATE_API_NAMES.length; i++) {
    const apiName = CANDIDATE_API_NAMES[i];
    let receivedAnyEvent = false;

    try {
      const submission = client.submit(apiName, args);

      for await (const event of submission) {
        receivedAnyEvent = true;

        if (event.type === "status") {
          if (event.stage === "error") {
            throw new Error(event.message || "The model host reported an error.");
          }
          const reported = extractReportedProgress(event);
          const elapsedPct = Math.min(
            90,
            Math.round(((Date.now() - startedAt) / EXPECTED_DURATION_MS) * 90)
          );
          const progress = Math.max(15, reported ?? elapsedPct);
          jobs.set(jobId, { status: "processing", progress, startedAt });
        }

        if (event.type === "data") {
          const videoUrl = extractVideoUrl(event.data?.[0]);
          if (videoUrl) {
            jobs.set(jobId, { status: "complete", progress: 100, videoUrl, startedAt });
            return;
          }
        }
      }

      // The stream ended without ever sending a video. This candidate
      // DID connect successfully, so this is a real failure, not a
      // routing problem — don't try the next name for it.
      throw new Error(
        "The Space finished but didn't return a video. It may have changed its output format."
      );
    } catch (err) {
      // Only treat this as "wrong endpoint name, try the next one" if
      // we never received a single event — meaning nothing (including
      // GPU time) actually ran yet. Anything after a real event started
      // is a genuine generation failure and must propagate as-is.
      const canFallBack =
        !receivedAnyEvent && isRoutingError(err) && i < CANDIDATE_API_NAMES.length - 1;

      if (canFallBack) {
        lastRoutingError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastRoutingError || new Error("Could not reach the video model.");
}

function isRoutingError(err) {
  const msg = (err && err.message) || "";
  return /not found|no endpoint|unknown|invalid api|does not exist/i.test(msg);
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
    return "The free model has hit its shared GPU quota for now. Wait a bit and try again — quota resets over time.";
  }
  if (/queue/i.test(msg)) {
    return "The free model's queue is full right now. Please wait a minute and try again.";
  }
  if (/timeout|timed out/i.test(msg)) {
    return "The free model took too long to respond. Please try again — it can be slow at busy times.";
  }
  if (/not found|no endpoint|unknown|invalid api|does not exist/i.test(msg)) {
    return "The free model's API has changed shape. This needs a quick code update — see the provider file's comments.";
  }
  return msg || "Generation failed. Please try again.";
}
