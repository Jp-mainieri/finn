import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
