import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 跟跳舞蹈（对齐逆向报告 dance-along.md）：
 * 左边教练逐拍跳舞（BPM 90/105/120），玩家逐拍模仿；每拍在 ±0.2s 窗口内取最大相似度评
 * Perfect(≥0.85)/很好(≥0.7)/还行(≥0.5)/miss，评级分值 3/2/1/0，每 10 连击额外 +5。
 */

const DIFF = [{ bpm: 90 }, { bpm: 105 }, { bpm: 120 }]

/** 规则常量（报告 §1）：开跳前热身 offset / 判定窗口 / 评级阈值 / 评级分值（beat 模块推断 3/2/1/0，任务指定） */
const OFFSET = 2.5
const WIN = 0.2
const THR = { perfect: 0.85, good: 0.7, ok: 0.5 }
const GRADE_SCORE = { perfect: 3, good: 2, ok: 1, miss: 0 }
const COMBO_BONUS = 5
const LOOKBACK = 3 // 过拍后回溯补判的拍数

type PoseKey = 'hips' | 'up' | 't' | 'leftUp' | 'rightUp' | 'y' | 'muscle' | 'star' | 'squat' | 'wave' | 'kneeL'

/** 姿势目标：双手相对肩心（scale 单位，dy 正=肩上方）；leg 附加腿部分量 */
interface Spec {
  l: { x: number; y: number }
  r: { x: number; y: number }
  leg?: 'star' | 'squat' | 'knee'
}

const SPECS: Record<PoseKey, Spec> = {
  hips: { l: { x: -0.34, y: -0.42 }, r: { x: 0.34, y: -0.42 } },
  up: { l: { x: -0.16, y: 1.0 }, r: { x: 0.16, y: 1.0 } },
  t: { l: { x: -0.95, y: 0 }, r: { x: 0.95, y: 0 } },
  leftUp: { l: { x: -0.14, y: 1.0 }, r: { x: 0.18, y: -0.5 } },
  rightUp: { l: { x: -0.18, y: -0.5 }, r: { x: 0.14, y: 1.0 } },
  y: { l: { x: -0.62, y: 0.8 }, r: { x: 0.62, y: 0.8 } },
  muscle: { l: { x: -0.32, y: 0.12 }, r: { x: 0.32, y: 0.12 } },
  star: { l: { x: -1.05, y: 0.42 }, r: { x: 1.05, y: 0.42 }, leg: 'star' },
  squat: { l: { x: -0.38, y: -0.12 }, r: { x: 0.38, y: -0.12 }, leg: 'squat' },
  wave: { l: { x: -0.16, y: -0.5 }, r: { x: 0.4, y: 0.95 } },
  kneeL: { l: { x: -0.45, y: 0.05 }, r: { x: 0.45, y: 0.05 }, leg: 'knee' },
}

const POSE_NAME: Record<PoseKey, string> = {
  hips: '叉腰', up: '举高高', t: '双手张开', leftUp: '举左手', rightUp: '举右手',
  y: 'Y 字', muscle: '大力士', star: '大星星', squat: '蹲下', wave: '挥挥手', kneeL: '金鸡独立',
}

/** 编舞（报告 §2 O 表，3 段 88 拍，取模循环） */
const SECTIONS: { name: string; color: string; moves: PoseKey[] }[] = [
  {
    name: '热身操', color: '#ff8fa3',
    moves: ['hips', 'hips', 'up', 'up', 't', 't', 'hips', 'hips', 'leftUp', 'rightUp', 'leftUp', 'rightUp',
      'up', 'up', 'hips', 'hips', 'y', 'y', 't', 't', 'muscle', 'muscle', 'up', 'up'],
  },
  {
    name: '星星舞', color: '#9b5de5',
    moves: ['t', 'star', 't', 'star', 'up', 'y', 'up', 'y', 'leftUp', 'leftUp', 'rightUp', 'rightUp',
      'hips', 'squat', 'hips', 'squat', 'wave', 'wave', 'muscle', 'muscle', 'star', 'star', 'y', 'y',
      't', 'up', 't', 'up', 'kneeL', 'kneeL', 'star', 'star'],
  },
  {
    name: '功夫操', color: '#ff9f1c',
    moves: ['muscle', 'muscle', 't', 't', 'squat', 'squat', 'up', 'up', 'leftUp', 'rightUp', 'leftUp', 'rightUp',
      'hips', 'kneeL', 'hips', 'kneeL', 'star', 'y', 'star', 'y', 't', 'muscle', 't', 'muscle',
      'squat', 'up', 'squat', 'up', 'wave', 'wave', 'star', 'star'],
  },
]
const TOTAL_BEATS = SECTIONS.reduce((n, s) => n + s.moves.length, 0)

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function squatComp(b: Body) {
  const s = Math.max(0.05, b.scale)
  const ratio = ((b.lKnee.y - b.lHip.y) / s + (b.rKnee.y - b.rHip.y) / s) / 2
  return clamp01(1 - ratio / 0.7)
}

