# 三渲二着色工艺

> 适用：**A 北冥风格路线 · WebGL 三渲二**。**B 北冥原生路线 · BNE** 的材质要另写：GLSL 不能直接当原生着色语言用，GLB 也不带屏幕墨线和后期（`AGENTS.md:31`、`AGENTS.md:39`、`docs/routes/beiming-style.md:184-185`）。**C 北冥代码动画风格 · 86 式** 的案例只当写法参照。
> 解决什么：在本仓库里做出高级三渲二画面的"光与色、线与笔"这一层。造型与镜头见 [two-five-d.md](two-five-d.md)，节拍见 [animation.md](animation.md)，材质补丁、渲染器与色彩空间见 [threejs.md](threejs.md)，分辨率与出片见 [video.md](video.md)。
> 怎么用：§1 先看清光路 → §2 十二条判据（每条：为什么／仓库怎么做／怎么自检）→ 调参查 §3 参数地图、§4 配方 → 新片按 §7 的顺序落地，§6 失败模式表用来排查（§6.1 技术失败、§6.2 审美失败、§6.3 撮影层）。
> 标注与术语统一见 [README](README.md)：【仓库实证】（含·复算／·渲染／·实测／·文档／·代码）、【通用工艺】、【推断】、【未实现】（正文里不加括号的"未实现"同义）。`$甲`、`$乙`、`<研究工作区>` 三个路径缩写的展开见本章「出处与许可」与 README。基线 `origin/main 3b97946`，只读检出。
> 本章标【仓库实证·实测】的命令只在 macOS（`engine/render/page.mjs:48` 的默认图形后端 ANGLE Metal）上跑过，没有在 5090 工作站复测。

## 0. 状态纪律

`cases/catalog.json` 里 `historical-render` 只表示"出过片"，不等于用户认可；`rejected`（豹变四版、北冥九分钟、纸上江山 E 组）不能当正面范例（`AGENTS.md:58`，`cases/entries/local-baobian-film.md:11`，`cases/entries/local-beiming-film-9min.md:5`，`cases/entries/lab-2026-11-05-e-paper-15s.md:11`）。六种鲲变体（原版、东方化、青绿仙山、玄鲲云纹、青铜古鲲、鲲鹏将化，见 `media/styles.jpg`）是仓库里的实现，**认可状态没有书面记录**；本章引用它们的参数只当"可运行的调法"，不当风格结论。

---

## 1. 着色发生在哪里：一条完整的光路

### 1.1 材质里（每个像素按这个顺序算）【仓库实证】

`engine/shade/toon.js` 的 `shadeGlsl` 把 `MeshToonMaterial` 里算 `outgoingLight` 的那一行整段替换（`engine/shade/toon.js:78`、`engine/shade/toon.js:240`），所以**内置光照、环境光、半球光、灯的颜色和强度都不进入卡通材质**，只剩第一盏平行光的方向和投影（`engine/shade/toon.js:4`、`engine/shade/toon.js:108-117`）。

```text
en  = 物体空间噪声(vToonObj × edgeNoiseScale) × edgeNoise              toon.js:119
hl  = 0.5·N·L + 0.5 + en                                              toon.js:121
hlS = hl × mix(1 − shadowDepth, 1, att)        att = 量化后的投影可见度   toon.js:122
m1  = 线性坡((step1 − hlS)/max(feather1, fwidth·bandAA))                toon.js:123-124
m1  = max(m1, castShade·(1 − att))             投影强制进一档            toon.js:125
m2  = 线性坡((step2 − hl)/max(feather2, fwidth·bandAA))  不含投影        toon.js:126-127
col = mix(alb·litTint, mix(alb·shade1Tint, alb·shade2Tint, m2), m1)     toon.js:129
col ← 天空冷光：朝天且 m1>0 的面混 alb·skyTint                           toon.js:130-135
col ← 下方补光：N·fillDir 两档量化，混暖色                                toon.js:137-145
col ← 背光侧边缘光(rim*) → 受光侧边缘光(rimLit*，乘 att)                  toon.js:147-165
col ← 材质内墨线 toonInk → 不受光的覆盖色 toonOverlay                     toon.js:167-168
out = col × uExposure + 自发光                                          toon.js:170
```

反照率阶段（分档之前）依次是：钩子变量 → `fragmentBase` → 记下 `toonBase` → 表面层（斑块/笔触/风化）→ `fragmentAlbedo` → 后置表面层（`engine/shade/toon.js:193-199`）。噪声全部是坐标的纯函数，任意帧可单独重渲（`engine/shade/noise.glsl.js:1-2`）。

### 1.2 后期里（固定顺序）【仓库实证】

`engine/look/index.js:3-6`：主场景（MSAA 4、HalfFloat 线性 HDR、带深度）→ ID 图（超采样 `ss` 倍）→ 边缘 → 笔画 → 雾 → bloom → 调色 → OutputPass → Kuwahara（sRGB 空间）→ **叠墨线**（在 Kuwahara 之后，不被抹糊）→ 纸纹 → 暗角 → 颗粒。之后才由影片外壳在顶层 2D 画布上画显示层和字幕，不经过任何后期（`engine/stage/film.js:2`、`engine/stage/film.js:30-33`、`engine/stage/film.js:45-47`）。

### 1.3 两套描边，别混用【仓库实证】

| | 正片 | 实验页 |
|---|---|---|
| 入口 | `engine/look/ids.js` + `engine/look/ink.js` | `uToonPass = 1` 输出视空间法线 + 物体/实例 ID（`engine/shade/toon.js:175-184`），`lab/kun*.js` 自写合成 |
| 依据 | 物体 ID 跳变 + 深度断层/折痕（`engine/look/ink.js:41-58`） | 深度 + 法线折痕 + ID（`lab/kun.js:79-84`） |
| ID 来源 | ids.js 遍历时按网格重新编号（`engine/look/ids.js:96`、`engine/look/ids.js:117-125`），**不读材质的 `uObjectId`** | 材质 `uObjectId`（`engine/shade/toon.js:180`） |
| 线宽 | 按输出高度/1080 标定（`engine/look/index.js:93`） | 写死渲染像素（`lab/kun.js:73`，PR=2） |

路线手册已写明 `lab/kun.js` 的临时描边不能证明正片一致（`docs/routes/beiming-style.md:151`）。`lab/look.js` 的测试材质是 `gradientMap` 三档的普通 `MeshToonMaterial`，**不是引擎卡通材质**（`lab/look.js:35-40`）。

---

## 2. 高级三渲二的十二条判据

每条分三段：为什么（通用工艺）→ 仓库怎么做（实证）→ 怎么自检。

### 判据 1 · 形体语言先于着色

【通用工艺】三渲二的高级感首先来自剪影和大形：剪影一眼可读，体块主次清楚，转折处留出能被色阶"切开"的面。着色只负责把形体说清楚；拓扑密度不等于美术复杂度。

【仓库实证】
- 鲲先用 14 个站点的轮廓表（顶线、底线、半宽）放样，截面是超椭圆，指数 `[2.25, 2.75]`（`src/kun.js:24-27`、`src/kun.js:42-43`）。
- 为让描边抓到嘴线，几何上专门做了台阶（`src/kun.js:46`）；胸鳍加弦向弯度，注释写明是为了让卡通分档在鳍面切出亮/暗两块（`src/kun.js:78`）。
- 低 LOD 时装饰"数量少、单个大，覆盖面积不变"（`src/kun.js:147`）；网格细分随 LOD（`src/kun.js:165`）。
- 镜头 A 让鲲背朝远处，海草成剪影边（`src/shotA.js:107`）。
- 手册：先保证远中近景轮廓再提细分（`docs/routes/beiming-style.md:36`）；校准第一步是灰模和轮廓（`docs/routes/beiming-style.md:142`）。

【自检】正式卡通材质没有灰模/纯反照率开关【未实现】；目前只能临时把 `fillAmt/skyAmt/rimAmt/rimLitAmt` 置 0、表面层量置 0 来看剪影与分档。校准场景是计划任务 T05，状态 `planned`，`lab/style-calibration/` 不存在（`docs/routes/work-plan.json:164-168`、`docs/routes/work-breakdown.md:126-132`）。

### 判据 2 · 主光是设计出来的：按镜头定方向，先保形体可读

【通用工艺】先定这一镜要读的是什么形——剪影、体积还是表情——再选光向。逆光和侧逆光利于气氛与剪影：主体大部分落进阴影档，体积靠轮廓光、反光和线来读；正侧光利于表情和形体。顺光、侧光、逆光都常用，没有哪一种天然更"高级"；三渲二的通行做法是主光为画面服务，可以按镜头、甚至按角色单独设。交界线的位置由光向和 `step1` 共同决定（判据 4）。主体大面积落在阴影档时，**观众看到的主色其实是一档阴影色**，这一档必须是设计出来的颜色。

【仓库实证】
- 北冥日出段选的是低角度逆光（`docs/作品.md:63`：日出一行写"粉紫、橙、金，逆光"）；色彩脚本的其他四段光向未定。样片主光仰角：镜头 A `(-0.72, 0.12, -0.68)` 约 6.9°（`src/shotA.js:53-55`），镜头 C `dirOf(30°, 7°)` 即 7.0°（`src/shotC.js:110-112`）；自测页 `(0.75, 0.1, 0.65)` 约 5.8°（`lab/kun.js:34-35`），不属于样片【仓库实证·复算，见 §5.1】。
- 青铜变体的色板注释直接写明：逆光里镜头看到的大多是一档阴影色（`src/toon_bronze.js:21`）。
- 灯只给方向和投影，颜色按色板绝对给定（`src/toon.js:4-5`）；场景里没有平行光时用共享的 `uKeyDirW`（`engine/shade/toon.js:108-112`）。主光方向可以逐镜设：`setToonGlobals({ keyDir })`（`src/shotA.js:142`、`src/shotC.js:198`）。
- 卡通材质只认第一盏平行光的方向（`engine/shade/toon.js:107-112`），点光源、聚光的位置、颜色、衰减都不进来；"灯照到哪里哪里才亮"这种局部光【未实现】，要做得在材质族钩子里新写点光分支和照射范围遮罩。
- 主光移动后要每帧重新罩阴影相机：`kun.fitShadow(light, { size })`（`src/kun.js:519-533`，镜头里见 `src/shotA.js:110`、`src/shotC.js:174`）。

