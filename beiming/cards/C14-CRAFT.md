# C14 工艺五章的只读卡

工艺原文以仓库基线 `490e76d` 的行号定位。每项技术通过一个主版本卡号读取。C1 的数据入口只返回技术名和文献位置，状态为 `read`。同一技术在多章出现时合并出处。

| 章 | 含标记的行 | 字面出现次数 | 引用本章的工艺数 |
|---|---:|---:|---:|
| [toon.md](../../routes/directing/craft/toon.md) | 12 | 13 | 27 |
| [two-five-d.md](../../routes/directing/craft/two-five-d.md) | 20 | 22 | 28 |
| [animation.md](../../routes/directing/craft/animation.md) | 19 | 20 | 22 |
| [video.md](../../routes/directing/craft/video.md) | 20 | 21 | 36 |
| [threejs.md](../../routes/directing/craft/threejs.md) | 14 | 17 | 17 |

共 122 张卡。计数包含章内的术语说明、表头和重复提及。另核对 toon §8、animation §8、video §10、threejs §11 的逐条清单，以及 two-five-d §5 的失败模式与 §6 的迁移建议。原文中的历史状态保留。

五章开头的标注说明（toon、animation、video、threejs 第 6 行，two-five-d 第 7 行）只定义术语。toon 第 435 行、two-five-d 第 513 行及后三章的清单标题用于组织下列条目。two-five-d 第 396 行记录样片缺少海面广角镜头，归入作品个案。第六章声音和配套词表另有独立入口。

## 已有能力的对照

现行实现各有自己的执行范围和验收记录。查子帧模糊见 [blur.subframe](mechanism/blur-subframe/card.json)，查事件、切点和停格帧见 [time.events](time/events/card.json)、[time.cut-grid](time/cut-grid/card.json)、[time.timeline](time/timeline/card.json)。音轨移位见 [audio.align](audio/align/card.json)，两段刚体骨骼反解见 [rig.rigid-ik](motion/rig-rigid-ik/card.json)，飞入扣合余振见 [motion.snap](motion/snap/card.json)。画风锁的四个镜头预设见 [C14 画风卡](C14-STYLE-PRESETS.md)。

核对交付时，文字时长与安全区见[文字检查](../../tools/qa/checks/texts.mjs)，黑场、静帧和切点见[画面检查](../../tools/qa/checks/visual.mjs)，底板露边与纹素密度见[底板检查](../../tools/qa/checks/plates.mjs)，声画对位见[同步检查](../../tools/qa/checks/sync.mjs)，封装后响度见[交付检查](../../tools/qa/checks/delivery.mjs)，图像对照见[帧比较](../observe/compare.mjs)。

## toon

