# 音效设计与拟音工艺

> 范围：把“画面里的物理动作、图形标注与叙事重音”设计成可信、清脆、不扎耳、零违和底噪的声音层。覆盖 **A 北冥风格路线 · WebGL 三渲二**、**B 北冥原生 · BNE** 与 **C 北冥代码动画风格 · 86 式** 三条路线的拟音选材、分层合成、空间摆位与听审迭代。
> 解决什么：导演意图与音效师（Sound Designer）思维如何结合；为什么纯 DSP 合成像假玩具、单条采样硬贴缺细节、微脉冲听不见、归一化会炸出单侧白噪；怎样跨工业微距、东方写意巨物、古风器物与动态图形做系统化音效创作。影视视听契约、物理建模与心理声学十二原则见 [SOUND-THEORY.md](../../../docs/audio/SOUND-THEORY.md)，声画同步容差归口在 [animation.md §5.7](animation.md)，交付响度与封装归口在 [video.md §5.8](video.md) 与 [../DIRECTING.md 步骤 8](../DIRECTING.md)。
> 怎么用：先看 §2.0 五段工程管线总览，开工前按 §2.1–§2.2 列好“本体清单”与“声音词典”；做具体动作查 §3 配方库与 §4 跨路线表；遇到听感反馈查 §6 翻译表定位物理根因；交付前按 §7“审片十问”逐条过检。
> 标注与术语统一见 [README.md](README.md)：【仓库实证】（含·复算／·实测／·文档／·代码）、【通用工艺】（含·建议）、【推断】、【未实现】。`$甲`、`$乙`、`<研究工作区>` 的展开见本章 §10 与 [README.md](README.md)。
> 实跑基线：本章代码护栏与单元测试在 Linux x86_64（Python 3.12 / NumPy / SciPy / FFmpeg）上实跑通过；《按一下》（`style-60-teardown`，19.75 秒圆珠笔微距拆解片）v1→v6 六轮盲听迭代位于未入库的 `<研究工作区>/pilot-teardown-sfx/`，《追电车的夏天》（`style-27-cel-anime-80s`，19.50 秒赛璐璐海岸追车片）v1→v2 取证与重混位于未入库的 `<研究工作区>/pilot-cel-anime-sfx/`，《港口集市》（`style-31-hd-2d`，19.00 秒微缩港镇雨过天晴片）v1→v2 乐效融合与母带重混位于未入库的 `<研究工作区>/pilot-harbor-sfx/`，引用这三组实测数时均注明未入库口径。

---

## 0. 一页结论

1. **合格的音效设计是“导演叙事意图 × Sound Designer 分层配方 × 取证级检索选材”的三元乘积。** 纯函数振荡器加滤波噪声做不出熟悉物件的认知可信度；单条原始录音直接贴又撑不起镜头放大后的精密质感。
2. **拉片第一步是读真画面源码与静帧，禁止只看文字梗概漏掉复合场景与关键动作音。** 复合外景必须拆成“远景底床 + 主纹理 + 生机点缀”三层（如海岸小镇 = 都市底噪 + 海浪拍岸 + 天空海鸥），同时逐镜盘点物件画高占比 $h/H$ 并审计已下载素材零闲置、零张冠李戴（§1.10）。
3. **选材前先做“因果本体审计”，耳朵听的是物理因果而不是孤立音色。** 无源手按圆珠笔一旦混入电动变焦镜头、舵机、持续正弦嗡鸣或 `np.tile` 死循环切片，哪怕只有 −28 dBFS，人耳也会立刻判假（§1.1）。
4. **响度服从人耳约 200 ms 能量积分，不能拿波形峰值骗耳朵。** 2.8 ms 的针尖微咔即使峰值给到 −21.5 dBFS，积分响度惩罚也高达约 −18.5 dB（短窗 RMS 跌至 −57 dBFS），在成片里完全听不见；微细动作必须匹配画面真实运动时长并用软膝激励托起包络体（§1.2）。
5. **峰值归一化不会提升信噪比，只会把切片底噪原样放大 G dB。** 截取 `raw_pk = 0.0025 ~ 0.048` 的轻擦或静音缝隙做归一化，等于把话筒白噪硬抬 `+26 ~ +52 dB`；`de_room_gate` 最多压回约 22 dB 且救不了瞬态底下的嘶声，唯一解法是在加载入口拦截低幅高噪切片（`library.load_slice`，§1.3）。
6. **声像跟观众注意力落点（POA）走，声距跟物体画高占比（$h/H$）走。** 按景别硬限声像上限（`SHOT_PAN_CAP`）并配逐 100 ms 窗左右平衡核对（`audio.balance`，§1.4）；同一声源在大远景（`1/12` 画高）、侧跟近景（`0.45` 画高）与摇臂远去（`1/7` 画高）之间必须经 `screen_scale_to_distance` 拉开 `8–16 dB` 远近电平差、空气高频吸收与干湿比，禁止被逐事件归一化抹平（§1.11）。
7. **微距与特写靠“四层超真实配方”出质感，图形标注走“跨界隐喻 + 家族同构 + 叠层强调”。** 微距叠 `identity + detail + body + space`（`foley.composite_mechanism`，§1.5）；工程引线与弹窗锁死同一 `hitech_laser_trace` / `hitech_micro_beep` 词元，重点镜头开 `emphasis_layer=True` 叠泛音（§1.6）。
8. **双向乐效平衡铁律：既严禁配乐独占 `-14 LUFS` 淹没音效，也严禁把配乐压到 `-24 LUFS` 以下沦为背景蚊子声，靠“互补 EQ 分槽 + 推子音量曲线 + SSL 总线粘合压缩母带”三板斧实现乐效融为一体。** 有配乐叙事片的终混分轨黄金配比为 `Music ≈ -15.8 ~ -17.8 LUFS`、`FX ≈ -15.5 ~ -17.5 LUFS`、`Foley ≈ -19 ~ -22 LUFS`、`AMB ≈ -22 ~ -25 LUFS`（装饰 `UI ≈ -21 ~ -24 LUFS`）；靠 `sculpt_stem_eq` 频谱镶嵌、`volume_curve` 呼吸推拉与 `bus_glue_compress` / `master_chain`（`25 ms` 慢起音保瞬态、`110 Hz` 侧链高通防抽吸、`1.5–3 dB` 软膝压缩粘合 + 微峰值驯服），在不损宏观动态 `LRA`（`5.5–9.5 LU`）的前提下将感知响度提至 `-13.2 ~ -13.5 LUFS`（§1.12）。
9. **高效收敛靠四步元方法闭环**：把用户的自然语言听感翻译成可测物理量 → 按时间码拆轨取证定位罪魁切片 → 历次问题时间码永久进回归表 → 同一类坑第二次出现立即沉入 `engine/audio/` 公共护栏（§2.9）。

---

## 1. 音效设计十六条法则

前四条决定一个声音**该不该存在、听不听得见、干不干净、摆在哪里**；中五条决定它**像不像、是不是一家人、对得准不准、主次清不清楚、切点顺不顺**；后七条决定整部片**画面元素全不全、远近纵深真不真、乐效双向平衡融不融、视觉遥测准不准、人声对白透不透、配乐弧线顺不顺、长片母带稳不稳**。

### 1.1 因果本体律：每一声都必须有可指认的“因”

- **法则**：影片里的每一个声音只能归属以下三层之一：
  1. **物理本体层**：由画面内物体的真实动力源决定（`passive` 无源手按/弹簧/重力/冷兵器、`pneumatic` 气动流体、`motorized` 电机/伺服/内燃机）；
  2. **编码界面层**：HUD 标尺、信息框、转场提示音，观众默认它是“信息图层”，接受电子/光学合成隐喻；
  3. **意象转译层**：写意动画里现实无声或超现实对象的象征发声（如水墨晕染用放慢绢帛与水滴转译，《北冥》汽笛与鲲鸣同源【仓库实证·代码】`audio/design.py:3-5`）。
  不属于任何一层的声音一律删除。
- **数学判定与阈值**：
  - 无源机构（`power='passive'`）严禁命中电机/伺服语义词，且信号层面 `80–3000 Hz` 窄带固定谱峰连续驻留时长 `sustained_tone_ms ≤ 120 ms`、包络周期自相关 `loop_periodicity ≤ 0.85`【仓库实证·代码】`engine/audio/sfx_judge.py:518-593`。
- **实证与反例**：《按一下》v4 在拆解圆珠笔时混入电动变焦镜头（154795）、舵机（748050）、持续正弦底音与 `np.tile` 循环拼接，盲听立即暴露“圆珠笔没有电机，为什么听见了类似电机的声音”【仓库实证·实测】（未入库试制区）；v5 清零有源声源并换用纯无源拨盘与单次实录后消除。
- **引擎入口**：`tools/fetch_sfx.py`（`_PASSIVE_MECH_QUERY_RE` 检索拦截）、`engine/audio/sfx_judge.py`（`ARCHETYPES['motorized']` 与 `judge_ontology`）。

### 1.2 可听积分律：响度看时间积分能量，不看瞬时峰值

- **法则**：人耳响度感知在约 `200 ms` 时间窗内对声能做积分【通用工艺】。峰值相同的短脉冲，持续时间 $d$ 越短，感知响度越低；瞬态前景事件必须具备“起音 + 体（$\ge 30\text{ ms}$）+ 尾”，或严格对齐画面笔触的真实运动时长。环境声床按积分响度（LUFS）定电平，离散瞬态按峰值与短窗 RMS 双口径定电平。
- **数学判定与阈值**：
  $$\Delta L_{\text{penalty}} \approx 10 \cdot \log_{10}\!\left(\frac{d}{200\text{ ms}}\right)\quad (d < 200\text{ ms})$$
  当 $d = 2.8\text{ ms}$ 时，$\Delta L_{\text{penalty}} \approx -18.5\text{ dB}$。承担叙事的微动作，`50 ms` 短窗 RMS 须高于局部环境声床 $\ge 12\text{ dB}$【通用工艺·建议】；微划线脉冲下限锁定 `tick_ms >= 12.0`【仓库实证·代码】`engine/audio/director.py:523-580`。
- **实证与反例**：《按一下》v2 把引出线起笔裁成 `2.8 ms` 针尖脉冲（峰值 `-21.5 dBFS`，短窗 RMS 跌至 `-57 dBFS`），盲听直接反馈“太短了，我听不见”；v3 对齐页面 `overlay.js` 真实动画帧长（折线 `360 ms`、标尺 `450 ms`）并用 `tanh` 软膝托起包络体后清晰可辨【仓库实证·实测】（未入库试制区）。
- **引擎入口**：`engine/audio/director.py`（`subtle_precision_cue`、`hitech_laser_trace`、`HDRMixer.add_bed`）。

### 1.3 洁净增益律：底噪跟着归一化增益原样放大

