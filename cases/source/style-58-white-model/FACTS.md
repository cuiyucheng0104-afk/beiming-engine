# FACTS · 涨潮一米

每个上屏数字都由 `tools/prep.py` 从下列公开数据算出（写入 `data/stats.json`），画面与配乐都读同一份文件。

| 上屏内容 | 数值 | 来源 / 计算方法 |
|---|---|---|
| 地点与中心坐标 | 金银岛 · 旧金山湾，37.821°N 122.370°W | 台面陆地（含耶尔巴布埃纳岛）质心，由 DEM 网格反算；UTM 10N |
| 比例 | 1:2000（台面 3192 m × 1488 m → 1.60 m × 0.74 m） | 渲染坐标 1 单位 = 2000 m；建筑和地形垂直 1:1，不夸张 |
| 建筑 | 657 栋（台面内全部） | DataSF《Building Footprints》ynuv-fyni（https://data.sfgov.org/d/ynuv-fyni），许可 Open Data Commons PDDL（公有领域贡献）。高度 = `hgt_median_m`（"zonal median height surface value, meters"），低于 1 m 的按 1 m 显示；轮廓来自 2010 年 Pictometry 体块，数据集 data_as_of 2023-09-11 |
| 地面与湾底 | 2 m 网格 | USGS 3DEP 数字高程（3DEPElevation ImageServer，含水深），NAVD88 米，美国政府作品（公有领域）。建筑立在其轮廓下的 DEM 最低地面上，与水位用同一个表面 |
| 今天的平均大潮高潮位（MHHW） | NAVD88 + 1.798 m | NOAA CO-OPS 站 9414290 San Francisco 潮汐基准面（epoch 1983–2001）：MHHW 3.602 m、NAVD88 1.804 m（相对站基准）→ 3.602 − 1.804。https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/9414290/datums.json?units=metric |
| "+1 m" | MHHW + 1.00 m = NAVD88 2.798 m | **示意情景**，不是某一年份的预测；画面标注"浴缸模型 · 示意" |
| 225 栋建筑进水 | 225 / 657 | 某栋建筑轮廓内任一 2 m 格子在水位 ≤ +1.00 m 时与开阔湾面连通，即计为进水（其中 2 栋轮廓今天就碰到 MHHW 水面：码头边） |
| 31.2 公顷陆地被淹 | 31.2 ha（岛上 MHHW 以上陆地共 226 ha） | 浴缸 + 连通模型：priority-flood 求每格的"溢出水位"，≤ +1.00 m 且今天在水面以上的格子面积之和。不计海堤、排水泵、地面沉降和波浪 |
| 从这里漫过岸线 +0.97 m | 溢出水位 +0.974 m | 西北住宅区背后是一个低于岸线的"碗"：水位到 +0.974 m 才漫过岸边最低处（图上钉子处），然后整碗被淹。碗内从 +0.974 到 +1.00 m 的铺开顺序按"离漫堤点的路径距离"排列，这是展示用的示意，终态（+1.00 m 时的被淹范围）是计算结果 |
| 计数滚动 | 被淹公顷数、进水栋数随水位实时取值 | `stats.json` 的 area_curve / bld_curve（按上面的展示顺序累加） |
| 太阳钟 | 夏至 2026-06-21，日出 05:50、日落 20:35（PDT） | NOAA 太阳位置算法（NOAA Solar Calculator 电子表格公式），台面中心坐标；日出/日落取太阳高度 > −0.833°；方位与高度驱动真实的平行光与阴影 |

注意：两套数据年份不同（建筑轮廓 2010、DEM 为 3DEP 现有最佳数据），金银岛正在重建，现状建筑可能与模型不同。
- 影长 50 m（太阳钟段 b10 的描影与量线）：#154 号建筑（DataSF Building Footprints，`hgt_median_m` = 21.24 m）在 2026-06-21 18:25 PDT 的影长，太阳高度 22.8°（NOAA 太阳位置算法，tools/prep.py 生成的 data/stats.json `sun` 表插值），按平地计算 L = 21.24 ÷ tan 22.8° ≈ 50 m；由 main.js `TRACE` 在渲染时计算，示意，不计地形起伏。
