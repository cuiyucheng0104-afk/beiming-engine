# {{TITLE}}（C 路线 · 北冥代码动画风格）

8 秒、90 BPM、4/4 的水墨小品：三笔山、云、题字、钤印，声音全部合成。它是"最小但有工艺的示范"——换风格时**留骨架、换画法**：骨架是 film.json → timeline.js → film.js / mix.py → 拍点核对这条单一时间线；画法是 film.js、brush.js、paper.js、seal.js 和 mix.py 里的乐器与拟音。

## 改哪里

| 想改 | 改这里 | 注意 |
|---|---|---|
| 片长、帧率、画幅、海报帧 | `film.json` 的 `output`（`width`、`height`、`fps`、`frameCount`）与 `posterFrame`；兼容镜像 `dur` / `fps` / `size` 一起改 | 新建时用 `--profile` 选交付档位最省事（如 `vertical-1080x1920-30`）；两边都是偶数；横竖构图按画幅自动选 |
| 节奏与打点 | `film.json` 的 `tempo`（段落 `{id, t0, bpm, meter}`）、`cues`（`[段落, 小节, 拍, 拍内分数]`） | 打点必须落在整帧上：选每拍整帧的速度（24 fps：90 BPM 16 帧、120 BPM 12 帧；30 fps：90 BPM 20 帧），写错页面会报出可选值 |
| 动作提前几拍起 | `timeline.js` 的 `ACT` | 从打点倒推（"提前 3/4 拍起笔"），不写绝对秒，改速度时窗口跟着伸缩 |
| 构图、笔路、笔压、墨色 | `film.js` 的 `LAYOUTS` 与 `MAIN` / `SECOND` / `FAR` / `WATER` | 笔压同时决定粗细和快慢，字段说明在 `brush.js` 开头 |
| 片名、印文、字体 | `film.js` 的 `TITLE`、`SEAL_TEXT`、`FONTS` | 见下面"字体"；片名在 `film.json` 的 `title` 也要一致 |
| 声音 | `mix.py` | 落在打点上的音乐起音用 `ON.mark(t, cue)` 登记，拍点核对拿它对 |

新加打点、事件随意；删掉 `timeline.js` 里 `NEED` 列出的打点，要同时改 film.js 与 mix.py（页面会报缺哪个）。

## 出片

在仓库根目录：

```sh
node engine/render/still.mjs films/{{NAME}} 0.25 1.33 2.67 6 7.5 --size 1920x1080 --out films/{{NAME}}/out/stills   # 关键帧（look 闸）
node engine/render/build.mjs films/{{NAME}}                                                                        # 出片
node tools/qa/cli.mjs report films/{{NAME}}/out/{{NAME}}.mp4 --film films/{{NAME}}                                  # 机器 QA
```

`build.mjs` 依次做：事件表 → `mix.py` → 拍点核对（`CUECHECK OK`）→ 逐帧 → 封装到 −14 LUFS → 海报 → 帧数与尺寸核对，成片在 `films/{{NAME}}/out/{{NAME}}.mp4`。声音脚本的 Python 由环境变量 `BEIMING_PY` 指定，要装有 numpy、scipy、numba、soundfile：`npm run setup` 之后，用 `node tools/env/py.mjs --which` 查看仓库选中的解释器，把它设给 `BEIMING_PY`。竖屏的 `--size` 写 `1080x1920`。QA 报告写在 `out/qa/`，硬门不通过时退出码为 4。

## 字体

片名与印文用马善政毛笔楷书（OFL），由 C 路线自带的分片字体提供（`routes/c-style/fonts/`）。它包含 GB 2312 的 6763 个简体汉字，页面只下载片名用到的那几片。片名或印文里有字体缺的字（繁体、生僻字）时，页面会在控制台报 `[字体缺字]`（渲染日志里能看到），`window.TEXTS` 每条的 `missing` 会列出缺的字，QA 的 `texts.glyphs` 也不会通过。这时画面已经回落到系统字体，换一台机器字形就会变，不能交付。

