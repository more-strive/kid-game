import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { bg, circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 冲浪 / surfing（对齐 dongdongpark 真实规则）：
 * 身体左右歪 → 板子跟着「金色浪带」走，待在带上每 0.2 秒 +1 分；
 * 大浪来了蹲下冲过（+5），浪尖跳起来做花样（+3），没蹲好会落水冻结 2 秒。
 *
 * 站点字面量全部保留：
 * - 浪心由「移动段 + 停留段」串成，停留时长 hold 与速度 speed 都随局内进度加压
 * - 大浪窗口 [at-0.9, at+0.2]，浪尖窗口 [at-0.7, at+0.6]，宁可放宽也不为难小孩
 * - 落水期间冻结玩家并把窗口内事件标记 done，避免一次失误触发连锁失败
 *
 * 与站点的差异：
 * 1) 站点读 motion.lean / motion.squat 连续量，本框架只有布尔 squat 与肩髋偏移，换算见下方 helper。
 * 2) 站点有 5 个滑板/人物贴图，这里用几何图形绘制。
 */

interface Seg {
  t0: number
  t1: number
  t2: number
  from: number
  to: number
}

interface Ev {
  id: number
  at: number
  kind: 'big' | 'crest'
}

interface Zone {
  cx: number
  w: number
  rpx: number
  baseY: number
}

interface Surfer {
  u: number
  wipe: number
  acc: number
  zoneT: number
  liveT: number
  tricks: number
  bigPass: number
  bigFail: number
  ev: Map<number, { done: boolean; ducked: boolean }>
  trickT: number
  hopT: number
  wasJumping: boolean
  enterAt: number
  zone: Zone
  color: string
}

/** 站点三档：浪带半宽 / 浪心横速 / 停留区间 / 事件间隔 / 大浪概率 / 预警提前量 */
const DIFF = [
  { hw: 0.3, speed: 0.3, hold: [1.6, 3] as [number, number], gap: [5.6, 7.6] as [number, number], bigP: 0.35, warn: 2.6 },
  { hw: 0.23, speed: 0.38, hold: [1.2, 2.4] as [number, number], gap: [4.6, 6.4] as [number, number], bigP: 0.45, warn: 2.2 },
  { hw: 0.17, speed: 0.48, hold: [0.8, 1.8] as [number, number], gap: [3.9, 5.4] as [number, number], bigP: 0.55, warn: 1.8 },
]

const TICK = 0.2 // 待在浪带上每 0.2 秒 +1 分
const LEAN_GAIN = 1.4 // u 目标 = clamp(lean × 1.4)
const U_MAX = 0.72 // 浪心位移上限（永不贴边）
const WIPE = 2 // 落水冻结（秒）
const BIG_IN = 0.9 // 大浪判定窗口起点
const BIG_OUT = 0.2 // 大浪判定窗口终点
const CREST_IN = 0.7 // 浪尖窗口起点
const CREST_OUT = 0.6 // 浪尖窗口终点
const ARM_UP = 0.42 // 举手也算跳（本量纲，约双手过头）

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function leanOf(b: Body | null) {
  if (!b) return 0
  const t = Math.max(0.08, b.scale)
  return clamp(((b.shoulderC.x - b.hipC.x) / t) * 2.2, -1, 1)
}

function armLiftOf(b: Body | null) {
  if (!b) return 0
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
}

