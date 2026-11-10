# 出片编排命令 · tools/film

> 一条 Node 命令依据作品描述 `film.json` 出片：三条路线、三个平台同一套参数、同一套退出码与运行记录。新作品一律用它出片；
> 《北冥》10 秒样片的 `npm run beiming:build`（`sh build.sh` 是它的兼容壳）也只是它的一层包装。
> 入口：`npm run film -- <子命令>`，等价 `node tools/film/cli.mjs <子命令>`。参数、`--help`、`--json` 与退出码遵守 [docs/CLI.md](../../docs/CLI.md)（实现是 `tools/lib/cli.mjs`）。

## 1. 做一部片的顺序

三道闸 look → animatic → final（决定 D08）。每道闸都要用户看过、按原话记录；**agent 不得自己批准，也不得替用户写原话**。

```sh
npm run new -- c my-film --title 晨渡                 # 1 新建（也可 npm run film -- new c my-film --title 晨渡）
npm run film -- check films/my-film                   # 2 只读检查：作品描述、页面契约 / 原生预检、档位与镜头表
npm run film -- stills films/my-film                  # 3 风格关键帧 + 联系表 → 给用户看
npm run film -- review approve look films/my-film --quote "<用户原话>" --source "<会话 / 日期 / 第几条>" --reviewer "<审阅人>"
npm run film -- animatic films/my-film                # 4 半分辨率动态预演（时长、切点同正片）→ 给用户看
npm run film -- review approve animatic films/my-film --quote "…" --source "…" --reviewer "…"
npm run film -- build films/my-film --final           # 5 终渲：先查闸门，再整条出片链 + 机器 QA 门
npm run film -- review approve final films/my-film --quote "…" --source "…" --reviewer "…"   # 之后 run.json 才是 accepted
npm run film -- status films/my-film                  # 任何时候：闸门、最近运行、下一步
```

- 工作版（不加 `--final`）随时可出，不查闸门；终渲（`build --final`、`render --final`）没有 look、animatic 的用户认可或**带用户原话的**豁免时退出码 4，一帧不渲、不建运行目录。
- 用户明确说不用看时记豁免：`npm run film -- review waive look,animatic films/my-film --reason "<理由>" --quote "<用户原话>" --source "<出处>"`；也可以出片时一并记（`build … --waive look,animatic --reason … --quote … --source …`）。**没有 `--quote/--source` 的豁免只记一条内部说明（comment），不放行终渲**——自检（如 G1）用它出工作版。final 闸不能豁免。
- agent 自己的审片结论用 `review note`（记为 comment），留证据、不放行任何闸。
- 「已交付 / 用户已认可」只能在最近一次终渲的 run.json 是 `accepted` 时说；`status` 会如实分三件事写：已输出 / 技术检查 / 人工认可。

## 2. 子命令

