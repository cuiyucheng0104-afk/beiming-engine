# 作品工程描述（草案）

> **解决什么**：现在每部作品各写一套时间与事件格式，同一个时刻在画面、声音、字幕、阐述里各抄一遍；改了一处，agent 不知道还要改哪里，检查脚本也没法通用。本稿提出一个最小的统一描述：**一个时钟、一张镜头表、一张事件表**；声音、配音、字幕、风格、资产都按 id 引用它们；整体挂在现有 ProjectSpec 上，不升结构版本。
> **按什么顺序用**：§1 原则 → §2 文件布局与 `production` 块 → §3–§9 各文件的 JSON 草案与字段说明 → §10 字段先例 → §11 校验 → §12 迁移 → §13 与 ProjectSpec 对齐 → §14 不做什么。
> **状态**：设计草案【未实现】。仓库里没有读取这些文件的代码，不得报告成已有 API（同类纪律见 `AGENTS.md:30`）。每个字段都在 §10 写了先例；没有先例的不进 `beiming.production/1`，需要的列在 §10.1 待议。
> **来源**：`events.json` 的 `{dur, ev}` 外形、`window.EV`、`window.TEXTS` 和 `timeline.js` 的"段，拍"写法是第三方风格库甲的页面约定（`$甲/core/render/events.mjs:9-10`；`$甲/TECHNIQUE.md:38-42,84-93`），C 路线历史作品照此写成；本稿在它上面加 id、帧号和校验规则。
> 标注同 [craft/README.md §2](craft/README.md)。凡括号里给出 `文件:行号` 或命令的说法，都属【仓库实证】，正文不再逐条加标签；没有路径的判断，要么标【通用工艺】或【推断】，要么是对前后实证的归纳。导演流程里它对应 [DIRECTING.md](DIRECTING.md) 第 6–9 步。

## 0. 现状（为什么要统一）

【仓库实证·复算】基于只读检出 `3b97946` 的全量盘点：

- **events.json 72 份**：顶层都是 `{dur, ev}`，`ev[]` 里每条 `{t:秒, type, …自由参数}`，由页面的 `window.EV` 导出（导出工具与格式来自 `$甲/core/render/events.mjs:9-10`），混音和核对脚本只读 `['ev']`（例：`cases/source/style-15-woodcut/tools/cuecheck.py:6`）。没有 schema、版本和 fps 字段，fps 只能从 build.sh 反推。每部作品的 `type` 词表 4–76 种。同名异义：`f` 在 `style-27`、`style-29` 是帧号，在 `ppt-jianlong` 是基频 Hz；`gain` 在 `ppt-jianlong` 是 dB，在 `style-03`、`style-21` 是线性值。只有 11 份带 `id`；15 份把速度或网格写成 `ev` 里的头记录。8,707 个 `t` 中 56% 距帧格不到 0.5 ms；`dur` 有 68 份恰好等于整数帧/fps，4 份不是（§12.2）。
- **timeline.json 35 份、timeline.js 71 个**：键名全大写、全小写、混用三种并存；"分段"有 SECS、secs、SEC、sec、SECTIONS、sections、SCENES、segments、BARS 九种写法；命中点大多是"拍位置表＋秒表"两张并存（`HIT`／`T`、`KB`／`K`……）；小节与拍的编号 0 起和 1 起并存。
- **A 样片**：镜头表只有起点秒（`src/main.js:40`）；显示层时刻在 `src/hud.js:49-57`，又被 `src/main.js:31` 改写；声音表在 `audio/cues.json` 里再写一遍，帧号可以是小数。三处靠人工同步，已经出现描述漂移（[craft/animation.md §5.3](craft/animation.md)）。
- **B 例片**：镜头表在 `examples/raea/film.board`（Markdown），帧数在 `examples/raea/film.tsx:105`，声音时刻硬编码在 `examples/raea/tools/sound.py:27-40`，三处互不引用。
- **契约**：ProjectSpec 没有任何时间轴、事件、配音或字幕字段；`docs/routes/work-plan.json` 的 T00–T20 里也没有这一项。

## 1. 原则

1. **整数帧是唯一时间单位**，秒只派生。依据：时长必须等于 `frameCount/fps`（`engine/production/project.js:111-122,197-203`）；镜头区间含头不含尾（`docs/routes/contracts.md:60-62`）；浮点秒量化已经造成过晚一帧（`cases/source/style-25-dark-keynote/TREATMENT.md:143`）。
2. **一个事件只写一处**，其他文件按 id 引用。这是 `$甲/TECHNIQUE.md` §3"一份时间线驱动一切"的主张，本稿沿用并加上 id。仓库依据：声音清单按 id 引用画面事件（`cases/source/keynote-C-quanpian/ARCH.md:283`，389 条音效最大音画差 0.00 ms，`ARCH.md:412`）；画面按 id 读声音事件表（`cases/source/ppt-jianlong/jianlong/ARCH.md:69`）。
3. **计划与实测分开**：计划写在作品文件里，实测写进交付记录（`engine/production/project.js:6-7`；`docs/routes/templates/render-result.json`）。
4. **外形兼容**：`events.json` 仍是 `{dur, ev}`，旧的混音和核对脚本照样能读；新字段都是可选加法。
5. **只收有先例的字段**（§10）；没有先例但需要的，列在 §10.1 待议，不进 `/1`。

