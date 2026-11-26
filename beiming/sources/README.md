# 帧源

帧源按镜头输入打开会话，按帧交付图像层与元数据。[帧源契约](../kernel/contracts/source/CONTRACT.md) 定义能力声明和会话接口，[输出通道](../kernel/contracts/passes/CONTRACT.md) 定义层的形状、类型和颜色空间。

| 帧源 | 入口与用途 |
| --- | --- |
| [Three](three/README.md) | 在页面宿主里运行 Three 镜头，按能力声明交出帧、通道与场景读数 |
| [Blender](blender/README.md) | 通过常驻 Blender 会话加载和求值场景，可导出场景包 |
| [旧页面](legacy-page/README.md) | 通过兼容帧源输出旧作品的颜色层与元数据 |
| [核心](core/README.md) | 读取场景包并经原生内核出帧，具体能力与档位以该组件的说明为准 |

改接口后核对能力声明与契约。层数据和元数据应由同一次镜头求值产生。

```sh
node --test beiming/sources/legacy-page/legacy-page.test.mjs
```