| 子命令 | 做什么 | 产物（都在运行目录里） |
|---|---|---|
| `new <a\|b\|c> <名字> [--title] [--profile] [--dry-run]` | 参数先按同一套规则检查，再转调 `tools/new-film.mjs`；信封转交它的结果，另给下一步命令 | `films/<名字>/` |
| `check <作品>` | 只读：作品描述校验（`engine/production/film.js check`；没有时用 `tools/lib/filmspec.mjs` 做结构自检）、页面契约探测或原生预检、档位、切点、闸门要求 | 无（不建运行目录） |
| `stills <作品> [--frames … \| --times …]` | 风格关键帧：缺省每个镜头取中间一帧，单镜头取片长 1/6、1/2、5/6 | `stills/` `frames.json` `contact.jpg` |
| `animatic <作品>` | 半分辨率预演：页面加 `previs=1`；临时声用作品混音，没有声音就按事件与切点生成提示音；B 用原生 `--quality draft` | `animatic.mp4` `contact.jpg` `player.html` |
| `build <作品> [--final] [--profile] [--size]` | 整条出片链（§4）；`--from` / `--to` 只跑一段；输入没变的步骤复用缓存；`--profile` 换档位（画幅或帧率与 film.json 不同时 QA 读生效描述，§4）；`--size` 出改画幅的工作版（不是交付件，不跑交付 QA） | `master.mp4` `web.mp4` `player.html` `contact.jpg` `poster.jpg` `qa/`（换了档位另有 `film.effective.json`） |
| `mix <作品>` | 只做声音：A、C 跑到声画拍点核对（`build --to cuecheck`），B 跑原生素材准备（`--to prepare`） | `audio/mix.wav` `audio/stems/` `audio/cuecheck.txt` |
| `assemble <作品>` | 画面与声音复用缓存，只重做封装及之后（A、C `build --from mux`，B `--from web`） | 同 build |
| `render <作品> --frames a:b \| --shot S [--clip] [--final]` | 只渲指定帧段或镜头，逐帧缓存（同一命令第二次 0 帧重渲）；`--final` 先查闸门，不给帧段时等于 `build --final` | `frames/` `frames.json` `contact.jpg`（`--clip` 另有 `range.mp4`） |
| `qa <作品> [--run <id>]` | 对已出的片子补跑机器 QA 门，回写那次的 run.json；作品描述与出片时同一口径（用那次的 `film.effective.json`）；`--size` 的工作版不审（用法错误） | `qa/` |
| `review approve\|reject\|waive\|note\|status …` | 闸门审阅记录（§6）；`approve …` 是 `review approve …` 的简写 | `films/<名>/review/<闸>-<日期>.json`（随作品源码提交） |
| `status <作品>` | 闸门、最近各类运行、下一步命令 | 无 |

每个子命令都有 `--help`（打印到 stdout、退出码 0、不建目录、不启动浏览器或子进程）。帧号从 0 起，`a:b` 是半开区间（含 a 不含 b），与镜头表同口径。

## 3. 运行目录（附录 C4）

```text
films/<名>/out/
  <run-id>/                 一次运行；run-id = UTC 的 YYYYMMDD-HHMMSS-<提交前 8 位>[-dirty]（同一秒已被占用时顺延一秒，不加后缀）
    master.mp4 web.mp4 player.html contact.jpg poster.jpg run.json
    film.effective.json     本次生效的作品描述：--profile 换了画幅或帧率时才有（§4「档位与作品描述」），QA 读它
    qa/report.json report.md contact.jpg   机器 QA 门的报告（附录 C8）
    checks/output.json      编排器对主产物的核对（完整解码计帧、画幅、帧率、音轨）
    events.json timeline.json audio/mix.wav audio/stems/   页面导出的事件表、混音（A / C）
    native/ technical.json  B 的原生清单与原生入口的核对
    logs/<步骤>.log         每一步的完整输出
    work/                   中间件（work/video.mp4 是逐帧中间件）；work/tmp 是子进程的 TMPDIR，运行结束删除
  latest                    指针文件：最近一次整条链跑完且没失败的 build（含 --no-qa、--size 的工作版，run.json 分别记 blocked、
                            rendered；--to 提前停、失败、中断不更新）；不是符号链接，兼容 Windows。作品描述包的状态机按它找
                            「最近一次运行」，再看那次的 kind 与 status
  latest-<stills|animatic|render>   同口径
  cache/<步骤>/<输入哈希>/  步骤缓存（硬链接，不占双份空间；随时可删）
  .lock                     作品锁：同一作品同一时间只允许一次运行，另一次退出码 5
```

镜像作品（film.json 写了 `mirror.paths = "repo"`，如描述仓库根《北冥》样片的 `films/beiming-10s`）的路径相对仓库根，运行目录默认在 `mirror.outDir`（《北冥》是 `out/beiming/<run-id>/`）。产物只写进运行目录：现有脚本写死的旧位置（作品目录的 `events.json`、`out/mix.wav`、原生入口的 `out/native.mp4` 等）由编排器临时登记、运行结束（成功、失败、被中断都一样）还原，run.json 的 `legacyRestored` 记录还原了什么。运行前后各取一次 `git status`，作品目录以外多出的改动写进警告与 `repoTouched`（只报告、不还原）。

