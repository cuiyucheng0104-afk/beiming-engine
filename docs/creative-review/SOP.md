# 一部作品的生产链

> **解决什么**：从接到需求到交付，每个阶段交什么文件、跑什么命令、谁来写、什么时候能进下一阶段。三条路线共用这一张表，路线差异在 §3。
> **怎么用**：导演方法（为什么这样排、每一步怎么判断好坏）看 `routes/directing/DIRECTING.md`；本页只管「交什么、跑什么、谁写、过哪道闸」。闸门规则见 [README.md](README.md)，评分口径见 [RUBRIC.md](RUBRIC.md)。
> **出处**：阶段顺序以 `docs/cases/ppt-animation.md`「实际流程」为底（提取 → 整数帧时间轴 → 分层 → 镜头 → 声音 → 渲染 → 封装 → 验收），关口取自 `routes/directing/DIRECTING.md` §1（其十步骨架改编自 `cases/vendor/lemo-opuscar/DIRECTOR.md` @bebbbe1，MIT）。
> **命令的状态**：标【现在】的命令已在仓库里，可以直接跑；标【接线中】的由出片编排 `tools/film`（工作包 P06）统一接上，接上之前用所选路线手册「最快上手」里的入口。

## 1. 阶段总表

路径都相对作品目录 `films/<名>/`。

| # | 阶段 | 交什么 | 命令 | 谁写 | 进下一阶段的条件 |
|---|---|---|---|---|---|
| 0 | 需求 | `brief.md`：用途、片长（秒与帧）、画幅、fps、交付档位、路线与理由、素材与授权、需求原文 | 【现在】`node tools/new-film.mjs <a\|b\|c> <名>` 建目录 | 导演 | 对照能力边界（DIRECTING §2.1）；做不到的项在 ⛔1 前告诉用户并给替代方案 |
| 1 | 结构 | `TREATMENT.md` §4–§6：一句话与弧线、三个候选结构、对标表 | 【现在】`film.js review <作品> --gate structure --decision approve …` 记录用户原话 | 导演 | ⛔1 用户确认结构与对标（只记录、不阻断） |
| 2 | 阐述 | `TREATMENT.md` 其余各节（小样 12 节）；系列或多人分工另写 `bible.md`：画幅、fps、色板、字体、调式与动机、段间接缝规则 | — | 导演 | 阐述的数字与 `film.json` 一致 |
| 3 | 风格定调 | `stills/` 风格帧（真实渲染代码出图）、色彩脚本条、比例与同帧对照；`style-lock.json`；`film.json` 的 `style` | 【现在】A / C：`node engine/render/still.mjs <作品> <秒…> --out <作品>/out/stills`；B：`node engine/render/native.mjs <作品> --at <帧…>` | 导演、风格 | ⛔2 `look`：用户认可风格帧（或原话豁免） |
| 4 | 镜头表与时间轴 | `film.json` 的 `shots`（整数帧半开区间）、`events`（结果帧）、`timeline`（节拍）、`holds`（有意的停顿与黑场）；阐述的镜头表、节拍表、cue map 从这里导出，不手抄 | 【现在】`film.js check <作品>`；`film.js expect <作品>`；`film.js retime <作品> --shot <id> --out <帧> [--mode roll] --write`；`film.js export <作品>` | 导演（独占 `film.json`） | `check` 通过；切点落在各轨道一拍 n 的公倍数帧（`cut-off-step` 提示） |
| 5 | 资产 | 作品自带的 `assets/`；复用的共享资产写进 `film.json` 的 `assets`（资产 id） | 【现在】`node engine/assets/manifest.js check --film <作品>`；共享资产清单 `node engine/assets/manifest.js list` | 资产 | 资产 id 都认得、文件在、权利写进 `credits` |
| 6 | 逐镜头制作 | `shots/<镜头 id>/`：本镜模块与本镜素材；镜头内的时间都相对本镜入点 | 【现在】按路线手册看关键帧（同第 3 步） | 镜头（只写自己的 `shots/<id>/`） | 每镜关键帧与阐述一致；要改切点交给导演 `retime` |
| 7 | 动态预演 | 由正片时间轴驱动的整片预演（半分辨率、占位主体、临时声）与联系表，写进一次运行 `out/<run-id>/`（`run.json` 的 `kind: animatic`） | 【接线中】`npm run film -- render <作品> --preview`；现在用路线手册的出片入口加半分辨率，例如 A / C 的 `node engine/render/video.mjs <作品> --size 960x520` | 渲染 | ⛔3 `animatic`：用户认可节奏与镜头（或原话豁免）；认可冻结当时的镜头表 |
| 8 | 终渲 | `out/<run-id>/` 里的成片与 `run.json`（`kind: final`、`status: rendered`），`out/latest` 指向它 | 【现在】先跑 `film.js gate <作品> final`，exit 0 才渲；【接线中】`npm run film -- render <作品> --final` 会自动检查，没过 exit 4 | 渲染（只写 `out/`） | 状态到 `rendered` |
| 9 | 声音 | `audio/`（或模版里的 `sound.py` / `mix.py`）；落点时间从 `film.json` 的 `events` 导出（`film.js export`），不手写秒数 | 【现在】按路线手册的声音脚本；C 路线另有 `cuecheck` | 声音（只写 `audio/`） | 混音目标在档位窗口内（`film.js expect` 的 `audio.mixTarget`） |
| 10 | 封装 | `out/<run-id>/` 的网页版与母版（档位见 `engine/production/profiles.json`） | 【接线中】`npm run film -- assemble <作品>`；现在 A / C 用 `engine/render/mux.sh`，B 用 `native:render` | 渲染 | 成片 sha256 写进 `run.json` |
| 11 | 机器 QA | `out/<run-id>/qa/report.json`（规格、色彩、响度、黑场静帧闪烁、切点、文字、声画、底板露边） | 【接线中】`npm run film -- qa <作品>`（`tools/qa`，工作包 P07）；期望值 `film.js expect <作品>` | QA（只写 `qa/`） | 硬门全过：状态到 `qa-passed` |
| 12 | 成片审看 | `review/final-<日期>.md` 送审单（[模板](review.template.md)）与代理审片证据；用户全速带声看完后的原话 | 【现在】`film.js review <作品> --gate final --decision approve --file <这次的成片> --quote "<原话>" --source-ref "<出处>"` | 导演录入用户原话 | ⛔4 `final`：用户认可这一版成片 → 状态 `accepted` |
| 13 | 交付 | 交付说明：只有状态为 `accepted` 时才写「已交付 · 用户已认可」 | 【现在】`film.js gate <作品> deliver`（exit 0 才写）；`film.js status <作品>` | 导演 | — |

