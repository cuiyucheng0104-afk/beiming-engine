# 感知：细则

[README.md](README.md) 是接口索引与预算说明；这里放 `compare`、`align` 与画面能量尺子的完整参数、容差与退化判定口径。

## `compare(a, b, options?)`

- 支持 RGB 图像对象、PNG 路径/缓冲或 `{ video, frame?, fps? }` 视频帧（一个输入对象只能给一种来源，`path`、`video`、`videoPath`、`rgb`、`data` 多给即报错）。
- 用组件内的 `metrics/pixel.mjs` 与 `metrics/perceptual.mjs`（PSNR、SSIM、maxDiff、fracAbove1/2、seamDeltaE、paletteDeltaE、lineCoverage、grainEnergy），并补 Rec.709 亮度分位差（`lumaP05`/`lumaP50`/`lumaP95`）与可选的超差像素占比：
  - 给 `pixelDiffThreshold`（顶层或写在 `tolerance` 里都行，两处校验相同且都给须相等：必须是 0 到 1 的有限数，`null`、布尔、字符串、`NaN` 或越界都报 `usage.bad-argument`）；
  - 一个像素的差取三通道最大的整数级数 `m`，按 `m > pixelDiffThreshold * 255` 判超差，不留浮点松弛，超差像素占比记为 `fracAboveThreshold` 一行，占比超过 `tolerance.pixelDiffMaxRatio`（默认 0）即不通过（阈值写成 `k / 255` 时差 `k` 级通过、差 `k + 1` 级不通过，比 `1/255` 略小的 `0.003921568627` 下差一级不通过）。
- 输出结构化 `rows` 与容差判定 `pass`（成对指标先用未舍入的差判定再格式化；亮度分位差先在 0 到 255 的整数灰阶上相减再除以 255，相邻一级恒为 `1/255`）。
- 支持 `heatmapPath`（别名 `heatmapOut`）写出差异热图，热图目标与任一输入实际读取的文件是同一文件（PNG 或视频，含软链、硬链）时报错不写。
- 顶层选项只认 `tolerance`、`pixelDiffThreshold`、`heatmapPath`、`heatmapOut`、`heatmapGain`、`metrics`；容差键只认 `psnrMin`、`ssimMin`、`maxDiff`、`maxFracAbove1`、`maxFracAbove2`、`pixelDiffThreshold`、`pixelDiffMaxRatio` 与 `max<指标>`（如 `maxSeamDeltaE`、`maxLumaP95Diff`，兼容 `<指标>Max` 写法），拼错的顶层选项、容差键或 `metrics` 里的未知指标名报 `usage.bad-argument`；小于 8x8 的图改用整幅单窗口 SSIM。

## `align(request)`

支持单选或组合调用四种对齐：

1. `cuts`：单调最优切点匹配 `pairs`/`missed`/`extra`（截断后仍保留 `missedCount`/`extraCount` 总数）。
2. `stretch`：20ms 能量包络或经 ffmpeg 抽 PCM 算 RMS 包络的网格互相关偏移与拉伸比求解，`corr < 0.5` 标 `reliable: false`。
3. `composition`：包围盒中心偏移、面积比与 `iou`。
4. `camera`：`>= 4` 组 3D-2D 点对的 7 参数阻尼高斯-牛顿相机拟合，输出对齐 `meta/0.1` 的列主序 `world`/`proj`、世界坐标 `pos`、相机到世界的轴角向量 `rotation`（弧度）与 `fovY`（度），都是不截断的双精度数，只用这七个参数就能重建相机，`rmsePx`/`maxErrPx` 用返回的矩阵复算。
   - `converged` 只在 `rmsePx <= 1`、无点在相机后方且 `degenerate` 为假时为真。
   - `degenerate` 由两道门给出：一是点集本身，重合、独立世界点不足 4 个（世界坐标相差不超过点集半径的 `1e-9` 视为同一点）、共线或共面且正对相机，在减质心、除以点集半径后的坐标上判定；二是解处的可辨识性，把位置按点集半径、角度与 `fovY` 按弧度归一后求重投影残差雅可比的 `J^T J`（7x7），最小与最大特征值之比低于 `1e-7` 即 7 个自由度局部不可唯一辨识（如正对平面的四角加光轴上一点，或相机距点集约 10 倍半径以上、`fovY` 约 11° 以下透视过弱时）。
   - 求解与两道门都在减去质心后的局部坐标里做，长度量按点集半径归一，结果再加回质心，世界坐标整体大平移不影响判定（回归覆盖半径 `2^-20`、平移 `262144` 及半径 `1e-9` 到 `1e9`）；`near`/`far` 或点坐标极端到 `world`/`proj` 出现非有限数时报 `usage.bad-argument`，不返回矩阵。

