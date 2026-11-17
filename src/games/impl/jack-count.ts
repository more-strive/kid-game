import type { Body, GameContext } from '@/core/types'
import { CounterGame, JackCounter } from './counter-kit'

/** 开合跳计数（对齐站点：goal 55/70/90、breakGap 2.5s、只跳腿/只举手 0.5s 纠正提示） */
class JackCount extends CounterGame {
  static GOALS = [55, 70, 90]
  counters = [new JackCounter(), new JackCounter()]

  constructor(ctx: GameContext) {
    super(ctx, 'jack', JackCount.GOALS, 2.5, '#ffa940')
  }

  protected detector(pi: number) {
    return this.counters[pi]
  }

  protected step(b: Body, pi: number, _t: number, dt: number) {
    return this.counters[pi].update(b, dt)
  }

  protected hint() {
    return '跳开时双手举过头，并拢时手放下，手脚同步才算'
  }
}

export default function create(ctx: GameContext) {
  return new JackCount(ctx)
}
