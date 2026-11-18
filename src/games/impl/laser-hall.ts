import { BaseGame, updateSeats } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, txt } from '@/core/draw'

/**
 * 激光走廊（对齐 dongdongpark 真实规则）：
 * 红色激光一道道扫来，横在上方要蹲、横在下方要跳、竖线侧身让开、斜线歪身躲过；5 颗心用完出局。
 *
 * 关键设计（站点原样保留）：激光瞄准的是「你站直时的锚点」——蹲下/歪身时代锚点几乎冻结
 * （0.15/s），只有回到中立站姿才快速跟随（2.5/s），所以躲动作不会把下一条激光"吸"到自己身上。
 *
 * 判定混用两套：high/low 用骨骼高度阈值（宽容、抗抖动），vert/diag 用几何距离（必须真的让开）。
 * 与站点的差异：站点读 motion.squat（连续量），本框架只有布尔 squat，故 squat=true 直接判躲过。
 */
type Kind = 'high' | 'low' | 'vert' | 'diag'

/** 对齐站点难度表：period 开局→末段线性收敛（秒）/ approach 预警时长（秒）/ 类型池 */
const DIFF = [
  { period: [2.6, 1.7], approach: 2.4, pool: ['high', 'low', 'vert'] as Kind[] },
  { period: [2.2, 1.3], approach: 2.0, pool: ['high', 'low', 'vert', 'diag'] as Kind[] },
  { period: [1.8, 1.0], approach: 1.6, pool: ['high', 'low', 'vert', 'diag', 'diag'] as Kind[] },
]

const HEARTS = 5 // 初始/上限心数
const MARGIN = 0.08 // 判定余量 = 0.08 × T
const DIAG_TAN = Math.tan((40 * Math.PI) / 180) // 斜线 40°
const FADE = 0.45 // 结算后残留淡出（秒）
const INVULN = 1 // 受击无敌（秒）
const LOW_GRACE = 0.5 // low 的跳跃宽限（秒）

const KIND_COLOR: Record<Kind, string> = {
  high: '#ff4d6d',
  low: '#ff7b3d',
  vert: '#ff4d9d',
  diag: '#ff2d55',
}
const KIND_HINT: Record<Kind, string> = { high: '蹲下', low: '跳起来', vert: '侧身让', diag: '歪一歪' }

interface Anchor {
  x: number
  headTop: number
  shoulderY: number
  ankleY: number
  T: number
}

interface PlayerState {
  anchor: Anchor
  hearts: number
  alive: boolean
  invuln: number
  streak: number
  maxStreak: number
  dodged: number
  hits: number
  jumpAt: number
  /** 上一帧的躯干中心 x（算横向速度用，判断锚点该不该跟） */
  prevX: number
  zone: { x0: number; x1: number }
}

interface Line {
  owner: number
  kind: Kind
  side: number
  born: number
  life: number
  state: 'warn' | 'pass' | 'hit'
  resolvedAt: number
  /** 几何：high/low 用 y；vert 用 x；diag 用 (ax, y, slope) */
  y: number
  x: number
  ax: number
  slope: number
}

