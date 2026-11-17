import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 太极云手（对齐逆向报告 taichi.md / 站点 game-CZcMqGu6.js）：
 * 师傅沿体式曲线（云手/单鞭/白鹤亮翅/野马分鬃）带动两颗发光小球，玩家双腕跟着目标走。
 * 每 0.2s 结算：手贴住目标（距离 < near×比例尺）且速度够慢（< maxSpeed）才得分（每手 +1，即最多 10 分/秒）。
 * 超速画警示环 +「慢一点」；每个体式循环结束时稳定占比 ≥0.75 夸「好！」。
 */

/** 难度表（报告 §1）：period 循环秒数 / near 命中半径(×T) / maxSpeed 慢速上限(×T 每秒) / cycles 每体式循环数 / forms 体式池 */
const DIFF = [
  { period: 6, near: 0.6, maxSpeed: 1.8, cycles: 3, forms: ['cloud', 'whip'] },
  { period: 7, near: 0.5, maxSpeed: 1.5, cycles: 2, forms: ['cloud', 'whip', 'crane'] },
  { period: 8.5, near: 0.42, maxSpeed: 1.3, cycles: 2, forms: ['cloud', 'whip', 'crane', 'horse'] },
]

/** 游戏内常量（报告 §1）：SCORE_EVERY 计分周期 / TRAIL_LIFE 尾迹寿命 / SLOW_SAY_T 首次提醒延时 / FAST_WARN_T 超速确认 */
const SCORE_EVERY = 0.2
const TRAIL_LIFE = 2.4
const SLOW_SAY_T = 1.5
const FAST_WARN_T = 0.15
const SLOW_SAY_GAP = 6

type FormId = 'cloud' | 'whip' | 'crane' | 'horse'
interface Pt {
  x: number
  y: number
}
/** 体式定义：pace（period 系数）/ alternate（每循环左右互换）/ at(phase) 返回双手目标（锚点单位，y 向下） */
interface Form {
  id: FormId
  name: string
  hint: string
  pace: number
  alternate: boolean
  at: (phase: number) => [Pt, Pt]
}

const TAU = Math.PI * 2
const mirror = (p: Pt): Pt => ({ x: -p.x, y: p.y })
/** 翻转：镜像并交换两手（站点 x()） */
const flipPair = (p: [Pt, Pt]): [Pt, Pt] => [mirror(p[1]), mirror(p[0])]

/** 两点间半椭圆插值（站点 S()）：连线为长轴，垂直振幅 amp，phase∈[0,1] */
function ellipseBetween(a: Pt, b: Pt, amp: number, phase: number): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy) || 1
  const dir = { x: dx / d, y: dy / d }
  const perp = dir.x >= 0 ? { x: dir.y, y: -dir.x } : { x: -dir.y, y: dir.x }
  const l = phase * TAU
  const half = d / 2
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  return {
    x: cx - dir.x * half * Math.cos(l) + perp.x * amp * Math.sin(l),
    y: cy - dir.y * half * Math.cos(l) + perp.y * amp * Math.sin(l),
  }
}

/** 云手（站点 C()）：双手沿椭圆轮流画大圆，相位差 π，第二只手镜像 */
function cloudAt(phase: number): [Pt, Pt] {
  const t = phase * TAU - Math.PI / 2
  const at = (e: number): Pt => ({ x: -0.33 + 0.4 * Math.cos(e), y: 0.26 - 0.5 * Math.sin(e) })
  return [at(t), mirror(at(t + Math.PI))]
}
/** 单鞭（站点 w()）：两手慢慢向两边打开 */
function whipAt(phase: number): [Pt, Pt] {
  return [
    ellipseBetween({ x: -0.12, y: 0.45 }, { x: -0.92, y: 0 }, 0.15, phase),
    mirror(ellipseBetween({ x: -0.12, y: 0.45 }, { x: -0.86, y: -0.12 }, 0.15, phase)),
  ]
}
/** 白鹤亮翅（站点 T()）：一手举高一手下按，每循环互换 */
function craneAt(phase: number): [Pt, Pt] {
  const hi = ellipseBetween({ x: 0.18, y: 0.42 }, { x: 0.6, y: -0.62 }, 0.16, phase)
  return [ellipseBetween({ x: -0.18, y: 0.42 }, { x: -0.58, y: 0.74 }, -0.1, phase), hi]
}
/** 野马分鬃（站点 E()）：一手斜着分出去一手按下，每循环互换 */
function horseAt(phase: number): [Pt, Pt] {
  const sweep = ellipseBetween({ x: 0.06, y: 0.6 }, { x: 0.82, y: -0.16 }, 0.14, phase)
  return [ellipseBetween({ x: -0.1, y: 0.22 }, { x: -0.56, y: 0.72 }, -0.1, phase), sweep]
}

