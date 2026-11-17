import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, txt } from '@/core/draw'

/**
 * 记忆翻牌 / memory-flip（对齐 dongdongpark 真实规则）：
 * 卡牌悬浮在肩周（多数在肩上方，锚定肩中心、尺寸随躯干），手掌悬停 0.25~0.4s 翻开；
 * 两张一样 +1 分消掉，不一样亮 show 秒后翻回并「blocked」（手不离开不复翻）；
 * 全部配对清盘 → 加一对再来。开局有偷看阶段（小童恒 3s）。
 *
 * 全部字面量沿用站点：起始对数 4/6/8（上限 6/8/10）、悬停 dwell 0.3/0.25/0.25、
 * 翻错展示 show 1.4/1/0.8、偷看 peek 2.5/0/0——本框架无 big（大童）模式 → 小童附加配置恒定生效：
 * peek=max(peek,3)=3、show+0.6、dwell+0.1、扩边系数 0.55；
 * 卡宽 0.5×躯干 / 高 0.54×躯干（躯干 clamp 110~250u）、命中=掌心点半径 ×0.55 扩边 AABB、
 * 离开 3× 衰减、配对确认 0.6s、清盘庆祝 1.8s、翻面动画 0.2s、发牌每张 0.035s、
 * 2P 严格轮流（翻错换人、12s 不出手/3s 缺席强制换人）、离开 3× 衰减。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点手 = pos + r 单点黑盒 → 本框架用 lHandDet/rHandDet 的掌心，r 按躯干 0.28 估算；
 * 2) 手势全程未用（站点同款）——位置+悬停驱动；精灵卡面用「字母/emoji」近似；
 * 3) 双人共享盘数统计（站点 2P 共享「一起清空几盘」同款），分数各自记改共享（仓库口径）；
 * 4) ai() 演示替身未实装；镜头过渡简化为直接锚定当前玩家。
 */
interface Card {
  face: number // 卡面编号（0~5）
  slot: number // 槽位序号
  up: boolean
  gone: boolean
  goneT: number
  flip: number // 翻面动画 0~1
  dwell: number
  blocked: boolean
  shake: number
  appear: number // 发牌延迟（负数=还没出现）
}

interface Zone {
  x0: number
  x1: number
  cx: number
}

/** 站点三档：起始对数 / 上限 / 悬停 / 翻错展示 / 偷看 */
const DIFF = [
  { pairs: 4, max: 6, dwell: 0.3, show: 1.4, peek: 2.5 },
  { pairs: 6, max: 8, dwell: 0.25, show: 1, peek: 0 },
  { pairs: 8, max: 10, dwell: 0.25, show: 0.8, peek: 0 },
]

/** 小童附加配置（本框架无 big 模式 → 恒定生效） */
const X_PEEK = 3
const X_SHOW = 0.6
const X_DWELL = 0.1
const X_EDGE = 0.55

