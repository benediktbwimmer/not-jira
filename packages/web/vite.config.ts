import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.UNBLOCK_WEB_HOST ?? "0.0.0.0",
    port: Number(process.env.UNBLOCK_WEB_PORT ?? 5173),
    proxy: {
      "/api": `http://localhost:${process.env.UNBLOCK_API_PORT ?? 3000}`
    }
  }
});