- **法则**：峰值归一化不会改善信噪比。把一段原始峰值为 `raw_pk` 的音频切片归一化到目标峰值 $P_{\text{target}}$，所需增益 $G$ 会把该切片里的话筒本底白噪一并抬高 $G\text{ dB}$。当 $G > 30\text{ dB}$ 时，连压在瞬态正下方的话筒嘶声也会一起浮出水面；`library.de_room_gate` 的衰减下限为 `0.08`（约 `-22 dB`，`engine/audio/library.py:186`），无法救回超额放大的脏切片——**唯一解法是拒用该切片并换高信噪比素材**。
- **数学判定与阈值**：
  $$G = 20 \cdot \log_{10}\!\left(\frac{P_{\text{target}}}{\text{raw\_pk}}\right),\qquad L_{\text{out\_floor}} = L_{\text{slice\_floor}} + G$$
  - 前景拟音硬门禁：$G \le 20\text{ dB}$（当 $P_{\text{target}} = 0.95$ 时等价于 `raw_pk >= 0.095`），且总线前放大后底噪 $L_{\text{out\_floor}} \le -56\text{ dBFS}$（严苛特写建议 $\le -60\text{ dBFS}$）【仓库实证·代码】`engine/audio/library.py:247-300`。
  - 经过 $\ge 1.2\text{ kHz}$ 高通且混音总线电平较低的纯高频 UI 装饰纹理，可显式放宽至 $G \le 24\text{ dB}$，禁止无上限裸调 `norm()`【通用工艺·建议】。
- **实证与反例**：《按一下》v5 在 `1.25 s` 与 `5.5 s` 出现刺耳左声道白噪，拆轨取证查出四段低幅切片：`clockwork_275802 [0.38:0.48]`（`raw_pk = 0.0025`，$G = +51.6\text{ dB}$）、`plastic_cap_154406`（`raw_pk = 0.0197`，$G = +33.7\text{ dB}$）、`pen_499190` 前导轻擦（`raw_pk = 0.048`，$G = +25.9\text{ dB}$）以及全段无瞬态的床垫弹簧录音；v6 拦截低幅切片后，`1.2–1.4 s` 左声道电平从 `-11.4 dBFS` 回落至 `-24.8 dBFS`【仓库实证·实测】（未入库试制区）。
- **引擎入口**：`engine/audio/library.py`（`load_slice`、`de_room_gate`）。

### 1.4 焦点声像律：声像跟视觉落点走，按景别收束上限

- **法则**：观众戴耳机看特写时，心理预期声音发自“视线注视的焦点（POA）”，而不是三维模型底座在广角/斜拍相机下的屏幕边缘投影。景别越紧，前景拟音允许的声像摆幅越窄。
- **数学判定与阈值**：
  - 按景别声像硬上限（`SHOT_PAN_CAP`）【仓库实证·代码】`engine/audio/director.py:426-432`：
    - 微距 / 大特写（`macro`）：`±0.12`
    - 特写（`close`）：`±0.25`
    - 中景（`medium`）：`±0.35`
    - 全景（`wide`）：`±0.60`
  - 逐 `100 ms` 有声窗（$\max(L, R) > -26\text{ dBFS}$）连续两窗以上左右能量差 $|L - R| \le 6\text{ dB}$【仓库实证·代码】`engine/audio/qa.py:110-134,648`。
- **实证与反例**：《按一下》v5 全片单声道相关系数高达 `0.97`（`audio.mono` 通过），但 `1.25 s` 笔尾微距斜拍把基座坐标算成 `pan = −0.63`，叠加 §1.3 的归一化底噪，左耳比右耳高出 `12.4 dB`；v6 将微距按压收束至 `+0.06`、整片零件声像限制在 `±0.34` 内，`0–7 s` 有声窗最大左右差降至 `3.32 dB`【仓库实证·实测】（未入库试制区）。
- **引擎入口**：`engine/audio/director.py`（`SHOT_PAN_CAP`、`pan_trajectory`、`HDRMixer.add_cue(..., shot_scale=..., follow_motion=True)`）、`engine/audio/editorial.py`（`couple_motion_trajectory`）、`engine/audio/qa.py`（`audio.balance`）。
- **连续动态声像轨迹（Object Trajectory Panning）**：画面中横向穿越或环绕的声源（如飞虫掠过、暗器飞射、载具驶过）不得给固定单点声像，必须按画面横向轨迹生成连续 `pan(t)` 曲线（`editorial.couple_motion_trajectory` 一次性合成受景别收束的等功率声像、时变距离高频吸收、混响干湿比、径向多普勒与掠过中心音量峰，或调 `director.pan_trajectory` / `add_cue(..., follow_motion=True)` 从页面遥测切片）。

### 1.5 尺度夸张律（Sonic Caricature）：镜头放大几倍，声音就补几层精密细节

- **法则**：微距镜头把几毫米的棘轮放大到满屏时，贴麦录到的单条真实圆珠笔声会显得单薄；反过来，水墨巨物占满画幅时，普通动物周期的扑翼声会显得轻飘。声音必须按视觉放大倍率做**分层超真实构建**。
- **四层固定配方**：
  1. **`identity`（认知锚点层）**：画面真实物件的近麦录音（如真实圆珠笔按压），保持原调或极小移调（`±1.5 st`），负责让大脑瞬间认出“这是圆珠笔”；
  2. **`detail`（高频清脆层）**：同物理家族的精密机械录音（单反快门拨盘、千分尺棘轮、微动开关，高通 `1.9–2.6 kHz`），补足放大后肉眼可见的齿尖咬合感；
  3. **`body`（重量与腔体层）**：实录重型卡扣或金属弹簧底盘（低通 `4.2–5.4 kHz`，冲击锚点刻意延后 `1.8 ms` 以免掩蔽主瞬态），替代廉价合成器低频正弦扫频，加上管腔半波长微反射（`_barrel_reflections`）；
  4. **`space`（微距近干空间）**：微距机械只挂极短近场早期反射（`close_dry`，`wet ≤ 0.12`），长混响会直接抹糊微咔瞬态。
- **实证与反例**：v1 用积木声加模态合成缺 `identity` 显得假；v4 橙色齿轮缺独立拨齿与锁止 `detail` 层显得闷；v5–v6 用 `composite_mechanism` 与 `precision_gear_turn`（加速拨齿 → `35–40 ms` 蓄力悬停 → 双阶落锁 `KA-TA`）实现高频清脆咬合【仓库实证·代码】`engine/audio/foley.py:704-833`。
- **引擎入口**：`engine/audio/foley.py`（`composite_mechanism`、`precision_gear_turn`、`shift_material`）、`engine/audio/procedural.py`（`modal_impact` 含 `radiation='accel'`、`phisem_particles`、`aerodynamic_whoosh`、`minnaert_bubbles`、`stylized_cartoon`、`thunder_strike`、`pouring_vessel`、`bouncing_disc`、`shock_blast`）。

### 1.6 家族同构律：同类视觉图元锁死同一词元，重点靠叠层强调

- **法则**：开工前建立全片《声音词典》（`视觉组件类 → 声音词元`）。只要画面上出现同一种设计组件（如 `label()` 引出线与参数说明菜单），无论在 8 秒还是 14 秒，底层必须调用**同一个声音词元函数与频段家族**。当某个核心镜头需要叙事强调时，**严禁推翻原词元另换音效**，而是在原词元之上叠加高五度/高八度晶莹副层并微抬 `+1.5 ~ 3.0 dB`。
- **实证与反例**：《按一下》v4 在 `8.0–9.5 s` 用镭射走线配微滴音，到了 `13.75 s` 核心结论标签“每按一次 · 转 45°”却换了另一套提示音，被用户指出前后割裂；v5 统一复用同一套走线与 `hitech_micro_beep`，仅开启 `emphasis_layer=True` 叠入双泛音确认层（实测电平抬升 `+1.37 dB`），既保持全片统一设计感又完成了叙事点睛【仓库实证·代码】`engine/audio/director.py:650-715`。
- **引擎入口**：`engine/audio/director.py`（`hitech_laser_trace`、`hitech_micro_beep(..., emphasis_layer=True)`）、`engine/audio/foley.py`（`ActionVariationDeck`）、`engine/audio/editorial.py`（`schedule_action_series`）。
- **同质复用与连续动作防疲劳的边界**：
  - **标准化视觉符号可原样复用（`policy='uniform'`）**：统一制式的界面刻度、同规格菜单确认音保持音色一致以建立秩序感；
  - **连续物理交互严禁同波形复读（`policy='anti_fatigue'`）**：连续拳击、脚步、劈砍、敲击或拼插若连续播放同一条波形超过 2 次，会立即触发听觉疲劳（机关枪效应）。必须在保留核心主音色的前提下按三级梯度做区分：① 同套不同 Take 不重样轮询；② 随画面动作力度在阈值之上叠加副层质感（如重击叠低频体量或衣料摩擦）；③ 仅有单条素材时施加保瞬态微移调（相邻音高差 $\ge 0.35\text{ st}$，重击微沉、轻击微扬），并通过 `editorial.schedule_action_series` 按相邻间隔（IOI）自动收紧密集连击尾音、末击完整释放余韵。

### 1.7 锚点同步律：对齐感知冲击中心（P-Center），不对齐文件头

- **法则**：真实录音切片往往带 `5–40 ms` 前导空气摩擦或手指触碰，把切片第 0 样本贴在事件帧上必然听起来滞后。所有瞬态放置必须先测包络能量斜率重心（`sync_anchor`），让感知冲击锚点严格落在画面结果帧上。
- **数学判定与阈值**：同步容差窗口（早于结果帧不超过约 `10 ms`、晚于结果帧不超过 `1` 帧）统一按 [animation.md §5.7](animation.md) 与 `engine/audio/cuecheck.py` 判定，本章不另立口径。
- **引擎入口**：`engine/audio/library.py`（`sync_anchor`、`get_anchored`）、`engine/audio/foley.py`（`place_anchored`）、`engine/audio/cuecheck.py`。

### 1.8 层级留白律：同一瞬间只留一个听觉主角

- **法则**：遵循 Walter Murch“2.5 声部法则”与 Randy Thom“峰值前声学真空”。任意 `85 ms` 聚簇窗内前景独立事件不超过 `2` 个，超出者自动退居群像背景层；在全片“最重要的一声”落地前 `4–12` 帧抽空环境与配乐声床，并用 6 临界频带零相位侧链闪避给前景瞬态让出频谱窥视窗（Auditory Glimpse）。
- **引擎入口**：`engine/audio/director.py`（`HDRMixer`、`carve_negative_space`）、`engine/audio/editorial.py`（`ThreeStemWorkstation`）、`engine/audio/qa.py`（`audio.masking`）。

### 1.9 三干线分轨、切点接缝与画面时值剪辑律

- **三干线动态配比（`amb` / `fx` / `foley`）**：全片声音按职能拆成环境音（随场景与氛围铺底）、硬效/设计音（随道具机关与调性事件发声；非写实画面按世界观选 `scifi` / `hitech` / `cartoon` 等声族池）与拟音（专管人物、动物、生物的脚步衣料与肢体动作，纯抽象几何/HUD 片型可关闭 `foley`），预设见 `director.WORLD_PROFILES` 与 `sfx_vocab.WORLD_PALETTES`（支持 `sfx_vocab.classify_stem` 与 `plan_film_sound_pool` 自动分流规划）。
- **硬切场景微交叉淡化 vs. 蒙太奇桥接**：当镜头发生空间硬切（如室外切室内）时，环境声严禁零样本硬拼（出咔嗒声）或长拖尾串味，默认在切点做 **`40–65 ms`（标准 `55 ms`，约 1–1.5 帧）等功率微交叉淡化**（`ThreeStemWorkstation.set_scenes` / `HDRMixer.add_scene_ambience(..., transition='hard_cut')`）；仅在导演明确做蒙太奇或情绪延宕时改用长交叉淡化（`montage`）或 `j_cut` / `l_cut`。
- **素材时值服从画面生命周期**：过程音效长于画面动作时按起止帧精裁阻尼淡出（可叠制动微咔嗒），短于画面时走随机偏移等功率非周期延展（严禁 `np.tile`）；冲击余韵音效遇下一镜头硬切时在切点前平滑收尾防跨场穿帮（`editorial.smart_edit_clip` / `director.fit_to_span`）。

