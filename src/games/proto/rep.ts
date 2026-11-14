import { BaseGame } from '@/core/base'
import type { Body, Game, GameContext, PoseFrame } from '@/core/types'
import { circle, glow, outlineTxt, ring, star, txt } from '@/core/draw'

/**
 * 体能/计数类原型。17 个游戏不再共用“数次数”一种规则，拆成 10 种：
 * count    纯计数（体测类：深蹲/高抬腿/开合跳/波比/跳绳计数/体能循环轮换）
 * rope     跳绳时机：绳到脚下必须在空中，绊住断连击，越跳越快
 * hurdle   跨栏时机：栏架滚过来，压线瞬间起跳
 * race     速度比拼：交替抬腿/划水推进，和小动物赛跑（骑车加躲水坑）
 * tramp    蹦床时机：落床瞬间起跳弹更高，够到高处的星星
 * longjump 蓄力跳远：蹲下蓄力、爆发起跳，量距离
 * hopscotch 跳房子：单格并脚跳、双格分腿跳
 * bamboo   跳竹竿：竿合脚在外、竿开脚在内
 * carrot   拔萝卜：先走到萝卜跟前，再蹲下拔
 * radish   萝卜蹲：喊到自己颜色才能蹲，忍住不蹲也算对
 */
type Rule =
  | 'count' | 'rope' | 'hurdle' | 'race' | 'tramp'
  | 'longjump' | 'hopscotch' | 'bamboo' | 'carrot' | 'radish'

type Action = 'jump' | 'squat' | 'knee' | 'jack' | 'burpee'

interface Theme {
  rule: Rule
  action?: Action
  label: string
  color: string
  rope?: boolean
  /** race 的输入方式 */
  input?: 'knee' | 'swim'
  /** race：路上有障碍要躲 */
  obstacles?: boolean
  /** count：三站轮换 */
  circuit?: boolean
  hint: string
}

const THEMES: Record<string, Theme> = {
  'jump-rope': { rule: 'rope', label: '跳绳', color: '#ff7a45', hint: '绳子扫到脚边时跳起来，别绊住' },
  'rope-count': { rule: 'count', action: 'jump', label: '跳绳', color: '#4cc9f0', rope: true, hint: '一下一下跳，数你跳了多少' },
  trampoline: { rule: 'tramp', label: '蹦床', color: '#9b5de5', hint: '落回蹦床的一瞬间跳，弹得更高摘星星' },
  hopscotch: { rule: 'hopscotch', label: '跳房子', color: '#ffd54a', hint: '单格并脚跳，双格分开跳' },
  hurdles: { rule: 'hurdle', label: '跨栏', color: '#3ddc97', hint: '栏架压到脚线时跳，跳早跳晚都会碰栏' },
  'squat-count': { rule: 'count', action: 'squat', label: '深蹲', color: '#3ddc97', hint: '蹲下去、站起来算一个' },
  'pull-carrot': { rule: 'carrot', label: '拔萝卜', color: '#ff9f1c', hint: '先走到萝卜跟前，蹲下使劲拔' },
  'radish-squat': { rule: 'radish', label: '萝卜蹲', color: '#7bc950', hint: '喊到你的颜色才蹲，别的颜色忍住' },
  'knee-count': { rule: 'count', action: 'knee', label: '高抬腿', color: '#ff5c8a', hint: '膝盖轮流抬到腰那么高' },
  'jack-count': { rule: 'count', action: 'jack', label: '开合跳', color: '#ffd54a', hint: '跳开举手、并拢放下，算一个' },
  burpee: { rule: 'count', action: 'burpee', label: '波比跳', color: '#ff4d4d', hint: '蹲下摸地，站起来跳起举手' },
  'fitness-circuit': { rule: 'count', action: 'squat', label: '体能', color: '#ff4d4d', circuit: true, hint: '三站轮流做，每站 20 秒' },
  'bamboo-dance': { rule: 'bamboo', label: '跳竹竿', color: '#3ddc97', hint: '竹竿合上脚在外，竹竿打开脚进来' },
  sprint: { rule: 'race', input: 'knee', label: '冲刺', color: '#4cc9f0', hint: '左右腿交替快抬，跑赢小豹子' },
  'long-jump': { rule: 'longjump', label: '立定跳远', color: '#ff9f1c', hint: '蹲下蓄力，站起来瞬间使劲跳' },
  'bike-ride': { rule: 'race', input: 'knee', obstacles: true, label: '骑车', color: '#4cc9f0', hint: '抬腿蹬车，身体左右歪躲水坑' },
  'swim-race': { rule: 'race', input: 'swim', label: '游泳', color: '#4cc9f0', hint: '两臂轮流举高划水，追上小海豚' },
}

interface Hurdle { x: number; hit: boolean; done: boolean }
interface Pad { x: number; kind: 0 | 1; n: number; checked: boolean }
interface Obs { d: number; lane: number; done: boolean }

class RepGame extends BaseGame implements Game {
  theme: Theme
  rule: Rule
  score = 0
  combo = 0
  best = 0
  reps = 0
  beat = 0
  beatInterval = 0.85
  flash = 0

  // 上升沿检测
  private was = { jump: false, squat: false, lKnee: false, rKnee: false, lArm: false, rArm: false }
  private jumpEdgeT = -9

  // count（含体能循环）
  private station = 0
  private stationT = 0
  private was2 = { squat: false, l: false, r: false, jack: false, burpee: false }

  // rope
  private ropePhase = 0
  private ropeDur = 1.05
  private ropeStun = 0
  private ropePasses = 0
  private windowAir = false

  // hurdle
  private hurdles: Hurdle[] = []
  private hSpeed = 430
  private hSpawn = 0.8
  private dist = 0

  // race
  private v = 0
  private myDist = 0
  private aiDist = 0
  private lastSide = 0
  private lane = 1
  private laneBase = -1
  private obs: Obs[] = []
  private raceDone = false

  // tramp
  private avY = 240
  private avV = 0
  private rest = 0.72
  private starRows = [
    { y: 480, v: 10, cd: 0 },
    { y: 400, v: 15, cd: 0 },
    { y: 320, v: 25, cd: 0 },
    { y: 240, v: 40, cd: 0 },
    { y: 170, v: 60, cd: 0 },
  ]

