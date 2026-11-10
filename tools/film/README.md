# 出片编排命令 · tools/film

> 一条 Node 命令依据作品描述 `film.json` 出片：三条路线、三个平台同一套参数、同一套退出码与运行记录。新作品一律用它出片；
> 《北冥》10 秒样片的 `sh build.sh` 也只是它的兼容壳。入口：`npm run film -- <子命令>`，等价 `node tools/film/cli.mjs <子命令>`。

## 1. 做一部片的顺序

三道闸 look → animatic → final（决定 D08）。每道闸都要用户看过、按原话记录；**agent 不得自己批准，也不得替用户写原话**。

```sh
npm run new -- c my-film --title 晨渡                 # 1 新建（转调 tools/new-film.mjs）；也可 npm run film -- new c my-film
npm run film -- check films/my-film                   # 2 只读检查：作品描述、页面契约 / 原生预检、档位与镜头表
npm run film -- stills films/my-film                  # 3 风格关键帧 + 联系表 → 给用户看
npm run film -- review approve look films/my-film --quote "<用户原话>" --source "<会话 / 日期 / 第几条>" --reviewer "<审阅人>"
npm run film -- animatic films/my-film                # 4 半分辨率动态预演（时长、切点同正片）→ 给用户看
npm run film -- review approve animatic films/my-film --quote "…" --source "…" --reviewer "…"
npm run film -- build films/my-film --final           # 5 终渲：先查闸门，再整条出片链 + 机器 QA 门
npm run film -- review approve final films/my-film --quote "…" --source "…" --reviewer "…"   # 之后 run.json 才是 accepted
npm run film -- status films/my-film                  # 任何时候：闸门、最近运行、下一步
```

- 工作版（不加 `--final`）随时可出，不查闸门；终渲（`build --final`、`render --final`）没有 look、animatic 的用户通过或**带用户原话的**豁免时退出码 4，一帧不渲、不建运行目录。
- 用户明确说不用看时记豁免：`npm run film -- review waive look,animatic films/my-film --reason "<理由>" --quote "<用户原话>" --source "<出处>"`；也可在出片时一并记：`build … --waive look,animatic --reason … --quote … --source …`。没有 `--quote/--source` 的豁免是内部豁免，只用于自检（例如 G1），**不放行终渲**。final 闸不能豁免。
- agent 自己的审片结论用 `review note`（记为 reviewerKind = ai），留证据、不放行任何闸。
- 「已交付 / 用户已认可」只能在最近一次终渲的 run.json 是 `accepted` 时说；`status` 会如实分三件事写：已输出 / 技术检查 / 人工认可。

## 2. 子命令

| 子命令 | 做什么 | 产物（都在运行目录里） |
|---|---|---|
| `new <a\|b\|c> <名字> [--title]` | 转调 `tools/new-film.mjs`，成功后给出 film 的下一步命令 | `films/<名字>/` |
| `check <作品>` | 只读：P05 校验器（`engine/production/film.js check`）、页面契约探测或原生预检、档位、切点、闸门要求 | 无（不建运行目录） |
| `stills <作品> [--frames … \| --times …]` | 风格关键帧：缺省每个镜头取中间一帧，单镜头取片长 1/6、1/2、5/6 | `stills/` `frames.json` `contact.jpg` |
| `animatic <作品>` | 半分辨率预演：页面加 `previs=1`；临时声用作品混音，没有声音就按事件与切点生成提示音；B 用原生 `--quality draft` | `animatic.mp4` `contact.jpg` `player.html` |
| `build <作品> [--final]` | 整条出片链（§4）；`--from` / `--to` 只跑一段；输入没变的步骤复用缓存 | `master.mp4` `web.mp4` `player.html` `contact.jpg` `poster.jpg` `qa/report.json` |
| `mix <作品>` | 只做声音：A、C 跑到声画拍点核对（`build --to cuecheck`），B 跑原生素材准备（`--to prepare`） | `audio/mix.wav` `audio/stems/` `audio/cuecheck.txt` |
| `assemble <作品>` | 画面与声音复用缓存，只重做封装及之后（A、C `build --from mux`，B `--from web`） | 同 build |
| `render <作品> --frames a:b \| --shot S [--clip] [--final]` | 只渲指定帧段或镜头，逐帧缓存（同一命令第二次 0 帧重渲）；`--final` 先查闸门，不给帧段时等于 `build --final` | `frames/` `frames.json` `contact.jpg`（`--clip` 另有 `range.mp4`） |
| `qa <作品> [--run <id>]` | 对已出的片子补跑机器 QA 门（P07），回写那次的 run.json | `qa/report.json` |
| `review approve\|reject\|waive\|note\|status …` | 闸门审阅记录（§6）；`approve …` 是 `review approve …` 的简写 | `films/<名>/review/*.json`（随作品源码提交） |
| `status <作品>` | 闸门、最近各类运行、下一步命令 | 无 |