## 4. 出片链

| 路线 | 步骤（`--from` / `--to` 用这些名字） | 调用的现有工具（编排器不重写它们） |
|---|---|---|
| A、C（页面型） | `probe → mix → cuecheck → video → mux → web → label → poster → contact → player → qa` | `engine/render/events.mjs`（页面契约 + 事件表）、film.json 的声音脚本或 wav、`python -m engine.audio.cuecheck`、`engine/render/video.mjs`、`engine/render/mux.sh` |
| B（原生） | `prepare → preflight → native → web → label → poster → contact → player → qa` | `engine/native/prepare.mjs`、`engine/render/native.mjs --check-only`、`native.mjs --mux copy --out …` |
| 预演 | A、C：`probe → mix → video → preview → label → contact → player`；B：`prepare → preflight → native(draft) → label → contact → player` | 同上 |

- 页面型步骤定义在 `engine/render/build.mjs`，B 的在 `tools/film/lib/native-steps.mjs`，三条路线共用的交付步骤（网页版、AIGC 标识、海报、联系表、播放页、QA）在 `tools/film/lib/deliver.mjs`。
- **开工前预检**：建运行目录后、渲染第一帧之前调 `tools/env/preflight.mjs`（约 1 秒，不启动浏览器）：全部要 ffmpeg、python（另查 Pillow）、browser；A / C 出片有声时要 sh（`mux.sh`）；要跑声音脚本、拍点核对或 B 的素材准备时要 `python:audio`；B 要 `raea`。缺什么一次说清，退出码 3。
- **缓存**：带输入哈希的步骤（mix、cuecheck、video、mux、web、prepare、native）输入没变就复用。video 的键包括作品目录、页面会 import 的 engine 层（core、form、shade、stage、look、paint、overlay、assets）、fonts、assets、src、渲染器文件、传给 video.mjs 的参数、Playwright 与浏览器版本、`BEIMING_ANGLE`、平台。`--no-cache` 全部重跑；`--from X` 从 X 起强制重跑，X 之前带哈希的步骤必须能复用（否则用法错误并说明是哪一步）。
- **页面帧率**：video.mjs 按 `window.FPS`（没声明按 24）量化一拍二 / 一拍三。与档位帧率不同时，终渲退出码 4；工作版告警并加 `--any-fps`。
- **软件渲染**：WebGL 落到 SwiftShader / llvmpipe / WARP 时，`--gpu required`（默认）退出码 3；`--gpu any` 或 `software-ok`（CI 冒烟）放行并在 run.json 记 `softwareFallback`。
- **响度**：mux.sh 固定归一到 −14 LUFS、真峰值 ≤ −1.2 dBTP。档位要别的目标（broadcast −23）时终渲退出码 4，工作版告警（渲染器 v2 的 Node 封装合入后按档位归一）。
- **网页版**：从逐帧中间件（A、C）或原生母版（B）编一次 H.264 High@4.1、crf 19 + maxrate 14 Mbps、GOP 2 秒、faststart，色彩一次性转成 BT.709 有限范围并写全四个标签；长边超过 1920 时缩到 1920；声音直接复制母版的 AAC（不二次编码，响度与母版一致）。
- **AIGC 标识（D11）**：film.json 的 `aigc.contains = true` 时，`label` 步骤用 `tools/compliance/lib/aigc.mjs` 的 `ffmpegMetadataArgs`（制作方「北冥引擎 Beiming Engine」，ProduceID = `<作品 id>@<run-id>`，类别取 `aigc.kinds`，缺省 visual；生成工具取 `aigc.tools`）给 master.mp4、web.mp4（预演是 animatic.mp4）写 mp4 comment；只改容器元数据、码流逐位不变；写完读回核对，run.json 的 `aigc.comment` 记下写入的字符串。播放页另写显式标识。
- **联系表**：只取本次运行的帧（从本次视频按帧号解码，不会混进旧静帧）。概览约 20 格（24 fps × 240 帧时每 12 帧一格，含片尾帧），每个切点另有前 3 后 3 的逐帧条；每格标帧号、时间码、镜头号，切点帧用橙色标出。
- **播放页**：`tools/make_html.py`，标题、画幅、时长、镜头分段与切点来自 film.json 与本次运行；逐帧步进（← →）、跳切点（Shift + ← →）、时间码与帧号。40 MB 以内内嵌成单文件，更大的引用同目录视频（`--embed`）。
- **机器 QA 门**：`node tools/qa/cli.mjs report <运行目录>/master.mp4 --film <作品描述> [--page <页面目录> --size <宽x高>] [--events <运行目录>/events.json] [--profile <档位>] --out <运行目录>/qa --json`：交付规格、画面异常、文字（页面型）、底板、声画同步、已知问题台账。硬门不通过时整个出片退出码 4，结论写进 run.json 的 `technicalAcceptance`（证据 `qa/report.json`，相对运行目录；`technicalAcceptance.film` 记 QA 读的是哪份作品描述）。QA 缺环境退出码 3；参数不被接受（版本不一致）记 not-run 并告警。页面型作品把视口 `--size` 明确交给 QA；film.json 没写 `events` 而页面导出了 `window.EV`（C 路线）时，把运行目录里的 `events.json` 交给声画同步组（QA 原本到作品目录找，编排器把这份导出写进了运行目录）。
- **档位与作品描述**（复核 must 的修正）：机器 QA 有意要求作品描述的画幅、帧率与档位一致，解码帧数等于作品描述的 `frameCount`，文字组按作品描述的画幅开页面（docs/quality/QA-GATE.md §4.1）。所以 `--profile` 换成画幅或帧率与 film.json 不同的档位时（例如横屏作品出 `vertical-1080x1920-30`），编排器在运行目录写 `film.effective.json`：`output` 换成档位的 profile、宽高、帧率、帧数；帧率变了时镜头（首尾相接、最后一镜止于新帧数）、事件、停顿、海报帧、`qa` 的有意区间与豁免帧段按比例换算（与 `tools/new-film.mjs` 的 `rescaleFrames` 同口径），按秒写的不动；`id` 显式写上。QA 的 `--film` 指向它，run.json 的 `filmEffective` 记来源、哈希与改动；作品目录的 film.json 不改。换算后有镜头一帧不剩时出片前就拒绝（退出码 4）。`docs/quality/waivers/<id>.json` 里按帧号写的豁免不随帧率换算。B 路线的档位必须与 film.json 一致（原生运行时按 film.json 出片），不一致时出片前拒绝。
- **改画幅的工作版（`--size`）**：不是交付件。交付 QA 按档位查画幅必然不过，所以不跑，`qa` 步骤记 skipped；编排器照常核对帧数、画幅、帧率与音轨（不符退出码 4），符合时退出码 0，run.json 的技术验收记 `not-run`、规格核对记 `specCheck`、`status` 记 `rendered`（作品描述包合入前记 `blocked`）、`deliverable: false`。不能与 `--final` 同用。《北冥》的 `--4k` 就是这一种。
- **检查顺序**：build 先把用法与契约全部查完（作品描述、页面目录、档位、`--size` / `--final`、步骤名、终渲档位须在 film.json 的 `deliveries` 里），再写审片记录（`--waive`）、判闸门、开运行目录；前面任何一项不过都直接退出，`review/` 不会多出记录，也不建运行目录。`--final` 配没有用户原话的 `--waive` 是用法错误。
- **主产物核对**：完整解码计帧，帧数、画幅、帧率、音轨任一与作品描述不符退出码 4，核对记录写 `checks/output.json`；再记逐帧解码 md5（`frameHashes`，复现时逐帧比对）。

