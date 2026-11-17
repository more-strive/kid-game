import type { Game, GameContext } from '@/core/types'
import createGeneric from './generic'

const impls = import.meta.glob(['./impl/*.ts', './proto/*.ts'])

/** 玩法原型复用表：同一套玩法引擎 + 每个游戏自己的主题配置 */

const ALIAS: Record<string, string> = {
  // 仍走原型引擎的游戏（原型已按原站真实规则对齐）
  'whack-mole': './proto/whack.ts',
  'santa-catch': './proto/catch.ts',
  'math-catch': './proto/catch.ts',
  'spell-catch': './proto/catch.ts',
}

/** 每个玩法原型/专属实现配套的场景装饰背景，未列出的默认 garden */
const BG_BY_PROTO: Record<string, string> = {
  './proto/whack.ts': 'garden',
  './proto/catch.ts': 'garden',
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
