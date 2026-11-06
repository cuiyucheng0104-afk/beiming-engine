# 完整风格基座快照

用户要求完整收录两套库，因此这里保存固定提交的**所有 Git 跟踪文件**，没有只摘取 STYLE 文档或示例入口。每个文件原始字节、目录与可执行权限保留；LICENSE、作者署名、构建脚本、工具、配套资产和原仓库说明一并在内。

| 快照 | 版本 | 内容 |
|---|---|---|
| [sy-style-100](sy-style-100/) | `e41dee31a5c05dffa12b2f241378e648d2a22df6` | 331文件；20风格、20第二期、60行业示例、18个lib模块及渲染/声音/构建工具 |
| [lemo-opuscar](lemo-opuscar/) | `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` | 2478文件；66个实际风格基座、模板、全部demo源码、core、导演/技术文档及工具 |

入口：[SY首期](sy-style-100/styles/)、[第二期](sy-style-100/vol2/)、[行业60例](sy-style-100/industry/)、[Lemo全部风格](lemo-opuscar/styles/README.md)、[Lemo core](lemo-opuscar/core/README.md)。

`lock.json` 记录两个快照总计 **2809 个文件**。每项含路径、文件模式、Git blob SHA1、SHA256与大小。运行 `python3 tools/casebook.py check` 同时校验全部快照。

这里是外部参考代码，不冒充北冥原创。后续修改北冥适配层，不就地改快照；升级时重新固定版本并更新lock。`node_modules`、虚拟环境、Git历史和上游从未提交的Release影片不属于源代码快照，未复制。依赖按各自原始package/requirements安装；原仓库完整安装说明保留。

本机案例中137处逐字相同的上游代码引用这份快照，恢复案例时还原原有路径，不再保存第二份相同源码。其余差异版本仍独立保留。