## 2. 文件布局与 `production` 块

```text
<作品>/
  project.json            ProjectSpec v1，新增可选的 production 块
  timeline.js             作者写的唯一时间源（也可以手写 timeline.json，二选一，在 production 里声明）
  build/timeline.json     导出物，可重建，不手改
  build/events.json       导出物（页面 window.EV），可重建，不手改
  sound/cues.json         声音表
  voice/lines.json        配音台词
  voice/takes.json        每条配音的生成与测量记录
  voice/words/<行>.json   逐字时间
  subs/<语言标签>.json    字幕；SRT 只从它导出
  style/lock.json         画风锁定（templates/style-lock.json）
  assets/manifest.json    资产清单
  delivery/render-result.json  交付记录（现有模板）
  delivery/checks/*.json  质检证据
```

`project.json` 新增（示例是阐述模板里的虚构短片《渡口》，它引用派生版本 `beiming-original@v1.1`，见 [templates/TREATMENT.md](templates/TREATMENT.md) §9）：

```json
{
  "production": {
    "schema": "beiming.production/1",
    "timeSource": "timeline.js",
    "timeline": "build/timeline.json",
    "events": "build/events.json",
    "sound": "sound/cues.json",
    "voice": "voice/lines.json",
    "subtitles": ["subs/zh-Hans.json"],
    "methodRefs": [
      { "caseId": "style-66-city-symphony", "path": "cases/source/style-66-city-symphony/timeline.js", "catalogStatus": "historical-render", "borrowed": "逐拍帧长速度表",
        "upstreamStyle": "city-symphony", "vendorPath": null, "license": "MIT（本仓库）" }
    ]
  },
  "style": { "id": "beiming-original", "version": "v1.1", "baseline": "media/shot_7.6.jpg", "lock": "style/lock.json" }
}
```

| 字段 | 说明 |
|---|---|
| `production.schema` | 固定 `beiming.production/1` |
| `timeSource` | 作者实际编辑的时间源文件；`timeline`、`events` 是它的导出物 |
| `sound`、`voice`、`subtitles` | 可省略（无声音、无配音、无字幕的片子） |
| `methodRefs[]` | 借用了哪些 C 路线历史案例的方法：案例 id、文件、catalog 状态、借了什么；`upstreamStyle` 填 catalog 的同名字段，`vendorPath` 填被借部分在 `cases/vendor/` 里的来源文件（逐字或改编自上游时必填，没有就填 null），`license` 写被借部分的许可。`catalogStatus` 为 rejected 的不得引用 |
| `style.lock` | 指向画风锁定文件（[templates/STYLE-LOCK.md](templates/STYLE-LOCK.md)） |

所有路径相对作品根。现有校验器只对 `entry`、`output.outputDir`、`style.baseline`、`assets.manifest` 调用路径检查（`engine/production/project.js:178-179,230-233,258`），不检查 `production` 下的路径和 `style.lock`；扩展校验器时对它们也调用 `normalizeRelativePath`（`project.js:61`）【未实现】，见 §13。

【仓库实证·实测】现有 v1 校验会忽略 `production` 这类未知顶层键和 `style.lock` 这类未知子键，`ok: true`，所以加字段不需要升 `schemaVersion`；同一条命令也说明了 C 路线的 route 值会被拒、`checkFiles` 不查 manifest 和 baseline（§11 第 8 条、§13）。在仓库根复跑：

```sh
node --input-type=module -e "
import fs from 'node:fs'; import { validateProjectSpec as v } from './engine/production/project.js';
const t = JSON.parse(fs.readFileSync('docs/routes/templates/project-beiming.json', 'utf8'));
const r = (s, o) => { const x = v(s, o); return JSON.stringify({ ok: x.ok, codes: x.diagnostics.map(d => d.code) }); };
console.log('未知键', r({ ...t, production: { timeline: '../../etc/passwd' }, style: { ...t.style, lock: '/abs/lock.json' } }, { root: '.', checkFiles: true }));
console.log('C 路线', r({ ...t, route: 'c86' }, { root: '.' }));
console.log('缺文件', r({ ...t, assets: { ...t.assets, manifest: 'nope/none.json' }, style: { ...t.style, baseline: 'media/nope.jpg' } }, { root: '.', checkFiles: true }));"
# 输出：未知键 {"ok":true,"codes":[]}；C 路线 {"ok":false,"codes":["route-invalid"]}；缺文件 {"ok":true,"codes":[]}
```

## 3. `timeline.json`：时钟、速度与镜头

