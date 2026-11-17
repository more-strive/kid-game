import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { bg, circle, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 滑雪 / slalom-ski（对齐 dongdongpark 真实规则）：
 * 身体左右歪 → 横向滑行；从两面小旗之间穿过得分，撞树会眩晕减速；举起双手朝前方雪人扔雪球。
 *
 * 玩法参数全部沿用站点字面量：
 * - 前进速度 v0 → v1 在 duration 内线性爬升；横向是「目标速度」而非位移（vx 以 5/s 指数跟随 lean × lat）
 * - 穿门容差 = gateW/2 + 0.2；连击单价 10/12/14/16/18/20 封顶
 * - 撞树：dizzy 1.1s（控制力 0.4×）、invuln 1.6s、slow 直接砸到 0.3 后按 1.5/s 恢复
 * - 雪球自动瞄准前方 2~18 单位内最近的雪人，命中 +15，同一雪人只能被打中一次
 *
 * 与站点的差异：
 * 1) 站点读 motion.lean / motion.armLift；本框架改为「肩髋横向偏移」和「手相对肩的高度」换算，
 *    因此举手阈值不是站点的 0.9，而是本量纲下的 0.42（约等于双手举过头顶）。
 * 2) 站点有 4 张滑雪贴图（松树/障碍树/雪人/滑雪者），这里全部用几何图形绘制。
 */

interface Gate {
  id: number
  s: number
  cx: number
  w: number
  color: string
}

interface Tree {
  s: number
  x: number
  kind: number
}

interface Man {
  id: number
  s: number
  x: number
  hit: boolean
}

interface Ball {
  x0: number
  s0: number
  x1: number
  s1: number
  t: number
  dur: number
  target: number
}

interface Zone {
  cx: number
  w: number
  ppm: number
  skierY: number
}

interface Skier {
  x: number
  vx: number
  d: number
  prevD: number
  dizzy: number
  invuln: number
  slow: number
  combo: number
  maxCombo: number
  passed: number
  missed: number
  crashed: number
  hits: number
  armed: boolean
  cool: number
  seen: Set<number>
  trail: { x: number; s: number }[]
  balls: Ball[]
  zone: Zone
  color: string
}

/** 站点三档：下坡初速 / 末速 / 满幅横速 / 门宽 / 门间距 / 树基数 */
const DIFF = [
  { v0: 4.5, v1: 7.5, lat: 4.5, gateW: 3.4, gap: [20, 26] as [number, number], trees: 1 },
  { v0: 5.5, v1: 9, lat: 5, gateW: 2.8, gap: [18, 23] as [number, number], trees: 1.5 },
  { v0: 6.5, v1: 10.5, lat: 5.5, gateW: 2.3, gap: [15, 20] as [number, number], trees: 2 },
]

const LANE = 4.7 // 横向硬边界
const GATE_TOL = 0.2 // 穿门额外容差
const TREE_HALF = 0.55 // 撞树横向半宽
const TREE_DZ = 0.3 // 撞树纵向宽限
const FOLLOW = 5 // vx 跟随速率（1/s，时间常数 0.2s）
const ARM_UP = 0.42 // 举手触发投掷（本量纲）
const ARM_DOWN = 0.2 // 落回此值才解锁下一次
const BALL_COOL = 0.8 // 投掷冷却
const HIT_POINTS = 15
const PPM_FACTOR = 0.075 // 每世界单位的像素/秒（站点 ppm = min(zoneW,H) × 0.075）

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function leanOf(b: Body | null) {
  if (!b) return 0
  const t = Math.max(0.08, b.scale)
  return clamp(((b.shoulderC.x - b.hipC.x) / t) * 2.2, -1, 1)
}

function armLiftOf(b: Body | null) {
  if (!b) return 0
  const t = Math.max(0.08, b.scale)
  const handY = (b.lHand.y + b.rHand.y) / 2
  return clamp(((b.shoulderC.y - handY) / t) * 1.3, -1, 1)
}

