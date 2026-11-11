# 日落之前

**历史成片·2026-11-07 归档时未重渲** · `ppt-before-sunset`

西部海报、原画分层、落日倒计时与双语声音。历史记录提醒需复查音频峰值。

![历史画面](../previews/ppt-before-sunset.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/ppt-before-sunset-preview.mp4) · 历史成片转码，非重新渲染。

历史故事介绍片；原画、配音和配乐为项目资产。入库不等于重新渲染或品牌终审。

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 历史成片（归档时未重渲；机器 QA 未跑） |
| 用户认可 | 未审：仓库里没有用户认可的记录；上作品站不等于用户认可 |
| 权利 | 内部：含客户材料、第三方 IP 或参考图，权利方 乐奇 / Rokid（法律主体名称待补）；restore 默认不还原其素材，产物不得用进新作品或对外物料 |
| 登记类别 | R02、R09（[授权登记册](../../docs/rights/register.md)） |
| AI 生成 | 含（R09；工具与版本待补） |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore ppt-before-sunset --download
```

还原位置：`out/casebook/Desktop/上影ppt/日落之前/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。内部素材默认不还原，只为研究方法时加 `--include-internal`。

| 入口 | 归档原文件 |
|---|---|
| `build.sh` | [查看](../source/ppt-before-sunset/build.sh) |
| `film/build.py` | [查看](../source/ppt-before-sunset/film/build.py) |
| `方案.md` | [查看](../source/ppt-before-sunset/方案.md) |

运行前核对：Python/Pillow/NumPy + FFmpeg；Prepared narration, original slides and depth maps

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 日落之前_故事介绍_手机版.mp4 | 1280×720 / 170.792 | [original-films-05.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-05.zip)，包内 `ppt-before-sunset/日落之前_故事介绍_手机版.mp4` | `14951614ff953d3412731a3d7653864a2ab12f1428a1e65b739ad5d75b95aa43` |
| 日落之前_故事介绍.mp4 | 1920×1080 / 170.792 | [original-films-06.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-06.zip)，包内 `ppt-before-sunset/日落之前_故事介绍.mp4` | `890ad88184ca81ccc2e9b18783f33216b4729c734e5c91498b1bbf678596e382` |

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
