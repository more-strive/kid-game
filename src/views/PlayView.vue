<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { GameHost, type HostState, type FinishResult } from '@/core/engine'
import { GAME_MAP } from '@/data/games'
import { audio } from '@/core/audio'
import type { HudSnapshot } from '@/core/types'
import StarRow from '@/components/StarRow.vue'

const route = useRoute()
const router = useRouter()
const meta = computed(() => GAME_MAP.get(String(route.params.slug)))

const stageRef = ref<HTMLDivElement>()
const videoRef = ref<HTMLVideoElement>()
const canvasRef = ref<HTMLCanvasElement>()

const host = shallowRef<GameHost | null>(null)
const state = ref<HostState>('idle')
const hud = ref<HudSnapshot>({
  score: 0,
  best: 0,
  combo: 0,
  timeLeft: 0,
  progress: 0,
  stage: '',
  running: false,
  finished: false,
  stars: 0,
  extra: {},
})
const result = ref<FinishResult | null>(null)
const errorMsg = ref('')
const showResult = ref(false)
const voiceOn = ref(true)
const muted = ref(false)
const showTip = ref(true)
const demoMode = ref(false)

function resize() {
  const el = stageRef.value
  const cv = canvasRef.value
  if (!el || !cv) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = el.clientWidth
  cv.width = Math.round(w * dpr)
  cv.height = Math.round((w * 9) / 16 * dpr)
}

async function start(demo = false) {
  if (!meta.value || !canvasRef.value || !videoRef.value) return
  audio.ensure()
  showTip.value = false
  demoMode.value = demo
  const h = new GameHost(canvasRef.value, videoRef.value, meta.value)
  h.hooks = {
    onHud: (s) => (hud.value = s),
    onState: (s) => {
      state.value = s
      if (s === 'error') showTip.value = true
    },
    onFinish: (r) => {
      result.value = r
      showResult.value = true
    },
    onError: (m) => (errorMsg.value = m),
  }
  host.value = h
  resize()
  await h.boot(demo)
}

function restart() {
  showResult.value = false
  result.value = null
  errorMsg.value = ''
  host.value?.destroy()
  host.value = null
  setTimeout(() => start(demoMode.value), 60)
}

function goBack() {
  host.value?.destroy()
  host.value = null
  router.push(`/game/${route.params.slug}`)
}

function togglePause() {
  host.value?.togglePause()
}

function toggleMute() {
  muted.value = !muted.value
  audio.setMuted(muted.value)
}
function toggleVoice() {
  voiceOn.value = !voiceOn.value
  audio.setVoice(voiceOn.value)
}

function onKey(e: KeyboardEvent) {
  if (e.code === 'Space') {
    e.preventDefault()
    if (state.value === 'playing' || state.value === 'paused') togglePause()
    else if (state.value === 'idle' || state.value === 'error') start(false)
  }
  if (e.code === 'Escape') goBack()
}

onMounted(() => {
  if (!meta.value) {
    router.replace('/games')
    return
  }
  window.addEventListener('resize', resize)
  window.addEventListener('keydown', onKey)
  resize()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  window.removeEventListener('keydown', onKey)
  host.value?.destroy()
  host.value = null
})

