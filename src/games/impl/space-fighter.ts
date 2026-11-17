import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, txt } from '@/core/draw'

/**
 * 太空战机 / space-fighter（对齐 dongdongpark 真实规则）：
 * 身体左右移动屏幕下方的飞船（不跟手）；举右手连发子弹（0.17s 冷却、永远垂直向上），
 * 举左手开 2s 护盾（撞陨石 +5、撞敌机 +10、吸收敌弹，冷却 5s），侧倾 ≥0.4 桶滚 0.5s 完全无敌（冷却 3s），
 * 能量满时双手举起放大招清屏（陨石 +10/敌机 +20 合并计分）。3 条命全局共享，归零结束。
 *
 * 全部字面量沿用站点：陨石间隔 1.3/1/0.75s、敌机 3.6/2.7/2s、敌机反击 medium 起、速度倍率 0.8/1/1.2、
 * 道具间隔 7/8/9s ×(0.8~1.2)、敌机血 1/2/2；难度爬坡 U()=1−0.3×clamp(t/75)（局末间隔缩至 70%）；
 * 陨石 r 26~52u（>42u 两血）、速度 (130+rng×110)u×speed 横向 ±30u；敌机 64u 下落 105u×speed
 * 正弦横摆 ±12%W、开局 1.2~2.2s 后开火每 1.8~2.8s 一发（仅上半屏）；玩家弹 −900u 冷却 0.17s、
 * 敌弹 +320u×speed；船体判定 0.32B、护盾 0.7B（B=92u）；活动半径 30%W/26%W、shift clamp ±1.4、
 * 平滑 1−e^(−7dt)；举手阈值=掌心过肩上 0.08T；被击中命−1+无敌 1.6s+能量 −0.25+同归于尽；
 * 道具 40% 加命（命满时改能量 +0.4）、拾取 +5；能量：陨石 +0.1/敌机 +0.2/道具 +0.4/受击 −0.25。
 *
 * 与站点的差异（写明待实测）：
 * 1) motion.shift 黑盒 → 「身体中心相对家中心的偏移 ÷ 活动半径」直接映射（本作飞船本来就跟身体）；
 * 2) motion.lean 用肩髋横偏代理（slalom-ski 同款）；events.has('handsUp') 用双手同时过肩 0.08T 的上升沿；
 * 3) 举手判定用腕点（掌心/腕点等价，站点黑盒）；精灵全部几何绘制；双人共享一个分数（仓库口径）；
 * 4) ai() 演示替身未实装；命中率按中弹次数（站点同款口径）。
 */

interface Rock {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  hp: number
  rot: number
  seed: number
}

interface Enemy {
  x: number
  y: number
  phase: number
  hp: number
  fireIn: number
}

interface Bullet {
  x: number
  y: number
  vy: number
  owner: number
}

interface EBullet {
  x: number
  y: number
  vy: number
}

interface Power {
  x: number
  y: number
  kind: 'life' | 'energy'
}

interface Zone {
  cx: number
  w: number
}

interface Flyer {
  x: number
  fireCool: number
  shieldT: number
  shieldCd: number
  rollT: number
  rollCd: number
  energy: number
  energyBanner: boolean
  invuln: number
  flash: number
  kills: number
  shots: number
  hits: number
  bombs: number
  wasBothUp: boolean
  zone: Zone
}

/** 站点三档：陨石间隔 / 敌机间隔 / 敌机反击 / 速度倍率 / 道具间隔 / 敌机血量 */
const DIFF = [
  { asteroid: 1.3, enemy: 3.6, enemyFire: false, speed: 0.8, power: 7, enemyHp: 1 },
  { asteroid: 1, enemy: 2.7, enemyFire: true, speed: 1, power: 8, enemyHp: 2 },
  { asteroid: 0.75, enemy: 2, enemyFire: true, speed: 1.2, power: 9, enemyHp: 2 },
]

