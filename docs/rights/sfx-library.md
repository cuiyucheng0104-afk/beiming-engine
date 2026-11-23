# 商用音效库（rog-5090）许可证核验与接入

> 登记：R16（[register.md](register.md)）｜核验日期：2026-11-24｜核验方式：逐子库读库内 EULA / README / 许可证文件原文（`ssh rog-5090` 上 `pdftotext` 抽取），不凭记忆断言。
> 库：rog-5090 `/mnt/data1/共享盘/音效库/`（63 G，15784 条音频），主人 2026-11-24 告知为已购可用的商用库。音频本体永不入仓、不复制，仓库只存元数据索引 [engine/audio/sfx_library_index.jsonl](../../engine/audio/sfx_library_index.jsonl)。

## 一、库概况

| 品牌 | 子库 | 文件数 | 库内许可证证据 |
|---|---|---|---|
| BOOM Library | Mechanicals Designed | 96 | `SoundMorph/Mechanicals Designed/00_BOOMlibrary_EULA.pdf`（另有 ReadMe / Metadata PDF） |
| SoundMorph | Mechanism | 769 | `SoundMorph/SoundMorph.Mechanism/SoundMorph_EULA_2016.pdf`（2016 版通用 EULA，措辞覆盖 "our products"） |
| SoundMorph | 其余 15 个子库（Future Weapons 1/2/3、Bloody Nightmare、Energy、Inner Circle Transient Foundations、Matter Mayhem、Monster_Within、Portals、Road Riders、Robotic Lifeforms、Solar Sky、Steampunk Weapons、Tension、Users of Tomorrow），其中 **Future Weapons 1/2、Portals、Inner Circle** 盘内有第三方渠道残留文件（第三节来源注记） | 14536 | 无库内 EULA 文件 |
| Pro Sound Effects | First | 350 | 无库内 EULA / README |
| Pro Sound Effects | Shanghai（Ambisonics-Stereo 三分卷） | 33 | 无库内 EULA / README |

顶层 `sfx/` 是空目录；总目录 CSV 在瑕疵修复后导出（145 个 AIFF 已记为 `.aif`，33 个 0 字节已删、不在册）。

## 二、逐子库核验结论

判定口径：**商用成片**＝素材用于对外交付/出售的影视成片；**渲染进交付**＝混音渲染进成片音轨后分发；**再分发**＝把库内音频（原样或处理后）作为素材再次分发；**衍生转换**＝从库内音频提取的参数文件（如 ERB 拟合参数）等可重建声音的中间产物。

### 1. BOOM Library · Mechanicals Designed —— ✅ 可用（单用户口径见第三节待补书面项 2）

EULA 原文要点（`00_BOOMlibrary_EULA.pdf`）：

- 授予 **MEDIA LICENSE**：「for commercial and non-commercial use in music, sound-effect, audio/video post-production, performance, broadcast or similar **finished content-creation and production use**」，含机械权（作为产品一部分复制发行）、同步权（与画面同步）、公开表演广播权，「worldwide and unlimited in time」，无需署名、无额外费用。
- **再分发禁止**的原文是目的限定条款：禁止「re-distribution method of the CONTENT, through any means, including … re-selling, trading, sharing, resampling, mixing, processing, isolating, or embedding into software or hardware of any kind, **for the purpose of** re-recording or reproduction **as part of any free or commercial library** of musical and/or sound effect samples … or any form of … sample playback system or device」。
- **衍生转换判断**：为某部成片的混音把库内音频转成拟合参数文件，不是「以重录/复制进素材库或采样回放系统为目的」的处理，按原文**不构成再分发**；但参数文件能重建声音的主要特征，一旦入库、随仓库分发或做成回放系统，即落入禁止范围。**红线：派生参数文件与一切处理中间体只留在制作机本地，不入仓、不分发。**

### 2. SoundMorph · 全部 16 个子库 —— ✅ 可用（授权 owner-confirmed；单用户口径与来源注记见第三节）

EULA 原文要点（`SoundMorph_EULA_2016.pdf`，仅随 Mechanism 子库附带；其余 15 个子库按同一 2016 版通用 EULA **推定**，建议主人核对购买记录确认版本）：

