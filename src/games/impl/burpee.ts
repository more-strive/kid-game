import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 波比跳挑战（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/burpee.md）：
 * 三步状态机 ①蹲下双手摸地(0) → ②站起(1) → ③跳起双手举过头(2)，60 秒内追上教练目标（20/24/28 个）。
 *
 * 站点框架行为等价代理说明：
 * - motion.squat（0~1 蹲深）：引擎侧无该特征，用膝关节平均弯曲角折算（站直≈172°、深蹲≈92°），
 *   报告全部阈值（0.32/0.15/0.2/0.4/depth）照抄。
 * - 跳跃检测：站点 events/motion.jump → 髋基线抬升通道（>0.2×torso，回落<0.08 复位，
 *   基线按报告速率 |位移|<0.12?4/s:0.4/s 吸收站位漂移）。
 * - 站点 highlight(秒)（HUD 高亮时长）：本框架无该 API，用计分数字 pop 放大衰减近似。
 * - 教练（AI 演示卡 + 节奏）只是叙事与目标参照，进度不参与判定，count===goal 即三星横幅（报告 §8）。
 * - 音效映射：coin→play('score')、sparkle→good、tada→win、boop→click(低增益)（站点音效名缺采样）。
 * - 音乐 run：BGM 由外壳统一管理，游戏内不另起。
 */

// ---- 难度表 h（报告 §1 全部字面量） ----
const DIFF = [
  { depth: 0.45, handDrop: -0.25, window: 3, both: false, goal: 20 },
  { depth: 0.55, handDrop: 0, window: 2, both: false, goal: 24 },
  { depth: 0.62, handDrop: 0.05, window: 1.5, both: true, goal: 28 },
]
const DIP_ENTER = 0.32 // _：squat>0.32 才进入下蹲相
const DIP_FAIL = 0.15 // v：下蹲中途 squat<0.15 判失败
const STAND_EXIT = 0.2 // y：squat<0.2 → 站起达成
const TOUCH_WIN = 0.22 // b：摸地双条件（蹲深事件与手放低事件）相隔窗口
const JUMP_RISE = 0.2 // x：髋部抬升 >0.2×torso
const JUMP_RESET = 0.08 // 回落 <0.08 复位
const REST_GAP = 0.6 // S：两个波比之间的恢复间隔
const TIP_THROTTLE = 2.5 // C：同一玩家提示节流
const IDLE_T = 7 // w：闲置提醒
const HAND_LATE_T = 0.7 // 蹲够深但手 0.7s 还没低 → 提示「双手摸地」
const STEP2_GUARD = 0.3 // 站起 0.3s 后 squat 又>0.4 → 失败「先跳起来再蹲」
const JUMP_CD = 0.45 // 跳事件冷却
const JUMP_GUARD_SQUAT = 0.4 // step2 抢蹲判定阈值

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v))
}

/** 膝角（度）：a 髋 b 膝 c 踝 */
function kneeAngle(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const v1x = a.x - b.x
  const v1y = a.y - b.y
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const d = v1x * v2x + v1y * v2y
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1
  return (Math.acos(Math.max(-1, Math.min(1, d / m))) * 180) / Math.PI
}

/** motion.squat 代理：膝关节平均弯曲角折算蹲深 0~1（站直≈0、深蹲≈1） */
function squatDepth(b: Body): number {
  const okL = (b.lm[25]?.visibility ?? 0) >= 0.3 && (b.lm[27]?.visibility ?? 0) >= 0.3
  const okR = (b.lm[26]?.visibility ?? 0) >= 0.3 && (b.lm[28]?.visibility ?? 0) >= 0.3
  const angs: number[] = []
  if (okL) angs.push(kneeAngle(b.lHip, b.lKnee, b.lFoot))
  if (okR) angs.push(kneeAngle(b.rHip, b.rKnee, b.rFoot))
  if (!angs.length) return 0
  const avg = angs.reduce((n, v) => n + v, 0) / angs.length
  return clamp01((172 - avg) / 80)
}

/** 躯干长（肩中点-髋中点，归一化），下限防抖 */
function torsoOf(b: Body): number {
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const hipY = (b.lm[23].y + b.lm[24].y) / 2
  return Math.max(0.06, Math.abs(hipY - shY))
}

