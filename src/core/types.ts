export interface Pt {
  x: number
  y: number
}

export interface LM {
  x: number
  y: number
  z: number
  visibility: number
}

/** 一帧里单个玩家的姿态（坐标已镜像成“屏幕坐标”，0~1） */
export interface Body {
  id: number
  visible: boolean
  lm: LM[]
  /** 屏幕左/右手（玩家自己的右手会出现在屏幕左侧） */
  lHand: Pt
  rHand: Pt
  lElbow: Pt
  rElbow: Pt
  lShoulder: Pt
  rShoulder: Pt
  lHip: Pt
  rHip: Pt
  lKnee: Pt
  rKnee: Pt
  lFoot: Pt
  rFoot: Pt
  head: Pt
  shoulderC: Pt
  hipC: Pt
  center: Pt
  /** 肩到踝的距离，用作尺度单位 */
  scale: number
  /** 帧间移动速度（归一化单位/秒），缺失时按屏幕像素感受换算 */
  lHandV: number
  rHandV: number
  hipV: number
  /** 派生动作 */
  armsUp: boolean
  squat: boolean
  jumping: boolean
  feetSpread: number
  lHandAboveHead: boolean
  rHandAboveHead: boolean
}

export interface PoseFrame {
  t: number
  dt: number
  bodies: Body[]
}

export type Mode = 'solo' | 'versus' | 'coop'

export interface HudSnapshot {
  score: number
  best: number
  combo: number
  timeLeft: number
  progress: number
  stage: string
  running: boolean
  finished: boolean
  stars: number
  extra: Record<string, number>
}

export interface GameContext {
  w: number
  h: number
  meta: import('@/data/games').GameMeta
  audio: import('./audio').AudioKit
  hud: () => HudSnapshot
  setScore(n: number): void
  addScore(n: number): void
  setCombo(n: number): void
  setStage(s: string): void
  setExtra(k: string, v: number): void
  speak(text: string): void
  finish(): void
  /** 难度档位 0/1/2，对应拿星标准的三个档 */
  difficulty: number
  /** 局内热力 0~1：随游戏时长线性爬升（站点由宿主黑盒维护，按「局内进度」推断口径对齐） */
  readonly heat: number
}

export interface Game {
  update(f: PoseFrame, dt: number): void
  draw(c: CanvasRenderingContext2D): void
  /** 场景装饰背景（public/bg/<name>.svg），只画在画面上下边缘，不挡摄像头 */
  bg?: string
  reset?(): void
  destroy?(): void
}

export interface GameFactory {
  (ctx: GameContext): Game
}
