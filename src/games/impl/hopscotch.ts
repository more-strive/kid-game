import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { emoji, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 跳房子（对齐 dongdongpark 真实规则，逆向报告 _reverse/reports/hopscotch.md）：
 * 10 格房子滚过来；单格单脚落地（hard 挑左/右脚）、双格两脚分开，摆对姿势保持一小段即跳过；
 * 跳到 10 再原路跳回，来回一趟（19 格）换新房子。每格 +1 分，星级按累计格数。
 *
 * 站点框架行为等价代理说明：
 * - 站点大屏/儿童双模式（e.big）：本框架无该标志，按儿童模式（!big）实现（同 swim-race 惯例）：
 *   limit+1.2、强制不挑脚、保持 0.22s / 判错 1.2s。
 * - liftedFoot（抬脚检测）：框架无该特征，用双踝各自基线通道（踝升高 >0.06×躯干 → 抬起）代理。
 * - 髋部抬升跳检测：基线 EMA，>0.1×躯干记起跳、<0.04 复位、0.8s 超时强制复位（照抄报告）。
 * - 起跳宽限 since = t+0.25：跳跃重置判定计时（报告 §1 v），空中/落地后重新累计保持时间。
 * - wide 滞回：报告 §1 同时给出 0.9（x）与 0.78（S）两阈值，按「进入 >0.9 / 退出 <0.78」滞回实现。
 * - 音效映射：note→play('pop') 按格子音高变调、oops→fail、boop→click(低增益)、chime→good、tada→win。
 * - 音乐 happy：BGM 由外壳统一管理。
 */

// ---- 难度表 h（报告 §1 全部字面量） ----
const RAW = [
  { limit: 3, pickFoot: false },
  { limit: 2.4, pickFoot: false },
  { limit: 1.8, pickFoot: true },
]
const CHILD_LIMIT_EXTRA = 1.2 // A：儿童模式 limit+1.2
const HOLD_BIG = 0.3 // g：大屏正确姿势保持时间
const HOLD_CHILD = 0.22 // j：儿童模式保持时间
const WRONG_BIG = 0.6 // _：大屏错误姿势判错时间
const WRONG_CHILD = 1.2 // M：儿童模式判错时间（宽容）
const JUMP_GRACE = 0.25 // v：起跳瞬间 since = t+0.25
const JUMP_RISE = 0.1 // y：髋部抬升 >0.1×torso 记起跳
const JUMP_RESET = 0.04 // b：回落 <0.04 复位
const JUMP_TIMEOUT = 0.8 // 空中超时强制复位
const WIDE_ENTER = 0.9 // x：间距 ≥0.9×torso 进入 wide
const WIDE_EXIT = 0.78 // S：间距 <0.78×torso 退出 wide
const DEBOUNCE = 0.06 // C：姿态候选确认时间
const ROWS = 10 // w：每座房子 10 格
const DOUBLE_P = 0.55 // T：单格之后接双格概率
const SWAP_P = 0.7 // E：连续单格之间换脚概率
const CORNER_EXTRA = 1.2 // D：转角格(10)/回家格(1) 额外宽限
const BAD_EXTRA = 0.45 // O：判错/超时后的额外缓冲
const SLIDE_T = 0.3 // k：格子滚动动画时长
const ROW_W = 1.1 // I：格子宽（torso 单位）
const ROW_GAP = 2.4 // L：行距（torso 单位）
const PERSP = 0.24 // R：透视收缩率
const AHEAD = 4 // z：前方预渲染格数
const LIFT_TH = 0.06 // 抬脚阈值（×躯干，本框架代理值）
const NOTES = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76] // 过格音阶（按格子编号 60~76）

type Stance = 'two' | 'wide' | 'onL' | 'onR'

interface Row {
  n: number
  double: boolean
  foot: 0 | 1
}

interface PS {
  rows: Row[]
  idx: number
  dir: 1 | -1
  rowT: number
  extra: number
  cand: Stance
  candT: number
  stance: Stance
  since: number
  footBase: [number, number]
  wide: boolean
  hipBase: number
  air: boolean
  airAt: number
  view: number
  slideFrom: number
  slideT: number
  flash: number
  xMark: number
  ok: number
  bad: number
  late: number
  trips: number
  tip: string
  tipUntil: number
  tipAt: number
}

