import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: false },
  async rewrites() {
    return [
      // Convenience alias for the discovery file. RFC 9116 mandates
      // /.well-known/security.txt; many scanners also probe the root.
      { source: "/security.txt", destination: "/.well-known/security.txt" },
    ];
  },
};

export default config;
