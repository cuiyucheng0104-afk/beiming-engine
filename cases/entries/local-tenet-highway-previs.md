# 公路动作预演

**技术预演·非正式作品** · `local-tenet-highway-previs`

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 技术预演（机器 QA 未跑） |
| 用户认可 | 未审：仓库里没有用户认可的记录；上作品站不等于用户认可 |
| 权利 | 公开归档 |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore local-tenet-highway-previs --download
```

还原位置：`out/casebook/tenet-highway-previs/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|
| `README.md` | [查看](../source/local-tenet-highway-previs/README.md) |
| `legacy/README.md` | [查看](../source/local-tenet-highway-previs/legacy/README.md) |

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
