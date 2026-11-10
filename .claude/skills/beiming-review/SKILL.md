---
name: beiming-review
description: 在北冥仓库（本仓库）里审片、验收、做交付前检查时用它：先跑机器 QA 门（交付规格、BT.709 色彩、响度与真峰值、黑场静帧闪帧、切点、文字安全区与停留、底板露边、声画同步），再做代理审片与闸门记录，分清"代理检查通过"和"用户已认可"。用户问"能交付吗""帮我检查成片""出联系表""QA 一下""审一下片"时触发。
---

# 在北冥仓库里审片与验收

先分清两层，结论不能互相代替（`routes/directing/DIRECTING.md` 步骤 10、`docs/quality/README.md`）：

- **机器 QA 与代理审片（agent 做）**：QA 门的报告、联系表、切点邻帧、逐帧变化曲线。结论只能写「代理检查通过」。
- **人工观看（人做）**：全速、带声、从头到尾，由用户或指定审片人完成，按 `docs/quality/RUBRIC.md` 记分并记下审片人、日期、看的版本和**用户原话**。agent 不能实时观看，不替人填这一项。

## 1. 机器 QA 门（必跑）

终渲之后、交给人看之前，在仓库根目录：

```sh
node tools/qa/cli.mjs report films/<名字>/out/<运行目录>/master.mp4      # 注册后：npm run qa -- report …
```

- 退出码：0 硬门全过（可以有「注意」）；4 硬门不通过；3 环境缺失（FFmpeg ≥ 7、无头浏览器）；2 用法错误；1 运行失败。**只有 exit 0 才能写「代理检查通过」**。
- 报告写在运行目录的 `qa/` 下：`report.json`（附录 C8，`technicalAcceptance` 可直接放进 run.json）、`report.md`（先列必须先修的问题）、`contact.jpg`（联系表，切点标 CUT）。产物只在 `films/<名字>/out/` 里，不提交。
- 期望值来自作品的 `film.json`（帧数、镜头表、事件、`aigc`、`qa` 段）与交付档位（默认 `web-1080p24`：1920×1080、24 fps、yuv420p、bt709 tv、AAC 48 kHz、−14 LUFS ±1 LU、真峰值 ≤ −1.0 dBTP）。刻意的停顿、黑场、闪白写进 `film.json` 的 `qa.intentional` 并写理由；不要为了过检放宽阈值。
- 只查一组时用子命令：`delivery`、`visual`、`texts`、`plates`、`sync`（各有 `--help`）。每项检查的判据与修法见 `docs/quality/QA-GATE.md` 第 4 节。
- **豁免**：只有用户批准的才生效。agent 只能起草，写成 `"status": "proposed"`（`docs/quality/QA-GATE.md` 第 5 节），由人填上用户原话与出处后才生效；`approvedBy` 写成 agent、AI、Claude 的豁免一律无效。

QA 门报 exit 3、一时修不好环境时，可以用 FFmpeg 先看数字（不能代替 QA 门的结论，汇报里写「QA 门未跑：原因」）：

```sh
F=films/<名字>/out/<运行目录>/master.mp4
ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=width,height,r_frame_rate,nb_read_frames,pix_fmt,color_range,color_space,color_transfer,color_primaries -of json "$F"
ffmpeg -hide_banner -nostats -i "$F" -filter_complex ebur128=peak=true -f null - 2>&1 | grep -E "^ +(I|Peak):"
```

色彩四项应为 tv、bt709×3；JSON 里缺 `color_transfer` / `color_primaries` 字段就是未标注，按失败记。在 Windows PowerShell 里先写 `$F = "films\<名字>\out\<运行目录>\master.mp4"`，`| grep -E "…"` 换成 `| Select-String -Pattern "…"`。

## 2. 代理审片清单

QA 门管得到的是规格与异常；构图、表演、节奏、质感要逐项看，每项写复核帧和原因：

- 画面：`routes/directing/VISUAL-DESIGN.md` §8「画面 QA 清单」与其后的「审美复核」（眯眼缩略图、水平翻转、5 秒复述、与基准帧并排）。
- 交付前：`routes/directing/DIRECTING.md` §4「交付前清单」。
- 出片工程：`routes/directing/craft/video.md` 第 2 节（确定性）、第 4 节（色彩管线）、第 5 节（编码与封装）、第 6 节（质量门）。
- 文字：读字时长（中文停留 ≥ 字数 ÷ 4.5 + 1.5 秒）、安全区、缺字回落（DIRECTING 步骤 9）。
- 声音：叙事动作有声、静默段实测电平、"最重要的一声"写明类型、声画偏差不超过 1 帧（DIRECTING 步骤 8；`routes/directing/craft/animation.md` §5.7 的容差表）。
- 机器判不了的项（遮挡、世界内文字、色彩观感）见 `docs/quality/QA-GATE.md` 第 8 节，逐条写「已看 / 未看」。

## 3. 闸门与状态记录

- look、animatic、final 每道闸都要有记录：版本、日期、审片人、**用户原话**。仓库的作品工具提供审批或豁免命令时（看 `npm run film -- --help`），用它写记录；没有时写进 `films/<名字>/TREATMENT.md` 的 §21「审片与返修」和 §22「状态」。
- 跳过某道闸只能凭用户原话，逐字引用并写明出处（哪一轮、哪条消息）；agent 不能自己批准。
- 返修表六列：意见原话｜根因｜改法｜是否动拍点｜改了哪个文件｜复测数字。返修后回改阐述里所有受影响的表，再跑一次 QA 门。
- 三种状态分开写，各附证据：**已输出**（文件在哪）、**代理检查通过**（QA 门 exit 0 与报告路径）、**用户认可**（谁、哪天、原话）。只有用户确实认可后才能写「已交付」「用户已认可」。

## 4. 汇报模板

```
成片：<路径>（<宽>×<高>，<fps> fps，<帧数> 帧，<时长> 秒）
QA 门：node tools/qa/cli.mjs report … → exit <码>；报告 <运行目录>/qa/report.md；不通过项 <逐条：检查 id、实测、期望>
代理审片：联系表 <路径>；问题 <逐条：帧号、现象、建议改法>
人工观看：<未进行 / 审片人、日期、原话、RUBRIC 分数>
状态：已输出 <是/否> / 代理检查 <通过 或 未通过项> / 用户认可 <有原话才写>
已知问题与豁免：<逐条，豁免附用户原话与出处；起草未批准的写 proposed>
```