| 工艺 | 主版本卡号 | 原文行号 |
|---|---|---|
| 可配置的卡通色阶档数 | [`shading.craft-toon-bands@1`](shading/craft-toon-bands/card.json) | [465](../../routes/directing/craft/toon.md) |
| 阴影阈值贴图与顶点色偏移 | [`shading.craft-shadow-threshold@1`](shading/craft-shadow-threshold/card.json) | [108,466](../../routes/directing/craft/toon.md) |
| 面部法线编辑 | [`shading.craft-face-normals@1`](shading/craft-face-normals/card.json) | [108,467](../../routes/directing/craft/toon.md) |
| 从代理体传递法线 | [`shading.craft-normal-transfer@1`](shading/craft-normal-transfer/card.json) | [108,467](../../routes/directing/craft/toon.md) |
| 三维人脸卡通着色 | [`shading.craft-face-lighting@1`](shading/craft-face-lighting/card.json) | [467](../../routes/directing/craft/toon.md) |
| 基座材质的硬边高光 | [`shading.craft-hard-specular@1`](shading/craft-hard-specular/card.json) | [468](../../routes/directing/craft/toon.md) |
| 逐物体屏幕线色 | [`post.craft-object-ink-color@1`](post/craft-object-ink-color/card.json) | [158,469](../../routes/directing/craft/toon.md) |
| 正片法线折痕线 | [`post.craft-crease-ink@1`](post/craft-crease-ink/card.json) | [158,469](../../routes/directing/craft/toon.md) |
| 按受光方向与曲率调整线宽 | [`post.craft-ink-width@1`](post/craft-ink-width/card.json) | [158,469](../../routes/directing/craft/toon.md) |
| 材质线宽的分辨率标定 | [`shading.craft-ink-resolution@1`](shading/craft-ink-resolution/card.json) | [400,470](../../routes/directing/craft/toon.md) |
| 保护材质线免受笔触滤波抹除 | [`post.craft-ink-preservation@1`](post/craft-ink-preservation/card.json) | [400,470](../../routes/directing/craft/toon.md) |
| 随分辨率调整笔画搜索半径 | [`post.craft-stroke-radius@1`](post/craft-stroke-radius/card.json) | [401,471](../../routes/directing/craft/toon.md) |
| 按屏幕线密度简化远景线条 | [`post.craft-ink-density@1`](post/craft-ink-density/card.json) | [399,472](../../routes/directing/craft/toon.md) |
| 阴影相机按像素对齐 | [`lighting.craft-shadow-snap@1`](lighting/craft-shadow-snap/card.json) | [392,472](../../routes/directing/craft/toon.md) |
| 按对象分配墨线沸腾时钟 | [`post.craft-ink-cadence@1`](post/craft-ink-cadence/card.json) | [473](../../routes/directing/craft/toon.md) |
| 卡通局部光的方向与作用范围 | [`lighting.craft-toon-local@1`](lighting/craft-toon-local/card.json) | [80,474](../../routes/directing/craft/toon.md) |
| 剪影检查开关 | [`shading.craft-silhouette@1`](shading/craft-silhouette/card.json) | [475](../../routes/directing/craft/toon.md) |
| 灰度缩略图检查 | [`post.craft-gray-thumbnail@1`](post/craft-gray-thumbnail/card.json) | [475](../../routes/directing/craft/toon.md) |
| 按材质和光照登记色指定 | [`shading.craft-color-script@1`](shading/craft-color-script/card.json) | [194,476](../../routes/directing/craft/toon.md) |
| 灰模与纯反照率检查 | [`shading.craft-albedo-view@1`](shading/craft-albedo-view/card.json) | [70,476](../../routes/directing/craft/toon.md) |
| 画风校准场景 | [`shading.craft-style-calibration@1`](shading/craft-style-calibration/card.json) | [70,476](../../routes/directing/craft/toon.md) |
| 着色回归对照 | [`shading.craft-style-regression@1`](shading/craft-style-regression/card.json) | [476](../../routes/directing/craft/toon.md) |
| 按屏幕厚度限制边缘光宽度 | [`shading.craft-rim-width@1`](shading/craft-rim-width/card.json) | [395](../../routes/directing/craft/toon.md) |
| 通用背光透射 | [`shading.craft-back-transmission@1`](shading/craft-back-transmission/card.json) | [438](../../routes/directing/craft/toon.md) |
| 镜头渐变遮罩 | [`post.craft-gradient-mask@1`](post/craft-gradient-mask/card.json) | [439](../../routes/directing/craft/toon.md) |
| 从背景取色的三维剪影光包裹 | [`post.craft-plate-light-wrap@1`](post/craft-plate-light-wrap/card.json) | [440](../../routes/directing/craft/toon.md) |
| 底板的屏幕空间雾 | [`post.craft-plate-fog@1`](post/craft-plate-fog/card.json) | [441](../../routes/directing/craft/toon.md) |

## two-five-d

