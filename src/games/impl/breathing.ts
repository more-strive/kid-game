import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 呼吸训练 / breathing（对齐 dongdongpark 真实规则）：
 * 呼吸圆变大=用鼻子安静吸气、停住=屏气、变小=对着麦克风均匀呼气；麦克风只做「验证」——
 * 吸/屏查**原始音量**是否安静（raw < quiet），呼气查**平滑值**是否落在 [lo,hi] 带且 1 秒标准差 ≤ sd。
 * 每轮呼气结束时按质量结算积分（呼气是主引擎且绑架吸/屏：全程不出声则吸/屏也 0 分），湖面开莲花。
 *
 * 全部字面量沿用站点：quiet 安静线 0.16/0.12/0.10、呼气带 lo-hi 0.07-0.60/0.10-0.50/0.12-0.45、
 * 平稳度 sd 0.09/0.065/0.05（1s 窗）、折算分母 slack 0.85/0.92/1.0、相宽限 0.6s（前 2 轮 1.1s）、
 * 音量平滑 τ=0.1s、出声占比 ≥50% 拿满乘数 c、轮质量 ≥0.85 盛开/≥0.45 半开/<0.45 小花/<0.12 不长/
 * >0.97 满分轮、呼气计分线 0.6×lo、提示去抖 0.3s、节奏表按站点总秒数展开塞满 90 秒。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点节奏表只公布了每轮总秒数（easy 10,10,11,11,12,12,13,14 等），**吸/屏/呼的拆分是黑盒** →
 *    按「吸 40%·屏 20~25%·呼 35~40%」推断拆分（总量与站点一致）；
 * 2) 站点 e.micRaw/e.mic 双通道 → 本框架 mic.raw/mic.level 对应；判定不对称照抄（吸/屏原始、呼气平滑）；
 * 3) 呼吸曲线图表简化为阈值线+状态文字；莲花/角色/云朵几何绘制；双人共用一路麦同分（站点同款）；
 * 4) ai() 演示替身未实装。
 */
type Phase = 'in' | 'hold' | 'out' | 'rest'
type Status = 'ok' | 'noisy' | 'soft' | 'loud' | 'shaky' | 'wait'

/** 站点三档：安静线 / 呼气带 / 平稳度 / 折算分母（cycles 拆分为推断，总量与站点一致） */
const DIFF = [
  { quiet: 0.16, lo: 0.07, hi: 0.6, sd: 0.09, slack: 0.85, cycles: [[4, 2, 4], [4, 2, 4], [4, 3, 4], [4, 3, 4], [5, 3, 4], [5, 3, 4], [5, 3, 5], [5, 4, 5]] as [number, number, number][] },
  { quiet: 0.12, lo: 0.1, hi: 0.5, sd: 0.065, slack: 0.92, cycles: [[4, 2, 4], [4, 3, 4], [4, 3, 5], [5, 3, 5], [5, 3, 6], [5, 4, 5], [5, 4, 6]] as [number, number, number][] },
  { quiet: 0.1, lo: 0.12, hi: 0.45, sd: 0.05, slack: 1.0, cycles: [[4, 2, 4], [4, 3, 4], [5, 3, 5], [5, 3, 6], [5, 3, 7]] as [number, number, number][] },
]

const GRACE = 0.6
const GRACE_VOICE = 1.1
const VOICE_CYCLES = 2
const EMA_TAU = 0.1
const SD_WIN = 1
const DUR = 90

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)


interface Cycle {
  secs: [number, number, number]
  t0: number
}

const PHASE_NAME: Record<Phase, string> = { in: '吸气', hold: '屏住', out: '呼气', rest: '放松' }
const STATUS_TIP: Record<string, string> = {
  ok: '很好，保持',
  noisy: '嘘，别出声！',
  soft: '再呼得重一点点',
  loud: '轻一点，慢慢呼',
  shaky: '稳住，别一阵一阵的',
  wait: '准备…',
}

