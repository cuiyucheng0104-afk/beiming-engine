# 验收

依据验收条件核对观测结果并记录判定。

通过契约接收观测记录和验收条件。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[谓词登记表](../kernel/contracts/predicates/CONTRACT.md)（验收条件与判定条目）、[信封](../kernel/contracts/envelope/CONTRACT.md)（验收层级与返回）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 带噪渲染对拍：Welch 检验

`welch.mjs` 的 `welchTest(groupA, groupB, options)` 判两组带噪渲染是否收敛到同一期望。每边给 K 个独立种子的样本，两边 K 必须相等（至少 2 个，建议 16 个；不等抛 `RangeError`）。样本可以是帧对象 `{ width, height, data, channels }`（`data` 按像素交错，`channels` 是通道数，缺省 1）、多层 EXR 的字节或路径。

```js
import { welchTest } from './index.mjs';
const result = welchTest(seedsA, seedsB, { blockSize: 8 }); // 缺省 alpha 0.05、blockSize 1（逐像素）
```

- **做法**：三通道先取线性亮度，按 `blockSize × blockSize` 求块均值（尾块按实际像素数平均），每个单元算两边的均值和无偏方差，做 Welch t 检验（Welch–Satterthwaite 自由度，双侧 p 值），再对参检单元做 Benjamini–Hochberg 校正。
- **取哪个通道**：EXR 有 `color.R/G/B` 就取它，没有才取裸 `R/G/B`，再没有就要求只有一个浮点通道；其余情况（比如只有 `normal.X/Y/Z`）不猜，抛错，要检就用 `channel` 给通道名。`channel` 给序号时只检颜色的那一个通道。两边解析出的形态要一致，一边三通道亮度、一边单通道会抛错。
- **结果**：`biasMap`（A 减 B 的均值差，偏差位置图）、`pMap`、`qMap`、`significantMask`（都是 `gridSize` 宽高的行主序平面）、`significantRatio`（校正后显著的单元比例）、`rawSignificantRatio`（未校正 p ≤ alpha 的比例）、`pHistogram`（`counts` 是 `bins` 个等宽桶的计数，`flat` 是平坦性判定，`lowTailP` 是判定用的 p 值，`effectiveAlpha` 是判定用的名义率）。`pass` 等于 `significantRatio <= alpha && pHistogram.flat`，两个条件缺一不可。
- **`testedUnits` 与 `totalUnits`**：`totalUnits` 是网格单元总数，`testedUnits` 是参检单元数，差值是 `deterministicUnits`。两个比例、直方图和 BH 校正的分母都是 `testedUnits`。
- **无噪声单元**：两边方差都是 0 且均值相等的单元（纯黑背景）记入 `deterministicUnits`，不参检，平面里 p 和 q 记 1；方差都是 0 而均值不等的单元 p 记 0，参检并必然显著。全图都不参检时 `pass` 为真，这只说明两组各统计单元样本逐位相等（块模式下指块聚合后的统计单元）。
- **平坦性只判小 p 端**：有偏会让小 p 变多。`flat` 检的是 p ≤ alpha 的单元数有没有显著超过 `effectiveAlpha × testedUnits`（单侧二项精确检验，`lowTailP < histogramAlpha` 判不平坦，缺省 0.001）。p 偏向 1 不判不过，代价是两边误用同一批种子时也判过，这时 `counts` 全堆在最后一桶，`rawSignificantRatio` 为 0。
- **名义率的余量**：`effectiveAlpha = max(alpha, min(0.25, alpha × (1 + 0.5 / max(2, K - 1))))`：余量最多把名义率抬到 0.25，`alpha` 本身大于 0.25 时就用 `alpha`；K 为 16 时是 0.05167。t 检验只在高斯噪声下精确，噪声非高斯时小 p 的比例会偏离 alpha，全高清有两百万个单元，千分之几的偏离也显著，不留余量同一渲染器换种子就会判不过。下表是 1920×1080 逐像素、同分布两组、alpha 0.05 的实测（每格两次）：

  | 每像素噪声 | K=16 | K=8 | K=4 |
  |---|---|---|---|
  | 高斯 | 0.0498、0.0499 | 0.0480、0.0481 | 0.0411、0.0413 |
  | 均匀 | 0.0503、0.0504 | 0.0500、0.0499 | 0.0456、0.0459 |
  | 两点（各半取 0 或 1） | 0.0502、0.0502 | **0.0769、0.0768** | 没测 |
  | 一成概率的亮点 | 0.0285、0.0287 | 0.0057、0.0057 | 没测 |
  | 余量后的名义率 | 0.0517 | 0.0536 | 0.0583 |

