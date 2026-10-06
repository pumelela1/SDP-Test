import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the native SQLite driver out of the server bundle.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
