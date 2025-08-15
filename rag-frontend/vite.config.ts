import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://backend:3001",
        changeOrigin: true,
        secure: false,
      },
      "/api/ws": {
        target: "http://backend:3001",
        ws: true,
        changeOrigin: true,
        secure: false,
        rewrite: (p) => p.replace(/^\/api\/ws/, "/ws"),
      },
    },
  },
});
