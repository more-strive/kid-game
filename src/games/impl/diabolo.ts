import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 抖空竹（对齐 dongdongpark 真实规则）：
 * 两手一上一下交替抖动（side 翻转 = 一次抖动），抖得越稳（间隔变异系数 CV）空竹转得越快；
 * 转速分档持续得分（≥.3/.6/.9 → 每秒 +1/+2/+3）；抖满（≥99.5%）后双手低→高扬抛起，
 * 1.5s 内双手收回胸前（胸带 + 掌距 gap 区间）接住 = 花样 +10 分；armed 后转慢会先歪警告
 * 再掉落；掉落弹跳 1.3s 后重新上绳。双人各自独立空竹（本作 score 为共享累计分）。
 */

/** 难度配置 m：抖动收益 / 自然衰减率 / 接住宽限(s) / 接住姿势双掌间距区间（×torso） */
const DIFF = [
  { gain: 0.12, decay: 0.08, grace: 0.55, gap: [0.35, 2.3] as [number, number] },
  { gain: 0.1, decay: 0.1, grace: 0.4, gap: [0.45, 2] as [number, number] },
  { gain: 0.085, decay: 0.12, grace: 0.26, gap: [0.55, 1.7] as [number, number] },
]
const ROD_LEN = 0.72 // 竿长 = 0.72×torso
const ROD_ANG = 0.8 // 竿与手的基础夹角（rad）
const SAG = 2.9 // 空竹绳下垂弧度系数
const SIDE_TH = 0.12 // 上下手判定向差阈值（×torso）
const DEBOUNCE = 0.12 // 抖动去抖最小间隔（s）
const BREAK_GAP = 1.1 // 抖动间隔 >1.1s → 节奏序列清空（该次收益 ×0.5）
const TIERS = [0.3, 0.6, 0.9] // 转速分档线：≥.3 每秒 +1、≥.6 +2、≥.9 +3
const FULL = 0.995 // "转满"阈值（浮点容差式写法）
const FULL_KEEP = 0.82 // full 保持线：spin <0.82 → full 丢失
const ARMED = 0.35 // armed 门槛：spin ≥0.35 后才进入可歪倒状态
const TILT = 0.05 // 歪倒阈值：armed 且 spin <0.05 → 掉落
const AIR_T = 1.5 // 抛起滞空时长（s）
const CATCH_EARLY = 0.12 // 最早可接时刻：launchT + 1.5 − 0.12（必须等空竹落下来）
const OVERHEAD_WIN = 0.9 // 双手过头顶须在离肩 <0.9s 内（先低后高动作序列）
const DROP_T = 1.3 // 掉落状态时长（物理弹跳）
const GRAVITY = 2600 // 掉落重力（px/s²）
const BOUNCE = -0.38 // 反弹系数
const IDLE_DECAY = 2.2 // 停手 1s 以上衰减 ×2.2
/** 空竹嗡鸣音高（随 spin 0→1 从 13 个音里取） */
const PITCHES = [48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72, 74, 76]
/** 花样名（纯装饰轮换，全部 +10 分） */
const TRICK_NAMES = ['抛高高', '鲤鱼跳龙门', '金鸡上架', '海底捞月', '满天飞', '仙人过桥']

type DState = 'string' | 'air' | 'drop'

class Diabolo {
  state: DState = 'string'
  spin = 0
  side = 0 // 1 = 左手在上，-1 = 右手在上
  lastFlipT = -9
  intervals: number[] = [] // 最近 5 次抖动间隔（稳定度用）
  stability = 0
  full = false
  belowAt = -1 // 双手低于肩的时刻（抛的前置）
  launchT = 0
  throws = 0
  tricks = 0
  trickIdx = 0
  streak = 0
  bestStreak = 0
  maxSpin = 0
  warnT = -9 // 提示节流
  buzzT = 0
  ang = 0 // 盘面转角（视觉模糊盘）
  /** 掉落物理：dropY = 离地高度（px），dropVy 向上为正 */
  dropY = 0
  dropVy = 0
  dropAt = 0
  /** 接住姿势（air 态提示用） */
  ready = false
  regSum = 0
  regN = 0

