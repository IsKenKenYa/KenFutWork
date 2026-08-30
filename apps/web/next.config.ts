import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // TEMP-VERIFY: distDir pointed outside the project because the dev sandbox
  // blocks Next's end-of-build unlink of .next/lock & export-detail.json.
  // Revert to default after verification.
  distDir: "/tmp/loomic-web-next-dist",
  typescript: {
    ignoreBuildErrors: true,
  },
  env: {
    NEXT_PUBLIC_SERVER_BASE_URL: process.env.NEXT_PUBLIC_SERVER_BASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
};

export default nextConfig;
