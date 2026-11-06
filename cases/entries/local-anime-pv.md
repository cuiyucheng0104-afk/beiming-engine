# AFTERGLOW 动画PV

**已有历史成片·本次未重渲** · `local-anime-pv`



![历史画面](../previews/local-anime-pv.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/local-anime-pv-preview.mp4) · 历史成片转码，非重新渲染。


## 源码与还原

```bash
python3 tools/casebook.py restore local-anime-pv --download
```

还原位置：`out/casebook/anime-pv/`。只看代码可加 `--source-only`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| AFTERGLOW_PV.mp4 | 1920×1080 / 30.000 | [original-films-10.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-10.zip)，包内 `local-anime-pv/AFTERGLOW_PV.mp4` | `dc1ac920b98dd5c12e8ece4b0aa4452e223e4605d8c97acebc7f26af7b5b30f4` |

完整文件映射和原始SHA256见 [catalog.json](../catalog.json)。来源见 [NOTICES](../NOTICES.md)。
