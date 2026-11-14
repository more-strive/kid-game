<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { GAMES, TYPES } from '@/data/games'
import GameCard from '@/components/GameCard.vue'

const route = useRoute()
const router = useRouter()

const keyword = ref('')
const age = ref<'all' | 'kg' | 'pri' | 'sec'>('all')
const type = ref('')
const sort = ref<'default' | 'age' | 'energy'>('default')

watch(
  () => route.query,
  (q) => {
    if (q.age) age.value = q.age as any
    if (q.type) type.value = String(q.type)
  },
  { immediate: true },
)

const ages = [
  { key: 'all', label: '全部年龄' },
  { key: 'kg', label: '幼儿园 3～6' },
  { key: 'pri', label: '小学 6～12' },
  { key: 'sec', label: '中学 12～18' },
] as const

const list = computed(() => {
  let arr = GAMES.filter((g) => {
    if (keyword.value) {
      const k = keyword.value.toLowerCase()
      const hay = `${g.name}${g.tagline}${g.types.join('')}${g.skills.join('')}${g.slug}`.toLowerCase()
      if (!hay.includes(k)) return false
    }
    if (age.value === 'kg' && g.ageMin > 6) return false
    if (age.value === 'pri' && !(g.ageMax >= 6 && g.ageMin <= 12)) return false
    if (age.value === 'sec' && g.ageMax < 12) return false
    if (type.value && !g.types.includes(type.value)) return false
    return true
  })
  if (sort.value === 'age') arr = [...arr].sort((a, b) => a.ageMin - b.ageMin)
  if (sort.value === 'energy') arr = [...arr].sort((a, b) => b.energy - a.energy)
  return arr
})

function setAge(k: any) {
  age.value = k
  router.replace({ query: { ...route.query, age: k === 'all' ? undefined : k } })
}
function setType(t: string) {
  type.value = type.value === t ? '' : t
  router.replace({ query: { ...route.query, type: type.value || undefined } })
}
</script>

<template>
  <div class="page py-10">
    <div class="flex flex-wrap items-end justify-between gap-4 mb-7">
      <div>
        <h1 class="text-[34px] font-black tracking-tight">全部 {{ GAMES.length }} 个体感游戏</h1>
        <p class="mt-2 text-slate-500 text-sm">
          用电脑摄像头玩的网页版体感游戏：不用手柄、不用下载安装。按年龄、玩法挑一个开始。
        </p>
      </div>
      <el-input
        v-model="keyword"
        placeholder="搜游戏名，比如 跳绳 / 气球"
        clearable
        style="width: 260px"
        size="large"
      />
    </div>

    <div class="card p-4 mb-6 flex flex-wrap items-center gap-x-5 gap-y-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[12px] font-black text-slate-400">年龄</span>
        <button
          v-for="a in ages"
          :key="a.key"
          class="px-3.5 py-1.5 rounded-full text-[13px] font-bold transition"
          :class="age === a.key ? 'bg-brand-600 text-white shadow-md shadow-brand-500/25' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'"
          @click="setAge(a.key)"
        >
          {{ a.label }}
        </button>
      </div>
      <div class="w-px h-6 bg-slate-200 hidden md:block" />
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[12px] font-black text-slate-400">玩法</span>
        <button
          v-for="t in TYPES"
          :key="t"
          class="px-3 py-1.5 rounded-full text-[13px] font-bold transition"
          :class="type === t ? 'bg-candy-500 text-white shadow-md shadow-candy-500/25' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'"
          @click="setType(t)"
        >
          {{ t }}
        </button>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <span class="text-[12px] font-black text-slate-400">排序</span>
        <el-select v-model="sort" size="small" style="width: 108px">
          <el-option label="默认" value="default" />
          <el-option label="年龄从小到大" value="age" />
          <el-option label="运动量最大" value="energy" />
        </el-select>
      </div>
    </div>

    <div class="text-sm text-slate-400 font-bold mb-4">共 {{ list.length }} 个游戏</div>

    <div v-if="list.length" class="game-grid">
      <GameCard v-for="g in list" :key="g.slug" :game="g" />
    </div>
    <el-empty v-else description="没有找到符合条件的游戏" />
  </div>
</template>
