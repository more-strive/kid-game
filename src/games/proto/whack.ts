import { BaseGame, segHit } from '@/core/base'
import type { Game, GameContext, PoseFrame } from '@/core/types'
import { circle, outlineTxt, txt } from '@/core/draw'
import { drawItem, preloadItems } from '@/core/sprites'

/**
 * 打地鼠原型（对齐 dongdongpark 真实规则）：
 * 身体两侧 6 洞冒头 → 手向下砸（有下拍手速门槛）→ 普通鼠 +1 / 金鼠两下 +3 / 安全帽鼠不能拍。
 * 普通鼠缩回没打到会清连击，安全帽缩回不清。
 */
type MoleKind = 'normal' | 'gold' | 'helmet'
type MoleState = 'rise' | 'up' | 'sink' | 'bonk' | 'clank' | 'gone'

const RISE_T = 0.18 // 冒头动画时长
const SINK_T = 0.2 // 缩回动画时长
const LINGER = 0.55 // 被打扁/敲帽后残留时长
const HIT_CD = 0.28 // 每只手命中后的冷却
const HAND_R = 16 // 手部判定半径

/** 对齐站点真实难度表：停留/间隔/同屏上限/下拍手速门槛/安全帽率/金鼠率/误拍帽扣分 */
const DIFF = [
  { up: 1.4, every: 1.3, max: 1, slam: 1.0, helmet: 0.1, gold: 0.1, penalty: 0 },
  { up: 1.0, every: 1.0, max: 2, slam: 1.5, helmet: 0.18, gold: 0.12, penalty: 1 },
  { up: 0.7, every: 0.75, max: 3, slam: 1.8, helmet: 0.25, gold: 0.15, penalty: 1 },
]

/** 6 个洞相对肩中心的偏移（×躯干长），左右镜像（对齐站点布局） */
const HOLE_OFFSETS: [number, number][] = [
  [-1.15, -0.4], [-1.2, 0.3], [-1.1, 1.0],
  [1.15, -0.4], [1.2, 0.3], [1.1, 1.0],
]

interface Hole {
  x: number
  y: number
  r: number
  glow: number
}

interface Mole {
  hole: number
  owner: number
  kind: MoleKind
  state: MoleState
  t: number // 当前状态已过秒数
  upTime: number
  seed: number
  hits: number // 金鼠已拍几下
}

interface PState {
  holes: Hole[]
  moles: Mole[]
  spawnT: number
  handCd: [number, number]
  combo: number
  maxCombo: number
  shown: number
  hit: number
  /** 本玩家累计得分 */
  hitScore: number
  helmetHits: number
  /** 洞位跟随用的平滑躯干长 */
  lastTorso: number
}

