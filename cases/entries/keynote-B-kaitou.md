# 方案 B《片库之夜》20 秒开头 · 导演阐述（TREATMENT）

**已有历史成片·本次未重渲** · `keynote-B-kaitou`



![历史画面](../previews/keynote-B-kaitou.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/keynote-B-kaitou-preview.mp4) · 历史成片转码，非重新渲染。


## 源码与还原

```bash
python3 tools/casebook.py restore keynote-B-kaitou --download
```

还原位置：`out/casebook/Desktop/上影ppt/03-制作/B-kaitou/`。只看代码可加 `--source-only`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `build.sh` | [查看](../source/keynote-B-kaitou/build.sh) |
| `index.html` | [查看](../source/keynote-B-kaitou/index.html) |
| `CREDITS` | [查看](../source/keynote-B-kaitou/CREDITS) |
| `TREATMENT.md` | [查看](../source/keynote-B-kaitou/TREATMENT.md) |

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| B-kaitou.mp4 | 1920×1080 / 20.000 | [original-films-07.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-07.zip)，包内 `keynote-B-kaitou/B-kaitou.mp4` | `c49b0c348efa446170d39d8f7d2652c5478245c0ebaa9b3e676d04436cd86a6f` |

完整文件映射和原始SHA256见 [catalog.json](../catalog.json)。来源见 [NOTICES](../NOTICES.md)。
