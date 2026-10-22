import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  // `web/` is the project root; the component and its modules live one directory up.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": root },
  },
  build: {
    // Straight into what the Worker serves as assets, so `wrangler deploy` ships the real UI.
    outDir: fileURLToPath(new URL("../worker/public", import.meta.url)),
    emptyOutDir: true,
  },
});