## 画面能量尺子与小指标（`metrics/energy-rulers.mjs`）

通用口径：

- 帧是 `{ width, height, <像素数组> }`，像素数组的键只能给一个：`rgba`（4 通道）、`rgb`（3 通道）、`luma` / `mask` / `ids`（单通道）或 `data`（按长度除以宽高判 1、3、4 通道）。`Uint8Array` / `Uint8ClampedArray` 是显示空间 8 位码值，`Float32Array` / `Float64Array` 是场景线性值，可以大于 1。阈值和读数都用输入自己的量纲（返回里的 `unit`：`code8` 或 `linear`），不做色彩空间换算；亮度按 Rec.709 权重。
- 坐标原点在左上，`roi` 是画面内的整数像素框 `{ x, y, width, height }`。
- 每个函数都返回 `{ metric, value, unit, ... }`，`metric` 是带 `metric:` 前缀的标准名，`value` 是判分用的主读数。
- 不用随机数、不读时钟：同一输入重复读数逐位一致，噪声地板是 0。
- 浮点输入的量级不限，从亚正规数到 `1.79e308` 都读出有限数：`noiseResidual` 与 `aliasEdge` 量之前把整个序列乘同一个 2 的幂挪到双精度中段，带量纲的读数再除回去。乘 2 的幂不舍入，常规量级的读数与不缩放逐位相同；序列整体乘 2 的幂（阈值跟着乘）时判定不变，`value`、`flicker` 严格成比例。真值超出双精度的读数封顶在 `Number.MAX_VALUE`，不出 `Infinity`。
- 尺寸不一致、空帧、非有限数、越界 `roi`、未知选项一律抛 `RangeError`，`code` 是 `usage.bad-argument`。普通数组入参（帧序列、色板、色值三元组、`background`、外部掩码）逐索引校验，只认数组自己的索引：稀疏数组的空洞同样报错，空洞处从原型链上继承到值也不算。
- `ENERGY_METRICS` 是标准名（不带前缀）到函数的冻结登记表；`runEnergyMetric(name, ...args)` 带不带 `metric:` 前缀都认，未知名字同样抛 `usage.bad-argument`。

### `clipHighlightRatio(frame, { threshold?, roi?, alphaMask? })`

- 任一色分量达到 `threshold`（闭区间）的像素占比。默认阈值：8 位 254，线性浮点 1（显示白）。
- `alphaMask: true` 只数本帧 alpha 大于 0 的像素（帧须带 alpha）；也可以给与画面等大的单通道数组（`Uint8Array` / `Uint8ClampedArray`、`Float32Array` / `Float64Array` 或普通数组），元素须为布尔或非负有限数，大于 0 计入；含 `NaN`、正负无穷、负数、空洞或其他类型时报 `usage.bad-argument`。计入像素为 0 时 `ratio` 是 0、`peakMax` 是 `null`。
- 返回 `ratio`、`clippedPixels`、`totalPixels`、`peakMax`（最大分量的峰值）、`channelRatios`（红、绿、蓝各自的占比）、`threshold`，以及平顶斑块 `plateauPixels` / `plateauRatio`：最大分量等于全区峰值、且四邻域里有同伴的像素；峰值不到阈值一半时不算。HDR 帧被硬削到某个高于阈值的上限时，削顶面积看 `plateauRatio`。

