# FACTS · 地球的一秒

片中画面里的每个数字都来自下面两条事实，加上纯乘法推算（不外推、不估计分布）。

| # | 陈述（片中） | 数值 | 来源 | 原文要点 | 许可 |
|---|---|---|---|---|---|
| 1 | 每秒出生（“出生”泳道 4 个点，总数钉为 4.2/秒） | 4.2 次/秒（2025 年 1 月，全球） | 美国人口普查局新闻稿 *Census Bureau Projects U.S. and World Populations on New Year's Day*（2024-12-30）：https://www.census.gov/newsroom/press-releases/2024/population-new-years-day.html | "4.2 births and 2.0 deaths are expected worldwide every second" in January 2025 | 美国联邦政府作品，公有领域 |
| 2 | 每秒闪电（“闪电”泳道 44 个点，总数钉为 44/秒） | 44 ± 5 次/秒（云内 + 云地合计） | Christian, H. J. et al. (2003), *Global frequency and distribution of lightning as observed from space by the Optical Transient Detector*, JGR 108(D1), doi:10.1029/2002JD002347；NASA GHRC 存档 PDF：https://ghrc.nsstc.nasa.gov/pub/doc/preservation/lis/documents/otd/instrument_description/GlobalFreqDistLightningObsfromSpacebyOTD.pdf | "an average of 44 ± 5 lightning flashes (intracloud and cloud-to-ground combined) occurring around the globe every second" | 事实本身不受版权保护；片中只用数字，未用文字或图像 |

## 推算（timeline.js `RATE` × 尺度因子 `LEVELS[].F`）

| 尺度 | 出生 | 闪电 |
|---|---|---|
| 1 秒 | 4.2 | 44 |
| 1 分（×60） | 252 | 2 640 |
| 1 时（×3 600） | 15 120 ≈ 1.5 万 | 158 400 ≈ 15.8 万 |
| 1 天（×86 400） | 362 880 ≈ 36.3 万 | 3 801 600 ≈ 380.2 万 |
| 比值 | 44 / 4.2 = 10.48 → “约 10 倍” | |

## 示意部分（不是事实）

- 每个点在一秒内的横向位置、在泳道内的高度都是示意；**个数**才是事实。
- 一分钟、一小时内的点阵由固定种子随机撒点，个数 = 速率 × 时长；一天的面积块按“面积 ∝ 个数、等密度”绘制。
