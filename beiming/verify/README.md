# 验收

依据验收条件核对观测结果并记录判定。

通过契约接收观测记录和验收条件。跨组件通过契约交接。

业务契约：[谓词登记表](../kernel/contracts/predicates/CONTRACT.md)（验收条件与判定条目）、[信封](../kernel/contracts/envelope/CONTRACT.md)（验收层级与返回）。

通用约定见[契约目录](../kernel/contracts/)、[契约写法约定](../kernel/contracts/CONVENTIONS.md)和[目录归属契约](../kernel/contracts/ownership/CONTRACT.md)。

## 带噪渲染对拍：Welch 检验

`welch.mjs` 判两组带噪渲染是否收敛到同一期望，三个函数都从 `index.mjs` 导出。校准实测表、数值细则与输入校验边界见 [DETAILS.md](DETAILS.md)。

```js
import { welchTest, benjaminiHochberg, studentTwoSidedP } from './index.mjs';
const result = welchTest(seedsA, seedsB, { blockSize: 8 }); // 门只看 result.pass
```

- **`welchTest(groupA, groupB, options)`**：每边 K 个独立种子的样本，两边 K 相等且至少 2 个（建议 16 个），否则抛 `RangeError`。样本是帧对象 `{ width, height, data, channels }`（`data` 按像素交错，`channels` 缺省 1）、多层 EXR 的字节或路径。`options`：`alpha`（缺省 0.05）、`blockSize`（缺省 1 逐像素，8 是 8×8 块）、`channel`（缺省 `'luma'` 取线性亮度，也可给通道序号或 EXR 通道名）、`bins`（缺省 20）、`histogramAlpha`（缺省 0.001）、`equivalence`（缺省 0）。
- **`benjaminiHochberg(pValues, alpha = 0.05)`**：回 `{ qValues, significant, significantCount }`，只收 [0, 1] 内的数字。
- **`studentTwoSidedP(t, df)`**：Student t 分布的双侧 p 值，自由度可为非整数，大于 1e7 时按正态算。
- **做法**：按块求均值，每个单元算两边的均值和无偏方差，做 Welch t 检验（Welch–Satterthwaite 自由度），再对参检单元做 Benjamini–Hochberg 校正。
- **两种除数**：块均值是块内像素的精确和除以像素数（尾块按实际像素数），`biasMap` 是两边 2K 个带符号样本的精确和除以 K。两者都是精确商的最近双精度数：能够安全移指数时走快速路径，其余保留整数余数作单次最近偶数舍入。同一批像素换排列、同一组种子换次序，结果逐位相同。
- **输出**：平面 `biasMap`（A 减 B 的均值差）、`pMap`、`qMap`、`significantMask`，都是 `gridSize` 宽高、行主序；`significantRatio`（校正后显著的单元比例）、`rawSignificantRatio`（未校正 p ≤ alpha 的比例）、`significantCount`；`pHistogram` 是 `{ bins, counts, effectiveAlpha, lowTailP, flat }`；`totalUnits`、`testedUnits`、`deterministicUnits`（两边都无噪声且相等的单元不参检，比例与校正的分母是 `testedUnits`）、`equivalentUnits`；另有 `alpha`、`blockSize`、`kA`、`kB`。`pass` 等于 `significantRatio <= alpha && pHistogram.flat`。
- **平坦性**：`flat` 只判小 p 端有没有堆高（单侧二项精确检验），名义率按 K 留余量，K 为 16 时是 0.05167。
- **选粒度**：日常门用 8×8 块，定位时再看逐像素。K=8 的两点噪声会误报；噪声大时逐像素检不出 1.01 倍偏移，按块能检出。
- **限制**：亮度检验看不到亮度相抵的纯色偏，要查色偏按 `channel: 0`、`1`、`2` 各跑一次。样本含 NaN 或无穷、尺寸不一致、输入含空洞或读取中途被改写都抛错，不出半截结果。

## 可控与可复现：局部性与加锁重建

`controllability.mjs` 的两项回归作业，都从 `index.mjs` 导出；判定细则、帧对象与报告字段见 [DETAILS.md](DETAILS.md)。拒收输入时抛的错都带 `code: 'usage.bad-argument'`，渲染器自己抛的错原样透出。

- **`runLocalityTest({ film, patch, renderFilm })`**：把补丁作用到片子描述上，前后各渲一遍；实际变了的帧必须全落在 `explainParam` 预测的 `affects` 里，范围外变一帧就不过，一帧都没变也不过。
- **`runRebuildTest({ film, lock, renderLocked })`**：同一份片子描述加同一份锁独立重渲两遍。开渲前先照 `lock-check/0.1` 核对锁和片子描述（种子、镜头表对不上就拒）。哈希档逐帧逐位相同；`tier: 'tolerance'` 守 P8 口径：PSNR ≥ 50 dB 且超 5/255 的像素 ≤ 0.1%。
- **`compareFramePair(a, b)`**：一对帧的字节摘要、MSE、PSNR 与超差像素比例。
- **`buildControllabilityRow`、`appendControllabilityRow`**：把两份报告并成看板「可控与可复现」栏的一行（先复核报告自洽，带上 `film` 再照镜头表核预测，对不上拒收），追加进 JSONL，并发追加逐行完整。

## 多档曝光感知误差：HDR-FLIP

`hdrflip.mjs` 从 `index.mjs` 导出 `hdrFlip(reference, test, options)`，收线性 sRGB 浮点帧 `{ width, height, data, channels }` 或 EXR 字节/路径，对齐 NVIDIA flip-evaluator 1.7（ACES 色调映射）返回均值 `value`、逐像素 `errorMap` 及曝光区间与分位数。

```sh
node --test "beiming/verify/**/*.test.mjs"
```

## 噪声地板乘 k

`floorgate.mjs` 的门与合并门见 [DETAILS.md](DETAILS.md)。
