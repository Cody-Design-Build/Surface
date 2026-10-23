import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { apps } from "../surfaces.mts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

let buildCommit: string | null = null;
try {
  if (fs.existsSync(new URL("../.git", import.meta.url)))
    buildCommit = execFileSync("git", ["rev-parse", "HEAD"], {cwd:fileURLToPath(new URL("..", import.meta.url)),encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();
}
catch { /* Source archives do not necessarily include Git metadata. */ }
const buildVersion = JSON.parse(fs.readFileSync(new URL("../cli/package.json", import.meta.url), "utf8")).version as string;

// `npm run dev` proxies the API to a running `surface serve` (default port 4317).
export default defineConfig({
  plugins: [react(), {
    name: "surface-build-metadata",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "surface-build.json", source: JSON.stringify({ number: buildVersion, commit: buildCommit }) + "\n" });
    },
  }],
  define: { __SURFACE_BUILD_COMMIT__: JSON.stringify(buildCommit) },
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