const LIVES = 3
const SHIELD_T = 2
const SHIELD_CD = 5
const ROLL_T = 0.5
const ROLL_CD = 3
const FIRST_AST = 1
const FIRST_ENEMY = 3
const FIRST_POWER = 6
const SHIP_B = 92 // 船体基准尺寸（×unit）
const HULL_R = 0.32 // 船体判定半径（×B）
const SHIELD_R = 0.7 // 护盾半径（×B）
const FIRE_CD = 0.17
const BULLET_V = -900
const EBULLET_V = 320
const HIT_INVULN = 1.6
const RAMP_T = 75 // 难度爬坡时长
const LEAN_ROLL = 0.4
const UP_LINE = 0.08 // 举手阈值：掌心过肩上 0.08T
const ENERGY_AST = 0.1
const ENERGY_ENEMY = 0.2
const ENERGY_POWER = 0.4
const ENERGY_HIT = -0.25

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

function leanOf(b: Body) {
  const t = Math.max(0.08, b.scale)
  return clamp(((b.shoulderC.x - b.hipC.x) / t) * 2.2, -1, 1)
}
function handUp(b: Body, side: 0 | 1) {
  const T = Math.max(60, b.scale * 720 * 1.1)
  const y = side === 0 ? b.lHand.y : b.rHand.y
  return y * 720 < b.shoulderC.y * 720 - T * UP_LINE
}

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

class SpaceFighter extends BaseGame implements Game {
  cfg = DIFF[this.ctx.difficulty] ?? DIFF[0]
  flyers: Flyer[] = []
  seats = 1
  private seatActive = [false, false]
  lives = LIVES
  rocks: Rock[] = []
  enemies: Enemy[] = []
  bullets: Bullet[] = []
  ebullets: EBullet[] = []
  powers: Power[] = []
  private rng = mulberry32(3)
  private astIn = FIRST_AST
  private enemyIn = FIRST_ENEMY
  private powerIn = FIRST_POWER
  private U = Math.min(this.W, this.H) / 720
  private over = false

  constructor(ctx: GameContext) {
    super(ctx)
    for (let i = 0; i < 2; i++) {
      this.flyers.push({
        x: this.W / 2, fireCool: 0, shieldT: 0, shieldCd: 0, rollT: 0, rollCd: 0,
        energy: 0, energyBanner: false, invuln: 0, flash: 0,
        kills: 0, shots: 0, hits: 0, bombs: 0, wasBothUp: false,
        zone: { cx: this.W / 2, w: this.W },
      })
    }
    this.layout()
  }

  private layout() {
    const n = this.seats
    for (let i = 0; i < 2; i++) {
      this.flyers[i].zone = { cx: (this.W / n) * i + this.W / n / 2, w: this.W / n }
      this.flyers[i].x = this.flyers[i].zone.cx
    }
  }

  /** 难度爬坡 U()：局末生成间隔缩至 70% */
  private ramp() {
    return 1 - 0.3 * clamp(this.t / RAMP_T, 0, 1)
  }

