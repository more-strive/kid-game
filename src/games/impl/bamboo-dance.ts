import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, emoji, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 跳竹竿（对齐 dongdongpark bamboo-dance 真实规则，逆向报告 _reverse/reports/bamboo-dance.md）：
 * 鼓点驱动的双脚开合跳跃——竹竿开（close=false）要求并脚跳进中间；竹竿合（close=true）要求
 * 从中间分脚跳出（上一拍必须曾在竿内）；夹脚 3 次进强制休息；连对每 10 拍庆祝；双人全中一小节有默契奖励。
 * 判定/休息/连对/默契/AI 哈希全部照抄站点源码 game-D7XQQoCy.js。
 * 站点框架黑盒量的等价代理（注释注明）：
 * - motion.feetApart 双脚距离归一值 → |双踝横距|/肩踝距（与 counter-kit 开合跳同标尺），阈值照抄站点字面量
 * - 站点 sfx drum/click/whoosh/sparkle/chime/oops → 用最近似采样等价代理
 * - 站点 big（大屏/TV 模式）专属 UI（时间轴并/分文字、BPM 副标题、额外统计）按手机版口径省略
 * - 站点 demo 机器人的 ai() 虚拟姿态：本工程演示模式由 sim 骨架驱动，等价能力已由判定层天然覆盖
 */

/** 难度表（报告 §1 字面量）：起始/末段 BPM、每段交替模式概率、判定提前/延后秒、并脚/分脚阈值 */
const DIFF = [
  { bpm0: 72, bpm1: 92, alt: [0, 0, 0, 0], early: 0.24, late: 0.3, together: 0.75, apart: 0.9 },
  { bpm0: 84, bpm1: 108, alt: [0, 0, 0.2, 0.3], early: 0.2, late: 0.26, together: 0.7, apart: 1.0 },
  { bpm0: 96, bpm1: 124, alt: [0.25, 0.4, 0.5, 0.6], early: 0.18, late: 0.22, together: 0.68, apart: 1.05 },
]
const FIRST_BEAT = 0.8 // y：第一个预备拍时刻（秒）
const COUNT_IN = 3 // b：预备拍数（count，不计分）
const LIVES = 3 // x：被夹 3 次进休息
const OPEN_PAT = [false, false, true] // S：开-开-合 三拍模式
const ALT_PAT = [false, true, false, true] // C：开-合-开-合 交替模式
const GAP_CLOSE = 0.07 // w：竹竿合拢间距（×躯干）
const GAP_OPEN = 0.62 // T：竹竿张开间距（×躯干）
const LOOKAHEAD = 2.4 // D：底部时间轴前瞻秒
const REST_DELAY = 1.2 // 夹满后从 t+1.2 起找下一个「首拍」作为复活点
const OPEN_SEC = 1.8 // 开场 banner（1800ms）

interface Beat {
  t: number
  close: boolean
  count: boolean
  first: boolean
  level: number
  bpm: number
}

interface Bar {
  from: number
  to: number
}

type Res = 'hit' | 'miss' | 'pinch' | 'idle' | 'rest' | 'skip' | 'count' | null

