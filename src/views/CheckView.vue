<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { tracker } from '@/core/pose'
import type { Body } from '@/core/types'

const videoRef = ref<HTMLVideoElement>()
const canvasRef = ref<HTMLCanvasElement>()
const running = ref(false)
const loading = ref(false)
const errorMsg = ref('')
const brightness = ref(0)
const personCount = ref(0)
const bodyHeight = ref(0)
const fullBody = ref(false)
const headOk = ref(false)
const handsOk = ref(0)

/** 关键点是否真的「看得见」：置信度够高，且没有跑到画面外 */
function visOk(p: { x: number; y: number; visibility?: number }) {
  return (
    (p.visibility ?? 1) > 0.5 && p.x > 0.015 && p.x < 0.985 && p.y > 0.015 && p.y < 0.985
  )
}

let raf = 0
const sample = document.createElement('canvas')
sample.width = 64
sample.height = 36

const BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
]

function drawSkeleton(b: Body | null) {
  const cv = canvasRef.value
  if (!cv) return
  const c = cv.getContext('2d')
  if (!c) return
  c.clearRect(0, 0, cv.width, cv.height)
  if (!b) return
  const k = cv.width
  const X = (n: number) => n * k
  const Y = (n: number) => n * k * (9 / 16)
  c.lineWidth = Math.max(3, k * 0.004)
  c.strokeStyle = '#3ddc97'
  c.lineCap = 'round'
  for (const [a, z] of BONES) {
    c.beginPath()
    c.moveTo(X(b.lm[a].x), Y(b.lm[a].y))
    c.lineTo(X(b.lm[z].x), Y(b.lm[z].y))
    c.stroke()
  }
  for (const p of b.lm) {
    if ((p.visibility ?? 1) < 0.4) continue
    c.beginPath()
    c.arc(X(p.x), Y(p.y), Math.max(2.5, k * 0.0035), 0, Math.PI * 2)
    c.fillStyle = '#ffd54a'
    c.fill()
  }

  // 头：以鼻子为圆心画一个圈，没看到就是空心虚线
  const headR = Math.max(14, k * 0.032)
  c.beginPath()
  c.arc(X(b.head.x), Y(b.head.y), headR, 0, Math.PI * 2)
  c.lineWidth = Math.max(3, k * 0.004)
  if (headOk.value) {
    c.strokeStyle = '#3ddc97'
    c.setLineDash([])
    c.stroke()
  } else {
    c.strokeStyle = 'rgba(255,90,120,.9)'
    c.setLineDash([8, 7])
    c.stroke()
    c.setLineDash([])
  }

  // 手：看得见是实心粉色圆盘，看不见是红色虚线空圈
  const handR = Math.max(9, k * 0.012)
  for (const h of [b.lHand, b.rHand]) {
    c.beginPath()
    c.arc(X(h.x), Y(h.y), handR, 0, Math.PI * 2)
    if (visOk(h)) {
      c.fillStyle = 'rgba(255,51,133,.85)'
      c.fill()
    } else {
      c.lineWidth = Math.max(3, k * 0.0045)
      c.strokeStyle = 'rgba(255,90,120,.9)'
      c.setLineDash([6, 6])
      c.stroke()
      c.setLineDash([])
    }
  }
}

function measureBrightness() {
  const v = videoRef.value
  const c = sample.getContext('2d', { willReadFrequently: true })
  if (!v || !c || !v.videoWidth) return
  c.drawImage(v, 0, 0, sample.width, sample.height)
  const d = c.getImageData(0, 0, sample.width, sample.height).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114)
  brightness.value = Math.round(sum / (d.length / 4))
}

function loop() {
  raf = requestAnimationFrame(loop)
  const cv = canvasRef.value
  const v = videoRef.value
  if (!cv || !v) return
  if (cv.width !== v.clientWidth) {
    cv.width = v.clientWidth
    cv.height = (v.clientWidth * 9) / 16
  }
  const frame = tracker.detect(performance.now())
  personCount.value = frame.bodies.length
  const b = frame.bodies[0] ?? null
  drawSkeleton(b)
  if (b) {
    bodyHeight.value = Math.round((Math.max(b.lFoot.y, b.rFoot.y) - b.head.y) * 100)
    fullBody.value =
      Math.min(b.lFoot.y, b.rFoot.y) < 0.99 &&
      b.head.y > 0.02 &&
      b.lm[27].visibility > 0.4 &&
      b.lm[28].visibility > 0.4
    headOk.value = visOk(b.head)
    handsOk.value = (visOk(b.lHand) ? 1 : 0) + (visOk(b.rHand) ? 1 : 0)
  } else {
    bodyHeight.value = 0
    fullBody.value = false
    headOk.value = false
    handsOk.value = 0
  }
}

async function start() {
  loading.value = true
  errorMsg.value = ''
  try {
    await tracker.init()
    await tracker.openCamera(videoRef.value!)
    running.value = true
    loop()
    setInterval(measureBrightness, 900)
  } catch (e: any) {
    const m = String(e?.message ?? e)
    errorMsg.value = m.includes('姿态模型')
      ? m
      : e?.name === 'NotAllowedError'
        ? '你拒绝了摄像头权限，请在地址栏重新允许'
        : `打不开摄像头：${m}`
  } finally {
    loading.value = false
  }
}