每个子命令都有 `--help`（打印到 stdout、退出码 0、不建目录、不启动浏览器）。帧号从 0 起，`a:b` 是半开区间（含 a 不含 b），与镜头表同口径。

## 3. 运行目录（附录 C4）

```text
films/<名>/out/
  <run-id>/                 一次运行；run-id = UTC 的 YYYYMMDD-HHMMSS-<提交前 8 位>[-dirty]（同一秒再加 -2…）
    master.mp4 web.mp4 player.html contact.jpg poster.jpg run.json
    qa/report.json          机器 QA 门的报告（附录 C8）
    checks/output.json      编排器对主产物的核对（完整解码计帧、画幅、帧率、音轨）
    events.json timeline.json audio/mix.wav audio/stems/   页面导出的事件表、混音（A / C）
    native/ technical.json  B 的原生清单与原生入口的核对
    logs/<步骤>.log         每一步的完整输出
    work/                   中间件（work/video.mp4 是逐帧中间件）；work/tmp 是子进程的 TMPDIR，运行结束删除
  latest                    指针文件：最近一次完整跑完的 build（不是符号链接，兼容 Windows）
  latest-<stills|animatic|render>
  cache/<步骤>/<输入哈希>/  步骤缓存（硬链接，不占双份空间；随时可删）
  .lock                     作品锁：同一作品同一时间只允许一次运行，另一次退出码 5
```

《北冥》样片的运行目录是 `out/beiming/<run-id>/`（`build.sh` 传 `--out-root out/beiming`）。产物只写进运行目录：现有脚本写死的旧位置（作品目录的 `events.json`、`out/mix.wav`、原生入口的 `out/native.mp4` 等）由编排器临时登记、运行结束（成功、失败、被中断都一样）还原，run.json 的 `legacyRestored` 记录还原了什么。运行前后各取一次 `git status`，作品目录以外多出的改动写进警告与 `repoTouched`（只报告、不还原）。

## 4. 出片链

| 路线 | 步骤（`--from` / `--to` 用这些名字） | 调用的现有工具（编排器不重写它们） |
|---|---|---|
| A、C（页面型） | `probe → mix → cuecheck → video → mux → web → poster → contact → player → qa` | `engine/render/events.mjs`（页面契约 + 事件表）、film.json 的声音脚本或 wav、`python -m engine.audio.cuecheck`、`engine/render/video.mjs`、`engine/render/mux.sh` |
| B（原生） | `prepare → preflight → native → web → poster → contact → player → qa` | `engine/native/prepare.mjs`、`engine/render/native.mjs --check-only`、`native.mjs --mux copy --out …` |
| 预演 | A、C：`probe → mix → video → preview → contact → player`；B：`prepare → preflight → native(draft) → contact → player` | 同上 |

