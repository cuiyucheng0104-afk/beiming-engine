# FACTS · 一滴池塘水

片中出现的每一个事实与数字、它的来源或测量方法。

## 素材（真实显微照片，两张，不同样本）

| 视野 | 文件 | 来源 | 许可 | 原始描述（摘要） |
|---|---|---|---|---|
| A | material/cymbella_field.jpg（2268×3025） | https://commons.wikimedia.org/wiki/File:Cymbella_sp._-_Botanical_Garden_Dimitrie_Branzda.jpg ，作者 Dionaea-muscipula-meow，拍摄 2025-11-24 | CC0 1.0（{{self|cc-zero}}） | 标题：Cymbella sp. - Botanical Garden Dimitrie Branzda（布加勒斯特 Dimitrie Brândză 植物园） |
| B | material/pinnularia_field.jpg（2261×3392） | https://commons.wikimedia.org/wiki/File:Pinnularia_sp.jpg ，同一作者，拍摄 2025-11-24 | CC0 1.0（{{self|cc-zero}}） | 原文："The large pennate diatom identified as Pinnularia sp."；描述称该属"typically associated with … wetlands"，是淡水生态研究的指示类群 |

- 两张都是手机贴目镜拍摄，画面里可见圆形视场光阑。原文件**没有**像素尺寸、物镜倍数或标尺信息。
- A 与 B 是**两个不同样本**。片中按风格规则只在对焦呼吸（全画面模糊）处衔接（约 5.0 s 进入 A，7.8 s A→B，13.5 s B→A），右下角来源面板随之切换"视野 A / 视野 B"。片中"下潜到 A 中某处再看到 B"是剪辑衔接，不表示 B 位于 A 的那个位置。
- 片名"一滴池塘水"：A 的文件标题指向植物园水体；B 原页面未写采样地点。片中不声称两张来自同一滴水。

## 屏上的数字

| 屏上 | 含义 | 方法 / 来源 |
|---|---|---|
| 10 mm / 1 mm 比例尺 | 代码绘制的载玻片按标准尺寸 75 × 25 mm 绘制，比例尺按这个尺寸换算 | 绘制的台面，不是测量；进入目镜视野后改写为"原片无标尺" |
| 放大 ×1 / ×10 / ×100 / ×400 | **本片镜头**相对开场画面的放大倍数（开场 1 mm = 20 px） | 由相机变换计算；不是原照片的物镜倍数（未知） |
| 扫描段 · 肋纹 87 条 | 在视野 B 中 Pinnularia 壳面一侧肋纹带上，沿 (700,1680)→(2000,1778) 像素线段数到 87 个周期峰 | tools/striae.py：灰度图沿该线取 13 px 宽剖面，减 40 px 高斯趋势，2 px 平滑，峰间距 ≥ 7 px、显著度 ≥ 0.5σ；峰间距中位数 14.5 px（IQR 13.5–15.0）。数的是这一段，不是整个壳面 |
| 中央节 | Pinnularia 壳面中部的加厚区（central nodule），原页面描述："a distinctly thickened central area that expands laterally into a conspicuous central nodule" | 圆环按图像位置 (1372,1800) 手工放置 |
| 视野内硅藻壳 36 个 | 视野 A 中、片中可见圆形范围内，轮廓清楚的完整或近完整硅藻壳 | tools/marks_A.py：作者在原分辨率照片上逐个圈点；碎片、杂质、失焦团块不计；圆外（照片左侧被裁的光阑区）的不计。是人工计数，不是自动识别 |

## 绘制而非拍摄的部分

台面（石墨色）、载玻片、水滴落下与溅起、涟漪、目镜外的暗场、所有标注线与面板，均为代码绘制的示意。
