# FunTechInc × 北冥引擎源码与功能对照

范围为 FunTechInc 公开仓库清单共 20 项。下表覆盖已有 138 项功能记录，归档空库占一行。

每个仓库给出固定提交和实现入口。右列列出本 PR 的北冥视频镜头 ID。没有视频的功能使用上游运行日志、交互断言、源树或离线夹具。

证据字段中的路径以 FunTech NAS 全量对照目录为基准。表中的上游记录来自固定提交的既有运行。当前批次重新验证源树，并复跑着色器、站点、Worker、角色、视频工具与组件浏览器检查。

站点及应用样片用北冥时间轴和受控夹具把交互结果画出来，实际 DOM、iframe、Worker、拖动和恢复另见浏览器断言。角色画面使用自制模型，资产结构断言使用上游 GLB。

源码入口 [北冥全屏 pass](../../engine/look/pass.js) · [短样片目录](README.md) · [波纹](../rain-ripple-ab) · [墨、烟、粒子](../funtech-fx-ab) · [原片元着色器](shots/upstream.js) · [北冥参数和合成](shots/materials.js) · [站点功能夹具](shots/site.js) · [几何夹具](shots/geometry.js)

## mekuri

[7ee01c9998f05f02f0053a7b11e1a63b93428498](https://github.com/FunTechInc/mekuri/tree/7ee01c9998f05f02f0053a7b11e1a63b93428498)

[上游 README](https://github.com/FunTechInc/mekuri#features-) · [北冥作品进出动画](../../site/js/works.js#L324)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| wait 进出 | 等离场，再挂载或呈现下一页 | 北冥已有作品卡到播放器的进出动画。用相同导航对照串行交接的视觉间歇与点击响应 | 功能实测。在实际构建产物中执行 wait / sync、进入详情、历史后退，并保存挂载状态、滚动值和实际回调序列。 `验证证据/网页组件/网页组件运行结果.json` | [`route-wait`](shots/cases.json) |
| sync 进出 | 新旧内容短暂共存，可自定义进场/离场回调 | 北冥有 GSAP Flip。若新增真正的详情路由，验证页面交叠期间的焦点和点击目标 | 功能实测。在实际构建产物中执行 wait / sync、进入详情、历史后退，并保存挂载状态、滚动值和实际回调序列。 `验证证据/网页组件/网页组件运行结果.json` | [`route-sync`](shots/cases.json) |
| 返回与滚动恢复 | popstate 和 scrollRestoration，sync 模式可用 wait 处理返回 | 北冥现有页内定位与筛选行为。用详情页往返对照列表滚动和筛选状态恢复 | 功能实测。在实际构建产物中执行 wait / sync、进入详情、历史后退，并保存挂载状态、滚动值和实际回调序列。 `验证证据/网页组件/网页组件运行结果.json` | [`route-restore`](shots/cases.json) |
| 组件级动画回调 | 每个组件注册进出、首次进场与同步完成回调 | 北冥已有每个场景的 timeline。先统计同一动画所需的生命周期钩子与取消清理效果 | 功能实测。在实际构建产物中执行 wait / sync、进入详情、历史后退，并保存挂载状态、滚动值和实际回调序列。 `验证证据/网页组件/网页组件运行结果.json` | [`route-wait`](shots/cases.json)、[`route-sync`](shots/cases.json) |
| 路由及滚动集成 | 覆盖 Next.js、Remix，也可配 Lenis | 北冥静态站可直接参考交接时序。新增 SPA 路由后再比框架适配 | 功能实测。上游 Next 示例从首页进入 page1 后返回。两种自定义模式的回调和路由由浏览器夹具记录。 `验证证据/上游浏览器预览/mekuri-next/browser.json` | [`route-restore`](shots/cases.json) |

## spice

[bdfe7dd6a71f2e297f3fdab2c0285b80423b97cb](https://github.com/FunTechInc/spice/tree/bdfe7dd6a71f2e297f3fdab2c0285b80423b97cb)

[上游公开组件及 Hook 导出](https://github.com/FunTechInc/spice/blob/bdfe7dd6a71f2e297f3fdab2c0285b80423b97cb/packages/spice/src/client.js) · [北冥叠字动效](../../engine/overlay/kinetic.js#L193) · [北冥显示层](../../engine/overlay/cjk.js) · [北冥网站策略](../../site/DESIGN.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| FormField | 输入、选择、文本区等组件组合 | 与引擎无直接对应。只有站点加入投稿表单时对比验证、错误提示与键盘路径 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | — |
| ModalButton | 触发弹层 | 北冥已有作品播放器打开与关闭，可对照焦点恢复、Escape 和背景滚动 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`modal`](shots/cases.json) |
| Tab | 内容面板切换 | 与作品分类筛选有交集。测方向键、活动面板与返回恢复 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`tabs`](shots/cases.json) |
| Accordion | 折叠内容 | 可用于技术说明。对比原生 details 与组件的键盘、内容高度和减少动态 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`accordion`](shots/cases.json) |
| InfinityLoop | 内容循环滚动 | 北冥作品列表有横向浏览。只在需要循环时试，验首尾重复内容与静态可读性 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`loop`](shots/cases.json) |
| SplitText | 文本拆分并单元动画 | 北冥已有字形拆分和逐字动效。对照中文换行、标点与 reduced motion | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`split-text`](shots/cases.json) |
| Video | 统一视频组件 | 北冥已有播放器、海报和 metadata 加载。对照 Safari、移动端及加载失败 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`video-plane`](shots/cases.json) |
| Loader | 加载状态起落 | 北冥舞台已有海报占位。对照状态变化、就绪前闪烁与可取消性 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`loader`](shots/cases.json) |
| CustomBreakLineParser | 解析手工断行 | 北冥 CJK 模块有禁则和断行。用中文标题、英文混排对照 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`breakline`](shots/cases.json) |
| StableScroller | 封装稳定的滚动容器状态 | 北冥已有 ScrollTrigger 和滚动测量。用 DOM-WebGL 同步误差作为评价 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`scroll`](shots/cases.json) |
| SpiceStarter | 网站组件和初始化入口 | 北冥站点有全局入口。对比最小站点启动依赖和初始化成本，现阶段收益低 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | — |
| ParallaxThumbnail | 缩略图局部视差 | 与北冥作品卡片相关。对照固定缩略图与浅幅视差的识别度 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`thumbnail`](shots/cases.json) |
| Parallax | 层之间的屏幕空间视差 | 北冥 A 有真实投影与底板视差。按页面视差和镜头投影分别测遮挡与边缘 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`parallax`](shots/cases.json) |
| Float | 子元素浮动动效 | 北冥有 GSAP 和镜头时钟。对照用逐帧函数或 DOM 动画的复用成本 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`float`](shots/cases.json) |
| MediaQuery | 组件响应媒体查询 | 北冥直接用 CSS 与 matchMedia。验首帧状态与视口变化 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`responsive`](shots/cases.json) |
| useIsomorphicLayoutEffect | 兼顾 SSR 和浏览器布局副作用 | 北冥静态站无 React SSR。仅迁移到有 SSR 的站点时验证 hydration 和首帧闪烁 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | — |
| useFrame | 组件级帧回调 | 北冥有 RAF 和 render(t)。网页帧回调对照暂停恢复，成片仍按整数帧 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | — |
| useResizeObserver | 元素尺寸监控 | 北冥舞台已有观察器。比较高频 resize 时更新次数与释放 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`layout`](shots/cases.json) |
| useWindowResizeObserver | 窗口尺寸观测 | 北冥已有窗口与视口监听。比较旋转设备、浏览器栏变化时的稳定性 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`layout`](shots/cases.json) |
| useIntersectionObserver | 交叉可见性回调 | 北冥作品站已有同类实现。用同一可见阈值测触发时点 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`visibility`](shots/cases.json) |
| useIsTouchDevice | 判断触屏能力 | 北冥已有设备判档。比较混合输入设备的行为 | 运行观察。记录当前桌面浏览器的实际设备值，触屏设备尚未覆盖。 `验证证据/网页组件/网页组件运行结果.json` | — |
| useDeviceDetector | 设备能力分类 | 北冥有基于能力和帧时的画质档。比较触屏笔电、慢设备和软件 GPU | 部分实测。HeadlessChrome 环境被识别成 WebKit。记录实际返回值，跨设备分类尚未覆盖。 `验证证据/网页组件/网页组件运行结果.json` | — |
| useMediaQuery | 提供媒体查询状态 | 北冥使用 matchMedia。验状态更新、监听清理与 reduced motion | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`responsive`](shots/cases.json) |
| useShare | 浏览器分享操作 | 如需作品分享，可对照系统共享和复制链接，检查回退与移动端可用性 | 部分实测。观察到分享适配器导出。第三方分享和系统弹窗未发起。 `验证证据/网页组件/网页组件运行结果.json` | — |
| useOnHovering | 跟踪悬停状态 | 北冥已有悬停视频预览。比较鼠标、键盘焦点与触屏窗口 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`hover`](shots/cases.json) |
| useValidElement | React 子元素处理 | 当前没有对应需求。仅在组件库消费 JSX 时评价 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | — |
| useScrollTrigger | 封装 GSAP 滚动注册 | 北冥已直接使用 ScrollTrigger。对照注册、刷新、销毁的复杂度 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | [`scroll`](shots/cases.json)、[`parallax`](shots/cases.json) |
| utils | 将分页等工具聚合导出 | 北冥已有案例筛选及静态构建。只有新增分页时再比页数、空结果、URL 恢复 | 功能实测。实际加载上游组件，浏览器验证状态、DOM 或事件。 `验证证据/网页组件/网页组件运行结果.json` | — |

