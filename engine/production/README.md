# engine/production · 作品描述、时间轴、状态与创作闸门

一部作品只有一份描述：`films/<名>/film.json`（v2）。镜头表与事件表是唯一的时间源，整数帧是唯一的时间单位，秒只由 帧 / fps 推出；交付规格只引用档位；作品走到哪一步，由审片记录与运行记录现算。页面、声音脚本、QA、出片编排都从这里读，不各写一份时间。

| 文件 | 做什么 |
|---|---|
| `film.js` | film.json v2 的校验、v1 升级、改切点、QA 期望值、与 ProjectSpec 互转；命令行入口 |
| `film.schema.json` | film.json v2 的 JSON Schema（给编辑器与 agent 看结构；规则以 `film.js` 为准） |
| `profiles.json` | 交付档位（决策 D07）与 QA 检测阈值 |
| `timeline.js` | 帧 ↔ 秒、镜头局部帧、切点、改切点（ripple / roll）、三种节拍写法、签名；纯函数，浏览器也能用 |
| `review.js` | 审片记录 `films/<名>/review/<闸>-<日期>.json` 的生成、校验、读取与每道闸的结论 |
| `state.js` | 状态机 draft → look-approved → animatic-approved → rendered → qa-passed → accepted；闸门判定；运行记录与 QA 报告校验 |
| `project.js` | ProjectSpec 与 RenderResult 的契约校验（T01）；路线取自注册表；RenderResult 的人工评审与 QA 证据规则 |
| `routes.js` | 路线注册表（`routes/routes.json`，缺省内置 a / b / c） |
| `vocab.js` | 审片、评分与问题条目的取值表（叶子模块） |
| `io.js` | 原子写、独占新建、sha256、JSON 读取与稳定排版 |
| `cli.js` | `film.js` 的命令行实现 |

共享资产（造型、角色、底板、字体）的 id 与 sha256 在 `engine/assets/manifest.js`；闸门与审片的操作说明在 `docs/creative-review/`。

## 1. film.json v2

```json
{
  "schemaVersion": 2, "id": "chendu", "title": "晨渡", "route": "a", "backend": "three",
  "output": { "profile": "web-1080p24", "width": 1920, "height": 1080, "fps": 24, "frameCount": 192 },
  "shots": [
    { "id": "S1", "in": 0, "out": 96, "module": "shots/s1/shot.js", "evaluation": "absolute", "tracks": [{ "id": "kun", "step": 3 }], "actorClockOrigin": { "kun": 0 } },
    { "id": "S2", "in": 96, "out": 192, "module": "shots/s2/shot.js", "evaluation": "absolute" }
  ],
  "events": [ { "id": "kun.rise", "frame": 130, "shot": "S2", "audio": "kun_breath", "visual": "鲲背出水" } ],
  "audio": { "mode": "script", "script": "audio/sound.py" },
  "deliveries": ["web-1080p24"],
  "style": { "id": "beiming-original", "version": 1, "baseline": "../../media/shot_7.6.jpg" },
  "assets": ["model:kun@v1", "plate:sky_dawn", "local:assets/far_hills.png"],
  "credits": [ { "what": "字体子集 Noto Sans SC", "owner": "Adobe / Google", "license": "OFL-1.1", "source": "fonts/LICENSE.md" } ],
  "aigc": { "contains": true, "kinds": ["visual"], "note": "远山底板由图像模型生成后手工整理" },
  "gates": { "look": "required", "animatic": "required", "final": "required" },
  "qa": { "intentional": [ { "kind": "black", "from": 186, "to": 192, "reason": "片尾黑场" } ] }
}
```