## 5. film.json 里编排器读的字段

兼容 v1（`{route, title, dur, fps, size}`）与 v2（附录 C6）；v2 一律读 `output`，`dur / fps / size` 兼容镜像编排器不再需要。字段级完整校验归作品描述包的 `node engine/production/film.js check`，`film check` 会转调它。

| 字段 | v1 | v2 | 说明 |
|---|---|---|---|
| 路线 | `route` | `route` | a / b / c；旧名 beiming、raea 按别名处理并告警 |
| 片名 | `title` | `title` | 还是 `{{TITLE}}` 占位符时拒绝（那是模版目录） |
| 时间与画幅 | `dur` `fps` `size` | `output.{profile,width,height,fps,frameCount}` | v1 的帧数 = round(dur × fps) |
| 交付档位 | 按画幅帧率对号，对不上记 custom | `output.profile` | `--profile` 覆盖；终渲必须是明确档位（D07）；定义取 `engine/production/profiles.json`，缺时用与 D07 一致的内置表并告警 |
| 镜头表 | `shots[{id,in,out}]` | 同 | 半开区间、首尾相接覆盖整片才拿来标切点，否则告警 |
| 事件表 | `events[{id,frame,shot}]` | 同 | 预演提示音的位置；QA 声画同步按 `events[].audio` 核对 |
| 声音 | 按约定推断（`sound.py` / `mix.py`） | `audio.{mode: script\|wav\|none\|native, script, wav}` | `--audio` 覆盖（none、x.wav、x.py / x.sh / x.mjs）；B 由 `native.audio` 在准备阶段生成 |
| 闸门 | — | `gates.{look,animatic}` | final 永远必审 |
| 页面目录 | — | `page`（相对作品目录）或 `entry`（html，相对路径基准） | 缺省是作品目录；镜像作品是 entry 所在目录 |
| 镜像 | — | `mirror.{paths: "repo", outDir}` | 路径相对仓库根；运行目录在 outDir |
| 海报帧 | `poster`（秒） | `posterFrame`（帧） | 缺省片长 60% 处 |
| 拍点核对 | `cuecheck.{grid,tolMs,silence,quietDb}` | 同 | 写了才跑，超差退出码 4 |
| 原生 | `native.*` | 同 | 原样交给 `engine/native/prepare.mjs` 与 `engine/render/native.mjs` |
| AIGC | — | `aigc.{contains,note,kinds?,tools?}` | 成片隐式标识 + 播放页显式标识（D11） |

