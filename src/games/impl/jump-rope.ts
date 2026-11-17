import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { outlineTxt, txt } from '@/core/draw'

/**
 * 跳绳大王（对齐 dongdongpark 真实规则）：
 * 两个小人摇大绳，相位扫到脚下给一个很短的判定窗，窗内起跳（踝升高 0.15 躯干或跳事件）才算；
 * 每 10 连跳绳加速 +5/6 rpm 到上限；绊到连跳清零、绳速回基线、领绳一圈（85% 基速）再开始。
 */
const DIFF = [
  { window: 0.19, baseRpm: 55, maxRpm: 95, stepRpm: 5, stumble: 0.8 },
  { window: 0.15, baseRpm: 60, maxRpm: 110, stepRpm: 5, stumble: 0.8 },
  { window: 0.12, baseRpm: 66, maxRpm: 125, stepRpm: 6, stumble: 0.7 },
]
const JUMP_HOLD = 0.45 // 跳事件视为滞空的时长
const ANKLE_TH = 0.15 // 踝升高阈值 ×躯干
const BASELINE_K = 0.08 // 踝基线慢跟随系数（仅在未离地时）
const WIN_MIN = 0.1 // 判定窗下限 s
const LEAD_RATIO = 0.85 // 领绳转速比例

type Phase = 'lead' | 'spin' | 'stumble'

interface PJump {
  lastAirT: number
  jumpT: number
  ankleBase: number
  airborne: boolean
  stumbleT: number
  jumps: number
}

