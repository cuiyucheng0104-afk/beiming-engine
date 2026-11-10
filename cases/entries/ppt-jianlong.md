# 见龙

**历史成片·2026-11-07 归档时未重渲** · `ppt-jianlong`

印刷长镜头 / 水墨版画；PPT原画分层，代码配乐；本次保留v2新旁白版本。

![历史画面](../previews/ppt-jianlong.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/ppt-jianlong-preview.mp4) · 历史成片转码，非重新渲染。

历史故事介绍片；原画、配音和配乐为项目资产。入库不等于重新渲染或品牌终审。

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 历史成片（归档时未重渲；机器 QA 未跑） |
| 用户认可 | 未审：仓库里没有用户认可的记录；上作品站不等于用户认可 |
| 权利 | 内部：含客户材料、第三方 IP 或参考图，权利方 待补；restore 默认不还原其素材，产物不得用进新作品或对外物料 |
| 登记类别 | R04、R09（[授权登记册](../../docs/rights/register.md)） |
| AI 生成 | 含（R09；工具与版本待补） |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore ppt-jianlong --download
```

还原位置：`out/casebook/Desktop/上影ppt/见龙/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。内部素材默认不还原，只为研究方法时加 `--include-internal`。

| 入口 | 归档原文件 |
|---|---|
| `jianlong/build.sh` | [查看](../source/ppt-jianlong/jianlong/build.sh) |
| `jianlong/index.html` | [查看](../source/ppt-jianlong/jianlong/index.html) |
| `jianlong/CREDITS` | [查看](../source/ppt-jianlong/jianlong/CREDITS) |
| `jianlong/TREATMENT.md` | [查看](../source/ppt-jianlong/jianlong/TREATMENT.md) |
| `jianlong/music/README.md` | [查看](../source/ppt-jianlong/jianlong/music/README.md) |

运行前核对：Python/Pillow/NumPy + FFmpeg；Prepared narration, original slides and depth maps

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 见龙_印刷水墨版_v2新旁白_3分14秒.mp4 | 1920×1080 / 194.500 | [original-films-04.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-04.zip)，包内 `ppt-jianlong/见龙_印刷水墨版_v2新旁白_3分14秒.mp4` | `480a18e955d3eef02c08b8a5d87318ab687a7fd730dffbf2680dbebd413c68a9` |
| 见龙_印刷水墨版_v2新旁白_3分14秒_手机版.mp4 | 1280×720 / 194.517 | [original-films-04.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-04.zip)，包内 `ppt-jianlong/见龙_印刷水墨版_v2新旁白_3分14秒_手机版.mp4` | `1828b57e09eb87dc25351e8ece3f8ce133ce2a9fa5b209fd4f11d49ef6124e88` |

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
