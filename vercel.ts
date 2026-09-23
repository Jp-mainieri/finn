import type { VercelConfig } from "@vercel/config/v1";

// Rewrites live in next.config.ts; secrets are set with `vercel env add`.
export const config: VercelConfig = {
  framework: "nextjs",
  buildCommand: "npm run build",
};
