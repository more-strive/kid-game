import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'

/**
 * 拍手开花（对齐 dongdongpark 真实规则）：
 * 小兔子按谱面示范 拍手C/举手U/张臂W，圆圈缩到最小那拍一起做；命中脚下开花，
 * 双人同拍做对 +2 并飞蝴蝶。拍手用双手合拢近似（站点用麦克风声检测）。
 */
type Move = 'C' | 'U' | 'W'

const MOVE_LABEL: Record<Move, string> = { C: '拍手', U: '举双手', W: '张开手臂' }
const MOVE_EMOJI: Record<Move, string> = { C: '👏', U: '🙌', W: '🙆' }

/** 对齐站点难度表：节拍周期/判定窗/小节动作池 */
const DIFF = [
  { period: 1.15, win: 0.42, bars: ['CCCU', 'CCCU', 'CUCU'] },
  { period: 1.0, win: 0.36, bars: ['CCCU', 'CUCU', 'CCWU', 'CWCU'] },
  { period: 0.88, win: 0.3, bars: ['CWCU', 'CCWU', 'WUCU', 'CUWU', 'WCWU', 'CCCU'] },
]
const LATENCY = 0.08 // 输入延迟补偿（所有手势按 t−0.08 判定）
const RESET_U = 0.2 // 举手复位阈值（×torso，腕回落到肩线下 0.2 躯干内）
const TRIG_W = 1.55 // 张臂触发阈值（×torso）
const RESET_W = 1.1 // 张臂复位阈值
const CLAP_ON = 0.18 // 合掌触发（腕距 ×torso）
const CLAP_OFF = 0.35 // 合掌复位
const SLOT_JITTER = (slot: number) => 0.9 + ((slot * 37) % 10) / 50

interface Beat {
  t: number
  move: Move
  hit: [boolean, boolean]
  closed: boolean
}

interface Flower {
  slot: number
  move: Move
  colorIdx: number
  bornAt: number
}

interface Butterfly {
  x: number
  y: number
  vx: number
  color: string
  age: number
}

const COLORS = ['#ff8fb1', '#ffd166', '#9b5de5', '#3ddc97', '#4cc9f0']

