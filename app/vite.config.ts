import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` proxies the API to a running `surface serve` (default port 4317).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
