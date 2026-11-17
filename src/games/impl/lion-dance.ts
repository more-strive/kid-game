import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, txt } from '@/core/draw'

/**
 * 舞狮（对齐 dongdongpark 真实规则）：
 * 双人体感节奏合作——狮头位（玩家 0）管举手/歪头/蹲，狮身位（玩家 1）管站蹲/跳；
 * 动作牌沿车道滚到大鼓上，牌压到鼓的那一拍（窗口 [t−early, t+late]）两人一起做对应动作；
 * 头漏做时只有"体术类"（body≠stand）的身体单独命中也给 1 分；两人同分；
 * 默契连击每 5 次横幅庆祝；单人时狮身由电脑延迟一拍跟随。
 */

/** 难度表 v：BPM / 拍每动作 / 提前判定(s) / 延后判定(s) / 举手阈值 / 体蹲阈值 / 头蹲阈值 / 歪头阈值 / 摇头分方向 / 动作池 */
const DIFF = [
  { bpm: 104, every: 4, early: 0.4, late: 0.5, up: 0.4, squat: 0.35, headSquat: 0.3, lean: 0.35, dir: false, moves: ['rise', 'crouch', 'shake', 'leap'] },
  { bpm: 112, every: 4, early: 0.3, late: 0.4, up: 0.5, squat: 0.4, headSquat: 0.3, lean: 0.4, dir: false, moves: ['rise', 'crouch', 'shake', 'leap', 'peek'] },
  { bpm: 126, every: 4, early: 0.25, late: 0.35, up: 0.55, squat: 0.45, headSquat: 0.35, lean: 0.45, dir: true, moves: ['rise', 'crouch', 'shake', 'leap', 'peek', 'lowShake'] },
]
const COUNT_IN = 1.2 // Beat 的 countIn（站点 y，推断值）
const FIRST_BEAT = 4 // 首个动作所在拍号（站点 b）
const STAND_T = 0.25 // 站立判定阈值：squat < 0.25（站点 x）
const HYST = { up: 0.2, squat: 0.12, lean: 0.15 } // 姿态保持滞回量（站点 S）：已保持时阈值下调防抖
const DURATION = 75 // catalog duration（站点 P）
const TAIL_LAG = 1 // 电脑狮尾延迟（拍）

/** 动作表 g：head/body 该座位要做的姿态、抽签权重 */
const MOVES: Record<string, { name: string; head: Pose; body: Pose; weight: number }> = {
  rise: { name: '抬头', head: 'up', body: 'stand', weight: 3 },
  crouch: { name: '伏身', head: 'squat', body: 'squat', weight: 3 },
  shake: { name: '摇头', head: 'lean', body: 'stand', weight: 3 },
  leap: { name: '跳跃', head: 'jump', body: 'jump', weight: 2 },
  peek: { name: '探头', head: 'up', body: 'squat', weight: 2 },
  lowShake: { name: '伏身摇头', head: 'lean', body: 'squat', weight: 2 },
}

type Pose = 'up' | 'squat' | 'lean' | 'jump' | 'stand'
/** 座位姿态：lean 为不分方向（dir=0 两侧皆可），leanL/leanR 为分方向命中 */
type SeatPose = 'up' | 'squat' | 'lean' | 'leanL' | 'leanR' | 'jump' | 'stand'

interface Note {
  t: number
  beat: number
  id: string
  name: string
  headPose: Pose
  bodyPose: Pose
  dir: number // lean 方向：-1/1 分向（hard），0 两侧皆可
  done: boolean
  headHit: boolean
  bodyHit: boolean
  headAt: number
  bodyAt: number
  said: boolean
}

/** 每座位姿态检测状态（滞回 + 进入时刻 since） */
interface SeatState {
  on: { up: boolean; squat: boolean; leanL: boolean; leanR: boolean; stand: boolean }
  since: { up: number; squat: number; leanL: number; leanR: number; stand: number }
  jumping: boolean
  armLift: number
  leanMag: number
  squat: number
}

function newSeat(): SeatState {
  return {
    on: { up: false, squat: false, leanL: false, leanR: false, stand: true },
    since: { up: 0, squat: 0, leanL: 0, leanR: 0, stand: 0 },
    jumping: false,
    armLift: 0,
    leanMag: 0,
    squat: 0,
  }
}

