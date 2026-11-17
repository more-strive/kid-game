# 动动乐园 · 复刻版

用电脑摄像头玩的儿童体感游戏合集，复刻 [dongdongpark.com](https://dongdongpark.com) 的 **110 个游戏**，玩法规则与难度参数按原站真实规则逆向对齐（65 个专属实现 + 4 个原型复用 + 41 个通用兜底）。

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

第一次用建议先走一遍 `/check` 设备检测：1 分钟查完摄像头、光线、站位，并确认**头 + 双手**都能被识别（游戏判定主要靠它们）。

## 目录结构

```
src/
├── core/                   体感引擎
│   ├── pose.ts             PoseTracker：摄像头 → 33 个关键点 → Body（含速度/跳/蹲/举手等派生）
│   ├── sim.ts              虚拟人体：不接摄像头也能演示和调试
│   ├── engine.ts           GameHost：倒计时、计时、计分、星级、暂停、主循环
│   ├── base.ts             BaseGame：玩家光标、骨架叠加、飘字、粒子、碰撞工具
│   ├── draw.ts             绘制工具（圆角矩形、描边字、星星、圆环、粒子、骨架连线）
│   ├── sprites.ts          道具/图标贴图加载，未就绪或缺失时由调用方回退矢量绘制
│   ├── audio.ts            WebAudio 合成音效 + 中文语音播报
│   └── types.ts            Body / PoseFrame / Game / GameContext
├── games/
│   ├── index.ts            注册表：slug → 实现（专属 or 原型），并按实现绑定场景背景
│   ├── generic.ts          通用玩法（剩余 41 个未专门实现的游戏用它兜底）
│   ├── impl/               65 个游戏的专属实现 + counter-kit.ts（计数类共用检测器）
│   └── proto/              玩法原型引擎：whack（打地鼠）/ catch（接礼物·算一算·拼字）
├── data/games.ts           110 个游戏的元数据（名称/玩法/年龄/运动量/类型/时长/拿星线）
├── router/                 路由：/ 、/games 、/game/:slug 、/play/:slug 、/check
├── views/                  Home / Games / Detail / Play / Check
├── styles/                 全局样式
└── components/             GameCard / StarRow
public/
├── models/pose_landmarker_lite.task   姿态模型（5.5MB / 5777746 字节，本地加载）
├── wasm/                              MediaPipe wasm（15MB，本地加载，不依赖 CDN）
├── icons/games/                       110 个游戏图标（OpenMoji 矢量，按 slug 命名）
├── icons/items/                       道具贴图（地鼠/星星/礼物/球类等 23 个）
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
| 游戏内道具贴图 | OpenMoji | CC BY-SA 4.0 | 23 个 / 68KB |
| 场景装饰背景 | 本项目脚本生成 | 随项目 | 4 张 / 26KB |
| 音效 | [Kenney](https://kenney.nl) Interface Sounds + Music Jingles | CC0 | 12 个 / 104KB |
| 背景音乐 | `audio.ts` WebAudio 实时合成 | 随项目 | 0 字节 |

自产素材合计不到 0.6MB；真正占体积的是姿态识别的运行时：`public/wasm/` 15MB + `public/models/` 5.5MB。

> `public/wasm/` 里只保留 `vision_wasm_internal.{js,wasm}`。MediaPipe 包同时提供 `vision_wasm_module_internal.*`（ES module 版，另外 14.7MB），但 `FilesetResolver.forVisionTasks(base)` 的 `isModule` 参数默认 `false`，运行时永远不会加载它，所以没有拷进来。

署名见 `public/icons/LICENSE.txt` 与 `public/sfx/LICENSE.txt`（CC BY-SA 要求署名，CC0 不要求但保留来源更清晰）。

素材使用方式：

- **图标**：`GameCard.vue` 用 `${import.meta.env.BASE_URL}icons/games/<slug>.svg` 直接渲染，替换 emoji 字体渲染，跨平台一致。
- **道具**：`src/core/sprites.ts` 负责加载与绘制，`drawItem()` / `drawGameIcon()` 未就绪时返回 `false`，调用方自动回退到 canvas 矢量绘制，所以首次加载或素材缺失也不会白屏。
- **背景**：`games/index.ts` 的 `BG_BY_PROTO` 按实现文件绑定场景（原型与部分专属实现都有，其余默认 `garden`），只画在画面上下边缘，中间透明，**不遮挡摄像头画面**。
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
6. 检测可视化：`drawSkeleton()` 按 BlazePose 33 点连线画出骨架（只画 `visibility ≥ 0.5` 的点，用玩家颜色），手部用 20px 半透明圆环 + 玩家色圆点标出，孩子能马上确认「我被看到了」。

## 游戏覆盖情况

**110 个游戏全部可进入、可玩、可计分、可拿星**，且星级分数线已统一对齐原站 **easy 档**（`games.ts` 里注释保留 medium/hard 三档数值）。

| 实现方式 | 数量 | 说明 |
| --- | --- | --- |
| 专属实现 `impl/` | 65 | 每个游戏一套独立规则，数值按原站逆向结果对齐 |
| 玩法原型 `proto/` | 4 | 打地鼠走 `whack.ts`；圣诞接礼物、算一算、拼字接接乐走 `catch.ts` |
| 通用兜底 `generic.ts` | 41 | 按玩法类型自动选「接/打/跳/摆」原型，保证能玩 |

`src/games/impl/counter-kit.ts` 不是游戏，是计数类游戏（跳绳/深蹲/高抬腿/开合跳/体能闯关/砍木头等）共用的检测器，移植自原站 counter 引擎。

早期版本用玩法原型覆盖了大批游戏，这批游戏现已全部迁到 `impl/`。剩下的 `rep / pose / aim / rhythm / whack-legacy` 五套原型确认无用后已删除（连同 `BG_BY_PROTO` 里的残留映射），需要回溯时从 git 历史里取。

## 新增游戏

**方式一：写专属实现**

1. 在 `src/games/impl/<slug>.ts` 新建文件，`export default (ctx) => new YourGame(ctx)`。
2. 继承 `BaseGame`，实现 `tick(frame, dt)` 与 `paint(ctx)`。
3. 文件名等于 slug 即自动生效，无需注册。

**方式二：复用玩法原型**

1. 在对应 `src/games/proto/*.ts` 顶部的 `THEMES` 里加一条（slug → 颜色/形状/提示/判定）。
2. 在 `src/games/index.ts` 的 `ALIAS` 表里加一行 `'slug': './proto/xxx.ts'`。

> 目前只有 `whack.ts` 与 `catch.ts` 两套原型。`rep / pose / aim / rhythm` 四套已删除（其覆盖的游戏都有专属实现），确实需要复用时从 git 历史取回，并先按 `impl/` 里的对齐结果重新校准参数。

**方式三：计数类游戏**

跳绳/深蹲/高抬腿/开合跳/体能闯关这类「数次数」的游戏，不要重写检测逻辑：在 `impl/<slug>.ts` 里基于 `counter-kit.ts` 写一层薄配置（goal、breakGap、pairMax、星级线）即可。

## 部署

`.github/workflows/deploy.yml`：推 `main` 触发，`pnpm install && pnpm run build` → 复制 `dist/index.html` 为 `dist/404.html`（SPA 深链接兜底）→ 用 `appleboy/scp-action` 把 `dist/` 铺到自有服务器的 `DEPLOY_PATH`。

- 需要在仓库 Secrets 里配 `SSH_HOST` / `SSH_USERNAME` / `SSH_PRIVATE_KEY`。
- 部署在子目录（如 `https://domain/kid-game/`）时，把 workflow 里的 `BASE_PATH` 改成 `/kid-game/`；wasm、模型、图标都按 `import.meta.env.BASE_URL` 拼路径。
- `scp-action` 开了 `rm: true`，会先清空 `DEPLOY_PATH` 再上传，改路径前务必确认，写错等于删目录。
- 本地构建**不会**自动清空 `dist`（`vite.config.ts` 里 `emptyOutDir: false`，因为 public 下 200+ 文件会触发批量删除保护），所以每次 build 前先手动清一次，否则历史 hash 产物会一直堆着。单次干净构建约 **24MB / 78 个 assets**；不清的话会一路涨（曾累积到 62MB / 692 个 assets，其中 2.4MB 的 js 膨胀成 27MB）。

## 数据来源

`src/data/games.ts` 中 110 条元数据（名称、简介、三步玩法、训练目标、年龄、运动量、玩法类型、时长、两人模式、拿星分数线）来自站点公开页面，用于对齐玩法与难度。玩法规则、判定阈值、难度表则是逐个游戏逆向原站代码后得到的数值。

逆向资料放在仓库根目录的 `_reverse/`（已进 `.gitignore`，不随代码发布）：`catalog-full.json` 是站点 111 个游戏的元数据，`pretty/` 是还原后的站点 chunk，`reports/` 是每个游戏的玩法报告，`PROGRESS.md` 记录对齐进度与所有已解码的共享引擎数值。

## 已知限制

- 摄像头画面只在本机推理，不上传；首次进入需加载 15MB wasm + 5.5MB 模型（都在 `public/` 下，离线可用），弱网首局会等得久。
- 难度固定 easy 档：引擎里 `GameHost.difficulty` 支持 0/1/2 三档，但界面还没有切换入口，所有游戏都按 easy 档参数和星级线跑。
- 少数游戏（吹蜡烛、吹蒲公英、悄悄话大声喊、音高爬梯）在原站需要麦克风，此版本暂用动作替代，未接麦克风输入。
- 部分手势是用姿态代理的：张嘴→手贴头、出拳→挥手、音高→手的高低。站点有 face / hand 关键点时会更准。
- 参数已按原站数值对齐，但手感（生成速度、目标大小、手速阈值换算）仍需真机试玩校准。

## 开源协议

本项目代码以 [MIT License](LICENSE) 开源，Copyright © 2026 Nevermore。

第三方资源遵循各自协议：

- **MediaPipe Tasks Vision**（`@mediapipe/tasks-vision`、`public/wasm/`、`public/models/pose_landmarker_lite.task`）：Apache-2.0，Google
- 其余 npm 依赖见 `package.json`，协议以各自包内 LICENSE 为准
- `src/data/games.ts` 的游戏元数据整理自 [dongdongpark.com](https://dongdongpark.com) 公开页面，仅用于玩法对齐与学习研究，内容版权归原站所有