每一步做完都可以先跑 `node engine/production/film.js status <作品>`：它说出当前状态和下一步该做什么。

## 2. 谁写哪里（多代理并行时的分区）

同一部片分给多个代理时，写入范围按角色切开，互不重叠；时间只在 `film.json` 里写一次，其他人从它导出。

| 角色 | 只写 | 不写 |
|---|---|---|
| 导演 / 集成者 | `film.json`、`brief.md`、`TREATMENT.md`、`bible.md`、`review/` | 别人的 `shots/<id>/`、`audio/` |
| 镜头 | 自己认领的 `shots/<id>/` | `film.json`（要改切点、事件，告诉导演；导演用 `film.js retime` 改，事件跟着镜头走） |
| 声音 | `audio/`（或 `sound.py` / `mix.py`） | 时间常数：从 `film.js export` 的 `timeline.json` / `events.json` 读 |
| 资产 | 作品的 `assets/` | 共享资产（`src/`、`assets/plates/`、`fonts/`）改动走资产注册表 `engine/assets/` 的登记与锁文件 |
| 渲染 | `out/<run-id>/`、`out/latest`、`out/cache/` | 任何源文件 |
| QA | `out/<run-id>/qa/` | 任何源文件 |

合并前跑 `film.js check <作品>`；改过切点的，animatic 认可会自动失效（status 显示 `stale` 与差异），要重新给用户看。

## 3. 三条路线的差异

| | A 北冥风格路线 · WebGL 三渲二 | B 北冥原生 · BNE | C 北冥代码动画风格 · 86 式 |
|---|---|---|---|
| `route` / `backend` | `a` / `three` | `b` / `native` | `c` / `canvas`、`svg`、`dom`、`three`、`webgl` |
| 入口 `entry` | `index.html`（页面） | `film.tsx`（原生运行时） | `index.html`（页面） |
| `film.json` 必写 | `style`（含视觉基准 `baseline`） | `native` 段：素材准备、封装方式 | 用到拍点核对时写 `cuecheck` 段 |
| 声音 `audio.mode` | `script`（`sound.py`） | `native`（`native.audio.script`） | `script`（`mix.py`） |
| 手册 | `routes/a-webgl/README.md` | `routes/b-native/README.md` | `routes/c-style/README.md` |

新作品默认交付档位 `web-1080p24`（决策 D07）；`beiming-1040p24` 只给《北冥》样片。档位清单：`node engine/production/film.js profiles`。