  // longjump
  private phase: 'ready' | 'charge' | 'air' | 'landed' = 'ready'
  private charge = 0
  private sinceSquat = 0
  private flyT = 0
  private jumpDist = 0
  private bestDist = 0
  private attempts = 0
  private landT = 0

  // hopscotch
  private pads: Pad[] = []
  private padSpeed = 300
  private padN = 1
  private padSpawn = 0.6

  // bamboo
  private open = true
  private evalT = -1
  private bInterval = 1.05
  private bTimer = 1.05
  private bFlash = 0
  private bOk = 0

  // carrot
  private carrotSide = 1
  private carrotHp = 3
  private carrotMax = 3
  private carrotGolden = false
  private carrotT = 0
  private carrotY = 0

  // radish
  private colors = ['红', '白', '紫']
  private myColor = 0
  private call: { color: number; t: number; resolved: boolean } | null = null
  private callT = 1.6

  constructor(ctx: GameContext) {
    super(ctx)
    this.theme = { ...(THEMES[ctx.meta.slug] ?? {
      rule: 'count', action: 'jump', label: '运动', color: '#ff7a45', hint: '跟着节拍动起来',
    }) }
    this.rule = this.theme.rule
    if (this.rule === 'radish') {
      this.myColor = Math.floor(Math.random() * 3)
      ctx.speak(`你是${this.colors[this.myColor]}萝卜`)
      ctx.setStage(`你是${this.colors[this.myColor]}萝卜`)
    }
    if (this.rule === 'race') {
      const marks = this.theme.obstacles ? [16, 30, 44, 58, 72, 86] : []
      this.obs = marks.map((d) => ({ d, lane: Math.random() < 0.5 ? 0 : 1, done: false }))
    }
  }

  /** 上升沿统一计算 */
  private edges(b: Body | null) {
    if (!b) {
      this.was = { jump: false, squat: false, lKnee: false, rKnee: false, lArm: false, rArm: false }
      return this.was
    }
    const e = {
      jump: b.jumping && !this.was.jump,
      squat: b.squat && !this.was.squat,
      lKnee: b.lKnee.y < b.lHip.y - 0.02 && !this.was.lKnee,
      rKnee: b.rKnee.y < b.rHip.y - 0.02 && !this.was.rKnee,
      lArm: b.lHandAboveHead && !this.was.lArm,
      rArm: b.rHandAboveHead && !this.was.rArm,
    }
    if (e.jump) this.jumpEdgeT = this.t
    this.was = {
      jump: b.jumping,
      squat: b.squat,
      lKnee: b.lKnee.y < b.lHip.y - 0.02,
      rKnee: b.rKnee.y < b.rHip.y - 0.02,
      lArm: b.lHandAboveHead,
      rArm: b.rHandAboveHead,
    }
    return e
  }

  private award(pts: number, x: number, y: number, color = '#fff36b') {
    this.combo++
    this.best = Math.max(this.best, this.combo)
    this.score += pts
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('best', this.best)
    this.say(`+${pts}`, x, y, color, 32)
  }

  private breakCombo(word?: string) {
    this.combo = 0
    this.ctx.setCombo(0)
    if (word) this.say(word, this.W / 2, 300, '#ff9f9f', 40)
  }

  tick(f: PoseFrame, dt: number) {
    const b = f.bodies[0] ?? null
    this.flash = Math.max(0, this.flash - dt * 3)
    switch (this.rule) {
      case 'count': this.tickCount(b, dt); break
      case 'rope': this.tickRope(b, dt); break
      case 'hurdle': this.tickHurdle(b, dt); break
      case 'race': this.tickRace(b, dt); break
      case 'tramp': this.tickTramp(b, dt); break
      case 'longjump': this.tickLongjump(b, dt); break
      case 'hopscotch': this.tickHopscotch(b, dt); break
      case 'bamboo': this.tickBamboo(b, dt); break
      case 'carrot': this.tickCarrot(b, dt); break
      case 'radish': this.tickRadish(b, dt); break
    }
    this.ctx.setScore(this.score)
  }

  // ---------- count：纯计数（原有玩法） ----------
  private tickCount(b: Body | null, dt: number) {
    this.beat += dt
    if (this.beat > this.beatInterval) {
      this.beat = 0
      this.flash = 1
      this.ctx.audio.tick()
      if (this.theme.rope) this.beatInterval = Math.max(0.42, this.beatInterval - 0.012)
    }
    if (!b) return

    if (this.theme.circuit) {
      this.stationT += dt
      if (this.stationT > 20) {
        this.stationT = 0
        this.station = (this.station + 1) % 3
        this.theme.action = (['squat', 'knee', 'jack'] as const)[this.station]
        this.ctx.setStage((['深蹲', '高抬腿', '开合跳'] as const)[this.station])
        this.ctx.speak(`换${(['深蹲', '高抬腿', '开合跳'] as const)[this.station]}`)
        this.was2 = { squat: false, l: false, r: false, jack: false, burpee: false }
      }
    }

    const a = this.theme.action
    if (a === 'jump') {
      if (b.jumping && !this.was2.jack) this.count()
      this.was2.jack = b.jumping
    } else if (a === 'squat') {
      if (b.squat && !this.was2.squat) this.count()
      this.was2.squat = b.squat
    } else if (a === 'knee') {
      const l = b.lKnee.y < b.lHip.y + 0.03
      const r = b.rKnee.y < b.rHip.y + 0.03
      if (l && !this.was2.l) this.count()
      if (r && !this.was2.r) this.count()
      this.was2.l = l
      this.was2.r = r
    } else if (a === 'jack') {
      const open = b.armsUp && b.feetSpread > Math.max(0.16, b.scale * 0.5)
      if (open && !this.was2.jack) this.count()
      this.was2.jack = open
    } else {
      if (b.squat) this.was2.burpee = true
      if (this.was2.burpee && b.jumping) {
        this.was2.burpee = false
        this.count()
      }
    }
  }

  private count() {
    this.reps++
    this.combo++
    this.best = Math.max(this.best, this.combo)
    const gain = 10 + Math.min(30, Math.floor(this.combo / 4) * 5)
    this.score += gain
    this.ctx.setCombo(this.combo)
    this.ctx.setExtra('reps', this.reps)
    this.ctx.setExtra('best', this.best)
    this.ctx.audio.jump()
    this.particles.burst(this.W / 2, this.H * 0.8, this.theme.color, 8, 260, 5, 400)
    this.say(`+${gain}`, this.W / 2, this.H * 0.62, '#fff36b', 34)
    if (this.reps % 10 === 0) {
      this.ctx.audio.good()
      this.say(`${this.reps} 个！`, this.W / 2, 210, '#ffd54a', 50)
    }
  }

