<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { introPose } from '@/core/intro-pose'
import type { IntroHandle } from '@/core/intro3d' // 仅类型：three 不进本组件 chunk

/**
 * 详情页 3D 动作示范。
 * three 场景滚到可视区才开始创建（IntersectionObserver），不可见时暂停渲染；
 * WebGL 不可用或加载失败时保持游戏图标兜底，不阻塞页面。
 */
const props = defineProps<{ slug: string; color: string; types: string[] }>()

const wrap = ref<HTMLDivElement>()
const cv = ref<HTMLCanvasElement>()
const ready = ref(false)

let handle: IntroHandle | null = null
let raf = 0
let t0 = 0
let visible = false
let ro: ResizeObserver | undefined
let io: IntersectionObserver | undefined

onMounted(async () => {
  const el = wrap.value
  const canvas = cv.value
  if (!el || !canvas) return

  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting)
      },
      { rootMargin: '80px' },
    )
    io.observe(el)
  } else {
    visible = true
  }
  ro = new ResizeObserver(() => {
    handle?.resize(el.clientWidth, el.clientHeight)
  })
  ro.observe(el)

  const { createIntroScene } = await import('@/core/intro3d')
  if (!el.isConnected) return // 等待期间组件已卸载
  handle = await createIntroScene(canvas, {
    color: () => props.color,
    pose: (t) => introPose(props.slug, props.types, t),
  })
  if (!handle) return // WebGL 不可用：保持兜底图标
  handle.resize(el.clientWidth, el.clientHeight)
  ready.value = true

  t0 = performance.now()
  const loop = () => {
    raf = requestAnimationFrame(loop)
    if (!visible || !handle) return
    const t = (performance.now() - t0) / 1000
    handle.update(t)
    handle.render()
  }
  raf = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  io?.disconnect()
  handle?.dispose()
  handle = null
})

const base = import.meta.env.BASE_URL
const iconUrl = () => `${base}icons/games/${props.slug}.svg`
</script>

<template>
  <div
    ref="wrap"
    class="relative w-full h-[300px] rounded-2xl overflow-hidden select-none"
    style="background: radial-gradient(120% 90% at 50% 0%, #ffffff 0%, #eaf3ff 55%, #dceeff 100%)"
  >
    <img
      :src="iconUrl()"
      :alt="props.slug"
      class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[72px] h-[72px] transition-opacity duration-500"
      :class="ready ? 'opacity-15' : 'opacity-80 animate-pulse'"
      draggable="false"
    />
    <canvas ref="cv" class="absolute inset-0 w-full h-full"></canvas>
    <div
      class="absolute left-3 bottom-2.5 text-[11px] font-bold text-slate-500/80 bg-white/70 backdrop-blur rounded-full px-2.5 py-1"
    >
      动作示范 · 3D 预览
    </div>
  </div>
</template>
