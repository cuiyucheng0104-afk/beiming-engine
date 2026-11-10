# 机器 QA 门（tools/qa）

读者｜出片的 agent、审片人、写编排与渲染器的维护者　状态｜生效（2026-11-10）　实现｜`tools/qa/`　测试｜`node --test "tests/qa/*.test.mjs"`

成片做完、交给人审之前，先过这道门：交付规格、画面异常、文字、底板、声画同步，凡是机器能判的，都由 `tools/qa` 判，硬门不通过就非零退出。
**通过只说明「代理检查通过」**。画面好不好、声音对不对味，由用户或指定审片人全速带声看完后判断并记录原话（D08）；报告不能写成「已交付」「用户已认可」。评分口径见 [RUBRIC.md](RUBRIC.md)。

## 1. 什么时候跑、跑什么

| 时机 | 命令（在仓库根目录） | 说明 |
|---|---|---|
| 每次终渲之后（必跑） | `node tools/qa/cli.mjs report films/<名>/out/<run-id>/master.mp4` | 跑全部检查组，写 `qa/report.json`、`report.md`、`contact.jpg`；注册后是 `npm run qa -- report …`，`film qa` 也调它 |
| 只核交付规格 | `node tools/qa/cli.mjs delivery <成片> --film films/<名>` | 最快（10 秒片约 0.5 秒），改了封装、响度、色彩时先跑它 |
| 只看画面异常 | `node tools/qa/cli.mjs visual <成片>` | 黑场、静帧、闪帧、切点、跳帧、闪烁、露边 |
| 只看文字 | `node tools/qa/cli.mjs texts --film films/<名>` | 打开作品页面逐帧读 `window.TEXTS`；B 路线原生片没有页面，不适用 |
| 只看底板 | `node tools/qa/cli.mjs plates --film films/<名> [--size 3840x2160]` | 直线淡出露边、贴图密度；`--size` 按 4K 查密度 |
| 素材入库前查边 | `node tools/qa/cli.mjs plates <图片…>` | 只做静态找边，不需要页面 |
| 只看声画同步 | `node tools/qa/cli.mjs sync <成片> --film films/<名>` | 事件帧 vs 最终 AAC 的起音 |
| 列档位 | `node tools/qa/cli.mjs profiles` | 交付档位、来源与关键数值 |
| 校验报告结构 | `node tools/qa/cli.mjs validate <qa/report.json>` | 附录 C8 的报告是否合格；P05 的 `validate-result` 判 `technicalAcceptance.evidence` 用同一个函数 |

每个子命令都有 `--help`（只打印用法，不读文件、不起进程）。常用参数：`--film <作品目录或 film.json>`、`--profile <档位>`、`--json`、`--out <目录>`、`--waivers <文件>`、`--timeout <秒>`；页面类加 `--page`、`--step`、`--ready-timeout`、`--size`；`report` 另有 `--skip delivery,visual,texts,plates,sync` 与 `--no-sheet`。

**作品描述自动查找**：不给 `--film` 时，从成片所在目录往上找最近的 `film.json`（`films/<名>/out/<run-id>/master.mp4` → `films/<名>/film.json`）；《北冥》样片的 `out/beiming/<run-id>/` 与旧产物 `out/beiming*.mp4` 对应 `films/beiming-10s/film.json`。没有作品描述也能跑，但帧数、切点、AIGC 标识只能报「注意」。

**报告位置**：成片在运行目录里时写到 `<运行目录>/qa/`；在别的 `out/` 目录里时写到同目录的 `qa/<文件名>/`；否则写到仓库根的 `out/qa/<文件名>/`。`--out` 优先。

## 2. 退出码与 `--json`（附录 C1、C2）

| 码 | 含义 | 例 |
|---|---|---|
| 0 | 全部硬门通过（可以有「注意」） | |
| 1 | 运行失败：页面脚本出错、render(t) 抛错、内部错误 | 报错里带堆栈与下一步 |
| 2 | 用法错误：未知参数、缺成片、文件不存在、档位不存在 | `--no-such-flag`、`--timeout abc` |
| 3 | 环境缺失：没有 FFmpeg ≥ 7（或缺 ebur128 等滤镜）、没有 playwright-core 或无头浏览器 | 提示怎么装 |
| 4 | 硬门不通过，或成片读不了（坏片本身就是验收不通过） | |
| 124 | 外部进程或页面渲染超时 | `--timeout` 放宽 |
| 130 / 143 | 收到 SIGINT / SIGTERM，已清掉子进程与浏览器 | |

