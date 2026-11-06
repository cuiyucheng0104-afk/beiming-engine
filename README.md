<div align="center">

# 北冥引擎 · Beiming Engine

**代码即影片。一套引擎，三条渲染路线。**

三渲二 + 2.5D 的逐帧确定性渲染管线：画面由代码画出，可重渲、可追溯、可换一种画风重来。<br>
同一个仓库里，WebGL 风格化合成、原生 RTX 工具链与 86 式代码动画风格并存；对外展示 79 部成片，仓库完整归档 96 条案例。

<a href="https://cuiyucheng0104-afk.github.io/beiming-engine/"><img src="media/preview.gif" width="100%" alt="《北冥》概念样片预览 · 进入作品站"></a>

<sub>《北冥》概念样片 · 10 秒 · 有声完整版：<a href="https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0">1080p 与原生 4K</a></sub>

<br>

![three.js](https://img.shields.io/badge/three.js-r170-1d2140?style=flat-square)
![Canvas 2D](https://img.shields.io/badge/Canvas-2D-1d2140?style=flat-square)
![FFmpeg](https://img.shields.io/badge/FFmpeg-H.264-1d2140?style=flat-square)
![RTX](https://img.shields.io/badge/NVIDIA-RTX-1d2140?style=flat-square)
![License](https://img.shields.io/badge/code-MIT-1d2140?style=flat-square)

[**作品站**](https://cuiyucheng0104-afk.github.io/beiming-engine/) · [三条路线](docs/TRACKS.md) · [案例库](cases/INDEX.md) · [成片与素材下载](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11)

</div>

---

## 一台引擎，三种画法

| | 路线 | 画在哪里 | 入口 | 状态 |
|---|---|---|---|---|
| **A** | 北冥风格 · WebGL 三渲二 | 无头浏览器 + WebGL / Canvas 2D，逐帧确定性绘制 | [`engine/`](engine) · [`src/`](src) · [`lab/`](lab) | 主线，可出片（1080p / 原生 4K） |
| **B** | 北冥原生 · BNE · RTX 工具链 | 原生运行时 + 独立 GPU；同一套资产导出 GLB 后执行 | [`examples/raea/`](examples/raea) · [`docs/raea/`](docs/raea) | 10 秒实验已跑通，通用双后端仍在推进 |
| **C** | 北冥代码动画风格 · 86 式 | 代码即画面：Canvas / SVG / DOM / WebGL 各种风格实现 | [`cases/`](cases) · [`cases/vendor/`](cases/vendor) | 86 式画法，已产出 66 部成片 |

三条路线**分别验收**：WebGL 的 4K 成绩不记到原生头上，原生 GPU 的设备信息也不写成浏览器的实测。C 路线的风格库包含第三方开源实现，其来源、固定版本与许可义务统一记录在 [THIRD-PARTY.md](THIRD-PARTY.md)，署名随快照保留。

---

## 三条路线的分工

### A · 北冥风格 · WebGL 三渲二

造型、三色分档卡通着色、屏幕空间 ID 墨线、Kuwahara 颜料笔触、手绘底板与 Canvas 2D 人物全部由代码逐帧绘制；显示层单独合成。北冥路线吸收原生路线的镜头组织与实践，但画面仍由 WebGL 后端出。

管线九层：**形**（放样 / 弯曲 / 道具 / 山石）、**光**（卡通着色 / 表面层）、**景**（底板 / 穹顶 / 机位 / 影片外壳）、**笔**（ID 墨线 / 雾 / bloom / 调色 / Kuwahara / 纸纹）、**人**（Canvas 2D 笔触）、**界**（显示层与片名）、**时**（分层时钟）、**声**（DSP / 合成 / 混音）、**片**（无头浏览器逐帧 + FFmpeg）。模块表见下方「引擎九层」。

### B · 北冥原生 · BNE（RTX 原生工具链）

同一套鲲、渡船与绘画底板导出为 GLB，走原生运行时与独立 GPU。工作方式：先验证单帧与 1–2 秒片段，再按镜头推进；原生速度与画风质量分开记录。

| 内容 | 入口 |
|---|---|
| 调用链、材质、GPU、编码与确定性分析 | [源码对照](docs/raea/architecture.md) |
| 接口设计、文件落点、风格迁移与分阶段验收 | [技术集成指引](docs/raea/integration.md) |
| 程序化鲲 → GLB 骨骼动画 → 原生渲染 | [示例与复现命令](examples/raea/README.md) |
| 真实测量、兼容问题与剩余限制 | [实验记录](docs/raea/experiment.md) |

原生运行时需单独安装，其技术底座、固定版本与许可义务见 [THIRD-PARTY.md](THIRD-PARTY.md)，不随本仓库分发。

### C · 北冥代码动画风格 · 86 式

- **86 式风格库**：66 部已完成样片 + 20 种方法模板，覆盖笔触、材质、排版、信息图与剪辑节奏；作为画风参照与可复用方法库。
- **66 部成片**：源码、时间轴、声音程序、素材与成片全部归档，可还原到独立工作区再看。

选型与去重方法见 [源码对比](docs/cases/comparison.md)；PPT 如何变成这类代码动画，见 [PPT 流程](docs/cases/ppt-animation.md)。

---

## 快速开始

需要 Node.js 20+、FFmpeg、Python 3.10+。

```bash
npm run setup                       # 安装依赖与无头浏览器
pip install -r requirements.txt     # 声音部分
```

```bash
sh build.sh            # 一键重建整片：静帧样张 → 混音 → 逐帧渲染 → 封装（1920×1040）
sh build.sh --4k       # 原生 4K（3840×2080）
```

只想看画面：

```bash
npx http-server -p 8080 .
# open http://127.0.0.1:8080/            正片
# open http://127.0.0.1:8080/?test=kun   单个模块自测页
```

案例库与作品站：

```bash
python tools/casebook.py list                       # 96 条归档案例与状态
python tools/casebook.py check                      # 校验源码/素材哈希与风格库快照
python tools/casebook.py restore style-02-watercolor --source-only   # 还原到 out/casebook/
python tools/build-showcase.py                      # 重建作品站页面 showcase/index.html
```

> Windows 注意：`npm run cases:check` 等脚本调用 `python3`，若本机只有 `python`，请直接运行对应命令；另外让仓库以 LF 检出（`git config core.autocrlf false`），否则哈希校验会因换行变化失败。见 [THIRD-PARTY.md](THIRD-PARTY.md#5-windows-注意)。

---

## 作品站

[**进入作品站 →**](https://cuiyucheng0104-afk.github.io/beiming-engine/)（GitHub Pages）

对外展示的是策展版本：只上有成片预览的作品，共 **79 部**，按三类归档——北冥代码动画风格 66 部、PPT 故事片 7 部、发布会动画 6 部。没有成片展示的实验、预演与未获认可的版本不上站，但完整记录仍保留在仓库 `cases/`。

| 内容 | 数量 | 说明 |
|---|---:|---|
| 作品站展示 | 79 | 全部有观看预览，点开即播 |
| 仓库归档案例 | 96 | 95 个工程 + 1 组共用资源，含实验、预演与未认可版本 |
| 纯代码风格实验 | 66 | 笔触、材质、排版、信息图，均有历史成片 |
| PPT 故事介绍片 | 7 | 从原画分层、时间轴到代码镜头与混音的完整链路 |
| 发布会动画 | 6 | 发布会六条工程，另有 1 组共用资源在归档中 |
| 风格库 | 86 式 | 66 部成片 + 20 种方法模板 |

观看副本是历史成片转码的 960 宽预览，**不是重新渲染**；原始画质与素材包在 [casebook-2026.11 Release](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11)（9.28 GB，105 个资产）。

**状态是分开的**：已有成片 ≠ 画面被认可。未获认可的版本只在仓库归档中标注，不进入作品站。

---

## 引擎九层

| 层 | 做什么 | 引擎 |
|---|---|---|
| **形** | 轮廓表放样、翼型与鳍、沿脊传播的游动弯曲，程序化道具在表面上确定性散布 | `engine/form` |
| **光** | 三色分档卡通着色、量化阴影、背光与受光边缘光、下方补光，可叠斑驳与风化表面层 | `engine/shade` |
| **景** | 手绘底板作为三维空间里的面片与穹顶分层，按屏幕像素摆位，镜头一动，视差自然产生 | `engine/stage` |
| **笔** | 屏幕空间墨线（深度 + 物体 ID）、空气透视、bloom、调色、Kuwahara 颜料笔触、纸纹与颗粒 | `engine/look` |
| **人** | Canvas 2D 逐笔绘制：路径语言、可变宽墨线、轮廓光与渗色、水彩斑驳 | `engine/paint` |
| **界** | 显示层与片名，最后一层合成，永远清晰；毛笔字按笔顺落笔，带枯笔飞白 | `engine/overlay` |
| **时** | 分层时钟：角色一拍二、鲲一拍三，镜头与雾水每帧都动 | `engine/core` |
| **声** | 程序化音效、采样编配、混音与响度，全部确定性 | `engine/audio` |
| **片** | 无头浏览器逐帧截图，多路并行，FFmpeg 编码后无损拼接 | `engine/render` |

确定性贯穿始终：没有 `Date.now`，没有无种子随机。同一个时刻永远画出同一张图，任何一帧都可以单独重渲。

页面约定（任何影片，满足四条即可交给渲染器）：

```js
window.DUR = 10;                 // 时长（秒）
window.render = t => { … };      // 把画面画到时刻 t，必须确定性
window.READY = true;             // 贴图、字体、着色器全部就绪
window.TEXTS = t => [ … ];       // 可选：该时刻画面文字，供检查
```

---

## RTX 原生加速（WebGL 路线）

无头浏览器在工作站上默认会落到核显；把 ANGLE 切到 Vulkan，WebGL 直接跑在 RTX 独显上：

```bash
BEIMING_ANGLE=vulkan sh build.sh --4k
```

| | 重着色器单帧 | 原生 4K 整片（240 帧） |
|---|---:|---:|
| RTX 5090 · Vulkan | **0.52 ms** | **31 秒** |
| Apple M5 Pro · Metal | 5.17 ms | 51 秒 |

原生分辨率优先：4K 是算出来的，不是放大出来的。超分只用于拿不到原生分辨率的素材。详细数据见 [docs/渲染与4K.md](docs/渲染与4K.md)、[docs/RTX工作站.md](docs/RTX工作站.md)。原生路线的 GPU/编码证据单独记录，不与本表混用。

---

## 仓库地图

```
engine/      北冥引擎（形 / 光 / 景 / 笔 / 人 / 界 / 时 / 声 / 片）
src/         《北冥》样片：色板、六种鲲、渡船、角色、显示层、三个镜头
lab/         各模块自测页
audio/       《北冥》声音设计、配乐与混音编排
assets/      手绘底板与纸纹
examples/    北冥原生示例（资产桥、TSX 场景、运行包装）
docs/        路线手册、原生对照、案例方法、RTX 与验收
cases/       96 条归档案例：entries / previews / source / vendor / catalog.json
showcase/    作品站页面（GitHub Pages 入口，生成物）
tools/       work-plan、casebook、作品站生成器
tests/       契约与还原测试
```

---

## 许可与署名

本仓库自有代码以 **MIT** 开放；影片、底板与展示图保留所有权利；字体遵循 SIL OFL 1.1。详见 [LICENSE](LICENSE)。

仓库中包含第三方开源风格库与原生运行时资料，其许可证、固定版本与署名**按原样保留，不因整合而移除或改写**：完整清单与义务见 [THIRD-PARTY.md](THIRD-PARTY.md)，案例侧声明见 [cases/NOTICES.md](cases/NOTICES.md) 与 [cases/licenses/](cases/licenses)。

---

<sub>工程计划（21 项）与任务状态见 [docs/routes/](docs/routes/README.md)；用 `npm run routes:check` / `npm run routes:next` 查依赖与下一项。三条执行路线的技术分档见 [docs/TRACKS.md](docs/TRACKS.md)。</sub>