interface PS {
  res: Res[]
  cursor: number
  lives: number
  restUntil: number
  inDance: boolean
  streak: number
  best: number
  hits: number
  judged: number
  pinches: number
  lastTogether: number
  lastApart: number
  pinchAt: number
  view: { init: boolean; cx: number; fy: number; T: number }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

/** 站点 motion.feetApart 的等价代理：|双踝横距| / 肩踝距（站姿并脚≈0.3、分脚跳开≈1.4 量级） */
function feetApartOf(b: Body) {
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const anY = (b.lm[27].y + b.lm[28].y) / 2
  const span = Math.max(0.06, Math.abs(anY - shY))
  return Math.abs(b.lFoot.x - b.rFoot.x) / span
}

class BambooDance extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  beats: Beat[] = []
  bars: Bar[] = []
  ps: PS[] = []
  score = 0
  fastest = 0
  schedPtr = 0
  syncPtr = 0
  seenLevel = 0
  openShown = false
  bannerText = ''
  bannerSub = ''
  bannerT = 0
  shakeT = 0
  shakeMag = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.fastest = this.cfg.bpm0
    // 鼓点/竹竿序列（照抄源码 create）：3 个预备拍 + 按 4 段 BPM 循环生成小节（开开合 / 开合开合）
    const dur = this.ctx.meta.duration || 60
    let t = FIRST_BEAT
    for (let i = 0; i < COUNT_IN; i++) {
      this.beats.push({ t, close: false, count: true, first: i === 0, level: 0, bpm: this.cfg.bpm0 })
      t += 60 / this.cfg.bpm0
    }
    while (t < dur + 1) {
      const level = Math.min(3, Math.floor((t / dur) * 4))
      const bpm = Math.round(this.cfg.bpm0 + ((this.cfg.bpm1 - this.cfg.bpm0) * level) / 3)
      const pat = Math.random() < this.cfg.alt[level] ? ALT_PAT : OPEN_PAT
      const from = this.beats.length
      pat.forEach((close, i) => {
        this.beats.push({ t, close, count: false, first: i === 0, level, bpm })
        t += 60 / bpm
      })
      this.bars.push({ from, to: this.beats.length - 1 })
    }
    this.ps = [this.newPS(), this.newPS()] // 必须在鼓点序列生成后再建判定状态（res 按拍数建表）
  }

  private newPS(): PS {
    return {
      res: this.beats.map(() => null),
      cursor: 0,
      lives: LIVES,
      restUntil: -1,
      inDance: true,
      streak: 0,
      best: 0,
      hits: 0,
      judged: 0,
      pinches: 0,
      lastTogether: -9,
      lastApart: -9,
      pinchAt: -9,
      view: { init: false, cx: 0, fy: 0, T: 1 },
    }
  }

  private banner(text: string, sec: number, sub = '') {
    this.bannerText = text
    this.bannerSub = sub
    this.bannerT = sec
  }

  private shake(mag: number, sec: number) {
    this.shakeMag = mag
    this.shakeT = sec
  }

  /** 记判定并推进 cursor（源码 W） */
  private setRes(ps: PS, n: number, v: Res) {
    ps.res[n] = v
    while (ps.cursor < this.beats.length && ps.res[ps.cursor]) ps.cursor++
  }

  /** 命中（源码 K） */
  private onHit(pi: number, n: number) {
    const ps = this.ps[pi]
    const bt = this.beats[n]
    this.setRes(ps, n, 'hit')
    ps.hits++
    ps.judged++
    ps.streak++
    ps.best = Math.max(ps.best, ps.streak)
    if (bt.close) ps.inDance = true
    this.score++
    this.ctx.audio.play('pop', 0.8, 1 + Math.min(0.4, ps.streak * 0.02))
    if (ps.streak % 10 === 0) {
      this.banner(`连对 ${ps.streak} 拍！`, 1)
      this.ctx.audio.combo() // 站点 sfx('sparkle') 等价代理
      // 12 颗星星粒子（黄/绿/白）
      const v = ps.view
      this.particles.burst(v.cx, v.fy - v.T * 0.3, '#ffd54a', 4, 320, 7)
      this.particles.burst(v.cx, v.fy - v.T * 0.3, '#3ddc97', 4, 320, 7)
      this.particles.burst(v.cx, v.fy - v.T * 0.3, '#ffffff', 4, 320, 7)
    }
  }

  /** 未并脚/未跳出（源码 q）：断连不扣命 */
  private onMiss(ps: PS, n: number) {
    this.setRes(ps, n, 'miss')
    ps.judged++
    ps.streak = 0
  }

  /** 被夹（源码 J）：扣命，3 次进休息 */
  private onPinch(pi: number, n: number) {
    const ps = this.ps[pi]
    const v = ps.view
    this.setRes(ps, n, 'pinch')
    ps.judged++
    ps.streak = 0
    ps.pinches++
    ps.lives--
    ps.inDance = false
    ps.pinchAt = this.t
    this.ctx.audio.fail() // 站点 sfx('oops')
    this.shake(6, 0.3)
    this.particles.burst(v.cx, v.fy, '#ffd54a', 5, 240, 7)
    this.particles.burst(v.cx, v.fy, '#ff5c5c', 4, 240, 7)
    if (ps.lives <= 0) {
      // 休息起点：t+1.2 后第一个非预备「首拍」时刻 − early − 0.01（源码逐字）
      const target = this.t + REST_DELAY
      const bt2 = this.beats.find((x) => !x.count && x.first && x.t >= target)
      ps.restUntil = bt2 ? bt2.t - this.cfg.early - 0.01 : Infinity
      this.say('夹到三次啦，歇一下！', v.cx, v.fy - v.T * 1.6, '#ff8a8a', 38)
    } else {
      this.say('夹到脚啦！', v.cx, v.fy - v.T * 1.4, '#ff8a8a', 40)
    }
  }

  /** 单玩家判定（源码 Y，逐行对齐） */
  private judge(pi: number, b: Body | null) {
    const ps = this.ps[pi]
    const A = this.cfg
    const t = this.t
    const o = b ? feetApartOf(b) : 1
    const togetherNow = Boolean(b) && o < A.together
    const apartNow = Boolean(b) && o > A.apart
    if (togetherNow) ps.lastTogether = t
    if (apartNow) ps.lastApart = t
    // 休息到点自动复活
    if (ps.lives <= 0 && t >= ps.restUntil) {
      ps.lives = LIVES
      ps.inDance = true
      this.ctx.audio.play('score', 0.9, 1.2) // 站点 sfx('chime') 等价代理
    }
    for (let n = ps.cursor; n < this.beats.length; n++) {
      const bt = this.beats[n]
      if (bt.t - A.early > t) break
      if (ps.res[n]) continue
      const late = bt.t + A.late
      if (bt.count) {
        if (t >= bt.t) this.setRes(ps, n, 'count')
      } else if (bt.t < ps.restUntil) {
        if (t >= bt.t) this.setRes(ps, n, 'rest')
      } else if (!b) {
        if (t > late) this.setRes(ps, n, 'skip')
      } else if (bt.close) {
        // 合拍命中：当前分脚 + 上一拍时人在竿内（真从中间跳出）
        const wasIn = ps.lastTogether >= this.beats[n - 1].t - A.early - 0.05
        if (apartNow && wasIn) this.onHit(pi, n)
        else if (t > late) {
          if (ps.lastApart >= bt.t - A.early) this.onMiss(ps, n)
          else this.onPinch(pi, n)
        }
      } else {
        if (togetherNow) {
          if (ps.inDance) this.onHit(pi, n)
          else this.setRes(ps, n, 'idle') // 休息中被夹状态：并脚也不给分
        } else if (t > late) this.onMiss(ps, n)
      }
    }
  }

  /** 双人默契奖励（源码 X）：一小节内所有玩家全部 hit → 每人 +1 */
  private checkSync() {
    if (this.ps.length < 2) return
    while (this.syncPtr < this.bars.length) {
      const bar = this.bars[this.syncPtr]
      if (this.ps.some((p) => p.cursor <= bar.to)) break
      if (this.ps.every((p) => p.res.slice(bar.from, bar.to + 1).every((r) => r === 'hit'))) {
        for (const p of this.ps) {
          this.score++
          this.say('默契！', p.view.cx, p.view.fy - p.view.T * 1.5, '#ff8ac2', 34)
        }
        this.ctx.audio.play('score', 1, 1.2) // 站点 sfx('chime', 1.2)
        this.particles.burst(this.W / 2, this.H * 0.45, '#ff8ac2', 6, 200, 6, 200)
      }
      this.syncPtr++
    }
  }

  /** 视角标定（源码 Z）：cx 6/s、躯干 T 3/s、地面 fy 下快上慢（10/0.8） */
  private calib(ps: PS, b: Body | null, dt: number) {
    const v = ps.view
    if (b) {
      const cx = b.hipC.x * this.W
      const T = Math.max(40, b.scale * this.H)
      const fy = Math.max(b.lFoot.y, b.rFoot.y) * this.H + T * 0.05
      if (!v.init) {
        v.init = true
        v.cx = cx
        v.fy = fy
        v.T = T
      } else {
        v.cx += (cx - v.cx) * Math.min(1, dt * 6)
        v.T += (T - v.T) * Math.min(1, dt * 3)
        v.fy += (fy - v.fy) * Math.min(1, dt * (fy > v.fy ? 10 : 0.8))
      }
    } else if (!v.init) {
      v.init = true
      v.cx = this.W / 2
      v.fy = this.H * 0.86
      v.T = this.H * 0.2
    }
  }

  /** 竹竿开合插值（源码 H）：拍间平滑过渡 + 跳跃顶点 hop */
  private poles(now: number) {
    const N = this.beats
    let ti = 0
    while (ti < N.length && N[ti].t <= now) ti++
    const prev = ti > 0 ? N[ti - 1] : null
    const next = N[ti]
    const curOpen = prev && prev.close ? 0 : 1
    if (!next) return { open: curOpen, hop: 0 }
    const tgt = next.close ? 0 : 1
    const l0 = prev ? prev.t : next.t - 0.6
    const u = clamp((now - l0) / (next.t - l0), 0, 1)
    if (curOpen === tgt) return { open: curOpen, hop: curOpen ? Math.sin(Math.PI * u) * 0.7 : 0 }
    const d = clamp((u - 0.45) / 0.55, 0, 1)
    const s = d * d * (3 - 2 * d)
    return { open: curOpen + (tgt - curOpen) * s, hop: Math.sin(Math.PI * d) * 0.35 }
  }

  tick(f: PoseFrame, dt: number) {
    if (!this.openShown) {
      this.openShown = true
      this.banner('跟着鼓点跳！', OPEN_SEC, '竹竿开：并脚 · 竹竿合：分脚')
    }
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.shakeT = Math.max(0, this.shakeT - dt)
    const t = this.t

    // 鼓点调度（源码 update 前半）：过拍 0.25s 内播鼓点，首拍升级横幅，合拍撒地尘
    while (this.schedPtr < this.beats.length && this.beats[this.schedPtr].t <= t) {
      const bt = this.beats[this.schedPtr]
      if (t - bt.t < 0.25) {
        this.ctx.audio.play('tick', bt.count ? 0.35 : bt.close ? 1 : 0.55) // 站点 sfx('drum', …)
        if (bt.close) this.ctx.audio.play('click', 0.9)
      }
      if (!bt.count && bt.first && bt.level > this.seenLevel) {
        this.seenLevel = bt.level
        this.fastest = Math.max(this.fastest, bt.bpm)
        this.banner('鼓点变快啦！', 1.1)
        this.ctx.audio.play('drop', 0.5, 0.6) // 站点 sfx('whoosh') 等价代理
      }
      if (bt.close && !bt.count) {
        for (const p of this.ps) {
          if (t < p.restUntil) continue
          this.particles.burst(p.view.cx, p.view.fy + p.view.T * 0.1, '#d9c27a', 3, 140, 4)
          this.particles.burst(p.view.cx, p.view.fy + p.view.T * 0.1, '#ffffff', 2, 140, 4)
        }
      }
      this.schedPtr++
    }

    for (let pi = 0; pi < 2; pi++) {
      this.calib(this.ps[pi], f.bodies[pi] ?? null, dt)
      this.judge(pi, f.bodies[pi] ?? null)
    }
    this.checkSync()

    let totHits = 0
    let totJudged = 0
    let totPinch = 0
    let best = 0
    let bestBest = 0
    for (const p of this.ps) {
      totHits += p.hits
      totJudged += p.judged
      totPinch += p.pinches
      best = Math.max(best, p.streak)
      bestBest = Math.max(bestBest, p.best)
    }
    this.ctx.setScore(this.score)
    this.ctx.setCombo(best)
    this.ctx.setExtra('最长连对', bestBest)
    this.ctx.setExtra('准确率', totJudged ? Math.round((totHits / totJudged) * 100) : 0)
    this.ctx.setExtra('被夹到', totPinch)
    this.ctx.setExtra('最快鼓点', this.fastest)
  }

  paint(c: CanvasRenderingContext2D) {
    c.save()
    if (this.shakeT > 0) {
      const amp = this.shakeMag * (this.shakeT / 0.3)
      c.translate(Math.sin(this.t * 71) * amp, Math.cos(this.t * 64) * amp * 0.6)
    }
    const pole = this.poles(this.t)
    for (const ps of this.ps) {
      if (!ps.view.init) continue
      this.paintPlayer(c, ps, pole)
    }
    this.paintTimeline(c)
    c.restore()

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.18, 52, '#3ddc97')
      if (this.bannerSub) outlineTxt(c, this.bannerSub, this.W / 2, this.H * 0.18 + 54, 26, '#ffffffcc')
      c.globalAlpha = 1
    }
    txt(
      c,
      '竹竿开：并脚跳进中间 · 竹竿合：分脚跳出，别被夹到',
      this.W / 2,
      this.H - 78,
      20,
      'rgba(255,255,255,.8)',
      'center',
      'bold',
    )
  }

  private paintPlayer(c: CanvasRenderingContext2D, ps: PS, pole: { open: number; hop: number }) {
    const v = ps.view
    const gap = (GAP_CLOSE + (GAP_OPEN - GAP_CLOSE) * pole.open) * v.T
    const lift = pole.hop * v.T * 0.07
    // 竹竿两根（圆角竖竿，跳起时脚端抬起）
    const pw = v.T * 0.1
    const top = v.fy - v.T * 1.15
    const bottom = v.fy + v.T * 0.08 - lift
    for (const s of [-1, 1]) {
      const x = v.cx + (s * gap) / 2 - pw / 2
      const g = c.createLinearGradient(x, 0, x + pw, 0)
      g.addColorStop(0, '#9ccc65')
      g.addColorStop(0.5, '#7cb342')
      g.addColorStop(1, '#558b2f')
      c.fillStyle = g
      rr(c, x, top, pw, bottom - top, pw * 0.5)
      c.fill()
      // 竹节
      c.strokeStyle = 'rgba(40,70,25,.5)'
      c.lineWidth = 2
      for (let k = 1; k <= 3; k++) {
        const y = top + ((bottom - top) * k) / 4
        c.beginPath()
        c.moveTo(x + 1, y)
        c.lineTo(x + pw - 1, y)
        c.stroke()
      }
    }
    // 生命值（被夹后 0.5 秒竿抖动闪烁命心：lives<=0 时整排脉动）
    const blink = ps.lives <= 0 ? 0.5 + 0.5 * Math.sin(this.t * 8) : 1
    for (let i = 0; i < LIVES; i++) {
      c.save()
      c.globalAlpha = i < ps.lives ? 1 : 0.3 * blink
      emoji(c, '❤️', v.cx - LIVES * 22 + i * 44 + 22, v.fy - v.T * 1.62, 30)
      c.restore()
    }
    // 小人表情：休息 😴 / 被夹 0.5s 😮 / 连对≥10 😄 / 其余 😊
    const face = ps.lives <= 0 ? '😴' : this.t - ps.pinchAt < 0.5 ? '😮' : ps.streak >= 10 ? '😄' : '😊'
    emoji(c, face, v.cx, v.fy - v.T * 1.32, 44)
    // 连对文字 ≥3 显示（≥10 金色）
    if (ps.streak >= 3) {
      outlineTxt(c, `连对 ${ps.streak}`, v.cx, v.fy - v.T * 1.95, 26, ps.streak >= 10 ? '#ffd54a' : '#ffffffdd')
    }
    // 下一拍 1 秒内半透明预览徽章（α≤0.55）：并=两点靠拢 / 分=两点分开
    const next = this.beats.find((x) => !x.count && x.t > this.t)
    if (next && next.t - this.t < 1) {
      const a = 0.55 * clamp((1 - (next.t - this.t)) * 1.6, 0, 1)
      c.save()
      c.globalAlpha = a
      circle(c, v.cx, v.fy - v.T * 0.7, 26, 'rgba(14,18,44,.85)')
      const open = next.close ? 0 : 1
      const dx = 6 + 10 * open
      circle(c, v.cx - dx, v.fy - v.T * 0.7, 6, next.close ? '#ff5c5c' : '#3ddc97')
      circle(c, v.cx + dx, v.fy - v.T * 0.7, 6, next.close ? '#ff5c5c' : '#3ddc97')
      c.restore()
    }
  }

  /** 底部时间轴：2.4s 前瞻，预备拍数字；开/合拍圆点；已判定的命中弹跳 / miss 灰叉 / pinch 红叉 */
  private paintTimeline(c: CanvasRenderingContext2D) {
    const stripY = this.H - 40
    const x0 = 40
    const x1 = this.W - 40
    const past = 0.6
    const span = LOOKAHEAD + past
    for (const bt of this.beats) {
      if (bt.t < this.t - past || bt.t > this.t + LOOKAHEAD) continue
      const x = x0 + ((bt.t - (this.t - past)) / span) * (x1 - x0)
      if (bt.count) {
        txt(c, String(this.beats.indexOf(bt) + 1), x, stripY, 24, 'rgba(255,255,255,.7)')
        continue
      }
      const res = this.ps.map((p) => p.res[this.beats.indexOf(bt)]).find((r) => r && r !== 'skip' && r !== 'count' && r !== 'rest')
      c.save()
      if (!res) {
        const a = 0.25 + 0.5 * clamp(1 - (bt.t - this.t) / LOOKAHEAD, 0, 1)
        c.globalAlpha = a
        circle(c, x, stripY, 7, bt.close ? '#ff5c5c' : '#3ddc97')
      } else if (res === 'hit') {
        const age = this.t - bt.t
        const k = 1 + 0.6 * Math.max(0, 1 - age / 0.25)
        circle(c, x, stripY, 7 * k, '#ffd54a')
      } else if (res === 'pinch' || res === 'miss') {
        c.strokeStyle = res === 'pinch' ? '#ff5c5c' : '#9a8ba8'
        c.lineWidth = 3
        c.beginPath()
        c.moveTo(x - 6, stripY - 6)
        c.lineTo(x + 6, stripY + 6)
        c.moveTo(x + 6, stripY - 6)
        c.lineTo(x - 6, stripY + 6)
        c.stroke()
      } else {
        c.globalAlpha = 0.3
        circle(c, x, stripY, 6, '#9a8ba8')
      }
      c.restore()
    }
  }
}

export default function create(ctx: GameContext) {
  return new BambooDance(ctx)
}
