# 动动乐园 · 复刻版

用电脑摄像头玩的儿童体感游戏合集，复刻 [dongdongpark.com](https://dongdongpark.com) 的 **110 个游戏**。

技术栈：**Vite + Vue 3 + TypeScript + Element Plus + UnoCSS**，姿态识别用 **MediaPipe Tasks Vision**（Pose Landmarker，本地 wasm）。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 快速开始

```bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # 产出 dist/
pnpm preview  # 本地预览构建产物
```

> 包管理器固定为 **pnpm 11**（`package.json` 里 `packageManager: pnpm@11.12.0`）。pnpm 默认不执行依赖的构建脚本，本项目在 `pnpm-workspace.yaml` 的 `allowBuilds` 里放行了 `esbuild`、`@parcel/watcher`，删掉这段会导致 vite 启动失败。
>
> 如需改用 npm/yarn，先删除 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`，再重新安装。

摄像头需要在 `localhost` 或 HTTPS 下才能打开。没有摄像头也可以点「先看演示（不用摄像头）」看虚拟小人玩。

## 目录结构

```
src/
├── core/                   体感引擎
│   ├── pose.ts             PoseTracker：摄像头 → 33 个关键点 → Body（含速度/跳/蹲/举手等派生）
│   ├── sim.ts              虚拟人体：不接摄像头也能演示和调试
│   ├── engine.ts           GameHost：倒计时、计时、计分、星级、暂停、主循环
│   ├── base.ts             BaseGame：玩家光标、飘字、粒子、碰撞工具
│   ├── draw.ts             绘制工具（圆角矩形、描边字、星星、圆环、粒子）
│   ├── audio.ts            WebAudio 合成音效 + 中文语音播报
│   └── types.ts            Body / PoseFrame / Game / GameContext
├── games/
│   ├── index.ts            注册表：slug → 实现（专属 or 玩法原型）
│   ├── generic.ts          通用玩法（未专门实现的游戏用它兜底，保证 110 个全可玩）
│   ├── impl/               单个游戏的专属实现
│   └── proto/              玩法原型引擎（一套引擎 + 每个游戏的主题配置）
├── data/games.ts           110 个游戏的元数据（名称/玩法/年龄/运动量/类型/时长/拿星线）
├── views/                  Home / Games / Detail / Play / Check
└── components/             GameCard / StarRow
public/
├── models/pose_landmarker_lite.task   姿态模型（5.5MB / 5777746 字节，本地加载）
├── wasm/                              MediaPipe wasm（本地加载，不依赖 CDN）
├── icons/games/                       110 个游戏图标（OpenMoji 矢量，按 slug 命名）
├── icons/items/                       道具贴图（地鼠/星星/礼物/球类等 25 个）
├── bg/                                4 张场景装饰背景（garden/stadium/stage/space）
└── sfx/                               12 个音效（Kenney CC0）
scripts/
├── fetch-icons.py                     批量拉取游戏图标（可重复执行，已存在的跳过）
└── gen-bg.py                          生成场景装饰背景 SVG
```

## 素材

原站的美术资源有版权，这里全部换成开源素材 + 自制矢量，许可允许商用：

| 用途 | 来源 | 许可 | 数量/体积 |
| --- | --- | --- | --- |
| 游戏图标（卡片、列表） | [OpenMoji](https://openmoji.org) | CC BY-SA 4.0 | 110 个 / 327KB |
| 游戏内道具贴图 | OpenMoji | CC BY-SA 4.0 | 25 个 / 约 80KB |
| 场景装饰背景 | 本项目脚本生成 | 随项目 | 4 张 / 26KB |
| 音效 | [Kenney](https://kenney.nl) Interface Sounds + Music Jingles | CC0 | 12 个 / 132KB |
| 背景音乐 | `audio.ts` WebAudio 实时合成 | 随项目 | 0 字节 |

署名见 `public/icons/LICENSE.txt` 与 `public/sfx/LICENSE.txt`（CC BY-SA 要求署名，CC0 不要求但保留来源更清晰）。

素材使用方式：

- **图标**：`GameCard.vue` 直接 `<img src="/icons/games/<slug>.svg">`，替换 emoji 字体渲染，跨平台一致。
- **道具**：`src/core/sprites.ts` 负责加载与绘制，`drawItem()` / `drawGameIcon()` 未就绪时返回 `false`，调用方自动回退到 canvas 矢量绘制，所以首次加载或素材缺失也不会白屏。
- **背景**：每套玩法原型绑定一张（`games/index.ts` 的 `BG_BY_PROTO`），只画在画面上下边缘，中间透明，**不遮挡摄像头画面**。
- **音效**：采样音效解码后播放，缺素材时回退到合成音；**BGM** 用振荡器现场合成 4 小节循环（C–Am–F–G，木琴旋律 + 低音 + 沙锤），避免几十 MB 的音乐文件。

替换素材：保持文件名与 slug 一致即可，代码不用改。

## 体感引擎原理

1. `getUserMedia` 拿摄像头画面，隐藏的 `<video>` 铺满舞台（`object-fit: cover` + 镜像）。
2. `PoseLandmarker.detectForVideo()` 每帧输出 33 个归一化关键点，支持同时 2 人。
3. `PoseTracker` 做四件事：**镜像 → 16:9 裁剪换算 → 指数平滑 → 派生特征**：
   - `lHandV / rHandV`：手部速度（归一化/秒），用来识别「挥」「切」「打」
   - `jumping`：脚踝相对站立基准抬高
   - `squat`：膝关节角度 + 髋部下降
   - `armsUp`、`feetSpread`、`handAboveHead` 等
4. 每个游戏只做两件事：`tick(frame, dt)` 更新逻辑、`paint(ctx)` 绘制。逻辑坐标系固定 `1280×720`，与窗口尺寸解耦。
5. Canvas 透明叠加在视频上，所以孩子能一边看自己一边玩。

## 游戏覆盖情况

**110 个游戏全部可进入、可玩、可计分、可拿星。**

| 实现方式 | 数量 | 说明 |
| --- | --- | --- |
| 专属实现 `impl/` | 3 | 木头人、水果忍者、托气球 |
| 玩法原型 `proto/` | 66 | 6 套引擎覆盖 66 个游戏，共用逻辑、独立主题与判定参数 |
| 通用兜底 `generic.ts` | 41 | 按玩法类型自动选「接/打/跳/摆」原型，保证能玩 |

6 套玩法原型：

- `whack.ts` 打击 —— 打地鼠、戳泡泡、踩星星、枕头大战、拍手开花、拳击
- `catch.ts` 接物 —— 接礼物、算一算、拼字接接乐、浇花、钓小鱼、捉萤火虫、喂羊驼、拍皮球
- `rep.ts` 计数 —— 跳绳大王、深蹲、高抬腿、开合跳、波比跳、蹦床、跳房子、跨栏、冲刺
- `pose.ts` 姿势 —— 穿墙洞、咔嚓合影、瑜伽、太极、动物模仿、老师说、反着做、跟跳舞蹈
- `aim.ts` 投掷 —— 投篮高手、投飞镖、射箭、保龄球、踢足球、守门员、乒乓、网球、排球
- `rhythm.ts` 节奏 —— 空中架子鼓、空中钢琴、摇滚吉他、节奏踏板、小指挥家、舞狮、划龙舟

## 新增一个游戏

**方式一：写专属实现**

1. 在 `src/games/impl/<slug>.ts` 新建文件，`export default (ctx) => new YourGame(ctx)`。
2. 继承 `BaseGame`，实现 `tick(frame, dt)` 与 `paint(ctx)`。
3. 文件名等于 slug 即自动生效，无需注册。

**方式二：复用玩法原型**

1. 在对应 `src/games/proto/*.ts` 顶部的 `THEMES` 里加一条（slug → 颜色/形状/提示/判定）。
2. 在 `src/games/index.ts` 的 `ALIAS` 表里加一行 `'slug': './proto/xxx.ts'`。

## 数据来源

`src/data/games.ts` 中 110 条元数据（名称、简介、三步玩法、训练目标、年龄、运动量、玩法类型、时长、两人模式、拿星分数线）来自站点公开页面，用于对齐玩法与难度。

## 已知限制

- 摄像头画面只在本机推理，不上传；首次进入需加载 5.5MB 模型（已放 `public/models`，离线可用）。
- 少数游戏（吹蜡烛、吹蒲公英、悄悄话大声喊、音高爬梯）在原站需要麦克风，此版本暂用动作替代，未接麦克风输入。
- 拿星分数线沿用原站数值，但玩法参数（生成速度、目标大小）与原站不完全一致，手感需按实际试玩再调。

## 开源协议

本项目代码以 [MIT License](LICENSE) 开源，Copyright © 2026 Nevermore。

第三方资源遵循各自协议：

- **MediaPipe Tasks Vision**（`@mediapipe/tasks-vision`、`public/wasm/`、`public/models/pose_landmarker_lite.task`）：Apache-2.0，Google
- 其余 npm 依赖见 `package.json`，协议以各自包内 LICENSE 为准
- `src/data/games.ts` 的游戏元数据整理自 [dongdongpark.com](https://dongdongpark.com) 公开页面，仅用于玩法对齐与学习研究，内容版权归原站所有
