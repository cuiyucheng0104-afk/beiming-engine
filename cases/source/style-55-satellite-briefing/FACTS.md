# FACTS · 后退的冰川

片中出现的每一个事实陈述及其来源。

## 1. 地点：哥伦比亚冰川（Columbia Glacier），美国阿拉斯加，威廉王子湾（Prince William Sound）

- 来源：NASA Earth Observatory, *World of Change: Columbia Glacier*，https://earthobservatory.nasa.gov/world-of-change/ColumbiaGlacier
- 画面范围：经度 −147.62～−146.48，纬度 60.93～61.45（细节板）。

## 2. 读数"后退 24.7 公里"（片中标注"Landsat 实测 · 沿主流线 1986→2026"）

- **方法（我们自己的测量）**：在下列 Landsat Collection 2 Level-2 真彩场景上，人工目视数字化冰川主支的崩解前缘（每年一条折线，两端落在峡湾两岸，坐标见 `tools/prep.py` 中 `FRONT`）；沿峡湾中线画一条主流线（Catmull-Rom 平滑，`FLOW`），以 1986 年前缘中点为起点、2026 年前缘中点为终点，按 WGS84 球面（R = 6371.0088 km）大圆距离逐段累加。
  - 1986-07-28 LT05_L2SP_067017_19860728_02_T1 → 0 km
  - 2005-08-10 LT05_L2SP_066017_20050810_02_T1 → 12.0 km
  - 2010-09-16 LT05_L2SP_067017_20100916_02_T1 → 15.7 km
  - 2015-08-13 LC08_L2SP_067017_20150813_02_T1 → 16.0 km
  - 2020-09-11 LC08_L2SP_067017_20200911_02_T1 → 19.7 km
  - 2026-08-27 LC08_L2SP_067017_20260827_02_T1 → **24.7 km**（直线距离 22.0 km）
- 精度：影像约 29.8 m/像素，前缘为人工判读，主流线为人工绘制；读数为近似值，保留一位小数只表示计算结果，不代表 100 m 级精度。
- **独立佐证**（NASA 原文）："Since the 1980s, the glacier's Main Branch has retreated more than 20 kilometers (12 miles)"。我们的结果（>20 km）与之一致。
- NASA 同页还写道 "The branch resumed retreat until it became constricted for several years by the rocky outcrop north of the Great Nunatak. After 2019, the glacier lost contact with this stabilizing 'pinning point,' and more retreat followed." —— 与我们测到的 2010→2015 几乎不动（15.7→16.0 km）、2015 年后再次后退相符。

## 3. 年份环

- 片中只出现上述六个日期（1986、2005、2010、2015、2020、2026）；1995-07-21 与 2000-06-24 场景下游前缘不可判读（大片碎冰/低清预览），未使用。

## 4. 地图层

- 片中"地图"（印刷纸面、白色冰面、蓝色形线）是由 1986-07-28 Landsat 场景的冰面亮度掩膜生成的示意地图，画面内标注为"哥伦比亚冰川 · 地图"，代表"按 1986 年冰面绘制的地图"，不是任何已出版地图的复制。

## 5. 颜色回来

- 结尾只有 2026-08-27 场景上的冰面（亮度 > 0.42、色度 < 0.22 的连通区域，去掉前缘下游的漂浮碎冰）恢复真彩，其余保持分析员灰。没有任何伪彩或生成影像。
