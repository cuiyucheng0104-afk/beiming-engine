# 画境追宝

**历史成片·2026-11-07 归档时未重渲** · `ppt-painting-treasure`

11幅漫画场景、三次入画、翻译气泡和展签；历史记录提醒需复查音频峰值。

![历史画面](../previews/ppt-painting-treasure.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/ppt-painting-treasure-preview.mp4) · 历史成片转码，非重新渲染。

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
node tools/env/py.mjs tools/casebook.py restore ppt-painting-treasure --download
```

还原位置：`out/casebook/Desktop/上影ppt/画境追宝/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。内部素材默认不还原，只为研究方法时加 `--include-internal`。

| 入口 | 归档原文件 |
|---|---|
| `film/assemble.sh` | [查看](../source/ppt-painting-treasure/film/assemble.sh) |
| `film/build.py` | [查看](../source/ppt-painting-treasure/film/build.py) |
| `方案.md` | [查看](../source/ppt-painting-treasure/方案.md) |

运行前核对：Python/Pillow/NumPy + FFmpeg；Prepared narration, original slides and depth maps

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 画境追宝_故事介绍.mp4 | 1920×1080 / 237.041 | [original-films-06.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-06.zip)，包内 `ppt-painting-treasure/画境追宝_故事介绍.mp4` | `090045df0af5fc5f65382703095a8dbcbd5adb4a01ffe1fa90f1f463ed6841ce` |
| 画境追宝_故事介绍_手机版.mp4 | 1280×720 / 237.042 | [original-films-06.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-06.zip)，包内 `ppt-painting-treasure/画境追宝_故事介绍_手机版.mp4` | `0c9ee1de78cba0fdfc745df4f0e94ba117cbb67408cdb29fff97a782ba48870e` |

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
