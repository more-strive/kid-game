import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 保龄球（对齐 dongdongpark 真实规则，报告 _reverse/reports/bowling.md）：
 * 手臂往后摆再往前一甩把球放出去（手低于髋开 1.2s 投掷窗，上甩出手），
 * 出手时手的横位定起点、0.14s 内身体倾斜定走向；球道物理简化为按 dt 累积步进
 * （原站为 240Hz 定步长 S=1/240，这里用累加器近似，规则数值不变）。
 * 5 轮每轮 2 球：全中 X / 补中 /，倒瓶直接累加（非标准计分，满分 50）。
 */

/** 对齐站点难度表：挡板 / 瓶阵散布 / 球半径(球道半宽=1) / 倾斜增益 / 出手速度门槛(躯干/s) / 慢球区间 / 球道宽系数 / 瞄准线比例 */
const DIFF = [
  { bumpers: true, spread: 0.94, ballR: 0.25, gain: 0.9, up: 2, slow: [3.4, 4.8] as const, width: 1.06, aim: 1 },
  { bumpers: false, spread: 1, ballR: 0.2, gain: 1.1, up: 2.5, slow: [2.8, 4.6] as const, width: 1, aim: 0.6 },
  { bumpers: false, spread: 1.06, ballR: 0.2, gain: 1.3, up: 2.5, slow: [2.6, 4.6] as const, width: 0.9, aim: 0.3 },
]
// 注：站点儿童模式覆盖（强制挡板/大球/门槛 1.8/增益 0.8）依赖 env.big，本框架无该开关，不叠加。

/** 10 瓶标准三角站位（行距 v=0.5，列距 u=0.289，×spread 散布） */
const PIN_SPOTS: [number, number][] = [
  [0, 0],
  [-0.289, 0.5], [0.289, 0.5],
  [-0.578, 1], [0, 1], [0.578, 1],
  [-0.867, 1.5], [-0.289, 1.5], [0.289, 1.5], [0.867, 1.5],
]
const STEP = 1 / 240 // 物理步长（本实现按 dt 累积近似）
const IMPULSE = 1.33 // 球撞瓶速度传递系数（1.55×C/7，C=6）
const BALL_SLOW = 0.221 // 球每撞一瓶的横向减速（1.55/7）
const PIN_FRICTION = 3.6 // 瓶滑动摩擦减速度 /s
const PIN_NEAR = 0.22 // 瓶受扰不倒的最近距离
const PIN_KNOCK = 0.5 // 直接撞倒距离
const PIN_PASS = 0.35 // 瓶间碰撞距离
const PIN_PASS_IMP = 0.825 // 瓶间冲量（1.65/2）
const PIT_V = 2.15 // 瓶滑入球坑的 v 阈值
const WALL_U = 1.225 // 瓶撞侧墙位置
const BALL_STOP_V = -0.7 // 球减速段结束的 v（g=-0.7 起 smoothstep 到 -3.5）
const BUMPER_U = 0.75 // 挡板内缩（球撞挡板 u=±(1−ballR×0.75)）
const DROP_WIN = 0.14 // 出手后 lean 采集窗 s
const ARM_WINDOW = 1.2 // 手低于髋后的投掷窗口 s
const FRAMES = 5 // 轮数
const TIMEOUT = 300 // 超时上限 s
const SHOW_T = 1.2 // show 阶段时长 s
const SWEEP_T = 0.85 // 清瓶扫杆时长 s
const PIN_W = 0.62 // 瓶绘制宽（球道单位）

interface BallObj {
  u: number
  v: number
  vu: number
  slope: number
  fast: number
  slow: number
  gutter: boolean
  rot: number
  /** 撞瓶音节流 */
  sndT: number
}

interface PinObj {
  u: number
  v: number
  vu: number
  vv: number
  state: 'stand' | 'slide' | 'pit'
  /** 摇晃幅度（受扰未倒） */
  wob: number
  /** 摇晃开始时刻 */
  wobT: number
  /** 延迟倒瓶计划时刻（>0 表示已安排） */
  fallAt: number
  /** 倒下动画进度 s */
  fallT: number
  dir: number
}

interface Deck {
  state: 'wait' | 'hold' | 'drop' | 'roll' | 'show' | 'sweep' | 'done'
  frame: number
  ball: number
  active: boolean
  /** 投掷窗口截止时刻（本局时间） */
  armedUntil: number
  power: number
  u0: number
  uEnd: number
  leanT: number
  ballObj: BallObj | null
  pins: PinObj[]
  standingBefore: number
  stateT: number
  strikes: number
  spares: number
  /** 每轮得分（两球合计倒瓶） */
  framePts: number[]
  marks: string[]
  /** 持球手（0 左 1 右） */
  handIdx: number
  /** 距离上次有手低于髋的时长（挂机提示） */
  idleT: number
  hintCd: number
  /** 出手窗内手曾达到的速度 */
  swingPeak: number
  noReleaseCd: number
  sndCd: number
}

