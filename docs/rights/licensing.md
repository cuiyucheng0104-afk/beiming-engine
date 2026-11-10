# 许可范围、文件头与派生代码的来源头

读者｜维护者与全部 agent　状态｜生效（2026-11-10）　依据｜决定 D02、D03、D04（[docs/decisions/2026-11-10-industrial-baseline.md](../decisions/2026-11-10-industrial-baseline.md)）；审计 COMP-07、COMP-08、COMP-09、GAP-13

本仓库是混合许可：自有代码 MIT，影片画面保留权利，字体 OFL，历史归档与第三方快照各按原许可。**逐路径的机器可读对照在根目录 [REUSE.toml](../../REUSE.toml)**（REUSE 规范 3.3），许可全文在 [LICENSES/](../../LICENSES/)。本页是它的文字说明，以及写代码时要遵守的文件头规则。

## 根 LICENSE 的适用范围

根目录 [LICENSE](../../LICENSE) 只放标准 MIT 正文，不加任何说明文字。原因：GitHub 与许可扫描工具按全文比对识别许可，正文后面多一段话就会被判成 Other（审计 COMP-07）。适用范围写在这里和 REUSE.toml 里：

1. **MIT 覆盖本项目原创的代码、文档与配置**：`engine/`、`src/`、`lab/`、`tools/`、`tests/`、`routes/`、`films/` 里的作品工程代码、`examples/`、`audio/` 的脚本、`docs/`、`site/` 的代码与文字、构建脚本与根目录配置。版权人见下文「权利人」。
2. **例外：文件头标注了第三方版权的文件。** 这些文件里改写自上游的部分仍按上游的许可（目前都是 MIT），版权归上游作者，必须保留其版权声明；本项目只对自己写的部分持有版权。判断方法：文件头某一行同时有版权字样与上游权利人（如 `LemoLab`、`肖雄 XIAOXIONG`），或有 `@provenance` 标记。已知的派生文件见下文「已登记的派生文件」。
3. **保留所有权利**：《北冥》影片、底板与纸纹（`assets/`）、样片与展示图（`media/`）、作品站的画面（`site/assets/`）、实验联系表（`docs/raea/media/`）、配乐渲染缓存（`audio/score_cache.npz`）、新作品工程里的画面与声音素材（`films/**` 下的图片、视频、音频）、历史作品的海报与截图（`cases/previews/`、`site/data/posters/`）。条款见 [LicenseRef-AllRightsReserved](../../LICENSES/LicenseRef-AllRightsReserved.txt)。其中含 AI 生成内容的，标识办法见 [aigc.md](aigc.md)。
4. **字体**：SIL OFL 1.1（`fonts/*.woff2`、B 路线例片内嵌的片名字体 `examples/raea/title-font.ts`，该文件的代码部分仍是 MIT）。字体说明见 [fonts/LICENSE.md](../../fonts/LICENSE.md)。
5. **历史案例归档** `cases/source/`：不统一改为 MIT，条款见 [LicenseRef-Casebook-Archive](../../LICENSES/LicenseRef-Casebook-Archive.txt)；其中的客户与第三方素材见 [register.md](register.md)。
6. **第三方风格库快照** `cases/vendor/`：原样收录，按上游许可（lemo-opuscar：代码 MIT、例片与静帧 CC BY 4.0；sy-style-100：MIT），见 [THIRD-PARTY.md](../../THIRD-PARTY.md)。
7. **上游原生运行时 RAEA 不在本仓库**：许可是 FSL-1.1-ALv2，与本仓库的 MIT 无关；B 路线怎么用它见 [fsl-boundary.md](fsl-boundary.md)。

## 权利人

根 LICENSE 与 REUSE.toml 的版权行暂写「北冥引擎 Beiming Engine」。**这是项目名，不是法律主体**（审计 COMP-07）；真实的个人或公司名称由用户提供，目前「待补」（[register.md](register.md) 的 R12）。补来以后三处一起改：LICENSE 第 3 行、REUSE.toml 里所有「北冥引擎 Beiming Engine」、register.json 的 R12，然后跑一遍扫描。不要自行推断或填写。

## 文件头怎么写

- **普通的新文件不必写许可头**：REUSE.toml 第一条按路径兜底（MIT，版权人同上）。
- **要写就两行写全**：许可行与版权行缺一不可，否则不同版本的 reuse 工具解读不一致，扫描会给提示。

<!-- REUSE-IgnoreStart -->
```js
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
```
<!-- REUSE-IgnoreEnd -->

- **不是 MIT 的文件放进 MIT 目录时**（例如把 CC BY 的图放进 `routes/` 的模版），在 REUSE.toml 末尾给这个路径加一条 `[[annotations]]`，或在文件头写它自己的 SPDX 两行。
- 源码里不要随手写「版权英文词 + 空格 + 年份」这种句子（包括测试样例与注释）：官方 reuse 工具会把它当成该文件的版权声明。

## 派生代码的来源头

从上游借来的代码（照抄、改名、改写、调参都算）写进本仓库主体时，文件头必须同时有：

1. 一句中文说明：哪些函数或段落来自哪里、按什么许可；
2. `@provenance <上游名>@<提交>:<上游路径>` 标记（提交至少 7 位，上游名与 [cases/vendor/lock.json](../../cases/vendor/lock.json) 一致）；
3. SPDX 许可行；
4. 本项目与上游各一条版权行。

写法（JavaScript；Python 与 shell 把 `//` 换成 `#`）：