### 1.10 真画面逐镜盘点与三层环境拆解律（Visual Frame Spotting & Three-Layer Ambience）

- **法则**：严禁只读文字梗概或分镜简表做声音设计。开工第一步必须直接阅读真实绘制源码（如 `shots.js`、`bg.js`）并逐张审看抽帧静帧，逐镜列出：
  1. **三层复合环境构成**：`base_hum`（远景底床，如海岬小镇都市微底噪、远山风底）+ `primary_texture`（主环境纹理，如近岸海浪拍岸、雨打屋檐）+ `spot_life`（间歇生机点缀，如天空海鸥啼叫、远犬、林鸟）；
  2. **全部前景与画外预警事件及画高占比 $h/H$**：并审计已下载素材池与入轨事件一一对应，严禁搜而不剪或张冠李戴。
- **实证与反例**：《追电车的夏天》v1 只看文字简表未看绘制代码与静帧，漏搜画面里明确画出的 5–6 只扇翅海鸥、右半屏 9 栋海岬小镇建筑与电车入画前预警喇叭；且已下载的 30 个 CC0 文件中有 14 个（`46.7%`）闲置未用，甚至在 `3.25 s` 拿自行车铃 `378354.ogg` 冒充电车声，而在 `5.42 s` 少女回头准备追车时却一声自行车铃都没剪入【仓库实证·实测】（未入库试制区）。
- **引擎入口**：`engine/audio/sfx_vocab.py:1506-1611`（`SCENE_AMBIENCE_LAYERS` 九类复合场景原型、`decompose_scene_ambience`、`plan_film_sound_pool`）、`engine/audio/editorial.py:559-689`（`build_layered_ambience`）。

### 1.11 视觉占比驱动声学远近律（Screen-Ratio Depth Law）

- **法则**：同一声源在不同景别或摇臂运动中的音量、空气高频滚降与混响干湿比，必须由其在画面中的表观尺寸占比 $r = h/H \in (0, 1]$ 连续驱动，严禁跨镜头共用静态电平或被混音器逐事件归一化反向抹平。
- **数学判定与阈值**：
  $$d(r) = \text{clip}\!\left(d_{\text{ref}} \cdot \left(\frac{r_{\text{ref}}}{r}\right)^{\alpha},\; d_{\min},\; d_{\max}\right),\qquad \Delta G_{\text{depth}}(d) = -20\beta \log_{10}\!\left(\frac{d}{d_{\text{ref}}}\right)$$
  默认以近景跟拍 $r_{\text{ref}} = 0.45 \mapsto d_{\text{ref}} = 1.8\text{ m}\ (0\text{ dB})$ 为基准（$\alpha = \beta = 0.95$）：大远景 $r = 1/12 \mapsto 8.93\text{ m}\ (-13.2\text{ dB})$，摇臂拉远 $r = 1/7 \mapsto 5.35\text{ m}\ (-9.0\text{ dB})$，特写 $r = 0.85 \mapsto 0.98\text{ m}\ (+5.0\text{ dB})$，远景与近景天然拉开 `8–16 dB` 纵深对比【仓库实证·代码】`engine/audio/director.py:435-520`。连击动作的 `forces` 力度阶梯亦须映射为真实分贝差（如坐姿稳蹬→站起猛蹬拉开 `+4 ~ +6 dB`），不得按固定 `target_lufs` 逐击重归一化。
- **实证与反例**：《追电车的夏天》v1 在 `4.33 s` 从 S1 大远景（电车占画高 `15.9%`）硬切到 S2 近景（占画高 `32.8%`，面积放大 `4.24` 倍）时，因未传 `screen_ratio` 且跨镜共用单条轨迹，切点前后电平仅差 `+0.54 dB`；S2 站起全身猛蹬被逐子事件归一化抹平，比坐姿仅高 `+0.14 dB`【仓库实证·实测】（未入库试制区）。
- **引擎入口**：`engine/audio/director.py`（`screen_scale_to_distance`、`depth_gain_db`、`resolve_screen_ratio_curve`、`HDRMixer.add_cue(..., screen_ratio=...)`）、`engine/audio/editorial.py`（`couple_motion_trajectory`、`ThreeStemWorkstation.add_sfx / add_foley / add_foley_series`）。

### 1.12 双向乐效平衡、融合三板斧与 SSL 总线粘合母带律（Bidirectional Balance, Pocket EQ, Fader Riding & Bus Glue）

- **法则（双向乐效平衡铁律）**：既**严禁配乐独占 `-14 LUFS` 淹没音效**，也**严禁靠全局死压把配乐压到 `-24 LUFS` 以下沦为背景噪音**！有配乐叙事片的终混分轨必须落在黄金平衡区间：**`Music ≈ -15.8 ~ -17.8 LUFS`、`FX ≈ -15.5 ~ -17.5 LUFS`、`Foley ≈ -19 ~ -22 LUFS`、`AMB ≈ -22 ~ -25 LUFS`**（装饰 `UI ≈ -21 ~ -24 LUFS`；`HDRMixer` / `ThreeStemWorkstation` 默认 `music_ceiling_offset_db = -2.6`、`continuous_duck_db = 1.8`、`set_music(..., target_lufs = -18.5)`，杜绝全局低顶棚与宽频闪避叠加的双重压制）。音乐悬停留白须用挂留和弦呼吸（Musical Breath）与反向引子（Pickup Swell）衔接而非硬乘零死断，片尾升华编曲须同步上扬。
- **融合三板斧（让音效长在音乐里面，不降音质、不扁动态提响度）**：
  1. **互补 EQ 分槽（Complementary Pocket EQ，`sculpt_stem_eq`）**：用频谱错位镶嵌替代粗暴降音量——`AMB` 让出 `< 115 Hz`（`110 Hz` 二阶高通清底）与 `500–1800 Hz` 旋律和声核心区（`800 Hz, Q=0.75` `-3.0 dB` 暖中频凹槽）；`SFX / Foley` 滤除低中频泥沼（`Foley` `130 Hz` 高通 + `320 Hz` `-2.0 dB`；`FX` `30 Hz` 清次声保 `55–140 Hz` 滚雷/灯塔胸腔重音 + `280 Hz` `-2.2 dB` 去泥沼）并聚焦 `2.0–5.5 kHz` 清脆瞬态咬合区；配乐完整保留 100% 低中频基音厚度，仅在 `3.2 kHz` 稳态微让位 `-1.0 dB` 及关键瞬态的毫秒级窗口于 `2.0–5.0 kHz` 做微频带动态避让【仓库实证·代码】`engine/audio/director.py:108-154`。
  2. **推子音量曲线（Fader Riding，`volume_curve`）**：用分贝域分段余弦平滑断点曲线（`[(t_s, gain_db), ...]`，零样条过冲）随乐句呼吸、独奏浮现与高潮转折平滑推拉 `music / amb / fx / foley` 各干线（如木管主题进入或管弦终章涌出时，环境声主动收低 `-2 ~ -5 dB`；滚雷/爆燃瞬间配乐微避让 `180–250 ms` 后立即回弹）【仓库实证·代码】`engine/audio/director.py:59-105`。
  3. **母带总线粘合压缩与微峰值驯服（SSL Bus Glue，`bus_glue_compress` + `master_chain`）**：采用经典 SSL G-Bus 风格立体声联动前馈压缩——`25 ms` 慢起音完整放过前 `20 ms` 乐器拨弦与拟音清脆瞬态、`160 ms` 平滑释放、`110 Hz` 侧链高通防滚雷/底鼓低频引发全片抽吸（Pumping）、`1.5–3 dB`（上限 `max_gr_db = 3.2 dB`）`6 dB` 软膝自适应压缩把分离声部粘合成有机整体，配合 `28 Hz` 次声波清理 + `< 100 Hz` 零相位 M/S 低频收紧 + 奇次软膝微瞬态驯服（削孤立毛刺 `1.0–1.5 dB`，99.8% 主体零染色）+ 自适应 `+0.5 dB @ 10 kHz` 空气光泽，在不损宏观动态范围 `LRA`（保持 `5.5–9.5 LU`）的前提下将交付感知响度提至饱满有力的 **`-13.2 ~ -13.5 LUFS`**（稳居 `-14 ± 1 LU` 交付窗，真峰值 `≤ -1.5 dBTP`）【仓库实证·代码】`engine/audio/mixing.py:146-329`。
- **数学判定与阈值**：
  - `audio.masking` 双向门禁：普通前景事件主频带听觉窥视信噪比 `soft >= -5.0 dB`（`hard >= -12.0 dB`），`role='hero'` 核心事件 `soft >= -1.0 dB`（`hard >= -8.0 dB`）；当存在活跃 `fx/foley` 但配乐能量高于 `fx + foley` 总和 `> +9.0 dB` 时报 `music_dominance` 告警（防配乐淹死音效）；反之当存在非静音 `music.wav` 分轨但终混积分响度低于总母带 **`> 8.5 LU`**（`MUSIC_BURIED_WARN_LU = 8.5`）时报 **`music_buried` 告警**（防配乐被过度压制）【仓库实证·代码】`engine/audio/qa.py:196-538`。
- **实证与反例**：① 淹死音效反例——《追电车的夏天》v1 未设配乐收束，`stems/music.wav` 高达 `-14.03 LUFS`（占 `-14.01 LUFS` 母带 `99.56%` 预算），淹死海浪与链条声；② 压死配乐反例——《港口集市》v1 矫枉过正，叠加 `music_ceiling_offset_db = -5.5`、`continuous_duck_db = 4.5` 与 6 频带挖槽，把 `music.wav` 死压到 **`-25.08 LUFS`**（低于 `-14.02 LUFS` 母带整整 `11.06 LU`！），而 `ui` 冲至 `-13.09 LUFS`、`amb` 达 `-18.53 LUFS`，盲听一针见血指出“单独音效还不错，但混音不行，音乐完全被压掉了”；v2 改用互补 EQ 分槽 + 推子呼吸曲线 + SSL 总线粘合母带后，配乐重回 `-15.8 ~ -17.5 LUFS` 温暖主轴，12 项关键音效特征频带依然正信噪比颗颗分明，成片响度与平均密度显著跃升且宏观动态 `LRA` 完整保留【仓库实证·实测】（未入库试制区）。
- **引擎入口**：`engine/audio/mixing.py:146-329`（`bus_glue_compress`、`master_chain`）、`engine/audio/director.py:59-154,718-1353`（`volume_curve`、`sculpt_stem_eq`、`HDRMixer`）、`engine/audio/editorial.py:692-1231`（`ThreeStemWorkstation` / `FourStemWorkstation`）、`engine/audio/qa.py:196-538`（`audio.masking`、`music_dominance`、`music_buried`）。