  // ---------- rope：跳绳时机 ----------
  private tickRope(b: Body | null, dt: number) {
    if (this.ropeStun > 0) {
      this.ropeStun -= dt
      return
    }
    this.ropePhase += dt / this.ropeDur
    // k：0 绳在头顶 → 1 绳在脚下
    const k = (1 - Math.cos(this.ropePhase * Math.PI * 2)) / 2
    if (k > 0.88 && b?.jumping) this.windowAir = true
    if (this.ropePhase >= 1) {
      this.ropePhase = 0
      const ok = this.windowAir
      this.windowAir = false
      if (ok) {
        this.ropePasses++
        this.award(12 + Math.min(30, this.combo * 2), this.W / 2, this.H * 0.45)
        this.ctx.audio.jump()
        if (this.ropePasses % 5 === 0) {
          this.ropeDur = Math.max(0.5, this.ropeDur - 0.07)
          this.say('加速咯！', this.W / 2, 220, '#ffd54a', 44)
        }
      } else {
        this.ctx.audio.fail()
        this.breakCombo('绊住啦！')
        this.ropeStun = 0.9
      }
    }
  }

  // ---------- hurdle：跨栏时机 ----------
  private tickHurdle(b: Body | null, dt: number) {
    this.hSpeed = Math.min(720, this.hSpeed + dt * 5)
    this.hSpawn -= dt
    if (this.hSpawn <= 0) {
      this.hSpawn = Math.max(0.72, 1.15 - this.t * 0.004)
      this.hurdles.push({ x: this.W + 90, hit: false, done: false })
    }
    const lineX = 300
    for (const h of this.hurdles) {
      const prev = h.x
      h.x -= this.hSpeed * dt
      if (!h.done && prev >= lineX && h.x < lineX) {
        h.done = true
        if (b?.jumping) {
          const perfect = Math.abs(h.x - lineX) < 26
          this.award(perfect ? 20 : 13, lineX, 380, perfect ? '#3ddc97' : '#fff36b')
          if (perfect) this.say('完美！', lineX, 300, '#3ddc97', 36)
          this.ctx.audio.jump()
        } else {
          h.hit = true
          this.ctx.audio.fail()
          this.breakCombo('碰栏了！')
        }
      }
    }
    this.hurdles = this.hurdles.filter((h) => h.x > -80)
    this.dist += (this.hSpeed * dt) / 30
    this.ctx.setExtra('dist', Math.floor(this.dist))
  }

  // ---------- race：速度比拼 ----------
  private tickRace(b: Body | null, dt: number) {
    if (this.raceDone) return
    const e = this.edges(b)
    if (b) {
      if (this.theme.input === 'knee') {
        if (e.lKnee && this.lastSide !== 1) { this.v += 1.15; this.lastSide = 1 }
        if (e.rKnee && this.lastSide !== 2) { this.v += 1.15; this.lastSide = 2 }
      } else {
        if (e.lArm && this.lastSide !== 1) { this.v += 1.0; this.lastSide = 1 }
        if (e.rArm && this.lastSide !== 2) { this.v += 1.0; this.lastSide = 2 }
      }
      if (this.theme.obstacles) {
        if (this.laneBase < 0) this.laneBase = b.center.x
        else this.lane = b.center.x - this.laneBase < -0.05 ? 0 : 1
      }
    }
    const cap = 6.4 + this.ctx.difficulty * 0.5
    this.v = Math.min(cap, this.v)
    this.v -= this.v * 0.5 * dt
    const aiV = this.theme.obstacles ? 3.4 : this.theme.input === 'swim' ? 3.1 : 4.0
    const ai = aiV * (1 + Math.sin(this.t * 0.7) * 0.12)
    const prevM = this.myDist
    this.myDist += this.v * dt
    this.aiDist += ai * dt
    if (Math.floor(prevM / 10) !== Math.floor(this.myDist / 10)) {
      this.score += 25
      this.ctx.audio.good()
      this.say(`${Math.floor(this.myDist / 10) * 10} 米！`, this.W / 2, 240, '#ffd54a', 44)
    }
    if (this.theme.obstacles) {
      for (const o of this.obs) {
        if (!o.done && Math.abs(this.myDist - o.d) < 1.2 && o.lane === this.lane) {
          o.done = true
          this.v *= 0.3
          this.ctx.audio.fail()
          this.breakCombo('压到水坑啦')
        }
      }
    }
    this.ctx.setExtra('dist', Math.floor(this.myDist))
    if (this.myDist >= 100) {
      this.raceDone = true
      const win = this.myDist > this.aiDist
      this.score += 200 + Math.max(0, Math.round((22 - this.t) * 15)) + (win ? 150 : 0)
      this.ctx.audio.win()
      this.say(win ? '赢啦！' : '到终点！', this.W / 2, 300, '#ffd54a', 60)
      this.ctx.finish()
    }
  }

  // ---------- tramp：蹦床时机 ----------
  private tickTramp(b: Body | null, dt: number) {
    this.edges(b)
    const G = 2200
    const bed = 560
    this.avV += G * dt
    this.avY += this.avV * dt
    if (this.avY >= bed && this.avV > 0) {
      const dtJump = this.t - this.jumpEdgeT
      const timed = b ? dtJump < 0.3 : false
      if (timed) {
        this.rest = Math.min(1.12, this.rest + 0.13)
        this.award(12 + Math.min(30, this.combo * 2), this.W / 2, bed - 120, '#3ddc97')
        this.ctx.audio.jump()
      } else {
        this.rest = Math.max(0.5, this.rest - 0.07)
      }
      this.avV = -(500 + 700 * this.rest)
      this.avY = bed
    }
    for (const r of this.starRows) {
      r.cd = Math.max(0, r.cd - dt)
      if (r.cd <= 0 && Math.abs(this.avY - r.y) < 26) {
        r.cd = 1.6
        this.score += r.v
        this.ctx.audio.coin()
        this.particles.burst(this.W / 2, r.y, '#ffd54a', 10, 300, 5)
        this.say(`+${r.v}`, this.W / 2 + 90, r.y, '#ffd54a', 30)
      }
    }
    this.ctx.setExtra('height', Math.max(0, Math.round(bed - this.avY)))
  }

