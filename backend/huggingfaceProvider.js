import { Client } from "@gradio/client";
import sharp from "sharp";
import { config } from "./config.js";

/**
 * Free-tier provider — calls the public Hugging Face Space
 * "zerogpu-aoti/wan2-2-fp8da-aoti-faster": Wan 2.2 14B Image-to-Video
 * with Lightning LoRA distillation, FP8 quantization + AOT compile,
 * running on free ZeroGPU (H200) hardware. No paid API, no card.
 *
 * Re-verified against the Space's live app.py on 2026-07-31 (unchanged
 * since the last check):
 *   - underlying fn: generate_video(input_image, prompt, steps,
 *       negative_prompt, duration_seconds, guidance_scale,
 *       guidance_scale_2, seed, randomize_seed) -> (video_path, seed)
 *   - Fixed 16fps, 8-80 frames (0.5s-5.0s duration). Our DURATION_SECONDS=5
 *     and STEPS=8 are both within the Space's own supported/documented
 *     ranges (max duration is exactly 5.0; the Space's own description
 *     says its Lightning LoRA is tuned for a 4-8 step fast range) — this
 *     was double-checked against the live get_duration() formula, which
 *     puts our worst case at ~90-95s of GPU compute. That is NOT what
 *     causes the "stuck at 15%" symptom below; it's well within what
 *     this Space is built to request. Left unchanged.
 *   - Status events (verified against @gradio/client's own docs) carry a
 *     `stage` field ("pending"|"generating"|"complete"|"error"), plus
 *     `position`, `queue_size`, `eta`, `progress_data`. The submission
 *     object also exposes `.cancel()`.
 *
 * WHY GENERATION COULD HANG INDEFINITELY (the bug being fixed here):
 * This Space runs on a single shared public queue (Gradio's default
 * concurrency is 1 request at a time for a given endpoint). If several
 * people are ahead of us, or the underlying event stream to Hugging
 * Face stalls, @gradio/client's `for await` loop simply has nothing to
 * iterate — it doesn't error, it just never resolves the next step.
 * The OLD code had no ceiling on that wait at all, so a stalled queue
 * or dropped connection meant the job sat at whatever progress % it
 * last reported, forever. The fix: a hard local watchdog timeout (see
 * GENERATION_TIMEOUT_MS) that always resolves the job one way or the
 * other, using Promise.race + submission.cancel(), regardless of what
 * Hugging Face's server does or doesn't send us.
 *
 * Gradio api_name: same fallback strategy as before — "/generate_video"
 * is tried first; "/generate_video_1" is only tried if we receive ZERO
 * events on the first name (a real routing rejection fails fast, not
 * after a long wait, so this never gets confused with a slow queue).
 *
 * Swapping to a commercial provider later: create a new file with the
 * same generate()/checkStatus() shape (see provider.interface.js),
 * then set VIDEO_PROVIDER in .env. server.js and the frontend stay
 * unchanged.
 */

const CANDIDATE_API_NAMES = ["/generate_video", "/generate_video_1"];

// Hard ceiling on how long we'll wait for ONE generation attempt before
// giving up and reporting failure. This is a REAL watchdog — it fires
// even if zero events ever arrive from Hugging Face.
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// In-memory job store. Fine for a single prototype server; replace with
// Redis/a database before running more than one server instance.
const jobs = new Map();

// How long a generation typically takes on this Space, used only to
// pace the progress bar when it doesn't report exact percentages.
const EXPECTED_DURATION_MS = 95_000;

// This Space's own native target resolutions (see resize_image() in
// its app.py: MAX_DIM=832, MIN_DIM=480, SQUARE_DIM=640, multiples of
// 16). Pre-cropping to these exact sizes means the Space's internal
// resize is a no-op — no extra cropping/reframing happens server-side.
const TARGET_DIMENSIONS = {
  "16:9": { width: 832, height: 480 },
  "9:16": { width: 480, height: 832 },
  "1:1": { width: 640, height: 640 },
};

// Generation settings — unchanged from the last review. See the header
// comment above for why 8 steps / 5s is a supported combination and
// not the cause of the hang this update fixes.
const STEPS = 8;
const DURATION_SECONDS = 5;
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

