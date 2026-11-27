# 审片怎么落分

> **只有一把尺子**：六个维度的锚点、低于 8 分的典型问题、一票否决与机器证据对照，都写在 [docs/quality/RUBRIC.md](../quality/RUBRIC.md)（机器 QA 包维护，依据加固计划 §7.3）。本页不另立标准，只说三件事：分数和问题怎么写进审片记录、送审成片前的内部门槛、agent 的代理审片怎么做。
> **取值的唯一来源**：维度、否决项、层、优先级的 id 在 `engine/production/vocab.js`；它与评分标尺的标题、验收题库的评分表（`tools/eval/lib/scoring.mjs`）一致，由 `tests/production/rubric.test.mjs` 守住。
> **出处**：内部送审线与问题分级改编自仓库归档的豹变项目规范（`cases/source/local-baobian-film/SUBAGENT_STANDARD.md` 第 4 节，本项目自有材料）；代理审片的看片方法见 `routes/directing/DIRECTING.md` 步骤 10（帧条与联系表做法改编自 `cases/vendor/lemo-opuscar/TECHNIQUE.md` §8 @bebbbe1，MIT）。

## 1. 记录里的 id

审片记录（`film.js review` 的 `--score`、`--veto`、`--rejected-on`）与运行记录 `creativeAcceptance.reviews[]` 的 `scores` / `vetoes` 只用下面的 id；标题与评分标尺的小节一一对应。