【自检】改主光方向时，交界线、投影、两种边缘光、天光遮罩会一起变；改 `DirectionalLight` 的颜色或强度，卡通材质**没有任何变化**是正常的。逆光镜头另看灰度缩略图：主体落进阴影档后，与背景的明度差常常不够（§5.2 末尾的北冥实例），要靠墨线、边缘光、补光承担分离。

### 判据 3 · 两到三档色阶

【通用工艺】赛璐璐的标准是"亮面 + 一影"，必要时加少量"二影"（只放在最深的转折和闭塞处）。档数是风格决定，不是精度问题；档间过渡宽度决定"硬卡通 ↔ 柔和插画"。

【仓库实证】
- 三色公式与阈值定义（`engine/shade/toon.js:51`、`engine/shade/toon.js:121-129`）。没有通用 `levels: N` 参数，要别的档数得改材质族钩子（`docs/routes/beiming-style.md:94`）。
- 羽化按 `max(给定值, fwidth × bandAA)` 取，逐帧导出不闪（`engine/shade/toon.js:120-126`）；族默认 `featherMin 0.015`、`bandAA 1.2`（`engine/shade/toon.js:187`、`engine/shade/toon.js:210`）。
- 变体：精修版羽化 0.012/0.015、下限 0.01（`src/toon_refine.js:7`、`src/toon_refine.js:40-41`、`src/toon_refine.js:105`）；玄鲲身体 0.006、下限 0.004、`bandAA 1.5`（`src/toon_xuan.js:81`、`src/toon_xuan.js:138`）；青铜玉器 `feather1 0.05` 偏柔（`src/toon_bronze.js:70`）。
- 预设把二档阈值压得很低（0.06–0.2），二影只出现在背光最深处【仓库实证·复算，见 §5.1】。
- 多档（2/3/4/6 阶）的写法示例：`cases/source/lab-2026-11-05-tonal-40/lab/material.js:5-21`（用 `toonKind` 的 `shade.afterRim` 钩子覆盖 `col`）。该案例状态是 `experiment`，只当钩子用法参考，不是认可画风。

### 判据 4 · 阴影形状与明暗交界线位置

【通用工艺】交界线就是三渲二的"笔"：位置决定亮暗面积比（避免 1:1 的含糊分割）；形状要顺着形体并带一点手绘抖动；投影要和自身阴影说同一种语言（同色、同硬度）。

【仓库实证】
- 交界线位置由 `step1` 决定；`step1 0.53` 意味着交界在离主光 86.6° 处，亮面略小于半球；`0.42` 则亮面绕到背面（99.2°）【仓库实证·复算，见 §5.1】。
- `edgeNoise / edgeNoiseScale` 在物体空间扰动交界线（`engine/shade/toon.js:60`、`engine/shade/toon.js:119-121`），同一噪声也扰动天光、补光、边缘光的边界（`engine/shade/toon.js:134`、`engine/shade/toon.js:139`、`engine/shade/toon.js:152`、`engine/shade/toon.js:157`），所有光的边界"同一只手"。
- 投影：阴影贴图的返回值过 `smoothstep(shadowLo, shadowHi)` 量化成色块（`engine/shade/patch.js:42-47`、`engine/shade/toon.js:237`）。
- 投影只压进**一档**，不进二档：`m2` 用不含投影的 `hl`（`engine/shade/toon.js:122-127`）。这避免投影区发黑。
- 薄片、羽毛不想被投影压死：`castShade 0.7–0.8`（`src/kun_peng.js:666`、`src/kun_peng.js:819`）。
- 逐像素"抬档"：青铜变体的 `toonLift` 把玉、绿松石从阴影档往亮档抬（`src/toon_bronze.js:4`、`src/toon_bronze.js:84-85`，用法 `src/kun_bronze.js:358`）。

【未实现】通用的阴影阈值贴图（贴图或顶点色逐像素偏移 `step1`）；面部法线编辑/法线传递（仓库没有三维人脸，人物画在透明 2D 画布上，见 `src/girl.js:3`）。

### 判据 5 · 阴影色是"换色相"，不是"压暗"

【通用工艺】暗部的颜色来自环境（天空、反射），所以阴影的色相向环境光偏移；乘黑或单纯降亮度会发灰发脏。判断"有没有发灰"要用感知均匀的色彩空间：sRGB 的 HSL 饱和度在暗色和低彩度时数值失真，会得出相反的结论（§5.2）。【通用工艺·建议】在 OKLCH 里看：阴影的彩度 C 不低于亮档的约 70%，身份色和强调色不低于约 90%；明度差按分档设计。特殊材质（金、肤色、强调色）在阴影里要保住"身份色"。

【仓库实证】
- `tintFrom(base, shade)` 在**线性空间**逐通道求比值（`engine/shade/toon.js:46-49`），单色物体直接给 `shade1/shade2`（`engine/shade/toon.js:54`、`engine/shade/toon.js:203-204`），实例色物体用乘法色调，每个实例各有自己的三档色（`engine/shade/toon.js:7`）。
- 引擎中性默认色调蓝通道最高（`[0.62,0.64,0.8]`、`[0.36,0.38,0.58]`，`engine/shade/toon.js:55`），即默认就往冷色偏。
- 实测（§5.2，OKLCH）：鲲身色相几乎不变（h 272°→274°），彩度 C 0.071→0.079（一影）、0.076（二影），**变暗时彩度略升**；藤壶亮档是低彩度的暖奶油（C 0.029、h 78°），阴影换成薰衣草（C 0.038、h 305°），彩度也略升——HSL 读数却是 0.42→0.13，看上去像大幅褪色；海草一影、二影的 C 是亮档的 80% 和 68%；**青铜二影的 C 只剩亮档的 32%（0.085→0.027），接近灰**，而 HSL 读数 0.26→0.20 把这个问题掩盖了，需看片确认是否发灰（F9）。
- 矿物色"在逆光暗面里也要认得出颜色，所以阴影色调比鲲浅、冷得少"（`src/toon_peng.js:31-35`）。
- 锈斑保色相：`patchLayer({ rust: 'tint' })` 是固有色乘色调，而不是混成锈色（`src/toon_qinglv.js:6`、`src/toon_qinglv.js:36`、`engine/shade/surface.js:15-18`）。
- 身份色：金线在暗档乘 `goldShade`，"偏冷、压暗，但保持金"（`src/toon_qinglv.js:41`、`src/toon_qinglv.js:60-62`）；玄鲲金箔用暖色阴影档，不发灰发蓝（`src/toon_xuan.js:9`、`src/toon_xuan.js:68`、`src/toon_xuan.js:98-106`）。
- 北冥代码动画风格 · 86 式（C 路线）的历史案例给了"色指定"的完整写法：白天为标准色，按时段换算，**肤色每套手指定**（避免乘法把脸染粉），强调色在所有套里保持饱和（`cases/source/style-27-cel-anime-80s/pal.js:1-2`、`cases/source/style-27-cel-anime-80s/pal.js:34-39`、`cases/source/style-27-cel-anime-80s/pal.js:50-58`）。这套结构和"肤色手指定"来自 `$甲/styles/cel-anime-80s/demo/pal.js:32-54`（见本章出处段）；该案例是 `historical-render`，出过片不等于认可，且是 Canvas 实现，不是 WebGL 着色器。

### 判据 6 · 天光只进暗部，反射光作补光

【通用工艺】天空是大面积冷色面光源：亮面被主光主导，看不出天光；只有暗部里朝天的面显出冷色。地面、水面、城市灯海的反射是来自下方的暖补光，分两档最像手绘。

【仓库实证】
- 天光遮罩乘了 `m1`，只进阴影档里朝天的面（`engine/shade/toon.js:130-135`），阈值默认写死 0.3，只有开了 `skyStepUniform` 的族才能调 `skyStep`（`engine/shade/toon.js:99`、`engine/shade/toon.js:221`，开的例子：`src/toon_peng.js:57`）。
- 下方补光两档量化：`fillW1` 是第一档权重，`fillStep / fillStep2` 两道阈值（`engine/shade/toon.js:137-142`）；`fillFlat` 在"乘固有色 ×2.4"和"平涂补光色"之间插值，并保留 55% 的斑块明暗（`engine/shade/toon.js:143-144`）。
- 在《北冥》里补光就是城市灯海的暖光（`src/toon.js:26-28`、`src/toon.js:47`），对应定调"城市灯海：钠灯橙…自下而上，假的暖"（`docs/作品.md:60`）。
- 镜头级"作弊"：镜头 C 仰拍时腹部法线只有约 0.8 朝下，把两档阈值放低，让腹沟映成暖橙，只改本镜头（`src/shotC.js:79-81`）。全局强度用 `setToonGlobals({ fillGain })`：镜头 A 0.55（`src/shotA.js:142`）。

### 判据 7 · 边缘光把主体从背景剥离

【通用工艺】边缘光要有方向（只在背光侧或迎光侧）、有宽度变化、颜色和背景拉开（紫色天空前用粉、桃、暖金）；不能是全身均匀发亮的菲涅尔描边。细薄物体要单独压低，否则整片被边缘光吃掉。

【仓库实证】
- 两种边缘光：背光侧 `rim*`（`hlv` 越小越宽）与受光侧 `rimLit*`（`hlv` 越大越宽，且乘投影可见度，投影里不出）（`engine/shade/toon.js:147-160`）。宽度随朝向的变化见 §5.1 表。
- 背光侧边缘光的颜色保留 35% 的斑块明暗（`engine/shade/toon.js:162`），不会把锈斑抹平；受光侧边缘光是纯色（`engine/shade/toon.js:164`）。
- 双色亮芯 + 内沿噪声撕边（像收笔）：族要开 `rimCore: true`（`engine/shade/toon.js:150-165`、`src/toon_refine.js:10`、`src/toon_refine.js:46-49`、`src/toon_refine.js:74-76`）；原版族不会因为传了亮芯参数就多出这个分支（`docs/routes/beiming-style.md:79`）。
- 鲲：背光侧粉 `#F2A0A6`、受光侧桃 `#FFD3B0`，对着 `#4F5BBF / #9C8FD8` 的天空（`src/toon.js:15-17`、`src/toon.js:65-66`）。
- 防滥用：浮雕纹只改着色法线，边缘光用原始法线，"免得每条纹带都起亮边"（`src/toon_bronze.js:6`、`src/toon_bronze.js:83`、`src/kun_bronze.js:364`）；瀑布、云用 `toonSoftRim` 自己控制（`src/toon_qinglv.js:11`、`src/toon_qinglv.js:63`）；薄绸直接关背光侧 rim（`src/toon_xuan.js:88`）。

