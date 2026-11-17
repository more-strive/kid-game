import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 攀岩 / climb（对齐 dongdongpark 真实规则）：
 * 岩壁向上滚动，手/脚放到岩点上停 0.3 秒就抓住；至少 3 个肢体抓着才能继续爬，
 * 不足 3 点支撑超过 slip 秒就滑落；酥点抓一会儿会碎；天降落石要缩头躲开。
 *
 * 全部字面量沿用站点难度表：crumble 酥点概率/存活、rockEvery 落石间隔（首块 6+rockEvery×0.5s、
 * 预警 0.9s）、slip 悬空宽限、up[] 新手点相对肩的高度区间、fall 掉落米数；
 * u=0.3 抓握停留、d=0.8（1 躯干=0.8 米）、单帧爬升上限 1 躯干/秒（≈1.25 米/秒）、
 * p=0.38 脱手阈值、脚点 5 秒首出、之后 7~11 秒一个、脚点首抓白送 1.5 米、
 * 岩点半径 max(26×unit, 0.2T)、落石半径 max(24×unit, 0.26T)、重力 1800×unit。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点双人各自计分，本框架共享一个分数（与 laser-hall 等已实装游戏同口径）；
 * 2) 手点「每侧肩上方 0.2T 内已有空闲点则不生成」照抄，但站点骨架的肢体半径黑盒，
 *    手取 0.12T、脚取 0.15T，命中=岩点半径+肢体半径×0.8；
 * 3) 脚的脱手站点只写了「岩点被删/肢体消失」，这里补了「脚偏离岩点 0.6T 也脱手」
 *    （脚会大幅摆动，不补会永远抓着）；
 * 4) 爬升量取「所有抓住的手的平均下压深度」，站点是 v/C 黑盒累计口径。
 */
type HoldKind = 'hand' | 'foot'

interface Hold {
  owner: number
  kind: HoldKind
  x: number
  y: number
  r: number
  crumble: boolean
  crumbleLeft: number
  grabbed: boolean
  by: number // 肢体序号 0=lHand 1=rHand 2=lFoot 3=rFoot，-1 空闲
  counted: boolean // 首次抓住已计入 grabs
  dwell: number
  dweller: number // 正在停留的肢体（换人重置停留）
  born: number
}

interface Rock {
  owner: number
  x: number
  y: number
  vy: number
  r: number
  rot: number
  phase: 'warn' | 'fall'
  born: number
}

interface Zone {
  x0: number
  x1: number
}

interface PState {
  holds: Hold[]
  rock: Rock | null
  nextRockAt: number
  stepAt: number
  height: number
  best: number
  scored: number
  grabs: number
  falls: number
  slipT: number
  flash: number
  banner: { text: string; sub: string; at: number } | null
  milestone: number
  zone: Zone
}

/** 站点三档：酥点概率/存活、落石间隔、悬空宽限、新手点高度区间、掉落米数 */
const DIFF = [
  { crumble: 0.06, crumbleT: 3.2, rockEvery: 14, slip: 2.2, up: [0.3, 0.6] as [number, number], fall: 2 },
  { crumble: 0.15, crumbleT: 2.4, rockEvery: 9, slip: 1.5, up: [0.35, 0.72] as [number, number], fall: 3 },
  { crumble: 0.25, crumbleT: 1.7, rockEvery: 6, slip: 1.2, up: [0.42, 0.85] as [number, number], fall: 4 },
]

const DWELL = 0.3 // 抓握停留（秒）
const M_PER_T = 0.8 // 1 躯干 = 0.8 米
const CLIMB_CAP = 1 // 单帧爬升上限（躯干/秒）
const RELEASE = 0.38 // 手高出岩点 0.38T 即松手
const FOOT_OFF = 0.6 // 脚偏离岩点 0.6T 即松手（补丁，见文件头）
const WARN = 0.9 // 落石预警（秒）
const ROCK_G = 1800 // 落石重力（unit/秒²）

