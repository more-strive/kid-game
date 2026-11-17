import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, txt } from '@/core/draw'

/**
 * 反应灯阵（对齐 dongdongpark 真实规则）：
 * 身体两侧各 4 盏灯围成马蹄形（共 8 盏），绿灯亮起要立刻用手拍（最低一排可以用脚点），红灯绝对不能碰。
 *
 * 三条关键规则（站点原样保留）：
 * 1. 主灯永不重复：位号步长恒为 1~7，连续两轮一定换位置，防站桩。
 * 2. 亮灯瞬间「压在身上」的部位被记为占用，必须先离开 1.25r 再回来才算命中（防静止蹭分）。
 * 3. 碰红灯只 −1 并隐藏那盏灯，本轮继续——惩罚与节奏解耦，一次误触不毁整轮。
 *
 * 与站点的差异：站点用 4 行灯位 = 肩 y + 偏移 × 躯干长，`unit`/`torso` 的具体口径在黑盒模块里，
 * 本实现改成直接锚在骨骼标志点上（头顶上方 / 肩 / 髋下 / 踝上），保证 4 行真的从头顶铺到脚边，
 * 最高一排必须举手、最低一排脚能够到。灯心横向偏移仍沿用站点的 0.85/1.25/1.15/0.95 躯干长。
 */

type PodState = 'off' | 'green' | 'red'

/** 对齐站点难度表：on 绿灯最长存活（秒）/ gap 间隔区间（秒）/ red 出红灯概率 / double 出双绿灯概率 */
const DIFF = [
  { on: 2.6, gap: [0.65, 1.3], red: 0.15, double: 0 },
  { on: 2.0, gap: [0.55, 1.2], red: 0.3, double: 0.12 },
  { on: 1.5, gap: [0.4, 1.0], red: 0.4, double: 0.3 },
]

/** 4 个灯位的横向偏移（单位=躯干长），按 side 镜像成 8 盏 */
const POD_OFF = [0.85, 1.25, 1.15, 0.95]
/** 画虚线底座的连接顺序：左顶 → 左中 → 左低 → 左底 → 右底 → 右低 → 右中 → 右顶 */
const POD_ORDER = [3, 2, 1, 0, 4, 5, 6, 7]
const FAST_MS = 650 // 快反应阈值
const FIRST_LIGHT = 1 // 首灯延迟（秒）
const TOP_PAD = 96 // 灯心离画面顶部的最小距离（避开 HUD）

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}
function lerp(a: number, b: number, k: number) {
  return a + (b - a) * k
}
const rowOf = (i: number) => i % 4
const sideOf = (i: number) => (i < 4 ? -1 : 1)

interface Pod {
  x: number
  y: number
  r: number
  state: PodState
  litAt: number
  life: number
  hit: boolean
  /** 亮灯瞬间已经压在这盏灯上的部位（key=hand/foot 名），必须先离开才能命中 */
  blocked: Set<string>
  flash: number
  /** 超时灰圈剩余时间 */
  decay: number
}

interface Plan {
  main: number
  extra: number
  red: number
  gap: number
}

interface PState {
  pods: Pod[]
  zone: { x0: number; x1: number }
  anchor: { x: number; headTop: number; shoulderY: number; hipY: number; ankleY: number; T: number }
  wait: number
  live: boolean
  /** 共享计划队列里的游标 */
  planAt: number
  prev: number
  hits: number
  judged: number
  reds: number
  times: number[]
  best: number
  /** 本轮已命中/已超时的绿灯数（用于判断本轮是否结束） */
  done: number
  litCount: number
  /** 本轮亮灯时刻与寿命（秒） */
  litAt: number
  life: number
}