声音脚本除了旧约定（写 `<作品>/out/mix.wav`），还能读环境变量 `BEIMING_AUDIO_OUT`（直接写到运行目录，最好）、`BEIMING_FILM`、`BEIMING_RUN`、`BEIMING_EVENTS`、`BEIMING_TIMELINE`、`BEIMING_DUR`、`BEIMING_FPS`、`BEIMING_FRAMES`、`BEIMING_WIDTH`、`BEIMING_HEIGHT`、`BEIMING_PROFILE`；`PYTHON` 指向选中的解释器。

## 6. 运行记录与闸门记录

**run.json**（附录 C8，写之前用 `engine/production/project.js` 的 `validateRenderResult` 按 strict 口径自检）：`schemaVersion`、`kind`（作品描述包的运行类别：`final` 终渲 · `preview` 工作版出片 · `animatic` · `still` 静帧与帧段）、`job`（编排器的子命令类别）、`final`、`status`、`outcome`、`projectId`、`shotId`、`route`、`backend`、`sourceCommit`、`dirty`、`argv`、`rerun`（从仓库根照抄就能重跑的命令）、`tools{node,playwright,browser,ffmpeg,python,raea?}`、`preflight`、`actualDevice`、`actualGraphicsBackend`、`actualEncoder`、`softwareFallback`、`profile`、`expected`、`filmEffective{path,sha256,from,fromSha256,profile,changes}`、`deliverable`、`output{path,sha256,width,height,fps,frames,pixFmt,color,audio}`、`outputs[{path,sha256,kind}]`、`frameHashes`、`timing`、`steps[]`、`technicalAcceptance{status,evidence,report,by,summary,skipped,failed}`、`specCheck`、`creativeAcceptance{status,reviews[],events[],styleComparison[]}`、`gates`、`waivers`、`aigc`、`warnings[]`、`legacyRestored[]`、`repoTouched[]`、`validation`、`error`。