class LaserHall extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  lines: Line[] = []
  states: PlayerState[] = []
  nextAt = 1.2
  count = 0
  lastKind: Kind = 'high'
  /** 曾经出现在画面里的席位（用于「全员出局」判定，避免空席位或走开的人卡住收局） */
  private seatActive = [false, false]

  /** 每个席位最后一次检测到人的时刻（配合 updateSeats 判断离场） */

  private seatSeen = [-9, -9]
  private wasJumping = [false, false]

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      const zone = { x0: i === 0 ? 0 : this.W / 2, x1: i === 0 ? this.W / 2 : this.W }
      this.states.push({
        anchor: { x: (zone.x0 + zone.x1) / 2, headTop: this.H * 0.22, shoulderY: this.H * 0.42, ankleY: this.H * 0.95, T: Math.max(90, this.H * 0.2) },
        hearts: HEARTS,
        alive: true,
        invuln: 0,
        streak: 0,
        maxStreak: 0,
        dodged: 0,
        hits: 0,
        jumpAt: -9,
        prevX: (zone.x0 + zone.x1) / 2,
        zone,
      })
    }
  }

  tick(f: PoseFrame, dt: number) {
    // 只有「曾经出现在画面里」的席位才参与存活统计：
    // 单人局空着的 2 号席位、以及中途走出画面的玩家，都不该算作「全员出局」的依据。
    updateSeats(this.seatActive, this.seatSeen, f.bodies, this.t)
    const living = this.states.filter((s, i) => s.alive && this.seatActive[i]).length
    if (this.seatActive.some(Boolean) && living === 0) {
      this.ctx.finish()
      return
    }

    // 锚点 + 跳跃边沿
    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      const b = f.bodies[i] ?? null
      if (st.invuln > 0) st.invuln -= dt
      if (!b) continue
      if (b.jumping && !this.wasJumping[i]) st.jumpAt = this.t
      this.wasJumping[i] = b.jumping
      if (st.alive) this.updateAnchor(st, b, dt)
    }

    // 生成
    if (this.t >= this.nextAt) {
      const [p0, p1] = this.cfg.period
      const gap = p0 + (p1 - p0) * Math.min(1, this.t / (this.ctx.meta.duration || 60))
      this.nextAt = this.t + gap
      this.spawnAll()
    }

    // 结算
    for (const ln of this.lines) {
      if (ln.state !== 'warn') continue
      if (this.t < ln.born + ln.life) continue
      const st = this.states[ln.owner]
      if (!st.alive) {
        ln.state = 'pass'
        ln.resolvedAt = this.t
        continue
      }
      const b = f.bodies[ln.owner] ?? null
      const pass = this.judge(ln, b, st)
      ln.state = pass ? 'pass' : 'hit'
      ln.resolvedAt = this.t
      this.settle(ln, st, b, pass)
    }
    this.lines = this.lines.filter((l) => this.t - l.resolvedAt < FADE || l.state === 'warn')
  }

  /** 锚点：中立站姿 / 身体不怎么横移时快速跟随（2.5 / 1.5 每秒），动作中几乎冻结（0.15 / 0.1） */
  private updateAnchor(st: PlayerState, b: Body, dt: number) {
    const T = Math.max(60, b.scale * this.H * 1.1)
    const cur = {
      x: b.center.x * this.W,
      headTop: b.head.y * this.H,
      shoulderY: b.shoulderC.y * this.H,
      ankleY: Math.max(b.lFoot.y, b.rFoot.y) * this.H,
      T,
    }
    const lean = Math.abs(((b.rShoulder.y - b.lShoulder.y) * this.H) / T)
    const neutral = !b.squat && !b.jumping && lean < 0.35 && cur.headTop > st.anchor.headTop - 0.12 * T
    const rate = neutral ? 2.5 : 0.15
    // 站点这里的 shift 是「这一帧横向移动了多少」，不是「离锚点多远」：
    // 按距离判断会在玩家站偏时让跟随速率永远掉到 0.1/s，锚点追不上人。
    const vx = Math.abs(cur.x - st.prevX) / Math.max(dt, 1e-3)
    st.prevX = cur.x
    const k = Math.min(1, rate * dt)
    const kx = Math.min(1, (vx < 0.3 * T ? 1.5 : 0.1) * dt)
    st.anchor.x += (cur.x - st.anchor.x) * kx
    st.anchor.headTop += (cur.headTop - st.anchor.headTop) * k
    st.anchor.shoulderY += (cur.shoulderY - st.anchor.shoulderY) * k
    st.anchor.ankleY += (cur.ankleY - st.anchor.ankleY) * k
    st.anchor.T += (cur.T - st.anchor.T) * k
  }

  private spawnAll() {
    let kind = this.lastKind
    if (this.count === 0) kind = 'high' // 教学：第 1 道必 high
    else if (this.count === 1) kind = 'vert' // 第 2 道必 vert
    else {
      const pool = this.cfg.pool.filter((k) => k !== this.lastKind)
      kind = pool[Math.floor(Math.random() * pool.length)] ?? 'high'
    }
    this.lastKind = kind
    const side = Math.random() < 0.5 ? -1 : 1
    this.count++

    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!st.alive || !this.player(i).body) continue
      const a = st.anchor
      const ln: Line = {
        owner: i,
        kind,
        side,
        born: this.t,
        life: this.cfg.approach,
        state: 'warn',
        resolvedAt: 0,
        y: 0,
        x: 0,
        ax: a.x,
        slope: 0,
      }
      if (kind === 'high') ln.y = a.headTop + 0.25 * a.T
      else if (kind === 'low') ln.y = a.ankleY - 0.12 * a.T
      else if (kind === 'vert') {
        ln.x = Math.max(st.zone.x0 + 0.3 * a.T, Math.min(st.zone.x1 - 0.3 * a.T, a.x - side * 0.25 * a.T))
      } else {
        ln.y = a.headTop
        ln.slope = -DIAG_TAN * side
      }
      this.lines.push(ln)
    }
    this.ctx.audio.play('drop', 0.5, 1.4)
    if (this.count <= 4 || this.count % 5 === 0) this.ctx.speak(KIND_HINT[kind])
  }

  /** true = 躲过 */
  private judge(ln: Line, b: Body | null, st: PlayerState): boolean {
    if (!b) return true
    const T = st.anchor.T
    const X = (p: { x: number }) => p.x * this.W
    const Y = (p: { y: number }) => p.y * this.H
    if (ln.kind === 'high') {
      const headR = Math.max(14, b.scale * this.H * 0.055)
      return b.squat || Y(b.head) - headR > ln.y + 0.04 * T
    }
    if (ln.kind === 'low') {
      if (this.t - st.jumpAt < LOW_GRACE) return true
      return [Y(b.lFoot), Y(b.rFoot)].every((y) => y < ln.y - 0.04 * T)
    }
    if (ln.kind === 'vert') {
      const xs = [b.head, b.shoulderC, b.hipC, b.lKnee, b.rKnee, b.lFoot, b.rFoot, b.lHand, b.rHand].map(X)
      const pad = 0.06 * T
      return ln.x < Math.min(...xs) - pad || ln.x > Math.max(...xs) + pad
    }
    // diag：站在锚点上时线正好过头部；歪身让头/髋离开线 0.13T 以上
    const yAt = (x: number) => ln.y + (x - ln.ax) * ln.slope
    const near = [b.head, b.shoulderC, b.hipC].some((p) => Math.abs(Y(p) - yAt(X(p))) < (MARGIN + 0.05) * T)
    return !near
  }

  private settle(ln: Line, st: PlayerState, b: Body | null, pass: boolean) {
    const x = ln.kind === 'vert' ? ln.x : b ? b.center.x * this.W : st.anchor.x
    const y = ln.kind === 'vert' ? st.anchor.shoulderY : ln.y
    if (pass) {
      if (!b) return // 没检测到人不计分
      st.dodged++
      st.streak++
      st.maxStreak = Math.max(st.maxStreak, st.streak)
      this.ctx.addScore(1)
      this.ctx.setCombo(st.streak)
      this.ctx.audio.play('pop', 0.45, 1.5)
      this.particles.burst(x, y, '#3ddc97', 6, 220, 4)
      if (st.streak % 6 === 0) {
        if (st.hearts < HEARTS) {
          st.hearts++
          this.say('补一颗心 ❤', x, y - 50, '#ff8fa8', 34)
          this.ctx.audio.coin()
        }
        this.say(`连躲 ${st.streak} 道！`, this.W / 2, 150, '#3ddc97', 44)
        this.ctx.speak('连躲六道，补一颗心')
      }
      this.ctx.setExtra('dodged', st.dodged)
      this.ctx.setExtra('streak', st.maxStreak)
    } else {
      st.streak = 0
      this.ctx.setCombo(0)
      if (st.invuln > 0) return
      st.hits++
      st.hearts--
      st.invuln = INVULN
      this.ctx.audio.fail()
      this.particles.burst(x, y, '#ff4d6d', 10, 300, 5)
      this.say(st.hearts > 0 ? '哎哟！' : '没心了！', x, y - 40, '#ff6b8a', 42)
      this.ctx.setExtra('hits', st.hits)
      if (st.hearts <= 0) {
        st.alive = false
        this.ctx.setStage('出局')
        this.ctx.speak('被激光抓住啦')
      }
    }
  }

  paint(c: CanvasRenderingContext2D) {
    // 双人时中间加一道分隔
    if (this.players.filter((p) => p.body).length > 1) {
      c.fillStyle = 'rgba(255,255,255,.12)'
      c.fillRect(this.W / 2 - 1, 0, 2, this.H)
    }

    for (const ln of this.lines) {
      const st = this.states[ln.owner]
      const zone = st.zone
      const p = Math.min(1, (this.t - ln.born) / ln.life)
      const resolved = ln.state !== 'warn'
      const fade = resolved ? Math.max(0, 1 - (this.t - ln.resolvedAt) / FADE) : 1
      if (fade <= 0) continue
      const color = ln.state === 'pass' ? '#3ddc97' : ln.state === 'hit' ? '#ff4d6d' : KIND_COLOR[ln.kind]
      c.save()
      c.globalAlpha = resolved ? fade : 0.3 + 0.5 * p
      c.strokeStyle = color
      c.lineWidth = resolved ? 12 : 3
      if (!resolved) c.setLineDash([14, 12])
      c.lineDashOffset = -this.t * 40
      c.shadowColor = color
      c.shadowBlur = 14
      c.beginPath()
      if (ln.kind === 'vert') {
        c.moveTo(ln.x, 0)
        c.lineTo(ln.x, this.H)
      } else if (ln.kind === 'diag') {
        const y0 = ln.y + (zone.x0 - ln.ax) * ln.slope
        const y1 = ln.y + (zone.x1 - ln.ax) * ln.slope
        c.moveTo(zone.x0, y0)
        c.lineTo(zone.x1, y1)
      } else {
        c.moveTo(zone.x0, ln.y)
        c.lineTo(zone.x1, ln.y)
      }
      c.stroke()
      c.restore()
      if (!resolved) {
        // 预警端点 + 提示字
        const px = ln.kind === 'vert' ? ln.x : (zone.x0 + zone.x1) / 2
        const py = ln.kind === 'vert' ? this.H * 0.18 : ln.kind === 'diag' ? ln.y + (px - ln.ax) * ln.slope : ln.y
        c.save()
        c.globalAlpha = 0.5 + 0.5 * p
        c.fillStyle = color
        c.beginPath()
        c.arc(px, py, 8 + 10 * p, 0, Math.PI * 2)
        c.fill()
        outlineTxt(c, KIND_HINT[ln.kind], px, py - 34, 24 + 14 * p, '#fff')
        c.restore()
      }
    }

    // 心数
    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!this.player(i).body) continue
      const x0 = st.zone.x0 + 30
      for (let h = 0; h < HEARTS; h++) {
        const alive = h < st.hearts
        c.globalAlpha = alive ? 1 : 0.22
        txt(c, '❤', x0 + h * 34, 44, 26, alive ? '#ff6b8a' : '#ffffff', 'left', 'bold')
        c.globalAlpha = 1
      }
      if (!st.alive) txt(c, '出局', x0 + HEARTS * 34 + 14, 44, 24, '#ff8fa8', 'left', 'bold')
      if (st.invuln > 0 && Math.floor(this.t * 12) % 2 === 0) {
        c.fillStyle = 'rgba(255,80,110,.16)'
        c.fillRect(st.zone.x0, 0, st.zone.x1 - st.zone.x0, this.H)
      }
    }

    // 出局遮罩
    if (!this.states.some((s) => s.alive)) {
      c.fillStyle = 'rgba(8,12,32,.35)'
      c.fillRect(0, 0, this.W, this.H)
      outlineTxt(c, '被激光抓住啦！', this.W / 2, this.H / 2 - 20, 56)
    }
  }
}

export default function create(ctx: GameContext) {
  return new LaserHall(ctx)
}
