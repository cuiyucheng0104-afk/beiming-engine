---
name: beiming-review
description: 在北冥仓库（本仓库）里审片、验收、做交付前检查时用它：成片规格（画幅、帧数、fps、色彩标签）、响度与真峰值、黑场静帧、切点与联系表、文字安全区与读字时长、声画对位，以及闸门记录与"已交付 / 已认可"的口径。用户问"能交付吗""帮我检查成片""出联系表""QA 一下"时触发。
---

# 在北冥仓库里审片与验收

先分清两层，结论不能互相代替（`routes/directing/DIRECTING.md` 步骤 10）：

- **代理审片（agent 做）**：联系表、切点邻帧、逐帧变化曲线、规格与响度数字、读字与安全区检查。结论只能写「代理检查通过」。
- **人工观看（人做）**：全速、带声、从头到尾，由用户或指定审片人完成。记下审片人、日期、看的版本和**原话**。agent 不能实时观看，不替人填这一项。

## 1. 机器检查

仓库有统一质检入口时优先用它（`node tools/qa/cli.mjs --help` 或 `npm run qa -- --help` 能运行就用；路线手册的「验收」一节另有本路线的判据）。没有时用下面的 FFmpeg 命令，逐项写「通过 / 失败 / 未复核」和数字：

```sh
F=films/<名字>/out/<运行目录>/web.mp4      # 换成实际成片路径

# 规格：宽高、帧率、帧数、像素格式、色彩标签（默认档 web-1080p24 应为 1920×1080、24/1、yuv420p、tv、bt709×3）
#       JSON 里缺 color_transfer / color_primaries 字段就是未标注（unknown），按失败记
ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=codec_name,profile,width,height,r_frame_rate,nb_read_frames,pix_fmt,color_range,color_space,color_transfer,color_primaries -of json "$F"
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of json "$F"

# 响度：积分响度 −14 LUFS ±1 LU、真峰值 ≤ −1.0 dBTP（broadcast 档 −23 LUFS）；打印 Summary 里的 I 与 Peak（真峰值，单位显示为 dBFS）
ffmpeg -hide_banner -nostats -i "$F" -filter_complex ebur128=peak=true -f null - 2>&1 | grep -E "^ +(I|Peak):"

# 黑场与静帧：没有输出就是没检出（刻意的黑场、定格要在阐述里登记过）
ffmpeg -hide_banner -nostats -i "$F" -an -vf "blackdetect=d=0.1:pix_th=0.05,freezedetect=n=-60dB:d=0.5" -f null - 2>&1 | grep -E "black_|freeze_"

# 联系表：每秒一张（长片改 fps=1/2），看构图、主体、字幕位置是否一致
ffmpeg -hide_banner -v error -i "$F" -vf "fps=1,scale=480:-2,tile=4x3" -frames:v 1 -update 1 films/<名字>/out/contact.jpg

# 切点邻帧：切点在第 N 帧时取 N−3 … N+3（下例 N=96），看接缝、轴线、光向和露边
ffmpeg -hide_banner -v error -i "$F" -vf "select='between(n\,93\,99)',scale=480:-2,tile=7x1" -frames:v 1 -update 1 films/<名字>/out/cut_96.jpg
```

逐帧变化曲线（找卡帧、频闪、跳拍）用 `routes/directing/DIRECTING.md` 步骤 10 给出的命令。在 Windows PowerShell 里：先写 `$F = "films\<名字>\out\<运行目录>\web.mp4"`，命令里的 `"$F"` 照用；`| grep -E "…"` 换成 `| Select-String -Pattern "…"`（同一个正则）。

产物只写 `films/<名字>/out/`；联系表、帧条这些审片证据跟成片放在一起，不提交。

## 2. 画面与声音清单

按清单逐项过，每项写复核帧和原因：

- 画面：`routes/directing/VISUAL-DESIGN.md` §8「画面 QA 清单」与其后的「审美复核」（眯眼缩略图、水平翻转、5 秒复述、与基准帧并排）。
- 交付前：`routes/directing/DIRECTING.md` §4「交付前清单」。
- 出片工程（色彩、编码、确定性、逐帧对比）：`routes/directing/craft/video.md` 第 2、4、6 节。
- 文字：白名单、读字时长（中文停留 ≥ 字数 ÷ 4.5 + 1.5 秒）、安全区、缺字回落（DIRECTING 步骤 9）。
- 声音：叙事动作有声、静默段实测电平、"最重要的一声"写明类型、声画偏差不超过 1 帧（DIRECTING 步骤 8；`craft/animation.md` §5.7 的容差表）。

## 3. 闸门与状态记录

- look、animatic、final 每道闸都要有记录：版本、日期、审片人、**用户原话**。仓库的作品工具提供审批或豁免命令时（看 `npm run film -- --help`），用它写记录；没有时写进 `films/<名字>/TREATMENT.md` 的 §21「审片与返修」和 §22「状态」。
- 豁免只能凭用户原话，逐字引用并写明出处（哪一轮、哪条消息）；agent 不能自己批准。
- 返修表六列：意见原话｜根因｜改法｜是否动拍点｜改了哪个文件｜复测数字。返修后回改阐述里所有受影响的表。
- 三种状态分开写，各附证据：**已输出**（文件在哪）、**技术检查通过**（哪些命令、什么数字）、**用户认可**（谁、哪天、原话）。只有用户确实认可后才能写「已交付」「用户已认可」。

## 4. 汇报模板

```
成片：<路径>（<宽>×<高>，<fps> fps，<帧数> 帧，<时长> 秒）
机器检查：规格 <通过/失败：数字>；色彩 <…>；响度 I=<…> LUFS、TP=<…> dBTP；黑场/静帧 <…>；切点 <…>
代理审片：联系表 <路径>；切点帧条 <路径>；问题 <逐条：帧号、现象、建议改法>
人工观看：<未进行 / 审片人、日期、原话>
状态：已输出 <是/否> / 技术检查 <代理检查通过 或 未通过项> / 用户认可 <有原话才写>
已知问题与豁免：<逐条，豁免附用户原话与出处>
```
