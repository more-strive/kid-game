import { BaseGame } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 鬼脸大赛 / funny-face（对齐 dongdongpark 真实规则）：
 * 翻一张鬼脸卡（张嘴/眨眼/鼓腮/嘟嘴/惊讶/大笑/生气…），对摄像头做出**一模一样**的表情并保持
 * 0.35~0.45 秒 →「咔嚓」拍照 +1 分；双人共用一张卡，先达标者「抢先 +2」并把对方窗口压缩到 after 秒；
 * 超时无人拍则收牌。判定唯一输入是 face 的 8 个 blendShape 字段，body.head 只用于取景框/照片位置。
 *
 * 全部字面量沿用站点：作答窗口 7/5/4s、保持 hold 0.35/0.4/0.45s、阈值缩放 th 0.85/1/1、
 * 另眼 openMax 0.4/0.35/0.3（超过单侧打 7 折）、2P 追加窗口 after 3/2.5/2s、卡间空档 1.4/1.3/1.2s、
 * 原始阈值 S：jaw .5 / blink .55 / puff .35 / pucker .45 / browUp .4 / surpriseJaw .25 / smile .6 / browDown .35；
 * 卡组 easy 7 款 / medium +winkL/winkR / hard 再加 puffBrow/pout/mouthWink（本框架只有 blinkL/R 无 wink 双向
 * 差异字段，wink/winkL/winkR 合并为「任一眼闭」blink 卡）；
 * 判定归一化 n(x,s)=clamp(x/(s×th))、眨眼 r=min(n(闭),另眼≤openMax?1:.7)、蓄力 1.5× 速回退、
 * 近成功 0.6~1 提示「再用力一点！」、首张发牌 0.6s、卡间 gap、翻面动画 0.35s、
 * 2P 先拍 +2 压窗、缺脸 2.5s 提示走近、美颜成像（照片 ≥ 目标×0.8）。
 *
 * 与站点的差异（写明待实测）：
 * 1) 站点 face 8 字段由框架黑盒算出 → 本框架 FaceLandmarker blendShapes 直接映射
 *    （jaw/blinkL/blinkR/puff/pucker/browUp/smile/browDown），blink 为闭合度同口径；puff/pucker
 *    是 blendshape 近似（站点几何比值黑盒），阈值需真机校准；
 * 2) 站点 wink 家族拆左右分卡（medium+），本框架 blinkL/R 字段同源 → wink 三卡合并为一张「眨一只眼」
 *    （任一眼闭即可，另一眼须睁开 ≤openMax），卡组缩为 10 款；
 * 3) 精灵（拍立得/卡面/角色）→ 几何绘制；双人共享一个分数（仓库口径）；
 * 4) ai() 演示替身未实装。
 */
type Kind =
  | 'mouth' | 'blink' | 'puff' | 'pucker' | 'surprise' | 'laugh' | 'angry' | 'puffBrow' | 'pout' | 'mouthWink'


/** 站点三档：作答窗口 / 保持时长 / 阈值缩放 / 另眼 openMax / 追加窗口 / 卡间空档 */
const DIFF = [
  { window: 7, hold: 0.35, th: 0.85, openMax: 0.4, after: 3, gap: 1.4 },
  { window: 5, hold: 0.4, th: 1, openMax: 0.35, after: 2.5, gap: 1.3 },
  { window: 4, hold: 0.45, th: 1, openMax: 0.3, after: 2, gap: 1.2 },
]

/** 原始表情阈值 S（判定时 ×th） */
const S = { jaw: 0.5, blink: 0.55, puff: 0.35, pucker: 0.45, browUp: 0.4, surpriseJaw: 0.25, smile: 0.6, browDown: 0.35 }

