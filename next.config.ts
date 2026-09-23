import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      // Service worker updates must never be served from HTTP cache.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
  async rewrites() {
    return [
      // A2A Agent Cards at the spec'd well-known paths.
      {
        source: "/agents/:agent/.well-known/agent.json",
        destination: "/api/agents/:agent/card",
      },
    ];
  },
};

export default nextConfig;
