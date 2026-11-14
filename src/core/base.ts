import { Cursor, H, Particles, W } from './draw'
import type { Body, Game, GameContext, PoseFrame } from './types'

export interface FloatWord {
  text: string
  x: number
  y: number
  vy: number
  life: number
  max: number
  color: string
  size: number
}

export interface PlayerView {
  id: number
  body: Body | null
  lHand: Cursor
  rHand: Cursor
  color: string
}

export const PLAYER_COLORS = ['#ffd54a', '#4cc9f0']

/** 游戏基类：统一坐标、玩家光标、飘字、粒子 */
export abstract class BaseGame implements Game {
  readonly W = W
  readonly H = H
  ctx: GameContext
  t = 0
  particles = new Particles()
  words: FloatWord[] = []
  players: PlayerView[] = []

  constructor(ctx: GameContext) {
    this.ctx = ctx
    for (let i = 0; i < 2; i++) {
      this.players.push({
        id: i,
        body: null,
        lHand: new Cursor(0, 0, PLAYER_COLORS[i]),
        rHand: new Cursor(0, 0, PLAYER_COLORS[i]),
        color: PLAYER_COLORS[i],
      })
    }
  }

  /** 归一化 x -> 画布 x */
  px(n: number) {
    return n * W
  }
  py(n: number) {
    return n * H
  }

  player(i: number): PlayerView {
    return this.players[i]
  }

  say(text: string, x: number, y: number, color = '#fff', size = 44) {
    this.words.push({ text, x, y, vy: -70, life: 1, max: 1, color, size })
  }

  update(f: PoseFrame, dt: number) {
    this.t += dt
    this.syncPlayers(f)
    this.tick(f, dt)
    this.particles.update(dt)
    for (let i = this.words.length - 1; i >= 0; i--) {
      const w = this.words[i]
      w.life -= dt
      w.y += w.vy * dt
      if (w.life <= 0) this.words.splice(i, 1)
    }
  }

  private syncPlayers(f: PoseFrame) {
    for (let i = 0; i < 2; i++) {
      const pv = this.players[i]
      const b = f.bodies[i]
      pv.body = b ?? null
      if (b) {
        pv.lHand.move(b.lHand.x * W, b.lHand.y * H)
        pv.rHand.move(b.rHand.x * W, b.rHand.y * H)
      } else {
        pv.lHand.active = false
        pv.rHand.active = false
        pv.lHand.trail.length = 0
        pv.rHand.trail.length = 0
      }
    }
  }

  draw(c: CanvasRenderingContext2D) {
    this.paint(c)
    this.particles.draw(c)
    // 手部光标画在最上层，玩家随时能看到自己的手在哪（没检测到人时自动隐藏）
    for (const pv of this.players) {
      pv.lHand.draw(c)
      pv.rHand.draw(c)
    }
    for (const w of this.words) {
      c.globalAlpha = Math.min(1, w.life / w.max)
      c.font = `900 ${w.size}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.lineWidth = Math.max(4, w.size * 0.18)
      c.strokeStyle = 'rgba(18,22,55,.7)'
      c.lineJoin = 'round'
      c.strokeText(w.text, w.x, w.y)
      c.fillStyle = w.color
      c.fillText(w.text, w.x, w.y)
      c.globalAlpha = 1
    }
  }

  abstract tick(f: PoseFrame, dt: number): void
  abstract paint(c: CanvasRenderingContext2D): void
}

/** 简单的线段碰撞：手在两点之间划过 */
export function segHit(
  ax: number, ay: number, bx: number, by: number,
  x: number, y: number, r: number,
) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-6) return Math.hypot(x - ax, y - ay) < r
  let t = ((x - ax) * dx + (y - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + dx * t
  const cy = ay + dy * t
  return Math.hypot(x - cx, y - cy) < r
}

/** 手是否有“挥”的动作（用于切/打） */
export function swingSpeed(b: Body | null) {
  if (!b) return 0
  return Math.max(b.lHandV, b.rHandV)
}

/** 取更快的那只手 */
export function fastHand(b: Body | null) {
  if (!b) return null
  return b.lHandV >= b.rHandV
    ? { hand: b.lHand, speed: b.lHandV, prevSpeed: b.lHandV }
    : { hand: b.rHand, speed: b.rHandV, prevSpeed: b.rHandV }
}
