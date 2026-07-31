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
    // Public Space that runs image-to-video generation. Swappable via
    // env if the Space moves or you prefer another one. Currently:
    // Wan 2.2 14B I2V with Lightning LoRA (real text-prompt
    // conditioning, better motion quality than the earlier SVD Space).
    spaceId: process.env.HF_SPACE_ID || "zerogpu-aoti/wan2-2-fp8da-aoti-faster",
  },

  // Reserved for later: when you're ready to switch to a paid provider
  // (Runway, Luma, Kling, Pika, etc.), add its config here and create
  // providers/<name>Provider.js implementing the same interface.
  commercial: {
    apiKey: process.env.COMMERCIAL_API_KEY || "",
  },
};