### 判据 8 · 线：粗细、断线、颜色与"沸腾"

【通用工艺】外轮廓粗、内部线细、远处更细更淡；同一物体的部件交界按需断线；线不用纯黑，传统赛璐璐讲究"色线"，线色取所在色块的深色版；暗部的线要比底色更深一档才看得见。手绘线按拍"沸腾"：沸腾来自每重描一张就抖一次，所以**沸腾节拍等于该物体的绘制节拍**——一拍三的角色，身上的线也一拍三换形；环境与底板上的线可以另定。一个停帧的物体不应在自己的两张画之间抖线。

【仓库实证】
- 断线依据：ID 跳变（4 邻域，近的一侧拥有这条线；深度几乎相同时固定让 ID 大的一侧画，避免双线锯齿）+ 1/z 二阶差分的深度折痕（平面恒为 0，掠射地面不误报）（`engine/look/ink.js:41-58`）。
- 粗细层级：两侧深度相对差大于 `silhouette 0.12` 算外轮廓，否则按 `inner 0.55` 变细；`near/far/farScale` 让线随深度变细（`engine/look/ink.js:67`、`src/look.js:31-35`）。镜头 A `300/3000/0.6`、镜头 C `90/700/0.55`（`src/shotA.js:147`、`src/shotC.js:205`）。
- 笔压 ±35%（`engine/look/ink.js:87-88`、`src/look.js:29`），偶尔断线 `breakup 0.1`（`engine/look/ink.js:101`、`src/look.js:30`），低频域扭曲抖动 `wobble 1.2 / warp 70`（`engine/look/ink.js:81-86`、`src/look.js:26-28`）。
- 沸腾：种子 `floor(t × boilFps)`，`boilFps 12` 即一拍二（`engine/look/ink.js:2`、`engine/look/ink.js:128`、`src/look.js:27`）；材质里画的线（嘴线、腹褶、眼周皱纹）用 `uInkTime = floor(帧/2)` 同拍抖动（`src/kun.js:183`、`src/kun.js:191-202`、`src/shotA.js:142`、`src/shotC.js:198`）。**已知偏差**：鲲的姿态一拍三（`src/shotC.js:165`），身上的线却跟全场墨线时钟一拍二，变化节奏成 2-1-1-2 的干涉（[animation.md §2.8](animation.md)），是否保留由看片决定；分轨的修法见 §8。
- 线色：深蓝灰 `#2A2D52` 不用纯黑（`src/look.js:25`）；`tint 0.15` 吸一点底色，`darken 0.5` 保证暗部的线取"底色 × 0.5"（`engine/look/compose.js:29-30`、`src/look.js:37-38`）。
- 断线控制：同组共用一个 ID（组内相接不出线）`outlineGroup`；实例群 `outlinePerInstance:false` 只描外轮廓（`engine/look/ids.js:12-13`、`engine/look/ids.js:119-124`）；卡通材质的 `instanceId:false` 会通过 `bind` 写成 `outlinePerInstance:false`（`engine/shade/toon.js:273`、`engine/shade/patch.js:70`），海藻团就这样只描团的外轮廓（`src/kun.js:351`）。
- 底板不描边（`engine/stage/plates.js:2`、`engine/stage/plates.js:33`）；透明云片按 alpha 半挡线（`engine/look/ids.js:14-15`）。
- 线叠在 Kuwahara 之后，笔触抹不糊它（`engine/look/index.js:6`、`engine/look/compose.js:2`）——**但只对屏幕墨线成立**，材质内画的线在 Kuwahara 之前（见失败模式 F16）。

【未实现】屏幕墨线的逐物体线色（`ids.js` 输出只有 ID、线宽系数、可见度，`engine/look/ids.js:2`；墨色是整帧一个 + 吸底色）；正片里的法线折痕线（只在实验页 `lab/kun.js:82`）；按受光方向调线宽。

### 判据 9 · 颜料笔触与纸纹的分寸

【通用工艺】笔触和纸纹是最后一层"材质感"：主体（尤其是脸）笔触小，远景和底板笔触大；笔触不能吃掉线和高光点；纸纹低对比、以中灰为中性；颗粒在高光处减弱。分寸靠"开/关对照"判断。

【仓库实证】
- Kuwahara：8 扇区、`q` 控制扇区选择锐度，按深度在近/远半径间过渡（`engine/look/kuwahara.js:1-2`、`engine/look/kuwahara.js:30-34`）。各镜头近/远半径：A `3/6.5`，B（人物）`1.6/6`，C `4/7`（`src/shotA.js:148`、`src/shotB.js:60`、`src/shotC.js:206`）。手册：人物面部不能被与远景云层相同的大半径抹平（`docs/routes/beiming-style.md:128`）；人物层用"彩色层 + 只写深度的遮罩"让后期按深度区分笔触（`engine/stage/plates.js:10`、`src/shotB.js:2-3`）。
- 灯点保护：调色把 HDR 最大通道在 `[1.05, 1.6]` 的像素写进 alpha，Kuwahara 在那里保留原图（`engine/look/grade.js:20-24`、`engine/look/kuwahara.js:44`、`engine/look/kuwahara.js:67`、`src/look.js:41`）。
- 纸纹：外部纸纹图的均值自动当中性点（`engine/look/paper.js:41-46`）；程序化纸纹以 0.5 为中性、对比很低（`engine/look/paper.js:2`、`engine/look/paper.js:25-31`）；叠加是乘法 `c *= 1 + strength·2·(纸 − 中性)`（`engine/look/compose.js:33-36`），镜头里强度 0.12–0.14。
- 颗粒：三角分布，亮部减半（`engine/look/compose.js:42-47`），镜头里 0.65（注意是着色器输入量，不是 65% 不透明度，`docs/routes/beiming-style.md:126`）。
- 物体空间的干笔笔触/颜料颗粒按屏幕频率自动淡出（`engine/shade/surface.js:103`、`engine/shade/surface.js:114-128`），精修鲲 `strokeAmt 0.075`、`grainAmt 0.04`（`src/toon_refine.js:72`）——量都很小。
- 出片不用 AI 超分：会在平涂区"凭空长出蚯蚓状纹理"（`docs/渲染与4K.md:11`、`docs/渲染与4K.md:66`）。

### 判据 10 · 用色板锁定代替色调映射

【通用工艺】风格化画面的颜色关系是设计出来的；电影式色调映射会压饱和、改色相，冲淡色板。做法是线性工作流 + 不做色调映射 + 颜色绝对给定 + 后期只做受控调色。

【仓库实证】
- 渲染器 `NoToneMapping`、输出 sRGB（`engine/stage/film.js:2`、`engine/stage/film.js:25`）；后期里的 OutputPass 跟随渲染器的设置，`NoToneMapping` 时只做 sRGB 转换（依赖源码行号见 §9）。`engine/look/index.js:6` 注释写的"色调映射 + sRGB"在本片设置下只剩 sRGB 这一步。
- 材质颜色绝对给定（`engine/shade/toon.js:4`），`tintFrom` 在线性空间求比值 → **调色之前，一档阴影像素精确等于设计的阴影色**【推断：由 `engine/shade/toon.js:46-49`、`engine/shade/toon.js:129` 推出】。
- 高光不用色调映射压，用调色的"高光肩"`shoulder 0.9`，大部分保色相（`engine/look/grade.js:33-39`、`src/look.js:43`）。
- 底板自带空气透视，不吃雾、不做色调映射（`engine/stage/plates.js:28-30`）。
- 手册提醒：经过补光、雾、调色和编码，最终像素不必等于输入十六进制值（`docs/routes/beiming-style.md:77`）。
- 渲染器设置、贴图色彩空间、OutputPass 前后各在哪个空间算，统一以 [threejs.md §2](threejs.md) 为准；帧离开浏览器之后的色彩（JPEG、YUV 矩阵与范围、标签）见 [video.md §4](video.md)。

### 判据 11 · 按镜头的色彩脚本（色指定）

【通用工艺】全片先有色彩脚本（每段的主色与情绪），再落成每个镜头的色指定（亮/影/线/高光色）；同一角色换光照时按色指定换色，而不是整帧套滤镜；强调色在每套色指定里都要跳出来。

【仓库实证】
- 色彩脚本："由冷到暖"五段：雾夜、城市灯海（假的暖，自下而上）、月光下江、关灯、日出（真的暖，从背后来）（`docs/作品.md:55-65`）。10 秒样片只落了"日出"这一段。
- 落成参数的方式有三层：镜头的 `look(t)`（`src/shotA.js:145-152`、`src/shotB.js:55-65`、`src/shotC.js:201-211`，汇总见 `docs/routes/beiming-style.md:112-126`）；每帧 `setToonGlobals`（`src/shotA.js:142`、`src/shotC.js:198`）；镜头内改材质 uniform（`src/shotC.js:79-81`）。
- 镜头 C 片尾（9–10 秒）是一段写在代码里的色彩脚本：城市补光 `fillGain 1 → 0.62`（假暖退场），材质曝光 `1 → 1.12`、调色暖度 `0.12 → 0.2`、曝光 `1 → 1.2`、bloom `0.6 → 1.05`、暗角 `0.24 → 0.16`（真暖登场）（`src/shotC.js:4`、`src/shotC.js:197-210`）。
- C 路线案例的色指定写法见判据 5 的 `pal.js`（白天、午后、夕阳、逆光四套，同一构图换一套色指定重画是该片的收尾手法，`cases/source/style-27-cel-anime-80s/TREATMENT.md:39`）。

【未实现】A 路线没有"色指定表 / 风格版本"数据结构；`docs/routes/templates/project-beiming.json` 写明渲染器不读它（`docs/routes/templates/project-beiming.json:2`），风格版本是计划任务 T06（`docs/routes/work-breakdown.md:136`）。

### 判据 12 · 节拍：让着色"活"在拍子上

【通用工艺】有限动画的质感一半来自节拍：角色一拍二/三，镜头和自然现象每帧动；线的沸腾跟角色拍；交界线和投影只在姿态变化的那一拍变。

