import { createApp } from 'vue'
import { createPinia } from 'pinia'
/**
 * Element Plus 按需引入。
 * 全量引入（`import ElementPlus from 'element-plus'` + `dist/index.css`）会把
 * 整库 JS 和 ~330KB 主题 CSS 都打进入口包；本项目只用到 4 个组件，按需引入后
 * 入口 JS/CSS 都能省下一大半。
 * 新增组件时：在这里 import 组件 + 对应的 `es/components/<name>/style/css`。
 */
import { ElEmpty, ElInput, ElOption, ElSelect } from 'element-plus'
import 'element-plus/es/components/empty/style/css'
import 'element-plus/es/components/input/style/css'
// select 的样式依赖里已包含 option / popper / scrollbar
import 'element-plus/es/components/select/style/css'
import 'virtual:uno.css'
import './styles/main.scss'
import App from './App.vue'
import router from './router'

const app = createApp(App)

app.use(createPinia()).use(router)

app.component('ElSelect', ElSelect)
app.component('ElOption', ElOption)
app.component('ElInput', ElInput)
app.component('ElEmpty', ElEmpty)

app.mount('#app')
