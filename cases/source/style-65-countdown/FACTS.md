# FACTS — 画面上每个数字、时间、名称的来源

| 画面上的内容 | 来源 | 原文 / 测量 |
|---|---|---|
| 阿尔忒弥斯 I · 2022.11.16 · LC-39B | NASA 图库条目元数据（Artemis I Launch 2022 CU tracking from Press Site）https://images.nasa.gov/details/Artemis%20I%20Launch%202022%20CU%20tracking%20from%20Press%20Site_compressed | "launches the agency's Artemis I flight test, Wednesday, Nov. 16 from Launch Complex 39B … lifted off at 1:47 a.m. ET" |
| 控制条：地面 GLS → 箭载 ALS（片子开始时 ALS 已接管） | NASA 博客 2022-11-16 https://www.nasa.gov/blogs/missions/2022/11/16/launch-managers-give-go-to-proceed-with-terminal-count-launch-set-for-147-a-m/ | "GLS sends "Go for automated launch sequencer" command (T-33S)"；"Core stage flight computer to automated launching sequencer (T-30S)" |
| 旗"氢燃尽点火器 · H2 IGNITERS · T−12"（落在 T−12） | 同上 | "Hydrogen burn off igniters initiated (T-12S)" — 计划时刻 |
| 旗"RS-25 ×4 启动 · ENGINE START · T−6.36"（T−6 落定，文字给计划时刻） | 同上；"×4"来自 NASA 自己的发射解说（同一 iso 片的原声，参考时刻 83.6–92.6 s） | "RS-25 engines startup (T-6.36S)"；解说："all four RS-25 engines on the core stage and two solid rocket boosters" |
| 控制条"飞行 FLIGHT"、时钟翻转、旗"助推器点火 · SRB ×2 · T−0" | NASA 博客同上；解说同上 | "Liftoff (T-0)"；"two solid rocket boosters" |
| CAM 1 休斯敦控制室 = 同一时段 · 未逐帧同步 | NASA 片名 "Mission Control Houston During Artemis I Launch"（jsc2022m000284） | 片中无时钟可对；只说明是发射期间的同一时段，放在不与时钟冲突的秒里（T−14…T−1.3，画面里没有任何可对时的事件） |
| CAM 2–10 实时同步 | 测量（下面） | |

## 同步测量（material/sync.json）
- 参考轴 ref：iso 片第一段机位（ML PAO PTZ）的源时间。其余各段的广播声与之做互相关（8 kHz 单声道、18 s 窗口），相关系数 0.90–0.99，得到 shift 表。
- 零点：机位 913（WTR V1 WIDE ENGINES）逐帧（30 fps）看助推器点火的白色羽流，第一帧出现在 ref 21.70 s；另外 7 个近景机位的亮度突变都在 ref 21.6–22.3 s 之间。
- 交叉核对：观礼机位画面里 NASA 的倒计时牌在 ref 9.3 s 显示 −00:00:13，ref 9.7 s 显示 −00:00:12（−13 → −12 的翻转落在 T−12.4 与 T−12.0 之间，与零点 = ref 21.70 一致）。
- 映射：片长时间 f → T = f − 15，ref = f + 6.70，源时刻 s = ref + shift。全片无变速、无重排、无跳时。
- 计划时刻与实际听到的时刻分开：画面上的旗只写 NASA 公布的计划时刻；解说员的口数（"seven" 在 T−7.19，"one" 在 T−0.17）不进片（用户决定无解说），只用于对时。
- 返修复核（2026-10-31）：从 iso 原片 990.569 s 机位段取同步广播声（995–1023 s），faster-whisper small.en 逐词定时，换算到片长时间 f = 源秒 − 992.269：
  "and here we go" f 2.81；"hydrogen burn off igniters initiat-" f 5.03–7.67；"seven" f 8.11（T−6.89）；"six" 8.81；"five" 9.79；"four" 10.75；"stage engine start" 11.13–12.07；"three" 13.05；"two" 13.53；"one" 14.57–14.89（T−0.43…−0.11）；"boosters in ignition" 15.39–16.19；"and liftoff of Artemis one" 17.29–18.95。
  ASR 词边界有 ±0.3 s 的误差（上面"seven"与前一次测的 T−7.19 相差 0.3 s）。结论不变：解说比时钟晚约半秒，"one" 落在零点前的静默拍里，所以现场声不进片（TREATMENT §0）。这段音频只用于测量，没有放进成片，测完已删除。