【仓库实证】分层时钟从整数帧号出发（`engine/core/clock.js:1-3`、`engine/core/clock.js:11-15`）；鲲一拍三（`src/shotA.js:103`、`src/shotC.js:165`）；墨线一拍二（上文）；导演定调的帧节奏表（`docs/作品.md:74-84`）。看沸腾节拍用 `?test=look&still=1`（`lab/look.js:9`、`lab/look.js:271`）。 每条轨道的 n、切换锚点与混叠规则见 [animation.md §2](animation.md)。

---

## 3. 参数地图：概念 → 仓库里真实的参数

### 3.1 材质参数（`engine/shade/toon.js:52-71` 的 `TOON_BASE`，各片在自己的 `*_DEFAULTS` 上覆盖）

| 概念 | 参数 | 公式位置 | 说明与陷阱 |
|---|---|---|---|
| 亮档颜色 | `color`、`litTint` | `toon.js:129` | 亮档 = 固有色 × litTint；实例色物体 `color` 用白色，颜色来自实例 |
| 一影 / 二影颜色 | `shade1/shade2`（单色物体）或 `shade1Tint/shade2Tint`（实例色） | `toon.js:54-55`、`toon.js:203-204` | 给了 `shade1` 就忽略 `shade1Tint`；用 `tintFrom(代表亮色, 代表影色)` 生成色调 |
| 交界线位置 | `step1`、`step2` | `toon.js:56-57`、`toon.js:121-127` | 作用在 `hl = 0.5·N·L+0.5` 上；`step1` 用含投影的 `hlS`，`step2` 用不含投影的 `hl` |
| 交界过渡宽 | `feather1/feather2` | `toon.js:123`、`toon.js:126` | **小于族的 `featherMin` 会被截掉**（`toon.js:210`）：原版族 0.015、精修 0.01、玄鲲 0.004 |
| 投影深浅 | `shadowDepth`、`castShade` | `toon.js:58`、`toon.js:122-125` | `castShade 1` 投影一律进一档；<1 时只压 hl |
| 投影边硬度 | `shadowLo/shadowHi` | `toon.js:59`、`patch.js:42-47` | 窗口越窄越像色块 |
| 交界线抖动 | `edgeNoise`、`edgeNoiseScale` | `toon.js:60`、`toon.js:119` | 频率单位是"1/物体单位"：鲲名义长 600，换尺度要换算（§5.1、`docs/routes/beiming-style.md:79`） |
| 背光侧边缘光 | `rimColor/rimAmt/rimPower/rimInside/rimDirK` | `toon.js:152-155`、`toon.js:162` | `rimPower` 越大越宽，`rimInside` 越大越窄，`rimDirK` 越大越偏向背光面 |
| 受光侧边缘光 | `rimLitColor/rimLitAmt/rimLitPower/rimLitInside/rimLitDirK` | `toon.js:157-160`、`toon.js:164` | 乘投影可见度；默认 `rimLitAmt 0` 关闭 |
| 双色亮芯、撕边 | `rimColor2/rimCore/rimLitColor2/rimLitCore/rimBreak/rimNoiseScale` | `toon.js:150-165`、`toon.js:215-219` | **只有 `toonKind({ rimCore: true })` 的族才生效** |
| 下方补光 | `fillColor/fillAmt/fillStep/fillStep2/fillW1/fillFlat` | `toon.js:137-145` | 方向和全局倍率在共享参数 `fillDir/fillGain` |
| 天光 | `skyTint/skyAmt`（`skyStep`） | `toon.js:130-135` | `skyStep` 只在 `skyStepUniform: true` 的族里是参数，否则固定 0.3 |
| 材质内墨线 | `inkColor` + 钩子写 `toonInk` | `toon.js:167`、`toon.js:195` | 线宽由钩子里的 `fwidth` 决定（像素恒定，见 F16） |
| 不受光覆盖色 | 钩子写 `toonOverlay` | `toon.js:168`、`toon.js:196` | 眼睛高光就是这样贴在眼窝坐标上（`src/kun.js:129`、`src/kun.js:289-292`） |
| 描边权重 / 实例 ID | `outlineW`、`instanceId` | `toon.js:68`、`toon.js:267-276` | `outlineW` 经 `bind` → `outlineWeight` → `wireOutlines` → `outlineWidth`（`patch.js:69`、`engine/stage/outline.js:21`） |
| CPU 形变的纹样固定 | `rest: true` + `aRest` 属性 | `toon.js:70`、`toon.js:73-77` | GPU 形变不需要：`vToonObj` 取未变形的 `position` |
| 半透明 / 不进 ID 通道 | `translucent`、`noId` | `toon.js:176-178`、`toon.js:247-256` | 只影响 `uToonPass=1` 通道；正片 `ids.js` 看 `userData.outline` |

材质族（`toonKind(spec)`，`engine/shade/toon.js:9-14`、`engine/shade/toon.js:186-191`）：`name / shared / firstId / featherMin / bandAA / skyStepUniform / rimCore / depth / layers / pars / glsl / uniforms / vars / shade{rimNormal, bands, skyMask, afterSky, flatMask, afterFill, rimScale, rimLitColor, afterRim, final, passPre, passNormal}`。新光照函数一律写在这些钩子里，不要改引擎公式。

各变体已有的钩子变量：`toonRelief`（`src/toon_refine.js:106`）；`toonLift / toonPassN / toonRimN`（`src/toon_bronze.js:78-81`）；`toonGold / toonGlow / toonTrans / toonSoftRim`（`src/toon_qinglv.js:53-57`）；`toonMetal / toonGloss / toonTrans`（`src/toon_xuan.js:153`）；`toonMuralP / toonMuralK`（`engine/shade/surface.js:178-181`）。

### 3.2 全场共享参数（所有卡通材质共用一个对象）

`setToonGlobals({ fillDir, fillGain, skyDir, skyGain, keyDir, exposure, inkTime, pass })`（`src/toon.js:26-31`、`engine/shade/toon.js:25-44`）。所有变体材质引用同一个 `TOON_SHARED`（`src/toon_refine.js:3`、`src/toon_xuan.js:3-4`）。运行时调单个材质：`mat.userData.toon.uXxx.value`（`engine/shade/toon.js:19`）。

### 3.3 表面层（分档之前改反照率，`engine/shade/surface.js`）

| 层 | 入口 | 关键参数 |
|---|---|---|
| 斑块 | `patchLayer({ rust:'color'\|'tint', core, algaeK })`（`surface.js:14-69`） | `patchScale`、`rust*`、`algae*`、`spot*`、`dab*` |
| 绘画感 | `paintLayer`（`surface.js:71-162`） | 上面全部 + `patchStretch`、`rustBreak/Pool/Spatter/Dapple`、`spotCluster`、`dabWarm`、`stroke*`、`grain*` |
| 壁画风化 | `muralLayer`（`surface.js:164-217`） | `muralAmt/Scale/Ground`、`fleck*`、`chip*`、`fadeAmt`、`stainAmt`、`dotAmt` |

高频部分按"一个像素覆盖多少物体单位"自动淡出（`surface.js:103`、`surface.js:108`、`surface.js:120`、`surface.js:126`、`surface.js:134`、`surface.js:157`）。

### 3.4 后期（每帧参数 `p`，默认值在 `src/look.js:22-48`）

| 概念 | 参数 | 位置 |
|---|---|---|
| 墨线 | `outline { width, color, wobble, boilFps, warp, pressure, breakup, inner, silhouette, depthThreshold, near, far, farScale, opacity, tint, darken, fogFade }` | `engine/look/ink.js:13-17`、`engine/look/compose.js:8` |
| 物体级描边开关 | `userData.outline / outlineWidth / outlineAlpha / outlinePerInstance / outlineGroup / outlineOccluder / outlineVertex` | `engine/look/ids.js:8-19` |
| 把卡通材质接到描边 | `wireOutlines(root, { alpha, group })` | `engine/stage/outline.js:5-8` |
| 笔触 | `kuwahara { radius, strength, q, farRadius, farStart, farEnd, protect }` | `engine/look/kuwahara.js:7-9` |
| 调色 | `grade { exposure, warmth, lift, gamma, gain, saturation, shoulder }` | `engine/look/grade.js:7-8` |
| 纸、暗角、颗粒 | `paper { strength, scale, tex, mid }`、`vignette`、`grain` | `engine/look/index.js:28-29` |
| 分辨率标定 | `refHeight 1080`（像素量 × 输出高/1080）、`ss 2`（ID 图超采样） | `engine/look/index.js:11`、`engine/look/index.js:15` |
| 中间缓冲 | `debug: 'id'\|'depth'\|'edge'\|'line'\|'bloom'\|'paper'\|'kuwahara'\|'scene'` | `engine/look/index.js:31`、`engine/look/debug.js:6-7` |

---

## 4. 调参配方：想要 X → 调 Y 到 Z

数值全部取自仓库现有预设，括号里是出处。**这些是仓库里能跑的取值，不是已验证的审美结论。**"出处状态"写明取值来自原版样片（只有间接认可痕迹）、变体（认可状态没有书面记录，§0）还是引擎默认；"安全范围与副作用"只写已知的，空着的是没测过。同一时刻开、关两张对照帧，仓库里每一条都还没有（待出图）——新片用前先出对照帧（命令见 §7 第 9 步）。先改单一变量，再组合（`docs/routes/beiming-style.md:169`）。