function outCubic(x: number) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3)
}

/** 肩踝距（归一化）作躯干标尺 */
function spanOf(b: Body): number {
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const ankY = (b.lm[27].y + b.lm[28].y) / 2
  return Math.max(0.06, Math.abs(ankY - shY))
}

/** 姿态判定 J（报告 §2.3） */
function judge(row: Row, st: Stance, pickFoot: boolean): 'good' | 'wait' | 'wrong' {
  if (row.double) {
    if (st === 'wide') return 'good'
    return st === 'two' ? 'wait' : 'wrong'
  }
  if (st === 'onL' || st === 'onR') {
    if (!pickFoot) return 'good'
    return (st === 'onL' ? 0 : 1) === row.foot ? 'good' : 'wrong'
  }
  return st === 'two' ? 'wait' : 'wrong'
}

/** 房子生成 H（报告 §2.1）：前格单格时 55% 接双格；单格前 70% 换脚；每人独立序列 */
function genHouse(): Row[] {
  const rows: Row[] = []
  let n = 1
  let foot: 0 | 1 = Math.random() < 0.5 ? 0 : 1
  let prevSingle = false
  while (n <= ROWS) {
    const dbl = prevSingle && n <= ROWS - 1 && Math.random() < DOUBLE_P
    if (dbl) {
      rows.push({ n, double: true, foot })
      n += 2
      prevSingle = false
    } else {
      if (rows.length && Math.random() < SWAP_P) foot = foot === 0 ? 1 : 0
      rows.push({ n, double: false, foot })
      n += 1
      prevSingle = true
    }
  }
  return rows
}

function newPS(): PS {
  return {
    rows: genHouse(),
    idx: 0,
    dir: 1,
    rowT: 0,
    extra: 0,
    cand: 'two',
    candT: 0,
    stance: 'two',
    since: 0,
    footBase: [NaN, NaN],
    wide: false,
    hipBase: NaN,
    air: false,
    airAt: 0,
    view: 0,
    slideFrom: 0,
    slideT: 1,
    flash: 0,
    xMark: 0,
    ok: 0,
    bad: 0,
    late: 0,
    trips: 0,
    tip: '',
    tipUntil: 0,
    tipAt: -9,
  }
}

class Hopscotch extends BaseGame implements Game {
  /** 儿童模式叠加（!big → 生效）：limit+1.2、不挑脚、保持/判错用儿童值 */
  cfg = {
    limit: (RAW[this.ctx.difficulty] ?? RAW[1]).limit + CHILD_LIMIT_EXTRA,
    pickFoot: false,
    hold: HOLD_CHILD,
    wrongT: WRONG_CHILD,
  }
  /** 大屏参考值（注释保留：站点 big 模式为 hold 0.3 / wrongT 0.6） */
  bigRef = { hold: HOLD_BIG, wrongT: WRONG_BIG }
  ps: PS[] = [newPS(), newPS()]
  bannerText = ''
  bannerT = 0
  popT = 0
  popAt = -9
  private realClock = 0

  constructor(ctx: GameContext) {
    super(ctx)
    this.ctx.setStage('单格单脚、双格分开，跳到 10 再跳回来！')
  }

  update(f: PoseFrame, dt: number) {
    this.realClock += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    this.popT = Math.max(0, this.popT - dt)
    super.update(f, dt)
  }

