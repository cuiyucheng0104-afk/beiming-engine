# A 路线 · 定调流程（LOOKDEV）

> **解决什么**：「用北冥画风做一部新片」或「定一种新的三渲二画风」时，按什么顺序把画风做出来、让用户签认、登记成可复用的版本。
> **最要紧的一条**：3–5 张钥匙帧经用户签认之前，**不许把片子做长**（look 闸，决定 D08）。九分钟版锁了画风、逐文件沿用原版，做完 540 秒才被否（`cases/entries/local-beiming-film-9min.md`）——风格锁和命名预设换不来认可，钥匙帧签认才是闸门。
> 字段口径以 [templates/STYLE-LOCK.md](../directing/templates/STYLE-LOCK.md) 为准；画面判据见 [VISUAL-DESIGN §1–§3](../directing/VISUAL-DESIGN.md)；参数含义见 [toon.md §3–§4](../directing/craft/toon.md)。

## 0. 先判断：用已登记的画风，还是定新画风

| 情况 | 做法 |
|---|---|
| brief 说「北冥画风」「延续原片」 | 直接用 `beiming-original@v1`：`film.json` 写 `"style": { "id": "beiming-original", "version": 1 }`，每镜 `lookPreset` 从 `wide / actor / hero / hero-sunrise` 里选；只在 `allowedOverrides` 的范围内调。跳到 §3 出钥匙帧 |
| 北冥画风 + 新的色彩段落（雾夜、灯海、月光……） | 这是**新版本**（`beiming-original@v2` 或新 id）：v1 只登记了日出段，其余四段没有任何参数（VISUAL-DESIGN §2）。从 §1 走 |
| 全新画风，或从 C 路线借一种画法 | 新 id，`derivedFrom` 写 null；先关掉北冥默认后期证明本体成立，再逐道加回（[craft/README §6](../directing/craft/README.md)）。从 §1 走 |

查已有的：`engine/style/registry.json`（`styles` 是登记过的版本；`candidates` 里的 `tonal-40` 是 8 组色板 × 5 套分阶的**实验候选**，用户没有选定任何一组，只能当起点）；鲲的六种造型、自测页与认可状态在同一文件的 `variants.kun`。

## 1. 参考入库与拆解

1. 参考图放 `films/<名>/refs/`，写 `refs/manifest.json`：每张一项 `{ file, source, rights, use }`。`rights` 写清是谁的、凭什么能用（VISUAL-DESIGN §7）；没有权利依据的参考只看不入库、不进画面。
2. 每张参考填一行拆解表（写进 `TREATMENT.md` §8）：

| 参考 | 明暗面积比 | 主体与背景明度差（OKLab ΔL） | 冷暖与主光方向 | 阴影色（换色相还是压暗） | 轮廓软硬与线色 | 纹理尺度（纸纹、笔触） | 二维与三维比例 |
|---|---|---|---|---|---|---|---|

拆解看的是能落到参数上的东西：每一列都对应 `engine/shade/toon.js` 或 `engine/look/` 的某几个参数（toon §3 参数地图）。

## 2. 校准场景

用模版当校准场景：`npm run new -- a <名>-look --title 定调`。固定机位、固定种子、固定时刻（模版的 S1 远景 1.5 秒、S2 日出前 3.6 秒、S2 片名之后 6.5 秒各一张），只改画风相关的数，不动构图和时间——这样每轮对照的差异只来自参数。

## 3. 钥匙帧（3–5 张）

用正片代码出图，不用参考图拼贴、不用别的工具画：

```sh
node tools/fonts/subset.mjs films/<名>
npm run film -- stills films/<名> --times 1.5,3.6,6.5                 # 钥匙帧 + 联系表，在 out/<运行号>/stills/
npm run film -- stills films/<名> --times 1.5,6.5 --query sil=1       # 剪影检查（三维主体涂黑、白底、不过后期）
```

每张钥匙帧配三样检查，结果写进 `review/`：剪影（`sil_*.jpg` 缩到 160 px 宽仍认得出主体）、灰度缩略图（`ffmpeg -i <帧> -vf "format=gray,scale=240:-2,gblur=sigma=2" <缩略图>.png`，主体是第一落点）、与基准帧的同帧对照（北冥画风对 `media/shot_*.jpg`）。再出一条色彩脚本条（每镜一张，时间顺序并排，`python tools/contact_sheet.py`）。

## 4. ⛔ look 闸：用户签认