const FORMS: Record<FormId, Form> = {
  cloud: { id: 'cloud', name: '云手', hint: '两只手轮流画大圆', pace: 1, alternate: false, at: cloudAt },
  whip: { id: 'whip', name: '单鞭', hint: '两手慢慢向两边打开', pace: 0.9, alternate: false, at: whipAt },
  crane: { id: 'crane', name: '白鹤亮翅', hint: '一只手举高，一只手按下', pace: 1, alternate: true, at: craneAt },
  horse: { id: 'horse', name: '野马分鬃', hint: '一只手斜着分出去，一只手按下', pace: 1, alternate: true, at: horseAt },
}

interface Seg {
  t0: number
  dur: number
  form: Form
  flip: boolean
  /** 过渡段：from/to 为翻转后的双手目标 */
  glide: { from: [Pt, Pt]; to: [Pt, Pt] } | null
  /** 正式循环序号（过渡段 = -1，站点靠它决定何时结算循环达标） */
  cycle: number
  intro: boolean
}

/** 谱面（站点 L()）：cloud 打头 + 池内洗牌不连重复；每体式 cycles 个循环；循环间距离 >0.03 插过渡段 */
function buildSequence(durationSec: number, cfg: (typeof DIFF)[number]): Seg[] {
  const pool = cfg.forms.map((f) => FORMS[f as FormId])
  const list: Form[] = [FORMS.cloud]
  const total = durationSec * 1.5 + 60
  const segs: Seg[] = []
  let t = 0
  let li = 0
  let prevEnd: [Pt, Pt] | null = null
  while (t < total) {
    if (li >= list.length) {
      const next = [...pool]
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[next[i], next[j]] = [next[j], next[i]]
      }
      if (next[0].id === list[list.length - 1].id) {
        const f = next.shift()
        if (f) next.push(f)
      }
      list.push(...next)
    }
    const form = list[li++]
    const startFlip = Math.random() < 0.5
    let intro = true
    for (let cyc = 0; cyc < cfg.cycles; cyc++) {
      const flip = form.alternate ? startFlip !== (cyc % 2 === 1) : false
      const end = flipPair(form.at(0))
      if (prevEnd) {
        const d = Math.max(
          Math.hypot(prevEnd[0].x - end[0].x, prevEnd[0].y - end[0].y),
          Math.hypot(prevEnd[1].x - end[1].x, prevEnd[1].y - end[1].y),
        )
        if (d > 0.03) {
          const dur = Math.min(2.4, Math.max(1.2, d / 0.35))
          segs.push({ t0: t, dur, form, flip, glide: { from: prevEnd, to: end }, cycle: -1, intro })
          intro = false
          t += dur
        }
      }
      const dur = cfg.period * form.pace
      segs.push({ t0: t, dur, form, flip, glide: null, cycle: cyc, intro })
      intro = false
      t += dur
      prevEnd = end
    }
  }
  return segs
}

