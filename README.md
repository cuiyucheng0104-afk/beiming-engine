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
![License](https://img.shields.io/badge/code-MIT-1d2140?style=flat-square)

[**作品站**](https://cuiyucheng0104-afk.github.io/beiming-engine/) · [三条路线](routes/README.md) · [案例库](cases/INDEX.md) · [成片与素材下载](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11) · [文档导航](docs/README.md)

</div>

---

**给 agent / 开发者：先读 [AGENTS.md](AGENTS.md)。**

## 快速开始

需要 Node.js ≥ 22（推荐 24，见 `.nvmrc`）、FFmpeg ≥ 7（带 libx264）与 Python 3.12；Python 3.12 由 `npm run setup` 建进仓库的 `.venv`，装了 uv 时连 Python 本身都不用另装。以下命令都在仓库根目录执行，bash、zsh 与 PowerShell 写法相同。各平台的安装、版本与全部环境变量见 [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)。

### 做一部新片

```sh
npm ci
npm run setup                                    # npm 依赖、锁定版本的无头浏览器、仓库内的 Python 3.12 虚拟环境（.venv）
npm run env:doctor -- --route a                  # 只读体检；不合格时退出 3，并按顺序列出修复命令
npm run new -- a my-film --title 晨渡            # 从路线模版生成 films/my-film/；b、c 同理，路线怎么选见 routes/README.md
npm run fonts:fetch                              # 只 A 路线要：这台机器第一次先取锁定的 OFL 字体（进 .cache/fonts/，不进 git）
npm run fonts:subset -- films/my-film            # 只 A 路线要：按 film.json 的文字生成本片字体子集，缺字直接失败
npm run film -- build films/my-film              # 出片（工作版），产物在 films/my-film/out/<run-id>/
```

正式交付要过三道闸（look 风格关键帧 → animatic 动态预演 → final 终渲），每道都请用户看过、按原话记录，最后 `npm run film -- build films/my-film --final`：步骤见所选路线的手册与 [tools/film/README.md](tools/film/README.md)，选路线见 [routes/README.md](routes/README.md)。

### 重建《北冥》样片

```sh
npm run beiming:build              # out/beiming.mp4（1920×1040，24 fps，10 秒），运行记录与机器 QA 报告在 out/beiming/<run-id>/
npm run beiming:build -- --4k      # 3840×2080 工作版：out/beiming_4k.mp4
```

旧写法 `npm run build` 与 `sh build.sh` 是它的兼容壳，保留一个版本。

### 在浏览器里看画面

```sh
npm run serve
# http://127.0.0.1:8080/              《北冥》正片页面
# http://127.0.0.1:8080/?test=kun     单个模块的自测页（名字对应 lab/ 下的文件，例如 kun 对应 lab/kun.js）
```

`npm run serve` 只监听 127.0.0.1。作品站用 `npm run site:build` 构建到 `out/site/`，`npm run site:serve` 打开 http://127.0.0.1:8090/；站上的作品预览默认直接播放 Release 里的文件，离线预览的做法见 [site/CONTRACT.md](site/CONTRACT.md)。

### 环境变量

设环境变量时 bash 与 PowerShell 写法不同。例如在 Windows 工作站上让 WebGL 跑在独显上（Windows 默认已是 Vulkan，这里显式写出）：

```bash
export BEIMING_ANGLE=vulkan
npm run beiming:build -- --4k
```

```powershell
$env:BEIMING_ANGLE = 'vulkan'
npm run beiming:build -- --4k
```

全部变量见 [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)「环境变量」。

### 查看与还原归档案例

```sh
npm run cases:list                                                                 # 96 条归档记录与状态
npm run cases:check                                                                # 校验源码、素材哈希与两套风格库快照
node tools/env/py.mjs tools/casebook.py restore style-02-watercolor --source-only  # 只还原源码到 out/casebook/
```

仓库需以 LF 检出（`.gitattributes` 已固定），否则哈希校验会失败；Windows 注意事项见 [THIRD-PARTY.md 第 5 节](THIRD-PARTY.md#5-windows-注意)。

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
| **声** | 程序化音效、采样编配、混音与响度（全部确定性）；声音 QA 门、声画拍点核对、配音与字幕（`npm run audio:qa`、`audio:cuecheck`、`audio:voice`） | [`engine/audio`](engine/audio) |
| **片** | 无头浏览器逐帧截图，多路并行，FFmpeg 编码后拼接 | [`engine/render`](engine/render) |

《北冥》用到的图像素材只有 13 张底板：天空、云、城市天际线、江面、低雾与纸纹。其中 12 张彩色绘画底板由 AI 生成（Midjourney V8 / GPT Image 2.5）后人工整理，来源链与处理见 [assets/plates/plates.json](assets/plates/plates.json)；纸纹的来历没有记录，写「待补」。配乐用代码编排 CC0 采样乐器，见 [audio/CREDITS](audio/CREDITS)。鲲、渡船、人物、墨线、光影、显示层和全部音效都由代码生成。

**AIGC 说明**：《北冥》含 AI 生成画面（绘画底板）。按决定 D11，片尾或作品说明写「含 AI 生成画面」，成片的 mp4 comment 元数据写入隐式标识；标识办法见 [docs/rights/aigc.md](docs/rights/aigc.md)。

画面只由帧号决定：影片代码不读墙钟，随机数都用固定种子，所以任何一帧都能单独重渲、多路并行。这是写片时遵守的约定，引擎外壳不替你全部保证（例如有状态的镜头要自己处理），多路分段出片前用 `npm run determinism` 核对；边界见[原生运行时源码对照](docs/raea/architecture.md)中关于确定性的分层说明。任何页面满足下面的约定，就能交给渲染器逐帧出片（完整约定见 [engine/render/README.md](engine/render/README.md)）：

```js
window.DUR = 10;                 // 时长（秒）
window.render = t => { … };      // 把画面画到时刻 t，必须确定性
window.READY = true;             // 贴图、字体、着色器全部就绪
window.TEXTS = t => [ … ];       // 可选：该时刻画面上的文字，供检查
```

## 三条路线

| 路线 | 定位 | 手册 |
|---|---|---|
| **A · 北冥风格路线 · WebGL 三渲二** | 北冥画风的确定性三渲二：程序化造型、三档卡通着色、屏幕空间墨线、Kuwahara 笔触与底板视差，无头 Chrome 的 WebGL 逐帧出片 | [routes/a-webgl](routes/a-webgl/README.md) |
| **B · 北冥原生 · BNE** | 通用原生渲染（render anything），可以复用北冥资产，但不要求北冥画风；作品写成一个 TSX 编排文件，由原生 GPU 运行时逐帧确定性渲出 | [routes/b-native](routes/b-native/README.md) |
| **C · 北冥代码动画风格 · 86 式** | 页面型代码动画的方法库，外加可直接出片的 C 模版；与 A 共用页面渲染器，不是第三个 GPU 后端 | [routes/c-style](routes/c-style/README.md) |

三条路线都能直接出片，选路线的判据见 [routes/README.md](routes/README.md)，执行面的技术分档见 [docs/TRACKS.md](docs/TRACKS.md)。三条路线分别验收：WebGL 的 4K 成绩不算到原生路线头上，原生路线的设备记录也不写成浏览器实测。

## 4K 与工作站

《北冥》4K 成片里，三维、墨线、纸纹、显示层是原生 4K；绘画底板为放大（AI 原图 ×2，4K 下屏幕上每个像素分到的底板像素不到 1，见 QA 台账 QA-A-004 与 [docs/渲染与4K.md](docs/渲染与4K.md)「4K 下的绘画底板」）。实测 RTX 超分会在平涂区长出蚯蚓状纹理，所以手绘风镜头一律原生渲染。同时装有核显和独显的 Windows 工作站上，渲染器默认用 Vulkan，让 WebGL 跑在独显上（写法见上文「环境变量」；装环境与远程出片见 [docs/RTX工作站.md](docs/RTX工作站.md)）。

下面两张表的数字都来自 2026-11-04 的旧编码链与系统 Chrome，换成锁定的无头浏览器与渲染器 v2 之后要重测；出片前用 `npm run film -- plan` 估算。

**GPU 着色器微基准**（`npm run env:gpu`：每像素 400 次噪声循环，1920×1040；只说明 GPU 着色快慢，不是出片吞吐）

| 设备 | 单帧 |
|---|---:|
| NVIDIA RTX 5090 · Vulkan | **0.52 ms** |
| Apple M5 Pro · Metal | 5.17 ms |

**出片吞吐**（《北冥》10 秒、240 帧，各设备取最好成绩，单位秒）

| 任务 | Apple M5 Pro | NVIDIA RTX 5090 工作站 |
|---|---:|---:|
| 1080 渲染 | **10.9**（4 路） | 13.1（6 路） |
| 原生 4K 渲染（3840×2080） | 50.8（4 路） | **31.4**（10 路） |

同一份工程在工作站与 Mac 上渲出的原生 4K 成片，SSIM 0.973、PSNR 41.5 dB，差异几乎都在显示层文字边缘。这些是北冥风格路线的实测，原生路线的 GPU 与编码记录另见[原生实验记录](docs/raea/experiment.md)。

## 作品与归档

| 内容 | 数量 | 说明 |
|---|---:|---|
| 作品站展示 | 97 部 | 北冥代码动画风格 66 部、PPT 故事介绍片 7 部、发布会动画 24 部（WONDER 项目案例，只发布成片，不进归档），都有观看预览 |
| 仓库归档 | 96 条 | 95 个创作与实验工程，加 1 组共用资源 |
| 观看预览 | 86 个 | 归档成片转码的 960 宽观看版（casebook-2026.11 Release），不是重新渲染；WONDER 的 24 部预览在 wonder-films-2026.11 Release |
| 风格库 | 86 式 | 两套第三方 MIT 风格库的固定快照：Lemo 66 种 + SY 20 种 |

作品站只放上面三类有预览的成片；其他动画与预演、画风实验、交互页面、共用资源和被否定的版本只留在归档里。**已输出、技术检查通过、用户认可是三种状态**，归档里分开标注；上作品站不等于用户认可。全部记录见 [cases/INDEX.md](cases/INDEX.md)，还原方法见 [cases/README.md](cases/README.md)。

## 仓库地图

```text
routes/     三条路线：总指引、路线注册表 routes.json、三份手册与模版、导演方法
films/      新作品，一部一个目录，由 npm run new 生成；films/<名字>/out/ 不提交
site/       作品站源码：页面、样式、实时舞台（three.js）与 GSAP 编排，构建到 out/site/
engine/     北冥引擎九层；production/ 是作品描述与创作闸门，native/ 是 B 路线的通用原生层
src/        《北冥》样片：色板、六种鲲、渡船、人物、显示层、三个镜头
lab/        模块自测页（?test=<名字>）
audio/      《北冥》声音设计、配乐与混音
assets/     绘画底板与纸纹
media/      样片、预览动图与剧照
fonts/      字体子集与 OFL 许可
examples/   B 路线的《北冥》10 秒原生例片（目录名沿用上游项目名）
docs/       文档，导航见 docs/README.md
cases/      96 条归档：entries/ previews/ source/ vendor/ catalog.json
tools/      出片编排、新建作品、规范检查、QA、环境、案例库与作品站工具
tests/      契约、治理与渲染测试
```

## 测试、CI 与发布

- `npm test` 跑全部 Node 与 Python 测试；`npm run check` 跑全部检查；`npm run lint` 列出 lint 告警数（只报告）；`npm run eval:selftest` 是 agent 评测计分器的自检。
- 每个 PR 都跑 `.github/workflows/ci.yml`：unit（Node 24 与 22、Python 3.12）；check；smoke-render（无显卡的 SwiftShader 下三条路线的模版出片，并与金标准比对：第一次运行只采集待审批候选，审批人看过工件里的总览 contact.png 后用 `npm run golden -- approve` 转正）；env-smoke（Linux、macOS、Windows 三平台环境自检）；windows-paths（PowerShell 与中文路径）。
- 推 `v*` 标签会触发 `.github/workflows/release.yml`，用 CHANGELOG.md 的对应段落建草稿 Release，维护者核对后发布。
- 本机复现与发布步骤见 [tests/ci/README.md](tests/ci/README.md)。

## 许可

仓库自有代码以 **MIT** 开放，见 [LICENSE](LICENSE)。文件头标注了第三方版权的文件，按其上游许可（见 [THIRD-PARTY.md](THIRD-PARTY.md)「派生代码」）。《北冥》影片、底板与展示图保留所有权利；其中绘画底板由 AI（Midjourney V8、GPT Image 2.5）生成后人工整理，含 AI 生成画面。字体遵循 SIL OFL 1.1，见 [fonts/LICENSE.md](fonts/LICENSE.md)。逐路径许可见 [REUSE.toml](REUSE.toml) 与 [docs/rights/licensing.md](docs/rights/licensing.md)，素材授权见 [docs/rights/](docs/rights/README.md)，安全问题见 [SECURITY.md](SECURITY.md)。

仓库还收录了第三方开源风格库、原生运行时的源码分析，作品站构建时会用到 three.js、GSAP 与两款 Google Fonts 字体。它们的来源、固定版本与许可义务见 [THIRD-PARTY.md](THIRD-PARTY.md)，案例侧声明见 [cases/NOTICES.md](cases/NOTICES.md) 与 [cases/licenses/](cases/licenses)。这些许可证与署名按原样保留，不因整合而移除或改写。

北冥原生 · BNE 基于第三方原生运行时 RAEA（shinyobjectz/raea，FSL-1.1-ALv2，版权人 Shane Murphy）。运行时不随本仓库分发，需单独取得并遵守其许可。北冥代码动画风格的画法库部分来自 MIT 开源项目 lemo-opuscar（LemoLab）与 sy-style-100（肖雄 XIAOXIONG），版权与许可原样保留。

<sub>引擎工程待办与分工见 [docs/routes/](docs/routes/README.md)，用 `npm run plan:check`、`npm run plan:next` 查依赖与下一项；做作品不用它。</sub>
