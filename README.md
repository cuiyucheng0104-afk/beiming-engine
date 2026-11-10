<div align="center">

# 北冥引擎 · Beiming Engine

**代码即影片。一套引擎，三条路线。**

三渲二 + 2.5D 的逐帧确定性渲染管线：造型、光影、墨线、镜头、版式与混音都写成代码，可重渲、可追溯、可换一种画风重来。<br>
手绘底板、提案原画、AI 生成的画面或公有领域影像只作素材，来源逐部记录在案例卡里；对外展示 79 部成片，仓库完整归档 96 条案例。

<a href="https://cuiyucheng0104-afk.github.io/beiming-engine/"><img src="media/preview.gif" width="100%" alt="《北冥》样片的三个镜头：黄昏江面上的城市与渡轮，戴眼镜的女水手侧影，背上长满海草的鲲从头顶游过。点击进入作品站"></a>

<sub>《北冥》概念样片 · 10 秒 · 有声完整版：<a href="https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0">1080p 与原生 4K</a></sub>

<br>

![three.js](https://img.shields.io/badge/three.js-r170-1d2140?style=flat-square)
![Canvas 2D](https://img.shields.io/badge/Canvas-2D-1d2140?style=flat-square)
![FFmpeg](https://img.shields.io/badge/FFmpeg-H.264-1d2140?style=flat-square)
![RTX](https://img.shields.io/badge/NVIDIA-RTX-1d2140?style=flat-square)
![License](https://img.shields.io/badge/code-MIT-1d2140?style=flat-square)

[**作品站**](https://cuiyucheng0104-afk.github.io/beiming-engine/) · [三条路线](docs/TRACKS.md) · [案例库](cases/INDEX.md) · [成片与素材下载](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11) · [文档导航](docs/README.md)

</div>

---

## 快速开始

需要 Node.js 20+、Python 3.10+ 与 FFmpeg。以下命令都在仓库根目录执行，先装依赖：

```bash
npm run setup                                # 安装 three.js、GSAP、playwright-core 与无头 Chromium
python3 -m pip install -r requirements.txt   # 声音部分用到的 numpy、scipy 等
```

### 渲染样片

```bash
sh build.sh          # 静帧样张 → 混音 → 逐帧渲染 → 封装，得到 out/beiming.mp4（1920×1040，24 fps，10 秒）
sh build.sh --4k     # 原生 4K：out/beiming_4k.mp4（3840×2080）
```

### 在浏览器里看画面

```bash
python3 -m http.server 8080
# http://127.0.0.1:8080/              正片
# http://127.0.0.1:8080/?test=kun     单个模块的自测页（名字对应 lab/ 下的自测页文件，例如 kun 对应 lab/kun.js）
```

### 构建作品站

```bash
npm run site:build     # 运行 tools/build-showcase.py，输出到 out/site/
npm run site:serve     # 打开 http://127.0.0.1:8090/
```

站上的作品预览默认直接播放 Release 里的文件。想离线预览，先把 86 个预览视频（约 406 MB）下到本地再构建：

```bash
gh release download casebook-2026.11 --pattern '*-preview.mp4' --dir out/previews
python3 tools/build-showcase.py --previews-dir out/previews     # 默认软链接；加 --copy-previews 改为复制
```

### 查看与还原归档案例

```bash
python3 tools/casebook.py list                                     # 96 条归档记录与状态
python3 tools/casebook.py check                                    # 校验源码、素材哈希与两套风格库快照
python3 tools/casebook.py restore style-02-watercolor --source-only  # 只还原源码到 out/casebook/
```

Windows 上 `python3` 可能只是空别名，请改用 `python`；仓库需以 LF 检出，否则哈希校验会失败。详见 [THIRD-PARTY.md 第 5 节](THIRD-PARTY.md#5-windows-注意)。

## 引擎九层

| 层 | 做什么 | 代码 |
|---|---|---|
| **形** | 轮廓表放样出鱼身，翼型撑起胸鳍，沿脊传播的波推着全身游动；道具按种子在表面确定性散布 | [`engine/form`](engine/form) |
| **光** | 三色分档卡通着色、量化阴影、背光与受光边缘光、下方补光，可叠斑驳与风化表面层 | [`engine/shade`](engine/shade) |
| **景** | 绘画底板作为三维空间里的面片与穹顶分层，按屏幕像素摆位，镜头一动视差自然产生 | [`engine/stage`](engine/stage) |
| **笔** | 屏幕空间墨线（深度与物体编号）、空气透视、泛光、调色、Kuwahara 颜料笔触、纸纹与颗粒 | [`engine/look`](engine/look) |
| **人** | Canvas 2D 逐笔画人物：路径语言、可变宽墨线、轮廓光与渗色、水彩斑驳 | [`engine/paint`](engine/paint) |
| **界** | 显示层与片名，最后一层合成，永远清晰；毛笔字按笔顺落笔，带枯笔飞白 | [`engine/overlay`](engine/overlay) |
| **时** | 分层时钟：人物一拍二，鲲一拍三，镜头、雾与水每帧都动 | [`engine/core`](engine/core) |
| **声** | 程序化音效、采样编配、混音与响度，全部确定性 | [`engine/audio`](engine/audio) |
| **片** | 无头浏览器逐帧截图，多路并行，FFmpeg 编码后拼接 | [`engine/render`](engine/render) |

《北冥》用到的图像素材只有 13 张底板：天空、云、城市天际线、江面、低雾与纸纹，其中绘画底板由 AI 生成后手工整理，来源与处理见 [assets/plates/plates.json](assets/plates/plates.json)；配乐用代码编排 CC0 采样乐器，见 [audio/CREDITS](audio/CREDITS)。鲲、渡船、人物、墨线、光影、显示层和全部音效都由代码生成。

画面只由帧号决定：影片代码不读墙钟，随机数都用固定种子，所以任何一帧都能单独重渲、多路并行。这是写片时遵守的约定，引擎外壳不替你保证（例如噪声工厂不传种子时默认用 `Math.random`，有状态的镜头要自己处理），边界见[原生运行时源码对照](docs/raea/architecture.md)中关于确定性的分层说明。任何页面满足下面的约定，就能交给渲染器逐帧出片：

```js
window.DUR = 10;                 // 时长（秒）
window.render = t => { … };      // 把画面画到时刻 t，必须确定性
window.READY = true;             // 贴图、字体、着色器全部就绪
window.TEXTS = t => [ … ];       // 可选：该时刻画面上的文字，供检查
```

## 三条路线

| 路线 | 画面在哪里算 | 入口 | 现状 |
|---|---|---|---|
| **A · 北冥风格路线 · WebGL 三渲二** | 无头 Chromium 里的 WebGL 与 Canvas 2D，逐帧确定性绘制 | [`engine/`](engine)、[`src/`](src)、[`lab/`](lab) | 主线，可出 1080p 与原生 4K |
| **B · 北冥原生路线 · BNE** | 原生运行时与独立 GPU；同一套鲲、渡船和底板导出成 GLB 后渲染 | [示例与复现命令](examples/raea/README.md)、[源码对照与集成](docs/raea/README.md) | 10 秒实验已跑通，通用双后端仍在推进 |
| **C · 北冥代码动画风格 · 86 式** | Canvas 2D、SVG、DOM 与 WebGL，各种画法各自实现 | [`cases/`](cases) | 66 部成片 + 20 种方法模板 |

开工时在 A 与 B 之间选（[ROUTES.md](ROUTES.md)）；C 是已经做过的画法与成片，新片从这里取构图、笔触和声音方法，再落到 A 或 B 上执行（[docs/TRACKS.md](docs/TRACKS.md)）。三条路线分别验收：WebGL 的 4K 成绩不算到原生路线头上，原生路线的设备记录也不写成浏览器实测。

## 4K 与 RTX 工作站

在同时装有核显和独显的 Windows 工作站上，无头浏览器默认会落到核显；把 ANGLE 切到 Vulkan，WebGL 就跑在 RTX 独显上：

```bash
BEIMING_ANGLE=vulkan sh build.sh --4k
```

| 设备 | 重着色器单帧（1920×1040） | 原生 4K 整片（240 帧） |
|---|---:|---:|
| RTX 5090 · Vulkan | **0.52 ms** | **31 秒** |
| Apple M5 Pro · Metal | 5.17 ms | 51 秒 |

同一份工程在工作站与 Mac 上渲出的原生 4K 成片，SSIM 0.973、PSNR 41.5 dB，差异几乎都在显示层文字边缘。4K 是算出来的，不是放大出来的：实测 RTX 超分会在平涂区长出蚯蚓状纹理，所以手绘风镜头一律原生渲染。数据与做法见 [docs/渲染与4K.md](docs/渲染与4K.md)、[docs/RTX工作站.md](docs/RTX工作站.md)。这些是北冥风格路线的实测，原生路线的 GPU 与编码记录另见[原生实验记录](docs/raea/experiment.md)。

## 作品与归档

| 内容 | 数量 | 说明 |
|---|---:|---|
| 作品站展示 | 79 部 | 北冥代码动画风格 66 部、PPT 故事介绍片 7 部、发布会动画 6 部，都有观看预览 |
| 仓库归档 | 96 条 | 95 个创作与实验工程，加 1 组共用资源 |
| 观看预览 | 86 个 | 历史成片转码的 960 宽观看版，不是重新渲染 |
| 风格库 | 86 式 | 66 部成片 + 20 种方法模板 |

作品站只放上面三类有预览的成片；其他动画与预演、画风实验、交互页面、共用资源和未获认可的版本只留在归档里。**已有成片、技术检查通过、画面被认可是三种状态**，归档里分开标注。全部记录见 [cases/INDEX.md](cases/INDEX.md)，还原方法见 [cases/README.md](cases/README.md)。

## 仓库地图

```text
site/       作品站源码：页面、样式、实时舞台（three.js）与 GSAP 编排，构建到 out/site/
engine/     北冥引擎九层；production/ 是项目与结果记录的校验
src/        《北冥》样片：色板、六种鲲、渡船、人物、显示层、三个镜头
lab/        模块自测页（?test=<名字>）
audio/      《北冥》声音设计、配乐与混音
assets/     绘画底板与纸纹
media/      样片、预览动图与剧照
fonts/      字体子集与 OFL 许可
examples/   北冥原生路线示例：资产桥、TSX 场景、运行包装
docs/       文档，导航见 docs/README.md
cases/      96 条归档：entries/ previews/ source/ vendor/ catalog.json
tools/      作品站构建器、案例库工具、工作计划校验
tests/      契约与还原测试
```

## 许可

仓库自有代码以 **MIT** 开放，见 [LICENSE](LICENSE)；《北冥》影片、底板与展示图保留所有权利；字体遵循 SIL OFL 1.1，见 [fonts/LICENSE.md](fonts/LICENSE.md)。

仓库还收录了第三方开源风格库、原生运行时的源码分析，作品站构建时会用到 three.js、GSAP 与两款 Google Fonts 字体。它们的来源、固定版本与许可义务见 [THIRD-PARTY.md](THIRD-PARTY.md)，案例侧声明见 [cases/NOTICES.md](cases/NOTICES.md) 与 [cases/licenses/](cases/licenses)。这些许可证与署名按原样保留，不因整合而移除或改写。

<sub>工程计划（21 项任务）与状态见 [docs/routes/](docs/routes/README.md)，用 `npm run routes:check`、`npm run routes:next` 查依赖与下一项。</sub>