### `noiseResidual(frames, { roi?, block?, motionThreshold?, maxShift? })`

- 至少 2 帧，各帧尺寸、通道数、数值类型须一致。相邻帧亮度差 `d` 的四邻域拉普拉斯在静止块上的均方根，除以 `√40` 折算成等效的单帧白噪声标准差（两帧相减方差翻倍，拉普拉斯核平方和 20；这个折算只要求噪声逐像素独立，不要求高斯）。
- 画面按边长 `block`（默认 8，取值 4 到量测区短边）分块。块内 `max|d|` 不超过 `motionThreshold`（默认 8 位 2 级、线性 `2/255`）的直接算静止；超过的，满足下面任一条才是运动块：
  1. 成片：块内横向或纵向相邻像素的 `d` 乘积和，绝对值超过 `Σd²` 的 0.6 倍。移动的边、平移的条纹、整块亮度跳变都落在这里；全画幅切换或曝光阶跃时每一块都成片，结果是 `no-static-region`。
  2. 配准：存在非零整数位移 `s`（横纵各不超过 `maxShift`，默认 6 像素，给 0 关掉）让配准后的残差均方根不超过零位移时的 0.35 倍。按块内 `|d|` 超过 `motionThreshold` 的像素多少分两种验法：
     - 至少四分之一（密纹理）：上一帧挪 `s` 对到本帧，只看本块，只试源块整个落在量测区内的位移。整体平移的细纹理（帧间差本身像白噪声）靠这一条认。
     - 不到四分之一（稀疏纹理，如底色上的点阵）：单看一块、单向配准不作数，消失的孤立脉冲随便挪一下就对上了平场。改验守恒：`cur(p) = prev(p − s)` 且 `prev(p) = cur(p + s)`，两个方向的残差在本块、在以本块为心的 3×3 块窗口上都要塌下去，且窗口里比过的变化像素不少于 4 个；来处或去处出了量测区的像素不比。
- `maxShift` 须为非负安全整数（`1e20`、`2^53` 报 `usage.bad-argument`）；实际只试量测区容得下的位移，给得再大也不空转。位移数随 `maxShift` 平方增长，凑巧配上的机会与耗时都跟着涨。
- 两条都不满足的块是静止区的随机噪声，留在静止区里计数：高斯噪声逐像素独立，不成片也配不准；稀疏的散粒、泊松脉冲同理（等幅脉冲偶尔有两对凑巧同位移，那一块连外圈被排除，`staticRatio` 低一两个百分点，读数不受影响）。运动块连同外圈八块都不计。
- 返回 `value`（没有静止像素时是 `null`，不出 `NaN`）、`status`（`ok` 或 `no-static-region`）、`staticRatio`、`staticPixels`、`totalPixels`、`pairs`、`block`、`motionThreshold`、`maxShift`。
- 局限：下面几种运动既不成片也配不准，会读成噪声：亚像素慢移或旋转形变的细纹理；位移超过 `maxShift` 的细纹理；3×3 块窗口里变化像素不到 4 个的稀疏运动（单个像素在动、间距 16 像素以上的单像素点阵，后者把 `block` 调大到窗口里装得下两个点就能认）；叠在有纹理的静止背景上的稀疏点阵（窗口里的静止纹理挪不动）。`block` 取 4 时样本少，密的散粒噪声会有一部分块被误判成运动，`staticRatio` 下降，读数仍在真值附近。
- 动态范围的局限：同一序列里比帧间差峰值小 `2^980` 倍（约 295 个数量级）以上、或比亮度峰值小 `2^1510` 倍（约 455 个数量级）以上的噪声，平方后下溢，读成 0 或 `no-static-region`；真有这种序列，先用 `roi` 避开离群的那块。