interface PState {
  /** 每只手匹配到的手腕屏幕坐标 */
  hand: (Pt | null)[]
  near: boolean[]
  slow: boolean[]
  /** 视觉锁定平滑（near&&slow → 1，速率 6/s） */
  lock: number[]
  wasGood: boolean[]
  fastT: number
  warnUntil: number
  warnHand: number
  /** 尾迹（沿目标轨迹落点） */
  trails: { x: number; y: number; age: number; gap: boolean }[][]
  handTicks: number
  nearTicks: number
  slowTicks: number
  streak: number
  best: number
  cycTicks: number
  cycGood: number
}

/** 太极云手 */
class TaichiGame extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  segs = buildSequence(this.ctx.meta.duration || 90, this.cfg)
  /** 锚点（站点 S[]）：先取 zone 中心 + H*0.4 + H*0.2，之后平滑跟随肩心 */
  anchors: { x: number; y: number; T: number; ok: boolean }[]
  ps: PState[]
  /** 上一帧段序号（站点 T） */
  segIdx = -1
  /** 计分 tick 时刻（站点 w=j） */
  tickAt = 0.2
  lastSlowSay = -99
  /** 慢一点警示环特效 */
  rings: { x: number; y: number; age: number }[] = []
  bannerT = 0
  bannerMax = 0
  bannerText = ''
  bannerSub = ''

  constructor(ctx: GameContext) {
    super(ctx)
    this.anchors = [0, 1].map((i) => ({
      x: this.zone(i)[0],
      y: this.H * 0.4,
      T: this.H * 0.2,
      ok: false,
    }))
    this.ps = [0, 1].map(() => ({
      hand: [null, null],
      near: [false, false],
      slow: [false, false],
      lock: [0, 0],
      wasGood: [false, false],
      fastT: 0,
      warnUntil: -1,
      warnHand: 0,
      trails: [[], []],
      handTicks: 0,
      nearTicks: 0,
      slowTicks: 0,
      streak: 0,
      best: 0,
      cycTicks: 0,
      cycGood: 0,
    }))
  }

  /** 分屏 zone（框架口径）：solo 0.08~0.92W，duo P0 0.03~0.47 / P1 0.53~0.97 */
  private zone(i: number): [number, number] {
    const dual = !!(this.players[0].body && this.players[1].body)
    if (!dual) return [this.W * 0.08, this.W * 0.92]
    return i === 0 ? [this.W * 0.03, this.W * 0.47] : [this.W * 0.53, this.W * 0.97]
  }

  private dual() {
    return !!(this.players[0].body && this.players[1].body)
  }

  /** 二分找当前段（站点 O()） */
  private segAt(t: number) {
    let lo = 0
    let hi = this.segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.segs[mid].t0 <= t) lo = mid
      else hi = mid - 1
    }
    return this.segs[lo]
  }

  /** 当前双手目标（锚点单位，站点 k()） */
  private sample(t: number): [Pt, Pt] {
    const seg = this.segAt(Math.max(0, t))
    const n = Math.max(0, Math.min(1, (t - seg.t0) / seg.dur))
    if (seg.glide) {
      const e = n * n * (3 - 2 * n)
      const lerp = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e })
      return [lerp(seg.glide.from[0], seg.glide.to[0]), lerp(seg.glide.from[1], seg.glide.to[1])]
    }
    const r = seg.form.at(n)
    return seg.flip ? flipPair(r) : r
  }

  /** 目标点换算到屏幕（站点 R()）：锚 + n*T 后 clamp 到 zone 与画面 */
  private toScreen(pi: number, n: Pt): Pt {
    const a = this.anchors[pi]
    const [x0, x1] = this.zone(pi)
    const T = a.T
    const m = Math.max(13 * this.unit, T * 0.13)
    return {
      x: Math.max(x0 + m, Math.min(x1 - m, a.x + n.x * T)),
      y: Math.max(110 * this.unit + m, Math.min(this.H - m - 8 * this.unit, a.y + n.y * T)),
    }
  }

  /** 锚点平滑跟随肩心（站点 z()：位置 3/s、比例尺 1.2/s 指数逼近，首帧吸附） */
  private followAnchors(dt: number) {
    for (let i = 0; i < 2; i++) {
      const b = this.players[i].body
      if (!b) continue
      const a = this.anchors[i]
      const scale = Math.max(60 * this.unit, b.scale * this.H)
      if (!a.ok) {
        a.x = b.shoulderC.x * this.W
        a.y = b.shoulderC.y * this.H
        a.T = scale
        a.ok = true
        continue
      }
      const k = 1 - Math.exp(-dt * 3)
      a.x += (b.shoulderC.x * this.W - a.x) * k
      a.y += (b.shoulderC.y * this.H - a.y) * k
      a.T += (scale - a.T) * (1 - Math.exp(-dt * 1.2))
    }
  }

  /** 手腕配对（站点 B()）：双腕按总距离最小分配，单腕选更近目标 */
  private matchHands(b: Body, targets: [Pt, Pt]): (Pt | null)[] {
    const l = { x: b.lHand.x * this.W, y: b.lHand.y * this.H }
    const r = { x: b.rHand.x * this.W, y: b.rHand.y * this.H }
    const d = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y)
    const direct = d(l, targets[0]) + d(r, targets[1])
    const crossed = d(l, targets[1]) + d(r, targets[0])
    return crossed < direct ? [r, l] : [l, r]
  }

  /** 循环结算（站点 H()）：好手占比 ≥0.75 → 夸奖；>0.9「行云流水！」 */
  private evalCycle() {
    let any = false
    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const ratio = st.cycGood / Math.max(1, st.cycTicks * 2)
      st.cycTicks = 0
      st.cycGood = 0
      const b = this.players[i].body
      if (!b || ratio < 0.75) continue
      const a = this.anchors[i]
      this.say(ratio > 0.9 ? '行云流水！' : '好！', a.x, a.y - a.T * 0.95, this.players[i].color, 38 * this.unit)
      this.particles.burst(a.x, a.y - a.T * 0.6, '#ffd54a', 3, 140, 6)
      this.particles.burst(a.x, a.y - a.T * 0.6, this.players[i].color, 3, 140, 6)
      any = true
    }
    if (any) this.ctx.audio.combo() // 站点 chime
  }

  /** 计分 tick（站点 V()，每 0.2s）：双手贴住且够慢 → 每手 +1 */
  private scoreTick() {
    let nearSum = 0
    let slowSum = 0
    let handSum = 0
    let best = 0
    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const b = this.players[i].body
      if (!b) {
        st.streak = 0
        continue
      }
      let good = 0
      for (let h = 0; h < 2; h++) {
        st.handTicks++
        if (st.hand[h]) {
          if (st.near[h]) st.nearTicks++
          if (st.slow[h]) st.slowTicks++
          if (st.near[h] && st.slow[h]) good++
        }
      }
      st.cycTicks++
      st.cycGood += good
      if (good > 0) this.ctx.addScore(good)
      if (good === 2) {
        st.streak++
        st.best = Math.max(st.best, st.streak)
        if (st.streak % 30 === 0) this.ctx.audio.combo() // 站点 highlight
      } else {
        st.streak = 0
      }
      nearSum += st.nearTicks
      slowSum += st.slowTicks
      handSum += st.handTicks
      best = Math.max(best, st.best)
    }
    // 站点按玩家分别 e.stat；本框架 extra 是扁平键，按全场汇总（推断口径）
    this.ctx.setExtra('跟随准确率%', Math.round((nearSum / Math.max(1, handSum)) * 100))
    this.ctx.setExtra('平稳度%', Math.round((slowSum / Math.max(1, handSum)) * 100))
    this.ctx.setExtra('最长连贯秒', Math.round(best * SCORE_EVERY * 10) / 10)
  }

  /** 换体式横幅（站点 U()） */
  private announce(form: Form) {
    this.bannerText = form.name
    this.bannerSub = form.hint
    this.bannerMax = 1.8
    this.bannerT = this.bannerMax
    this.ctx.speak(`${form.name}，${form.hint}`)
    this.ctx.audio.pop() // 站点 appear
    this.ctx.setStage(`师傅 · ${form.name}`)
  }

  tick(_f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    for (let k = this.rings.length - 1; k >= 0; k--) {
      this.rings[k].age += dt
      if (this.rings[k].age > 0.5) this.rings.splice(k, 1)
    }
    this.followAnchors(dt)

    // 段切换：离开正式循环段 → 结算；新段 intro → 横幅
    const n = this.segAt(this.t)
    const idx = this.segs.indexOf(n)
    if (idx !== this.segIdx) {
      if (this.segIdx >= 0 && this.segs[this.segIdx].cycle >= 0) this.evalCycle()
      this.segIdx = idx
      if (n.intro) this.announce(n.form)
    }

    const targets = this.sample(this.t)
    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const b = this.players[i].body
      if (!b) {
        st.streak = 0
        continue
      }
      const a = this.anchors[i]
      const tg: [Pt, Pt] = [this.toScreen(i, targets[0]), this.toScreen(i, targets[1])]
      st.hand = this.matchHands(b, tg)
      let fast = -1
      for (let h = 0; h < 2; h++) {
        const p = st.hand[h]
        // 手速（归一化/s → px/s）与慢速上限（×T）比较
        const spd = (h === 0 ? b.lHandV : b.rHandV) * this.H
        st.near[h] = !!p && Math.hypot(p.x - tg[h].x, p.y - tg[h].y) / a.T < this.cfg.near
        st.slow[h] = spd / a.T < this.cfg.maxSpeed
        if (p && !st.slow[h]) fast = h
        const good = st.near[h] && st.slow[h]
        st.lock[h] += ((good ? 1 : 0) - st.lock[h]) * (1 - Math.exp(-dt * 6))
        // 尾迹：沿目标轨迹落点，寿命 2.4s，断续时 gap
        const tr = st.trails[h]
        for (const q of tr) q.age += dt
        while (tr.length && tr[0].age > TRAIL_LIFE) tr.shift()
        if (good) {
          const last = tr[tr.length - 1]
          if (!st.wasGood[h] || !last || Math.hypot(last.x - tg[h].x, last.y - tg[h].y) > 3 * this.unit) {
            tr.push({ x: tg[h].x, y: tg[h].y, age: 0, gap: !st.wasGood[h] })
          }
        }
        st.wasGood[h] = good
        if (good && Math.random() < dt * 3) {
          this.particles.burst(tg[h].x, tg[h].y, this.players[i].color, 1, 50, 3, 0)
        }
      }
      // 超速提醒：累计 >0.15s → 警示环 +「慢一点」（6s 语音节流，1.2s 视觉节流）
      if (fast >= 0) st.fastT += dt
      else st.fastT = Math.max(0, st.fastT - dt * 2)
      if (fast >= 0 && st.fastT > FAST_WARN_T && this.t > SLOW_SAY_T) {
        if (this.t > st.warnUntil) {
          const p = st.hand[fast]
          if (p) this.rings.push({ x: p.x, y: p.y, age: 0 })
          if (this.t - this.lastSlowSay > SLOW_SAY_GAP) {
            this.ctx.speak('慢一点')
            this.lastSlowSay = this.t
          }
        }
        st.warnUntil = this.t + 1.2
        st.warnHand = fast
      }
    }

    while (this.t >= this.tickAt) {
      this.scoreTick()
      this.tickAt += SCORE_EVERY
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    // 底：淡雅山水渐变（站点 taichi-bg 水墨背景的简化代理）
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, '#e8f1ea')
    g.addColorStop(0.6, '#f4f0e4')
    g.addColorStop(1, '#e9e4d6')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    c.fillStyle = 'rgba(120,140,120,.16)'
    for (const [mx, mw, mh] of [
      [0.16, 0.34, 0.3],
      [0.52, 0.4, 0.38],
      [0.86, 0.3, 0.26],
    ]) {
      c.beginPath()
      c.moveTo((mx - mw / 2) * this.W, this.H * 0.72)
      c.quadraticCurveTo(mx * this.W, (0.72 - mh) * this.H, (mx + mw / 2) * this.W, this.H * 0.72)
      c.fill()
    }

    const duo = this.dual()
    // 师傅 box（站点 W()）：单人居左上大图 / 双人顶部居中小图
    const boxT = this.H * (duo ? 0.1 : 0.12)
    const top = this.H * (duo ? 0.93 : 0.86)
    const boxX = duo ? this.W / 2 : Math.max(this.W * 0.12, top * 1.7)
    const boxY = top - boxT * 1.27

    const cur = this.segAt(this.t)
    const hands = this.sample(this.t)
    this.drawMaster(c, boxX, boxY, boxT, hands, cur.form.name)

    // 目标点 + 幽灵前瞻 + 尾迹 + 光球（每玩家）
    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const b = this.players[i].body
      if (!b) continue
      const col = this.players[i].color
      // 尾迹（站点：玩家色 35% 透明度，宽 T*(.05+.09*fade)，随年龄衰减）
      c.save()
      c.lineCap = 'round'
      c.lineJoin = 'round'
      for (const tr of st.trails) {
        for (let k = 1; k < tr.length; k++) {
          const p = tr[k]
          if (p.gap) continue
          const fade = 1 - p.age / TRAIL_LIFE
          c.strokeStyle = this.rgba(col, 0.35 * fade)
          c.lineWidth = this.anchors[i].T * (0.05 + 0.09 * fade)
          c.beginPath()
          c.moveTo(tr[k - 1].x, tr[k - 1].y)
          c.lineTo(p.x, p.y)
          c.stroke()
        }
      }
      c.restore()
      // 前瞻幽灵点：未来 16 个位置，每 0.16s 一个（站点）
      c.save()
      for (let k = 1; k <= 16; k++) {
        const fut = this.sample(this.t + k * 0.16)
        const s = 1 - k / 17
        c.fillStyle = this.rgba(col, 0.4 * s)
        for (const q of fut) {
          const p = this.toScreen(i, q)
          c.beginPath()
          c.arc(p.x, p.y, this.anchors[i].T * (0.018 + 0.03 * s), 0, Math.PI * 2)
          c.fill()
        }
      }
      c.restore()
      // 目标圈 + 光球
      const orbR = Math.max(13 * u, this.anchors[i].T * 0.13)
      for (let h = 0; h < 2; h++) {
        const tg = this.toScreen(i, hands[h])
        const lock = st.lock[h]
        c.save()
        c.beginPath()
        c.arc(tg.x, tg.y, this.cfg.near * this.anchors[i].T, 0, Math.PI * 2)
        c.fillStyle = this.rgba(col, 0.05 + 0.13 * lock)
        c.fill()
        c.lineWidth = (2 + 2 * lock) * u
        c.strokeStyle = this.rgba(col, 0.35 + 0.45 * lock)
        if (lock < 0.5) c.setLineDash([8 * u, 7 * u])
        c.stroke()
        c.restore()
        // 发光小球：呼吸脉动 1±.05 + lock*.18
        const f = 1 + Math.sin(this.t * 2 + h * 1.7 + i) * 0.05 + lock * 0.18
        const gr = c.createRadialGradient(tg.x, tg.y, 0, tg.x, tg.y, orbR * 4 * f)
        gr.addColorStop(0, '#ffffff')
        gr.addColorStop(0.45, col)
        gr.addColorStop(1, this.rgba(col, 0))
        c.fillStyle = gr
        c.beginPath()
        c.arc(tg.x, tg.y, orbR * 4 * f, 0, Math.PI * 2)
        c.fill()
        circle(c, tg.x, tg.y, orbR * 1.1 * f, '#ffffff')
      }
      // 超速警示环 +「慢一点」浮字
      if (this.t < st.warnUntil) {
        const p = st.hand[st.warnHand]
        if (p) {
          const a = this.anchors[i]
          txt(c, '慢一点', Math.max(70 * u, Math.min(this.W - 70 * u, p.x)), Math.max(130 * u, p.y - a.T * 0.62), Math.max(16, 24 * u), '#ffd166')
        }
      }
    }

    // 警示环特效（站点 fx.ring 扩散；age 在 tick 里推进）
    for (const rg of this.rings) {
      c.save()
      c.globalAlpha = 1 - rg.age / 0.5
      c.strokeStyle = '#ff9f1c'
      c.lineWidth = 6
      c.beginPath()
      c.arc(rg.x, rg.y, 20 + rg.age * 260, 0, Math.PI * 2)
      c.stroke()
      c.restore()
    }

    // 换体式横幅（站点 banner 紫色 1800ms）
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.2, 52, '#7c5cff')
      if (this.bannerSub) txt(c, this.bannerSub, this.W / 2, this.H * 0.2 + 44, 22, 'rgba(90,70,120,.9)')
      c.restore()
    }
  }

  /** 师傅简笔（站点太极师傅精灵的本地等价自绘）：道袍 + 斗笠 + 双手沿曲线 */
  private drawMaster(c: CanvasRenderingContext2D, x: number, y: number, T: number, hands: [Pt, Pt], name: string) {
    const headR = T * 0.24
    const headY = y - T * 1.0
    c.save()
    // 道袍（梯形）
    c.fillStyle = '#e7dcc8'
    c.strokeStyle = '#b7a988'
    c.lineWidth = T * 0.03
    c.beginPath()
    c.moveTo(x - T * 0.42, y + T * 0.55)
    c.quadraticCurveTo(x - T * 0.18, y - T * 0.55, x, y - T * 0.62)
    c.quadraticCurveTo(x + T * 0.18, y - T * 0.55, x + T * 0.42, y + T * 0.55)
    c.closePath()
    c.fill()
    c.stroke()
    // 腰带
    c.fillStyle = '#7c5cff'
    c.fillRect(x - T * 0.36, y + T * 0.05, T * 0.72, T * 0.09)
    // 头 + 斗笠
    circle(c, x, headY, headR, '#f3dcc0')
    c.fillStyle = '#9a86e0'
    c.beginPath()
    c.ellipse(x, headY - headR * 0.75, headR * 1.7, headR * 0.45, 0, 0, Math.PI * 2)
    c.fill()
    // 胡须
    c.fillStyle = '#e8e2d2'
    c.beginPath()
    c.moveTo(x - headR * 0.3, headY + headR * 0.3)
    c.quadraticCurveTo(x, headY + headR * 1.3, x + headR * 0.3, headY + headR * 0.3)
    c.fill()
    // 双臂沿目标曲线（肩在 y-T*0.35）
    c.strokeStyle = '#e7dcc8'
    c.lineWidth = T * 0.09
    c.lineCap = 'round'
    for (const hnd of hands) {
      c.beginPath()
      c.moveTo(x + (hnd.x > 0 ? T * 0.2 : -T * 0.2), y - T * 0.35)
      c.lineTo(x + hnd.x * T, y + hnd.y * T)
      c.stroke()
      const hx = x + hnd.x * T
      const hy = y + hnd.y * T
      circle(c, hx, hy, T * 0.1, '#f3dcc0')
      const gr = c.createRadialGradient(hx, hy, 0, hx, hy, T * 0.3)
      gr.addColorStop(0, 'rgba(255,255,255,.9)')
      gr.addColorStop(1, 'rgba(255,255,255,0)')
      c.fillStyle = gr
      c.beginPath()
      c.arc(hx, hy, T * 0.3, 0, Math.PI * 2)
      c.fill()
    }
    c.restore()
    // 标题「师傅 · 体式名」
    outlineTxt(c, `师傅 · ${name}`, x, headY - headR * 2.1, Math.max(15, 20 * this.unit), '#f4f0e4', 'rgba(60,80,60,.55)')
  }

  private rgba(col: string, a: number) {
    // 玩家色是 #rrggbb，转 rgba
    const n = parseInt(col.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
}

export default function create(ctx: GameContext) {
  return new TaichiGame(ctx)
}