| status | 含义 |
|---|---|
| `passed` | 技术验收通过：build 由机器 QA 门判定 |
| `rendered` | 非交付件（stills、render、animatic，以及 `--size` 改画幅的 build 工作版）跑完：不跑交付 QA，编排器的规格核对记在 `specCheck`（校验器还不认 `rendered` 的版本里：stills、render、animatic 记 `passed`，`--size` 工作版记 `blocked`） |
| `failed` | 运行出错，或 QA 硬门不过 |
| `blocked` | 没能完成技术验收：缺环境、作品被占用、用法错误；或画面已出但 QA 没跑（`--no-qa`、`--to` 提前停）；或记录缺实测字段 |
| `accepted` | 只由 final 闸的用户认可写入（`review approve final`，且技术验收已通过、校验器认可） |

`outcome` 另记编排本身：`complete`（整条链跑完）· `partial`（`--to` 提前停）· `failed` · `interrupted`。

**闸门记录**的格式以作品描述包为准（`engine/production/review.js`；它在仓库里时由它生成、校验、判定，否则用 `lib/gates.mjs` 的同格式实现）：`films/<名>/review/<闸>-<YYYY-MM-DD>[-n].json`，一条记录一个文件，只增不改，随作品源码提交：

```json
{ "schemaVersion": 1, "film": "my-film", "gate": "look", "decision": "approve",
  "reviewer": { "kind": "human", "name": "用户" }, "quote": "这版颜色可以",
  "source": { "kind": "session", "ref": "会话 2026-11-10 第 12 条", "at": "2026-11-10T15:32:00+08:00" },
  "recordedBy": { "kind": "ai", "name": "agent（npm run film -- review）" }, "recordedAt": "2026-11-10T15:33:05+08:00",
  "reviewed": [{ "path": "out/20261110-073300-1a2b3c4d/contact.jpg", "sha256": "…", "kind": "image" }] }
```

- approve / reject / waive 只能由人做（`reviewer.kind = human`），带用户原话与出处；原话是占位符或自评口吻（「代理检查通过」）的记录无效。agent 只能写 `comment`。
- approve 绑定用户看过的文件与 sha256；animatic 的认可冻结镜头表签名，之后切点改了自动失效（`stale`），要把新的预演给用户看；look 的认可冻结风格 id 与版本。
- 每道闸取最后一条有效的人工决定：`approved` / `waived` / `rejected` / `stale` / `missing`。不合格的记录不放行任何闸，`status` 会列出来，仓库规范检查 `film.review-records` 报错。

## 7. 退出码与 --json（附录 C1、C2）

`0` 成功 · `1` 运行失败 · `2` 用法错误 · `3` 环境或依赖缺失（ffmpeg、Python 包、浏览器、RAEA_BIN、软件渲染、QA 缺环境）· `4` 契约 / QA / 闸门不通过 · `5` 作品被占用 · `124` 超时（单步超时或连续无输出的看门狗，已结束整棵进程树）· `130` / `143` 收到 SIGINT / SIGTERM（已结束子进程、还原旧位置、写好 run.json、放锁）。

