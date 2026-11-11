# 上影发布会共用资源

**共用资源** · `keynote-shared`

## 状态与权利

| 项 | 记录 |
|---|---|
| 技术状态 | 共用资源（机器 QA 未跑） |
| 用户认可 | 未审：仓库里没有用户认可的记录；上作品站不等于用户认可 |
| 权利 | 内部：含客户材料、第三方 IP 或参考图，权利方 上海美术电影制片厂及相关权利方；restore 默认不还原其素材，产物不得用进新作品或对外物料 |
| 登记类别 | R01、R05、R08（[授权登记册](../../docs/rights/register.md)） |
| AI 生成 | 含（R08；工具与版本待补） |

## 源码与还原

```bash
node tools/env/py.mjs tools/casebook.py restore keynote-shared --download
```

还原位置：`out/casebook/Desktop/上影ppt/03-制作/共用/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。命令不运行构建。内部素材默认不还原，只为研究方法时加 `--include-internal`。

| 入口 | 归档原文件 |
|---|---|

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。

完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。
