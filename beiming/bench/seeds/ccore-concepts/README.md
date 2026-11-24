# 场景概念种子表（ccore ThreeJS-3D-Scenes-v2 节选）

**这是什么**：400 条「一个概念 → 一个可对照的小场景」的英文提示词，从公开数据集 [ccore/ThreeJS-3D-Scenes-v2](https://huggingface.co/datasets/ccore/ThreeJS-3D-Scenes-v2) 抽出来，给 bench 出题时当**场景概念的多样性参考**。它不是题目、不是评分依据，也不是渲染素材。

## 来源与许可

| 项 | 内容 |
|---|---|
| 数据集 | `ccore/ThreeJS-3D-Scenes-v2`（Hugging Face，ModelScope 同名镜像） |
| 取用的版本 | Hugging Face 提交 `370b2cf95727666a3ac570f7fdb3f63f4552d382`（2026-11-17 修改），只取文本配置 `default` 的 `train`、`validation` 共 3,445 条，**没有取图片、系统提示和助手回复** |
| 许可 | MIT，Copyright (c) 2026 CCORE；全文见 [LICENSE-upstream.txt](LICENSE-upstream.txt)。数据集卡写明「在发布者持有权利的范围内」 |
| 本仓库登记 | [THIRD-PARTY.md](../../../../THIRD-PARTY.md) 第 14 节、[docs/rights/register.json](../../../../docs/rights/register.json) R17、[REUSE.toml](../../../../REUSE.toml) |

提示词原文一字不改（只把空白折成单个空格）。`id` 就是数据集里的编号，可回查原条目。

## 怎么选的 400 条

规则固定、可复算（【实测】在 3,445 条上跑过）：

1. 按 `domain`（50 个领域）分组；
2. 每组内按难度 `level`（1 到 8）分桶，桶内按 `sha256(id)` 升序；
3. 难度从低到高轮流取各桶的第一条，取满 8 条为止（样本不足 8 条的领域取完为止）；
4. 结果按 `level`、`id` 排序。

结果：50 个领域各 8 条，共 400 条；难度 1 到 8 都有（59/61/57/48/50/43/49/33）；体素风 155 条；来自验证集 21 条。

## 字段（tab 分隔，第一行是表头）

| 字段 | 含义 |
|---|---|
| `id` | 数据集编号，如 `scene-expansion-0401` |
| `split` | `train` 或 `val`（数据集自带的划分，同一概念家族在同一边） |
| `domain` | 领域类，50 种 |
| `level` | 数据集标注的难度 1 到 8，只是课程标签，**不是**北冥的难度 |
| `voxel` | 1 为体素风 |
| `title` | 场景标题（干净的概念名） |
| `compare` | 1 表示提示词要求并排或对照（正则：compare / side by side / beside / versus） |
| `hedge` | 1 表示带「不夸大」限定（without claiming / rather than / qualitative / schematic / illustrat / toy） |
| `interactive` | 1 表示要求可切换或可交互（toggle / let users / allow viewers / slider） |
| `prompt` | 用户提示词原文，英文 |

三个标记是正则粗标，会漏会错，只当筛选线索（【实测】）。

## 怎么用、不该怎么用

- **用**：出新题前按 `domain`、`compare`、`hedge` 过一遍，看自己的题是不是总在同几个主题上打转；写「示意而非实测」类限定句时，参考 `hedge=1` 的行怎么写。
- **不用**：提示词里的「Three.js from cdnjs、单个 HTML 文件」是它原任务的输出要求，对北冥无意义；提示词没有任何可量条件，不能直接当 `question/0.1` 的 `brief`——北冥的题面要有可量的交付规格与评分指标。
- 难度 `level` 不要照抄进题目。

## 局限（没核实的）

- 只抽读过十几条提示词，没有逐条读过这 400 条的内容质量。
- 数据集的响应代码（HTML/JS）没有取，也没有在无头 Chrome 里跑过，不知道能否稳定渲染。
- 提示词是英文，没有翻译。
