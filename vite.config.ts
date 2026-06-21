/** WARNING: DON'T EDIT THIS FILE */
/** WARNING: DON'T EDIT THIS FILE */
/** WARNING: DON'T EDIT THIS FILE */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

function getPlugins() {
  const plugins = [react(), tsconfigPaths()];
  return plugins;
}

function getBaseUrl() {
  // CloudBase 部署用 / ，GitHub Pages 用 /AllinONE-Gaming-Platform/
  return process.env.VITE_BASE_URL || '/';
}

export default defineConfig({
  base: getBaseUrl(),
  plugins: getPlugins(),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // 忽略模块解析警告
        if (warning.code === 'UNRESOLVED_IMPORT') return;
        warn(warning);
      }
    }
  }
});
