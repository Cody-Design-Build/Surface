import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { apps } from "../surfaces.mts";

// `npm run dev` proxies the API to a running `surface serve` (default port 4317).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
  build: {
    target: ["safari17", "chrome120", "firefox121"],
    cssTarget: ["safari17", "chrome120", "firefox121"],
    outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000,
    rollupOptions: { input: Object.fromEntries(apps.map(app => [app.id, fileURLToPath(new URL(`./${app.entry}`, import.meta.url))])) },
  },
});
