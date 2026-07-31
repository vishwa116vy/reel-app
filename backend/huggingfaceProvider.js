import { Client } from "@gradio/client";
import sharp from "sharp";
import { config } from "./config.js";

const CANDIDATE_API_NAMES = ["/generate_video", "/generate_video_1"];
const GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
const EXPECTED_DURATION_MS = 8 * 60 * 1000;

const jobs = new Map();

const TARGET_DIMENSIONS = {
  "16:9": { width: 832, height: 480 },
  "9:16": { width: 480, height: 832 },
  "1:1": { width: 640, height: 640 },
};

// Conservative first test using the Space UI's own defaults.
const STEPS = 8;
const DURATION_SECONDS = 5;
const GUIDANCE_SCALE = 1;
const GUIDANCE_SCALE_2 = 1;

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

function log(jobId, message) {
  console.log(`[HF] Job ${jobId} — ${message}`);
}

export const huggingfaceProvider = {
  async generate({ imageBuffer, mimeType, prompt, aspectRatio }) {
    const jobId = `hf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log(jobId, "created");
    jobs.set(jobId, { status: "queued", progress: 3, startedAt: Date.now() });

    runJob(jobId, { imageBuffer, mimeType, prompt, aspectRatio }).catch((err) => {
      log(jobId, `error: ${err.message}`);
      setJobSafe(jobId, { status: "failed", message: friendlyErrorMessage(err) });
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

function setJobSafe(jobId, patch) {
  const current = jobs.get(jobId);
  if (current && (current.status === "complete" || current.status === "failed")) return;
  jobs.set(jobId, { ...current, ...patch });
}

async function runJob(jobId, { imageBuffer, prompt, aspectRatio }) {
  const startedAt = jobs.get(jobId).startedAt;
  setJobSafe(jobId, { status: "queued", progress: 8, startedAt });

  log(jobId, "preparing image");
  const dims = TARGET_DIMENSIONS[aspectRatio] || TARGET_DIMENSIONS["9:16"];
  const preparedImage = await sharp(imageBuffer)
    .rotate()
    .resize(dims.width, dims.height, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 6 })
    .toBuffer();

  log(jobId, `connecting to Space ${config.huggingface.spaceId}`);
  const client = await getClient();
  log(jobId, "connected");

  const imageBlob = new Blob([preparedImage], { type: "image/png" });

  // Current official Space API: image, prompt, steps, negative_prompt,
  // duration_seconds, guidance_scale, guidance_scale_2, seed, randomize_seed.
  const args = [
    imageBlob,
    prompt,
    STEPS,
    NEGATIVE_PROMPT,
    DURATION_SECONDS,
    GUIDANCE_SCALE,
    GUIDANCE_SCALE_2,
    Math.floor(Math.random() * 2_147_483_647),
    true,
  ];

  setJobSafe(jobId, { status: "processing", progress: 15, startedAt });

  let lastRoutingError;
  for (let i = 0; i < CANDIDATE_API_NAMES.length; i++) {
    const apiName = CANDIDATE_API_NAMES[i];
    try {
      const videoUrl = await runCandidateWithTimeout(client, apiName, args, jobId, startedAt);
      log(jobId, "generation complete");
      setJobSafe(jobId, { status: "complete", progress: 100, videoUrl, startedAt });
      return;
    } catch (err) {
      if (err.isTimeout) throw err;
      const canFallBack =
        !err.receivedAnyEvent && isRoutingError(err) && i < CANDIDATE_API_NAMES.length - 1;
      if (canFallBack) {
        log(jobId, `${apiName} routing failed; trying fallback endpoint`);
        lastRoutingError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastRoutingError || new Error("Could not reach the video model.");
}

async function runCandidateWithTimeout(client, apiName, args, jobId, startedAt) {
  log(jobId, `submitting to ${apiName}`);
  const submission = client.submit(apiName, args);
  log(jobId, "submission created");

  let receivedAnyEvent = false;
  let timeoutHandle;

  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), GENERATION_TIMEOUT_MS);
  });

  const runPromise = (async () => {
    for await (const event of submission) {
      receivedAnyEvent = true;

      if (event.type === "status") {
        log(
          jobId,
          `status event: stage=${event.stage} position=${event.position ?? "-"} eta=${event.eta ?? "-"}`
        );

        if (event.stage === "error") {
          throw new Error(event.message || "The model host reported an error.");
        }

        const reported = extractReportedProgress(event);
        const elapsedPct = Math.min(
          90,
          Math.round(((Date.now() - startedAt) / EXPECTED_DURATION_MS) * 90)
        );
        setJobSafe(jobId, {
          status: event.stage === "pending" ? "queued" : "processing",
          progress: Math.max(15, reported ?? elapsedPct),
          startedAt,
        });
      }

      if (event.type === "data") {
        log(jobId, "data received");
        // Official Space returns the generated video as the first output.
        const videoUrl = extractVideoUrl(event.data?.[0]) || extractVideoUrl(event.data?.[1]);
        if (videoUrl) return { videoUrl };
      }
    }

    throw new Error(
      "The Space finished but didn't return a video. Its API/output format may have changed."
    );
  })();

  runPromise.catch(() => {});

  try {
    const result = await Promise.race([runPromise, timeoutPromise]);

    if (result.timedOut) {
      log(jobId, "timeout — cancelling submission");
      safeCancel(submission, jobId);
      const err = new Error(
        "The free AI model took too long to respond. The ZeroGPU queue may be busy. Please try again."
      );
      err.isTimeout = true;
      err.receivedAnyEvent = receivedAnyEvent;
      throw err;
    }

    return result.videoUrl;
  } catch (err) {
    if (!("receivedAnyEvent" in err)) err.receivedAnyEvent = receivedAnyEvent;
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function safeCancel(submission, jobId) {
  try {
    if (submission && typeof submission.cancel === "function") submission.cancel();
  } catch (err) {
    log(jobId, `cancel() failed (non-fatal): ${err.message}`);
  }
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
  if (output.path && /^https?:\/\//i.test(output.path)) return output.path;
  return null;
}

function friendlyErrorMessage(err) {
  if (err && err.isTimeout) return err.message;
  const msg = (err && err.message) || "";
  if (/quota/i.test(msg))
    return "The free model has hit its shared GPU quota for now. Wait a bit and try again.";
  if (/queue/i.test(msg))
    return "The free model's queue is full right now. Please wait and try again.";
  if (/timeout|timed out/i.test(msg))
    return "The free model took too long to respond. Please try again.";
  if (/not found|no endpoint|unknown|invalid api|does not exist/i.test(msg))
    return "The free model's API endpoint has changed. The provider needs a small update.";
  return msg || "Generation failed. Please try again.";
}