`--json` 时 stdout 只有一个对象：`{ ok, exitCode, command, error: {code, message, hint} | null, outputs: [{path, sha256, kind}], runJson, warnings[], result }`，`result` 就是报告本体；供人看的进度一律写 stderr。不留子进程、浏览器与临时文件（`tests/qa` 有检查）。

## 3. 期望值从哪来

- **交付档位**：权威表是 `engine/production/profiles.json`（P05 维护，D07）。缺这个文件、缺某个档位或缺字段时，用 `tools/qa/profiles.builtin.json` 的内置值兜底，**报告里逐项写 warn**，说明哪些值来自兜底。内置值与 D07 一致：默认 `web-1080p24`（1920×1080、24 fps、H.264 High、yuv420p、BT.709 有限范围且四项标注齐全、AAC-LC 48 kHz 立体声、−14 LUFS ±1 LU、真峰值 ≤ −1.0 dBTP）；另有 `master-1080p24`、`uhd-2160p24`、`vertical-1080x1920-30`、`broadcast-1080p25`（−23 LUFS ±0.5）、《北冥》专用 `beiming-1040p24`。
- **作品描述 film.json**（附录 C6；v1 的 `{route,title,dur,fps,size}` 自动升级，`frameCount = round(dur × fps)`）：帧数、画幅、镜头表（切点）、事件（声画同步）、`aigc`（D11 标识）、`audio.mode`（`none` 时不要求音轨），以及下面的 `qa` 段。
- 检查代码里不写死数字；阈值都在档位的 `visual`、`texts`、`plates`、`sync`、`safeArea` 段，作品可在 film.json 的 `qa` 段按需覆盖（覆盖了什么，报告的「期望」一栏照实写出）。

### film.json 的 `qa` 段

```json
"qa": {
  "intentional": [ { "kind": "freeze", "from": 0, "to": 12, "reason": "开场空纸等第一笔落拍" },
                   { "kind": "black", "from": 228, "to": 240, "reason": "片尾黑场" },
                   { "kind": "flash", "from": 96, "to": 98, "reason": "拍点闪白" } ],
  "safeArea": { "title": { "bottom": 0.18 } },
  "texts": { "minHoldSec": 1.0 },
  "visual": { "freezeMinSec": 0.75 },
  "plates": { "sides": ["left", "right", "top"] },
  "clearColor": "#000000",
  "waivers": []
}
```

- `intentional`：刻意的停顿、黑场、闪白（半开区间、整数帧）。**这是设计声明，不是豁免**：写进来就不算问题，但要写理由，审片时会对照阐述核对。不要为了过检放宽阈值。
- `events[].sync`：`"lip"` 口型类（可晚 2 帧）、`"soft"` 只记注意（缓起的弦乐、铺底）、`"none"` 不查。

## 4. 检查项

级别：**硬门**不通过即 exit 4；**软项**只记「注意」，写进报告给人看。下表的阈值是内置默认值。

### 4.1 delivery：交付规格（对最终文件测）