  tick(f: PoseFrame, dt: number) {
    if (this.seats === 1 && f.bodies[1]) {
      this.seats = 2
      this.layout()
    }
    for (let i = 0; i < 2; i++) if (f.bodies[i]) this.seatActive[i] = true
    if (this.over) return

    // —— 生成（间隔 × ramp）——
    this.astIn -= dt
    this.enemyIn -= dt
    this.powerIn -= dt
    if (this.astIn <= 0) {
      this.astIn = this.cfg.asteroid * this.ramp() * (0.7 + this.rng() * 0.6)
      const r = (26 + this.rng() * 26) * this.U
      this.rocks.push({
        x: this.U * 40 + this.rng() * (this.W - this.U * 80),
        y: -r, vx: (this.rng() * 2 - 1) * 30 * this.U,
        vy: (130 + this.rng() * 110) * this.U * this.cfg.speed,
        r, hp: r > 42 * this.U ? 2 : 1, rot: this.rng() * 6, seed: Math.floor(this.rng() * 12),
      })
    }
    if (this.enemyIn <= 0) {
      this.enemyIn = this.cfg.enemy * this.ramp() * (0.75 + this.rng() * 0.5)
      this.enemies.push({
        x: this.U * 60 + this.rng() * (this.W - this.U * 120),
        y: -64 * this.U, phase: this.rng() * 6,
        hp: this.cfg.enemyHp,
        fireIn: 1.2 + this.rng() * 1,
      })
    }
    if (this.powerIn <= 0) {
      this.powerIn = this.cfg.power * (0.8 + this.rng() * 0.4)
      this.powers.push({
        x: this.U * 40 + this.rng() * (this.W - this.U * 80),
        y: -24 * this.U,
        kind: this.lives < LIVES && this.rng() < 0.4 ? 'life' : 'energy',
      })
    }

    // —— 实体推进 ——
    for (const r of this.rocks) {
      r.y += r.vy * dt
      r.x += r.vx * dt
      r.rot += 2 * dt
      if (r.x < r.r || r.x > this.W - r.r) r.vx *= -1
    }
    for (const e of this.enemies) {
      e.y += 105 * this.U * this.cfg.speed * dt
      e.x += Math.sin(this.t * 1.6 + e.phase) * 0.12 * this.W * dt
      e.fireIn -= dt
      if (this.cfg.enemyFire && e.fireIn <= 0 && e.y < this.H * 0.5) {
        e.fireIn = 1.8 + this.rng() * 1
        this.ebullets.push({ x: e.x, y: e.y, vy: EBULLET_V * this.U * this.cfg.speed })
        this.ctx.audio.play('tick', 0.3, 0.7)
      }
    }
    for (const b2 of this.bullets) b2.y += BULLET_V * this.U * dt
    for (const b2 of this.ebullets) b2.y += b2.vy * dt
    for (const p2 of this.powers) p2.y += 120 * this.U * dt

    // —— 玩家 ——
    let anyActive = false
    for (let i = 0; i < 2; i++) {
      if (!this.seatActive[i]) continue
      anyActive = true
      this.step(this.flyers[i], f.bodies[i] ?? null, dt, i)
    }

    // —— 清理出屏 ——
    this.rocks = this.rocks.filter((r) => r.y < this.H + r.r && r.hp > 0)
    this.enemies = this.enemies.filter((e) => e.y < this.H + 64 * this.U && e.hp > 0)
    this.bullets = this.bullets.filter((b2) => b2.y > -30)
    this.ebullets = this.ebullets.filter((b2) => b2.y < this.H + 30)
    this.powers = this.powers.filter((p2) => p2.y < this.H + 30)

    if (anyActive && this.lives <= 0 && !this.over) {
      this.over = true
      this.say('飞船坏了…', this.W / 2, this.H * 0.4, '#ff8fa8', 46)
      this.ctx.finish()
    }
  }