// --- structured logging (Render Live Tail friendly) ---
// Never logs HF_TOKEN, image bytes, or other sensitive data — only
// job ids, stage names, and short status text.
function log(jobId, message) {
  console.log(`[HF] Job ${jobId} — ${message}`);
}

export const huggingfaceProvider = {
  async generate({ imageBuffer, mimeType, prompt, aspectRatio }) {
    const jobId = `hf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    log(jobId, "created");
    jobs.set(jobId, { status: "queued", progress: 3, startedAt: Date.now() });

    // Runs in the background — the HTTP request returns immediately
    // with the jobId so the frontend can poll for progress.
    runJob(jobId, { imageBuffer, mimeType, prompt, aspectRatio }).catch((err) => {
      log(jobId, `error: ${err.message}`);
      setJobSafe(jobId, {
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

// Writes job state UNLESS the job has already reached a terminal state
// (complete/failed). This is what prevents a late event from an
// abandoned/timed-out submission from ever overwriting a job that has
// already been resolved one way or the other.
function setJobSafe(jobId, patch) {
  const current = jobs.get(jobId);
  if (current && (current.status === "complete" || current.status === "failed")) {
    return; // already finalized — ignore stale updates
  }
  jobs.set(jobId, { ...current, ...patch });
}

async function runJob(jobId, { imageBuffer, mimeType, prompt, aspectRatio }) {
  const startedAt = jobs.get(jobId).startedAt;
  setJobSafe(jobId, { status: "queued", progress: 8, startedAt });

  log(jobId, "preparing image");
  const dims = TARGET_DIMENSIONS[aspectRatio] || TARGET_DIMENSIONS["9:16"];
  const preparedImage = await sharp(imageBuffer)
    .rotate() // respect EXIF orientation from phone cameras
    .resize(dims.width, dims.height, { fit: "cover", position: "centre" })
    .png({ compressionLevel: 6 })
    .toBuffer();

  log(jobId, "connecting to Space");
  const client = await getClient();
  log(jobId, "connected");
  const imageBlob = new Blob([preparedImage], { type: "image/png" });

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
      if (err.isTimeout) {
        // A stalled queue or dropped connection — never worth retrying
        // a different endpoint name, and never silent. Fails now.
        throw err;
      }
      const canFallBack =
        !err.receivedAnyEvent && isRoutingError(err) && i < CANDIDATE_API_NAMES.length - 1;
      if (canFallBack) {
        lastRoutingError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastRoutingError || new Error("Could not reach the video model.");
}

/**
 * Runs one generation attempt against one candidate endpoint name, with
 * a hard timeout. Always resolves or rejects within GENERATION_TIMEOUT_MS,
 * regardless of what Hugging Face's server does.
 */
async function runCandidateWithTimeout(client, apiName, args, jobId, startedAt) {
  log(jobId, `submitting to ${apiName}`);
  const submission = client.submit(apiName, args);
  log(jobId, "submission created");

  let receivedAnyEvent = false;
  let sawGenerating = false;
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
        if (event.stage === "generating" && !sawGenerating) {
          sawGenerating = true;
          log(jobId, "generation started");
        }

        const reported = extractReportedProgress(event);
        const elapsedPct = Math.min(
          90,
          Math.round(((Date.now() - startedAt) / EXPECTED_DURATION_MS) * 90)
        );
        const progress = Math.max(15, reported ?? elapsedPct);
        setJobSafe(jobId, { status: "processing", progress, startedAt });
      }

      if (event.type === "data") {
        log(jobId, "data received");
        const videoUrl = extractVideoUrl(event.data?.[0]);
        if (videoUrl) return { videoUrl };
      }
    }
    throw new Error(
      "The Space finished but didn't return a video. It may have changed its output format."
    );
  })();

  // Prevents an "unhandled promise rejection" if the timeout wins the
  // race below and this promise later rejects on its own with nobody
  // awaiting it directly.
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
    if (submission && typeof submission.cancel === "function") {
      submission.cancel();
    }
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
  return null;
}

function friendlyErrorMessage(err) {
  if (err && err.isTimeout) return err.message;

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