- 授予 **SINGLE-USER MEDIA PRODUCER LICENSE**：「royalty-free use of all assets in your productions, recordings and/or performances」，含机械权、同步权（films, games, theatrical works）、公开表演广播权。
- 明确允许「The recordings may be sold as part of your production/product **so long as it is not another Sample Library**」——**渲染进交付成片并出售：允许**。
- 禁止：并入另一素材库转售（原样、叠加或「Manipulated or modified recordings」皆禁）、声称作者权、在公共服务器或种子站分享。
- **衍生转换判断**：同上——修改/处理产物禁止的是「sold as part of another sample library」；内部制作中间体不属于。**红线同上：不入仓、不分发。**

### 3. Pro Sound Effects · First / Shanghai —— ✅ 可用（授权 owner-confirmed；库内无 EULA，书面凭据待补）

两个子库目录内**没有任何 EULA / README / 许可证文件**，本核验无法给出原文要点。授权状态以主人确认为准（owner-confirmed）；PSE 官方许可口径与购买凭证（官方 EULA 原文）待补，补齐后在此记录，不凭记忆与传闻下结论。

## 三、授权状态与来源注记（不阻塞使用，书面项待补）

**授权状态**：全部 16 个 SoundMorph 子库、BOOM Mechanicals Designed、Pro Sound Effects First / Shanghai 统一记为 **owner-confirmed**——主人 2026-11-24 确认（item 37：「我都有授权，你不用操心」；Portals 与 Inner Circle 另确认「在正版购买范围内，用过正版下载替换/确认来源」）。这是主人的确认，不是库内文件能核实的事实；书面凭据（购买记录、官方 EULA）仍待补。检索结果的每条候选带 `rights: owner-confirmed`，没有任何子库因授权被排除。

### 来源注记（盘内有第三方渠道残留文件的 4 个 SoundMorph 子库）

只记观察到的事实，不外推；**建议以官方原盘替换拷贝**，不阻塞使用。索引中这 4 个子库的行带 `source_residue: third-party-files`（共 1874 条），检索输出标 ℹ来源注记。

| 子库（条数） | 痕迹文件 | 发现方式与现状 |
|---|---|---|
| Future Weapons 1（467） | `Ammunitions/About.zip`，内含 `About.txt`（「资源来源于互联网，请勿用于商业用途。更多资源请访问：www.LookAE.com」）与 LookAE.com / FCPX 资源站 / Audio Jungle 合集 `.url`；另有 GBK 乱码目录「更多免费资源下载」 | 首轮核验与 04:19 复查均在盘上（zip 形态） |
| Future Weapons 2（527） | `Source Recordings/About.zip`、`Designed/Explosions/About.zip`，内容同上；GBK 乱码目录同上 | 同上 |
| Portals（419） | `下载.url`（指向 lookae.com） | 独立复核发现；04:19 复查**已不在盘上** |
| Inner Circle（461） | `TM DISCOVER.nfo` | 独立复核发现；04:19 复查**已不在盘上** |

- **「其余子库没有痕迹」不成立，不能写**：其余 12 个 SoundMorph 子库（含 Mechanism）只在 2026-11-24 按扩展名查过全库非音频杂项文件（`.url`/`.nfo`/`.txt`/`.html`/`.lnk` 等），没读文件内容，也没查音频内嵌元数据，**未逐文件扫描**。
- **盘上现状**：Portals 的 `下载.url`、Inner Circle 的 `TM DISCOVER.nfo` 复查时已不在；这两个目录（及 FW1/FW2 `About.zip` 所在目录）的修改时间是 04:18，晚于其余子库的 02:53，与「有人清理过痕迹文件」一致，**未确认是谁、何时删的**。主人说明 Portals / Inner Circle 用过正版下载替换或确认来源，与此相符。清单仍按「观察到过」如实保留。
- 机器字段：`engine/audio/sfx_library.py` 的 `SOURCE_RESIDUE`（逐库痕迹清单，`--json` 的候选带 `residue_files`）与 `RIGHTS_STATUS`；改动后重跑 index 子命令重新生成索引。

### 待补书面项（非阻断）