| 字段 | 规则 |
|---|---|
| `route` / `backend` | 注册表 id：`a`（`three`）、`b`（`native`）、`c`（`canvas` / `svg` / `dom` / `three` / `webgl`）。别名 beiming、raea、a-webgl… 能读，但提示改成规范值 |
| `output` | `profile` 必填，宽、高、帧率必须等于档位；`frameCount` 是时长的唯一来源。新作品默认 `web-1080p24`；`beiming-1040p24` 只给《北冥》样片 |
| `shots` | 半开区间 `[in, out)`，首尾相接，正好覆盖 `[0, frameCount)`；切点要落在本镜各轨道一拍 n 的公倍数帧（`tracks[].step`、`actorClockOrigin`），否则提示 `cut-off-step` |
| `events` | `frame` 是结果帧（看见或听见的那一帧），必须落在 `shot` 里；`end` 不含；写了 `beat` 就必须与 `frame` 同源（第 b 拍所在帧取 floor）；`sync: false` 是铺底类 |
| `holds` | 有意的静帧与黑场，写原因；QA 据此豁免 |
| `timeline` | 节拍三种写法只能用一种：`sections`（按 BPM 分段，`start` 为整数帧）、`beats`（逐拍帧表）、`bars`（小节数组，每小节逐拍帧数）。`drive: "beat"` 时必填 |
| `audio` | `mode`：`script`（声音脚本）、`wav`（现成混音）、`none`、`native`（B 路线）。`targetLUFS` 省略时取档位值 |
| `deliveries` | 档位 id；帧率与画幅比必须与渲染档相同（换帧率、换画幅要另一份描述） |
| `style` | A 路线必填（含视觉基准）；look 认可冻结 id 与 version |
| `assets` | 资产 id，按 `engine/assets/manifest.js` 的注册表核对存在与哈希；作品自带的文件写 `local:<相对路径>` |
| `credits` / `aigc` | 必填：署名与许可（没有写 `[]`）；是否含 AI 生成内容（决策 D11） |
| `gates` | 只能全开；跳过某一关要在 `review/` 记录用户原话的豁免 |
| `native` / `cuecheck` | B 路线的原生段；页面型路线（A / C）的拍点核对段 |
| `mirror` | 只给描述冻结样片的镜像作品（`films/beiming-10s`）：路径相对仓库根，`frozen: true` 时不许写回切点 |

不允许出现没有消费者的时间字段：`poster`、`dur`、`duration`、`t`、`t0`、`start`、`at`、`inFrame` 之类写在白名单之外就判错（海报写 `posterFrame`，时长由 `frameCount` 推出）。未知字段只提示。完整字段见 `film.schema.json`。

**v1 兼容**：没有 `schemaVersion` 的 v1 记录 `{ route, title, dur, fps, size, native?, poster?, cuecheck? }` 自动升级读取（`frameCount = round(dur × fps)`，整片一个镜头），并提示迁移：`node engine/production/film.js upgrade <作品> --write`。v2 里可以暂留 `dur` / `fps` / `size` 作兼容镜像（给还没改读 film.js 的旧工具），但必须与 `output` 一致。

## 2. 时间

- 帧 ↔ 秒：`frameToSeconds(f, fps)`；`secondsToFrame(t, fps, mode)` 的 `mode` 写明取整：`floor`（t 所在的那一帧：声音落点、画面先到）、`ceil`（t ≥ T 的第一帧：阈值事件「从 T 起出现」）、`round`、`exact`（不落整帧就抛错）。
- 镜头：`shotAt(film, f)`、`localFrame(film, f)` → `{ shot, local }`、`globalFrame(film, id, local)`、`cutList(film)`；给 `engine/stage/film.js` 的 `run({ shots })` 用 `stageShots(film, byId)`。
- 改切点：`node engine/production/film.js retime <作品> --shot <id> --out <帧> [--mode ripple|roll] [--write]`。
  - `ripple`：本镜之后的镜头、事件、停顿、海报帧与角色时钟起点整体平移，总帧数随之变；节拍主导的片子拒绝 ripple。
  - `roll`：只挪本镜与下一镜之间的切点，总帧数不变。
  - 贴着切点的事件跟着切点走：本镜里 `end` 等于旧出点的（整镜铺底）改到新出点；roll 时下一镜落在旧切点上的事件与从切点起算的角色时钟改到新切点。会让事件落到镜头外的改动一律拒绝（exit 4），不替你删改。
- 签名：`timingSignature`（切点）、`eventsSignature`（事件）给闸门判断「认可之后改没改」；`shotSignature(film, id)` 与镜头在片中的位置无关（只平移不改内容的镜头不重渲），给镜头级缓存键。
- 节拍：`beatGrid(timeline, { fps, frameCount })` 把三种写法统一成拍点帧表；`frameOfBeat`、`beatAt`、`beatOf`、`offGrid`（不落整帧的拍点）。与 `engine/core/tempo.js` 同一公式：页面读 film.json 的 `timeline.sections` 时用 `createTempoFromFrames`，事件帧用 `tempo.frame(段, 小节, 拍, 拍内分数)`。

## 3. 交付档位与 QA 期望值

