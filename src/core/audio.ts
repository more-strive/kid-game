/** 纯 WebAudio 合成音效，无需外部素材 */
export class AudioKit {
  ctx: AudioContext | null = null
  private master: GainNode | null = null
  muted = false
  private voiceOn = true

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (!AC) return null
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.32
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') this.ctx.resume()
    return this.ctx
  }

  private tone(freq: number, dur = 0.12, type: OscillatorType = 'sine', gain = 0.5, slideTo?: number) {
    if (this.muted) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, ctx.currentTime)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), ctx.currentTime + dur)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur)
    o.connect(g)
    g.connect(this.master)
    o.start()
    o.stop(ctx.currentTime + dur + 0.02)
  }

  private noise(dur = 0.16, gain = 0.4, hp = 800) {
    if (this.muted) return
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    const len = Math.floor(ctx.sampleRate * dur)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2
    const src = ctx.createBufferSource()
    src.buffer = buf
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = hp
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(f)
    f.connect(g)
    g.connect(this.master)
    src.start()
  }

  pop() {
    this.tone(520 + Math.random() * 240, 0.09, 'sine', 0.45, 900)
  }
  coin() {
    this.tone(880, 0.07, 'triangle', 0.4)
    setTimeout(() => this.tone(1320, 0.1, 'triangle', 0.35), 60)
  }
  good() {
    this.tone(660, 0.1, 'triangle', 0.4)
    setTimeout(() => this.tone(990, 0.14, 'triangle', 0.36), 90)
  }
  slash() {
    this.noise(0.12, 0.5, 1600)
    this.tone(300, 0.08, 'sawtooth', 0.18, 120)
  }
  hit() {
    this.noise(0.1, 0.55, 500)
    this.tone(140, 0.12, 'square', 0.25, 60)
  }
  jump() {
    this.tone(380, 0.12, 'sine', 0.3, 760)
  }
  fail() {
    this.tone(300, 0.2, 'sawtooth', 0.22, 110)
  }
  tick() {
    this.tone(1100, 0.035, 'square', 0.16)
  }
  whistle() {
    this.tone(1600, 0.18, 'sine', 0.3, 2100)
    setTimeout(() => this.tone(2100, 0.22, 'sine', 0.3, 1700), 170)
  }
  win() {
    ;[523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.2, 'triangle', 0.35), i * 110))
  }
  lose() {
    ;[440, 370, 294].forEach((f, i) => setTimeout(() => this.tone(f, 0.24, 'triangle', 0.3), i * 150))
  }
  tonePop(lane = 0) {
    this.tone(440 * Math.pow(2, lane / 5), 0.12, 'triangle', 0.4)
  }
  countdown(last = false) {
    this.tone(last ? 880 : 520, last ? 0.3 : 0.12, 'square', 0.28)
  }

  speak(text: string, rate = 1) {
    if (this.muted || !this.voiceOn) return
    const synth = window.speechSynthesis
    if (!synth) return
    try {
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'zh-CN'
      u.rate = rate
      u.pitch = 1.15
      synth.speak(u)
    } catch {
      /* ignore */
    }
  }

  setVoice(on: boolean) {
    this.voiceOn = on
  }
  setMuted(m: boolean) {
    this.muted = m
    if (m) window.speechSynthesis?.cancel()
  }
}

export const audio = new AudioKit()