/** 蹲深 0~1（等价代理，见 musical-chairs 注释） */
function squatDepth(b: Body) {
  const shY = (b.lm[11].y + b.lm[12].y) / 2
  const hipY = (b.lm[23].y + b.lm[24].y) / 2
  const ankY = (b.lm[27].y + b.lm[28].y) / 2
  const span = Math.max(0.06, Math.abs(ankY - shY))
  return Math.max(0, Math.min(1, 1 - Math.max(0, ankY - hipY) / (0.45 * span)))
}

class LionDance extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  period = 60 / 112
  seq: Note[] = []
  seats = [newSeat(), newSeat()]
  /** 结算浮标（打勾/打叉跟随座位 0.9s） */
  marks: { seat: number; ok: boolean; t0: number; x: number; y: number }[] = []
  /** 电脑狮尾结算队列（单人：延迟一拍模仿体术） */
  tailQ: { t: number; pose: Pose }[] = []
  tailPose: Pose = 'stand'
  tailJumpV = 0
  tailJumpY = 0
  score = 0
  /** 默契统计：同步数 W / 连击 H / 最长 U / 双人全中数 G */
  sync = 0
  judged = 0
  combo = 0
  bestCombo = 0
  fullN = 0
  seatHits = [0, 0]
  deltas: number[] = []
  saidTypes = new Set<string>() // medium/hard 每种动作只播报第一次（站点 R）
  lastDrumBeat = -1
  drumGlow = 0
  blinkAt = 0
  blinkNext = 3
  moodQ = 0 // 困惑表情（狮头漏做）

  constructor(ctx: GameContext) {
    super(ctx)
    this.period = 60 / this.cfg.bpm
    this.genSeq()
  }

  /** 序列生成：前 4 个固定 [rise,crouch,shake,leap]，之后加权随机；终止 timeOf+late > 75−0.6 */
  private genSeq() {
    this.seq = []
    const order = ['rise', 'crouch', 'shake', 'leap']
    let i = 0
    let prev: Note | null = null
    for (; ; i++) {
      const beat = FIRST_BEAT + i * this.cfg.every
      const t = COUNT_IN + beat * this.period
      if (t + this.cfg.late > DURATION - 0.6) break
      let id: string
      if (i < 4) id = order[i]
      else {
        const pool = this.cfg.moves.filter((m) => {
          if (prev && m === prev.id) return false
          if (prev && MOVES[prev.id].body === 'squat' && m === 'leap') return false
          return true
        })
        const total = pool.reduce((a, m) => a + MOVES[m].weight, 0)
        let r = Math.random() * total
        id = pool[0]
        for (const m of pool) {
          r -= MOVES[m].weight
          if (r <= 0) {
            id = m
            break
          }
        }
      }
      const mv = MOVES[id]
      const dir = this.cfg.dir && mv.head === 'lean' ? (Math.random() < 0.5 ? -1 : 1) : 0
      const note: Note = {
        t,
        beat,
        id,
        name: mv.name,
        headPose: mv.head,
        bodyPose: mv.body,
        dir,
        done: false,
        headHit: false,
        bodyHit: false,
        headAt: 0,
        bodyAt: 0,
        said: false,
      }
      this.seq.push(note)
      prev = note
    }
  }

  private poseOfSeat(note: Note, seat: 0 | 1): SeatPose {
    const p = seat === 0 ? note.headPose : note.bodyPose
    if (p === 'lean') return note.dir < 0 ? 'leanL' : note.dir > 0 ? 'leanR' : 'lean'
    return p
  }

  /** 该座位某姿态是否保持中（'lean' 不分方向：任一侧歪都算） */
  private heldOf(si: 0 | 1, pose: SeatPose): boolean {
    const o = this.seats[si].on
    if (pose === 'up') return o.up
    if (pose === 'squat') return o.squat
    if (pose === 'leanL') return o.leanL
    if (pose === 'leanR') return o.leanR
    if (pose === 'lean') return o.leanL || o.leanR
    if (pose === 'stand') return o.stand
    return false
  }

  /** 该座位某姿态的进入时刻（jump/stand 无保持语义 → 返回当前时刻） */
  private sinceOf(si: 0 | 1, pose: SeatPose): number {
    const s = this.seats[si].since
    if (pose === 'up') return s.up
    if (pose === 'squat') return s.squat
    if (pose === 'leanL') return s.leanL
    if (pose === 'leanR') return s.leanR
    if (pose === 'lean') return Math.max(s.leanL, s.leanR)
    return this.t
  }

  /** 姿态检测（站点 Z）：阈值 + 滞回 + since 进入时刻 */
  private updateSeat(si: 0 | 1, b: Body, t: number) {
    const st = this.seats[si]
    const span = Math.max(0.1, b.scale)
    // armLift 等价代理：高手到肩中的竖距 / span（0~1）
    const handY = Math.min(b.lHand.y, b.rHand.y)
    const lift = Math.max(0, Math.min(1, (b.shoulderC.y - handY) / span))
    st.armLift = lift
    // lean 等价代理：双肩高度差 / span，方向 = 低肩侧
    const dy = (b.lShoulder.y - b.rShoulder.y) / span
    st.leanMag = Math.abs(dy)
    const leanDir = dy > 0 ? -1 : 1 // lShoulder 更低（y 更大）→ leanL(-1)
    st.squat = squatDepth(b)
    st.jumping = b.jumping

    const upTh = this.cfg.up - (st.on.up ? HYST.up : 0)
    if (!st.on.up && lift > upTh) {
      st.on.up = true
      st.since.up = t
    } else if (st.on.up && lift < this.cfg.up - HYST.up) st.on.up = false

    const sqTh = (si === 0 ? this.cfg.headSquat : this.cfg.squat) - (st.on.squat ? HYST.squat : 0)
    if (!st.on.squat && st.squat > sqTh) {
      st.on.squat = true
      st.since.squat = t
    } else if (st.on.squat && st.squat <= (si === 0 ? this.cfg.headSquat : this.cfg.squat) - HYST.squat) st.on.squat = false

    const leanTh = this.cfg.lean - (st.on.leanL || st.on.leanR ? HYST.lean : 0)
    if (!st.on.leanL && leanDir < 0 && st.leanMag > leanTh) {
      st.on.leanL = true
      st.on.leanR = false
      st.since.leanL = t
    } else if (!st.on.leanR && leanDir > 0 && st.leanMag > leanTh) {
      st.on.leanR = true
      st.on.leanL = false
      st.since.leanR = t
    } else if (st.leanMag <= this.cfg.lean - HYST.lean) {
      st.on.leanL = false
      st.on.leanR = false
    }

    const stand = st.squat < STAND_T
    if (stand && !st.on.stand) {
      st.on.stand = true
      st.since.stand = t
    } else if (!stand) st.on.stand = false
  }

  /** 命中判定（站点 ee）：窗口 [note.t−early, note.t+late]，全部命中或超时后强制结算 */
  private judge(note: Note, seat: 0 | 1, t: number): boolean {
    if (t < note.t - this.cfg.early) return false
    const st = this.seats[seat]
    const pose = this.poseOfSeat(note, seat)
    if (pose === 'jump') return st.jumping
    if (pose === 'stand') return st.on.stand
    // up / squat / lean：处于保持中；上一动作同姿态 → 须拍后重新做一次（since > 上一动作.t，防一直举着白拿）
    if (!this.heldOf(seat, pose)) return false
    const prev = this.seq[this.seq.indexOf(note) - 1] ?? null
    const prevPose = prev ? this.poseOfSeat(prev, seat) : null
    const samePose = prevPose === pose && (pose !== 'lean' || note.dir === 0 || (prev as Note).dir === note.dir)
    if (samePose && this.sinceOf(seat, pose) <= (prev as Note).t) return false
    return true
  }

  /** 结算（站点 ne）：u 计算 + 同分 + 默契统计 + 音效 */
  private settle(note: Note, t: number, duo: boolean) {
    note.done = true
    const full = duo ? note.headHit && note.bodyHit : note.headHit
    let u: number
    if (duo) {
      u = note.headHit || (note.bodyHit && note.bodyPose !== 'stand') ? (note.headHit ? 1 : 0) + (note.bodyHit ? 1 : 0) : 0
    } else {
      u = note.headHit ? 2 : 0
    }
    this.score += u
    this.judged++
    if (full) {
      this.sync++
      this.fullN++
      this.combo++
      this.bestCombo = Math.max(this.bestCombo, this.combo)
      this.ctx.audio.good() // chime
      if (this.combo > 0 && this.combo % 5 === 0) {
        this.say(`${duo ? '默契' : '连对'} ×${this.combo}！`, this.W / 2, this.H * 0.2, '#ffd54a', 44)
        this.particles.burst(this.W / 2, this.H * 0.3, '#fff3b0', 16, 380, 5)
      }
    } else {
      this.combo = 0
      if (u > 0) this.ctx.audio.coin()
      else {
        this.ctx.audio.fail() // boop
        if (!duo) this.moodQ = 1.2 // 狮子 ？ 困惑表情 + 甩尾
      }
    }
    if (u > 0) {
      // 非站姿命中记录离鼓点偏差（毫秒）
      if (note.headHit && note.headPose !== 'stand') this.deltas.push(Math.abs(note.headAt - note.t) * 1000)
      if (duo && note.bodyHit && note.bodyPose !== 'stand') this.deltas.push(Math.abs(note.bodyAt - note.t) * 1000)
    }
    const label = u === 2 && duo ? `默契 +${u}` : `+${u}`
    const b = this.players[0].body
    const x = b ? b.shoulderC.x * this.W : this.W / 2
    if (u > 0) this.say(label, x, this.H * 0.32, '#ffd54a', 34)
    // 结算浮标：各自位置打勾/打叉
    const b1 = this.players[1].body
    this.marks.push({ seat: 0, ok: note.headHit, t0: t, x, y: this.H * 0.3 })
    if (duo && b1) this.marks.push({ seat: 1, ok: note.bodyHit, t0: t, x: b1.shoulderC.x * this.W, y: this.H * 0.3 })
    // 单人：电脑狮尾延迟一拍跟随做体术
    if (!duo && note.bodyPose !== 'stand') this.tailQ.push({ t: note.t + TAIL_LAG * this.period, pose: note.bodyPose })
  }

  tick(f: PoseFrame, dt: number) {
    const duo = f.bodies.length > 1
    for (let si = 0; si < 2; si++) {
      const b = f.bodies[si]
      if (!b) continue
      // 单人：玩家 0 = 狮头位；狮身位由电脑跟随（无真人输入）
      if (!duo && si === 1) continue
      this.updateSeat(si as 0 | 1, b, this.t)
    }

    // 电脑狮尾（单人）：从队列弹出体术动作
    if (!duo) {
      while (this.tailQ.length && this.t >= this.tailQ[0].t) {
        this.tailPose = this.tailQ.shift()!.pose
        if (this.tailPose === 'jump') {
          this.tailJumpV = 380 // 站点跳跃初速 6.3、重力 20（引擎单位），换算成像素速度
          this.ctx.audio.jump()
        }
      }
      if (this.tailJumpY > 0 || this.tailJumpV > 0) {
        this.tailJumpV -= 1200 * dt
        this.tailJumpY = Math.max(0, this.tailJumpY + this.tailJumpV * dt)
        if (this.tailJumpY <= 0 && this.tailJumpV < 0) {
          this.tailJumpY = 0
          this.tailJumpV = 0
        }
      }
    }

    // 语音播报：拍前 1.2s（站点 easy 每个动作都播，medium/hard 每种只播第一次）
    for (const note of this.seq) {
      if (!note.said && this.t >= note.t - 1.2 && this.t < note.t) {
        note.said = true
        if (this.ctx.difficulty === 0 || !this.saidTypes.has(note.id)) {
          this.saidTypes.add(note.id)
          this.ctx.speak(note.name)
        }
      }
      if (!note.done && !note.headHit) {
        const b0 = f.bodies[0]
        if (b0 && this.judge(note, 0, this.t)) {
          note.headHit = true
          this.seatHits[0]++
          // 命中时刻：同姿态重触发钳到窗起点；不同姿态=完美踩点
          const prev = this.seq[this.seq.indexOf(note) - 1] ?? null
          const prevPose = prev ? this.poseOfSeat(prev, 0) : null
          const pose = this.poseOfSeat(note, 0)
          note.headAt = pose === 'jump' ? this.t : prevPose === pose ? Math.max(this.sinceOf(0, pose), note.t - this.cfg.early) : note.t
        }
      }
      if (duo && !note.done && !note.bodyHit) {
        const b1 = f.bodies[1]
        if (b1 && this.judge(note, 1, this.t)) {
          note.bodyHit = true
          this.seatHits[1]++
          const prev = this.seq[this.seq.indexOf(note) - 1] ?? null
          const prevPose = prev ? this.poseOfSeat(prev, 1) : null
          const pose = this.poseOfSeat(note, 1)
          note.bodyAt = pose === 'jump' ? this.t : prevPose === pose ? Math.max(this.sinceOf(1, pose), note.t - this.cfg.early) : note.t
        }
      }
      // 全部角色命中（单人=狮头命中即结算）或超窗 → 强制结算
      const allHit = duo ? note.headHit && note.bodyHit : note.headHit
      if (!note.done && (allHit || this.t > note.t + this.cfg.late)) this.settle(note, this.t, duo)
    }

    // 鼓点分层：动作拍 drum(1.0)+crack；非动作拍 (拍−4)%4 → .8/.6/.4；反拍装饰 .35
    if (this.t >= COUNT_IN) {
      const beat = Math.floor((this.t - COUNT_IN) / this.period)
      if (beat !== this.lastDrumBeat) {
        this.lastDrumBeat = beat
        const isAction = beat >= FIRST_BEAT && (beat - FIRST_BEAT) % this.cfg.every === 0 && this.seq.some((n) => n.beat === beat)
        if (isAction) {
          this.ctx.audio.play('pop', 1, 0.75) // drum
          this.ctx.audio.play('hit', 0.5, 1.3) // crack
          this.drumGlow = 1
        } else {
          const k = (beat - FIRST_BEAT) % 4
          const gain = k === 0 ? 0.8 : k === 1 ? 0.6 : 0.4
          this.ctx.audio.play('tick', gain, 1)
          if (beat % 2 === 1) this.ctx.audio.play('tick', 0.35, 1.5) // 反拍装饰鼓
        }
      }
    }
    this.drumGlow = Math.max(0, this.drumGlow - dt * 3)
    this.moodQ = Math.max(0, this.moodQ - dt)

    // 结算浮标 0.9s
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (this.t - this.marks[i].t0 > 0.9) this.marks.splice(i, 1)
    }

    // 眨眼随机 2–5s
    this.blinkAt += dt
    if (this.blinkAt > this.blinkNext) {
      this.blinkAt = 0
      this.blinkNext = 2 + Math.random() * 3
    }

    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.combo)
    const acc = this.judged ? Math.round((this.sync / this.judged) * 100) : 0
    if (duo) {
      this.ctx.setExtra('默契', acc)
      this.ctx.setExtra('狮头做对', this.seatHits[0])
      this.ctx.setExtra('狮身做对', this.seatHits[1])
    } else {
      this.ctx.setExtra('准确率', acc)
    }
    this.ctx.setExtra('最长连对', this.bestCombo)
    if (this.deltas.length) {
      this.ctx.setExtra('离鼓点平均', Math.round(this.deltas.reduce((a, d) => a + d, 0) / this.deltas.length))
    }
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const duo = this.players.filter((p) => p.body).length > 1
    const drumX = this.W / 2
    const drumY = this.H * 0.62

    // 夜景灯笼 4 盏摇摆
    for (let i = 0; i < 4; i++) {
      const lx = this.W * (0.12 + i * 0.25)
      const sway = Math.sin(this.t * 1.4 + i * 1.7) * 14 * U
      c.save()
      c.translate(lx + sway, 60 * U)
      c.strokeStyle = 'rgba(255,220,150,.5)'
      c.lineWidth = 2
      c.beginPath()
      c.moveTo(0, -50 * U)
      c.lineTo(0, -18 * U)
      c.stroke()
      c.fillStyle = '#e5484d'
      c.beginPath()
      c.ellipse(0, 0, 22 * U, 26 * U, 0, 0, Math.PI * 2)
      c.fill()
      c.fillStyle = '#ffd166'
      rr(c, -8 * U, -24 * U, 16 * U, 6 * U, 3)
      c.fill()
      rr(c, -8 * U, 18 * U, 16 * U, 6 * U, 3)
      c.fill()
      c.restore()
    }

    // 鼓面泛黄光（窗开启前 0.15s）
    const nearNote = this.seq.find((n) => !n.done && n.t - this.t <= this.cfg.early + 0.15 && n.t - this.t > 0)
    if (nearNote) glow(c, drumX, drumY, 130 * U, '#ffe08a', 0.3)

    // 车道线
    c.save()
    c.strokeStyle = 'rgba(255,255,255,.3)'
    c.lineWidth = 3
    c.setLineDash([14, 14])
    c.beginPath()
    c.moveTo(0, drumY)
    c.lineTo(this.W, drumY)
    c.stroke()
    c.restore()

    // 大鼓
    c.save()
    c.translate(drumX, drumY)
    const pulse = 1 + 0.12 * this.drumGlow
    c.scale(pulse, pulse)
    circle(c, 0, 0, 56 * U, '#c0392b')
    circle(c, 0, 0, 46 * U, '#f6d55c')
    circle(c, 0, 0, 12 * U, '#8d5b34')
    txt(c, '咚', 0, 2 * U, 22 * U, '#7a4a1f')
    c.restore()

    // 动作牌（沿车道滚向鼓，进判定窗放大 1.12）
    for (const note of this.seq) {
      if (note.done) continue
      const dtToNote = note.t - this.t
      if (dtToNote > 4.5 || dtToNote < -this.cfg.late) continue
      const x = drumX + Math.max(0, dtToNote) * 340 * U
      const inWin = dtToNote <= this.cfg.early && dtToNote >= -this.cfg.late
      const scale = inWin ? 1.12 : 1
      c.save()
      c.translate(x, drumY - 110 * U)
      c.scale(scale, scale)
      const mv = MOVES[note.id]
      // 牌面上下两格：头位/体位（颜色=玩家色）
      rr(c, -52 * U, -46 * U, 104 * U, 44 * U, 10 * U)
      c.fillStyle = 'rgba(20,26,60,.78)'
      c.fill()
      c.strokeStyle = this.players[0].color
      c.lineWidth = 3
      c.stroke()
      rr(c, -52 * U, 2 * U, 104 * U, 44 * U, 10 * U)
      c.fillStyle = 'rgba(20,26,60,.78)'
      c.fill()
      c.strokeStyle = duo ? this.players[1].color : 'rgba(200,200,220,.6)'
      c.lineWidth = 3
      c.stroke()
      txt(c, `${poseLabel(mv.head)}${note.dir < 0 ? '←' : note.dir > 0 ? '→' : ''}`, 0, -24 * U, 22 * U, this.players[0].color)
      txt(c, duo ? poseLabel(mv.body) : `电脑：${poseLabel(mv.body)}`, 0, 24 * U, duo ? 22 * U : 16 * U, duo ? this.players[1].color : '#c9d4ff')
      c.restore()
    }

    // 狮子：头（玩家 0 上方）+ 身（duo 连到玩家 1 / solo 连到电脑狮尾）
    const b0 = this.players[0].body
    if (b0) {
      const hx = b0.shoulderC.x * this.W
      const hy = (b0.shoulderC.y - 0.18) * this.H - (this.seats[0].on.up ? 30 * U : 0)
      const seat1 = duo ? this.players[1].body : null
      const bx = seat1 ? seat1.shoulderC.x * this.W : hx + 190 * U
      const by = seat1 ? seat1.shoulderC.y * this.H : (b0.shoulderC.y + 0.22) * this.H + this.tailJumpY
      // 狮身（拱形）
      c.save()
      c.strokeStyle = '#f4a261'
      c.lineWidth = 42 * U
      c.lineCap = 'round'
      c.beginPath()
      c.moveTo(hx + 40 * U, hy + 60 * U)
      c.quadraticCurveTo((hx + bx) / 2, Math.min(hy, by) - 70 * U, bx, by)
      c.stroke()
      // 花纹
      c.strokeStyle = 'rgba(255,255,255,.5)'
      c.lineWidth = 6 * U
      for (let i = 1; i < 5; i++) {
        const q = i / 5
        const px2 = (1 - q) * (1 - q) * (hx + 40 * U) + 2 * (1 - q) * q * ((hx + bx) / 2) + q * q * bx
        const py2 = (1 - q) * (1 - q) * (hy + 60 * U) + 2 * (1 - q) * q * Math.min(hy, by) - 70 * U * 2 * (1 - q) * q + q * q * by
        c.beginPath()
        c.arc(px2, py2, 8 * U, 0, Math.PI * 2)
        c.stroke()
      }
      c.restore()
      // 狮头
      c.save()
      c.translate(hx, hy)
      circle(c, 0, 0, 52 * U, '#e76f51')
      // 眼（眨眼随机 2–5s）
      const blink = this.blinkAt < 0.12
      c.fillStyle = '#fff'
      circle(c, -18 * U, -10 * U, 12 * U, '#fff')
      circle(c, 18 * U, -10 * U, 12 * U, '#fff')
      if (!blink) {
        circle(c, -18 * U, -10 * U, 5.5 * U, '#222')
        circle(c, 18 * U, -10 * U, 5.5 * U, '#222')
      } else {
        c.strokeStyle = '#222'
        c.lineWidth = 3 * U
        c.beginPath()
        c.moveTo(-25 * U, -10 * U)
        c.lineTo(-11 * U, -10 * U)
        c.moveTo(11 * U, -10 * U)
        c.lineTo(25 * U, -10 * U)
        c.stroke()
      }
      // 嘴：开合随举手高度 + 鼓点 + 咬合
      const mouth = 8 * U + this.seats[0].armLift * 26 * U + this.drumGlow * 10 * U
      c.fillStyle = '#7a2f1d'
      c.beginPath()
      c.ellipse(0, 22 * U, 22 * U, mouth, 0, 0, Math.PI * 2)
      c.fill()
      // 困惑 ？
      if (this.moodQ > 0) {
        txt(c, '？', 40 * U, -44 * U, 34 * U, '#fff')
      }
      c.restore()
    }

    // 电脑狮尾标记（solo）
    if (!duo) {
      const b = this.players[0].body
      if (b) {
        const bx = b.shoulderC.x * this.W + 190 * U
        const by = (b.shoulderC.y + 0.22) * this.H - this.tailJumpY
        c.save()
        c.globalAlpha = 0.85
        circle(c, bx, by, 26 * U, '#c98a52')
        txt(c, `电脑·${poseLabel(this.tailPose)}`, bx, by - 40 * U, 16 * U, '#ffe8c2')
        c.restore()
      }
    }

    // 结算浮标（跟随各自位置 0.9s）
    for (const m of this.marks) {
      const age = this.t - m.t0
      const y = m.y - age * 120 * U
      c.save()
      c.globalAlpha = Math.max(0, 1 - age / 0.9)
      txt(c, m.ok ? '✔' : '✘', m.x + (m.seat === 0 ? -30 : 30) * U, y, 34 * U, m.ok ? '#3ddc97' : '#ff6b6b')
      c.restore()
    }

    // 顶部状态
    const next = this.seq.find((n) => !n.done)
    if (next) {
      outlineTxt(c, `${next.name}！`, this.W / 2, 48 * U, 40, '#ffd54a')
      txt(c, `狮头：${poseLabel(MOVES[next.id].head)}${duo ? `　狮身：${poseLabel(MOVES[next.id].body)}` : '　电脑管狮身'}`, this.W / 2, 82 * U, 20 * U, 'rgba(255,255,255,.85)')
    }
    txt(c, '牌压到鼓的那一拍一起做：头位举手/歪头/蹲，身位站蹲跳', this.W / 2, this.H - 28, 20, 'rgba(255,255,255,.8)', 'center', 'bold')
  }
}

/** 姿态中文标签 */
function poseLabel(p: Pose) {
  return p === 'up' ? '举手' : p === 'squat' ? '蹲下' : p === 'lean' ? '歪头' : p === 'jump' ? '跳跃' : '站直'
}

export default function create(ctx: GameContext) {
  return new LionDance(ctx)
}
