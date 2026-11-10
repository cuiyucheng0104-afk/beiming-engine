# C 路线 · 片名字体（马善政毛笔楷书）

C 模版的片名与印文用这套字体。它是马善政毛笔楷书（Ma Shan Zheng）的全部 7015 个字符，包括 GB 2312 的 6763 个简体汉字，所以新片换任何常用简体片名都不缺字。仓库 `fonts/` 下的同名子集只有「北」「冥」两个字，只够《北冥》使用。

| 项 | 内容 |
|---|---|
| 文件 | `mashanzheng-00.woff2` … `mashanzheng-12.woff2`，共 13 片，合计约 3.3 MB。每片按码位区间切分，配有自己的 `unicode-range`，区间写在 [fonts.json](fonts.json) |
| 许可 | SIL Open Font License 1.1，全文见 [OFL.txt](OFL.txt)。可以商用、嵌入、随作品分发，但不能单独出售字体本身。上游没有声明保留字体名 |
| 版权行 | Copyright 2018 The Ma Shan Zheng Project Authors (https://github.com/googlefonts/mashanzheng) |
| 来源 | google/fonts 仓库固定提交 `406197b` 下的 `ofl/mashanzheng/MaShanZheng-Regular.ttf`，sha256 `6d2546bb…88b7fb`。按原始字体的 cmap 取码位，每 540 个字一片，再用 Google Fonts CSS2 API 的 `&text=` 参数取官方子集（woff2）。仓库 `fonts/` 下的现有子集也是这样生成的 |

## 作品怎么用

模版的 `film.js` 在 `FONTS` 里登记 `{ family: 'BM Brush', manifest: '../../routes/c-style/fonts/fonts.json' }`，`type.js` 按清单为每片登记一个 FontFace。页面只下载片名和印文实际用到的那几片，通常是 1–3 片。作品必须放在 `films/<名字>/` 这一层，相对路径才对得上。

- 片名里有繁体字或 GB 2312 以外的生僻字时，页面会报 `[字体缺字]`，QA 的 `texts.glyphs` 不会通过。这时把含这些字的 OFL 字体（附带许可文件）放进作品的 `fonts/` 目录，在 `FONTS` 最前面登记 `{ family, src: './fonts/<文件>' }`；或者改用简体字。
- 成片要在 `film.json` 的 `credits` 里写明这套字体（模版已经写好，照抄即可）。

## 核对与重新生成

```sh
node routes/c-style/fonts/fetch.mjs --check    # 离线核对：每片的 sha256、大小与清单一致，cmap 正好覆盖清单列出的码位，OFL.txt 在
node routes/c-style/fonts/fetch.mjs --fetch    # 联网重新生成（会覆盖现有文件），只在要换字体版本时用
```

`npm run check:repo` 的 `route-c.fonts` 规则会做同样的离线核对。不要手改分片或清单。

以后如果 `fonts/` 提供了同一字体的完整版，或者按作品自动子集化的工具，就把模版的 `FONTS` 改过去，再删掉这个目录，避免同一字体在仓库里存两份。
