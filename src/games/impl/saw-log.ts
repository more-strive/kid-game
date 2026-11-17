import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, rr, star, txt } from '@/core/draw'

/**
 * 拉大锯（对齐 dongdongpark 真实规则）：
 * 双人合作体感拉锯——看大箭头方向一起来回拉（横向手部位移 ≥ amp 算一刀，每锯一下换一边）；
 * 双人齐拉（doneAt 差 ≤ sync）2 分、不齐 1 分；锯够 cuts 刀木头断落，一起举双手抛上房架
 * （双举 3 分/单举 1 分）；每 6 根木头盖好一座小木屋（+5 分），小动物搬进来；
 * 单人时右侧小熊为装饰性队友（陪拉不计分）。
 */

/** 难度表 se：计数幅度(torso 单位) / 每根木头刀数 / 同判容差(s) / 等待同伴上限(s) / 举手时限(s) */
const DIFF = [
  { amp: 0.4, cuts: 2, sync: 0.6, wait: 3, toss: 4.5 },
  { amp: 0.5, cuts: 3, sync: 0.45, wait: 3.5, toss: 4 },
  { amp: 0.6, cuts: 4, sync: 0.35, wait: 4, toss: 3.5 },
]
const REV = 0.12 // 拉动方向反转阈值 |Δd| > 0.12 才翻向（torso 单位）
const CUT_GAP = 0.22 // 同一玩家两次计刀最小间隔（s）
const FLY_T = 0.8 // 断木从锯架飞到房子的时长（s）
const POP_T = 0.45 // 房屋弹入动画时长（s）
const STAY_T = 2.6 // 成品屋停留展示时长（s）
const HOUSE_X = [0.2, 0.8, 0.07, 0.93, 0.33, 0.67] // 已建房屋落点（×W，6 个循环）
const CENTER_TAU = 2.5 // 玩家中心慢速跟随（s，防姿势漂移）
const SAW_TAU = 1 / 14 // 锯条位移平滑（s）
const WAIT_REMIND = 1.6 // 一人 done 后多久开始提醒（s）
const IDLE_T = 6 // 闲置提醒（6s 无团队刀）
const HOUSE_LOGS = 6 // 每座房子 6 根木头
const ANIMALS = ['小兔子', '小鸡', '小猪', '小猫']

type GState = 'saw' | 'toss' | 'fly' | 'house' | 'housefly'

/** 每玩家拉锯检测（滞后状态机：定向→行进→回撤翻向→计刀） */
class SawArm {
  center = NaN // 玩家中心（τ=2.5s 慢跟）
  disp = 0 // 锯向位移（torso 单位，平滑后）
  dir = 0 // 当前行进方向
  turn = 0 // 本段起点
  peak = 0 // 本方向峰值
  lastCut = -9
  done = false // 本轮已按箭头方向完成一刀
  doneAt = 0
  wrong = 0 // 反向刀计数
  wrongHintAt = -9
  up = false
  upPrev = false

  /** @returns dir（计刀方向）或 0（未计刀） */
  update(b: Body, amp: number, t: number, dt: number): number {
    const raw = ((b.lHand.x + b.rHand.x) / 2 - b.shoulderC.x) / Math.max(0.1, b.scale)
    if (!Number.isFinite(this.center)) this.center = raw
    this.center += (raw - this.center) * (1 - Math.exp(-dt / CENTER_TAU))
    const target = (raw - this.center) / (amp * 0.9)
    this.disp += (target - this.disp) * Math.min(1, dt / SAW_TAU)
    this.up = b.lHandAboveHead && b.rHandAboveHead // 双手腕均高于鼻尖

    const d = this.disp
    if (this.dir === 0) {
      if (Math.abs(d - this.turn) > REV) {
        this.dir = Math.sign(d - this.turn)
        this.peak = d
      }
      return 0
    }
    // 行进中更新峰值；回撤超过 REV → 翻向
    if ((this.peak - d) * this.dir > REV) {
      this.turn = this.peak
      this.dir = -this.dir as 1 | -1
      this.peak = d
      return 0
    }
    if ((d - this.peak) * this.dir > 0) this.peak = d
    // 计刀：该方向行程 ≥ amp 且距上次 ≥ 0.22s
    if ((this.peak - this.turn) * this.dir >= amp && t - this.lastCut >= CUT_GAP) {
      this.lastCut = t
      const out = this.dir
      this.turn = this.peak
      this.dir = 0
      return out
    }
    return 0
  }

