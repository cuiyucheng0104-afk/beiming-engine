# 作业

管理作业调度、缓存、资产库和账本。

通过契约接收协议组件的作业请求，并交接作业输入与产物。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[片子描述](../kernel/contracts/film/CONTRACT.md)（作业输入）、[锁文件](../kernel/contracts/lock/CONTRACT.md)（种子、版本与哈希，缓存与复跑按它对齐）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。