| 检查 | 级别 | 判据 | 不通过怎么修 |
|---|---|---|---|
| `delivery.container` | 硬门 | ffprobe 能解析；容器是 MP4 / MOV；只有 1 条视频流 | 重新封装 |
| `delivery.decode` | 硬门 | `ffmpeg -xerror` 完整解码画面与声音，无错误；同时逐帧计数（framecrc） | 文件截短或损坏：重封装或重渲 |
| `delivery.frame-count` | 硬门 | 解码帧数 = film.json 的 `frameCount`（不读 `nb_frames` 元数据） | 回到渲染查缺帧原因，不要用 fps 滤镜或补帧「修」 |
| `delivery.frame-rate` | 硬门 | `r_frame_rate` 与 `avg_frame_rate` 都等于档位帧率；作品描述的 fps 也要一致 | 一拍二、一拍三的节奏只在整数帧率下成立 |
| `delivery.cfr` | 硬门 | 视频包 PTS 严格等间隔（相邻差 = 1/帧率，允许 1 tick 舍入） | 封装时不要混入可变帧率的中间件 |
| `delivery.duration` | 硬门 | 视频时长 = 帧数 ÷ 帧率，误差 ≤ 1 帧 | |
| `delivery.size` | 硬门 | 宽高 = 档位，且为偶数；作品描述的画幅也要与档位一致 | 改 `output.profile` 或改画幅（D07 默认 1920×1080，不是 1040） |
| `delivery.sar` | 硬门 | SAR 1:1 | |
| `delivery.codec` | 硬门 | H.264；High 档次、Level ≤ 档位上限为软项 | Level 超了部分硬件放不了（craft/video.md §5.5） |
| `delivery.pix-fmt` | 硬门 | yuv420p（不是全范围的 yuvj420p） | 编码前 `scale` 做 full→tv 范围转换 |
| `delivery.color` | 硬门 | `color_range=tv`，`colorspace`、`color_primaries`、`color_trc` 都是 bt709 | 像素与标签一起改：`scale=out_color_matrix=bt709:out_range=tv` 后接 `setparams=…`，再写四个 `-color_*` 参数（FFmpeg 8 实测：帧上没有原色 / 传递属性时只写编码器参数会是 unknown） |
| `delivery.range-pixels` | 软项 | 标成有限范围时，抽 5 帧原尺寸 Y 平面，超出 16–235 的像素 < 1% | 抓「只改标签不改像素」 |
| `delivery.audio-stream` | 硬门 | AAC（LC 为软项）、48 kHz、立体声；`audio.mode = "none"` 时不要求音轨 | 混音没进成片，或采样率不对 |
| `delivery.av-align` | 硬门 | 音画起点差、终点差都 ≤ 1 帧 | 混音时长要等于 帧数 ÷ 帧率 |
| `delivery.loudness` | 硬门 | 对**最终文件**跑 ebur128（BS.1770 门限积分）：档位目标 ± 容差 | 在混音阶段算好增益；封装时别再跑会压动态的 loudnorm（craft/video.md §5.8） |
| `delivery.true-peak` | 硬门 | 4 倍过采样真峰值 ≤ 档位上限 | AAC 会抬高样本间峰值，混音真峰值留在 −1.5 到 −2 dBTP |
| `delivery.faststart` | 软项 | 网页档 moov 在 mdat 之前（母版档不要求） | `-movflags +faststart` |
| `delivery.aigc-label` | 硬门 | film.json 声明 `aigc.contains: true` 时，mp4 的 `comment` 元数据含 AIGC 标识（D11）；没写 `aigc` 字段记注意 | 封装加 `-metadata comment="含 AI 生成画面（AIGC）"`，片尾或说明里也写 |

### 4.2 visual：画面异常（一次解码，缩到 ≤ 480 宽的亮度流，按标签换算成观众看到的 0–255）

| 检查 | 级别 | 判据 | 不通过怎么修 |
|---|---|---|---|
| `visual.black` | 硬门 | 像素亮度 ≤ 2% 的占比 ≥ 98% 的帧连成段（同 blackdetect 的 pix_th 0.02 / pic_th 0.98）；`intentional` 里 `black` 段放行 | 渲染没出画面，或刻意黑场没声明 |
| `visual.freeze` | 硬门 | 与静帧起点帧的分块（16 列）平均绝对差都 < −50 dB（约 0.8 级），持续 ≥ 0.5 秒（24 fps 下 12 帧）；颗粒照动也算静帧；`intentional` 里 `freeze` 段放行 | 卡帧要回渲染查；刻意停顿要声明，或给停顿加「活的停顿」（呼吸、颗粒、漂移） |
| `visual.flicker` | 硬门 | 帧平均亮度与同镜头前后 5 帧中值之差 ≥ 6 级，且相对前后两帧均值也跳 ≥ 3 级（平滑的渐亮不算）；切点 ±1 帧除外 | 资源没就绪、后期参数跳变；刻意闪白写 `intentional` 的 `flash` |
| `visual.cuts` | 硬门 | 切点分数 = min(帧差%, \|帧差% − 上一帧帧差%\|)（同 scdet）≥ 10，±2 帧非极大值抑制；与镜头表 ±1 帧一一对应。**多出的切点**硬失败，镜头表有而画面没检出的只记注意（溶、划写 `transition`） | 镜头表与画面不一致：改 film.json 的 shots 或修画面 |
| `visual.jumps` | 软项 | 帧差 ≥ 3 × 前后 6 帧帧差中值且至少高 2 级；附近 ±2…±4 帧也有相近尖峰的是一拍二、一拍三的节拍，不算 | 逐帧看是否漏帧、重复帧、相机参数跳变 |
| `visual.flash-rate` | 软项 | 按 ITU-R BT.1702 近似：分块亮度（sRGB 解码 × 200 cd/m²）变化 ≥ 20 cd/m² 且暗端 < 160 算一次闪烁；任意 1 秒内 ≥ 25% 画面闪烁 > 3 次 | 光敏性风险筛查，**不等于 PSE 认证**，对外播出前用专业工具复测 |
| `visual.edge-clear` | 软项 | 画面四边（各分 4 段）有清屏色（缺省黑，`qa.clearColor` 可改）暗带，内侧明显更亮 | 相机运动时底板没盖满画框：按 craft/two-five-d.md §2.1 的出血公式补 |
| `visual.edge-line` | 软项 | 贯穿 ≥ 30% 画高、连续 ≥ 3 帧的笔直竖向断层（启发式，建筑竖线也会命中） | 人工看：底板截断边就按 plates 的提示修 |