- 页面型步骤定义在 `engine/render/build.mjs`，B 的在 `tools/film/lib/native-steps.mjs`，三条路线共用的交付步骤（网页版、海报、联系表、播放页、QA）在 `tools/film/lib/deliver.mjs`。
- **缓存**：带输入哈希的步骤（mix、cuecheck、video、mux、web、prepare、native）输入没变就复用。video 的键包括作品目录、页面会 import 的 engine 层（core、form、shade、stage、look、paint、overlay、assets）、fonts、assets、src、渲染器文件、传给 video.mjs 的参数、Playwright 与浏览器版本、`BEIMING_ANGLE`、平台。`--no-cache` 全部重跑；`--from X` 从 X 起强制重跑，X 之前带哈希的步骤必须能复用（否则用法错误并说明是哪一步）。
- **页面帧率**：video.mjs 按 `window.FPS`（没声明按 24）量化一拍二 / 一拍三。与档位帧率不同时，终渲退出码 4；工作版告警并加 `--any-fps`。
- **软件渲染**：WebGL 落到 SwiftShader / llvmpipe / WARP 时，`--gpu required`（默认）退出码 3；`--gpu any` 或 `software-ok`（CI 冒烟）放行并在 run.json 记 `softwareFallback`。
- **响度**：mux.sh 固定归一到 −14 LUFS、真峰值 ≤ −1.2 dBTP。档位要别的目标（broadcast −23）时终渲退出码 4，工作版告警。
- **网页版**：从逐帧中间件（A、C）或原生母版（B）编一次 H.264 High@4.1、crf 19 + maxrate 14 Mbps、GOP 2 秒、faststart，色彩一次性转成 BT.709 有限范围并写全四个标签；长边超过 1920 时缩到 1920；声音直接复制母版的 AAC（不做 AAC→AAC 二次编码，响度与母版一致）。
- **联系表**：只取本次运行的帧（从本次视频按帧号解码，不会混进旧静帧）。概览约 20 格（24 fps × 240 帧时每 12 帧一格，含片尾帧），每个切点另有前 3 后 3 的逐帧条；每格标帧号、时间码、镜头号，切点帧用橙色标出。
- **播放页**：`tools/make_html.py`，标题、画幅、时长、镜头分段与切点来自 film.json 与本次运行；逐帧步进（← →）、跳切点（Shift + ← →）、时间码与帧号；film.json 写了 `aigc.contains = true` 时左上角写 AI 生成标识（D11）。40 MB 以内内嵌成单文件，更大的引用同目录视频（`--embed`）。
- **主产物核对**：完整解码计帧，帧数、画幅、帧率、音轨任一与作品描述不符退出码 4，核对记录写 `checks/output.json`；再记逐帧解码 md5（`frameHashes`，复现时逐帧比对）。

## 5. film.json 里编排器读的字段

兼容 v1（模版现状）与 v2（附录 C6）；字段级完整校验归 P05 的 `node engine/production/film.js check`，`film check` 会转调它。

