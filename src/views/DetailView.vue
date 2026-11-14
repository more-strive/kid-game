<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { GAMES, GAME_MAP } from '@/data/games'
import { bgOf, hasImpl } from '@/games'
import GameCard from '@/components/GameCard.vue'

const route = useRoute()
const game = computed(() => GAME_MAP.get(String(route.params.slug)))
const built = computed(() => (game.value ? hasImpl(game.value.slug) : false))

const similar = computed(() => {
  if (!game.value) return []
  return GAMES.filter(
    (g) => g.slug !== game.value!.slug && g.types.some((t) => game.value!.types.includes(t)),
  ).slice(0, 6)
})

const energyText = computed(() =>
  game.value ? ['轻松', '中等', '出汗'][game.value.energy - 1] : '',
)

// 子路径部署时资源路径要带 base
const base = import.meta.env.BASE_URL
const iconUrl = (slug: string) => `${base}icons/games/${slug}.svg`
const bgUrl = (slug: string) => `${base}bg/${bgOf(slug)}.svg`
</script>

<template>
  <div v-if="game" class="page py-10">
    <RouterLink to="/games" class="text-sm font-bold text-slate-400 hover:text-brand-600"
      >← 返回全部游戏</RouterLink
    >

    <div class="grid lg:grid-cols-[1fr_340px] gap-8 mt-5">
      <div>
        <div class="flex items-start gap-5">
          <div
            class="w-[92px] h-[92px] rounded-3xl grid place-items-center shrink-0 shadow-lg bg-white/80"
            :style="{ background: `linear-gradient(135deg, ${game.color}33, ${game.color}0d)` }"
          >
            <img
              :src="iconUrl(game.slug)"
              :alt="game.name"
              class="w-[62px] h-[62px] select-none"
              draggable="false"
            />
          </div>
          <div>
            <h1 class="text-[38px] leading-tight font-black tracking-tight">{{ game.name }}</h1>
            <p class="mt-1 text-slate-500">{{ game.tagline }}</p>
            <div class="flex flex-wrap gap-2 mt-3">
              <span class="pill">👦 {{ game.ageMin }}～{{ game.ageMax }} 岁</span>
              <span class="pill">⚡ 运动量{{ energyText }}</span>
              <span v-for="t in game.types" :key="t" class="pill">{{ t }}</span>
              <span v-if="built" class="pill" style="background: #e6fbf2; color: #0f9e68">专属玩法</span>
              <span v-else class="pill" style="background: #f1f3f9; color: #7d879c">通用玩法</span>
            </div>
          </div>
        </div>

        <div class="card p-6 mt-7">
          <h2 class="font-black text-lg mb-3">怎么玩</h2>
          <ol class="space-y-3">
            <li v-for="(h, i) in game.hows" :key="i" class="flex gap-3 items-start">
              <span
                class="w-6 h-6 rounded-full grid place-items-center text-[12px] font-black text-white shrink-0 mt-0.5"
                :style="{ background: game.color }"
                >{{ i + 1 }}</span
              >
              <span class="text-[15px] text-slate-600 leading-relaxed">{{ h }}</span>
            </li>
          </ol>
        </div>

        <div class="grid sm:grid-cols-2 gap-5 mt-5">
          <div class="card p-6">
            <h2 class="font-black text-lg mb-3">能练到什么</h2>
            <div class="flex flex-wrap gap-2">
              <span
                v-for="s in game.skills"
                :key="s"
                class="px-3 py-1.5 rounded-full text-[13px] font-bold bg-brand-50 text-brand-700"
                >{{ s }}</span
              >
            </div>
          </div>
          <div class="card p-6">
            <h2 class="font-black text-lg mb-3">游戏信息</h2>
            <dl class="text-[13px] space-y-2">
              <div class="flex justify-between">
                <dt class="text-slate-400 font-bold">每局时长</dt>
                <dd class="font-bold text-slate-700">
                  {{ game.duration ? `${game.duration} 秒` : '不计时，完成目标' }}
                </dd>
              </div>
              <div class="flex justify-between">
                <dt class="text-slate-400 font-bold">几个人玩</dt>
                <dd class="font-bold text-slate-700">
                  {{ game.mode === 'solo' ? '单人 / 两人比分数' : game.mode === 'coop' ? '单人 / 两人合作' : '单人 / 两人对战' }}
                </dd>
              </div>
              <div class="flex justify-between">
                <dt class="text-slate-400 font-bold">拿星标准</dt>
                <dd class="font-bold text-slate-700">
                  <template v-if="game.star3">
                    两颗星 ≥ {{ game.star2 }}，三颗星 ≥ {{ game.star3 }}
                  </template>
                  <template v-else>玩了就有一颗星</template>
                </dd>
              </div>
              <div class="flex justify-between">
                <dt class="text-slate-400 font-bold">需要</dt>
                <dd class="font-bold text-slate-700">摄像头 · Chrome / Edge</dd>
              </div>
            </dl>
          </div>
        </div>

        <div class="card p-6 mt-5">
          <h2 class="font-black text-lg mb-3">玩之前</h2>
          <ul class="text-[13px] text-slate-500 space-y-1.5 list-disc pl-5">
            <li>摄像头放在胸口高度，站在 2～3 米远。</li>
            <li>清出一块空地，注意地面防滑；小朋友玩的时候请大人在旁边。</li>
            <li>第一次玩先做一次设备检测；不确定怎么玩，就先看玩法说明。</li>
          </ul>
        </div>
      </div>

      <aside class="space-y-4">
        <div class="card p-5 lg:sticky lg:top-24">
          <RouterLink
            :to="`/play/${game.slug}`"
            class="block text-center px-6 py-4 rounded-full text-white font-black text-lg shadow-xl shadow-candy-500/25 transition active:scale-95"
            style="background: linear-gradient(135deg, #ff3385, #ff7a45)"
          >
            ▶ 开始玩{{ game.name }}
          </RouterLink>
          <RouterLink
            to="/check"
            class="block text-center mt-3 px-6 py-3 rounded-full font-bold text-sm bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
          >
            先做设备检测
          </RouterLink>
          <div class="mt-4 text-[12px] text-slate-400 leading-relaxed">
            第一次玩建议先允许摄像头权限，站远一点让全身进画面。中途可以按空格暂停。
          </div>
        </div>

        <div class="card overflow-hidden">
          <div class="relative h-[168px]" style="background: linear-gradient(180deg, #dceeff, #f6fbff)">
            <img
              :src="bgUrl(game.slug)"
              class="absolute inset-0 w-full h-full object-cover"
              alt=""
              draggable="false"
            />
            <img
              :src="iconUrl(game.slug)"
              :alt="game.name"
              class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[76px] h-[76px] drop-shadow-[0_10px_18px_rgba(24,44,110,.22)]"
              draggable="false"
            />
          </div>
          <div class="px-4 py-3">
            <div class="font-black text-[13px] text-slate-700">游戏画面示意</div>
            <div class="text-[12px] text-slate-400 mt-0.5">实际画面里，场景会叠加摄像头实时影像</div>
          </div>
        </div>
      </aside>
    </div>

    <div v-if="similar.length" class="mt-14">
      <h2 class="section-title mb-5">相似的游戏</h2>
      <div class="game-grid">
        <GameCard v-for="g in similar" :key="g.slug" :game="g" />
      </div>
    </div>
  </div>
  <el-empty v-else description="没有这个游戏" class="py-24" />
</template>