  /** 稳定度 F：抖动间隔 CV → clamp(1−(CV−0.08)/0.55, 0, 1)，间隔越均匀越稳 */
  private cv(intervals: number[]) {
    if (intervals.length < 2) return Infinity
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
    if (mean <= 0) return Infinity
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length
    return Math.sqrt(variance) / mean
  }

  /** string 态：抖动蓄速 + 衰减 + 歪倒判定。返回事件码（'full' 转满 / 'tilt' 歪倒 / ''） */
  tickString(b: Body, t: number, dt: number, gain: number, decay: number, warnText: { v: string }): '' | 'full' | 'tilt' {
    const scale = Math.max(0.1, b.scale)
    // 双手 y 差判定：diff > 0.12 → 左手在上（side=1）；< −0.12 → 右手在上（side=−1）
    const diff = (b.rHand.y - b.lHand.y) / scale
    let newSide = this.side
    if (diff > SIDE_TH) newSide = 1
    else if (diff < -SIDE_TH) newSide = -1
    if (newSide !== this.side && newSide !== 0 && t - this.lastFlipT >= DEBOUNCE) {
      const gapT = t - this.lastFlipT
      const broken = this.lastFlipT < 0 || gapT > BREAK_GAP
      if (!broken) {
        this.intervals.push(gapT)
        while (this.intervals.length > 5) this.intervals.shift()
      } else {
        this.intervals.length = 0
      }
      const cvv = this.cv(this.intervals)
      this.stability = Math.max(0, Math.min(1, 1 - (cvv - 0.08) / 0.55))
      this.spin += gain * (0.4 + 0.6 * this.stability) * (broken ? 0.5 : 1)
      this.spin = Math.min(1, this.spin)
      this.regSum += this.stability
      this.regN++
      this.side = newSide
      this.lastFlipT = t
    }

    // 衰减：decay×(0.3+0.7spin)；停手 >1s ×2.2
    const idle = t - this.lastFlipT > 1
    this.spin -= decay * (0.3 + 0.7 * this.spin) * dt * (idle ? IDLE_DECAY : 1)
    this.maxSpin = Math.max(this.maxSpin, this.spin)

    // full 进入/保持
    if (!this.full && this.spin >= FULL) {
      this.full = true
      return 'full'
    }
    if (this.full && this.spin < FULL_KEEP) this.full = false

    // armed 后转慢：先 wobble 警告，再歪倒掉落
    if (this.spin >= ARMED && this.spin < 0.16) {
      warnText.v = '快抖，要歪啦！'
    }
    if (this.spin >= ARMED && this.spin < TILT) {
      this.spin = 0
      this.streak = 0
      this.state = 'drop'
      this.dropAt = t
      this.dropY = 140
      this.dropVy = 60
      return 'tilt'
    }
    return ''
  }

  /** 抛起尝试：双手低于肩后 0.9s 内同时举过头顶 */
  tryThrow(b: Body, t: number, full: boolean): 'launched' | 'deny' | 'none' {
    const scale = Math.max(0.1, b.scale)
    const below = b.lHand.y > b.shoulderC.y + 0.1 * scale && b.rHand.y > b.shoulderC.y + 0.1 * scale
    const overhead = b.lHandAboveHead && b.rHandAboveHead
    if (below) {
      if (this.belowAt < 0) this.belowAt = t
      return 'none'
    }
    if (overhead && this.belowAt >= 0 && t - this.belowAt <= OVERHEAD_WIN) {
      this.belowAt = -1
      return full ? 'launched' : 'deny'
    }
    if (this.belowAt >= 0 && t - this.belowAt > OVERHEAD_WIN) this.belowAt = -1
    return 'none'
  }

