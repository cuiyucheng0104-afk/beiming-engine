# 方案 C《打开》20 秒开头

**历史成片·2026-11-07 归档时未重渲** · `keynote-C-kaitou`

![历史画面](../previews/keynote-C-kaitou.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/keynote-C-kaitou-preview.mp4) · 历史成片转码，非重新渲染。

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 历史成片（归档时未重渲；机器 QA 未跑） |
| 用户认可 | 未审：仓库里没有用户认可的记录；上作品站不等于用户认可 |
| 权利 | 内部：含客户材料、第三方 IP 或参考图，权利方 上海美术电影制片厂及相关权利方；restore 默认不还原其素材，产物不得用进新作品或对外物料 |
| 登记类别 | R01、R07、R08（[授权登记册](../../docs/rights/register.md)） |
| 署名 | Drums: "MuldjordKit" by Lars Muldjord (drumgizmo.org), FreePats version, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) |
| AI 生成 | 含（R08；工具与版本待补） |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore keynote-C-kaitou --download
```

还原位置：`out/casebook/Desktop/上影ppt/03-制作/C-kaitou/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。内部素材默认不还原，只为研究方法时加 `--include-internal`。

| 入口 | 归档原文件 |
|---|---|
| `build.sh` | [查看](../source/keynote-C-kaitou/build.sh) |
| `index.html` | [查看](../source/keynote-C-kaitou/index.html) |
| `CREDITS` | [查看](../source/keynote-C-kaitou/CREDITS) |
| `TREATMENT.md` | [查看](../source/keynote-C-kaitou/TREATMENT.md) |

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| C-kaitou.mp4 | 1920×1080 / 20.000 | [original-films-07.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-07.zip)，包内 `keynote-C-kaitou/C-kaitou.mp4` | `d06d5b5041b9e184bcae94b21618c71f87b670b1ec312d155f2a70471685b38c` |

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