  private step(fl: Flyer, b: Body | null, dt: number, idx: number) {
    if (fl.fireCool > 0) fl.fireCool -= dt
    if (fl.shieldT > 0) fl.shieldT -= dt
    if (fl.shieldCd > 0) fl.shieldCd -= dt
    if (fl.rollT > 0) fl.rollT -= dt
    if (fl.rollCd > 0) fl.rollCd -= dt
    if (fl.invuln > 0) fl.invuln -= dt
    if (fl.flash > 0) fl.flash -= dt
    const radius = (this.seats > 1 ? 0.26 : 0.3) * this.W

    if (!b) return
    const home = fl.zone.cx
    // shift：身体中心相对家中心的偏移（±1.4 clamp）
    const shift = clamp((b.center.x * this.W - home) / radius, -1.4, 1.4)
    const tx = clamp(home + shift * radius, 0.6 * SHIP_B * this.U, this.W - 0.6 * SHIP_B * this.U)
    fl.x += (tx - fl.x) * (1 - Math.exp(-dt * 7))

    // 桶滚：侧倾 ≥0.4 且冷却完毕
    if (fl.rollCd <= 0 && Math.abs(leanOf(b)) >= LEAN_ROLL) {
      fl.rollT = ROLL_T
      fl.rollCd = ROLL_CD
      this.ctx.audio.play('click', 0.5, 0.7)
    }
    const shipY = this.H * 0.7
    const hullR = HULL_R * SHIP_B * this.U
    const shieldR = SHIELD_R * SHIP_B * this.U

    // 举手：掌心（腕点代理）过肩上 0.08T
    const upL = handUp(b, 0)
    const upR = handUp(b, 1)
    // 开火（右手）
    if (upR && fl.fireCool <= 0) {
      fl.fireCool = FIRE_CD
      fl.shots++
      this.bullets.push({ x: fl.x, y: shipY - SHIP_B * this.U * 0.4, vy: BULLET_V * this.U, owner: idx })
      this.ctx.audio.play('click', 0.35, 1.3)
    }
    // 护盾（左手）
    if (upL && fl.shieldCd <= 0) {
      fl.shieldT = SHIELD_T
      fl.shieldCd = SHIELD_CD
      this.ctx.audio.play('pop', 0.5, 0.9)
    }
    // 大招：双手举起 + 能量满（上升沿）
    const bothUp = upL && upR
    if (bothUp && fl.energy >= 1 && !fl.wasBothUp) {
      fl.bombs++
      fl.energy = 0
      let gain = 0
      for (const r of this.rocks) {
        gain += 10
        this.particles.burst(r.x, r.y, '#9aa4b5', 6, 200, 4)
      }
      for (const _e of this.enemies) {
        void _e
        gain += 20
        fl.kills++
      }
      gain += this.ebullets.length * 0
      this.rocks = []
      this.enemies = []
      this.ebullets = []
      this.ctx.addScore(gain)
      this.say(`大招 +${gain}`, fl.zone.cx, this.H * 0.4, '#ffd54a', 40)
      this.ctx.audio.play('win')
      this.particles.burst(fl.x, shipY, '#ffd54a', 30, 420, 5)
      fl.energyBanner = false
    }
    fl.wasBothUp = bothUp

    const shieldOn = fl.shieldT > 0
    const rolling = fl.rollT > 0

    // —— 子弹命中 ——
    for (const b2 of this.bullets) {
      if (b2.owner !== idx) continue
      for (const r of this.rocks) {
        if (r.hp <= 0) continue
        if (Math.hypot(b2.x - r.x, b2.y - r.y) < r.r + 6 * this.U) {
          r.hp--
          b2.y = -100
          fl.hits++
          this.addEnergy(fl, ENERGY_AST)
          if (r.hp <= 0) {
            this.ctx.addScore(10)
            fl.kills++
            this.ctx.audio.play('pop', 0.5)
            this.particles.burst(r.x, r.y, '#9aa4b5', 8, 240, 4)
            if (this.rng() < 0.08) this.powers.push({ x: r.x, y: r.y, kind: this.lives < LIVES && this.rng() < 0.4 ? 'life' : 'energy' })
          } else {
            this.ctx.audio.play('tick', 0.4)
          }
          break
        }
      }
      if (b2.y <= -100) continue
      for (const e of this.enemies) {
        if (e.hp <= 0) continue
        if (Math.hypot(b2.x - e.x, b2.y - e.y) < 0.45 * 64 * this.U) {
          e.hp--
          b2.y = -100
          fl.hits++
          this.addEnergy(fl, ENERGY_ENEMY)
          if (e.hp <= 0) {
            this.ctx.addScore(20)
            fl.kills++
            this.ctx.audio.play('pop', 0.5, 1.2)
            this.particles.burst(e.x, e.y, '#ffd54a', 10, 260, 4)
            if (this.rng() < 0.15) this.powers.push({ x: e.x, y: e.y, kind: this.lives < LIVES && this.rng() < 0.4 ? 'life' : 'energy' })
          } else {
            this.ctx.audio.play('tick', 0.4)
          }
          break
        }
      }
    }

    // —— 护盾撞碎 / 吸收 ——
    if (shieldOn) {
      for (const r of this.rocks) {
        if (r.hp > 0 && Math.hypot(fl.x - r.x, shipY - r.y) < shieldR + r.r) {
          r.hp = 0
          this.ctx.addScore(5)
          this.particles.burst(r.x, r.y, '#9aa4b5', 8, 240, 4)
        }
      }
      for (const e of this.enemies) {
        if (e.hp > 0 && Math.hypot(fl.x - e.x, shipY - e.y) < shieldR + 0.45 * 64 * this.U) {
          e.hp = 0
          this.ctx.addScore(10)
          this.particles.burst(e.x, e.y, '#ffd54a', 10, 260, 4)
        }
      }
      this.ebullets = this.ebullets.filter((b2) => {
        if (Math.hypot(fl.x - b2.x, shipY - b2.y) < shieldR) {
          this.particles.burst(b2.x, b2.y, '#b088f0', 6, 180, 3)
          return false
        }
        return true
      })
    }

    // —— 道具拾取 ——
    this.powers = this.powers.filter((p2) => {
      if (Math.hypot(fl.x - p2.x, shipY - p2.y) < 26 * this.U + 1.3 * hullR) {
        this.ctx.addScore(5)
        this.addEnergy(fl, ENERGY_POWER)
        this.ctx.audio.play('score', 0.5)
        if (p2.kind === 'life') {
          this.lives++
          this.say('+1 命', fl.x, shipY - 60, '#ff8fa8', 28)
        } else {
          this.say('能量 +', fl.x, shipY - 60, '#ffd54a', 28)
        }
        return false
      }
      return true
    })

    // —— 受击（船体；桶滚完全无敌）——
    if (rolling || fl.invuln > 0) return
    const crash = (x: number, y: number) => {
      this.lives--
      fl.invuln = HIT_INVULN
      this.addEnergy(fl, ENERGY_HIT)
      fl.flash = 0.4
      this.ctx.audio.play('hit', 0.8)
      this.particles.burst(fl.x, shipY, '#ffffff', 12, 300, 5)
      this.say('中弹了！', fl.x, shipY - 70, '#ff6b8a', 32)
      void x
      void y
    }
    for (const r of this.rocks) {
      if (r.hp > 0 && Math.hypot(fl.x - r.x, shipY - r.y) < hullR + r.r) {
        r.hp = 0 // 同归于尽
        crash(r.x, r.y)
        return
      }
    }
    for (const e of this.enemies) {
      if (e.hp > 0 && Math.hypot(fl.x - e.x, shipY - e.y) < hullR + 0.4 * 64 * this.U) {
        e.hp = 0
        crash(e.x, e.y)
        return
      }
    }
    for (let i = 0; i < this.ebullets.length; i++) {
      const b2 = this.ebullets[i]
      if (Math.hypot(fl.x - b2.x, shipY - b2.y) < hullR + 8 * this.U) {
        this.ebullets.splice(i, 1)
        crash(b2.x, b2.y)
        return
      }
    }
  }

