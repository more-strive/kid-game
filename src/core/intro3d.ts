import type * as THREE_NS from 'three'
import type { LM } from './types'

/**
 * 详情页 3D 玩法示范。
 *
 * 首选 Xbot 骨骼蒙皮人形（public/intro/xbot.glb，597KB meshopt 压缩；
 * 来自 three.js 官方示例库，MIT，Mixamo 标准骨架），由 intro-pose 的
 * 33 关键点做骨骼 FK 驱动：每根骨骼把「静止指向」对准「目标指向」。
 * 模型加载失败时回退到程序生成的积木小人，保证零素材也能出画面。
 *
 * three.js 在本函数内部动态 import（独立 chunk，不进首屏；
 * 也不挂在 PlayView，避免与 MediaPipe 的 GPU 推理抢资源）。
 */

export interface IntroHandle {
  /** 推进动作时间并更新骨架（秒） */
  update(t: number): void
  render(): void
  resize(w: number, h: number): void
  dispose(): void
}

export interface IntroOpts {
  /** 游戏主题色（hex），每帧读取（仅兜底小人用） */
  color: () => string
  /** 目标姿态（33 关键点，归一化坐标） */
  pose: (t: number) => LM[]
}

/** Rig 需要把自己的根节点挂进场景 */
interface Rig {
  root: THREE_NS.Object3D
  apply(cur: Map<number, THREE_NS.Vector3>): void
  dispose(): void
}

/** 参与平滑与驱动的关键点编号 */
const PTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32]
/** 归一化坐标 → 世界坐标的系数（y 向下翻转为 y 向上） */
const W = 3

type Three = typeof import('three')

export async function createIntroScene(
  canvas: HTMLCanvasElement,
  opts: IntroOpts,
): Promise<IntroHandle | null> {
  const THREE = await import('three')
  let renderer: THREE_NS.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  } catch {
    return null // WebGL 不可用：调用方保持静态兜底图
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20)
  scene.add(new THREE.HemisphereLight(0xffffff, 0xbcd8ff, 1.2))
  const sun = new THREE.DirectionalLight(0xffffff, 1.6)
  sun.position.set(2, 3, 4)
  scene.add(sun)

  // 地面柔影（两种 Rig 共用）
  const blobMat = new THREE.MeshBasicMaterial({ color: 0x24355e, transparent: true, opacity: 0.12 })
  const blob = new THREE.Mesh(new THREE.CircleGeometry(1, 28), blobMat)
  blob.rotation.x = -Math.PI / 2
  blob.position.y = -1.22
  blob.scale.set(0.85, 1, 0.4)
  scene.add(blob)

  const rig = (await buildModelRig(THREE).catch(() => null)) ?? buildPuppetRig(THREE, opts)
  scene.add(rig.root)

  // —— 关键点平滑层：指数平滑后交给 Rig ——
  const cur = new Map<number, THREE_NS.Vector3>()
  for (const i of PTS) cur.set(i, new THREE.Vector3())
  const tmp = new THREE.Vector3()
  let lastT = -1

  const update = (t: number) => {
    const lms = opts.pose(t)
    const dt = lastT < 0 ? 0.016 : Math.min(0.05, Math.max(0.001, t - lastT))
    lastT = t
    const k = 1 - Math.exp(-dt * 14) // 与体感引擎一致的指数平滑
    for (const i of PTS) {
      const lm = lms[i]
      tmp.set((lm.x - 0.5) * W, (0.55 - lm.y) * W, lm.z * W * 0.6)
      cur.get(i)!.lerp(tmp, k)
    }
    rig.apply(cur)
  }

  const render = () => {
    // 轻微环绕视角，强调立体感
    camera.position.set(0.55 * Math.sin(lastT * 0.32), 0.55, 3.35)
    camera.lookAt(0, -0.05, 0)
    renderer.render(scene, camera)
  }

  const resize = (w: number, h: number) => {
    if (w <= 0 || h <= 0) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  const dispose = () => {
    rig.dispose()
    blob.geometry.dispose()
    blobMat.dispose()
    renderer.dispose()
  }

  return { update, render, resize, dispose }
}

// ============================ 蒙皮人形（首选） ============================

/** 骨骼驱动规则：bone 的指向（由 ref 子骨骼定义）对准关键点 from→to 的方向 */
interface DriveRule {
  bone: string
  ref: string
  from: number
  to: number
}

/** 特殊目标：躯干方向（髋心→肩心）/ 头部方向（肩心→鼻尖） */
const TORSO = -1
const HEAD = -2