1. **SoundMorph 单用户许可 vs NAS 共享盘**：2016 EULA 写明「Store the collection … on up to **two personal computers**」「No Remote Sites may have access to SoundMorph products … unless a multi-user license is purchased」（仅在「完成原单用户已开工的项目」时可向其他系统分享具体用到的声音）。本库放在家庭 NAS 共享目录（`nas-family` 组可读）。使用口径提示：被授权人本人的两台个人电脑内访问；多人共用要补多用户许可。
2. **BOOM 单用户**：EULA 写「granted only to a single user … and your assigns」，同上口径。库里只有 Mechanicals Designed 一个 BOOM 子库（96 条，物理目录在 `SoundMorph/Mechanicals Designed/` 下，与 SoundMorph 子库混放），购买凭证建议一并归档。
3. **PSE 官方 EULA 与购买凭证**：两子库库内无 EULA，见第二节第 3 项。
4. **SoundMorph 其余 15 个子库**的 EULA 版本按同一 2016 版**推定**（库内只有 Mechanism 随附原文），购买记录核对后可改为确认。

## 四、工程接入

- **索引**：`engine/audio/sfx_library_index.jsonl`（4.4 MiB，目录字典化压到 5 MiB 大文件红线内）。再生成：
  `node tools/env/py.mjs tools/sfx_library.py index --csv <库根>/音效库总目录.csv --defects <库根>/音效库瑕疵清单.txt`
- **检索**：`node tools/env/py.mjs tools/sfx_library.py search "水花" --dur-max 3`（中英关键词；中文经 UCS 词表翻成英文检索词）；程序内 `from engine.audio import sfx_library; sfx_library.search(...)`。接缝：选材流程（[sound.md](../../routes/directing/craft/sound.md) 阶段 1 锁池）里与 Freesound CC0 并列的候选池；混音时 `engine/audio/library.load(sfx_library.abs_path(候选['path']))`。
- **库根**：环境变量 `BEIMING_SFX_ROOT` 指向本机挂载点（sshfs / NFS 两可），未设时 `abs_path()` 返回 None，作品照旧走程序化合成——CI 无库环境优雅降级，检索本身只用仓库索引、离线可跑。
- **授权字段**：每条候选带 `rights: owner-confirmed`（全部子库，主人确认，见第三节）；盘内有第三方渠道残留文件的 4 个子库（FW1 / FW2 / Portals / Inner Circle，1874 条）索引行另带 `source_residue: third-party-files`，`--json` 候选带 `residue_files`（痕迹文件清单），人类可读输出标 `ℹ来源注记`。只注记，不排除、不阻塞。
- **瑕疵标记**：145 个「.wav 实为 AIFF、主人确认已改名 .aif」的文件带 `defect: aiff_renamed_from_wav`（内容完好；**决定（2026-11-24，协调者拍板）：默认排除保持不变**，要用时 `search --include-defective` 或 `sfx_library.search(include_defective=True)` 放开，放开后混音前建议先用 `ffmpeg` 实读一次确认能解码）；33 个 0 字节空文件已删、不在索引。检索默认排除带标记的行。
- **验收数字**（2026-11-24，索引全量 15784 条，默认排除瑕疵标记）：水花 225、脚步 4317、金属碰撞 7740、机械齿轮 2572、爆炸 4201、怪兽吼叫 3320、电流能量 3711 命中；剪纸 383 / 折纸 7（库内只有纸袋类纸质素材，剪纸折纸仍走程序化合成与 Freesound）；挥砍破空 4728 但中文展开偏泛（冰/武器/陶瓷），精确检索用英文 `whoosh swing sword`（765 命中）。

## 五、义务与做法（agent 与人共用）

- 音频本体只读挂载使用，不入仓、不复制进仓库或作品目录；成片里的渲染属于 EULA 授予的同步/机械权。
- 派生参数文件、切片缓存等中间体留制作机本地，不入仓、不分发、不做成素材库或回放系统。
- 署名：BOOM 与 SoundMorph 的 MEDIA LICENSE 均无署名义务；作品 credits 里致谢是可选的好习惯（建议句式：Sound effects courtesy of BOOM Library / SoundMorph）。
- 全部子库按 owner-confirmed 可用于交付成片；带 `ℹ来源注记` 的 4 个子库建议先用官方原盘替换拷贝（不阻塞）。
- 其余 12 个 SoundMorph 子库未逐文件扫描，见第三节；SoundMorph 单用户 / NAS 共享口径与 PSE 书面凭据见「待补书面项」，补齐后改记。
