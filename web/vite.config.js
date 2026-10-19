import { defineConfig } from "vite";

// In dev, send /api calls to the local server (npm start, port 3000).
export default defineConfig({
  server: { proxy: { "/api": "http://localhost:3000" } },
});