function kneeComp(b: Body) {
  const s = Math.max(0.05, b.scale)
  const minRatio = Math.min(b.lKnee.y - b.lHip.y, b.rKnee.y - b.rHip.y) / s
  return clamp01((0.55 - minRatio) / 0.4)
}

/** 特征-姿势相似度（黑盒 u(feat, spec) 的本地实现）：双手目标分（±leg 分量）均值 */
function simOf(b: Body, spec: Spec): number {
  const s = Math.max(0.05, b.scale)
  const handScore = (p: { x: number; y: number }, t: { x: number; y: number }) => {
    const qx = (p.x - b.shoulderC.x) / s
    const qy = (b.shoulderC.y - p.y) / s
    return clamp01(1 - Math.hypot(qx - t.x, qy - t.y) / 0.55)
  }
  const hl = handScore(b.lHand, spec.l)
  const hr = handScore(b.rHand, spec.r)
  if (!spec.leg) return (hl + hr) / 2
  const leg = spec.leg === 'star' ? clamp01(b.feetSpread / s) : spec.leg === 'squat' ? squatComp(b) : kneeComp(b)
  return (hl + hr + leg) / 3
}

/** 每拍判定记录 */
interface BeatRec {
  best: number[]
  graded: boolean
  grade: string
  fx: number
}

