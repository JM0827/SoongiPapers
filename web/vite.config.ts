import { defineConfig } from "vite";
import type { UserConfigExport } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const rootDir = fileURLToPath(new URL("./", import.meta.url));
const hmrHost = process.env.VITE_HMR_HOST;
const hmrPort = process.env.VITE_HMR_PORT
  ? Number(process.env.VITE_HMR_PORT)
  : 5174;
const httpsEnabled = process.env.VITE_HTTPS_ENABLED === "true";
const httpsConfig = httpsEnabled
  ? {
      key: resolve(rootDir, "../certs/server.key"),
      cert: resolve(rootDir, "../certs/server.crt"),
    }
  : undefined;

const config: UserConfigExport = {
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
      protocol: httpsEnabled ? "wss" : "ws",
    },

    proxy: {
      "/api": {
        target: httpsEnabled
          ? "https://localhost:8080"
          : "http://localhost:8080",
        changeOrigin: true,
        secure: httpsEnabled ? false : true,
        // configure: (proxy: { on: (event: string, handler: (req: { setHeader: (key: string, value: string) => void }) => void) => void }) => {
        //   proxy.on("proxyReq", (proxyReq) => {
        //     proxyReq.setHeader("accept-encoding", "identity");
        //   });
        // },
        configure: (proxy: any) => {
          // 요청 전: 압축 비활성화(스트림 버퍼링 방지) + 요청 로깅
          proxy.on("proxyReq", (proxyReq: any, req: any) => {
            proxyReq.setHeader("accept-encoding", "identity");
            console.log("[VITE PROXY][req]", req.method, req.url);
          });
          // 응답 수신 시: 상태 코드 로깅(8080에 붙는지 확인)
          proxy.on("proxyRes", (proxyRes: any, req: any) => {
            console.log("[VITE PROXY][res]", req.method, req.url, proxyRes.statusCode);
          });
          // 에러 시: 원인 노출(타겟 불가/타임아웃 등)
          proxy.on("error", (err: any, req: any) => {
            console.error("[VITE PROXY][error]", req?.method, req?.url, err?.message || err);
          });
        },
        // 응답이 정말 없을 때 프록시가 끊고 에러를 노출(디버그 가시성)
        timeout: 10000,
        proxyTimeout: 10000,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/tests/setup.ts",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      reporter: ["text", "html"],
    },
    exclude: [...configDefaults.exclude, "src/tests/setup.ts"],
  },
};

export default defineConfig(config);