| 字段 | v1 | v2 | 说明 |
|---|---|---|---|
| 路线 | `route` | `route` | a / b / c；旧名 beiming、raea 按别名处理并告警 |
| 片名 | `title` | `title` | 还是 `{{TITLE}}` 占位符时拒绝（那是模版目录） |
| 时间与画幅 | `dur` `fps` `size` | `output.{profile,width,height,fps,frameCount}` | v1 的帧数 = round(dur × fps) |
| 交付档位 | 按画幅帧率对号，对不上记 custom | `output.profile` | `--profile` 覆盖；终渲必须是明确档位（D07）；定义取 `engine/production/profiles.json`（P05），缺时用与 D07 一致的内置表并告警 |
| 镜头表 | `shots[{id,in,out}]` | 同 | 半开区间、首尾相接覆盖整片才拿来标切点，否则告警 |
| 事件表 | `events[{id,frame,shot}]` | 同 | 预演提示音的位置；final 闸「用户确认看到的事件」只认这里的 id |
| 声音 | 按约定推断（`sound.py` / `mix.py`） | `audio.{mode: script\|wav\|none, script, wav}` | `--audio` 覆盖（none、x.wav、x.py / x.sh / x.mjs）；B 由 `native.audio` 在准备阶段生成 |
| 闸门 | — | `gates.{look,animatic}`：required \| optional | final 永远必审 |
| 页面目录 | — | `page`（相对作品目录） | 缺省是作品目录；《北冥》样片是 `"../.."`（页面在仓库根） |
| 海报帧 | `poster`（秒） | `posterFrame`（帧） | 缺省片长 60% 处 |
| 拍点核对 | `cuecheck.{grid,tolMs,silence,quietDb}` | 同 | 写了才跑，超差退出码 4 |
| 原生 | `native.*` | 同 | 原样交给 `engine/native/prepare.mjs` 与 `engine/render/native.mjs` |
| AIGC | — | `aigc.{contains,note}` | 播放页写显式标识（D11） |

声音脚本除了旧约定（写 `<作品>/out/mix.wav`），还能读环境变量 `BEIMING_AUDIO_OUT`（直接写到运行目录，最好）、`BEIMING_FILM`、`BEIMING_RUN`、`BEIMING_EVENTS`、`BEIMING_TIMELINE`、`BEIMING_DUR`、`BEIMING_FPS`、`BEIMING_FRAMES`、`BEIMING_WIDTH`、`BEIMING_HEIGHT`、`BEIMING_PROFILE`。

## 6. 运行记录与闸门记录

**run.json**（附录 C8，兼容 `engine/production/project.js` 的 `validateRenderResult`；写之前先用它自检）：`schemaVersion`、`kind`、`final`、`status`、`outcome`、`projectId`、`shotId`、`route`、`backend`、`sourceCommit`、`dirty`、`argv`、`rerun`（从仓库根照抄就能重跑的命令）、`tools{node,playwright,browser,ffmpeg,python,raea?}`、`actualDevice`、`actualGraphicsBackend`、`actualEncoder`（从码流里 x264 自报的参数读出；B 的运行时日志不报编码器名时按码流档次级别如实记录）、`softwareFallback`、`profile`、`expected`、`output`、`outputs[{path,sha256,kind}]`、`frameHashes`、`timing`、`steps[]`、`technicalAcceptance{status,evidence[],by}`、`creativeAcceptance{status,reviews[],events[],styleComparison[]}`、`gates`、`warnings[]`、`legacyRestored[]`、`repoTouched[]`、`validation`、`error`。

| status | 含义 |
|---|---|
| `passed` | 技术验收通过：build 由机器 QA 门判定；stills / render / animatic 不是交付件，由编排器核对规格（帧数、画幅、帧率、音轨）并留证据 |
| `failed` | 运行出错，或 QA 硬门不过 |
| `blocked` | 没能完成技术验收：缺环境、作品被占用、用法错误；或画面已出但 QA 没跑（P07 未提供、`--no-qa`、`--to` 提前停）；或记录缺实测字段 |
| `accepted` | 只由 final 闸的用户认可写入（`review approve final`，且技术验收已通过、校验器认可） |

`outcome` 另记编排本身：`complete`（整条链跑完）· `partial`（`--to` 提前停）· `failed` · `interrupted`。

**闸门记录**（随作品源码提交，它们是审片证据，不是产物）：`films/<名>/review/<闸>-<UTC 时间>.json` 一次审阅 `{ gate, decision: approved|changes-requested|agent-note, reviewerKind: human|ai, reviewer, quote, source, run{id,kind,dir}, files[{path,sha256}], issues[{frame|shot, note}], recordedAt, recordedBy }`；`review/waivers.json` 豁免台账 `{ waivers: [{ gate, reason, quote, source, kind: user|internal, recordedAt, recordedBy }] }`。只有 reviewerKind = human 且写明审阅人、原话、出处的记录算数；不合格的记录不放行任何闸，`status` 会列出来，仓库规范检查 `film.review-records` 报错。每道闸取时间最晚的一条有效记录定状态。审阅会绑定被看文件的 sha256，事后能核对看的是哪一版。

