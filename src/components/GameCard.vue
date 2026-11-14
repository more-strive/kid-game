<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { GameMeta } from '@/data/games'
import { hasImpl } from '@/games'

const props = defineProps<{ game: GameMeta; index?: number }>()

const energyDots = computed(() => '⚡'.repeat(props.game.energy))
const built = computed(() => hasImpl(props.game.slug))
// 子路径部署（/kid-game/）时图标也要带 base，否则 404
const iconUrl = (slug: string) => `${import.meta.env.BASE_URL}icons/games/${slug}.svg`
</script>

<template>
  <RouterLink
    :to="`/game/${game.slug}`"
    class="group card overflow-hidden flex flex-col hover:-translate-y-1.5 hover:shadow-[0_26px_50px_-30px_rgba(24,44,110,.6)] transition duration-300"
  >
    <div
      class="relative h-[118px] grid place-items-center overflow-hidden"
      :style="{ background: `linear-gradient(135deg, ${game.color}22, ${game.color}05)` }"
    >
      <div
        class="absolute -right-6 -top-8 w-24 h-24 rounded-full opacity-20"
        :style="{ background: game.color }"
      />
      <div
        class="absolute -left-8 -bottom-10 w-28 h-28 rounded-full opacity-10"
        :style="{ background: game.color }"
      />
      <div
        class="relative w-[76px] h-[76px] rounded-[22px] grid place-items-center bg-white/70 shadow-[0_6px_16px_-8px_rgba(24,44,110,.35)] group-hover:scale-110 group-hover:-rotate-3 transition duration-300"
      >
        <img
          :src="iconUrl(game.slug)"
          :alt="game.name"
          class="w-[52px] h-[52px] select-none pointer-events-none"
          loading="lazy"
          draggable="false"
        />
      </div>
      <span
        v-if="built"
        class="absolute top-2.5 right-2.5 text-[10px] font-black px-2 py-0.5 rounded-full text-white shadow"
        style="background: linear-gradient(135deg, #1fc47d, #37d6a0)"
        >已实现</span
      >
      <span
        v-else
        class="absolute top-2.5 right-2.5 text-[10px] font-black px-2 py-0.5 rounded-full text-white/90 bg-slate-400/70"
        >通用玩法</span
      >
    </div>

    <div class="p-3.5 flex flex-col gap-1 flex-1">
      <div class="font-black text-[15px] text-slate-800 leading-snug">{{ game.name }}</div>
      <div class="text-[12px] text-slate-500 leading-snug line-clamp-2 h-[34px]">
        {{ game.tagline }}
      </div>
      <div class="flex items-center gap-2 mt-1 text-[11px] text-slate-400 font-bold">
        <span>{{ game.ageMin }}～{{ game.ageMax }} 岁</span>
        <span class="text-[10px]">{{ energyDots }}</span>
        <span class="ml-auto px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{{
          game.types[0]
        }}</span>
      </div>
    </div>
  </RouterLink>
</template>