class Climb extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  U = Math.min(this.W, this.H) / 720
  states: PState[] = []
  seats = 1
  private seatActive = [false, false]

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.states.push({
        holds: [],
        rock: null,
        nextRockAt: 6 + (DIFF[ctx.difficulty]?.rockEvery ?? 14) * 0.5,
        stepAt: 5,
        height: 0,
        best: 0,
        scored: 0,
        grabs: 0,
        falls: 0,
        slipT: 0,
        flash: 0,
        banner: null,
        milestone: 0,
        zone: { x0: 0, x1: this.W },
      })
    }
    this.layout()
  }

  private layout() {
    const duo = this.seats > 1
    for (let i = 0; i < 2; i++) {
      this.states[i].zone = duo
        ? { x0: (i * this.W) / 2, x1: ((i + 1) * this.W) / 2 }
        : { x0: 0, x1: this.W }
    }
  }

  private limbs(b: Body) {
    const X = (n: number) => n * this.W
    const Y = (n: number) => n * this.H
    return [
      { x: X(b.lHand.x), y: Y(b.lHand.y) },
      { x: X(b.rHand.x), y: Y(b.rHand.y) },
      { x: X(b.lFoot.x), y: Y(b.lFoot.y) },
      { x: X(b.rFoot.x), y: Y(b.rFoot.y) },
    ]
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true

    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!this.seatActive[i]) continue
      const b = f.bodies[i] ?? null
      if (st.flash > 0) st.flash -= dt
      this.genHolds(st, b)
      if (b) this.climb(st, b, dt)
      this.rocks(st, b, dt)
      this.syncScore(st)
      this.ctx.setExtra(`best${i}`, Math.floor(st.best))
    }
    this.states.forEach((st) => (st.holds = st.holds.filter((h) => h.y < this.H + 80)))
  }

  /** 岩点生成 + 清理 + 手点限流（每帧，对齐站点 T()） */
  private genHolds(st: PState, b: Body | null) {
    const z = st.zone
    // 开局脚点：直接生成在双脚上并自动抓住
    if (b && !st.holds.some((h) => h.kind === 'foot')) {
      const T = this.T(b)
      const limbs = this.limbs(b)
      for (const fi of [2, 3]) {
        st.holds.push({
          owner: 0, kind: 'foot', x: limbs[fi].x, y: limbs[fi].y, r: this.holdR(T),
          crumble: false, crumbleLeft: 0, grabbed: true, by: fi, counted: true,
          dwell: DWELL, dweller: fi, born: this.t,
        })
        st.grabs++
      }
    }
    if (!b) return
    const T = this.T(b)
    const sh = { x: b.shoulderC.x * this.W, y: b.shoulderC.y * this.H }

    // 手点：每侧检查「肩上方 0.2T 内是否已有空闲点」
    for (const a of [-1, 1]) {
      const busy = st.holds.some((h) => {
        if (h.kind !== 'hand' || h.grabbed) return false
        if (Math.sign(h.x - sh.x) !== a) return false
        return h.y > sh.y - 0.2 * T && h.y < sh.y + 0.1 * T
      })
      if (busy) continue
      const x = Math.max(z.x0 + 0.3 * T, Math.min(z.x1 - 0.3 * T, sh.x + a * 0.32 * T + a * T * (0.1 + Math.random() * 0.4)))
      const y = Math.max(40 * this.U, sh.y - T * (this.cfg.up[0] + Math.random() * (this.cfg.up[1] - this.cfg.up[0])))
      if (st.holds.some((h) => Math.hypot(h.x - x, h.y - y) < 0.45 * T)) continue
      st.holds.push({
        owner: 0, kind: 'hand', x, y, r: this.holdR(T),
        crumble: Math.random() < this.cfg.crumble, crumbleLeft: this.cfg.crumbleT,
        grabbed: false, by: -1, counted: false, dwell: 0, dweller: -1, born: this.t,
      })
    }

    // 后续脚点：到点且没有空闲脚点时，在一只可见脚上方生成
    if (this.t >= st.stepAt && !st.holds.some((h) => h.kind === 'foot' && !h.grabbed)) {
      const footY = Math.max(b.lFoot.y, b.rFoot.y) * this.H
      const footX = (b.lFoot.x + b.rFoot.x) / 2 * this.W
      st.holds.push({
        owner: 0, kind: 'foot', x: footX, y: footY - T * (0.44 + Math.random() * 0.12), r: this.holdR(T),
        crumble: false, crumbleLeft: 0, grabbed: false, by: -1, counted: false, dwell: 0, dweller: -1, born: this.t,
      })
      st.stepAt = this.t + 7 + Math.random() * 4
    }

    // 清理：空闲点落到髋下 1.4T、已抓手点被甩到肩下 0.5T（屏幕坐标：肩下 = y 更大）
    const hipY = b.hipC.y * this.H
    const shY = sh.y
    st.holds = st.holds.filter((h) => {
      if (!h.grabbed && h.y > hipY + 1.4 * T) return false
      if (h.grabbed && h.kind === 'hand' && h.y > shY + 0.5 * T) return false
      return true
    })
    // 空闲手点最多保留最高的 3 个
    const free = st.holds.filter((h) => h.kind === 'hand' && !h.grabbed).sort((a, b2) => a.y - b2.y)
    for (const h of free.slice(3)) st.holds.splice(st.holds.indexOf(h), 1)
  }

  private T(b: Body) {
    return Math.max(70, b.scale * this.H * 1.1)
  }
  private holdR(T: number) {
    return Math.max(26 * this.U, T * 0.2)
  }

  /** 抓握 / 脱手 / 攀爬 / 3 点规则 / 酥点（对齐站点 k 主循环） */
  private climb(st: PState, b: Body, dt: number) {
    const T = this.T(b)
    const limbs = this.limbs(b)
    const limbR = [T * 0.12, T * 0.12, T * 0.15, T * 0.15]
    const present = b.visible

    // 脱手检查：手只看纵向（站点 p=0.38T），脚看平面距离（补丁见文件头）
    for (const h of st.holds) {
      if (!h.grabbed || h.by < 0) continue
      const li = h.by
      if (!present || !limbs[li]) { this.release(h); continue }
      const l = limbs[li]
      if (h.kind === 'hand') {
        if (l.y < h.y - RELEASE * T) this.release(h)
      } else if (Math.hypot(l.x - h.x, l.y - h.y) > FOOT_OFF * T) {
        this.release(h)
      }
    }

    // 抓握停留
    for (let li = 0; li < 4; li++) {
      const holding = st.holds.some((h) => h.grabbed && h.by === li)
      if (holding || !present) continue
      const kind: HoldKind = li < 2 ? 'hand' : 'foot'
      const l = limbs[li]
      let target: Hold | null = null
      for (const h of st.holds) {
        if (h.kind !== kind || h.grabbed) continue
        if (Math.hypot(h.x - l.x, h.y - l.y) < h.r + limbR[li] * 0.8) {
          if (!target || Math.hypot(h.x - l.x, h.y - l.y) < Math.hypot(target.x - l.x, target.y - l.y)) target = h
        }
      }
      for (const h of st.holds) {
        if (h.grabbed || h.kind !== kind) continue
        if (h !== target && h.dweller === li) { h.dwell = 0; h.dweller = -1 }
      }
      if (!target) continue
      if (target.dweller !== li) { target.dwell = 0; target.dweller = li }
      target.dwell += dt
      if (target.dwell >= DWELL) {
        target.grabbed = true
        target.by = li
        target.dwell = DWELL
        this.ctx.audio.play('click', 0.8, li < 2 ? 1.1 : 0.9)
        if (!target.counted) {
          target.counted = true
          st.grabs++
        }
        if (kind === 'foot') {
          st.height += 1.5 // 踩稳白送 1.5 米
          this.say('踩稳了！', target.x, target.y - 40, '#9be15d', 34)
        }
      }
    }

    // 抓住的手拖动岩点 + 下压产生爬升
    let depthSum = 0
    let depthN = 0
    for (const h of st.holds) {
      if (!h.grabbed || h.kind !== 'hand' || h.by < 0 || h.by > 1) continue
      const l = limbs[h.by]
      h.x += (l.x - h.x) * Math.min(1, dt * 12)
      if (l.y > h.y) {
        depthSum += l.y - h.y
        depthN++
        h.y = l.y
      }
    }
    let dy = depthN > 0 ? Math.min(depthSum / depthN, T * CLIMB_CAP * dt) : 0
    // 3 点规则
    const held = st.holds.filter((h) => h.grabbed).length
    if (held >= 3) {
      st.slipT = 0
    } else if (this.t > 3) {
      st.slipT += dt
      if (st.slipT >= this.cfg.slip) {
        this.fall(st, b, Math.min(st.height, this.cfg.fall), '滑下来了！')
        dy = 0
      }
    }
    if (dy > 0) {
      for (const h of st.holds) h.y += dy
      if (st.rock) st.rock.y += dy
      st.height += dy / (T * M_PER_T)
    }

    // 酥点倒计时
    for (let i = st.holds.length - 1; i >= 0; i--) {
      const h = st.holds[i]
      if (!h.grabbed || !h.crumble) continue
      h.crumbleLeft -= dt
      if (h.crumbleLeft <= 0) {
        this.release(h)
        st.holds.splice(i, 1)
        this.particles.burst(h.x, h.y, '#d8b27a', 12, 260, 4)
        this.ctx.audio.play('miss', 0.7)
      }
    }
    st.best = Math.max(st.best, st.height)
    // 每 10 米横幅
    const m = Math.floor(st.height / 10)
    if (m > st.milestone && st.height >= 10) {
      st.milestone = m
      st.banner = { text: `${m * 10} 米！`, sub: '', at: this.t }
      this.ctx.audio.play('combo')
    }
  }

  private release(h: Hold) {
    h.grabbed = false
    h.by = -1
    h.dwell = 0
    h.dweller = -1
  }

  /** 滑落 / 被砸：岩壁整体回滚 + 全部手脱手 */
  private fall(st: PState, b: Body | null, meters: number, text: string) {
    st.height = Math.max(0, st.height - meters)
    st.falls++
    st.slipT = 0
    st.flash = 0.5
    for (const h of st.holds) if (h.kind === 'hand') this.release(h)
    // 岩壁向上滚回 s 米
    const T = b ? this.T(b) : 140
    const dyPx = meters * T * M_PER_T
    for (const h of st.holds) h.y -= dyPx
    st.banner = { text, sub: meters > 0 ? `掉了 ${meters} 米` : '', at: this.t }
    this.ctx.audio.play('hit', 0.8)
  }

  /** 落石：0.9s 预警 → 重力下落 → 砸头 / 落地 */
  private rocks(st: PState, b: Body | null, dt: number) {
    const z = st.zone
    if (!st.rock && this.t >= st.nextRockAt) {
      const hx = b ? b.head.x * this.W : (z.x0 + z.x1) / 2
      const T = b ? this.T(b) : 140
      const r = Math.max(24 * this.U, T * 0.26)
      st.rock = {
        owner: 0, x: Math.max(z.x0 + r, Math.min(z.x1 - r, hx + (Math.random() * 2 - 1) * 0.4 * T)),
        y: -r, vy: 0, r, rot: 0, phase: 'warn', born: this.t,
      }
      this.ctx.audio.play('tick', 0.6, 0.7)
    }
    const rk = st.rock
    if (!rk) return
    if (rk.phase === 'warn') {
      if (this.t - rk.born >= WARN) {
        rk.phase = 'fall'
        rk.vy = 0
      }
      return
    }
    rk.vy += ROCK_G * this.U * dt
    rk.y += rk.vy * dt
    rk.rot += 4 * dt
    if (b && b.visible) {
      const head = { x: b.head.x * this.W, y: b.head.y * this.H }
      const headR = Math.max(12, b.scale * this.H * 0.06)
      if (Math.hypot(rk.x - head.x, rk.y - head.y) < rk.r + headR * 0.9) {
        this.fall(st, b, this.cfg.fall * 0.6, '被石头砸到了！')
        this.particles.burst(rk.x, rk.y, '#9aa4b5', 14, 320, 5)
        st.rock = null
        st.nextRockAt = this.t + this.cfg.rockEvery * (0.8 + Math.random() * 0.4)
        return
      }
    }
    if (rk.y > this.H + rk.r) {
      this.say('躲过了！', rk.x, this.H - 80, '#9be15d', 30)
      st.rock = null
      st.nextRockAt = this.t + this.cfg.rockEvery * (0.8 + Math.random() * 0.4)
    }
  }

  /** 分数与高度单调对齐：升 1 米 +1、降 1 米 −1 */
  private syncScore(st: PState) {
    const target = Math.floor(st.height)
    while (st.scored < target) {
      this.ctx.addScore(1)
      st.scored++
    }
    while (st.scored > target) {
      this.ctx.addScore(-1)
      st.scored--
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    if (duo) {
      c.fillStyle = 'rgba(255,255,255,.5)'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
    for (let i = 0; i < 2; i++) {
      if (!this.seatActive[i]) continue
      const st = this.states[i]
      const z = st.zone
      const b = this.player(i).body
      const T = b ? this.T(b) : 140
      // 岩壁：半透明深色层 + 滚动的裂纹
      c.save()
      c.beginPath()
      c.rect(z.x0, 0, z.x1 - z.x0, this.H)
      c.clip()
      c.fillStyle = 'rgba(52,42,36,.42)'
      c.fillRect(z.x0, 0, z.x1 - z.x0, this.H)
      const off = (st.height * T * M_PER_T) % (T * 1.24)
      c.strokeStyle = 'rgba(255,255,255,.14)'
      c.lineWidth = 3
      for (let k = -1; k < this.H / (T * 1.24) + 1; k++) {
        const y0 = k * T * 1.24 + off
        c.beginPath()
        c.moveTo(z.x0 + 20, y0)
        c.quadraticCurveTo((z.x0 + z.x1) / 2, y0 + T * 0.3, z.x1 - 20, y0 - T * 0.12)
        c.stroke()
      }
      // 高度标尺：每 5 米一格，锚定「当前高度在中屏」
      c.fillStyle = 'rgba(255,255,255,.55)'
      c.fillRect(z.x0 + 14, 0, 2, this.H)
      const yFor = (m: number) => this.H * 0.5 + (st.height - m) * T * M_PER_T
      c.font = '700 15px system-ui'
      c.textAlign = 'left'
      const mLo = Math.max(0, Math.floor(st.height - (this.H * 0.5) / (T * M_PER_T)))
      const mHi = Math.ceil(st.height + (this.H * 0.5) / (T * M_PER_T))
      for (let m = Math.ceil(mLo / 5) * 5; m <= mHi; m += 5) {
        const y = yFor(m)
        if (y < 10 || y > this.H - 10) continue
        c.fillRect(z.x0 + 14, y, 12, 2)
        c.fillText(`${m}`, z.x0 + 30, y + 5)
      }
      // 岩点
      for (const h of st.holds) {
        const age = Math.min(1, (this.t - h.born) / 0.25)
        const scale = 0.4 + 0.6 * age + Math.sin(age * Math.PI) * 0.2
        const col = h.grabbed ? this.players[i].color : h.kind === 'hand' ? '#c98850' : '#8fb573'
        circle(c, h.x, h.y, h.r * scale, col)
        c.strokeStyle = 'rgba(0,0,0,.25)'
        c.lineWidth = 3
        c.beginPath()
        c.arc(h.x, h.y, h.r * scale, 0, Math.PI * 2)
        c.stroke()
        if (!h.grabbed && h.dwell > 0 && h.dweller >= 0) {
          ring(c, h.x, h.y, h.r * 1.35, h.dwell / DWELL, this.players[i].color, 5)
        }
        if (h.grabbed && h.crumble) {
          ring(c, h.x, h.y, h.r * 1.35, 1 - h.crumbleLeft / this.cfg.crumbleT, '#ff5d5d', 5)
        }
      }
      // 落石
      const rk = st.rock
      if (rk) {
        if (rk.phase === 'warn') {
          const blink = Math.floor(this.t * 6) % 2 === 0
          if (blink) {
            c.strokeStyle = '#ff4d4d'
            c.lineWidth = 4
            c.setLineDash([10 * this.U, 8 * this.U])
            c.lineDashOffset = -this.t * 40
            c.beginPath()
            c.moveTo(rk.x, 0)
            c.lineTo(rk.x, this.H)
            c.stroke()
            c.setLineDash([])
          }
          outlineTxt(c, '⚠ 落石', rk.x, 60 + Math.sin(this.t * 8) * 6, 30, '#ff4d4d')
        } else {
          c.save()
          c.translate(rk.x, rk.y)
          c.rotate(rk.rot)
          circle(c, 0, 0, rk.r, '#7d7468')
          c.fillStyle = 'rgba(0,0,0,.25)'
          circle(c, -rk.r * 0.3, -rk.r * 0.2, rk.r * 0.28, 'rgba(0,0,0,.25)')
          c.restore()
        }
      }
      c.restore()

      // 高度大字
      txt(c, `${Math.floor(st.height)} 米`, z.x1 - 24, 48, 26, this.players[i].color, 'right', 'bold')
      // 滑落预警
      if (st.slipT > 0.15 && b) {
        const wy = b.shoulderC.y * this.H + 0.4 * T
        ring(c, b.center.x * this.W, wy, 0.35 * T, Math.max(0, 1 - st.slipT / this.cfg.slip), '#ff5d5d', 6)
        outlineTxt(c, '快抓住岩点！', b.center.x * this.W, wy + 0.6 * T, 26, '#ff5d5d')
      }
      // 横幅
      if (st.banner && this.t - st.banner.at < 0.9) {
        outlineTxt(c, st.banner.text, (z.x0 + z.x1) / 2, this.H * 0.3, 48, '#ffb24d')
        if (st.banner.sub) outlineTxt(c, st.banner.sub, (z.x0 + z.x1) / 2, this.H * 0.3 + 52, 26, '#ffffffcc')
      } else if (st.banner && this.t - st.banner.at >= 0.9) st.banner = null
      // 掉落红闪
      if (st.flash > 0) {
        c.fillStyle = `rgba(255,60,60,${st.flash * 0.5})`
        c.fillRect(z.x0, 0, z.x1 - z.x0, this.H)
      }
    }
    // 统计
    for (let i = 0; i < 2; i++) {
      const st = this.states[i]
      if (!this.seatActive[i]) continue
      this.ctx.setExtra(`falls${i}`, st.falls)
      this.ctx.setExtra(`grabs${i}`, st.grabs)
    }
    if (duo) txt(c, '🧗', this.W / 2, this.H - 16, 18, '#fff')
  }
}

export default function create(ctx: GameContext) {
  return new Climb(ctx)
}