  private addEnergy(fl: Flyer, v: number) {
    const was = fl.energy
    fl.energy = clamp(fl.energy + v, 0, 1)
    if (fl.energy >= 1 && was < 1 && !fl.energyBanner) {
      fl.energyBanner = true
      this.say('能量满了！双手举起放大招', this.W / 2, this.H * 0.2, '#ffd54a', 30)
      this.ctx.audio.play('combo', 0.6)
    }
  }

  paint(c: CanvasRenderingContext2D) {
    // 星空
    const g = c.createLinearGradient(0, 0, 0, this.H)
    g.addColorStop(0, '#171433')
    g.addColorStop(1, '#3a2d5c')
    c.fillStyle = g
    c.fillRect(0, 0, this.W, this.H)
    for (let k = 0; k < 70; k++) {
      const layer = k % 3
      const speed = [40, 90, 140][layer] * this.U
      const y = (k * 97.3 + this.t * speed) % this.H
      c.globalAlpha = [0.25, 0.5, 0.75][layer]
      circle(c, (k * 173.7) % this.W, y, 1.5, '#fff')
      c.globalAlpha = 1
    }
    // 陨石
    for (const r of this.rocks) {
      c.save()
      c.translate(r.x, r.y)
      c.rotate(r.rot)
      c.fillStyle = '#7d7468'
      c.beginPath()
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2
        const rr2 = r.r * (0.85 + ((r.seed + k) % 3) * 0.1)
        const px = Math.cos(a) * rr2
        const py = Math.sin(a) * rr2
        if (k === 0) c.moveTo(px, py)
        else c.lineTo(px, py)
      }
      c.closePath()
      c.fill()
      c.restore()
      if (r.hp > 1) {
        c.strokeStyle = 'rgba(255,255,255,.3)'
        c.lineWidth = 2
        c.beginPath()
        c.arc(r.x, r.y, r.r + 3, 0, Math.PI * 2)
        c.stroke()
      }
    }
    // 敌机
    for (const e of this.enemies) {
      circle(c, e.x, e.y, 32 * this.U, '#b0576b')
      c.fillStyle = 'rgba(255,255,255,.35)'
      c.beginPath()
      c.ellipse(e.x, e.y - 6 * this.U, 18 * this.U, 8 * this.U, 0, 0, Math.PI * 2)
      c.fill()
    }
    // 子弹 / 敌弹 / 道具
    for (const b2 of this.bullets) {
      c.fillStyle = '#9be15d'
      c.fillRect(b2.x - 3 * this.U, b2.y - 13 * this.U, 6 * this.U, 26 * this.U)
    }
    for (const b2 of this.ebullets) {
      c.fillStyle = '#b088f0'
      c.fillRect(b2.x - 4 * this.U, b2.y - 9 * this.U, 8 * this.U, 18 * this.U)
    }
    for (const p2 of this.powers) {
      txt(c, p2.kind === 'life' ? '❤️' : '⚡', p2.x, p2.y, 24 * this.U, '#fff')
    }
    // 飞船
    for (let i = 0; i < 2; i++) {
      const fl = this.flyers[i]
      if (!this.seatActive[i] || (this.seats === 1 && i === 1)) continue
      const shipY = this.H * 0.7
      const B = SHIP_B * this.U
      const blink = fl.invuln > 0 && Math.floor(this.t * 12) % 2 === 0
      if (!blink) {
        // 护盾
        if (fl.shieldT > 0) {
          c.globalAlpha = fl.shieldT < 0.4 ? 0.4 + Math.sin(this.t * 20) * 0.2 : 0.7
          circle(c, fl.x, shipY, SHIELD_R * B, 'rgba(76,201,240,.25)')
          c.strokeStyle = '#4cc9f0'
          c.lineWidth = 3
          c.beginPath()
          c.arc(fl.x, shipY, SHIELD_R * B, 0, Math.PI * 2)
          c.stroke()
          c.globalAlpha = 1
        }
        // 船体
        const bank = 0.2
        void bank
        const roll = fl.rollT > 0 ? Math.cos((1 - fl.rollT / ROLL_T) * Math.PI * 2) : 1
        c.save()
        c.translate(fl.x, shipY)
        c.rotate(clamp(0.1, -0.35, 0.35))
        c.scale(roll, 1)
        c.fillStyle = this.players[i].color
        c.beginPath()
        c.moveTo(0, -B * 0.45)
        c.lineTo(B * 0.32, B * 0.35)
        c.lineTo(-B * 0.32, B * 0.35)
        c.closePath()
        c.fill()
        // 火焰
        c.fillStyle = '#ffd54a'
        c.beginPath()
        c.moveTo(-B * 0.12, B * 0.35)
        c.lineTo(0, B * 0.55 + Math.sin(this.t * 30) * B * 0.06)
        c.lineTo(B * 0.12, B * 0.35)
        c.closePath()
        c.fill()
        c.restore()
      }
      // HUD：命 + 能量
      for (let k = 0; k < LIVES; k++) {
        c.globalAlpha = k < this.lives ? 1 : 0.25
        txt(c, '❤', 24 + k * 28, 40, 22, '#ff6b8a')
        c.globalAlpha = 1
      }
      const barW = 220 * this.U
      c.fillStyle = 'rgba(255,255,255,.13)'
      c.fillRect(24, 60, barW, 10)
      c.fillStyle = this.players[i].color
      c.fillRect(24, 60, barW * fl.energy, 10)
      txt(c, fl.energy >= 1 ? '大招 OK！双手举起' : '能量', 24 + barW + 10, 65, 16, fl.energy >= 1 ? '#ffd54a' : '#ffffffaa', 'left', 'bold')
      txt(c, fl.shieldCd > 0 ? `护盾 ${Math.ceil(fl.shieldCd)}s` : '护盾 OK', 24 + barW + 10, 88, 15, fl.shieldCd > 0 ? '#ffffff88' : '#6bcb77', 'left', 'bold')
      // 受击白闪
      if (fl.flash > 0) {
        c.fillStyle = `rgba(255,255,255,${fl.flash * 0.6})`
        c.fillRect(0, 0, this.W, this.H)
      }
      if (this.seats > 1) {
        txt(c, i === 0 ? 'P1' : 'P2', fl.x, shipY + B * 0.8, 18, this.players[i].color, 'center', 'bold')
      }
    }
    // 统计
    for (let i = 0; i < 2; i++) {
      const fl = this.flyers[i]
      if (!this.seatActive[i]) continue
      this.ctx.setExtra(`kills${i}`, fl.kills)
      this.ctx.setExtra(`accuracy${i}`, fl.shots > 0 ? Math.round((100 * fl.hits) / fl.shots) : -1)
      this.ctx.setExtra(`bombs${i}`, fl.bombs)
    }
  }
}

export default function create(ctx: GameContext) {
  return new SpaceFighter(ctx)
}