## 7. 退出码与 --json（附录 C1、C2）

`0` 成功 · `1` 运行失败 · `2` 用法错误 · `3` 环境或依赖缺失（ffmpeg、Python 包、RAEA_BIN、软件渲染、QA 门不可用）· `4` 契约 / QA / 闸门不通过 · `5` 作品被占用 · `124` 超时（单步超时或连续无输出的看门狗，已结束整棵进程树）· `130` / `143` 收到 SIGINT / SIGTERM（已结束子进程、还原旧位置、写好 run.json、放锁）。

`--json` 时 stdout 只有一个对象 `{ ok, exitCode, command, error: {code, message, hint} | null, outputs: [{path, sha256, kind}], runJson, warnings[], …数据 }`，过程日志全部走 stderr。出错时信息只有一行原因加一行下一步；`FILM_DEBUG=1` 时内部错误另打堆栈。

## 8. 环境变量

| 变量 | 作用 |
|---|---|
| `PYTHON` | 装了 `requirements.txt` 的 Python（声音、联系表、播放页）；缺省 macOS / Linux `python3`、Windows `python`。出片前预检缺什么一次说清（退出码 3） |
| `FFMPEG` / `FFPROBE` | 指定 FFmpeg（≥ 7，带 libx264、aac、ebur128） |
| `BEIMING_ANGLE` / `BEIMING_CHROME` / `BEIMING_READY_TIMEOUT` / `BEIMING_FRAME_TIMEOUT` | 页面渲染器的 GPU 后端、浏览器、等就绪与单帧上限（见 `engine/render/page.mjs`） |
| `RAEA_BIN` | B 路线原生运行时（不随仓库分发，D03）；没设时 B 的命令退出码 3 并给出设法 |
| `FILM_QA_CLI` | 机器 QA 门的实现路径（默认 `tools/qa/cli.mjs`；测试用 `tests/film/fixtures/qa-stub.mjs`） |

## 9. 跨平台

- macOS、Linux：全部命令可用。
- Windows（PowerShell）：编排器本身、页面渲染、联系表、播放页、QA 都不经 shell；**音画封装 `engine/render/mux.sh` 与 `.sh` 声音脚本（如《北冥》的 `audio/build.sh`）目前仍要 POSIX sh**（Git Bash 的 sh 放进 PATH），预检会说清。P04·R3 的 `mux.mjs` 合入后去掉这个依赖。PowerShell 设环境变量：`$env:PYTHON="C:\路径\python.exe"; npm run film -- build films\my-film`。
- 子进程整棵树清理：POSIX 上按进程组与父子关系结束（含 Playwright 自建进程组的浏览器），Windows 上 `taskkill /T /F`。
- B 路线的作品目录必须**真实位于**仓库的 `films/` 下：原生运行时按真实路径打包 `film.tsx`，指向仓库外的链接会找不到 `../../engine/native`（实测），编排器提前以用法错误拒绝。

## 10. 与其它工作包的接口与替换点