<!-- REUSE-IgnoreStart -->
```js
// 来源：clamp、lerp、seg、ss、ei、eo、eio 与 monotone 改写自 LemoLab lemo-opuscar 的 core/lib.js，
// 按其 MIT 许可使用并保留版权声明（许可全文 cases/licenses/LemoLab-MIT.txt）；其余部分为本项目原创。
// @provenance lemo-opuscar@bebbbe1:core/lib.js
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-FileCopyrightText: 2026 LemoLab
```
<!-- REUSE-IgnoreEnd -->

上游是肖雄的 sy-style-100 时，标记写 `@provenance sy-style-100@e41dee31:<路径>`，版权行写 `2026 肖雄 XIAOXIONG`，许可全文 `cases/licenses/XIAOXIONG-MIT.txt`。

**只借思路、没有搬代码**（读了上游的做法，自己从头写）：不用版权行，但建议在说明里写一句「做法参考 lemo-opuscar 的 <路径>」，方便后人核对。

**不能借的**：上游原生运行时 RAEA 的任何源码（FSL，见 [fsl-boundary.md](fsl-boundary.md)）；`cases/source/` 里客户与第三方的素材（见 [register.md](register.md)）。

同时要在 [THIRD-PARTY.md](../../THIRD-PARTY.md) 的派生文件清单里加一行（根文档由整合包维护；改不了时在汇报里写明）。

## 怎么判定是不是派生

`node tools/compliance/scan.mjs --only provenance` 把仓库主体的代码与 `cases/vendor/` 两套快照逐段比对（去注释、标识符与字符串归一，改名、改空白都不影响），按两档报告：

| 级别 | 条件 | 处理 |
|---|---|---|
| 阻断 | 最长连续相同片段 ≥ 200 个记号，或与同一个上游文件相同的内容占本文件 ≥ 40% 且最长片段 ≥ 48 个记号 | 按派生处理，写来源头 |
| 提示 | 最长片段 ≥ 90 个记号，或相同内容占比 ≥ 30% 且最长片段 ≥ 32 个记号 | 人工判定：派生就写来源头；确属通用写法（公开算法的唯一自然写法、标准 API 用法、记号形状巧合）就在 [allowlist.json](../../tools/compliance/allowlist.json) 登记为 `false-positive` 并写清理由与判定人 |

判定从严：公开算法（如 Fritsch–Carlson 单调样条、Catmull-Rom）本身不受保护，但逐句结构、辅助函数名与写法都与上游一致时，按派生处理更稳妥（审计 COMP-09 的结论）。

## 已登记的派生文件

2026-11-10 扫描结果（[allowlist.json](../../tools/compliance/allowlist.json) 有对应的 `pending` 条目，属主加好来源头后条目会提示删除）：

| 文件 | 上游（lemo-opuscar@bebbbe1） | 相同程度 | 判定 | 由谁加来源头 |
|---|---|---|---|---|
| `engine/core/math.js` | `core/lib.js` | 连续 502 记号，占本文件 73% | 派生（审计 COMP-09） | P13 |
| `engine/form/curves.js` | `styles/rubber-hose/demo/toon.js`（spline） | 连续 244 记号 | 派生 | P13 |
| `engine/paint/affine.js` | `styles/papercut-red/demo/rig.js` | 连续 132 记号，占 45% | 按派生（从严） | P13 |
| `engine/paint/curve.js` | `styles/urban-sketch/demo/engine.js` | 连续 135 记号（提示级） | 派生（Catmull-Rom 写法连多余括号都一致） | P13 |
| `engine/form/sdf.js` | `styles/woodcut/demo/engine/hatch.js` | 连续 156 记号（提示级） | 派生（距离变换的分配与两趟循环逐句一致） | P13 |
| `engine/overlay/brush.js` | `styles/chalkboard/demo/js/chalk.js` | 连续 148 记号（提示级） | 派生（倒角距离两趟循环逐句一致） | P13 |
| `tools/contact_sheet.py` | `core/render/sheet.py` | 连续 71 记号，占 32%（提示级） | 派生（参数名与默认值相同） | P06 |
| `tools/rtx/gpucheck.mjs` | `styles/urban-sketch/demo/engine.js` | 连续 155 记号（提示级） | 派生（WebGL 样板连变量名都相同） | P04 |

判为通用写法、登记为 `false-positive` 的：`engine/audio/dsp.py`（SciPy 标准滤波写法）、`engine/core/stroke.js` 与 `engine/paint/ink.js`（法线偏移）、`engine/overlay/widgets.js`（arcTo 圆角矩形）、`site/js/main.js`（记号形状巧合）。理由逐条写在允许清单里。

## 新增文件与目录

- 新代码、新文档放在任何目录都自动是 MIT（REUSE.toml 第一条兜底），不用改 REUSE.toml。
- 新增**画面、底板、声音素材**：放在 `films/<名>/` 下自动按保留权利处理；放在别处（如 `routes/` 的模版、`assets/` 以外的新目录），要在 REUSE.toml 补一条例外。
- 新增**第三方素材**（字体、采样、图片、模型）：先在 [register.json](register.json) 登记来源与授权，再在 REUSE.toml 写它的许可与版权行，许可全文放进 `LICENSES/`（文件名是 SPDX 标识，如 `CC-BY-4.0.txt`）。
- 自查：`node tools/compliance/scan.mjs --only reuse,license-file`；CI 另跑官方 `reuse lint`。

## 第三方 JavaScript 库与作品站依赖

npm 依赖（three.js MIT、GSAP 标准免费许可等）不提交进仓库，版本由 `package.json` 与 `package-lock.json` 固定，许可与义务见 [THIRD-PARTY.md](../../THIRD-PARTY.md) 第 6 节。GSAP 的许可**不是开源许可**，不随本仓库的 MIT 再授权。