class ClapBloom extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  beats: Beat[] = []
  score = 0
  combo = 0
  together = 0
  gardens = 0
  /** 每个玩家的花 */
  flowers: [Flower[], Flower[]] = [[], []]
  totalFlowers = 0
  butterflies: Butterfly[] = []
  hits = 0
  /** 已过拍数（用于结算跟上节拍） */
  passedBeats = 0
  /** 手势边沿状态 */
  private clapOpen = [true, true]
  private uArmed = [true, true]
  private wArmed = [true, true]
  /** 当前判定指针（beat 关闭推进） */
  private cursor = 0
  private wTaught = false

  constructor(ctx: GameContext) {
    super(ctx)
    // 谱面：首拍 = 0.8s 静默 + 3 预备拍；前 2 小节 CCCU，之后每小节从池中抽（对齐站点）
    const D = 0.8 + 3 * this.cfg.period
    const k = Math.max(4, Math.floor((60 - D - 0.6) / this.cfg.period) + 1)
    const bars = Math.ceil(k / 4)
    let pattern = ''
    for (let bar = 0; bar < bars; bar++) {
      pattern += bar < 2 ? 'CCCU' : this.cfg.bars[Math.floor(Math.random() * this.cfg.bars.length)]
    }
    pattern = pattern.slice(0, k).padEnd(k, 'C')
    for (let i = 0; i < k; i++) {
      this.beats.push({ t: D + i * this.cfg.period, move: pattern[i] as Move, hit: [false, false], closed: false })
    }
    this.ctx.setStage('跟着小兔子做')
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  /** 三种手势检测（每玩家）：返回本帧触发的动作，无则 null */
  private gesture(pi: number, b: Body): Move | null {
    const torso = Math.max(0.05, b.scale)
    const lx = b.lHand.x * this.W
    const ly = b.lHand.y * this.H
    const rx = b.rHand.x * this.W
    const ry = b.rHand.y * this.H
    const noseY = b.head.y * this.H
    void noseY
    const shY = b.shoulderC.y * this.H
    const torsoPx = torso * this.H

    // C 拍手：双手合拢边沿（近似站点的声检测）
    const span = Math.hypot(lx - rx, ly - ry)
    if (this.clapOpen[pi] && span < CLAP_ON * torsoPx) {
      this.clapOpen[pi] = false
      return 'C'
    }
    if (span > CLAP_OFF * torsoPx) this.clapOpen[pi] = true

    // U 举手：双腕都在鼻子上方，上升沿触发；任一腕落回肩线附近复位
    const up = b.lHand.y < b.head.y && b.rHand.y < b.head.y
    if (this.uArmed[pi] && up) {
      this.uArmed[pi] = false
      return 'U'
    }
    if (ly > shY - RESET_U * torsoPx || ry > shY - RESET_U * torsoPx) this.uArmed[pi] = true

    // W 张臂：腕距 >1.55×躯干 且都在肩高 ±0.6 躯干内，上升沿；<1.1 复位
    const flat = Math.abs(lx - rx) / torsoPx > TRIG_W && Math.abs(ly - shY) < 0.6 * torsoPx && Math.abs(ry - shY) < 0.6 * torsoPx
    if (this.wArmed[pi] && flat) {
      this.wArmed[pi] = false
      return 'W'
    }
    if (Math.abs(lx - rx) / torsoPx < RESET_W) this.wArmed[pi] = true

    return null
  }

  tick(f: PoseFrame, dt: number) {
    void dt
    const now = this.t - LATENCY
    const duo = this.present() > 1

    // 首个 W 拍前 2.2 拍播教学语音
    const firstW = this.beats.find((bt) => bt.move === 'W')
    if (firstW && !this.wTaught && now >= firstW.t - 2.2 * this.cfg.period) {
      this.wTaught = true
      this.ctx.speak('小兔子张开手臂，你也张开！')
    }

    // 漏拍关闭
    for (const bt of this.beats) {
      if (!bt.closed && now > bt.t + this.cfg.win + 0.05) {
        bt.closed = true
        this.passedBeats++
        // 连击结算：单人漏拍清零；双人非 together 清零
        if (duo) {
          if (!(bt.hit[0] && bt.hit[1])) this.combo = 0
        } else if (!bt.hit[0]) this.combo = 0
      }
    }

    // 输入判定（倒扫当前窗口找最小时间差）
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi]
      if (!b) continue
      const g = this.gesture(pi, b)
      if (!g) continue
      let target: Beat | null = null
      let bestD = 1e9
      for (let i = this.cursor; i < this.beats.length; i++) {
        const bt = this.beats[i]
        if (bt.closed) continue
        if (bt.t - now > this.cfg.win + 0.1) break
        if (bt.move !== g || bt.hit[pi]) continue
        const d = Math.abs(now - bt.t)
        if (d <= this.cfg.win && d < bestD) {
          bestD = d
          target = bt
        }
      }
      if (!target) continue
      target.hit[pi] = true
      this.hits++
      const both = target.hit[0] && target.hit[1]
      // 单人 +3/拍；双人同拍都做对 +2、只有一人做对 +1（站点对两人各记一次，共享总分等价）
      this.score += duo ? (both ? 2 : 1) : 3
      this.combo++
      if (duo && both) {
        this.together++
        this.say('一起！', this.W / 2, this.H * 0.4, '#ff8fb1', 44)
        this.butterflies.push({
          x: this.W / 2 + (Math.random() - 0.5) * 200,
          y: this.H * 0.5,
          vx: (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 30),
          color: COLORS[this.together % COLORS.length],
          age: 0,
        })
        this.ctx.audio.good()
      }
      // 命中音按动作（对齐站点：U chime / W boing / C pop）
      if (target.move === 'U') this.ctx.audio.good()
      else if (target.move === 'W') this.ctx.audio.play('pop', 1, 1.2)
      else this.ctx.audio.pop()
      this.plantFlower(pi, target.move)
      if (this.combo > 0 && this.combo % 12 === 0) {
        this.sayText(duo ? `一起做对 ${this.combo} 拍！` : `连着做对 ${this.combo} 拍！`)
        this.ctx.audio.good()
      }
    }

    // 蝴蝶漂移
    for (const bf of this.butterflies) {
      bf.age += dt
      bf.x += bf.vx * dt
      bf.y += Math.sin(bf.age * 6) * 20 * dt
    }
    this.butterflies = this.butterflies.filter((bf) => bf.age < 4)
    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('开花', this.totalFlowers)
    if (duo) this.ctx.setExtra('一起', this.together)
  }

  /** 命中种花：从花圃中间向外找空槽；种满整圃 → 爆开重来 */
  private plantFlower(pi: number, move: Move) {
    const duo = this.present() > 1
    const slots = duo ? 9 : 14
    const order: number[] = []
    const center = (slots - 1) / 2
    for (let i = 0; i < slots; i++) order.push(i)
    order.sort((a, b2) => Math.abs(a - center) - Math.abs(b2 - center))
    const garden = this.flowers[pi]
    for (const slot of order) {
      if (!garden.some((fl) => fl.slot === slot)) {
        garden.push({ slot, move, colorIdx: this.totalFlowers % COLORS.length, bornAt: this.t })
        this.totalFlowers++
        break
      }
    }
    if (garden.length >= slots) {
      // 整圃绽放
      this.gardens++
      this.ctx.audio.good()
      for (const fl of garden) {
        const pos = this.slotPos(pi, fl.slot, slots)
        this.particles.burst(pos.x, pos.y, '#ff8fb1', 3, 260, 4)
      }
      this.flowers[pi] = []
      this.say('花开满圃！', this.W / 2, this.H * 0.3, '#ffd54a', 44)
    }
  }

  /** 花圃槽位坐标 */
  private slotPos(pi: number, slot: number, slots: number) {
    const duo = this.present() > 1
    const zone = duo
      ? (pi === 0 ? { x0: 0.04, x1: 0.44 } : { x0: 0.56, x1: 0.96 })
      : { x0: 0.1, x1: 0.9 }
    const x = (zone.x0 + ((slot + 0.5) / slots) * (zone.x1 - zone.x0)) * this.W
    return { x, y: this.H - 70 }
  }

  bannerText = ''
  bannerT = 0
  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1.1
  }

  /** 当前应显示的提示拍：最近一个未关闭且 t+win ≥ now 的拍 */
  private currentBeat() {
    const now = this.t - LATENCY
    let best: Beat | null = null
    for (const bt of this.beats) {
      if (now >= bt.t - this.cfg.win && now <= bt.t + this.cfg.win) return bt
      if (bt.t > now && (!best || bt.t < best.t)) best = bt
    }
    return best
  }

  paint(c: CanvasRenderingContext2D) {
    const duo = this.present() > 1
    const cur = this.currentBeat()

    // 花圃
    for (let pi = 0; pi < 2; pi++) {
      const slots = duo ? 9 : 14
      const zone = duo
        ? (pi === 0 ? { x0: 0.04, x1: 0.44 } : { x0: 0.56, x1: 0.96 })
        : { x0: 0.1, x1: 0.9 }
      c.save()
      c.globalAlpha = 0.3
      c.fillStyle = '#6bbb67'
      c.fillRect(zone.x0 * this.W, this.H - 52, (zone.x1 - zone.x0) * this.W, 30)
      c.restore()
      for (const fl of this.flowers[pi]) {
        const pos = this.slotPos(pi, fl.slot, slots)
        const grow = Math.min(1, (this.t - fl.bornAt) / 0.4)
        const height = (fl.move === 'U' ? 0.2 : fl.move === 'C' ? 0.15 : 0.13) * this.H * SLOT_JITTER(fl.slot) * grow
        c.save()
        c.strokeStyle = '#3f8f22'
        c.lineWidth = 3
        c.beginPath()
        c.moveTo(pos.x, pos.y)
        c.lineTo(pos.x, pos.y - height)
        c.stroke()
        c.font = `${26 * grow}px system-ui`
        c.textAlign = 'center'
        c.textBaseline = 'middle'
        c.fillText('🌸', pos.x, pos.y - height)
        c.restore()
      }
    }

    // 蝴蝶
    for (const bf of this.butterflies) {
      c.save()
      c.globalAlpha = Math.min(1, (4 - bf.age) / 1)
      c.translate(bf.x, bf.y + Math.sin(bf.age * 10) * 6)
      c.font = '30px system-ui'
      c.textAlign = 'center'
      c.fillText('🦋', 0, 0)
      c.restore()
    }

    // 小兔子 + 提示圈
    const cx = this.W / 2
    const cueY = this.H * 0.33
    if (cur) {
      const toBeat = cur.t - (this.t - LATENCY)
      // 收缩提示环
      const closeK = Math.max(0, Math.min(1, 1 - (toBeat + this.cfg.win) / (this.cfg.win * 2 + this.cfg.period)))
      c.save()
      c.globalAlpha = 0.35 + (1 - closeK) * 0.65
      circle(c, cx, cueY, 60 + closeK * 50, 'rgba(124,92,255,.25)')
      c.globalAlpha = 1
      c.strokeStyle = '#fff6c9'
      c.lineWidth = 4
      c.beginPath()
      c.arc(cx, cueY, 60 + closeK * 50, 0, Math.PI * 2)
      c.stroke()
      c.restore()
      // 动作图标
      c.font = '54px system-ui'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(MOVE_EMOJI[cur.move], cx, cueY)
      outlineTxt(c, MOVE_LABEL[cur.move], cx, cueY + 84, 30, '#fff6c9')
    }
    // 小兔子（🐰 蹦跳）
    const hop = cur ? Math.abs(Math.sin(((this.t - LATENCY) / this.cfg.period) * Math.PI)) * 8 : 0
    c.font = '84px system-ui'
    c.textAlign = 'center'
    c.fillText('🐰', cx, this.H - 110 - hop)

    // 连击与横幅
    if (this.combo >= 4) {
      outlineTxt(c, duo ? `一起 ×${this.combo}` : `×${this.combo}`, cx, 76, 36, '#ffd54a')
    }
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 150, 44, '#ff8fb1')
      c.globalAlpha = 1
    }
    txt(c, '兔子拍手你拍手、举手你举手、张臂你张臂；缩圈到最小一起做', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

export default function create(ctx: GameContext) {
  return new ClapBloom(ctx)
}