| 想要 | 调什么 | 调到（出处） | 出处状态 | 安全范围与副作用 |
|---|---|---|---|---|
| 色块更干脆的赛璐璐 | `feather1/feather2`，并换 `featherMin` 更小的族 | 0.012 / 0.015，族下限 0.01（`src/toon_refine.js:40-41`、`src/toon_refine.js:105`） | 变体 | 小于族的 `featherMin` 会被截掉（`engine/shade/toon.js:210`）；运动中的抗锯齿靠 `fwidth × bandAA` 兜底（F1） |
| 漆器、墨玉那种刀切交界 | 羽化 + 族的 `featherMin/bandAA` | 0.006 / 0.006，下限 0.004，`bandAA 1.5`（`src/toon_xuan.js:81`、`src/toon_xuan.js:138`） | 变体 | 同上；网格粗时交界线呈台阶（F4） |
| 玉、瓷的温润过渡 | `feather1` | 0.05（`src/toon_bronze.js:70`） | 变体 | 过大时一影糊成渐变，色阶感消失【推断】 |
| 亮暗面积比（与光向、相机无关） | `step1` | 0.5 ≈ 90°（亮区约占半球）；0.53 ≈ 87°（约 47%，`src/toon.js:62`）；0.6 ≈ 78°（约 40%）；0.75 = 60°（约 25%）【复算：交界角 θ＝arccos(2·step1−1)，亮区占球面 (1−cosθ)/2】 | 样片（0.53） | 交界线不要正好平分主体（判据 4）；`step1` 只管面积，管不了"从镜头看亮面窄不窄" |
| 从镜头看亮面窄、要逆光感 | 主光方向 `keyDir` | 放到主体后方、仰角 5–10°（`src/shotA.js:53-55`、`src/shotC.js:110-112`），`step1` 不必动 | 样片 | 主体大半落进阴影档：一影色必须设计；明度分离不够时加墨线、边缘光、补光（判据 2） |
| 小白花、小物件更透气 | `step1` 降低让亮面绕到背面 | 0.42–0.45（`src/toon_refine.js:90`、`src/toon.js:75`） | 变体（0.42）、样片（0.45） | — |
| 二影只在最背光处 | `step2` | 0.06–0.17（`src/toon_xuan.js:81`、`src/toon.js:62`） | 变体（0.06）、样片（0.17） | 二影太少时暗部只剩一个色（F9） |
| 二影厚一些 | `step2` | 0.30–0.32（`engine/shade/toon.js:57`、`src/toon.js:41`） | 引擎默认、样片默认 | 二影过多会压暗、发脏【推断】 |
| 投影更像色块 | `shadowLo/shadowHi` | 0.44 / 0.56（`src/toon_refine.js:43`） | 变体 | 窗口越窄越像色块，也越容易在镜头运动时爬动（F8） |
| 羽毛、薄片投影别压死 | `castShade` | 0.7–0.8（`src/kun_peng.js:666`、`src/kun_peng.js:819`） | 变体 | 小于 1 时投影只压亮度、不强制进档 |
| 植物、青苔类的手绘交界 | `edgeNoise` | 0.04–0.05（`src/toon.js:71`、`src/toon_refine.js:83`） | 样片（0.04）、变体（0.05） | 交界线摆动约 ±2·edgeNoise 弧度（0.05 ≈ ±5.7°，§5.1）；近景大面积时偏脏【推断】 |
| 光滑器物交界干净 | `edgeNoise` | 0.02（`src/toon.js:68`、`src/toon_refine.js:78`） | 样片、变体 | — |
| 单色物体的影换色相 | 直接给 `shade1/shade2` | 鲲 `#4E5888 / #343D69`（`src/toon.js:62`），树皮 `#4C3D57 / #2E2A47`（`src/toon_refine.js:95`） | 样片、变体 | 用 §5.2 的 OKLCH 命令核对彩度没有掉 |
| 植被每株自带三档 | `color '#ffffff'` + `shade*Tint = tintFrom(代表亮, 代表影)` | 海草 `tintFrom('#8DB36A', weedA/weedB)`（`src/toon.js:69`） | 样片 | 同上 |
| 矿物色逆光里认得出 | 浅一点、冷得少的色调 | `[0.6,0.64,0.8] / [0.38,0.41,0.6]`（`src/toon_peng.js:35`） | 变体 | — |
| 锈斑不改固有色相 | `patchLayer({ rust:'tint' })` + `rustTint` | `[0.66,0.72,0.96]`（`src/toon_qinglv.js:36`、`src/toon_qinglv.js:49`） | 变体 | — |
| 背光侧粉色轮廓 | `rimAmt/rimColor/rimPower/rimInside/rimDirK` | 0.6、`#F2A0A6`、0.4、0.3、0.5（`src/toon.js:65`） | 样片 | 细薄物体会被整片吃掉（F11） |
| 迎光侧暖桃亮边 | `rimLitAmt/rimLitColor/rimLitPower/rimLitInside/rimLitDirK` | 1、`#FFD3B0`、0.55、0.1、0.55（`src/toon.js:66`） | 样片 | 乘投影可见度，投影里不出 |
| 亮芯 + 收笔撕边 | 族开 `rimCore` + 亮芯色 | `rimColor2 '#FFC9B0'`、`rimCore 0.16`、`rimLitColor2 '#FFF0D8'`、`rimLitCore 0.14`、`rimBreak 0.09`、`rimNoiseScale 0.09`（`src/toon_refine.js:74-76`） | 变体 | 只有 `toonKind({ rimCore: true })` 的族才生效（F25） |
| 薄绸不要背光 rim | `rimAmt / rimLitAmt` | 0 / 0.6（`src/toon_xuan.js:88`） | 变体 | — |
| 城市暖光从下映上来 | `fill*` + 共享 `fillDir` | `fillAmt 0.92, fillStep 0.6, fillStep2 0.94, fillW1 0.42, fillFlat 0.55`（`src/toon.js:64`）；`fillDir [0.08,-1,0.1]`（`src/shotA.js:142`） | 样片 | — |
| 仰拍镜头腹部也吃暖光 | 本镜头改材质 uniform | `uFillStep 0.38, uFillStep2 0.72, uFillW1 0.5, uFillAmt 1.0`（`src/shotC.js:79-81`） | 样片 | 只改本镜头；记进 style-lock 的 `allowedOverrides` |
| 暗部朝天的面偏冷 | `skyAmt/skyTint` | 0.75、`[0.8,0.88,1.18]`（`src/toon.js:48`、`src/toon.js:64`） | 样片 | `skyStep` 只在开了 `skyStepUniform` 的族里可调（F25） |
| 片尾"真日光"登场 | 共享 + 调色 + bloom 同步过渡 | 见判据 11（`src/shotC.js:197-210`） | 样片 | — |
| 手绘墨线基准 | `outline` | `width 2.6, color #2A2D52, wobble 1.2, boilFps 12, warp 70, pressure 0.35, breakup 0.1, inner 0.55`（`src/look.js:24-31`） | 样片 | 4K 下 `width × 最大 outlineWidth` 超过约 2.69 会碰到笔画搜索上限（F17） |
| 远景线细且淡 | `near/far/farScale` + 整棵树的线透明度 | `300/3000/0.6` + `wireOutlines(..., { alpha: 0.5 })`（`src/shotA.js:147`、`src/shotA.js:60`） | 样片 | — |
| 植被团只描外轮廓 | `instanceId:false` + 细一点 | `outlineW 0.45`（`src/kun.js:351`） | 样片 | — |
| 部件相接处不出线 | 正片用 `outlineGroup`（或 `wireOutlines` 的 `group` 映射） | `engine/look/ids.js:13`、`engine/stage/outline.js:7`、`engine/stage/outline.js:23` | 引擎 | — |
| 人脸笔触小、天空笔触大 | `kuwahara` 近/远半径与过渡距离 | `1.6 / 6 / 30 / 60`（`src/shotB.js:60`） | 样片 | 半径按输出高度/1080 放大；原生 4K 下会抹掉材质内画线（F16） |
| 灯点不被抹成星形 | `kuwahara.protect` | `[1.05, 1.6]`（`src/look.js:41`） | 样片 | 只保护 HDR 最大通道落在区间里的像素 |
| 纸感 | `paper / vignette / grain` | 0.12–0.14 / 0.22–0.26 / 0.65（`src/look.js:45-47`、`src/shotA.js:151`、`src/shotB.js:63`、`src/shotC.js:209`） | 样片 | `grain 0.65` 是着色器输入量，不是不透明度；外部纸纹按输出像素平铺，4K 下变细（video §3.3） |
| 暗部带紫、不死黑 | `grade.lift` | `[0.035,0.022,0.06]`（`src/look.js:43`）；镜头里 `[0.02,0.012,0.045]`（`src/shotA.js:150`） | 样片 | — |
| 过曝仍保色相 | `grade.shoulder` | 0.9（`src/look.js:43`） | 样片 | — |
| 金线在暗档仍是金 | 钩子 `toonGold` + `goldShade` | `[0.6,0.5,0.58]`（`src/toon_qinglv.js:41`、`src/toon_qinglv.js:60-62`） | 变体 | — |
| 玉、松石逆光里也透 | 钩子 `toonLift` | 0.38–0.6（`src/kun_bronze.js:358`、`src/kun_bronze.js:688`） | 变体 | — |
| 浮雕只改着色，不起亮边、不进实验页描边 | 钩子 `toonRimN/toonPassN` = 未扰动法线 | `src/kun_bronze.js:363-364`、`src/toon_bronze.js:83-87` | 变体 | — |

---

## 5. 推导与实测

### 5.1 把阈值换算成几何含义【仓库实证·复算】

算法：只按 `engine/shade/toon.js:121-160` 的公式做算术，不渲染（研究期脚本未入库，用下面的换算式可在任何环境重算）。

色阶阈值 → 与主光的夹角（`N·L = 2·hl − 1`），羽化 → 交界处的角宽（参数下限；实际不小于 `fwidth × bandAA`）：

| 预设 | 亮/一影交界 | 一影/二影交界 | feather1 角宽 | feather2 角宽 |
|---|---|---|---|---|
| 引擎中性 `TOON_BASE` | 84.3° | 113.6° | 2.3° | 3.8° |
| 北冥 `TOON_DEFAULTS` | 83.1° | 111.1° | 2.3° | 3.7° |
| `TOON_PRESETS.kun` | 86.6° | 131.3° | 2.3° | 4.6° |
| seaweed | 90.0° | 136.1° | 2.3° | 5.0° |
| anemone | 95.7° | 132.8° | 2.3° | 4.7° |
| 精修 flower | 99.2° | 136.1° | 1.4° | 2.5° |
| 青铜默认 | 86.6° | 143.1° | 2.3° | 5.7° |
| 鲲鹏默认 | 86.6° | 139.5° | 2.3° | 5.3° |
| 青绿默认 | 86.6° | 126.9° | 2.3° | 4.3° |
| 玄鲲 body | 86.6° | 151.6° | 0.7° | 1.4° |

边缘光出现范围（忽略 `edgeNoise`；数值是"N·V 小于多少时出现"，越大越宽）：

