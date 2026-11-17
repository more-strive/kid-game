import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { glow, outlineTxt, txt } from '@/core/draw'

/**
 * 踢毽子（对齐 dongdongpark 真实规则，报告 _reverse/reports/shuttlecock.md）：
 * 毽子落到膝盖高时抬起那边的腿踢上去；换一只脚踢 +2 分，落地重新数。
 * 不对称重力：上升 gUp、下落 gDown 且封顶终端速度 vt（模拟毽子空气阻力的「飘」）。
 * 「刚抬起」判定：膝需从低位（kneeLift<0.22）在 0.7s 内升过门槛，一直架着腿无效。
 * 双人（mode=coop 同队）传队友、合作共分。
 */

/** 对齐站点难度表：终端下落速度(×躯干/s) / 上升重力 / 下落重力 / 踢起顶点(×躯干,相对膝) / 膝判定窗半宽 / 抬膝门槛 / 换侧概率 / 任意腿均可 / 连击加速系数 / AI失误率(未用) */
const DIFF = [
  { vt: 1.15, gUp: 7, gDown: 3, apex: [1.4, 1.8] as const, win: 0.5, lift: 0.35, switchP: 0.35, anyLeg: true, heat: 0.1, miss: 0.15 },
  { vt: 1.5, gUp: 8, gDown: 4, apex: [1.5, 2] as const, win: 0.4, lift: 0.4, switchP: 0.45, anyLeg: false, heat: 0.15, miss: 0.2 },
  { vt: 1.85, gUp: 9, gDown: 5, apex: [1.5, 2.1] as const, win: 0.35, lift: 0.4, switchP: 0.6, anyLeg: false, heat: 0.2, miss: 0.22 },
]
const KICK_OFF = 0.3 // 踢球点横偏：髋 ±0.3×躯干
const MEM_WIN = 0.7 // 「腿刚抬起」记忆窗 s
const LOW_KNEE = 0.22 // 判定「腿在低位」的 kneeLift 阈值
const INT_STEP = 1 / 60 // 到达时间数值积分步长
const SERVE_H = [1.25, 1.55] as const // 发球踢起高度区间（×躯干 相对膝）
const SERVE_TOP = 190 // 发球位最高点 px×unit（max(190unit, knee−(1.25~1.55)T)）
const SHUTTLE_R = 110 // 毽子绘制尺寸 px×unit
const KICK_CD = 0.3 // 距上次踢的最短间隔 s
const DROP_T = 0.9 // 落地插地动画时长 s
const FOOT_PUSH = 0.2 // 脚踢：另一脚明显更低阈值（×躯干）
const FOOT_KICK_V = -1.2 // 脚踢：快速上踢速度（×躯干/s）
const NATURAL_KNEE = 0.6 // 膝自然下垂位：髋 +0.6×躯干

interface Shuttle {
  x: number
  y: number
  vy: number
  r: number
  /** 目标玩家与该玩家应踢的腿（0=l 1=r） */
  to: number
  side: number
  /** 落地/踢中状态 */
  state: 'fly' | 'drop' | 'wait'
  t: number
  rot: number
  lastKickT: number
}

interface Deck {
  /** 平滑锚点（τ=6/s）：躯干/髋/膝/地 */
  torso: number
  hipX: number
  hipY: number
  kneeY: number
  groundY: number
  ready: boolean
  kicks: number
  swaps: number
  /** 每条腿「曾在低位」的时刻 */
  lowAt: [number, number]
  /** 上一帧脚 y（算脚速） */
  prevFootY: [number, number]
  lastLeg: number
  lastHintT: number
}

function newDeck(): Deck {
  return { torso: 0, hipX: 0, hipY: 0, kneeY: 0, groundY: 0, ready: false, kicks: 0, swaps: 0, lowAt: [-9, -9], prevFootY: [-1, -1], lastLeg: -1, lastHintT: -9 }
}

