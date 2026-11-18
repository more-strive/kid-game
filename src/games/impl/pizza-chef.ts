import { BaseGame, updateSeats } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, rr, txt } from '@/core/draw'

/**
 * 小厨师做披萨 / pizza-chef（对齐 dongdongpark 真实规则）：
 * 三步订单制：①双手在面团上「上挥蓄力→快速下拍」揉面（vy −0.35/+0.9 躯干每秒，0.22s 冷却）；
 * ②手悬到碗上吸附拿配料（碗距 < 0.31T + 0.35 手半径），悬到披萨上 0.3s 或快速下压（vy ≥ 0.7T/s）放下，
 * 按订单数量判定对错（放错闪 X 飞回碗）；③配料齐了双手举过头顶 0.25s → 披萨飞进烤箱 +1 分，下一单。
 * 工作站整体锚定肩部平滑跟随（2.5/s）。
 *
 * 全部字面量沿用站点：揉面拍数 3/4/4、配料总片 2/3/4、碗数 2/4/4、必放种类 [1,2]/[2,2]/[2,3]、
 * 洋葱陷阱仅 hard（50% 概率）、提示 arrow/glow/none、intro 0.9s、fly 1s、烤箱余焰 1.6s、
 * 放料停留 0.3s、坏件闪 X 0.55s/回碗 0.45s、拍面冷却 0.22s、举手自算 0.25s（双手高于头 −0.1T）、
 * 披萨基准半径 0.5T、碗 0.62T、手持料 0.44T、烤箱 1.1T、提醒循环 knead 6s/top 9s/bake 6s、
 * 拍面命中椭圆 (1.35R, 0.6T) 中心 肩上 −0.15T、放料椭圆 dx/1.1R 上半 dy/0.95R 下半 0.55R、
 * 揉面完成 sparkle、放对 coin 音高 +0.12 递增、配料齐 tada、fly 结束 thud+彩带+夸奖横幅。
 *
 * 与站点的差异（写明待实测）：
 * 1) hand.vel.y 黑盒 → 本框架掌心 y 帧间差分 ÷ 躯干长（平滑 0.1s），阈值照抄需真机校准；
 * 2) 站点 7 种配料精灵 → 文字/颜色几何碗（番茄🍅/蘑菇🍄/青椒🫑/香肠🌭/玉米🌽/菠萝🍍/虾仁🍤）；
 * 3) 站点 events.has('handsUp') → 双手掌心高于头 −0.1T 持续 0.25s 自算（站点也有此兜底）；
 * 4) 双人共享一个分数（仓库口径，站点各自 +1）；订单用 mulberry32(1) 同串（站点 rng(1) 同款）；
 * 5) ai() 演示替身未实装。
 */
type Topping = 0 | 1 | 2 | 3 | 4 | 5 | 6
const TOP_EMOJI = ['🍅', '🍄', '🫑', '🌭', '🌽', '🍍', '🍤']
const TOP_COL = ['#ff6b6b', '#d8b27a', '#6bcb77', '#c05a5a', '#ffd54a', '#ffe07a', '#ff9f8a']

/** 站点三档：揉面拍数 / 配料片数 / 碗数 / 必放种类 / 洋葱陷阱 / 提示档 */
const DIFF = [
  { pats: 3, pieces: 2, bowls: 2, kinds: [1, 2] as [number, number], onion: false, hint: 'arrow' },
  { pats: 4, pieces: 3, bowls: 4, kinds: [2, 2] as [number, number], onion: false, hint: 'glow' },
  { pats: 4, pieces: 4, bowls: 4, kinds: [2, 3] as [number, number], onion: true, hint: 'none' },
]

const INTRO_T = 0.9
const FLY_T = 1
const OVEN_GLOW = 1.6
const PLACE_DWELL = 0.3
const BAD_FLASH = 0.55
const PAT_COOL = 0.22
const UP_T = 0.25
const ARM_VY = -0.35
const PAT_VY = 0.9
const SLAP_VY = 0.7
const KNEAD_NAG = 6
const TOP_NAG = 9
const BAKE_NAG = 6
const DUR = 90