const items = computed(() => [
  {
    ok: personCount.value > 0,
    title: '看到你了',
    tip: personCount.value > 0 ? `检测到 ${personCount.value} 个人` : '站到摄像头前，让整个人进画面',
  },
  {
    ok: headOk.value,
    title: '看到头了',
    tip: !personCount.value
      ? '还没看到人'
      : headOk.value
        ? '头在画面里'
        : '头没被认出来：往后退一点，别低头，帽子/刘海别挡脸',
  },
  {
    ok: handsOk.value === 2,
    title: '两只手都在画面里',
    tip: !personCount.value
      ? '还没看到人'
      : handsOk.value === 2
        ? '两只手都看得到'
        : `只看到 ${handsOk.value}/2 只手，把手抬到身前挥一挥（别贴身体、别伸出画面外）`,
  },
  {
    ok: fullBody.value,
    title: '全身在画面里',
    tip: fullBody.value ? '头和脚都看得到' : '往后退一点，或把摄像头抬高/放低',
  },
  {
    ok: bodyHeight.value > 45 && bodyHeight.value < 96,
    title: '距离合适',
    tip:
      bodyHeight.value === 0
        ? '还没看到人'
        : bodyHeight.value < 45
          ? '离得有点远，往前走一点'
          : bodyHeight.value > 96
            ? '离得太近了，往后退一点'
            : `身高约占画面 ${bodyHeight.value}%`,
  },
  {
    ok: brightness.value > 55,
    title: '光线够亮',
    tip:
      brightness.value === 0
        ? '正在测量光线…'
        : brightness.value <= 55
          ? '有点暗，开灯或面对窗户'
          : `亮度 ${brightness.value}，合适`,
  },
])

const passed = computed(() => items.value.filter((i) => i.ok).length)

onMounted(() => {
  // 页面卸载时释放摄像头
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  tracker.stop()
})
</script>

<template>
  <div class="page py-10">
    <h1 class="text-[34px] font-black tracking-tight">设备检测</h1>
    <p class="mt-2 text-slate-500 text-sm max-w-2xl">
      1 分钟查完摄像头、光线和站位，并确认头、双手都能被认出来（游戏判定主要靠它们）。检测只在这台电脑上做，画面不会上传。
    </p>

    <div class="grid lg:grid-cols-[1fr_380px] gap-8 mt-7">
      <div>
        <div class="relative rounded-3xl overflow-hidden bg-[#0b1024] aspect-video">
          <video
            ref="videoRef"
            class="absolute inset-0 w-full h-full object-cover"
            style="transform: scaleX(-1)"
            playsinline
            muted
            autoplay
          />
          <canvas ref="canvasRef" class="absolute inset-0 w-full h-full" />

          <div v-if="!running" class="absolute inset-0 grid place-items-center bg-[#0b1024]/85">
            <div class="text-center px-6">
              <div class="text-6xl mb-4">🎥</div>
              <h2 class="text-2xl font-black text-white">先看看摄像头</h2>
              <p class="mt-2 text-white/55 text-sm max-w-sm">
                点下面的按钮，浏览器会问你要不要用摄像头，选“允许”。
              </p>
              <div v-if="errorMsg" class="mt-4 px-4 py-3 rounded-2xl bg-red-500/15 text-red-300 text-sm">
                {{ errorMsg }}
              </div>
              <button
                class="mt-6 px-9 py-3.5 rounded-full text-white font-black shadow-xl transition active:scale-95 disabled:opacity-60"
                style="background: linear-gradient(135deg, #3390fc, #7c5cff)"
                :disabled="loading"
                @click="start"
              >
                {{ loading ? '正在打开…' : '打开摄像头' }}
              </button>
            </div>
          </div>

          <div v-if="running" class="absolute top-3 left-3 px-3 py-1.5 rounded-full bg-black/45 text-white text-[12px] font-bold">
            ● 实时识别 · {{ personCount }} 人
          </div>
        </div>

        <div class="card p-5 mt-5 flex items-start gap-3">
          <div class="text-2xl">💡</div>
          <div class="text-[13px] text-slate-500 leading-relaxed">
            摄像头最好放在胸口高度，孩子站在 2～3 米外。光线从前面来、别背光。地上清出一块空地，
            玩的时候有大人在旁边看着。
          </div>
        </div>
      </div>

      <aside class="space-y-4">
        <div class="card p-6">
          <div class="flex items-center justify-between mb-4">
            <h2 class="font-black text-lg">检测结果</h2>
            <span class="text-sm font-black" :class="passed === items.length ? 'text-mint-500' : 'text-slate-400'"
              >{{ passed }}/{{ items.length }}</span>
          </div>
          <ul class="space-y-3">
            <li v-for="it in items" :key="it.title" class="flex gap-3">
              <span
                class="w-6 h-6 rounded-full grid place-items-center text-[12px] font-black shrink-0 text-white"
                :style="{ background: it.ok ? '#1fc47d' : '#cbd5e1' }"
              >
                {{ it.ok ? '✓' : '!' }}
              </span>
              <div>
                <div class="font-bold text-[14px]" :class="it.ok ? 'text-slate-800' : 'text-slate-500'">
                  {{ it.title }}
                </div>
                <div class="text-[12px] text-slate-400 leading-snug">{{ it.tip }}</div>
              </div>
            </li>
          </ul>
        </div>

        <RouterLink
          to="/games"
          class="block text-center px-6 py-4 rounded-full text-white font-black shadow-xl shadow-candy-500/25 transition active:scale-95"
          style="background: linear-gradient(135deg, #ff3385, #ff7a45)"
        >
          检测好了，去玩 →
        </RouterLink>
      </aside>
    </div>
  </div>
</template>
