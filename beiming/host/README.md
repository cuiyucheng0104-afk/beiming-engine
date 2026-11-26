# 帧源宿主

宿主负责设备、场景装载、逐帧驱动及产物写盘。[帧源契约](../kernel/contracts/source/CONTRACT.md) 约定输入、会话生命周期和能力声明。

- [页面宿主](page/README.md) 通过 [startSource](page/host.mjs) 启动无头浏览器，为每个会话分配独立页面并量测帧元数据。
- [离屏宿主](offscreen/README.md) 通过 Node 与 Dawn 运行双宿主像素对拍。启用条件和主线档位限制以组件说明为准。

```sh
node --test beiming/host/page/host.test.mjs
```
