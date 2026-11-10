# 风格、工程与作品：三个仓库如何合用

> 读者：维护案例库、从两套风格库取方法的人｜状态：归档记录与选型方法｜依据：2026-11-07，两套风格库按固定提交核对

这里把“风格名字相近”“底层方法相通”“文件完全相同”分开处理。同名风格不等于重复影片，不同作者实现也不能去掉署名后归为原创。

## 固定版本与数量

| 来源 | 固定版本（2026-11-07 归档） | 核对到的内容 | 在北冥中的位置 |
|---|---|---|---|
| [sy-style-100](https://github.com/xiaoxiong20xx-code/sy-style-100/tree/e41dee31a5c05dffa12b2f241378e648d2a22df6) | `e41dee31a5c05dffa12b2f241378e648d2a22df6` | 20 种风格；首期 20、第二期 20、行业 60，共 100 个示例 | 完整源码快照收入 cases/vendor；运行时独立，北冥不另造一套同功能播放器 |
| [lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar/tree/bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00) | `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` | 66 个实际风格目录；另有 `_template`，不计入风格数 | 完整的 66 种风格、导演/技术文档、demo、core 和工具收入 cases/vendor |
| 北冥引擎 | 本批归档基于 `02762fe` | 风格化 Three 主线、RAEA 独立实验、真实项目与案例库 | 创作入口、项目资产、渲染和验收；原片源码保持不变 |

2026-11-07 归档时，本机的 lemo 库与当时远端快照的 HEAD 相同。两套外部仓库的 tracked Git blob ID 交集为 **0**（331 与 2478 个文件条目）；这是字节级核对，不证明不存在相近算法或改写。完整外部示例索引见 [references.json](../../cases/references.json)。本机 66 部风格实验是另一组项目，不能把它们与 lemo 的 66 部官方 demo 加成“132 种画风”。

## 源码层的区别

| 维度 | sy-style-100 | lemo-opuscar | 北冥现状与取用方式 |
|---|---|---|---|
| 场景入口 | `Reel.scene({duration,fps,setup,render})` | 每部片独立 HTML / JS，风格模块与导演文档配套 | 原片 `src/`，复用模块 `engine/`；历史工程先还原到独立目录 |
| 逐帧接口 | `__seek(t)`、`__duration`、`__fps`；渲染参数 `?render=1` | `DUR`、`render(t)`、`READY`，另有文字/事件检查 | 主线沿用后者；SY 不能只改名字就认为已兼容 |
| 等待资源 | `__seek` 内部等待 setup/fonts Promise | 页面 READY + 浏览器端检查 | 适配时必须等待第一次异步 seek；不能只检测函数存在 |
| 画面方法 | Canvas、SVG、DOM/CSS、WebGL；18 个库模块，含 SDF 光线步进 | 66 套风格方法与演示，2D/3D/剪辑/纪实混合 | 北冥三色材质、ID 线、绘画人物和后期只是一种组合；案例库补充不同组合 |
| 光照/材质 | `lib/rm.js` 的距离场场景；`toon/clay/glass/chrome` 等专用模块 | 按风格分别实现；不是所有风格都用 Three | 优先借用构成和材质方法；SDF 与 Mesh 不能直接互换材质代码 |
| 模糊/采样 | `--frames --mb N` 的子帧 + Halton jitter + FFmpeg tmix；frameKey 可复用停格帧 | 多 worker 逐帧、锁文件、渲染槽、质量检查 | 未来按需求取用子帧采样；截至 2026-11-07 归档没有移植到北冥 |
| GPU | 默认 SwiftShader；`--hwgpu` 才请求硬件 GPU | Chrome/ANGLE 后端配置 | 已有 RTX Vulkan 路径；必须记录实际设备，不把 WebGL 硬件加速称作 CUDA/NVENC/DLSS |
| 声音 | 音乐种类+动作 cue，Python 合成，统一合成 reel | events、采样器、配乐/拟音/混音和阅读检查 | 保存案例实际声音程序与素材，不统一重算历史混音 |
| 示例用途 | 10/15 秒广告、文字配置、行业换题材 | 风格学习、镜头与导演方法、长短故事 | 真实 PPT 改编、风格探索、讲解片与技术预演按状态存档 |

可追到的实现：[SY 场景生命周期](https://github.com/xiaoxiong20xx-code/sy-style-100/blob/e41dee31a5c05dffa12b2f241378e648d2a22df6/lib/core.js)、[SY 渲染采样](https://github.com/xiaoxiong20xx-code/sy-style-100/blob/e41dee31a5c05dffa12b2f241378e648d2a22df6/render.js)、[SY 距离场](https://github.com/xiaoxiong20xx-code/sy-style-100/blob/e41dee31a5c05dffa12b2f241378e648d2a22df6/lib/rm.js)、[Lemo 多进程渲染](https://github.com/lemomo-ai/lemo-opuscar/blob/bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00/core/render/video.mjs)、[北冥页面入口](../../engine/render/page.mjs)。

## 20 类风格怎样去重

下表是选型映射，不是相同源码判定。“扩展候选”表示现有案例没有同等实现，不冒充已集成。

| SY 风格 | 已有本机案例/方法 | 整理结果 |
|---|---|---|
| 01 逐帧手绘 | crayon-book / watercolor / cel-anime-80s | 同一大类；保留各自笔触与停格机制 |
| 02 等轴 2.5D | iso-infographic / isometric-picture-book | 合并选型标签，故事与源文件独立 |
| 03 扁平矢量 | pictogram-motion / swiss-motion | 合并图形标签；无限缩放作为另一镜头技法 |
| 04 线条 | one-line | 同类，不删除透视山脊与连续一笔的差异 |
| 05 三维摄影棚 | glass-product / lowpoly-island | 不与“三渲二”混为一类；按材质和几何选型 |
| 06 粒子形变 | 北冥没有同等完整案例 | 扩展候选：形状采样、粒子对应与过渡 |
| 07 贴纸科普 | 本机讲解类可参考，但非同等实现 | 扩展候选：模切轮廓、接触阴影、镜头阅读 |
| 08HUD | hologram-hud / lidar-survey | 合并界面标签，点云与显示层仍分开 |
| 09 拼贴 | halftone-dossier / archive-lighttable | 相邻类别；撕纸、证据排布、光照各自保留 |
| 10 玻璃拟态 | glass-product | 都涉及玻璃；屏幕 UI 与实体产品不能合成同一预设 |
| 11 包豪斯 | memphis-diorama / swiss-motion | 相邻构成方法；错觉对齐是独立技法 |
| 12Synthwave | ascii-crt / backrooms 仅共享部分复古后期 | 扩展候选：霓虹距离场山谷，不算已有同款 |
| 13 像素 | pixel-rpg / hd-2d | 标签合并；低分辨率像素与高清 2.5D 不同 |
| 14 液态金属 | 无同等完整案例 | 扩展候选：距离场融合与液面形态 |
| 15 综艺花字 | game-show / telestrator | 保留花字与战术标注的不同叙事职责 |
| 16 页面推镜 | living-screencast / desktop-flythrough | 标签合并；DOM 分层、真实录屏、3D 桌面分别记录 |
| 17 数据编辑风 | dataviz / caption-news / news-package | 共用信息表达标签，证据来源与图表逻辑独立 |
| 18 水墨 | ink-wash / printed-long-take /《见龙》 | 现成项目优先；墨晕、版画、PPT 原画是不同流程 |
| 19 黏土定格 | brick-toy 只有玩具邻近性 | 扩展候选：指纹表面、微距、逐拍形变 |
| 20 蓝图 | blueprint / teardown | 标签合并；爆炸图和实物切换独立验收 |

## 去重的边界

1. 代码文件在替换本机路径为显式还原标记后计算 SHA256，完全相同才共用一份。每个条目保存原文件哈希和归档哈希；改写不被标成逐字原件。
2. 素材按原始字节 SHA256 去重。不同分辨率、不同配音或不同剪辑保留为版本，不能因片名相同合并。
3. 镜头、色彩和导演方法按标签归类，不删除不同实现。两部水墨片可能完全不同，不强行抽出“万能水墨引擎”。
4. 外部仓库的全部 2809 个跟踪文件已按固定提交保存到 cases/vendor；它们标明外部来源，不冒充我们的作品。没有复制未跟踪依赖、Git 历史或上游另外发布的影片。
5. 不提交 node_modules、虚拟环境、秘密配置、缓存帧和下载的原始 LiDAR 分块；保留处理后的点云输入、实际项目代码和可用成片。

## 给 agent 的实际开工顺序

先从 [案例目录](../../cases/INDEX.md) 找“叙事任务+视觉方法”最接近的一部，读它的 `TREATMENT/方案`、入口与版本记录，再还原项目。只取已经验证的组件；跨工程依赖和原有输出路径要先核对。

延续北冥画风，遵守 [北冥手册](../routes/README.md) 的风格锁定；直接走北冥原生路线，按原生路线手册制作。PPT 转片则先使用 [PPT 流程](ppt-animation.md) 的提取、分层、时间轴与声画方法。历史案例库不新增第三个 GPU 后端，也不代表所有旧工程已经迁移为北冥或 RAEA API。
