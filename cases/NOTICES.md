# 来源、权利与署名

本目录是历史创作档案。它把项目放在一起，不把所有代码、影片和素材重新声明为北冥原创或 MIT。归档源码与文本的许可是 [LicenseRef-Casebook-Archive](../LICENSES/LicenseRef-Casebook-Archive.txt)；客户与第三方素材的权利方、授权范围和状态登记在 [授权登记册](../docs/rights/register.md)（不知道的字段写「待补」）。

- 北冥原创代码按仓库根许可；新增归档工具也按 MIT。
- 历史风格项目使用、复制或改写了 LemoLab 的模块。凡能逐字核对的文件，`catalog.json` 的 `upstream` 提供固定提交和路径；没有该字段不等于证明完全原创。保留 [LemoLab MIT 声明](licenses/LemoLab-MIT.txt)，适用于该来源的代码及其改写部分。
- sy-style-100 与 lemo-opuscar 的完整跟踪文件均按固定版本收入 vendor/，保留原始文件。保留 [肖雄 XIAOXIONG MIT 声明](licenses/XIAOXIONG-MIT.txt) 和外部链接，后续实际取用仍应保留署名。
- 打包或包含 Three.js 的历史项目遵循 [Three.js MIT](licenses/three-MIT.txt)。其他嵌入的库、字体、采样和媒体按各工程原有 LICENSE / CREDITS / 来源标注处理，不能被本仓库的根许可覆盖。
- **字体**：75 个案例带字体文件（多为 Noto、IBM Plex、Barlow、马善政、站酷等 SIL OFL 1.1 字体，版权行写在各案例的 CREDITS 里）。许可全文见 [OFL-1.1.txt](licenses/OFL-1.1.txt)；子集化、转格式在 OFL 里也算修改版。`casebook.py restore` 还原带字体的案例时，会把 OFL 全文复制到还原目录的 `ARCHIVE-LICENSES/`。
- **署名义务**：用到 CC BY 采样的成片随附署名，原文见下表；分发这些成片（Release 的原片包与观看预览）时一并给出。署名写进 Release 说明属于公开动作，要用户授权后由维护者执行。
- PPT 原画、设定、品牌标识、演员配音、生成音乐、影片和素材包仅作为已有项目展示与学习参考，保留原权利范围；归档不额外授予商业复用权。不要将例片中的商标解释为官方背书。`catalog.json` 里 `rights.clearance` 为 `internal` 的案例与素材（客户材料、第三方 IP、参考图）`restore` 默认不还原，不得用进新作品或对外物料。
- 电影镜头分析类预演只归档自制程序、拟合数据和自己的输出；未打包 `ref/` 下的原电影片段。它们不属于正式客户作品。

## CC BY 署名

由 `node tools/env/py.mjs tools/casebook.py index` 按 `catalog.json` 的 `rights.attributionText`（取自各案例的 CREDITS）生成。

<!-- casebook index:署名 开始（由 tools/casebook.py index 生成，不要手改） -->
| 署名原文（照录案例 CREDITS） | 用到的案例 |
|---|---|
| Drums: "MuldjordKit" by Lars Muldjord (drumgizmo.org), FreePats version, licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) | [style-16-swiss-motion](entries/style-16-swiss-motion.md)、[style-18-art-deco](entries/style-18-art-deco.md)、[style-32-microgame](entries/style-32-microgame.md)、[style-33-game-show](entries/style-33-game-show.md)、[style-46-living-screencast](entries/style-46-living-screencast.md)、[style-48-midcentury-toon](entries/style-48-midcentury-toon.md)、[style-63-caption-news](entries/style-63-caption-news.md)、[style-69-telestrator](entries/style-69-telestrator.md)、[keynote-C-kaitou](entries/keynote-C-kaitou.md)、[keynote-C-quanpian](entries/keynote-C-quanpian.md) |
| Piano: "Salamander Grand Piano V3" by Alexander Holm, licensed under CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/) | [style-62-archive-lighttable](entries/style-62-archive-lighttable.md)、[ppt-understands-you](entries/ppt-understands-you.md)、[keynote-B-kaitou](entries/keynote-B-kaitou.md) |
| 采样：鼓组 "MuldjordKit" by Lars Muldjord (drumgizmo.org), FreePats version CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) | [style-27-cel-anime-80s](entries/style-27-cel-anime-80s.md) |

<!-- casebook index:署名 结束 -->

## 其他

外部索引包含上游风格名称、技术标签和源文件链接，详见 [references.json](references.json)。项目状态优先看案例卡和 `catalog.json`（技术状态、用户认可、权利三者分开记录）；历史源文件中“已交付/已完成”等旧措辞不替代后续用户反馈。
