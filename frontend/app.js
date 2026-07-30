/* =====================================================================
   REEL — app.js

   This file is split into two parts on purpose:

   1. VideoAPI — a small client that talks to the backend. This is the
      ONLY place that knows about network requests. When you swap the
      free backend model for a commercial API (Runway, Kling, Luma,
      Pika, etc.), you only touch backend/providers/*.js — this file
      and everything below it never needs to change, as long as the
      backend keeps returning the same { jobId } / { status, videoUrl }
      shape.

   2. UI wiring — DOM logic for the upload, prompt, aspect ratio,
      progress and result screens.
===================================================================== */

const CONFIG = {
  // Your backend's address. localhost:3001 while you're running it on
  // your own computer for testing; swap this to your deployed backend
  // URL once you host it (see README).
  API_BASE_URL: window.REEL_API_BASE_URL || "https://reel-app-vbiw.onrender.com",

  // Now connected to the real backend by default. Set this back to
  // true any time you want to click through the UI with no backend
  // running at all (e.g. while iterating on design).
  DEMO_MODE: false,
};

/* ---------------------------------------------------------------------
   1. VideoAPI — backend client (modular, swappable)
--------------------------------------------------------------------- */

const VideoAPI = {
  /**
   * Kicks off a generation job.
   * @param {{ imageFile: File, prompt: string, aspectRatio: string }} input
   * @returns {Promise<{ jobId: string }>}
   */
  async startGeneration({ imageFile, prompt, aspectRatio }) {
    if (CONFIG.DEMO_MODE) {
      return { jobId: "demo-job" };
    }

    const formData = new FormData();
    formData.append("image", imageFile);
    formData.append("prompt", prompt);
    formData.append("aspectRatio", aspectRatio);

    let res;
    try {
      res = await fetch(`${CONFIG.API_BASE_URL}/api/generate`, {
        method: "POST",
        body: formData,
      });
    } catch {
      throw new Error(
        `Couldn't reach the backend at ${CONFIG.API_BASE_URL}. Make sure it's running (see README) and reachable from this device.`
      );
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || "Could not start generation. Please try again.");
    }

    return res.json(); // { jobId }
  },

  /**
   * Polls job status.
   * @param {string} jobId
   * @returns {Promise<{ status: "queued"|"processing"|"complete"|"failed", progress?: number, videoUrl?: string, message?: string }>}
   */
  async checkStatus(jobId) {
    if (CONFIG.DEMO_MODE) {
      return DemoProvider.checkStatus(jobId);
    }

    const res = await fetch(`${CONFIG.API_BASE_URL}/api/status/${jobId}`);
    if (!res.ok) {
      throw new Error("Lost connection to the render job.");
    }
    return res.json();
  },
};

/* Demo provider — simulates a real generation job in the browser so the
   UI is fully clickable before any backend exists. Not used once
   CONFIG.DEMO_MODE is false. */
const DemoProvider = (() => {
  let startedAt = 0;
  const DURATION_MS = 9000;

  return {
    reset() {
      startedAt = Date.now();
    },
    async checkStatus() {
      if (!startedAt) startedAt = Date.now();
      const elapsed = Date.now() - startedAt;
      const pct = Math.min(100, Math.round((elapsed / DURATION_MS) * 100));

      if (pct < 100) {
        const stage = pct < 35 ? "queued" : "processing";
        return { status: stage, progress: pct };
      }

      return {
        status: "complete",
        progress: 100,
        // Freely licensed sample clip, standing in for a generated result.
        videoUrl:
          "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
      };
    },
  };
})();

/* ---------------------------------------------------------------------
   2. UI wiring
--------------------------------------------------------------------- */

const els = {
  dropzone: document.getElementById("dropzone"),
  dropzoneEmpty: document.getElementById("dropzoneEmpty"),
  dropzonePreview: document.getElementById("dropzonePreview"),
  clearImageBtn: document.getElementById("clearImageBtn"),
  fileInput: document.getElementById("fileInput"),

  promptInput: document.getElementById("promptInput"),
  promptCount: document.getElementById("promptCount"),

  aspectOptions: Array.from(document.querySelectorAll(".aspect-option")),

  generateBtn: document.getElementById("generateBtn"),
  generateBtnLabel: document.getElementById("generateBtnLabel"),

  uploadCard: document.getElementById("uploadCard"),
  promptCard: document.getElementById("promptCard"),
  aspectCard: document.getElementById("aspectCard"),
  progressCard: document.getElementById("progressCard"),
  resultCard: document.getElementById("resultCard"),

  progressStage: document.getElementById("progressStage"),
  progressPercent: document.getElementById("progressPercent"),
  progressTime: document.getElementById("progressTime"),
  progressNote: document.getElementById("progressNote"),
  filmstripTrack: document.getElementById("filmstripTrack"),

  resultVideo: document.getElementById("resultVideo"),
  downloadBtn: document.getElementById("downloadBtn"),
  restartBtn: document.getElementById("restartBtn"),

  errorNote: document.getElementById("errorNote"),
};

const state = {
  imageFile: null,
  prompt: "",
  aspectRatio: "9:16",
  jobId: null,
  pollTimer: null,
  timerInterval: null,
  startTime: 0,
};