class JumpRope extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  phase: Phase = 'lead'
  phaseT = 0
  rpm = this.cfg.baseRpm
  rope = 0.5 // 绳相位 0~1，1.0 = 扫脚一次
  streak = 0
  total = 0
  best = 0
  bestRpm = 0
  stumbles = 0
  pending: { t: number; ok: [boolean, boolean] } | null = null
  jumps: PJump[] = [
    { lastAirT: -9, jumpT: -9, ankleBase: NaN, airborne: false, stumbleT: 0, jumps: 0 },
    { lastAirT: -9, jumpT: -9, ankleBase: NaN, airborne: false, stumbleT: 0, jumps: 0 },
  ]
  bannerText = ''
  bannerT = 0

  tick(f: PoseFrame, dt: number) {
    if (this.bannerT > 0) this.bannerT -= dt

    // 起跳判定（双通道：跳事件滞空 0.45s / 双踝升高 0.15 躯干）
    for (let pi = 0; pi < 2; pi++) {
      const j = this.jumps[pi]
      j.stumbleT = Math.max(0, j.stumbleT - dt)
      const b = f.bodies[pi]
      if (!b) {
        j.airborne = false
        continue
      }
      const li = 27 // leftAnkle
      const ri = 28 // rightAnkle
      const l = b.lm[li]
      const r = b.lm[ri]
      if (l && r && (l.visibility ?? 1) > 0.5 && (r.visibility ?? 1) > 0.5) {
        const e = (l.y + r.y) / 2
        if (Number.isNaN(j.ankleBase)) j.ankleBase = e
        const torso = Math.max(0.06, b.scale)
        const raised = (j.ankleBase - e) / torso > ANKLE_TH
        if (!j.airborne && !raised) j.ankleBase += (e - j.ankleBase) * BASELINE_K
        j.airborne = raised || this.t - j.jumpT < JUMP_HOLD
        if (raised) {
          j.airborne = true
          j.lastAirT = this.t
        }
      } else {
        j.airborne = false
      }
      void b
    }

    // 绊倒停顿
    if (this.phase === 'stumble') {
      this.phaseT += dt
      if (this.phaseT >= this.cfg.stumble) {
        this.phase = 'lead'
        this.phaseT = 0
        this.rope = 0.5
      }
      this.updateHud()
      return
    }

    // 绳相位推进
    const eff = this.phase === 'lead' ? Math.min(this.rpm, this.cfg.baseRpm) * LEAD_RATIO : this.rpm
    this.rope += (eff / 60) * dt
    const presentCount = this.players.filter((p) => p.body).length
    if (presentCount === 0) {
      // 待机：慢转不判定
      this.rope += 0.5 * dt
      this.pending = null
      this.updateHud()
      return
    }
    if (this.rope >= 1) {
      this.rope -= 1
      if (this.phase === 'lead') {
        this.phase = 'spin'
      }
      // 生成一次判定
      const t = this.t
      const win = this.window()
      this.pending = {
        t,
        ok: this.players.map((p, i) => (!p.body ? true : t - this.jumps[i].lastAirT <= win)) as [boolean, boolean],
      }
    }
    // pending 窗口内起跳也可过
    if (this.pending) {
      const win = this.window()
      this.players.forEach((p, i) => {
        if (!p.body) return
        if (!this.pending!.ok[i] && this.t - this.jumps[i].lastAirT <= win) this.pending!.ok[i] = true
      })
      if (this.t - this.pending.t > win) this.settle()
    }
    this.updateHud()
  }

  private window() {
    return Math.max(WIN_MIN, this.cfg.window / (this.rpm / 60))
  }

  /** 结算一次扫脚：全员 ok 计数；有人没跳 → 绊倒 */
  private settle() {
    const ok = this.pending!.ok
    this.pending = null
    const present = this.players.filter((p) => p.body).length
    if (present === 0) return
    const allOk = this.players.every((p, i) => !p.body || ok[i])
    if (allOk) {
      this.streak++
      this.total++
      this.best = Math.max(this.best, this.streak)
      this.ctx.audio.play('pop', 1, 1 + Math.min(0.5, (this.streak % 10) * 0.05))
      for (let pi = 0; pi < 2; pi++) {
        const b = this.players[pi].body
        if (!b) continue
        this.jumps[pi].jumps++
        this.score++
        this.say(String(this.streak), b.shoulderC.x * this.W, (b.shoulderC.y - 0.2) * this.H, '#fff36b', 28)
      }
      if (this.streak % 10 === 0) {
        this.rpm = Math.min(this.cfg.maxRpm, this.rpm + this.cfg.stepRpm)
        this.bestRpm = Math.max(this.bestRpm, this.rpm)
        this.sayText(`连跳 ${this.streak} 个！加速到 ${this.rpm} 转/分`)
        this.ctx.audio.good()
        this.particles.burst(this.W / 2, this.H * 0.75, '#ffd54a', 14, 360, 5)
      }
    } else {
      // 绊倒
      this.stumbles++
      this.streak = 0
      this.rpm = this.cfg.baseRpm
      this.phase = 'stumble'
      this.phaseT = 0
      this.ctx.audio.fail()
      for (let pi = 0; pi < 2; pi++) {
        const b = this.players[pi].body
        if (b && !ok[pi]) {
          this.jumps[pi].stumbleT = this.cfg.stumble
          this.say('绊到啦！', b.head.x * this.W, (b.head.y - 0.12) * this.H, '#ff8a8a', 34)
        }
      }
    }
  }

  private score = 0

  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1.3
  }

  private updateHud() {
    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.streak)
    this.ctx.setExtra('最长连跳', this.best)
    this.ctx.setExtra('绊绳', this.stumbles)
    this.ctx.setExtra('最快绳速', this.bestRpm || this.rpm)
  }

  /** 绳的绘制 y（扫到脚下时贴近地面） */
  update(f: PoseFrame, dt: number) {
    this.bannerT = Math.max(0, this.bannerT - dt)
    super.update(f, dt)
  }

  paint(c: CanvasRenderingContext2D) {
    // 摇绳小人（左右两个，emoji 简化）
    const gx = this.W / 2
    const groundY = this.H * 0.86
    c.font = '64px system-ui'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText('🧍', gx - this.W * 0.3, groundY - 20)
    c.fillText('🧍', gx + this.W * 0.3, groundY - 20)
    // 绳：两柄间弧线；相位 >0.5（前半圈）画到脚下
    c.save()
    c.strokeStyle = this.phase === 'stumble' ? '#ffa940' : '#4dd0c4'
    c.lineWidth = this.phase === 'stumble' ? Math.max(5, 9) : 6
    if (this.phase === 'stumble') {
      // 贴地波浪
      c.beginPath()
      for (let x = gx - this.W * 0.3; x <= gx + this.W * 0.3; x += 20) {
        const y = groundY + Math.sin(x / 30) * 8
        if (x === gx - this.W * 0.3) c.moveTo(x, y)
        else c.lineTo(x, y)
      }
      c.stroke()
    } else {
      const sweep = Math.sin(this.rope * Math.PI)
      const midY = groundY - 10 - (1 - sweep) * this.H * 0.45
      c.beginPath()
      c.moveTo(gx - this.W * 0.3, groundY - 40)
      c.quadraticCurveTo(gx, midY, gx + this.W * 0.3, groundY - 40)
      c.stroke()
      // 接近预警：脚下虚线椭圆
      if (this.rope > 0.78) {
        c.globalAlpha = (this.rope - 0.78) / 0.22
        c.setLineDash([8, 8])
        c.strokeStyle = '#ffffff'
        c.beginPath()
        c.ellipse(gx, groundY + 14, this.W * 0.16, 14, 0, 0, Math.PI * 2)
        c.stroke()
        c.setLineDash([])
      }
    }
    c.restore()

    // HUD
    outlineTxt(c, `连跳 ${this.streak}`, this.W * 0.27, 60, 34, this.streak >= 10 ? '#ffd54a' : '#ffffff')
    txt(c, `${Math.round(this.phase === 'lead' ? this.rpm * LEAD_RATIO : this.rpm)} 转/分 · 最长 ${this.best}`, this.W * 0.27, 96, 22, 'rgba(255,255,255,.75)', 'left', 'bold')
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 170, 40, '#4dd0c4')
      c.globalAlpha = 1
    }
    txt(c, '绳扫到脚下就跳！连跳 10 个加速，绊到绳速回起点', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  void ctx
  return new JumpRope(ctx)
}

export type { Body }
