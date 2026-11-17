import type { Body, GameContext } from '@/core/types'
import { CounterGame, WaveCounter } from './counter-kit'

/** 跳绳计数（对齐站点：goal 100/120/145、breakGap 1.2s、波形弹跳检测） */
class RopeCount extends CounterGame {
  static GOALS = [100, 120, 145]
  counters = [new WaveCounter(), new WaveCounter()]

  constructor(ctx: GameContext) {
    super(ctx, 'rope', RopeCount.GOALS, 1.2, '#4dd0c4')
  }

  protected detector(pi: number) {
    return this.counters[pi]
  }

  protected step(b: Body, pi: number, t: number, dt: number) {
    return { rep: this.counters[pi].update(b, t, dt) }
  }

  protected hint() {
    return '拿绳跳或空手摇着跳都行，跳一下数一个'
  }
}

export default function create(ctx: GameContext) {
  return new RopeCount(ctx)
}
