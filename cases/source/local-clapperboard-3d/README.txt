电影场记板 · Clapperboard 3D
================================

一个用 Three.js (r160) 制作的电影场记板 3D 模型网页，单文件、零依赖、纯前端。
特性：
  - 醒目的黑白色立体色块（ROLL / SCENE / TAKE + 数值格 + DIRECTOR）
  - 厚实立体建模 + clearcoat 塑料质感 + 自定义 fresnel 边缘光着色器
  - 旋转的自然光效（太阳公转，昼→暮色温/阴影变化）
  - 打板动画、自动旋转、自然光开关与速度、复位视角
  - 鼠标左键拖拽旋转 · 滚轮缩放 · 右键平移

如何运行
--------
本页面使用 ES Module + importmap，并从 CDN(unpkg) 加载 three.js，
所以需要联网，且不能直接双击用 file:// 打开（Chrome 会拦截模块脚本）。
请用以下任一方式通过本地服务器打开：

  方式 A（最简单）：双击本文件夹里的「启动.command」，会自动开本地服务器并打开浏览器。

  方式 B（手动）：在本文件夹打开终端，执行
        python3 -m http.server 8000
     然后浏览器访问  http://localhost:8000/index.html

  方式 C：用 VS Code 的 Live Server 等任意静态服务器打开 index.html。

嵌入到你自己的网页
------------------
  - 直接把 index.html 里 <script type="module"> 的内容和 importmap 拷过去（只需一个 <div id="app"> 容器）。
  - 或用 <iframe src="index.html"> 内嵌。

文件
----
  index.html     —— 整个 3D 场景（模型 + 着色器 + 灯光 + 交互），自包含。
  启动.command   —— macOS 双击启动本地预览。
  README.txt     —— 本说明。
