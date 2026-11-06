# 北冥九景 · 三维重建与画风试验

这轮按九张参考的题材重建三维场景，复用《北冥》的三档着色、蓝紫阴影、暖色边缘光和屏幕空间墨线。它是可继续修改机位、几何和灯光的风格样张，不是参考图的像素级复刻。

**看结果：`delivery/index.html`。** 每景包含原生 3840×2160 成图、原始参考、灰模及侧移机位。无需联网即可看成果页。

## 文件

| 位置 | 内容 |
|---|---|
| `lab/scenes.js` | 九景的模型摆位、相机、灯光、空间尺度 |
| `lab/world.js` | 器物、曲面屋顶、树枝、山体、舟船等真实几何；主体GLB着色；材质色板 |
| `lab/main.js` | 渲染器、阴影、后期、灰模与机位切换 |
| `src/toon.js` / `src/look.js` | 从北冥工程复制的原片材质与后期配方 |
| `engine/` | 北冥引擎快照，来自提交 `a65c172246d04351e3e380f2d5925d2a6ff1950a` |
| `models/` | 书生、舟人、楼阁三个既有 TRELLIS.2 实体模型 |
| `assets/` | 北冥自有水彩天空、云和纸纹 |
| `refs/` | 用户提供的九张参考及原始 SHA256 |
| `out/final/` | RTX5090 原生4K渲染与逐景日志 |
| `out/qa/` | 1920×1080灰模和侧移视角 |
| `tools/` | 批量渲染、成果整理、Windows运行入口 |
| `delivery/` | 可离线浏览的九景成果页、4K PNG、对照图 |

## RTX 5090 上重渲

工程位于 `D:\北冥\experiments\beiming-nine-3d`，英文入口 `D:\beiming\experiments\beiming-nine-3d` 指向同一处。已有 `node_modules` 连接到工作站上的公共依赖目录。

```powershell
cd D:\beiming\experiments\beiming-nine-3d
powershell -NoProfile -ExecutionPolicy Bypass -File tools\render.ps1 -Mode final
# 只渲第4景
powershell -NoProfile -ExecutionPolicy Bypass -File tools\render.ps1 -Mode final -Scenes "04"
# 灰模与移机
powershell -NoProfile -ExecutionPolicy Bypass -File tools\render.ps1 -Mode clay
```

脚本只对当前进程设置 Chrome/Vulkan 后端，不改系统执行策略。渲染器会核对 WebGL 设备确为 RTX 5090 + Vulkan。使用共享工作站前应确认没有别的GPU任务。

新机器安装 `npm ci`，准备Chrome；Mac试渲可执行：

```sh
BEIMING_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tools/render.mjs --pilot --local --tag latest
```

`--local` 仅跳过5090设备校验，不改变着色方式。默认最终输出3840×2160，pilot为1600×900。

## 这轮实际改了什么

之前的360张是单视图深度曲面实验，这轮没有使用那套MoGe网格或整张参考投影。主体明暗来自三维法线、灯光和阴影；原始参考不会进入最终画面的贴图通道。

背景天空和远云仍使用北冥自有2D水彩底板。书法也是局部二维纹理，贴在有位置、法线和遮挡的纸张/碑面上；这符合原片的3D主体+2.5D背景组合。

为了清晰度，Kuwahara从原片半径5、强度1降到半径1.2、强度0.14；纸纹降到0.025；Bloom降到0.18；墨线宽度1.4（按1080高度标定）。几何在4K原生光栅化，未做AI超分。见 `docs/画风与几何说明.md`。

## 尚未达到的部分

- 书生、舟人是单图生成的实体模型，脸、手、衣褶和背面仍有误差，未做角色级拓扑或绑定。
- 05与09的村舍、人物为程序化风格资产；树冠与山体形状有重复性，属于视觉开发阶段。
- 06与07复用楼阁主体，但场景布局与镜头不同；没有声称九个独立高精度扫描模型。
- 这轮验证的是三维与三渲二画风，不含动画稳定性或120分钟影片的生产验证。

代码和既有资产的许可范围沿用工程中的 LICENSE；用户提供的参考图不被声明为本项目原创。