const DRIVE: DriveRule[] = [
  // 躯干只驱动 Spine 一节：三节全指同一方向会把倾角放大三倍（耸肩驼背）
  { bone: 'Spine', ref: 'Spine1', from: TORSO, to: TORSO },
  { bone: 'Neck', ref: 'Head', from: HEAD, to: HEAD },
  { bone: 'LeftShoulder', ref: 'LeftArm', from: 11, to: 13 },
  { bone: 'LeftArm', ref: 'LeftForeArm', from: 13, to: 15 },
  { bone: 'LeftForeArm', ref: 'LeftHand', from: 13, to: 15 },
  { bone: 'RightShoulder', ref: 'RightArm', from: 12, to: 14 },
  { bone: 'RightArm', ref: 'RightForeArm', from: 14, to: 16 },
  { bone: 'RightForeArm', ref: 'RightHand', from: 14, to: 16 },
  { bone: 'LeftUpLeg', ref: 'LeftLeg', from: 23, to: 25 },
  { bone: 'LeftLeg', ref: 'LeftFoot', from: 25, to: 27 },
  { bone: 'RightUpLeg', ref: 'RightLeg', from: 24, to: 26 },
  { bone: 'RightLeg', ref: 'RightFoot', from: 26, to: 28 },
]

async function buildModelRig(THREE: Three): Promise<Rig> {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ])
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const url = `${import.meta.env.BASE_URL}intro/xbot.glb`
  const gltf = await loader.loadAsync(url) // 失败由调用方 catch → 兜底小人
  const root = gltf.scene

  const bySuffix = (suf: string): THREE_NS.Object3D | null => {
    let found: THREE_NS.Object3D | undefined
    root.traverse((o) => {
      if (!found && o.name.endsWith(suf)) found = o
    })
    return found ?? null
  }
  const hips = bySuffix('Hips')
  if (!hips?.parent) throw new Error('xbot.glb 骨骼不完整：缺 Hips')

  // 解析驱动规则，缺任何一根骨骼就放弃走兜底
  type Item = {
    bone: THREE_NS.Object3D
    ref: THREE_NS.Object3D
    parent: THREE_NS.Object3D
    from: number
    to: number
    restQ: THREE_NS.Quaternion
    dir: THREE_NS.Vector3
  }
  const items: Item[] = []
  for (const r of DRIVE) {
    const bone = bySuffix(r.bone)
    const ref = bySuffix(r.ref)
    if (!bone || !ref || !bone.parent) throw new Error(`xbot.glb 骨骼不完整：${r.bone}`)
    items.push({
      bone,
      ref,
      parent: bone.parent,
      from: r.from,
      to: r.to,
      restQ: new THREE.Quaternion(),
      dir: new THREE.Vector3(),
    })
  }

  // 等比缩放到舞台身高，再记录静止姿态（T-pose）下每根骨骼的世界四元数与指向
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  root.scale.setScalar(2.3 / Math.max(box.max.y - box.min.y, 0.001))
  root.updateMatrixWorld(true)
  const v1 = new THREE.Vector3()
  const v2 = new THREE.Vector3()
  for (const it of items) {
    it.restQ = it.bone.getWorldQuaternion(new THREE.Quaternion())
    it.dir.copy(it.ref.getWorldPosition(v1).sub(it.bone.getWorldPosition(v2)).normalize())
  }
  const hipsParent = hips.parent

  // 骨骼位移幅度大，蒙皮网格的包围盒不可靠
  root.traverse((o) => {
    if ((o as THREE_NS.Mesh).isMesh) o.frustumCulled = false
  })

  // apply 闭包用的工作向量（一次性分配）
  const hipC = new THREE.Vector3()
  const shC = new THREE.Vector3()
  const torsoDir = new THREE.Vector3()
  const headDir = new THREE.Vector3()
  const dTarget = new THREE.Vector3()
  const worldQ = new THREE.Quaternion()
  const parentQ = new THREE.Quaternion()

  return {
    root,
    apply(cur) {
      hipC.copy(cur.get(23)!).add(cur.get(24)!).multiplyScalar(0.5)
      shC.copy(cur.get(11)!).add(cur.get(12)!).multiplyScalar(0.5)
      torsoDir.copy(shC).sub(hipC).normalize()
      headDir.copy(cur.get(0)!).sub(shC).normalize()

      hips.position.copy(hipsParent.worldToLocal(hipC.clone()))
      hips.updateWorldMatrix(true, false)

      for (const it of items) {
        if (it.from === TORSO) dTarget.copy(torsoDir)
        else if (it.from === HEAD) dTarget.copy(headDir)
        else dTarget.copy(cur.get(it.to)!).sub(cur.get(it.from)!).normalize()
        // 世界系旋转 Δ：静止指向 → 目标指向；期望世界四元数 = Δ × 静止世界四元数
        worldQ.setFromUnitVectors(it.dir, dTarget).multiply(it.restQ)
        // 换算回局部：左乘父骨骼当前世界四元数的逆（父骨骼在本帧先更新）
        it.parent.getWorldQuaternion(parentQ)
        it.bone.quaternion.copy(parentQ.invert().multiply(worldQ))
        it.bone.updateWorldMatrix(true, false)
      }
    },
    dispose() {
      root.traverse((o) => {
        const m = o as THREE_NS.Mesh
        if (m.isMesh) {
          m.geometry?.dispose()
          const mats = Array.isArray(m.material) ? m.material : [m.material]
          for (const mat of mats) mat.dispose()
        }
      })
    },
  }
}

