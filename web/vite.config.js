import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// index.html ships a strict CSP (connect-src 'self') with a comment saying to
// name the API host once it's known. That's now — VITE_API_BASE is the API
// host, so it's added to connect-src at build time instead of by hand.
// CSP source expressions with a path only match that exact path, so this
// injects the origin, not the full VITE_API_BASE (which includes /api).
function apiOrigin(env) {
  if (!env.VITE_API_BASE) return "";
  try {
    return new URL(env.VITE_API_BASE).origin;
  } catch {
    throw new Error(`VITE_API_BASE is not a valid URL: ${env.VITE_API_BASE}`);
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const origin = apiOrigin(env);

  return {
    plugins: [
      react(),
      {
        name: "csp-connect-src-api",
        transformIndexHtml(html) {
          if (!origin) return html;
          return html.replace("connect-src 'self';", `connect-src 'self' ${origin};`);
        },
      },
    ],
    build: {
      outDir: "dist",
      sourcemap: true,          // keep maps: needed to read a production stack trace
      target: "es2020",
    },
    server: { port: 5173, strictPort: true },
  };
});
