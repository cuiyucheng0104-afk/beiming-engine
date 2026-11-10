# 2026-11-10 · D05 调查：公开成片里的红珊瑚从哪来

读者｜集成负责人、用户、作品站属主　状态｜调查完成，处理方式待裁定　依据｜决定 D05；差距 ENV-02、CRAFT-10　机读版｜[../media-provenance.json](../media-provenance.json)

## 结论

1. **红珊瑚版成片不是任何一个提交的代码渲出来的。** 它出自 v1.0 提交前约 8 分钟的工作区：当时新写的 `engine/core/noise.js` 初稿用「从后往前」的 Fisher–Yates 洗牌建置换表，而样片原来用的 simplex-noise 4.0.3 是「从前往后」。两种洗牌都对，但消耗随机数的顺序不同：同一个种子得到不同的置换表、不同的噪声场。鲲身上海藻、珊瑚、海葵的分布权重（`src/kun.js` 用两张 3D 噪声算 wWeed、wKelp、wCoral……）和镜头 B 人物的发丝、墨线、纸纹（`src/girl.js` 的四张 2D 噪声）全变了，红色鹿角珊瑚和扇珊瑚正好落在第 177、182 帧鲲背的可见轮廓上，镜头 C 的构图也因此看起来「略有不同」。
2. **两分钟后初稿就改对了，但整片没有重渲。** 作者对比静帧发现镜头 C 与样片差很多，把置换表改成从前往后（与 simplex-noise 逐位相同），重渲静帧确认与样片一致；之后复制进 `media/` 的 `beiming.mp4` 却是改之前那次构建的网页版。v1.0 提交和 Release v1.0 的 1080p 附件就是它，`preview.gif` 与后来的 `beiming-1280.mp4` 都由它转出。
3. **有意还是意外**：用自写噪声替换第三方依赖是有意的；改正置换表、对齐样片也是有意的；**把旧产物当成片发布是意外**。代码从 v1.0 起渲出的就是用户项目档里存档的「07:40 版」样片的画面，没有发生回归。
4. **D05 的两个分支都对不上**：不是「仓库改动造成回归」（代码没变过这一处），也不是「有意改了画面」（公开成片本身就不是代码的画面）。建议按「以现代码版为准」处理：重渲 media 并另发 v1.0.1，不覆盖 v1.0 的附件（第 5 节 A）。如果用户更想要红珊瑚的画面，修回要改 3 个文件（第 5 节 B）。这一步由集成负责人报用户裁定。

## 1. 时间线（UTC）

| 时间 | 事件 | 出处 |
|---|---|---|
| 11-02 23:39–23:40 | 样片工程（仓库建立前的工作目录）出「07:40 版」：整片、网页版、静帧；后存档为用户项目档的 `北冥样片_0740版_*`，也是 4K 实测对比报告的对象 | 文件时间、4K 对比报告 |
| 11-03 16:52:03 | 新建仓库：从样片工程复制 `src/`、素材、字体，打原生 4K 补丁（1040 高时与原来逐字节相同） | 本机会话记录 |
| 16:53:12–16:53:54 | 写自己的底座 `engine/core/math.js`、**`noise.js` 初稿**、`stroke.js`，替换上游的数学库、simplex-noise、perfect-freehand | 同上 |
| 16:57:43 | `PYTHON=… sh build.sh`：静帧 → 混音 → 视频 → 封装 → 网页版 `out/beiming_web.mp4` | 同上 |
| 16:59:15 | 静帧与样片对比：镜头 C 5.5–9.0 秒 PSNR 19.9–23.2 dB，差 >8 级的像素 13.6–26.1% | 同上 |
| 16:59:32 | `noise.js` 置换表改为从前往后 | 同上 |
| 16:59:46 | 重渲 8 张静帧：0、1.5、6、7 秒与样片逐像素一致；3.5、4.5、8.5、9.5 秒 48–62 dB（自写笔触与 perfect-freehand 的细微差别） | 同上 |
| 17:00:19 | 后台 `build.sh --4k --no-audio`（改正之后）→ `out/beiming_4k.mp4` | 同上 |
| 17:01:02 | `cp out/beiming_web.mp4 media/beiming.mp4`（**16:57:43 那次构建的产物**）；同一条命令里用 `still.mjs` 重渲 `media/shot_*.jpg`（改正之后） | 同上 |
| 17:05:06–17:05:20 | 由 `media/beiming.mp4` 转出 `media/preview.gif` | 同上 |
| 17:05:39 | 提交 `ed11b83`（v1.0）：改正后的 `noise.js` + 旧的 `beiming.mp4` | git |
| 17:07:48 | `gh release create v1.0 out/beiming_4k.mp4 media/beiming.mp4` | 本机会话记录 |
| 11-09 13:42 | 作品站第二轮：`tools/build-showcase.py --make-film-1280` 从 `media/beiming.mp4` 转出 `media/beiming-1280.mp4`（元数据 comment 记原片 sha256） | 作品站会话记录、文件元数据 |

