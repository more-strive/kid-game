import type { Game, GameContext } from '@/core/types'
import createGeneric from './generic'

const impls = import.meta.glob(['./impl/*.ts', './proto/*.ts'])

/** 玩法原型复用表：同一套玩法引擎 + 每个游戏自己的主题配置 */
const ALIAS: Record<string, string> = {
  // 打击类
  'whack-mole': './proto/whack.ts',
  'bubble-pop': './proto/whack.ts',
  'star-stomp': './proto/whack.ts',
  'pillow-fight': './proto/whack.ts',
  'clap-bloom': './proto/whack.ts',
  boxing: './proto/whack.ts',
  // 接物类
  'santa-catch': './proto/catch.ts',
  'math-catch': './proto/catch.ts',
  'spell-catch': './proto/catch.ts',
  'water-flowers': './proto/catch.ts',
  fishing: './proto/catch.ts',
  firefly: './proto/catch.ts',
  'star-muncher': './proto/catch.ts',
  'sea-lion': './proto/catch.ts',
  'llama-treat': './proto/catch.ts',
  'bounce-ball': './proto/catch.ts',
  // 计数类
  'jump-rope': './proto/rep.ts',
  'rope-count': './proto/rep.ts',
  trampoline: './proto/rep.ts',
  hopscotch: './proto/rep.ts',
  hurdles: './proto/rep.ts',
  'squat-count': './proto/rep.ts',
  'pull-carrot': './proto/rep.ts',
  'radish-squat': './proto/rep.ts',
  'knee-count': './proto/rep.ts',
  'jack-count': './proto/rep.ts',
  burpee: './proto/rep.ts',
  'fitness-circuit': './proto/rep.ts',
  'bamboo-dance': './proto/rep.ts',
  sprint: './proto/rep.ts',
  'long-jump': './proto/rep.ts',
  'bike-ride': './proto/rep.ts',
  'swim-race': './proto/rep.ts',
  // 姿势类
  'shape-wall': './proto/pose.ts',
  'photo-pose': './proto/pose.ts',
  yoga: './proto/pose.ts',
  taichi: './proto/pose.ts',
  'animal-mimic': './proto/pose.ts',
  'simon-says': './proto/pose.ts',
  opposite: './proto/pose.ts',
  'english-moves': './proto/pose.ts',
  'dance-along': './proto/pose.ts',
  'mirror-duel': './proto/pose.ts',
  // 投掷瞄准类
  hoops: './proto/aim.ts',
  darts: './proto/aim.ts',
  archery: './proto/aim.ts',
  bowling: './proto/aim.ts',
  'soccer-kick': './proto/aim.ts',
  goalkeeper: './proto/aim.ts',
  'air-pong': './proto/aim.ts',
  tennis: './proto/aim.ts',
  volley: './proto/aim.ts',
  shuttlecock: './proto/aim.ts',
  'frisbee-dog': './proto/aim.ts',
  'stone-skip': './proto/aim.ts',
  // 节奏类
  'air-drums': './proto/rhythm.ts',
  'air-piano': './proto/rhythm.ts',
  'air-guitar': './proto/rhythm.ts',
  'rhythm-pad': './proto/rhythm.ts',
  conductor: './proto/rhythm.ts',
  'musical-chairs': './proto/rhythm.ts',
  'pitch-ladder': './proto/rhythm.ts',
  diabolo: './proto/rhythm.ts',
  'lion-dance': './proto/rhythm.ts',
  'saw-log': './proto/rhythm.ts',
  'dragon-boat': './proto/rhythm.ts',
}

/** 每个玩法原型配套的场景装饰背景 */
const BG_BY_PROTO: Record<string, string> = {
  './proto/whack.ts': 'garden',
  './proto/catch.ts': 'garden',
  './proto/rep.ts': 'stadium',
  './proto/pose.ts': 'stage',
  './proto/aim.ts': 'stadium',
  './proto/rhythm.ts': 'stage',
  './impl/freeze.ts': 'garden',
  './impl/fruit-slash.ts': 'space',
  './impl/balloon-keep.ts': 'garden',
}

function keyFor(slug: string) {
  if (impls[`./impl/${slug}.ts`]) return `./impl/${slug}.ts`
  return ALIAS[slug]
}

/** 该游戏用哪张场景装饰背景 */
export function bgOf(slug: string) {
  const key = keyFor(slug)
  return (key && BG_BY_PROTO[key]) || 'garden'
}

export function hasImpl(slug: string) {
  return Boolean(keyFor(slug))
}

export function implCount() {
  return Object.keys(ALIAS).length + Object.keys(impls).filter((k) => k.startsWith('./impl/')).length
}

export async function createGame(slug: string, ctx: GameContext): Promise<Game> {
  const key = keyFor(slug)
  const loader = key ? (impls[key] as undefined | (() => Promise<{ default: (c: GameContext) => Game }>)) : undefined
  let game: Game | null = null
  if (loader) {
    try {
      const mod = await loader()
      game = mod.default(ctx)
    } catch (e) {
      console.error('[game] 加载失败，降级到通用玩法', slug, e)
    }
  }
  if (!game) game = createGeneric(ctx)
  if (!game.bg) game.bg = (key && BG_BY_PROTO[key]) || 'garden'
  return game
}