| id | 维度 | 锚点与典型问题 |
|---|---|---|
| `style` | 风格还原 | [RUBRIC §2.1](../quality/RUBRIC.md#21-风格还原) |
| `texture` | 质感 | [RUBRIC §2.2](../quality/RUBRIC.md#22-质感) |
| `narrative` | 叙事清楚 | [RUBRIC §2.3](../quality/RUBRIC.md#23-叙事清楚) |
| `camera` | 镜头与节奏 | [RUBRIC §2.4](../quality/RUBRIC.md#24-镜头与节奏) |
| `composition` | 构图与留白 | [RUBRIC §2.5](../quality/RUBRIC.md#25-构图与留白) |
| `avText` | 声画与文字 | [RUBRIC §2.6](../quality/RUBRIC.md#26-声画与文字) |

| id | 一票否决（画面分记 0，[RUBRIC §3](../quality/RUBRIC.md#3-一票否决画面分记-0)） |
|---|---|
| `edge-exposed` | 露边或贴片截断 |
| `frame-glitch` | 断帧或闪帧 |
| `text-broken` | 文字越界，或缺字后回退到系统字体 |
| `a-missing-ink-or-post` | A 路线缺墨线或缺后期 |
| `subject-mismatch` | 主体与 brief 不符 |

读字时长不足、对比度低、声画错位这类问题不是否决项：机器 QA 的硬门（`texts.duration`、`texts.contrast`、`sync.events`）会挡住，评分落在 `avText`。

## 2. 送审线只是内部门槛

**送审成片前**（⛔4，把成片交给用户看之前）：六个维度都不低于 8 分，没有一票否决项，没有 P0、P1 问题，机器 QA 的硬门全部通过。达不到就先改，不送审。

这条线**不能**代替用户认可：豹变四版按同一条线自评过关，用户仍不认可（`cases/entries/local-baobian-film.md`）；纸上江山 E 组技术检查全部通过，用户否定了画面方向（`routes/directing/DIRECTING.md` §1）。分数的用处是挡住明显不够的东西、让问题说得清楚；作品是否交付，只看用户的原话（[README.md](README.md) §2）。评测场合的通过线（总分、画面分）见评分标尺 §4。

落分规则：
- 打 8 分以下必须写出至少一条落到帧号的问题（`issues`），否则该维不计；每个分数引用证据帧号（`evidenceFrames`）。
- 有参照（风格基准帧、style-lock、对标片）时与参照并排看；没有参照时写明「无参照，按阐述的意图判断」。
- 只给看过的维度打分：没看带声的完整成片，就不给 `camera`、`avText` 打分（评分标尺 §1 第 4 步）。

## 3. 代理审片规程（agent 做）

agent 不能实时观看，只能看证据。看片顺序按评分标尺 §1（QA 报告 → 联系表 → 切点与事件帧 → 带声完整观看由人做），agent 另外遵守：

1. **帧号从作品描述来**：切点、事件帧、刻意画面、豁免帧段一律取 `node engine/production/film.js expect <作品> --json`（`cuts`、`events`、`intentional`、`waivers`），不手抄、不按秒估。
2. **切点**：每个切点前后至少各 3 帧（建议 6 帧）；分段渲染的段边界同样看。切点没落在本镜各轨道一拍 n 的公倍数帧时（`film.js check` 的 `cut-off-step` 提示），看切点前后有没有被截掉的半拍。
3. **事件**：`film.json` 每个带 `visual` 的事件看起点、峰值、终点三帧；关键动作出 0.2 秒步长的帧条与连续帧条，确认一拍二 / 一拍三与预备—动作—结果。
4. **声音**：只看数据——QA 报告的响度、真峰值、`sync.events` 的偏差；`sync` 写成 `soft` 的缓起事件超出容差只是注意。音色与混音好坏留给人判断。
5. **抽帧**：按文件实际的色彩范围与矩阵转换（成片按档位是 BT.709 限范围；ffmpeg 默认的快速转换会让抽出的帧整体偏暗约 2 级，抽帧时在滤镜里加 `scale=flags=accurate_rnd+full_chroma_int,format=rgb24`）。
6. **记录**：结论只能写「代理检查通过 / 未通过」，用 `--decision comment`：

   ```sh
   node engine/production/film.js review films/<名> --gate final --decision comment \
     --file films/<名>/out/<run-id>/master.mp4 \
     --summary "代理检查未通过：片尾副标题停留 0.29 秒" \
     --score style=8 --score composition=7 --score avText=5 --evidence-frame 227 --evidence-frame 239 \
     --issues-file <问题条目.json>
   ```

   `--file` 记下所看成片的 sha256：出片编排用它把这条代理审片挂到这次运行的 `creativeAcceptance`（状态 `ai-reviewed`），换了成片就不算。

## 4. 问题条目

一条问题一个对象，格式见 [issue.schema.json](issue.schema.json)：定位到帧（`frame` 或半开区间 `frames`）、镜头、画面区域（`region`，0–1 的比例坐标 `[x, y, w, h]`）、所属层；写现象（不写猜测的原因）、改法、优先级、证据路径与处理状态。`dimension` 取 §1 的维度 id。

| 层 `layer` | 含义 | 层 `layer` | 含义 |
|---|---|---|---|
| `model` | 造型 | `camera` | 镜头与运镜 |
| `material` | 材质与着色 | `edit` | 剪辑与节奏 |
| `lighting` | 灯光 | `overlay` | 显示层 |
| `plate` | 底板 | `text` | 文字 |
| `post` | 后期 | `sound` | 声音 |
| `performance` | 动作与表演 | `tech` | 技术与编码 |

| 优先级 | 含义 |
|---|---|
| `P0` | 报错、黑屏、穿帮，或者整段看不懂；任何一票否决项 |
| `P1` | 明显偏离画风，或者转场、动作不成立；机器 QA 硬门不通过 |
| `P2` | 能看出来的瑕疵 |
| `P3` | 锦上添花的改进 |

处理状态 `status`：`open`（待改）→ `fixed`（改了，待复核）→ `verified`（复核过，附复测证据）；不改的写 `wontfix` 并说明理由。

用户否定时，`film.js review --decision reject` 写 `--rejected-on`（取 §1 的维度 id，逗号分隔）和 `--must-change`（下次必须改什么，从原话里提炼，原话照样保留在 `--quote`）。