```json
{
  "schema": "beiming.timeline/1",
  "timebase": { "fps": 24, "frameCount": 240, "sampleRate": 48000, "samplesPerFrame": 2000, "interval": "[in,out)" },
  "drive": "beat",
  "tempo": {
    "numbering": "存储用从 0 起的绝对拍号；显示用从 1 起的「第几小节第几拍」",
    "quantize": "every-beat-on-frame",
    "sections": [
      { "id": "A", "startFrame": 0, "meter": [4, 4], "bpmNominal": 120, "framesPerBeat": 12, "beats": 20 }
    ]
  },
  "shots": [
    {
      "id": "S1", "inFrame": 0, "outFrame": 48, "beats": [0, 4], "backend": "three",
      "framing": "近景", "angle": "平视", "camera": { "fovDeg": 30, "move": "固定" },
      "purpose": "钩子：第一帧就有动作",
      "lookPreset": "beiming-original@v1.1",
      "actorTracks": ["hand"], "actorClockOrigin": { "hand": 0 },
      "tracks": [ { "id": "hand", "step": 2 } ],
      "sound": { "perspective": "近、窄、干" },
      "visibleEvents": [ { "atFrame": 24, "event": "灯亮" } ]
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `timebase.fps`、`frameCount` | 是 | 必须与 ProjectSpec 的 `output` 相同；时长＝`frameCount/fps` |
| `timebase.sampleRate`、`samplesPerFrame` | 是 | 48 kHz 下 24／30／60 fps 每帧恰好 2000／1600／800 个采样（`docs/routes/validation-and-rtx.md` 第 2 节"音频"行） |
| `drive` | 是 | `picture`（画面主导）／`beat`（节拍主导）／`voice`（旁白主导）（[craft/animation.md §5.1](craft/animation.md)） |
| `tempo` | `drive` 为 beat 时必填 | `null` 表示没有固定网格 |
| `tempo.sections[]` | — | 每段 `startFrame`、拍号 `meter`、`bpmNominal`；`framesPerBeat` 可以是整数，也可以是逐拍数组（渐快渐慢时每拍仍落整帧）；不落整帧时改写 `quantize` 并给出误差上限 |
| `shots[]` | 是 | 至少 `id`、`inFrame`、`outFrame`；同一轨道不允许意外空隙或重叠（`docs/routes/contracts.md:60-61`） |
| `shots[].tracks[]` | — | 本镜用到的动画轨道：`id`、一拍几 `step`。轨道的起点帧不在这里写，沿用契约的 `actorClockOrigin`（连续的角色保留原起点，不从零启动，`contracts.md:63-64`） |
| `shots[].visibleEvents[]` | — | 需要人工验收的画面事实，帧号用全局帧（`contracts.md:65-66`） |
| 其余镜头字段 | — | 景别、角度、相机参数、目的、声场：阐述里的镜头表由这些字段生成 |

`shots[]` 是 `docs/routes/templates/shot.json` 的超集：`backend`、`cameraTrack`、`actorTracks`、`actorClockOrigin`、`worldTrack`、`lookPreset`、`stateBefore`、`stateAfter`、`evaluation`、`visibleEvents` 照原样可用，含义以 `docs/routes/contracts.md:58-69` 为准。本稿只加轨道的一拍 n（`tracks[].step`）和景别、相机、目的、声场这些描述字段。

## 4. `events.json`：唯一事件表

```json
{
  "schema": "beiming.events/1",
  "fps": 24,
  "frameCount": 240,
  "dur": 10,
  "ev": [
    { "id": "lamp.on", "frame": 24, "t": 1.0, "beat": 2, "type": "lamp-on", "shot": "S1", "domain": "picture", "sfx": true },
    { "id": "lamp.off", "frame": 132, "t": 5.5, "beat": 11, "type": "lamp-off", "shot": "S2", "domain": "picture", "sfx": true },
    { "id": "fish.glow", "frame": 144, "t": 6.0, "beat": 12, "type": "glow", "shot": "S3", "domain": "picture", "sfx": true, "source": "plan" }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema`、`fps`、`frameCount` | 新增 | 旧脚本会忽略；`dur` 必须等于 `frameCount/fps` |
| `ev[].id` | 是 | `组.名[.序号]`，组是镜头、段或章；全片唯一（与 `keynote-C-quanpian` 的"章.名"、`style-15` 的 `knife.0` 兼容） |
| `ev[].frame` | 是 | 结果帧（落定类取第一次到位那一帧，起动类取第一帧开始变化，`keynote-C-kaitou/TREATMENT.md:17`） |
| `ev[].t` | 是 | 保留给旧混音器，等于 `frame/fps` |
| `ev[].beat` | 节拍主导时 | 从 0 起的绝对拍号，可带小数 |
| `ev[].domain` | 是 | 事件属于哪一类：`picture`／`ui`／`text`／`sfx`／`music`／`vo`。不叫 `layer`，因为现有 `audio/cues.json` 的 `layer` 是混音总线（§12.1）；总线在声音表里写 `bus` |
| `ev[].sfx` | — | `true` 表示这一帧必须有声音落点；成片上按 [craft/animation.md §5.7](craft/animation.md) 的同步容差表判定（声音晚于结果帧 0–1 帧可接受，早于结果帧不超过约 10 ms）。先例 `keynote-C-quanpian/tools/cuecheck.py` 用的是对称的 ±1 帧，本稿改成不对称窗口 |
| `ev[].source` | — | `plan`（计划时刻）或 `probe`（按画面实际状态扫描得到，如 `style-42-tilt-shift/main.js:423-448` 的 vhit） |
| `ev[].span` | — | 区间事件 `{ "outFrame": … }` |
| `ev[].raw` | — | 只给连续拟音（笔声、珠子）用：允许子帧，必须写 `raw: true` |
| 自由参数 | — | 键名带单位：`durSec`、`gainDb`／`gainLin`、`freqHz`；`pan` 用 −1…1，渐变写 `{ "from": …, "to": … }` |

## 5. `sound/cues.json`：声音表

```json
{
  "schema": "beiming.sound/1",
  "buses": ["amb", "fx", "ui", "kun", "music", "master"],
  "shots": [ { "shot": "A", "perspective": "远、闷、宽" } ],
  "cues": [
    { "id": "touch", "ev": "girl.touch", "offsetSec": 0.05, "anchor": "onset", "type": "touch", "bus": "ui", "gainDb": 0, "pan": -0.1 },
    { "id": "beat-tick", "bar": 9, "beat": 4, "s16": 1, "type": "tick", "bus": "ui", "gainDb": -18 },
    { "id": "room", "t": 0, "raw": true, "type": "room", "bus": "amb", "durSec": 10 }
  ],
  "silences": [ { "inFrame": 132, "outFrame": 144, "kind": "digital-zero", "maxRmsDb": -90, "next": "fish.glow" } ],
  "mostImportant": { "ev": "fish.glow", "class": "B", "note": "靠静默反衬，不要求最响" },
  "premaster": { "integratedLufs": -14, "truePeakDbTP": -1.7 }
}
```

| 字段 | 说明 |
|---|---|
| `cues[]` 的时刻 | `ev`、`bar/beat/s16`、`t` 三选一（`keynote-C-quanpian/mix.py:117-123` 的规则）；默认量化到帧，`raw: true` 才保留子帧 |
| `offsetSec`、`anchor` | 同步点与声音起点之差：`onset`（起音对准）／`peak`（峰值对准）／`end`（收尾对准），用于预卷和 J/L-cut（例：起音按包络 10% 点对齐，`style-18-art-deco/music/score.py:27`；按半高点，`style-17-spy-titles/mix.py:26-31`） |
| `gainDb` | 只认 dB |
| `silences[]` | 帧区间、类型（`digital-zero`／`room-tone`）、目标电平、之后的第一声 |
| `mostImportant` | "最重要的一声"及类型 A（最响，交付时报 LU 差）／B（静默反衬） |
| `premaster` | 混音阶段的目标（编 AAC 之前）：A 样片 −14 LUFS、−1.7 dBTP（`audio/cues.json:6-9`）。**交付门槛只写在 ProjectSpec 的 `audio`**：目标 −14 LUFS、真峰值上限 −1.2 dBTP（`docs/routes/templates/project-beiming.json:12`），容差 ±1 LU（`docs/routes/validation-and-rtx.md:37`），以最终 AAC 复测为准。其他文件只引用这两处，不另写数字 |

## 6. `voice/`：配音

```json
{ "id": "n01", "speaker": "旁白", "lang": "zh-CN", "spoken": "一座村庄，<#0.3#>一副眼镜。", "display": { "zh-Hans": "一座村庄，一副眼镜。" },
  "voice": { "engine": "cloud-tts", "voiceId": "…", "speed": 1.0, "pitch": 0 },
  "place": { "after": "n00", "gapSec": 0.3 } }
```

- `lines.json` 每行：`spoken` 是送 TTS 的原话（可含停顿标记），`display` 是各语言的显示文本，`lang` 用标准语言标签。现有作品里 `zh`、`cn`、`sub`、`es`、`say` 语义互相冲突（例：`ppt-in-sight` 的 `zh` 存英语原话，`ppt-before-sunset` 的 `zh` 存中文字幕），迁移时统一到这两个字段。
- `place` 四种写法都有先例：按停顿串接 `{after, gapSec}`（`ppt-in-sight/film/build.py:25-48`）、按网格 `{bar, beat}`（`ppt-dance-mentor/film/build.py:31-35`）、固定起点 `{frame}`（`ppt-jianlong/jianlong/data/timeline.json`）、镜头内偏移 `{shot, offsetSec}`（`ppt-painting-treasure/film/timeline.json`）。画面锁定后统一落成绝对帧，写进 `takes.json`。
- `takes.json` 每条：`line`、`file`、`sha256`、`sampleRate`、`seconds`、`billedChars`、参数快照、`placedFrame`、`words`（逐字时间文件）。接口原始响应不入库：现有 281 份原始响应里带已过期的签名下载链接和请求追踪号（【仓库实证】`git grep -l OSSAccessKeyId -- cases/source` 共 281 个文件），与 `docs/cases/verification.md:25`"未发现签名下载令牌"的说法不符。
- `words/<行>.json`：`{line, timing: "tts"|"asr"|"proportional", chars: [[字, 起秒, 止秒]]}`，格式同 `ppt-jianlong/jianlong/data/words.json`。只能按字数比例估的，必须标 `proportional`，不能静默退化（反例：`ppt-before-sunset/film/build.py:33-44`）。

## 7. `subs/<语言标签>.json`：字幕

```json
{ "lang": "zh-Hans",
  "rules": { "maxCharsPerLine": 18, "minHoldSec": 1.8, "tailSec": 0.6, "gapSec": 0.0833, "stripLineEndPunct": true },
  "cues": [ { "id": "n01_0", "line": "n01", "t0": 4.539, "speakEnd": 7.836, "t1": 8.436, "text": "一座村庄，一副眼镜，一段历史", "style": "present" } ] }
```

规则与字段取自 `ppt-jianlong/jianlong/tools/subs.py:4-7` 和 `data/subs.json`：先按句读标点断小句再贪心合并，每行不超过 18 字，去掉行尾标点；每条至少显示 max(1.8 s, 念完＋0.6 s)，不压到下一条；`speakEnd` 与 `t1` 分开存，能区分"念完"和"显示结束"。`gapSec` 的先例值是 0.05 s（`subs.py:6`，30 fps 下只有 1.5 帧，相邻两条会读成闪一下），本稿要求不少于 2/fps（24 fps 下 0.083 s）【通用工艺·建议】。字幕最长停留、最多行数、离切点多近要吸附，仓库没有先例，列在 §10.1 待议（建议数字见 [VISUAL-DESIGN.md §6.3](VISUAL-DESIGN.md)）。SRT 只从这里导出。画面里的其他文字仍走 `window.TEXTS(t)` 加白名单（`src/hud.js:362-381`；`ppt-jianlong/jianlong/ARCH.md:71`）。

## 8. 画风与资产

- **画风**：`style/lock.json`，结构见 [templates/STYLE-LOCK.md](templates/STYLE-LOCK.md)。
- **资产**：以契约的 AssetManifest 为底（`docs/routes/contracts.md:135-141`；`docs/routes/templates/asset.json`：id、来源版本、相对路径、sha256、单位、轴向、包围盒、材质类别、clips、形变方式）。底板另加 2.5D 字段：用途、镜头、层级（与 renderOrder 同序）、计划视深、出血、边缘处理、光向、色彩空间与 alpha、是否参与雾和阴影（完整任务单见 [craft/two-five-d.md §2.8](craft/two-five-d.md)）；生成素材加来源（工具、提示、放大方式）；他人 IP 加权利约束（不改色、不变形、不抠图……，[VISUAL-DESIGN.md §7.2](VISUAL-DESIGN.md)）；被否的资产保留记录和理由（先例：`cases/source/lab-2026-11-05-nine-scenes-360/models/asset-review.json`，该案例的 catalog 状态是 experiment）。
- 现有 `assets/plates/plates.json` 是 ProjectSpec 模板登记的 `assets.manifest`（`docs/routes/templates/project-beiming.json:11`），但它没有 sha256 和版本，层级与视差字段也和代码不一致（[craft/two-five-d.md §2.7](craft/two-five-d.md)），应作为底板子清单被总清单引用，并补哈希。

## 9. 交付记录

- `delivery/render-result.json` 就是现有的 RenderResult 模板：`technicalAcceptance` 与 `creativeAcceptance` 分开，`accepted` 要求两者都通过、创作验收必须记录可见事件和风格对照（`engine/production/project.js` 第 371 行起的 `validateRenderResult`）。
- `delivery/checks/` 放质检证据，都被 `technicalAcceptance.evidence` 引用：`probe.json`（帧数、尺寸、fps、色彩标签）、`cuecheck.json`、`readcheck.json`、`loudness.json`（对最终 AAC 测：积分响度、真峰值，短片另记最大短期与最大瞬时响度；判定门槛读 ProjectSpec 的 `audio`）。数字一律存数值，不存 ffprobe 输出的字符串。
- 人工观看记录（审片人、日期、原话）写进 `creativeAcceptance`，由人填写；代理审片证据放 `delivery/checks/`，结论写"代理检查通过"（[DIRECTING.md 步骤 10](DIRECTING.md)）。

`cuecheck.json` 建议结构：

```json
{ "events": [ { "id": "lamp.on", "plannedFrame": 24, "pictureFrame": 24, "sfxOnsetMs": 1000.3, "musicOnsetMs": null, "deltaMs": 0.3 } ],
  "maxDeltaMs": 0.3,
  "silences": [ { "inFrame": 132, "outFrame": 144, "rmsDb": -151 } ] }
```

## 10. 字段先例

| 本稿字段 | 仓库先例 |
|---|---|
| 整数帧、`[in,out)` | `docs/routes/contracts.md:60-62`；`docs/routes/templates/shot.json` |
| `timebase.samplesPerFrame` | `docs/routes/validation-and-rtx.md` 第 2 节"音频"行 |
| `tempo.sections[].framesPerBeat` 整数 | `cases/source/style-15-woodcut/timeline.js`（每拍 19 帧）；`cases/source/style-27-cel-anime-80s/timeline.json` 的 `FPB` |
| `framesPerBeat` 逐拍数组 | `cases/source/style-66-city-symphony/timeline.js:6-27` |
| 固定 BPM＋取用时量化 | `cases/source/keynote-C-quanpian/src/timeline.js:5-11`（`bt()`、`fq()`） |
| `shots[]` 带帧区间 | `cases/source/style-27-cel-anime-80s/timeline.json` 的 `SHOTS` |
| `tracks[].step`；起点沿用 `actorClockOrigin` | `docs/routes/contracts.md:63-69`；`docs/routes/templates/shot.json:9`；`engine/core/clock.js:12-13` |
| 顶层 `{dur, ev}`、`ev[].t`、`type` | `$甲/core/render/events.mjs:9-10` 的输出格式（第三方，MIT）；72 份历史 `events.json` |
| `ev[].id` | `keynote-C-quanpian/ARCH.md:132`；`style-15-woodcut/events.json` 的 `key` |
| `ev[].frame` | `keynote-B-kaitou`、`keynote-seg1-kaijuan` 的 events.json |
| `ev[].source: probe` | `cases/source/style-42-tilt-shift/main.js:423-448`；`style-56-briefing-board/tools/cuecheck.mjs:1` |
| 声音按 `ev` 引用、`raw` | `cases/source/keynote-C-quanpian/mix.py:110-124` |
| `anchor`、`offsetSec` | `style-07-shadow-puppet/music/score.py:25`；`style-17-spy-titles/mix.py:26-31`；`style-18-art-deco/music/score.py:27` |
| `silences[]` 带目标电平 | `cases/source/style-15-woodcut/tools/cuecheck.py:29-35,43` |
| `voice.place` 四种 | 见 §6 |
| `words` 逐字时间 | `ppt-jianlong/jianlong/data/words.json` |
| 字幕规则 | `ppt-jianlong/jianlong/tools/subs.py:4-7` |
| `takes` 的规范化记录 | `ppt-before-sunset/配音/wav/dur.json` 与 `usage.json`；`ppt-in-sight`、`ppt-dance-mentor` 的同名文件（三件都是 historical-render） |
| `methodRefs[].upstreamStyle`、`vendorPath` | `cases/catalog.json` 的案例字段 `upstreamStyle` 与文件字段 `upstream`（45 个案例的 137 个文件） |
| 交付双验收 | `engine/production/project.js` 的 `validateRenderResult` |

### 10.1 待议字段（没有仓库先例，不进 `/1`）

| 字段 | 用途 | 依据 |
|---|---|---|
| `shots[].focus: { in: [x, y], out: [x, y] }` | 切点前后主体中心的屏幕位置，查视觉落点 | 【通用工艺】，VISUAL §4.4 第 3 条 |
| `shots[].screenDirection` | 本镜主体的屏幕方向（左→右等），查轴线 | 【通用工艺】，VISUAL §4.4 第 1 条 |
| `shots[].keyAzimuthDeg` | 本镜主光的屏幕方位，查同场光向一致 | 【通用工艺】，VISUAL §4.4 第 5 条；样片各镜的主光方向写在镜头代码里（`src/shotA.js:53-55`；`src/shotC.js:110-112`） |
| `subs.rules.maxHoldSec`、`maxLines`、`snapToCutFrames` | 字幕最长停留、最多行数、离切点多近要吸附 | 【通用工艺·建议】，VISUAL §6.3 |

这些字段要等有作品真正用过、校验脚本写出来之后再收。

## 11. 校验（建议脚本，【未实现】）

1. `timeline.timebase.fps／frameCount` 与 ProjectSpec `output` 相同；`events.dur＝frameCount/fps`。
2. 镜头区间连续、无意外空隙或重叠；每个切点是本镜所有轨道 `step` 的公倍数帧（[craft/animation.md §2.3](craft/animation.md)）。
3. `domain` 为 picture 或 `sfx: true` 的事件，`frame` 为整数，`t＝frame/fps`；子帧只允许 `raw: true`。
4. 声音 `cues[].ev` 都能在事件表里找到；不存在的 id 报错，构建失败。先例 `keynote-C-quanpian/mix.py` 对未知 id 只告警并丢弃该条（`mix.py:31` 的 `warn()` 只打印并记入报告，`:121-122` 告警后 `continue`），本稿要求改成报错。
5. `sfx: true` 的事件有声音落点；成片实测按 [craft/animation.md §5.7](craft/animation.md) 的不对称窗口判定；静默区间的电平不超过目标。
6. 阐述里的镜头表、拍点表和规格头时长与时间轴一致（防 DIRECTING 步骤 4 列出的那类漂移）。
7. 字幕不跨切点；读字时长过检或已登记例外。
8. `production` 下所有文件存在；`assets.manifest`、`style.baseline` 存在且哈希一致（现有 `checkFiles` 只查 `entry`：把 manifest 和 baseline 改成不存在的路径仍然 `ok: true`，【仓库实证·实测】，复跑命令见 §2）。
9. 声音与交付响度：混音按 `premaster`，最终 AAC 按 ProjectSpec `audio` 判定（§5）。

## 12. 迁移

### 12.1 A 样片（演示，未执行）

镜头：`src/main.js:40` 的 `{at:0}`、`{at:3}`、`{at:5}` → 帧区间 `[0,72)`、`[72,120)`、`[120,240)`。三个切点都是 6 的倍数，一拍二、一拍三的轨道不会被截成半拍（[craft/animation.md §2.3](craft/animation.md)）。

事件（摘录，画面主导，`tempo: null`）：

| id | frame | 来源 | 说明 |
|---|---|---|---|
| `girl.touch` | 84 | 指尖贴上镜腿（`src/girl.js:381-385`） | 3.5 s |
| `hud.on` | 120 | `HUD_T.on = 5.0`（`src/hud.js:50`） | |
| `hud.scan` | 131 | `HUD_T.scan = 5.45` | 5.45×24＝130.8，显示层在 t≥5.45 时出现，第一帧可见是 131 |
| `hud.fail` | 150 | `HUD_T.fail = 6.25` | |
| `hud.nav` | 168 | `HUD_T.navIn = 7.0` | |
| `title.bei` | 216 | `HUD_T.titleA[0] = 9.0`（`src/main.js:31` 改写后的值） | |

声音（摘录）：先改键名——`audio/cues.json` 的 `layer` 是混音总线（取值 amb/fx/kun/master/music/ui，与 `audio/mix.py:247` 的 `BUS` 一致），改名 `bus`；`gain_db` 改名 `gainDb`；带小数的 `frame`／`frame_end` 改成按 `ev` 引用，或写 `t` 加 `raw: true`。再改时刻：`touch`（t 3.55）改成 `{ev: "girl.touch", offsetSec: 0.05}`，`wake_ping`（3.6）改成 `{ev: "girl.touch", offsetSec: 0.1}`，数值不变。`ui_scan`（5.45）改成 `{ev: "hud.scan"}` 后会落在 5.4583 s，**晚 8.3 ms**；要逐采样保持原样，就写 `{t: 5.45, raw: true}`。`audio/cues.json` 的 `shots[].声场` 移到 `timeline.shots[].sound.perspective`。

迁移后显示层时间表与声音表从同一份事件表生成，鸽群这类描述漂移（画面 12 只，声音按 10 只合成）由事件参数统一。

### 12.2 C 路线的 `events.json`（72 份）

| 现有写法 | 迁移后 |
|---|---|
| 顶层 `{dur, ev}` | 不变；加 `schema`、`fps`、`frameCount` |
| `ev[].t` | 保留；加 `frame`。现有 68 份 `dur` 恰好等于整数帧/fps，4 份不是：`style-10`（30 fps 下 592.5 帧，母版实为 592 帧）、`style-34`（478.0008 帧，截到 4 位小数）、`style-59`（475.2 帧）、`style-61`（24 fps 下 472.000008 帧）。在迁移副本里修正或注明。复算：按各作品 fps 判断 `|dur×fps − round(dur×fps)| < 1e-6` |
| `key`（如 `style-15` 的 `knife.0`） | 改名 `id` |
| `d`、`dur` | `durSec` |
| `gain` | 按作品声明为 `gainDb` 或 `gainLin`，不靠猜 |
| `g`、`v`、`vel` | `gainLin` 或 `velocity` |
| `f` | 按作品改为 `frame` 或 `freqHz` |
| `pan: [起, 止]` | `pan: {from, to}` |
| `t0`、`t1` 区间 | `span` |
| `type` 为 grid、meta、tempo、timeline 的头记录 | 移到 `timeline.tempo`，新导出不再写进 `ev` |
| `vhit` 一类实测命中 | `source: "probe"` |

### 12.3 C 路线的 `timeline.json`（35 份）

| 现有键 | 迁移后 |
|---|---|
| `FPS`／`fps` | `timebase.fps` |
| `DUR`／`dur`／`total` | 不存，校验时由 `frameCount/fps` 推出并比对 |
| `BPM`／`bpm` | `tempo.sections[].bpmNominal` |
| `FPB`／`fpb`／`BEAT_FRAMES`；`BEAT`／`beat`／`B`／`spb`／`beat_s`（拍长秒数） | `framesPerBeat`（秒数换成帧数，不整除就改 `quantize` 并写误差） |
| `SECS`、`secs`、`SEC`、`sec`、`SECTIONS`、`sections`、`SCENES`、`segments`、`BARS` | `tempo.sections`（音乐段）或 `shots`（画面段），按内容分 |
| `SHOTS`／`shots`／`stations` | `shots` |
| `HIT`／`hit`／`CUE`／`cues`／`KB`／`B`（拍位置表）与 `T`／`t`／`K`／`h`／`H`（秒表） | 合并进 `events.json`：每个命中点一条事件，带 `beat` 和 `frame`；只留一张表 |
| 内嵌的 `EV`／`events`／`ev` | 移到 `events.json` |

注意 `B` 在 `style-18`、`style-23` 是拍长秒数，在 `style-55`、`style-61` 是命中点到拍号的映射；小节与拍的编号 0 起（`ppt-dance-mentor/film/build.py:20` 的 `tb()`、`style-02` 的 `HIT`）和 1 起（`keynote-C-quanpian` 的 `bt()`、`style-66` 的 `F()`）都有。迁移前逐部确认，最常见的错误是整体差一小节。

### 12.4 B 例片

`examples/raea/film.board` 的三行 → `shots`：0–3.5 s、3.5–6 s、6–10 s 换成 `[0,84)`、`[84,144)`、`[144,240)`；Composition 的 `fps=24`、`durationInFrames=240`（`examples/raea/film.tsx:105`）→ `timebase`；鲲的一拍三 `q=Math.floor(f/3)*3/24`（`film.tsx:66`）→ `tracks[{id:"kun", step:3}]` 加 `actorClockOrigin: {kun: 0}`；`tools/sound.py` 里汽笛 0.45 s、鲲鸣 3.7 s、和弦 5.9 s、铃声 6.35/7.15/8.1 s（`sound.py:27,32,39-40`）→ 先补对应的画面事件，再让声音按 `ev` 引用。原生运行时不读这些文件，迁移只用于记录和核对。

### 12.5 PPT 旁白驱动片

`lines.json` → `voice/lines.json`（`spoken`、`display`、`lang`）；`dur.json` → `takes.json` 的 `seconds`；`usage.json` → `billedChars`；接口原始响应只保留采样率、时长、字数，删去签名链接与追踪号；`data/timeline.json` 的 `vo.start` → `place: {frame}`；逐字时间只有 `ppt-jianlong` 保留了，其他作品标 `timing: "proportional"`。

### 12.6 迁移纪律

历史快照只读，迁移写到新目录（`AGENTS.md:57`：用 `python3 tools/casebook.py restore <id>` 还原到独立工作区）；不在共享检出里跑会写文件的脚本（`audio/mix.py:277` 会重写 `audio/CREDITS`）。

## 13. 与 ProjectSpec 对齐

| ProjectSpec 字段 | 本稿怎么用 |
|---|---|
| `output.fps`、`output.frameCount` | 时间的唯一来源；`timeline.timebase` 与 `events` 都由它推导并校验 |
| `output.width`、`height` | 不变；设计高、K 写在 style-lock 的 `layout` |
| `style.id`、`version`、`baseline` | 不变；新增 `style.lock` |
| `style.migration` | 北冥画风走原生后端时照旧必填 |
| `assets.manifest` | 指向符合 AssetManifest 的清单（§8） |
| `audio` | 交付目标（−14 LUFS、真峰值上限）；混音阶段目标写在 `sound.premaster` |
| `execution` | 只写计划；实测进 RenderResult（`engine/production/project.js:281-285`） |
| 新增 `production` | §2 |

**C 路线怎么表示**：`route` 现在只接受 `beiming` 和 `raea`（`engine/production/project.js:17`），填 C 路线的值会返回 `route-invalid`（【仓库实证·实测】，复跑命令见 §2）。按 `docs/TRACKS.md:43`"C 取方法，落回 A 或 B 执行"，本稿建议新作品的 `route` 仍填 A 或 B，用 `production.methodRefs` 记录借了哪些 86 式方法，校验器拒绝把 rejected 的案例当正面引用。历史 86 式作品的复现条件继续由 `cases/catalog.json` 的 `requirements` 承载。若要让 C 成为第三个 route，需要新增枚举值，以及一个不等同于 `three` 的浏览器页面后端——这要用户或集成负责人拍板。

**校验器要扩的地方**【未实现】：`production` 下所有路径和 `style.lock` 也调用 `normalizeRelativePath`（`project.js:61`）防越界；`checkFiles` 覆盖 `production` 下的文件、`assets.manifest` 和 `style.baseline`；`methodRefs` 里 `catalogStatus` 为 rejected 的报错；把 `tests/production` 接进 npm 脚本（现在 `package.json` 只有 `test:routes` 和 `test:cases`）；在 `docs/routes/work-plan.json` 新增"时间轴、事件、配音、字幕契约"任务。

## 14. 不做什么

- 不做通用中间表示，不替代设计中的 FrameState（`docs/routes/contracts.md` 第 4 节）；本稿只描述时间与事件，不描述每帧状态。
- 不要求原生运行时读这些文件；B 路线只用它们记录和核对。
- 不在 `events.json` 里存画面参数曲线；曲线留在镜头代码或时间轴源文件里。
- 暂不接 EDL、OpenTimelineIO 之类的剪辑交换格式【通用工艺】；需要给剪辑审片时再从 `shots` 和 `events` 导出。
- 不收没有先例的字段。

## 15. 出处与许可

- 本稿新增字段的先例来自本仓库文件（§10）。`events.json` 的 `{dur, ev}` 外形、`window.EV`、`window.TEXTS`、`timeline.js` 的 `SECS`／`HIT`（段，拍）与 cuecheck 的做法，是第三方风格库甲规定的页面约定（`$甲/core/render/events.mjs:9-10`；`$甲/TECHNIQUE.md:38-42,84-93`；`$甲/core/README.md:24-26`），72 份历史 `events.json` 照此写成；原则 2"一份时间线驱动一切"沿用 `$甲/TECHNIQUE.md` 第 3 节。本稿用自己的话整理，未复制原文。
- `$甲` = `cases/vendor/lemo-opuscar`（MIT，LemoLab），见 [SOURCES.md](SOURCES.md)。
