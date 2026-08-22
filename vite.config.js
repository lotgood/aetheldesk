import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "frontend",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        lobby: resolve(__dirname, "frontend/lobby.html"),
        room: resolve(__dirname, "frontend/room.html"),
      },
      output: {
        // three.js is the dominant weight of the room bundle; give it its
        // own chunk so it caches independently of app code.
        manualChunks: {
          three: ["three"],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://127.0.0.1:8000",
        ws: true,
      },
    },
  },
});
