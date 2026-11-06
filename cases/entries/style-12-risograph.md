# 跳水 · Risograph 孔版印刷 风格样片

**已有历史成片·本次未重渲** · `style-12-risograph`



![历史画面](../previews/style-12-risograph.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/style-12-risograph-preview.mp4) · 历史成片转码，非重新渲染。


## 源码与还原

```bash
python3 tools/casebook.py restore style-12-risograph --download
```

还原位置：`out/casebook/style-test-66/12-risograph/`。只看代码可加 `--source-only`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `build.sh` | [查看](../source/style-12-risograph/build.sh) |
| `index.html` | [查看](../source/style-12-risograph/index.html) |
| `CREDITS` | [查看](../source/style-12-risograph/CREDITS) |
| `TREATMENT.md` | [查看](../source/style-12-risograph/TREATMENT.md) |

运行前核对：Legacy Lemo runtime at fixed commit；Python scientific audio packages；FFmpeg；Fonts/samples per CREDITS

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| 12-risograph.mp4 | 1920×1080 / 19.500 | [original-films-01.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-01.zip)，包内 `style-12-risograph/12-risograph.mp4` | `f8a74bec8869559e24f7c53ccf5ba1e28d6e145695c430bec9af4c10bf124121` |

完整文件映射和原始SHA256见 [catalog.json](../catalog.json)。来源见 [NOTICES](../NOTICES.md)。
