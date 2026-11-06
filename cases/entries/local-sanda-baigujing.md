# 三打白骨精

**已有历史成片·本次未重渲** · `local-sanda-baigujing`



![历史画面](../previews/local-sanda-baigujing.jpg)

[观看/下载压缩预览](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/local-sanda-baigujing-preview.mp4) · 历史成片转码，非重新渲染。


## 源码与还原

```bash
python3 tools/casebook.py restore local-sanda-baigujing --download
```

还原位置：`out/casebook/sanda-baigujing/`。只看代码可加 `--source-only`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `build.sh` | [查看](../source/local-sanda-baigujing/build.sh) |
| `index.html` | [查看](../source/local-sanda-baigujing/index.html) |
| `CREDITS` | [查看](../source/local-sanda-baigujing/CREDITS) |
| `TREATMENT.md` | [查看](../source/local-sanda-baigujing/TREATMENT.md) |

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换。

## 保留的成片版本

| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |
|---|---|---|---|
| sanda-baigujing.mp4 | 1920×1080 / 93.000 | [original-films-10.zip](https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/casebook-2026.11/original-films-10.zip)，包内 `local-sanda-baigujing/sanda-baigujing.mp4` | `1b389929117aa1c9bf04eec269037153d593884b8de083f9aaed1db81d479925` |

完整文件映射和原始SHA256见 [catalog.json](../catalog.json)。来源见 [NOTICES](../NOTICES.md)。