### 1.13 自动画面遥测与角色轨迹绑定律（Automatic Visual Telemetry & Actor Binding）

- **法则**：运动声源的横向声像 `pan(t)`、画高占比远近 `scale(t) = h/H` 与碰撞脉冲严禁手抄估算数字；一律由舞台遥测传感器或视频流分析器从真实渲染画面自动提取并直绑声轨。
- **双路采集与自动绑定**【仓库实证·代码】：
  1. **页面型作品实时遥测（`engine/stage/telemetry.js`）**：三维场景用 `projectThreeActor(object3d, camera, opts)`（纯 4×4 矩阵投影，输出 `x, y ∈ [-1, 1]`、`scale ∈ [0, 1.5]`、`depth >= 0.1 m` 与视锥裁剪 `visible ∈ {0, 1}`），二维画布用 `trackCanvasActor(rect, viewport)`，经 `createAudioTelemetry(actors).install(window)` 挂载 `window.AUDIO_TELEMETRY(t, f)`。在 `film.json` 设 `"audio": { "telemetry": true }` 后，`film build` 的 `probe` 步骤自动传 `--telemetry` 写出 `kinematics.json`（注入 `BEIMING_KINEMATICS`）。
  2. **Python 打点与成品视频流式分析（`engine/audio/spotting.py`）**：`spot_from_kinematics(kin)` 自动剥离切点 `±1` 帧伪峰，提取 `cuts`、`holds`、`motion_peaks` 与每个角色的可见区间、`pan_points`、`screen_ratio` 及径向速度；外部或 B 路线无源码成片用 `spot_from_video(video_path)` 经 FFmpeg 管道 O(1) 帧内存流式提取四分区 `Kinematics`。
  3. **一键角色绑定**：`FourStemWorkstation.bind_actor(kin, actor_id, wave, ...)` 直接将角色轨迹转为受 `SHOT_PAN_CAP` 约束的连续声像、`screen_scale_to_distance` 远近衰减、空气吸收与多普勒频移。

### 1.14 四干线对白共振峰让位律（Four-Stem Dialogue Formant Pocket）

- **法则**：含旁白或角色台词的叙事片升级为 `vo + music + amb + fx/foley` 四干线架构。**严禁用全频段宽带乘法 `music * duck` 硬压配乐**（会抽走低音根基并造成呼吸抽吸感），必须采用零相位共振峰频带精准挖槽。
- **数学判定与阈值**【仓库实证·代码】：
  - **人声通道雕塑（`sculpt_stem_eq` `'vo'`）**：`85 Hz` 二阶高通清口水低频 + `-1.8 dB @ 240 Hz (Q=1.1)` 去胸腔浑浊 + `+1.2 dB @ 3.0 kHz (Q=0.9)` 提咬字清晰度 + `-1.0 dB @ 7.2 kHz (Q=2.0)` 柔化齿音，有声窗（`> -42 dBFS`）定标 `-16.0 LUFS` 并挂 `rt=0.32 s, room_wet=0.04` 微早反防干贴。
  - **共振峰动态挖槽（`carve_dialogue_pocket` / `FourStemWorkstation.set_dialogue`）**：15 ms 前视、20 ms 起音、180 ms 释放包络，仅动态衰减配乐 `800–4200 Hz` 人声共振峰核心带（默认 `4.2 dB`；`amb` 衰减 `600–4500 Hz` `2.5 dB`；`fx/foley` 衰减 `1.2–4.2 kHz` `1.8 dB`），**配乐 `< 350 Hz` 大提琴与低音底盘保持 `0.00 dB` 零衰减**。
  - **机器门禁与出片闭环**：作品含 `dialogue.json` 时 `film build` 自动构建配音并注入 `BEIMING_DIALOGUE_DIR`；`engine.audio.qa` 的 `audio.dialogue` 硬门核查有声句段 `1–4 kHz` 信噪比（`>= +2.0 dB` 通过，`[-2.0, 2.0) dB` 报 `dialogue_masked` 软告警，`< -2.0 dB` 或削波退出码 4 并在 `video` 渲染前快速拦截）。

### 1.15 情绪导引乐谱与 Cover 配乐闭环律（Emotional Guide-Track & Cover Score CLI）

- **法则**：AI 配乐不能靠纯文本盲抽导致切点脱节、中段断片或片尾塌陷；必须先由影片镜头表与事件表生成确定性**程序化情绪导引乐谱（Guide Track）**锁死调性、节拍、呼吸留白与终章抬升弧线，再以 Cover 模式重绘管弦/民乐实录质感。
- **引擎入口与契约**【仓库实证·代码】：`npm run audio:music -- <guide|build|probe> [film]`（`tools/audio/music.mjs` ↔ `engine/audio/music_gen.py`）：
  - `plan_sections_from_film(film)` 从镜头与事件自动推导能量弧线（开场铺垫 `0.35` → 展开推进 `0.55..0.70` → 高潮前悬停呼吸 `0.42` → 终章高潮抬升 `0.92`）；
  - `build_guide_score(...)` 确定性合成 48 kHz 立体声导引轨（跨段和声铺底 + 锁拍琶音脉冲 + 切镜前上行引子 + 终章高八度/高五度声部抬升，中段零静音断档，峰值 `-3.0 dBFS`）；
  - `generate_cover(...)` 支持 `--provider guide`（离线确定性）与 `--provider acestep`（按 `--endpoint` → `BEIMING_ACESTEP_URL` → `--ssh` 临时本地端口转发连接 ACE-Step 1.5 Cover API，退出零残留清理子进程；`soxr` 重采样至 48 kHz 立体声 `PCM_24` 精确样本数，带 SHA-256 缓存与 D11 `aigc` 描述符）。

### 1.16 长片流式粘合母带律（Long-Form Streaming Bus Glue）

- **法则**：分钟级（如 10 分钟）长片严禁为每个音效分配全片长度 `float64` 数组或在母带阶段一次性展开数 GB 缓冲；必须走稀疏总线加跨分块保状态流式粘合母带，兼顾短片级音质与亚 GB 内存预算。
- **数学判定与实测**【仓库实证·代码】：`engine/audio/stream.py` 的 `Bus`（`float32` 局部切片写入）配合 `stream.bus_glue_compress` 与 `stream.master_chain(..., chunk_s=10.0)`，在分块原地处理时跨块传递 IIR 滤波器 `zi` 状态与 Numba `@njit` 慢起音压缩包络状态：与全量 `mixing.master_chain` 响度偏差 `< 0.05 LU`、分块边界零咔嗒，10 分钟（`600 s`）立体声实测峰值内存 `854 MB < 1.0 GB`（满足 `H11`）。

---

## 2. 标准创作与迭代工作流（九步闭环）

拿到一部短片或一个镜头表后，按以下「五段管线 × 九步闭环」推进；不要跳过前两步直接搜音效。五段管线背后的声画契约、物理建模与心理声学十二原则（P01–P12）完整推导见 [SOUND-THEORY.md](../../../docs/audio/SOUND-THEORY.md)。

### 2.0 五段工程管线总览【仓库实证·代码】

```text
[1. 逐镜盘点与锁池] 真画面源码/静帧 -> sfx_vocab (decompose_scene_ambience / plan_film_sound_pool) + sfx_judge (含 hf_envelope_buzz / hf_whistle_db) + library.load_slice
       │
       ▼
[2. 合成与演化] foley (composite_mechanism / precision_gear_turn / shift_material) + procedural (modal / phisem / whoosh / bubbles / cartoon / thunder / pour / disc / blast)
       │
       ▼
[3. 时值与连击剪辑] editorial.smart_edit_clip (长裁阻尼·短非周期延展·切点收尾) + editorial.schedule_action_series (三级防疲劳 + IOI 紧尾)
       │
       ▼
[4. 同步与远近贴合] sync_anchor + screen_scale_to_distance + editorial (couple_motion_trajectory / build_layered_ambience)
       │
       ▼
[5. 乐效融合与调片闭环] FourStemWorkstation / HDRMixer + mixing/stream.master_chain + qa + serve.mjs (?preview=1 分轨实时调片)
```

| 管线阶段 | 核心工程模块与入口函数 | 解决的创作与工程问题 |
|---|---|---|
| **阶段 1 · 逐镜盘点与三层锁池** | `sfx_vocab.WORLD_PALETTES`、`SCENE_AMBIENCE_LAYERS`、`decompose_scene_ambience`、`classify_stem`、`search_by_world`、`plan_film_sound_pool`；`tools/fetch_sfx.py --world / --plan`；`sfx_judge.extract_metrics`、`judge_wave`、`judge_ontology`；`library.load_slice` | 按画面源码与静帧把复合外景拆成「远景底床 + 主纹理 + 生机点缀」三层，锁定 `amb / fx / foley` 候选池，拦截电机污染、低 `raw_pk` 高噪切片及高频周期颗粒电嗡声（`hf_envelope_buzz`）与窄带哨音尖刺（`hf_whistle_db`） |
| **阶段 2 · 实录复合与物理合成** | `foley.composite_mechanism`、`precision_gear_turn`、`layer_event`、`shift_material`；`procedural.modal_impact`（含 `radiation='accel'`）、`phisem_particles`、`aerodynamic_whoosh`、`minnaert_bubbles`、`stylized_cartoon`、`thunder_strike`、`pouring_vessel`、`bouncing_disc`、`shock_blast`；`director.hitech_laser_trace`、`hitech_micro_beep` | 有实录走四层超真实复合；缺精确匹配或需运动连续耦合/非写实夸张时走「激励 × 共振 × 耦合」确定性全带宽（`0–20 kHz`）物理因果与卡通合成 |
| **阶段 3 · 时值精裁与防疲劳编排** | `editorial.smart_edit_clip`、`editorial.schedule_action_series`、`foley.ActionVariationDeck`、`director.fit_to_span` | 过程音贴合画面时长且零死循环；冲击余韵不在硬切后穿帮；连拳/蹬踏按三级防疲劳演化并随 IOI 自动紧尾、末击放尾 |
| **阶段 4 · 锚点同步与远近声像贴合** | `library.sync_anchor`、`foley.place_anchored`、`director.screen_scale_to_distance`、`depth_gain_db`、`editorial.couple_motion_trajectory`、`editorial.build_layered_ambience`、`director.SHOT_PAN_CAP` | P-Center 精确咬合结果帧；由画高占比 `screen_ratio` 自动拉开远近 `8–16 dB` 纵深、空气高频吸收、混响干湿比、多普勒与三层立体声环境轨 |
| **阶段 5 · 双向乐效融合与母带粘合** | `director.sculpt_stem_eq`、`director.volume_curve`、`editorial.ThreeStemWorkstation`、`director.HDRMixer`、`mixing.bus_glue_compress`、`mixing.master_chain`、`qa.analyze`、`cuecheck` | 双向黄金分轨配比（`Music ≈ -15.8 ~ -17.8`、`FX ≈ -15.5 ~ -17.5`、`Foley ≈ -19 ~ -22`、`AMB ≈ -22 ~ -25 LUFS`）、互补 EQ 频谱分槽、推子呼吸曲线、SSL 总线慢起音粘合压缩提响度保 `LRA`，以及 `music_dominance` / `music_buried` 双向门禁 |

