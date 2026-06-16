import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss() as any],
  base: "/webapp/",
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": "http://localhost:3847",
    },
  },
});