/** 跟跳舞蹈 */
class DanceAlong extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  unit = this.H / 720
  beatLen = 60 / this.cfg.bpm
  score = 0
  /** 每玩家连击与最大连击 */
  combo = [0, 0]
  maxCombo = [0, 0]
  perfect = 0
  judged = 0
  miss = 0
  beats = new Map<number, BeatRec>()
  /** 段落横幅 */
  bannerT = 0
  bannerText = ''
  bannerColor = '#ff8fa3'
  started = false
  lastTickBeat = -1
  /** 命中光环 */
  halo: { pi: number; grade: string; t: number }[] = []
  /** 教练插值手位（scale 单位） */
  teachL = { x: -0.18, y: -0.5 }
  teachR = { x: 0.18, y: -0.5 }

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.setStage('准备……')
  }

  /** 全局编舞表 */
  private moveOf(beat: number): PoseKey {
    const b = ((beat % TOTAL_BEATS) + TOTAL_BEATS) % TOTAL_BEATS
    let acc = 0
    for (const sec of SECTIONS) {
      if (b < acc + sec.moves.length) return sec.moves[b - acc]
      acc += sec.moves.length
    }
    return 'up'
  }

  private sectionOf(beat: number) {
    const b = ((beat % TOTAL_BEATS) + TOTAL_BEATS) % TOTAL_BEATS
    let acc = 0
    for (let i = 0; i < SECTIONS.length; i++) {
      const len = SECTIONS[i].moves.length
      if (b < acc + len) return { idx: i, segBeat: b - acc, sec: SECTIONS[i] }
      acc += len
    }
    return { idx: 0, segBeat: 0, sec: SECTIONS[0] }
  }

  private beatAt(n: number) {
    return OFFSET + n * this.beatLen
  }

  tick(f: PoseFrame, dt: number) {
    void f
    this.bannerT = Math.max(0, this.bannerT - dt)

    // 开跳（offset 2.5s "准备……" 热身，报告 L231-235）
    if (!this.started && this.t >= OFFSET) {
      this.started = true
      this.bannerT = 1.8
      this.bannerText = '跟着教练跳！'
      this.bannerColor = '#ff8fa3'
      this.ctx.speak('跟着左边的教练一起跳！')
    }
    if (!this.started) return

    const now = this.t
    const curN = Math.max(0, Math.floor((now - OFFSET) / this.beatLen))

    // 每拍节拍音（小节头拍音量 1.2，报告 L250-251）
    if (curN !== this.lastTickBeat) {
      this.lastTickBeat = curN
      const segBeat = this.sectionOf(curN).segBeat
      this.ctx.audio.play('tick', segBeat % 4 === 0 ? 1.2 : 0.7)
      // 段落切换横幅（报告 L252-257）
      const { idx, segBeat: sb, sec } = this.sectionOf(curN)
      if (sb === 0) {
        this.bannerT = 1.5
        this.bannerText = `第 ${idx + 1} 段 · ${sec.name}`
        this.bannerColor = sec.color
        this.ctx.audio.good()
      }
      this.ctx.setStage(`${sec.name} ${sb + 1}/${sec.moves.length}`)
    }

    // 窗口内采集：对窗内每拍取最大相似度（报告 L237-245）
    for (let n = Math.max(0, curN - LOOKBACK); n <= curN + 1; n++) {
      const bt = this.beatAt(n)
      if (now < bt - WIN || now > bt + WIN) continue
      let rec = this.beats.get(n)
      if (!rec) {
        rec = { best: [0, 0], graded: false, grade: '', fx: 0 }
        this.beats.set(n, rec)
      }
      for (const pv of this.players) {
        const b = pv.body
        if (!b) continue
        const spec = SPECS[this.moveOf(n)]
        rec.best[pv.id] = Math.max(rec.best[pv.id], simOf(b, spec))
      }
    }

    // 判级：过窗即判，回溯最多 3 拍补判（报告 V()/L247-248）
    for (let n = Math.max(0, curN - LOOKBACK); n <= curN; n++) {
      const bt = this.beatAt(n)
      if (now <= bt + WIN) continue
      const rec = this.beats.get(n)
      if (!rec || rec.graded) continue
      rec.graded = true
      this.grade(n, rec)
    }
    // 清掉太老的记录
    if (this.beats.size > 64) {
      for (const key of this.beats.keys()) if (key < curN - 8) this.beats.delete(key)
    }

    // 命中光环衰减
    for (let i = this.halo.length - 1; i >= 0; i--) {
      this.halo[i].t += dt
      if (this.halo[i].t > 0.45) this.halo.splice(i, 1)
    }

    // 教练姿势插值（前后两拍 inOut 缓动混合，报告 §2 教练侧）
    const frac = clamp01((now - OFFSET) / this.beatLen - curN)
    const e = frac < 0.5 ? 4 * frac * frac * frac : 1 - Math.pow(-2 * frac + 2, 3) / 2
    const specA = SPECS[this.moveOf(Math.max(0, curN - 1))]
    const specB = SPECS[this.moveOf(curN)]
    this.teachL.x += (specA.l.x + (specB.l.x - specA.l.x) * e - this.teachL.x) * Math.min(1, dt * 18)
    this.teachL.y += (specA.l.y + (specB.l.y - specA.l.y) * e - this.teachL.y) * Math.min(1, dt * 18)
    this.teachR.x += (specA.r.x + (specB.r.x - specA.r.x) * e - this.teachR.x) * Math.min(1, dt * 18)
    this.teachR.y += (specA.r.y + (specB.r.y - specA.r.y) * e - this.teachR.y) * Math.min(1, dt * 18)
  }

  /** 判级与计分（报告 V()/L213-226）：perfect≥0.85 / good≥0.7 / ok≥0.5 / miss；分值 3/2/1/0 */
  private grade(_n: number, rec: BeatRec) {
    for (const pv of this.players) {
      const pi = pv.id
      const b = pv.body
      this.judged++
      const sim = b ? rec.best[pi] : 0 // 不在镜头前强制 miss
      const g = sim >= THR.perfect ? 'perfect' : sim >= THR.good ? 'good' : sim >= THR.ok ? 'ok' : 'miss'
      rec.grade = g
      const val = GRADE_SCORE[g as keyof typeof GRADE_SCORE]
      this.score += val
      if (g === 'miss') {
        this.combo[pi] = 0
        this.miss++
        if (b) this.say('miss', b.head.x * this.W, b.head.y * this.H - 60, 'rgba(220,220,230,.8)', 30)
      } else {
        this.combo[pi]++
        this.maxCombo[pi] = Math.max(this.maxCombo[pi], this.combo[pi])
        if (g === 'perfect') {
          this.perfect++
          if (b) {
            this.say('Perfect!', b.head.x * this.W, b.head.y * this.H - 70, '#ffd54a', 40 * this.unit)
            this.particles.burst(b.head.x * this.W, b.head.y * this.H, '#ffd54a', 8, 340, 5)
            this.particles.burst(b.head.x * this.W, b.head.y * this.H, '#ffffff', 4, 300, 4)
          }
          this.ctx.audio.combo() // sparkle → combo 兜底
        } else {
          if (b) this.say(g === 'good' ? '很好' : '还行', b.head.x * this.W, b.head.y * this.H - 60, '#b6ffdd', 32 * this.unit)
          this.ctx.audio.pop()
        }
        // 每 10 连击额外 +5（报告 §3）
        if (this.combo[pi] % 10 === 0) {
          this.score += COMBO_BONUS
          if (b) this.say(`${this.combo[pi]} 连击 +5`, b.head.x * this.W, b.head.y * this.H - 110, '#ff8fa3', 34)
          this.ctx.audio.win()
        }
        this.halo.push({ pi, grade: g, t: 0 })
      }
      rec.fx = this.t
    }
    this.ctx.setScore(this.score)
    this.ctx.setExtra('Perfect', this.perfect)
    this.ctx.setExtra('最大连击', Math.max(...this.maxCombo))
    this.ctx.setExtra(
      '命中率',
      this.judged ? Math.round(((this.judged - this.miss) / this.judged) * 100) : 100,
    )
  }

  /** 教练简笔小人（手位用插值目标） */
  private drawCoach(c: CanvasRenderingContext2D) {
    const cx = this.W * 0.3
    const cy = this.H * 0.72
    const s = 190 * this.unit
    c.save()
    // 黄色射灯
    glow(c, cx, cy - s * 0.5, 240, 'rgba(255,209,102,.5)', 0.24)
    c.strokeStyle = '#f9c74f'
    c.fillStyle = '#f9c74f'
    c.lineWidth = 13
    c.lineCap = 'round'
    c.beginPath()
    c.arc(cx, cy - s * 0.95, s * 0.15, 0, Math.PI * 2)
    c.fill()
    c.beginPath()
    c.moveTo(cx, cy - s * 0.78)
    c.lineTo(cx, cy + s * 0.1)
    c.stroke()
    c.lineWidth = 11
    c.beginPath()
    c.moveTo(cx - 20, cy - s * 0.6)
    c.lineTo(cx + this.teachL.x * s * 0.55, cy - this.teachL.y * s * 0.55)
    c.stroke()
    c.beginPath()
    c.moveTo(cx + 20, cy - s * 0.6)
    c.lineTo(cx + this.teachR.x * s * 0.55, cy - this.teachR.y * s * 0.55)
    c.stroke()
    // 腿
    c.beginPath()
    c.moveTo(cx - 14, cy + s * 0.1)
    c.lineTo(cx - 26, cy + s * 0.52)
    c.stroke()
    c.beginPath()
    c.moveTo(cx + 14, cy + s * 0.1)
    c.lineTo(cx + 26, cy + s * 0.52)
    c.stroke()
    // 黄头带
    c.strokeStyle = '#ffd54a'
    c.lineWidth = 6
    c.beginPath()
    c.arc(cx, cy - s * 0.98, s * 0.13, Math.PI * 1.1, Math.PI * 1.9)
    c.stroke()
    txt(c, '教练 · 领舞', cx, cy + s * 0.66, 16, 'rgba(255,255,255,.75)')
    c.restore()
  }

  paint(c: CanvasRenderingContext2D) {
    const pulse = this.started ? clamp01(1 - (((this.t - OFFSET) / this.beatLen) % 1)) : 0

    // 舞台：紫色地板 + 方格砖随拍闪烁（粉/蓝交替，报告 L273-282）
    const g = c.createLinearGradient(0, this.H * 0.55, 0, this.H)
    g.addColorStop(0, '#4a3a8c')
    g.addColorStop(1, '#2c2258')
    c.fillStyle = g
    c.fillRect(0, this.H * 0.55, this.W, this.H * 0.45)
    const tile = 64 * this.unit
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < this.W / tile + 1; col++) {
        if ((row + col) % 2) continue
        const flash = ((row + col) % 4 < 2 ? '#ff3385' : '#3390fc')
        c.save()
        c.globalAlpha = 0.08 + pulse * 0.1
        c.fillStyle = flash
        c.fillRect(col * tile, this.H * 0.55 + row * tile, tile, tile)
        c.restore()
      }
    }

    // 迪斯科球
    const dx = this.W / 2
    c.save()
    circle(c, dx, 40, 18, '#b9c4d8')
    c.fillStyle = 'rgba(255,255,255,.5)'
    for (let i = 0; i < 5; i++) {
      const a = this.t * 1.4 + i * 1.257
      c.globalAlpha = 0.25 + 0.25 * Math.sin(a * 3)
      c.fillRect(dx - 16 + ((i * 7) % 30), 26 + ((i * 5) % 24), 5, 5)
    }
    c.restore()
    glow(c, dx, 40, 70, '#ffffff', 0.2)

    // 教练区/玩家区虚线分隔 + 玩家粉色射灯
    c.save()
    c.setLineDash([14, 12])
    c.strokeStyle = 'rgba(255,255,255,.3)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(this.W * 0.46, this.H * 0.18)
    c.lineTo(this.W * 0.46, this.H * 0.95)
    c.stroke()
    c.restore()
    const present = this.players.filter((p) => p.body)
    for (const pv of present) {
      const b = pv.body!
      glow(c, b.shoulderC.x * this.W, b.shoulderC.y * this.H, 200, 'rgba(255,131,182,.6)', 0.18)
    }

    // 教练
    this.drawCoach(c)

    // 教练脚下 4 拍位圆点（当前拍黄点放大脉冲，报告 L346-359）
    const segBeat = this.started ? this.sectionOf(Math.max(0, Math.floor((this.t - OFFSET) / this.beatLen))).segBeat : 0
    for (let i = 0; i < 4; i++) {
      const cur = this.started && i === segBeat % 4
      circle(c, this.W * 0.3 - 54 + i * 36, this.H * 0.95, cur ? 9 + pulse * 4 : 5, cur ? '#ffd54a' : 'rgba(255,255,255,.3)')
    }

    // 玩家幽灵剪影 / 缺席提示（报告 L314-339）
    const duo = present.length > 1
    for (const pv of this.players) {
      const b = pv.body
      const px = duo ? (pv.id === 0 ? this.W * 0.62 : this.W * 0.84) : this.W * 0.63
      if (!b) {
        // 灰色幽灵站位
        c.save()
        c.globalAlpha = 0.3
        c.strokeStyle = '#9aa'
        c.fillStyle = '#9aa'
        c.lineWidth = 9
        this.ghostFigure(c, px, this.H * 0.72, 170 * this.unit)
        c.restore()
        txt(c, '站到镜头前', px, this.H * 0.92, 18, 'rgba(255,255,255,.6)')
        continue
      }
      // 名牌 + 连击
      const label = duo ? `玩家${pv.id + 1}` : '你'
      txt(c, label, b.shoulderC.x * this.W, Math.max(30, (b.head.y - 0.2) * this.H), 15, pv.color)
      if (this.combo[pv.id] >= 3) {
        outlineTxt(c, `${this.combo[pv.id]} 连击`, b.shoulderC.x * this.W, Math.max(52, (b.head.y - 0.2) * this.H - 22), 17, '#ffd54a')
      }
    }

    // 命中光环：判级后 0.45s 玩家头顶彩色半透明圆（报告 L324-325）
    for (const h of this.halo) {
      const b = this.players[h.pi].body
      if (!b) continue
      c.save()
      c.globalAlpha = (1 - h.t / 0.45) * 0.6
      c.fillStyle = h.grade === 'perfect' ? '#ffd54a' : h.grade === 'good' ? '#3ddc97' : '#8fd3ff'
      c.beginPath()
      c.arc(b.head.x * this.W, (b.head.y - 0.06) * this.H, b.scale * 1.7 * this.H, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }

    // 三拍预告牌：当前 + 下两拍（左上竖排，透明度 1/0.55，报告 L293-313）
    if (this.started) {
      const curN = Math.max(0, Math.floor((this.t - OFFSET) / this.beatLen))
      for (let k = 0; k < 3; k++) {
        const n = curN + k
        const pose = this.moveOf(n)
        const cw = 96 * this.unit
        const chh = 84 * this.unit
        const x = 30
        const y = 110 + k * (chh + 12)
        c.save()
        c.globalAlpha = k === 0 ? 1 : 0.55
        c.fillStyle = 'rgba(18,24,58,.72)'
        rr(c, x, y, cw, chh, 14)
        c.fill()
        c.strokeStyle = k === 0 ? '#ffd54a' : 'rgba(255,255,255,.3)'
        c.lineWidth = k === 0 ? 3 : 2
        c.stroke()
        c.fillStyle = '#f9c74f'
        c.strokeStyle = '#f9c74f'
        c.lineWidth = 5
        c.save()
        c.translate(x + cw / 2, y + chh / 2 + 8)
        const spec = SPECS[pose]
        this.miniSpec(c, spec, chh * 0.5)
        c.restore()
        if (k === 0) txt(c, POSE_NAME[pose], x + cw / 2, y + chh - 10, 12, '#ffd54a')
        c.restore()
      }
    }

    // 横幅 / 准备
    if (this.bannerT > 0) {
      c.save()
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.3, 52, this.bannerColor)
      c.restore()
    } else if (!this.started) {
      outlineTxt(c, '准备……', this.W / 2, this.H * 0.35, 48, '#ffffff')
      txt(c, '跟着左边的教练一起跳！', this.W / 2, this.H * 0.35 + 48, 22, 'rgba(255,255,255,.85)')
    }
  }

  /** 按目标手位画迷你小人（预告牌用） */
  private miniSpec(c: CanvasRenderingContext2D, spec: Spec, h: number) {
    c.beginPath()
    c.arc(0, -h * 0.42, h * 0.1, 0, Math.PI * 2)
    c.fill()
    c.beginPath()
    c.moveTo(0, -h * 0.3)
    c.lineTo(0, h * 0.16)
    c.stroke()
    c.beginPath()
    c.moveTo(-6, -h * 0.24)
    c.lineTo(spec.l.x * h * 0.42, -spec.l.y * h * 0.42)
    c.stroke()
    c.beginPath()
    c.moveTo(6, -h * 0.24)
    c.lineTo(spec.r.x * h * 0.42, -spec.r.y * h * 0.42)
    c.stroke()
    c.beginPath()
    c.moveTo(-5, h * 0.16)
    c.lineTo(-10, h * 0.55)
    c.stroke()
    c.beginPath()
    c.moveTo(5, h * 0.16)
    c.lineTo(10, h * 0.55)
    c.stroke()
  }

  /** 灰色幽灵站位小人 */
  private ghostFigure(c: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
    c.beginPath()
    c.arc(cx, cy - s * 0.45, s * 0.1, 0, Math.PI * 2)
    c.fill()
    c.beginPath()
    c.moveTo(cx, cy - s * 0.32)
    c.lineTo(cx, cy + s * 0.05)
    c.stroke()
    c.beginPath()
    c.moveTo(cx - 12, cy - s * 0.26)
    c.lineTo(cx - 40, cy - s * 0.05)
    c.stroke()
    c.beginPath()
    c.moveTo(cx + 12, cy - s * 0.26)
    c.lineTo(cx + 40, cy - s * 0.05)
    c.stroke()
    c.beginPath()
    c.moveTo(cx - 8, cy + s * 0.05)
    c.lineTo(cx - 18, cy + s * 0.3)
    c.stroke()
    c.beginPath()
    c.moveTo(cx + 8, cy + s * 0.05)
    c.lineTo(cx + 18, cy + s * 0.3)
    c.stroke()
  }
}

export default function create(ctx: GameContext) {
  return new DanceAlong(ctx)
}