const timeText = computed(() => {
  const t = Math.ceil(hud.value.timeLeft)
  const m = Math.floor(t / 60)
  const s = t % 60
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${t}`
})

const stateText = computed(() => {
  switch (state.value) {
    case 'loading':
      return '正在准备摄像头…'
    case 'countdown':
      return '准备好！'
    case 'paused':
      return '已暂停'
    default:
      return ''
  }
})
</script>

<template>
  <div v-if="meta" class="fixed inset-0 bg-[#0b1024] flex flex-col">
    <!-- 顶栏 -->
    <div class="h-14 shrink-0 px-4 flex items-center gap-3 text-white/90 z-20">
      <button
        class="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 grid place-items-center transition"
        @click="goBack"
      >
        ←
      </button>
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-xl">{{ meta.emoji }}</span>
        <span class="font-black truncate">{{ meta.name }}</span>
      </div>

      <div class="flex-1" />

      <div v-if="state === 'playing' || state === 'paused'" class="flex items-center gap-3">
        <div class="px-3 py-1.5 rounded-full bg-white/10 text-sm font-black tabular-nums">
          {{ timeText }}
        </div>
        <div v-if="hud.combo >= 3" class="px-3 py-1.5 rounded-full bg-candy-500/90 text-sm font-black">
          ×{{ hud.combo }} 连击
        </div>
        <div class="px-4 py-1.5 rounded-full bg-white text-slate-900 text-sm font-black tabular-nums">
          {{ hud.score }} 分
        </div>
      </div>

      <button
        class="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 grid place-items-center transition"
        :title="muted ? '打开音效' : '静音'"
        @click="toggleMute"
      >
        {{ muted ? '🔇' : '🔊' }}
      </button>
      <button
        class="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 grid place-items-center transition"
        :title="voiceOn ? '关闭语音' : '打开语音'"
        @click="toggleVoice"
      >
        🗣️
      </button>
      <button
        v-if="state === 'playing' || state === 'paused'"
        class="px-4 h-9 rounded-full bg-white/10 hover:bg-white/20 text-sm font-bold transition"
        @click="togglePause"
      >
        {{ state === 'paused' ? '继续' : '暂停' }}
      </button>
    </div>

    <!-- 舞台 -->
    <div class="flex-1 min-h-0 px-2 pb-2 flex items-center justify-center">
      <div
        ref="stageRef"
        class="relative bg-black rounded-2xl overflow-hidden shadow-2xl"
        style="width: min(100%, calc((100vh - 88px) * 16 / 9)); aspect-ratio: 16 / 9"
      >
        <video
          ref="videoRef"
          class="absolute inset-0 w-full h-full object-cover"
          style="transform: scaleX(-1)"
          playsinline
          muted
          autoplay
        />
        <canvas ref="canvasRef" class="absolute inset-0 w-full h-full" />

        <!-- 进度条 -->
        <div v-if="meta.duration && state === 'playing'" class="absolute bottom-0 left-0 right-0 h-1.5 bg-white/15">
          <div
            class="h-full transition-[width] duration-100"
            :style="{ width: `${hud.progress * 100}%`, background: 'linear-gradient(90deg,#3ddc97,#ffd54a)' }"
          />
        </div>

        <!-- 开始遮罩 -->
        <div
          v-if="state === 'idle' || state === 'loading' || state === 'error'"
          class="absolute inset-0 grid place-items-center bg-[#0b1024]/85 backdrop-blur-sm"
        >
          <div class="text-center px-6 max-w-lg">
            <div class="text-6xl mb-4">{{ meta.emoji }}</div>
            <h2 class="text-3xl font-black text-white">{{ meta.name }}</h2>
            <p class="mt-2 text-white/60 text-sm">{{ meta.tagline }}</p>

            <div v-if="errorMsg" class="mt-5 px-4 py-3 rounded-2xl bg-red-500/15 border border-red-400/30 text-red-300 text-sm">
              {{ errorMsg }}
            </div>

            <div v-if="showTip" class="mt-5 text-left rounded-2xl bg-white/5 border border-white/10 p-4 space-y-1.5">
              <div class="text-[13px] text-white/70 font-bold mb-1">开始前确认</div>
              <div class="text-[13px] text-white/55">· 允许浏览器使用摄像头</div>
              <div class="text-[13px] text-white/55">· 站到离摄像头 2～3 米，全身进画面</div>
              <div class="text-[13px] text-white/55">· 清出一块空地，注意防滑</div>
            </div>

            <div class="mt-6 flex flex-col items-center gap-3">
              <button
                class="px-10 py-4 rounded-full text-white font-black text-lg shadow-xl transition active:scale-95 disabled:opacity-60"
                style="background: linear-gradient(135deg, #ff3385, #ff7a45)"
                :disabled="state === 'loading'"
                @click="start(false)"
              >
                {{ state === 'loading' ? '正在准备摄像头…' : '▶ 开始游戏' }}
              </button>
              <button
                class="px-6 py-2.5 rounded-full text-white/80 font-bold text-sm bg-white/10 hover:bg-white/20 transition"
                :disabled="state === 'loading'"
                @click="start(true)"
              >
                先看演示（不用摄像头）
              </button>
            </div>
            <div class="mt-3 text-[12px] text-white/35">按空格也可以开始 / 暂停</div>
          </div>
        </div>

        <!-- 倒计时/暂停提示 -->
        <div
          v-if="stateText && state !== 'idle'"
          class="absolute top-3 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-black/45 text-white text-sm font-bold"
        >
          {{ stateText }}
        </div>
        <div
          v-if="demoMode && state !== 'idle' && state !== 'error'"
          class="absolute top-3 right-3 px-3 py-1.5 rounded-full bg-brand-600/85 text-white text-[12px] font-bold"
        >
          演示模式
        </div>
      </div>
    </div>

    <!-- 结算 -->
    <div
      v-if="showResult && result"
      class="absolute inset-0 z-30 grid place-items-center bg-[#060a18]/80 backdrop-blur-md px-4"
    >
      <div class="w-full max-w-md rounded-[32px] bg-white p-8 text-center shadow-2xl">
        <div class="text-sm font-black text-slate-400">本局结束</div>
        <h2 class="text-2xl font-black mt-1">{{ meta.name }}</h2>

        <div class="my-6 flex justify-center">
          <StarRow :stars="result.stars" :size="52" />
        </div>

        <div class="grid grid-cols-3 gap-3 mb-6">
          <div class="rounded-2xl bg-slate-50 p-3">
            <div class="text-[11px] font-bold text-slate-400">得分</div>
            <div class="text-2xl font-black text-slate-800 tabular-nums">{{ result.score }}</div>
          </div>
          <div class="rounded-2xl bg-slate-50 p-3">
            <div class="text-[11px] font-bold text-slate-400">最高连击</div>
            <div class="text-2xl font-black text-slate-800 tabular-nums">{{ result.best }}</div>
          </div>
          <div class="rounded-2xl bg-slate-50 p-3">
            <div class="text-[11px] font-bold text-slate-400">时长</div>
            <div class="text-2xl font-black text-slate-800 tabular-nums">{{ result.durationPlayed }}s</div>
          </div>
        </div>

        <div class="space-y-2.5">
          <button
            class="w-full py-3.5 rounded-full text-white font-black shadow-lg transition active:scale-95"
            style="background: linear-gradient(135deg, #ff3385, #ff7a45)"
            @click="restart"
          >
            再来一局
          </button>
          <RouterLink
            to="/games"
            class="block w-full py-3 rounded-full font-black bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
          >
            换一个游戏
          </RouterLink>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="fixed inset-0 grid place-items-center bg-[#0b1024] text-white">
    <div class="text-center">
      <div class="text-5xl mb-3">🤔</div>
      <div class="font-black">没有找到这个游戏</div>
      <RouterLink to="/games" class="inline-block mt-4 px-6 py-2.5 rounded-full bg-white/10">去游戏列表</RouterLink>
    </div>
  </div>
</template>
