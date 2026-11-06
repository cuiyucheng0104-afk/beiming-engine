# 这条街照常过年

**已有历史成片·本次未重渲** · `ppt-new-year-street`

灯笼节拍、100BPM、PPT原画与多语声音；主成片为v3。

![历史画面](../previews/ppt-new-year-street.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/ppt-new-year-street-preview.mp4) · 历史成片转码，非重新渲染。

历史故事介绍片；原画、配音和配乐为项目资产。入库不等于重新渲染或品牌终审。

## 源码与还原

```bash
python3 tools/casebook.py restore ppt-new-year-street --download
```

还原位置：`out/casebook/Desktop/上影ppt/这条街照常过年/`。只看代码可加 `--source-only`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `film/build.py` | [查看](../source/ppt-new-year-street/film/build.py) |

运行前核对：Python/Pillow/NumPy + FFmpeg；Prepared narration, original slides and depth maps

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 这条街照常过年_故事介绍_手机版.mp4 | 1280×720 / 124.800 | [original-films-06.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-06.zip)，包内 `ppt-new-year-street/这条街照常过年_故事介绍_手机版.mp4` | `f666862f34135b211fcf94775b15b828621b33e610cdaa9f6a6c53efba71c75c` |
| 这条街照常过年_故事介绍.mp4 | 1920×1080 / 124.800 | [original-films-07.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-07.zip)，包内 `ppt-new-year-street/这条街照常过年_故事介绍.mp4` | `b987300137bf0a4707c08dbcac7d70b408d01a1632ddf6d44b9511e1f8407469` |

完整文件映射和原始SHA256见 [catalog.json](../catalog.json)。来源见 [NOTICES](../NOTICES.md)。
