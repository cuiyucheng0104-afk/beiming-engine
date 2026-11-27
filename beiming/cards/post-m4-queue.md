# T21 · M4 后技术卡排队清单

规划 05 §5.5 的第 67–91 项按原编号逐张立项。每行列出实现落点、原包定位及验收题。入队只登记工作范围；实作、量测与晋级须在各卡立项后另行留证。

来源路径以各包源码根为起点：Skyfire 用 `game/src/`，Iron Bamboo 和赤龙用 `src/`，VOWLORN 用 `js/src/`，03B 用工程根。范围含首尾行。考题索引注明可运行登记与设计题的区别。

| 编号 | 卡 ID | 能力 | 拟实现落点 | 来源文件及行号 | 挂题 |
|---|---|---|---|---|---|
| 67 | `shade.toon-kit` | 卡通光照四件套（主光作弊、形体光、像素约束的边缘光、抗锯齿分带） | three | Skyfire `render/toon.js:89-230` | [SI-K3](#exam-si-k3) |
| 68 | `shade.hull-outline` | 反壳描边（屏幕恒宽） | three | Skyfire `render/toon.js:235-258,518-570` | [SI-K3](#exam-si-k3) |
| 69 | `comp.tonemap-hybrid` | 混合色调映射 | comp | Skyfire `render/pipeline.js:221-268` | [SI-K1](#exam-si-k1) |
| 70 | `post.hue-keep` | 发光体保色 | three | VOWLORN `fx/post.js:1569-1592` | [VW-K5](#exam-vw-k5) |
| 71 | `post.grade-lut` | 显示空间调色与查找表烘焙 | comp | VOWLORN `fx/post.js:813-937`；Skyfire `render/pipeline.js:351-365` | [VW-K5](#exam-vw-k5) |
| 72 | `post.bilateral-up` | 联合双边上采样 | three | Iron Bamboo `render/shaders.js:91-114`；Skyfire `render/pipeline.js:36-60` | [SI-K9](#exam-si-k9) |
| 73 | `light.pcss` | 多深度比较的软阴影 | three | VOWLORN `world/skyshadow.js:307-388` | [VW-K8](#exam-vw-k8) |
| 74 | `light.sun-fill` | 单太阳加着色器补光 | three | VOWLORN `world/skyglsl.js:846-908` | [VW-K8](#exam-vw-k8) |
| 75 | `light.hdri-sun` | 从环境图里分离太阳 | three | Iron Bamboo `render/sky.js:43-58` | [SI-K8](#exam-si-k8) |
| 76 | `shade.shell-fur` | 壳层毛发 | three | Iron Bamboo `game/skin.js:12-55` | [10-1](#exam-10-1) |
| 77 | `motion.retarget` | 运行时重定向 | 数据层和 three | Iron Bamboo `game/retarget.js:6-60` | [SI-K12](#exam-si-k12) |
| 78 | `motion.ik2` | 解析双骨反解 | 数据层 | Iron Bamboo `game/riglayer.js:15-26`；VOWLORN `enemies/rig.js:443-476`；03B `build/scene.py:290` | [SI-K12](#exam-si-k12)、[VW-K1](#exam-vw-k1) |
| 79 | `motion.weapon-track` | 以武器为中心的关键帧 | 数据层 | Iron Bamboo `game/riglayer.js:28-37`；Iron Bamboo `game/staffmoves.js:1-16` | [SI-K12](#exam-si-k12) |
| 80 | `motion.weigh` | 自动重量（插键与二阶差分） | 数据层 | VOWLORN `enemies/rig.js:632-691`；VOWLORN `enemies/dragon_anim.js:407-428` | [13-2](#exam-13-2) |
| 81 | `motion.spring-chain` | 弹簧链与次级运动 | 数据层 | Skyfire `actors/dragon.js:850-860`；Iron Bamboo `core/util.js:17-26`；VOWLORN `enemies/dragon_anim_ik.js:50-56` | [13-1](#exam-13-1) |
| 82 | `motion.wing` | 扑翼相位函数 | 数据层 | Skyfire `actors/wingkin.js:63-128`；VOWLORN `enemies/dragon_anim_flight.js:5-40` | [SI-K4](#exam-si-k4)、[VW-K2](#exam-vw-k2) |
| 83 | `particle.on-twos` | 一拍二 | three | Skyfire `vfx/particles.js:16` | [SI-K6](#exam-si-k6)、[15-1](#exam-15-1) |
| 84 | `particle.ambient` | 环境粒子纯函数 | three | VOWLORN `world/particles.js:189-190`；赤龙 `72_air.js:413-417` | [T21-A84](#exam-t21-a84) |
| 85 | `form.sdf-nets` | 距离场雕刻与取面 | three（烘焙） | 赤龙 `10_sdf.js:5-99`；VOWLORN `core/organic_sdf_core.js:112-831` | [外01-2](#exam-30-2) |
| 86 | `shade.scales` | 叠压鳞片 | three | 赤龙 `58_dlook.js:75-251` | [外01-2](#exam-30-2) |
| 87 | `wind.gust-wake` | 阵风表、经过表与闭式弹簧响应 | 数据层和 three | 赤龙 `72_air.js:57-64`；赤龙 `66_wake.js:59,229-263` | [CL-X5](#exam-cl-x5) |
| 88 | `camera.relative` | 主体相对的机位数据 | 数据层 | Skyfire `camera/camera.js:215-246` | [SI-K5](#exam-si-k5) |
| 89 | `audio.sfx-bank` | 种子确定的音效库 | comp | VOWLORN `audio/bank.js:51-259,5195-5202`；Skyfire `audio/synth.js:12-42` | [VW-K6](#exam-vw-k6) |
| 90 | `audio.scene-events` | 声音读画面的事件表 | 数据层和 comp | 赤龙 `85_audio.js:728-854` | [CL-X8](#exam-cl-x8) |
| 91 | `sky.cloud-toon` | 体积云与卡通分带 | three | Skyfire `world/clouds/shaders.js:484-594` | [SI-K7](#exam-si-k7) |

## 考题索引

- <a id="exam-10-1"></a>**10-1**　仓内预期失败题，见 [题面 10-1](../bench/questions/expected-fail/10-1.json)。
- <a id="exam-13-1"></a>**13-1**　龙起飞姿势与尾部弹簧稳定。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-13-2"></a>**13-2**　骑士重攻击的蓄势、停顿与收势。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-15-1"></a>**15-1**　水粉一拍二加缓推。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-cl-x5"></a>**CL-X5**　开场山谷：岩柱、树、建筑、云影、高度雾。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-cl-x8"></a>**CL-X8**　配乐读画面：按画面事件表合成 90 秒声音。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k1"></a>**SI-K1**　色调映射等价：喂合成 HDR 测试卡。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k12"></a>**SI-K12**　正手横扫：武器关键帧驱动。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k3"></a>**SI-K3**　龙的卡通静帧，四种光向。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k4"></a>**SI-K4**　扑翼循环。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k5"></a>**SI-K5**　泰坦登场镜头：按机位数据复刻。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k6"></a>**SI-K6**　吐息一拍二。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k7"></a>**SI-K7**　金色云海。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k8"></a>**SI-K8**　逆光熊猫。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-si-k9"></a>**SI-K9**　光柱与竹林。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-t21-a84"></a>**T21-A84**　本清单新增的待出题「环境粒子随机访问」。给定种子、粒子编号和帧号，分别顺序、倒序与跳帧求值；同一输入的粒子位置及生命周期读数须一致，换种子后至少一个粒子的位置须变化。尚未接入 bench。
- <a id="exam-vw-k1"></a>**VW-K1**　骑士轻击：按 8 键表做出 0.86 秒挥砍。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-vw-k2"></a>**VW-K2**　龙扇翼一拍。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-vw-k5"></a>**VW-K5**　火焰不漂白。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-vw-k6"></a>**VW-K6**　两个音效的合成。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-vw-k8"></a>**VW-K8**　一盏太阳的暗部。规划设计题，出处见 05 §5.7 或调研 15 §6。
- <a id="exam-30-2"></a>**外01-2**　仓内预期失败题，见 [题面 30-2](../bench/questions/expected-fail/30-2.json)。