| 工艺 | 主版本卡号 | 原文行号 |
|---|---|---|
| 从背景取色的三维剪影光包裹 | [`post.craft-plate-light-wrap@1`](post/craft-plate-light-wrap/card.json) | [475](../../routes/directing/craft/two-five-d.md) |
| 深度图位移视差 | [`two-d.craft-depth-displace@1`](two-d/craft-depth-displace/card.json) | [21](../../routes/directing/craft/two-five-d.md) |
| 逐帧投影检查底板露边 | [`camera.craft-plate-bleed@1`](camera/craft-plate-bleed/card.json) | [160,515,675](../../routes/directing/craft/two-five-d.md) |
| 按镜头加载底板 | [`asset.craft-plate-stream@1`](asset/craft-plate-stream/card.json) | [240](../../routes/directing/craft/two-five-d.md) |
| 从底板元数据读取关键位置 | [`asset.craft-plate-landmarks@1`](asset/craft-plate-landmarks/card.json) | [332](../../routes/directing/craft/two-five-d.md) |
| 逐层记录底板规格与绘制要求 | [`asset.craft-plate-spec@1`](asset/craft-plate-spec/card.json) | [336,340](../../routes/directing/craft/two-five-d.md) |
| 相机运动的子帧模糊 | [`mechanism.craft-motion-blur@1`](mechanism/craft-motion-blur/card.json) | [421,520](../../routes/directing/craft/two-five-d.md) |
| 底板接收三维物体投影 | [`lighting.craft-plate-shadow@1`](lighting/craft-plate-shadow/card.json) | [474](../../routes/directing/craft/two-five-d.md) |
| 地面底板沿高度做透视压缩 | [`two-d.craft-ground-compression@1`](two-d/craft-ground-compression/card.json) | [494](../../routes/directing/craft/two-five-d.md) |
| 从起始机位投影贴图到代理几何 | [`two-d.craft-camera-projection@1`](two-d/craft-camera-projection/card.json) | [495](../../routes/directing/craft/two-five-d.md) |
| 纸纹锚定物体或世界坐标 | [`post.craft-paper-anchor@1`](post/craft-paper-anchor/card.json) | [501](../../routes/directing/craft/two-five-d.md) |
| 动态纸纹 | [`post.craft-dynamic-canvas@1`](post/craft-dynamic-canvas/card.json) | [501](../../routes/directing/craft/two-five-d.md) |
| 多平面镜头的景深 | [`camera.craft-depth-of-field@1`](camera/craft-depth-of-field/card.json) | [507](../../routes/directing/craft/two-five-d.md) |
| 多平面镜头的焦点转移 | [`camera.craft-focus-pull@1`](camera/craft-focus-pull/card.json) | [507](../../routes/directing/craft/two-five-d.md) |
| 条带端头遮挡与画外延长 | [`two-d.craft-strip-ends@1`](two-d/craft-strip-ends/card.json) | [515](../../routes/directing/craft/two-five-d.md) |
| 条带端头的横向羽化 | [`two-d.craft-strip-feather@1`](two-d/craft-strip-feather/card.json) | [515](../../routes/directing/craft/two-five-d.md) |
| 截断边外扩补画 | [`two-d.craft-plate-outpaint@1`](two-d/craft-plate-outpaint/card.json) | [515](../../routes/directing/craft/two-five-d.md) |
| 时间抗锯齿 | [`post.craft-temporal-aa@1`](post/craft-temporal-aa/card.json) | [520](../../routes/directing/craft/two-five-d.md) |
| 按分辨率调整纸纹尺度 | [`post.craft-paper-scale@1`](post/craft-paper-scale/card.json) | [523](../../routes/directing/craft/two-five-d.md) |
| 逐帧投影检查纹素密度 | [`asset.craft-texel-density@1`](asset/craft-texel-density/card.json) | [675](../../routes/directing/craft/two-five-d.md) |
| 平面底板的摇镜出血预算 | [`camera.craft-pan-budget@1`](camera/craft-pan-budget/card.json) | [516](../../routes/directing/craft/two-five-d.md) |
| 平铺接缝交叉过渡 | [`two-d.craft-seam-crossfade@1`](two-d/craft-seam-crossfade/card.json) | [517](../../routes/directing/craft/two-five-d.md) |
| 面片宽高比核验 | [`two-d.craft-plate-aspect@1`](two-d/craft-plate-aspect/card.json) | [518](../../routes/directing/craft/two-five-d.md) |
| 天空随相机旋转的视差 | [`camera.craft-sky-rotation@1`](camera/craft-sky-rotation/card.json) | [519](../../routes/directing/craft/two-five-d.md) |
| 底板纹素密度与目标图分辨率 | [`asset.craft-plate-resolution@1`](asset/craft-plate-resolution/card.json) | [521](../../routes/directing/craft/two-five-d.md) |
| 核验预乘透明度与雾及遮罩次序 | [`two-d.craft-alpha-fog-order@1`](two-d/craft-alpha-fog-order/card.json) | [522](../../routes/directing/craft/two-five-d.md) |
| 底板的雾与色调映射旁路 | [`shading.craft-plate-double-grade@1`](shading/craft-plate-double-grade/card.json) | [524](../../routes/directing/craft/two-five-d.md) |
| 按底板深度调节笔触 | [`post.craft-depth-brush@1`](post/craft-depth-brush/card.json) | [547](../../routes/directing/craft/two-five-d.md) |

