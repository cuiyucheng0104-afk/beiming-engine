# 懂你的人

**已有历史成片·本次未重渲** · `ppt-understands-you`

后续书桌版：Blender Cycles一镜到底，照片浮雕和投影HUD；旧版入口仍是历史文件，不应误当书桌版。

![历史画面](../previews/ppt-understands-you.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/ppt-understands-you-preview.mp4) · 历史成片转码，非重新渲染。

历史故事介绍片；原画、配音和配乐为项目资产。入库不等于重新渲染或品牌终审。
书桌版为后续版本，film/build.py 同时保留旧版；以 tools/desk_film.py 和技术说明为入口。

## 源码与还原

```bash
python3 tools/casebook.py restore ppt-understands-you --download
```

还原位置：`out/casebook/Desktop/上影ppt/懂你的人/`。只看代码可加 `--source-only`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `build.sh` | [查看](../source/ppt-understands-you/build.sh) |
| `film/build.py` | [查看](../source/ppt-understands-you/film/build.py) |
| `tools/desk_film.py` | [查看](../source/ppt-understands-you/tools/desk_film.py) |

运行前核对：Python/Pillow/NumPy + FFmpeg；Prepared narration, original slides and depth maps；Blender Cycles for desk version

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 懂你的人_书桌版_手机版.mp4 | 1280×720 / 185.583 | [original-films-05.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-05.zip)，包内 `ppt-understands-you/懂你的人_书桌版_手机版.mp4` | `42eca94ab167697acdd56c74b61dda73911e143f9ae90a3fdb2cee4ad90c6166` |
| 懂你的人_书桌版.mp4 | 1920×1080 / 185.583 | [original-films-05.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-05.zip)，包内 `ppt-understands-you/懂你的人_书桌版.mp4` | `723f9a0aadea9509431bee32489aceede565749350c31440889c81f556b8c7c6` |

完整文件映射和原始SHA256见 [catalog.json](../catalog.json)。来源见 [NOTICES](../NOTICES.md)。
