import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_PROXY ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in the browser, so the session cookie needs no CORS exceptions.
    proxy: { "/api": { target: apiTarget } },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { "/api": { target: apiTarget } },
  },
});