### `aliasEdge(frame | frames, { roi?, edgeThreshold? })`

- 锯齿度 `jaggedness`（单位像素）：强边缘像素（Sobel 幅值 / 4 不低于 `edgeThreshold`，默认 8 位 32 级、线性 `32/255`）上，沿边缘方向取窗，逐行（近水平的边逐列）覆盖面积的二阶差分绝对值除以窗内极差，再取平均。盒滤波抗锯齿下直边、细杆每行的覆盖面积随行号线性变化，读数接近 0；点采样的阶梯读数约 `2·min(s, 1 − s)`，`s` 是每行的横移量。
- 窗的半宽从 1 加到 6，取第一个两端平坦的；距量测区边缘不到 7 像素的边缘不计。没有可量的边缘时 `value` 是 0、`status` 是 `no-edges`。
- 闪烁 `flicker`（给 3 帧及以上才算，否则 `null`）：细节区像素上，相邻两次帧间亮度变化反号时取较小的那次幅度，再对像素和帧取平均，量纲见 `flickerUnit`。细节区是任一帧里下面三项的最大值不低于 `edgeThreshold` 的像素：Sobel 幅值 / 4、向右与向下的单步差分 `|L(x+1,y) − L(x,y)|`、`|L(x,y+1) − L(x,y)|`、横纵二阶差分 `|2L(x,y) − L(x−1,y) − L(x+1,y)|`（纵向同理）。1 像素交替的条纹、棋盘周期是 2 像素，Sobel 的隔一像素差分正好抵消，靠后两项认；锯齿度仍只在 Sobel 强边缘上量，这类画面 `status` 是 `no-edges` 而 `detailPixels`、`flicker` 有读数。
- 局限：正好 0°、45°、90° 的点采样阶梯每行面积等差，读不出锯齿；这类画面看 `flicker`，或用 `compare` 对参考图。

### `colorPaletteDe00(candidate, reference, { k? })`

- 两边各自可以是帧（用 `colorPalette` 取前 `k` 个主色，默认 6；线性浮点帧先截到 0 到 1 再按 sRGB 编成 8 位）或色板数组，元素是 `[r, g, b]`、`{ rgb, share? }` 或 `{ lab, share? }`。色值三个分量须都是数（`rgb` 是 0 到 255 的整数，`lab` 是有限数）。`share` 是非负有限数（缺省 1），只看比例：权重与色差都拆成尾数和 2 的指数再算，`1e308` 这样的权重相加不溢出，占比小到 `2^-1075` 的色乘上 `1e308` 的色差也照样读得出，整板同乘 2 的幂读数逐位不变；色板各项 `share` 全为 0 时抛 `RangeError`（`usage.bad-argument`）。
- 色差是 CIEDE2000（含旋转项与彩度修正），`rgb` 按 `tools/eval/lib/metrics.mjs` 的 `srgbToLab` 换算（sRGB → 线性 → D65 XYZ → Lab）。公式在本文件里另写了一份不溢出的：常规范围与 `tools/eval/lib/metrics.mjs` 的 `deltaE00` 对到 `1e-9`，任何有限 Lab 都读出有限非负数（那一版彩度上到 `1e44` 会出 `Infinity`）：`a`、`b` 贴近双精度上限时先一起乘 2 的负幂再算，彩度不溢出，`1.3e308` 与 `1.7e308` 两个彩度照样分得开；旋转项配方后用 `hypot` 合成，极小的色差不会平方后下溢。彩度差与小夹角的色相差从分量差算（`ΔC′ = (C2² − C1²) / (C1 + C2)`，色相差用两个向量的叉积），只差一个浮点步长的两个色也读得出色差，不会各自舍入后减成 0。只有三个分量逐一相等才读 0，不同的色至少读出最小正数，所以色板里有完全相同的色时最近色一定是它；不加权的平均色差先除以最大的那个再平均；加权的只算 `share` 不为 0 的色，添几个 `share` 为 0 的色 `weightedDe00` 逐位不变，读数夹在有权重的色差的最小与最大之间（`pairs` 里的 `share` 是归一后的占比，小于最小正数的显示为 0，加权不受影响）；有不为 0 的色差（加权的还要它的 `share` 不为 0）就至少读出最小正数，不同的色板不会读成 0；超出双精度的色差封顶在 `Number.MAX_VALUE`。匹配是双向最近色，不强制一一对应。
- 顶层 `meanDe00`、`maxDe00`、`weightedDe00`（按 `share` 归一加权）与 `pairs` 是候选的每个主色到参考色板最近色；`reverse` 是参考到候选的同一组数。`value` 取两个方向平均色差里大的那个：多出色板外的主色、或缺了参考里的色，都会抬高它。

