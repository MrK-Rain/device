import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,          // keep maps: needed to read a production stack trace
    target: "es2020",
  },
  server: { port: 5173, strictPort: true },
});
