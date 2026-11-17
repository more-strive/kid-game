import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 打水漂（对齐 dongdongpark 真实规则，见 _reverse/reports/stone-skip.md）：
 * 手放腰边停稳 0.25s 武装（grip），再横着快甩——按 快/平/低 三要素质量算跳数；
 * 双挥取更优候选（0.22s 内不开新挥则发射）；每跳 +1 分，单颗上限 12 跳；
 * hard 关有逐颗递增的礁石（首跳距离不足必撞）；伪 3D 水面（k=3/(3+深度)）。
 */

/** 对齐站点难度表：grip 持稳判定(手距髋 y ×torso) / vMin 起挥阈值 / vTop 满分速度(躯干/s) /
 *  rGood/rBad "平"质量竖横速度比 / hGood/hBad "低"质量手高于髋距离 / waves 波浪系数 / reef 礁石开关 */
const DIFF = [
  { grip: 0.75, vMin: 2.5, vTop: 5.0, rGood: 0.3, rBad: 1.1, hGood: 0.4, hBad: 1.2, waves: 0, reef: false },
  { grip: 0.6, vMin: 3.0, vTop: 6.0, rGood: 0.2, rBad: 0.9, hGood: 0.25, hBad: 0.95, waves: 0.5, reef: false },
  { grip: 0.5, vMin: 3.2, vTop: 7.0, rGood: 0.15, rBad: 0.8, hGood: 0.2, hBad: 0.9, waves: 1.0, reef: true },
]
const STONES = 10 // 每人石头数（站点 v=10）
const MAX_SKIP = 12 // 单颗跳跃数上限（站点 y=12）
const PERSP = 3 // 伪 3D 透视常数（站点 b=3）
const SHORE_M = 1.5 // 水岸到地平线的米距（站点 x=1.5）
const STILL_T = 0.25 // 持稳需持续时长 s（站点 S=0.25）
const CAND_T = 0.22 // 两次挥臂间候选保留时长 s（站点 C=0.22）
const REEF_U = [-1.05, -0.38, 0.3, 0.98] // 礁石横向偏移（米）
const SOLO_LIMIT = 220 // 单人超时 s
const DUO_LIMIT = 360 // 双人超时 s
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/** 一次挥臂的累积记录（对齐站点 {dir,t0,peak,sx,sy,sdy,n}） */
interface SwingRec {
  dir: number
  t0: number
  peak: number
  sx: number
  sy: number
  sdy: number
  n: number
}

interface Sea {
  wave: number
  reef: number
}

interface Hop {
  d0: number
  d1: number
  arc: number
  dur: number
}

interface Flight {
  hops: Hop[]
  t: number
  u0: number // 出手横向米
  h0: number // 出手离水高度米
  dir: number
  n: number // 总跳数
  crash: boolean
  doneHops: number // 已结算跳数
  sinkT: number // 沉水/撞礁动画计时
  finished: boolean
}

interface Quality {
  s: number
  f: number
  h: number
}

interface PSkip {
  stones: number
  thrown: number
  armed: boolean
  still: number
  highFor: number
  swing: SwingRec | null
  cand: SwingRec | null
  candQ: number
  candAt: number
  swings: number
  armT: number
  tipT: number // 未武装计时（提示用）
  total: number
  best: number
  bestDist: number
  crashes: number
  quality: Quality | null
  lastN: number
  lastDist: number
  lastCrash: boolean
  flight: Flight | null
  settleT: number // 结算后等待
}

