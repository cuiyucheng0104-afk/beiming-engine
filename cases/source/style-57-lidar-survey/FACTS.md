# FACTS · 《火山口》

每一条画面内文字/数字的来源。量测值都由 tools/build_data.py 从原始数据算出，可复现。

| 画面内容 | 依据 | 来源 / 方法 |
|---|---|---|
| 帕纳姆火山口 | 该地 USGS 名称 Panum Crater；"a crater surrounded by a ejecta ring, with a dome in the middle" | USGS, Long Valley Caldera Field Guide – Panum Crater: https://www.usgs.gov/volcanoes/long-valley-caldera/science/long-valley-caldera-field-guide-panum-crater |
| 加州莫诺火山链最北端 | "is the northernmost and youngest vent of the Mono Craters eruptions" | 同上 |
| 熔岩穹丘（标签） | "After the ejecta ring was built, the dome we see today was extruded in four parts." | 同上 |
| 37.9292°N 119.0455°W | 本片测区中心（抽取框中心），WGS84 | tools/fetch_ept.py 参数 |
| 1.4 × 1.4 km | 抽取框 ±700 m（Web Mercator 已按 1/cos(lat) = 1.2678 换算为地面米） | tools/fetch_ept.py |
| 航摄 USDA NAIP · 2022-08-07 | NAIP 影像 m_3711908_se_11_060_20220807（USDA-FSA-APFO，0.6 m，4 波段） | USGS The National Map USGSNAIPImagery ImageServer identify 返回的 catalog item（acquisition_date 2022-08-07） |
| 激光 USGS 3DEP · CA_SierraNevada_13_B22 | 机载激光点云项目名（EPT 版本） | https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CA_SierraNevada_13_B22/ept.json |
| 回波 2,809,914 点 | 画面里绘制的点数。框内全深度抽取 27,223,906 个回波；去掉 7/18 类（噪声）和离地高 <−3 m 或 >25 m 的离群点后，按类别随机抽稀（地面 17%，离地 >0.25 m 的非地面 16%，其余 3%，种子 57） | tools/fetch_ept.py, tools/build_data.py |
| 垂直 ×1.5（仅显示） | 三维显示的垂直夸张；所有读数在未夸张的数据上量取 | index.html（EX = 1.5） |
| 凝灰环脊线 · 描绘 | 判读：以穹丘顶为极点，每 4° 一条射线，在 2 m DTM（σ=3 平滑）上取环沟最低点外 200 m 内的最高点，半径中值滤波（11）+ 平滑后再贴回局部最高点；只保留脊线清楚的 WSW→N→ENE 一段（1.27 km），东侧凸起与南侧穹丘脚接环处不描 | tools/build_data.py |
| 剖面 · 西→东 过穹丘顶 | 正东西向剖面线，过平滑 DTM 最高点（本地坐标 E 73.5 m, N 64.5 m） | tools/build_data.py |
| 地面回波 23,951 点 · ±2 m 带 | 剖面线两侧 2 m 内的全部 2 类（地面）回波 | tools/build_data.py（section.n_returns） |
| 垂直 ×3.0（剖面图） | 图中纵横比例之比 | index.html（VEX） |
| **穹丘顶高出火山口底 97 m** | 剖面上 2 m 分箱取中位：穹丘顶 2146.57 m；东侧环沟底（剖面上两侧环沟中较低者，距穹丘顶 145 m）2049.76 m；差 96.8 m，取整 97 m。西侧环沟底 2058.24 m。高程为数据原值，差值与竖直基准无关 | tools/build_data.py（meta.json → meas） |

附带量测（未上屏）：凝灰环脊沿剖面跨度 618 m（西脊 −385 m、东脊 +233 m）；西脊高出环沟底 55.1 m，东脊 46.4 m。