### 2.1 第一步：读真画面源码与静帧，列《逐镜元素、三层环境与本体清单》
禁止只看文字梗概！逐镜检查绘制代码与抽帧静帧，填清两张表：
- **三层环境表**：`镜头 ｜ 远景底床 base_hum（如都市微嗡）｜ 主纹理 primary_texture（如海浪拍岸）｜ 生机点缀 spot_life（如天空海鸥方位）`（可调 `sfx_vocab.decompose_scene_ambience` 自动生成候选检索词）；
- **前景本体与比例表**：`对象名 ｜ 出现帧区间与画高占比 h/H ｜ 所属层（物理本体 / 编码界面 / 意象转译）｜ 动力源（passive / pneumatic / motorized / digital）｜ 严禁混入的声族`。
- 例：圆珠笔拆解片 → 笔壳/弹簧/棘轮归 `物理本体 · passive`，严禁 `servo / motor / synth drone / 循环切片`；引出线与尺寸标注归 `编码界面 · digital`，允许 `hitech laser pulse / micro-beep`。

### 2.2 第二步：定《全片声音词典》
把全片重复出现的动作与图形归纳为 4–8 个标准“声音词元”（Morpheme），规定每个词元的基础配方与高潮强调方式（叠层参数），确保跨镜头家族同构。

### 2.3 第三步：上下文感知检索与三干线锁池（Search Strategy）
音效师搜素材不是搜物体表面名词，而是按**物理发声机制 + 世界观调性**拆词搜索（用 `tools/fetch_sfx.py` 检索 CC0 素材库；完整 82 大类 / 753 子类 UCS v8.2.1 词表与 24 类复合检索配方见 [sfx-vocab.md](sfx-vocab.md)，命令行用 `node tools/env/py.mjs tools/fetch_sfx.py --plan films/<名字>/film.json --world <调性>` 规划整片三干线池，或用 `--vocab "<词>" --world <调性>` 反查）：
- **搜认知锚点（Identity）**：搜具体物件原词，如 `ballpoint pen click`、`retractable pen button`、`sword unsheath`；
- **搜高频精密层（Detail）**：跨品类借用微型精密机械，关键词带 `camera shutter dial`、`pocket watch escapement`、`micrometer ratchet`、`micro switch click`、`safe combination dial`（无源机械词会自动触发 `fetch_sfx.py` 的 `_PASSIVE_MECH_QUERY_RE` 电机污染过滤【仓库实证·代码】`tools/fetch_sfx.py:42-49`）；
- **搜高科技界面层（HUD / UI）**：关键词显式带上 `hitech`、`telemetry`、`hud`、`micro beep`、`laser scan`（触发 `is_hitech_query` 上下文放行【仓库实证·代码】`tools/fetch_sfx.py:52-55`，不会误伤有机拟音的电子合成器禁令）。

### 2.4 第四步：零训练物理初筛（Stage 1 Judge）
下载候选素材或校验程序化合成波形后先跑 `python -m engine.audio.sfx_judge <目录> --manifest sfx_manifest.json`（或调 `sfx_judge.extract_metrics` / `judge_wave`）：
- 自动剔除 MP3 11 kHz 低通砖墙伪高采、削波破音、50/60 Hz 交流哼声、口技拟音谐波污染与大教堂长混响（`rt20_s` 超标）；
- 对宽带非乐音原型（`friction_cloth / whoosh / water / ambience / foley_snap / impact / wood`）额外拦截高频程序化合成伪影：`> 6 kHz` 颗粒窗或帧跳周期调制电嗡声（`hf_envelope_buzz` 上限 `0.50–0.58`）与 `4–16 kHz` 相对局部中值基线的窄带金属哨音尖刺（`hf_whistle_db` 上限 `17.0–19.5 dB`），而 `metal_blade / sustained_tonal / tonal_ui / low_drone / mechanical` 乐音与金属原型自动豁免；
- 对无源机械额外调用 `sfx_judge.judge_ontology(..., power='passive')`，筛除残留持续窄带嗡鸣（`> 120 ms`）的伪机械录音。

### 2.5 第五步：洁净增益切片（Forensic Slicing）
一律通过 `library.load_slice(path, t0, t1, max_gain_db=20.0)` 切取所需片段，严禁先切一段安静缝隙再裸调 `dsp.norm()`。若返回超限报错，说明该时间段只有擦碰底噪，立即改切录音中的主瞬态峰或更换文件。

### 2.6 第六步：四层实录复合、物理合成与时值/防疲劳剪辑
- 机械撞击/卡扣走 `foley.composite_mechanism`；多齿旋转咬合走 `foley.precision_gear_turn`；实录缺失或需参数连续耦合时走 `procedural`（`modal_impact` 含 `radiation='accel'` 远场加速度辐射、`phisem_particles`、`aerodynamic_whoosh`、`minnaert_bubbles`、`stylized_cartoon`、`thunder_strike`、`pouring_vessel`、`bouncing_disc`、`shock_blast`）；
- 过程音长短精裁与停止制动微咔走 `editorial.smart_edit_clip`；连续摩擦（衣袂、旋拧）走 `foley.granular_bed` 或 `RoundRobinDeck`，连续打击/脚步走 `editorial.schedule_action_series`，**严禁使用 `np.tile` 硬循环拼接**。

### 2.7 第七步：P-Center 锚定、画高占比远近纵深与动态轨迹贴合
- 从页面导出的 `events.json` 或 `film.json`（v2）读取整数帧唯一起点；
- 三层复合外景用 `editorial.build_layered_ambience` 构建单声道兼容环境床；静态或跨景别声源传入 `screen_ratio`（如远景 `0.12`、侧跟 `0.45`、摇臂远去 `0.14`）与 `shot_scale`（微距夹在 `±0.12` 内，特写夹在 `±0.25` 内）；横向穿越或纵深运动声源经 `editorial.couple_motion_trajectory(..., screen_ratio=...)` 合成五维运动声像与 `8–16 dB` 远近层次。

### 2.8 第八步：双向乐效融合、互补 EQ 分槽、推子曲线与 SSL 总线粘合母带收口
- 整片优先用 `editorial.ThreeStemWorkstation`（或底层 `director.HDRMixer`）统一编排 `set_scenes(..., curve_points=...)`（硬切默认 `55 ms` 微过渡）、`set_music(..., music_ceiling_offset_db=-2.6, continuous_duck_db=1.8, target_lufs=-18.5, music_focus_windows=..., curve_points=...)`、`add_sfx` 与 `add_foley_series`（自动保留 `forces` 连击力度阶梯，跨总线隔离 Murch 聚簇）；
- 启用**融合三板斧**：① `glue_eq=True`（`sculpt_stem_eq`）让 `AMB` 退让 `< 115 Hz` 与 `500–1800 Hz` 旋律区、`SFX/Foley` 去低中频泥沼聚焦 `2.0–5.5 kHz` 瞬态、配乐保 100% 低中频基音；② `curve_points`（`volume_curve`）随乐句起势与高潮平滑推拉各干线，使终混分轨稳居 `Music ≈ -15.8 ~ -17.8`、`FX ≈ -15.5 ~ -17.5`、`Foley ≈ -19 ~ -22`、`AMB ≈ -22 ~ -25 LUFS`；③ 核心叙事点注册负空间（`carve_negative_space`），前景瞬态对配乐仅做 `2.0–5.0 kHz` 毫秒级微频带避让；
- 母带由 `master_glue=True`（`mixing.master_chain`）一次收口：`28 Hz` 次声清理 + `< 100 Hz` M/S 低频收紧 → SSL 总线慢起音粘合压缩（`25 ms` 起音、`110 Hz` 侧链高通、`1.5–3.2 dB` 软膝压缩）→ 奇次软膝微瞬态驯服 + `10 kHz` 丝绒光泽 → `loudness_to` 收口至饱满响度 `-13.2 ~ -13.5 LUFS`（或 `-14.0 LUFS`，真峰值 `≤ -1.5 dBTP`，保持全片 `LRA 5.5–9.5 LU`，首尾样本归零），五条分轨逐一施加 4× 过采样 `tp_limit` 防削波；视频封装直接编码 AAC，禁止二次套 `loudnorm`（[video.md §5.8](video.md)）。

### 2.9 第九步：实时带声分轨调片、机器取证 QA 与盲听反馈四步闭环
跑完 `npm run audio:qa` 与 `npm run audio:cuecheck` 后，可在本地运行 `npm run serve` 并在影片地址后加 `?preview=1` 开启 WebAudio 声卡时钟相位锁定调片栏（`Space` 播放/暂停、`←/→` 逐帧步进、`[/]` 跳镜头切点、`L` 循环、`amb/fx/foley/music/vo/ui` 分轨实时无咔嗒 Mute/Solo 拆轨定位，以及 `↻ 重混声音` 免刷新热重载），再交人类导演全速盲听。收到听感修改意见时，严格执行**四步元方法**：
1. **听感词 → 物理量翻译**：查 §6 翻译表，把主观描述变成可测的声学指标假设；
2. **按时间码拆轨取证**：定位到具体秒数，打印该窗口内每一条分轨、每一个切片的 `raw_pk`、增益 $G$、左右声道 RMS 与频谱峰，找到铁证再动手，绝不盲目整体压音量；
3. **痛点时间码永久入回归表**：凡被指出过一次异常的时间段（如 `1.20–1.45 s`、`5.5–6.3 s`），写成脚本末尾的自动断言，后续每出一版自动复查；
4. **二次踩坑沉入引擎护栏**：同一个问题在脚本里修到第二次，必须抽成 `engine/audio/` 的默认参数检查或 QA 门规则。

---

## 3. 核心声音配方库（已验证参数区间）

以下配方均已在 `engine/audio/` 实现并通过单测【仓库实证·代码】，括号内为经过听审验证的推荐参数区间：

