# 《北冥》10 秒样片 · 作品描述镜像

仓库根的《北冥》10 秒概念样片（`index.html` + `src/` + `audio/`）完成于作品描述 film.json v2 之前，它的时间写在自己的源码里。本目录用 film.json v2 **描述**这部样片，供工具与 agent 按统一格式读取（镜头表、事件表、交付档位、资产、署名）；页面不读这份文件，样片源码是冻结基准，不因本目录而改动。

| 文件 | 是什么 |
|---|---|
| `film.json` | 镜像描述：三镜 A [0, 72)、B [72, 120)、C [120, 240)，34 个画面与声音事件，档位 `beiming-1040p24`；路径相对仓库根（`mirror.paths = repo`），`mirror.frozen = true` |
| `mirror-check.mjs` | 一致性检查：读 `src/timeline.js`、`src/main.js`、`src/girl.js`、`src/shotC.js`、`src/hud.js`、`src/birds.js`、`audio/cues.json`，推出应有的镜头表与事件帧，与 `film.json` 逐项比对，任何漂移都失败 |
| `review/` | 审片记录。目前只有一条 AI 的代理审片（`decision: comment`），不是用户认可，状态仍是 draft |

```sh
node engine/production/film.js check films/beiming-10s     # 作品描述合格
node films/beiming-10s/mirror-check.mjs                    # 与样片源码、声音表一致（exit 0）；漂移 exit 4 并逐条列出
node engine/production/film.js status films/beiming-10s    # 状态：draft
node engine/production/film.js expect films/beiming-10s    # QA 期望值（切点 72、120，事件帧，档位规格）
```

**状态只能是 draft。** 样片完成于创作闸门建立之前，没有用户对风格帧、动态预演或成片的认可记录，所以不能写「已交付」。九分钟版文档转述过用户要求沿用原版十秒，那是转述，不是用户对样片本身的原话，不能补成审片记录。媒体的认可版本见决策 D05。

**改样片的切点**（src/ 是冻结基准，改之前先确认有授权）：在 `src/timeline.js` 改 `TIMELINE`，再跑 `mirror-check.mjs`，按它列出的差异改 `film.json` 的镜头表与事件（`film.js retime films/beiming-10s --shot <id> --out <帧>` 可以预览改后的帧号；镜像不许 `--write`）。声音表 `audio/cues.json` 的时间也要一起改。

**代理审片样例**：`review/final-2026-11-10.json` 是按 `docs/creative-review/RUBRIC.md` §3 与评分标尺 `docs/quality/RUBRIC.md` 做的一次代理审片（静帧证据，没有看连续帧与带声成片）：片尾片名「北冥」写完后只停约 9 帧、副标题字小对比低（声画与文字 5 分，机器 QA 的 `texts.duration` 硬门同样不通过），鲲鳍尖与东方明珠塔尖相切（构图与留白 7 分）。AI 的记录只能是 `comment`，不推进状态。样片源码冻结，这些问题按 QA 豁免登记，作为新作品的反例。
