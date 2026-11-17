import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, ring, rr, txt } from '@/core/draw'

/**
 * 过河搭桥 / bridge-builder（对齐 dongdongpark 真实规则）：
 * 河边木牌挂出两个「动作筹码」，做对动作桥板才落下；搭满 6 块过一条河，镜头前推开始下一条。
 * 双人：各对各自的筹码，两人「最后一次做到」都落在 sync 窗口内即成功（我先蹲着等你可行）；
 * 单人：先做动作 1，再在 win 秒内做动作 2（顺序不可颠倒，[蹲,跳] 强制交换成 [跳,蹲]）。
 * 超时只换牌不扣分（时间就是成本）；每块板每名玩家 +1，星级 6/10/14 = 搭上的块数。
 *
 * 全部字面量沿用站点：pool 动作池（easy 4 个 / medium·hard 7 个）、same 双人同动作概率、
 * limit 换牌时限（×(1−0.2×heat)）、sync 双人同步窗、win 单人顺序窗；
 * 常量：牌弹出 0.4s + 0.3s 才生效、板落下动画 0.55s、换牌翻转 0.45s、间隔等待 0.5s、
 * 过河 0.25s 后庆祝、1.2s 后镜头 1.1s 前推、每条河 6 块、板宽 0.1（归一化屏宽）、
 * 河左边界 z(e)=e×0.8+0.2、入场 0.8 秒挂第一块牌。
 *
 * 与站点的差异（写明待实测）：
 * 1) heat：本框架 ctx.heat = 局内时长线性 0→1（core/engine.ts）；
 * 2) 站点 events.has('jump'/'clap') 单帧脉冲 → jumping 上升沿 / 双手合拢上升沿（≥0.2s 间隔）；
 * 3) motion.oneLeg / motion.lean 黑盒 → 「两踝高度差 ÷ 躯干」「肩髋横向偏移」代理；
 * 4) 站点精灵/贴图（bb-board、人物、鱼）→ 几何图形绘制；
 * 5) 双人加分是共享分数里 +1/人（仓库口径），站点各自计分再 1:1 对应块数。
 */
type Act = 'squat' | 'up' | 'jump' | 'clap' | 'leg' | 'leanL' | 'leanR'

const ACT_META: Record<Act, { label: string; emoji: string }> = {
  squat: { label: '蹲下', emoji: '🧎' },
  up: { label: '举双手', emoji: '🙌' },
  jump: { label: '跳起来', emoji: '🦘' },
  clap: { label: '拍拍手', emoji: '👏' },
  leg: { label: '单脚站', emoji: '🦩' },
  leanL: { label: '往左歪', emoji: '⬅️' },
  leanR: { label: '往右歪', emoji: '➡️' },
}

const HOLD_ACTS: Act[] = ['squat', 'up', 'leg', 'leanL', 'leanR'] // 保持型（其余为瞬时型）

/** 站点三档：动作池 / 双人同动作概率 / 换牌时限 / 同步窗 / 顺序窗 */
const DIFF = [
  { pool: ['squat', 'up', 'jump', 'clap'] as Act[], same: 0.35, limit: 7.5, sync: 1.2, win: 2.0 },
  { pool: ['squat', 'up', 'jump', 'clap', 'leg', 'leanL', 'leanR'] as Act[], same: 0.25, limit: 6.5, sync: 1.0, win: 1.5 },
  { pool: ['squat', 'up', 'jump', 'clap', 'leg', 'leanL', 'leanR'] as Act[], same: 0.12, limit: 5.5, sync: 0.8, win: 1.2 },
]

const PER_RIVER = 6 // 每条河 6 块板
const RIVER_PITCH = 0.8 // 河间距（归一化屏宽）
const RIVER_LEFT0 = 0.2 // 第 0 条河左边界
const BRIDGE_W = 0.6 // 板组总宽
const BOARD_W = 0.1 // 单板宽
const POP_T = 0.4 // 牌弹出动画
const LIVE_DELAY = 0.3 // 弹出后到生效
const DROP_T = 0.55 // 落板动画
const FLIP_T = 0.45 // 换牌翻转
const WAIT_GAP = 0.5 // 两板间隔
const INTRO = 0.8 // 入场等待
const CROSS_CELE = 0.25 // 过河庆祝延迟
const CROSS_PAN_AT = 1.2 // 镜头前推开始
const PAN_T = 1.1 // 镜头前推时长
const CLAP_MIN = 0.2 // 拍手最小间隔（秒）