  tick(f: PoseFrame, dt: number) {
    for (let pi = 0; pi < 2; pi++) {
      const b = f.bodies[pi] ?? null
      const ps = this.ps[pi]
      ps.flash = Math.max(0, ps.flash - dt * 2.2)
      ps.xMark = Math.max(0, ps.xMark - dt)
      if (ps.tipUntil && this.t > ps.tipUntil) ps.tip = ''
      // 滚动镜头动画（outCubic 0.3s）
      ps.slideT += dt
      ps.view = ps.slideFrom + (ps.idx - ps.slideFrom) * outCubic(ps.slideT / SLIDE_T)

      // 缺席玩家：rowT 继续走（会积累 late），hold 清零（报告 §2.4）
      if (!b) {
        ps.since = 1e9
      } else {
        const span = spanOf(b)
        this.updateStance(ps, b, span, dt)
        this.jumpChannel(ps, b, span, dt)
        const row = ps.rows[ps.idx]
        const j = judge(row, ps.stance, this.cfg.pickFoot)
        const held = this.t - ps.since
        if (j === 'good' && held >= this.cfg.hold) {
          this.settle(pi, 'ok')
        } else if (j === 'wrong' && held >= this.cfg.wrongT) {
          this.settle(pi, 'bad')
        } else if (this.t - ps.rowT > this.cfg.limit + ps.extra) {
          this.settle(pi, 'late')
        }
      }
    }
    this.ctx.setExtra('准确率(%)', (() => {
      const s = this.ps[0]
      const t = s.ok + s.bad + s.late
      return t ? Math.round((100 * s.ok) / t) : 100
    })())
    this.ctx.setExtra('来回趟数', Math.max(this.ps[0].trips, this.ps[1].trips))
  }

  /** 姿态判定 U：抬脚 → onL/onR；间距滞回 0.9 进 / 0.78 退 → wide / two；0.06s 去抖 */
  private updateStance(ps: PS, b: Body, span: number, dt: number) {
    if (!Number.isFinite(ps.footBase[0])) {
      ps.footBase[0] = b.lFoot.y
      ps.footBase[1] = b.rFoot.y
    }
    const liftL = (ps.footBase[0] - b.lFoot.y) / span > LIFT_TH
    const liftR = (ps.footBase[1] - b.rFoot.y) / span > LIFT_TH
    if (!liftL) ps.footBase[0] += (b.lFoot.y - ps.footBase[0]) * Math.min(1, dt * 2.5)
    if (!liftR) ps.footBase[1] += (b.rFoot.y - ps.footBase[1]) * Math.min(1, dt * 2.5)
    const apart = b.feetSpread / span
    if (apart > WIDE_ENTER) ps.wide = true
    else if (apart < WIDE_EXIT) ps.wide = false
    const raw: Stance = liftL !== liftR ? (liftL ? 'onL' : 'onR') : ps.wide ? 'wide' : 'two'
    if (raw !== ps.cand) {
      ps.cand = raw
      ps.candT = this.t
    }
    if (this.t - ps.candT >= DEBOUNCE && ps.stance !== ps.cand) {
      ps.stance = ps.cand
      ps.since = this.t
    }
  }

  /** 髋部抬升跳检测：>0.1×躯干记起跳（since 提到 t+0.25），<0.04 复位，0.8s 超时强制复位 */
  private jumpChannel(ps: PS, b: Body, span: number, dt: number) {
    if (!Number.isFinite(ps.hipBase)) ps.hipBase = b.hipC.y
    if (!ps.air) {
      ps.hipBase += (b.hipC.y - ps.hipBase) * Math.min(1, dt * 1.5)
      const rise = (ps.hipBase - b.hipC.y) / span
      if (rise > JUMP_RISE) {
        ps.air = true
        ps.airAt = this.t
        ps.since = this.t + JUMP_GRACE // 跳跃宽限：跳一下即视作重新就位
      }
    } else {
      const rise = (ps.hipBase - b.hipC.y) / span
      if (rise < JUMP_RESET || this.t - ps.airAt > JUMP_TIMEOUT) ps.air = false
    }
  }

