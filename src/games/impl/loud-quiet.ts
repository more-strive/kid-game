import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, ring, rr, txt } from '@/core/draw'

/**
 * 悄悄话大声喊 / loud-quiet（对齐 dongdongpark 真实规则）：
 * 左边情景卡（五种目标音量）+ 右边音量温度计（绿带=刚刚好）；把音量顶进绿带并保持，
 * 每 0.2 秒 +1 分（所有玩家同时加，麦克风单路共享=合作）。唯一判定输入是 mic，肢体只做声波圈特效。
 *
 * 全部字面量沿用站点：窗口半宽 0.3/0.22/0.15（居中型 = center ± w/2）、题长 [6.5,8]/[5,7]/[4.5,6]
 * ×(1−0.2×heat)、换题反应宽限 1.3/1.1/0.9s、计分心跳 0.2s、首题固定「一起唱歌」、
 * wolf 大声线 = 0.9−w（充能 +0.55/出窗 −0.3/宽限 −0.9 每秒、胜利线 1.15、重臂 0.8、上限 1.3、起始 1.25）、
 * shh 静音线 = 0.75w（入睡 +0.14/s 封顶 1）、3 秒保持里程碑、出窗 0.4s 红字/2.2s 语音教练（每题一次）、
 * 表针平滑 14/s、绿带平滑 7/s（仅显示）、题库 seed rng(1) 洗牌循环不重复。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 e.mic 黑盒 → 本框架 mic.level = (RMS−噪声底)×6 的 EMA 平滑值（12/s），量纲需真机校准；
 *    站点判定用逐帧原始值，我们用平滑值（抗抖动，代价是边界响应略钝）；
 * 2) 站点精灵情景卡 → 几何绘制（卡名+提示语+情景 emoji）；e.big 无对应概念，统一用文字提示；
 * 3) 双人共享一个分数（仓库口径，站点也是双人同分合作）；
 * 4) ai() 演示替身未实装。
 */
type Kind = 'song' | 'kitten' | 'whisper' | 'wolf' | 'shh'

const CARDS: { kind: Kind; name: string; emoji: string; center: number; tip: string; col: string }[] = [
  { kind: 'song', name: '一起唱歌', emoji: '🎤', center: 0.53, tip: '跟着唱"啦啦啦～"', col: '#4cc9f0' },
  { kind: 'kitten', name: '小猫睡觉', emoji: '🐱', center: 0.2, tip: '轻轻唱"睡吧，睡吧～"', col: '#9be15d' },
  { kind: 'whisper', name: '说悄悄话', emoji: '🤫', center: 0.33, tip: '小声说"我喜欢你"', col: '#b088f0' },
  { kind: 'wolf', name: '大灰狼来了', emoji: '🐺', center: 0.85, tip: '大声喊"走开！"', col: '#ff6b6b' },
  { kind: 'shh', name: '嘘，别出声', emoji: '😴', center: 0, tip: '一点声音也不出', col: '#8fa3d0' },
]

/** 站点三档：窗口半宽 / 题长区间 / 反应宽限 */
const DIFF = [
  { w: 0.3, dur: [6.5, 8] as [number, number], react: 1.3 },
  { w: 0.22, dur: [5, 7] as [number, number], react: 1.1 },
  { w: 0.15, dur: [4.5, 6] as [number, number], react: 0.9 },
]