| 边缘光 | 指数 | 背光面（hlv=0） | hlv=0.5 | 迎光面（hlv=1） |
|---|---|---|---|---|
| 引擎中性背光侧 | 5.28 | 0.15 | 0.10 | 0.06 |
| 鲲背光侧（粉） | 3.48 | 0.29 | 0.16 | 0.06 |
| 精修鲲背光侧 | 3.34 | 0.32 | 0.18 | 0.08 |
| 鲲受光侧（桃） | 2.55 | 0.16 | 0.32 | 0.59 |
| 精修鲲受光侧 | 2.39 | 0.18 | 0.35 | 0.65 |
| seaweed 受光侧 | 2.83 | 0.14 | 0.28 | 0.49 |

其它换算：主光仰角 镜头 A 6.9°、自测页 5.8°、镜头 C 7.0°；`edgeNoise` 让交界线在 90° 附近摆动约 `±2·edgeNoise` 弧度，即 0.02→±2.3°、0.03→±3.4°、0.05→±5.7°（噪声幅度按"约 [-1,1]"计，`engine/shade/noise.glsl.js:5`）。`edgeNoiseScale 0.06` 在 600 单位长的鲲上约 36 个起伏；资产换成 30 米量级时需按比例放大频率【推断】（尺度差异见 `docs/routes/beiming-style.md:79`）。

### 5.2 阴影色实测：用 OKLCH，不用 HSL【仓库实证·复算】

```sh
# 在仓库根执行（依赖已安装）；只用仓库自己的 toColor（engine/look/params.js:13-18，返回线性 sRGB）和 OKLab 公式
node --input-type=module -e "import { toColor } from './engine/look/params.js'; const ok = h => { const c = toColor(h), cb = Math.cbrt; const l = cb(.4122214708*c.r+.5363325363*c.g+.0514459929*c.b), m = cb(.2119034982*c.r+.6806995451*c.g+.1073969566*c.b), s = cb(.0883024619*c.r+.2817188376*c.g+.6299787005*c.b); const L = .2104542553*l+.793617785*m-.0040720468*s, a = 1.9779984951*l-2.428592205*m+.4505937099*s, b = .0259040371*l+.7827717662*m-.808675766*s; return [L, Math.hypot(a,b), (Math.atan2(b,a)*180/Math.PI+360)%360]; }; for (const [a,b] of [['#6E7BA8','#4E5888'],['#6E7BA8','#343D69'],['#E9DCC9','#9A8FA8'],['#8DB36A','#5E8A5A'],['#8DB36A','#3E6B4A'],['#8fae76','#567c60'],['#8fae76','#33484c'],['#4F5BBF','#4E5888']]) { const x = ok(a), y = ok(b); console.log(a, '->', b, 'L', x[0].toFixed(3)+'->'+y[0].toFixed(3), 'C', x[1].toFixed(3)+'->'+y[1].toFixed(3), 'h', Math.round(x[2])+'->'+Math.round(y[2]), 'C比', (y[1]/x[1]).toFixed(2)); }"
```

| 亮 → 影 | OKLab L | OKLCH 彩度 C（影/亮） | 色相 h | HSL 饱和度（只作对照） | 出处 |
|---|---|---|---|---|---|
| 鲲 `#6E7BA8 → #4E5888`（一影） | 0.590 → 0.473 | 0.071 → 0.079（1.11） | 272° → 274° | 0.25 → 0.27 | `src/toon.js:17` |
| 鲲 `#6E7BA8 → #343D69`（二影） | 0.590 → 0.374 | 0.071 → 0.076（1.08） | 272° → 273° | 0.25 → 0.34 | `src/toon.js:17` |
| 藤壶 `#E9DCC9 → #9A8FA8` | 0.900 → 0.668 | 0.029 → 0.038（1.32） | 78° → 305° | 0.42 → 0.13 | `src/toon.js:18` |
| 海草 `#8DB36A → #5E8A5A`（一影） | 0.721 → 0.588 | 0.108 → 0.086（0.80） | 131° → 142° | 0.32 → 0.21 | `src/toon.js:18`、`src/toon.js:69` |
| 海草 `#8DB36A → #3E6B4A`（二影） | 0.721 → 0.485 | 0.108 → 0.073（0.68） | 131° → 151° | 0.32 → 0.27 | 同上 |
| 青铜 `#8fae76 → #567c60`（一影） | 0.713 → 0.550 | 0.085 → 0.061（0.72） | 132° → 152° | 0.26 → 0.18 | `src/toon_bronze.js:20-22` |
| 青铜 `#8fae76 → #33484c`（二影） | 0.713 → 0.386 | 0.085 → **0.027（0.32）** | 132° → 211° | 0.26 → 0.20 | 同上 |

读法：HSL 说藤壶"褪色最厉害"、青铜二影"只小降"，OKLCH 正好相反——藤壶的彩度其实略升，青铜二影的彩度掉到亮档的三分之一，接近灰。按判据 5 的建议门槛（≥ 约 70%），海草二影刚好在线下，青铜二影明显在线下，列为看片重点。

`tintFrom` 的线性比值（同一套色值，可用 `engine/shade/toon.js` 的 `tintFrom` 复算）：鲲一影 `(0.489, 0.493, 0.629)`、二影 `(0.220, 0.236, 0.361)`（源码注释写的是"约 (0.47, 0.48, 0.63)"，`src/toon.js:22`）；藤壶 `(0.397, 0.384, 0.670)`；青铜二影 `(0.121, 0.153, 0.399)`——蓝通道比值始终最高，阴影整体往冷色走。

**主体与背景的明度差**（同一条命令的最后一行）：鲲一影 `#4E5888` 的 L 是 0.473，天顶 `#4F5BBF` 是 0.515，ΔL 只有约 0.04。逆光里观众看到的鲲主色就是一影，所以灰度里鲲背和天空并在一起，样片的可读性靠墨线、暖补光和色相差承担（VISUAL-DESIGN §3）。

### 5.3 原生 4K 下材质内画线被 Kuwahara 抹掉【仓库实证·实测】

```sh
OUT=<你的输出目录>
node engine/render/still.mjs . 7.5 --size 1920x1040 --query "dbg=kuwahara&nohud=1" --out $OUT --prefix kuwa1080_
node engine/render/still.mjs . 7.5 --size 3840x2080 --query "dbg=kuwahara&nohud=1" --out $OUT --prefix kuwa4k_
node engine/render/still.mjs . 7.5 --size 3840x2080 --query "dbg=scene&nohud=1"    --out $OUT --prefix scene4k_
# 同一画面区域：1080 取 crop=700:380:800:440；4K 取 crop=1400:760:1600:880 再缩到 700×380 对比
```

结果：镜头 C 第 7.5 秒的鲲腹褶沟线（材质钩子里画的 `toonInk`，`src/kun.js:200-202`）在 1080 的 Kuwahara 输出里清楚可见；4K 的场景缓冲（`dbg=scene`）里也在；**4K 的 Kuwahara 输出里几乎消失**。屏幕墨线（藤壶轮廓）两种分辨率都正常。对照图在本次工作区 `<研究工作区>/experts/notes/res/cmp_kuwa_1080_vs_4k.png` 与 `cmp_scene_kuwa_4k.png`（临时目录，入库请重跑上面的命令）。

原因【推断，与实测一致】：材质内的线宽用 `fwidth` 定，恒为约 1–3 个输出像素（`src/kun.js:191`、`src/kun.js:200`）；Kuwahara 半径却按输出高度/1080 放大（`engine/look/kuwahara.js:79`），镜头 C 近景半径 4 在 4K 变成约 7.7 像素（`src/shotC.js:206`）。Kuwahara 会抹掉比半径细的细节，而材质线在 Kuwahara 之前（只有屏幕墨线叠在之后，`engine/look/index.js:6`）。`docs/渲染与4K.md:62-66` 的 4K 对比看的是屏幕墨线、小字和纸纹，没有覆盖这类线。

---

## 6. 失败模式表

### 6.1 技术失败

