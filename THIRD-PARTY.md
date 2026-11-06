# 第三方来源、固定版本与许可义务

本仓库整合了三类上游材料。**许可证与署名文件是仓库的一部分，不可删除、不可改写、不可在改写后冒充原创。** 本页列出固定版本、用途与义务；逐文件清单见 `cases/catalog.json` 与 `cases/vendor/lock.json`。

## 1. 上游仓库

| 来源 | 固定提交 | 许可 | 在仓库中的位置 | 用途 | 义务 |
|---|---|---|---|---|---|
| [xiaoxiong20xx-code/sy-style-100](https://github.com/xiaoxiong20xx-code/sy-style-100) | `e41dee31a5c05dffa12b2f241378e648d2a22df6` | MIT（XIAOXIONG） | `cases/vendor/sy-style-100/`（331 个跟踪文件，原样） | 20 风格 / 100 示例、lib、渲染与声音工具；画风参照 | 保留版权声明与 MIT 许可（`cases/licenses/XIAOXIONG-MIT.txt`） |
| [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` | MIT（LemoLab） | `cases/vendor/lemo-opuscar/`（2478 个跟踪文件，原样） | 66 风格、demo、core、导演与技术文档；历史 66 部风格实验的方法来源 | 保留版权声明与 MIT 许可（`cases/licenses/LemoLab-MIT.txt`） |
| [shinyobjectz/raea](https://github.com/shinyobjectz/raea) | 见 `docs/raea/architecture.md` 中的源码快照 | FSL-1.1-ALv2（Functional Source License 1.1, ALv2, Copyright 2026 Shane Murphy） | **运行时与 SDK 不随本仓库分发**；仓库仅含源码对照、集成方案与自有示例 | 原生渲染路线的参考与调用方式 | 单独取得并按 FSL 条款使用；含 Competing Use 限制，两年后转为 Apache-2.0；本仓库不得删除或替换其许可信息 |

## 2. 仓库自有内容

| 内容 | 许可 | 说明 |
|---|---|---|
| `engine/`、`src/`、`lab/`、`tools/`、`showcase/` 等自有代码 | MIT | 见根 [LICENSE](../LICENSE) |
| 《北冥》影片、底板、展示图 | 保留所有权利 | 不因仓库开源而变更 |
| 字体 | SIL OFL 1.1 | 见 `examples/raea` 与 `docs/raea/README.md` 的字体说明 |
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
