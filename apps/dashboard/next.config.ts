import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDirectory = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(dashboardDirectory, "../.."),
  serverExternalPackages: ["node:sqlite"],
  experimental: {
    useTypeScriptCli: true,
  },
};

export default nextConfig;
