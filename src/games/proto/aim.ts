import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, txt } from '@/core/draw'
import { drawItem, preloadItems } from '@/core/sprites'

/**
 * 投掷/瞄准类原型。12 个游戏不再共用“丢球打移动目标”，拆成 8 种规则：
 * throw     移动目标投掷（投篮：横向移动篮筐｜飞盘：小狗上下跑，看准时机甩出）
 * precision 稳住再放：手稳住准星收拢，快甩出手，按离靶心距离算环数（飞镖/射箭）
 * bowling   保龄球：低手甩出滚球撞瓶，两球一轮，全中加分
 * soccer    射门：踢向球门，守门员左右扑，射死角加分
 * keeper    守门员：反过来接飞来的球，用手脚头把球挡出去
 * rally     对打：球过网来回，用手挥拍回击，和电脑比回合数（乒乓/网球/排球）
 * keepup    颠球：毽子落下用脚或手颠起来，别落地
 * skip      打水漂：贴着水面平甩，石头跳几下、穿环得分
 */
type Rule = 'throw' | 'precision' | 'bowling' | 'soccer' | 'keeper' | 'rally' | 'keepup' | 'skip'

interface Theme {
  rule: Rule
  kind: 'hoop' | 'board' | 'dog' | 'net' | 'goal'
  color: string
  label: string
  kick?: boolean
  /** rally：乒乓为直线球，网球/排球为弧线球 */
  flat?: boolean
  /** precision：总箭数 */
  shots?: number
  hint: string
}

const THEMES: Record<string, Theme> = {
  hoops: { rule: 'throw', kind: 'hoop', color: '#ff7a45', label: '投篮', hint: '对准移动的篮筐，挥手投出去' },
  'frisbee-dog': { rule: 'throw', kind: 'dog', color: '#3ddc97', label: '扔飞盘', hint: '小狗跑进圈里时，把飞盘甩给它' },
  darts: { rule: 'precision', kind: 'board', color: '#ff4d6d', label: '飞镖', shots: 15, hint: '手稳住让准星收拢，快甩出手' },
  archery: { rule: 'precision', kind: 'board', color: '#3ddc97', label: '射箭', shots: 10, hint: '稳住准星缩小，一甩放箭' },
  bowling: { rule: 'bowling', kind: 'hoop', color: '#4cc9f0', label: '保龄球', hint: '手放低往后拉，往前一甩滚出去' },
  'soccer-kick': { rule: 'soccer', kind: 'hoop', color: '#3ddc97', label: '射门', kick: true, hint: '抬脚踢向球门，守门员扑不到就进' },
  goalkeeper: { rule: 'keeper', kind: 'goal', color: '#ffb703', label: '扑救', hint: '球飞过来，用手、脚、头挡出去！' },
  'air-pong': { rule: 'rally', kind: 'net', color: '#7c5cff', label: '对打', flat: true, hint: '手当球拍，把球打回去，别漏球' },
  tennis: { rule: 'rally', kind: 'net', color: '#ffd54a', label: '对打', hint: '球到哪边就用那边的手挥回去' },
  volley: { rule: 'rally', kind: 'net', color: '#4cc9f0', label: '垫球', hint: '球落下来，用手垫回去' },
  shuttlecock: { rule: 'keepup', kind: 'net', color: '#ff8fa3', label: '踢毽子', hint: '毽子落到膝盖高，抬脚或用手颠起来' },
  'stone-skip': { rule: 'skip', kind: 'net', color: '#7c5cff', label: '打水漂', hint: '手放低贴着水面平甩，石头多跳几下' },
}

interface Ball {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  alive: boolean
  scored: boolean
  spin: number
}

interface Pin { x: number; y: number; fall: number; hit: boolean }
interface InBall { x: number; y: number; tx: number; ty: number; t: number; dur: number; saved: boolean }
interface Obs2 { x: number; got: boolean }

const G = 1000
const FLOOR = 640

class AimGame extends BaseGame implements Game {
  theme: Theme
  rule: Rule
  score = 0
  hits = 0
  throws = 0
  combo = 0
  cool = 0
  private prevHand: { x: number; y: number } | null = null
  private prevFoot: { x: number; y: number } | null = null
  private footV = 0

  // throw（投篮/飞盘）
  target = { x: 640, y: 200, r: 68, dir: 1, speed: 150, axis: 'x' as 'x' | 'y' }
  balls: Ball[] = []

  // precision
  private aim = { x: 640, y: 500, wob: 150 }
  private darts: { x: number; y: number; pts: number; life: number }[] = []
  private shotsLeft = 15

  // bowling
  private pins: Pin[] = []
  private bBall = { x: -99, v: 0, rolling: false }
  private frame = 0
  private ball = 1
  private pinsDownThisBall = 0
  private resetT = 0

  // soccer
  private sBall = { x: 0, y: 0, tx: 0, ty: 0, t: 1, dur: 0.55, flying: false }
  private keeperY = 400
  private keeperDir = 1
  private goals = 0

  // keeper
  private incoming: InBall[] = []
  private hearts = 3
  private saves = 0
  private spawnT = 1.2

  // rally
  private rBall = { x: 0, y: 0, vx: 0, vy: 0, live: false }
  private rally = 0
  private serveT = 1

  // keepup
  private shuttle = { x: 640, y: 120, vx: 0, vy: 0, live: true }
  private prevFeet: { l: number; r: number } | null = null

  // skip
  private stone = { x: 0, y: 0, vx: 0, hopT: 0, live: false }
  private skips = 0
  private rings: Obs2[] = []
  private stones = 5
  private bestDist = 0

  constructor(ctx: GameContext) {
    super(ctx)
    const t = THEMES[ctx.meta.slug]
    this.theme = t ?? THEMES.hoops
    this.rule = this.theme.rule
    this.target.speed = 210 + ctx.difficulty * 70
    if (this.rule === 'throw') this.target.axis = this.theme.kind === 'dog' ? 'y' : 'x'
    if (this.rule === 'precision') this.shotsLeft = this.theme.shots ?? 12
    if (this.rule === 'bowling') this.resetPins()
    if (this.rule === 'rally') this.resetRally()
    if (this.rule === 'skip') this.rings = [{ x: 420, got: false }, { x: 760, got: false }, { x: 1100, got: false }]
    preloadItems(['basketball', 'soccer', 'dart', 'bowling', 'tennis', 'volleyball', 'shuttlecock', 'frisbee', 'note'])
  }