| 包 | 现在 | 对方合入后 |
|---|---|---|
| P02 命令约定库 `tools/lib/cli.mjs` | 本目录 `lib/exit.mjs`、`lib/args.mjs`、`lib/output.mjs` 按附录 C1、C2 自带一份 | 改为从 `tools/lib/cli.mjs` 转出同名常量，行为不变 |
| P04 渲染器 v2 | 读 `engine/render/video.mjs --help` 的用法文字探测能力：认 `--gpu`、`--profile` 时自动传；编排层兜底超时、看门狗、进程树清理、`.segs-*` 清扫 | `--frames/--shots/--resume` 合入后 `render` 改为整片按镜头局部重渲；`mux.mjs` 合入后去掉 sh 依赖、按档位归一响度；渲染器自己的 run.json 并入本 run.json 的 `steps` |
| P05 作品描述与闸门库 | `check` 转调 `engine/production/film.js check`（缺时退出码 3 并说明）；档位优先读 `engine/production/profiles.json`；闸门库 `engine/production/review.js` 导出 `REVIEW_API_VERSION = 1` 与通用写入口 `recordReview(filmDir, rec)`、`recordWaivers(filmDir, list)` 时由它写记录，否则用本目录 `lib/gates.mjs`（文件格式见 §6，与 P05·M1 的描述一致）；读记录、判闸门一律用 `lib/gates.mjs`（只认合格记录）；run.json 自检用 `project.js` 的 `validateRenderResult` | 改用 `node engine/production/film.js validate-result` 同口径自检 |
| P07 机器 QA 门 | `node tools/qa/cli.mjs delivery <成片> --film <作品>/film.json [--profile <档位>] --json`；stdout 可以是附录 C8 的报告本身，也可以是 C2 信封（outputs 里 kind 含 qa / report 的一项指向报告）；退出码 0 通过、4 硬门不过、2 参数不匹配（按未运行处理并告警）、3 缺环境 | — |
| P10 环境 | Python 用 `PYTHON` 或 `python3`；出片前自己预检依赖 | 改用 `tools/env/py.mjs` 选解释器 |
| P11 / P12 / P14 / P15 | 声音脚本按旧约定或 `BEIMING_AUDIO_OUT`；模版的 film.json 能被 `parseFilm` 读懂（规范检查 `film.templates` 把关） | 模版接线（v2 film.json、`window.FPS`、`TEXTS`）由各路线包完成 |

## 11. 《北冥》样片

`sh build.sh [--4k] [--no-audio]`（Windows：`node tools/film/beiming.mjs`）= `film build films/beiming-10s --page . --out-root out/beiming --profile beiming-1040p24 --audio audio/build.sh`，再按旧文件名硬链接到 `out/`：`video[_4k].mp4`、`beiming[_4k].mp4`、`beiming_web.mp4`、`beiming.html`、`contact_sheet.jpg`、`mix.wav`。实测新旧两条路出的 `out/video.mp4`、`out/beiming.mp4`、`out/mix.wav` 字节完全相同。旧版另有的 `out/stills/s_*.jpg` 不再单独出（联系表直接从本次成片按 0.5 秒取帧）；网页版改为上面 §4 的参数（旧版是从成片两遍 9 Mbps 转码）。

## 12. 测试

```sh
node --test tests/film/lib.test.mjs tests/film/cli.test.mjs        # 秒级：参数、运行目录、缓存、档位、闸门、命令契约
FILM_E2E=1 PYTHON=<python> node --test tests/film/e2e.test.mjs     # 真渲染：A / C（设了 RAEA_BIN 再加 B）按 G1 命令出片、复用、帧段缓存、中断清理
node tools/repo-check/rules/film/index.mjs                         # 出片相关的仓库规范检查（产物不入库、闸门记录、作品与模版能出片、入口统一）
```

临时作品放在 `FILM_TEST_ROOT`（默认系统临时目录），`films/` 里只留链接（B 例外：真实目录，测完删除）；`FILM_TEST_KEEP=1` 保留产物。

## 13. 已知限制

- `render` 现在是逐帧静帧（still.mjs / native.mjs --at）加帧缓存；整片按镜头局部重渲属于渲染器 v2（P04·R4）。
- 原生静帧（`native.mjs --at`）不保存运行时日志，记不到实际设备：这类运行的 status 是 blocked（look 闸照样能审，因为审的是画面）。
- 软件渲染判定只看 WebGL 渲染器字符串；GPU 占用、共享工作站槽位、显存预算属于 P04·R2。