本机会话记录指仓库作者机器上的 Claude Code 会话文件，不在仓库里；表中命令与输出原样摘自其中。

## 2. 复现

### 2.1 历史提交逐个渲同一时刻

仓库的根提交就是 v1.0（`ed11b83`），之后改动 `src/` 的提交是 `3bf6ca3`、`b9d96d6`、`e9e7273`、`62ad28e`。v1.0 与 62ad28e 之前的 HEAD 在 t = 7.375 的渲染 md5 相同（ENV-02 的核实）；62ad28e 在 1080 上只改了渡船航行灯、鸽群和导航线线头三处（见 [2026-11-10-darwin-metal-g0.md](2026-11-10-darwin-metal-g0.md)），镜头 C 鲲背不在其中。用 `golden compare --against ed11b83` 复核：现代码与 v1.0 在 4.0、9.9 秒的 1080 画面逐像素一致，1.6、7.6 秒的差别全部来自这三处修复。**没有一个提交渲得出红珊瑚**，来源只能在提交之前。

### 2.2 把初稿换回 v1.0 再渲（11 个时刻，1080 JPEG q92 对成片解码帧）

| 时刻 | 成片 ↔ v1.0 | 成片 ↔ v1.0 + 噪声初稿 |
|---|---|---|
| 1.0、2.0（镜头 A） | SSIM 0.848–0.860，PSNR 32.1–33.0 dB | SSIM 0.858–0.867，PSNR 34.3–34.8 dB |
| 3.5、4.5（镜头 B） | 0.831–0.839，31.7–31.9 dB | 0.845–0.854，35.6–35.9 dB |
| 5.5–8.5（镜头 C，6 个时刻） | 0.677–0.758，19.8–22.5 dB | 0.816–0.847，31.4–32.8 dB |
| 9.5 | 0.816，29.8 dB | 0.839，33.4 dB |

成片是两代有损（crf 19 再两遍 9 Mbps）编码，满是颗粒的画面压缩损失本来就大，镜头 A 这样两版几乎相同的段落也只有 34–35 dB，这就是「同一画面」的上限。初稿在每个时刻都贴近这个上限，现代码在镜头 C 差了 10 dB 以上。第 177 帧裁切并排看：初稿版与成片同样是红色鹿角珊瑚、扇珊瑚，位置一致；v1.0 是绿苔团、海葵和飘带草。

### 2.3 整片 240 帧，走同一条 v1.0 管线

两个版本都用 v1.0 的 `video.mjs`（4 路）出帧，按当时 `mux.sh` 的视频参数（crf 19）和 `build.sh` 的网页版两遍 9 Mbps 重编码，再与 `media/beiming.mp4` 逐帧比（FFmpeg ssim / psnr）：

| | SSIM All | PSNR 均值（逐帧平均） | 镜头 A / B / C | 最差一帧 | 解码后逐位相同的帧 |
|---|---|---|---|---|---|
| v1.0 + 噪声初稿 | 0.9492 | 39.23 dB（41.54） | 47.7 / 40.6 / 38.2 dB | 36.72 dB | 9 |
| v1.0 原样 | 0.8838 | 27.68 dB（30.86） | 36.3 / 34.7 / 26.1 dB | 21.85 dB | 0 |

v1.0 原样这一行与 ENV-02 当初实测的 0.8836 / 27.68 dB 吻合。初稿版剩下的差距是两次独立的有损编码，另有 9 帧解码后与成片逐位相同。

### 2.4 media/ 里其它文件

| 文件 | 来源 | 复现 |
|---|---|---|
| `preview.gif` | 由 `beiming.mp4` 转出（命令见机读版） | 2026-11-10 重转，逐字节相同 |
| `beiming-1280.mp4` | 由 `beiming.mp4` 两遍转码，comment 记原片 sha256 | 两遍多线程 x264 不保证逐位相同；来源由 comment 证明 |
| `shot_1.6/4.0/7.6/9.9.jpg` | `ed11b83` 的 `still.mjs` 出 1920×1040，再缩到 1280×694 | 2026-11-10 从 `ed11b83` 重做，四张逐字节相同 |
| `styles.jpg` | 仓库建立前的「六版鲲对比图」裁切拼排（原图不在仓库里） | 用同一张原图重做，逐字节相同；仓库内不可复现 |

所以 `media/` 里的成片、动图、手机版和剧照、风格图互相矛盾：前三个是噪声初稿的画面，剧照是代码的画面。

## 3. 判定

| 改动 | 性质 |
|---|---|
| 用自写的 `engine/core/noise.js` 替换 simplex-noise（去掉第三方依赖） | 有意 |
| 16:59:32 把置换表改成从前往后、对齐样片 | 有意（修正初稿的偏差） |
| 把 16:57:43 的构建产物复制进 `media/`、上传 Release | **意外**：改正之后没有重渲整片就发布了 |

现代码的画面就是用户项目档里「07:40 版」样片的画面；红珊瑚版只在公开成片里存在过。

## 4. 影响面

