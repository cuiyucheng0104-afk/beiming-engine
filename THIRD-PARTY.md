# 第三方来源、固定版本与许可义务

本仓库整合了三类上游材料。**许可证与署名文件是仓库的一部分，不可删除、不可改写、不可在改写后冒充原创。** 本页列出固定版本、用途与义务；逐文件清单见 `cases/catalog.json` 与 `cases/vendor/lock.json`。作品站构建时另外用到的依赖与字体见第 6 节。

## 1. 上游仓库

| 来源 | 固定提交 | 许可 | 在仓库中的位置 | 用途 | 义务 |
|---|---|---|---|---|---|
| [xiaoxiong20xx-code/sy-style-100](https://github.com/xiaoxiong20xx-code/sy-style-100) | `e41dee31a5c05dffa12b2f241378e648d2a22df6` | MIT（XIAOXIONG） | `cases/vendor/sy-style-100/`（331 个跟踪文件，原样） | 20 风格 / 100 示例、lib、渲染与声音工具；画风参照 | 保留版权声明与 MIT 许可（`cases/licenses/XIAOXIONG-MIT.txt`） |
| [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` | MIT（LemoLab） | `cases/vendor/lemo-opuscar/`（2478 个跟踪文件，原样） | 66 风格、demo、core、导演与技术文档；历史 66 部风格实验的方法来源 | 保留版权声明与 MIT 许可（`cases/licenses/LemoLab-MIT.txt`） |
| [shinyobjectz/raea](https://github.com/shinyobjectz/raea) | 见 `docs/raea/architecture.md` 中的源码快照 | FSL-1.1-ALv2（Functional Source License 1.1, ALv2, Copyright 2026 Shane Murphy） | **运行时与 SDK 不随本仓库分发**；仓库仅含源码对照、集成方案与自有示例 | 原生渲染路线的参考与调用方式 | 单独取得并按 FSL 条款使用；含 Competing Use 限制，两年后转为 Apache-2.0；本仓库不得删除或替换其许可信息 |

## 2. 仓库自有内容

| 内容 | 许可 | 说明 |
|---|---|---|
| `engine/`、`src/`、`lab/`、`tools/`、`site/` 等自有代码 | MIT | 见根 [LICENSE](LICENSE) |
| 《北冥》影片、底板、展示图（含作品站 `site/assets/` 的海报与静帧） | 保留所有权利 | 不因仓库开源而变更 |
| 字体 | SIL OFL 1.1 | 仓库字体见 [fonts/LICENSE.md](fonts/LICENSE.md)；原生例片内嵌字体见 [examples/raea/README.md](examples/raea/README.md)；作品站字体见第 6 节 |
| 历史 PPT 影片、发布会影片、配音、生成音乐、原画与素材包 | 原项目权利范围 | 仅作展示与学习参考，归档不额外授予商业复用权 |
| Three.js 等随片依赖 | MIT | 见 `cases/licenses/three-MIT.txt` 与各工程原有声明 |

## 3. 归档与快照的校验方式

```bash
python tools/casebook.py check     # 96 条记录、2243 个唯一源文件、2809 个 vendor 文件
python -m unittest discover -s tools -p test_casebook.py
```

`cases/vendor/lock.json` 为每个文件记录 `path / mode / gitBlob(SHA1) / sha256 / size`；`cases/catalog.json` 为案例源文件记录 `sha256 / originalSha256 / size`。校验覆盖全部跟踪文件，任何改动都会被抓到。

## 4. 使用规则

1. 外部快照**只读**：不就地修改 `cases/vendor/`；需要改就复制到独立工程，并保留来源说明。
2. 案例还原用 `python tools/casebook.py restore <id>`；源码里的 `@@CASE_ROOT@@ / @@WORKSPACE_ROOT@@ / @@LEMO_ROOT@@ / @@ROG_HOST@@` 是显式还原标记，**不能把归档路径当可执行项目**。还原只替换已知工作区路径，不自动修复历史构建逻辑。
3. 引用上游代码写自己的模块时，保留派生说明与许可；「整合、改写、调参」不改变原作者权利。
4. 对外发布时随附本页与 `cases/NOTICES.md`；不要删除 `LICENSE`、`cases/licenses/` 与 vendor 目录内的许可文件。
5. 状态按实际证据写：历史成片、技术通过、用户认可分别标注；《豹变》四版与北冥九分钟的后续否定反馈优先于旧文件措辞。

## 5. Windows 注意

- 仓库需以 LF 检出：`git config core.autocrlf false`，否则文本文件字节变化会让 `casebook.py check` 报 `Checksum mismatch`，Git blob 校验也会失败。
- `npm run cases:check` / `test:cases` 调用的 `python3` 在 Windows 上可能只是空别名；请安装 Python 3 并用 `python` 执行对应命令。
- 符号链接相关的还原测试需要「开发者模式」或管理员权限，否则 Windows 上会有 1 个环境性失败。

## 6. 作品站（`site/`）的依赖与字体

作品站用 `npm run site:build`（即 `tools/build-showcase.py`）构建到 `out/site/`，GitHub Pages 发布的是同一份构建产物。下列文件在构建时从 `node_modules/` 或 Google Fonts 取出放进产物，**不提交进仓库**；npm 依赖的版本由 `package.json` 与 `package-lock.json` 固定，字体取构建当时 Google Fonts 提供的版本。

| 依赖 | 固定版本 | 许可与版权 | 进入构建产物的文件 | 义务 |
|---|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | `0.170.0` | MIT，Copyright © 2010-2024 three.js authors | `vendor/three/three.module.min.js` 与实际用到的 `addons` | 保留文件内的版权与许可声明；全文见 [cases/licenses/three-MIT.txt](cases/licenses/three-MIT.txt) |
| [GSAP](https://gsap.com)，含 ScrollTrigger、Flip 插件 | `3.15.1` | GSAP 标准免费许可（Standard "No Charge" License，现由 Webflow 授予），条款见 <https://gsap.com/standard-license>；Copyright 2008-2026 GreenSock | `vendor/gsap/gsap.min.js`、`ScrollTrigger.min.js`、`Flip.min.js` | 用在网站与应用上免费，商业项目也可以；不得用于与 Webflow 竞争的无代码动画搭建工具。它**不是 MIT 等开源许可**，不随本仓库的 MIT 再授权；保留每个文件头的版权与许可声明 |
| [Ma Shan Zheng](https://github.com/googlefonts/mashanzheng)（马善政毛笔楷书） | 构建当时的 Google Fonts 版本 | SIL OFL 1.1，Copyright 2018 The MaShanZheng Project Authors | `css/fonts.css` 及按页面实际用字生成的子集 | 子集由 Google Fonts CSS2 API 的 `text=` 参数生成，不改字形、不改字体名；许可全文见 [fonts/LICENSE.md](fonts/LICENSE.md) |
| [Barlow](https://github.com/jpt/barlow)，300 / 400 / 500 / 600 | 构建当时的 Google Fonts 版本 | SIL OFL 1.1，Copyright 2017 The Barlow Project Authors | 同上，只取数字与西文 | 同上 |

- 字体子集下载后放进产物，由站点自己提供，访客浏览时不连 Google Fonts；[fonts/LICENSE.md](fonts/LICENSE.md) 也随产物复制，`css/fonts.css` 文件头写明字体与许可。
- 构建时连不上 Google Fonts，构建器打印警告，改用仓库 `fonts/` 里自带的子集（毛笔字只有“北冥”两个字，Barlow 只有 300、400、500）并退回系统字体，构建本身不失败。
- 站上播放的作品预览来自 [casebook-2026.11](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/casebook-2026.11) Release，海报来自 `cases/previews/`，样片是仓库里的 `media/beiming.mp4`（与 [v1.0](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/tag/v1.0) Release 的 1080p 版逐字节相同）。它们的权利范围同第 2 节的影片与历史素材，不因进入站点而改变。
- 作品站可见文字只用对外名称（见 [AGENTS.md](AGENTS.md)）；上游来源与许可仍以本页第 1 节为准，不因对外改名而省略。