## animation

| 工艺 | 主版本卡号 | 原文行号 |
|---|---|---|
| 按对象分配墨线沸腾时钟 | [`post.craft-ink-cadence@1`](post/craft-ink-cadence/card.json) | [145,563](../../routes/directing/craft/animation.md) |
| 相机运动的子帧模糊 | [`mechanism.craft-motion-blur@1`](mechanism/craft-motion-blur/card.json) | [171,564](../../routes/directing/craft/animation.md) |
| 动作节拍轨道与切换锚点 | [`motion.craft-cadence-anchor@1`](motion/craft-cadence-anchor/card.json) | [91,92,154,189,555,557](../../routes/directing/craft/animation.md) |
| 按角色尺度调整游动与眨眼周期 | [`motion.craft-giant-timing@1`](motion/craft-giant-timing/card.json) | [556](../../routes/directing/craft/animation.md) |
| 动作节拍网格与事件表 | [`time.craft-beat-grid@1`](time/craft-beat-grid/card.json) | [445,558](../../routes/directing/craft/animation.md) |
| 动作与镜头的单调关键帧插值 | [`motion.craft-monotone-keys@1`](motion/craft-monotone-keys/card.json) | [237,559](../../routes/directing/craft/animation.md) |
| 带过冲的回退缓动 | [`motion.craft-back-ease@1`](motion/craft-back-ease/card.json) | [255,560](../../routes/directing/craft/animation.md) |
| 阻尼弹簧缓动 | [`motion.craft-spring-ease@1`](motion/craft-spring-ease/card.json) | [255,560](../../routes/directing/craft/animation.md) |
| 扫视与眼神先行动作 | [`motion.craft-saccade@1`](motion/craft-saccade/card.json) | [303,311,561](../../routes/directing/craft/animation.md) |
| 眼睑跟随瞳孔 | [`motion.craft-lid-follow@1`](motion/craft-lid-follow/card.json) | [303,561](../../routes/directing/craft/animation.md) |
| 非周期眨眼 | [`motion.craft-blink-timing@1`](motion/craft-blink-timing/card.json) | [561](../../routes/directing/craft/animation.md) |
| 通用二维骨架 | [`two-d.craft-skeleton@1`](two-d/craft-skeleton/card.json) | [358,562](../../routes/directing/craft/animation.md) |
| 关键姿态替换与插值 | [`two-d.craft-pose-library@1`](two-d/craft-pose-library/card.json) | [358,562](../../routes/directing/craft/animation.md) |
| 按音素驱动口型 | [`motion.craft-phoneme-mouth@1`](motion/craft-phoneme-mouth/card.json) | [527,562](../../routes/directing/craft/animation.md) |
| 快速动作的拖影帧 | [`motion.craft-smear@1`](motion/craft-smear/card.json) | [171,564](../../routes/directing/craft/animation.md) |
| 核对成片声音与动作结果帧 | [`audio.craft-cue-alignment@1`](audio/craft-cue-alignment/card.json) | [497,565](../../routes/directing/craft/animation.md) |
| 检查拍内姿态跳变 | [`motion.craft-held-pose-check@1`](motion/craft-held-pose-check/card.json) | [543,565](../../routes/directing/craft/animation.md) |
| 整数帧时钟单元测试 | [`time.craft-clock-check@1`](time/craft-clock-check/card.json) | [566](../../routes/directing/craft/animation.md) |
| 视线与手部接触目标 | [`motion.craft-contact-targets@1`](motion/craft-contact-targets/card.json) | [332,567](../../routes/directing/craft/animation.md) |
| 手部接触逆运动学 | [`motion.craft-contact-ik@1`](motion/craft-contact-ik/card.json) | [332](../../routes/directing/craft/animation.md) |
| 六秒表演夹具 | [`motion.craft-performance-fixture@1`](motion/craft-performance-fixture/card.json) | [568](../../routes/directing/craft/animation.md) |
| 角色级挤压拉伸 | [`motion.craft-squash-stretch@1`](motion/craft-squash-stretch/card.json) | [181,569](../../routes/directing/craft/animation.md) |