class SlalomSki extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  dur = this.ctx.meta.duration || 60
  gates: Gate[] = []
  trees: Tree[] = []
  men: Man[] = []
  skiers: Skier[] = []
  /** 一旦出现过双人就保持分屏，避免画面在有人走动时反复抖动 */
  seats = 1

  private genS = 0
  private lastCx = 0
  private gateCount = 0

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.skiers.push({
        x: 0,
        vx: 0,
        d: 0,
        prevD: 0,
        dizzy: 0,
        invuln: 0,
        slow: 1,
        combo: 0,
        maxCombo: 0,
        passed: 0,
        missed: 0,
        crashed: 0,
        hits: 0,
        armed: true,
        cool: 0,
        seen: new Set<number>(),
        trail: [],
        balls: [],
        zone: { cx: this.W / 2, w: this.W, ppm: Math.min(this.W, this.H) * PPM_FACTOR, skierY: this.H * 0.72 },
        color: this.players[i].color,
      })
    }
    this.layout()
    this.genWorld(140)
  }

  private layout() {
    const w = this.W / this.seats
    for (let i = 0; i < 2; i++) {
      const z = this.skiers[i].zone
      z.w = w
      z.cx = w * i + w / 2
      z.ppm = Math.min(w, this.H) * PPM_FACTOR
      z.skierY = this.H * 0.72
    }
  }

  /** 按需向前生成雪道：门 → 门后的树 → 每第 3 道门反侧的雪人 */
  private genWorld(target: number) {
    while (this.genS < target) {
      const r = this.cfg
      const gap = r.gap[0] + Math.random() * (r.gap[1] - r.gap[0])
      const prevS = this.genS
      const prevCx = this.lastCx
      this.genS += gap
      const cx = clamp(prevCx + (Math.random() - 0.5) * 6, -3.2, 3.2)
      this.lastCx = cx
      this.gates.push({
        id: this.gateCount,
        s: this.genS,
        cx,
        w: r.gateW,
        color: this.gateCount % 2 ? '#4cc9f0' : '#ff6b8a',
      })

      const n = Math.floor(r.trees + Math.random() * 0.99)
      for (let i = 0; i < n; i++) {
        const at = this.genS + gap * (0.3 + Math.random() * 0.45)
        let tx = (Math.random() - 0.5) * 8.8
        // 别挡在旗门正前方
        let tries = 0
        while (Math.abs(tx - cx) < 1.8 && tries++ < 6) tx = (Math.random() - 0.5) * 8.8
        // 也别挡在「上一门 → 本门」的完美走线上
        const lineX = prevCx + (cx - prevCx) * clamp((at - prevS) / Math.max(0.01, gap), 0, 1)
        if (Math.abs(tx - lineX) < 1.6) tx = lineX + Math.sign(tx - lineX || 1) * 1.6
        if (Math.abs(tx - cx) < 1.6) tx = cx + Math.sign(tx - cx || 1) * 1.6
        this.trees.push({
          s: at,
          x: clamp(tx, -4.6, 4.6),
          kind: (Math.random() * 3) | 0,
        })
      }

      if (this.gateCount % 3 === 2) {
        this.men.push({ id: this.men.length, s: this.genS, x: cx > 0 ? -4.3 : 4.3, hit: false })
      }
      this.gateCount++
    }
  }

  tick(f: PoseFrame, dt: number) {
    if (f.bodies[1] && this.seats !== 2) {
      this.seats = 2
      this.layout()
    }

    for (let i = 0; i < this.seats; i++) {
      const b = f.bodies[i] ?? null
      this.stepSkier(i, b, dt)
    }

    const far = Math.max(this.skiers[0].d, this.skiers[1].d)
    this.genWorld(far + 140)
  }

  private stepSkier(i: number, b: Body | null, dt: number) {
    const s = this.skiers[i]
    const r = this.cfg
    if (s.dizzy > 0) s.dizzy -= dt
    if (s.invuln > 0) s.invuln -= dt
    if (s.cool > 0) s.cool -= dt

    // 前进：撞树后 slow 恢复（眩晕期几乎不恢复）
    const back = s.dizzy > 0 ? 0.3 : 1.5
    s.slow += (1 - s.slow) * Math.min(1, back * dt)
    const speed = (r.v0 + (r.v1 - r.v0) * Math.min(1, this.t / this.dur)) * s.slow
    s.prevD = s.d
    s.d += speed * dt

    // 横向：lean → 目标速度 → 平滑跟随
    const lean = leanOf(b)
    const target = lean * r.lat * (s.dizzy > 0 ? 0.4 : 1)
    s.vx += (target - s.vx) * (1 - Math.exp(-dt * FOLLOW))
    s.x += s.vx * dt
    if (Math.abs(s.x) > LANE) {
      s.x = Math.sign(s.x) * LANE
      s.vx *= -0.2
    }

    const last = s.trail[s.trail.length - 1]
    if (!last || Math.abs(s.d - last.s) > 0.4) {
      s.trail.push({ x: s.x, s: s.d })
      if (s.trail.length > 30) s.trail.shift()
    }

    if (b) {
      this.judgeGates(s)
      if (s.invuln <= 0) this.judgeTrees(s)
      this.throwBall(s, b)
    }

    // 雪球飞行
    for (let k = s.balls.length - 1; k >= 0; k--) {
      const bl = s.balls[k]
      bl.t += dt
      if (bl.t < bl.dur) continue
      s.balls.splice(k, 1)
      const man = bl.target >= 0 ? this.men.find((m) => m.id === bl.target) : undefined
      if (man && !man.hit) {
        man.hit = true
        s.hits++
        this.ctx.addScore(HIT_POINTS)
        this.ctx.audio.play('pop', 0.9, 1.25)
        this.ctx.setExtra('snowmen', s.hits)
        const p = this.proj(s, man.x, man.s)
        this.particles.burst(p.x, p.y - 30 * p.k, '#ffffff', 22, 260, 5)
        this.say('打中啦 +15', p.x, p.y - 60 * p.k, '#4cc9f0', 32)
      } else {
        const p = this.proj(s, bl.x1, bl.s1)
        this.particles.burst(p.x, p.y, '#ffffff', 8, 160, 3)
      }
    }
  }

  /** 跨过门的那一帧结算：容差 gateW/2 + 0.2，连击单价 10 起每多 1 连 +2 封顶 20 */
  private judgeGates(s: Skier) {
    for (const g of this.gates) {
      if (g.s <= s.prevD || g.s > s.d) continue
      if (s.seen.has(g.id)) continue
      s.seen.add(g.id)
      if (Math.abs(s.x - g.cx) < g.w / 2 + GATE_TOL) {
        s.combo++
        s.maxCombo = Math.max(s.maxCombo, s.combo)
        s.passed++
        const pts = 10 + Math.min(s.combo - 1, 5) * 2
        this.ctx.addScore(pts)
        this.ctx.setCombo(s.combo)
        this.ctx.audio.play('score', 0.5 + Math.min(0.5, s.combo * 0.08), 1)
        const p = this.proj(s, g.cx, g.s)
        this.particles.burst(p.x, p.y - 20, '#ffd54a', 10, 240, 5)
        this.say(`+${pts}`, p.x, p.y - 40, '#ffd54a', 34)
        if (s.combo % 5 === 0) {
          this.ctx.speak(`连过${s.combo}个门`)
          this.say(`连过 ${s.combo} 个门！`, s.zone.cx, this.H * 0.22, '#ff9f1c', 44)
        }
        this.ctx.setExtra('gates', s.passed)
      } else {
        s.combo = 0
        s.missed++
        this.ctx.setCombo(0)
        this.ctx.audio.play('click', 0.4, 0.8)
        const p = this.proj(s, g.cx, g.s)
        this.say('差一点！', p.x, p.y - 40, '#9aa4b2', 28)
      }
    }
  }

  private judgeTrees(s: Skier) {
    for (const tr of this.trees) {
      if (tr.s <= s.prevD - TREE_DZ || tr.s > s.d + TREE_DZ) continue
      if (Math.abs(s.x - tr.x) >= TREE_HALF) continue
      s.crashed++
      s.dizzy = 1.1
      s.invuln = 1.6
      s.slow = 0.3
      s.combo = 0
      s.vx = -Math.sign(tr.x - s.x || 1) * 2
      this.ctx.setCombo(0)
      this.ctx.audio.play('hit', 0.7, 0.9)
      this.ctx.setExtra('crashed', s.crashed)
      const p = this.proj(s, tr.x, tr.s)
      this.particles.burst(p.x, p.y - 26, '#ffffff', 18, 300, 4)
      this.say('哎呀！', s.zone.cx, this.H * 0.42, '#b06bff', 34)
      return
    }
  }

  /** 举手投掷：必须落回 ARM_DOWN 以下才解锁（防一直举手连发），另有 0.8s 冷却 */
  private throwBall(s: Skier, b: Body) {
    const lift = armLiftOf(b)
    if (lift < ARM_DOWN) s.armed = true
    if (lift < ARM_UP || !s.armed || s.cool > 0) return
    s.armed = false
    s.cool = BALL_COOL

    let target: Man | null = null
    let best = 99
    for (const m of this.men) {
      if (m.hit) continue
      const dz = m.s - s.d
      if (dz <= 2 || dz > 18) continue
      if (s.balls.some((bl) => bl.target === m.id)) continue
      if (dz < best) {
        best = dz
        target = m
      }
    }
    const dist = target ? best : 10
    s.balls.push({
      x0: s.x,
      s0: s.d,
      x1: target ? target.x : s.x,
      s1: target ? target.s : s.d + dist,
      t: 0,
      dur: 0.45 + dist * 0.012,
      target: target ? target.id : -1,
    })
    this.ctx.audio.play('pop', 0.4, 2)
  }

  /** 世界坐标 → 屏幕像素（透视：scale = 1/(1+dz/14)） */
  private proj(s: Skier, worldX: number, worldS: number) {
    // dz = -14 会让分母归零，这里先夹住：小于 -13（已滑过很远）与超出视野的都按边界处理
    const dz = clamp(worldS - s.d, -13, 240)
    const k = 1 / (1 + dz / 14)
    return {
      k,
      x: s.zone.cx + worldX * s.zone.ppm * k,
      y: s.zone.skierY - dz * s.zone.ppm * k,
    }
  }

  paint(c: CanvasRenderingContext2D) {
    for (let i = 0; i < this.seats; i++) {
      const s = this.skiers[i]
      c.save()
      c.beginPath()
      c.rect(s.zone.cx - s.zone.w / 2, 0, s.zone.w, this.H)
      c.clip()
      this.paintLane(c, i)
      c.restore()
    }
    if (this.seats > 1) {
      c.fillStyle = 'rgba(255,255,255,.55)'
      c.fillRect(this.W / 2 - 3, 0, 6, this.H)
    }
  }

  private paintLane(c: CanvasRenderingContext2D, i: number) {
    const s = this.skiers[i]
    const z = s.zone
    bg(c, '#cfe8ff', '#ffffff')

    // 远处松林剪影
    c.fillStyle = 'rgba(120,160,190,.35)'
    for (let k = 0; k < 14; k++) {
      const x = z.cx - z.w / 2 + ((k + 0.5) * z.w) / 14
      const h = 46 + ((k * 37) % 40)
      c.beginPath()
      c.moveTo(x, 96 - h)
      c.lineTo(x - 22, 108)
      c.lineTo(x + 22, 108)
      c.closePath()
      c.fill()
    }

    // 雪道：横向速度条纹（按世界 s 每 4 单位一条）
    const from = Math.floor(s.d / 4) * 4
    for (let ws = from; ws < s.d + 40; ws += 4) {
      const p = this.proj(s, 0, ws)
      if (p.y < 100 || p.y > this.H) continue
      const half = 4.7 * z.ppm * p.k
      c.strokeStyle = 'rgba(170,205,232,.55)'
      c.lineWidth = 1 + 2 * p.k
      c.beginPath()
      c.moveTo(z.cx - half, p.y)
      c.lineTo(z.cx + half, p.y)
      c.stroke()
    }

    // 雪道两边
    for (const side of [-1, 1]) {
      const a = this.proj(s, side * 5, s.d)
      const b2 = this.proj(s, side * 5, s.d + 30)
      c.strokeStyle = 'rgba(150,195,225,.7)'
      c.lineWidth = 2
      c.beginPath()
      c.moveTo(a.x, a.y)
      c.lineTo(b2.x, b2.y)
      c.stroke()
    }

    // 所有实体按深度从远到近
    type Item = { dz: number; draw: () => void }
    const items: Item[] = []

    for (const g of this.gates) {
      const dz = g.s - s.d
      if (dz < -4 || dz > 34) continue
      items.push({
        dz,
        draw: () => {
          const p = this.proj(s, g.cx, g.s)
          const half = (g.w / 2) * z.ppm * p.k
          const h = 1.5 * z.ppm * p.k
          const done = s.seen.has(g.id)
          const col = done ? '#6bcb77' : g.color
          c.strokeStyle = col
          c.lineWidth = Math.max(2, 4 * p.k)
          c.globalAlpha = 0.9
          for (const side of [-1, 1]) {
            const x = p.x + side * half
            c.beginPath()
            c.moveTo(x, p.y)
            c.lineTo(x, p.y - h)
            c.stroke()
            // 旗面
            c.fillStyle = col
            c.beginPath()
            c.moveTo(x, p.y - h)
            c.lineTo(x + side * h * 0.42, p.y - h + h * 0.22)
            c.lineTo(x, p.y - h + h * 0.44)
            c.closePath()
            c.fill()
          }
          // 门中间的虚线
          c.setLineDash([6 * p.k, 8 * p.k])
          c.globalAlpha = 0.5
          c.beginPath()
          c.moveTo(p.x - half, p.y)
          c.lineTo(p.x + half, p.y)
          c.stroke()
          c.setLineDash([])
          c.globalAlpha = 1
        },
      })
    }

    for (const tr of this.trees) {
      const dz = tr.s - s.d
      if (dz < -3 || dz > 34) continue
      items.push({
        dz,
        draw: () => {
          const p = this.proj(s, tr.x, tr.s)
          const h = 1.9 * z.ppm * p.k
          const w = 0.62 * z.ppm * p.k
          c.fillStyle = '#8d6242'
          c.fillRect(p.x - w * 0.16, p.y - h * 0.34, w * 0.32, h * 0.34)
          const greens = ['#2f7d4f', '#3d9463', '#276b43']
          c.fillStyle = greens[tr.kind]
          for (let tier = 0; tier < 3; tier++) {
            const ty = p.y - h * (0.3 + tier * 0.24)
            const tw = w * (1 - tier * 0.22)
            c.beginPath()
            c.moveTo(p.x, ty - h * 0.42)
            c.lineTo(p.x - tw, ty)
            c.lineTo(p.x + tw, ty)
            c.closePath()
            c.fill()
          }
        },
      })
    }

    for (const m of this.men) {
      const dz = m.s - s.d
      if (dz < -3 || dz > 34) continue
      items.push({
        dz,
        draw: () => {
          const p = this.proj(s, m.x, m.s)
          const u = z.ppm * p.k
          c.globalAlpha = m.hit ? 0.55 : 1
          circle(c, p.x, p.y - u * 0.42, u * 0.28, '#ffffff')
          circle(c, p.x, p.y - u * 0.95, u * 0.2, '#ffffff')
          circle(c, p.x - u * 0.06, p.y - u * 1.0, u * 0.035, '#2b2b2b')
          circle(c, p.x + u * 0.06, p.y - u * 1.0, u * 0.035, '#2b2b2b')
          c.fillStyle = '#ff9f1c'
          c.beginPath()
          c.moveTo(p.x, p.y - u * 0.93)
          c.lineTo(p.x + u * 0.2, p.y - u * 0.9)
          c.lineTo(p.x, p.y - u * 0.86)
          c.closePath()
          c.fill()
          c.globalAlpha = 1
        },
      })
    }

    // 雪球（世界坐标插值 + 抛物线）
    for (const bl of s.balls) {
      const e = Math.min(1, bl.t / bl.dur)
      const ws = bl.s0 + (bl.s1 - bl.s0) * e
      const wx = bl.x0 + (bl.x1 - bl.x0) * e
      const dz = ws - s.d
      if (dz < -3 || dz > 34) continue
      items.push({
        dz,
        draw: () => {
          const p = this.proj(s, wx, ws)
          const u = z.ppm * p.k
          circle(c, p.x, p.y - u * 0.5 - Math.sin(Math.PI * e) * u * 1.4, u * 0.11, '#ffffff')
        },
      })
    }

    // 玩家（始终在 skierY）
    items.push({
      dz: 0,
      draw: () => {
        const u = z.ppm
        const blink = s.invuln > 0 && Math.floor(this.t * 10) % 2 === 0
        if (blink) return
        // 走线拖痕
        if (s.trail.length > 1) {
          c.strokeStyle = 'rgba(255,255,255,.8)'
          c.lineWidth = 3
          c.beginPath()
          s.trail.forEach((tp, idx) => {
            const p = this.proj(s, tp.x, tp.s)
            idx ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)
          })
          c.stroke()
        }
        const px = z.cx + s.x * u
        const py = z.skierY
        c.save()
        c.translate(px, py)
        // 侧倾角 = 横向速度 / 满幅横速（撞树时叠一层高频抖动）
        const tilt = clamp(s.vx / this.cfg.lat, -1, 1) * 0.22 + (s.dizzy > 0 ? Math.sin(this.t * 22) * 0.16 : 0)
        c.rotate(tilt)
        // 板
        c.fillStyle = '#22324a'
        rr(c, -u * 0.34, -u * 0.1, u * 0.68, u * 0.1, u * 0.05)
        c.fill()
        // 身体
        c.fillStyle = s.color
        rr(c, -u * 0.15, -u * 0.62, u * 0.3, u * 0.52, u * 0.12)
        c.fill()
        // 头
        circle(c, 0, -u * 0.78, u * 0.13, '#ffe0bd')
        // 手（举得越高画得越高）
        c.strokeStyle = s.color
        c.lineWidth = u * 0.07
        c.lineCap = 'round'
        const lift = armLiftOf(this.players[i].body)
        const hy = -u * 0.6 - Math.max(0, lift) * u * 0.85
        c.beginPath()
        c.moveTo(-u * 0.13, -u * 0.5)
        c.lineTo(-u * 0.3, hy)
        c.moveTo(u * 0.13, -u * 0.5)
        c.lineTo(u * 0.3, hy)
        c.stroke()
        c.lineCap = 'butt'
        c.restore()
      },
    })

    items.sort((a, b2) => b2.dz - a.dz)
    for (const it of items) it.draw()

    // HUD
    const label = this.seats > 1 ? `P${i + 1}` : '连击'
    txt(c, `${label} ${s.combo}`, z.cx - z.w / 2 + 22, 30, 22, s.color, 'left')
    txt(c, `门 ${s.passed} · 撞 ${s.crashed}`, z.cx + z.w / 2 - 22, 30, 20, '#5b7186', 'right')
    if (s.dizzy > 0) {
      outlineTxt(c, '晕了…', z.cx, this.H * 0.36, 34, '#b06bff')
    }
    if (this.t < 4 && s.passed === 0) {
      c.globalAlpha = 0.5 + 0.45 * Math.sin(this.t * 4)
      outlineTxt(c, '歪身体左右滑', z.cx, this.H * 0.5, 30)
      c.globalAlpha = 1
    }
  }
}

export default function create(ctx: GameContext) {
  return new SlalomSki(ctx)
}