type Step = 'intro' | 'knead' | 'top' | 'bake' | 'fly'

interface Bowl {
  kind: Topping
  x: number // 相对锚点（×T）
  y: number
  onion: boolean
}

interface Placed {
  x: number
  y: number
  kind: Topping
  bad: boolean
  badT: number
  slot: number
}

interface Chef {
  anchor: { x: number; y: number }
  T: number
  step: Step
  stepAt: number
  pats: number
  armed: [boolean, boolean]
  patCool: number
  patFlip: boolean
  hold: [Topping | null, Topping | null]
  dwell: [number, number]
  placed: Placed[]
  need: Topping[]
  bowls: Bowl[]
  flyT: number
  made: number
  good: number
  bad: number
  upT: number
  nagAt: number
  orderN: number
  vyL: number
  vyR: number
  prevLy: number
  prevRy: number
  zone: { x0: number; x1: number }
}

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

const PRAISE = ['做好啦！', '真香！', '又做好一张！', '好厉害！']

class PizzaChef extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  chefs: Chef[] = []
  seats = 1
  private seatActive = [false, false]
  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */
  private seatSeen = [-9, -9]
  private ovenGlow = 0
  private U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      const rng = mulberry32(1)
      this.chefs.push({
        anchor: { x: this.W / 2, y: this.H * 0.5 }, T: 160,
        step: 'intro', stepAt: 0, pats: 0,
        armed: [true, true], patCool: 0, patFlip: false,
        hold: [null, null], dwell: [0, 0], placed: [], need: [], bowls: [],
        flyT: 0, made: 0, good: 0, bad: 0, upT: 0, nagAt: 0, orderN: 0,
        vyL: 0, vyR: 0, prevLy: 0.5, prevRy: 0.5,
        zone: { x0: 0, x1: this.W },
      })
      void rng
    }
    this.layout()
    for (const ch of this.chefs) this.newOrder(ch)
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      this.chefs[i].zone = duo
        ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 }
        : { x0: 0, x1: this.W }
    }
  }

  /** 新订单：洗牌取必放种类 + 额外份数（rng 种子 1，双人同串——站点同款） */
  private newOrder(ch: Chef) {
    const rng = mulberry32(1)
    for (let k = 0; k <= ch.orderN; k++) {
      // 空转 rng 流到第 orderN 次（保证双人/多单同串）
      for (let j = 0; j < 6; j++) rng()
    }
    const nKinds = this.cfg.kinds[Math.floor(rng() * this.cfg.kinds.length)]
    const pool = [0, 1, 2, 3, 4, 5, 6]
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    const must = pool.slice(0, nKinds) as Topping[]
    const extra = this.cfg.pieces - nKinds
    const need: Topping[] = [...must]
    for (let k = 0; k < extra; k++) need.push(must[Math.floor(rng() * must.length)])
    ch.need = need
    // 碗：必放种类在前，其余干扰；hard 50% 末位干扰换洋葱
    const others = pool.slice(nKinds)
    const bowls: Bowl[] = []
    const n = this.cfg.bowls
    const onionHere = this.cfg.onion && rng() < 0.5
    for (let i = 0; i < n; i++) {
      const kind = (i < must.length ? must[i] : ((others[i - must.length] ?? others[0]) as Topping)) as Topping
      const isOnion = onionHere && i === n - 1
      const px = n === 2 ? (i === 0 ? -1 : 1) : i < 2 ? (i === 0 ? -0.95 : 0.95) : (i === 2 ? -1.02 : 1.02)
      const py = n === 2 ? 0.25 : i < 2 ? -0.2 : 0.6
      bowls.push({ kind: isOnion ? 6 : kind, x: px, y: py, onion: isOnion && kind !== 6 })
      void isOnion
    }
    // 洋葱替换：hard 时把最后一个非必放碗直接换成洋葱碗
    if (onionHere) {
      for (const b of bowls) {
        if (!must.includes(b.kind as Topping) && b.kind !== 6) {
          b.onion = true
          break
        }
      }
    }
    ch.bowls = bowls
    ch.step = 'intro'
    ch.stepAt = this.t
    ch.pats = 0
    ch.placed = []
    ch.hold = [null, null]
    ch.dwell = [0, 0]
    ch.orderN++
    this.ctx.audio.play('pop', 0.4, 1.1)
  }

  /** 工作站布局换算 */
  private layoutOf(ch: Chef) {
    const T = ch.T
    const pz = { x: ch.anchor.x, y: clamp(ch.anchor.y + 0.8 * T, 0, this.H - 0.45 * T) }
    const ticket = { x: ch.anchor.x - (this.seats > 1 ? (ch.zone.x0 < this.W / 2 ? -1 : 1) * 1.95 * T : 2 * T), y: ch.anchor.y - 0.45 * T }
    const oven = { x: ch.anchor.x + (this.seats > 1 ? (ch.zone.x0 < this.W / 2 ? -1 : 1) * 1.95 * T : 2 * T), y: ch.anchor.y - 0.35 * T }
    return { pz, ticket, oven, T }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) this.seats = 2
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    if (this.ovenGlow > 0) this.ovenGlow -= dt
    const duo = this.seats > 1
    for (let i = 0; i < (duo ? 2 : 1); i++) {
      if (!this.seatActive[i]) continue
      this.step(this.chefs[i], f.bodies[i] ?? null, dt)
    }
    if (this.t >= DUR) this.ctx.finish()
  }

  private step(ch: Chef, b: Body | null, dt: number) {
    const now = this.t
    // 锚点平滑
    if (b) {
      const k = 1 - Math.exp(-dt * 2.5)
      ch.anchor.x += (b.shoulderC.x * this.W - ch.anchor.x) * k
      ch.anchor.y += (b.shoulderC.y * this.H - ch.anchor.y) * k
      ch.T = clamp(b.scale * this.H * 1.1, 80 * this.U, this.H * 0.3)
    }
    const { pz, T } = this.layoutOf(ch)
    const R = 0.5 * T

    // —— 拍面速度（腕点 y 帧间差分，0.1s 平滑）——
    let vyL = 0
    let vyR = 0
    if (b) {
      const ly = b.lHand.y * this.H
      const ry = b.rHand.y * this.H
      vyL = ((ly - ch.prevLy) / Math.max(dt, 1e-3)) / T
      vyR = ((ry - ch.prevRy) / Math.max(dt, 1e-3)) / T
      ch.vyL += (vyL - ch.vyL) * Math.min(1, dt / 0.1)
      ch.vyR += (vyR - ch.vyR) * Math.min(1, dt / 0.1)
      ch.prevLy = ly
      ch.prevRy = ry
    }

    switch (ch.step) {
      case 'intro':
        if (now - ch.stepAt >= INTRO_T) this.toStep(ch, 'knead')
        break
      case 'knead': {
        if (!b) break
        if (ch.patCool > 0) ch.patCool -= dt
        const inDough = (px: number, py: number) =>
          ((px - pz.x) / (1.35 * R)) ** 2 + ((py - (pz.y - 0.15 * T)) / (0.6 * T)) ** 2 < 1
        const tryPat = (px: number, py: number, vy: number, armed: boolean): boolean => {
          if (vy < ARM_VY) return true // 上挥蓄力
          if (armed && vy > PAT_VY && ch.patCool <= 0 && inDough(px, py)) {
            ch.pats++
            ch.patCool = PAT_COOL
            this.ctx.audio.play('pop', 0.3, 0.85 + ch.pats * 0.12)
            this.particles.burst(px, py, '#f6d38f', 5, 140, 3)
            return false
          }
          return armed
        }
        const detL = b.lHandDet
        const detR = b.rHandDet
        const palms = detL && detR ? [detL.palm, detR.palm] : [b.lHand, b.rHand].map((p) => ({ x: p.x * this.W, y: p.y * this.H }))
        ch.armed[0] = tryPat(palms[0].x * this.W, palms[0].y * this.H, ch.vyL, ch.armed[0])
        ch.armed[1] = tryPat(palms[1].x * this.W, palms[1].y * this.H, ch.vyR, ch.armed[1])
        if (ch.pats >= this.cfg.pats) {
          this.ctx.audio.play('combo', 0.5)
          this.toStep(ch, 'top')
        } else if (now - ch.stepAt > KNEAD_NAG && now - ch.nagAt > KNEAD_NAG + 8) {
          ch.nagAt = now
          this.say('双手在面团上，上下拍一拍', this.W / 2, this.H * 0.14, '#4cc9f0', 24)
        }
        break
      }
      case 'top': {
        if (!b) break
        const handR = T * 0.28
        const detR = b.rHandDet
        const palms = b.lHandDet && detR
          ? [b.lHandDet.palm, detR.palm]
          : [b.lHand, b.rHand].map((p) => ({ x: p.x * this.W, y: p.y * this.H }))
        for (let h = 0; h < 2; h++) {
          const px = palms[h].x * this.W
          const py = palms[h].y * this.H
          if (ch.hold[h] === null) {
            // 拿料：悬停吸附
            for (const bw of ch.bowls) {
              const bx = ch.anchor.x + bw.x * T
              const by = ch.anchor.y + bw.y * T
              if (Math.hypot(px - bx, py - by) < 0.31 * T + 0.35 * handR) {
                ch.hold[h] = bw.kind as Topping
                this.ctx.audio.play('pop', 0.4)
                break
              }
            }
          } else {
            // 放料：披萨椭圆内 dwell 或下压
            const dx = (px - pz.x) / (1.1 * R)
            const dy = py < pz.y ? (py - pz.y) / (0.95 * R) : (py - pz.y) / (0.55 * R)
            const inPizza = dx * dx + dy * dy < 1
            if (inPizza) {
              ch.dwell[h] += dt
              const vy = h === 0 ? ch.vyL : ch.vyR
              if (ch.dwell[h] >= PLACE_DWELL || vy >= SLAP_VY) {
                this.placeTopping(ch, px, py, ch.hold[h]!)
                ch.hold[h] = null
                ch.dwell[h] = 0
              }
            } else {
              ch.dwell[h] = 0
            }
            // 防抢跑：此步举手提示
            if (py < b.head.y * this.H - 0.1 * T) {
              if (now - ch.nagAt > 0.8) {
                ch.nagAt = now
                this.say('还差配料哦', this.W / 2, this.H * 0.14, '#ff9f43', 22)
              }
            }
          }
        }
        // 全部填满 → bake
        const filled = ch.placed.filter((p2) => !p2.bad).length
        if (filled >= ch.need.length) {
          this.ctx.audio.play('combo', 0.6)
          this.toStep(ch, 'bake')
        } else if (now - ch.stepAt > TOP_NAG && now - ch.nagAt > TOP_NAG + 9) {
          ch.nagAt = now
          const listing = ch.need.map((t) => TOP_EMOJI[t]).join(' ')
          this.say(`要 ${listing}`, this.W / 2, this.H * 0.14, '#ffd54a', 24)
        }
        break
      }
      case 'bake': {
        // 举手：双手高于头 −0.1T 持续 0.25s（自算，站点另有框架事件兜底）
        if (!b) break
        const upLine = b.head.y * this.H - 0.1 * ch.T
        const bothUp = b.lHand.y * this.H < upLine && b.rHand.y * this.H < upLine
        ch.upT = bothUp ? ch.upT + dt : 0
        if (ch.upT >= UP_T) {
          ch.step = 'fly'
          ch.stepAt = now
          ch.flyT = 0
          this.ctx.audio.play('click', 0.5, 0.7)
        } else if (now - ch.stepAt > BAKE_NAG && now - ch.nagAt > BAKE_NAG + 6) {
          ch.nagAt = now
          this.say('双手举高高！', this.W / 2, this.H * 0.14, '#ffd54a', 24)
        }
        break
      }
      case 'fly': {
        ch.flyT += dt
        if (ch.flyT >= FLY_T) {
          ch.made++
          this.ctx.addScore(1)
          this.ovenGlow = OVEN_GLOW
          this.ctx.audio.play('win', 0.5)
          this.say(PRAISE[ch.made % PRAISE.length], this.W / 2, this.H * 0.2, '#6bcb77', 34)
          this.particles.burst(ch.anchor.x, ch.anchor.y - ch.T, '#ffd54a', 22, 380, 5)
          this.newOrder(ch)
        }
        break
      }
    }
  }

  private toStep(ch: Chef, s: Exclude<Step, 'fly'>) {
    ch.step = s
    ch.stepAt = this.t
    ch.nagAt = this.t
    if (s === 'knead') {
      ch.armed = [true, true]
      this.say(ch.orderN === 1 ? '双手拍拍面团！' : '拍拍面团！', this.W / 2, this.H * 0.14, '#4cc9f0', 24)
    } else if (s === 'top') {
      this.say('去碗里拿配料，放到披萨上', this.W / 2, this.H * 0.14, '#ffd54a', 24)
    } else if (s === 'bake') {
      this.say('双手举高高，送进烤箱！', this.W / 2, this.H * 0.14, '#ff9f43', 24)
    }
  }

  private placeTopping(ch: Chef, px: number, py: number, kind: Topping) {
    const usedSlots = new Set(ch.placed.filter((p2) => !p2.bad).map((p2) => p2.slot))
    const slot = ch.need.findIndex((t, i) => t === kind && !usedSlots.has(i))
    const useSlot = slot
    const isOnion = kind === 6 && ch.bowls.some((bw) => bw.kind === 6 && bw.onion)
    if (useSlot >= 0 && !isOnion) {
      const ang = (ch.placed.length / Math.max(1, ch.need.length)) * Math.PI * 2
      ch.placed.push({ x: Math.cos(ang) * 0.28, y: Math.sin(ang) * 0.2, kind, bad: false, badT: 0, slot: useSlot })
      ch.good++
      this.ctx.audio.play('score', 0.35, 1 + ch.good * 0.12)
    } else {
      ch.bad++
      ch.placed.push({ x: 0, y: 0, kind, bad: true, badT: this.t, slot: -1 })
      this.ctx.audio.play('miss', 0.5)
      if (isOnion) this.say('说了不要洋葱哦！', this.W / 2, this.H * 0.18, '#ff5d5d', 28)
    }
    void px
    void py
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    const n = duo ? 2 : 1
    for (let pi = 0; pi < n; pi++) {
      const ch = this.chefs[pi]
      const z: { x0: number; x1: number } = { x0: (pi * this.W) / n, x1: ((pi + 1) * this.W) / n }
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()
      const { pz, ticket, oven, T } = this.layoutOf(ch)
      const R = 0.5 * T
      // 蛋糕台（案板）
      c.fillStyle = '#c98850'
      circle(c, pz.x, pz.y + 6 * this.U, R * 1.25, '#c98850')
      // 面团 / 披萨
      if (ch.step === 'intro' || ch.step === 'knead') {
        const prog = ch.step === 'knead' ? clamp(ch.pats / this.cfg.pats, 0, 1) : 0
        circle(c, pz.x, pz.y - 0.15 * T, R * (0.7 + 0.3 * prog), '#f6d38f')
        txt(c, '🥟', pz.x, pz.y - 0.15 * T, R * 0.6, '#fff')
      } else {
        circle(c, pz.x, pz.y, R, '#e8b04b')
        c.fillStyle = '#f6d38f'
        circle(c, pz.x, pz.y, R * 0.85, '#f6d38f')
        for (const p2 of ch.placed) {
          if (p2.bad && this.t - p2.badT > BAD_FLASH) continue
          txt(c, TOP_EMOJI[p2.kind], pz.x + p2.x * R, pz.y + p2.y * R, 22 * this.U, '#fff')
          if (p2.bad) {
            c.strokeStyle = '#ff5d5d'
            c.lineWidth = 3
            c.beginPath()
            c.moveTo(pz.x + p2.x * R - 10, pz.y + p2.y * R - 10)
            c.lineTo(pz.x + p2.x * R + 10, pz.y + p2.y * R + 10)
            c.moveTo(pz.x + p2.x * R + 10, pz.y + p2.y * R - 10)
            c.lineTo(pz.x + p2.x * R - 10, pz.y + p2.y * R + 10)
            c.stroke()
          }
        }
      }
      // 碗
      for (const bw of ch.bowls) {
        const bx = ch.anchor.x + bw.x * T
        const by = ch.anchor.y + bw.y * T
        circle(c, bx, by, 0.31 * T, TOP_COL[bw.kind])
        txt(c, TOP_EMOJI[bw.kind], bx, by, 26 * this.U, '#fff')
        if (bw.onion) {
          c.strokeStyle = '#ff5d5d'
          c.lineWidth = 4
          c.beginPath()
          c.moveTo(bx - 16 * this.U, by - 16 * this.U)
          c.lineTo(bx + 16 * this.U, by + 16 * this.U)
          c.stroke()
        }
      }
      // 订单小票
      rr(c, ticket.x - 60 * this.U, ticket.y, 120 * this.U, 26 * this.U + ch.need.length * 24 * this.U, 8)
      c.fillStyle = '#fffdf3'
      c.fill()
      c.fillStyle = '#ff6b81'
      c.fillRect(ticket.x - 60 * this.U, ticket.y, 120 * this.U, 12 * this.U)
      ch.need.forEach((t, i) => {
        const done = ch.placed.filter((p2) => !p2.bad).length > i
        txt(c, `${TOP_EMOJI[t]}${done ? '✓' : ''}`, ticket.x, ticket.y + 34 * this.U + i * 24 * this.U, 18 * this.U, done ? '#6bcb77' : '#26152c')
      })
      // 烤箱
      const glow = this.ovenGlow > 0 || ch.step === 'bake'
      circle(c, oven.x, oven.y, 0.55 * T, glow ? 'rgba(255,180,80,.45)' : '#5a4632')
      circle(c, oven.x, oven.y, 0.34 * T, '#26152c')
      // 步骤条
      const stepNames = ['揉面', '放料', '进炉']
      const stepIdx = ch.step === 'intro' || ch.step === 'knead' ? 0 : ch.step === 'top' ? 1 : 2
      for (let k = 0; k < 3; k++) {
        const sx = pz.x + (k - 1) * 0.7 * T
        const sy = pz.y + 0.62 * T
        circle(c, sx, sy, 16 * this.U, k < stepIdx ? '#6bcb77' : k === stepIdx ? '#ffd54a' : 'rgba(255,255,255,.4)')
        txt(c, stepNames[k], sx, sy, 11 * this.U, '#26152c')
      }
      txt(c, `订单 ${ch.orderN} · 做好 ${ch.made}`, z.x0 + 16, 40, 18, this.players[pi].color, 'left', 'bold')
      c.restore()
    }
    if (duo) {
      c.fillStyle = '#fffdf3'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
  }
}

export default function create(ctx: GameContext) {
  return new PizzaChef(ctx)
}
