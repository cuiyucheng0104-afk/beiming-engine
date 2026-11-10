# 北冥九分钟

**画面效果未获认可** · `local-beiming-film-9min`

技术上输出了540秒影片；用户随后明确不认可效果，不能因历史WORK_STATE写“已交付”就视作通过。

![历史画面](../previews/local-beiming-film-9min.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/local-beiming-film-9min-preview.mp4) · 历史成片转码，非重新渲染。

保留已输出的技术试验；用户不认可画面效果，不作为合格画风或正式作品基线。

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 历史成片（归档时未重渲；机器 QA 未跑） |
| 用户认可 | 未获认可：原因未记录，待用户补充（记录人：用户；日期：待补） |
| 认可记录出处 | 归档记录：git show 1046c14:cases/entries/local-beiming-film-9min.md 第 5 行「用户随后明确不认可效果」 |
| 权利 | 内部：含客户材料、第三方 IP 或参考图，权利方 乐奇 / Rokid（法律主体名称待补）；restore 默认不还原其素材，产物不得用进新作品或对外物料 |
| 登记类别 | R02、R08、R09（[授权登记册](../../docs/rights/register.md)） |
| AI 生成 | 含（R08、R09；工具与版本待补） |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore local-beiming-film-9min --download
```

还原位置：`out/casebook/beiming-film-9min/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。内部素材默认不还原，只为研究方法时加 `--include-internal`。

| 入口 | 归档原文件 |
|---|---|
| `delivery/index.html` | [查看](../source/local-beiming-film-9min/delivery/index.html) |
| `index.html` | [查看](../source/local-beiming-film-9min/index.html) |
| `README.md` | [查看](../source/local-beiming-film-9min/README.md) |
| `audio/README.md` | [查看](../source/local-beiming-film-9min/audio/README.md) |
| `tools/test_peng/README.md` | [查看](../source/local-beiming-film-9min/tools/test_peng/README.md) |

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| beiming_9min_1080.mp4 | 1920×1040 / 540.000 | [original-films-09.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-09.zip)，包内 `local-beiming-film-9min/beiming_9min_1080.mp4` | `41251498e25474e8441da9e85b97cd83c92c29c6704035a13c1c305361ab86b4` |

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