修法：做一份含这些字的 OFL 字体子集，连同许可文件放进作品的 `fonts/`，在 `film.js` 的 `FONTS` 最前面加一项 `{ family: '…', src: './fonts/<文件>.woff2' }`，并在 `film.json` 的 `credits` 写上它的来源与许可；或者换字。

## 工艺对照（模版示范了哪条规则）

| 规则 | 模版里在哪 | 依据 |
|---|---|---|
| 一个时间源 | 只有 `film.json` 写时间；页面导出 `events.json` / `timeline.json`，`mix.py` 和拍点核对读同一组数 | [风格动画 §5.3](../../routes/directing/craft/animation.md) |
| 拍点帧是结果帧 | `ACT` 从打点倒推：笔收、字落、印定都在拍点那一帧 | 风格动画 §5.4 |
| 每拍整帧 | 90 BPM 在 24 fps 下每拍 16 帧，在 30 fps 下 20 帧；拍内分数取 1/2、1/4 | 风格动画 §5.2 |
| 分层时钟 | 笔、字、印一拍二（`hold(f, 2)`）；镜头缓推与云走一拍一的平滑时间 | [画面设计 §5](../../routes/directing/VISUAL-DESIGN.md)；风格动画 §2 |
| 预备—动作—结果 | 第 0 帧笔先按下（藏锋圆头就是"钩子"）；钤印前半拍印影由虚到实落下 | 风格动画 §3.1 |
| 粗细即快慢 | `brush.js` 的 `reveal`：笔压重处慢、提笔处快、转折处顿；粗细差三倍以上；枯笔放在走得快的下坡和收笔 | [水墨 STYLE.md](../../cases/vendor/lemo-opuscar/styles/ink-wash/STYLE.md) §2、§5 |
| 飞白不碎成虚线 | 断墨按长尺度噪声整条预排，逐帧只揭开，不爬动 | 水墨 STYLE §5、§9 |
| 墨分五色、墨吃进纸 | `TONE` 五档；墨层先被纸齿掏出纤维，再 multiply 到纸上；湿笔垫晕 | 水墨 STYLE §2 |
| 纸纹分寸 | 云絮只有 ±1.2% 明暗；纤维按设计像素定尺度，4K 下不会变成一层细噪点 | [代码渲染视频工程 §3.3](../../routes/directing/craft/video.md) |
| 留白与重心 | 留白约七成；主体在左下，题与印在右上对角平衡；竖屏另排一套，不是裁切 | 水墨 STYLE §6；画面设计 §4 |
| 一种强调色 | 朱红只给印 | 水墨 STYLE §3 |
| 题字与钤印的时序 | 题字提前一拍起笔、逐字自上而下浸出、落下时略湿；印比题字晚一拍落定 | 水墨 STYLE §4 |
| 静默反衬 | 题字前一拍只剩房间底噪（约 −49 dBFS），钤印靠前面的安静显出来 | 水墨 STYLE §7（原文要求整条总线归零；模版留房间底噪，免得听着像掉音） |
| 声画同源 | 每个打点都登记了一个音乐起音，拍点核对偏差 0 ms | 风格动画 §5.7 |
| 确定性 | 只用种子随机，不读时钟，不留上一帧状态；任意帧单独、乱序重渲结果一致 | 代码渲染视频工程 §2 |
| 字不回落 | 片名字体覆盖全部简体常用字；`type.js` 用 50% 探针字体查缺字，缺了就报；QA 的 `texts.glyphs` 按 cmap 复核 | 画面设计 §6.3 |

方法参考的水墨风格属第三方风格库（`cases/vendor/lemo-opuscar`，固定快照 bebbbe1，MIT，LemoLab）：只读学方法，本模版的代码是按描述自己写的；要搬代码就保留原作者版权与许可，规则见 `THIRD-PARTY.md`。
