<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { computed } from 'vue'

const route = useRoute()
const isPlay = computed(() => route.name === 'play')
</script>

<template>
  <RouterView v-if="isPlay" />
  <div v-else class="min-h-screen flex flex-col">
    <header class="sticky top-0 z-30 backdrop-blur-xl bg-white/75 border-b border-[#e3ebfb]">
      <div class="page h-16 flex items-center gap-6">
        <RouterLink to="/" class="flex items-center gap-2 shrink-0">
          <div
            class="w-10 h-10 rounded-2xl grid place-items-center text-xl shadow-lg shadow-brand-500/25"
            style="background: linear-gradient(135deg, #3390fc, #7c5cff)"
          >
            🤸
          </div>
          <div class="leading-tight">
            <div class="font-black text-[17px] tracking-tight">动动乐园</div>
            <div class="text-[10px] text-slate-400 -mt-0.5">摄像头体感游戏 · 复刻版</div>
          </div>
        </RouterLink>

        <nav class="hidden md:flex items-center gap-1 text-sm font-bold text-slate-500">
          <RouterLink
            to="/games"
            class="px-3.5 py-2 rounded-full hover:bg-slate-100 hover:text-slate-800 transition"
            active-class="!text-brand-700 !bg-brand-50"
          >
            全部游戏
          </RouterLink>
          <RouterLink
            to="/check"
            class="px-3.5 py-2 rounded-full hover:bg-slate-100 hover:text-slate-800 transition"
            active-class="!text-brand-700 !bg-brand-50"
          >
            设备检测
          </RouterLink>
        </nav>

        <div class="flex-1" />
        <RouterLink
          to="/games"
          class="px-5 py-2.5 rounded-full text-white font-black text-sm shadow-lg shadow-candy-500/25 transition active:scale-95"
          style="background: linear-gradient(135deg, #ff3385, #ff7a45)"
        >
          ▶ 开始玩
        </RouterLink>
      </div>
    </header>

    <main class="flex-1">
      <RouterView />
    </main>

    <footer class="mt-20 border-t border-[#e6edfb] bg-white/60">
      <div class="page py-10 flex flex-wrap gap-8 justify-between text-sm text-slate-500">
        <div class="max-w-sm">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-lg">🤸</span>
            <span class="font-black text-slate-800">动动乐园 · 复刻版</span>
          </div>
          <p class="leading-relaxed">
            用摄像头玩的儿童体感游戏，打开网页就能玩，不用手柄、不用安装。画面只在本机识别，不会上传。
          </p>
        </div>
        <div class="flex gap-12">
          <div class="space-y-2">
            <div class="font-bold text-slate-700">玩</div>
            <RouterLink to="/games" class="block hover:text-brand-600">全部游戏</RouterLink>
            <RouterLink to="/check" class="block hover:text-brand-600">设备检测</RouterLink>
          </div>
          <div class="space-y-2">
            <div class="font-bold text-slate-700">说明</div>
            <div>Chrome / Edge</div>
            <div>需摄像头</div>
            <div>本地识别</div>
          </div>
        </div>
      </div>
    </footer>
  </div>
</template>
