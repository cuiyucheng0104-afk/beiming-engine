# 电影场记板 · Clapperboard 3D

一个用 **Three.js (r160)** 制作的电影场记板（打板器 / clapperboard）3D 模型网页。
**单文件、零依赖、纯前端**——一个 `index.html` 即是完整作品：建模 + 程序化贴图 + 自定义着色器 + 灯光 + 交互动画，全部内联，无需构建工具。

> 由参考图片（一张电影场记板产品图）逆向建模，并经多轮迭代：基础建模 → 醒目的黑白立体色块 → 着色器光影与立体化 → 旋转的自然光效。

---

## ✨ 特性

- 🎬 **打板动画**：点击按钮或直接点模型，上板"啪"地合下再弹开（缓入急合 / 缓出回弹）
- 🟦 **醒目的黑白立体色块**：`ROLL / SCENE / TAKE` 标题条、三个大号数值格（A12 / 047 / 03）、`DIRECTOR` 黑条 + 白色填写格——全部是**真实凸起几何**，自带投影
- 🧊 **立体厚实建模**：圆角挤出板体、圆角厚打板条、加粗铆钉 / 转轴 / 角块
- 💡 **自定义 Fresnel 边缘光着色器**：通过 `onBeforeCompile` 注入世界空间菲涅尔 rim，叠加 `MeshPhysicalMaterial` 清漆质感
- ☀️ **旋转的自然光效**：太阳（方向光）绕模型公转，随昼→暮改变色温、强度与阴影方向；可开关、调速
- 🖱️ **交互**：左键拖拽旋转 · 滚轮缩放 · 右键平移（OrbitControls）；自动旋转、复位视角

---

## 🧱 技术栈

| 分类 | 使用 |
| --- | --- |
| 渲染核心 | [Three.js](https://threejs.org) **r0.160.0**（WebGL2 / `WebGLRenderer`） |
| 模块加载 | 原生 **ES Modules + `importmap`**，从 CDN（unpkg）加载，无打包器 |
| 相机控制 | `OrbitControls`（three/addons） |
| 环境光照 IBL | `RoomEnvironment` + `PMREMGenerator` |
| 色调映射 | `ACESFilmicToneMapping`，`toneMappingExposure = 1.12` |
| 阴影 | `PCFSoftShadowMap`，单一方向光投射，4096 阴影贴图 |
| 几何 | `ExtrudeGeometry`（圆角 `Shape`）、`BoxGeometry`、`CylinderGeometry`、`PlaneGeometry` |
| 材质 | `MeshPhysicalMaterial`（clearcoat 清漆）、`MeshStandardMaterial`、`ShadowMaterial`、`MeshBasicMaterial` |
| 程序化贴图 | `CanvasTexture`——斜条纹、标签文字、柔和接触阴影，全部用 2D Canvas 现画 |
| 自定义着色器 | `material.onBeforeCompile` 注入 GLSL，在 r160 的 `<opaque_fragment>` 处加菲涅尔 rim |
| 动画 | `requestAnimationFrame` + `THREE.Clock`（`getElapsedTime` 驱动太阳公转，防相位漂移） |
| 本地预览 | Python `http.server`（或任意静态服务器 / `启动.command`） |

---

## 🚀 运行（操作路径）

页面使用 ES Module + `importmap` 并从 CDN 加载 three.js，因此**需要联网**，且**不能直接双击用 `file://` 打开**（Chrome 会拦截模块脚本）。请用本地服务器：

```bash
# 方式 A：进入项目目录起一个静态服务器
cd clapperboard-3d
python3 -m http.server 8000
# 浏览器访问 http://localhost:8000/index.html
```

- **方式 B（macOS）**：双击 `启动.command`，自动起服务器并打开浏览器。
- **方式 C**：VS Code 的 *Live Server* 等任意静态服务器打开 `index.html`。

---

## 📂 项目结构

```
clapperboard-3d/
├── index.html      # 整个 3D 场景：建模 + 着色器 + 灯光 + 交互，自包含
├── 启动.command    # macOS 双击启动本地预览
├── README.md       # 本文件
└── README.txt      # 纯文本说明（随桌面打包分发用）
```

`index.html` 内部分区（`<script type="module">`）：
1. Renderer / Scene / Camera / OrbitControls / PMREM 环境
2. Lights（三点布光 + 可公转的太阳）
3. 程序化贴图：`makeStripeTexture`（条纹）、`makeLabelTexture`（标签）、`makeBlobTex`（接触阴影）
4. 材质 + 圆角盒 `roundedBoxShape`
5. 建模：板体、凸起色块（`makeBand` / `labelOnBand`）、打板条（`makeStick`）、铰链五金
6. 着色器：`addRim`（Fresnel 边缘光，`onBeforeCompile`）
7. 旋转自然光：`updateSun` / `restoreStaticLighting`
8. 打板动画状态机、UI 按钮、`animate` 主循环

---

## 🛠️ 制作过程

1. **逆向建模**：分析参考图，用内置几何拼出板体 + 双打板条 + 铰链铆钉；`CanvasTexture` 画斜条纹与表单文字；加 OrbitControls、打板动画、柔和投影。
2. **修正贴图**：`ExtrudeGeometry` 端面是世界坐标 UV，重新归一化到 0–1 让贴图铺满板面；修正镜像文字。
3. **改版为醒目黑白立体色块**：删掉细密表单文字，换成**真实凸起的圆角色块** + 透明贴花标签；板体加厚、打板条改圆角厚条；升级 `MeshPhysicalMaterial` clearcoat；写 `addRim` 菲涅尔边缘光（经校验：r160 注入点是 `<opaque_fragment>`，非已废弃的 `<output_fragment>`）；三点影棚布光 + 接触阴影。
4. **旋转的自然光效**：先让子代理产出实现"提示词"，据此把主光改为绕模型公转的太阳，随昼夜改色温 / 强度 / 阴影，并加"自然光"开关与速度档；冷色 rim 背光对位太阳游走。
5. **打包 / 同步**：桌面 zip 分发 + 双击启动脚本；推送到 GitHub；学习笔记与流程图同步到 Obsidian。

---

## 🔌 嵌入到你自己的网页

- **直接内联**：把 `index.html` 里的 `importmap` 和 `<script type="module">` 拷过去，页面里准备一个挂载容器 `<div id="app"></div>` 即可，不依赖任何打包工具。
- **iframe 内嵌**：`<iframe src="clapperboard-3d/index.html" style="border:0;width:100%;height:600px"></iframe>`

---

## 📄 License

MIT
