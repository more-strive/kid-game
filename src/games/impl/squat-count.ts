import type { Body, GameContext } from '@/core/types'
import { CounterGame, SquatCounter } from './counter-kit'

/** 深蹲计数（对齐站点：goal 30/40/50、breakGap 3.5s、蹲到 QUALIFY 才算、0.5 以下提示蹲低一点） */
class SquatCount extends CounterGame {
  static GOALS = [30, 40, 50]
  counters = [new SquatCounter(), new SquatCounter()]

  constructor(ctx: GameContext) {
    super(ctx, 'squat', SquatCount.GOALS, 3.5, '#4d96ff')
  }

  protected detector(pi: number) {
    return this.counters[pi]
  }

  protected step(b: Body, _pi: number) {
    return this.counters[_pi].update(b)
  }

  protected hint() {
    return '蹲到大腿差不多平再站直才算一个，蹲不够低会提示'
  }
}

export default function create(ctx: GameContext) {
  return new SquatCount(ctx)
}