  /** air 态：接住姿势 ready = 双手在胸带内 且 掌距 ∈ gap 区间 */
  updateReady(b: Body, gap: [number, number]) {
    const scale = Math.max(0.1, b.scale)
    const top = b.shoulderC.y - 0.15 * scale
    const bottom = b.hipC.y + 0.35 * scale
    const inBand = b.lHand.y >= top && b.lHand.y <= bottom && b.rHand.y >= top && b.rHand.y <= bottom
    const palmDist = Math.abs(b.lHand.x - b.rHand.x) / scale
    this.ready = inBand && palmDist >= gap[0] && palmDist <= gap[1]
  }
}

class DiaboloGame extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ds = [new Diabolo(), new Diabolo()]
  banner = ''
  bannerT = 0
  /** 总分（转速分连续累计 + 花样 +10，显示取整） */
  scoreF = 0

  tick(f: PoseFrame, dt: number) {
    for (let pi = 0; pi < 2; pi++) {
      const d = this.ds[pi]
      const b = f.bodies[pi]
      const px = b ? b.shoulderC.x * this.W : pi === 0 ? this.W * 0.3 : this.W * 0.7

      // 转速分档得分：每秒按档 +1/+2/+3（连续累计）
      const tier = d.spin >= TIERS[2] ? 3 : d.spin >= TIERS[1] ? 2 : d.spin >= TIERS[0] ? 1 : 0
      this.scoreF += tier * dt

      // 嗡鸣：spin >0.12 按 0.52−0.3×spin 秒间隔循环播 note（音高随 spin 上行）
      if (d.state === 'string' && d.spin > 0.12) {
        d.buzzT -= dt
        if (d.buzzT <= 0) {
          d.buzzT = 0.52 - 0.3 * d.spin
          const midi = PITCHES[Math.min(12, Math.floor(d.spin * 12.99))]
          this.ctx.audio.play('pop', 0.14, 0.85 + ((midi - 48) / 28) * 0.9)
        }
      } else {
        d.buzzT = 0
      }

      // 盘面角度（视觉：1.5+spin×28 rad/s）
      d.ang += (1.5 + d.spin * 28) * dt

      if (d.state === 'string') {
        if (b) {
          const warn = { v: '' }
          const tip = d.tickString(b, this.t, dt, this.cfg.gain, this.cfg.decay, warn)
          if (tip === 'full') {
            this.ctx.audio.combo() // chime + 金色光环
            this.banner = '转满啦！双手往上抛！'
            this.bannerT = 2
            this.ctx.speak('转满啦！双手往上抛！')
          } else if (tip === 'tilt') {
            this.ctx.audio.play('hit', 0.7, 0.7) // oops
            this.banner = '歪掉啦！'
            this.bannerT = 1.6
            this.say('歪掉啦！', px, this.H * 0.4, '#ff6b6b', 40)
          } else if (warn.v && this.t - d.warnT > 2.5) {
            d.warnT = this.t
            this.say(warn.v, px, this.H * 0.4, '#ffd54a', 30)
          }

          // 抛起尝试：先低后高，双手过头顶须在离肩 0.9s 内
          const r = d.tryThrow(b, this.t, d.spin >= FULL)
          if (r === 'launched') {
            d.state = 'air'
            d.launchT = this.t
            d.throws++
            this.ctx.audio.jump()
            this.ctx.audio.slash() // whoosh
            this.particles.burst(px, (b.shoulderC.y - 0.3) * this.H, '#ffe08a', 10, 340, 4)
          } else if (r === 'deny' && this.t - d.warnT > 2.5) {
            d.warnT = this.t
            const msg = '先抖满转速再抛！'
            this.say(msg, px, this.H * 0.36, '#8fd3ff', 32)
            this.ctx.speak(msg)
          }
        } else {
          // 人不在画面只按 decay 衰减
          d.spin -= this.cfg.decay * (0.3 + 0.7 * d.spin) * dt
        }
      } else if (d.state === 'air') {
        if (b) {
          d.updateReady(b, this.cfg.gap)
          const since = this.t - d.launchT
          if (d.ready && since >= AIR_T - CATCH_EARLY) {
            // 接住成功：花样 +10、streak++、spin 封顶 0.75（接完要重新抖）
            d.state = 'string'
            d.tricks++
            d.trickIdx++
            d.streak++
            d.bestStreak = Math.max(d.bestStreak, d.streak)
            d.spin = Math.min(d.spin, 0.75)
            d.full = false
            this.scoreF += 10
            const name = TRICK_NAMES[(d.trickIdx - 1) % TRICK_NAMES.length]
            this.say(`${name} +10`, px, this.H * 0.36, '#ffd54a', 40)
            this.ctx.audio.win() // tada + sparkle
            this.particles.burst(px, this.H * 0.4, '#ffe08a', 14, 380, 5)
            if (d.streak === 3 || d.streak % 5 === 0) {
              this.banner = `连续接住 ${d.streak} 个！`
              this.bannerT = 1.6
              this.ctx.audio.combo()
            }
          } else if (since > AIR_T + this.cfg.grace) {
            // 超 1.5+grace 未接 → 掉落
            d.state = 'drop'
            d.dropAt = this.t
            d.dropY = this.H * 0.25
            d.dropVy = 0
            d.streak = 0
            this.ctx.audio.fail()
            this.say('掉啦！', px, this.H * 0.5, '#ff6b6b', 40)
          }
        } else {
          d.state = 'drop'
          d.dropAt = this.t
          d.dropY = this.H * 0.25
          d.dropVy = 0
        }
      } else {
        // drop：1.3s 物理弹跳（重力 2600、反弹 ×−0.38）后回 string 态重来
        d.dropVy -= GRAVITY * dt
        d.dropY += d.dropVy * dt
        if (d.dropY <= 0 && d.dropVy < 0) {
          d.dropY = 0
          d.dropVy = Math.abs(d.dropVy) * -BOUNCE
          this.ctx.audio.play('drop', 0.5)
        }
        if (this.t - d.dropAt > DROP_T) {
          d.state = 'string'
          d.dropY = 0
          d.dropVy = 0
          d.spin = 0
          d.full = false
          d.intervals.length = 0
          d.lastFlipT = -9
          this.ctx.audio.play('click', 0.4, 1.2) // 重上绳 appear
        }
      }
    }

    if (this.bannerT > 0) this.bannerT -= dt

    // HUD
    this.ctx.setScore(Math.round(this.scoreF))
    const best = Math.max(...this.ds.map((d) => d.streak))
    this.ctx.setCombo(best)
    this.ctx.setExtra('最高转速', Math.round(Math.max(...this.ds.map((x) => x.maxSpin)) * 100))
    this.ctx.setExtra('抛接成功', this.ds.reduce((n, d) => n + d.tricks, 0))
    this.ctx.setExtra('最多连续接住', Math.max(...this.ds.map((d) => d.bestStreak)))
    const rs = this.ds.reduce((n, d) => n + d.regSum, 0)
    const rn = this.ds.reduce((n, d) => n + d.regN, 0)
    if (rn > 0) this.ctx.setExtra('节奏稳定', Math.round((rs / rn) * 100))
  }

  /** 底部常驻教学行 */
  private teachLine(): string {
    const d = this.ds.find((x) => x.state === 'air') ?? this.ds[0]
    if (d.state === 'air') return d.ready ? '对啦，接住！' : '两手放回胸前接住！'
    if (d.full) return '转满啦！双手往上抛！'
    const stab = d.regN ? d.regSum / d.regN : 0
    if (d.tricks > 0 && stab >= 0.6) return `节奏很稳 · 花样 ${d.tricks} 个`
    if (stab >= 0.3) return '再稳一点，转得更快'
    if (d.regN > 3) return '节奏乱啦，一上一下要匀'
    return '两手一上一下抖起来！'
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const duo = this.players.filter((p) => p.body).length > 1

    for (let pi = 0; pi < 2; pi++) {
      const d = this.ds[pi]
      const b = this.players[pi].body
      if (!b) continue
      const scale = Math.max(0.1, b.scale)
      const spanPx = scale * this.H
      const lx = b.lHand.x * this.W
      const ly = b.lHand.y * this.H
      const rx = b.rHand.x * this.W
      const ry = b.rHand.y * this.H

      // 双竿：从手向外下方伸（竿长 0.72×torso，基础夹角 0.8）
      c.save()
      c.strokeStyle = '#a97c50'
      c.lineWidth = 7 * U
      c.lineCap = 'round'
      const rod = ROD_LEN * spanPx
      const lEndX = lx + Math.sin(-ROD_ANG) * rod
      const lEndY = ly + Math.cos(-ROD_ANG) * rod
      const rEndX = rx + Math.sin(ROD_ANG) * rod
      const rEndY = ry + Math.cos(ROD_ANG) * rod
      c.beginPath()
      c.moveTo(lx, ly)
      c.lineTo(lEndX, lEndY)
      c.moveTo(rx, ry)
      c.lineTo(rEndX, rEndY)
      c.stroke()
      c.restore()

      if (d.state === 'string') {
        // 空竹位置：双手中点下方（绳下垂弧度系数 2.9 视觉近似）
        const mx = (lEndX + rEndX) / 2
        const my = (lEndY + rEndY) / 2 + spanPx * 0.22 * (SAG / 2.9)
        // 双绳（悬链线弧）
        c.save()
        c.strokeStyle = 'rgba(240,240,250,.85)'
        c.lineWidth = 2.5 * U
        c.beginPath()
        c.moveTo(lEndX, lEndY)
        c.quadraticCurveTo((lEndX + mx) / 2, Math.max(lEndY, my) + 8 * U, mx, my - 6 * U)
        c.moveTo(rEndX, rEndY)
        c.quadraticCurveTo((rEndX + mx) / 2, Math.max(rEndY, my) + 8 * U, mx, my - 6 * U)
        c.stroke()
        c.restore()
        // 转速模糊盘（椭圆 + 旋转辐条）
        const dr = Math.max(20 * U, spanPx * 0.3)
        c.save()
        c.translate(mx, my)
        if (d.full) glow(c, 0, 0, dr * 2, '#ffd54a', 0.45) // full 金色光环
        c.rotate(d.ang)
        c.fillStyle = '#e05a7a'
        c.beginPath()
        c.ellipse(0, 0, dr, dr * 0.42, 0, 0, Math.PI * 2)
        c.fill()
        c.strokeStyle = 'rgba(255,255,255,.75)'
        c.lineWidth = 3 * U
        for (const k of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          c.beginPath()
          c.moveTo(Math.cos(k) * dr * 0.2, Math.sin(k) * dr * 0.1)
          c.lineTo(Math.cos(k) * dr * 0.95, Math.sin(k) * dr * 0.4)
          c.stroke()
        }
        c.fillStyle = '#8d5b34'
        rr(c, -4 * U, -dr * 0.9, 8 * U, dr * 1.8, 3 * U)
        c.fill()
        c.restore()
        // 抖动方向提示
        if (d.spin < TIERS[0]) {
          txt(c, '↑↓ 抖起来', mx, my + dr + 26 * U, 20 * U, 'rgba(255,255,255,.8)')
        }
      } else if (d.state === 'air') {
        // 空中：抛起残影 3 帧 + 接住区提示（胸前两个绿圈）
        const prog = Math.min(1, (this.t - d.launchT) / AIR_T)
        const apex = Math.sin(prog * Math.PI)
        const mx = (lx + rx) / 2
        const my = (b.shoulderC.y - 0.5 - apex * 0.45) * this.H
        for (let g = 2; g >= 0; g--) {
          c.save()
          c.globalAlpha = 0.15 + g * 0.12
          c.translate(mx, my + g * 14 * U)
          c.rotate(d.ang - g * 0.4)
          const dr = Math.max(20 * U, spanPx * 0.3)
          c.fillStyle = '#e05a7a'
          c.beginPath()
          c.ellipse(0, 0, dr, dr * 0.42, 0, 0, Math.PI * 2)
          c.fill()
          c.restore()
        }
        // 接住区提示
        c.save()
        c.setLineDash([6, 6])
        c.strokeStyle = d.ready ? '#3ddc97' : '#ffd54a'
        c.lineWidth = 3 * U
        circle(c, lx, b.shoulderC.y * this.H + 10 * U, 12 * U, 'transparent')
        c.beginPath()
        c.arc(lx, b.shoulderC.y * this.H + 10 * U, 14 * U, 0, Math.PI * 2)
        c.stroke()
        c.beginPath()
        c.arc(rx, b.shoulderC.y * this.H + 10 * U, 14 * U, 0, Math.PI * 2)
        c.stroke()
        c.restore()
        txt(c, d.ready ? '对啦，接住！' : '两手放回胸前接住！', mx, my - 60 * U, 24 * U, d.ready ? '#3ddc97' : '#ffd54a')
      } else {
        // 掉落弹跳（dropY = 离地高度）
        const ground = this.H * 0.82
        const mx = (lx + rx) / 2
        const my = ground - Math.max(0, d.dropY)
        c.save()
        c.translate(mx, my)
        c.rotate(d.ang)
        const dr = Math.max(20 * U, spanPx * 0.3)
        c.fillStyle = '#b9b9c9'
        c.beginPath()
        c.ellipse(0, 0, dr, dr * 0.42, 0, 0, Math.PI * 2)
        c.fill()
        c.restore()
        txt(c, '掉啦！抖一抖重新上绳', mx, ground + 30 * U, 20 * U, '#ffb0b0')
      }

      // 竖直转速计（刻度 0.3/0.6/0.9）
      const mx0 = duo ? (pi === 0 ? 90 * U : this.W - 90 * U) : 90 * U
      const my0 = this.H * 0.62
      const mh = 220 * U
      c.save()
      rr(c, mx0 - 20 * U, my0 - mh, 40 * U, mh, 8 * U)
      c.fillStyle = 'rgba(16,22,52,.45)'
      c.fill()
      const fillH = mh * Math.max(0, Math.min(1, d.spin))
      c.fillStyle = d.full ? '#ffd54a' : d.spin >= TIERS[1] ? '#3ddc97' : '#5db6e8'
      rr(c, mx0 - 15 * U, my0 - fillH, 30 * U, fillH, 6 * U)
      c.fill()
      c.strokeStyle = 'rgba(255,255,255,.6)'
      c.lineWidth = 2
      for (const tIdx of TIERS) {
        const y = my0 - mh * tIdx
        c.beginPath()
        c.moveTo(mx0 - 20 * U, y)
        c.lineTo(mx0 + 20 * U, y)
        c.stroke()
      }
      c.restore()
      const tier = d.spin >= TIERS[2] ? 3 : d.spin >= TIERS[1] ? 2 : d.spin >= TIERS[0] ? 1 : 0
      txt(c, tier ? `${tier} 档 · 每秒 +${tier}` : '还没转起来', mx0, my0 + 20 * U, 16 * U, 'rgba(255,255,255,.85)')
      if (d.full) star(c, mx0, my0 - mh - 22 * U, 14 * U, '#ffd54a')
    }

    // 顶部/底部文字
    outlineTxt(c, '🪀 抖空竹', 130 * U, 48 * U, 32, '#ff9fbb')
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.banner, this.W / 2, 60 * U, 44, '#ffd54a')
      c.globalAlpha = 1
    }
    // 常驻教学行
    c.save()
    c.fillStyle = 'rgba(16,22,52,.45)'
    rr(c, this.W / 2 - 260 * U, this.H - 66 * U, 520 * U, 34 * U, 17 * U)
    c.fill()
    c.restore()
    txt(c, this.teachLine(), this.W / 2, this.H - 49 * U, 20 * U, '#ffe9c2')
    txt(c, '转满双手往上扬抛起，两手放回胸前接住（花样 +10）', this.W / 2, this.H - 22, 18, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new DiaboloGame(ctx)
}
