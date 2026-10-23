import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    // 内容服务：所有 /api 请求代理到 Node 服务（127.0.0.1:8788）。
    // 前端因此是同源请求，不需要 CORS，也不需要在前端记录服务地址。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