class WhackGame extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  ps: PState[] = [
    { holes: [], moles: [], spawnT: 0.8, handCd: [0, 0], combo: 0, maxCombo: 0, shown: 0, hit: 0, hitScore: 0, helmetHits: 0, lastTorso: 0.22 },
    { holes: [], moles: [], spawnT: 0.8, handCd: [0, 0], combo: 0, maxCombo: 0, shown: 0, hit: 0, hitScore: 0, helmetHits: 0, lastTorso: 0.22 },
  ]

  constructor(ctx: GameContext) {
    super(ctx)
    preloadItems(['mole', 'bomb', 'star'])
  }

  private zone(pi: number) {
    if (this.present() <= 1) return { x0: this.W * 0.08, x1: this.W * 0.92 }
    return pi === 0 ? { x0: this.W * 0.03, x1: this.W * 0.47 } : { x0: this.W * 0.53, x1: this.W * 0.97 }
  }

  private present() {
    return this.players.filter((p) => p.body).length
  }

  tick(f: PoseFrame, dt: number) {
    const heat = Math.min(1, this.t / 45)
    for (let pi = 0; pi < 2; pi++) {
      const st = this.ps[pi]
      const b = f.bodies[pi]
      const z = this.zone(pi)
      st.handCd[0] = Math.max(0, st.handCd[0] - dt)
      st.handCd[1] = Math.max(0, st.handCd[1] - dt)

      // 洞位跟随身体（有效 4/s，丢失后 1.5/s 漂回默认位）
      const cx = b ? b.shoulderC.x * this.W : (z.x0 + z.x1) / 2
      const cy = b ? b.shoulderC.y * this.H : this.H * 0.55
      const torso = b ? Math.max(0.05, b.scale) : st.lastTorso
      if (b) st.lastTorso += (torso - st.lastTorso) * Math.min(1, dt * 2)
      const rate = b ? 4 : 1.5
      const holeR = Math.min(90, Math.max(34, st.lastTorso * this.H * 0.42))
      if (!st.holes.length) {
        for (const [ox, oy] of HOLE_OFFSETS) {
          st.holes.push({
            x: cx + ox * torso * this.H,
            y: cy + oy * torso * this.H,
            r: holeR,
            glow: 0,
          })
        }
      }
      st.holes.forEach((h, i) => {
        const [ox, oy] = HOLE_OFFSETS[i]
        const tx = Math.min(z.x1 - holeR * 1.3, Math.max(z.x0 + holeR * 1.3, cx + ox * torso * this.H))
        const ty = Math.min(this.H - holeR * 0.8, Math.max(this.H * 0.25 + holeR, cy + oy * torso * this.H))
        const k = Math.min(1, rate * dt)
        h.x += (tx - h.x) * k
        h.y += (ty - h.y) * k
        h.r = holeR
        h.glow = Math.max(0, h.glow - dt * 2.5)
      })

      // 生成：活跃数 < max 才冒头（对齐站点节奏公式）
      if (b) {
        st.spawnT -= dt
        if (st.spawnT <= 0) {
          const alive = st.moles.filter((m) => m.state !== 'bonk' && m.state !== 'clank').length
          if (alive < this.cfg.max) this.spawnMole(st, pi)
          st.spawnT = this.cfg.every * (1 - 0.25 * heat) * (0.7 + Math.random() * 0.6)
        }
      }

      // 地鼠状态机
      for (const m of st.moles) {
        m.t += dt
        if (m.state === 'rise' && m.t >= RISE_T) { m.state = 'up'; m.t = 0 }
        else if (m.state === 'up' && m.t >= m.upTime) { m.state = 'sink'; m.t = 0 }
        else if (m.state === 'sink' && m.t >= SINK_T) {
          m.state = 'gone'
          // 普通/金鼠缩回没打到 → 清连击；安全帽缩回不清（对齐站点）
          if (m.kind !== 'helmet' && m.hits === 0) st.combo = 0
        }
        else if ((m.state === 'bonk' || m.state === 'clank') && m.t >= LINGER) m.state = 'gone'
      }
      st.moles = st.moles.filter((m) => m.state !== 'gone')

      // 命中判定：下拍手速门槛 + 冷却 + 距头顶距离
      if (!b) continue
      const hands = [
        { trail: this.players[pi].lHand.trail, cd: 0 },
        { trail: this.players[pi].rHand.trail, cd: 1 },
      ]
      for (const h of hands) {
        if (st.handCd[h.cd] > 0) continue
        if (h.trail.length < 2) continue
        const a = h.trail[h.trail.length - 2]
        const z2 = h.trail[h.trail.length - 1]
        // 下拍手速（躯干长/秒，y 向下为正）
        const vyTorso = (z2.y - a.y) / Math.max(0.001, dt) / torso
        if (vyTorso < this.cfg.slam) continue
        for (const m of st.moles) {
          if (m.state === 'bonk' || m.state === 'clank') continue
          const hole = st.holes[m.hole]
          const k = m.state === 'rise' ? m.t / RISE_T : m.state === 'up' ? 1 : 1 - m.t / SINK_T
          const hx = hole.x
          const hy = hole.y - hole.r * 0.75 * k
          if (!segHit(a.x * this.W, a.y * this.H, z2.x * this.W, z2.y * this.H, hx, hy, hole.r * 1.05 + HAND_R * 0.6)) continue
          st.handCd[h.cd] = HIT_CD
          this.hitMole(st, pi, m, hx, hy)
          break
        }
      }
    }

    const bestCombo = Math.max(this.ps[0].combo, this.ps[1].combo)
    this.ctx.setCombo(bestCombo)
    this.ctx.setScore(this.ps[0].hitScore + this.ps[1].hitScore)
    this.ctx.setExtra('命中率', Math.round(
      (this.ps[0].hit + this.ps[1].hit) / Math.max(1, this.ps[0].shown + this.ps[1].shown) * 100,
    ))
    this.ctx.setExtra('最大连拍', Math.max(this.ps[0].maxCombo, this.ps[1].maxCombo))
    const hats = this.ps[0].helmetHits + this.ps[1].helmetHits
    this.ctx.setExtra('误拍帽', hats)
  }

  private spawnMole(st: PState, pi: number) {
    // 随机挑一个没有活跃地鼠的洞（最多轮转 6 次）
    let hole = Math.floor(Math.random() * 6)
    for (let i = 0; i < 6; i++) {
      const occupied = st.moles.some((m) => m.hole === hole && m.state !== 'bonk' && m.state !== 'clank')
      if (!occupied) break
      hole = (hole + 1) % 6
    }
    const roll = Math.random()
    const kind: MoleKind = roll < this.cfg.helmet ? 'helmet' : roll < this.cfg.helmet + this.cfg.gold ? 'gold' : 'normal'
    if (kind !== 'helmet') st.shown++
    const heat = Math.min(1, this.t / 45)
    st.moles.push({
      hole,
      owner: pi,
      kind,
      state: 'rise',
      t: 0,
      upTime: this.cfg.up * (1 - 0.25 * heat) * (0.85 + Math.random() * 0.3) * (kind === 'gold' ? 1.35 : 1),
      seed: Math.floor(Math.random() * 1e6),
      hits: 0,
    })
    this.ctx.audio.play('pop', 0.7, 0.9 + Math.random() * 0.3)
  }

  private hitMole(st: PState, _pi: number, m: Mole, hx: number, hy: number) {
    const hole = st.holes[m.hole]
    if (m.kind === 'helmet') {
      // 安全帽：连击清零 + 按难度扣分
      m.state = 'clank'
      m.t = 0
      st.combo = 0
      st.helmetHits++
      if (this.cfg.penalty) st.hitScore = Math.max(0, st.hitScore - this.cfg.penalty)
      this.ctx.audio.fail()
      this.say('哎哟！别拍它', hx, hy - 60, '#7a6b8a', 38)
      this.particles.burst(hx, hy, '#ffffff', 6, 300, 4)
      return
    }
    if (m.kind === 'gold' && m.hits === 0) {
      // 金鼠第一下：不消失、可从缩回中拉回
      m.hits = 1
      if (m.state === 'sink') { m.state = 'up'; m.t = 0 }
      this.ctx.audio.play('pop', 1, 1.2)
      this.say('再拍一下！', hx, hy - 50, '#ffd54a', 32)
      this.particles.burst(hx, hy, '#ffd54a', 10, 320, 4)
      return
    }
    // 正常命结（普通 +1 / 金鼠第二下 +3）
    m.state = 'bonk'
    m.t = 0
    st.hit++
    st.combo++
    st.maxCombo = Math.max(st.maxCombo, st.combo)
    const gain = m.kind === 'gold' ? 3 : 1
    st.hitScore += gain
    hole.glow = 1
    this.ctx.audio.play('hit', 1, 1 + Math.min(0.5, st.combo * 0.05))
    this.say(`+${gain}`, hx, hy - 40, '#fff36b', 32)
    this.particles.burst(hx, hy, m.kind === 'gold' ? '#ffd54a' : '#a9754f', m.kind === 'gold' ? 18 : 10, 320, 5)
    if (st.combo % 5 === 0) {
      this.ctx.audio.good()
      this.sayText(`连拍 ×${st.combo}！`)
    }
  }

  private bannerText = ''
  private bannerT = 0

  private sayText(text: string) {
    this.bannerText = text
    this.bannerT = 1
  }

  paint(c: CanvasRenderingContext2D) {
    // 洞 + 地鼠 + 锤子（按玩家绘制）
    for (let pi = 0; pi < 2; pi++) {
      this.drawMallets(c, pi)
      const st = this.ps[pi]
      const color = this.players[pi].color
      for (const h of st.holes) {
        // 洞口
        c.save()
        c.translate(h.x, h.y)
        c.beginPath()
        c.ellipse(0, 0, h.r * 1.35, h.r * 0.75, 0, 0, Math.PI * 2)
        c.fillStyle = '#4a3b5c'
        c.fill()
        c.beginPath()
        c.ellipse(0, -h.r * 0.06, h.r * 1.15, h.r * 0.6, 0, 0, Math.PI * 2)
        c.fillStyle = '#241c30'
        c.fill()
        if (h.glow > 0) {
          c.globalAlpha = h.glow * 0.7
          c.strokeStyle = color
          c.lineWidth = 5
          c.beginPath()
          c.ellipse(0, 0, h.r * 1.35, h.r * 0.75, 0, 0, Math.PI * 2)
          c.stroke()
        }
        c.restore()
      }
      for (const m of st.moles) {
        const hole = st.holes[m.hole]
        const k = m.state === 'rise' ? m.t / RISE_T : m.state === 'up' ? 1 : m.state === 'sink' ? 1 - m.t / SINK_T : 1
        const squash = m.state === 'bonk' ? Math.max(0.4, 1 - m.t / LINGER * 0.5) : 1
        const shake = m.state === 'clank' ? Math.sin(this.t * 40) * hole.r * 0.04 : 0
        c.save()
        c.translate(hole.x + shake, hole.y - hole.r * 0.3 * k)
        // 只露出洞口以上的部分
        c.beginPath()
        c.rect(-hole.r * 1.5, -hole.r * 2.2, hole.r * 3, hole.r * 2.2 + hole.r * 0.35)
        c.clip()
        c.scale(1, squash)
        this.drawMole(c, hole.r, m, k)
        c.restore()
      }
    }

    // 连击与横幅
    const best = Math.max(this.ps[0].combo, this.ps[1].combo)
    if (best >= 3) {
      outlineTxt(c, `连拍 ${best}`, 100, 50, 30 + Math.min(16, best), '#ffd54a')
    }
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.bannerText, this.W / 2, 150, 44, '#ffd54a')
      c.globalAlpha = 1
    }
    txt(c, '使劲往下拍冒头的地鼠；金鼠拍两下，戴帽子的别碰', this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }

  /** 手里的锤子（对齐站点：mallet 精灵，基础倾斜 ±0.45，按垂直手速再倾斜） */
  private drawMallets(c: CanvasRenderingContext2D, pi: number) {
    const pv = this.players[pi]
    const torsoPx = this.ps[pi].lastTorso * this.H
    const size = Math.max(50, torsoPx * 0.5)
    for (const { cur, side } of [
      { cur: pv.lHand, side: -1 },
      { cur: pv.rHand, side: 1 },
    ]) {
      if (!cur.active || cur.trail.length < 2) continue
      const a = cur.trail[cur.trail.length - 2]
      const z = cur.trail[cur.trail.length - 1]
      const vyNorm = (z.y - a.y) / Math.max(0.016, 1 / 60)
      const tilt = side * 0.45 + Math.max(-0.25, Math.min(0.25, vyNorm * 0.25))
      c.save()
      c.translate(cur.x, cur.y)
      c.rotate(tilt)
      // 柄
      c.strokeStyle = '#8a6a3a'
      c.lineWidth = size * 0.14
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(0, size * 0.55)
      c.lineTo(0, -size * 0.45)
      c.stroke()
      // 锤头
      c.fillStyle = pv.color
      c.beginPath()
      c.roundRect(-size * 0.34, -size * 0.62, size * 0.68, size * 0.34, size * 0.1)
      c.fill()
      c.strokeStyle = 'rgba(255,255,255,.5)'
      c.lineWidth = 3
      c.stroke()
      c.restore()
    }
  }

  private drawMole(c: CanvasRenderingContext2D, r: number, m: Mole, k: number) {
    void k
    const gold = m.kind === 'gold'
    const body = gold ? '#e8b93d' : '#a9754f'
    const belly = gold ? '#ffe9a3' : '#c99a6b'
    // 优先贴图
    if (m.kind !== 'helmet' && drawItem(c, 'mole', 0, -r * 0.35, r * 2.2 * (gold ? 1 : 1))) {
      if (gold) {
        c.globalAlpha = 0.4
        circle(c, 0, -r * 0.35, r * 0.9, '#ffd54a')
        c.globalAlpha = 1
      }
      return
    }
    // 矢量地鼠
    const g = c.createRadialGradient(-r * 0.3, -r * 0.5, r * 0.1, 0, 0, r * 1.3)
    g.addColorStop(0, gold ? '#ffe9a3' : '#c98f57')
    g.addColorStop(1, body)
    c.beginPath()
    c.ellipse(0, 0, r * 0.88, r, 0, 0, Math.PI * 2)
    c.fillStyle = g
    c.fill()
    circle(c, -r * 0.7, -r * 0.62, r * 0.24, gold ? '#d9a72e' : '#8a5f37')
    circle(c, r * 0.7, -r * 0.62, r * 0.24, gold ? '#d9a72e' : '#8a5f37')
    circle(c, -r * 0.28, -r * 0.15, r * 0.11, '#2b1c0e')
    circle(c, r * 0.28, -r * 0.15, r * 0.11, '#2b1c0e')
    circle(c, 0, r * 0.14, r * 0.13, '#5d3d22')
    c.beginPath()
    c.ellipse(0, r * 0.42, r * 0.42, r * 0.3, 0, 0, Math.PI * 2)
    c.fillStyle = belly
    c.fill()
    if (m.kind === 'helmet') {
      // 安全帽：深色硬帽 + 红叉，明示不能拍
      c.beginPath()
      c.ellipse(0, -r * 0.78, r * 0.82, r * 0.4, 0, Math.PI, Math.PI * 2)
      c.fillStyle = '#3a3a4d'
      c.fill()
      c.fillRect(-r * 0.9, -r * 0.8, r * 1.8, r * 0.14)
      txt(c, '✕', 0, -r * 0.5, r * 0.8, '#ff6b6b', 'center', '900')
    }
    if (m.state === 'bonk') {
      // 被打扁的晕脸
      txt(c, '@_@', 0, -r * 0.1, r * 0.5, '#2b1c0e', 'center', '900')
    }
  }
}

export default function create(ctx: GameContext) {
  return new WhackGame(ctx)
}