### 4.3 texts：文字（打开作品页面，逐帧 `render(t)` 后读 `window.TEXTS(t)`）

页面约定（附录 C5）：`TEXTS(t)` 返回 `[{ id, text, box:[x,y,w,h], alpha, font }]`（也接受现有的 `{id,text,x0,y0,x1,y1}`）。QA 在页面脚本运行前注入探针，记下同一帧每次 `fillText` / `strokeText` 的字体与实际不透明度，补全 TEXTS 没写的 `alpha`、`font`；页面没有 TEXTS 时用探针与 DOM 文字推导（停留时长只给软项）。同一个 id 换了内容（如「识别中…」→「未能识别」）按两条字分别查。

| 检查 | 级别 | 判据 | 不通过怎么修 |
|---|---|---|---|
| `texts.contract` | 软项 | 有 `TEXTS`、条目格式对、`round(DUR × fps) = frameCount`、没有外网请求（一律拦下） | 按 C5 实现 TEXTS 并带 alpha |
| `texts.inframe` | 硬门 | 文字方框完整在画内（VISUAL-DESIGN §6.3：要么完整在画内，要么完全在画外） | |
| `texts.safe-area` | 硬门 | 在图文安全区内：16:9 按 EBU R95 每边 5%（与 VISUAL-DESIGN §6.3 一致）；竖屏档每边 上 8% 右 12% 下 18% 左 6%（主流竖屏平台界面遮挡的保守交集），作品可在 `qa.safeArea` 改 | 往画内收或缩字号。注：旧的 4:3 广播口径「title-safe 10%」比 EBU R95 严，本门按 R95 |
| `texts.duration` | 硬门 | **完全显现**（不透明度 ≥ 该条自己峰值的 90%；显示层的字本来就是半透明的）的连续时长 ≥ max(0.8 秒, 读字单位 × 0.12 秒)；低于导演规范的 字数 ÷ 4.5 + 1.5 秒（DIRECTING 步骤 9）只记注意。读字单位：一个汉字算 1，一串连续字母数字算 1 | 拉长停留或减字；刻意快闪由用户批准后写豁免 |
| `texts.contrast` | 硬门 | 对每条字取最不透明的一帧，截三张无损图：照常、只关文字（字后的底板留着）、关文字并藏掉显示层（给画成路径的书法片名用）。方框内差值 ≥ 0.5×P99 的是笔画核心，方框外扩 max(4 px, 0.3×字高) 范围内差值 < max(6, 0.1×P99) 的是背景；字取笔画核心亮度 P75（亮字）/ P25（暗字），背景取对字不利一侧的四分位，按 WCAG 相对亮度算比值。< 3:1 硬失败，< 4.5:1 注意 | 加暗晕、描边、半透明底板，或换落点（VISUAL-DESIGN §6.3）；分不出字和背景（世界内文字）记注意，人工看 4K 与 1080 对照帧 |
| `texts.glyphs` | 硬门 | 每个字按 CSS 字体匹配（字重、样式、unicode-range）逐家族查 **cmap**：落到系统字体（含 `sans-serif` 等通用族）、字体 `local()` 引用、来自外网、没加载完，都算缺字 | 把字加进作品自己的字体子集（作品目录 `fonts/`，从带许可的原字体离线子集化）；不改共享 `fonts/`，不依赖系统字体 |

