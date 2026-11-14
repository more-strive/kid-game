<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { GAMES, TYPES } from '@/data/games'
import GameCard from '@/components/GameCard.vue'

const total = GAMES.length
const counts = computed(() => ({
  kg: GAMES.filter((g) => g.ageMin <= 6).length,
  pri: GAMES.filter((g) => g.ageMax >= 6 && g.ageMin <= 12).length,
  sec: GAMES.filter((g) => g.ageMax >= 12).length,
}))

const featured = ['freeze', 'fruit-slash', 'jump-rope', 'balloon-keep', 'math-catch', 'whack-mole']
const picks = computed(() => featured.map((s) => GAMES.find((g) => g.slug === s)!).filter(Boolean))

const ages = [
  {
    key: 'kg',
    emoji: '🧒',
    title: '幼儿园 · 3～6 岁',
    desc: '木头人、托气球、小鸟飞飞、接礼物……',
    to: '/games?age=kg',
    color: '#ffc53d',
  },
  {
    key: 'pri',
    emoji: '🎒',
    title: '小学 · 6～12 岁',
    desc: '水果忍者、跳绳大王、节奏踏板、拼字接接乐……',
    to: '/games?age=pri',
    color: '#3390fc',
  },
  {
    key: 'sec',
    emoji: '🏀',
    title: '中学 · 12～18 岁',
    desc: '体能循环、功夫对决、跟跳舞蹈、波比跳挑战……',
    to: '/games?age=sec',
    color: '#7c5cff',
  },
]

const steps = [
  { n: 1, t: '打开网页', d: '用 Chrome 或 Edge 打开就行，笔记本自带的摄像头就够。想让全班一起看，接上投影或电视。', icon: '💻' },
  { n: 2, t: '站到摄像头前', d: '离摄像头 2～3 米，从头到脚都进画面。第一次用先做一次设备检测，1 分钟查完摄像头、光线和站位。', icon: '🧍' },
  { n: 3, t: '动起来', d: '跳、跑、挥手、下蹲，屏幕里的小人跟着你动。每个游戏都有中文语音带着做。', icon: '🎉' },
]
</script>

