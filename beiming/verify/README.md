# 验收

依据验收条件核对观测结果并记录判定。

通过契约接收观测记录和验收条件。跨组件通过契约交接，引用旧目录须命中白名单。

业务契约：[谓词登记表](../kernel/contracts/predicates/CONTRACT.md)（验收条件与判定条目）、[信封](../kernel/contracts/envelope/CONTRACT.md)（验收层级与返回）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 带噪渲染对拍：Welch 检验

`welch.mjs` 的 `welchTest(groupA, groupB, options)` 判两组带噪渲染是否收敛到同一期望。每边给 K 个独立种子的样本（至少 2 个，建议 16 个），样本可以是帧对象 `{ width, height, data, channels }`（`data` 按像素交错，`channels` 是通道数，缺省 1）、多层 EXR 的字节或路径（取 `color.R/G/B`，没有就取 `R/G/B` 或唯一的浮点通道）。

```js
import { welchTest } from './index.mjs';
const result = welchTest(seedsA, seedsB, { blockSize: 8 }); // 缺省 alpha 0.05、blockSize 1（逐像素）
```

- **做法**：三通道先取线性亮度（`channel` 给通道序号时只检那一个通道），按 `blockSize × blockSize` 求块均值（尾块按实际像素数平均），每个单元算两边的均值和无偏方差，做 Welch t 检验（Welch–Satterthwaite 自由度，双侧 p 值），再对全部单元做 Benjamini–Hochberg 校正。
- **结果**：`biasMap`（A 减 B 的均值差，偏差位置图）、`pMap`、`qMap`、`significantMask`（都是 `gridSize` 宽高的行主序平面）、`significantRatio`（校正后显著的单元比例）、`rawSignificantRatio`（未校正 p ≤ alpha 的比例）、`pHistogram`（`counts` 是 `bins` 个等宽桶的计数，`flat` 是平坦性判定，`lowTailP` 是判定用的 p 值）。`pass` 等于 `significantRatio <= alpha && pHistogram.flat`。
- **平坦性只判小 p 端**：有偏会让小 p 变多。`flat` 检的是 p ≤ alpha 的单元数有没有显著超过 `alpha × 单元数`（单侧二项精确检验，`lowTailP < histogramAlpha` 判不平坦，缺省 0.001）。p 偏向 1 不判不过：K 不大或噪声重尾时 Welch 近似本来就偏保守，全高清的单元数下对整条分布做双侧检验，同一渲染器换种子也会被判不平坦。代价是两边误用同一批种子时也判过，这时 `counts` 全堆在最后一桶，`rawSignificantRatio` 为 0。
- **无噪声单元**：两边方差都是 0 且均值相等的单元（纯黑背景）记入 `deterministicUnits`，不进校正和直方图，比例的分母是 `testedUnits`；方差都是 0 而均值不等的单元 p 记 0。
- **选粒度**：逐像素能定位到像素，但噪声大、分布重尾时检出力很低；像素间噪声独立时 8×8 块把标准差压到八分之一，日常门用块，定位时再看逐像素。单元数少于 `1 / alpha` 时一个假阳性就让比例超过 alpha，这种小图的误报率约等于 alpha。
- **限制**：亮度检验看不到亮度相抵的纯色偏，要查色偏时按 `channel: 0`、`1`、`2` 各跑一次。样本含 NaN 或无穷、尺寸不一致、每边不足 2 个时抛错。
