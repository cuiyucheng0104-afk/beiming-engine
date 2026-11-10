# fonts/ 字体许可说明

本目录的字体全部是 **SIL Open Font License 1.1（OFL）**，可商用、可嵌入、可随作品分发，但不能单独出售字体本身。`*.woff2` 都是 **子集**：只含《北冥》显示层与片名用到的字，不是完整字体。子集由 Google Fonts CSS2 API 的 `&text=` 参数生成（2026-11-03 取得），来历见 `fetch_fonts.sh`；它们是《北冥》的冻结基准，**新作品不要重抓、不要改动**。

## 新作品的字体：锁定原始字体 + 按作品子集化

- `fonts.lock.json` 锁定完整的 OFL 原始字体（Ma Shan Zheng 2.003、Noto Sans SC 2.004、Barlow 1.408 三个字重）：版本、上游提交、下载地址、大小与 sha256、版权行、保留字体名。字体本体不进 git（决定 D10），`node tools/fonts/fetch.mjs` 一次下载到缓存目录 `.cache/fonts/`（或环境变量 `BEIMING_FONT_CACHE`）并逐字节核对。
- `licenses/` 是每款字体随发布的 OFL 全文（`fonts.lock.json` 里记了它们的 sha256）；子集化时随字体复制进作品目录。
- `node tools/fonts/subset.mjs films/<名>` 按作品 `film.json` 的 `texts`（画面文字白名单）与 `fonts`（字族 → 锁定字体）离线生成 `films/<名>/fonts/*.woff2` + `fonts.json` 清单；原始字体里没有的字直接失败并列出该字。页面用 `engine/style/fonts.js` 读同一份清单，画字前再核对一遍，缺字就报错，绝不回退系统字体。
- 子集化用 Python fontTools（`PYTHON` 指向装了 fonttools 与 brotli 的解释器）；同样的输入得到逐字节相同的子集。

| 文件 | 字体（字重） | 子集内容 | 用途 | 版权行（读自字体 name 表 ID 0） | 许可地址（name 表 ID 14） |
|---|---|---|---|---|---|
| `NotoSansSC-var.woff2` | Noto Sans SC，可变字重，取 300–500 | 约 60 个汉字与符号（字形 71 个） | 显示层中文、副标题 | (c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. | http://scripts.sil.org/OFL |
| `Barlow-300.woff2` `Barlow-400.woff2` `Barlow-500.woff2` | Barlow Light / Regular / Medium | 数字、`: . · … %`、`k m A I K M`（字形 54 个） | 显示层的时间、距离等数字 | Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow) | http://scripts.sil.org/OFL |
| `MaShanZheng-400.woff2` | Ma Shan Zheng（马善政毛笔楷书）Regular | 「北」「冥」两个字（字形 4 个） | 片名 | Copyright 2018 The MaShanZheng Project Authors (https://github.com/googlefonts/mashanzheng) | https://openfontlicense.org |

说明：
- 版权行与许可地址是用 Node 自带的 brotli 解压 woff2、直接读 `name` 表得到的，不是从网页抄的。
- Noto Sans SC 声明了保留字体名 **"Source"**。我们没有修改或改名字体文件（子集是 Google Fonts 官方服务生成的），如果以后自己再改字形或改名，要遵守下面许可第 3 条：修改版不能使用保留字体名。
- 页面里注册的字体族名是 `BM HUD Latin` / `BM HUD SC` / `BM Title`（只是 CSS 里的别名，不改动字体文件）。
- 成片若要列字体鸣谢，可写：Noto Sans SC（Adobe / Google，OFL）、Barlow（The Barlow Project Authors，OFL）、Ma Shan Zheng 马善政毛笔楷书（The Ma Shan Zheng Project Authors，OFL）。

## SIL Open Font License 1.1 全文

下面是标准 OFL 1.1 原文（与马善政项目随字体发布的 OFL.txt 逐字一致）。

```text
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