class Breathing extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  cycles: Cycle[] = []
  phase: Phase = 'in'
  phaseAt = 0
  cycleIdx = 0
  V = 0 // 平滑音量（τ=0.1s）
  private sdWin: { t: number; v: number }[] = []
  status: Status = 'wait'
  private rawOk = 0
  private phaseLen = 0
  private phaseVoice = false
  private scoreAcc = 0
  private scoreSent = 0
  private debounced: Status = 'wait'
  private debouncedAt = 0
  q = 0 // 完成轮数
  perfect = 0
  private smoothOk = 0
  private smoothAll = 0
  private quietOk = 0
  private quietAll = 0
  private smAllT = 0 // 累计（结算统计用）
  private smOkT = 0
  private qAllT = 0
  private qOkT = 0
  private lotus: { x: number; level: number }[] = []

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.mic.ensure().catch(() => undefined)
    // 节奏表展开：塞满 90 秒，放不下回挑能塞下的最长轮，表耗尽循环末项
    let t0 = 0
    let idx = 0
    const table = this.cfg.cycles
    while (t0 < DUR) {
      let pick = table[Math.min(idx, table.length - 1)]
      if (t0 + pick[0] + pick[1] + pick[2] > DUR) {
        // 回挑能塞下的最长旧轮
        let best: [number, number, number] | null = null
        for (const c of table) {
          if (t0 + c[0] + c[1] + c[2] <= DUR) best = c
        }
        pick = best ?? pick
      }
      this.cycles.push({ secs: pick, t0 })
      t0 += pick[0] + pick[1] + pick[2]
      idx++
    }
    this.phaseAt = 0
    this.phaseVoice = true
    this.ctx.speak('圆圈变大时用鼻子吸气')
  }

  private lookup(t: number): { cycle: number; phase: Phase } {
    for (let i = 0; i < this.cycles.length; i++) {
      const total = this.cycles[i].secs[0] + this.cycles[i].secs[1] + this.cycles[i].secs[2]
      if (t < this.cycles[i].t0 + total) {
        const local = t - this.cycles[i].t0
        const phase: Phase = local < this.cycles[i].secs[0] ? 'in' : local < this.cycles[i].secs[0] + this.cycles[i].secs[1] ? 'hold' : 'out'
        return { cycle: i, phase }
      }
    }
    return { cycle: this.cycles.length, phase: 'rest' }
  }

  private cycleTotal(c: Cycle) {
    return c.secs[0] + c.secs[1] + c.secs[2]
  }

  tick(f: PoseFrame, dt: number) {
    void f
    const raw = this.ctx.mic.raw
    this.V += (raw - this.V) * (1 - Math.exp(-dt / EMA_TAU))
    // 1 秒标准差窗口
    this.sdWin.push({ t: this.t, v: this.V })
    while (this.sdWin.length > 2 && this.t - this.sdWin[0].t > SD_WIN) this.sdWin.shift()
    const cur = this.lookup(this.t)

    // 相切换：结算上一相 → 初始化新相
    const phaseKey = `${cur.cycle}:${cur.phase}`
    if (phaseKey !== this.phaseKey) {
      if (this.phaseLen > 0.05) this.settle(this.phase)
      this.phase = cur.phase
      this.phaseAt = this.t
      this.phaseKey = phaseKey
      this.phaseLen = 0
      this.rawOk = 0
      this.sdWin = []
      this.phaseVoice = cur.cycle < VOICE_CYCLES
      if (cur.phase !== 'rest') this.ctx.audio.play('pop', 0.3, cur.phase === 'in' ? 1.4 : cur.phase === 'hold' ? 1.6 : 1.1)
      if (cur.cycle < VOICE_CYCLES && cur.phase !== 'rest') {
        this.ctx.speak(cur.phase === 'in' ? (cur.cycle === 0 ? '用鼻子吸气' : '吸气') : cur.phase === 'hold' ? '屏住' : '呼——')
      }
    }
    if (this.phase === 'rest') {
      this.status = 'ok'
      return
    }
    this.phaseLen += dt
    const grace = this.phaseLen < (this.phaseVoice ? GRACE_VOICE : GRACE)
    // 判定
    let st: Status
    if (grace) {
      st = 'wait'
    } else if (this.phase === 'out') {
      const mean = this.sdWin.reduce((a, s2) => a + s2.v, 0) / Math.max(1, this.sdWin.length)
      const variance = this.sdWin.reduce((a, s2) => a + (s2.v - mean) ** 2, 0) / Math.max(1, this.sdWin.length)
      const sd = Math.sqrt(variance)
      if (this.V < this.cfg.lo) st = 'soft'
      else if (this.V > this.cfg.hi) st = 'loud'
      else if (sd > this.cfg.sd) st = 'shaky'
      else st = 'ok'
      this.smoothAll += dt
      this.smAllT += dt
      if (st === 'ok') this.smoothOk += dt
      if (st === 'ok') this.smOkT += dt
    } else {
      st = raw < this.cfg.quiet ? 'ok' : 'noisy'
      this.quietAll += dt
      this.qAllT += dt
      if (st === 'ok') this.quietOk += dt
      if (st === 'ok') this.qOkT += dt
    }
    if (st === 'ok') this.rawOk += dt
    // 状态去抖 0.3s
    if (st !== this.debounced) {
      if (this.debouncedAt === 0) this.debouncedAt = this.t
      if (this.t - this.debouncedAt >= 0.3) {
        this.debounced = st
        this.debouncedAt = 0
      }
    } else this.debouncedAt = 0
    this.status = st
  }

  private phaseKey = ''

  /** 相结束结算：B[相] = ok 占比；呼气相结束时触发整轮计分 */
  private settle(ph: Phase) {
    const b = this.rawOk / this.phaseLen
    const s = Math.min(1, b / this.cfg.slack)
    if (ph !== 'out') return
    const cyc = this.cycles[this.cycleIdx]
    if (!cyc) return
    const zRatio = this.smoothAll > 0 ? Math.min(1, (this.smoothOk / Math.max(0.05, this.smoothAll)) / 0.5) : 0
    void zRatio
    // 简化：乘数 c 用呼气 ok 占比（站点是「V≥0.6×lo 占比 ≥50% 拿满」，我们用 ok 占比近似——ok 已含带内+平稳）
    const c = Math.min(1, b / 0.5)
    const l = (cyc.secs[0] * s + cyc.secs[1] * s) * c + cyc.secs[2] * s
    this.scoreAcc += l
    const emit = Math.round(this.scoreAcc) - this.scoreSent
    if (emit > 0) {
      this.scoreSent += emit
      this.ctx.addScore(emit)
    }
    const d = l / this.cycleTotal(cyc)
    this.q++
    const lx = this.W * (0.12 + (0.76 * ((this.q - 1) % 8)) / 8)
    const level = d > 0.97 ? 3 : d >= 0.85 ? 3 : d >= 0.45 ? 2 : d >= 0.12 ? 1 : 0
    if (d > 0.97) {
      this.perfect++
      this.ctx.audio.play('win', 0.6)
    } else if (d >= 0.85) this.ctx.audio.play('win', 0.5)
    else if (d >= 0.45) this.ctx.audio.play('score', 0.4)
    else this.ctx.audio.play('pop', 0.3, 0.8)
    this.lotus.push({ x: lx, level })
    this.cycleIdx++
    this.smoothAll = 0
    this.smoothOk = 0
    this.rawOk = 0
    const smoothPct = this.smAllT > 0.5 ? Math.round((100 * this.smOkT) / this.smAllT) : -1
    const quietPct = this.qAllT > 0.5 ? Math.round((100 * this.qOkT) / this.qAllT) : -1
    this.ctx.setExtra('rounds', this.q)
    this.ctx.setExtra('perfect', this.perfect)
    this.ctx.setExtra('smooth', smoothPct)
    this.ctx.setExtra('quiet', quietPct)
  }

  paint(c: CanvasRenderingContext2D) {
    // 天空 + 湖面
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, '#a8d8ea')
    g.addColorStop(1, '#5f9ea8')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    c.fillStyle = '#4a8a96'
    c.fillRect(0, this.H * 0.83, this.W, this.H * 0.17)
    // 云
    for (let k = 0; k < 3; k++) {
      const cx2 = ((k * 0.45 + 0.1 + this.t * 0.006) % 1.2) * this.W - 60
      circle(c, cx2, 60 + k * 30, 20, 'rgba(255,255,255,.85)')
      circle(c, cx2 + 24, 56 + k * 30, 15, 'rgba(255,255,255,.85)')
    }
    // 呼吸圆
    const cyc = this.cycles[this.cycleIdx]
    const rMax = Math.min(this.H * 0.25, this.W * 0.18)
    const rMin = rMax * 0.5
    let r = rMin
    let prog = 0
    if (this.phase !== 'rest' && cyc) {
      const phIdx = this.phase === 'in' ? 0 : this.phase === 'hold' ? 1 : 2
      const local = this.t - this.phaseAt
      const dur = cyc.secs[phIdx]
      prog = clamp(local / Math.max(0.05, dur), 0, 1)
      r = this.phase === 'in' ? rMin + (rMax - rMin) * (1 - Math.cos(prog * Math.PI)) / 2 : this.phase === 'hold' ? rMax * (1 + Math.sin(this.t * 9) * 0.012) : rMax - (rMax - rMin) * (1 - Math.cos(prog * Math.PI)) / 2
    } else {
      r = rMin + (rMax - rMin) * (0.5 + Math.sin(this.t * 2) * 0.03)
    }
    const ccx = this.W / 2
    const ccy = this.H * 0.48
    // 参考圈
    c.strokeStyle = 'rgba(255,255,255,.35)'
    c.setLineDash([8, 10])
    circle(c, ccx, ccy, rMax, 'rgba(0,0,0,0)')
    c.beginPath()
    c.arc(ccx, ccy, rMax, 0, Math.PI * 2)
    c.stroke()
    c.beginPath()
    c.arc(ccx, ccy, rMin, 0, Math.PI * 2)
    c.stroke()
    c.setLineDash([])
    // 主圆
    const col = this.status === 'ok' ? '#6bcb77' : this.status === 'wait' ? '#ffd54a' : this.status === 'noisy' || this.status === 'loud' ? '#ff6b6b' : '#4cc9f0'
    circle(c, ccx, ccy, r, col)
    // 相位进度弧
    c.strokeStyle = 'rgba(255,255,255,.8)'
    c.lineWidth = 5
    c.beginPath()
    c.arc(ccx, ccy, r + 10, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2)
    c.stroke()
    // 中心文字
    txt(c, PHASE_NAME[this.phase], ccx, ccy - r - 24, 26, '#26152c', 'center', 'bold')
    if (this.phase !== 'rest' && cyc) {
      const phIdx = this.phase === 'in' ? 0 : this.phase === 'hold' ? 1 : 2
      const remain = Math.max(0, cyc.secs[phIdx] - (this.t - this.phaseAt))
      txt(c, Math.ceil(remain).toString(), ccx, ccy, 52, '#26152c', 'center', '900')
    } else {
      txt(c, this.t >= DUR ? '完成' : '放松', ccx, ccy, 40, '#26152c', 'center', 'bold')
    }
    // 底部状态提示
    const tip = this.status === 'ok' || this.phase === 'rest' ? '很好，保持' : STATUS_TIP[this.status] ?? ''
    if (tip && this.status !== 'ok') outlineTxt(c, tip, this.W / 2, this.H * 0.78, 28, this.status === 'wait' ? '#ffd54a' : '#ff6b6b')
    // 莲花（湖面）
    for (const l of this.lotus) {
      circle(c, l.x, this.H * 0.9, 14 + l.level * 4, l.level >= 2 ? '#ff8fab' : l.level === 1 ? '#ffc4d0' : 'rgba(255,255,255,.4)')
    }
    // 轮次
    txt(c, `第 ${Math.min(this.cycleIdx + 1, this.cycles.length)}/${this.cycles.length} 轮 · 完成 ${this.q} 轮`, this.W / 2, 30, 20, '#26152c', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new Breathing(ctx)
}