/** 卡组：easy 7 款基础；wink 三方向合并为一张 blink（本框架 blinkL/R 同源，见文件头差异 2） */
const DECKS: Kind[][] = [
  ['mouth', 'blink', 'puff', 'pucker', 'surprise', 'laugh', 'angry'],
  ['mouth', 'blink', 'puff', 'pucker', 'surprise', 'laugh', 'angry'],
  ['mouth', 'blink', 'puff', 'pucker', 'surprise', 'laugh', 'angry', 'puffBrow', 'pout', 'mouthWink'],
]
const CARD_META: Record<Kind, { name: string; emoji: string; say: string }> = {
  mouth: { name: '张大嘴', emoji: '😮', say: '张大嘴巴！' },
  blink: { name: '眨一只眼', emoji: ' 😉', say: '眨一只眼睛！' },
  puff: { name: '鼓腮帮', emoji: '😗', say: '吸一口气，把脸蛋鼓起来！' },
  pucker: { name: '嘟嘟嘴', emoji: '😙', say: '嘴巴嘟起来！' },
  surprise: { name: '惊讶', emoji: '😲', say: '眉毛挑起来，嘴巴张小口！' },
  laugh: { name: '大笑', emoji: '😄', say: '笑一个，哈哈哈！' },
  angry: { name: '生气', emoji: '😠', say: '皱起眉毛，哼！' },
  puffBrow: { name: '鼓腮+挑眉', emoji: '😯', say: '鼓腮帮再挑眉毛！' },
  pout: { name: '嘟嘴+皱眉', emoji: '☹️', say: '嘟嘴再皱眉！' },
  mouthWink: { name: '张嘴+眨眼', emoji: '😜', say: '张嘴再眨一只眼！' },
}

const FLIP_T = 0.35
const NEAR_T = 1.3 // 近成功提示
const ABSENT_T = 2.5 // 缺脸提示

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