  /** 结算 Z：ok / bad / late，推进格子并按报告规则设置宽限 */
  private settle(pi: number, kind: 'ok' | 'bad' | 'late') {
    const ps = this.ps[pi]
    const row = ps.rows[ps.idx]
    const corner = row.n === ROWS
    const home = row.n === 1 && ps.dir === -1
    if (kind === 'ok') {
      ps.ok++
      this.ctx.addScore(1)
      const midi = NOTES[Math.min(NOTES.length - 1, row.n - 1)]
      this.ctx.audio.play('pop', 0.8, Math.pow(2, (midi - 60) / 12))
      ps.flash = 1
    } else if (kind === 'bad') {
      ps.bad++
      this.ctx.audio.fail() // oops
      this.tip(pi, '跳错啦')
      ps.xMark = 1
    } else {
      ps.late++
      this.ctx.audio.play('click', 0.6, 0.8) // boop
      this.tip(pi, '快一点')
    }

    if (kind === 'ok' && corner) {
      // 转角格（10）：往回跳
      ps.dir = -1
      ps.idx = ROWS - 2
      this.banner('到 10 啦！往回跳', 1.4)
      this.ctx.speak('到 10 啦，往回跳！')
      this.ctx.audio.good() // chime
    } else if (kind === 'ok' && home) {
      // 回家格（1）：一趟完成，换新房子
      ps.trips++
      this.banner(`跳完 ${ps.trips} 趟！换一座新房子`, 1.6)
      this.ctx.speak(`跳完 ${ps.trips} 趟！`)
      this.ctx.audio.win() // tada
      this.particles.confetti(this.W, 30)
      this.popAt = this.realClock
      this.popT = 1.5 + ps.trips * 0.3 // highlight(1.5+趟数×0.3)
      ps.rows = genHouse()
      ps.idx = 0
      ps.dir = 1
    } else {
      ps.idx += ps.dir
    }
    ps.rowT = this.t
    const nx = ps.rows[ps.idx].n
    // extra：每次结算清零；转角/回家格 1.2；判错/超时后 0.45 缓冲（报告 §1 D/O、§8 叠加关系）
    ps.extra = nx === ROWS || nx === 1 ? CORNER_EXTRA : kind === 'ok' ? 0 : BAD_EXTRA
    ps.slideFrom = ps.view
    ps.slideT = 0
    ps.since = this.t
  }

  private tip(pi: number, text: string) {
    const ps = this.ps[pi]
    ps.tip = text
    ps.tipUntil = this.t + 1.4
    void pi
  }

  private banner(text: string, sec: number) {
    this.bannerText = text
    this.bannerT = sec
  }