  // ---------- longjump：蓄力跳远 ----------
  private tickLongjump(b: Body | null, dt: number) {
    const e = this.edges(b)
    if (this.phase === 'ready') {
      if (b?.squat) {
        this.phase = 'charge'
        this.charge = 0
        this.sinceSquat = 0
      }
    } else if (this.phase === 'charge') {
      if (b?.squat) {
        this.charge = Math.min(1, this.charge + dt * 0.5)
        this.sinceSquat = 0
      } else {
        this.sinceSquat += dt
        this.charge = Math.max(0, this.charge - dt * 0.35)
        if (this.sinceSquat > 1.1) this.phase = 'ready'
      }
      if (e.jump && this.charge > 0.15) {
        const bonus = this.sinceSquat < 0.35 ? 1 : 0.75
        this.jumpDist = (1.4 + this.charge * 4.4) * bonus
        this.phase = 'air'
        this.flyT = 0
        this.ctx.audio.jump()
      }
    } else if (this.phase === 'air') {
      this.flyT += dt
      if (this.flyT >= 1) {
        this.bestDist = Math.max(this.bestDist, this.jumpDist)
        const pts = 40 + Math.round(this.jumpDist * 12)
        this.score += pts
        this.ctx.audio.good()
        this.say(`${this.jumpDist.toFixed(1)} 米！`, this.W / 2, 340, '#ffd54a', 52)
        this.attempts++
        this.ctx.setExtra('best', Math.round(this.bestDist * 10) / 10)
        this.phase = 'landed'
        this.landT = 1
      }
    } else {
      this.landT -= dt
      if (this.landT <= 0) {
        if (this.attempts >= 5) {
          this.ctx.finish()
          return
        }
        this.phase = 'ready'
      }
    }
  }

  // ---------- hopscotch：跳房子 ----------
  private tickHopscotch(b: Body | null, dt: number) {
    this.padSpeed = Math.min(430, this.padSpeed + dt * 3)
    this.padSpawn -= dt
    if (this.padSpawn <= 0) {
      const kind: 0 | 1 = Math.random() < 0.32 ? 1 : 0
      this.pads.push({ x: this.W + 140, kind, n: this.padN, checked: false })
      this.padN = this.padN % 10 + 1
      this.padSpawn = kind === 1 ? 1.35 : 1.0
    }
    const lineX = 320
    for (const p of this.pads) {
      const prev = p.x
      p.x -= this.padSpeed * dt
      if (!p.checked && prev >= lineX && p.x < lineX) {
        p.checked = true
        const spread = b ? b.feetSpread : 0
        if (!b?.jumping) {
          this.ctx.audio.fail()
          this.breakCombo('要跳起来')
        } else if (p.kind === 0 && spread > 0.2) {
          this.ctx.audio.fail()
          this.breakCombo('单格要并脚')
        } else if (p.kind === 1 && spread <= 0.2) {
          this.ctx.audio.fail()
          this.breakCombo('双格要分开')
        } else {
          this.award(14 + Math.min(20, this.combo * 2), lineX, 400)
          this.ctx.audio.jump()
        }
      }
    }
    this.pads = this.pads.filter((p) => p.x > -160)
  }

  // ---------- bamboo：跳竹竿 ----------
  private tickBamboo(b: Body | null, dt: number) {
    this.bFlash = Math.max(0, this.bFlash - dt * 2.5)
    this.bTimer -= dt
    if (this.bTimer <= 0) {
      this.open = !this.open
      this.bTimer = this.bInterval
      this.evalT = 0.4
      this.ctx.audio.tick()
    }
    if (this.evalT > 0) {
      this.evalT -= dt
      if (this.evalT <= 0) {
        if (b) {
          const wantOut = !this.open
          const isOut = b.feetSpread > 0.21
          const ok = wantOut === isOut
          if (ok) {
            this.bOk = 1
            this.bFlash = 1
            this.award(12 + Math.min(24, this.combo * 2), this.W / 2, this.H * 0.55, '#3ddc97')
            this.ctx.audio.jump()
          } else {
            this.bOk = -1
            this.bFlash = 1
            this.ctx.audio.fail()
            this.breakCombo(this.open ? '脚要收进来' : '脚要跳出去')
          }
        }
        this.bInterval = Math.max(0.62, this.bInterval - 0.01)
      }
    }
  }

  // ---------- carrot：拔萝卜 ----------
  private tickCarrot(b: Body | null, dt: number) {
    const e = this.edges(b)
    this.carrotT = Math.max(0, this.carrotT - dt)
    if (!b) return
    const zone = b.center.x < 0.4 ? 0 : b.center.x < 0.66 ? 1 : 2
    if (e.squat) {
      if (zone === this.carrotSide && this.carrotT <= 0) {
        this.carrotHp--
        this.carrotY = Math.min(1, this.carrotY + 0.3)
        this.ctx.audio.pop()
        this.particles.burst(this.W * (0.25 + this.carrotSide * 0.25), 560, '#ff9f1c', 6, 200, 4)
        if (this.carrotHp <= 0) {
          const pts = this.carrotGolden ? 60 : 30
          this.award(pts, this.W * (0.25 + this.carrotSide * 0.25), 480, '#ffd54a')
          this.ctx.audio.good()
          this.say(this.carrotGolden ? '大萝卜！' : '拔出来啦', this.W / 2, 260, '#ffd54a', 46)
          this.carrotT = 0.9
          this.nextCarrot()
        } else {
          this.score += 8
          this.say('+8', this.W * (0.25 + this.carrotSide * 0.25), 500, '#fff36b', 28)
        }
      } else if (zone !== this.carrotSide) {
        this.say('站到萝卜跟前', this.W / 2, 300, '#ffffffcc', 30)
      }
    }
  }

  private nextCarrot() {
    this.carrotSide = Math.floor(Math.random() * 3)
    this.carrotGolden = Math.random() < 0.18
    this.carrotMax = this.carrotGolden ? 5 : 2 + Math.floor(Math.random() * 3)
    this.carrotHp = this.carrotMax
    this.carrotY = 0
  }