function newDeck(): Deck {
  return {
    state: 'wait',
    frame: 0,
    ball: 0,
    active: true,
    armedUntil: -1,
    power: 0,
    u0: 0,
    uEnd: 0,
    leanT: 0,
    ballObj: null,
    pins: [],
    standingBefore: 10,
    stateT: 0,
    strikes: 0,
    spares: 0,
    framePts: [],
    marks: [],
    handIdx: 1,
    idleT: 0,
    hintCd: 0,
    swingPeak: 0,
    noReleaseCd: 0,
    sndCd: 0,
  }
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x))
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function smoothstep(a: number, b: number, x: number) {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

class Bowling extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  decks = [newDeck(), newDeck()]
  /** 全局出球数：双人轮流（偶数 0 号） */
  ballCount = 0
  bannerT = 0
  bannerText = ''
  bannerColor = '#fff'
  shakeT = 0
  finished = false
  endTimer = -1
  /** 定时 confetti 波（strike：0.15+i×0.28） */
  waves: { at: number }[] = []

  private duo() {
    return this.players.filter((p) => p.body).length > 1
  }

  /** 球道几何：cx / half / 纵向映射 */
  private lane(pi: number) {
    const duo = this.duo()
    const cx = duo ? (pi === 0 ? this.W * 0.28 : this.W * 0.72) : this.W / 2
    const half = Math.min(this.W * 0.14, this.H * 0.25) * this.cfg.width
    const yNear = this.H * 0.88
    const yFar = this.H * 0.34
    return { cx, half, yNear, yFar }
  }

  /** 球道坐标 → 屏幕（伪 3D：近宽远窄） */
  private proj(pi: number, u: number, v: number) {
    const g = this.lane(pi)
    const s = clamp((v + 12) / 14.75, 0, 1.05)
    const pw = 1 - s * 0.45
    return { x: g.cx + u * g.half * pw, y: g.yNear - s * (g.yNear - g.yFar), pw }
  }

  tick(f: PoseFrame, dt: number) {
    const duo = this.duo()
    if (!this.finished && this.t > TIMEOUT) {
      this.finishGame()
      return
    }
    if (this.bannerT > 0) this.bannerT -= dt
    if (this.shakeT > 0) this.shakeT -= dt
    // strike 的 4 波定时 confetti
    for (let i = this.waves.length - 1; i >= 0; i--) {
      this.waves[i].at -= dt
      if (this.waves[i].at <= 0) {
        this.waves.splice(i, 1)
        this.particles.confetti(this.W, 26)
      }
    }

    // 双人轮流：偶数球 0 号
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      const b = f.bodies[pi]
      dk.active = duo ? this.ballCount % 2 === pi : true
      dk.sndCd = Math.max(0, dk.sndCd - dt)
      dk.hintCd = Math.max(0, dk.hintCd - dt)
      dk.noReleaseCd = Math.max(0, dk.noReleaseCd - dt)
      if (dk.state === 'done') continue
      if (!dk.active) {
        // 待机：显示闲置球提示
        continue
      }

      const T = b ? Math.max(60, Math.max(0.05, b.scale) * this.H) : this.H * 0.2

      // ---- 状态机 ----
      if (dk.state === 'wait') {
        dk.state = 'hold'
        dk.power = 0
        dk.swingPeak = 0
        dk.armedUntil = -1
        this.rack(dk)
      }

      if (dk.state === 'hold' && b) {
        // 持球手切换：持球手低于髋(0.2T)且另一手举过髋上 0.7T
        const hands = [b.lHand, b.rHand]
        const hipY = b.hipC.y * this.H
        const cur = hands[dk.handIdx]
        const other = hands[1 - dk.handIdx]
        if (cur.y * this.H > hipY + 0.2 * T && other.y * this.H < hipY - 0.7 * T) dk.handIdx = 1 - dk.handIdx
        const hand = hands[dk.handIdx]
        const g = this.lane(pi)
        dk.u0 = clamp(((hand.x * this.W - g.cx) / g.half), -0.85, 0.85)
        dk.uEnd = dk.u0

        // 手速（躯干/s，取当前帧速度并追踪峰值）
        const vel = dk.handIdx === 0 ? b.lHandV : b.rHandV
        const velT = vel / Math.max(0.05, b.scale)
        dk.swingPeak = Math.max(dk.swingPeak, velT)

        // 手落到髋线以下 → 开 1.2s 投掷窗口
        if (hand.y * this.H > hipY) {
          dk.idleT += dt
          if (dk.armedUntil < 0) {
            dk.armedUntil = this.t + ARM_WINDOW
            dk.power = 0
            dk.swingPeak = 0
          }
        } else {
          dk.idleT = 0
        }
        // 挂机 8s 提示
        if (dk.idleT > 8) {
          dk.idleT = 0
          this.say('往后摆，再往前甩！', this.W / 2, this.H * 0.3, '#ffe27a', 38)
        }
        // 窗口内上甩出手：−velY/torso > up 且手在髋上 0.3T 到肩下 0.6T 之间
        if (dk.armedUntil > 0 && this.t <= dk.armedUntil) {
          const trail = (dk.handIdx === 0 ? this.players[pi].lHand : this.players[pi].rHand).trail
          let vyUp = 0
          if (trail.length >= 2) {
            const a = trail[trail.length - 2]
            const z = trail[trail.length - 1]
            vyUp = (-(z.y - a.y) / Math.max(0.001, dt)) / Math.max(0.05, b.scale)
          }
          const shoulderY = b.shoulderC.y * this.H
          // 手在「髋上 0.3T 到肩下 0.6T」之间（腰带高度出手区）
          const inBand = hand.y * this.H >= hipY - 0.3 * T && hand.y * this.H <= shoulderY + 0.6 * T
          dk.power = Math.max(dk.power, velT)
          if (vyUp > this.cfg.up && inBand) {
            this.throwBall(pi, dk)
            continue
          }
        } else if (dk.armedUntil > 0 && this.t > dk.armedUntil) {
          // 窗口关闭，等手再次落低
          dk.armedUntil = -1
        }
        // 举得够高但没快甩 → 提示（3s 冷却）
        if (hand.y * this.H < hipY - 0.75 * T && dk.swingPeak >= Math.min(1.4, this.cfg.up * 0.7) && dk.noReleaseCd <= 0) {
          dk.noReleaseCd = 3
          this.say('再快一点甩！', this.W / 2, this.H * 0.3, '#9ad0ff', 36)
        }
      }

      if (dk.state === 'drop') {
        // 出手后 0.14s 内持续采集 lean 更新 uEnd
        dk.leanT += dt
        if (b) {
          const lean = ((b.shoulderC.x - b.hipC.x) * this.W) / T
          dk.uEnd = clamp(dk.u0 + lean * this.cfg.gain, -1.2, 1.2)
        }
        dk.stateT -= dt
        if (dk.stateT <= 0) {
          // 发射：slope = (uEnd−u0)/12
          const bo = dk.ballObj!
          bo.slope = (dk.uEnd - dk.u0) / 12
          const t = clamp((dk.power - this.cfg.up) / 3.5, 0, 1)
          bo.fast = lerp(6.5, 10.5, t)
          bo.slow = lerp(this.cfg.slow[0], this.cfg.slow[1], t)
          dk.state = 'roll'
          this.ctx.audio.slash()
        }
      }

      if (dk.state === 'roll' || dk.state === 'show') {
        // 物理步进（按 dt 累积近似 240Hz 定步长）
        dk.stateT -= dt
        this.physics(dk, dt)
        if (dk.state === 'roll' && dk.ballObj && dk.ballObj.v > 2.75) {
          dk.state = 'show'
          dk.stateT = SHOW_T
        }
        if (dk.state === 'show' && dk.stateT <= 0) {
          this.settleFrame(pi, dk, duo)
        }
      }

      if (dk.state === 'sweep') {
        dk.stateT -= dt
        // 扫杆推走未消失的倒瓶（进度 >0.6 时清走）
        if (dk.stateT < SWEEP_T * 0.4) {
          for (const p of dk.pins) if (p.state !== 'stand' && p.state !== 'pit') p.state = 'pit'
        }
        if (dk.stateT <= 0) this.nextBall(pi, dk)
      }
    }

    // ---- 结束 ----
    if (!this.finished && this.decks.every((d) => d.state === 'done')) {
      const max = Math.max(...this.decks.map((d) => d.framePts.reduce((a, c) => a + c, 0)))
      this.bannerText = '打完啦！'
      this.bannerColor = '#ffd54a'
      this.bannerT = 1.6
      this.endTimer = 1.6
      this.bannerText = duo ? '打完啦！' : '打完啦！'
      this.endSub = `倒了 ${max} 个瓶子`
      this.ctx.audio.play('win', 0.9)
    }
    if (this.endTimer > 0) {
      this.endTimer -= dt
      if (this.endTimer <= 0 && !this.finished) this.finishGame()
    }

    this.ctx.setScore(this.decks.reduce((n, d) => n + d.framePts.reduce((a, c) => a + c, 0), 0))
    this.ctx.setExtra('全中', this.decks.reduce((n, d) => n + d.strikes, 0))
    this.ctx.setExtra('补中', this.decks.reduce((n, d) => n + d.spares, 0))
    const cur = this.decks[duo ? this.ballCount % 2 : 0]
    this.ctx.setStage(`第 ${Math.min(FRAMES, cur.frame + 1)}/${FRAMES} 轮`)
  }

  endSub = ''

  /** 出手：记录起点 u0、力度，进入 0.14s drop 窗采集 lean */
  private throwBall(_pi: number, dk: Deck) {
    dk.ballObj = { u: clamp(dk.u0, -0.95, 0.95), v: -12, vu: 0, slope: 0, fast: 6.5, slow: this.cfg.slow[0], gutter: false, rot: 0, sndT: 0 }
    dk.state = 'drop'
    dk.stateT = DROP_WIN
    dk.armedUntil = -1
    dk.standingBefore = dk.pins.filter((p) => p.state === 'stand').length
    this.ballCount++
  }

  /** 摆新瓶阵（strike 后直接换新阵） */
  private rack(dk: Deck) {
    dk.pins = PIN_SPOTS.map(([u, v]) => ({
      u: u * this.cfg.spread,
      v,
      vu: 0,
      vv: 0,
      state: 'stand' as const,
      wob: 0,
      wobT: 0,
      fallAt: 0,
      fallT: 0,
      dir: 0,
    }))
  }

  /** 球道物理（简化：dt 累积步进；数值与原站一致） */
  private physics(dk: Deck, dt: number) {
    const bo = dk.ballObj
    let acc = Math.min(dt, 0.05)
    while (acc > 0) {
      const S = Math.min(STEP, acc)
      acc -= S
      if (bo) {
        // 球速：v 从 -3.5 到 -0.7 smoothstep 由 fast 减到 slow
        const k = smoothstep(-3.5, BALL_STOP_V, bo.v)
        const vv = lerp(bo.fast, bo.slow, k)
        const vu = bo.slope * vv
        bo.v += vv * S
        bo.u += vu * S
        bo.rot += vv * S * 1.4 / this.cfg.ballR
        // 边界：挡板反弹 slope×=-0.75 / 入沟
        const bl = 1 - this.cfg.ballR * BUMPER_U
        if (Math.abs(bo.u) > bl) {
          if (this.cfg.bumpers) {
            bo.slope *= -0.75
            bo.u = clamp(bo.u, -bl, bl)
            if (dk.sndCd <= 0) {
              dk.sndCd = 0.1
              this.ctx.audio.play('hit', 0.5, 1.6)
            }
          } else {
            // 入沟：锁定 u 向沟心
            bo.gutter = true
            bo.slope = 0
            bo.u = Math.sign(bo.u) * 1.14
            if (dk.sndCd <= 0) {
              dk.sndCd = 0.4
              this.ctx.audio.play('drop', 0.6, 0.7)
            }
          }
        }
        // 球撞瓶
        for (const p of dk.pins) {
          if (p.state !== 'stand') continue
          const du = p.u - bo.u
          const dv = p.v - bo.v
          const d = Math.hypot(du, dv)
          const rr2 = this.cfg.ballR + 0.12
          if (d < rr2 && d > 1e-4) {
            // 接近速度（沿法线）
            const closing = -(du / d) * vu - (dv / d) * vv
            if (closing > 0) {
              // 瓶获得速度 1.33×接近速度
              if (d < PIN_KNOCK) {
                p.state = 'slide'
                p.vu = (du / d) * IMPULSE * closing
                p.vv = (dv / d) * IMPULSE * closing
                p.dir = Math.atan2(p.vv, p.vu)
                p.fallT = 0
              } else if (d >= PIN_NEAR && d < PIN_KNOCK && p.fallAt <= 0) {
                // 摇晃延迟倒瓶
                p.wob = Math.min(0.35, (d - PIN_NEAR) * 0.8)
                p.wobT = 0
                const chance = ((d - PIN_NEAR) / (PIN_KNOCK - PIN_NEAR)) * 0.7
                if (Math.random() < chance) p.fallAt = 0.55 + Math.random() * 0.4
              }
              // 球每撞一瓶减速
              bo.slope *= 1 - BALL_SLOW
              if (dk.sndCd <= 0) {
                dk.sndCd = 0.06
                this.ctx.audio.play(closing > 1.5 ? 'hit' : 'click', 0.8, closing > 1.5 ? 1 : 1.2)
              }
            }
          }
        }
      }
      // 瓶物理
      for (const p of dk.pins) {
        if (p.state === 'pit') continue
        // 摇晃计时推进（供绘制摇晃动画）
        if (p.state === 'stand' && p.wob > 0) p.wobT += S
        // 摇晃延迟倒瓶计时
        if (p.fallAt > 0) {
          p.fallAt -= S
          if (p.fallAt <= 0 && p.state === 'stand') {
            p.state = 'slide'
            p.vu = (Math.random() - 0.5) * 1.4
            p.vv = (Math.random() * 0.6 + 0.4) * 1.2
            p.dir = Math.atan2(p.vv, p.vu)
            p.fallT = 0
          }
          continue
        }
        if (p.state !== 'slide') continue
        p.fallT += S
        // 滑动摩擦 3.6/s
        const sp = Math.hypot(p.vu, p.vv)
        if (sp > 0.01) {
          const dec = Math.min(sp, PIN_FRICTION * S)
          p.vu -= (p.vu / sp) * dec
          p.vv -= (p.vv / sp) * dec
        }
        p.u += p.vu * S
        p.v += p.vv * S
        // 瓶间碰撞：距离 <0.35 传递冲量 1.65/2×接近速度
        for (const q of dk.pins) {
          if (q === p || q.state !== 'stand') continue
          const du = q.u - p.u
          const dv = q.v - p.v
          const d = Math.hypot(du, dv)
          if (d < PIN_PASS && d > 1e-4) {
            const closing = -(du / d) * p.vu - (dv / d) * p.vv
            if (closing > 0) {
              q.state = 'slide'
              q.vu = (du / d) * PIN_PASS_IMP * closing
              q.vv = (dv / d) * PIN_PASS_IMP * closing
              q.dir = Math.atan2(q.vv, q.vu)
              q.fallT = 0
              p.vu *= 0.5
              p.vv *= 0.5
            }
          }
        }
        // 侧墙 |u|>1.225 反弹 ×0.55
        if (Math.abs(p.u) > WALL_U) {
          p.u = clamp(p.u, -WALL_U, WALL_U)
          p.vu *= -0.55
          if (dk.sndCd <= 0) {
            dk.sndCd = 0.08
            this.ctx.audio.play('click', 0.4, 0.8)
          }
        }
        // 入坑消失
        if (p.v > PIT_V) p.state = 'pit'
        // 回弹 v<−0.5 ×0.3
        if (p.v < -0.5) {
          p.v = -0.5
          p.vv *= -0.3
        }
      }
    }
  }

  /** 一轮结算：倒瓶 = 之前立瓶 − 现立瓶 */
  private settleFrame(_pi: number, dk: Deck, duo: boolean) {
    const standingNow = dk.pins.filter((p) => p.state === 'stand').length
    const down = dk.standingBefore - standingNow
    if (dk.ball === 0 && down === 10) {
      // 全中 strike：+10、大红横幅、tada、4 波定时 confetti、震屏 6
      dk.strikes++
      dk.framePts.push(10)
      dk.marks.push('X')
      this.bannerText = '全中！'
      this.bannerColor = '#ff5a5a'
      this.bannerT = 1.4
      this.shakeT = 0.5
      for (let i = 0; i < 4; i++) this.waves.push({ at: 0.15 + i * 0.28 })
      this.ctx.audio.play('win', 1)
    } else if (dk.ball === 1 && standingNow === 0) {
      // 补中 spare：蓝横幅 + confetti×30
      dk.spares++
      dk.framePts.push(down)
      dk.marks.push('/')
      this.bannerText = '补中！'
      this.bannerColor = '#4cc9f0'
      this.bannerT = 1.2
      this.particles.confetti(this.W, 30)
      this.ctx.audio.good()
    } else {
      dk.framePts.push(down)
      dk.marks.push(String(down))
      if (down >= 8) {
        this.bannerText = `倒了${down}个！`
        this.bannerColor = '#ffd54a'
        this.bannerT = 1
      } else if (down >= 1) {
        this.bannerText = `倒了${down}个！`
        this.bannerColor = '#ffe27a'
        this.bannerT = 0.8
      } else {
        // 0 瓶区分入沟 / 没碰到
        const gutter = dk.ballObj?.gutter ?? false
        this.bannerText = gutter ? '掉进边沟了' : '没碰到'
        this.bannerColor = '#c9c9d9'
        this.bannerT = 1
        this.ctx.audio.fail()
      }
    }
    if (down >= 1 && dk.marks[dk.marks.length - 1] !== 'X') this.ctx.audio.coin()
    void duo
    dk.state = 'sweep'
    dk.stateT = SWEEP_T
    dk.ballObj = null
  }

  /** 下一球 / 下一轮 / 结束 */
  private nextBall(_pi: number, dk: Deck) {
    const wasStrike = dk.marks[dk.marks.length - 1] === 'X'
    if (dk.ball === 0 && !wasStrike) {
      // 第二球：只保留立瓶（清走倒瓶）
      dk.pins = dk.pins.filter((p) => p.state === 'stand')
      dk.ball = 1
      dk.standingBefore = dk.pins.length
      dk.state = 'hold'
      dk.power = 0
      dk.swingPeak = 0
    } else {
      // strike 或第二球后：换新瓶阵、下一轮
      dk.ball = 0
      dk.frame++
      if (dk.frame >= FRAMES) {
        dk.state = 'done'
        return
      }
      dk.state = 'wait'
    }
  }

  private finishGame() {
    if (this.finished) return
    this.finished = true
    this.ctx.finish()
  }

  // ---- 绘制 ----

  paint(c: CanvasRenderingContext2D) {
    const duo = this.players.filter((p) => p.body).length > 1
    const U = this.H / 720
    if (this.shakeT > 0) {
      const amp = 6 * (this.shakeT / 0.5)
      c.save()
      c.translate(Math.sin(this.t * 70) * amp, Math.cos(this.t * 63) * amp * 0.5)
    }

    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      if (duo && !this.players[pi].body) continue
      this.paintLane(c, pi)
      this.paintPins(c, pi, dk)

      // 球（滚动 / 持球 / 待机闲置球）
      const b = this.players[pi].body
      if (dk.ballObj && (dk.state === 'roll' || dk.state === 'show')) {
        const bo = dk.ballObj
        const p = this.proj(pi, bo.u, bo.v)
        const r = this.cfg.ballR * this.lane(pi).half * p.pw
        // 影子
        c.save()
        c.globalAlpha = 0.2
        circle(c, p.x + 6 * U, p.y + r * 0.55, r * 1.05, '#1a1030')
        c.restore()
        this.paintBall(c, p.x, p.y, r, bo.rot)
      } else if (b && (dk.state === 'hold' || dk.state === 'drop')) {
        const hand = dk.handIdx === 0 ? b.lHand : b.rHand
        const r = this.cfg.ballR * this.lane(pi).half
        this.paintBall(c, hand.x * this.W, hand.y * this.H + r * 0.5, r, this.t * 0.8)
        // 瞄准辅助线：hold 状态画预测轨迹点（14 个椭圆点，u0→uEnd 线性插值）
        if (dk.state === 'hold') this.paintAimLine(c, pi, dk)
      } else if (!dk.active && duo) {
        // 对方待机：闲置球 + 等一等
        const g = this.lane(pi)
        const p = this.proj(pi, 0, -11)
        this.paintBall(c, p.x, p.y, this.cfg.ballR * g.half * p.pw * 0.9, this.t * 0.3)
        c.save()
        c.globalAlpha = 0.6 + Math.sin(this.t * 4) * 0.2
        txt(c, '等一等 ⏳', g.cx, p.y - 60 * U, 24, '#ffffffcc')
        c.restore()
      }

      // 清瓶扫杆
      if (dk.state === 'sweep') {
        const k = 1 - dk.stateT / SWEEP_T
        const v = -0.7 + (2.35 - -0.7) * k
        const a = this.proj(pi, -1.08, v)
        const bb = this.proj(pi, 1.08, v)
        c.save()
        c.fillStyle = '#e8ecf7'
        c.strokeStyle = 'rgba(20,24,60,.5)'
        c.lineWidth = 2
        rr(c, a.x, a.y - 14 * U, bb.x - a.x, 16 * U, 6 * U)
        c.fill()
        c.stroke()
        c.restore()
      }

      // 记分卡
      this.paintCard(c, pi, dk, duo)
    }

    if (this.shakeT > 0) c.restore()

    // 大横幅
    if (this.bannerT > 0 && this.bannerText) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 56, this.bannerColor)
      c.globalAlpha = 1
    }
    if (this.bannerT > 0 && this.endSub) {
      outlineTxt(c, this.endSub, this.W / 2, this.H * 0.24 + 62, 32, '#fff')
    }
    txt(c, '手臂往后摆，再往前一甩！出手时身体往哪边歪，球就往哪边滚', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }

  /** 瞄准辅助线：只画到 v = −12+12×aim；会入沟则灰点并截断 */
  private paintAimLine(c: CanvasRenderingContext2D, pi: number, dk: Deck) {
    const n = 14
    let cut = n
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const v = -12 + 12 * this.cfg.aim * t
      const u = lerp(dk.u0, dk.uEnd, t)
      const p = this.proj(pi, u, v)
      const gutter = Math.abs(u) > 1 && !this.cfg.bumpers
      if (gutter && cut === n) cut = i
      if (i > cut) break
      c.save()
      c.globalAlpha = gutter ? 0.35 : 0.6
      c.beginPath()
      c.ellipse(p.x, p.y, 7 * p.pw, 3.5 * p.pw, 0, 0, Math.PI * 2)
      c.fillStyle = gutter ? '#888' : '#fff'
      c.fill()
      c.restore()
    }
    // 终点箭头
    const vEnd = -12 + 12 * this.cfg.aim
    const uEnd = lerp(dk.u0, dk.uEnd, 1)
    const p = this.proj(pi, uEnd, vEnd)
    c.save()
    c.fillStyle = Math.abs(uEnd) > 1 && !this.cfg.bumpers ? '#888' : '#ffd54a'
    c.beginPath()
    c.moveTo(p.x, p.y - 14 * p.pw)
    c.lineTo(p.x - 8 * p.pw, p.y + 6 * p.pw)
    c.lineTo(p.x + 8 * p.pw, p.y + 6 * p.pw)
    c.closePath()
    c.fill()
    c.restore()
  }

  /** 伪 3D 球道：木纹板条 + 边沟 + 红色箭头标记 + 定位点 */
  private paintLane(c: CanvasRenderingContext2D, pi: number) {
    // 球道木面
    const tl = this.proj(pi, -1, -12)
    const bl = this.proj(pi, -1, 2.75)
    const br = this.proj(pi, 1, 2.75)
    const tr = this.proj(pi, 1, -12)
    c.beginPath()
    c.moveTo(tl.x, tl.y)
    c.lineTo(bl.x, bl.y)
    c.lineTo(br.x, br.y)
    c.lineTo(tr.x, tr.y)
    c.closePath()
    c.fillStyle = 'rgba(196,150,96,.34)'
    c.fill()
    // 木纹板条（纵向分隔线）
    c.save()
    c.strokeStyle = 'rgba(120,80,40,.22)'
    c.lineWidth = 1.5
    for (let i = -8; i <= 8; i++) {
      const u = i / 8
      const a = this.proj(pi, u, -12)
      const b2 = this.proj(pi, u, 2.75)
      c.beginPath()
      c.moveTo(a.x, a.y)
      c.lineTo(b2.x, b2.y)
      c.stroke()
    }
    // 横向定位线
    for (const v of [-6, -2]) {
      const a = this.proj(pi, -1, v)
      const b2 = this.proj(pi, 1, v)
      c.beginPath()
      c.moveTo(a.x, a.y)
      c.lineTo(b2.x, b2.y)
      c.stroke()
    }
    c.restore()
    // 红色箭头标记 ±0.27×{−3..3}
    c.save()
    c.fillStyle = 'rgba(200,40,40,.55)'
    for (const k of [-3, -2, -1, 0, 1, 2, 3]) {
      const p = this.proj(pi, 0.27 * k, -6 - Math.abs(k) * 0.4)
      const s = 10 * p.pw
      c.beginPath()
      c.moveTo(p.x, p.y - s)
      c.lineTo(p.x - s * 0.6, p.y + s * 0.6)
      c.lineTo(p.x + s * 0.6, p.y + s * 0.6)
      c.closePath()
      c.fill()
    }
    c.restore()
    // 边沟（两侧深槽）
    for (const side of [-1, 1]) {
      const a1 = this.proj(pi, side, -12)
      const a2 = this.proj(pi, side * 1.3, -12)
      const b1 = this.proj(pi, side, 2.75)
      const b2 = this.proj(pi, side * 1.3, 2.75)
      c.beginPath()
      c.moveTo(a1.x, a1.y)
      c.lineTo(a2.x, a2.y)
      c.lineTo(b2.x, b2.y)
      c.lineTo(b1.x, b1.y)
      c.closePath()
      c.fillStyle = 'rgba(30,22,50,.4)'
      c.fill()
    }
    // 挡板（easy）
    if (this.cfg.bumpers) {
      for (const side of [-1, 1]) {
        const a = this.proj(pi, side * 1.02, -12)
        const b2 = this.proj(pi, side * 1.02, 2.2)
        c.strokeStyle = '#ff5a5a'
        c.lineWidth = 6
        c.beginPath()
        c.moveTo(a.x, a.y)
        c.lineTo(b2.x, b2.y)
        c.stroke()
      }
    }
    // 底部瓶坑暗带
    const p1 = this.proj(pi, -1.3, PIT_V)
    const p2 = this.proj(pi, 1.3, 2.75)
    c.fillStyle = 'rgba(16,10,32,.45)'
    c.fillRect(p1.x, p1.y, p2.x - p1.x, Math.max(8, (p2.y - p1.y) * 0.4))
  }

  private paintPins(c: CanvasRenderingContext2D, pi: number, dk: Deck) {
    const half = this.lane(pi).half
    // 按v 从远到近画
    const list = dk.pins.filter((p) => p.state !== 'pit').slice().sort((a, b) => a.v - b.v)
    for (const p of list) {
      const pr = this.proj(pi, p.u, p.v)
      const w = PIN_W * half * pr.pw * 0.5
      const h = w * 2.4
      c.save()
      c.translate(pr.x, pr.y)
      // 影子
      c.save()
      c.globalAlpha = 0.18
      c.beginPath()
      c.ellipse(3, h * 0.42, w * 1.1, w * 0.4, 0, 0, Math.PI * 2)
      c.fillStyle = '#1a1030'
      c.fill()
      c.restore()
      if (p.state === 'stand') {
        // 摇晃动画（计时在物理步进里推进）
        const wob = p.wob > 0 ? Math.sin(p.wobT * 22) * Math.min(0.35, p.wob * 0.6) * Math.exp(-p.wobT * 1.8) : 0
        c.rotate(wob)
        this.paintPin(c, 0, 0, w, h, false)
      } else {
        // 倒下动画：绕撞击方向旋转 + 压扁
        const k = Math.min(1, p.fallT / 0.22)
        const ease = 1 - Math.pow(1 - k, 3)
        c.rotate(Math.sin(p.dir) * 0 + p.dir + ease * 1.35)
        c.scale(1, 1 - ease * 0.55)
        this.paintPin(c, 0, 0, w, h, k > 0.5)
      }
      c.restore()
    }
  }

  /** 一只瓶：白瓶身 + 红颈条纹 */
  private paintPin(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, lying: boolean) {
    const g = c.createLinearGradient(x - w, y, x + w, y)
    g.addColorStop(0, '#fdf7ee')
    g.addColorStop(1, '#d9d2c5')
    c.fillStyle = lying ? '#cfc8ba' : g
    c.beginPath()
    c.ellipse(x, y - h * 0.3, w * 0.75, h * 0.5, 0, 0, Math.PI * 2)
    c.fill()
    // 瓶颈
    c.fillStyle = lying ? '#c4bcb0' : '#fdf7ee'
    c.beginPath()
    c.ellipse(x, y - h * 0.62, w * 0.42, h * 0.22, 0, 0, Math.PI * 2)
    c.fill()
    // 红条纹
    c.fillStyle = '#e23d3d'
    c.fillRect(x - w * 0.4, y - h * 0.5, w * 0.8, h * 0.05)
    c.fillRect(x - w * 0.34, y - h * 0.44, w * 0.68, h * 0.04)
    // 描边
    c.strokeStyle = 'rgba(40,30,20,.35)'
    c.lineWidth = 1.5
    c.beginPath()
    c.ellipse(x, y - h * 0.3, w * 0.75, h * 0.5, 0, 0, Math.PI * 2)
    c.stroke()
  }

  private paintBall(c: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number) {
    c.save()
    c.translate(x, y)
    glow(c, 0, 0, r * 1.8, '#4cc9f0', 0.22)
    const g = c.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r)
    g.addColorStop(0, '#5aa7e8')
    g.addColorStop(1, '#22348c')
    c.beginPath()
    c.arc(0, 0, r, 0, Math.PI * 2)
    c.fillStyle = g
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.4)'
    c.lineWidth = 2
    c.stroke()
    // 三个指孔随滚动旋转
    c.rotate(rot)
    c.fillStyle = 'rgba(10,14,40,.75)'
    for (const [hx, hy] of [[-0.18, -0.28], [0.18, -0.28], [0, -0.02]]) {
      c.beginPath()
      c.arc(hx * r, hy * r, r * 0.11, 0, Math.PI * 2)
      c.fill()
    }
    c.restore()
  }

  /** 记分卡：每轮 2 格，X 红 / 蓝 / 0 → -；轮号圈当前轮高亮 */
  private paintCard(c: CanvasRenderingContext2D, pi: number, dk: Deck, duo: boolean) {
    const U = this.H / 720
    const cell = 30 * U
    const x0 = duo ? (pi === 0 ? this.W * 0.28 - cell * 3.4 : this.W * 0.72 - cell * 3.4) : this.W * 0.06
    const y0 = duo ? 84 * U : 90 * U
    c.save()
    c.globalAlpha = 0.85
    rr(c, x0 - 8, y0 - 8, cell * 6.4 + 16, cell + 16, 10)
    c.fillStyle = 'rgba(10,14,40,.45)'
    c.fill()
    c.restore()
    for (let fr = 0; fr < FRAMES; fr++) {
      const x = x0 + fr * cell * 1.3
      // 轮号圈
      const cur = fr === dk.frame && dk.state !== 'done'
      c.save()
      if (cur) {
        c.strokeStyle = this.players[pi].color
        c.lineWidth = 3
        c.beginPath()
        c.arc(x + cell * 0.14, y0 + cell * 0.5, cell * 0.78, 0, Math.PI * 2)
        c.stroke()
      }
      c.restore()
      const m = dk.marks[fr] ?? ''
      if (!m) continue
      const col = m === 'X' ? '#ff5a5a' : m === '/' ? '#4cc9f0' : '#fff'
      outlineTxt(c, m, x + cell * 0.14, y0 + cell * 0.5, cell * 0.9, col)
    }
    // 累计分
    const total = dk.framePts.reduce((a, c2) => a + c2, 0)
    outlineTxt(c, String(total), x0 + cell * 6.6, y0 + cell * 0.5, cell * 1.1, this.players[pi].color)
  }
}

export default function create(ctx: GameContext) {
  return new Bowling(ctx)
}