| # | 现象 | 原因 | 仓库里的手段 | 状态 |
|---|---|---|---|---|
| F1 | 色阶边界锯齿，运动时闪 | 羽化小于一个像素；MSAA 只抗几何边，不抗着色器里的分档边【通用工艺】 | 羽化取 `max(给定, fwidth × bandAA)`（`engine/shade/toon.js:120-126`）；天光/补光/边缘光同样有 `fwidth` 下限（`toon.js:133`、`toon.js:140`、`toon.js:153`、`toon.js:158`）；玄鲲把 `bandAA` 提到 1.5（`src/toon_xuan.js:6`） | 已有 |
| F2 | 远处斑块、笔触、斑点闪烁或出摩尔纹 | 高频纹理频率超过像素 | 表面层按像素覆盖量淡出（`engine/shade/surface.js:103`、`surface.js:108`、`surface.js:120`、`surface.js:126`、`surface.js:134`、`surface.js:144`、`surface.js:157`）；`toonAA`、`toonFar`（`engine/shade/util.glsl.js:24-26`、`util.glsl.js:39-41`） | 已有 |
| F3 | 纹样随形变"滑动"，交界线噪声游移 | 噪声坐标取了变形后或世界坐标 | `vToonObj` 取未变形的 `position`（`engine/shade/toon.js:73-77`）；CPU 形变用 `rest:true` + `aRest`（`engine/shade/toon.js:18`、`src/toon_peng.js:5`）；法线与位置同步弯（`engine/form/bend.js:36-40`） | 已有 |
| F4 | 交界线呈锯齿台阶、形变时"爬" | 网格太粗，插值法线把交界线切成折线【通用工艺】；姿态每帧都变 | 提高细分（鲲 `NU 90–230 / NV 56–128` 随 lod，`src/kun.js:165`）；姿态按拍保持，交界线只在换拍时变（`engine/core/clock.js:13`、`src/shotC.js:165`） | 部分 |
| F5 | 投影和形体对不上；描边不跟形变 | 彩色、深度、ID 三个通道的顶点形变不一致 | `bind` 自动挂同形变的阴影深度材质（`engine/shade/toon.js:260-276`、`engine/shade/patch.js:51-61`）；`wireOutlines` 把顶点钩子交给 ID 图（`engine/stage/outline.js:14-20`、`engine/look/ids.js:16-17`）；手册要求三通道同形变（`docs/routes/beiming-style.md:38`） | 已有（忘了调用就会坏） |
| F6 | 阴影痤疮、条纹 | 深度偏移不够、阴影相机罩得太大 | `fitShadow`：阴影相机紧罩主体，`normalBias = 1.5 × 缩放`、`bias -0.0005`，近景 4096、远景 2048（`src/kun.js:519-533`、`src/shotC.js:174`、`src/shotA.js:110`）；同处写的 `radius 2` 在正片的 PCFSoft 下不起作用（[threejs.md §5](threejs.md)） | 已有（只在鲲上） |
| F7 | 投影边软糊，和色阶语言不一致 | PCF 软阴影的渐变直接进画面 | 投影量化 `shadowLo/Hi`（`engine/shade/patch.js:42-47`） | 已有 |
| F8 | 投影边在镜头运动时轻微爬动 | 阴影相机随主体重摆，阴影贴图像素没对齐【通用工艺】 | 主体按拍保持时阴影相机也只在换拍时动（`src/shotC.js:165-174`）；高分辨率阴影贴图 | 部分；阴影相机按像素对齐【未实现】 |
| F9 | 暗部发脏、发灰 | 阴影靠压暗得到；投影进了最深档；暗部只剩一个色 | 换色相的 `shade1/2`（判据 5）；投影只进一档（`engine/shade/toon.js:122-127`）；天光只进暗部（`toon.js:130-135`）；`lift` 带紫（`src/look.js:43`） | 已有（靠调色板） |
| F10 | 逆光主体一片死暗不可读 | 一影色没设计；没有补光和边缘光 | 一影当主色设计（`src/toon_bronze.js:21`）；补光、天光、两种边缘光（判据 6、7） | 已有 |
| F11 | 全身像菲涅尔一样发亮；细薄物体整片被边缘光吃掉 | 边缘光只看 N·V，薄片和掠射面 N·V 处处很小【推断】 | 逐材质压 rim（薄绸 `rimAmt 0`，`src/toon_xuan.js:88`；小花 `rimInside 0.55`，`src/toon_refine.js:90`）；`toonSoftRim`（`src/toon_qinglv.js:63`） | 部分；按屏幕厚度自动限宽【未实现】 |
| F12 | 浮雕纹每条都起亮边或多出描边 | 扰动后的法线也进了边缘光和法线描边 | `toonRimN / toonPassN` 用未扰动法线（`src/toon_bronze.js:5-6`、`src/toon_bronze.js:83-87`、`src/kun_bronze.js:363-364`）；正片 ID 描边本来就不看法线 | 已有（青铜族） |
| F13 | 描边闪烁、抖得太快 | 每帧换抖动种子；线没有超采样 | `boilFps 12`（一拍二，`engine/look/ink.js:128`）；材质线同拍 `uInkTime = hold(f,2)`（`src/shotA.js:142`）；ID 图 2 倍超采样（`engine/look/index.js:11`、`engine/look/compose.js:28`） | 已有 |
| F14 | 两个部件穿插处出双线或锯齿 | 深度几乎相同，两侧轮流画 | 固定让 ID 大的一侧画（`engine/look/ink.js:48-49`）；或同组 `outlineGroup` | 已有 |
| F15 | 远景线条过密，实例群糊成一片黑 | 每个实例都有 ID，线宽不随距离变 | `instanceId:false` / `outlinePerInstance:false`（`src/kun.js:351`、`engine/look/ids.js:12`）；`near/far/farScale`（`src/shotA.js:147`）；整树线透明度（`src/shotA.js:60`）；低 LOD 少而大（`src/kun.js:147`）；雾里淡出（只在后期 `fog` 打开时，`engine/look/ink.js:64-65`） | 部分；按屏幕线密度自动简化【未实现】 |
| F16 | **原生 4K 下材质内画线（褶沟、嘴线、眼圈）消失或变细** | 材质线按 `fwidth` 定宽、不随分辨率缩放；Kuwahara 半径按高度缩放并在线之前执行 | 屏幕墨线、Kuwahara、纸纹已按 `refHeight` 标定（`engine/look/index.js:93`、`engine/look/paper.js:59`）；不要靠提高像素比放大（`docs/routes/beiming-style.md:128`） | 【仓库实证·实测】存在；材质线宽的分辨率标定、材质线免受 Kuwahara 的保护【未实现】 |
| F17 | 4K 下再加粗屏幕墨线，线被"削平" | 笔画搜索半径上限 8 个 ID 像素（`engine/look/ink.js:124`）；4K、`ss 2`、笔压 0.35 时，`width × 最大 outlineWidth` 超过约 2.69 就会碰到上限；正片 `2.6 × 1` 刚好在线内【推断】 | 暂无；1080 下上限约 5.38，余量大 | 【未实现】 |
| F18 | Kuwahara 把屏幕墨线抹糊 | 线在笔触之前合成 | 线在 Kuwahara 之后叠加（`engine/look/index.js:128-138`） | 已有 |
| F19 | Kuwahara 把灯点抹成星形 | 高亮小点被扇区平均 | `protect [1.05, 1.6]`（`engine/look/grade.js:24`、`engine/look/kuwahara.js:67`） | 已有 |
| F20 | 人脸被大笔触抹平 | 全画面同一半径 | 按深度换半径 + 人物层深度遮罩（`src/shotB.js:60`、`engine/stage/plates.js:10`） | 已有 |
| F21 | 暗部的线看不见 | 墨色比底色还亮 | `ink = min(墨色, 底色 × darken)`（`engine/look/compose.js:29`），`darken 0.5` | 已有 |
| F22 | 底板被描成矩形框；透明云片挡线不对 | 面片进了 ID 图 | 底板一律 `outline:false`（`engine/stage/plates.js:33`）；`outlineOccluder` 的 `soft/solid/own`（`engine/look/ids.js:14-15`、`engine/look/ids.js:131-145`） | 已有 |
| F23 | 调灯的颜色、强度、环境光，卡通材质毫无反应 | 设计如此：光照合成被整段替换 | 用色板、`fill*`、`sky*`、`exposure` 调（`engine/shade/toon.js:4`、`engine/shade/toon.js:170`；`docs/routes/beiming-style.md:61`） | 设计行为 |
| F24 | 色板被冲淡、偏色 | 开了色调映射，或底板吃了雾/色调映射 | `NoToneMapping`（`engine/stage/film.js:25`）；底板 `toneMapped:false, fog:false`（`engine/stage/plates.js:30`）；高光用 `shoulder` | 已有 |
| F25 | 传了参数但没效果 | 族不支持：`featherMin` 截断（`engine/shade/toon.js:210`）、没开 `rimCore`（`toon.js:215`）、没开 `skyStepUniform`（`toon.js:221`）、传了不存在的 `levels`（`docs/routes/beiming-style.md:94`） | 读族的 `toonKind` 参数；`mat.userData.toon` 里没有的 uniform 就是没生效 | 需人工核对 |
| F26 | 实验页调好的线、色，进正片走样 | 实验页用临时描边（`lab/kun.js:6`）或测试材质（`lab/look.js:38`），线宽写死渲染像素 | 进正片前用 `src/look.js` 管线复核：`?test=kun_qinglv_look`、`?test=kun_refine&post=look`（`lab/kun_qinglv_look.js:1-2`、`lab/kun_refine.js:6-7`） | 已有入口 |
| F27 | 实验页里两套材质之间的描边消失 | `uToonPass=1` 通道靠 `uObjectId` 分界，ID 段撞号 | 各族错开起始号：1 / 101 / 301 / 501 / 4001 / 5001（`src/toon.js:79`、`src/toon_refine.js:105`、`src/toon_qinglv.js:48`、`src/toon_peng.js:57`、`src/toon_xuan.js:138`、`src/toon_bronze.js:76`）；正片 ID 图自行编号，不受影响（`engine/look/ids.js:96`） | 已有 |
| F28 | 平涂区出现色带台阶 | 8 位中间缓冲【通用工艺】 | 主场景与后期中间缓冲用 HalfFloat（`engine/look/index.js:81`、`engine/look/pass.js:29`）；颗粒起抖动作用【推断】（`engine/look/compose.js:42-47`） | 部分 |

阴影相机、深度材质与形变一致的工程细节见 [threejs.md §3.4、§5](threejs.md)；墨线、笔触、纸纹的分辨率标定见 [video.md §3](video.md)。

### 6.2 审美失败

技术表里的问题都解决了，画面仍可能不好看。下表是三渲二最常见的审美失败；成因和修法属【通用工艺】，仓库里已有的手段注明出处。查法用 VISUAL-DESIGN §8 的"审美复核"（眯眼缩略图、水平翻转、5 秒复述、与基准帧并排）。

| # | 现象 | 常见成因 | 修法（仓库已有的注出处） | 怎么查 |
|---|---|---|---|---|
| A1 | CG 味、塑料感 | 角色一拍一的平滑插值；物理式高光；广角透视畸变；线宽处处一样；阴影形状碎 | 姿态按拍保持（判据 12；`src/shotC.js:165`）；按镜头修形，例如转身时收起会竖成一块板的远侧胸鳍（`src/shotC.js:170-172`）；用长焦减小透视；线宽按深度和轮廓分级（`near/far/farScale`、`silhouette/inner`，判据 8）；交界线形状简化（降 `edgeNoise`、提高网格细分） | 停帧放大看高光和交界线；与基准帧并排 |
| A2 | 画面平、没有层次 | 明度没有分组，主体、中景、背景的明度键接近 | 每段先定明度键与明暗面积比（VISUAL §2）；远层向雾色收拢（two-five-d §1.4） | 灰度缩略图 |
| A3 | 焦点乱 | 最高对比和强调色不在主体上 | 强调色只给 style-lock 里 `only` 写明的对象；暗角（`vignette`）把视线收向中心 | 眯眼缩略图；水平翻转 |
| A4 | 色彩脏、发灰 | 阴影靠压暗得到；暗部彩度掉得太多 | 换色相的 `shade1/2`（判据 5）；`grade.lift` 带一点紫（`src/look.js:43`） | §5.2 的 OKLCH 命令看彩度 C |
| A5 | 太满 | 近、中、远细节密度一样 | 先保证远中近景轮廓，再提细分（`docs/routes/beiming-style.md:36`）；低 LOD 时装饰少而大（`src/kun.js:147`）；远景线细且淡 | 眯眼缩略图里细节是否往主体集中 |
| A6 | 太空 | 只有主体，缺参照物和空气 | 加尺度参照（船、人、楼）和前后层遮挡（two-five-d §4.1） | 5 秒复述能否说出"有多大" |
| A7 | 动作飘 | 处处对称缓动、没有接触帧 | 见 [animation.md §6](animation.md) | 0.2 秒帧条 |
| A8 | 滤镜感 | 后期抢了形体：纸纹、颗粒、笔触比体积还显眼 | 关后期看灰模和反照率，再逐道加回（`docs/routes/beiming-style.md:140-147` 的六步顺序） | 关后期与开后期两帧并排 |

