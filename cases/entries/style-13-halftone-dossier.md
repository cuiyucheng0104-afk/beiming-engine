# 消失的第十三页

**历史成片·2026-11-07 归档时未重渲** · `style-13-halftone-dossier`

![历史画面](../previews/style-13-halftone-dossier.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/style-13-halftone-dossier-preview.mp4) · 历史成片转码，非重新渲染。

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 历史成片（归档时未重渲；机器 QA 未跑） |
| 用户认可 | 未审：仓库里没有用户认可的记录；上作品站不等于用户认可 |
| 权利 | 公开归档 |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore style-13-halftone-dossier --download
```

还原位置：`out/casebook/style-test-66/13-halftone-dossier/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `build.sh` | [查看](../source/style-13-halftone-dossier/build.sh) |
| `index.html` | [查看](../source/style-13-halftone-dossier/index.html) |
| `CREDITS` | [查看](../source/style-13-halftone-dossier/CREDITS) |
| `TREATMENT.md` | [查看](../source/style-13-halftone-dossier/TREATMENT.md) |

运行前核对：Legacy Lemo runtime at fixed commit；Python scientific audio packages；FFmpeg；Fonts/samples per CREDITS

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 13-halftone-dossier.mp4 | 1920×1080 / 19.600 | [original-films-01.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-01.zip)，包内 `style-13-halftone-dossier/13-halftone-dossier.mp4` | `3e7de0662b2df062a1b3b6936e52191e8e015cfb0bcd1caa507e73b3d8ac9d89` |

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