### `shapeIou(a, b, { roi?, threshold?, id?, background?, tol?, emptyValue? })`

- `a` 是候选、`b` 是参考，尺寸须一致，选项对两边同样生效。掩码来源：给 `id` 时读单通道编号层里等于 `id` 的像素（另收 16、32 位整数数组）；给 `background` 时取彩色帧里任一分量与背景色相差超过 `tol` 的像素；四通道帧取 alpha 大于 `threshold`（默认半幅）；单通道取大于 `threshold`（默认 0）。三通道帧不给 `background` 报错。
- 返回 `iou`、`intersection`、`union`、`precision`（交 / 候选面积）、`recall`（交 / 参考面积）、`bboxIou`（两个紧包围盒的交并比）、`areaA`、`areaB`、`emptyBoth`。
- 两边都空时各比值取 `emptyValue`（默认 1）并置 `emptyBoth: true`；只有一边空时都是 0。

### 成片视频封装（`metrics/video-energy.mjs`）

- `videoNoiseResidual(filePath, { maxFrames?, roi?, block?, motionThreshold?, maxShift? })` 与 `videoAliasEdge(filePath, { maxFrames?, roi?, edgeThreshold? })` 从 `metrics/index.mjs` 与组件顶层 `observe/index.mjs` 统一导出，面向本地成片视频文件（如 `master.mp4`）。
- 先用 `ffprobe -count_frames` 查总帧数，再用 `ffmpeg -nostdin -hide_banner -v error -i <file> -map 0:v:0 -fps_mode passthrough -strict -1 -f yuv4mpegpipe -pix_fmt gray -` 按原帧 1:1（不因 VFR 重复帧）流式读取自定界 Y4M 单通道 8 位灰度亮度平面（不落临时图片文件），直接从 `YUV4MPEG2` 流头取 ffmpeg 按显示矩阵自动旋转后的真实解码宽高（涵盖 ±90°/±89.5° 等任意旋转元数据），委托 `energy-rulers.mjs` 的 `noiseResidual` / `aliasEdge` 计算；`videoNoiseResidual` 未显式传 `block` 且有效量测区（整幅或合法 `roi`）短边在 `4..7` 像素时自动将默认 `block` 收敛至短边（短边 `< 4` 无论省略或显式传合法 `roi` 均一致返回 `status: 'insufficient-resolution'`），`videoAliasEdge` 的 `edgeRatio` 在传入 `roi` 时按 ROI 面积分母计算。
- 内存上界守卫：`totalFrames <= maxFrames`（默认 60，合法下限 9）时全量解码；超过 `maxFrames` 时取首、中、尾三段互不重叠的确定性等距连续窗口（每段长 `floor(maxFrames / 3) >= 3` 帧，同时支撑 `noiseResidual` 与 `aliasEdge.flicker`），每段解码完立即计算并释放帧缓冲，最终聚合取最差/最大 `value`（`videoAliasEdge` 同时取最大 `flicker`）。
- 返回标准 `{ metric, unit, value, details }`：`videoNoiseResidual` 为 `metric:noise.residual` / `code8`，`videoAliasEdge` 为 `metric:alias.edge` / `px`，`details` 保留 `status`、`staticRatio`、`flicker`、`flickerUnit`、`edgePixels`、`sampledFrames`、`totalFrames` 与各段读数 `segments`。单帧视频调 `videoNoiseResidual` 返回 `value: null`、`details.status: 'insufficient-frames'` 不抛异常；缺少 `ffprobe` / `ffmpeg`（`ENOENT`）时照 `video-audio.mjs` 同口径返回 `{ metric, value: null, details: { code: 'tool-missing', tool }, unit }`；非法路径、未知选项或非法 `maxFrames` 抛带 `code: 'usage.bad-argument'` 的 `RangeError`。