把钥匙帧、色彩脚本条、剪影与灰度检查交给用户。用户的原话、出处、所看文件的 sha256 记进 `films/<名>/review/look-<日期>.json`（`npm run film -- review approve look films/<名> --quote "<原话>" --source "<出处>" --reviewer "<审阅人>"`）。用户没看过就不能写「认可」；用户说「不用给我看」也要原话记成豁免。签认之前：不扩展时长、不做第二个镜头、不登记画风版本。

## 5. 色板锁定

色板写成十六进制 + 职责（只给谁）+ 禁用场合；强调色写清出现几次、占多大面积（VISUAL-DESIGN §1「颜色规则的四条通则」）。主体与紧邻背景的明度差不少于约 0.15（OKLab ΔL）；不够时写明由墨线、边缘光、色相差、彩度差里的哪两项承担分离。模版 `world.js` 的 `PAL` 是一个写法范例：每色一个注释写职责。

## 6. 逐层扫参

按六步顺序，每步只动一层、留一组对照（`docs/routes/beiming-style.md:140-147`）：灰模与轮廓 → 反照率（关后期）→ 分档与投影 → 边缘光与表面纹理 → 底板、雾与空间 → 线宽、笔触、纸纹与颗粒。用扫参工具出网格，不要改一个数渲一张：

```sh
node tools/lookdev/sweep.mjs films/<名> --t 1.5,6.5 --look kuwahara.radius=1.6,3,4 --look kuwahara.farRadius=6,7.5 --query notext=1
node tools/lookdev/sweep.mjs films/<名> --t 6.5 --look "grade.lift=[0.02,0.012,0.045],[0.05,0.04,0.05]" --look grade.warmth=0.12,0.2
node tools/lookdev/sweep.mjs . --t 1.0 --q test=look --q kr=3,5,7      # 自测页 lab/look.js 的查询参数也能扫
```

产物在 `films/<名>/out/lookdev/<名字>/`：每格无损 PNG、`cells.json`（参数、时刻、sha256、源提交）、`grid.png`、离线对照页 `index.html`。同样的参数两次运行逐字节相同。扫参的覆盖不受 `allowedOverrides` 限制——它就是用来找新数值的；找到之后要么落进 `lookOverrides`（在允许范围内），要么写进新版本（§7）。成片里不能带 `?lookdev=`。

## 7. 写入画风版本

签认过的画风才登记：

1. 复制 `engine/style/beiming-original.v1.json` 为 `engine/style/<id>.v<N>.json`，改 `styleId`、`version`、`derivedFrom`、`sourceCommit`；填 `palette`、`colorScript`、`light`、`shading`、`line`、`brush`、`texture`、`grade`、`typography`、`layout`、`camera`、`motion`、`form`、`valueStructure`、`soundPalette`、`overlay`（字段见 STYLE-LOCK.md §2）。
2. `lookDefaults`（交给 `createLook` 的默认后期）与 `lookPresets`（每类镜头一套每帧参数，例如远 / 中 / 近、日出前 / 后）是渲染真正读的部分；`allowedOverrides[].paths` 写镜头级允许调的参数路径与范围（`[下限, 上限]` 或 `"any"`），页面按它严格检查。
3. `status.userApproval` 只能按用户原话写：签认了写 `approved` 并填 `approvalEvidence`（look 闸的记录文件）、`approvedBy`、`approvedAt`；没有就写 `none` 或 `indirect`。
4. 在 `engine/style/registry.json` 的 `styles` 加一项（`id`、`version`、`file`、`lookPresets`、`baselineFrames`）。
5. 自检：`node tools/repo-check.mjs --only route-a` 无错误（锁定文件合格、预设可解析、作品引用的 `lookPreset` 都登记过）。

**什么时候必须升版本**：换色板、换光照公式、换后期顺序或增删一道后期、把 `allowedOverrides` 外的参数改成别的值（`newVersionWhen`）。景别改变笔触半径这类在允许范围里的调整不升版本。

## 8. 之后

画风定了才写镜头表与事件表（`film.json` 的 `shots`、`events`），再走动态预演（`?animatic=1`，animatic 闸）和终渲（final 闸）——见路线手册 [README.md](README.md)「最快上手」的十步表。

## 9. 常见错误

- 跳过钥匙帧直接做整片；或者把参考图、别的工具出的图当钥匙帧。
- 在镜头模块里直接写后期数值（绕开注册表）；或者给 `lookOverrides` 写超出范围的值后把 `strict` 关掉。
- 把 `tonal-40` 的某一组当成「用户选过的画风」；把 `indirect` 写成 `approved`。
- 改了 `src/` 原片去试画风（原片是基准，只读）。