`--json` 时 stdout 只有一个对象 `{ schemaVersion: 1, ok, exitCode, command, error: {code, message, hint} | null, outputs: [{path, sha256, kind}], runJson, warnings[], data }`，过程日志全部走 stderr。`error.code` 的前缀与退出码对应（`usage.` 2、`env.` 3、`contract.` 4、`busy.` 5、`timeout.` 124、`signal.` 130 / 143、其余 1）。build 的 `outputs` 列出成片、网页版、播放页、联系表、QA 报告与 run.json（仓库相对路径、带 sha256，`tools/remote` 据此取回并核对）；`data` 有 `runId`、`runDir`、`status`、`technicalAcceptance`、`steps`。出错时信息只有一行原因加一行下一步；`BEIMING_DEBUG=1` 时内部错误另打堆栈。

## 8. 环境变量

| 变量 | 作用 |
|---|---|
| `BEIMING_PYTHON` / `BEIMING_PY` / `PYTHON` | 装了 `requirements.txt` 的 Python（声音、联系表、播放页）；不设时按 `tools/env/py.mjs` 的顺序找（`.venv` → python3 → python → `py -3.12`），Windows 上没有 python3 也找得到 |
| `FFMPEG` / `FFPROBE` | 指定 FFmpeg（≥ 7，带 libx264、aac、ebur128）；与 `tools/env/lib/ffmpeg.mjs` 同口径 |
| `BEIMING_SH` | 过渡期的 POSIX sh（`mux.sh`、`.sh` 声音脚本）；Windows 上自动找 Git for Windows 的 `bin\sh.exe` |
| `BEIMING_ANGLE` / `BEIMING_CHROME` / `BEIMING_READY_TIMEOUT` / `BEIMING_FRAME_TIMEOUT` | 页面渲染器的 GPU 后端、浏览器、等就绪与单帧上限（见 `engine/render/page.mjs`） |
| `RAEA_BIN` | B 路线原生运行时（不随仓库分发，D03）；没设时 B 的命令退出码 3 并给出设法 |
| `FILM_QA_CLI` | 机器 QA 门的实现路径（默认 `tools/qa/cli.mjs`；测试用 `tests/film/fixtures/qa-stub.mjs`） |
| `FILM_REVIEW_LIB=builtin` | 强制用内置的闸门记录实现（测试用） |

## 9. 跨平台

- macOS（Apple Silicon，Metal）：全部命令实测（单元、契约、端到端 A / B / C、真 QA 的竖屏口径）。
- Linux：设计上全部命令可用（只用 Node、ffmpeg、Python 与无头 Chrome，不依赖 shell 语法），**尚未实测**，交给 P09 的 CI（ubuntu 作业）跑 `node --test tests/film/*.test.mjs` 与 `node tests/film/e2e-run.mjs`。
- Windows（PowerShell）：**尚未实测**（交给 P09 的 CI）。设计上编排器本身、页面渲染、联系表、播放页、QA 都不经 shell；**音画封装 `engine/render/mux.sh` 与 `.sh` 声音脚本（如《北冥》的 `audio/build.sh`）目前仍要 POSIX sh**，预检会说清；Git for Windows 装在默认位置时自动找到，不用改 PATH。渲染器 v2 的 Node 封装合入后去掉这个依赖。PowerShell 设环境变量：`$env:PYTHON="C:\路径\python.exe"; npm run film -- build films\my-film`。
- 子进程整棵树清理：POSIX 上按进程组与父子关系结束（含 Playwright 自建进程组的浏览器），Windows 上 `taskkill /T /F`。子进程的 TMPDIR 指到运行目录（`work/tmp`，结束整体删除），浏览器配置目录也在其中。
- B 路线的作品目录必须**真实位于**仓库的 `films/` 下：原生运行时按真实路径打包 `film.tsx`，指向仓库外的链接会找不到 `../../engine/native`，编排器提前以用法错误拒绝。

## 10. 与其它工作包的接口

