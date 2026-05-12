import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_API_PORT = 39217;
const DEFAULT_WEB_PORT = 39218;

export default defineConfig({
  plugins: [react({
    exclude: [/\/node_modules\//, /\/src\/main\.tsx$/]
  })],
  server: {
    host: process.env.UNBLOCK_WEB_HOST ?? "0.0.0.0",
    port: Number(process.env.UNBLOCK_WEB_PORT ?? DEFAULT_WEB_PORT),
    proxy: {
      "/api": `http://localhost:${process.env.UNBLOCK_API_PORT ?? DEFAULT_API_PORT}`
    }
  }
});