class StoneSkip extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  /** 水岸线 yS 与地平线 yH（站点 sprites 黑盒 → 等价取值） */
  yH = this.H * 0.4
  yS = this.H * 0.72
  ppm = (this.H * 0.72 - this.H * 0.4) / SHORE_M
  ps: [PSkip, PSkip]
  sea: Sea[] = [] // 每颗石头海况（第 n 颗礁石距离 2→3.9m 递增）
  turn = 0
  turnAt = 0 // 轮换生效时刻（发射后 1.1s）
  bannerT = 0
  bannerText = ''
  bannerSub = ''
  bannerColor = '#fff'
  endT = -1 // 全部扔完的结束等待
  endBanner = false
  finished = false
  score = 0
  flash = 0 // highlight 等价代理（命中高亮强度衰减）
  ripples: { x: number; y: number; life: number; max: number; big: boolean }[] = []
  sparkles: { u: number; d: number; ph: number }[] = []
  clouds: { x: number; y: number; w: number; v: number }[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    this.ps = [this.newPS(), this.newPS()]
    for (let i = 0; i < 56; i++) {
      this.sparkles.push({ u: (Math.random() * 2 - 1) * 8, d: 0.3 + Math.pow(Math.random(), 1.7) * 40, ph: Math.random() * 6 })
    }
    for (let i = 0; i < 4; i++) {
      this.clouds.push({ x: Math.random() * this.W, y: 40 + Math.random() * this.yH * 0.5, w: 120 + Math.random() * 160, v: 0.004 + Math.random() * 0.004 })
    }
  }

  private newPS(): PSkip {
    return {
      stones: STONES,
      thrown: 0,
      armed: false,
      still: 0,
      highFor: 0,
      swing: null,
      cand: null,
      candQ: 0,
      candAt: 0,
      swings: 0,
      armT: 0,
      tipT: 0,
      total: 0,
      best: 0,
      bestDist: 0,
      crashes: 0,
      quality: null,
      lastN: -1,
      lastDist: 0,
      lastCrash: false,
      flight: null,
      settleT: 0,
    }
  }

  /** 每颗石头海况 sea[n] = {wave: waves×rng, reef: 2+n×0.14+rng×0.6} */
  private seaOf(n: number): Sea {
    while (this.sea.length <= n) {
      const i = this.sea.length
      this.sea.push({
        wave: this.cfg.waves * Math.random(),
        reef: 2 + i * 0.14 + Math.random() * 0.6,
      })
    }
    return this.sea[n]
  }

  /** 伪 3D 坐标 W(view,u,d,h)：k=3/(3+max(0,d))（对齐站点） */
  private W3(u: number, d: number, h: number) {
    const k = PERSP / (PERSP + Math.max(0, d))
    return { x: this.W / 2 + u * this.ppm * k, y: this.yH + SHORE_M * this.ppm * k - h * this.ppm * k, k }
  }

  /** 玩家锚点 G()：双人 0.27W/0.73W，单人 0.5W */
  private anchor(pi: number) {
    const duo = this.players.filter((p) => p.body).length >= 2
    return duo ? (pi === 0 ? this.W * 0.27 : this.W * 0.73) : this.W * 0.5
  }

  /** 体感→屏幕比例 K()：(双人?74:86)×unit px/躯干 */
  private K() {
    const duo = this.players.filter((p) => p.body).length >= 2
    return (duo ? 74 : 86) * this.unit
  }

  tick(f: PoseFrame, dt: number) {
    const duo = this.players.filter((p) => p.body).length >= 2
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.flash = Math.max(0, this.flash - dt * 1.2)
    for (const cl of this.clouds) cl.x = (cl.x + cl.v * dt * 1000) % (this.W + 300)
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].life -= dt
      if (this.ripples[i].life <= 0) this.ripples.splice(i, 1)
    }
    if (this.ripples.length > 60) this.ripples.splice(0, this.ripples.length - 60)

    // 超时：单人 220s / 双人 360s
    if (!this.finished && this.t > (duo ? DUO_LIMIT : SOLO_LIMIT)) {
      this.finished = true
      this.ctx.finish()
      return
    }

    // 全部扔完 → 结束等待 → 横幅 → finish（对齐站点）
    const allDone = this.ps.every((st) => st.thrown >= STONES && !st.flight)
    if (allDone && !this.finished) {
      if (this.endT < 0) this.endT = 2.4
      this.endT -= dt
      if (this.endT <= 1.4 && !this.endBanner) {
        this.endBanner = true
        this.bannerText = '石头扔完啦！'
        this.bannerSub = ''
        this.bannerColor = '#3ddc97'
        this.bannerT = 1.4
        this.ctx.speak('石头扔完啦！')
      }
      if (this.endT <= 0) {
        this.finished = true
        this.ctx.finish()
        return
      }
    }

    // 回合开启 X(i)：单人上一颗结算后自动可再武装；双人发射后 1.1s 轮换（turn/turnAt 在 launch 里推进）
    if (!allDone && duo && this.ps[this.turn].thrown >= STONES) {
      const other = 1 - this.turn
      if (this.ps[other].thrown < STONES) this.turn = other
    }

    // 每玩家：武装/挥臂/飞行推进
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      if (pi === 1 && !duo) continue
      const canPlay = !duo || (pi === this.turn && this.t >= this.turnAt)
      if (canPlay) this.tickGripAndSwing(st, pi, f, dt)
      if (st.flight) this.tickFlight(st, dt)
    }

    this.ctx.setScore(this.score)
    const agg = this.ps.filter((_, i) => i === 0 || duo)
    this.ctx.setExtra('最多一次', Math.max(...agg.map((s) => s.best)))
    this.ctx.setExtra('最远(米)', Math.round(Math.max(...agg.map((s) => s.bestDist)) * 10) / 10)
    this.ctx.setExtra('撞礁', agg.reduce((n, s) => n + s.crashes, 0))
  }

  /** 持稳武装（grip）+ 防高举 + 挥臂采集 + 双挥发射（对齐站点 re()/Z()/Q()） */
  private tickGripAndSwing(st: PSkip, pi: number, f: PoseFrame, dt: number) {
    if (st.flight || st.thrown >= STONES) {
      st.armed = false
      st.still = 0
      return
    }
    const body = f.bodies[pi]
    if (!body) return
    const cfg = this.cfg
    const torsoN = Math.max(0.05, body.scale) // 归一化躯干
    const torsoPx = torsoN * this.H
    const hipY = body.hipC.y * this.H
    const hipX = body.hipC.x * this.W
    const hands = [
      { x: body.lHand.x * this.W, y: body.lHand.y * this.H, v: body.lHandV },
      { x: body.rHand.x * this.W, y: body.rHand.y * this.H, v: body.rHandV },
    ]
    // 持盘手 = 离髋高度最近的手
    const holdIdx = Math.abs(hands[0].y - hipY) <= Math.abs(hands[1].y - hipY) ? 0 : 1
    const hold = hands[holdIdx]
    const speedT = hold.v / torsoN // 躯干/s

    // 持稳武装：|手y−髋y| < grip×torso 且 |手x−髋x| < 1.5×torso 且合速度 <1.3
    const dyN = Math.abs(hold.y - hipY) / torsoPx
    const dxN = Math.abs(hold.x - hipX) / torsoPx
    const gripOk = dyN < cfg.grip && dxN < 1.5 && speedT < 1.3
    if (!st.armed) {
      if (gripOk) {
        st.still += dt
        if (st.still >= STILL_T) {
          st.armed = true
          st.armT = 0
          st.swings = 0
          this.ctx.audio.click() // 站点 sfx('click')
        }
      } else {
        st.still = Math.max(0, st.still - 2 * dt) // 未达标 2× 速率衰减
      }
      // 3.5s 冷却提示：就绪超 5s 仍未武装 → 手放到腰边
      st.tipT += dt
      if (st.tipT > 5 && st.still <= 0.01 && this.cooldownOk(pi)) {
        this.cd.set(pi, this.t)
        this.say('手放腰边', hold.x, hold.y - 50, '#e8590c', 32)
      }
    } else {
      st.armT += dt
      // 防高举：两只手都高于髋上 1×torso 持续 >1.2s → 取消武装
      const bothHigh = hands.every((h) => h.y < hipY - torsoPx)
      st.highFor = bothHigh ? st.highFor + dt : 0
      if (st.highFor > 1.2) {
        st.armed = false
        st.still = 0
        st.highFor = 0
        return
      }
      // 挥臂采集：横向速度最大的一只手
      const prevL = this.prevHand(pi, 0)
      const prevR = this.prevHand(pi, 1)
      let bestVx = 0
      let bestIdx = holdIdx
      for (let hi = 0; hi < 2; hi++) {
        const prev = hi === 0 ? prevL : prevR
        if (!prev) continue
        const vxPx = (hands[hi].x - prev.x) / Math.max(0.016, this.lastDt)
        if (Math.abs(vxPx) > Math.abs(bestVx)) {
          bestVx = vxPx
          bestIdx = hi
        }
      }
      const vxT = Math.abs(bestVx) / Math.max(0.016, this.lastDt) / torsoPx // 躯干/s
      const dir = Math.sign(bestVx) || 1
      const h = hands[bestIdx]
      if (st.swing) {
        // 累积：同方向且速度 ≥ 峰值×0.5 且 0.5s 内
        const sameDir = dir === st.swing.dir
        const fastEnough = vxT >= st.swing.peak * 0.5
        const inTime = this.t - st.swing.t0 < 0.5
        if (sameDir && fastEnough && inTime) {
          st.swing.peak = Math.max(st.swing.peak, vxT)
          st.swing.n++
          st.swing.sx += (vxT * dt) as number
          st.swing.sy += (Math.abs((h.y - (bestIdx === 0 ? prevL!.y : prevR!.y)) / Math.max(0.016, this.lastDt) / torsoPx) * dt)
          st.swing.sdy += ((h.y - hipY) / torsoPx) * vxT * dt
        } else {
          this.endSwing(st, pi, h)
        }
      } else if (st.armed && vxT > cfg.vMin) {
        // 开新挥
        st.swing = { dir, t0: this.t, peak: vxT, sx: 0, sy: 0, sdy: 0, n: 1 }
      }
      // 候选保留：0.22s 内不开新挥则用候选发射
      if (!st.swing && st.cand && this.t - st.candAt > CAND_T) {
        this.launch(st, pi, st.cand, h)
      }
    }
  }

  /** 上次 tick 的真实 dt */
  private lastDt = 1 / 30


  private prevHand(pi: number, hi: number): { x: number; y: number } | null {
    const trail = hi === 0 ? this.players[pi].lHand.trail : this.players[pi].rHand.trail
    if (trail.length < 2) return null
    return trail[trail.length - 2]
  }

  /** 挥臂结束：n<3 丢弃；否则质量评估 + 双挥机制（对齐站点 Z()） */
  private endSwing(st: PSkip, pi: number, hand: { x: number; y: number }) {
    const sw = st.swing
    st.swing = null
    if (!sw) return
    if (sw.n < 3) return
    const cfg = this.cfg
    const sx = Math.max(0.001, sw.sx)
    const s = 0.3 + 0.7 * Math.max(0, Math.min(1, (sw.peak - cfg.vMin) / (cfg.vTop - cfg.vMin)))
    const fq = 1 - 0.7 * Math.max(0, Math.min(1, (sw.sy / sx - cfg.rGood) / (cfg.rBad - cfg.rGood)))
    const hq = 1 - 0.7 * Math.max(0, Math.min(1, (-sw.sdy / sx - cfg.hGood) / (cfg.hBad - cfg.hGood)))
    const q = s * fq * hq
    st.quality = { s, f: fq, h: hq }
    // 第 1 次挥臂 s≥0.85（速度拉满）→ 立即发射；否则保留候选，等第 2 次挥臂
    const better = !st.cand || q > st.candQ
    if (better) {
      st.cand = sw
      st.candQ = q
    }
    st.candAt = this.t
    st.swings++
    if (st.swings >= 2 || s >= 0.85) {
      this.launch(st, pi, st.cand!, hand)
    }
  }

  /** 发射 Q()：首跳距离 + 跳数公式 + 逐跳衰减 + 礁石判定（对齐站点核心字面量） */
  private launch(st: PSkip, pi: number, sw: SwingRec, hand: { x: number; y: number }) {
    const cfg = this.cfg
    const duo = this.players.filter((p) => p.body).length >= 2
    const sx = Math.max(0.001, sw.sx)
    const s = 0.3 + 0.7 * Math.max(0, Math.min(1, (sw.peak - cfg.vMin) / (cfg.vTop - cfg.vMin)))
    const fq = 1 - 0.7 * Math.max(0, Math.min(1, (sw.sy / sx - cfg.rGood) / (cfg.rBad - cfg.rGood)))
    const hq = 1 - 0.7 * Math.max(0, Math.min(1, (-sw.sdy / sx - cfg.hGood) / (cfg.hBad - cfg.hGood)))
    const q = s * fq * hq
    st.quality = { s, f: fq, h: hq }
    st.cand = null
    st.candQ = 0
    st.swing = null
    st.armed = false
    st.still = 0
    st.swings = 0

    const sea = this.seaOf(st.thrown)
    const anchorX = this.anchor(pi)
    const u0 = (hand.x - anchorX) / this.ppm // 出手横向米（屏幕换算等价代理）
    const h0 = Math.max(0.05, Math.min(1.5, (this.yS - hand.y) / this.ppm))
    const o = Math.max(0, Math.min(1, (s - 0.3) / 0.7))
    const l = 1.4 + 3.6 * o + 1.2 * q
    // 礁石（仅 hard）：首跳距离不足 → 撞礁，弹道止于 reef−0.15
    const crash = cfg.reef && l < sea.reef + 0.45
    const n = crash ? 0 : Math.max(1, Math.min(MAX_SKIP, Math.round(1 + 11 * Math.pow(q, 1.5) * (1 - 0.15 * sea.wave))))
    const decay = 0.7 + 0.16 * fq
    const hops: Hop[] = []
    if (crash) {
      hops.push({ d0: 0, d1: sea.reef - 0.15, arc: 0.3, dur: 0.42 })
    } else {
      let d = l
      const firstArc = 0.15 + 0.05 * n + (1 - fq) * 0.6
      const firstDur = 0.3 + 0.07 * n
      hops.push({ d0: 0, d1: d, arc: firstArc, dur: firstDur })
      for (let i = 1; i < n; i++) {
        const nd = d * decay
        hops.push({ d0: d, d1: nd, arc: 0.09 * n, dur: 0.08 + 0.1 * Math.sqrt(n) })
        d = nd
      }
      hops.push({ d0: d, d1: d + 0.55 * Math.pow(decay, n), arc: 0, dur: 0.5 }) // 末段滑水
    }
    st.flight = {
      hops,
      t: 0,
      u0,
      h0,
      dir: sw.dir,
      n,
      crash,
      doneHops: 0,
      sinkT: 0,
      finished: false,
    }
    st.thrown++
    st.lastN = -1
    st.lastDist = 0
    st.lastCrash = crash
    this.ctx.audio.slash() // 站点 whoosh

    // 双人轮换：F = 对手仍有石头 ? 对手 : 自己，1.1s 后生效（对齐站点）
    if (duo) {
      const other = 1 - pi
      this.turn = this.ps[other].thrown < STONES ? other : pi
      this.turnAt = this.t + 1.1
    } else {
      st.settleT = 0
    }
  }

  /** 飞行播放 ee() + 每跳结算 te() + 终局 ne()（对齐站点） */
  private tickFlight(st: PSkip, dt: number) {
    const fl = st.flight!
    fl.t += dt
    // 逐跳结算
    let acc = 0
    for (let i = 0; i < fl.hops.length; i++) acc += fl.hops[i].dur
    let elapsed = 0
    let hopIdx = -1
    for (let i = 0; i < fl.hops.length; i++) {
      elapsed += fl.hops[i].dur
      if (fl.t <= elapsed) {
        hopIdx = i
        break
      }
    }
    if (hopIdx === -1) hopIdx = fl.hops.length - 1
    // 结算跳过首段（首段落地 = 第 1 跳）
    const hopsToSettle = Math.min(hopIdx, fl.crash ? 0 : fl.n)
    while (fl.doneHops < hopsToSettle) {
      fl.doneHops++
      const hop = fl.hops[fl.doneHops - 1]
      const p = this.W3(fl.u0 + fl.dir * 0.035 * hop.d1, hop.d1, 0)
      this.ripples.push({ x: p.x, y: p.y, life: 1.6, max: 1.6, big: false })
      this.particles.burst(p.x, p.y, '#bfe3ff', 4, 260 * this.unit * (0.3 + p.k), 4 * this.unit, 500)
      this.score++ // 每跳 +1（对齐站点 te() score(owner,1)）
      this.say(`${fl.doneHops}`, p.x, p.y - 26 * this.unit, '#ffffff', 24 + fl.doneHops * 2)
      this.ctx.audio.play('drop', 0.7, 0.75 + fl.doneHops * 0.07) // 站点 bubble 音高逐跳升高
      this.flash = Math.max(this.flash, 0.5)
    }
    // 全部跳数播完 → 沉水/撞礁
    if (!fl.finished && fl.t >= acc) {
      fl.finished = true
      fl.sinkT = 0
      const lastHop = fl.hops[fl.hops.length - 1]
      const endD = lastHop.d1
      const p = this.W3(fl.u0 + fl.dir * 0.035 * endD, endD, 0)
      if (fl.crash) {
        st.crashes++
        this.ctx.audio.hit() // thud
        this.ctx.audio.play('hit', 0.8, 0.8) // crack
        this.shakeT = 0.35
        this.particles.burst(p.x, p.y, '#8a8a99', 10, 300 * this.unit, 6 * this.unit)
        this.say('撞到礁石啦，甩快一点！', p.x, p.y - 40 * this.unit, '#ff6b6b', 30)
      } else {
        this.ctx.audio.drop() // splash
        this.ripples.push({ x: p.x, y: p.y, life: 1.6, max: 1.6, big: true })
        this.ripples.push({ x: p.x, y: p.y, life: 1.35, max: 1.35, big: false })
        this.particles.burst(p.x, p.y, '#bfe3ff', 8, 340 * this.unit, 5 * this.unit, 600)
      }
      // 统计 + 播报（对齐站点 ne()）
      st.total += fl.n
      st.best = Math.max(st.best, fl.n)
      if (!fl.crash) st.bestDist = Math.max(st.bestDist, endD)
      st.lastN = fl.n
      st.lastDist = endD
      const q = st.quality
      const weakest: [string, number][] = q ? [['快', q.s], ['平', q.f], ['低', q.h]] : []
      weakest.sort((a, b) => a[1] - b[1])
      const great = q && Math.min(q.s, q.f, q.h) >= 0.82
      if (fl.n >= 10) {
        this.bannerText = `${fl.n} 跳！`
        this.bannerSub = fl.n >= 12 ? '满分一甩！' : '又快又平又低'
        this.bannerColor = '#ffd54a'
        this.bannerT = 1.6
        this.ctx.speak(`${CN_NUM[Math.min(12, fl.n)]}跳！太棒了！`)
        this.ctx.audio.play('win', 0.9) // tada
        this.particles.burst(p.x, p.y, '#ffd54a', 10, 340 * this.unit, 12 * this.unit)
        this.flash = 2
      } else if (fl.n >= 7) {
        this.ctx.audio.play('score', 0.8, 1 + Math.min(5, fl.n - 6) * 0.1) // 站点 chime(min(5, n−6))
        this.flash = 1
      } else {
        this.flash = 0.3
      }
      // 教学语（非 great，双人仅前 3 颗）：按最弱项提示
      const duoNow = this.players.filter((q) => q.body).length >= 2
      if (!great && fl.n >= 1 && !(duoNow && st.thrown > 3)) {
        const tip = weakest[0]?.[0]
        if (tip === '快') this.ctx.speak('再甩快一点！')
        else if (tip === '平') this.ctx.speak('横着平平地甩！')
        else if (tip === '低') this.ctx.speak('再低一点，贴着水面！')
      }
      st.settleT = 0.6 // 单人 0.6s 后自动开下一颗
      st.flight = null
    }
    if (fl.finished) fl.sinkT += dt
  }

  private shakeT = 0

  /** 提示冷却（3.5s），按玩家记录上次提示时刻 */
  private cd = new Map<number, number>()

  private cooldownOk(pi: number): boolean {
    const t0 = this.cd.get(pi)
    return !t0 || this.t - t0 > 3.5
  }



  update(f: PoseFrame, dt: number) {
    this.lastDt = dt
    this.shakeT = Math.max(0, this.shakeT - dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    const u = this.unit
    const duo = this.players.filter((p) => p.body).length >= 2
    c.save()
    if (this.shakeT > 0) {
      const amp = 7 * (this.shakeT / 0.35)
      c.translate(Math.sin(this.t * 70) * amp, Math.cos(this.t * 63) * amp * 0.5)
    }

    // 天空 + 云 + 地平线
    const sky = c.createLinearGradient(0, 0, 0, this.yH)
    sky.addColorStop(0, '#a8d8f0')
    sky.addColorStop(1, '#dff1fa')
    c.fillStyle = sky
    c.fillRect(0, 0, this.W, this.yH)
    c.fillStyle = 'rgba(255,255,255,.8)'
    for (const cl of this.clouds) {
      c.beginPath()
      c.ellipse(cl.x, cl.y, cl.w * 0.5, cl.w * 0.16, 0, 0, Math.PI * 2)
      c.ellipse(cl.x - cl.w * 0.25, cl.y + cl.w * 0.06, cl.w * 0.3, cl.w * 0.12, 0, 0, Math.PI * 2)
      c.ellipse(cl.x + cl.w * 0.28, cl.y + cl.w * 0.05, cl.w * 0.26, cl.w * 0.1, 0, 0, Math.PI * 2)
      c.fill()
    }
    // 水面
    const water = c.createLinearGradient(0, this.yH, 0, this.H)
    water.addColorStop(0, '#5ba8c9')
    water.addColorStop(1, '#3f7fa8')
    c.fillStyle = water
    c.fillRect(0, this.yH, this.W, this.H - this.yH)
    // 水面闪光点
    c.fillStyle = 'rgba(255,255,255,.35)'
    for (const sp of this.sparkles) {
      const p = this.W3(sp.u, sp.d, 0)
      const tw = 0.5 + 0.5 * Math.sin(this.t * 2 + sp.ph)
      c.globalAlpha = 0.3 * tw
      c.beginPath()
      c.ellipse(p.x, p.y, 5 * u * p.k, 1.6 * u * p.k, 0, 0, Math.PI * 2)
      c.fill()
    }
    c.globalAlpha = 1

    // 浮标 5/10/20 米（双人居中，单人整体左移 2.3m）
    const buoyU = duo ? 0 : -2.3
    for (const d of [5, 10, 20]) {
      const p = this.W3(buoyU, d, 0)
      circle(c, p.x, p.y - 6 * u * p.k, 5 * u * p.k, '#e63946')
      c.fillStyle = 'rgba(255,255,255,.5)'
      c.fillRect(p.x - 8 * u * p.k, p.y - 1 * u, 16 * u * p.k, 2 * u)
      txt(c, `${d}米`, p.x + 22 * u, p.y - 8 * u, 14 * u, 'rgba(255,255,255,.6)')
    }

    for (let pi = 0; pi < 2; pi++) {
      if (pi === 1 && !duo) continue
      const st = this.ps[pi]
      const anchorX = this.anchor(pi)

      // 礁石（hard）：4 块横向偏移 ×（双人 0.8），回合开始 0.5s 内升起
      if (this.cfg.reef && st.thrown < STONES) {
        const sea = this.seaOf(st.thrown)
        const alpha = st.flight ? 1 : 0.85
        for (const ru of REEF_U) {
          const rp = this.W3((anchorX - this.W / 2) / this.ppm + ru * (duo ? 0.8 : 1), sea.reef, 0)
          c.save()
          c.globalAlpha = alpha
          c.fillStyle = '#6d6875'
          c.beginPath()
          c.moveTo(rp.x - 16 * u * rp.k, rp.y)
          c.lineTo(rp.x - 6 * u * rp.k, rp.y - 22 * u * rp.k)
          c.lineTo(rp.x + 5 * u * rp.k, rp.y - 14 * u * rp.k)
          c.lineTo(rp.x + 14 * u * rp.k, rp.y)
          c.closePath()
          c.fill()
          c.restore()
        }
        if (duo || this.t < 1e8) {
          const lastRock = this.W3((anchorX - this.W / 2) / this.ppm + REEF_U[3] * (duo ? 0.8 : 1), sea.reef, 0)
          txt(c, `礁石 ${sea.reef.toFixed(1)}米`, lastRock.x + 40 * u, lastRock.y - 20 * u, 15 * u, 'rgba(255,255,255,.7)')
        }
      }

      // 水面目标区 se()：上沿 yS−hGood×K、下沿 yS+0.3×K；手在区内变绿
      const K = this.K()
      const body = this.players[pi].body
      if (body && st.thrown < STONES) {
        const dl = Math.abs(body.lHand.y * this.H - body.hipC.y * this.H)
        const dr = Math.abs(body.rHand.y * this.H - body.hipC.y * this.H)
        const holdY = dl <= dr ? body.lHand.y * this.H : body.rHand.y * this.H
        const zTop = this.yS - this.cfg.hGood * K
        const zBot = this.yS + 0.3 * K
        const inZone = holdY >= zTop && holdY <= zBot
        const zx0 = anchorX - 130 * u
        const zx1 = anchorX + 130 * u
        c.save()
        c.globalAlpha = 0.85
        rr(c, zx0, zTop, zx1 - zx0, zBot - zTop, 12 * u)
        c.fillStyle = inZone ? 'rgba(61,220,151,.3)' : 'rgba(255,255,255,.16)'
        c.fill()
        c.strokeStyle = inZone ? '#2a9d5c' : 'rgba(255,255,255,.4)'
        c.lineWidth = 2.5 * u
        c.setLineDash([10, 8])
        c.lineDashOffset = this.t * 30
        c.stroke()
        c.setLineDash([])
        c.restore()
      }

      // 手部状态环：未武装白圈 + 进度弧；武装黄色脉冲
      if (body && st.thrown < STONES) {
        const holdIdx = Math.abs(body.lHand.y - body.hipC.y) <= Math.abs(body.rHand.y - body.hipC.y) ? 0 : 1
        const hx = (holdIdx === 0 ? body.lHand.x : body.rHand.x) * this.W
        const hy = (holdIdx === 0 ? body.lHand.y : body.rHand.y) * this.H
        if (!st.armed) {
          c.save()
          c.strokeStyle = 'rgba(255,255,255,.7)'
          c.lineWidth = 4 * u
          c.beginPath()
          c.arc(hx, hy, 26 * u, 0, Math.PI * 2)
          c.stroke()
          c.strokeStyle = this.players[pi].color
          c.lineWidth = 5 * u
          c.beginPath()
          c.arc(hx, hy, 26 * u, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (st.still / STILL_T))
          c.stroke()
          c.restore()
        } else {
          c.save()
          c.globalAlpha = 0.25 + 0.2 * Math.sin(this.t * 8)
          c.strokeStyle = '#ffd54a'
          c.lineWidth = 7 * u
          c.beginPath()
          c.arc(hx, hy, 34 * u, 0, Math.PI * 2)
          c.stroke()
          c.restore()
        }
      }

      // 虚线挥臂轨迹预览（仅前 2 颗或武装超 3s 时显示）
      if (body && st.armed && st.thrown < STONES && (st.thrown < 2 || st.armT > 3)) {
        const holdIdx2 = Math.abs(body.lHand.y - body.hipC.y) <= Math.abs(body.rHand.y - body.hipC.y) ? 0 : 1
        const hx = (holdIdx2 === 0 ? body.lHand.x : body.rHand.x) * this.W
        const hy = (holdIdx2 === 0 ? body.lHand.y : body.rHand.y) * this.H
        const endP = this.W3((hx - this.W / 2) / this.ppm + 1.2, 1.2, 0)
        c.save()
        c.setLineDash([9, 9])
        c.lineDashOffset = -this.t * 60
        c.strokeStyle = 'rgba(255,255,255,.55)'
        c.lineWidth = 3 * u
        c.beginPath()
        c.moveTo(hx, hy)
        c.quadraticCurveTo((hx + endP.x) / 2, Math.min(hy, endP.y) - 40 * u, endP.x, endP.y)
        c.stroke()
        c.setLineDash([])
        // 箭头
        const ang = Math.atan2(endP.y - hy, endP.x - hx)
        c.translate(endP.x, endP.y)
        c.rotate(ang)
        c.fillStyle = 'rgba(255,255,255,.7)'
        c.beginPath()
        c.moveTo(0, 0)
        c.lineTo(-12 * u, -6 * u)
        c.lineTo(-12 * u, 6 * u)
        c.closePath()
        c.fill()
        c.restore()
      }

      // 石头堆：按 4/3/2/1 金字塔排剩余石头 + ×N
      const remain = STONES - st.thrown
      if (remain > 0) {
        const px0 = pi === 0 ? anchorX - 200 * u : anchorX + 200 * u
        let placed = 0
        for (const row of [4, 3, 2, 1]) {
          for (let i = 0; i < row && placed < remain; i++, placed++) {
            const sx = px0 + (i - (row - 1) / 2) * 26 * u * (pi === 0 ? 1 : -1)
            const sy = this.H - 60 * u - (placed >= 7 ? 26 * u : placed >= 4 ? 13 * u : 0)
            circle(c, sx, sy, 11 * u, '#9aa2ad')
            c.strokeStyle = 'rgba(50,56,70,.5)'
            c.lineWidth = 2 * u
            c.stroke()
          }
        }
        txt(c, `×${remain}`, px0, this.H - 110 * u, 22, '#fff')
      }

      // 飞行石头 + 涟漪
      if (st.flight) this.paintFlight(c, st.flight, u)
    }

    // 涟漪（白色双椭圆扩散，深度压扁）
    for (const rp of this.ripples) {
      const k = 1 - rp.life / rp.max
      c.save()
      c.globalAlpha = Math.max(0, rp.life / rp.max) * 0.8
      c.strokeStyle = '#fff'
      c.lineWidth = 3 * u
      c.beginPath()
      c.ellipse(rp.x, rp.y, 8 * u + 60 * u * k, (8 * u + 60 * u * k) * 0.28, 0, 0, Math.PI * 2)
      c.stroke()
      if (rp.big) {
        c.beginPath()
        c.ellipse(rp.x, rp.y, 4 * u + 40 * u * k, (4 * u + 40 * u * k) * 0.28, 0, 0, Math.PI * 2)
        c.stroke()
      }
      c.restore()
    }

    // 结算面板（最近一颗）
    const showPi = duo ? this.turn : 0
    const st = this.ps[showPi]
    if (st.lastN >= 0 && !st.flight) {
      const px = duo ? (showPi === 0 ? this.W * 0.27 : this.W * 0.73) : this.W * 0.5
      const py = 110 * u
      rr(c, px - 130 * u, py, 260 * u, 118 * u, 14 * u)
      c.fillStyle = 'rgba(20,26,60,.6)'
      c.fill()
      outlineTxt(c, st.lastCrash ? '撞礁了！' : `${st.lastN} 跳`, px, py + 28 * u, 32, st.lastCrash ? '#ff6b6b' : '#3ddc97')
      txt(c, `第 ${st.thrown} 颗 · 飞了 ${st.lastDist.toFixed(1)} 米`, px, py + 56 * u, 16, 'rgba(255,255,255,.8)')
      // 三色质量条
      if (st.quality) {
        const bars: [string, number][] = [
          ['快', st.quality.s],
          ['平', st.quality.f],
          ['低', st.quality.h],
        ]
        bars.forEach(([label, v], i) => {
          const bx = px - 100 * u + i * 70 * u
          const by = py + 76 * u
          txt(c, label, bx - 14 * u, by + 8 * u, 15, '#fff')
          rr(c, bx, by, 52 * u, 12 * u, 6 * u)
          c.fillStyle = v >= 0.85 ? '#3ddc97' : v >= 0.6 ? '#ffd54a' : '#ff9f43'
          c.fillRect(bx, by, 52 * u * v, 12 * u)
        })
      }
    }

    // 活跃玩家头顶三角指针（双人）
    if (duo) {
      const ax = this.anchor(this.turn)
      c.save()
      c.globalAlpha = 0.6 + Math.sin(this.t * 6) * 0.3
      c.fillStyle = '#ffd54a'
      c.beginPath()
      c.moveTo(ax, 74 * u)
      c.lineTo(ax - 14 * u, 94 * u)
      c.lineTo(ax + 14 * u, 94 * u)
      c.closePath()
      c.fill()
      c.restore()
    }

    c.restore()

    if (this.flash > 0.05) {
      c.save()
      c.globalAlpha = Math.min(0.25, this.flash * 0.12)
      c.fillStyle = '#fff'
      c.fillRect(0, 0, this.W, this.H)
      c.restore()
    }
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.22, 54, this.bannerColor)
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.22 + 54, 30, '#fff')
      c.globalAlpha = 1
    }
    txt(c, '手放腰边停一下拿稳，再横着快快一甩！越快、越平、越低，跳得越多', this.W / 2, this.H - 26, 20, 'rgba(255,255,255,.9)', 'center', 'bold')
  }

  /** 飞行石头：首段从手位置滑入水面，后续每跳抛物线；带水面阴影 */
  private paintFlight(c: CanvasRenderingContext2D, fl: Flight, u: number) {
    let elapsed = 0
    let seg = -1
    let segT = 0
    for (let i = 0; i < fl.hops.length; i++) {
      if (fl.t <= elapsed + fl.hops[i].dur) {
        seg = i
        segT = (fl.t - elapsed) / fl.hops[i].dur
        break
      }
      elapsed += fl.hops[i].dur
    }
    if (seg === -1) {
      seg = fl.hops.length - 1
      segT = 1
    }
    const hop = fl.hops[seg]
    const d = hop.d0 + (hop.d1 - hop.d0) * segT
    // 高度：首段从 h0 滑入水面，跳段抛物线 arc×4a(1−a)
    let h: number
    if (seg === 0) h = fl.h0 * (1 - segT) + hop.arc * 4 * segT * (1 - segT)
    else h = hop.arc * 4 * segT * (1 - segT)
    if (fl.finished) h = Math.max(0, h - fl.sinkT * 1.5) // 沉水下沉
    const p = this.W3(fl.u0 + fl.dir * 0.035 * d, d, h)
    // 阴影
    const sp = this.W3(fl.u0 + fl.dir * 0.035 * d, d, 0)
    c.save()
    c.globalAlpha = 0.25
    c.beginPath()
    c.ellipse(sp.x, sp.y, 9 * u * sp.k, 3 * u * sp.k, 0, 0, Math.PI * 2)
    c.fillStyle = '#000'
    c.fill()
    c.restore()
    // 石头
    c.save()
    c.translate(p.x, p.y)
    c.rotate(this.t * 14)
    circle(c, 0, 0, 17 * u * (0.28 + 0.72 * p.k), '#9aa2ad')
    c.strokeStyle = 'rgba(50,56,70,.6)'
    c.lineWidth = 2 * u
    c.stroke()
    c.beginPath()
    c.arc(-3 * u, -2 * u, 4 * u * (0.28 + 0.72 * p.k), 0, Math.PI * 2)
    c.fillStyle = 'rgba(255,255,255,.4)'
    c.fill()
    c.restore()
  }
}

export default function create(ctx: GameContext) {
  return new StoneSkip(ctx)
}
