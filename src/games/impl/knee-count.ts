import type { Body, GameContext } from '@/core/types'
import { CounterGame, KneePairCounter } from './counter-kit'

/** 高抬腿计数（对齐站点：goal 55/70/85 配对、pairMax 1.4/1.1/0.85s、breakGap 2.5s） */
class KneeCount extends CounterGame {
  static GOALS = [55, 70, 85]
  static PAIR_MAX = [1.4, 1.1, 0.85]
  counters = [new KneePairCounter(), new KneePairCounter()]

  constructor(ctx: GameContext) {
    super(ctx, 'knee', KneeCount.GOALS, 2.5, '#ff8fb1')
    const pm = KneeCount.PAIR_MAX[ctx.difficulty] ?? 1.1
    this.counters[0] = new KneePairCounter(pm)
    this.counters[1] = new KneePairCounter(pm)
  }

  protected detector(pi: number) {
    return this.counters[pi]
  }

  protected step(b: Body, pi: number, t: number) {
    return this.counters[pi].update(b, t)
  }

  protected hint() {
    return '左右膝盖轮流抬到胯那么高，各抬一次算一个'
  }
}

export default function create(ctx: GameContext) {
  return new KneeCount(ctx)
}
