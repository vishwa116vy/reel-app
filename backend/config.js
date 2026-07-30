import "dotenv/config";

export const config = {
  port: process.env.PORT || 3001,

  // Which provider to use. Swapping this (and adding a new file in
  // /providers) is the ONLY change needed to move from the free tier
  // to a commercial image-to-video API later.
  provider: process.env.VIDEO_PROVIDER || "huggingface",

  huggingface: {
    // Free — no card required. Create a token at:
    // https://huggingface.co/settings/tokens (read access is enough)
    apiToken: process.env.HF_TOKEN || "",
    // Public Space that runs Stable Video Diffusion image-to-video.
    // Swappable via env if the Space moves or you prefer another one.
    spaceId: process.env.HF_SPACE_ID || "multimodalart/stable-video-diffusion",
  },

  // Reserved for later: when you're ready to switch to a paid provider
  // (Runway, Luma, Kling, Pika, etc.), add its config here and create
  // providers/<name>Provider.js implementing the same interface.
  commercial: {
    apiKey: process.env.COMMERCIAL_API_KEY || "",
  },
};
