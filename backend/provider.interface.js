/**
 * VideoProvider — the contract every image-to-video backend must follow.
 *
 * This is the seam that keeps the app modular: server.js only ever talks
 * to "a provider," never to Hugging Face or Runway or Kling directly.
 * To add a new backend (e.g. a commercial API), create a new file in
 * this folder that implements these two methods, then point
 * config.js -> provider at its name.
 *
 * This file is documentation, not executable logic — providers don't
 * need to extend it, just match the shape.
 */
export class VideoProvider {
  /**
   * Start a generation job.
   * @param {object} input
   * @param {Buffer} input.imageBuffer   - raw bytes of the uploaded image
   * @param {string} input.mimeType      - e.g. "image/jpeg"
   * @param {string} input.prompt        - motion description
   * @param {string} input.aspectRatio   - "9:16" | "16:9" | "1:1"
   * @returns {Promise<{ jobId: string }>}
   */
  async generate(_input) {
    throw new Error("generate() not implemented");
  }

  /**
   * Check on a previously started job.
   * @param {string} _jobId
   * @returns {Promise<{
   *   status: "queued" | "processing" | "complete" | "failed",
   *   progress?: number,      // 0-100
   *   videoUrl?: string,      // present when status === "complete"
   *   message?: string        // present when status === "failed"
   * }>}
   */
  async checkStatus(_jobId) {
    throw new Error("checkStatus() not implemented");
  }
}