## video

| 工艺 | 主版本卡号 | 原文行号 |
|---|---|---|
| 核对页面与渲染帧率 | [`delivery.craft-page-fps@1`](delivery/craft-page-fps/card.json) | [399,445](../../routes/directing/craft/video.md) |
| 无损截帧 | [`delivery.craft-lossless-capture@1`](delivery/craft-lossless-capture/card.json) | [446](../../routes/directing/craft/video.md) |
| 一次转换到 BT.709 有限范围 | [`delivery.craft-limited-bt709@1`](delivery/craft-limited-bt709/card.json) | [446](../../routes/directing/craft/video.md) |
| 写入并核验成片色彩标签 | [`delivery.craft-color-tags@1`](delivery/craft-color-tags/card.json) | [318,446,447](../../routes/directing/craft/video.md) |
| 核对交付帧数 | [`delivery.craft-frame-count@1`](delivery/craft-frame-count/card.json) | [18,414,447](../../routes/directing/craft/video.md) |
| 核对交付帧时间戳 | [`delivery.craft-frame-timestamps@1`](delivery/craft-frame-timestamps/card.json) | [414,447](../../routes/directing/craft/video.md) |
| 核对输出尺寸 | [`delivery.craft-frame-size@1`](delivery/craft-frame-size/card.json) | [18,447](../../routes/directing/craft/video.md) |
| 黑场检测 | [`delivery.craft-black-frames@1`](delivery/craft-black-frames/card.json) | [18,319,414,447](../../routes/directing/craft/video.md) |
| 缩小模糊后检测静帧 | [`delivery.craft-freeze-proxy@1`](delivery/craft-freeze-proxy/card.json) | [18,320,414,447](../../routes/directing/craft/video.md) |
| 核对画面切点与镜头表 | [`delivery.craft-cut-check@1`](delivery/craft-cut-check/card.json) | [321,447](../../routes/directing/craft/video.md) |
| 封装后 AAC 的响度核验 | [`delivery.craft-aac-loudness@1`](delivery/craft-aac-loudness/card.json) | [18,322,447,448](../../routes/directing/craft/video.md) |
| 交付文件哈希校验 | [`delivery.craft-file-hash@1`](delivery/craft-file-hash/card.json) | [447](../../routes/directing/craft/video.md) |
| 封装阶段避免重复响度归一 | [`audio.craft-mux-gain@1`](audio/craft-mux-gain/card.json) | [448](../../routes/directing/craft/video.md) |
| 核对文字可读时长 | [`delivery.craft-text-duration@1`](delivery/craft-text-duration/card.json) | [18,324,449](../../routes/directing/craft/video.md) |
| 检查文字安全区 | [`delivery.craft-text-safe-area@1`](delivery/craft-text-safe-area/card.json) | [324,449](../../routes/directing/craft/video.md) |
| 检测软件渲染或非目标 GPU | [`mechanism.craft-gpu-fallback@1`](mechanism/craft-gpu-fallback/card.json) | [325,450](../../routes/directing/craft/video.md) |
| 渲染前检查共享 GPU 占用 | [`mechanism.craft-gpu-load@1`](mechanism/craft-gpu-load/card.json) | [388,450](../../routes/directing/craft/video.md) |
| 中断时结束编码进程并清理临时文件 | [`delivery.craft-render-shutdown@1`](delivery/craft-render-shutdown/card.json) | [451](../../routes/directing/craft/video.md) |
| 并发输出锁 | [`delivery.craft-output-lock@1`](delivery/craft-output-lock/card.json) | [451](../../routes/directing/craft/video.md) |
| 分段渲染失败重试 | [`delivery.craft-segment-retry@1`](delivery/craft-segment-retry/card.json) | [265,451](../../routes/directing/craft/video.md) |
| 渲染检查点与断点续跑 | [`delivery.craft-render-resume@1`](delivery/craft-render-resume/card.json) | [265,451](../../routes/directing/craft/video.md) |
| 渲染结果自动登记 | [`delivery.craft-render-record@1`](delivery/craft-render-record/card.json) | [326,452](../../routes/directing/craft/video.md) |
| 网页视频的 GOP 间隔 | [`delivery.craft-web-gop@1`](delivery/craft-web-gop/card.json) | [453](../../routes/directing/craft/video.md) |
| 网页视频的编码 Level | [`delivery.craft-web-level@1`](delivery/craft-web-level/card.json) | [453](../../routes/directing/craft/video.md) |
| 从同一无损源分别编码分发版本 | [`delivery.craft-single-generation@1`](delivery/craft-single-generation/card.json) | [453](../../routes/directing/craft/video.md) |
| 无损或高码率中间件与归档母带 | [`delivery.craft-master-intermediate@1`](delivery/craft-master-intermediate/card.json) | [277,453](../../routes/directing/craft/video.md) |
| 跨设备无损帧对照与差值图 | [`delivery.craft-frame-comparison@1`](delivery/craft-frame-comparison/card.json) | [454](../../routes/directing/craft/video.md) |
| 噪声工厂显式种子 | [`time.craft-noise-seed@1`](time/craft-noise-seed/card.json) | [455](../../routes/directing/craft/video.md) |
| 检索画面路径里的墙钟与非播种随机 | [`time.craft-clock-random-audit@1`](time/craft-clock-random-audit/card.json) | [76,455](../../routes/directing/craft/video.md) |
| 字体子集字形覆盖 | [`delivery.craft-glyph-coverage@1`](delivery/craft-glyph-coverage/card.json) | [401,456](../../routes/directing/craft/video.md) |
| 必需资源加载失败报告 | [`asset.craft-required-load@1`](asset/craft-required-load/card.json) | [402,456](../../routes/directing/craft/video.md) |
| 颗粒保真的编码参数 | [`delivery.craft-grain-encode@1`](delivery/craft-grain-encode/card.json) | [249](../../routes/directing/craft/video.md) |
| 分发版颗粒强度 | [`post.craft-web-grain@1`](post/craft-web-grain/card.json) | [249](../../routes/directing/craft/video.md) |
| 渐变色带的十位编码 | [`delivery.craft-ten-bit@1`](delivery/craft-ten-bit/card.json) | [249](../../routes/directing/craft/video.md) |
| 完整解码错误检查 | [`delivery.craft-decode-check@1`](delivery/craft-decode-check/card.json) | [317](../../routes/directing/craft/video.md) |
| 顺序取帧与跳帧确定性对照 | [`delivery.craft-frame-determinism@1`](delivery/craft-frame-determinism/card.json) | [397](../../routes/directing/craft/video.md) |