class Shuttlecock extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  decks = [newDeck(), newDeck()]
  shuttle: Shuttle = this.newShuttle(0, 0)
  combo = 0
  best = 0
  drops = 0
  score = 0
  bannerT = 0
  bannerText = ''

  private newShuttle(to: number, side: number): Shuttle {
    return { x: this.W / 2, y: this.H * 0.3, vy: 0, r: SHUTTLE_R * (this.H / 720) * 0.3, to, side, state: 'fly', t: 0, rot: 0, lastKickT: -9 }
  }

  private duo() {
    return this.players.filter((p) => p.body).length > 1
  }

  /** 连击热度（原站 env.heat 宿主维护，这里按连击近似） */
  private heat() {
    return Math.min(1, this.combo * 0.08)
  }

  tick(f: PoseFrame, dt: number) {
    const duo = this.duo()
    if (this.bannerT > 0) this.bannerT -= dt

    // ---- 锚点平滑（τ=6/s）+ 抬膝/脚速记录 ----
    for (let pi = 0; pi < 2; pi++) {
      const dk = this.decks[pi]
      const b = f.bodies[pi]
      if (!b) continue
      const torso = Math.max(60, Math.max(0.05, b.scale) * this.H)
      const hipX = b.hipC.x * this.W
      const hipY = b.hipC.y * this.H
      // 膝：取较高者（y 小），且不高于髋 −0.4T（防检测抖动）
      const kneeRaw = Math.min(b.lKnee.y, b.rKnee.y) * this.H
      const kneeY = Math.max(kneeRaw, hipY - 0.4 * torso)
      const footLow = Math.max(b.lFoot.y, b.rFoot.y) * this.H
      const groundY = Math.min(footLow + 0.05 * torso, this.H - 6 * (this.H / 720))
      if (!dk.ready) {
        dk.torso = torso
        dk.hipX = hipX
        dk.hipY = hipY
        dk.kneeY = kneeY
        dk.groundY = groundY
        dk.ready = true
      }
      const k = Math.min(1, dt * 6)
      dk.torso += (torso - dk.torso) * k
      dk.hipX += (hipX - dk.hipX) * k
      dk.hipY += (hipY - dk.hipY) * k
      dk.kneeY += (kneeY - dk.kneeY) * k
      dk.groundY += (groundY - dk.groundY) * k
      // 每条腿 kneeLift：从自然下垂位（髋+0.6T）抬升的比例
      const liftL = (dk.hipY + NATURAL_KNEE * dk.torso - b.lKnee.y * this.H) / dk.torso
      const liftR = (dk.hipY + NATURAL_KNEE * dk.torso - b.rKnee.y * this.H) / dk.torso
      if (liftL < LOW_KNEE) dk.lowAt[0] = this.t
      if (liftR < LOW_KNEE) dk.lowAt[1] = this.t
      // 脚速（归一化/s → 躯干/s）
      const fyL = b.lFoot.y * this.H
      const fyR = b.rFoot.y * this.H
      if (dk.prevFootY[0] >= 0) this.footVy[pi][0] = (fyL - dk.prevFootY[0]) / Math.max(0.001, dt)
      if (dk.prevFootY[1] >= 0) this.footVy[pi][1] = (fyR - dk.prevFootY[1]) / Math.max(0.001, dt)
      dk.prevFootY[0] = fyL
      dk.prevFootY[1] = fyR
    }

    // ---- 毽子状态 ----
    const s = this.shuttle
    const dk = this.decks[s.to]
    if (s.state === 'fly' && dk.ready) {
      // 不对称重力：上升 gUp、下落 gDown 封顶终端速度 vt（连击越高下落越快）
      const rising = s.vy < 0
      if (rising) {
        s.vy += this.cfg.gUp * dk.torso * dt
      } else {
        const cap = this.cfg.vt * dk.torso * (1 + this.cfg.heat * this.heat())
        s.vy = Math.min(cap, s.vy + this.cfg.gDown * dk.torso * (1 + this.cfg.heat * this.heat()) * dt)
      }
      s.y += s.vy * dt
      // 横向：平滑步 C(a)=a(1.5−0.5a) 朝目标踢点插值（span 由数值积分估）
      const tx = dk.hipX + (s.side === 0 ? 1 : -1) * KICK_OFF * dk.torso
      const span = this.timeToKnee(s, dk)
      const a = Math.min(1, dt / Math.max(0.05, span))
      s.x += (tx - s.x) * (a * (1.5 - 0.5 * a))
      // 旋转朝速度方向阻尼对齐（τ=9）+ 微摆
      const targetRot = Math.atan2(s.vy, Math.max(60, tx - s.x) * (tx > s.x ? 0.2 : -0.2))
      s.rot += (targetRot - s.rot) * Math.min(1, dt * 9)
      s.t += dt
      // 踢中判定 X()（球下落 vy>0 且距上次踢 >0.3s）
      let kicked = false
      if (s.vy > 0 && this.t - s.lastKickT > KICK_CD) {
        const hit = this.tryKick(f, s, dk)
        if (hit !== null) {
          // 踢中会替换 this.shuttle（新球踢起），跳过本次落地检查
          this.onKick(s, dk, hit, duo)
          kicked = true
        }
      }
      // 落地 J()
      if (!kicked && this.shuttle === s && s.y >= dk.groundY - 8 * (this.H / 720)) {
        s.state = 'drop'
        s.t = 0
        this.onDrop()
      }
    } else if (s.state === 'drop') {
      // 落地斜插 0.9s 后重发
      s.t += dt
      if (s.t >= DROP_T) {
        const side = Math.random() < 0.5 ? 0 : 1
        this.serve(s.to, side)
      }
    }

    // 统计
    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('踢起', this.decks[0].kicks + this.decks[1].kicks)
    this.ctx.setExtra('换脚踢', this.decks[0].swaps + this.decks[1].swaps)
    this.ctx.setExtra('最多连续', this.best)
    this.ctx.setExtra('落地', this.drops)
  }

  /** 每玩家的脚竖直速度（px/s） */
  footVy: number[][] = [
    [0, 0],
    [0, 0],
  ]

  private newServe(to: number, side: number) {
    const dk = this.decks[to]
    const s = this.newShuttle(to, side)
    // 发球：从踢球者头顶位竖直落下（vy=0），横位髋 ±0.3T 随机侧
    s.x = dk.hipX + (side === 0 ? 1 : -1) * KICK_OFF * dk.torso
    s.y = Math.max(SERVE_TOP * (this.H / 720), dk.kneeY - (SERVE_H[0] + Math.random() * (SERVE_H[1] - SERVE_H[0])) * dk.torso)
    s.vy = 0
    s.state = 'fly'
    s.t = 0
    s.rot = 0
    s.lastKickT = this.t
    this.shuttle = s
    this.ctx.audio.slash()
  }

  /** 踢起重发：从踢点（脚高过球心则修正到脚上）以 apex 重新踢起 */
  private serve(to: number, side: number) {
    this.newServe(to, side)
  }

  /** 到达膝位的预计时间 W()：1/60 步长数值积分（≤5s） */
  private timeToKnee(s: Shuttle, dk: Deck) {
    let y = s.y
    let vy = s.vy
    const target = dk.kneeY
    const cap = this.cfg.vt * dk.torso
    let t = 0
    while (y < target && t < 5) {
      vy = Math.min(cap, vy + this.cfg.gDown * dk.torso * INT_STEP)
      y += vy * INT_STEP
      t += INT_STEP
    }
    return Math.max(0.15, t)
  }

  /** 单条腿 kneeLift（相对自然下垂位） */
  private legLift(dk: Deck, b: NonNullable<PoseFrame['bodies'][number]>, leg: number) {
    const kneeY = (leg === 0 ? b.lKnee.y : b.rKnee.y) * this.H
    return (dk.hipY + NATURAL_KNEE * dk.torso - kneeY) / dk.torso
  }

  /** 踢中判定 X()：膝盖踢（球在膝窗内 + 侧合规 + 刚抬起的膝）或脚踢（脚够近 + 主动上踢/另一脚更低） */
  private tryKick(f: PoseFrame, s: Shuttle, dk: Deck): number | null {
    const b = f.bodies[s.to]
    if (!b) return null
    const torso = dk.torso
    const win = this.cfg.win * torso
    // 球心低于窗下沿 −0.4z 才开始判（从上方进入窗口）
    if (s.y < dk.kneeY - win - 0.4 * s.r) return null
    // 膝盖踢：球在 knee ± win 窗内
    const inWin = Math.abs(s.y - dk.kneeY) <= win
    // 脚踢：脚距球 < z + 脚r
    const footR = 18 * (this.H / 720)
    const z = s.r
    const feet = [
      { x: b.lFoot.x * this.W, y: b.lFoot.y * this.H },
      { x: b.rFoot.x * this.W, y: b.rFoot.y * this.H },
    ]
    let footHit = -1
    for (let i = 0; i < 2; i++) {
      if (Math.hypot(feet[i].x - s.x, feet[i].y - s.y) < z + footR) footHit = i
    }
    if (!inWin && footHit < 0) return null
    // 侧合规：easy 任意腿；否则须 A.side 那侧（换侧球提示「另一只脚！」）
    const leg = footHit >= 0 ? footHit : s.side
    if (!this.cfg.anyLeg && leg !== s.side) {
      if (this.t - dk.lastHintT > 8) {
        dk.lastHintT = this.t
        this.say('另一只脚！', s.x, s.y - 60, '#ffb703', 34)
        this.ctx.audio.play('pop', 0.5, 0.9)
      }
      return null
    }
    const lift = this.legLift(dk, b, leg)
    if (footHit >= 0) {
      // 脚踢：另一脚明显更低 >0.2T 或该脚正在快速上踢 vel.y < −1.2×躯干/s
      const vy = this.footVy[s.to][leg] / torso
      const other = feet[1 - leg].y
      const lower = other > feet[leg].y + FOOT_PUSH * torso
      if (!(lower || vy < FOOT_KICK_V)) return null
    } else {
      // 膝盖踢：该腿 kneeLift > lift 且 0.7s 内该腿曾在低位（刚抬起的膝才算，一直架着腿无效）
      if (!(lift > this.cfg.lift && this.t - dk.lowAt[leg] < MEM_WIN)) return null
    }
    return leg
  }

  /** 踢中结算 q()：换腿 +2 / 同腿 +1；新球踢起；双人传队友（缺位自传）；switchP 概率换边 */
  private onKick(s: Shuttle, dk: Deck, leg: number, duo: boolean) {
    const swapped = dk.lastLeg >= 0 && leg !== dk.lastLeg
    const h = swapped ? 2 : 1
    dk.lastLeg = leg
    dk.kicks++
    if (swapped) dk.swaps++
    this.score += h
    // 双人队友同步 +h（合作共分）
    if (duo) {
      const mate = 1 - s.to
      if (this.players[mate].body) this.score += h
    }
    this.combo++
    this.best = Math.max(this.best, this.combo)
    // 音效/特效
    this.ctx.audio.play('hit', 0.9, 1 + Math.min(0.3, this.combo * 0.02))
    if (swapped) {
      this.say('换脚 +2', s.x, s.y - 50, '#ffd54a', 38)
      this.ctx.audio.coin()
      this.particles.burst(s.x, s.y, '#ffd54a', 12, 320, 5, 700, '⭐')
    } else {
      this.particles.burst(s.x, s.y, '#ffffff', 7, 280, 4)
    }
    this.particles.burst(s.x, s.y, '#ff8fa3', 6, 240, 3.5)
    // 每满 10：tada + 横幅 + 6 处 confetti×14
    if (this.combo % 10 === 0) {
      this.ctx.audio.play('win', 0.85)
      this.bannerText = duo ? `一起踢了 ${this.combo} 个！` : `${this.combo} 个不落地！`
      this.bannerT = 1.6
      this.particles.confetti(this.W, 40)
    }
    // 新球：从踢点（脚高过球心则修正到脚上）以 apex ∈ cfg ×T 相对膝踢起
    let to = s.to
    if (duo) {
      const mate = 1 - s.to
      if (this.players[mate].body) to = mate
    }
    const side = Math.random() < this.cfg.switchP ? 1 - s.side : s.side
    const dk2 = this.decks[to]
    const ns = this.newShuttle(to, side)
    const b = this.players[s.to].body
    const footY = b ? (leg === 0 ? b.lFoot.y : b.rFoot.y) * this.H : s.y
    ns.x = dk2.hipX + (side === 0 ? 1 : -1) * KICK_OFF * dk2.torso
    ns.y = Math.min(s.y, footY)
    const apex = (this.cfg.apex[0] + Math.random() * (this.cfg.apex[1] - this.cfg.apex[0])) * dk2.torso
    // 从踢点向上有初速：v = sqrt(2×gUp×(目标顶点 − 当前))
    const apexY = dk2.kneeY - apex
    const rise = Math.max(20, ns.y - apexY)
    ns.vy = -Math.sqrt(2 * this.cfg.gUp * dk2.torso * rise)
    ns.state = 'fly'
    ns.t = 0
    ns.lastKickT = this.t
    this.shuttle = ns
  }

  /** 落地：连击清 0、全员 lastLeg 清 -1（换脚统计重置）、落地 P++ */
  private onDrop() {
    this.drops++
    this.combo = 0
    for (const dk of this.decks) dk.lastLeg = -1
    this.ctx.audio.play('hit', 0.8, 0.7)
    this.bannerText = '落地啦'
    this.bannerT = 1.1
    this.ctx.audio.fail()
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const duo = this.players.filter((p) => p.body).length > 1
    const s = this.shuttle
    const dk = this.decks[s.to]

    // 踢点判定圈 Q()：窗内实线高亮脉动、窗外虚线；下方画鞋精灵
    if (dk.ready) {
      const tx = dk.hipX + (s.side === 0 ? 1 : -1) * KICK_OFF * dk.torso
      const win = this.cfg.win * dk.torso
      const inWinNow = s.state === 'fly' && s.vy > 0 && Math.abs(s.y - dk.kneeY) <= win
      c.save()
      if (inWinNow) {
        c.globalAlpha = 0.7 + Math.sin(this.t * 10) * 0.2
        c.strokeStyle = '#3ddc97'
        c.lineWidth = 5
        c.beginPath()
        c.ellipse(tx, dk.kneeY, win, win * 0.5, 0, 0, Math.PI * 2)
        c.stroke()
      } else {
        c.globalAlpha = 0.4
        c.setLineDash([10, 8])
        c.strokeStyle = '#fff'
        c.lineWidth = 3
        c.beginPath()
        c.ellipse(tx, dk.kneeY, win, win * 0.5, 0, 0, Math.PI * 2)
        c.stroke()
      }
      c.restore()
      // 鞋标
      c.font = `${Math.round(30 * U)}px "Apple Color Emoji","Segoe UI Emoji",sans-serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText('👟', tx, dk.kneeY + win * 0.5 + 26 * U)
      // 球接近膝位时画收缩预告圈（1.4−t 命中提示环）
      if (s.state === 'fly' && s.vy > 0 && s.y < dk.kneeY) {
        const eta = Math.max(0.15, (dk.kneeY - s.y) / Math.max(60, s.vy))
        if (eta < 1.4) {
          const k = 1 - eta / 1.4
          c.save()
          c.globalAlpha = 0.3 + k * 0.4
          c.strokeStyle = '#ffd54a'
          c.lineWidth = 4
          c.beginPath()
          c.arc(tx, dk.kneeY, win * (1.6 - 0.6 * k), 0, Math.PI * 2)
          c.stroke()
          c.restore()
        }
      }
    }

    // 毽子（随速度方向旋转 + 微摆 sin(clock×7)×0.06×(vy/vt)）
    if (s.state !== 'drop' || s.t < DROP_T) {
      const R = SHUTTLE_R * U * 0.5
      const dropK = s.state === 'drop' ? s.t / DROP_T : 0
      c.save()
      c.translate(s.x, s.y)
      if (s.state === 'drop') {
        c.rotate((s.side === 0 ? 1 : -1) * 1.25 * Math.min(1, dropK * 1.4))
        c.globalAlpha = 1 - dropK * 0.9
      } else {
        const vt = this.cfg.vt * dk.torso
        const sway = Math.sin(this.t * 7) * 0.06 * Math.max(0, Math.min(1, s.vy / Math.max(1, vt)))
        c.rotate(s.rot * 0.35 + sway)
      }
      // 羽毛（扇形）+ 底座
      glow(c, 0, 0, R * 1.6, '#ffffff', 0.15)
      c.fillStyle = '#fdfdfd'
      for (let i = -2; i <= 2; i++) {
        c.save()
        c.rotate((i / 2) * 0.5)
        c.beginPath()
        c.moveTo(0, R * 0.35)
        c.quadraticCurveTo(i * R * 0.16, -R * 0.3, 0, -R * 0.75)
        c.quadraticCurveTo(i * R * 0.1, -R * 0.2, 0, R * 0.35)
        c.fill()
        c.restore()
      }
      c.fillStyle = '#ff8fa3'
      c.beginPath()
      c.ellipse(0, R * 0.42, R * 0.34, R * 0.2, 0, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = 'rgba(30,30,60,.45)'
      c.lineWidth = 2
      c.stroke()
      c.restore()
      // 地面影子随接近变大变深
      if (s.state === 'fly') {
        const prox = Math.max(0, Math.min(1, 1 - (dk.groundY - s.y) / (this.H * 0.6)))
        c.save()
        c.globalAlpha = 0.12 + prox * 0.2
        c.beginPath()
        c.ellipse(s.x, dk.groundY, R * (0.5 + 0.5 * prox), R * 0.18, 0, 0, Math.PI * 2)
        c.fillStyle = '#000'
        c.fill()
        c.restore()
      }
    }

    // 落点目标玩家提示
    if (duo) {
      outlineTxt(c, `${s.to === 0 ? '玩家 1' : '玩家 2'} 接`, this.players[s.to].body ? this.players[s.to].body!.shoulderC.x * this.W : this.W * (s.to === 0 ? 0.25 : 0.75), 120, 24, this.players[s.to].color)
    }

    // 连击角标
    if (this.combo >= 2) {
      outlineTxt(c, `连续 ${this.combo}`, 110, 60, 30 + Math.min(14, this.combo), '#ffd54a')
      outlineTxt(c, `最多 ${this.best}`, 110, 100, 22, '#ffffffaa')
    }
    if (this.bannerT > 0 && this.bannerText) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.2, 48, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, '毽子落到膝盖高，抬起那边的腿踢上去；换一只脚 +2，落地重新数', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.85)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new Shuttlecock(ctx)
}
