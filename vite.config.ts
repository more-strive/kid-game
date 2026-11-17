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
    // Element Plus 按需引入后主包应稳定在 400KB 左右，超了说明有依赖被拽回主包
    chunkSizeWarningLimit: 700,
    // public 资源较多（图标 + 音效 200+ 文件），自动清空 dist 会触发批量删除保护，
    // 因此关闭自动清空；部署前手动清一次 dist 即可
    emptyOutDir: false,
    rolldownOptions: {
      output: {
        // Vue 全家桶单独成块：业务代码迭代时用户只需重下小包，框架包走长效缓存。
        // 注意只圈 Vue 生态，不要把 node_modules 全量塞进来 —— mediapipe 是
        // 动态引入的，一旦被并进公共 vendor 就会拖慢首屏。
        codeSplitting: {
          groups: [
            {
              name: 'vendor-vue',
              test: /[\\/]node_modules[\\/](?:@vue|vue|vue-router|pinia|@vueuse)[\\/]/,
            },
          ],
        },
      },
    },
  },
})