  /** 该玩家的分屏区：solo 0.08~0.92W，duo P0 0.03~0.47 / P1 0.53~0.97 */
  private zone(pi: number) {
    const duo = this.players.filter((p) => p.body).length > 1
    if (!duo) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  // ---------- 绘制 ----------

  paint(c: CanvasRenderingContext2D) {
    const duo = this.players.filter((p) => p.body).length > 1
    for (let pi = 0; pi < 2; pi++) {
      const pv = this.players[pi]
      const b = pv.body
      if (!b) continue
      const ps = this.ps[pi]
      const z = this.zone(pi)
      const torsoPx = Math.min(this.H * 0.4, Math.max(70, b.scale * this.H))
      const cx = (z.x0 + z.x1) / 2
      const baseY = this.H * 0.64
      const gapPx = ROW_GAP * torsoPx
      const colors = ['#ff8fab', '#7cc7ff', '#8be0a4', '#ffb26b', '#c3a6ff']

      // 透视彩色格子（滚动镜头 + 前方 AHEAD 格预渲染，透视收缩 PERSP）
      for (let i = 0; i < ps.rows.length; i++) {
        const o = ps.view - i // 0=当前，<0 未来（上方），>0 已过（下方）
        const ahead = i - ps.view
        if (ahead > AHEAD || o > 1.15) continue
        const row = ps.rows[i]
        const v = 1 / (1 + Math.max(0, ahead) * PERSP) // V(persp)
        const y = baseY + o * gapPx * v
        const wPx = (row.double ? 2 : 1) * ROW_W * torsoPx * v
        const hPx = ROW_W * 0.78 * torsoPx * v
        const alpha = o > 0 ? Math.max(0, 1 - o) : Math.max(0.35, 1 - ahead / (AHEAD + 2))
        c.save()
        c.globalAlpha = alpha
        c.fillStyle = colors[(row.n - 1) % colors.length]
        c.beginPath()
        c.roundRect(cx - wPx / 2, y - hPx / 2, wPx, hPx, 10 * v)
        c.fill()
        c.strokeStyle = 'rgba(255,255,255,.7)'
        c.lineWidth = 3 * v
        c.stroke()
        outlineTxt(c, String(row.n), cx, y, Math.max(16, 34 * v), '#ffffff')
        // 脚印提示（当前格）：单格 1 个 / 双格 2 个；hard 挑脚时染红/紫并标注
        if (i === ps.idx) {
          const fp = (fx: number, foot: 0 | 1 | -1) => {
            const need = this.cfg.pickFoot && foot >= 0
            const col = !need ? 'rgba(255,255,255,.85)' : foot === 0 ? '#ff4d6d' : '#9b5de5'
            emoji(c, '👣', fx, y + hPx * 0.18, 26 * v)
            if (need) {
              txt(c, foot === 0 ? '左脚' : '右脚', fx, y + hPx * 0.52, 15, col, 'center', 'bold')
            }
          }
          if (row.double) {
            fp(cx - wPx * 0.25, -1)
            fp(cx + wPx * 0.25, -1)
          } else {
            fp(cx, this.cfg.pickFoot ? row.foot : -1)
          }
          // 判错红叉
          if (ps.xMark > 0) {
            outlineTxt(c, '✗', cx + wPx / 2 - 16 * v, y - hPx / 2 + 14 * v, 30, '#ff5c5c')
          }
          // 判定行进度圆环（limit 倒计时，<30% 变红）
          const pct = Math.max(0, 1 - (this.t - ps.rowT) / (this.cfg.limit + ps.extra))
          ring(c, cx + wPx / 2 + 30 * v, y, 22 * v, pct, pct < 0.3 ? '#ff5c5c' : '#ffffff', 5)
          // 过格闪白
          if (ps.flash > 0) {
            c.globalAlpha = ps.flash * 0.55
            c.fillStyle = '#ffffff'
            c.beginPath()
            c.roundRect(cx - wPx / 2, y - hPx / 2, wPx, hPx, 10 * v)
            c.fill()
          }
        }
        c.restore()
      }

      // 地面线
      c.strokeStyle = 'rgba(255,255,255,.3)'
      c.lineWidth = 3
      c.beginPath()
      c.moveTo(z.x0 + 10, baseY + gapPx)
      c.lineTo(z.x1 - 10, baseY + gapPx)
      c.stroke()

      // 脚部高亮圈
      for (const ft of [b.lFoot, b.rFoot]) {
        c.beginPath()
        c.arc(ft.x * this.W, ft.y * this.H, 20, 0, Math.PI * 2)
        c.strokeStyle = pv.color
        c.lineWidth = 4
        c.stroke()
      }

      // 小地图：右上角整座房子布局 + 当前位置 + 方向箭头
      const mx = z.x1 - 158
      const my = 46
      txt(c, ps.dir === 1 ? '去 →' : '← 回', mx + 66, my - 18, 15, 'rgba(255,255,255,.85)', 'center', 'bold')
      for (let i = 0; i < ps.rows.length; i++) {
        const row = ps.rows[i]
        const w = row.double ? 22 : 11
        const x = mx + (i / ps.rows.length) * 132
        c.fillStyle = colors[(row.n - 1) % colors.length]
        c.globalAlpha = i === ps.idx ? 1 : 0.4
        c.beginPath()
        c.roundRect(x, my, w - 2, 14, 3)
        c.fill()
        c.globalAlpha = 1
        if (i === ps.idx) {
          c.strokeStyle = '#ffffff'
          c.lineWidth = 2
          c.strokeRect(x - 1.5, my - 1.5, w + 1, 17)
        }
      }

      if (ps.tip) {
        outlineTxt(c, ps.tip, b.shoulderC.x * this.W, (b.shoulderC.y - 0.14) * this.H, 36, '#ff8a8a')
      }
      // 双人头顶名牌
      if (duo) {
        outlineTxt(c, `玩家${pi + 1}`, b.head.x * this.W, (b.head.y - 0.16) * this.H, 24, pv.color)
      }
      // 当前格号大数字
      outlineTxt(c, String(ps.rows[ps.idx].n), duo ? cx : this.W * 0.14, this.H * 0.2, 64, pv.color)
    }

    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, this.H * 0.24, 46, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(
      c,
      this.cfg.pickFoot ? '单格要抬指定的脚，双格两脚分开；跳到 10 再跳回来' : '单格单脚落地，双格两脚分开；跳到 10 再跳回来',
      this.W / 2,
      this.H - 30,
      20,
      'rgba(255,255,255,.8)',
      'center',
      'bold',
    )
  }
}

export default function create(ctx: GameContext) {
  return new Hopscotch(ctx)
}