| 包 | 用法 |
|---|---|
| 命令约定库 `tools/lib/cli.mjs`、`cli.py` | 全部子命令的参数、帮助、信封、退出码；`lib/exit.mjs` 的 FilmError 继承 CliError；`contact_sheet.py`、`make_html.py` 用 `cli.py` 的严格解析器 |
| 环境 `tools/env/` | `preflight.mjs` 开工前预检；`lib/python.mjs` 找 Python；`lib/ffmpeg.mjs` 的 `ffmpegBins`；`lib/sh.mjs` 找 sh |
| 机器 QA `tools/qa/cli.mjs` | `report` 子命令（§4）；`film qa` 补跑 |
| 合规 `tools/compliance/lib/aigc.mjs` | `ffmpegMetadataArgs` 写隐式标识 |
| 作品描述包 `engine/production/` | `film.js check`（film check）；`review.js` 的 buildReview / validateReview / writeReview / readReviews / gateVerdict（闸门记录）；`project.js` 的 validateRenderResult（run.json 自检）；`profiles.json`（档位） |
| 渲染器 `engine/render/` | 读 `video.mjs --help` 探测能力（认 `--gpu`、`--profile` 时传）；编排层兜底超时、看门狗、进程树清理、`.segs-*` 清扫；渲染器 v2 的局部重渲与 Node 封装合入后切换（见 §13） |
| 路线模版 | 模版的 film.json 能被 `parseFilm` 读懂（规范检查 `film.templates` 把关）；模版画面能否过真 QA 由各路线包负责 |

## 11. 《北冥》样片

`npm run beiming:build -- [--4k] [--no-audio] [--workers N] [--json]`（= `node tools/film/beiming.mjs`；`sh build.sh` 是参数相同的 POSIX 兼容壳）= `film build films/beiming-10s --page . --out-root out/beiming --profile beiming-1040p24 --audio audio/build.sh`，再按旧文件名放到 `out/`：`video[_4k].mp4`、`beiming[_4k].mp4`、`beiming_web.mp4`、`beiming.html`、`contact_sheet.jpg`、`mix.wav`。实测新旧两条路出的 `out/video.mp4`、`out/mix.wav` 字节完全相同，`out/beiming.mp4` 的画面与声音逐帧相同、只多了 D11 的 AIGC comment。机器 QA 门对冻结的样片报出已知问题（文字停留、对比度、两个配乐起音，见 `docs/quality/known-issues.json`）时退出码 4，旧文件名照样放好；这些问题的豁免要用户批准（`docs/quality/waivers/beiming-10s.json`）。

## 12. 测试

```sh
node --test tests/film/lib.test.mjs tests/film/cli.test.mjs tests/film/rules.test.mjs   # 秒级：参数、运行目录、缓存、档位、闸门记录、命令契约、规范检查
node tests/film/e2e-run.mjs                                                            # 真渲染：A / C（设了 RAEA_BIN 再加 B）按 G1 命令出片、复用、帧段缓存、终渲与认可、中断清理
node tools/repo-check.mjs --only film                                                  # 出片相关的仓库规范检查
```

`npm test -- --only film` 走测试总入口（`tests/film/suite.json` 声明时限）。端到端测试的临时作品放在 `FILM_TEST_ROOT`（默认系统临时目录），`films/` 里只留链接（B 例外：真实目录，测完删除）；`FILM_TEST_KEEP=1` 保留产物；`FILM_E2E_REAL_QA=1` 用真 QA 门（默认用测试替身，只验编排器的接线）。

## 13. 已知限制

- `render` 现在是逐帧静帧（still.mjs / native.mjs --at）加帧缓存；整片按镜头局部重渲属于渲染器 v2（`video.mjs --frames/--shot`、`shots.mjs`）。
- 原生静帧（`native.mjs --at`）不保存运行时日志，记不到实际设备：这类运行的 status 是 blocked（look 闸照样能审，因为审的是画面）。
- 软件渲染判定只看 WebGL 渲染器字符串；GPU 占用、共享工作站槽位、显存预算属于渲染器 v2。
