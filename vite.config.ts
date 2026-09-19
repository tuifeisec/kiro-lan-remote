import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';

const backendUrl = process.env.REMOTE_BACKEND_URL ?? 'http://127.0.0.1:8790';

/**
 * 构建产物必须是**单个自包含 HTML**。
 *
 * 原因（这是硬约束，不是风格偏好）：server.mjs 只提供 4 条 HTTP 路由
 * （/、/index.html、/healthz、/favicon.ico），没有任何静态资源路由。
 * 因此 Vite 默认的多文件产物（/assets/index-xxx.js、index-xxx.css）
 * 在浏览器里会 404 —— 页面白屏。而 server.mjs 属于「保留不动的后端边界」，
 * 不在本次重构范围内。
 *
 * viteSingleFile 把 JS/CSS 全部内联进 index.html，产物结构与重构前一致：
 * server.mjs 用 readFile(HERE/public/index.html) 就能直接提供页面。
 */
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  build: {
    outDir: 'public',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024, // 图标全部内联，杜绝额外请求
  },
  publicDir: false,
  server: {
    // 仅用于本地开发预览；正式运行仍由 node server.mjs 提供页面
    port: 5174,
    proxy: {
      '/ws': {
        target: backendUrl,
        ws: true,
        changeOrigin: true,
      },
      '/healthz': {
        target: backendUrl,
        changeOrigin: true,
      },
    },
  },
});
