# Blender 帧源

在帧源侧与 Blender 交互，按帧源接口交付帧产物。

通过帧源接口契约接收输入和交付帧产物，渲染器依赖留在本帧源侧。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[帧源接口](../../kernel/contracts/source/CONTRACT.md)（能力声明与会话接口）、[场景包](../../kernel/contracts/scene-pack/CONTRACT.md)（几何、实例表与每帧状态的交换格式）、[输出通道](../../kernel/contracts/passes/CONTRACT.md)（交付的通道）。

通用约定见[契约目录](../../kernel/contracts/)、[契约写法约定](../../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../../kernel/contracts/ownership/CONTRACT.md)。
