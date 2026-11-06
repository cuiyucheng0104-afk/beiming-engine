# 上影发布会共用资源

**共用资源** · `keynote-shared`




## 源码与还原

```bash
python3 tools/casebook.py restore keynote-shared --download
```

还原位置：`out/casebook/Desktop/上影ppt/03-制作/共用/`。只看代码可加 `--source-only`。命令不运行构建。

| 入口 | 归档原文件 |
|---|---|

运行前核对：见本工程说明与依赖文件。

历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换。


完整文件映射和原始SHA256见 [catalog.json](../catalog.json)。来源见 [NOTICES](../NOTICES.md)。