`profiles.json` 每个档位写全交付规格：宽高、帧率、H.264 High、yuv420p、BT.709 限范围（range tv、matrix / primaries / transfer bt709）、AAC 48 kHz 立体声、积分响度与容差、真峰值上限、声画同步容差、标题与动作安全区。`qa` 是所有档位共用的检测阈值（解码、黑场、静帧、闪烁、切点、文字、底板、AIGC 标识），标 `calibrate: true` 的三项是待实测标定的起点值。

`node engine/production/film.js expect <作品> [--json]`（库：`qaExpectations(film)`）给出这部片 QA 要比的全部数：ffprobe 应有的字段值、帧数与时长、切点、事件帧与秒、停顿、响度窗口、安全区、阈值换算成本片帧数（例如文字最短停留 0.8 秒 = 20 帧 @24 fps）。改一个镜头的 `out`，这里的帧数、切点、事件随之变化。

## 4. 创作闸门与状态

三道阻断闸 look → animatic → final（另有只记录的 structure），对应 `routes/directing/DIRECTING.md` 的 ⛔2、⛔3、⛔4（⛔1）。规则、命令与 agent 的边界见 `docs/creative-review/README.md`。给编排工具的库接口：

| 函数 | 用途 |
|---|---|
| `filmStatus(target)` | 现算状态 `{ state, label, gates, run, qa, canFinal, diagnostics, next }` |
| `assertFinalAllowed(target)` | 终渲前调用：look 与 animatic 认可或豁免才放行，否则抛 `GateError`（`exitCode` 4） |
| `assertDelivered(target)` | 写「已交付」之前调用：只有 accepted 放行 |
| `deliveryLabel(state)` / `findUnbackedClaims(text, state)` | 状态的对外文字；查出没有 accepted 撑腰的「已交付」「用户已认可」 |
| `buildReview` / `validateReview` / `writeReview` / `readReviews` / `gateVerdict` | 审片记录 |
| `validateRunRecord(run, { film, runDir })` / `validateQaReport(report, { film, runShas })` | 运行记录（附录 C8）与 QA 报告 |

运行目录：`films/<名>/out/<run-id>/`（run-id 为 `YYYYMMDD-HHMMSS-<短提交>[-dirty]`），`out/latest` 是写着 run-id 的指针文件（不用符号链接）。渲染器写 `run.json` 的 `kind`（final / animatic / preview / still）与 `status: rendered`、`technicalAcceptance.status: not-run`；QA 写 `qa/report.json`。

## 5. 与 ProjectSpec 的关系

ProjectSpec（`project.js`，契约见 `docs/routes/contracts.md`）是执行侧的投影：`toProjectSpec(film, { runtime, execution, filmDir })` 把作品描述换成 ProjectSpec（路线写注册表 id，路径换成仓库相对），`fromProjectSpec(spec)` 反过来生成 film.json 骨架。ProjectSpec 的 `route` 接受 a / b / c 与旧值 beiming / raea；a 的风格搬到原生执行（a + native）要声明风格迁移状态。

## 6. 命令行

```
node engine/production/film.js <子命令> [参数] [--json]
  check <作品|film.json> [--template] [--strict] [--no-files]   校验（v1 自动升级读取）
  status <作品>                                              现算状态与下一步
  gate <作品> final|deliver                                   能否终渲 / 能否写「已交付」
  review <作品> --gate … --decision … [--quote …] …          记录一条审片结论（只增不改）
  retime <作品> --shot <id> (--out <帧>|--length <帧数>) [--mode ripple|roll] [--write]
  expect <作品>                                              QA 期望值
  export <作品> [--out <目录>]                               给旧消费者的 timeline.json / events.json
  upgrade <作品> [--template] [--keep-v1-fields] [--write]    v1 → v2 草稿
  validate-result <run.json> [--film <作品>]                  校验运行记录（严格口径）与同目录的 QA 报告
  profiles                                                   列出交付档位
```

退出码（计划附录 C1）：0 成功；1 运行失败；2 用法错误或找不到文件；4 契约 / 闸门不通过；130 / 143 收到中断信号（已删掉未写完的临时文件）。`--json` 时 stdout 只有一个对象 `{ ok, exitCode, command, error: { code, message, hint } | null, outputs, runJson, warnings, result }`；`--help` 输出到 stdout、exit 0、不读写作品文件。写文件一律原子写（同目录临时文件 + rename）。

测试：`node --test "tests/production/**/*.test.mjs" "tests/assets/**/*.test.mjs"`（Node 22 起支持 glob；直接给目录名不会展开）。