class Surfing extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  dur = this.ctx.meta.duration || 90
  segs: Seg[] = []
  evs: Ev[] = []
  surfers: Surfer[] = []
  seats = 1

  private nextEvent = 3.2
  private evCount = 0

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.surfers.push({
        u: 0,
        wipe: 0,
        acc: 0,
        zoneT: 0,
        liveT: 0,
        tricks: 0,
        bigPass: 0,
        bigFail: 0,
        ev: new Map(),
        trickT: -1,
        hopT: -1,
        wasJumping: false,
        enterAt: -9,
        zone: { cx: this.W / 2, w: this.W, rpx: Math.min(this.W * 0.36, this.H * 0.58), baseY: this.H * 0.72 },
        color: this.players[i].color,
      })
    }
    this.layout()
  }

  private layout() {
    const w = this.W / this.seats
    for (let i = 0; i < 2; i++) {
      const z = this.surfers[i].zone
      z.w = w
      z.cx = w * i + w / 2
      z.rpx = Math.min(w * 0.36, this.H * 0.58)
      z.baseY = this.H * 0.72
    }
  }

  /** 浪心轨迹：一段「移动（缓入缓出）」+ 一段「停留」，都随进度加压 */
  private genWave(until: number) {
    while (!this.segs.length || this.segs[this.segs.length - 1].t2 < until) {
      const last = this.segs[this.segs.length - 1]
      if (!last) {
        this.segs.push({ t0: 0, t1: 0, t2: 3, from: 0, to: 0 })
        continue
      }
      const prog = Math.min(1, last.t2 / this.dur)
      const dir = Math.random() < 0.5 ? -1 : 1
      const amp = 0.3 + Math.random() * 0.75
      let to = last.to + dir * amp
      if (Math.abs(to) > U_MAX) to = -to
      to = clamp(to, -U_MAX, U_MAX)
      const moveDur = Math.max(0.7, Math.abs(to - last.to) / (this.cfg.speed * (1 + 0.3 * prog)))
      const holdDur =
        (this.cfg.hold[0] + Math.random() * (this.cfg.hold[1] - this.cfg.hold[0])) * (1 - 0.25 * prog)
      this.segs.push({
        t0: last.t2,
        t1: last.t2 + moveDur,
        t2: last.t2 + moveDur + holdDur,
        from: last.to,
        to,
      })
    }
    while (this.segs.length > 60) this.segs.shift()
  }

  private waveAt(t: number) {
    this.genWave(t + 8)
    for (const s of this.segs) {
      if (t < s.t0) return s.from
      if (t <= s.t1) {
        const p = (t - s.t0) / Math.max(1e-3, s.t1 - s.t0)
        return s.from + (s.to - s.from) * (1 - Math.cos(Math.PI * p)) * 0.5
      }
      if (t <= s.t2) return s.to
    }
    return this.segs[this.segs.length - 1]?.to ?? 0
  }

  private genEvents(until: number) {
    while (this.nextEvent < until) {
      const prog = Math.min(1, this.nextEvent / this.dur)
      let at: number
      if (this.evCount === 0) {
        at = 3.2 + this.cfg.warn + 0.6 + Math.random()
      } else {
        const gap =
          (this.cfg.gap[0] + Math.random() * (this.cfg.gap[1] - this.cfg.gap[0])) * (1 - 0.15 * prog)
        at = this.nextEvent + gap
      }
      const kind: 'big' | 'crest' =
        this.evCount === 0 ? 'big' : this.evCount === 1 ? 'crest' : Math.random() < this.cfg.bigP ? 'big' : 'crest'
      this.evs.push({ id: this.evCount, at, kind })
      this.nextEvent = at
      this.evCount++
    }
  }

  private mst(s: Surfer, id: number) {
    let st = s.ev.get(id)
    if (!st) {
      st = { done: false, ducked: false }
      s.ev.set(id, st)
    }
    return st
  }

  tick(f: PoseFrame, dt: number) {
    if (f.bodies[1] && this.seats !== 2) {
      this.seats = 2
      this.layout()
    }
    this.genEvents(this.t + 3)
    for (let i = 0; i < this.seats; i++) this.step(i, f.bodies[i] ?? null, dt)
  }

  private step(i: number, b: Body | null, dt: number) {
    const s = this.surfers[i]

    if (s.trickT >= 0) {
      s.trickT += dt
      if (s.trickT > 0.9) s.trickT = -1
    }
    if (s.hopT >= 0) {
      s.hopT += dt
      if (s.hopT > 0.4) s.hopT = -1
    }

    // 落水：完全冻结，并把窗口内事件标记 done（避免一次失误触发连锁失败）
    if (s.wipe > 0) {
      // 冻结期也同步跳跃电平，否则恢复瞬间会把「一直举着/跳着」误判成一次新的起跳
      s.wasJumping = !!b?.jumping
      s.wipe -= dt
      for (const ev of this.evs) {
        if (ev.at > this.t + 2) break
        const st = this.mst(s, ev.id)
        if (st.done) continue
        if (this.t >= ev.at - (ev.kind === 'big' ? BIG_IN : CREST_IN)) st.done = true
      }
      if (s.wipe <= 0) this.ctx.audio.play('pop', 0.5, 0.85)
      return
    }

    const lean = leanOf(b)
    const target = clamp(lean * LEAN_GAIN, -1, 1)
    s.u += (target - s.u) * (1 - Math.exp(-dt * 7))
    s.liveT += dt

    // 待浪计分
    const wave = this.waveAt(this.t)
    const inZone = Math.abs(s.u - wave) <= this.cfg.hw
    if (inZone) {
      s.zoneT += dt
      s.acc += dt
      while (s.acc >= TICK) {
        s.acc -= TICK
        this.ctx.addScore(1)
      }
      if (this.t - s.enterAt > 1.5) {
        s.enterAt = this.t
        this.ctx.audio.play('pop', 0.35, 2)
      }
    } else {
      s.enterAt = this.t - 3
    }
    if (inZone && Math.random() < dt * 4) {
      this.particles.burst(s.zone.cx + s.u * s.zone.rpx, s.zone.baseY - 30, '#ffe680', 2, 90, 3)
    }

    const jump = !!b?.jumping
    const jumpEdge = jump && !s.wasJumping
    s.wasJumping = jump
    const handsUp = armLiftOf(b) > ARM_UP

    for (const ev of this.evs) {
      if (ev.at > this.t + 2) break
      const st = this.mst(s, ev.id)
      if (st.done) continue

      if (ev.kind === 'big') {
        if (this.t >= ev.at - BIG_IN && this.t <= ev.at + BIG_OUT && b?.squat && !st.ducked) {
          st.ducked = true
          this.ctx.audio.play('pop', 0.55, 1.5)
        }
        if (this.t >= ev.at && st.ducked) {
          st.done = true
          s.bigPass++
          this.ctx.addScore(5)
          this.ctx.audio.coin()
          this.say('冲过去 +5', s.zone.cx + s.u * s.zone.rpx, s.zone.baseY - 150, '#ffd54a', 34)
          this.ctx.setExtra('big', s.bigPass)
        } else if (this.t > ev.at + BIG_OUT) {
          st.done = true
          s.bigFail++
          s.wipe = WIPE
          s.trickT = -1
          this.ctx.audio.fail()
          this.say('落水啦！要蹲下', s.zone.cx, this.H * 0.34, '#ff6b8a', 34)
          this.ctx.setExtra('big', s.bigPass)
          this.particles.burst(s.zone.cx + s.u * s.zone.rpx, s.zone.baseY - 20, '#dff6ff', 30, 320, 5)
          return
        }
      } else {
        if (this.t >= ev.at - CREST_IN && this.t <= ev.at + CREST_OUT && (jumpEdge || handsUp)) {
          st.done = true
          s.tricks++
          s.trickT = 0
          this.ctx.addScore(3)
          this.ctx.audio.play('pop', 0.8, 1.7)
          this.say('花样 +3', s.zone.cx + s.u * s.zone.rpx, s.zone.baseY - 190, '#ffe680', 32)
          this.ctx.setExtra('tricks', s.tricks)
        } else if (this.t > ev.at + CREST_OUT) {
          st.done = true
        }
      }
    }

    // 不在浪尖窗口的空跳
    if (jumpEdge && s.trickT < 0) s.hopT = 0

    if (s.liveT > 3) {
      this.ctx.setExtra('onwave', Math.round((s.zoneT / Math.max(1, s.liveT)) * 100))
    }
  }

  /** 浪面高度：浪心附近高斯隆起（视觉），不参与判定 */
  private surfY(z: Zone, px: number) {
    const wx = z.cx + this.waveAt(this.t) * z.rpx
    const d = (px - wx) / (z.rpx * 0.95)
    return z.baseY - Math.exp(-d * d) * this.H * 0.1
  }

  paint(c: CanvasRenderingContext2D) {
    for (let i = 0; i < this.seats; i++) {
      const s = this.surfers[i]
      c.save()
      c.beginPath()
      c.rect(s.zone.cx - s.zone.w / 2, 0, s.zone.w, this.H)
      c.clip()
      this.paintSea(c, i)
      c.restore()
    }
    if (this.seats > 1) {
      c.fillStyle = 'rgba(255,252,240,.85)'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
  }

  private paintSea(c: CanvasRenderingContext2D, i: number) {
    const s = this.surfers[i]
    const z = s.zone
    const left = z.cx - z.w / 2
    const right = z.cx + z.w / 2

    bg(c, '#7fd0f5', '#dff6ff')

    // 太阳 + 云
    circle(c, right - 90, 92, 46, 'rgba(255,230,128,.9)')
    circle(c, right - 90, 92, 64, 'rgba(255,230,128,.22)')
    c.fillStyle = 'rgba(255,255,255,.75)'
    for (let k = 0; k < 3; k++) {
      const cx2 = left + ((k * 0.37 + 0.16) % 1) * z.w + Math.sin(this.t * 0.2 + k) * 20
      const cy2 = 70 + k * 34
      circle(c, cx2, cy2, 22, 'rgba(255,255,255,.75)')
      circle(c, cx2 + 24, cy2 + 4, 16, 'rgba(255,255,255,.75)')
      circle(c, cx2 - 22, cy2 + 6, 14, 'rgba(255,255,255,.75)')
    }

    // 海面：沿浪面采样闭合到底部
    c.beginPath()
    c.moveTo(left, this.surfY(z, left))
    for (let px = left; px <= right; px += 8) c.lineTo(px, this.surfY(z, px))
    c.lineTo(right, this.H)
    c.lineTo(left, this.H)
    c.closePath()
    const sea = c.createLinearGradient(0, z.baseY - this.H * 0.16, 0, this.H)
    sea.addColorStop(0, '#7fe0ef')
    sea.addColorStop(0.45, '#43c3d6')
    sea.addColorStop(1, '#17709c')
    c.fillStyle = sea
    c.fill()

    // 浪面上沿的白色浪线
    c.strokeStyle = 'rgba(255,255,255,.75)'
    c.lineWidth = 4
    c.beginPath()
    for (let px = left; px <= right; px += 8) {
      const y = this.surfY(z, px)
      px === left ? c.moveTo(px, y) : c.lineTo(px, y)
    }
    c.stroke()

    // 金色浪带（得分区）
    const wx = z.cx + this.waveAt(this.t) * z.rpx
    const half = this.cfg.hw * z.rpx
    c.save()
    c.beginPath()
    const gx0 = clamp(wx - half, left, right)
    const gx1 = clamp(wx + half, left, right)
    c.moveTo(gx0, this.surfY(z, gx0))
    for (let px = gx0; px <= gx1; px += 6) c.lineTo(px, this.surfY(z, px))
    for (let px = gx1; px >= gx0; px -= 6) c.lineTo(px, this.surfY(z, px) + 26)
    c.closePath()
    c.fillStyle = 'rgba(255,213,74,.45)'
    c.fill()
    c.strokeStyle = 'rgba(255,213,74,.9)'
    c.lineWidth = 3
    c.setLineDash([10, 8])
    c.stroke()
    c.setLineDash([])
    c.restore()

    // 玩家（先画，浪墙随后带缺口盖上来）
    this.paintSurfer(c, s, i)

    // 大浪浪墙
    this.paintBigWave(c, s)

    // HUD
    txt(c, `P${i + 1}`, left + 22, 30, 22, s.color, 'left')
    const pct = Math.round((s.zoneT / Math.max(1, s.liveT)) * 100)
    txt(c, `在浪上 ${s.liveT > 1 ? pct : 0}%`, right - 22, 30, 20, '#2b5c73', 'right')

    if (s.wipe > 0) {
      outlineTxt(c, '扑通！', z.cx, z.baseY - this.H * 0.2, 44, '#ff8fa8')
    }

    // 事件提示徽章
    this.paintBadge(c, s)

    if (this.t < 5 && s.liveT < 5) {
      c.globalAlpha = 0.5 + 0.45 * Math.sin(this.t * 4)
      outlineTxt(c, '歪身体，跟着金色的浪走', z.cx, this.H * 0.2, 28)
      c.globalAlpha = 1
    }
  }

  private paintSurfer(c: CanvasRenderingContext2D, s: Surfer, i: number) {
    const z = s.zone
    const px = z.cx + s.u * z.rpx
    const py = this.surfY(z, px)
    const b = this.players[i].body
    const squat = !!b?.squat
    const air = s.trickT >= 0
    const hop = s.hopT >= 0 ? Math.sin((s.hopT / 0.4) * Math.PI) : 0
    const lift = air ? Math.sin(Math.min(1, s.trickT / 0.9) * Math.PI) * this.H * 0.09 : hop * this.H * 0.035
    const lean = leanOf(b)

    c.save()
    c.translate(px, py - lift)
    c.rotate(lean * 0.28)

    // 板
    c.fillStyle = s.wipe > 0 ? '#8fa3b8' : s.color
    rr(c, -46, -6, 92, 12, 6)
    c.fill()
    c.fillStyle = 'rgba(255,255,255,.45)'
    rr(c, -40, -4, 80, 3, 2)
    c.fill()

    // 人（蹲下时压低）
    const bodyH = squat ? 26 : 44
    c.fillStyle = '#2b3a55'
    rr(c, -9, -bodyH - 6, 18, bodyH, 8)
    c.fill()
    circle(c, 0, -bodyH - 18, 11, '#ffe0bd')
    // 手臂
    c.strokeStyle = '#2b3a55'
    c.lineWidth = 7
    c.lineCap = 'round'
    const handY = air ? -bodyH - 34 : squat ? -bodyH + 2 : -bodyH - 4
    c.beginPath()
    c.moveTo(-6, -bodyH + 2)
    c.lineTo(-22, handY)
    c.moveTo(6, -bodyH + 2)
    c.lineTo(22, handY)
    c.stroke()
    c.lineCap = 'butt'

    // 落水：倒板 + 水花
    if (s.wipe > 0) {
      c.globalAlpha = 0.6
      c.fillStyle = '#dff6ff'
      circle(c, 0, 6, 16 + Math.sin(this.t * 8) * 3, '#dff6ff')
      c.globalAlpha = 1
    }
    c.restore()

    // 脚下光圈（在带内时）
    const inZone = Math.abs(s.u - this.waveAt(this.t)) <= this.cfg.hw
    if (inZone && s.wipe <= 0) {
      c.strokeStyle = 'rgba(255,213,74,.85)'
      c.lineWidth = 3
      c.beginPath()
      c.ellipse(px, py + 2, 56, 14, 0, 0, Math.PI * 2)
      c.stroke()

    }
  }

  /** 大浪浪墙：从远处升起，在玩家位置裂开一个缺口，制造「从浪里钻过去」的错觉 */
  private paintBigWave(c: CanvasRenderingContext2D, s: Surfer) {
    const z = s.zone
    let ev: Ev | null = null
    for (const e of this.evs) {
      if (e.kind !== 'big') continue
      if (e.at < this.t - 1.2) continue
      if (e.at > this.t + this.cfg.warn) continue
      ev = e
      break
    }
    if (!ev) return
    const rise = clamp((this.t - (ev.at - this.cfg.warn)) / 0.6, 0, 1)
    const fade = clamp(1 - (this.t - ev.at - 0.3) / 0.55, 0, 1)
    const a = Math.min(rise, fade)
    if (a <= 0.02) return

    const top = z.baseY - this.H * 0.95 * a
    const px = z.cx + s.u * z.rpx
    const gap = 92
    const left = z.cx - z.w / 2
    const right = z.cx + z.w / 2
    c.fillStyle = `rgba(31,120,176,${0.55 + 0.3 * a})`
    const lw = Math.max(0, px - gap - left)
    const rw = Math.max(0, right - (px + gap))
    c.fillRect(left, top, lw, this.H - top)
    c.fillRect(px + gap, top, rw, this.H - top)

    // 浪顶白沫
    c.fillStyle = 'rgba(255,255,255,.8)'
    c.fillRect(left, top, lw, 8)
    c.fillRect(px + gap, top, rw, 8)
    // 缺口两侧的浪花
    c.fillStyle = 'rgba(255,255,255,.55)'
    for (const ex of [px - gap, px + gap]) {
      for (let k = 0; k < 5; k++) {
        const yy = top + 10 + k * 26
        if (yy > this.H) break
        circle(c, ex + (k % 2 ? 4 : -4), yy, 6, 'rgba(255,255,255,.5)')
      }
    }
  }

  /** 胶囊徽章：「大浪！蹲下」/「蹲好了！」/「浪尖！跳」 */
  private paintBadge(c: CanvasRenderingContext2D, s: Surfer) {
    const z = s.zone
    let text = ''
    let good = false
    for (const ev of this.evs) {
      if (ev.at < this.t - 1.5) continue
      if (ev.kind === 'big' && this.t >= ev.at - this.cfg.warn) {
        const st = this.mst(s, ev.id)
        text = st.ducked ? '蹲好了！' : '大浪！蹲下'
        good = st.ducked
        break
      }
      if (ev.kind === 'crest' && this.t >= ev.at - 1.3) {
        text = '浪尖！跳'
        break
      }
    }
    if (!text) return
    const w = 240
    const h = 62
    const y = this.H * 0.12
    c.save()
    c.translate(z.cx, y + h / 2)
    c.fillStyle = good ? 'rgba(61,220,151,.92)' : 'rgba(24,54,92,.86)'
    rr(c, -w / 2, -h / 2, w, h, h / 2)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.6)'
    c.lineWidth = 2
    rr(c, -w / 2, -h / 2, w, h, h / 2)
    c.stroke()
    txt(c, text, 0, 0, 28, '#fff')
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new Surfing(ctx)
}