interface PS {
  step: 0 | 1 | 2
  stepAt: number
  dipping: boolean
  dipAt: number
  peak: number
  deepAt: number
  lowAt: number
  jumpDone: boolean
  handDone: boolean
  hipBase: number
  airborne: boolean
  jumpAt: number
  jumpNow: boolean
  pc: number
  lastOkAt: number
  idleTipAt: number
  tipAt: number
  tip: string
  tipUntil: number
  times: number[]
}

class Burpee extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ps: PS[] = [this.newPS(), this.newPS()]
  count = 0
  fails = 0
  best10 = 0
  fastest = 0
  bannerText = ''
  bannerT = 0
  /** highlight 代理：数字 pop 剩余时长 */
  popT = 0
  popAt = -9
  guide = [false, false, false]
  spoke30 = false
  started = false
  /** 教练节奏 */
  coachN = 0
  coachT = 0
  coachGap = 2.45
  coachBase = 2.45
  coachStep: 0 | 1 | 2 = 0
  private realClock = 0

  private newPS(): PS {
    return {
      step: 0,
      stepAt: 0,
      dipping: false,
      dipAt: 0,
      peak: 0,
      deepAt: -1,
      lowAt: -1,
      jumpDone: false,
      handDone: false,
      hipBase: NaN,
      airborne: false,
      jumpAt: -9,
      jumpNow: false,
      pc: 0,
      lastOkAt: 0,
      idleTipAt: 0,
      tipAt: -9,
      tip: '',
      tipUntil: 0,
      times: [],
    }
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.popT = Math.max(0, this.popT - dt)
    super.update(f, dt)
  }

  tick(f: PoseFrame, dt: number) {
    if (!this.started) {
      this.started = true
      this.ctx.audio.play('win', 0.5, 1)
      this.ctx.setStage(`追上教练 ${this.cfg.goal} 个！`)
    }
    if (!this.spoke30 && this.t >= 30) {
      this.spoke30 = true
      this.ctx.speak('坚持住，还有三十秒！')
    }
    this.tickCoach(dt)

    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi] ?? null
      const st = this.ps[pi]
      if (!b) {
        st.dipping = false
        continue
      }
      const torso = torsoOf(b)
      const squat = squatDepth(b)
      this.updateJump(st, b, squat, torso, dt)
      // 「手放低」判定线：hipC.y + handDrop×torso（easy 线在髋上方 → 手过髋就算低）
      const lowLine = b.hipC.y + this.cfg.handDrop * torso
      const handsLow = b.lHand.y > lowLine && b.rHand.y > lowLine
      // 举手：双手 y 都低于 head.y − 0.05×torso（即高过头），armsUp 作事件补充
      const handsHigh = b.armsUp || (b.lHand.y < b.head.y - 0.05 * torso && b.rHand.y < b.head.y - 0.05 * torso)

      // 逐步首次语音引导：蹲下摸地 → 站起来 → 跳起来，手举高
      if (!this.guide[st.step]) {
        this.guide[st.step] = true
        this.ctx.speak(['蹲下去，双手摸地', '站起来', '跳起来，手举高'][st.step])
      }

      switch (st.step) {
        case 0: {
          if (!st.dipping) {
            if (squat > DIP_ENTER && this.t - st.lastOkAt > REST_GAP) {
              st.dipping = true
              st.dipAt = this.t
              st.peak = squat
              st.deepAt = -1
              st.lowAt = -1
            }
          } else {
            st.peak = Math.max(st.peak, squat)
            if (squat >= this.cfg.depth && st.deepAt < 0) st.deepAt = this.t
            if (handsLow && st.lowAt < 0) st.lowAt = this.t
            if (st.deepAt >= 0 && st.lowAt >= 0 && Math.abs(st.deepAt - st.lowAt) < TOUCH_WIN) {
              // 摸地达成 → step 1
              st.dipping = false
              st.step = 1
              st.stepAt = this.t
              this.ctx.audio.pop()
              break
            }
            if (st.deepAt >= 0 && st.lowAt < 0 && this.t - st.deepAt > HAND_LATE_T) {
              this.tip(pi, st, '双手摸地')
            }
            if (squat < DIP_FAIL) {
              this.onFail(pi, st, st.peak < this.cfg.depth ? '蹲低一点' : '双手摸地')
            }
          }
          break
        }
        case 1: {
          if (squat < STAND_EXIT) {
            st.step = 2
            st.stepAt = this.t
            st.jumpDone = false
            st.handDone = false
            this.ctx.audio.click()
          }
          break
        }
        case 2: {
          if (st.jumpNow) st.jumpDone = true
          if (handsHigh) st.handDone = true
          const ok = this.cfg.both ? st.jumpDone && st.handDone : st.jumpDone || st.handDone
          if (ok) {
            this.onOk(b, st)
            break
          }
          if (this.t - st.stepAt > STEP2_GUARD && squat > JUMP_GUARD_SQUAT) {
            this.onFail(pi, st, '先跳起来再蹲')
            break
          }
          if (this.t - st.stepAt > this.cfg.window) {
            const tip = !st.jumpDone && !st.handDone ? '跳起来，手举过头' : !st.jumpDone ? '跳起来' : '手举过头'
            this.onFail(pi, st, tip)
          }
          break
        }
      }

      // 闲置提醒：7s 无进展 → 「跟着教练做」
      if (this.t - st.lastOkAt > IDLE_T && this.t - st.idleTipAt > IDLE_T) {
        st.idleTipAt = this.t
        this.tip(pi, st, '跟着教练做')
      }
      if (st.tipUntil && this.t > st.tipUntil) st.tip = ''
    }

    this.ctx.setScore(this.count)
    this.ctx.setCombo(Math.max(this.ps[0].pc, this.ps[1].pc))
    this.ctx.setExtra('最快10秒', this.best10)
    const total = this.count + this.fails
    this.ctx.setExtra('完成率(%)', total ? Math.round((100 * this.count) / total) : 100)
    this.ctx.setExtra('最快一个(秒)', this.fastest)
  }

  /** 髋基线抬升跳检测：>0.2×torso 触发（冷却 0.45s），回落<0.08 复位；基线按报告速率吸收漂移 */
  private updateJump(st: PS, b: Body, squat: number, torso: number, dt: number) {
    st.jumpNow = false
    if (!Number.isFinite(st.hipBase)) st.hipBase = b.hipC.y
    if (!st.airborne) {
      if (squat < 0.12) {
        const off = b.hipC.y - st.hipBase
        st.hipBase += off * Math.min(1, dt * (Math.abs(off) < 0.12 ? 4 : 0.4))
      }
      const rise = (st.hipBase - b.hipC.y) / torso
      if (rise > JUMP_RISE && this.t - st.jumpAt > JUMP_CD) {
        st.airborne = true
        st.jumpAt = this.t
        st.jumpNow = true
      }
    } else {
      const rise = (st.hipBase - b.hipC.y) / torso
      if (rise < JUMP_RESET) st.airborne = false
    }
  }

  private onOk(b: Body, st: PS) {
    st.step = 0
    st.dipping = false
    st.lastOkAt = this.t
    st.idleTipAt = this.t
    st.pc++
    this.count++
    st.times.push(this.t)
    while (st.times.length && st.times[0] <= this.t - 10) st.times.shift()
    this.best10 = Math.max(this.best10, st.times.length)
    if (st.times.length >= 2) {
      const gap = st.times[st.times.length - 1] - st.times[st.times.length - 2]
      if (!this.fastest || gap < this.fastest) this.fastest = Math.round(gap * 100) / 100
    }
    const hx = b.head.x * this.W
    const hy = b.head.y * this.H
    this.say('+1', hx, hy - 44, '#ffffff', 30)
    this.particles.burst(hx, hy - 10, '#ffd54a', 10, 300, 5)
    this.ctx.addScore(1)
    // coin 音，音高 1+min(0.5, count×0.02) 渐升
    this.ctx.audio.play('score', 0.85, 1 + Math.min(0.5, st.pc * 0.02))
    this.popAt = this.realClock
    this.popT = 0.8 // highlight(0.8)
    if (st.pc % 5 === 0) {
      this.banner(`${st.pc} 个！`, 1.2)
      this.ctx.audio.good() // sparkle
      this.particles.burst(this.W / 2, this.H * 0.3, '#ffe97a', 14, 360, 5)
      this.popT = 1.2 + st.pc / 10 // highlight(1.2+count/10)
    }
    if (st.pc === this.cfg.goal && st.pc > 0) {
      this.banner('追上教练啦！', 1.5)
      this.ctx.audio.win() // tada
      this.particles.confetti(this.W, 36)
      this.popT = 3 // highlight(3)
      this.ctx.speak('追上教练啦！')
    }
  }

  private onFail(pi: number, st: PS, tip: string) {
    this.fails++
    st.step = 0
    st.dipping = false
    this.tip(pi, st, tip)
  }

  /** 提示节流 2.5s（报告 C） */
  private tip(pi: number, st: PS, text: string) {
    if (this.t - st.tipAt < TIP_THROTTLE) return
    st.tipAt = this.t
    st.tip = text
    st.tipUntil = this.t + 1.6
    st.idleTipAt = Math.max(st.idleTipAt, this.t - IDLE_T + 2.5)
    this.ctx.audio.play('click', 0.6, 0.8) // boop 代理
    void pi
  }

  private banner(text: string, sec: number) {
    this.bannerText = text
    this.bannerT = sec
  }

  /** 教练节奏：2.45 + min(0.6, 序号×0.028) ± 0.15 秒/个，每 7 个休息 +1.3s（报告 §2.2） */
  private tickCoach(dt: number) {
    this.coachT += dt
    if (this.coachT >= this.coachGap) {
      this.coachT = 0
      this.coachN++
      this.coachBase = 2.45 + Math.min(0.6, this.coachN * 0.028)
      this.coachGap = this.coachBase + (Math.random() * 0.3 - 0.15) + (this.coachN % 7 === 0 ? 1.3 : 0)
    }
    const fr = clamp01(this.coachT / this.coachGap)
    this.coachStep = fr < 0.4 ? 0 : fr < 0.65 ? 1 : 2
  }

  // ---------- 绘制 ----------

  paint(c: CanvasRenderingContext2D) {
    const unit = this.H / 720
    this.paintCoach(c, unit)
    const duo = this.players.filter((p) => p.body).length > 1
    for (let pi = 0; pi < 2; pi++) {
      const pv = this.players[pi]
      const b = pv.body
      const st = this.ps[pi]
      if (!b) continue
      const zx = duo ? (pi === 0 ? this.W * 0.25 : this.W * 0.75) : this.W * 0.14
      // 大数字（pop 高亮代理）
      const k = Math.max(0, 1 - (this.realClock - this.popAt) / Math.min(0.8, Math.max(0.25, this.popT)))
      c.save()
      c.translate(zx, this.H * (duo ? 0.32 : 0.3))
      c.scale(1 + 0.3 * k, 1 + 0.3 * k)
      outlineTxt(c, String(st.pc), 0, 0, 96, pv.color)
      c.restore()
      txt(c, '个', zx, this.H * (duo ? 0.32 : 0.3) + 64, 24, 'rgba(255,255,255,.75)', 'center', 'bold')
      // 脚下提示环
      this.paintHints(c, b, st.step, st.jumpDone, st.handDone)
      // 步骤卡
      this.paintSteps(c, zx, this.H * 0.9, st, unit)
      if (st.tip) {
        outlineTxt(c, st.tip, b.shoulderC.x * this.W, (b.shoulderC.y - 0.14) * this.H, 36, '#ff8a8a')
      }
      // 我的节奏（大屏面板）
      if (!duo) this.paintPace(c, st)
      else {
        const pace = st.pc >= 2 ? this.t / st.pc : 0
        if (pace) {
          const col = pace <= this.coachBase + 0.05 ? '#3ddc97' : pace <= this.coachBase * 1.3 ? '#ffb703' : '#ff6b6b'
          txt(c, `${pace.toFixed(1)} 秒/个`, zx, this.H * 0.42, 22, col, 'center', 'bold')
        }
      }
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.2, 52, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(
      c,
      `蹲下摸地 → 站起 → 跳起举手 · 60 秒追上教练的 ${this.cfg.goal} 个`,
      this.W / 2,
      this.H - 30,
      20,
      'rgba(255,255,255,.8)',
      'center',
      'bold',
    )
  }

  /** 教练示范卡（左上角）：小人同步演示当前步 + 目标节奏 */
  private paintCoach(c: CanvasRenderingContext2D, unit: number) {
    const x = 24
    const y = 24
    const w = 188 * unit
    const h = 208 * unit
    c.fillStyle = 'rgba(10,14,40,.55)'
    c.beginPath()
    c.roundRect(x, y, w, h, 18 * unit)
    c.fill()
    outlineTxt(c, '教练', x + w / 2, y + 26 * unit, 24, '#ffd54a')
    txt(c, `${this.coachBase.toFixed(1)} 秒一个`, x + w / 2, y + 50 * unit, 16, 'rgba(255,255,255,.75)', 'center', 'bold')
    txt(c, `目标 ${this.cfg.goal} 个`, x + w / 2, y + 70 * unit, 16, 'rgba(255,255,255,.75)', 'center', 'bold')

    // 演示小人（三步姿势）
    const cx = x + w / 2
    const gy = y + h - 26 * unit
    const s = 44 * unit
    let hipY = gy - s * 0.9
    let handY = gy - s * 0.2
    let headOff = 0
    let armUp = false
    if (this.coachStep === 0) {
      hipY = gy - s * 0.45
      handY = gy - s * 0.05
    } else if (this.coachStep === 2) {
      hipY = gy - s * 1.05
      handY = gy - s * 1.7
      headOff = -s * 0.18
      armUp = true
    }
    const headY = hipY - s * 0.72 + headOff
    c.strokeStyle = '#7dd3fc'
    c.lineWidth = 5 * unit
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(cx, hipY)
    c.lineTo(cx, headY + 12 * unit)
    c.stroke()
    // 手臂
    c.beginPath()
    c.moveTo(cx - 8 * unit, hipY - s * 0.55)
    c.lineTo(cx - 16 * unit, armUp ? handY : handY)
    c.moveTo(cx + 8 * unit, hipY - s * 0.55)
    c.lineTo(cx + 16 * unit, handY)
    c.stroke()
    // 腿
    c.beginPath()
    c.moveTo(cx, hipY)
    c.lineTo(cx - 13 * unit, gy)
    c.moveTo(cx, hipY)
    c.lineTo(cx + 13 * unit, gy)
    c.stroke()
    circle(c, cx, headY, 11 * unit, '#ffd9b3')
  }

  /** 脚下提示环：step0 绿色目标圈（手）、step1 上升箭头、step2 头顶黄圈 + 脚下橙箭头 */
  private paintHints(c: CanvasRenderingContext2D, b: Body, step: 0 | 1 | 2, jumpDone: boolean, handDone: boolean) {
    const t = this.t
    if (step === 0) {
      for (const h of [b.lHand, b.rHand]) {
        c.beginPath()
        c.arc(h.x * this.W, h.y * this.H, 26 + Math.sin(t * 6) * 3, 0, Math.PI * 2)
        c.strokeStyle = 'rgba(61,220,151,.9)'
        c.lineWidth = 5
        c.stroke()
      }
    } else if (step === 1) {
      const ax = b.shoulderC.x * this.W
      const ay = (b.shoulderC.y - 0.22) * this.H + Math.sin(t * 8) * 5
      c.fillStyle = '#3ddc97'
      c.beginPath()
      c.moveTo(ax, ay - 16)
      c.lineTo(ax - 12, ay + 4)
      c.lineTo(ax + 12, ay + 4)
      c.closePath()
      c.fill()
    } else {
      const hx = b.head.x * this.W
      const hy = (b.head.y - 0.14) * this.H
      for (const s of [-1, 1]) {
        c.beginPath()
        c.arc(hx + s * 60, hy, 22, 0, Math.PI * 2)
        c.strokeStyle = 'rgba(255,212,74,.9)'
        c.lineWidth = 5
        c.stroke()
      }
      outlineTxt(c, handDone ? '✓手' : '手', hx - 60, hy, 22, handDone ? '#3ddc97' : '#ffd54a')
      outlineTxt(c, jumpDone ? '✓跳' : '跳', hx + 60, hy, 22, jumpDone ? '#3ddc97' : '#ffd54a')
      // 脚下橙色跳跃箭头
      const fx = b.hipC.x * this.W
      const fy = Math.max(b.lFoot.y, b.rFoot.y) * this.H + 24
      c.fillStyle = '#ff8a3d'
      c.beginPath()
      c.moveTo(fx, fy - 18 + Math.sin(t * 8) * 4)
      c.lineTo(fx - 13, fy + Math.sin(t * 8) * 4)
      c.lineTo(fx + 13, fy + Math.sin(t * 8) * 4)
      c.closePath()
      c.fill()
    }
  }

  /** 三步进度卡：当前步呼吸放大、完成变绿打勾 */
  private paintSteps(c: CanvasRenderingContext2D, cx: number, cy: number, st: PS, unit: number) {
    const labels = ['蹲·摸地', '站起', '跳·举手']
    const w = 96 * unit
    const gap = 10 * unit
    const x0 = cx - (w * 3 + gap * 2) / 2
    for (let i = 0; i < 3; i++) {
      const done = st.step > i || (st.step === 0 && i === 0 && st.pc > 0 && !st.dipping && this.t - st.lastOkAt < 1.2)
      const active = st.step === i
      const breathe = active ? 1 + Math.sin(this.t * 5) * 0.05 : 1
      const x = x0 + i * (w + gap)
      c.save()
      c.translate(x + w / 2, cy)
      c.scale(breathe, breathe)
      c.fillStyle = done ? 'rgba(61,220,151,.85)' : active ? 'rgba(255,212,74,.25)' : 'rgba(10,14,40,.5)'
      c.beginPath()
      c.roundRect(-w / 2, -24 * unit, w, 48 * unit, 12 * unit)
      c.fill()
      if (done) {
        outlineTxt(c, '✓', -w / 2 + 20 * unit, 0, 22, '#0d3a26')
        txt(c, labels[i], 8 * unit, 0, 17, '#0d3a26', 'center', 'bold')
      } else {
        txt(c, labels[i], 0, -6 * unit, 17, active ? '#ffd54a' : 'rgba(255,255,255,.8)', 'center', 'bold')
        // step2 显示「跳/手」两个小圆点收集状态
        if (i === 2) {
          circle(c, -16 * unit, 12 * unit, 5 * unit, st.jumpDone ? '#3ddc97' : 'rgba(255,255,255,.3)')
          circle(c, 16 * unit, 12 * unit, 5 * unit, st.handDone ? '#3ddc97' : 'rgba(255,255,255,.3)')
          txt(c, '跳', -16 * unit, 12 * unit, 8, '#0d3a26', 'center', 'bold')
          txt(c, '手', 16 * unit, 12 * unit, 8, '#0d3a26', 'center', 'bold')
        }
      }
      c.restore()
    }
  }

  /** 我的节奏面板：实时秒/个（颜色分级）+ 最快10秒 + 进度条（对齐报告 §4） */
  private paintPace(c: CanvasRenderingContext2D, st: PS) {
    const x = this.W - 232
    const y = 24
    const w = 208
    const h = 118
    c.fillStyle = 'rgba(10,14,40,.55)'
    c.beginPath()
    c.roundRect(x, y, w, h, 16)
    c.fill()
    outlineTxt(c, '我的节奏', x + w / 2, y + 24, 22, '#ffffff')
    const pace = st.pc >= 2 ? this.t / st.pc : 0
    if (pace) {
      // ≤目标+0.05 绿 / ≤目标×1.3 橙 / 更慢红
      const col = pace <= this.coachBase + 0.05 ? '#3ddc97' : pace <= this.coachBase * 1.3 ? '#ffb703' : '#ff6b6b'
      outlineTxt(c, `${pace.toFixed(1)} 秒/个`, x + w / 2, y + 54, 28, col)
    } else {
      txt(c, '做完第一个就出节奏', x + w / 2, y + 54, 16, 'rgba(255,255,255,.6)', 'center', 'bold')
    }
    txt(c, `最快10秒 ${this.best10} 个`, x + w / 2, y + 82, 16, 'rgba(255,255,255,.8)', 'center', 'bold')
    const pct = clamp01(st.pc / this.cfg.goal)
    c.fillStyle = 'rgba(255,255,255,.2)'
    c.beginPath()
    c.roundRect(x + 18, y + 96, w - 36, 8, 4)
    c.fill()
    c.fillStyle = '#ffd54a'
    c.beginPath()
    c.roundRect(x + 18, y + 96, (w - 36) * pct, 8, 4)
    c.fill()
    ring(c, x + 18 + (w - 36) * pct, y + 100, 9, 1, '#fff', 2)
  }
}

export default function create(ctx: GameContext) {
  return new Burpee(ctx)
}
