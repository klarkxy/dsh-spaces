import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/main/index.ts"), "snapshot-worker": resolve("src/main/snapshot-worker.ts") },
        output: {
          entryFileNames: chunk => chunk.name === "snapshot-worker" ? "snapshot-worker.mjs" : "[name].js",
          chunkFileNames: "chunks/[name]-[hash].mjs",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
        "@workbench": resolve("packages/plugin/src/workbench"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