- **已知的误报与漏报**（都是上表同一套实测）：
  - K 小而噪声离散时会误报：K=8 的两点噪声小 p 比例约 0.077，同一渲染器换种子也判不过。每像素只有几种取值的低采样画面用 K=16，或者按 8×8 块检（块均值接近高斯）。
  - 余量会吃掉逐像素的检出力：每像素噪声标准差是均值两成的高斯噪声下，一边乘 1.01 的逐像素小 p 比例是 0.0515，低于 0.0517，逐像素判过；同一组数据按 8×8 块是 0.192，判不过。噪声大时用块做门。
  - 二项检验假设单元之间独立。3×3 盒式像素滤波下实测比例是 0.0494 到 0.0499，没有误报；更宽的滤波核没测，相关会让计数的波动大于二项分布，遇到贴线的不平坦先换成不小于滤波核的块再看。
- **下游怎么用**（V19 等对拍条目）：门只看 `pass`。不过时先看 `significantRatio` 和 `biasMap` 定位，再看 `pHistogram.counts` 区分「少数单元强偏」和「整体轻微偏」。报告里同时写 `testedUnits` 和 `totalUnits`，`testedUnits` 远小于 `totalUnits` 时结论只覆盖带噪区域；`rawSignificantRatio` 为 0 且末桶堆满，先查两边是不是用了同一批种子。
- **选粒度**：逐像素能定位到像素，但噪声大、分布重尾时检出力很低；像素间噪声独立时 8×8 块把标准差压到八分之一，日常门用块，定位时再看逐像素。单元数少于 `1 / alpha` 时一个假阳性就让比例超过 alpha，这种小图的误报率约等于 alpha。
- **限制**：亮度检验看不到亮度相抵的纯色偏，要查色偏时按 `channel: 0`、`1`、`2` 各跑一次。样本含 NaN 或无穷（帧对象查 `data` 的全部分量，含当前 `channel` 没用到的通道，抛 `RangeError`；EXR 只查参与计算的通道，深度层的无穷不算错）、`data` 不是 TypedArray 或普通数组、普通数组里有不是 number 的元素（`null`、字符串、布尔，抛 `TypeError`，不做隐式转换）、尺寸不一致、每边不足 2 个、种子组或 `data`、p 值数组含空洞（稀疏数组，抛 `TypeError`，先于个数与长度检查，所以 `new Array(1)` 也报空洞；普通数组的每个元素只读一次并拷成快照，读取中途被 getter 删项或改长度同样抛 `TypeError`；种子组分两段读：先记下两边的入口长度并拷快照（种子数相不相等按入口长度判），再解析全部帧，解析完、统计前复查原种子组，长度变了抛 `RangeError`、槽位被删抛 `TypeError`，复查只看长度和槽位在不在、不再读元素，所以 A 的 getter 把 B 从 4 帧缩成 3 帧、或帧的 `data` 与像素 getter 回头改种子组，都在统计前被拒）、`options` 不是普通对象、`alpha` 不是 (0, 1) 内的数、`bins` 超过 10000 时抛错。两边全部帧先解析、校验完才开始统计，任何一帧不合格都不会算出半截结果；代价是 2K 个平面同时在内存里（每单元 8 字节）。`studentTwoSidedP` 在自由度大于 1e7（含无穷）时按正态算；`benjaminiHochberg` 只收 [0, 1] 内的数字。
