import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const rootDir = fileURLToPath(new URL("./", import.meta.url));
const hmrHost = process.env.VITE_HMR_HOST;
const hmrPort = process.env.VITE_HMR_PORT
  ? Number(process.env.VITE_HMR_PORT)
  : 5174;
const httpsEnabled = process.env.VITE_HTTPS_ENABLED === 'true';
const httpsConfig = httpsEnabled
  ? {
      key: resolve(rootDir, '../certs/server.key'),
      cert: resolve(rootDir, '../certs/server.crt'),
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(rootDir, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5174,
    open: false,
    strictPort: true,
    https: httpsConfig,

    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(",")
          .map((h) => h.trim())
          .filter(Boolean)
      : ["project-t1.com", "project-t1.local", "localhost", "soongipapers.com"],
    hmr: {
      ...(hmrHost ? { host: hmrHost } : {}),
      port: hmrPort,
      protocol: httpsEnabled ? 'wss' : 'ws',
    },

    proxy: {
      "/api": {
        target: httpsEnabled ? 'https://localhost:8080' : 'http://localhost:8080',
        changeOrigin: true,
        secure: httpsEnabled ? false : true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
});
