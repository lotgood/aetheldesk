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
    },
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
