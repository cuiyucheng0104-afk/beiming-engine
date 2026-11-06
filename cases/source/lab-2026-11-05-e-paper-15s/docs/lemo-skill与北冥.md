# lemo-opuscar 在北冥中的作用

核对日期：2026-11-05。依据本地 skill、lemo-opuscar 指南与当前北冥源码。这里记录架构关系，不把文字相似或 API 相同直接当作逐行代码来源证明。

## 三层关系

**skill 是制作流程的入口。** SKILL.md 本身不含着色算法；它定位库、准备依赖，并把工作交给 AGENTS.md、DIRECTOR.md、TECHNIQUE.md 与风格指南。不是影片播放时加载的运行库。

**lemo 提供制作方法与通用工具。** 统一时间轴、`DUR / render(t) / READY / TEXTS` 约定、无头浏览器逐帧截图、ffmpeg 编码、声音合成与响度检查。这些环节在北冥开发中充当过基础设施。当前北冥已将自己的实现放在 engine 下，不必在播放时运行 skill。

**北冥负责具体画面系统。** `engine/shade/toon.js` 的材质分档、`engine/look` 的 ID/深度墨线与绘画后期、`engine/stage` 的二维底板与三维主体合成、`src/kun.js` 的鲲形体及原片镜头，是需要单独理解和调参的内容。不能把北冥的所有视觉算法归因于 skill。

| lemo 的方法 / 工具 | 北冥对应位置 | 这次动画的用途 |
|---|---|---|
| TECHNIQUE §2：画面是时间的纯函数 | engine/stage/film.js；engine/render/page.mjs | 随机种子固定，跳帧、并行和重渲结果一致 |
| 逐帧浏览器截图 → ffmpeg | engine/render/video.mjs、mux.sh | 在 5090 的 Vulkan 后端输出 360 帧 |
| DIRECTOR：一个主体、一个转折、材质内生转场 | 本片 TREATMENT.md | 一张纸→纸鹤→山河，纸张遮镜 |
| cel-anime-80s：绘画背景与运动赛璐璐分工 | 原片 shotA.js、shotB.js、shotC.js | 二维底板保住美术；三维只服务关键主体 |
| 角色一拍二/三，镜头与光连续 | engine/core/clock.js | 纸/鹤姿态 12fps，飞行路径、雾 24fps |
| STYLE.md：把风格固定为可检查的规则 | 本片 src/style.js、STYLE.md | E 组颜色、光影档位、线宽、纸纹全片一致 |
| DIRECTOR §11：关键帧、动作条、声音与最终成片验收 | 本片 tools 和 delivery | 先看实画，再做完整渲染 |

## 对用户纠正的落实

三渲二描述的是三维物体如何输出二维视觉语言，并不要求所有背景、人物和特效都必须是三维。原片 `shotB.js` 的人物就是 Canvas 2D 图层；`shotA.js` 的城市、云、水面主要是二维底板，鲲与船提供局部空间与动作。这种分工有代码证据。

因此本次应保存二维绘画的构图、色彩与气氛，让可见的三维飞纸具有分档和纸面质感，再统一合成。不是把照片贴到完整三维场景上绕拍，也不是只给全画面加一层卡通滤镜。

## 使用范围

研究了本地 DIRECTOR.md、TECHNIQUE.md、MY-STYLES.md、watercolor/STYLE.md 与 cel-anime-80s/STYLE.md。采用制作流程和有限动画分工，不照搬水彩逐笔显现、80s CRT/霓虹或示例剧情。已有工具可用，保持当前依赖版本，不为研究强制更新共享库。

本次不能保证静帧参数自动在所有运动中稳定；需要检验折痕变化、线条沸腾、背景/主体色差和转场连续性。稳定风格来自规则、分层职责和实际验收，而不是单个固定滤镜。