  // ---------- radish：萝卜蹲（听指令抑制） ----------
  private tickRadish(b: Body | null, dt: number) {
    const e = this.edges(b)
    if (!this.call) {
      this.callT -= dt
      if (this.callT <= 0) {
        const color = Math.random() < 0.45 ? this.myColor : (this.myColor + 1 + Math.floor(Math.random() * 2)) % 3
        this.call = { color, t: 1.5, resolved: false }
        this.ctx.speak(`${this.colors[color]}萝卜蹲`)
      }
      return
    }
    this.call.t -= dt
    const mine = this.call.color === this.myColor
    if (e.squat && !this.call.resolved) {
      this.call.resolved = true
      if (mine) {
        this.award(12, this.W / 2, this.H * 0.5)
        this.ctx.audio.jump()
      } else {
        this.ctx.audio.fail()
        this.breakCombo('上当啦！')
        this.score = Math.max(0, this.score - 12)
      }
    } else if (this.call.t <= 0 && !this.call.resolved) {
      this.call.resolved = true
      if (mine) {
        this.breakCombo('漏蹲了')
        this.score = Math.max(0, this.score - 6)
      } else {
        this.combo++
        this.best = Math.max(this.best, this.combo)
        this.score += 8
        this.ctx.setCombo(this.combo)
        this.say('忍住了 +8', this.W / 2, this.H * 0.5, '#3ddc97', 32)
        this.ctx.audio.good()
      }
    }
    if (this.call.resolved && this.call.t <= 0) {
      this.call = null
      this.callT = 1.4 + Math.random() * 0.8
    }
  }

  // ================= 绘制 =================

  paint(c: CanvasRenderingContext2D) {
    switch (this.rule) {
      case 'count': this.paintCount(c); break
      case 'rope': this.paintRope(c); break
      case 'hurdle': this.paintHurdle(c); break
      case 'race': this.paintRace(c); break
      case 'tramp': this.paintTramp(c); break
      case 'longjump': this.paintLongjump(c); break
      case 'hopscotch': this.paintHopscotch(c); break
      case 'bamboo': this.paintBamboo(c); break
      case 'carrot': this.paintCarrot(c); break
      case 'radish': this.paintRadish(c); break
    }
    this.hud(c)
  }

  private hud(c: CanvasRenderingContext2D) {
    if (this.combo >= 5) {
      c.fillStyle = 'rgba(10,14,40,.4)'
      c.beginPath()
      c.roundRect(this.W - 234, 26, 210, 52, 26)
      c.fill()
      outlineTxt(c, `连击 ${this.combo}`, this.W - 129, 52, 28, '#ffd54a')
    }
    txt(c, this.theme.hint, this.W / 2, this.H - 34, 20, 'rgba(255,255,255,.82)', 'center', 'bold')
  }

  private paintCount(c: CanvasRenderingContext2D) {
    const B = 132
    const pct = Math.min(1, this.beat / this.beatInterval)
    ring(c, B, 112, 62, pct, this.theme.color, 9)
    const scale = 1 + this.flash * 0.12
    c.save()
    c.translate(B, 112)
    c.scale(scale, scale)
    outlineTxt(c, String(this.reps), 0, 0, 56, '#fff')
    c.restore()

    if (this.theme.circuit) {
      c.fillStyle = 'rgba(10,16,44,.55)'
      c.beginPath()
      c.roundRect(this.W / 2 - 150, 20, 300, 58, 29)
      c.fill()
      outlineTxt(c, ['第一站 深蹲', '第二站 高抬腿', '第三站 开合跳'][this.station], this.W / 2, 49, 30, '#ffd54a')
      // 站内进度
      const p = Math.min(1, this.stationT / 20)
      c.fillStyle = 'rgba(255,255,255,.25)'
      c.fillRect(this.W / 2 - 130, 68, 260, 5)
      c.fillStyle = '#3ddc97'
      c.fillRect(this.W / 2 - 130, 68, 260 * p, 5)
    }

    if (this.theme.rope) this.drawRopeArc(c)
  }

  private drawRopeArc(c: CanvasRenderingContext2D) {
    const b = this.players[0].body
    const cx = b ? b.center.x * this.W : 132
    const top = 120
    const bottom = b ? Math.max(b.lFoot.y, b.rFoot.y) * this.H + 20 : this.H * 0.9
    const t = this.beat / this.beatInterval
    const swing = Math.sin(t * Math.PI)
    const lh = b ? { x: b.lHand.x * this.W, y: b.lHand.y * this.H } : { x: cx - 150, y: top + 30 }
    const rh = b ? { x: b.rHand.x * this.W, y: b.rHand.y * this.H } : { x: cx + 150, y: top + 30 }
    c.beginPath()
    c.moveTo(lh.x, lh.y)
    c.quadraticCurveTo(cx, top + (bottom - top) * (0.2 + swing * 1.2), rh.x, rh.y)
    c.strokeStyle = 'rgba(255,255,255,.75)'
    c.lineWidth = 7
    c.lineCap = 'round'
    c.stroke()
    const near = t > 0.72 && t < 0.98
    if (near) {
      c.beginPath()
      c.ellipse(cx, bottom + 6, 150, 22, 0, 0, Math.PI * 2)
      c.strokeStyle = 'rgba(255,212,74,.9)'
      c.lineWidth = 5
      c.stroke()
    }
  }

