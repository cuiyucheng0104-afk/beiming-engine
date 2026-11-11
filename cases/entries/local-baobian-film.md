# 豹变四版

**画面效果未获认可** · `local-baobian-film`

A水墨、B装饰、C奇谭、D雾山为同一故事的四次风格试验；保留四版原片，预览选第一版，不代表推荐。

![历史画面](../previews/local-baobian-film.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/local-baobian-film-preview.mp4) · 历史成片转码，非重新渲染。

保留已输出的技术试验；用户不认可画面效果，不作为合格画风或正式作品基线。

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 历史成片（归档时未重渲；机器 QA 未跑） |
| 用户认可 | 未获认可：原因未记录，待用户补充（记录人：用户；日期：待补） |
| 认可记录出处 | 归档记录：git show 1046c14:cases/entries/local-baobian-film.md 第 11 行「用户不认可画面效果」 |
| 权利 | 公开归档（个别素材标为内部，restore 默认不还原，见 catalog 的文件条目） |
| 登记类别 | R01、R03、R08、R09（[授权登记册](../../docs/rights/register.md)） |
| AI 生成 | 含（R08、R09；工具与版本待补） |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore local-baobian-film --download
```

还原位置：`out/casebook/baobian-film/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `BRIEF.md` | [查看](../source/local-baobian-film/BRIEF.md) |

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 豹变_D_wushan.mp4 | 1920×1040 / 30.000 | [original-films-07.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-07.zip)，包内 `local-baobian-film/豹变_D_wushan.mp4` | `f47d78fe98f83843ee2f5106b73559cf7d43005a21aeeb8156418c840b88cb1a` |
| 豹变_C_qitan.mp4 | 1920×1040 / 30.000 | [original-films-07.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-07.zip)，包内 `local-baobian-film/豹变_C_qitan.mp4` | `36d74bc572d7ddb161c6d7c424c0100d1c3e42905f7a25eb04bf6a02b3289077` |
| 豹变_B_zhuangshi.mp4 | 1920×1040 / 30.000 | [original-films-07.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-07.zip)，包内 `local-baobian-film/豹变_B_zhuangshi.mp4` | `21451f8516102c87b8e1e8340c59ed389d073b78eee06dbab7c387e4a9cc010f` |
| 豹变_A_shuimo.mp4 | 1920×1040 / 30.000 | [original-films-08.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-08.zip)，包内 `local-baobian-film/豹变_A_shuimo.mp4` | `6c10d7d2cd188af487f234b1a2de3ad8878b56e96225163d9df19079b3c2e447` |

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