class ReactionLights extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  ps: PState[] = []
  plans: Plan[] = []
  coachSaid = false
  /** 站点由宿主维护的 heat（0→1 难度爬坡）；本框架没有，用局内进度代理 */
  heat = 0

  constructor(ctx: GameContext) {
    super(ctx)
    const versus = ctx.meta.mode === 'versus'
    for (let i = 0; i < 2; i++) {
      const zone = versus
        ? { x0: i === 0 ? 0 : this.W / 2, x1: i === 0 ? this.W / 2 : this.W }
        : { x0: 0, x1: this.W }
      this.ps.push({
        pods: POD_ORDER.map(() => ({ x: 0, y: 0, r: 40, state: 'off' as PodState, litAt: 0, life: 0, hit: false, blocked: new Set<string>(), flash: 0, decay: 0 })),
        zone,
        anchor: {
          x: (zone.x0 + zone.x1) / 2,
          headTop: this.H * 0.2,
          shoulderY: this.H * 0.38,
          hipY: this.H * 0.56,
          ankleY: this.H * 0.9,
          T: this.H * 0.24,
        },
        wait: FIRST_LIGHT,
        live: false,
        planAt: 0,
        prev: -1,
        hits: 0,
        judged: 0,
        reds: 0,
        times: [],
        best: 0,
        done: 0,
        litCount: 0,
        litAt: 0,
        life: 0,
      })
    }
  }

  // ---------------------------------------------------------------- 计划

  /** 生成一条出灯计划（主灯必不与上一轮相同；双绿灯必在身体另一侧；红灯不与绿灯重合） */
  private makePlan(prev: number): Plan {
    const d = this.cfg
    const main = prev < 0 ? Math.floor(Math.random() * 8) : (prev + 1 + Math.floor(Math.random() * 7)) % 8
    let extra = -1
    if (Math.random() < d.double) {
      const other = (sideOf(main) > 0 ? 0 : 1) * 4
      extra = other + clamp(rowOf(main) + Math.floor(Math.random() * 3) - 1, 0, 3)
    }
    let red = -1
    if (Math.random() < d.red) {
      const pool: number[] = []
      for (let i = 0; i < 8; i++) if (i !== main && i !== extra) pool.push(i)
      red = pool[Math.floor(Math.random() * pool.length)]
    }
    return { main, extra, red, gap: lerp(d.gap[0], d.gap[1], Math.random()) }
  }

  private planFor(st: PState): Plan {
    // 队列按「上一条计划的主灯」续推，保证共享队列里相邻两轮的主灯也不重复
    while (this.plans.length <= st.planAt) {
      const prev = this.plans.length ? this.plans[this.plans.length - 1].main : -1
      this.plans.push(this.makePlan(prev))
    }
    const p = this.plans[st.planAt]
    st.planAt++
    return p
  }

  // ---------------------------------------------------------------- 主循环

  tick(f: PoseFrame, dt: number) {
    this.heat = clamp(this.t / Math.max(1, this.ctx.meta.duration), 0, 1)

    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      const b = f.bodies[i] ?? null
      this.layout(st, b, dt)
      for (const pod of st.pods) {
        pod.flash = Math.max(0, pod.flash - dt)
        pod.decay = Math.max(0, pod.decay - dt)
      }
      if (!b) continue

      if (!st.live) {
        st.wait -= dt
        if (st.wait <= 0) this.light(st, b)
        continue
      }

      this.checkHits(st, b)

      // 绿灯寿命到期：剩余未命中的记一次「慢了」
      if (st.live && this.t - st.litAt >= st.life) this.expire(st)
    }

    this.report()
  }

  /** 锚点平滑（对齐站点：x 1.2/s；肩线上移立即 2/s、下落 0.5/s 且蹲下时冻结；躯干长 0.8/s） */
  private layout(st: PState, b: Body | null, dt: number) {
    const a = st.anchor
    if (!b) return
    const curX = b.center.x * this.W
    const curHead = b.head.y * this.H
    const curSh = b.shoulderC.y * this.H
    const curHip = b.hipC.y * this.H
    const curAnk = Math.max(b.lFoot.y, b.rFoot.y) * this.H
    const curT = Math.max(60, (curHip - curSh) * 1.05)

    a.x += (curX - a.x) * Math.min(1, 1.2 * dt)
    a.headTop += (curHead - a.headTop) * Math.min(1, 1.5 * dt)
    a.hipY += (curHip - a.hipY) * Math.min(1, 1.2 * dt)
    a.ankleY += (curAnk - a.ankleY) * Math.min(1, 1.2 * dt)
    // 肩线：上抬立即跟，下落只在站直时慢跟（蹲下时灯阵不跟着塌）
    const rate = curSh < a.shoulderY ? 2 : b.squat ? 0 : 0.5
    a.shoulderY += (curSh - a.shoulderY) * Math.min(1, rate * dt)
    a.T += (curT - a.T) * Math.min(1, 0.8 * dt)

    // 4 行：头顶上方 / 肩 / 髋下 / 踝上
    const rows = [a.headTop - 0.18 * a.T, a.shoulderY, a.hipY + 0.28 * a.T, a.ankleY - 0.12 * a.T]
    const r = Math.round(clamp(0.54 * a.T, 34, 64) / 2) * 2
    for (let i = 0; i < 8; i++) {
      const pod = st.pods[i]
      const row = rowOf(i)
      pod.r = r
      pod.x = clamp(a.x + sideOf(i) * POD_OFF[row] * a.T, st.zone.x0 + 1.1 * r, st.zone.x1 - 1.1 * r)
      pod.y = clamp(rows[row], TOP_PAD + r, this.H - 1.05 * r)
    }
  }

  /** 亮灯：写入状态、记录占用、按站点公式算寿命 */
  private light(st: PState, b: Body | null) {
    const plan = this.planFor(st)
    st.prev = plan.main
    const life = this.cfg.on * (1 - 0.2 * this.heat)
    st.litAt = this.t
    st.life = life
    for (const pod of st.pods) {
      pod.state = 'off'
      pod.hit = false
      pod.blocked.clear()
      pod.decay = 0
    }
    for (const idx of [plan.main, plan.extra, plan.red]) {
      if (idx < 0) continue
      const pod = st.pods[idx]
      pod.state = idx === plan.red ? 'red' : 'green'
      pod.litAt = this.t
      pod.life = life
      // 亮灯瞬间压在灯上的部位 → 占用
      if (b) for (const [key, p, pr] of this.parts(b, st.anchor.T)) {
        if (Math.hypot(p.x, p.y) < pod.r * 1.1 + pr * 0.6) pod.blocked.add(key)
      }
    }
    st.live = true
    st.done = 0
    st.litCount = plan.extra >= 0 ? 2 : 1
    this.ctx.audio.tick()
    if (plan.red >= 0 && !this.coachSaid) {
      this.coachSaid = true
      this.ctx.speak('红灯别碰！')
    }
  }

  /** 手/脚部位（屏幕像素坐标 + 半径），脚只在最低一排参与判定 */
  private parts(b: Body, T: number): [string, { x: number; y: number }, number][] {
    const handR = T * 0.1
    const footR = T * 0.12
    return [
      ['lHand', { x: b.lHand.x * this.W, y: b.lHand.y * this.H }, handR],
      ['rHand', { x: b.rHand.x * this.W, y: b.rHand.y * this.H }, handR],
      ['lFoot', { x: b.lFoot.x * this.W, y: b.lFoot.y * this.H }, footR],
      ['rFoot', { x: b.rFoot.x * this.W, y: b.rFoot.y * this.H }, footR],
    ]
  }

  private checkHits(st: PState, b: Body) {
    const T = st.anchor.T
    const parts = this.parts(b, T)
    for (let i = 0; i < 8; i++) {
      const pod = st.pods[i]
      if (pod.state === 'off' || pod.hit) continue
      const green = pod.state === 'green'
      for (const [key, p, pr] of parts) {
        // 脚只在最低一排（行 3）参与判定
        if (key.endsWith('Foot') && rowOf(i) !== 3) continue
        const d = Math.hypot(p.x - pod.x, p.y - pod.y)
        // 占用半径 1.25r（离开判定）比命中半径宽，中间形成「不命中也不判红」的窄带
        if (d > pod.r * 1.25 + pr * 0.6) pod.blocked.delete(key)
        if (pod.blocked.has(key)) continue
        // 绿：r + 手r×0.6（宽松）；红：0.8r + 手r×0.3（收紧）
        const reach = green ? pod.r + pr * 0.6 : pod.r * 0.8 + pr * 0.3
        if (d >= reach) continue
        if (green) this.greenHit(st, pod, key.endsWith('Foot'))
        else this.redHit(st, pod)
        break
      }
    }

    if (st.live && st.done >= st.litCount) this.endRound(st)
  }

  private greenHit(st: PState, pod: Pod, byFoot: boolean) {
    const ms = Math.round((this.t - pod.litAt) * 1000)
    pod.hit = true
    pod.flash = 0.25
    st.hits++
    st.judged++
    st.done++
    st.times.push(ms)
    this.ctx.addScore(1)
    const cx = pod.x
    const cy = pod.y - pod.r - 18
    this.particles.burst(cx, cy, ms < FAST_MS ? '#ffe066' : '#ffffff', ms < FAST_MS ? 12 : 8, 300, 5)
    if (ms < FAST_MS) this.ctx.audio.coin()
    else this.ctx.audio.pop()
    if (byFoot) this.ctx.audio.play('hit', 0.6)
    if (st.hits >= 5 && (st.best === 0 || ms < st.best)) {
      st.best = ms
      this.say('最快！', cx, cy - 34, '#ffa94d', 34)
    } else if (st.best === 0 || ms < st.best) {
      st.best = ms
    }
  }

  private redHit(st: PState, pod: Pod) {
    pod.hit = true
    pod.state = 'off'
    pod.decay = 0.5
    st.reds++
    this.ctx.addScore(-1)
    this.ctx.audio.fail()
    this.ctx.audio.play('miss', 0.8)
    this.say('红灯！', pod.x, pod.y - pod.r - 20, '#ff4d6d', 40)
    this.particles.burst(pod.x, pod.y, '#ff4d6d', 10, 240, 5)
  }

  /** 绿灯寿命到期：未命中的都记「慢了」（不扣分，只拉低准确率） */
  private expire(st: PState) {
    let any = false
    for (const pod of st.pods) {
      if (pod.state !== 'green' || pod.hit) continue
      pod.hit = true
      pod.decay = 0.5
      st.judged++
      st.done++
      any = true
      this.say('慢了', pod.x, pod.y - pod.r - 16, '#9b8fb0', 26)
    }
    if (any) this.ctx.audio.play('miss', 0.6)
    this.endRound(st)
  }

  private endRound(st: PState) {
    st.live = false
    st.wait = this.plans[st.planAt - 1].gap * (1 - 0.25 * this.heat)
    for (const pod of st.pods) pod.state = 'off'
  }

  private report() {
    const st = this.ps[0]
    if (st.times.length) {
      const avg = Math.round(st.times.reduce((a, b) => a + b, 0) / st.times.length)
      this.ctx.setExtra('平均反应', avg)
      this.ctx.setExtra('最快反应', Math.min(...st.times))
    }
    const den = st.judged + st.reds
    this.ctx.setExtra('准确率', den ? Math.round((st.hits / den) * 100) : 100)
    if (st.reds > 0) this.ctx.setExtra('碰红灯', st.reds)
  }

  // ---------------------------------------------------------------- 绘制

  paint(c: CanvasRenderingContext2D) {
    for (let i = 0; i < 2; i++) {
      const st = this.ps[i]
      if (i === 1 && this.ctx.meta.mode !== 'versus') continue
      this.drawPods(c, st, i)
    }
    const active = this.ps.filter((_, i) => this.player(i).body)
    if (active.length === 0) {
      outlineTxt(c, '站到画面中间，灯阵会围着你', this.W / 2, this.H * 0.12, 34, 'rgba(255,255,255,.9)')
    }
  }

  private drawPods(c: CanvasRenderingContext2D, st: PState, idx: number) {
    const pods = st.pods
    // 虚线底座：马蹄形
    c.save()
    c.setLineDash([10, 8])
    c.lineWidth = 3
    c.strokeStyle = 'rgba(255,255,255,.28)'
    c.beginPath()
    POD_ORDER.forEach((k, n) => {
      const p = pods[k]
      n === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)
    })
    c.stroke()
    c.restore()

    for (let i = 0; i < 8; i++) {
      const p = pods[i]
      const lit = p.state !== 'off' && !p.hit
      const color = p.state === 'red' ? '#ff4d6d' : '#3ddc97'
      if (lit) glow(c, p.x, p.y, p.r * 2.2, color, 0.28 + Math.sin(this.t * 14) * 0.06)
      circle(c, p.x, p.y, p.r, lit ? color : 'rgba(18,26,48,.42)')
      // 外圈：双人时用玩家色描边
      c.beginPath()
      c.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      c.lineWidth = lit ? 4 : 2
      c.strokeStyle = lit ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.22)'
      c.stroke()
      if (this.ctx.meta.mode === 'versus') {
        c.beginPath()
        c.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2)
        c.lineWidth = 3
        c.strokeStyle = this.player(idx).color
        c.stroke()
      }
      // 剩余寿命环
      if (lit && p.state === 'green') {
        const left = clamp(1 - (this.t - p.litAt) / p.life, 0, 1)
        ring(c, p.x, p.y, p.r * 0.86, left, left < 0.3 ? '#ff922b' : '#ffffff', 6)
      }
      // 命中闪白
      if (p.flash > 0) {
        c.globalAlpha = p.flash / 0.25
        circle(c, p.x, p.y, p.r * 0.95, '#ffffff')
        c.globalAlpha = 1
      }
      // 超时灰圈
      if (p.decay > 0) {
        c.globalAlpha = p.decay / 0.5
        circle(c, p.x, p.y, p.r * 0.5, '#9b8fb0')
        c.globalAlpha = 1
      }
      // 行提示：最高一排画上举箭头、最低一排画脚印
      if (p.state === 'green' && !p.hit) {
        const bob = Math.sin(this.t * 6 + i) * 6
        if (rowOf(i) === 0) txt(c, '↑', p.x, p.y - p.r - 18 + bob, 34, '#ffe066')
        if (rowOf(i) === 3) txt(c, '👣', p.x, p.y + p.r + 20 + bob, 26, '#8ad7ff')
      }
    }
  }
}

export function createReactionLights(ctx: GameContext): Game {
  return new ReactionLights(ctx)
}


export default createReactionLights