  reset() {
    this.dir = 0
    this.turn = this.disp
    this.peak = this.disp
    this.done = false
  }
}

class SawLog extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[1]
  arms = [new SawArm(), new SawArm()]
  state: GState = 'saw'
  stateT = 0
  /** 箭头方向：0 未定向，±1 定向（每结算一次翻转） */
  O = 0
  A = 0 // 总计刀数
  M = 0 // 本根木头已锯刀数
  me = 0 // 拉齐次数
  j = 0 // 连齐
  R = 0 // 当前房子已砌木头数
  V = 0 // 盖好的房子数
  score = 0
  houses = 0 // 已飞走的房子数（落点循环用）
  logsDone = 0 // 已断木数（前 2 根有专门播报）
  lastTeamCut = 0
  lastSayAt = -9
  lastRemind = -9
  /** 断木飞行/房屋动画 */
  fly = { t: 0, x0: 0, y0: 0 }
  housePop = 0
  houseFly = { t: 0, x0: 0, y0: 0, x1: 0 }
  tossMsg = ''
  banner = ''
  bannerT = 0
  jingleT = 0

  tick(_f: PoseFrame, dt: number) {
    this.stateT += dt
    this.bannerT = Math.max(0, this.bannerT - dt)
    const present = [0, 1].map((pi) => this.players[pi].body).filter((b) => b !== null)
    const duo = present.length > 1

    if (this.state === 'saw') {
      for (let pi = 0; pi < 2; pi++) {
        const b = this.players[pi].body
        const arm = this.arms[pi]
        if (!b) continue
        const out = arm.update(b, this.cfg.amp, this.t, dt)
        if (out !== 0) {
          // 首刀定向
          if (this.O === 0) this.O = out
          if (out === this.O && !arm.done) {
            arm.done = true
            arm.doneAt = this.t
            this.ctx.audio.slash() // whoosh
          } else if (out !== this.O) {
            arm.wrong++
            // 双人反向刀≥2 且距上次提示 >10s 播报；单人反向刀直接不计
            if (duo && arm.wrong >= 2 && this.t - arm.wrongHintAt > 10) {
              arm.wrongHintAt = this.t
              this.say('看箭头，往同一边拉！', b.shoulderC.x * this.W, (b.shoulderC.y - 0.3) * this.H, '#ffd54a', 32)
            }
          }
        }
      }

      // 团队结算 Q
      const done0 = this.players[0].body ? this.arms[0].done : false
      const done1 = duo && this.players[1].body ? this.arms[1].done : false
      if (!duo) {
        if (done0) this.settleTeam(false, '')
      } else if (done0 && done1) {
        this.settleTeam(Math.abs(this.arms[0].doneAt - this.arms[1].doneAt) <= this.cfg.sync, '')
      } else if (done0 !== done1) {
        const doneAt = done0 ? this.arms[0].doneAt : this.arms[1].doneAt
        const other = done0 ? this.players[1].body : this.players[0].body
        if (this.t - doneAt > this.cfg.wait) {
          this.settleTeam(false, '小伙伴，一起拉呀！')
        } else if (this.t - doneAt > WAIT_REMIND && this.t - this.lastRemind > 8) {
          this.lastRemind = this.t
          if (other) this.say('等等小伙伴，一起拉！', other.shoulderC.x * this.W, (other.shoulderC.y - 0.3) * this.H, '#8fd3ff', 30)
        }
      }

      // 闲置提醒：6s 无团队刀且距上次播报 >9s
      if (this.t - this.lastTeamCut > IDLE_T && this.t - this.lastSayAt > 9) {
        this.lastSayAt = this.t
        this.ctx.speak('拉大锯，扯大锯，一起来！')
        this.say('拉大锯，扯大锯，一起来！', this.W / 2, this.H * 0.24, '#ffd54a', 36)
      }
    } else if (this.state === 'toss') {
      // toss 中：检测到举手 → 星粒 + pop
      for (let pi = 0; pi < 2; pi++) {
        const b = this.players[pi].body
        const arm = this.arms[pi]
        if (!b) continue
        arm.upPrev = arm.up
        arm.up = b.lHandAboveHead && b.rHandAboveHead
        if (arm.up && !arm.upPrev) {
          this.ctx.audio.pop()
          this.particles.burst(b.shoulderC.x * this.W, (b.shoulderC.y - 0.2) * this.H, '#ffd54a', 10, 300, 4)
        }
      }
      const ups = [0, 1].filter((pi) => this.players[pi].body && this.arms[pi].up).length
      const allUp = ups >= 1 && ups === present.length
      if (allUp || this.stateT > this.cfg.toss) this.settleToss(duo)
    } else if (this.state === 'fly') {
      // 断木飞 0.8s 到房架
      if (this.stateT >= FLY_T) {
        this.state = 'saw'
        this.stateT = 0
        this.R++
        this.M = 0
        this.ctx.audio.drop() // thud + 尘土
        const hx = this.W * 0.5
        this.particles.burst(hx, this.H * 0.42, '#d8c9a3', 8, 180, 4)
        if (this.R >= HOUSE_LOGS) {
          // 房子完成：V++、+5 分、tada + 46 confetti
          this.V++
          this.score += 5
          this.state = 'house'
          this.stateT = 0
          this.housePop = 0.01
          this.ctx.audio.win() // tada
          this.particles.confetti(this.W, 46)
          const animal = ANIMALS[this.houses % ANIMALS.length]
          this.banner = '小木屋盖好啦！'
          this.bannerT = 2.2
          this.tossMsg = `${animal}搬进来了`
          this.ctx.speak('小木屋盖好啦！')
        }
      }
    } else if (this.state === 'house') {
      this.housePop = Math.min(1, this.housePop + dt / POP_T)
      // 停留 2.6s 后房屋飞往落点（0.9s 缩至 55%）
      if (this.stateT >= STAY_T) {
        this.state = 'housefly'
        this.stateT = 0
        this.houseFly = { t: 0, x0: this.W * 0.5, y0: this.H * 0.45, x1: HOUSE_X[this.houses % HOUSE_X.length] * this.W }
      }
    } else if (this.state === 'housefly') {
      // 0.9s 飞行 + 缩小
      if (this.stateT >= 0.9) {
        this.houses++
        this.R = 0
        this.state = 'saw'
        this.stateT = 0
      }
    }

    // 举手星形计时
    this.jingleT = Math.max(0, this.jingleT - dt)
  }

  /** 团队刀结算 Q：齐 2 分 / 不齐 1 分 / 等待超时强制 1 分（加油！） */
  private settleTeam(inSync: boolean, forcedMsg: string) {
    const duo = this.players.filter((p) => p.body).length > 1
    let gain: number
    if (!duo) gain = 1
    else gain = inSync ? 2 : 1
    this.score += gain
    this.A++
    this.M++
    this.lastTeamCut = this.t
    if (inSync) {
      this.me++
      this.j++
      this.ctx.audio.coin() // sparkle
      this.say('齐！', this.W / 2, this.H * 0.3, '#3ddc97', 44)
      if (this.j % 6 === 0) {
        this.banner = `一起拉齐 ${this.j} 下！`
        this.bannerT = 1.4
        this.ctx.audio.good()
      }
    } else {
      this.j = 0
      if (forcedMsg) {
        this.ctx.speak(forcedMsg)
        this.say(forcedMsg, this.W / 2, this.H * 0.3, '#8fd3ff', 32)
        this.say('加油！', this.W / 2, this.H * 0.38, '#ffd54a', 30)
      }
    }
    // 木屑粒子（±0.95R 处各 7 粒）
    const sawY = this.H * 0.52
    const half = 150
    this.particles.burst(this.W / 2 - half * 0.95, sawY, '#e0c9a0', 7, 240, 4)
    this.particles.burst(this.W / 2 + half * 0.95, sawY, '#e0c9a0', 7, 240, 4)
    this.O = this.O === 1 ? -1 : 1 // 每锯一下换一边
    for (const arm of this.arms) arm.reset()
    if (this.M >= this.cfg.cuts) this.startToss()
  }

  /** 断木 → toss 态 */
  private startToss() {
    this.state = 'toss'
    this.stateT = 0
    this.ctx.audio.play('hit', 0.9, 0.8) // crack
    this.particles.burst(this.W / 2, this.H * 0.52, '#e0c9a0', 18, 320, 5)
    const msg = this.logsDone < 2 ? '锯下来啦，举起双手！' : '举高高！'
    this.logsDone++
    this.tossMsg = msg
    this.ctx.speak(msg)
    this.banner = msg
    this.bannerT = 1.6
    for (const arm of this.arms) {
      arm.upPrev = arm.up
      arm.done = false
    }
  }

  /** 抛举结算 xe：双人双 up=3（一起举！）、单 up=1；单人 up=3、无 up=0 */
  private settleToss(duo: boolean) {
    const up0 = this.players[0].body && this.arms[0].up
    const up1 = duo && this.players[1].body && this.arms[1].up
    let gain: number
    let msg = ''
    if (duo) {
      if (up0 && up1) {
        gain = 3
        msg = '一起举！'
      } else {
        gain = up0 || up1 ? 1 : 0
        msg = gain ? '举起来了！' : '要举高高！'
      }
    } else {
      gain = up0 ? 3 : 0
      msg = up0 ? '举高高！+3' : '举双手才能送上去哦'
    }
    this.score += gain
    if (gain > 0) this.ctx.audio.jump()
    else this.ctx.audio.fail()
    if (msg) {
      this.say(msg, this.W / 2, this.H * 0.3, gain >= 3 ? '#ffd54a' : '#8fd3ff', 36)
    }
    // 木头飞 0.8s 到房架
    this.state = 'fly'
    this.stateT = 0
    this.fly = { t: 0, x0: this.W / 2, y0: this.H * 0.52 }
  }

  paint(c: CanvasRenderingContext2D) {
    const U = this.H / 720
    const present = this.players.filter((p) => p.body)
    const duo = present.length > 1
    const sawY = this.H * 0.52
    const half = 150 * U

    // 天空 + 山丘 + 沙地（简洁版，装饰背景之上）
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, 'rgba(140,200,255,.35)')
    g.addColorStop(1, 'rgba(255,240,210,.25)')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)

    // 已建房屋一排（落点循环，缩至 55%）
    for (let i = 0; i < this.houses; i++) {
      const hx = HOUSE_X[i % HOUSE_X.length] * this.W
      drawHouse(c, hx, this.H * 0.78, 0.55 * U, i)
    }
    // 正在飞的房子
    if (this.state === 'housefly') {
      const k = Math.min(1, this.stateT / 0.9)
      const e = k * k
      const hx = this.houseFly.x0 + (this.houseFly.x1 - this.houseFly.x0) * e
      const hy = this.houseFly.y0 + (this.H * 0.78 - this.houseFly.y0) * e
      drawHouse(c, hx, hy, (1 - 0.45 * k) * U, this.houses)
    }
    // 刚盖好的房子（弹入）
    if (this.state === 'house' && this.housePop > 0) {
      const pop = 1 + 0.25 * Math.sin(Math.min(1, this.housePop) * Math.PI)
      c.save()
      c.translate(this.W * 0.5, this.H * 0.45)
      c.scale(pop, pop)
      drawHouse(c, 0, 0, U, this.houses)
      c.restore()
      txt(c, this.tossMsg, this.W * 0.5, this.H * 0.45 + 90 * U, 22 * U, '#ffe08a')
    }

    // 房架（当前砌墙位 + 已砌木头）
    const frameX = this.W * 0.5
    const frameY = this.H * 0.42
    c.save()
    c.strokeStyle = 'rgba(160,120,80,.8)'
    c.lineWidth = 8 * U
    c.strokeRect(frameX - 120 * U, frameY - 80 * U, 240 * U, 160 * U)
    for (let i = 0; i < this.R; i++) {
      c.fillStyle = '#b08968'
      rr(c, frameX - 112 * U, frameY + 60 * U - i * 24 * U, 224 * U, 20 * U, 6 * U)
      c.fill()
    }
    c.restore()

    // 大箭头（未定向双向，定向后单向 + sin 摆动）
    const arrowY = sawY - 120 * U
    c.save()
    c.translate(this.W / 2, arrowY)
    const sway = Math.sin(this.t * 5) * 8 * U
    c.strokeStyle = '#ff884d'
    c.fillStyle = '#ff884d'
    c.lineWidth = 12 * U
    c.lineCap = 'round'
    const dir = this.O === 0 ? 0 : this.O
    const len = 90 * U
    if (dir === 0) {
      // 双向
      c.beginPath()
      c.moveTo(-len, 0)
      c.lineTo(len, 0)
      c.stroke()
      for (const s of [-1, 1]) {
        c.beginPath()
        c.moveTo(s * len, 0)
        c.lineTo(s * len - s * 24 * U, -14 * U)
        c.lineTo(s * len - s * 24 * U, 14 * U)
        c.closePath()
        c.fill()
      }
    } else {
      c.beginPath()
      c.moveTo(-dir * len + sway, 0)
      c.lineTo(dir * len + sway, 0)
      c.stroke()
      c.beginPath()
      c.moveTo(dir * len + sway, 0)
      c.lineTo(dir * len + sway - dir * 26 * U, -16 * U)
      c.lineTo(dir * len + sway - dir * 26 * U, 16 * U)
      c.closePath()
      c.fill()
    }
    c.restore()

    // 木头 + 锯口深度（本轮刀数/cuts，τ=9 平滑近似）
    c.save()
    c.translate(this.W / 2, sawY)
    const depth = this.state === 'toss' ? 1 : Math.min(1, this.M / this.cfg.cuts)
    c.fillStyle = '#8d5b34'
    rr(c, -half, -26 * U, half * 2, 52 * U, 20 * U)
    c.fill()
    c.fillStyle = '#a97c50'
    c.beginPath()
    c.ellipse(-half + 12 * U, 0, 12 * U, 24 * U, 0, 0, Math.PI * 2)
    c.ellipse(half - 12 * U, 0, 12 * U, 24 * U, 0, 0, Math.PI * 2)
    c.fill()
    if (depth > 0.02 && this.state === 'saw') {
      c.strokeStyle = '#4a2f18'
      c.lineWidth = 5 * U
      c.beginPath()
      c.moveTo(-40 * U * depth, -26 * U)
      c.lineTo(-40 * U * depth, -26 * U + 52 * U * depth * 0.5)
      c.stroke()
    }
    c.restore()

    // 断木飞行
    if (this.state === 'fly') {
      const k = Math.min(1, this.stateT / FLY_T)
      const fx = this.fly.x0 + (frameX - this.fly.x0) * k
      const fy = this.fly.y0 + (frameY + 40 * U - this.fly.y0) * (k * k * (3 - 2 * k))
      c.save()
      c.translate(fx, fy)
      c.rotate(k * 2.2)
      c.fillStyle = '#8d5b34'
      rr(c, -60 * U, -18 * U, 120 * U, 36 * U, 14 * U)
      c.fill()
      c.restore()
    }

    // 锯子：从两位玩家手到木头两端的锯条（ solo 补一段小熊装饰手柄）
    const handles: { x: number; y: number; color: string; label: string }[] = []
    const b0 = this.players[0].body
    if (b0) {
      handles.push({ x: (b0.lHand.x + b0.rHand.x) / 2 * this.W, y: (b0.lHand.y + b0.rHand.y) / 2 * this.H, color: this.players[0].color, label: duo ? '' : '你' })
    }
    if (duo) {
      const b1 = this.players[1].body
      if (b1) handles.push({ x: (b1.lHand.x + b1.rHand.x) / 2 * this.W, y: (b1.lHand.y + b1.rHand.y) / 2 * this.H, color: this.players[1].color, label: '' })
    } else if (!duo && b0) {
      // 小熊（装饰性队友，右手柄棕色 #c98a52，不计分）
      const bx = Math.min(this.W * 0.85, b0.shoulderC.x * this.W + 330 * U)
      handles.push({ x: bx, y: sawY - 20 * U, color: '#c98a52', label: '小熊' })
    }
    c.save()
    c.strokeStyle = 'rgba(120,120,140,.9)'
    c.lineWidth = 10 * U
    c.beginPath()
    for (let i = 0; i < handles.length; i++) {
      const hx = i === 0 ? this.W / 2 - half * 0.8 : this.W / 2 + half * 0.8
      c.moveTo(handles[i].x, handles[i].y)
      c.lineTo(hx, sawY)
    }
    c.stroke()
    // 锯齿
    c.strokeStyle = 'rgba(200,210,230,.9)'
    c.lineWidth = 5 * U
    c.beginPath()
    c.moveTo(this.W / 2 - half, sawY + 30 * U)
    for (let x = -half; x < half; x += 16 * U) {
      c.lineTo(x + 8 * U, sawY + 40 * U)
      c.lineTo(x + 16 * U, sawY + 30 * U)
    }
    c.stroke()
    c.restore()
    // 手柄
    for (const h of handles) {
      circle(c, h.x, h.y, 17 * U, h.color)
      if (h.label) txt(c, h.label, h.x, h.y - 30 * U, 18 * U, '#fff')
      // done 对勾圈
      const arm = handles.indexOf(h) === 0 ? this.arms[0] : this.arms[1]
      if (this.state === 'saw' && arm.done) {
        circle(c, h.x, h.y - 44 * U, 14 * U, '#3ddc97')
        txt(c, '✔', h.x, h.y - 44 * U, 18 * U, '#fff')
      }
      // toss 举手星形爆发
      if (this.state === 'toss' && arm.up) {
        star(c, h.x, h.y - 50 * U, 16 * U, '#ffd54a')
      }
    }

    // 圆木堆（高度随 A/40 增长，最多 1）
    const pileH = Math.min(1, this.A / 40)
    if (pileH > 0.02) {
      c.save()
      c.globalAlpha = 0.8
      for (let i = 0; i < Math.ceil(pileH * 6); i++) {
        c.fillStyle = '#8d5b34'
        rr(c, 60 * U + (i % 2) * 16 * U, this.H - 60 * U - i * 22 * U, 70 * U, 20 * U, 8 * U)
        c.fill()
      }
      c.restore()
    }

    // 状态大字
    if (this.bannerT > 0) {
      c.globalAlpha = Math.min(1, this.bannerT / 0.3)
      outlineTxt(c, this.banner, this.W / 2, 90 * U, 44, '#ffd54a')
      c.globalAlpha = 1
      if (this.state === 'house' && this.tossMsg) txt(c, this.tossMsg, this.W / 2, 132 * U, 24 * U, '#ffe08a')
    }
    if (this.state === 'toss') {
      const left = Math.max(0, this.cfg.toss - this.stateT)
      outlineTxt(c, `${this.tossMsg} (${left.toFixed(1)}s)`, this.W / 2, 90 * U, 36, '#ff884d')
    }
    glow(c, this.W / 2, arrowY, 120 * U, 'rgba(255,136,77,.35)', 0.5)
    txt(
      c,
      duo ? '看大箭头同边拉才动，齐了 2 分；木头锯断一起举手送上去' : '看大箭头拉锯子；木头锯断就举起双手，小熊陪你玩',
      this.W / 2,
      this.H - 28,
      20,
      'rgba(255,255,255,.85)',
      'center',
      'bold',
    )

    this.ctx.setScore(this.score)
    this.ctx.setCombo(this.j)
    this.ctx.setExtra('一起锯了', this.A)
    if (duo) this.ctx.setExtra('两个人拉齐', this.me)
    this.ctx.setExtra('盖好的小木屋', this.V)
  }
}

/** 画一座小木屋（第 n 座，住户轮换小兔子/小鸡/小猪/小猫） */
function drawHouse(c: CanvasRenderingContext2D, x: number, y: number, s: number, n: number) {
  c.save()
  c.translate(x, y)
  c.scale(s, s)
  // 墙
  c.fillStyle = '#d9b382'
  rr(c, -70, -60, 140, 110, 6)
  c.fill()
  // 屋顶
  c.fillStyle = '#c9563c'
  c.beginPath()
  c.moveTo(-88, -60)
  c.lineTo(0, -130)
  c.lineTo(88, -60)
  c.closePath()
  c.fill()
  // 门
  c.fillStyle = '#8d5b34'
  rr(c, -16, -8, 32, 58, 4)
  c.fill()
  // 窗
  c.fillStyle = '#ffe9b8'
  rr(c, 30, -44, 30, 28, 4)
  c.fill()
  // 住户（动物轮换）
  circle(c, -34, 24, 16, '#fff1dc')
  txt(c, ['🐰', '🐤', '🐷', '🐱'][n % 4], -34, 25, 20, '#000')
  c.restore()
}

export default function create(ctx: GameContext) {
  return new SawLog(ctx)
}