class FunnyFace extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  deck: Kind[] = DECKS[this.ctx.difficulty] ?? DECKS[0]
  phase: 'gap' | 'show' = 'gap'
  phaseAt = -0.6
  card: Kind | null = null
  seats = 1
  turn = 0
  private seatActive = [false, false]
  private shot = [false, false]
  private firstShooter = -1
  private charge = [0, 0]
  private nearT: [number, number] = [0, 0]
  private nearSaid = false
  private absent: [number, number] = [0, 0]
  private absentHintAt = -10
  private photos = 0
  private firsts: [number, number] = [0, 0]
  private flash = 0
  private window = this.cfg.window
  private order: Kind[] = []
  private oi = 0
  private rng = mulberry32(11)
  private U = Math.min(this.W, this.H) / 720

  constructor(ctx: GameContext) {
    super(ctx)
    ctx.enableFace().catch(() => undefined)
    this.nextCard()
  }

  private nextCard() {
    if (this.oi >= this.order.length) {
      const kinds = [...this.deck]
      for (let i = kinds.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1))
        ;[kinds[i], kinds[j]] = [kinds[j], kinds[i]]
      }
      if (kinds[0] === this.card && kinds.length > 1) [kinds[0], kinds[1]] = [kinds[1], kinds[0]]
      this.order = kinds
      this.oi = 0
    }
    this.card = this.order[this.oi++]
    this.phase = 'show'
    this.phaseAt = this.t
    this.shot = [false, false]
    this.firstShooter = -1
    this.charge = [0, 0]
    this.nearT = [0, 0]
    this.nearSaid = false
    this.window = this.cfg.window
    const meta = CARD_META[this.card]
    this.ctx.speak(meta.say)
    this.ctx.audio.play('click', 0.4, 0.8)
  }

  /** 表情匹配评分 oe(card, face)（站点公式原样） */
  private scoreFace(card: Kind, face: NonNullable<PoseFrame['bodies'][number]['face']>): number {
    const th = this.cfg.th
    const n = (x: number, s: number) => clamp(x / (s * th), 0, 1)
    // 眨眼：任一眼闭合，另一眼必须睁开（openMax）
    const r = (closed: number, other: number) => Math.min(n(closed, S.blink), other <= this.cfg.openMax ? 1 : 0.7)
    const winkAny = Math.max(r(face.blinkL, face.blinkR), r(face.blinkR, face.blinkL))
    switch (card) {
      case 'mouth': return n(face.jaw, S.jaw)
      case 'blink': return winkAny
      case 'puff': return n(face.puff, S.puff)
      case 'pucker': return n(face.pucker, S.pucker)
      case 'surprise': return Math.min(n(face.browUp, S.browUp), n(face.jaw, S.surpriseJaw))
      case 'laugh': return n(face.smile, S.smile)
      case 'angry': return n(face.browDown, S.browDown)
      case 'puffBrow': return Math.min(n(face.puff, S.puff), n(face.browUp, S.browUp))
      case 'pout': return Math.min(n(face.browDown, S.browDown), n(face.pucker, S.pucker))
      case 'mouthWink': return Math.min(n(face.jaw, S.jaw), winkAny)
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) this.seats = 2
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true
    const duo = this.seats > 1
    if (this.flash > 0) this.flash -= dt

    if (this.phase === 'gap') {
      if (this.t - this.phaseAt >= this.cfg.gap) this.nextCard()
      return
    }
    const elapsed = this.t - this.phaseAt
    if (elapsed < FLIP_T) return // 翻面期冻结蓄力

    // 逐玩家判定
    for (let i = 0; i < (duo ? 2 : 1); i++) {
      if (!this.seatActive[i]) continue
      const b = f.bodies[i] ?? null
      const face = b?.face
      if (!face) {
        this.absent[i] += dt
        if (this.absent[i] > ABSENT_T && this.t - this.absentHintAt > 15) {
          this.absentHintAt = this.t
          this.ctx.speak('走近一点，让我看清你的脸')
        }
        continue
      }
      this.absent[i] = 0
      if (this.shot[i]) continue // 已拍照：本轮不再蓄力
      const o = this.card ? this.scoreFace(this.card, face) : 0
      if (o >= 0.999) this.charge[i] += dt
      else this.charge[i] = Math.max(0, this.charge[i] - dt * 1.5)
      if (o >= 0.6 && o < 0.999) {
        this.nearT[i] += dt
        if (this.nearT[i] > NEAR_T && !this.nearSaid) {
          this.nearSaid = true
          this.ctx.speak('再用力一点！')
        }
      } else this.nearT[i] = 0
      if (this.charge[i] >= this.cfg.hold) {
        // 拍照！
        this.shot[i] = true
        this.photos++
        this.flash = 0.35
        this.ctx.audio.play('win', 0.4)
        const isFirst = this.firstShooter < 0
        if (isFirst) {
          this.firstShooter = i
          if (duo) {
            this.firsts[i]++
            this.ctx.addScore(2)
            this.window = Math.min(this.window, elapsed + this.cfg.after)
            this.say(`抢先 +2`, this.W / 2, this.H * 0.16, this.players[i].color, 34)
          } else {
            this.ctx.addScore(1)
            this.say('咔嚓 +1', this.W / 2, this.H * 0.16, '#6bcb77', 32)
          }
        } else {
          this.ctx.addScore(1)
          this.say('咔嚓 +1', this.W / 2, this.H * 0.16, '#6bcb77', 28)
        }
      }
    }
    // 全部在场玩家拍完 → 提前收牌
    let participated = false
    let anyNotShot = false
    for (let i = 0; i < (duo ? 2 : 1); i++) {
      if (!this.seatActive[i]) continue
      participated = true
      if (!this.shot[i]) anyNotShot = true
    }
    if (participated && !anyNotShot) {
      this.phase = 'gap'
      this.phaseAt = this.t
      return
    }
    // 超时
    if (elapsed >= this.window) {
      if (!this.shot.some((s, i) => s && this.seatActive[i])) this.ctx.audio.play('miss', 0.4)
      this.phase = 'gap'
      this.phaseAt = this.t
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.seats > 1
    const U = this.U
    const card = this.card
    const cw = (duo ? 190 : 230) * U
    const ch = cw * 1.26
    const cx = duo ? this.W / 2 : Math.max(115 * U + 24 * U, Math.min(this.W * 0.2, 270 * U))
    const cy = (duo ? this.H * 0.52 : this.H * 0.47) - ch / 2
    // 卡
    rr(c, cx - cw / 2, cy, cw, ch, 16)
    c.fillStyle = '#fffdf3'
    c.fill()
    c.strokeStyle = '#e8dccf'
    c.lineWidth = 5
    c.stroke()
    if (card) {
      const meta = CARD_META[card]
      txt(c, meta.emoji, cx, cy + ch * 0.42, cw * 0.42, '#26152c')
      txt(c, meta.name, cx, cy + ch * 0.82, 24 * U, '#8b6bb0', 'center', 'bold')
    } else {
      txt(c, '?', cx, cy + ch / 2, 48, '#c4b8d0')
    }
    // 倒计时条
    if (this.phase === 'show') {
      const left = clamp(1 - (this.t - this.phaseAt) / this.window, 0, 1)
      const bw = cw * 0.8
      c.fillStyle = 'rgba(255,255,255,.75)'
      c.fillRect(cx - bw / 2, cy + ch + 8 * U, bw, 14 * U)
      c.fillStyle = left < 0.25 ? '#ff5d5d' : '#6bcb77'
      c.fillRect(cx - bw / 2, cy + ch + 8 * U, bw * left, 14 * U)
    }
    // 拍照闪光
    if (this.flash > 0) {
      c.fillStyle = `rgba(255,255,255,${(this.flash / 0.35) * 0.9})`
      c.fillRect(0, 0, this.W, this.H)
    }
    // 逐玩家取景框 + 三颗星
    for (let i = 0; i < (duo ? 2 : 1); i++) {
      const b = this.player(i).body
      if (!b || !this.seatActive[i]) continue
      const headR = Math.max(40 * U, b.scale * this.H * 0.42)
      const hx = b.head.x * this.W
      const hy = b.head.y * this.H
      const shot = this.shot[i]
      const chargeK = this.shot[i] ? 1 : clamp(this.charge[i] / this.cfg.hold, 0, 1)
      const frame = 1.5 - 0.25 * chargeK + (this.shot[i] ? 0 : Math.sin(this.t * 4) * 0.015)
      const col = shot || chargeK >= 1 ? '#6bcb77' : chargeK > 0 ? '#ffd54a' : '#ffffff'
      c.strokeStyle = col
      c.lineWidth = 5
      c.globalAlpha = shot ? 0.9 : 0.55
      const hw = headR * frame
      const corners = 26 * U
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
        const px = hx + sx * hw
        const py = hy + sy * hw
        c.beginPath()
        c.moveTo(px + sx * corners, py)
        c.lineTo(px, py)
        c.lineTo(px, py + sy * corners)
        c.stroke()
      }
      c.globalAlpha = 1
      // 三颗预测星
      const face = b.face
      const o = face && card ? this.scoreFace(card, face) : 0
      const lit = shot ? 3 : this.charge[i] > 0 ? 3 : o >= 0.8 ? 2 : o >= 0.5 ? 1 : 0
      for (let k = 0; k < 3; k++) {
        const on = k < lit
        circle(c, hx - 24 * U + k * 24 * U, hy - hw - 26 * U, 6 * U, on ? '#ffd54a' : 'rgba(255,255,255,.35)')
      }
      if (this.absent[i] > 1.5) outlineTxt(c, '走近一点', hx, hy + hw + 30 * U, 22, '#ff9f43')
    }
    // 分数
    txt(c, `${this.photos} 张`, this.W - 24, 40, 24, '#ffd54a', 'right', 'bold')
    if (duo) {
      txt(c, `P1 ${this.firsts[0]} 抢先`, 24, 40, 15, '#ffffffcc', 'left', 'bold')
      txt(c, `P2 ${this.firsts[1]} 抢先`, 24, 62, 15, '#ffffffcc', 'left', 'bold')
    }
  }
}

export default function create(ctx: GameContext) {
  return new FunnyFace(ctx)
}