为什么查 cmap 而不只用 `document.fonts.check()`：它只回答「这个字体加载了没有」，查不出子集字体缺字——缺的字浏览器会逐字退回系统字体，而本仓库的字体全是子集（QUAL-07 核实修正）。探针仍会记 `document.fonts.check` 的结果，画字时字体没加载完同样判缺字。

### 4.4 plates：底板（默认只查左右两条竖直边）

| 检查 | 级别 | 判据 | 不通过怎么修 |
|---|---|---|---|
| `plates.inventory` | 软项 | 找得到作品用的底板：页面型作品经 three.js 垫片探针逐帧记到贴图面片（不改页面代码）；B 路线读 film.json 的 `native.images`；或命令行给图片。页面用了 three 但没有图片底板时直接通过 | A 路线页面按模版的 importmap 引 three；C 路线 2D 页面画的图片底板用 `qa plates <图片…>` 静态找边 |
| `plates.straight-fade` | 软项 | 静态找边：逐行找从透明一侧第一次越过 alpha 0.5 的位置，连续一段标准差 < 15 px、覆盖主体高度 ≥ 30% 即直线边；淡出带 ≥ 8 px 宽是**直线淡出**，贴着图边、不到 8 px 的是**硬切边**，离图边远的锐利直边（楼的侧墙）不报。再按每帧面片位置投影：直线边有 ≥ 30% 落在画内、面片不透明度 ≥ 0.05、没被裁切面片的椭圆软边遮掉，就报帧号与屏幕位置。前面的雾、云片会不会把它盖住**不建模**，所以是软项：按帧号逐帧看 | 把这一端放到画外、用 `cropPlate` 的椭圆软边裁掉，或扩图重做这一端（craft/two-five-d.md；台账 QA-B-001） |
| `plates.density` | 硬门 | 画内各采样点上每个屏幕像素分到的贴图像素（texel/px，横竖取小）的最小值：< 0.6 不通过，< 1.0 注意。按页面实际打开的分辨率量，查 4K 交付要带 `--size`。量不了的（B 路线原生片、C 路线 2D 页面、单独图片）记注意并说明原因，不判失败 | 按镜头与档位重新生成更大的底板，或减小推近幅度；4K 交付要么换大图，要么在运行记录写明放大方法并附 1:1 对照（GAP-03） |

### 4.5 sync：声画同步（事件帧 vs 最终 AAC 的起音）

要求有声的事件：film.json 的 `events[]` 里写了 `audio`（或 `sfx: true`、`cue`）的；作品描述没写 events 时，自动用作品目录里 C 路线导出的 `events.json`（`engine/render/events.mjs`），也可 `--events` 指定。

| 检查 | 级别 | 判据 | 不通过怎么修 |
|---|---|---|---|
| `sync.events` | 硬门 | 起音 − 结果帧时刻落在 [−0.25 帧, +1 帧]（24 fps 约 −10.4 ms … +41.7 ms）；口型类可晚 2 帧；`soft` 事件超出只记注意。容差出自 [craft/animation.md §5.7](../../routes/directing/craft/animation.md) 的同步容差表（不对称：声音超前比滞后更容易被察觉）。没检出起音记注意（可能被混音盖住，要人带声复核）；**一个都没检出**判硬失败（多半是整条声音错位或混音没进成片） | 事件帧号与声音时刻同源（同一份事件表）；拍点不落整帧时画面结果帧取 floor、声音留在网格原位 |

起音检测：把事件前后一段分成全频带、150–1000 Hz、1–4 kHz、4–12 kHz 四路（RBJ 带通两级），每路取 2 ms 窗、0.5 ms 步长的 RMS 包络；候选是比此前 5–20 ms 底噪抬高 ≥ 8 dB、且不低于 −70 dBFS 与本窗最响处 −30 dB 的局部峰；起音取峰前越过「底噪 + 20%」的位置。相邻事件各自只搜到与邻居的中点为止。AAC 的编码延迟由 MP4 编辑列表在解码时扣掉。合成信号实测误差 ±1.5 ms（`tests/qa/sync.test.mjs`）。

### 4.6 台账

| 检查 | 级别 | 判据 |
|---|---|---|
| `known-issues.open` | 硬门 | `report` 时，本作品在 [known-issues.json](known-issues.json) 里没有未关闭（`status: "open"`）的 P0 / P1；P2、P3 只记注意 |