## 亮度分位与切镜重影（O9，`metrics/luma-ghost.mjs`）

`lumaPercentile(input, opts)` 和 `cutGhost(input, opts)` 共用两种输入：内存帧数组直接返回读数；传视频路径则返回 Promise，经 ffmpeg 以 `-fps_mode passthrough` 流式解出灰度 Y4M，不落盘。缺解码工具返回 `status: 'tool-missing'`，不是零亮度或零重影。可从 `observe/index.mjs` 或 `metrics/index.mjs` 导入；`runLumaGhostMetric` 的名字可带 `metric:` 前缀。

- 内存帧形如 `{width, height, data, channels?, frame?}`。`Uint8Array` 的满幅是 255，`Float32Array` 的满幅是 1（不是可超过 1 的场景 HDR）。RGB/RGBA 按 Rec.709 合成亮度，不把 alpha 加进亮度。切点 `c` 是**后镜首帧**的全片帧号，不是采样数组下标。
- `lumaPercentile(frames, {cuts: [120]})` 的 `perFrame` 逐帧给 `p01/p50/p99`；`summary` 是所有像素合在一起的 nearest-rank 分位（排序后取第 `ceil(q*N)` 个），不是逐帧分位的平均。`pXX` 用 `[0,1]`，`code8.pXX` 用 `[0,255]`。`crossCutExposureDelta` 的差是 `c` 减 `c-1`，正值表示变亮；`maxCrossCutDeltaP50`、`maxCrossCutDeltaP99` 取变化量的最大绝对值，没有有效切点时是 `null`。不传 `cuts` 时，以相邻帧的平均绝对亮度差 `> cutThreshold`（默认 0.15）作切点；抽帧不连续时不跨过缺帧计算。
- `cutGhost(frames, {cuts: [120], threshold: 0.15})` 对每个切点取 `c-1,c,c+1`，把后镜首帧沿「后镜稳定帧 → 前镜末帧」方向投影。`ghostEnergy` 是截断到 `[0,1]` 的拟合混合系数，乘上残差解释度与按前后镜亮度差平方加权的像素支持率；若后镜两帧只相差可配准的一像素平移，不算前镜渗透。能量为正且达到 `threshold` 才标记重影。`perCut` 给 `cutFrame`、`status`、`ghostEnergy` 与 `hasGhost`；`ghostFrames` 只列出命中的后镜首帧。`missing-frames`（三帧不齐）或 `low-contrast`（前后镜太像）都没有足够证据，不能当作硬切验过。这个读数针对旧镜头渗入首帧，不是一般的镜内运动模糊检测器。

验收时可将两个完整结果分别放进 `measured.lumaPercentile`、`measured.cutGhost`，让 `luma_p99`、`no_ghost` 直接定位反例；详见 [验收细则](../verify/DETAILS.md)。

## 亚像素光流与 LDR-FLIP（`metrics/flow-flip.mjs`）