| 配方场景 | 引擎函数 | 关键结构与防翻车参数 |
|---|---|---|
| **微型卡扣 / 按钮按压**（圆珠笔帽、精密开关、枪械保险） | `foley.composite_mechanism`（`engine/audio/foley.py:704`） | `identity` 用原物实录（`identity_pitch_st` 在 `-1.0 ~ +1.0` 内保真）；`mechanism` 叠高采棘轮/微动开关；`latch_body` 延后 `1.8 ms` 补壳体重量；`tube_mm=120~145` 加管腔反射；`body_drive=1.6~2.1` 软膝托起包络中段 |
| **精密齿轮转动与落锁**（步进棘轮、密码盘、机械表冠） | `foley.precision_gear_turn`（`engine/audio/foley.py:775`） | 拆成两段因果叙事：前段 `teeth=3~6` 颗独立齿尖按 `accel=1.25~1.5` 加速拨过且音高逐齿微升，经 `hover_ms=30~42` 蓄力悬停后，精确在到位帧落入主齿面撞击 + `9.5 ms` 止逆爪副咔嗒（`KA-TA`），`lock_jump_db=4.5~6.5`、`crisp_hp=2200~2600 Hz`，空间混响 `wet ≤ 0.10` |
| **螺纹旋松 / 旋紧与弹簧** | `foley.helical_thread`、`spring_coil`（`engine/audio/foley.py:590,639`） | 旋松含“静摩擦破拆微咔 → 加速螺距滑擦 → 末圈管口四分之一波长气封轻啵”；弹簧禁用家具大床垫弹簧录音，只取高频受抑金属微颤（`wire_hz=1100~2400 Hz`） |
| **高科技 HUD 镭射走线**（工程引出线、矢量标尺扫描） | `director.hitech_laser_trace`（`engine/audio/director.py:583`） | `dur` 严格取页面矢量绘制真实时长（如 `0.36 s`、`0.45 s`）；`f_lo=6800~7400 Hz`、`f_hi=12000~13200 Hz` 余弦平方窗微晶脉冲串，脉冲率随 ease-out 从 `118 Hz` 减速至 `46 Hz`；内置 `3.5 kHz` 耳道共振防扎耳凹槽（`-6.5 dB, Q=1.35`）与 `14.8 kHz` 丝绒滚降；折线拐点传 `elbow_at` |
| **高科技菜单微提示与重点强调** | `director.hitech_micro_beep`（`engine/audio/director.py:650`） | `1.2 ms` 余弦软起音消除数码硬毛刺，`harmonic_freq` 吸附全片调性根音；常规标注用 `pattern='double'`、`emphasis_layer=False`；全片核心结论标注保持同根音与同 `pattern`，开启 `emphasis_layer=True` 在 `+12 ms / +36 ms` 叠入高五度与高八度泛音副层 |
| **实体制图 / 卡尺微划线**（非电子纸面工程风） | `director.subtle_precision_cue`（`engine/audio/director.py:523`） | 零电子合成音；以 `12–35 ms` 怀表擒纵/千分尺微咔起笔，衔接等长纸面笔尖非周期纹理（`_extend_nonperiodic`）与收笔微触点 |
| **刚体模态撞击 / 粒子群碰撞 / 流体破空 / 气泡 / 卡通原语** | `procedural.modal_impact`、`phisem_particles`、`aerodynamic_whoosh`、`minnaert_bubbles`、`stylized_cartoon`（`engine/audio/procedural.py`） | `modal_impact` 支持实录瞬态 `exciter_sample` 卷积激励、`key` 调性吸附，以及 `radiation='accel'` 二阶接触力差分辐射（`-12 dB/oct` 滤除软敲 `< 100 Hz` 位移拖尾浑浊，`radiation='disp'` 逐样本兼容）；`aerodynamic_whoosh` 遵循 Strouhal 频率与 $v^3$ 功率律；卡通世界观用干净 `stylized_cartoon` |
| **三维闪电雷鸣 / 杯壶时变注水 / 圆片弹跳欧拉盘 / 激波爆破** | `procedural.thunder_strike`、`pouring_vessel`、`bouncing_disc`、`shock_blast`（`engine/audio/procedural.py`） | 全带宽（`0–20 kHz`）因果合成：`thunder_strike` 建三维梯级先导与 `branches` 分叉，按双耳推迟到达叠偶极 N 波冲击子、4 层大气吸收壳与 `strokes` 二次回击（`overhead / diagonal / distant_roll`）；`pouring_vessel` 以幂律 Minnaert 微泡流激励时变四分之一波长闭底圆筒杯腔前三阶奇次模态，共振峰随 `fill_start -> fill_end` 单调上扬；`bouncing_disc` 合成 `coin_brass / coin_silver / jade_token / stone_go` 简并分裂双音闪烁（至 `16–19 kHz`）、几何递减弹跳与 Moffatt 欧拉盘加速滚振（`22 -> 95 Hz`）及平拍止音；`shock_blast` 合成 `firework / cannon / cork_pop / whip_crack` 前导弹道 N 波脆裂、Friedlander 超压波与地面反射干涉尾迹 |
| **过程音精裁 / 连击力度保留 / 视觉占比远近与三层环境** | `editorial.smart_edit_clip`、`schedule_action_series`、`couple_motion_trajectory`、`build_layered_ambience`、`ThreeStemWorkstation`；`director.screen_scale_to_distance`（`engine/audio/editorial.py`、`director.py:435`） | 过程音长裁阻尼、短走非周期延展，冲击余韵在硬切前收尾；`screen_ratio` 自动拉开远景 `1/12` 与近景 `0.45` 之间 `8–16 dB` 纵深；`build_layered_ambience` 合成三层外景 |
| **互补 EQ 分槽 / 推子音量曲线 / SSL 母带粘合压缩** | `director.sculpt_stem_eq`、`director.volume_curve`（`engine/audio/director.py:59,108`）；`mixing.bus_glue_compress`、`mixing.master_chain`（`engine/audio/mixing.py:146,300`） | `AMB` `110 Hz` 高通 + `800 Hz` `-3.0 dB` 让旋律区，`Foley` `130 Hz` 高通 + `320 Hz` `-2.0 dB`、`FX` `280 Hz` `-2.2 dB` 去泥沼；分贝域余弦平滑推子曲线；SSL 总线 `25 ms` 慢起音、`110 Hz` 侧链高通、`1.5–3.2 dB` 软膝压缩 + 微峰值驯服提响度至 `-13.2 ~ -13.5 LUFS` 保 `LRA` |

---

## 4. 跨路线（A / B / C）泛化矩阵与参数边界

《按一下》验证的是“暗调工业微距 + 高科技 HUD”。把同一套八条法则推广到北冥其余主力题材时，必须按以下矩阵切换参数方向（未在对应成片上逐项复测的数值标【通用工艺·建议】）：

| 路线与题材类型 | 法则切换要点（与微距机械相反或新增的规律） | 关键参数边界【通用工艺·建议】 |
|---|---|---|
| **A · 东方写意巨物**（《北冥》鲲鹏、云海、水墨山河） | **尺度律反向使用**：体积越大，动作前摇与事件间距越慢，音高越低，混响尾越长。手机与笔记本扬声器放不出 `<60 Hz` 纯基频，巨物压迫感必须靠 `80–160 Hz` 奇次谐波激发大脑“缺失基频”效应。水墨晕染现实无声，走**意象转译层**（放慢的绢帛摩挲、深水暗涌）。 | 时间拉伸倍率 $s \in [2, 5]$，`foley.shift_material` 下移 `-6 ~ -12·log2(s)` 半音并设 `preserve_msi=0.5~0.7`；峰值前负空间提前 `8–12 帧`（`director.carve_negative_space`）；POA 用 `fog_wide` / `open_sky`（RT `2.6–4.0 s`）；全景声像放宽至 `±0.60`；`20–120 Hz` 相对最强频段不超过 `-2 dB`（`audio.bands`） |
| **A · 古风冷兵器与器物**（《青锋行》刀剑、木竹机关） | 沿用四层超真实配方（`identity` 剑鸣 + `detail` 鞘口金属刮擦 + `body` 剑格撞击），但**严禁照搬 3.5 kHz 深凹槽**：刀剑出鞘的锋利临场感恰恰集中在 `2.2–5.0 kHz`，挖掉会像隔着棉被拔剑。调性吸附改用中国五声音阶（`scale='pentatonic'`）。 | `metal_blade` 原型允许高调性度（`tonal_max=0.92`，`sfx_judge.py:72`）；`3.5 kHz` 凹槽不加或不超过 `-2.0 dB`；金属余韵 `0.6–1.4 s` |
| **B · 原生写实渲染 · BNE**（写实工业、建筑、自然场景） | 物理本体层最严格：空间距离衰减与早期反射跟着三维相机真实物距走（`dsp.space_place`），高速掠过镜头主体加多普勒频移。材质表一对一映射 `identity` 实录。 | 声像上限仍按景别受 `SHOT_PAN_CAP` 约束（防止特写镜头贴耳偏斜）；混响 RT 严格匹配场景物理容积 |
| **C · 纯图形代码动画 / Keynote**（矢量图表、瑞士平面、动态海报） | 画面无物理实体，**因果本体律转化为“视觉材质隐喻一致性”**：扁平几何矢量配纯净调性合成音，纸张/胶片肌理配纸张/快门实录拟音，二者不混搭。离散瞬态严格卡音乐节拍网格。 | 非高潮段离散音效密度 `≤ 3–4 个/秒`（过多会像打字机噪音）；文字逐字敲击音仅在显式电报/终端机风格中使用；空间保持极干（`wet ≤ 0.08`） |
| **叙事角色表演片**（含对白、人物动作） | 对白是最高优先级信号；**“零电机死循环”泛化为“零机关枪重复”**：脚步、衣袂、呼吸必须走 `RoundRobinDeck` 洗牌池并带每次微移调与增益抖动。主观心理镜头切 `POA_PRESETS['subjective_internal']`。 | 对白期间 `fx / ui` 总线在 `1.5–3.5 kHz` 侧链让位 `-4 ~ -7 dB`；连续同类动作每次随机移调 `±0.5 st`、电平抖动 `±1.5 dB` |

---

## 5. 真实迭代翻车反例表（微距拆解与海岸叙事取证台账）

以下问题均真实发生在《按一下》v1→v6、《追电车的夏天》v1→v2 与《港口集市》v1→v2 音效试制过程中【仓库实证·实测】（未入库试制区），覆盖了 AI 与新手音效师最常踩的全部典型陷阱：