  private paintRope(c: CanvasRenderingContext2D) {
    const b = this.players[0].body
    const k = this.ropeStun > 0 ? 1 : (1 - Math.cos(this.ropePhase * Math.PI * 2)) / 2
    const cx = b ? b.center.x * this.W : this.W / 2
    const feetY = b ? Math.max(b.lFoot.y, b.rFoot.y) * this.H : this.H * 0.88
    const lh = b ? { x: b.lHand.x * this.W, y: b.lHand.y * this.H } : { x: cx - 150, y: 200 }
    const rh = b ? { x: b.rHand.x * this.W, y: b.rHand.y * this.H } : { x: cx + 150, y: 200 }
    const ctrlY = feetY + 250 - k * 820
    c.beginPath()
    c.moveTo(lh.x, lh.y)
    c.quadraticCurveTo(cx, ctrlY, rh.x, rh.y)
    c.strokeStyle = this.ropeStun > 0 ? '#ff8fa3' : 'rgba(255,255,255,.85)'
    c.lineWidth = 8
    c.lineCap = 'round'
    c.stroke()
    // 危险窗口提示
    if (k > 0.8 && this.ropeStun <= 0) {
      c.beginPath()
      c.ellipse(cx, feetY + 8, 170, 26, 0, 0, Math.PI * 2)
      c.strokeStyle = 'rgba(255,90,90,.95)'
      c.lineWidth = 6
      c.stroke()
    }
    if (this.ropeStun > 0) {
      outlineTxt(c, '绊住了，歇一下', this.W / 2, 260, 44, '#ff9f9f')
    }
    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(24, 24, 190, 52, 26)
    c.fill()
    outlineTxt(c, `过了 ${this.ropePasses} 圈`, 119, 50, 26, '#ffd54a')
    // 速度档
    outlineTxt(c, `速度 ${(1.05 / this.ropeDur).toFixed(1)}x`, this.W - 119, 50, 24, '#fff')
  }

  private paintHurdle(c: CanvasRenderingContext2D) {
    const b = this.players[0].body
    const groundY = 600
    // 跑道
    c.fillStyle = 'rgba(255,255,255,.08)'
    c.fillRect(0, groundY, this.W, 60)
    c.strokeStyle = 'rgba(255,255,255,.35)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(0, groundY)
    c.lineTo(this.W, groundY)
    c.stroke()
    // 起跳线
    const lineX = 300
    c.strokeStyle = 'rgba(255,212,74,.9)'
    c.lineWidth = 5
    c.setLineDash([12, 10])
    c.beginPath()
    c.moveTo(lineX, groundY - 260)
    c.lineTo(lineX, groundY + 40)
    c.stroke()
    c.setLineDash([])
    outlineTxt(c, '起跳线', lineX, groundY - 285, 22, '#ffd54a')

    // 栏架
    for (const h of this.hurdles) {
      c.save()
      c.translate(h.x, groundY)
      if (h.hit) c.rotate(0.5)
      c.strokeStyle = '#ff6b6b'
      c.lineWidth = 7
      c.beginPath()
      c.moveTo(-34, 0)
      c.lineTo(-34, -86)
      c.moveTo(34, 0)
      c.lineTo(34, -86)
      c.stroke()
      c.fillStyle = 'rgba(255,255,255,.92)'
      c.fillRect(-40, -100, 80, 22)
      c.fillStyle = '#ff6b6b'
      for (let i = 0; i < 3; i++) c.fillRect(-40 + i * 27, -100, 13, 22)
      c.restore()
    }

    // 小人（位置固定，跳起跟随）
    const jy = b?.jumping ? 60 : 0
    const px = lineX
    circle(c, px, groundY - 150 - jy, 22, this.theme.color)
    circle(c, px, groundY - 118 - jy, 34, 'rgba(255,255,255,.25)')
    if (b?.jumping) glow(c, px, groundY - 150 - jy, 60, this.theme.color, 0.5)

    c.fillStyle = 'rgba(10,14,40,.4)'
    c.beginPath()
    c.roundRect(24, 24, 210, 52, 26)
    c.fill()
    outlineTxt(c, `${Math.floor(this.dist)} 米`, 129, 50, 26, '#ffd54a')
  }

  private paintRace(c: CanvasRenderingContext2D) {
    // 进度条
    const barY = 60
    const barW = this.W - 320
    c.fillStyle = 'rgba(10,14,40,.5)'
    c.beginPath()
    c.roundRect(150, barY - 18, barW, 36, 18)
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,.3)'
    c.lineWidth = 2
    c.stroke()
    // 终点旗
    txt(c, '🏁', 150 + barW + 24, barY, 34)
    // 对手
    const ax = 150 + barW * Math.min(1, this.aiDist / 100)
    txt(c, this.theme.obstacles ? '🚴' : this.theme.input === 'swim' ? '🐬' : '🐆', ax - 4, barY, 30)
    // 我
    const mx = 150 + barW * Math.min(1, this.myDist / 100)
    circle(c, mx, barY, 12, this.theme.color)
    circle(c, mx, barY, 5, '#fff')
    outlineTxt(c, `${Math.floor(this.myDist)}m / 100m`, this.W / 2, 118, 24, '#ffffffcc')