/* --- image upload --- */

els.dropzone.addEventListener("click", (e) => {
  if (e.target === els.clearImageBtn) return;
  els.fileInput.click();
});

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handleImageFile(file);
});

["dragover", "dragenter"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("is-dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("is-dragover");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleImageFile(file);
});

els.clearImageBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  state.imageFile = null;
  els.fileInput.value = "";
  els.dropzonePreview.hidden = true;
  els.dropzoneEmpty.hidden = false;
  els.clearImageBtn.hidden = true;
  updateGenerateButtonState();
});

function handleImageFile(file) {
  if (!file.type.startsWith("image/")) {
    showError("That file doesn't look like an image. Please choose a JPG or PNG.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showError("That image is over 10MB. Please choose a smaller file.");
    return;
  }
  clearError();
  state.imageFile = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    els.dropzonePreview.src = e.target.result;
    els.dropzonePreview.hidden = false;
    els.dropzoneEmpty.hidden = true;
    els.clearImageBtn.hidden = false;
  };
  reader.readAsDataURL(file);

  updateGenerateButtonState();
}

/* --- prompt --- */

els.promptInput.addEventListener("input", () => {
  state.prompt = els.promptInput.value;
  els.promptCount.textContent = `${state.prompt.length} / 300`;
  updateGenerateButtonState();
});

/* --- aspect ratio --- */

els.aspectOptions.forEach((btn) => {
  btn.addEventListener("click", () => {
    els.aspectOptions.forEach((b) => b.setAttribute("aria-checked", "false"));
    btn.setAttribute("aria-checked", "true");
    state.aspectRatio = btn.dataset.ratio;
    applyResultFrameShape();
  });
});

function applyResultFrameShape() {
  const map = { "9:16": "9 / 16", "1:1": "1 / 1", "16:9": "16 / 9" };
  els.resultVideo.style.aspectRatio = map[state.aspectRatio];
}

/* --- generate button gating --- */

function updateGenerateButtonState() {
  const ready = Boolean(state.imageFile) && state.prompt.trim().length > 0;
  els.generateBtn.disabled = !ready;
}

/* --- generation flow --- */

els.generateBtn.addEventListener("click", startGeneration);
els.restartBtn.addEventListener("click", resetToStart);

async function startGeneration() {
  clearError();
  DemoProvider.reset();

  setScreen("progress");
  state.startTime = Date.now();
  startElapsedTimer();

  try {
    const { jobId } = await VideoAPI.startGeneration({
      imageFile: state.imageFile,
      prompt: state.prompt.trim(),
      aspectRatio: state.aspectRatio,
    });
    state.jobId = jobId;
    pollJob();
  } catch (err) {
    stopElapsedTimer();
    showError(err.message || "Something went wrong starting the render.");
    setScreen("form");
  }
}

function pollJob() {
  state.pollTimer = setInterval(async () => {
    try {
      const result = await VideoAPI.checkStatus(state.jobId);
      renderProgress(result);

      if (result.status === "complete") {
        clearInterval(state.pollTimer);
        stopElapsedTimer();
        showResult(result.videoUrl);
      } else if (result.status === "failed") {
        clearInterval(state.pollTimer);
        stopElapsedTimer();
        showError(result.message || "The render failed. Please try again.");
        setScreen("form");
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      stopElapsedTimer();
      showError(err.message || "Lost connection while checking your render.");
      setScreen("form");
    }
  }, 1500);
}

function renderProgress({ status, progress = 0 }) {
  els.filmstripTrack.style.width = `${progress}%`;
  els.progressPercent.textContent = `${progress}%`;
  els.progressStage.textContent =
    status === "queued" ? "Queued for rendering…" : "Developing your scene…";
  els.progressNote.textContent =
    status === "queued"
      ? "Waiting for a free render slot to open up."
      : "This usually takes 1–3 minutes on the free tier.";
}

function showResult(videoUrl) {
  els.resultVideo.src = videoUrl;
  els.downloadBtn.href = videoUrl;
  applyResultFrameShape();
  setScreen("result");
}

function startElapsedTimer() {
  state.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    els.progressTime.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopElapsedTimer() {
  clearInterval(state.timerInterval);
}

/* --- screen switching --- */

function setScreen(screen) {
  const showForm = screen === "form";
  els.uploadCard.hidden = !showForm;
  els.promptCard.hidden = !showForm;
  els.aspectCard.hidden = !showForm;
  document.querySelector(".dock").hidden = !showForm;

  els.progressCard.hidden = screen !== "progress";
  els.resultCard.hidden = screen !== "result";

  if (screen === "progress") {
    els.filmstripTrack.style.width = "0%";
    els.progressPercent.textContent = "0%";
    els.progressTime.textContent = "00:00";
  }
}

function resetToStart() {
  clearInterval(state.pollTimer);
  stopElapsedTimer();
  state.jobId = null;
  setScreen("form");
}

/* --- error handling --- */

function showError(message) {
  els.errorNote.textContent = message;
  els.errorNote.hidden = false;
}
function clearError() {
  els.errorNote.hidden = true;
  els.errorNote.textContent = "";
}

/* --- init --- */

setScreen("form");