| 阶段 | 盲听反馈要点 | 物理与工程根因 | 实测异常指标 | 根治手段 | 引擎护栏状态 |
|---|---|---|---|---|---|
| **《按一下》v1** | 机械声不够真实，划线不够精密 | 用积木咔嗒声加纯 DSP 模态正弦合成充当圆珠笔；引出线用金属刀刃鸣响加通用扫描音 | 缺真实塑料/金属微弹簧瞬态谱包络 | 确立“导演意图 × 音效师分层 × 精确检索”三元法，引入真实圆珠笔近麦录音做 `identity` | 已固化（`foley.composite_mechanism`） |
| **《按一下》v2** | “太短了，我听不见”；画面只有半分辨率预览 | 误把“精密微声”理解成“极短极轻”，将起笔咔嗒裁成 `2.8 ms` 针尖脉冲并把母带降到 `-18.1 LUFS` | 峰值 `-21.5 dBFS`，但 `200 ms` 积分惩罚约 `-18.5 dB`，短窗 RMS 仅 `-57 dBFS` | 对齐页面真实绘制时长（`360 ms / 450 ms`），`tanh` 软膝托起包络体，恢复 `-14.3 LUFS` 与 `1080p` 画面 | 已固化（`subtle_precision_cue` 脉冲下限 `12 ms`） |
| **《按一下》v3** | 好很多，但缺精密仪器高频咬合感；细线不该只用笔声，应用高频不扎耳的镭射脉冲加细致 hitech beep | `fetch_sfx.py` 全局封杀了 `electronic / laser` 标签导致搜不到高科技 UI 素材；机械层缺 3–12 kHz 精密拨盘泛音 | `>6 kHz` 晶莹泛音能量不足，UI 层与暗调科技画风脱节 | `fetch_sfx` 增设 `is_hitech_query` 上下文放行；实现带 `3.5 kHz` `-6.5 dB` 防扎耳凹槽的 `hitech_laser_trace` 与 `hitech_micro_beep` | 已固化（`director.py`、`fetch_sfx.py`） |
| **《按一下》v4** | “圆珠笔没有电机，为什么听见电机声”；橙色齿轮咬合不够清脆；后段菜单与前段不一致；末镜笔帽需实录叠高频齿轮 | 混入电动变焦镜头（154795）、舵机（748050）、持续正弦嗡鸣与 `np.tile` 循环；齿轮无独立拨齿与锁止跃迁；后段换了 UI 词元 | 无源物体出现 `>120 ms` 窄带固定谐波与周期自相关峰；前后同组件频谱质心分裂 | 零电机本体门禁；实现 `precision_gear_turn`（加速拨齿 → 悬停 → 双阶 `KA-TA`）；统一 HUD 词元并用 `emphasis_layer=True` 双层强调 | 已固化（`sfx_judge.judge_ontology`、移除 `np.tile`、`foley.py`） |
| **《按一下》v5** | “1 秒左右左声道有一个噪音，后面 5 秒又出现一次，非常违和” | 两个坑叠加：① 截取 `raw_pk = 0.0025 ~ 0.048` 的静止/轻擦段做峰值归一化，把话筒白噪硬抬 `+26 ~ +52 dB`；② 微距斜拍按底座几何坐标算出 `pan = −0.63` | 全片 `audio.mono` 仍达 `0.97`（全局指标失明），但 `1.2–1.4 s` 左右声道实测为 `-11.4 / -23.8 dBFS`（偏斜 `12.4 dB`） | 加载入口强制洁净增益门禁（`G ≤ 20 dB`）；微距声像收束至焦点（`+0.06`），全片限宽 `±0.34`，`1.2–1.4 s` 回落至 `-24.8 / -24.0 dBFS` | 已固化（`library.load_slice`、`SHOT_PAN_CAP`、`qa` 的 `audio.balance`） |
| **《追电车》v1** | 漏了都市背景、海鸥、入画前电车喇叭、追车车铃；准备了很多音效却完全听不到链条/铁轨/海浪，电车无远近变化；配乐硬断且片尾塌陷 | 四重叠加：① 只看文字简表未读绘制源码与静帧，且 30 个下载文件闲置 14 个（`46.7%`）、拿自行车铃冒充电车声；② 无配乐收束且过程音 220 ms 后无让位；③ 未传画高占比 $h/H$ 且逐击归一化抹平蹬车力度；④ `qa` 被 `7.5–14 kHz` 配乐空洞欺骗 | `music` 高达 `-14.03 LUFS`（占母带 `-14.01 LUFS` 响度预算 `99.56%`），海浪/链条中频 SNR `-16 ~ -18 dB`；远景切近景电车仅跳 `+0.54 dB`，站蹬比坐蹬仅 `+0.14 dB`；`11.25 s` 硬乘零断片，片尾暴跌 `-10.8 dB` | 真画面逐镜三层环境拆解 + `build_layered_ambience`；`screen_scale_to_distance` 拉开 `8–16 dB` 远近差；配乐退居黄金平衡区；悬停和弦呼吸与片尾上扬编曲 | 已固化（`sfx_vocab.decompose_scene_ambience`、`director.py`、`editorial.py`、`qa` 的 `music_dominance`） |
| **《港口集市》v1** | “单独音效还不错，但混音不行，音乐完全被压掉了，要学会用音量曲线和适度 EQ 将音效和音乐融合，并在输出环节加压缩/母带在不改音质与基本动态前提下提高响度” | 三重叠加：① 双重压制（`music_ceiling_offset_db = -5.5` + `continuous_duck_db = 4.5` 全片压低 + 6 频带挖槽）把配乐死压 `-11 dB`；② 靠粗暴砍音量而非频段互补 EQ 与分段音量包络曲线融合；③ 母带仅靠线性增益撞孤立尖峰，无 SSL 总线慢起音粘合压缩，平均密度单薄 | 母带 `-14.02 LUFS / -2.50 dBTP`，`music.wav` 跌至 `-25.08 LUFS`（低于母带 `11.06 LU`！），而装饰 `ui` 冲至 `-13.09 LUFS`、`fx -15.17`、`amb -18.53 LUFS`，乐效剥离成两张皮 | 回调 `music_ceiling_offset_db = -2.6`、`continuous_duck_db = 1.8` 使 `Music` 回归 `-15.8 ~ -17.5 LUFS`；上齐 `sculpt_stem_eq` 互补分槽 + `volume_curve` 推子曲线 + `master_chain`（`25 ms` 慢起音、`110 Hz` 侧链高通、`1.5–3.2 dB` 粘合压缩提响至 `-13.2 ~ -13.5 LUFS` 保 `LRA`） | 已固化（`mixing.bus_glue_compress`、`mixing.master_chain`、`director.volume_curve`、`director.sculpt_stem_eq`、`qa` 的 `music_buried`） |

---

## 6. 听感词 → 声学物理量翻译表

人类导演或用户在审片时给出的是直觉听感词。Agent 禁止凭感觉乱调总音量，必须先按此表翻译为可测物理假设并跑数据验证：

| 用户 / 导演原话 | 对应的声学物理假设 | 第一时间要测的指标与定位工具 |
|---|---|---|
| **“太短了 / 听不见 / 没存在感”** | 有效发声体短于人耳 `200 ms` 积分窗，或关键频带被背景掩蔽 | 切片非零有效时长、`50 ms` 短窗 RMS、`400 ms` 瞬时响度、`qa.py` 的 `audio.masking` 带内窥视信噪比 |
| **“准备了很多音效却完全听不到 / 全被音乐盖住了”** | 配乐吃光 `-14 LUFS` 母带预算，缺少互补 EQ 分槽与中高频微避让，或下载素材闲置未剪入 | 测 `stems/music.wav` 占母带响度比、`qa.py` 的 `music_dominance`、各元素特征频带对同期配乐 SNR、审计 `sfx/` 库存闲置率 |
| **“单独音效不错，但音乐完全被压掉了 / 乐效两张皮、响度偏软”** | 双重压制把 `music` 死压至 `< -24 LUFS`，缺互补 EQ 分槽与推子呼吸曲线，且母带仅做线性增益撞孤立尖峰缺总线粘合压缩 | 测 `stems/music.wav` 积分响度与 `qa.py` 的 `music_buried`（不得低于母带 `> 8.5 LU`，目标 `-15.8 ~ -17.8 LUFS`）；开启 `sculpt_stem_eq` + `volume_curve` + `mixing.master_chain(..., target_lufs=-13.3, glue=True)` 核查 `glueMaxGrDb ∈ [1.5, 3.5] dB` 与 `LRA ∈ [5.5, 9.5] LU` |
| **“环境判断不准 / 漏了城市、飞鸟、喇叭、车铃”** | 只读文字梗概未核对绘制源码与静帧，或只搜单一泛词漏掉三层复合环境 | 读渲染源码与抽帧静帧列逐镜元素表，调 `sfx_vocab.decompose_scene_ambience` 核查底床、主纹理、生机点缀三层是否齐全 |
| **“车/人远近大小没变化 / 站起猛蹬没发力感”** | 跨镜头未传画面占比 $h/H$，或子事件被固定 `target_lufs` 重新峰值归一化抹平动态 | 测远景与近景分轨 RMS 差（应 `≥ 8 dB`）、连击脉冲峰值阶梯；传入 `screen_ratio` 与 `add_foley_series(..., forces=...)` |
| **“音乐中间断点很怪 / 最后情绪没上扬”** | 强拍后硬乘零截断混响尾造成断片感；片尾视觉升华段停掉节奏与主奏导致能量塌陷 | 测留白前后 `25 ms` 包络斜率与片尾段 RMS 曲线；悬停段改挂留和弦呼吸 + 反向引子，片尾开上扬编曲与 `music_focus_windows` |
| **“像电机 / 有嗡嗡声 / 假电子味”** | 无源机构混入了持续窄带谐波（电机/合成器）或死循环拼接周期 | `sfx_judge.judge_ontology` 的 `sustained_tone_ms`（`>120 ms`）与 `loop_periodicity`（`>0.85`）、素材原始标签 |
| **“风声/水流/衣料里有电嗡嗡颗粒感或尖锐金属哨音”** | `> 6 kHz` 颗粒窗/帧跳周期包络调制，或 `4–16 kHz` 高 Q 窄带滤波器谐振尖刺 | `sfx_judge.extract_metrics` / `judge_wave` 的 `hf_envelope_buzz`（宽带原型上限 `0.50–0.58`）与 `hf_whistle_db`（宽带原型上限 `17.0–19.5 dB`） |
| **“不够清脆 / 咬合不明显 / 发闷”** | 缺 `2.5–12 kHz` 高频精密 `detail` 层，或起音过慢、混响过湿抹平了瞬态峰 | `2–10 kHz` 瞬态能量占比、`log_attack_time`（LAT）、波峰因数（Crest Factor）、落锁跃迁差（dB）、混响 `wet` 值 |
| **“扎耳朵 / 毛刺 / 听着累”** | 人耳耳道共振区（`2.5–4.5 kHz`）能量堆积，或 `>10 kHz` 缺少滚降、数码硬截断 | `2.8–4.6 kHz` 与 `8 kHz+` 频段相对能量（`qa.py` 的 `audio.bands`）、起音是否有 `<0.5 ms` 未淡入硬跳变 |
| **“前后不统一 / 像两部片子拼的”** | 同类视觉元素中途换了声音词元、根音或频谱重心 | 对照《声音词典》核查各实例调用的函数、根音频率与频谱质心（Spectral Centroid）离散度 |
| **“某几秒一边耳朵有噪音 / 很违和”** | 低 `raw_pk` 切片经峰值归一化炸出话筒底噪 + 声像偏置叠加 | 跑 `qa.py` 的 `audio.balance` 找 `|L−R| > 6 dB` 窗口，逐轨排查该秒数内各切片的 `raw_pk`、增益 $G$ 与 `pan` |
| **“声音抢拍 / 慢半拍 / 贴不上画面”** | 用文件第 0 样本而非 P-Center 对齐，或事件帧号未从唯一时间源读取 | 跑 `npm run audio:cuecheck` 核对感知起音与画面结果帧的毫秒偏差 |

---

## 7. 交付前审片十问（Agent 自动取证 vs 人类导演盲听）

机器检查只能签“代理检查通过”；音色真假、审美分寸与听觉疲劳必须由人类全速带声盲听签字（[../DIRECTING.md 步骤 10](../DIRECTING.md)）。

