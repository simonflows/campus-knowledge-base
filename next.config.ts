import type { NextConfig } from "next";

const basePath =
  process.env.BASE_PATH !== undefined ? process.env.BASE_PATH : "";
const isDevelopment = process.env.NODE_ENV === "development";
const isFullLocalDemo = process.env.CAMPUS_FULL_LOCAL_DEMO === "true";

const nextConfig: NextConfig = {
  output: process.env.OUTPUT_MODE === "export" ? "export" : undefined,
  ...(isFullLocalDemo && {
    distDir: ".next-campus-demo",
  }),

  ...(process.env.OUTPUT_MODE !== "export" && {
    async headers() {
      return [
        {
          source: "/demo",
          headers: [
            {
              key: "Content-Security-Policy",
              value: "connect-src 'none'; form-action 'none'; base-uri 'none'",
            },
          ],
        },
        ...(isDevelopment
          ? [
              {
                source: "/:path*",
                basePath: false as const,
                headers: [
                  {
                    key: "X-Robots-Tag",
                    value: "noindex, nofollow",
                  },
                ],
              },
            ]
          : []),
        ...(isFullLocalDemo
          ? [
              {
                source: "/api/health",
                headers: [{ key: "X-Campus-Full-Local-Demo", value: "1" }],
              },
            ]
          : []),
      ];
    },
  }),

  ...(basePath && {
    basePath,
    assetPrefix: basePath,
  }),

  ...(process.env.OUTPUT_MODE === "export" && {
    images: {
      unoptimized: true,
    },
  }),
  allowedDevOrigins: ["*"],

  devIndicators: false,
  poweredByHeader: false,
  reactStrictMode: true,
  ...(isFullLocalDemo && {
    typescript: { tsconfigPath: "tsconfig.demo.json" },
  }),
  experimental: {
    serverSourceMaps: false,
    turbopackSourceMaps: false,
    // Keep rendered data in the development document so /demo can hydrate without a socket.
    ...(isDevelopment && { reactDebugChannel: false }),
  },
};

export default nextConfig;
