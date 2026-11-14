import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // GitHub Pages 部署在 /<repo>/ 子路径下时，用 BASE_PATH=/kid-game/ 覆盖；本地与自有服务器保持 /
  base: process.env.BASE_PATH || '/',
  plugins: [vue(), UnoCSS()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