`flowField`、`imageFlip` 从组件和 `metrics/index.mjs` 都能导入；也可用 `FLOW_FLIP_METRICS[name]` 或 `runFlowFlipMetric(name, ...args)`，`name` 可带 `metric:` 前缀。两者均不读文件、时钟、显卡或随机源，不改输入。帧给 `{ width, height, rgba | rgb | luma | data }`，恰好一个像素载荷，行优先；`data` 按长度推断 1、3、4 通道，单通道按灰度，alpha 不参加量测。只收 8 位无符号或钳位数组、Float32/64 数组。帧、ROI、选项只读普通对象的自有数据描述符；拒绝 Proxy、访问器、未知键、稀疏序列、共享像素缓冲、非有限样本（包括 alpha）以及不合法的尺寸、参数。像素视图只按原生类型、内部长度与数字下标读取，标准成员不许在实例上遮蔽。错误统一抛 `RangeError`，`code: 'usage.bad-argument'`。

### `flowField(frames, { fps?, windowRadius?, pyramidLevels?, iterations?, roi?, includeFields? })`

- 至少两帧，尺寸、通道数和编码（8 位或浮点）一致。按 Rec.709 系数计算亮度。每对帧共用一个除数，8 位取 255，浮点取两帧颜色通道的最大绝对值（全零时取 1），使梯度乘积与正则下限使用同一尺度。各层用 `[1,6,15,20,15,6,1]/64` 横纵低通，滤后亮度用于本层求流，隔点取样生成下一层。
- 最粗层从零开始。细层先用本层低通前的亮度检查方窗。若窗内两帧逐像素相同，且后帧亮度在各像素与其画内四邻点间均相同，该窗位移始终为零。其余位置从粗层双线性上采样位移并乘二。在本层方窗内，对比该初值与零位移的亮度残差平方和；若上采样使残差变大，就从零开始，避免沿用粗层错配的纹理周期。
- 每轮在 `q=p+v(p)` 双线性采样滤后亮度和后帧中心差分梯度 `g`，令 `t=前帧(p)−后帧(q)+g·v(p)`。在半径 `r` 的方窗内分别累加 `H=Σggᵀ`、`b=Σgt`，越界观测跳过。窗口先横后纵，每轴从截在画内的两端成对相加，翻转该轴时求和顺序对称，全零窗口的和精确为零。
- 令 `T=tr(H)`，若 `T≤10⁻¹⁴`，位移清零。否则用 Tikhonov 正则解总速度 `(H+λI)v目标=b`，每轮向目标最多走一个该层像素。取 `λ=max(10⁻⁶(2r+1)², 5×10⁻⁴T, T/40−λmin(H))`。绝对下限稳定弱梯度，最后一项抑制单向边缘上无法观测的切向速度。遮挡、切镜和高频重复纹理仍可能产生误差。窗半径默认 3（1–64），层数上限默认 4（1–32，短边容不下窗口就不再降采样），迭代上限默认 6（1–64）。
- 全画幅求流，`roi: { x, y, width, height }` 只裁统计与返回的场。`curve[t]` 是第 t 帧到下一帧：`meanMag/p95Mag/maxMag` 汇总逐像素 `hypot(dx,dy)`；`meanDx/meanDy` 是平均向量，单位 px/帧，右、下为正，`coherentAngleRad=atan2(meanDy,meanDx)`，零向量为 `null`。顶层 `mean`（也是 `value`）、`p95` 是**逐对均值**的均值与 nearest-rank 95 分位，`max` 是全段最大像素幅值。只有 `includeFields: true` 才返回逐对的 `fields[{width,height,dx,dy}]`，两张 Float64 平面的下标均为 ROI 内的 `y*width+x`。
- `spectrum` 分析 `N=frames.length−1` 个 `meanMag`，去均值，乘周期 Hann 窗 `wᵢ=(1−cos(2πi/N))/2`（N<3 用矩形窗），实序列单边 DFT：`amplitude[k]=s·|Σwᵢ(mᵢ−m̄) exp(−2πiki/N)|/Σwᵢ`，双边成对的频点 `s=2`，DC 和 Nyquist 取 1。`spectralEnergy=Σ amplitude²/s`。`bins` 从 0 到 `floor(N/2)`；有正有限 `fps` 时 `freqHz=k·fps/N`，否则为 `null`。`dominantIndex` 取最强非零频点（同幅取低频），没有交流分量时为 `null`；`dominantFreqHz` 无主峰或没给帧率时为 `null`。这是**速度大小**不是位置或有符号速度的频谱：来回的 2 Hz 正弦平移，在速度幅值上主峰是 4 Hz。