const HEARTBEAT = 0.2 // 计分心跳（秒）
const HINT_T = 0.4 // 出窗红字延迟
const COACH_T = 2.2 // 语音教练延迟
const HOLD_STAR = 3 // 保持里程碑（秒）
const WOLF_WIN = 1.15
const WOLF_REARM = 0.8
const WOLF_CAP = 1.3
const SLEEP_RATE = 0.14

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class LoudQuiet extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  kind: Kind = 'song'
  cardAt = 0
  cardDur = 7
  cardN = -1
  private order: Kind[] = []
  private oi = 0
  needle = 0
  bandLo = 0
  bandHi = 1
  V = 0 // 计分心跳累加器
  te = 0 // 判定期入窗总时
  ee = 0 // 判定期总时
  hold = 0
  bestHold = 0
  outT = 0
  starShown = false
  coached = false
  wolfQ = 0
  wolfArmed = false
  sleep = 0
  stars: { x: number; y: number; vx: number; vy: number }[] = []
  private rng = mulberry32(1)

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.mic.ensure().catch(() => undefined)
    this.nextCard(true)
  }

  /** 出题器：seed rng(1) 洗牌循环，重洗后首张与当前题相同则轮转一位 */
  private nextCard(first: boolean) {
    if (this.oi >= this.order.length) {
      const kinds = CARDS.map((c) => c.kind)
      for (let i = kinds.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1))
        ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
      }
      if (kinds[0] === this.kind) kinds.push(kinds.shift()!)
      this.order = kinds
      this.oi = 0
    }
    const k = first ? 'song' : this.order[this.oi++]
    this.kind = k
    this.cardN++
    this.cardAt = this.t
    this.cardDur = (this.cfg.dur[0] + this.rng() * (this.cfg.dur[1] - this.cfg.dur[0])) * (1 - 0.2 * this.ctx.heat)
    this.hold = 0
    this.starShown = false
    this.coached = false
    this.outT = 0
    if (k === 'wolf') {
      this.wolfQ = 1.25
      this.wolfArmed = false
      this.ctx.audio.play('tick', 0.7, 0.6)
    } else if (k === 'shh') {
      this.sleep = 0
      this.ctx.audio.play('tick', 0.6)
    } else {
      this.ctx.audio.play('pop', 0.5)
    }
    const card = CARDS.find((c) => c.kind === k)!
    if (this.cardN > 0) this.say(`${card.name}！`, this.W * 0.2, this.H * 0.3, card.col, 30)
    else this.say(card.tip, this.W * 0.2, this.H * 0.3, card.col, 24)
    void first
  }

  /** 当前卡的判定窗口 [lo, hi] */
  private window(): [number, number] {
    const w = this.cfg.w
    const card = CARDS.find((c) => c.kind === this.kind)!
    if (this.kind === 'wolf') return [0.9 - w, 1.01]
    if (this.kind === 'shh') return [0, 0.75 * w]
    return [Math.max(0.02, card.center - w / 2), card.center + w / 2]
  }

  tick(f: PoseFrame, dt: number) {
    void f
    const mic = this.ctx.mic
    const now = this.t
    const grace = now - this.cardAt < this.cfg.react
    const [lo, hi] = this.window()
    const micV = mic.level
    const inWin = micV >= lo && micV <= hi

    if (!grace) this.ee += dt
    // 状态与计分
    if (grace) {
      this.hold = 0
    } else if (inWin) {
      this.te += dt
      this.hold += dt
      this.bestHold = Math.max(this.bestHold, this.hold)
      this.V += dt
      while (this.V >= HEARTBEAT) {
        this.V -= HEARTBEAT
        this.ctx.addScore(1)
      }
      if (this.hold >= HOLD_STAR && !this.starShown) {
        this.starShown = true
        this.say('稳稳的！', this.W * 0.2, this.H * 0.42, '#ffd54a', 26)
        this.particles.burst(this.W * 0.2, this.H * 0.5, '#ffd54a', 10, 240, 4)
      }
      if (this.kind === 'shh') this.sleep = Math.min(1, this.sleep + SLEEP_RATE * dt)
    } else {
      this.hold = 0
      this.outT += dt
      if (this.outT > COACH_T && !this.coached) {
        this.coached = true
        if (this.kind === 'wolf') this.ctx.speak('再大声一点！')
        else if (this.kind === 'shh') this.ctx.speak('嘘，不出声。')
        else if (micV > hi) this.ctx.speak('小声一点。')
        else this.ctx.speak('大声一点点。')
      }
    }
    // wolf 充能战
    if (this.kind === 'wolf') {
      if (grace) {
        this.wolfQ = Math.max(0.45, this.wolfQ - 0.9 * dt)
        if (this.wolfQ < WOLF_REARM) this.wolfArmed = false
      } else if (inWin) {
        this.wolfQ = Math.min(WOLF_CAP, this.wolfQ + 0.55 * dt)
        if (this.wolfQ >= WOLF_WIN && !this.wolfArmed) {
          this.wolfArmed = true
          this.say('大灰狼跑啦！', this.W * 0.2, this.H * 0.46, '#9aa4b5', 30)
          this.particles.burst(this.W * 0.2, this.H * 0.5, '#9aa4b5', 14, 260, 4)
          this.ctx.audio.play('click', 0.7, 0.8)
        }
      } else {
        this.wolfQ = Math.max(0, this.wolfQ - 0.3 * dt)
        if (this.wolfQ < WOLF_REARM) this.wolfArmed = false
      }
    }
    // 换题
    if (now - this.cardAt >= this.cardDur) this.nextCard(false)

    // —— 显示平滑 ——
    this.needle += (micV - this.needle) * Math.min(1, dt * 14)
    const [nlo, nhi] = this.window()
    this.bandLo += (nlo - this.bandLo) * Math.min(1, dt * 7)
    this.bandHi += (nhi - this.bandHi) * Math.min(1, dt * 7)

    this.ctx.setExtra('pct', this.ee > 0.1 ? Math.round((100 * this.te) / Math.max(0.1, this.ee)) : 0)
    this.ctx.setExtra('hold', Math.round(this.bestHold * 10) / 10)
  }

  paint(c: CanvasRenderingContext2D) {
    const card = CARDS.find((c2) => c2.kind === this.kind)!
    const [lo, hi] = this.window()
    const grace = this.t - this.cardAt < this.cfg.react
    const U = Math.min(this.W, this.H) / 720
    // 情景卡
    const cw = 330 * U
    const ch = Math.min(this.H * 0.5, 340 * U)
    const cx = 36 * U
    const cy = this.H * 0.54 - ch / 2
    rr(c, cx, cy, cw, ch, 18)
    c.fillStyle = '#fffdf3'
    c.fill()
    c.strokeStyle = card.col
    c.lineWidth = 5
    c.stroke()
    txt(c, card.emoji, cx + cw / 2, cy + 60 * U, 64 * U, '#26152c')
    txt(c, card.name, cx + cw / 2, cy + ch - 66 * U, 26 * U, card.col, 'center', 'bold')
    // 提示（出窗 0.4s 后变红/蓝指令）
    let tipCol = '#5a4632'
    let tip = card.tip
    if (!grace && this.outT > HINT_T) {
      if (this.kind === 'shh') {
        tip = '嘘，别出声！'
        tipCol = '#4cc9f0'
      } else if (this.needle > hi) {
        tip = '小声一点！'
        tipCol = '#4cc9f0'
      } else {
        tip = '再大声一点！'
        tipCol = '#ff5d5d'
      }
    }
    txt(c, tip, cx + cw / 2, cy + ch - 30 * U, 17 * U, tipCol, 'center', 'bold')
    // wolf 充能条
    if (this.kind === 'wolf') {
      const qy = cy - 16 * U
      c.fillStyle = 'rgba(0,0,0,.15)'
      c.fillRect(cx, qy - 8, cw, 8)
      c.fillStyle = this.wolfQ >= WOLF_WIN ? '#6bcb77' : '#ff6b6b'
      c.fillRect(cx, qy - 8, cw * clamp(this.wolfQ / WOLF_WIN, 0, 1), 8)
      txt(c, '狼', cx + cw / 2, qy - 16, 14 * U, '#9aa4b5')
    }

    // 音量温度计
    const tw = 64 * U
    const tTop = 150 * U
    const tBot = this.H - 78 * U
    const tx = this.W - 140 * U
    rr(c, tx, tTop, tw, tBot - tTop, tw / 2)
    c.fillStyle = '#26152c33'
    c.fill()
    // 渐变填充（底蓝→中黄→顶红）
    const gh = tBot - tTop
    const gg = c.createLinearGradient(0, tBot, 0, tTop)
    gg.addColorStop(0, '#4cc9f0')
    gg.addColorStop(0.5, '#ffd54a')
    gg.addColorStop(1, '#ff5d5d')
    const fillH = gh * clamp(this.needle, 0, 1)
    c.fillStyle = gg
    c.fillRect(tx, tBot - fillH, tw, fillH)
    // 绿带
    const bandY = (v: number) => tBot - clamp(v, 0, 1) * gh
    const by1 = bandY(this.bandHi)
    const by2 = bandY(this.bandLo)
    c.fillStyle = grace ? 'rgba(107,203,119,' + (0.35 + Math.sin(this.t * 6) * 0.15) + ')' : 'rgba(107,203,119,.35)'
    c.fillRect(tx, by1, tw, by2 - by1)
    c.strokeStyle = grace ? 'rgba(255,255,255,.8)' : '#6bcb77'
    c.lineWidth = 2
    c.strokeRect(tx, by1, tw, by2 - by1)
    // 表针（小鸟）
    const ny = bandY(this.needle)
    const good = this.needle >= lo && this.needle <= hi
    circle(c, tx - 16 * U, ny, 16 * U, good ? '#6bcb77' : grace ? '#ffd54a' : this.needle > hi ? '#ff5d5d' : '#4cc9f0')
    // 上下喇叭
    txt(c, '🔊', tx + tw / 2, tTop - 20 * U, 25 * U, '#fff')
    txt(c, '🔇', tx + tw / 2, tBot + 24 * U, 22 * U, '#fff')
    txt(c, '刚刚好', tx - 40 * U, (by1 + by2) / 2, 16 * U, '#6bcb77', 'right', 'bold')

    // 头顶声波圈（展示）
    for (let i = 0; i < 2; i++) {
      const b = this.player(i).body
      if (!b) continue
      const hx = b.head.x * this.W
      const hyy = b.head.y * this.H
      const rings = this.needle > 0.66 ? 3 : this.needle > 0.3 ? 2 : 1
      for (let k = 1; k <= rings; k++) {
        c.globalAlpha = 0.5 / k
        ring(c, hx, hyy - 30 * U, 20 * U + k * 16 * U, 1, good ? '#6bcb77' : this.players[i].color, 3)
        c.globalAlpha = 1
      }
    }
    // 分数
    txt(c, `${Math.floor(this.ctx.hud().score)} 分`, this.W - 24, 40, 24, '#ffd54a', 'right', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new LoudQuiet(ctx)
}