## sauce

[a5943f34e5e49b33e11de45aa7bdf175dbfbe007](https://github.com/FunTechInc/sauce/tree/a5943f34e5e49b33e11de45aa7bdf175dbfbe007)

[上游组合说明](https://github.com/FunTechInc/sauce) · [依赖配置](https://github.com/FunTechInc/sauce/blob/a5943f34e5e49b33e11de45aa7bdf175dbfbe007/package.json) · [北冥网站构建约定](../../site/CONTRACT.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| Next.js App Router 模板 | Next、React、TypeScript、Sass 及状态容器搭底座 | 北冥作品站构建静态输出。只有出现真实多页站点需求时比构建和运行成本 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/sauce-next/browser.json` | — |
| GSAP、Lenis、spice | 平滑滚动与现成组件拼接 | 北冥有 GSAP、静态回退与 reduced motion。比较复杂页面的滚动延迟和交互稳定性 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/sauce-next/browser.json` | [`scroll`](shots/cases.json) |
| mekuri 入口与过场参考 | README 指向 mekuri 和 blankcanvas 组合 | 复用前两节的导航、画布验证项，以迁移成本为主 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/sauce-next/browser.json` | [`route-wait`](shots/cases.json)、[`route-sync`](shots/cases.json) |
| 语言、CMS 与图片占位依赖 | 配置含 locale 匹配、microCMS SDK 和 LQIP 工具 | 北冥以案例目录生成作品站，已有缩略图。如将来改成 CMS，测草稿、国际化、占位图与构建失效 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/sauce-next/browser.json` | — |
| Cookie 同意工具 | 依赖包含 cookie consent | 取决于站点是否新增需要用户选择的统计或服务。当前对渲染和出片无直接价值 | 部分实测。已在临时环境启动页面。未触发生产统计与同意服务。 `验证证据/上游浏览器预览/sauce-next/browser.json` | — |

## use-shader-fx

[338e63427310a6b13947f68c5863e4cf4bbb62f1](https://github.com/FunTechInc/use-shader-fx/tree/338e63427310a6b13947f68c5863e4cf4bbb62f1)

[上游公开导出](https://github.com/FunTechInc/use-shader-fx/blob/338e63427310a6b13947f68c5863e4cf4bbb62f1/packages/use-shader-fx/src/index.js) · [Storybook 特效索引](https://use-shader-fx-stories.vercel.app/) · [Cream 源码](https://github.com/FunTechInc/use-shader-fx/blob/338e63427310a6b13947f68c5863e4cf4bbb62f1/app/cream/Playground.tsx) · [北冥材质补丁](../../engine/shade/patch.js#L39) · [北冥笔画](../../engine/overlay/brush.js#L64) · [北冥雾](../../engine/look/fog.js#L60) · [C 路线形变参考](../../routes/c-style/STYLES.md) · [雨滴样片源码](../../films/rain-ripple-ab/shots/rain.js)
[上游公开导出与实现](https://github.com/FunTechInc/use-shader-fx/tree/338e63427310a6b13947f68c5863e4cf4bbb62f1/packages/use-shader-fx/src) · [北冥全屏渲染工具](../../engine/look/pass.js#L16) · [叠层](../../engine/look/layers.js#L196) · [底板](../../engine/stage/plates.js#L29) · [画质调节](../../site/js/stage/quality.js#L54) · [逐帧渲染契约](../../engine/render/README.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 高 · 水波纹 useRipple | 波纹面片盖印纹理，用透明度、大小和旋转更新波纹，输出到 FBO | A 路线模版已有碎波。雨滴小样复用它，左边画单圈细环，右边用原片元着色器盖印多圈并合成折射 | A/B 渲染。北冥水面加上游波纹盖印。120 帧全等，16 帧独立取样。 `验证证据/雨滴确定性结果.json` | [`rain`](../rain-ripple-ab/shots/rain.js) |
| 高 · 墨滴扩散 useFluid / useBrush | 流体版把染料注入速度场，随流动对流。笔刷版在上一帧纹理中叠笔触、拖抹与衰减 | C 有水墨风格参考，北冥有字形洇墨和笔刷模块。可补可控的二维流场扩散，用在墨落宣纸或水中染料 | A/B 渲染。北冥样片第 31 帧可见左右差异。1 路、4 路共 216 帧哈希一致，24 个取样帧独立重渲一致。 `验证证据/墨滴烟尘粒子/comparison.json` | [`ink`](../funtech-fx-ab/shots/effects.js) |
| 高 · 烟尘 useFluid / Cream | Cream 将流体输出贴到平面，鼠标轨迹驱动烟状拖尾。模拟累计速度、密度和压力 | 北冥已有按深度混色的雾 pass。可加有涡卷的局部烟尘，基础雾继续负责空间层次 | A/B 渲染。北冥样片第 106 帧可见左右差异。1 路、4 路共 216 帧哈希一致，24 个取样帧独立重渲一致。 `验证证据/墨滴烟尘粒子/comparison.json` | [`smoke`](../funtech-fx-ab/shots/effects.js) |
| 高 · 粒子聚字 useMorphParticles / useCreateMorphParticles | 形态属性随 morphProgress 插值，可附图像或纹理以驱动点外观，也提供在场景中创建粒子的路径 | C 已有 SY-06 粒子形变参考，北冥文字动效可驱动字形拆分。GPU 点云可补从字形轮廓到图标、线稿的高密度变形 | A/B 渲染。北冥样片第 198 帧可见左右差异。1 路、4 路共 216 帧哈希一致，24 个取样帧独立重渲一致。 `验证证据/墨滴烟尘粒子/comparison.json` | [`particles`](../funtech-fx-ab/shots/effects.js) |
| 高 · 拖抹笔刷 useBrush | 用反馈纹理保留笔迹，按指针轨迹着色，可设置拖抹、衰减、纹理和位移图 | 北冥 brush.js 强项是已知笔画的逐笔揭示。反馈笔刷适合油墨被拖走、渐散的轨迹 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 97.8%。 `验证证据/着色器图谱/useBrush.png` | [`brush`](shots/cases.json) |
| 中 · 波前 useWave | 进度、圆心、宽度和强度控制圆形、水平或垂直波前 | 北冥有时间轴与叠层。可加无累计状态的屏幕空间波前，用于 C 的转场与冲击信号 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 100.0%。 `验证证据/着色器图谱/useWave.png` | [`wave-radial`](shots/cases.json)、[`wave-horizontal`](shots/cases.json)、[`wave-vertical`](shots/cases.json) |
| 中 · 动态扭曲 useWobble3D / useCreateWobble3D | 结合位置和时间噪声改变网格顶点，可配合材质着色 | 北冥可通过 shade/patch 改顶点和对应深度着色。适合抽象模型或能量形变 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 59.1%。 `验证证据/着色器图谱/useWobble3D.png` | [`wobble`](shots/cases.json) |
| 中 · 简易模糊 useSimpleBlur | 对输入纹理产生可调模糊，暴露尺寸和强度 | 北冥 Bloom 已有金字塔式光晕，但模糊输入与发光用途不同 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 87.5%。 `验证证据/着色器图谱/useSimpleBlur.png` | [`blur`](shots/cases.json) |
| 中 · 反馈拖影 useMotionBlur | 把当前帧和偏移的上一帧纹理混合，呈现可调残影 | 北冥 A 路线手册把运动模糊标为未实现。上游的观感适合拖影，物理快门效果可用子帧积分另行对照 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 90.9%。 `验证证据/着色器图谱/useMotionBlur.png` | [`trail`](shots/cases.json) |
| 中 · 色键 useChromaKey | 按目标色抠像，提供边缘平滑和溢色处理 | 北冥现有 cutoutPlane 适合已有 alpha 的贴图。色键可补输入素材仅有绿幕颜色的场景 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 78.4%。 `验证证据/着色器图谱/useChromaKey.png` | [`chroma`](shots/cases.json) |
| 中 · 噪声 useNoise | 多 octave 噪声、FBM、域扭曲和时间控制 | 北冥已有 HASH_NOISE、纸纹及墨线扰动，可借域扭曲生成不同频段的云和水纹 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 91.5%。 `验证证据/着色器图谱/useNoise.png` | [`noise`](shots/cases.json) |
| 中 · 大理石 useMarble | 多次扰动迭代生成流纹，可调复杂度和动画成分 | 北冥有 surface.js 的地表材质补丁和造型配色。可作为矿石、水墨转场的单独纹理 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 99.7%。 `验证证据/着色器图谱/useMarble.png` | [`marble`](shots/cases.json) |
| 中 · 层纹 useColorStrata | 可调层数、层间隔、厚薄细节和扭曲 | 北冥 surface.js 已有层理，可借滤镜式层纹用于动态切片和抽象片头 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 100.0%。 `验证证据/着色器图谱/useColorStrata.png` | [`strata`](shots/cases.json) |
| 中 · 余弦色表 useCosPalette | 四组参数映射纹理权重，用于周期性的连续配色 | 北冥有 grade 调色及锁定色板。可在 C 独立资产试配色，A 的画风锁仍是验收基准 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 100.0%。 `验证证据/着色器图谱/useCosPalette.png` | [`palette`](shots/cases.json) |
| useDuoTone | 亮度映射到双色 | 北冥有色板与调色。用灰阶斜坡检查暗亮端、中性色和溢出 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 99.7%。 `验证证据/着色器图谱/useDuoTone.png` | [`duotone`](shots/cases.json) |
| useHSV | 按纹理调亮度、饱和度 | 北冥有 grade。用肤色与高饱和色块查黄色偏移、超色域和通道裁切 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 100.0%。 `验证证据/着色器图谱/useHSV.png` | [`hsv`](shots/cases.json) |
| useBrightnessPicker | 可配置明度权重和阈值 | 北冥 Bloom 有亮区提取。单独比较阈值、过渡软硬和 sRGB / 线性域 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 98.7%。 `验证证据/着色器图谱/useBrightnessPicker.png` | [`brightness`](shots/cases.json) |
| useAlphaBlending | 用第二张贴图控制 alpha 合成 | 北冥 plate / layers 有透明图层。用半透明边缘检查预乘和黑边 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 70.4%。 `验证证据/着色器图谱/useAlphaBlending.png` | [`alpha`](shots/cases.json) |
| useBlending | 按明度选区与遮罩混合纹理 | 北冥 compositor 有分层合成。用软遮罩、独立 alpha 图和高亮输入测输出 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 99.8%。 `验证证据/着色器图谱/useBlending.png` | [`blend`](shots/cases.json) |
| useFxBlending | 取 FX 纹理做叠层，封装混合 | 北冥 createFullscreen 可逐 pass 合成。用两个透明特效检查层序和相同颜色域 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 86.7%。 `验证证据/着色器图谱/useFxBlending.png` | [`displace`](shots/cases.json) |
| useFxTexture | 两纹理、位移图和过渡进度 | 北冥已有裁切与底板定位。可做转场镜头，检查起止帧原图还原及边缘透明度 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 100.0%。 `验证证据/着色器图谱/useFxTexture.png` | [`transition`](shots/cases.json) |
| useCoverTexture | 按画面宽高比裁切覆盖 | 北冥已有 fillScreen、cropPlate 和 CSS object-fit。试横、竖、方三种图的裁切锚点 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 89.4%。 `验证证据/着色器图谱/useCoverTexture.png` | [`cover`](shots/cases.json) |
| useBlank | 带纹理与节拍输入的空白 shader 模板 | 北冥新 pass 可用 createFullscreen。比自定义 uniform、可复现输入和释放成本 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 98.8%。 `验证证据/着色器图谱/useBlank.png` | [`blank`](shots/cases.json) |
| useRawBlank | 提供原始着色器版本的空白 pass | 北冥已有 ShaderMaterial 的全屏入口。只有必须控制 shader 声明时再对照 raw 路径 | A/B 渲染。同一测试纹理或几何送入上游 Hook，Chromium 实际产生输出。差异像素占比 100.0%。 `验证证据/着色器图谱/useRawBlank.png` | [`raw-blank`](shots/cases.json) |
| useSingleFBO | 单渲染目标输出 | 北冥 renderTarget 已具备。查 resize 后格式、深度与颜色域 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useDoubleFBO | 交换读、写 FBO | 北冥全屏工具可组合双缓冲。固定初始状态，验积分、重置和快照恢复 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useResolution | 按窗口和 DPR 更新分辨率 | 北冥 stage/film 有设计尺寸与输出尺寸。分别测成片固定档和作品站窗口变化 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useResizeBoundary | 达到尺寸条件后更新 | 北冥自适应画质有 ResizeObserver 与判档。测连续拖窗时重建次数与像素对齐 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useAddMesh | 组件周期管理 Mesh 挂载 | 北冥场景可显式 add/remove。回归挂载卸载、材质与几何释放 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useCamera | 为效果创建合适的相机 | 北冥 pass 自带正交相机，舞台另有屏幕投影工具。测像素坐标往返 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useParams | 管理效果参数 | 北冥 lookParams 和预设锁可承担。测部分覆盖字段与相邻镜头之间的复位 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| setUniforms | 统一设置效果 uniform | 北冥材质复用时由镜头逐帧写完整状态。复核乱序不漏掉上次设值 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useCopyTexture | 复制纹理供后续处理 | 北冥有 plateCopy 和全屏拷贝能力。检查浅拷贝与独立 GPU 像素复制的差异 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| usePointer | 计算指针位置差与速度 | 作品站可用 Pointer Events。成片用 film.json 事件或录制后固定的整数帧轨迹 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useBeat | 以 BPM 等参数驱动效果 | 北冥已有节拍表、整数帧时钟和音画对位检查。用固定 120 BPM 比对拍点 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useFPSLimiter | 限制实时更新频率 | 北冥作品站按设备与帧时动态调画质。对照掉帧、能耗和可感知延迟 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| useDomSyncer | DOM 矩形、可见性与 WebGL 元素同步 | 北冥已有滚动与投影的基础，单卡片同步可与 Scroll-Sync 合并实验 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | [`scroll`](shots/cases.json)、[`layout`](shots/cases.json) |
| Easings | 时间进度映射 | 北冥已有基础 easing、分段时钟和样条。对照端点和逐帧采样 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |
| Utils / ShaderChunk | 通用数学与可复用 GLSL 片段 | 北冥已有 core/math 和 look/glsl。按被采用的函数验证域、精度和源码出处 | 功能实测。在实际 R3F 场景调用上游工具，检查返回值或目标状态。 `验证证据/着色器图谱/工具功能结果.json` | — |

## blankcanvas

[db9d160c1e74190397374ec3b2f30a1626c89f58](https://github.com/FunTechInc/blankcanvas/tree/db9d160c1e74190397374ec3b2f30a1626c89f58)

[上游画布入口](https://github.com/FunTechInc/blankcanvas/blob/db9d160c1e74190397374ec3b2f30a1626c89f58/app/BlankCanvas/index.tsx) · [视频纹理](https://github.com/FunTechInc/blankcanvas/blob/db9d160c1e74190397374ec3b2f30a1626c89f58/app/BlankCanvas/hooks/useVideoTexture.ts) · [北冥静帧命令](../../engine/render/README.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 按需 · Shader 实验模板 | Next.js / R3F 组织 Scene、Material 和示例 useBrush | 北冥已有 lab 和 A 路线模版。比新增一个 pass 需编辑的文件、构建依赖和是否可由出片工具直接读取 | 运行观察。原项目在 localhost 启动，浏览器发现可见 Canvas 并输入鼠标。 `验证证据/上游浏览器预览/blankcanvas-next/browser.json` | [`blank`](shots/cases.json) |
| 按需 · Worker 与回退 | 同一个 Scene 可在 Worker 或主线程挂载 | 北冥舞台现在有海报回退。若遇到真实掉帧，比较主线程、Worker、海报三条路径的交互延迟和首帧时间 | 功能实测。同一相关 OffscreenCanvas 机制验证真实 Worker 与强制不支持的主线程回退。 `验证证据/Worker画布/Worker结果.json` | — |
| 按需 · DPR、调参和面板 | PerformanceMonitor、r3f-perf 和 GUI 辅助调试 | 北冥已有 debug 与画质档，可比较动态分辨率切换次数、峰值 GPU 和长任务 | 运行观察。原项目在 localhost 启动，浏览器发现可见 Canvas 并输入鼠标。 `验证证据/上游浏览器预览/blankcanvas-next/browser.json` | [`layout`](shots/cases.json) |
| 按需 · 单帧 PNG 下载 | 从浏览器画布导出 PNG | 北冥已有 still 命令和哈希记录。用同一时刻对照用户快速保存与可复查生产输出 | 功能实测。直接调用仓库 Hook，验证真实视频播放、加载计数、模拟播放拒绝和 PNG 文件头。 `验证证据/Blankcanvas工具/工具结果.json` | — |
| 按需 · 视频纹理就绪 | 视频就绪计数及低功耗模式回退 | 北冥作品站已有海报与视频加载。做低功耗测试时对照真实首帧、离开视口恢复和海报连续性 | 功能实测。直接调用仓库 Hook，验证真实视频播放、加载计数、模拟播放拒绝和 PNG 文件头。 `验证证据/Blankcanvas工具/工具结果.json` | [`video-plane`](shots/cases.json) |

## 3Dcam-scroll

[1e6a7a76fd807c8d9aabdc7fa267c745ea284988](https://github.com/FunTechInc/3Dcam-scroll/tree/1e6a7a76fd807c8d9aabdc7fa267c745ea284988)

[上游相机示例](https://github.com/FunTechInc/3Dcam-scroll/blob/1e6a7a76fd807c8d9aabdc7fa267c745ea284988/js/maincanvas.js) · [北冥相机函数](../../engine/stage/camera.js#L24)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 视频贴图平面 | VideoTexture 给 PlaneGeometry，视频循环 | 北冥 A 有二维底板和相机投影。用本地视频做同机位静态底板与视频平面对照；成片导入时按帧定位解码 | 运行观察。原始 Vite 工程运行，视频进入可解码状态并播放。保存了画布截图，GUI 参数未逐一量化。 `验证证据/上游浏览器预览/3Dcam-scroll/browser.json` | [`video-plane`](shots/cases.json) |
| 相机调参 | Tweakpane 调 XYZ、旋转和 lookAt | 北冥有 aimCamera、project 和 lab。可借可视化调参，最终值回写镜头配置 | 运行观察。原始 Vite 工程运行，视频进入可解码状态并播放。保存了画布截图，GUI 参数未逐一量化。 `验证证据/上游浏览器预览/3Dcam-scroll/browser.json` | [`video-plane`](shots/cases.json) |
| 渲染循环与尺寸更新 | RAF 更新画面，窗口变化触发 renderer 更新 | 北冥已有舞台循环和 ResizeObserver。入口源码主要体现相机 GUI，未把仓库名当作已验证滚动绑定 | 运行观察。原始 Vite 工程运行，视频进入可解码状态并播放。保存了画布截图，GUI 参数未逐一量化。 `验证证据/上游浏览器预览/3Dcam-scroll/browser.json` | [`layout`](shots/cases.json) |

## mouse-effects-ogl-glsl

[6a8ab7468b83fc3d85103f7b0d5ce5d5405eaf15](https://github.com/FunTechInc/mouse-effects-ogl-glsl/tree/6a8ab7468b83fc3d85103f7b0d5ce5d5405eaf15)

[上游 flowmap](https://github.com/FunTechInc/mouse-effects-ogl-glsl/blob/6a8ab7468b83fc3d85103f7b0d5ce5d5405eaf15/js/letFlowmap.js) · [UV 合成 shader](https://github.com/FunTechInc/mouse-effects-ogl-glsl/blob/6a8ab7468b83fc3d85103f7b0d5ce5d5405eaf15/js/glsl/main.frag) · [北冥画质与回退](../../site/CONTRACT.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 中 · 轨迹流向 | ping-pong flowmap 把鼠标位置、速度和衰减写入上一帧状态 | 用北冥 renderTarget 管理读写。相同轨迹比较无尾迹和含衰减尾迹，记录消失帧 | A/B 渲染。将原始 flowmap 片元送入北冥双缓冲。未注入时左右逐像素相同，拖动后差异出现并随尾迹衰减。 `验证证据/作品站/流向像素变化.json` | [`flow`](shots/cases.json) |
| 中 · UV 位移 | 由流向向量偏移底图采样坐标 | 用北冥 fullscreen pass 接一张作品缩略图。验静止时零位移，快速拖动时无边缘穿帮 | A/B 渲染。将原始 flowmap 片元送入北冥双缓冲。未注入时左右逐像素相同，拖动后差异出现并随尾迹衰减。 `验证证据/作品站/流向像素变化.json` | [`flow`](shots/cases.json) |
| 中 · 噪声及局部光感 | 底图叠纹理噪声与交互高光 | 对照同一图片的无高光、仅位移和位移加高光，检验可读性 | 运行观察。原项目的纹理已复制到临时产物后成功展示，留存拖动前后。 `验证证据/上游浏览器预览/mouse-effects-ogl-glsl-retry/browser.json` | [`flow-light`](shots/cases.json) |
| 按需 · 半浮点与过滤策略 | WebGL 版本与扩展决定浮点目标和采样过滤 | 北冥舞台已有 GPU 探测与静态海报回退。用桌面和手机各验一组 | 部分实测。本机运行以半浮点缓冲渲染。移动端扩展和过滤回退尚未单独覆盖。 `验证证据/作品站/作品站运行结果.json` | — |

## Funkun

[a6e3444baeb8fddfa7cffa645992aaa42f1b8635](https://github.com/FunTechInc/Funkun/tree/a6e3444baeb8fddfa7cffa645992aaa42f1b8635)

[上游 Canvas](https://github.com/FunTechInc/Funkun/blob/a6e3444baeb8fddfa7cffa645992aaa42f1b8635/app/Canvas/index.tsx) · [上游 shader 入口](https://github.com/FunTechInc/Funkun/blob/a6e3444baeb8fddfa7cffa645992aaa42f1b8635/app/Canvas/Shader.tsx)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 最小 Canvas | R3F 建 Canvas 并限制 DPR 到 1–1.5 | 北冥已有实时质量档。可比较静态 DPR 上限和自适应的画质、耗电及帧时 | 运行观察。临时检出补上 Three 类型后构建成功，浏览器绘制原始页面的 shader Canvas。 `验证证据/上游浏览器预览/Funkun-next/browser.json` | [`layout`](shots/cases.json) |
| RawShaderMaterial | 平面 shader 由累计时间 uniform 更新 | 北冥全屏 pass 可做同类效果。用显式帧时间替换累计更新，验暂停和跳帧 | 运行观察。临时检出补上 Three 类型后构建成功，浏览器绘制原始页面的 shader Canvas。 `验证证据/上游浏览器预览/Funkun-next/browser.json` | [`raw-blank`](shots/cases.json) |
| 作图用途 | 源码入口体现平面 shader 小样 | 角色 GLB 的动作与表情以 character-model 实际文件为依据 | 资料核对。该行是项目用途归类。角色包的动作、表情与画面证据记录在 character-model。 `验证证据/角色资产/角色资产运行结果.json` | — |

## sauce-WP

[空归档](https://github.com/FunTechInc/sauce-WP)

[空归档仓库](https://github.com/FunTechInc/sauce-WP) · [WordPress 模板](https://github.com/FunTechInc/sauce.wp)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 空归档 | GitHub 标记归档，内容 API 返回空仓库 | 没有独立可复现功能。同名容易混淆，可运行模板见 sauce.wp | 资料核对。组织 API 标记为空归档，无可检出运行的代码。 `执行/仓库检出.json` | — |

## mekuri-demo-pages

[411d2c8481ac94519440244766efb5fb882ea4da](https://github.com/FunTechInc/mekuri-demo-pages/tree/411d2c8481ac94519440244766efb5fb882ea4da)

[上游示例仓库](https://github.com/FunTechInc/mekuri-demo-pages) · [在线示例](https://mekuri-demo-pages.vercel.app/) · [依赖配置](https://github.com/FunTechInc/mekuri-demo-pages/blob/411d2c8481ac94519440244766efb5fb882ea4da/package.json)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| Pages Router 集成样例 | Next.js Pages Router 与 mekuri、GSAP 一起运行 | 给北冥做跨页试验时可用同一路径演示 A/B，比较硬刷新与前端路由交接 | 功能实测。临时检出改用公开镜像下载相同锁定 GSAP 包，启动真实 Pages Router 从首页到 sample 再返回。 `验证证据/上游浏览器预览/mekuri-demo-pages-next/browser.json` | [`route-wait`](shots/cases.json)、[`route-sync`](shots/cases.json) |
| 可访问的真实导航样例 | 已部署示例把库行为放进真实页面 | 可用于观察快速连点、返回恢复和动画取消。北冥有静态站浏览及作品播放流程作为基线 | 功能实测。临时检出改用公开镜像下载相同锁定 GSAP 包，启动真实 Pages Router 从首页到 sample 再返回。 `验证证据/上游浏览器预览/mekuri-demo-pages-next/browser.json` | [`route-restore`](shots/cases.json) |

## sauce.wp

[3020211de054a4d3fc4cf144b9fc928c9b8bda57](https://github.com/FunTechInc/sauce.wp/tree/3020211de054a4d3fc4cf144b9fc928c9b8bda57)

[上游 README](https://github.com/FunTechInc/sauce.wp) · [北冥站点 CI](../../site/CONTRACT.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| WordPress 本地开发 | wp-env 和 Docker 启动本地环境 | 北冥已有静态站和本地出片服务。仅在作品站要 WordPress 编辑体验时比较启动复杂度 | 离线夹具。WordPress 6.8 / PHP 8.3 中激活主题，首页、样例与表单页均返回 200。原始 Docker wp-env 使用的虚拟机镜像未下载完成。 `验证证据/WordPress/运行结果.json` | — |
| 构建上传 | build 输出 dist，文档描述服务器上传 | 与北冥静态 build 和站点 CI 做发布路径对照，关注内容来源和回滚 | 构建通过。npm ci 后 Vite 生产构建通过，输出 dist。部署上传未发起。 `验证证据/仓库运行/sauce.wp.log` | — |
| CMS 模板 | 用于制作 WordPress 站点 | 对 WebGL 出片、GLB 和确定性无新增能力 | 离线夹具。WordPress 6.8 / PHP 8.3 中激活主题，首页、样例与表单页均返回 200。原始 Docker wp-env 使用的虚拟机镜像未下载完成。 `验证证据/WordPress/运行结果.json` | — |

## use-shader-fx2

[d196a0c1efef8713b3c3a41d483df345baf19ecb](https://github.com/FunTechInc/use-shader-fx2/tree/d196a0c1efef8713b3c3a41d483df345baf19ecb)

[旧 fork 导出](https://github.com/FunTechInc/use-shader-fx2/blob/d196a0c1efef8713b3c3a41d483df345baf19ecb/packages/use-shader-fx/src/index.js) · [旧 fork 依赖](https://github.com/FunTechInc/use-shader-fx2/blob/d196a0c1efef8713b3c3a41d483df345baf19ecb/package.json)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 水波、流体、拖抹与着色器效果 | 导出表包含 useRipple、useFluid、useBrush，以及主仓库对应的噪声、混合、色键、模糊和 3D Hook | 主仓库已逐项对照。这个旧 fork 可当版本回归参考，同功能不另造第二个样片 | A/B 渲染。旧 fork 的 23 个 Hook 输出已实际渲染，流体和波纹使用其旧字段名。缺少的新导出记录在旧版源码。 `验证证据/旧版着色器/像素对照.json` | [`rain`](../rain-ripple-ab/shots/rain.js)、[`ink`](../funtech-fx-ab/shots/effects.js)、[`smoke`](../funtech-fx-ab/shots/effects.js)、[`brush`](shots/cases.json)、[`wobble`](shots/cases.json) |
| 导出差异 | Fluid 与 Ripple 在 interactions 路径，导出表缺主仓后来的 Blank、RawBlank 与 ResizeBoundary 条目 | 比较移植时用到的 API 和 GLSL，确定来源提交与行为一致性 | A/B 渲染。旧 fork 的 23 个 Hook 输出已实际渲染，流体和波纹使用其旧字段名。缺少的新导出记录在旧版源码。 `验证证据/旧版着色器/像素对照.json` | — |
| 依赖与构建 | 旧版配置使用 Three r155 范围、R3F 8 和 Storybook | 北冥锁定 Three r170。移植关键 shader 时按现有版本直接编译测试 | 构建通过。锁文件安装并构建通过，仍保留 fork 原始依赖。 `验证证据/仓库运行/use-shader-fx2-retry.log` | — |

## react-three-offscreen

[076a8f63b864f0f075c3bdf9520481096d8d5184](https://github.com/FunTechInc/react-three-offscreen/tree/076a8f63b864f0f075c3bdf9520481096d8d5184)

[FunTech fork](https://github.com/FunTechInc/react-three-offscreen) · [Canvas 实现](https://github.com/FunTechInc/react-three-offscreen/blob/076a8f63b864f0f075c3bdf9520481096d8d5184/src/Canvas.tsx) · [Worker 端](https://github.com/FunTechInc/react-three-offscreen/blob/076a8f63b864f0f075c3bdf9520481096d8d5184/src/render.ts) · [北冥站点 Stage API](../../site/CONTRACT.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| Worker 画布转移 | OffscreenCanvas 转移到 Worker，R3F 在 Worker 挂载 | 北冥视频已有多浏览器分段，网页舞台另有主线程压力。只有后者因主线程争用掉帧时才测 Worker 收益 | 功能实测。直接编译 fork Canvas 和 Worker 源码。两条路径都收到指针事件，并在模拟 2× DPR 和改屏幕尺寸后更新渲染尺寸。 `验证证据/Worker画布/Worker结果.json` | [`worker`](../funtech-platform-ab/shots/worker.js) |
| 指针转发 | 主线程转发事件和坐标，Worker 以兼容层接收 | 同设备测试触屏、滚轮、拖动、指针离开与画布坐标映射 | 功能实测。直接编译 fork Canvas 和 Worker 源码。两条路径都收到指针事件，并在模拟 2× DPR 和改屏幕尺寸后更新渲染尺寸。 `验证证据/Worker画布/Worker结果.json` | [`worker`](../funtech-platform-ab/shots/worker.js) |
| 尺寸与像素比同步 | Worker 接收尺寸、偏移和 DPR，环境由兼容层补齐 | 北冥 stage 已有 resize 和质量档。对照旋转设备、跨屏以及调整像素比时的分辨率一致性 | 功能实测。直接编译 fork Canvas 和 Worker 源码。两条路径都收到指针事件，并在模拟 2× DPR 和改屏幕尺寸后更新渲染尺寸。 `验证证据/Worker画布/Worker结果.json` | [`worker`](../funtech-platform-ab/shots/worker.js) |
| 宿主兼容与回退 | 不支持转移时渲主线程 Scene | 北冥已有静态海报。验证事件丢失、中断恢复，以及只显示海报时页面仍可用 | 功能实测。直接编译 fork Canvas 和 Worker 源码。两条路径都收到指针事件，并在模拟 2× DPR 和改屏幕尺寸后更新渲染尺寸。 `验证证据/Worker画布/Worker结果.json` | [`worker`](../funtech-platform-ab/shots/worker.js) |

## handshake

[5b3bbe0367ff6bdb5a10bd6e38fee5d4b8fa3522](https://github.com/FunTechInc/handshake/tree/5b3bbe0367ff6bdb5a10bd6e38fee5d4b8fa3522)

[上游 API 与 MIT 许可](https://github.com/FunTechInc/handshake)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 父页面创建 iframe | Parent 指定容器与加载 URL | 北冥目前作品站以本页舞台和视频为主。嵌入预览需要一个明确的加载、失败和卸载流程 | 功能实测。使用仓库构建产物创建 iframe 并等待就绪，三个方向往返输入全部相等。 `验证证据/作品站/作品站运行结果.json` | [`embed`](shots/cases.json) |
| Promise 就绪 | 父子双方通过 ready 取得对象和通信接口 | 对照独立加载与握手后发首个播放请求，测试先后加载顺序和 iframe 刷新 | 功能实测。使用仓库构建产物创建 iframe 并等待就绪，三个方向往返输入全部相等。 `验证证据/作品站/作品站运行结果.json` | [`embed`](shots/cases.json) |
| 双向 on / emit | postMessage 封装事件订阅和发送 | 可传播放、暂停、时间、尺寸和渲染就绪。嵌入时用明确 origin 和消息结构对照正确、过期与无效消息 | 功能实测。使用仓库构建产物创建 iframe 并等待就绪，三个方向往返输入全部相等。 `验证证据/作品站/作品站运行结果.json` | [`embed`](shots/cases.json) |

## code-component

[3d9f41126a7e667a58c010033eeaca8900539e7a](https://github.com/FunTechInc/code-component/tree/3d9f41126a7e667a58c010033eeaca8900539e7a)

[上游组件源码](https://github.com/FunTechInc/code-component/blob/3d9f41126a7e667a58c010033eeaca8900539e7a/src/App.tsx)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| Studio 自定义组件承载 | iframe 内的 R3F Canvas 作为可嵌入效果 | 北冥舞台通常在页面内。适合为案例展示提供独立嵌入版，可对照页面内组件与 iframe 的初始开销 | 运行观察。原项目构建并在 localhost 显示 Canvas。Studio 宿主环境未接入。 `验证证据/上游浏览器预览/code-component/browser.json` | [`embed`](shots/cases.json) |
| 从宿主接收滚动 | subscribe scroll 消息，把外部数值变为 shader progress | 用北冥站内滚动直连作为基线。对照从宿主发送的 0、0.5、1 与内部 uniform 的到达帧 | 功能实测。网页夹具使用上游 Handshake，宿主发送 0、0.5、1，iframe 显示进度并回传相同值。 `验证证据/作品站/作品站运行结果.json` | [`embed`](shots/cases.json) |
| 插值与纹理呈现 | 用 lerp 平滑进度，通过 shader 显示图片 | 北冥已有 GSAP 插值与定位。测反馈延迟、快速来回滚动和停下后的最终状态 | 部分实测。原项目记录了 Canvas 运行；iframe 夹具断言消息到达。图形插值曲线未单独量化。 `验证证据/上游浏览器预览/code-component/browser.json` | [`embed`](shots/cases.json) |

## React-WebGL-Scroll-Sync

[e8f72f3ed5257765b286c60c0cce7f3400df22db](https://github.com/FunTechInc/React-WebGL-Scroll-Sync/tree/e8f72f3ed5257765b286c60c0cce7f3400df22db)

[上游画布实现](https://github.com/FunTechInc/React-WebGL-Scroll-Sync/blob/e8f72f3ed5257765b286c60c0cce7f3400df22db/src/components/WebGLCanvas.tsx) · [上游噪声片元](https://github.com/FunTechInc/React-WebGL-Scroll-Sync/blob/e8f72f3ed5257765b286c60c0cce7f3400df22db/src/shaders/img.frag) · [北冥作品站舞台](../../site/CONTRACT.md) · [作品列表实现](../../site/js/works.js#L448)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 高 · 单画布对齐多张 DOM 图片 | 读取 DOM 矩形，换算为覆盖相同区域的 WebGL 平面 | 北冥 stage 固定在首屏与引擎篇章，作品卡片由 DOM 负责。对照原卡片与共享画布覆盖，记录卡片四角偏差 | A/B 渲染。原项目浏览器试跑通过。北冥 DOM / GPU 夹具完成两种视口、四档滚动，共 8 组；矩形取整误差不超过 0.5 px。 `验证证据/作品站/作品站运行结果.json` | [`scroll`](shots/cases.json) |
| 高 · 同步滚动偏移 | 同一 scroll offset 更新 canvas wrapper 位移和 shader uniform | 北冥已有 ScrollTrigger 和滚动测量。用同一组快速滚动、位置跳转和回到顶部的操作测错位与迟滞 | A/B 渲染。原项目浏览器试跑通过。北冥 DOM / GPU 夹具完成两种视口、四档滚动，共 8 组；矩形取整误差不超过 0.5 px。 `验证证据/作品站/作品站运行结果.json` | [`scroll`](shots/cases.json) |
| 高 · 可视范围裁切 | 根据矩形和画布范围暂停离屏平面的显示 | 作品站已有视频可视性管理。对照多卡片快速滚动时可见对象数、GPU 渲染调用数和回视口的首帧 | A/B 渲染。原项目浏览器试跑通过。北冥 DOM / GPU 夹具完成两种视口、四档滚动，共 8 组；矩形取整误差不超过 0.5 px。 `验证证据/作品站/作品站运行结果.json` | [`visibility`](shots/cases.json) |
| 中 · 共享噪声纹理 | 场景计算 useNoise 输出，多个平面从共享纹理取样 | 北冥可用相同 pass 生成一次纹理。用原图对照噪声覆盖或显影，分开测移动端缩放与 reduced motion | A/B 渲染。原项目浏览器试跑通过。北冥 DOM / GPU 夹具完成两种视口、四档滚动，共 8 组；矩形取整误差不超过 0.5 px。 `验证证据/作品站/作品站运行结果.json` | [`reveal`](shots/cases.json) |
| 中 · 布局重算 | 尺寸变化后重新量测矩形，参考稳定滚动容器的偏移 | 北冥有字体加载后的刷新。测 ResizeObserver、字体补载、页面 zoom 和不同 DPR | A/B 渲染。原项目浏览器试跑通过。北冥 DOM / GPU 夹具完成两种视口、四档滚动，共 8 组；矩形取整误差不超过 0.5 px。 `验证证据/作品站/作品站运行结果.json` | [`layout`](shots/cases.json) |

## React-WebGL-Starter

[fb7c2d1fdcdd237b364ff77f9f35a39ac32b3950](https://github.com/FunTechInc/React-WebGL-Starter/tree/fb7c2d1fdcdd237b364ff77f9f35a39ac32b3950)

[上游实际 WebGPU 源码](https://github.com/FunTechInc/React-WebGL-Starter/blob/fb7c2d1fdcdd237b364ff77f9f35a39ac32b3950/src/App.tsx) · [北冥渲染器契约](../../engine/render/README.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| WebGPU 启动 | Canvas 接入异步 init 的 WebGPURenderer | 北冥 A、C 正在使用 WebGL2；B 是另外的原生后端。可对照一个小场景的设备覆盖、首帧和出片契约 | 运行观察。原始 Vite 工程实际跑起。Chromium 获得 WebGPU 适配器，保存 TSL 立方体及拖动后截图。 `验证证据/上游浏览器预览/React-WebGL-Starter/browser.json` | [`webgpu-tsl`](../funtech-platform-ab/main.js) |
| TSL 材质 | MeshStandardNodeMaterial 使用 TSL 表达材质 | 北冥现有 ShaderMaterial 与 shader patch。对照同一色阶材质的维护性、GPU 编译和图像输出 | 运行观察。原始 Vite 工程实际跑起。Chromium 获得 WebGPU 适配器，保存 TSL 立方体及拖动后截图。 `验证证据/上游浏览器预览/React-WebGL-Starter/browser.json` | [`webgpu-tsl`](../funtech-platform-ab/main.js) |
| 可交互立方体 | Box 网格配 OrbitControls | 小样可用于设备冒烟。保留同机位的 WebGL 对照，检查上下文失败与保底表现 | 运行观察。原始 Vite 工程实际跑起。Chromium 获得 WebGPU 适配器，保存 TSL 立方体及拖动后截图。 `验证证据/上游浏览器预览/React-WebGL-Starter/browser.json` | [`webgpu-tsl`](../funtech-platform-ab/main.js) |

## hidden-sauce

[ee0c3ddffbc26ee87ecfb5592a367680fb12410b](https://github.com/FunTechInc/hidden-sauce/tree/ee0c3ddffbc26ee87ecfb5592a367680fb12410b)

[上游源码树](https://github.com/FunTechInc/hidden-sauce/tree/ee0c3ddffbc26ee87ecfb5592a367680fb12410b) · [样例路由](https://github.com/FunTechInc/hidden-sauce/tree/ee0c3ddffbc26ee87ecfb5592a367680fb12410b/app) · [北冥网站发布校验](../../site/CONTRACT.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 语言路由与切换 | app/[lang] 定义布局、页面和语言切换 | 如需中英作品站，可与两份独立静态站对比语言 URL、fallback 与路由可分享性 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/hidden-sauce-next/browser.json` | [`route-restore`](shots/cases.json) |
| CMS 归档 | 内容列表、分类、分页、详情页面 | 北冥由 cases/catalog 和策展数据生成列表。对比构建时生成与 CMS 编辑便利性 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/hidden-sauce-next/browser.json` | — |
| 草稿预览 | 样例含 draft 与 disable-draft 路由 | 北冥已有闸门、审片记录与本地预览。对比未公开材料的可见性和共享链接生命周期 | 离线夹具。合成 CMS 草稿实际重定向到预览页，带 noindex，退出后清除草稿状态。该夹具不用真实 CMS 账户。 `验证证据/上游浏览器预览/hidden-sauce-draft/draft.json` | — |
| 组件与样式 | 代码树含 Accordion、表单、Modal、Lenis、GSAP 初始化，配置含 Tailwind | 北冥有自己的站点 CSS 和动效。只借有明确重用价值的交互模式 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/hidden-sauce-next/browser.json` | [`accordion`](shots/cases.json)、[`modal`](shots/cases.json) |
| 组件说明方法 | 仓库附可访问性、设计令牌和组件结构参考 | 可借来补作品站组件验收。北冥路线、模板、制作闸门继续沿用已有文档体系 | 资料核对。说明文件已核对。这一行是组件文档的方法。 `执行/仓库检出.json` | — |
| sitemap 与 404 | 源码包含 Next.js sitemap 和 not-found | 北冥已有静态链接校验。如扩展更多案例详情页，可比较索引和失效 URL 的反馈 | 离线夹具。使用合成空 CMS 启动原始模板路由。ja / en、样例列表、站点地图与 404 实际返回预期状态。 `验证证据/上游浏览器预览/hidden-sauce-next/browser.json` | — |

## character-model

[2195aa6c8596a26ea072771529feb51236ffafda](https://github.com/FunTechInc/character-model/tree/2195aa6c8596a26ea072771529feb51236ffafda)

[上游资产规格与许可](https://github.com/FunTechInc/character-model#files) · [预览器代码](https://github.com/FunTechInc/character-model/blob/2195aa6c8596a26ea072771529feb51236ffafda/viewer/viewer.js) · [北冥回读](../../engine/native/bridge/browser.mjs#L112) · [北冥扩展校验](../../engine/native/bridge/validate.mjs#L60)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| 高 · 多动作交付 | 单个 GLB 内有 Idle、Dance、Run、Jump | 北冥已有 GLB 导出、AnimationMixer 回读和循环首尾检查。用北冥自有角色验证一包多动作、动作名和首尾一致 | A/B 渲染。标准版与网页版在 Three.js r170 中实际解码并并排绘制。两版包含同样的 4 个动作和 9 个表情。 `验证证据/角色资产/角色资产运行结果.json` | [`asset-clips`](shots/cases.json) |
| 高 · 表情切换 | 9 套脸屏材质以 KHR_materials_variants 切换 | 北冥桥接支持材质校验，但未在对照入口看到通用表情变体工作流。用自有角色的 2–3 件状态对照独立贴图与 GLB 变体 | A/B 渲染。标准版与网页版在 Three.js r170 中实际解码并并排绘制。两版包含同样的 4 个动作和 9 个表情。 `验证证据/角色资产/角色资产运行结果.json` | [`asset-faces`](shots/cases.json) |
| 高 · 标准与网页压缩 | 标准版 3,035,804 字节，网页版 718,872 字节。两版动作名、变体名全部一致 | **已读二进制头**。网页包小 76.3%，需要 Meshopt、WebP 与网格量化。北冥原生桥接拒绝任何必需扩展，保留标准包供原生验收，网页压缩包另走站点解码与验收 | A/B 渲染。标准版与网页版在 Three.js r170 中实际解码并并排绘制。两版包含同样的 4 个动作和 9 个表情。 `验证证据/角色资产/角色资产运行结果.json` | [`asset-lod`](shots/cases.json) |
| 中 · 高清交付 | README 列高清版本用于静帧和特写，文件约 25 MB | 北冥有不同输出档与模型 LOD。比较同一镜头远景、特写所需的几何密度、显存和加载成本。高清文件数值来自上游文档 | A/B 渲染。发行版 v1.0.0 的高清 GLB 已读取并与标准包同机位特写渲染。 `验证证据/角色资产/HD-close.png` | [`asset-lod`](shots/cases.json) |
| 高 · 可分享预览状态 | URL 保存动作、表情、背景和模型版本，可隐藏控制条 | 北冥作品站已有可浏览作品，当前样式面向影片。静态资产预览可比较旧流程与一键复现某动作、表情的链接 | 功能实测。本地预览用 URL 参数打开 Dance、heart 与 0.62 秒，实际跳到同一状态。 `验证证据/角色资产/shared-state.png` | — |
| 中 · 自适应相机 | 初次按模型和窗口尺寸取景，用户移动相机后保留操作意图 | 北冥有相机投影和画幅控制。用窄屏、宽屏和切换姿态检查完整轮廓与焦点 | 部分实测。实际以包围盒定标后绘制标准及高清模型，留存常规与近景。官方预览器自动取景交互只核对源码。 `验证证据/角色资产/HD-close.png` | [`asset-framing`](shots/cases.json) |
| 按需 · AR、下载与元数据 | model-viewer 提供 AR，预览页可下载并选模型版本。GLB 带许可元数据 | 北冥当前主要交付成片。展会确需 AR 时，先测自有模型、下载记录和许可信息。Funkun 模型标注 CC BY-NC 4.0 | 部分实测。GLB 包和许可元数据已核对，当前桌面环境缺实际 AR 设备。 `验证证据/Funkun GLB 结构对照.json` | — |

## fusen.md

[853954d9e377c41aa96574b038bb620232ec265b](https://github.com/FunTechInc/fusen.md/tree/853954d9e377c41aa96574b038bb620232ec265b)

[上游功能说明](https://github.com/FunTechInc/fusen.md) · [北冥制作与审片状态](../../AGENTS.md)

| 功能 | 上游源码行为 | 北冥对应 | 已记录的上游或既有实验结果 | 北冥视频 ID |
|---|---|---|---|---|
| Markdown 即时编辑 | 标题、清单、任务等直接显示为便签块 | 北冥审片说明是项目文件。可对照写短反馈的效率，项目文件保留版本与帧号依据 | 功能实测。用上游 Swift 测试验证编辑或历史读写。整套串行测试仍有 11 条外观相关断言失败。 `验证证据/仓库运行/fusen-test-serial.log` | [`note-edit`](shots/cases.json) |
| 便签历史与恢复 | 恢复旧版本或找回已关闭便签 | 北冥有 Git 和审片变更记录。按误操作场景比可恢复性和溯源精度 | 功能实测。用上游 Swift 测试验证编辑或历史读写。整套串行测试仍有 11 条外观相关断言失败。 `验证证据/仓库运行/fusen-test-serial.log` | — |
| 任务信号 | 标记等待、进行中并突出当前任务 | 北冥有制作与审片状态。可借状态可视化，比较是否能区分生产、技术检查和人工审片结论 | 部分实测。串行 Swift 测试已运行。任务信号、卡片颜色相关断言未全部通过，见 AppKit 外观差异日志。 `验证证据/仓库运行/fusen-test-serial.log` | — |
| 卡片分组 | 按项目组织便签，支持排列 | 北冥已有作品目录和案例分组。可用作制作桌面的短期组织 | 部分实测。串行 Swift 测试已运行。任务信号、卡片颜色相关断言未全部通过，见 AppKit 外观差异日志。 `验证证据/仓库运行/fusen-test-serial.log` | — |
| 置顶和快捷交互 | macOS 快捷键、暗色、半透明、置顶 | 可作为人工审片时记录帧号和问题的便签，但不会改变出片链 | 部分实测。本机 Swift 测试已完成。桌面全局快捷键与系统置顶状态未以用户配置实机验证。 `验证证据/仓库运行/fusen-test-serial.log` | — |
| Notion 单向备份 | 将便签向 Notion 数据库镜像 | 北冥已有本地和 NAS 产物归档。比较恢复流程，只有明确的资料同步需求才考虑接入 | 离线夹具。Swift 的 NotionSyncTests 使用测试替身跑通，多条停用、失败重试和备份行为有日志。真实 Notion 账号未连接。 `验证证据/仓库运行/fusen-test-serial.log` | — |