## threejs

| 工艺 | 主版本卡号 | 原文行号 |
|---|---|---|
| 阴影相机按像素对齐 | [`lighting.craft-shadow-snap@1`](lighting/craft-shadow-snap/card.json) | [306,510](../../routes/directing/craft/threejs.md) |
| 核对文字可读时长 | [`delivery.craft-text-duration@1`](delivery/craft-text-duration/card.json) | [448,512](../../routes/directing/craft/threejs.md) |
| 检查文字安全区 | [`delivery.craft-text-safe-area@1`](delivery/craft-text-safe-area/card.json) | [448,512](../../routes/directing/craft/threejs.md) |
| 检测软件渲染或非目标 GPU | [`mechanism.craft-gpu-fallback@1`](mechanism/craft-gpu-fallback/card.json) | [411,507](../../routes/directing/craft/threejs.md) |
| 跨设备无损帧对照与差值图 | [`delivery.craft-frame-comparison@1`](delivery/craft-frame-comparison/card.json) | [504](../../routes/directing/craft/threejs.md) |
| Three.js 运行时版本核对 | [`mechanism.craft-three-revision@1`](mechanism/craft-three-revision/card.json) | [151,505](../../routes/directing/craft/threejs.md) |
| 转发页面警告 | [`mechanism.craft-page-warnings@1`](mechanism/craft-page-warnings/card.json) | [105,506](../../routes/directing/craft/threejs.md) |
| 着色器编译失败检测 | [`mechanism.craft-shader-errors@1`](mechanism/craft-shader-errors/card.json) | [105,506](../../routes/directing/craft/threejs.md) |
| 从实际渲染上下文识别 GPU | [`mechanism.craft-renderer-context@1`](mechanism/craft-renderer-context/card.json) | [411](../../routes/directing/craft/threejs.md) |
| 预检 WebGL 纹理与渲染缓冲区上限 | [`mechanism.craft-gl-limits@1`](mechanism/craft-gl-limits/card.json) | [379,508](../../routes/directing/craft/threejs.md) |
| 切镜时释放场景资源 | [`mechanism.craft-scene-dispose@1`](mechanism/craft-scene-dispose/card.json) | [366,509](../../routes/directing/craft/threejs.md) |
| 审计纹理几何与着色器资源 | [`mechanism.craft-gpu-memory-audit@1`](mechanism/craft-gpu-memory-audit/card.json) | [367,509](../../routes/directing/craft/threejs.md) |
| 点光源下形变网格的距离阴影材质 | [`lighting.craft-deformed-point-shadow@1`](lighting/craft-deformed-point-shadow/card.json) | [263,306,472,510](../../routes/directing/craft/threejs.md) |
| 级联阴影 | [`lighting.craft-cascade-shadow@1`](lighting/craft-cascade-shadow/card.json) | [306,510](../../routes/directing/craft/threejs.md) |
| 着色器异步预热 | [`mechanism.craft-shader-prewarm@1`](mechanism/craft-shader-prewarm/card.json) | [418,511](../../routes/directing/craft/threejs.md) |
| 屏幕对齐画布停用 mipmap | [`two-d.craft-canvas-mips@1`](two-d/craft-canvas-mips/card.json) | [373,513](../../routes/directing/craft/threejs.md) |
| 穹顶透明材质单次绘制 | [`two-d.craft-dome-pass@1`](two-d/craft-dome-pass/card.json) | [513](../../routes/directing/craft/threejs.md) |