// ============================ 积木小人（兜底） ============================

function buildPuppetRig(THREE: Three, opts: IntroOpts): Rig {
  const JOINTS: Array<{ i: number; r: number; kind: 'head' | 'body' | 'hand' | 'foot' }> = [
    { i: 0, r: 0.125, kind: 'head' },
    { i: 11, r: 0.055, kind: 'body' },
    { i: 12, r: 0.055, kind: 'body' },
    { i: 13, r: 0.046, kind: 'body' },
    { i: 14, r: 0.046, kind: 'body' },
    { i: 15, r: 0.058, kind: 'hand' },
    { i: 16, r: 0.058, kind: 'hand' },
    { i: 23, r: 0.062, kind: 'body' },
    { i: 24, r: 0.062, kind: 'body' },
    { i: 25, r: 0.052, kind: 'body' },
    { i: 26, r: 0.052, kind: 'body' },
    { i: 27, r: 0.05, kind: 'foot' },
    { i: 28, r: 0.05, kind: 'foot' },
    { i: 31, r: 0.042, kind: 'foot' },
    { i: 32, r: 0.042, kind: 'foot' },
  ]
  const LIMBS: Array<[number, number, number]> = [
    [11, 13, 0.042],
    [13, 15, 0.038],
    [12, 14, 0.042],
    [14, 16, 0.038],
    [23, 25, 0.052],
    [25, 27, 0.046],
    [24, 26, 0.052],
    [26, 28, 0.046],
    [27, 31, 0.034],
    [28, 32, 0.034],
  ]

  const matHead = new THREE.MeshStandardMaterial({ color: 0xffd9b5, roughness: 0.85 })
  const matBody = new THREE.MeshStandardMaterial({ color: 0x7aa7ff, roughness: 0.85 })
  const matHand = new THREE.MeshStandardMaterial({ color: 0x4a5a9e, roughness: 0.85 })
  const matFoot = new THREE.MeshStandardMaterial({ color: 0x4a5a9e, roughness: 0.85 })
  const matOf = (kind: string) =>
    kind === 'head' ? matHead : kind === 'hand' ? matHand : kind === 'foot' ? matFoot : matBody

  const sphereGeo = new THREE.SphereGeometry(1, 18, 14)
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10)
  const group = new THREE.Group()

  const jointMesh = new Map<number, THREE_NS.Mesh>()
  for (const j of JOINTS) {
    const m = new THREE.Mesh(sphereGeo, matOf(j.kind))
    m.scale.setScalar(j.r)
    group.add(m)
    jointMesh.set(j.i, m)
  }
  const limbMeshes: Array<{ mesh: THREE_NS.Mesh; a: number; b: number; r: number }> = []
  for (const [a, b, r] of LIMBS) {
    const m = new THREE.Mesh(cylGeo, matBody)
    group.add(m)
    limbMeshes.push({ mesh: m, a, b, r })
  }
  const torso = new THREE.Mesh(sphereGeo, matBody)
  group.add(torso)

  let lastColor = ''
  const white = new THREE.Color(1, 1, 1)
  const dir = new THREE.Vector3()
  const yAxis = new THREE.Vector3(0, 1, 0)

  return {
    root: group,
    apply(cur) {
      const c = opts.color()
      if (c !== lastColor) {
        lastColor = c
        matBody.color.set(c).lerp(white, 0.3)
      }
      for (const j of JOINTS) jointMesh.get(j.i)!.position.copy(cur.get(j.i)!)
      for (const l of limbMeshes) {
        const pa = cur.get(l.a)!
        const pb = cur.get(l.b)!
        dir.subVectors(pb, pa)
        const len = Math.max(dir.length(), 0.01)
        l.mesh.position.copy(pa).addScaledVector(dir, 0.5)
        l.mesh.quaternion.setFromUnitVectors(yAxis, dir.divideScalar(len))
        l.mesh.scale.set(l.r, len, l.r)
      }
      const top = new THREE.Vector3().addVectors(cur.get(11)!, cur.get(12)!).multiplyScalar(0.5)
      const bottom = new THREE.Vector3().addVectors(cur.get(23)!, cur.get(24)!).multiplyScalar(0.5)
      dir.subVectors(bottom, top)
      const h = Math.max(dir.length(), 0.01)
      torso.position.copy(top).add(bottom).multiplyScalar(0.5)
      torso.quaternion.setFromUnitVectors(yAxis, dir.divideScalar(h))
      torso.scale.set(0.17, h * 0.52, 0.12)
    },
    dispose() {
      sphereGeo.dispose()
      cylGeo.dispose()
      matHead.dispose()
      matBody.dispose()
      matHand.dispose()
      matFoot.dispose()
    },
  }
}