- README 首屏动图、作品站的样片（`media/beiming.mp4` 与 `media/beiming-1280.mp4`，作品站构建时校验两者的 sha256 配对）、Release v1.0 的 1080p 附件——都是红珊瑚版。
- Release v1.0 的原生 4K 附件是改正之后渲的，没有红珊瑚：**同一个发布页的两个附件画面不一致。**
- `docs/routes/templates/project-beiming.json` 的 `style.baseline` 指向 `media/shot_7.6.jpg`：画面与代码一致，但是 1280×694 有损缩图，做不了像素对照；像素对照改用 [beiming-original@v1](../beiming-original@v1/README.md)。
- 62ad28e 之后代码又多了渡船航行灯、鸽群、导航线线头和 4K 观感的修复，`media/` 里所有文件都不带这些修复（PR #1 已注明「交付物没有重渲」）。

## 5. 两种处理

### A（建议）以现代码为准，重渲并另发 v1.0.1

| 步骤 | 文件 / 动作 | 属主 |
|---|---|---|
| 1 | 现代码出 1080 与原生 4K 成片，过 QA 门（规格、BT.709 tv、−14 LUFS） | 出片 CLI（P06）、QA 门（P07） |
| 2 | 替换 `media/beiming.mp4`；`python3 tools/build-showcase.py --make-film-1280` 重转 `media/beiming-1280.mp4`；按机读版的命令重转 `media/preview.gif`；按 2.4 的两步重渲 `media/shot_*.jpg` | `media/` 的属主；替换前通知作品站属主，只读跑一次 `site:build` 与 `site:qa` |
| 3 | 另发 Release v1.0.1（1080p 与原生 4K，说明写清与 v1.0 的差别和原因），**不覆盖、不删除** v1.0 的附件 | 用户授权后由集成负责人执行（公开动作） |
| 4 | 更新 `docs/style-baselines/media-provenance.json`（新的 sha256、来源提交 `sourceCommit`、`matchesCode: true`）；`styles.jpg` 改为用 lab 自测页现渲六张再拼 | P08 / 集成负责人 |

回归金标准不受影响：金标准本来就用现代码，不看 `media/`。

### B 修回红珊瑚的画面（只在用户明确要这一版时做）

| 文件 | 改什么 |
|---|---|
| `engine/core/noise.js` | 加一个显式选项，例如 `createNoise3D(random, { order: 'descending' })`、`createNoise2D(random, { order: 'descending' })`，按初稿的从后往前洗牌建置换表；**默认保持从前往后**：作品站首屏的 `src/kun_qinglv.js`、各自测页、C 模版都依赖默认值 |
| `src/kun.js` 第 155–156 行 | 两处 `createNoise3D(mulberry(o.seed + 11))`、`createNoise3D(mulberry(o.seed + 23))` 加这个选项（鲲的海藻 / 珊瑚 / 海葵分布） |
| `src/girl.js` 第 86–89 行 | 四处 `createNoise2D(mulberry(…))` 加这个选项（镜头 B 人物的发丝、墨线、纹理、纸） |

代价：`beiming-core`、`beiming-detail` 两套回归基线要经审批 `update`；认可参照另立 `beiming-original@v2`，v1 不改；仍要按 A 的第 2–3 步重转 `media/` 与发版（画面会是「红珊瑚 + 62ad28e 的修复」）。`engine/` 属引擎维护包，`src/` 是全员只读区，改动要用户授权。

## 6. 复跑本调查

```sh
# 1. 导出 v1.0 的页面（只读仓库，不建 worktree）：golden 工具同款导出，或者
git worktree add --detach <临时目录> ed11b83 && ln -s "$PWD/node_modules" <临时目录>/node_modules
# 2. 在临时目录里把 engine/core/noise.js 的 permutation() 换成初稿写法：
#      for (let i = 255; i > 0; i--) { const j = Math.floor(random() * (i + 1)); 交换 p[i]、p[j] }
# 3. 出帧并比较
node engine/render/still.mjs . 1 2 3.5 4.5 5.5 6 7 7.375 8.5 9.5 --out <输出>
node engine/render/video.mjs . --size 1920x1040 --fps 24 --workers 4 --out <输出>/video.mp4
ffmpeg -i <输出>/video.mp4 -vf fps=24,format=yuv420p -c:v libx264 -preset slow -crf 19 <输出>/v.mp4
ffmpeg -i <输出>/v.mp4 -c:v libx264 -preset slow -b:v 9000k -pass 1 -an -f null -
ffmpeg -i <输出>/v.mp4 -c:v libx264 -preset slow -b:v 9000k -maxrate 14000k -bufsize 18000k -pass 2 -pix_fmt yuv420p -an <输出>/web.mp4
ffmpeg -i <输出>/web.mp4 -i media/beiming.mp4 -lavfi "[0:v]split[a][c];[1:v]split[b][d];[a][b]ssim;[c][d]psnr" -f null -
# 4. 用完删除临时工作树：git worktree remove --force <临时目录>
```
