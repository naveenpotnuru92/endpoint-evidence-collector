import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: forwards /api to the loopback service started with EEC_DEV_TOKEN=devtoken EEC_PORT=47800.
// Production use serves the built UI from the service itself (no proxy, no CORS).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, assetsInlineLimit: 0 },
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": { target: "http://127.0.0.1:47800", changeOrigin: true,
    headers: { "x-eec-token": "devtoken", origin: "http://127.0.0.1:47800" } } } },
});
