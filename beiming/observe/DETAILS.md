# 感知：细则

[README.md](README.md) 是接口索引与预算说明；这里放 `compare`、`align` 与画面能量尺子的完整参数、容差与退化判定口径。

## `compare(a, b, options?)`

- 支持 RGB 图像对象、PNG 路径/缓冲或 `{ video, frame?, fps? }` 视频帧（一个输入对象只能给一种来源，`path`、`video`、`videoPath`、`rgb`、`data` 多给即报错）。
- 复用白名单 `tools/baseline/lib/metrics.mjs` 与 `tools/eval/lib/metrics.mjs`（PSNR、SSIM、maxDiff、fracAbove1/2、seamDeltaE、paletteDeltaE、lineCoverage、grainEnergy），并补 Rec.709 亮度分位差（`lumaP05`/`lumaP50`/`lumaP95`）与可选的超差像素占比：
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

- 两边各自可以是帧（用 `colorPalette` 取前 `k` 个主色，默认 6；线性浮点帧先截到 0 到 1 再按 sRGB 编成 8 位）或色板数组，元素是 `[r, g, b]`、`{ rgb, share? }` 或 `{ lab, share? }`。色值三个分量须都是数（`rgb` 是 0 到 255 的整数，`lab` 是有限数）。`share` 是非负有限数，只看比例：先除以色板里最大的 `share` 再加权，`1e308` 这样的权重不会溢出。
- 色差是 CIEDE2000（含旋转项与彩度修正），`rgb` 按 `tools/eval/lib/metrics.mjs` 的 `srgbToLab` 换算（sRGB → 线性 → D65 XYZ → Lab）。公式在本文件里另写了一份不溢出的：常规范围与 `tools/eval/lib/metrics.mjs` 的 `deltaE00` 对到 `1e-9`，任何有限 Lab 都读出有限非负数（那一版彩度上到 `1e44` 会出 `Infinity`）：`a`、`b` 贴近双精度上限时先一起乘 2 的负幂再算，彩度不溢出，`1.3e308` 与 `1.7e308` 两个彩度照样分得开；旋转项配方后用 `hypot` 合成，极小的色差不会平方后下溢。彩度差与小夹角的色相差从分量差算（`ΔC′ = (C2² − C1²) / (C1 + C2)`，色相差用两个向量的叉积），只差一个浮点步长的两个色也读得出色差，不会各自舍入后减成 0。只有三个分量逐一相等才读 0，不同的色至少读出最小正数，所以色板里有完全相同的色时最近色一定是它；不加权的平均色差先除以最大的那个再平均；加权的只算 `share` 不为 0 的色，色差乘权重直接相加，添几个 `share` 为 0 的色 `weightedDe00` 逐位不变；有不为 0 的色差（加权的还要它的 `share` 不为 0）就至少读出最小正数，不同的色板不会读成 0；超出双精度的色差封顶在 `Number.MAX_VALUE`。匹配是双向最近色，不强制一一对应。
- 顶层 `meanDe00`、`maxDe00`、`weightedDe00`（按 `share` 归一加权）与 `pairs` 是候选的每个主色到参考色板最近色；`reverse` 是参考到候选的同一组数。`value` 取两个方向平均色差里大的那个：多出色板外的主色、或缺了参考里的色，都会抬高它。

### `shapeIou(a, b, { roi?, threshold?, id?, background?, tol?, emptyValue? })`

- `a` 是候选、`b` 是参考，尺寸须一致，选项对两边同样生效。掩码来源：给 `id` 时读单通道编号层里等于 `id` 的像素（另收 16、32 位整数数组）；给 `background` 时取彩色帧里任一分量与背景色相差超过 `tol` 的像素；四通道帧取 alpha 大于 `threshold`（默认半幅）；单通道取大于 `threshold`（默认 0）。三通道帧不给 `background` 报错。
- 返回 `iou`、`intersection`、`union`、`precision`（交 / 候选面积）、`recall`（交 / 参考面积）、`bboxIou`（两个紧包围盒的交并比）、`areaA`、`areaB`、`emptyBoth`。
- 两边都空时各比值取 `emptyValue`（默认 1）并置 `emptyBoth: true`；只有一边空时都是 0。
