import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies the API so cookies/key/session live on one origin;
// in production the built bundle is served by WrongForge itself at /.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env.WRONGFORGE_API ?? "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1600,
    sourcemap: false,
  },
});