## 5. 豁免

一条豁免只放行**一项检查里的某个对象**（`target`：文字 id、事件 id、底板名）和可选的帧段（`frames: [起, 止)`），不放行整项。字段：

```json
{ "check": "texts.duration", "target": "subtitle", "frames": [228, 240],
  "reason": "片尾副标题随最后一拍落定，停在最后一帧",
  "approvedBy": "用户", "quote": "<用户原话，逐字>", "source": "<出处：会话、日期、消息位置>", "date": "2026-11-10" }
```

- `approvedBy`、`quote`、`source` 必填；`approvedBy` 写成 agent、AI、Claude、助手之类的豁免**一律无效**并在报告里报 warning——agent 不得自己批准（D08）。
- 放在三处之一：作品的 `film.json` → `qa.waivers`；`docs/quality/waivers/<作品 id>.json`（不改作品目录时用）；命令行 `--waivers <文件>`。
- agent 可以**起草**：写成 `"status": "proposed"`，QA 不采用，只在报告里提示「有 N 条待用户批准」；用户批准后由人填上原话与出处、删掉 `status`，才生效。见 [waivers/README.md](waivers/README.md)。
- 报告里被放行的项状态是 `waived`，并写明谁批准、原话、出处、记录在哪个文件。

## 6. 报告（附录 C8）

`qa/report.json`：`{ schemaVersion: 1, tool, film, input: {path, sha256, bytes}, profile: {id, source}, groups, skipped, checks: [{id, group, title, severity, status: pass|fail|warn|waived, value, expected, evidence, message, findings?, waiver?, hint?}], summary, ok, verdict, warnings, env, generatedAt, technicalAcceptance, contactSheet, facts, framesOfInterest, … }`。

- `ok` = 没有任何 `fail`；`verdict` 只会写「机器检查通过（代理检查通过，不等于人工认可）」或「机器检查不通过」。
- `technicalAcceptance = { status: passed | failed, evidence: [报告路径] }`，可直接放进 run.json（P04 写 not-run，由 QA 判定）；P05 的校验器用 `validateReport`（`tools/qa/lib/report.mjs`）判 evidence 指向的报告可解析。
- `skipped` 写明没执行的组和原因（例如没有页面时的 texts），**不假装通过**。不能执行的硬门记 `fail`、软项记 `warn`。
- `report.md` 是给人看的一页：先列「必须先修的问题」（实测、期望、怎么修），再列全部检查、需要人看一眼的项、已豁免（谁、原话、出处）。
- `contact.jpg`：全片均匀约 24 张 + 每个切点前后帧 + 有发现的帧（红框、标 !）+ 有声事件帧，最多 48 格；每格标帧号、时间码、镜头号，切点标 CUT。它供代理审片，**不替代全片观看**。

## 7. 2026-11-10 实测（底座 routes-template@abfdc83，含 main 62ad28e）

在仓库快照里重建《北冥》（`sh build.sh`）与 A、B、C 三条路线的新建模版片（`npm run new` 后各自的出片入口），逐项跑 QA。结果如实列出，供各路线属主修模版：

| 成片 | delivery | visual | texts | plates | sync |
|---|---|---|---|---|---|
| 《北冥》`out/beiming.mp4`（`--profile beiming-1040p24`） | 色彩、响度（−14.0 LUFS / −1.6 dBTP）、帧数全过；作品声明含 AI 画面时 `aigc-label` 不通过（mp4 没写 comment） | 全过；切点检出 72、120，与镜头表 0 帧偏差 | `duration`：识别中… 0.50 秒、未能识别 0.58 秒、片尾副标题 0.29 秒（< 0.8 秒）；`contrast`：显示层 5 条 < 3:1（1.2–2.1:1）；缺字 0 | 1040p 密度全 ≥ 1.0；3840×2080 下 clouds_front_a 0.51、clouds_front_b 0.51 texel/px 不通过；clouds_back、clouds_front_a 左端直线淡出投影在镜头 A 画内（注意） | touch +8.4 ms、wake_ping +18.9 ms、ui_nav −4.0 ms、apex +22.7 ms；ui_fail 没检出（注意） |
| A 模版（1920×1040） | `size` 不通过（D07 默认 1080） | 全过 | 片名「晨渡」与副标题全部缺字（Barlow 子集只有数字与少数字母，落到系统字体）；副标题对比度 1.98:1 | — | — |
| B 模版 | 全过 | 全过 | 不适用（原生片没有页面） | 静态找边（注意）：mist_low 是横向可循环的贴图，左右两端贴着图边、是硬切边；模版把它当整张卡片用，卡片比画面宽，抽看第 36 帧两端在画外，要逐帧确认 | — |
| C 模版 | 全过 | `freeze`：开场第 0–13 帧逐帧几乎不变（0.58 秒空纸） | 片名缺字 | — | 5/5 事件偏差 0–3.5 ms |

