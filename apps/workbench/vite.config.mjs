import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiProxyTarget = process.env.WORKBENCH_API_PROXY_TARGET || "http://127.0.0.1:8090";
const piAgentProxyTarget = process.env.WORKBENCH_PI_AGENT_PROXY_TARGET || "http://127.0.0.1:8091";
const apiProxy = {
  "/analysis": { target: apiProxyTarget, changeOrigin: true },
  "/auth": { target: apiProxyTarget, changeOrigin: true },
  "/pi-agent": { target: piAgentProxyTarget, changeOrigin: true, rewrite: (path) => path.replace(/^\/pi-agent/, "") },
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
    projects: [
      { test: { name: "unit", environment: "jsdom", setupFiles: "./src/test/setup.ts", include: ["src/**/*.unit.test.{ts,tsx}"] } },
      { test: { name: "component", environment: "jsdom", setupFiles: "./src/test/setup.ts", include: ["src/**/*.component.test.{ts,tsx}"] } },
    ],
  },
  server: { host: process.env.WORKBENCH_HOST || "127.0.0.1", port: 5180, strictPort: true, proxy: apiProxy },
  preview: { host: "127.0.0.1", port: 5180, strictPort: true, proxy: apiProxy },
  build: { sourcemap: false },
});