### 6.3 撮影（合成）层

二维动画在着色之后还有一道"撮影"：柔光与辉光、透光、渐变覆盖、光包裹、空气透视，把各层捏成同一个空间。原则是克制，形体优先——这一层用来让画面"在一个空间里"，不是用来补救形体【通用工艺】。

| 手段 | 仓库已有 | 未有【未实现】 |
|---|---|---|
| 柔光、辉光 | 后期 bloom（`engine/look/bloom.js:49`；镜头参数见 `src/look.js:42-43`）；加色辉光精灵 `glowSprite`（`engine/stage/plates.js:98`，用法 `src/shotA.js:50`） | — |
| 透光 | 青绿族的 `toonTrans` 钩子（`src/toon_qinglv.js:53-57`） | 通用的背光透射 |
| 渐变覆盖 | 暗角 `vignette`；调色 `grade` 的暖度与提亮（`src/look.js:42-47`） | 按镜头画的渐变遮罩层 |
| 光包裹 | 2D 画布层的 `lightWrap`（`engine/paint/light.js:52`，用法 `src/girl.js:592`） | 三维物体与底板之间、按真实背景取色的光包裹（[two-five-d.md §4.1](two-five-d.md)） |
| 空气透视 | 底板画进去；三维物体用 FogExp2，雾色取色板紫（[two-five-d.md §1.4](two-five-d.md)） | 屏幕空间雾在底板上的正确处理（`engine/look/fog.js` 三个镜头都关着） |

---

## 7. 新作品落地顺序（给 agent 的操作清单）

1. **建独立目录，不动原版。** 新作品放新目录，原版 `src/` 和基准帧保留（`AGENTS.md:35`、`docs/TRACKS.md:59`）。风格基准帧在设计模板里登记为 `media/shot_7.6.jpg`（`docs/routes/templates/project-beiming.json:10`，渲染器不读该文件）。
2. **写自己的配方文件**，结构照 `src/toon.js`：`PALETTE` → `TOON_DEFAULTS` → `TOON_PRESETS` → `toonKind({...})`（`src/toon.js:14-89`）。需要双色亮芯就开 `rimCore`，需要调天光阈值就开 `skyStepUniform`，需要更硬的边就降 `featherMin`。
3. **先定色指定**：每种材质写亮 / 一影 / 二影三色；单色物体直接给 `shade1/shade2`，实例色物体用 `tintFrom` 生成色调；用 §5.2 的 OKLCH 命令检查色相是否偏向环境色、彩度 C 有没有低于亮档的约 70%（不要看 HSL 饱和度）。肤色、金色、强调色单独指定，不靠乘法。同时算主体与背景的明度差（§5.2 末尾）。
4. **定光**：按色彩脚本该段与本镜的读形目标定主光方向（判据 2；北冥日出段是低角度逆光，其他段不默认），`fitShadow` 罩阴影相机；`setToonGlobals` 定补光/天光方向与倍率。
5. **定分档**：`step1/step2/feather*`；`edgeNoiseScale` 按资产尺度换算。
6. **定边缘光**、再加表面层（量从小开始，参照 §4）。
7. **接描边**：`bindToon` → `wireOutlines`；决定哪些实例只描外轮廓、哪些部件同组。
8. **定后期**：每个镜头一个 `look(t)`，只覆盖与默认不同的字段（`src/look.js:14`）。
9. **验证**（全部是现有命令）：
   - 中间缓冲：`node engine/render/still.mjs . <t> --query "dbg=edge&nohud=1" --out <dir>`，`dbg` 可选 `id / depth / edge / line / bloom / paper / kuwahara / scene`（`src/main.js:39`、`engine/stage/film.js:44`、`engine/look/debug.js:6-7`）。
   - 后期开关对照：`?test=look&cfg=raw|line|kuwa|grade|paper|full|nolines|nokuwa`、`&still=1` 看沸腾（`lab/look.js:6-10`）；注意它用的是测试材质。
   - 原生 4K 对照：同一 `t` 渲 1080 与 3840×2080，按 §5.3 的方法裁同一区域 1:1 比较（`docs/渲染与4K.md:58-67`）。必须同时看屏幕墨线和材质内画线。
   - 验收表逐项写"通过/失败/未复核"（`docs/routes/validation-and-rtx.md:318-319`）；再做 VISUAL-DESIGN §8 的审美复核。技术检查通过不能替代观看整片（`AGENTS.md:38`）：agent 交代理审片证据，全速带声的完整观看由人做（DIRECTING 步骤 10）。

---

## 8. 本章提到但仓库没有实现的能力

- 通用 N 档色阶参数（只有三色公式，需改族钩子；多档写法仅见 `experiment` 案例）。
- 阴影阈值贴图 / 顶点色逐像素偏移交界线（只有青铜族的 `toonLift` 特例）。
- 面部法线编辑、法线传递（例如植被团用代理球的法线），三维人脸着色。
- 基座材质的硬边高光档（只有玄鲲族的 `toonGloss / toonMetal` 钩子、鲲眼的 `toonOverlay` 高光）。
- 屏幕墨线的逐物体线色（色线）；正片的法线折痕线；按受光方向或曲率调线宽。
- 材质内画线的分辨率标定，以及让它免受 Kuwahara 抹除的机制（F16，已实测）。
- 笔画搜索半径随分辨率放宽（F17）。
- 按屏幕线密度自动简化远景线条；阴影相机按像素对齐。
- 按材质族分开的墨线沸腾时钟：给各族各自的 `uInkTime`（鲲取 `hold(f, 3)`），屏幕墨线按 ID 分组取种子，至少给鲲单独一个种子（判据 8 的已知偏差）。
- 点光源与聚光的卡通分支（每片元 L＝normalize(灯位−世界坐标)）和照射范围遮罩（判据 2）。
- 正片的剪影开关与灰度缩略图工具（VISUAL-DESIGN §3）。
- A 路线的色指定表 / 风格版本数据结构（T06 planned），正式材质的灰模/纯反照率检查开关，风格校准场景（T05 planned），着色回归测试（`tests/` 下没有着色相关测试）。

---

## 9. 出处与许可

- **路径缩写**：`$甲` = `cases/vendor/lemo-opuscar`（风格库甲，固定提交 `bebbbe1a`，MIT，LemoLab）；`$乙` = `cases/vendor/sy-style-100`（风格库乙，固定提交 `e41dee31`，MIT，肖雄 XIAOXIONG）；`<研究工作区>` = 研究期的临时目录，未入库（说明见 [README](README.md) §8）。快照只读，许可与署名不得删改（`AGENTS.md:51,56`；`THIRD-PARTY.md:32-38`）。

- **three.js r170**（MIT）：`package.json:26`，`THIRD-PARTY.md:21`，许可文件 `cases/licenses/three-MIT.txt`。卡通材质是对它的 `MeshToonMaterial` 注入补丁，锚点按 r170 写，升级后锚点缺失会直接报错（`engine/shade/patch.js:18-24`）。本章核对过锚点：
  ```sh
  node --input-type=module -e "import * as THREE from 'three'; const a='return mix( 1.0, shadow, shadowIntensity );'; console.log(THREE.REVISION, THREE.ShaderChunk.shadowmap_pars_fragment.split(a).length-1, THREE.ShaderLib.toon.fragmentShader.includes('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;'))"
  # 输出：170 2 true（阴影量化锚点 2 处，被 replaceAll 一起替换；光照锚点存在）
  ```
  判据 10 引用的 OutputPass 行为见依赖源码 `node_modules/three/examples/jsm/postprocessing/OutputPass.js:51-65`（按渲染器的 `outputColorSpace / toneMapping` 设宏；`NoToneMapping` 不设任何色调映射宏）。
- **算法出处**（引擎源码注明）：Generalized Kuwahara 取 Papari 2007 的思路（`engine/look/kuwahara.js:1`）；无切线凹凸用屏幕导数法 Mikkelsen 2010（`engine/shade/util.glsl.js:10`）；后期整数哈希用 PCG（Jarzynski & Olano 2020，`engine/look/glsl.js:2`）。
- **北冥代码动画风格 · 86 式（C 路线）引用的第三方风格库**（只读快照，`THIRD-PARTY.md:9-10`）：本章判据 5、7、8、11 的"通用工艺"沿用 lemo-opuscar（MIT，LemoLab）快照中 `cases/vendor/lemo-opuscar/styles/cel-anime-80s/STYLE.md` 第 1、2、3、9 节的做法（每套光照一份色指定、线色取填充色的深色版而不用纯黑、肤色每套单独给、边缘光宽约 2–4 像素以免吞掉细形体）。判据 5 引用的案例 `cases/source/style-27-cel-anime-80s/pal.js` 的结构（`mul`／`LIGHTS`／`palette()`／`PAL`、肤色手指定）来自 `cases/vendor/lemo-opuscar/styles/cel-anime-80s/demo/pal.js:32-54`，其中 12 行逐字相同、文件头注释是上游英文注释的中译；同案例的 `cel.js` 除首行注释外与上游 `demo/cel.js` 逐字相同（首行注释自称"改写自风格库示例引擎"）。借用这两个文件时保留 LemoLab 的版权与 MIT 许可声明（`THIRD-PARTY.md:36`）。sy-style-100（MIT，XIAOXIONG）快照中另有 `cases/vendor/sy-style-100/lib/toon.js`，本章未采用。快照不得就地修改、许可与署名不得删改（`THIRD-PARTY.md:32-38`）。
- 本章 §5.1 的换算只用 `engine/shade/toon.js:121-160` 的公式做算术（交界角 θ＝arccos(2·step 值−1)，羽化角宽同理），研究期的脚本没有入库，可按公式重算；§5.2 的命令在仓库根即可重跑。OKLab 公式出处见 [../SOURCES.md §2.3](../SOURCES.md)。
