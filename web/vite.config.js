import { defineConfig } from "vite";

export default defineConfig({
  // Two pages: the public site and the hidden owner page (/owner).
  build: { rollupOptions: { input: { main: "index.html", owner: "owner.html" } } },
  // In dev, send /api calls to the local server (npm start, port 3000).
  server: { proxy: { "/api": "http://localhost:3000" } },
});
