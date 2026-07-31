import "dotenv/config";

export const config = {
  port: process.env.PORT || 3001,
  provider: process.env.VIDEO_PROVIDER || "huggingface",

  huggingface: {
    apiToken: process.env.HF_TOKEN || "",
    // Wan 2.2 14B Fast Preview / I2V ZeroGPU Space.
    spaceId: process.env.HF_SPACE_ID || "cinderholm/wan2-2-i2v-v3",
  },

  commercial: {
    apiKey: process.env.COMMERCIAL_API_KEY || "",
  },
};