interface Card {
  serial: number
  acts: [Act, Act]
  born: number
  at: number
  live: number
  limit: number
  duo: boolean // 发牌时刻锁定的模式（站点按当次 players.length 判）
}

interface ActState {
  held: boolean
  last: number // 最后一次做到（保持型持续刷新）
  on: number // 本张牌内首次做到（-1 未做）
  lastClap: number
}

interface Kid {
  acts: Record<Act, ActState>
  chipLit: [boolean, boolean]
  jumpAt: number // 成功后跳跃动画
  wasJump: boolean
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

/** rr 只描路径，这里补一个带填充的版本 */
function rrf(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  rr(c, x, y, w, h, r)
  c.fillStyle = fill
  c.fill()
}

function leanOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  return clamp(((b.shoulderC.x - b.hipC.x) / t) * 2.2, -1, 1)
}

function armLiftOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
}

class BridgeBuilder extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  phase: 'intro' | 'card' | 'drop' | 'wait' | 'cross' = 'intro'
  phaseAt = 0
  card: Card | null = null
  kids: Kid[] = []
  J = 0 // 当前河已搭块数
  q = 0 // 当前河序号
  ve = 0 // 换过的牌
  crossed = 0
  best = Infinity
  boardSum = 0
  boardN = 0
  dropAt = 0 // 当前落板的世界起始 x（动画用）
  panFrom = 0
  panTo = 0
  private serial = 0
  private prevActs: [Act, Act] | null = null
  private tickMark = -1
  private litMark = [false, false]
  private seatActive = [false, false]
  private celebrated = false
  private panStarted = false

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      const acts = {} as Record<Act, ActState>
      for (const a of Object.keys(ACT_META) as Act[]) {
        acts[a] = { held: false, last: -1, on: -1, lastClap: -9 }
      }
      this.kids.push({ acts, chipLit: [false, false], jumpAt: -9, wasJump: false })
    }
  }

  private get duo() {
    return this.seatActive[0] && this.seatActive[1]
  }

  /** 出牌：双人 same 概率同动作；两个动作不重复、避开上一张对应位；单人 [蹲,跳] 强制交换 */
  private deal() {
    const pool = this.cfg.pool
    const pick = (avoid: Act | null): Act => {
      let idx = Math.floor(Math.random() * pool.length)
      for (let k = 0; k < pool.length; k++) {
        const cand = pool[(idx + k) % pool.length]
        if (cand !== avoid) return cand
      }
      return pool[idx]
    }
    let acts: [Act, Act]
    const duo = this.duo
    if (duo && Math.random() < this.cfg.same) {
      let a = pick(null)
      if (this.prevActs && a === this.prevActs[0]) a = pool[(pool.indexOf(a) + 1) % pool.length]
      acts = [a, a]
    } else {
      const a = pick(this.prevActs?.[0] ?? null)
      const b = pick(this.prevActs?.[1] ?? a)
      acts = [a, b !== a ? b : pool[(pool.indexOf(b) + 1) % pool.length]]
    }
    if (!duo && acts[0] === 'squat' && acts[1] === 'jump') acts = ['jump', 'squat']
    // 重置首次做到计时
    for (const kid of this.kids) {
      for (const a of Object.keys(ACT_META) as Act[]) kid.acts[a].on = -1
      kid.chipLit = [false, false]
    }
    this.litMark = [false, false]
    const heat = this.ctx.heat
    this.card = {
      serial: this.serial++,
      acts,
      born: this.t,
      at: this.t + POP_T,
      live: this.t + POP_T + LIVE_DELAY,
      limit: this.cfg.limit * (1 - 0.2 * heat),
      duo,
    }
    this.prevActs = acts
    this.phase = 'card'
    this.phaseAt = this.t
    this.ctx.audio.play('pop', 0.5, 1.1)
  }

  /** 换牌（超时）：避开刚失败的牌 */
  private redeal() {
    this.ve++
    this.card = null
    this.deal()
    this.ctx.audio.play('click', 0.6, 0.7)
    this.ctx.speak('换一个动作')
  }

  /** 动作检测（上升沿 + 保持刷新，站点 B() 的等价实现） */
  private sense(i: number, b: Body | null, dt: number) {
    const kid = this.kids[i]
    if (!b) {
      for (const a of HOLD_ACTS) kid.acts[a].held = false
      kid.wasJump = false
      return
    }
    const Tn = Math.max(0.1, b.scale)
    // 保持型
    const doing: Record<string, boolean> = {
      squat: b.squat,
      up: armLiftOf(b) >= 0.6,
      leg: (Math.max(b.lFoot.y, b.rFoot.y) - Math.min(b.lFoot.y, b.rFoot.y)) / Tn >= 0.3,
      leanL: leanOf(b) <= -0.4,
      leanR: leanOf(b) >= 0.4,
    }
    for (const a of HOLD_ACTS) {
      const st = kid.acts[a]
      const now = doing[a]
      if (now && !st.held) {
        st.last = this.t
        if (st.on < 0) st.on = this.t
      } else if (now && st.held) {
        st.last = this.t // 持续保持刷新 last（「我先蹲着等你」可行）
      }
      st.held = now
    }
    // 瞬时型：跳（jumping 上升沿）
    if (b.jumping && !kid.wasJump) {
      kid.acts.jump.last = this.t
      if (kid.acts.jump.on < 0) kid.acts.jump.on = this.t
    }
    kid.wasJump = b.jumping
    // 瞬时型：拍手（双手合拢上升沿，最小间隔防连击）
    const shoulderW = Math.max(0.05, Math.abs(b.lShoulder.x - b.rShoulder.x))
    const together = Math.hypot(b.lHand.x - b.rHand.x, b.lHand.y - b.rHand.y) < 0.45 * shoulderW
    if (together && this.t - kid.acts.clap.lastClap >= CLAP_MIN) {
      kid.acts.clap.lastClap = this.t
      kid.acts.clap.last = this.t
      if (kid.acts.clap.on < 0) kid.acts.clap.on = this.t
    }
    void dt
  }

  tick(f: PoseFrame, dt: number) {
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true
    for (let i = 0; i < 2; i++) this.sense(i, f.bodies[i] ?? null, dt)

    switch (this.phase) {
      case 'intro':
        if (this.t >= INTRO) this.deal()
        break
      case 'card':
        this.cardPhase(dt)
        break
      case 'drop':
        if (this.t - this.phaseAt >= DROP_T) this.landBoard()
        break
      case 'wait':
        if (this.t - this.phaseAt >= WAIT_GAP) this.deal()
        break
      case 'cross':
        this.crossPhase()
        break
    }
    this.ctx.setExtra('switched', this.ve)
    this.ctx.setExtra('rivers', this.crossed)
    if (this.best !== Infinity) this.ctx.setExtra('best', Math.round(this.best * 10) / 10)
  }

  private cardPhase(dt: number) {
    const card = this.card!
    const t = this.t
    // 剩余 ≤3 秒每秒一次 tick
    const remain = card.at + card.limit - t
    if (remain <= 3 && remain > 0) {
      const m = Math.ceil(remain)
      if (m !== this.tickMark) {
        this.tickMark = m
        this.ctx.audio.play('tick', 0.5, 1.4)
      }
    }
    if (t < card.live) return
    const sync = this.cfg.sync
    const win = this.cfg.win
    if (card.duo) {
      // 双人：各对各自筹码，两人的「最后一次做到」都在 sync 窗口内
      const ok: boolean[] = []
      for (let slot = 0; slot < 2; slot++) {
        const st = this.kids[slot].acts[card.acts[slot]]
        const inWin = st.last >= 0 && t - st.last <= sync
        ok.push(inWin)
        if (inWin && !this.litMark[slot]) {
          this.litMark[slot] = true
          this.kids[slot].chipLit[slot] = true
          this.ctx.audio.play('pop', 0.6)
          const b = this.player(slot).body
          this.particles.burst(b ? b.center.x * this.W : this.W / 2, 200, '#ffd54a', 6, 200, 3)
        }
      }
      if (ok[0] && ok[1]) this.succeed()
    } else {
      // 单人：动作 1 已做过且 last 在 win 内，本帧刚做动作 2（上升沿 = last 刚更新）
      const st0 = this.kids[0].acts[card.acts[0]]
      const st1 = this.kids[0].acts[card.acts[1]]
      const done0 = st0.on >= 0 && t - st0.last <= win
      const just1 = st1.on >= 0 && t - st1.last < dt + 1e-4 // 本帧内更新过
      if (done0 && just1) this.succeed()
      // 部分点亮
      if (st0.on >= 0 && !this.litMark[0]) {
        this.litMark[0] = true
        this.kids[0].chipLit[0] = true
        this.ctx.audio.play('pop', 0.6)
      }
    }
    // 超时换牌
    if (t >= card.at + card.limit) this.redeal()
  }

  private succeed() {
    const took = this.t - this.card!.born
    this.best = Math.min(this.best, took)
    this.boardSum += took
    this.boardN++
    this.phase = 'drop'
    this.phaseAt = this.t
    this.ctx.audio.play('combo', 0.8)
    for (const kid of this.kids) {
      kid.chipLit = [true, true]
      kid.jumpAt = this.t
    }
  }

  /** 落板：每名在场玩家 +1；满 6 块过河 */
  private landBoard() {
    this.J++
    this.card = null
    let n = 0
    for (let i = 0; i < 2; i++) {
      if (!this.seatActive[i]) continue
      n++
    }
    this.ctx.addScore(Math.max(1, n))
    const left = RIVER_LEFT0 + this.q * RIVER_PITCH
    this.dropAt = left + (this.J - 1) * BOARD_W
    const px = this.dropAt * this.W
    this.particles.burst(px, this.H * 0.62, '#d8b27a', 12, 260, 4)
    this.ctx.audio.play('hit', 0.6)
    if (this.J >= PER_RIVER) {
      this.phase = 'cross'
      this.phaseAt = this.t
      this.crossed++
      this.celebrated = false
    } else {
      this.phase = 'wait'
      this.phaseAt = this.t
    }
  }

  private crossPhase() {
    const t = this.t - this.phaseAt
    if (t >= CROSS_CELE && !this.celebrated) {
      this.celebrated = true
      this.ctx.audio.play('win')
      this.say('过河啦！', this.W / 2, this.H * 0.35, '#9be15d', 52)
      this.say(`第 ${this.crossed} 条河`, this.W / 2, this.H * 0.35 + 54, '#ffffffcc', 28)
      this.particles.burst(this.W / 2, this.H * 0.4, '#ffd54a', 18, 340, 5)
      this.ctx.speak('过河啦！')
    }
    if (t >= CROSS_PAN_AT && !this.panStarted) {
      this.panStarted = true
      this.panFrom = this.q * RIVER_PITCH
      this.panTo = (this.q + 1) * RIVER_PITCH
    }
    if (t >= CROSS_PAN_AT + PAN_T) {
      this.q++
      this.J = 0
      this.panStarted = false
      this.phase = 'wait'
      this.phaseAt = this.t - WAIT_GAP + 0.1 // 站点：过河后 0.1 秒挂牌
    }
  }

  /** 当前相机 x（归一化） */
  private camX() {
    if (this.panStarted) {
      const k = clamp((this.t - this.phaseAt - CROSS_PAN_AT) / PAN_T, 0, 1)
      const e = k * k * (3 - 2 * k) // smoothstep
      return this.panFrom + (this.panTo - this.panFrom) * e
    }
    return this.q * RIVER_PITCH
  }

  paint(c: CanvasRenderingContext2D) {
    const cam = this.camX()
    const sx = (n: number) => (n - cam) * this.W
    // 天空
    const g = c.createLinearGradient(0, 0, 0, this.H * 0.55)
    g.addColorStop(0, '#8ed0f5')
    g.addColorStop(1, '#e3f5ff')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H * 0.55)
    circle(c, this.W * 0.12 - cam * 40, 70, 34, '#ffe680')
    circle(c, this.W * 0.12 - cam * 40, 70, 26, '#fff2a8')
    // 云
    for (let k = 0; k < 3; k++) {
      const cx2 = ((k * 0.45 + 0.1 - cam * 0.3 + this.t * 0.004) % 1.2) * this.W - 60
      circle(c, cx2, 60 + k * 26, 22, '#ffffffee')
      circle(c, cx2 + 26, 56 + k * 26, 18, '#ffffffee')
      circle(c, cx2 - 24, 58 + k * 26, 16, '#ffffffee')
    }
    // 草地
    const groundY = this.H * 0.55
    c.fillStyle = '#9bd88f'
    c.fillRect(0, groundY - 30, this.W, this.H - groundY + 30)
    // 远山（视差）
    c.fillStyle = '#b5e3a0'
    c.beginPath()
    c.moveTo(0, groundY)
    for (let px = 0; px <= this.W; px += 24) {
      const y = groundY - 60 - Math.sin((px + cam * 200) * 0.008) * 30
      c.lineTo(px, y)
    }
    c.lineTo(this.W, groundY)
    c.closePath()
    c.fill()
    // 河与桥
    const waterY = groundY + 40
    const e0 = Math.floor(cam - 0.3)
    for (let e = Math.max(0, e0); e <= e0 + 3; e++) {
      const left = RIVER_LEFT0 + e * RIVER_PITCH
      const x0 = sx(left)
      const x1 = sx(left + BRIDGE_W)
      if (x1 < -40 || x0 > this.W + 40) continue
      // 水
      const wg = c.createLinearGradient(0, waterY, 0, this.H)
      wg.addColorStop(0, '#7fd3f7')
      wg.addColorStop(1, '#3f9be6')
      c.fillStyle = wg
      c.fillRect(x0, waterY, x1 - x0, this.H - waterY)
      c.strokeStyle = 'rgba(255,255,255,.5)'
      c.lineWidth = 2
      for (let wl = 0; wl < 3; wl++) {
        c.beginPath()
        for (let px = 0; px <= x1 - x0; px += 10) {
          const y = waterY + 14 + wl * 22 + Math.sin(px * 0.05 + this.t * (1.5 + wl * 0.6)) * 4
          if (px === 0) c.moveTo(x0 + px, y)
          else c.lineTo(x0 + px, y)
        }
        c.stroke()
      }
      // 荷叶 + 鱼跳
      for (let k = 0; k < 4; k++) {
        const lx = x0 + ((k + 0.5) / 4) * (x1 - x0)
        c.fillStyle = '#5cae6e'
        c.beginPath()
        c.ellipse(lx, waterY + 30 + (k % 2) * 40, 16, 7, 0, 0, Math.PI * 2)
        c.fill()
      }
      const fishK = (this.t + e * 1.3) % 4.2
      if (fishK < 0.9) {
        const fk = fishK / 0.9
        const fx = x0 + (x1 - x0) * (0.3 + 0.4 * ((e % 3) / 3))
        const fy = waterY + 40 - Math.sin(Math.PI * fk) * 60
        circle(c, fx, fy, 8, ['#ff9f43', '#ff6b81', '#ffd54a'][e % 3])
      }
      // 桥板
      const built = e < this.q ? PER_RIVER : e === this.q ? this.J : 0
      const bridgeY = waterY - 6
      for (let j = 0; j < PER_RIVER; j++) {
        const bx0 = sx(left + j * BOARD_W)
        const bw = BOARD_W * this.W
        if (j < built) {
          const plank = ['#c98d4f', '#b97f45', '#d49a5c'][(e * PER_RIVER + j) % 3]
          rrf(c, bx0 + 2, bridgeY, bw - 4, 14, 4, plank)
          // 吊索
          c.strokeStyle = 'rgba(90,60,30,.6)'
          c.lineWidth = 2
          c.beginPath()
          c.moveTo(bx0 + 2, bridgeY)
          c.lineTo(bx0 + bw / 2, bridgeY - 26)
          c.lineTo(bx0 + bw - 2, bridgeY)
          c.stroke()
        } else if (e === this.q && j === this.J && this.phase !== 'cross') {
          // 下一块：黄色闪烁虚线框
          const blink = Math.floor(this.t * 3) % 2 === 0
          c.strokeStyle = blink ? '#ffd54a' : 'rgba(255,213,74,.4)'
          c.lineWidth = 3
          c.setLineDash([8, 6])
          c.strokeRect(bx0 + 2, bridgeY - 4, bw - 4, 20)
          c.setLineDash([])
        } else {
          c.strokeStyle = 'rgba(255,255,255,.25)'
          c.lineWidth = 2
          c.setLineDash([6, 6])
          c.strokeRect(bx0 + 2, bridgeY - 4, bw - 4, 20)
          c.setLineDash([])
        }
      }
      // 绳索护栏（已搭部分）
      if (built > 0) {
        const rx0 = sx(left)
        const rx1 = sx(left + built * BOARD_W)
        c.strokeStyle = '#8a5a2b'
        c.lineWidth = 3
        for (const dy of [0, 16]) {
          c.beginPath()
          c.moveTo(rx0, bridgeY - 26 + dy)
          c.quadraticCurveTo((rx0 + rx1) / 2, bridgeY - 34 + dy, rx1, bridgeY - 26 + dy)
          c.stroke()
        }
        c.fillStyle = '#8a5a2b'
        c.fillRect(rx0 - 4, bridgeY - 30, 6, 30)
        c.fillRect(rx1 - 2, bridgeY - 30, 6, 30)
      }
    }
    // 岸上的树
    for (let k = 0; k < 14; k++) {
      const nx = (k * 0.083 + 0.05) % 1.3
      const inRiver = ((nx - RIVER_LEFT0) % RIVER_PITCH + RIVER_PITCH) % RIVER_PITCH < BRIDGE_W
      if (inRiver) continue
      const tx = sx(nx)
      if (tx < -30 || tx > this.W + 30) continue
      c.fillStyle = '#8a5a2b'
      c.fillRect(tx - 4, groundY - 26, 8, 28)
      circle(c, tx, groundY - 40, 22, '#4f9d58')
    }

    // 小人（站在当前河已搭段的末端）
    for (let i = 0; i < 2; i++) {
      if (!this.seatActive[i]) continue
      const kid = this.kids[i]
      const left = RIVER_LEFT0 + this.q * RIVER_PITCH
      const nx = left + Math.min(this.J, PER_RIVER) * BOARD_W - 0.05 + (this.duo ? (i === 0 ? -0.025 : 0.025) : 0)
      const px = sx(nx)
      const jumpK = clamp((this.t - kid.jumpAt) / 0.45, 0, 1)
      const jumpY = jumpK < 1 ? Math.sin(Math.PI * jumpK) * 30 : 0
      this.kid(c, px, groundY + 6 - jumpY, this.players[i].color)
    }

    this.cardPaint(c)
  }

  private kid(c: CanvasRenderingContext2D, x: number, y: number, color: string) {
    c.strokeStyle = '#3a3a55'
    c.lineWidth = 4
    c.beginPath()
    c.moveTo(x, y - 26)
    c.lineTo(x - 8, y)
    c.moveTo(x, y - 26)
    c.lineTo(x + 8, y)
    c.stroke()
    c.strokeStyle = color
    c.lineWidth = 7
    c.beginPath()
    c.moveTo(x, y - 26)
    c.lineTo(x, y - 48)
    c.stroke()
    c.beginPath()
    c.moveTo(x, y - 44)
    c.lineTo(x - 10, y - 34)
    c.moveTo(x, y - 44)
    c.lineTo(x + 10, y - 34)
    c.stroke()
    circle(c, x, y - 58, 11, '#f2c9a0')
    c.fillStyle = '#3a2d2d'
    c.beginPath()
    c.arc(x, y - 60, 10, Math.PI, 0)
    c.fill()
  }

  /** 木牌 UI */
  private cardPaint(c: CanvasRenderingContext2D) {
    if (this.phase !== 'card' || !this.card) return
    const card = this.card
    const bw = Math.min(380, this.W * 0.32)
    const bx = this.W / 2 - bw / 2
    const by = 34
    const bh = 128
    // 翻转动画
    const flipK = clamp((this.t - card.born) / FLIP_T, 0, 1)
    const scaleY = Math.abs(Math.cos(Math.PI * flipK))
    c.save()
    c.translate(this.W / 2, by + bh / 2)
    c.scale(1, Math.max(0.08, scaleY))
    c.translate(-this.W / 2, -(by + bh / 2))
    // 吊绳
    c.strokeStyle = '#8a5a2b'
    c.lineWidth = 4
    c.beginPath()
    c.moveTo(bx + 20, 0)
    c.lineTo(bx + 26, by)
    c.moveTo(bx + bw - 20, 0)
    c.lineTo(bx + bw - 26, by)
    c.stroke()
    rrf(c, bx, by, bw, bh, 14, '#b9803f')
    c.strokeStyle = '#8a5a2b'
    c.lineWidth = 4
    c.strokeRect(bx, by, bw, bh)
    // 筹码
    const chip = (act: Act, cx2: number, badge: string, badgeCol: string, lit: boolean) => {
      rrf(c, cx2 - 52, by + 22, 104, 62, 10, lit ? '#dff3d0' : '#f3e2c2')
      c.strokeStyle = lit ? '#3ddc97' : '#c9a26b'
      c.lineWidth = lit ? 3 : 2
      c.strokeRect(cx2 - 52, by + 22, 104, 62)
      txt(c, ACT_META[act].emoji, cx2, by + 44, 26, '#333')
      txt(c, ACT_META[act].label, cx2, by + 72, 15, '#5a4632', 'center', 'bold')
      circle(c, cx2 + 40, by + 32, 10, badgeCol)
      txt(c, badge, cx2 + 40, by + 32, 12, '#26152c')
    }
    const duo = card.duo
    const lit0 = this.kids[0].chipLit[0]
    const lit1 = this.kids[duo ? 1 : 0].chipLit[1]
    if (duo && card.acts[0] === card.acts[1]) {
      chip(card.acts[0], this.W / 2, '一起', '#ffffff', lit0)
    } else {
      chip(card.acts[0], bx + bw * 0.3, duo ? 'P1' : '先', this.players[0].color, lit0)
      txt(c, duo ? '＋' : '→', bx + bw * 0.5, by + 50, 26, '#5a4632')
      chip(card.acts[1], bx + bw * 0.7, duo ? 'P2' : '再', this.players[1].color, lit1)
    }
    // 同步/顺序窗口进度环（围绕中间连接符）
    const sync = this.cfg.sync
    const win = this.cfg.win
    let pct = 0
    if (card.duo) {
      const lasts = [0, 1].map((slot) => this.kids[slot].acts[card.acts[slot]].last)
      const done = lasts.filter((v) => v >= 0)
      if (done.length === 2) {
        const since = this.t - Math.min(...done)
        pct = clamp(1 - since / sync, 0, 1)
      }
    } else {
      const st0 = this.kids[0].acts[card.acts[0]]
      if (st0.on >= 0) pct = clamp(1 - (this.t - st0.last) / win, 0, 1)
    }
    if (pct > 0) {
      ring(c, bx + bw * 0.5, by + 50, 24, pct, '#3ddc97', 4)
    }
    // 时限条
    const used = clamp((this.t - card.at) / card.limit, 0, 1)
    const remainPct = 1 - used
    c.fillStyle = remainPct > 0.35 ? '#3ddc97' : remainPct > 0.15 ? '#ffb24d' : '#ff5d5d'
    const barW = bw * 0.7 * remainPct
    const barCol = remainPct > 0.35 ? '#3ddc97' : remainPct > 0.15 ? '#ffb24d' : '#ff5d5d'
    rrf(c, bx + bw * 0.15, by + bh - 14, Math.max(4, barW), 8, 4, barCol)
    c.restore()
    // 文案
    const hint = duo
      ? card.acts[0] === card.acts[1]
        ? `一起${ACT_META[card.acts[0]].label}！`
        : `左边${ACT_META[card.acts[0]].label}，右边${ACT_META[card.acts[1]].label}！`
      : `先${ACT_META[card.acts[0]].label}，再${ACT_META[card.acts[1]].label}！`
    outlineTxt(c, hint, this.W / 2, by + bh + 30, 24, '#ffffff')
  }
}

export default function create(ctx: GameContext) {
  return new BridgeBuilder(ctx)
}