  private resetPins() {
    this.pins = []
    let n = 0
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i <= row; i++) {
        this.pins.push({
          x: 1010 + row * 62 + (i - row / 2) * 34,
          y: 556 - row * 8,
          fall: 0,
          hit: false,
        })
        n++
      }
    }
    this.pinsDownThisBall = 0
  }

  private resetRally() {
    this.rBall.live = false
    this.serveT = 1
  }

  tick(f: PoseFrame, dt: number) {
    this.cool = Math.max(0, this.cool - dt)
    const b = f.bodies[0] ?? null
    if (b) {
      // 归一化单位/秒，和 Body 里的手速一个量纲
      this.footV = this.prevFoot
        ? Math.hypot(b.lFoot.x - this.prevFoot.x, b.lFoot.y - this.prevFoot.y) / Math.max(0.016, dt)
        : 0
    }
    switch (this.rule) {
      case 'throw': this.tickThrow(b, dt); break
      case 'precision': this.tickPrecision(b, dt); break
      case 'bowling': this.tickBowling(b, dt); break
      case 'soccer': this.tickSoccer(b, dt); break
      case 'keeper': this.tickKeeper(f, dt); break
      case 'rally': this.tickRally(f, dt); break
      case 'keepup': this.tickKeepup(f, dt); break
      case 'skip': this.tickSkip(b, dt); break
    }
    if (b) {
      this.prevHand = { x: b.lHand.x, y: b.lHand.y }
      this.prevFoot = { x: b.lFoot.x, y: b.lFoot.y }
    }
    this.ctx.setScore(this.score)
  }

  /** 更快的那只手（含速度） */
  private fastHand(b: Body) {
    return b.lHandV >= b.rHandV
      ? { x: b.lHand.x * this.W, y: b.lHand.y * this.H, v: b.lHandV }
      : { x: b.rHand.x * this.W, y: b.rHand.y * this.H, v: b.rHandV }
  }

  // ---------- throw：移动目标投掷 ----------
  private tickThrow(b: Body | null, dt: number) {
    const t = this.target
    if (t.axis === 'x') {
      t.x += t.dir * t.speed * dt
      if (t.x > this.W - 200) { t.x = this.W - 200; t.dir = -1 }
      if (t.x < 200) { t.x = 200; t.dir = 1 }
    } else {
      t.y += t.dir * (t.speed * 0.7) * dt
      if (t.y > 480) { t.y = 480; t.dir = -1 }
      if (t.y < 140) { t.y = 140; t.dir = 1 }
      t.x = this.W - 260
    }

    // 出手判定（冷却中不投，但球照常飞）
    if (b && this.cool <= 0) {
      const h = this.fastHand(b)
      if (this.prevHand) {
        const speed = Math.hypot(b.lHand.x - this.prevHand.x, b.lHand.y - this.prevHand.y)
        if (h.v > 0.85 || speed > 0.1) {
          this.cool = 0.78
          this.throws++
          const tx = t.x + (Math.random() - 0.5) * 90
          const ty = t.y + (Math.random() - 0.5) * 40
          const dist = Math.hypot(tx - h.x, ty - h.y) || 1
          const power = 1180
          this.balls.push({
            x: h.x, y: h.y,
            vx: ((tx - h.x) / dist) * power,
            vy: ((ty - h.y) / dist) * power - 260,
            r: this.theme.kind === 'dog' ? 18 : 22,
            alive: true, scored: false, spin: 0,
          })
          this.ctx.audio.pop()
        }
      }
    }

    for (const bl of this.balls) {
      if (!bl.alive) continue
      bl.vy += G * dt
      bl.x += bl.vx * dt
      bl.y += bl.vy * dt
      bl.spin += dt * 8
      if (!bl.scored && Math.hypot(bl.x - t.x, bl.y - t.y) < t.r + bl.r) this.scoreHit(bl)
      if (bl.y > this.H + 80 || bl.x < -80 || bl.x > this.W + 80) bl.alive = false
    }
    this.balls = this.balls.filter((x) => x.alive)
  }

  private scoreHit(bl: Ball) {
    bl.scored = true
    bl.alive = false
    this.hits++
    this.combo++
    const gain = 20 + Math.min(30, this.combo * 5)
    this.score += gain
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('hits', this.hits)
    this.ctx.audio.good()
    this.particles.burst(bl.x, bl.y, this.theme.color, 20, 420, 7)
    this.say(`+${gain}`, this.target.x, this.target.y - 40, '#fff36b', 40)
    if (this.combo > 0 && this.combo % 3 === 0) {
      this.ctx.speak('好球')
      this.target.speed += 20
    }
  }

  // ---------- precision：稳住再放 ----------
  private tickPrecision(b: Body | null, dt: number) {
    if (!b) return
    const l = { x: b.lHand.x * this.W, y: b.lHand.y * this.H, v: b.lHandV }
    const r = { x: b.rHand.x * this.W, y: b.rHand.y * this.H, v: b.rHandV }
    // 用较稳的那只手瞄准
    const hand = l.v < r.v ? l : r
    const k = 1 - Math.pow(0.0015, dt)
    this.aim.x += (hand.x - this.aim.x) * k
    this.aim.y += (hand.y - this.aim.y) * k
    // 稳：准星收拢；动：散开
    if (hand.v < 0.22) this.aim.wob = Math.max(26, this.aim.wob - 170 * dt)
    else this.aim.wob = Math.min(150, this.aim.wob + 320 * dt)
    // 快甩出手
    const flick = Math.max(b.lHandV, b.rHandV)
    if (flick > 1.15 && this.cool <= 0 && this.shotsLeft > 0) {
      this.cool = 0.7
      this.shotsLeft--
      this.throws++
      const d = Math.hypot(this.aim.x - 640, this.aim.y - 270) + this.aim.wob * 0.35
      const pts = d < 22 ? 50 : d < 48 ? 30 : d < 74 ? 20 : d < 100 ? 10 : d < 130 ? 5 : 0
      this.darts.push({ x: this.aim.x, y: this.aim.y, pts, life: 1.4 })
      this.score += pts
      if (pts >= 30) {
        this.combo++
        this.ctx.audio.good()
        this.say(pts === 50 ? '正中靶心！' : `+${pts}`, this.aim.x, this.aim.y - 50, '#3ddc97', 40)
        if (pts === 50) this.ctx.speak('靶心')
      } else if (pts > 0) {
        this.ctx.audio.pop()
        this.say(`+${pts}`, this.aim.x, this.aim.y - 50, '#fff36b', 32)
        this.combo = 0
      } else {
        this.ctx.audio.fail()
        this.say('脱靶', this.aim.x, this.aim.y - 50, '#ff9f9f', 32)
        this.combo = 0
      }
      this.ctx.setCombo(this.combo)
      this.aim.wob = 150
      this.ctx.setExtra('shots', this.shotsLeft)
      if (this.shotsLeft <= 0) this.ctx.finish()
    }
    for (const d of this.darts) d.life -= dt
    this.darts = this.darts.filter((d) => d.life > 0)
  }

  // ---------- bowling：保龄球 ----------
  private tickBowling(b: Body | null, dt: number) {
    if (this.resetT > 0) {
      this.resetT -= dt
      if (this.resetT <= 0) {
        const cleared = this.pins.every((p) => p.hit)
        if (cleared || this.ball >= 2) {
          this.ball = 1
          this.frame++
          this.resetPins()
          if (this.frame >= 5) {
            this.ctx.finish()
            return
          }
        } else {
          this.ball = 2
        }
        this.bBall.rolling = false
        this.bBall.x = -99
      }
      return
    }
    // 出手：手放低 + 快甩
    if (b && !this.bBall.rolling && this.cool <= 0) {
      const h = this.fastHand(b)
      if (h.y > this.H * 0.55 && h.v > 0.8) {
        this.cool = 1
        this.throws++
        this.bBall.rolling = true
        this.bBall.x = 140
        this.bBall.v = Math.min(1250, 480 + h.v * 900)
        this.pinsDownThisBall = 0
        this.ctx.audio.pop()
      }
    }
    if (this.bBall.rolling) {
      this.bBall.x += this.bBall.v * dt
      this.bBall.v = Math.max(180, this.bBall.v - 90 * dt)
      for (const p of this.pins) {
        if (!p.hit && Math.abs(p.x - this.bBall.x) < 40) {
          p.hit = true
          this.pinsDownThisBall++
          this.hits++
          this.ctx.audio.hit()
        }
      }
      // 倒下的瓶带倒邻居
      for (const p of this.pins) {
        if (p.hit && p.fall < 1) {
          p.fall = Math.min(1, p.fall + dt * 3)
          for (const q of this.pins) {
            if (!q.hit && Math.hypot(q.x - p.x, q.y - p.y) < 56 && Math.random() < 0.5) {
              q.hit = true
              this.pinsDownThisBall++
              this.hits++
            }
          }
        }
      }
      const down = this.pins.filter((p) => p.hit).length
      if (this.bBall.x > 1230 || this.bBall.v <= 200 || (down === 10 && this.bBall.x > 900)) {
        // 结算这一球
        this.score += this.pinsDownThisBall * 10
        const standing = 10 - down
        if (down === 10 && this.ball === 1) {
          this.score += 40
          this.ctx.audio.win()
          this.say('全中！STRIKE +40', this.W / 2, 300, '#ffd54a', 52)
        } else if (standing === 0) {
          this.score += 25
          this.ctx.audio.good()
          this.say('补中！+25', this.W / 2, 300, '#ffd54a', 46)
        } else if (this.pinsDownThisBall === 0) {
          this.ctx.audio.fail()
          this.say('一瓶没倒…', this.W / 2, 300, '#ff9f9f', 40)
        }
        this.ctx.setExtra('frame', this.frame + 1)
        this.resetT = 1.4
      }
    }
  }

  // ---------- soccer：射门 vs 守门员 ----------
  private tickSoccer(b: Body | null, dt: number) {
    // 守门员上下扑
    const range = 130
    this.keeperY += this.keeperDir * (170 + this.goals * 14) * dt
    if (this.keeperY > 400 + range) { this.keeperY = 400 + range; this.keeperDir = -1 }
    if (this.keeperY < 400 - range) { this.keeperY = 400 - range; this.keeperDir = 1 }
    if (Math.random() < dt * 0.6) this.keeperDir *= -1

    if (this.sBall.flying) {
      this.sBall.t += dt / this.sBall.dur
      if (this.sBall.t >= 1) {
        this.sBall.flying = false
        const saved = Math.abs(this.sBall.ty - this.keeperY) < 80
        if (saved) {
          this.ctx.audio.fail()
          this.combo = 0
          this.ctx.setCombo(0)
          this.say('被扑出了！', 1010, 200, '#ff9f9f', 38)
        } else {
          this.goals++
          this.combo++
          const corner = this.sBall.ty < 310 || this.sBall.ty > 490
          const gain = corner ? 25 : 15
          this.score += gain
          this.ctx.setCombo(this.combo)
          this.ctx.audio.good()
          this.particles.burst(1010, this.sBall.ty, '#3ddc97', 22, 460, 7)
          this.say(corner ? `死角！+${gain}` : `进球！+${gain}`, 1010, 180, '#ffd54a', 42)
          this.ctx.setExtra('goals', this.goals)
          if (this.goals % 3 === 0) this.ctx.speak('漂亮')
        }
      }
      return
    }
    // 踢球：脚快抬
    if (b && this.cool <= 0 && this.footV > 0.5) {
      this.cool = 0.9
      this.throws++
      const fy = b.lFoot.y < b.rFoot.y ? b.lFoot.y : b.rFoot.y
      const ty = Math.max(280, Math.min(520, 280 + (fy - 0.45) * 900))
      this.sBall = { x: 300, y: fy * this.H, tx: 1010, ty, t: 0, dur: 0.55, flying: true }
      this.ctx.audio.pop()
    }
  }

  // ---------- keeper：扑救 ----------
  private tickKeeper(f: PoseFrame, _dt: number) {
    const bodies = f.bodies
    this.spawnT -= Math.min(0.05, _dt)
    if (this.spawnT <= 0) {
      this.spawnT = Math.max(0.9, 1.7 - this.t * 0.01)
      const ty = [280, 400, 520, 340, 460][Math.floor(Math.random() * 5)]
      this.incoming.push({
        x: this.W - 80,
        y: 120 + Math.random() * 200,
        tx: 330,
        ty,
        t: 0,
        dur: Math.max(0.8, 1.5 - this.t * 0.006),
        saved: false,
      })
    }
    const limbs: { x: number; y: number }[] = []
    for (const b of bodies) {
      limbs.push(
        { x: b.lHand.x * this.W, y: b.lHand.y * this.H },
        { x: b.rHand.x * this.W, y: b.rHand.y * this.H },
        { x: b.head.x * this.W, y: b.head.y * this.H },
        { x: b.lFoot.x * this.W, y: b.lFoot.y * this.H },
        { x: b.rFoot.x * this.W, y: b.rFoot.y * this.H },
      )
    }
    for (const ib of this.incoming) {
      if (ib.saved) continue
      ib.t += Math.min(0.05, _dt) / ib.dur
      ib.x += (ib.tx - ib.x) * 0.12
      ib.y += (ib.ty - ib.y) * 0.12
      const bx = ib.tx + (this.W - 80 - ib.tx) * (1 - ib.t)
      const by = ib.y
      for (const l of limbs) {
        if (Math.hypot(l.x - bx, l.y - by) < 66) {
          ib.saved = true
          this.saves++
          this.combo++
          const gain = 15 + Math.min(20, this.combo * 3)
          this.score += gain
          this.ctx.setCombo(this.combo)
          this.ctx.setExtra('saves', this.saves)
          this.ctx.audio.good()
          this.particles.burst(bx, by, '#ffb703', 16, 380, 6)
          this.say(`扑出去！+${gain}`, bx, by - 60, '#ffd54a', 36)
          break
        }
      }
      if (!ib.saved && ib.t >= 1) {
        ib.saved = true
        this.hearts--
        this.combo = 0
        this.ctx.setCombo(0)
        this.ctx.audio.fail()
        this.say('进了…', ib.tx, ib.ty - 60, '#ff6b6b', 40)
        if (this.hearts <= 0) this.ctx.finish()
      }
    }
    this.incoming = this.incoming.filter((x) => !x.saved || x.t < 1.3)
    for (const ib of this.incoming) if (ib.saved) ib.t += 0.05
  }

  // ---------- rally：对打 ----------
  private tickRally(f: PoseFrame, dt: number) {
    const netX = this.W / 2
    const rb = this.rBall
    if (!rb.live) {
      this.serveT -= dt
      if (this.serveT <= 0) {
        rb.live = true
        rb.x = netX - 200
        rb.y = 320
        rb.vx = 460 + this.rally * 12
        rb.vy = this.theme.flat ? (Math.random() - 0.5) * 300 : -160
      }
      return
    }
    if (!this.theme.flat) rb.vy += 850 * dt
    rb.x += rb.vx * dt
    rb.y += rb.vy * dt
    if (!this.theme.flat && rb.y > FLOOR - 30 && rb.vy > 0) {
      rb.y = FLOOR - 30
      rb.vy *= -0.45
    }
    if (rb.y < 40) { rb.y = 40; rb.vy = Math.abs(rb.vy) }

    // 电脑回球
    if (rb.x < netX - 60 && rb.vx < 0) {
      const missChance = Math.min(0.45, 0.07 + this.rally * 0.03)
      if (Math.random() < missChance) {
        // 电脑失误
        this.combo++
        const gain = 20 + this.rally * 2
        this.score += gain
        this.ctx.setCombo(this.combo)
        this.hits++
        this.ctx.audio.win()
        this.say(`${this.rally} 回合拿下！+${gain}`, netX, 240, '#ffd54a', 46)
        this.resetRally()
        return
      }
      rb.vx = Math.abs(rb.vx)
      rb.vy = this.theme.flat ? (Math.random() - 0.5) * 320 : -(180 + Math.random() * 220)
      this.ctx.audio.pop()
    }

    // 玩家回球：手碰到球 + 挥动
    for (const b of f.bodies) {
      const hands = [
        { x: b.lHand.x * this.W, y: b.lHand.y * this.H, v: b.lHandV },
        { x: b.rHand.x * this.W, y: b.rHand.y * this.H, v: b.rHandV },
      ]
      for (const h of hands) {
        if (rb.x > netX + 30 && rb.vx > 0 && Math.hypot(h.x - rb.x, h.y - rb.y) < 85 && h.v > 0.4) {
          this.rally++
          this.throws++
          this.score += 10
          this.ctx.setExtra('rally', this.rally)
          this.ctx.audio.tonePop(Math.min(3, this.rally % 4))
          rb.vx = -(520 + Math.min(400, h.v * 320) + this.rally * 14)
          rb.vy = this.theme.flat ? (Math.random() - 0.5) * 300 : -(140 + Math.random() * 200)
          if (this.rally % 5 === 0) {
            this.ctx.audio.good()
            this.say(`${this.rally} 连击！`, netX, 200, '#ffd54a', 44)
          }
          break
        }
      }
    }
    // 玩家漏球
    if (rb.x > this.W + 60) {
      this.combo = 0
      this.ctx.setCombo(0)
      this.ctx.audio.fail()
      this.say('漏球了', netX + 200, 260, '#ff9f9f', 38)
      this.rally = 0
      this.ctx.setExtra('rally', 0)
      this.resetRally()
    }
  }

  // ---------- keepup：颠球 ----------
  private tickKeepup(f: PoseFrame, dt: number) {
    const s = this.shuttle
    if (!s.live) {
      this.serveT -= dt
      if (this.serveT <= 0) {
        s.live = true
        s.x = 240 + Math.random() * (this.W - 480)
        s.y = 100
        s.vx = (Math.random() - 0.5) * 60
        s.vy = 0
      }
      return
    }
    s.vy += 1250 * dt
    s.x += s.vx * dt
    s.y += s.vy * dt
    if (s.x < 40 || s.x > this.W - 40) {
      s.x = Math.max(40, Math.min(this.W - 40, s.x))
      s.vx *= -0.6
    }
    // 脚速（帧间差分，归一化单位/秒）
    const b0 = f.bodies[0] ?? null
    let footV = 0
    if (b0 && this.prevFeet) {
      footV = Math.hypot(b0.lFoot.x - this.prevFeet.l, b0.lFoot.y - this.prevFeet.r) / Math.max(0.016, dt)
    }
    if (b0) this.prevFeet = { l: b0.lFoot.x, r: b0.lFoot.y }

    const limbs: { x: number; y: number; v: number }[] = []
    for (const b of f.bodies) {
      limbs.push(
        { x: b.lHand.x * this.W, y: b.lHand.y * this.H, v: b.lHandV },
        { x: b.rHand.x * this.W, y: b.rHand.y * this.H, v: b.rHandV },
        { x: b.lFoot.x * this.W, y: b.lFoot.y * this.H, v: footV },
        { x: b.rFoot.x * this.W, y: b.rFoot.y * this.H, v: footV },
      )
    }
    for (const l of limbs) {
      if (s.vy > -50 && Math.hypot(l.x - s.x, l.y - s.y) < 62) {
        const power = 700 + Math.min(700, l.v * 500)
        s.vy = -power
        s.vx = ((s.x - l.x) / 62) * 180 + (Math.random() - 0.5) * 80
        this.combo++
        this.throws++
        const gain = 8 + Math.min(20, this.combo * 2)
        this.score += gain
        this.ctx.setCombo(this.combo)
        this.ctx.setExtra('best', this.combo)
        this.ctx.audio.tonePop(this.combo % 4)
        this.particles.burst(s.x, s.y, this.theme.color, 6, 200, 4)
        if (this.combo % 10 === 0) {
          this.ctx.audio.good()
          this.say(`${this.combo} 个！`, this.W / 2, 220, '#ffd54a', 46)
        }
        break
      }
    }
    if (s.y > FLOOR) {
      s.live = false
      this.serveT = 0.8
      this.ctx.audio.fail()
      if (this.combo >= 5) this.say('落地啦', s.x, FLOOR - 60, '#ff9f9f', 38)
      this.combo = 0
      this.ctx.setCombo(0)
    }
  }

  // ---------- skip：打水漂 ----------
  private tickSkip(b: Body | null, dt: number) {
    if (!this.stone.live) {
      if (b && this.cool <= 0) {
        const h = this.fastHand(b)
        if (h.y > this.H * 0.5 && h.v > 0.7) {
          this.cool = 1.2
          this.throws++
          this.stones--
          this.stone.live = true
          this.stone.x = Math.max(120, h.x)
          this.stone.vx = Math.min(1500, 550 + h.v * 1000)
          this.skips = 0
          this.stone.hopT = 0
          this.ctx.setExtra('stones', this.stones)
        }
      }
      return
    }
    const prevX = this.stone.x
    this.stone.x += this.stone.vx * dt
    this.stone.hopT -= dt
    if (this.stone.hopT <= 0) {
      this.skips++
      this.score += 6 + this.skips * 2
      this.ctx.audio.pop()
      this.particles.burst(this.stone.x, 500, '#9fd8ff', 5, 180, 4, 300)
      this.stone.vx *= 0.86
      this.stone.hopT = Math.max(0.12, this.stone.vx / 750)
    }
    for (const rg of this.rings) {
      if (!rg.got && prevX < rg.x && this.stone.x >= rg.x) {
        rg.got = true
        this.score += 15
        this.combo++
        this.ctx.setCombo(this.combo)
        this.ctx.audio.good()
        this.say('穿环 +15', rg.x, 380, '#3ddc97', 36)
      }
    }
    if (this.stone.vx < 260 || this.stone.x > this.W - 40) {
      this.stone.live = false
      const dist = Math.round((this.stone.x - 120) / 90)
      this.bestDist = Math.max(this.bestDist, dist)
      this.ctx.setExtra('best', this.bestDist)
      this.say(`${this.skips} 跳 · ${dist} 米`, this.W / 2, 300, this.skips >= 4 ? '#ffd54a' : '#fff', 44)
      if (this.stones <= 0) this.ctx.finish()
      else for (const rg of this.rings) rg.got = false
    }
  }

  // ================= 绘制 =================

  paint(c: CanvasRenderingContext2D) {
    switch (this.rule) {
      case 'throw': this.paintThrow(c); break
      case 'precision': this.paintPrecision(c); break
      case 'bowling': this.paintBowling(c); break
      case 'soccer': this.paintSoccer(c); break
      case 'keeper': this.paintKeeper(c); break
      case 'rally': this.paintRally(c); break
      case 'keepup': this.paintKeepup(c); break
      case 'skip': this.paintSkip(c); break
    }
    txt(c, this.theme.hint, this.W / 2, this.H - 30, 20, 'rgba(255,255,255,.82)', 'center', 'bold')
  }

  private paintThrow(c: CanvasRenderingContext2D) {
    const { x, y, r } = this.target
    const t = this.theme
    if (t.kind === 'dog') {
      // 目标圈
      glow(c, x, y, r * 2, t.color, 0.3)
      c.strokeStyle = t.color
      c.lineWidth = 10
      c.beginPath()
      c.ellipse(x, y, r, r * 0.75, 0, 0, Math.PI * 2)
      c.stroke()
      txt(c, '🐕', x, y + 6, 62)
      outlineTxt(c, '小狗', x, y + r + 34, 22, '#fff')
    } else {
      glow(c, x, y, r * 2, t.color, 0.25)
      c.strokeStyle = t.color
      c.lineWidth = 8
      c.beginPath()
      c.ellipse(x, y, r, r * 0.34, 0, 0, Math.PI * 2)
      c.stroke()
      c.strokeStyle = 'rgba(255,255,255,.75)'
      c.lineWidth = 3
      for (let i = -3; i <= 3; i++) {
        c.beginPath()
        c.moveTo(x + i * (r / 3.4), y)
        c.lineTo(x + i * (r / 6), y + r * 0.62)
        c.stroke()
      }
      c.fillStyle = 'rgba(255,255,255,.85)'
      c.beginPath()
      c.roundRect(x - r * 1.35, y - r * 1.1, r * 2.7, r * 0.9, 8)
      c.fill()
    }
    for (const bl of this.balls) {
      c.save()
      c.translate(bl.x, bl.y)
      c.rotate(bl.spin)
      const pic = t.kind === 'dog' ? 'frisbee' : 'basketball'
      if (!drawItem(c, pic, 0, 0, bl.r * 2.5)) circle(c, 0, 0, bl.r, t.color)
      c.restore()
    }
    const acc = this.throws ? Math.round((this.hits / this.throws) * 100) : 0
    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(24, 24, 200, 52, 26)
    c.fill()
    outlineTxt(c, `命中 ${this.hits}${this.throws > 3 ? ` · ${acc}%` : ''}`, 124, 50, 24, '#ffd54a')
    if (this.combo >= 2) {
      c.fillStyle = 'rgba(10,14,40,.42)'
      c.beginPath()
      c.roundRect(this.W / 2 - 105, 24, 210, 52, 26)
      c.fill()
      outlineTxt(c, `连中 ${this.combo}`, this.W / 2, 50, 26, '#ffd54a')
    }
    const ready = this.cool <= 0
    ring(c, this.W - 70, this.H - 70, 26, ready ? 1 : 1 - this.cool / 0.78, ready ? '#3ddc97' : 'rgba(255,255,255,.5)', 7)
    txt(c, ready ? '可以投' : '等一下', this.W - 70, this.H - 32, 13, 'rgba(255,255,255,.85)', 'center', 'bold')
  }

  private paintPrecision(c: CanvasRenderingContext2D) {
    const cx = 640
    const cy = 270
    const r = 130
    glow(c, cx, cy, r * 1.8, this.theme.color, 0.22)
    for (let i = 5; i >= 1; i--) {
      c.beginPath()
      c.arc(cx, cy, (r * i) / 5, 0, Math.PI * 2)
      c.fillStyle = i % 2 === 0 ? '#f7f9ff' : this.theme.color
      c.fill()
    }
    circle(c, cx, cy, r * 0.1, '#ffd54a')
    // 分值标注
    txt(c, '50', cx, cy, 18, '#7a2e2e', 'center', 'bold')
    txt(c, '30', cx, cy - 62, 15, '#fff', 'center', 'bold')
    txt(c, '20', cx, cy - 96, 14, '#fff', 'center', 'bold')
    // 插着的镖
    for (const d of this.darts) {
      c.globalAlpha = Math.min(1, d.life)
      circle(c, d.x, d.y, 7, d.pts >= 30 ? '#3ddc97' : d.pts > 0 ? '#ffd54a' : '#ff8fa3')
      c.globalAlpha = 1
    }
    // 准星
    const a = this.aim
    const steady = a.wob < 45
    c.strokeStyle = steady ? '#3ddc97' : 'rgba(255,255,255,.85)'
    c.lineWidth = 3
    c.beginPath()
    c.arc(a.x, a.y, a.wob, 0, Math.PI * 2)
    c.stroke()
    c.beginPath()
    c.moveTo(a.x - 14, a.y)
    c.lineTo(a.x + 14, a.y)
    c.moveTo(a.x, a.y - 14)
    c.lineTo(a.x, a.y + 14)
    c.strokeStyle = steady ? '#3ddc97' : '#ff5c5c'
    c.lineWidth = 3
    c.stroke()
    outlineTxt(c, steady ? '稳住了，甩出去！' : '手稳住，准星会收拢', this.W / 2, 100, 34, steady ? '#b6ffdd' : '#fff')
    // 剩余箭数
    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(24, 24, 210, 52, 26)
    c.fill()
    outlineTxt(c, `还剩 ${this.shotsLeft} ${this.theme.label === '射箭' ? '箭' : '镖'}`, 129, 50, 26, '#ffd54a')
  }

  private paintBowling(c: CanvasRenderingContext2D) {
    // 球道
    const floorY = 600
    c.fillStyle = 'rgba(255,224,178,.12)'
    c.fillRect(0, floorY - 130, this.W, 130)
    c.strokeStyle = 'rgba(255,255,255,.25)'
    c.lineWidth = 2
    for (let i = 0; i < 8; i++) {
      const x = 60 + i * 160
      c.beginPath()
      c.moveTo(x, floorY - 130)
      c.lineTo(x + 30, floorY)
      c.stroke()
    }
    c.strokeStyle = 'rgba(255,255,255,.5)'
    c.beginPath()
    c.moveTo(0, floorY)
    c.lineTo(this.W, floorY)
    c.stroke()
    // 瓶
    for (const p of this.pins) {
      c.save()
      c.translate(p.x, p.y)
      if (p.hit) {
        c.rotate(p.fall * 1.5)
        c.globalAlpha = 1 - p.fall * 0.5
      }
      c.fillStyle = '#fff'
      c.beginPath()
      c.ellipse(0, -22, 11, 26, 0, 0, Math.PI * 2)
      c.fill()
      c.strokeStyle = this.theme.color
      c.lineWidth = 3
      c.beginPath()
      c.arc(0, -34, 6, 0, Math.PI * 2)
      c.stroke()
      c.restore()
      c.globalAlpha = 1
    }
    // 球
    if (this.bBall.rolling) {
      if (!drawItem(c, 'bowling', this.bBall.x, floorY - 18, 46)) {
        circle(c, this.bBall.x, floorY - 18, 20, '#4a4a5c')
        circle(c, this.bBall.x - 6, floorY - 24, 6, 'rgba(255,255,255,.4)')
      }
    }
    // 计分板
    c.fillStyle = 'rgba(10,14,40,.45)'
    c.beginPath()
    c.roundRect(24, 24, 300, 88, 26)
    c.fill()
    outlineTxt(c, `第 ${Math.min(5, this.frame + 1)} 轮 · 第 ${this.ball} 球`, 174, 50, 24, '#fff')
    outlineTxt(c, `倒了 ${this.pins.filter((p) => p.hit).length} / 10`, 174, 88, 24, '#ffd54a')
    if (this.resetT > 0) {
      const down = this.pins.filter((p) => p.hit).length
      if (down === 10 && this.ball === 1) outlineTxt(c, 'STRIKE!', this.W / 2, 200, 60, '#ffd54a')
    }
  }

  private paintSoccer(c: CanvasRenderingContext2D) {
    // 球门（右侧）
    const gx = 960
    const gy0 = 250
    const gy1 = 550
    c.strokeStyle = 'rgba(255,255,255,.9)'
    c.lineWidth = 10
    c.beginPath()
    c.moveTo(gx, gy0 - 20)
    c.lineTo(gx, gy1 + 20)
    c.lineTo(gx + 220, gy1 + 20)
    c.moveTo(gx, gy1 + 20)
    c.lineTo(gx - 60, gy1 + 20)
    c.stroke()
    c.strokeStyle = 'rgba(255,255,255,.22)'
    c.lineWidth = 2
    for (let i = 1; i < 10; i++) {
      c.beginPath()
      c.moveTo(gx + i * 22, gy0 - 10)
      c.lineTo(gx + i * 22, gy1 + 14)
      c.stroke()
    }
    // 死角区提示
    c.strokeStyle = 'rgba(255,212,74,.5)'
    c.setLineDash([8, 8])
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(gx + 10, gy0 + 40)
    c.lineTo(gx + 200, gy0 + 40)
    c.moveTo(gx + 10, gy1 - 40)
    c.lineTo(gx + 200, gy1 - 40)
    c.stroke()
    c.setLineDash([])
    outlineTxt(c, '死角 +25', gx + 130, gy0 + 14, 18, '#ffd54acc')
    // 守门员
    const kx = gx + 110
    glow(c, kx, this.keeperY, 90, '#ffb703', 0.4)
    circle(c, kx - 40, this.keeperY, 26, '#ff8fa3')
    circle(c, kx + 40, this.keeperY, 26, '#ff8fa3')
    circle(c, kx, this.keeperY, 34, '#ffb703')
    txt(c, '🧤', kx - 40, this.keeperY, 30)
    txt(c, '🧤', kx + 40, this.keeperY, 30)
    // 球
    let bx = 300
    let by = FLOOR - 60
    let r = 26
    if (this.sBall.flying) {
      const p = this.sBall.t
      bx = this.sBall.x + (this.sBall.tx - this.sBall.x) * p
      by = this.sBall.y + (this.sBall.ty - this.sBall.y) * p
      r = 26 - p * 8
      if (!drawItem(c, 'soccer', bx, by, r * 2)) circle(c, bx, by, r, '#fff')
    } else {
      if (!drawItem(c, 'soccer', bx, by, r * 2)) circle(c, bx, by, r, '#fff')
    }
    // 进球数
    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(24, 24, 200, 52, 26)
    c.fill()
    outlineTxt(c, `进球 ${this.goals}`, 124, 50, 26, '#ffd54a')
    outlineTxt(c, this.sBall.flying ? '……' : '抬脚踢！', 300, FLOOR - 140, 30, '#fff')
  }

  private paintKeeper(c: CanvasRenderingContext2D) {
    // 球门（左侧）
    const gx = 300
    c.strokeStyle = 'rgba(255,255,255,.9)'
    c.lineWidth = 10
    c.beginPath()
    c.moveTo(gx, 200)
    c.lineTo(gx, 620)
    c.stroke()
    c.strokeStyle = 'rgba(255,255,255,.2)'
    c.lineWidth = 2
    for (let i = 0; i < 6; i++) {
      c.beginPath()
      c.moveTo(gx - i * 40, 200)
      c.lineTo(gx - i * 40, 620)
      c.stroke()
    }
    for (let i = 0; i < 7; i++) {
      c.beginPath()
      c.moveTo(gx - 200, 200 + i * 70)
      c.lineTo(gx, 200 + i * 70)
      c.stroke()
    }
    // 飞来的球
    for (const ib of this.incoming) {
      const bx = ib.tx + (this.W - 80 - ib.tx) * Math.max(0, 1 - ib.t)
      // 落点提示
      if (!ib.saved && ib.t < 0.7) {
        c.strokeStyle = 'rgba(255,90,90,.8)'
        c.lineWidth = 4
        c.setLineDash([10, 8])
        c.beginPath()
        c.ellipse(ib.tx, ib.ty, 44, 16, 0, 0, Math.PI * 2)
        c.stroke()
        c.setLineDash([])
      }
      if (ib.saved && ib.t > 1) continue
      if (!drawItem(c, 'soccer', bx, ib.y, 52)) circle(c, bx, ib.y, 26, '#fff')
    }
    // 手套（跟手）
    const b = this.players[0].body
    if (b) {
      for (const h of [b.lHand, b.rHand]) {
        const x = h.x * this.W
        const y = h.y * this.H
        glow(c, x, y, 50, '#ffb703', 0.4)
        txt(c, '🧤', x, y, 44)
      }
    }
    // 命
    for (let i = 0; i < 3; i++) {
      txt(c, i < this.hearts ? '❤️' : '🤍', this.W - 150 + i * 56, 56, 34)
    }
    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(24, 24, 220, 52, 26)
    c.fill()
    outlineTxt(c, `扑出 ${this.saves}`, 134, 50, 26, '#ffd54a')
  }

  private paintRally(c: CanvasRenderingContext2D) {
    const netX = this.W / 2
    const topY = this.theme.flat ? 330 : 260
    // 场地
    c.strokeStyle = 'rgba(255,255,255,.35)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(0, FLOOR)
    c.lineTo(this.W, FLOOR)
    c.stroke()
    // 网
    c.strokeStyle = 'rgba(255,255,255,.8)'
    c.lineWidth = 5
    c.beginPath()
    c.moveTo(netX, FLOOR)
    c.lineTo(netX, topY)
    c.stroke()
    c.strokeStyle = 'rgba(255,255,255,.25)'
    c.lineWidth = 2
    for (let y = topY + 20; y < FLOOR; y += 26) {
      c.beginPath()
      c.moveTo(netX - 30, y)
      c.lineTo(netX, y - 8)
      c.lineTo(netX + 30, y)
      c.stroke()
    }
    // 电脑拍子
    const rb = this.rBall
    if (rb.live) txt(c, '🤖', netX - 170, Math.max(topY + 60, Math.min(FLOOR - 60, rb.y)), 56)
    // 球
    if (rb.live) {
      glow(c, rb.x, rb.y, 44, this.theme.color, 0.5)
      const pic = this.theme.flat ? 'tennis' : this.ctx.meta.slug === 'volley' ? 'volleyball' : 'tennis'
      if (!drawItem(c, pic, rb.x, rb.y, 48)) circle(c, rb.x, rb.y, 20, this.theme.color)
    } else {
      outlineTxt(c, '准备…', netX, 200, 40, '#ffffffcc')
    }
    // 回合数
    if (this.rally >= 2) {
      outlineTxt(c, `${this.rally} 回合`, this.W / 2, 90, 48, '#ffd54a')
    }
    if (this.hits > 0) {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(24, 24, 220, 52, 26)
      c.fill()
      outlineTxt(c, `得分 ${this.hits}`, 134, 50, 26, '#ffd54a')
    }
  }

  private paintKeepup(c: CanvasRenderingContext2D) {
    const s = this.shuttle
    // 地面
    c.strokeStyle = 'rgba(255,255,255,.3)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(0, FLOOR)
    c.lineTo(this.W, FLOOR)
    c.stroke()
    if (s.live) {
      // 高度记录线
      if (s.y < 400) {
        c.strokeStyle = 'rgba(255,212,74,.5)'
        c.setLineDash([8, 8])
        c.lineWidth = 2
        c.beginPath()
        c.moveTo(0, s.y - 140)
        c.lineTo(this.W, s.y - 140)
        c.stroke()
        c.setLineDash([])
      }
      glow(c, s.x, s.y, 50, this.theme.color, 0.45)
      // 毽子：羽毛 + 底座
      c.save()
      c.translate(s.x, s.y)
      c.rotate(Math.sin(this.t * 6) * 0.15)
      for (let i = -1; i <= 1; i++) {
        c.beginPath()
        c.ellipse(i * 10, -16, 6, 16, i * 0.3, 0, Math.PI * 2)
        c.fillStyle = i === 0 ? '#fff' : this.theme.color
        c.fill()
      }
      circle(c, 0, 8, 9, '#e8e0c8')
      c.restore()
    } else {
      outlineTxt(c, '准备好了…', this.W / 2, 300, 40, '#ffffffcc')
    }
    if (this.combo >= 2) outlineTxt(c, `${this.combo} 个`, this.W / 2, 90, 48, '#ffd54a')
  }

  private paintSkip(c: CanvasRenderingContext2D) {
    const water = 520
    // 水
    const g = c.createLinearGradient(0, water, 0, this.H)
    g.addColorStop(0, 'rgba(76,160,255,.35)')
    g.addColorStop(1, 'rgba(30,80,180,.5)')
    c.fillStyle = g
    c.fillRect(0, water, this.W, this.H - water)
    c.strokeStyle = 'rgba(255,255,255,.4)'
    c.lineWidth = 3
    for (let row = 0; row < 3; row++) {
      c.beginPath()
      for (let x = 0; x <= this.W; x += 36) {
        const y = water + 16 + row * 26 + Math.sin(x / 50 + this.t * 2.2 + row * 1.7) * 5
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y)
      }
      c.stroke()
    }
    // 环
    for (const rg of this.rings) {
      c.strokeStyle = rg.got ? 'rgba(61,220,151,.9)' : 'rgba(255,255,255,.75)'
      c.lineWidth = 7
      c.beginPath()
      c.ellipse(rg.x, water - 26, 30, 34, 0, 0, Math.PI * 2)
      c.stroke()
      if (rg.got) txt(c, '✓', rg.x, water - 26, 26, '#3ddc97', 'center', 'bold')
    }
    // 石头
    if (this.stone.live) {
      const hopP = 1 - this.stone.hopT / Math.max(0.12, this.stone.vx / 750)
      const hopH = 26 * (this.stone.vx / 1500)
      const y = water - 10 - Math.sin(Math.max(0, Math.min(1, hopP)) * Math.PI) * hopH
      circle(c, this.stone.x, y, 10, '#c9ced6')
      // 水痕
      c.strokeStyle = 'rgba(255,255,255,.35)'
      c.lineWidth = 2
      c.beginPath()
      c.moveTo(this.stone.x - 60, water)
      c.lineTo(this.stone.x - 10, water)
      c.stroke()
    }
    // 计数
    c.fillStyle = 'rgba(10,14,40,.45)'
    c.beginPath()
    c.roundRect(24, 24, 320, 52, 26)
    c.fill()
    outlineTxt(c, `第 ${this.skips} 跳 · 还剩 ${this.stones} 块石头`, 184, 50, 24, '#ffd54a')
    if (this.bestDist > 0) {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(this.W - 244, 24, 220, 52, 26)
      c.fill()
      outlineTxt(c, `最远 ${this.bestDist} 米`, this.W - 134, 50, 24, '#fff')
    }
  }
}

export default function create(ctx: GameContext) {
  return new AimGame(ctx)
}
