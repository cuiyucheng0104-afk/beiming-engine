# 技术卡

存放全部卡文件，以及内建能力之外的数据层卡实现。数据层卡实现在 `cards/<类>/<名>/`，其中 `<名>` 是卡名的最后一段。时间线、事件、随机流和插值的实现在 `kernel/eval/`。

卡文件格式、运行时接口和卡的放置遵循契约。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[卡文件格式](../kernel/contracts/card-file/CONTRACT.md)（卡文件字段与验证状态）、[卡的运行时接口](../kernel/contracts/card-runtime/CONTRACT.md)（卡入口与装载顺序）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。