const CARD_W = 0.5 // 卡宽（×躯干）
const CARD_H = 0.54
const FLIP_T = 0.2
const MATCH_CONFIRM = 0.6
const CLEAR_CELE = 1.8
const DEAL_PER = 0.035
const DECAY = 3 // 离开衰减倍率
/** 槽位表：10 组 [x, y]（×躯干，组内镜像 ±x） */
const SLOTS: [number, number][] = [
  [0.84, -0.48], [1.4, -0.48], [0.84, 0.1], [1.4, 0.1], [1.96, -0.48],
  [1.96, 0.1], [0.84, -1.06], [1.4, -1.06], [1.96, -1.06], [0.84, 0.68],
]
const FACES = ['🍎', '⭐', '🌈', '🐱', '🌻', '🚀']
const DUR = 90

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class MemoryFlip extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  dwell = this.cfg.dwell + X_DWELL
  show = this.cfg.show + X_SHOW
  peek = Math.max(this.cfg.peek, X_PEEK)
  cards: Card[] = []
  seats = 1
  turn = 0 // 当前回合玩家（2P）
  boardP = 0 // 棋盘锚定的玩家
  phase: 'ready' | 'deal' | 'peek' | 'play' | 'review' | 'clear' | 'switch' = 'ready'
  phaseAt = 0
  pairsGoal = this.cfg.pairs
  upFaces: number[] = [] // 亮起的牌序号（≤2）
  reviewAt = 0
  matchOk = false
  streak = 0
  bestStreak = 0
  boards = 0
  turns = 0
  private scored = 0
  private seatActive = [false, false]
  private absent = 0
  private moveT = 0
  private lastF: PoseFrame | null = null
  private rng = mulberry32(8)
  private U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.enableHands().catch(() => undefined)
    this.dealBoard()
  }

  private pairCount() {
    return Math.min(this.cfg.max, this.pairsGoal)
  }

  private dealBoard() {
    const n = this.pairCount()
    const faces: number[] = []
    const pool = FACES.map((_, i) => i)
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    for (let i = 0; i < n; i++) {
      faces.push(pool[i % pool.length], pool[i % pool.length])
    }
    // 洗牌 + 槽位（前 2n 个槽位序号）
    for (let i = faces.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[faces[i], faces[j]] = [faces[j], faces[i]]
    }
    this.cards = faces.map((face, i) => ({
      face, slot: i, up: false, gone: false, goneT: 0,
      flip: 0, dwell: 0, blocked: false, shake: 0,
      appear: -i * DEAL_PER,
    }))
    this.upFaces = []
    this.phase = 'deal'
    this.phaseAt = this.t
  }

  private anchor(b: Body | null, turn: number) {
    if (b) {
      const s = clamp(b.scale * this.H * 1.1, 110 * this.U, 250 * this.U)
      return { x: b.shoulderC.x * this.W, y: b.shoulderC.y * this.H, s }
    }
    const z = this.zoneOf(turn)
    return { x: z.cx, y: this.H * 0.4, s: this.H * 0.2 }
  }

  private zoneOf(turn: number): Zone {
    const duo = this.seats > 1
    const x0 = duo ? (turn * this.W) / 2 : 0
    const x1 = duo ? ((turn + 1) * this.W) / 2 : this.W
    return { x0, x1, cx: (x0 + x1) / 2 }
  }

  /** 卡牌屏幕位置 */
  private cardPos(card: Card, b: Body | null, turn: number) {
    const a = this.anchor(b, turn)
    const group = SLOTS[Math.floor(card.slot / 2)]
    const side = card.slot % 2 === 0 ? -1 : 1
    return { x: a.x + side * group[0] * a.s, y: a.y + group[1] * a.s, w: CARD_W * a.s, h: CARD_H * a.s, s: a.s }
  }

  tick(f: PoseFrame, dt: number) {
    this.lastF = f
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.turn = 0
      this.boardP = 0
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true

    const elapsed = this.t - this.phaseAt
    switch (this.phase) {
      case 'ready':
        this.phase = 'deal'
        break
      case 'deal':
        if (elapsed >= 0.45 + this.cards.length * DEAL_PER) {
          this.phase = 'peek'
          this.phaseAt = this.t
        }
        break
      case 'peek':
        for (const cd of this.cards) cd.flip = 1 // 全亮
        if (elapsed >= this.peek) {
          for (const cd of this.cards) cd.flip = 0
          this.phase = 'play'
          this.phaseAt = this.t
          this.ctx.audio.play('click', 0.5, 0.7)
          this.say('翻回去啦，记住位置！', this.W / 2, this.H * 0.14, '#ffd54a', 24)
        }
        break
      case 'play':
        this.stepPlay(f, dt)
        break
      case 'review':
        if (this.t - this.reviewAt >= (this.matchOk ? MATCH_CONFIRM : this.show)) {
          this.resolveReview()
        }
        break
      case 'clear':
        if (elapsed >= CLEAR_CELE) {
          this.pairsGoal = Math.min(this.cfg.max, this.pairsGoal + 1)
          this.boards++
          this.dealBoard()
        }
        break
      case 'switch':
        if (elapsed >= 0.75) {
          this.phase = 'play'
          this.phaseAt = this.t
          this.moveT = 0
        }
        break
    }
    // 翻面动画
    for (const cd of this.cards) {
      if (cd.appear < 0) cd.appear += dt
      const target = cd.up || (this.phase === 'peek' && cd.appear >= 0) ? 1 : 0
      cd.flip += (target - cd.flip) * Math.min(1, (dt / FLIP_T) * 2)
      cd.flip = clamp(cd.flip, 0, 1)
      if (cd.gone) cd.goneT += dt
      if (cd.shake > 0) cd.shake -= dt * 1.4
    }
    // 2P 超时
    if (this.seats > 1 && this.phase === 'play') {
      const b = f.bodies[this.turn]
      if (!b) {
        this.absent += dt
        if (this.absent > 3) this.forceSwitch()
      } else {
        this.absent = 0
        this.moveT += dt
        if (this.moveT > 12) this.forceSwitch()
      }
    }
    // 结束
    if (this.t >= DUR) this.ctx.finish()
    this.ctx.setExtra('boards', this.boards)
    this.ctx.setExtra('rate', this.turns > 0 ? Math.round((100 * this.scored) / this.turns) : -1)
  }


  private forceSwitch() {
    for (const cd of this.cards) {
      if (cd.up) {
        cd.up = false
        cd.blocked = true
      }
    }
    this.upFaces = []
    this.turn = 1 - this.turn
    this.boardP = this.turn
    this.phase = 'switch'
    this.phaseAt = this.t
    this.absent = 0
    this.moveT = 0
  }

  private stepPlay(f: PoseFrame, dt: number) {
    const b = f.bodies[this.turn] ?? null
    if (!b) return
    const T = Math.max(110 * this.U, b.scale * this.H * 1.1)
    const handR = T * 0.28
    const edge = handR * X_EDGE
    // 每只手当前覆盖的牌
    const covered = new Set<number>()
    const hands = [b.lHandDet ? { ...b.lHandDet.palm, r: handR } : { x: b.lHand.x * this.W, y: b.lHand.y * this.H, r: handR }, b.rHandDet ? { ...b.rHandDet.palm, r: handR } : { x: b.rHand.x * this.W, y: b.rHand.y * this.H, r: handR }]
    for (const h of hands) {
      let bestC: Card | null = null
      let bestD = Infinity
      for (const cd of this.cards) {
        if (cd.gone || cd.up) continue
        const pos = this.cardPos(cd, b, this.turn)
        const dx = h.x - pos.x
        const dy = h.y - pos.y
        if (Math.abs(dx) <= pos.w / 2 + edge && Math.abs(dy) <= pos.h / 2 + edge) {
          const d = Math.abs(dx) / pos.w + Math.abs(dy) / pos.h
          if (d < bestD) {
            bestD = d
            bestC = cd
          }
        }
      }
      if (bestC) covered.add(this.cards.indexOf(bestC))
    }
    // dwell 累计/衰减 + blocked 解除
    for (let i = 0; i < this.cards.length; i++) {
      const cd = this.cards[i]
      if (cd.gone || cd.up) continue
      if (this.upFaces.length >= 2) continue // review 期不累计
      if (covered.has(i)) {
        if (!cd.blocked) {
          cd.dwell += dt
          if (cd.dwell >= this.dwell) this.flipUp(i)
        }
      } else {
        cd.dwell = Math.max(0, cd.dwell - dt * DECAY)
        cd.blocked = false // 手离开 → 解锁
      }
    }
  }

  private flipUp(idx: number) {
    const cd = this.cards[idx]
    cd.up = true
    cd.dwell = 0
    this.upFaces.push(idx)
    this.moveT = 0
    this.ctx.audio.play('click', 0.4, this.upFaces.length === 1 ? 1.25 : 1.4)
    if (this.upFaces.length >= 2) {
      this.phase = 'review'
      this.reviewAt = this.t
      const [i0, i1] = this.upFaces
      this.matchOk = this.cards[i0].face === this.cards[i1].face
    }
  }

  private resolveReview() {
    const [i0, i1] = this.upFaces
    if (this.matchOk) {
      this.streak++
      this.bestStreak = Math.max(this.bestStreak, this.streak)
      this.scored++
      this.turns++
      this.ctx.addScore(1)
      this.ctx.audio.play('score', 0.5)
      const c0 = this.cards[i0]
      const c1 = this.cards[i1]
      c0.gone = true
      c1.gone = true
      c0.goneT = 0
      c1.goneT = 0
      this.upFaces = []
      if (this.cards.every((cd) => cd.gone)) {
        this.phase = 'clear'
        this.phaseAt = this.t
        this.ctx.audio.play('win', 0.6)
        this.say('全部找到啦！', this.W / 2, this.H * 0.3, '#6bcb77', 40)
        this.particles.burst(this.W / 2, this.H * 0.4, '#ffd54a', 30, 420, 5)
      } else {
        this.phase = 'play'
        this.phaseAt = this.t
        if (this.streak >= 2) this.say(`连对 ${this.streak}！`, this.W / 2, this.H * 0.16, '#ffd54a', 30)
      }
    } else {
      this.streak = 0
      this.turns++
      this.ctx.audio.play('miss', 0.5)
      for (const i of this.upFaces) {
        this.cards[i].up = false
        this.cards[i].blocked = true
        this.cards[i].shake = 0.4
      }
      this.upFaces = []
      if (this.seats > 1) {
        this.forceSwitch()
      } else {
        this.phase = 'play'
        this.phaseAt = this.t
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      // 当前玩家区域
      const z = this.zoneOf(this.turn)
      c.strokeStyle = this.players[this.turn].color
      c.globalAlpha = 0.75
      c.setLineDash([12, 10])
      c.strokeRect(z.x0 + 6, 6, z.x1 - z.x0 - 12, this.H - 12)
      c.setLineDash([])
      c.globalAlpha = 1
    }
    const body = this.lastF?.bodies[this.boardP] ?? null
    for (const cd of this.cards) {
      if (cd.appear < 0) continue
      const pos = this.cardPos(cd, body, this.boardP)
      const pop = clamp(cd.appear / 0.35, 0, 1)
      const scaleX = Math.abs(Math.cos(cd.flip * Math.PI)) || 0.05
      if (cd.gone) {
        // 消散：虚线空槽
        c.globalAlpha = 0.5
        c.strokeStyle = '#ffffff88'
        c.setLineDash([8, 8])
        c.strokeRect(pos.x - pos.w / 2, pos.y - pos.h / 2, pos.w, pos.h)
        c.setLineDash([])
        c.globalAlpha = 1
        continue
      }
      c.save()
      c.translate(pos.x, pos.y)
      if (cd.shake > 0) c.translate(Math.sin(this.t * 36) * 4, 0)
      const dwellScale = 1 + (cd.dwell / this.dwell) * 0.08
      c.scale(Math.max(0.05, scaleX) * dwellScale, pop * dwellScale)
      const faceUp = cd.up || this.phase === 'peek'
      if (faceUp) {
        c.fillStyle = '#fffdf3'
        c.fillRect(-pos.w / 2, -pos.h / 2, pos.w, pos.h)
        txt(c, FACES[cd.face], 0, 0, pos.s * 0.4, '#26152c')
        if (this.phase === 'review') {
          c.strokeStyle = this.matchOk ? '#6bcb77' : '#ff5d5d'
          c.lineWidth = 4
          c.strokeRect(-pos.w / 2, -pos.h / 2, pos.w, pos.h)
        }
      } else {
        c.fillStyle = cd.blocked ? '#3a4470' : '#4a5aa8'
        c.fillRect(-pos.w / 2, -pos.h / 2, pos.w, pos.h)
        circle(c, 0, 0, pos.s * 0.12, 'rgba(255,255,255,.4)')
        // dwell 进度（虚线沿周长生长）
        if (cd.dwell > 0.05) {
          c.strokeStyle = this.players[this.turn].color
          c.lineWidth = 4
          c.setLineDash([(cd.dwell / this.dwell) * pos.w * 2, 99])
          c.strokeRect(-pos.w / 2, -pos.h / 2, pos.w, pos.h)
          c.setLineDash([])
        }
      }
      c.restore()
    }
    // 相位提示
    if (this.phase === 'peek') {
      const left = Math.max(0, this.peek - (this.t - this.phaseAt))
      txt(c, '👀 记住它们！', this.W / 2, this.H - 44, 22, '#ffd54a', 'center', 'bold')
      c.fillStyle = 'rgba(255,255,255,.3)'
      c.fillRect(this.W / 2 - 75, this.H - 28, 150, 7)
      c.fillStyle = '#ffd54a'
      c.fillRect(this.W / 2 - 75, this.H - 28, 150 * (left / this.peek), 7)
    }
  }
}

export default function create(ctx: GameContext) {
  return new MemoryFlip(ctx)
}