    if (this.theme.obstacles) {
      // 双车道
      const laneY = [430, 530]
      for (let i = 0; i < 2; i++) {
        c.strokeStyle = i === this.lane ? 'rgba(255,212,74,.8)' : 'rgba(255,255,255,.2)'
        c.lineWidth = 4
        c.beginPath()
        c.moveTo(0, laneY[i] + 60)
        c.lineTo(this.W, laneY[i] + 60)
        c.stroke()
        if (i === this.lane) {
          c.fillStyle = 'rgba(255,212,74,.08)'
          c.fillRect(0, laneY[i] - 60, this.W, 120)
        }
      }
      // 水坑
      for (const o of this.obs) {
        const x = this.W - 140 - (o.d - this.myDist) * 26
        if (x < -60 || x > this.W + 60) continue
        txt(c, o.done ? '💨' : '🟦', x, laneY[o.lane], 52)
      }
      txt(c, '🚲', this.W - 140, laneY[this.lane], 64)
      outlineTxt(c, '往左歪 = 上道，往右歪 = 下道', this.W / 2, 330, 24, '#ffffffb0')
    } else if (this.theme.input === 'swim') {
      // 泳道水波
      for (let i = 0; i < 3; i++) {
        const y = 420 + i * 60
        c.strokeStyle = 'rgba(120,190,255,.25)'
        c.lineWidth = 3
        c.beginPath()
        for (let x = 0; x <= this.W; x += 40) {
          const yy = y + Math.sin(x / 60 + this.t * 2 + i) * 6
          x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy)
        }
        c.stroke()
      }
      txt(c, '🏊', this.W - 160, 470, 60)
    } else {
      // 跑道速度表
      const pct = Math.min(1, this.v / 7)
      ring(c, this.W - 110, this.H - 120, 56, pct, this.theme.color, 10)
      outlineTxt(c, `${this.v.toFixed(1)}`, this.W - 110, this.H - 120, 34, '#fff')
      txt(c, '速度', this.W - 110, this.H - 60, 18, 'rgba(255,255,255,.8)', 'center', 'bold')
    }
  }

  private paintTramp(c: CanvasRenderingContext2D) {
    const bed = 560
    // 蹦床
    c.strokeStyle = '#8a6aee'
    c.lineWidth = 10
    c.beginPath()
    c.moveTo(this.W / 2 - 180, bed + 16)
    c.lineTo(this.W / 2 - 150, bed)
    c.lineTo(this.W / 2 + 150, bed)
    c.lineTo(this.W / 2 + 180, bed + 16)
    c.stroke()
    c.strokeStyle = '#b39dff'
    c.lineWidth = 8
    c.beginPath()
    c.moveTo(this.W / 2 - 150, bed)
    c.lineTo(this.W / 2 + 150, bed)
    c.stroke()

    // 星星行
    for (const r of this.starRows) {
      const on = r.cd <= 0
      c.globalAlpha = on ? 1 : 0.18
      star(c, this.W / 2, r.y, on ? 20 : 14, '#ffd54a')
      txt(c, `+${r.v}`, this.W / 2 + 46, r.y, 20, '#ffd54acc', 'left', 'bold')
      c.globalAlpha = 1
    }

    // 小人
    const y = this.avY
    glow(c, this.W / 2, y, 60, this.theme.color, 0.5)
    circle(c, this.W / 2, y - 26, 20, '#ffd9b3')
    circle(c, this.W / 2, y + 8, 24, this.theme.color)
    // 接近床面时的时机圈
    if (this.avV > 0 && y > bed - 200) {
      const p = Math.max(0, Math.min(1, (y - (bed - 200)) / 200))
      ring(c, this.W / 2, bed, 46 + (1 - p) * 60, 1 - p, '#3ddc97', 6)
    }
    outlineTxt(c, `高度 ${Math.max(0, Math.round(bed - this.avY))}`, this.W - 120, this.H - 120, 26, '#fff')
  }

  private paintLongjump(c: CanvasRenderingContext2D) {
    const groundY = 620
    // 跑道 + 米尺
    c.fillStyle = 'rgba(255,255,255,.08)'
    c.fillRect(0, groundY, this.W, 50)
    c.font = 'bold 18px "PingFang SC",system-ui'
    c.textAlign = 'center'
    for (let m = 1; m <= 6; m++) {
      const x = 220 + m * 140
      c.strokeStyle = 'rgba(255,255,255,.4)'
      c.lineWidth = 2
      c.beginPath()
      c.moveTo(x, groundY)
      c.lineTo(x, groundY + 50)
      c.stroke()
      c.fillStyle = 'rgba(255,255,255,.75)'
      c.fillText(`${m}m`, x, groundY + 70)
    }
    // 最好成绩旗
    if (this.bestDist > 0) {
      const bx = 220 + this.bestDist * 140
      txt(c, '🚩', bx, groundY - 20, 34)
    }

    // 小人
    const startX = 220
    let px = startX
    let py = groundY - 40
    if (this.phase === 'charge') {
      py = groundY - 10
    } else if (this.phase === 'air') {
      const p = this.flyT
      px = startX + this.jumpDist * 140 * p
      py = groundY - 40 - Math.sin(p * Math.PI) * (60 + this.charge * 120)
    } else if (this.phase === 'landed') {
      px = startX + this.jumpDist * 140
    }
    glow(c, px, py, 46, this.theme.color, 0.4)
    circle(c, px, py, 20, this.theme.color)

    // 蓄力条
    if (this.phase === 'charge' || this.phase === 'ready') {
      const x = 90
      c.fillStyle = 'rgba(10,14,40,.5)'
      c.beginPath()
      c.roundRect(x - 16, 300, 32, 260, 16)
      c.fill()
      const h = 228 * this.charge
      c.fillStyle = this.charge > 0.85 ? '#ff6b6b' : this.theme.color
      c.beginPath()
      c.roundRect(x - 9, 552 - h, 18, h, 9)
      c.fill()
      outlineTxt(c, '蓄力', x, 590, 22, '#fff')
    }

    // 状态提示
    const msg = this.phase === 'ready' ? '蹲下开始蓄力'
      : this.phase === 'charge' ? '蓄力中…站起来瞬间跳！'
        : this.phase === 'air' ? `${this.jumpDist.toFixed(1)} 米！`
          : `第 ${this.attempts} / 5 次`
    outlineTxt(c, msg, this.W / 2, 180, 40, '#fff')
    // 次数点
    for (let i = 0; i < 5; i++) {
      circle(c, this.W / 2 - 60 + i * 30, 240, 7, i < this.attempts ? this.theme.color : 'rgba(255,255,255,.3)')
    }
  }

  private paintHopscotch(c: CanvasRenderingContext2D) {
    const groundY = 560
    c.strokeStyle = 'rgba(255,255,255,.3)'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(0, groundY + 80)
    c.lineTo(this.W, groundY + 80)
    c.stroke()
    // 起跳线
    const lineX = 320
    c.strokeStyle = 'rgba(255,212,74,.8)'
    c.lineWidth = 4
    c.setLineDash([10, 8])
    c.beginPath()
    c.moveTo(lineX, groundY - 160)
    c.lineTo(lineX, groundY + 80)
    c.stroke()
    c.setLineDash([])

    for (const p of this.pads) {
      c.save()
      c.translate(p.x, groundY)
      if (p.kind === 0) {
        c.fillStyle = 'rgba(255,212,74,.9)'
        c.beginPath()
        c.roundRect(-52, -100, 104, 100, 12)
        c.fill()
        outlineTxt(c, String(p.n), 0, -50, 44, '#5a3e00')
      } else {
        c.fillStyle = 'rgba(76,201,240,.9)'
        c.beginPath()
        c.roundRect(-96, -100, 88, 100, 12)
        c.roundRect(8, -100, 88, 100, 12)
        c.fill()
        outlineTxt(c, String(p.n), -52, -50, 34, '#0a3550')
        outlineTxt(c, String(p.n), 52, -50, 34, '#0a3550')
      }
      c.restore()
    }
    outlineTxt(c, '🦶', lineX, groundY - 40, 40)
  }

  private paintBamboo(c: CanvasRenderingContext2D) {
    const b = this.players[0].body
    const y = this.H * 0.82
    const gap = this.open ? 190 : 26
    // 两根竹竿
    for (const s of [-1, 1]) {
      const cx = this.W / 2 + s * gap
      c.save()
      c.translate(cx, y)
      c.fillStyle = '#3f8f22'
      c.beginPath()
      c.roundRect(-110, -16, 220, 32, 14)
      c.fill()
      c.strokeStyle = '#2c6b16'
      c.lineWidth = 3
      for (let i = -1; i <= 1; i++) {
        c.beginPath()
        c.moveTo(i * 60, -16)
        c.lineTo(i * 60, 16)
        c.stroke()
      }
      c.restore()
    }
    // 安全区提示
    if (this.open) {
      c.fillStyle = 'rgba(61,220,151,.18)'
      c.fillRect(this.W / 2 - gap + 110, y - 60, gap * 2 - 220, 120)
      outlineTxt(c, '脚在里面', this.W / 2, y - 90, 26, '#9ff0c8')
    } else {
      c.fillStyle = 'rgba(255,90,90,.15)'
      c.fillRect(this.W / 2 - gap - 100, y - 60, 200, 120)
      outlineTxt(c, '脚在外面', this.W / 2, y - 90, 26, '#ffc2c2')
    }
    // 玩家脚
    if (b) {
      for (const f of [b.lFoot, b.rFoot]) {
        circle(c, f.x * this.W, f.y * this.H, 16, '#ffd54a')
        circle(c, f.x * this.W, f.y * this.H, 7, '#fff')
      }
    }
    // 节拍闪
    if (this.bFlash > 0) {
      c.globalAlpha = this.bFlash * 0.35
      c.fillStyle = this.bOk >= 0 ? '#3ddc97' : '#ff5c5c'
      c.fillRect(0, 0, this.W, this.H)
      c.globalAlpha = 1
    }
    outlineTxt(c, this.open ? '开！' : '合！', this.W / 2, 150, 56, this.open ? '#9ff0c8' : '#ffd54a')
  }

  private paintCarrot(c: CanvasRenderingContext2D) {
    const b = this.players[0].body
    const groundY = 600
    c.fillStyle = 'rgba(80,140,60,.25)'
    c.fillRect(0, groundY, this.W, this.H - groundY)
    const sides = [0.25, 0.5, 0.75]
    for (let i = 0; i < 3; i++) {
      const x = this.W * sides[i]
      const active = i === this.carrotSide
      c.strokeStyle = active ? 'rgba(255,212,74,.95)' : 'rgba(255,255,255,.25)'
      c.lineWidth = active ? 5 : 3
      c.beginPath()
      c.ellipse(x, groundY + 10, 130, 30, 0, 0, Math.PI * 2)
      c.stroke()
      if (active) {
        const rise = this.carrotY * 70
        const y = groundY - rise
        // 叶子
        c.strokeStyle = '#4caf50'
        c.lineWidth = 8
        c.lineCap = 'round'
        for (const dx of [-16, 0, 16]) {
          c.beginPath()
          c.moveTo(x, y - 40)
          c.lineTo(x + dx, y - 80)
          c.stroke()
        }
        // 萝卜身
        c.fillStyle = this.carrotGolden ? '#ffd166' : '#ff8a3d'
        c.beginPath()
        c.moveTo(x - 34, y - 40)
        c.quadraticCurveTo(x, y - 46, x + 34, y - 40)
        c.quadraticCurveTo(x + 20, y + 30, x, y + 46)
        c.quadraticCurveTo(x - 20, y + 30, x - 34, y - 40)
        c.fill()
        // 血条（还要拔几下）
        const pct = 1 - this.carrotHp / this.carrotMax
        c.fillStyle = 'rgba(10,14,40,.55)'
        c.beginPath()
        c.roundRect(x - 44, y - 116, 88, 12, 6)
        c.fill()
        c.fillStyle = '#3ddc97'
        c.beginPath()
        c.roundRect(x - 41, y - 113, 82 * pct, 6, 3)
        c.fill()
      }
    }
    // 玩家位置指示
    if (b) {
      const px = b.center.x * this.W
      circle(c, px, groundY - 8, 14, '#ffd54a')
      txt(c, '你', px, groundY - 44, 22, '#ffd54a', 'center', 'bold')
    }
  }

  private paintRadish(c: CanvasRenderingContext2D) {
    // 三根萝卜
    const names = ['红萝卜', '白萝卜', '紫萝卜']
    const cols = ['#ff6b6b', '#f2f2f2', '#9b5de5']
    for (let i = 0; i < 3; i++) {
      const x = this.W / 2 + (i - 1) * 300
      const mine = i === this.myColor
      if (mine) {
        c.fillStyle = 'rgba(255,212,74,.15)'
        c.beginPath()
        c.roundRect(x - 110, 360, 220, 260, 24)
        c.fill()
        outlineTxt(c, '你', x, 350, 30, '#ffd54a')
      }
      // 身体
      c.fillStyle = cols[i]
      c.beginPath()
      c.ellipse(x, 530, 62, 78, 0, 0, Math.PI * 2)
      c.fill()
      // 叶子
      c.strokeStyle = '#4caf50'
      c.lineWidth = 10
      c.lineCap = 'round'
      for (const dx of [-26, 0, 26]) {
        c.beginPath()
        c.moveTo(x + dx * 0.4, 458)
        c.lineTo(x + dx, 400)
        c.stroke()
      }
      // 表情
      circle(c, x - 18, 520, 6, '#333')
      circle(c, x + 18, 520, 6, '#333')
      outlineTxt(c, names[i], x, 640, 26, mine ? '#ffd54a' : '#ffffffcc')
    }
    // 口令横幅
    if (this.call && !this.call.resolved) {
      const mine = this.call.color === this.myColor
      c.fillStyle = 'rgba(10,16,44,.6)'
      c.beginPath()
      c.roundRect(this.W / 2 - 220, 150, 440, 90, 30)
      c.fill()
      outlineTxt(c, `${this.colors[this.call.color]}萝卜蹲！`, this.W / 2, 183, 46, mine ? '#ffd54a' : '#fff')
      const pct = Math.min(1, this.call.t / 1.5)
      ring(c, this.W / 2 + 250, 195, 26, pct, '#4cc9f0', 6)
    }
  }
}

export default function create(ctx: GameContext) {
  return new RepGame(ctx)
}