### `imageFlip(reference, test, { ppd?, distanceM?, monitorWidthM?, resolutionX?, transfer?, includeMap?, threshold? })`

按 Andersson 等 [FLIP: A Difference Evaluator for Alternating Images (HPG 2020)](https://research.nvidia.com/publication/2020-07_flip-difference-evaluator-alternating-images) 的 LDR 口径量两张同尺寸图。只收显示范围：字节除以 255，浮点须在 `[0,1]`。两边默认都是 `transfer: 'srgb'`：`v≤0.04045` 解作 `v/12.92`，否则 `((v+0.055)/1.055)^2.4`；已经是**线性** RGB 的两帧须显式给 `'linear'`。`ppd` 为每度像素数，默认 `3840π/180 ≈ 67.0206`。也可完整给三项几何参数代替 `ppd`：`(distanceM/monitorWidthM)·resolutionX·π/180`；两种写法不能混用，实际 ppd 要在 `(0,2048]` 内以限制卷积核宽度。

1. 线性 sRGB → D65 XYZ，除以白点得 `(x,y,z)`；YCxCz 为 `(116y−16,500(x−y),200(y−z))`。单位 DC 增益下可直接滤 `y, x−y, y−z`，无需来回乘常数。边界复制，三通道分别做 CSF 空间滤波；角坐标为像素偏移除以 ppd。二维高斯项 `a√(π/b) exp(−π²r²/b)`，Y 和 Cx 各一项 `(a,b)=(1,.0047),(1,.0053)`，Cz 是 `(34.1,.04),(13.5,.025)` **两个二维核之和**；三核各自单位和。沿每轴截在 `ceil(3·ppd·√(.04/2)/π)`，分离卷积时 Cz 的两项始终分别过滤，最后才相加。
2. 滤后逆变换回线性 RGB，裁 `[0,1]` 再转 D65 CIELab；Hunt 调整 `aH=.01·L·a*, bH=.01·L·b*`。`HyAB=|ΔL|+hypot(ΔaH,ΔbH)`，`d=(HyAB/HyAB(纯绿,纯蓝))^0.7`。色差 `Ec` 在 `(0,0)→(.4,.95)→(1,1)` 两段间线性映射。
3. 从**未滤波**的 `y` 求边缘与点特征，`σ=.041·ppd`，半径 `ceil(3σ)`。沿 x 或 y 的采样核分别正比于 `−k·G(k)`、`((k/σ)²−1)·G(k)`，`G(k)=exp(−k²/(2σ²))`；导数核正负瓣分别归一到 +1/−1，垂直于导数的轴只做单位和高斯平滑。将同阶 x/y 响应以 `hypot` 合为边缘强度 E 与点强度 P。`Ef=(max(|Eref−Etest|,|Pref−Ptest|)/√2)^0.5`。
4. `FLIP=Ec^(1−Ef)`，误差图是 `[0,1]` 的 Float32；`includeMap: true` 才带 `map`。`mean`（也是 `value`）、`max`、`p95`（按像素数的 nearest-rank）与返回图同源。`q1/weightedMedian/q3` 按误差本身加权：像素升序累加，首次达到总误差 25%/50%/75% 的像素值，全零时都为 0。

`threshold` 在 `[0,1]` 内，给了才返回 `pass: mean <= threshold`。校准时固定颜色编码、尺寸和观看条件，用同一画面的已知良好跨机结果约束误报，再用已知错误的材质、亮度等负对照约束漏报；若两组分不开，不应只靠均值判。测试用局部 1 码舍入与 28 码亮度偏移演示门限 0.05 的两侧，**不是实测 5090 门限**。有很小但严重的局部回归时应另看 `max` 和误差图。