| # | 维度 | Agent 自动取证门槛（写进审片证据） | 人类导演盲听核对项（全速带声，先耳机后外放） |
|---|---|---|---|
| 1 | **因（本体）** | 本体清单覆盖全部前景事件；`passive` 对象上 `motorized` 素材数为 `0`；`judge_ontology` 零 `reject` | 有没有听到任何画面里不存在的动力源（电机、风扇、合成器嗡鸣、人声口技、机械循环）？ |
| 2 | **闻（可听）** | 承担叙事的微动作有效包络体 `≥ 30 ms`，关键动作特征频带对同期配乐具清晰正信噪比（`audio.masking` 普通 `≥ -5 dB`、`hero ≥ -1 dB`），无 `music_dominance` 与 `music_buried` 告警 | 不看声音表盲听第一遍，配乐旋律是否温暖在线，同时每个关键动作、交通工具、生机点缀都清晰可辨？ |
| 3 | **像（质感）** | 候选素材全部通过 `sfx_judge`（零伪升频、零削波、零长混响污染）；特写关键动作具备 `identity + detail + body` 分层，复合外景具备底床+主纹理+生机三层 | 塑料像塑料、金属像精密金属、海边小镇既有浪涌又有远城底韵与海鸥吗？ |
| 4 | **净（底噪）** | 所有前景实录切片经 `library.load_slice` 校验满足 $G \le 20\text{ dB}$ 且总线前底噪 $\le -56\text{ dBFS}$ | 安静段与动作起落边缘，有没有突然冒出来的白噪嘶声、电流声或剪接咔嗒声？ |
| 5 | **位（声像与远近）** | 声像不超 `SHOT_PAN_CAP` 景别上限；远景与近景经 `screen_ratio` 拉开 `≥ 8 dB` 纵深差；`audio.balance` 连续 `100 ms` 有声窗无 `> 6 dB` 偏斜；`audio.mono` 相关 `≥ 0` | 戴耳机听，特写稳在视觉焦点上吗？车与人从远景切到近景再远去，音量与空气感有真实的远近纵深吗？ |
| 6 | **准（同步）** | 全部瞬态经 P-Center 锚定；`npm run audio:cuecheck` 偏差落在容差窗内 | 撞击、落锁、菜单跳出那一帧，声音是否严丝合缝咬在画面结果帧上？ |
| 7 | **一（同构）** | 同类画面组件调用同一词元函数；重点强调镜头仅开启叠层（电平抬升 `+1.5 ~ 3.0 dB`） | 全片同一种标注线、同一种弹窗听起来是不是“同一套工业设计语言”？ |
| 8 | **融（平衡与母带粘合）** | 有配乐片满足黄金分轨配比（`Music ≈ -15.8 ~ -17.8`、`FX ≈ -15.5 ~ -17.5`、`Foley ≈ -19 ~ -22`、`AMB ≈ -22 ~ -25 LUFS`）；开启 `sculpt_stem_eq` 互补分槽、`volume_curve` 推子曲线与 `master_chain` 总线粘合压缩（`glueMaxGrDb ∈ [1.5, 3.5] dB`、`LRA ∈ [5.5, 9.5] LU`） | 音效是不是像真正长在管弦乐里面而不是浮在表面两张皮？悬停呼吸自然吗？高潮响度饱满且没有低频抽吸压扁感吗？ |
| 9 | **耳（耐听）** | 核查 `audio.bands`：高频科技风若触发 `8k+` 告警，确认 `2.8–4.6 kHz` 耳道敏感区已做凹槽抑制且真峰值达标 | 连听两遍耳朵累不累？切到手机扬声器外放，高频镭射和金属咔嗒刺不刺耳？ |
| 10 | **交（回归）** | `npm run audio:qa` 退出码 `0`（`-14±1 LUFS` 含 `-13.2 ~ -13.5 LUFS` 高密度母带、TP `≤ -1.5 dBTP`、首尾归零、切点无爆音），封装未二次跑 `loudnorm`；**历次返修点时间码 100% 复测通过** | 从头到尾全速带声看完最终 MP4，记下审片人、日期与原话，经 `review approve` 入档 |

---

## 8. 引擎能力地图与未实现项

### 8.1 已固化的公共能力【仓库实证·代码】
- **取证加载与 P-Center 同步**：`engine/audio/library.py` — `load_slice`（洁净增益 $G \le 20\text{ dB}$ 与输出底噪门禁）、`sync_anchor`（能量斜率重心）、`de_room_gate`、`slices(..., min_len=...)`。
- **零训练素材物理与本体审定**：`engine/audio/sfx_judge.py` — 14 类拟音原型（含 `mechanical`、`motorized`、`tonal_ui`、`metal_blade`、`low_drone`、`sustained_tonal`）、`extract_metrics`（含 `> 6 kHz` 周期包络电嗡声 `hf_envelope_buzz` 与 `4–16 kHz` 窄带哨音尖刺 `hf_whistle_db`）、`judge_wave`、`judge_ontology`（无源机构电机嗡鸣与循环自相关拦截）。
- **UCS 词表、复合场景三层拆解与世界观锁池**：`engine/audio/sfx_vocab.py` 与 `tools/fetch_sfx.py` — UCS v8.2.1 全量词表、24 类复合检索配方、六类世界观调色板 `WORLD_PALETTES`、九类复合场景三层原型 `SCENE_AMBIENCE_LAYERS`、`decompose_scene_ambience`、`search_by_world`、`classify_stem`、`plan_film_sound_pool`（CLI 支持 `--vocab`、`--cat`、`--world`、`--plan`），以及 `is_hitech_query` 上下文放行与无源机械电机污染过滤。
- **分层拟音与全带宽物理/风格化合成**：`engine/audio/foley.py`（`composite_mechanism`、`precision_gear_turn`、`helical_thread`、`spring_coil`、`stick_slip_friction`、`shift_material`、`RoundRobinDeck`、`ActionVariationDeck`、`granular_bed`）与 `engine/audio/procedural.py`（`modal_impact` 含 `radiation='accel'`、`phisem_particles`、`aerodynamic_whoosh`、`minnaert_bubbles`、`stylized_cartoon`、`thunder_strike`、`pouring_vessel`、`bouncing_disc`、`shock_blast`）。
- **智能时值剪辑、视觉遥测绑定、四干线人声融合、互补 EQ 与流式 SSL 母带工作台**：`engine/stage/telemetry.js`（`createAudioTelemetry`、`projectThreeActor`、`trackCanvasActor`）、`engine/audio/spotting.py`（`spot_from_kinematics`、`spot_from_video`）、`engine/audio/music_gen.py`（`plan_sections_from_film`、`build_guide_score`、`generate_cover`、`probe_endpoint`；CLI `npm run audio:music`）、`engine/audio/editorial.py`（`smart_edit_clip`、`schedule_action_series`、`couple_motion_trajectory`、`build_layered_ambience`、`FourStemWorkstation` / `ThreeStemWorkstation` 含 `set_dialogue` 与 `bind_actor`）、`engine/audio/director.py`（`volume_curve`、`sculpt_stem_eq`、`carve_dialogue_pocket`、`POA_PRESETS`、`SHOT_PAN_CAP`、`WORLD_PROFILES`、`screen_scale_to_distance`、`depth_gain_db`、`resolve_screen_ratio_curve`、`hitech_laser_trace`、`hitech_micro_beep`、`subtle_precision_cue`、`carve_negative_space`、`HDRMixer`）以及 `engine/audio/mixing.py` 与 `engine/audio/stream.py`（`bus_glue_compress`、`master_chain`，含 10 分钟 `< 1.0 GB` 跨块保状态流式母带）。
- **质量门、前置快败、拍点核对与实时带声预览**：`engine/audio/qa.py`（含 `audio.loudness`、`audio.truepeak`、`audio.mono`、`audio.balance`、`audio.bands`、`audio.masking` 双向乐效平衡守卫 `music_dominance` / `music_buried`、对白清晰度硬门 `audio.dialogue`，并由 `engine/render/build.mjs` 在 `mix` 阶段自动跑前置快败拦截写出 `audio/qa.json`）、`engine/audio/cuecheck.py`、`engine/render/events.mjs`（`--telemetry` 逐帧运动与角色遥测采集）、`engine/render/serve.mjs`（`?preview=1` WebAudio 声卡相位锁定分轨 Mute/Solo 与一键重混调片栏）。

### 8.2 尚未实现的工程增强【未实现】
- **混音事件溯源台账（Cue Ledger）**【未实现】：目前定位“第 1.25 秒左声道是谁响”仍需在作品脚本里按分轨排查；后续可在 `foley.place_anchored` 与 `HDRMixer.add_cue` 中输出 `<run>/sound/ledger.json`（记录每个事件的起止毫秒、源文件名、切片区间、`raw_pk`、增益 $G$ 与 `pan`），实现按时间码一键反查。
- **事件外高频底噪跳变门（`audio.floor_jump`）**【未实现】：`qa.py` 已实现逐窗左右差 `audio.balance`，但对居中放置（`pan = 0`）的低幅归一化底噪爆发，后续可结合 `events.json` 在非事件窗口增设 `>8 kHz` 底噪跳变检测。
- **声画对齐波形叠帧图自动生成**【未实现】：见 [../DIRECTING.md 步骤 10](../DIRECTING.md)。

---

## 9. 已知问题与边界

1. **高科技微距风格的高频能量告警（`audio.bands`）**：以镭射走线（`6.8–13 kHz`）和微型金属棘轮为主体的暗调科技短片，全片低频极少、`8 kHz+` 频段相对最强频段可接近 `-0.5 dB`【仓库实证·实测】（未入库试制区），会触发 `qa.py` 的软告警 `audio.bands`（阈值 `≤ -10 dB`）。这是题材有意选择的清透频谱；但在超过 60 秒的长片中若全程保持该高频密度，仍易引发听觉疲劳，需靠中段低频环境床或静默段落平衡。
2. **`de_room_gate` 不能替代洁净选材**：`de_room_gate` 适合压低优质录音在瞬态前后的轻微空调底噪，不能用来挽救 `raw_pk < 0.05` 的极微弱切片。
3. **跨路线参数仍需案例扩充**：§4 中东方写意巨物与叙事角色片的定量边界多为依据声学原理与现有引擎接口给出的【通用工艺·建议】，后续每完成一部对应路线的用户认可成片，应将实测数回填替换。

---

## 10. 出处与许可

- **声学与电影声音理论（只引用概念与通行规律，未复制原文）**：Walter Murch 声部密度法则（*Dense Clarity — Clear Density*，“2.5 声部”聚簇上限）；Randy Thom 声音设计视角与峰值前留白（*Designing a Movie for Sound*）；Michel Chion 视听契约与无声动作意象转译（*Audio-Vision: Sound on Screen*）；Fletcher-Munson 等响曲线耳道共振敏感区（`2.5–4.5 kHz`）与心理声学约 `200 ms` 响度时间积分规律；Peeters 等 *Timbre Toolbox*（2011）信号描述符；Few（1969）三维曲折闪电通道 N 波传播模型、Moffatt（2000）欧拉盘有限时间奇点滚振与 Friedlander（1946）/ Whitham（1956）冲击波超压方程。
- **第三方风格库参照**：`$甲` = `cases/vendor/lemo-opuscar`（MIT，LemoLab，固定提交 `bebbbe1a`），本章与 [../DIRECTING.md 步骤 8](../DIRECTING.md) 衔接的三栏声音表及静默反衬思路源自其 `DIRECTOR.md §4, §6` 的改编（随仓库分发保留 `cases/licenses/LemoLab-MIT.txt`）。《按一下》原始画面工程归档于 `cases/source/style-60-teardown/`，《追电车的夏天》原始画面工程归档于 `cases/source/style-27-cel-anime-80s/`，《港口集市》原始画面工程归档于 `cases/source/style-31-hd-2d/`（参见 [../SOURCES.md §3](../SOURCES.md)）。
- **CC0 实录音效来源**：试制验证所使用的圆珠笔、机械快门拨盘、怀表棘轮、高科技界面及海岸电车/自行车/海鸥采样均取自 Freesound.org 的 **CC0 1.0 Public Domain** 授权录音（通过 `tools/fetch_sfx.py` 校验许可并由 `engine/audio/library.py` 的 `credits()` 生成逐条来源记录）。