这些问题已登记在 [known-issues.json](known-issues.json)，或作为跨包请求交给 A、B、C 路线与渲染器属主；《北冥》显示层的停留与对比度是已认可正片里的设计，放行要用户批准（[waivers/beiming-10s.json](waivers/beiming-10s.json) 里是待批准的草稿）。

## 8. 机器判不了的（要人做）

- 全速带声完整观看，画面、表演、节奏、混音好不好（[RUBRIC.md](RUBRIC.md)）。
- 遮挡关系：直线淡出是否被雾、云片盖住；世界内文字（画进 WebGL 场景里的字）的可读性。
- B 路线原生片：底板投影与贴图密度（没有页面）；文字（运行时自带 `raea check`）。
- 闪烁筛查是近似，不等于 PSE 认证；`visual.edge-line` 是启发式。
- 色彩准不准（灰阶、肤色、黑位）：标签与像素范围可以机判，观感要人对照基准帧（validation-and-rtx.md §8）。

## 9. 接口（给其他包）

| 谁 | 怎么用 |
|---|---|
| P06 `film qa` / 出片编排 | 终渲后调 `node tools/qa/cli.mjs report <run>/master.mp4 --json`；exit 4 即构建失败；把信封的 `result.technicalAcceptance` 写进 run.json |
| P05 作品描述与 validate-result | `import { validateReport } from 'tools/qa/lib/report.mjs'` 判 `technicalAcceptance.evidence`；`engine/production/profiles.json` 的字段写法 QA 都认（`size`/`width`、`video.color.{range,matrix,primaries,transfer}`、`audio.loudness.{integrated,tolerance,truePeak}` 等，见 `tools/qa/lib/profiles.mjs` 的 `adapt`）；P05 的 film.js 合入后，`tools/qa/lib/film.mjs` 改为先调它的升级函数 |
| P04 渲染器 | run.json 的 `technicalAcceptance` 只写 not-run，由 QA 判；页面约定的 `TEXTS` 带 `alpha`；QA 上线后，render.mjs、native.mjs、build.mjs 里各自的帧数与尺寸核对改为调 `qa delivery` |
| P11 声音 | `sync` 以 film.json 的 events 为准；混音的真峰值留余量，最终响度以 `delivery.loudness` 为准 |
| P12 / P14 / P15 路线模版 | 模版的 film.json 写 `output.profile`、`events`、`aigc`，刻意停顿写 `qa.intentional`；片名用的字进字体子集 |
| P02 仓库规范检查 | `tools/repo-check/rules/qa/` 的规则：检查项都写进本页、台账与豁免文件合格、内置档位与 D07 一致 |

## 10. 出处

- 黑场、静帧、切点的判据与 FFmpeg 的 blackdetect、freezedetect、scdet 滤镜同口径（算法自行实现，便于逐帧取证）；跳帧的帧差对中值倍数借鉴 `cases/source/style-18-art-deco/tools/motioncheck.py@1046c14`，代码重写。
- 响度：ITU-R BS.1770 / EBU R128（FFmpeg ebur128 滤镜）；安全区：EBU R95；闪烁：ITU-R BT.1702 的近似筛查；对比度：WCAG 2.x 相对亮度公式。
- 同步容差：[routes/directing/craft/animation.md §5.7](../../routes/directing/craft/animation.md)；读字时长：[routes/directing/DIRECTING.md 步骤 9](../../routes/directing/DIRECTING.md)；文字与安全区：[VISUAL-DESIGN.md §6.3](../../routes/directing/VISUAL-DESIGN.md)。
- 字体 cmap 解析按 OpenType 规范（cmap 子表 0/4/6/10/12/13）与 W3C WOFF / WOFF2 规范自行实现，不依赖第三方库。
