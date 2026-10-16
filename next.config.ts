import type { NextConfig } from "next";

/**
 * Hosts allowed to load Next.js *development* resources.
 *
 * The phone opens the app over the tailnet, so the page arrives from a different origin than the one
 * the dev server was started on. Next.js blocks its own dev resources for that case — by default,
 * for safety — and the block is total: `react-dom` itself came back 403, so the phone downloaded no
 * JavaScript at all. The HTML painted and nothing else worked: no passage, no buttons.
 *
 * This only affects `next dev`. A production build (`npm run build && npm start`) has no dev
 * resources and therefore no such restriction, which is how the app should be served from the Pi.
 */
const devOrigins = [
  "localhost",
  "127.0.0.1",
  // The tailnet address of the Pi, and any others named in ALLOWED_DEV_ORIGINS.
  "100.120.214.20",
  ...(process.env.ALLOWED_DEV_ORIGINS?.split(",") ?? []),
]
  .map((host) => host.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // No `output: "standalone"`. It was set before the app was served from a checkout on the Pi, and it
  // makes `next start` refuse to run — "use node .next/standalone/server.js instead" — which then
  // needs `public/` and `.next/static` copied in by hand. The app runs from the repository on the Pi,
  // so the bundling bought nothing and cost the one command that works.
  allowedDevOrigins: devOrigins,
};

export default nextConfig;