<template>
  <div>
    <!-- Hero -->
    <section class="relative overflow-hidden">
      <div class="absolute inset-0 pointer-events-none">
        <div class="absolute -top-24 -left-24 w-[420px] h-[420px] rounded-full bg-brand-200/40 blur-3xl" />
        <div class="absolute -top-10 right-0 w-[380px] h-[380px] rounded-full bg-candy-200/40 blur-3xl" />
      </div>
      <div class="page relative pt-16 pb-10">
        <div class="grid lg:grid-cols-[1.15fr_.85fr] gap-10 items-center">
          <div>
            <div class="pill mb-4">
              <span class="w-2 h-2 rounded-full bg-mint-500 animate-pulse" />
              110 个游戏全部可玩 · 无需安装
            </div>
            <h1 class="text-[42px] md:text-[54px] leading-[1.08] font-black tracking-tight">
              <span class="text-slate-900">用摄像头玩的</span><br />
              <span
                style="background: linear-gradient(120deg, #3390fc 10%, #ff3385 60%, #ff9d3d 95%); -webkit-background-clip: text; background-clip: text; color: transparent"
                >儿童体感游戏</span
              >
            </h1>
            <p class="mt-5 text-[17px] leading-relaxed text-slate-500 max-w-xl">
              适合 3～18 岁，幼儿园、小学、中学都有。孩子站在电脑或投影前跳、跑、挥手、下蹲，屏幕里的小人跟着动。不用手柄，也不用安装。
            </p>
            <div class="mt-8 flex flex-wrap items-center gap-3">
              <RouterLink
                to="/games"
                class="px-8 py-4 rounded-full text-white font-black text-[17px] shadow-xl shadow-candy-500/30 transition active:scale-95 hover:brightness-105"
                style="background: linear-gradient(135deg, #ff3385, #ff7a45)"
              >
                ▶ 开始玩
              </RouterLink>
              <RouterLink
                to="/check"
                class="px-6 py-4 rounded-full font-black text-[15px] bg-white border-2 border-slate-200 text-slate-700 hover:border-brand-300 hover:text-brand-700 transition"
              >
                设备检测
              </RouterLink>
              <span class="text-sm text-slate-400 font-semibold">不登录可以先试玩</span>
            </div>
            <div class="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[13px] font-bold text-slate-400">
              <span>🎥 画面只在本机识别</span>
              <span>🚫 没有广告</span>
              <span>📶 打开过一次断网也能玩</span>
            </div>
          </div>

          <div class="relative">
            <div class="card p-5 rotate-1">
              <div class="rounded-2xl overflow-hidden bg-slate-900 aspect-video relative">
                <div class="absolute inset-0 grid place-items-center">
                  <div class="text-center">
                    <svg viewBox="0 0 120 160" class="w-[112px] h-[150px] mx-auto" aria-hidden="true">
                      <g stroke="#5eead4" stroke-width="3.4" stroke-linecap="round" opacity=".9">
                        <line x1="60" y1="38" x2="60" y2="86" />
                        <line x1="60" y1="50" x2="33" y2="72" />
                        <line x1="60" y1="50" x2="87" y2="72" />
                        <line x1="33" y1="72" x2="21" y2="98" />
                        <line x1="87" y1="72" x2="99" y2="98" />
                        <line x1="60" y1="86" x2="43" y2="124" />
                        <line x1="60" y1="86" x2="77" y2="124" />
                        <line x1="43" y1="124" x2="41" y2="154" />
                        <line x1="77" y1="124" x2="79" y2="154" />
                      </g>
                      <g fill="#fbbf24">
                        <circle cx="60" cy="26" r="10" fill="none" stroke="#5eead4" stroke-width="3.4" />
                        <circle cx="60" cy="50" r="3.4" />
                        <circle cx="60" cy="86" r="3.4" />
                        <circle cx="33" cy="72" r="3" />
                        <circle cx="87" cy="72" r="3" />
                        <circle cx="21" cy="98" r="3.6" />
                        <circle cx="99" cy="98" r="3.6" />
                        <circle cx="43" cy="124" r="3" />
                        <circle cx="77" cy="124" r="3" />
                        <circle cx="41" cy="154" r="3.4" />
                        <circle cx="79" cy="154" r="3.4" />
                      </g>
                    </svg>
                    <div class="text-white/70 font-bold text-[12px] mt-1">摄像头画面在这里</div>
                  </div>
                </div>
                <div class="absolute top-3 left-3 px-3 py-1 rounded-full bg-black/40 text-white text-[11px] font-bold">
                  ● 实时识别 33 个关键点
                </div>
              </div>
              <div class="flex items-center justify-between mt-4">
                <div class="flex gap-1.5">
                  <span v-for="i in 3" :key="i" class="text-2xl">⭐</span>
                </div>
                <div class="text-right">
                  <div class="text-[11px] text-slate-400 font-bold">本局得分</div>
                  <div class="text-2xl font-black text-brand-600">238</div>
                </div>
              </div>
            </div>
            <div class="absolute -bottom-5 -left-5 px-4 py-3 rounded-2xl bg-white shadow-xl text-sm font-black text-slate-700 -rotate-2">
              🎈 托气球 · 三颗星！
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 三步 -->
    <section class="page py-12">
      <h2 class="section-title mb-6">三步开玩</h2>
      <div class="grid md:grid-cols-3 gap-5">
        <div v-for="s in steps" :key="s.n" class="card p-6 relative overflow-hidden">
          <div class="text-4xl mb-3">{{ s.icon }}</div>
          <div class="flex items-center gap-2 mb-2">
            <span
              class="w-6 h-6 rounded-full grid place-items-center text-[12px] font-black text-white"
              style="background: linear-gradient(135deg, #3390fc, #7c5cff)"
              >{{ s.n }}</span
            >
            <span class="font-black text-slate-800">{{ s.t }}</span>
          </div>
          <p class="text-[13px] leading-relaxed text-slate-500">{{ s.d }}</p>
        </div>
      </div>
    </section>

    <!-- 按年龄 -->
    <section class="page py-6">
      <div class="flex items-end justify-between mb-6">
        <h2 class="section-title">按年龄挑</h2>
        <RouterLink to="/games" class="text-sm font-bold text-brand-600 hover:underline"
          >全部 {{ total }} 个游戏 →</RouterLink
        >
      </div>
      <div class="grid md:grid-cols-3 gap-5">
        <RouterLink
          v-for="a in ages"
          :key="a.key"
          :to="a.to"
          class="card p-6 group hover:-translate-y-1 transition"
        >
          <div class="flex items-center gap-3 mb-2">
            <span class="text-3xl">{{ a.emoji }}</span>
            <div>
              <div class="font-black text-slate-800">{{ a.title }}</div>
              <div class="text-[12px] font-bold" :style="{ color: a.color }">
                {{ a.key === 'kg' ? counts.kg : a.key === 'pri' ? counts.pri : counts.sec }} 个游戏
              </div>
            </div>
          </div>
          <p class="text-[13px] text-slate-500 leading-relaxed">{{ a.desc }}</p>
          <div class="mt-3 text-[13px] font-black text-slate-400 group-hover:text-brand-600 transition">
            看这一组的游戏 →
          </div>
        </RouterLink>
      </div>
    </section>

    <!-- 精选 -->
    <section class="page py-10">
      <div class="flex items-end justify-between mb-6">
        <h2 class="section-title">先挑几个试试</h2>
        <RouterLink to="/games" class="text-sm font-bold text-brand-600 hover:underline"
          >全部 {{ total }} 个游戏 →</RouterLink
        >
      </div>
      <div class="game-grid">
        <GameCard v-for="g in picks" :key="g.slug" :game="g" />
      </div>
    </section>

    <!-- 玩法类型 -->
    <section class="page py-10">
      <h2 class="section-title mb-5">按玩法找</h2>
      <div class="flex flex-wrap gap-3">
        <RouterLink
          v-for="t in TYPES"
          :key="t"
          :to="`/games?type=${encodeURIComponent(t)}`"
          class="px-5 py-2.5 rounded-full bg-white border border-slate-200 font-bold text-sm text-slate-600 hover:border-brand-300 hover:text-brand-700 hover:shadow-md transition"
        >
          {{ t }}
        </RouterLink>
      </div>
    </section>

    <!-- CTA -->
    <section class="page py-14">
      <div
        class="rounded-[32px] p-10 md:p-14 text-center relative overflow-hidden"
        style="background: linear-gradient(135deg, #16295c, #2a1b58)"
      >
        <div class="absolute -top-10 -left-10 text-[170px] opacity-10">🎈</div>
        <div class="absolute -bottom-14 -right-6 text-[170px] opacity-10">🏀</div>
        <h2 class="text-3xl md:text-4xl font-black text-white relative">现在就动起来</h2>
        <p class="mt-3 text-white/70 relative">打开就能玩，先试两局看看。第一次用，先做一次设备检测。</p>
        <div class="mt-7 flex flex-wrap justify-center gap-3 relative">
          <RouterLink
            to="/games"
            class="px-7 py-3.5 rounded-full font-black text-white shadow-lg transition active:scale-95"
            style="background: linear-gradient(135deg, #ff3385, #ff7a45)"
            >▶ 开始玩</RouterLink
          >
          <RouterLink
            to="/check"
            class="px-7 py-3.5 rounded-full font-black bg-white/10 text-white border border-white/20 hover:bg-white/20 transition"
            >设备检测</RouterLink
          >
        </div>
      </div>
    </section>
  </div>
</template>
