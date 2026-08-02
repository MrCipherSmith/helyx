import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // The root tsconfig type-checks this file against its own copy of `vite`,
  // which is a different package instance than the one the webapp resolves.
  // The two `Plugin` types are structurally identical but nominally unrelated,
  // so the cast goes through `unknown`. It names the target type rather than
  // erasing it with `any`, which is what stood here before.
  plugins: [react(), tailwindcss()] as unknown as PluginOption[],
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
