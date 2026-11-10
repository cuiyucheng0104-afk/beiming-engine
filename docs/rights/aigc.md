# AI 生成内容的标识与来源链（决定 D11）

读者｜做片的人与 agent、写对外材料的人、出片与 QA 工具的维护者　状态｜生效（2026-11-10）　依据｜决定 D11；审计 COMP-04；《人工智能生成合成内容标识办法》（2025-09-01 施行）与配套国家标准 GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》

**一句话**：作品里只要有 AI 生成的画面、配音或配乐，就同时做**显式标识**（观众看得见的一句话）和**隐式标识**（写进成片元数据）；生成的原图保留 C2PA，处理过的派生图在清单里记来源链；对外描述照实说，不把 AI 生成的底板写成「手绘」或「代码逐帧绘制」。

本页是本仓库的执行口径，不是法律意见；法规与标准以正文为准，标准里的具体参数在发布前要再核对一次。

## 哪些算 AI 生成内容

| 内容 | 本仓库里的例子 | 证据 |
|---|---|---|
| 绘画底板与参考图 | 《北冥》13 张底板（Midjourney V8 与 GPT Image 2.5 生成后人工整理）、风格参考图 `assets/ref/sky_test.png`（带 OpenAI 签名的 C2PA） | `assets/plates/plates.json` 的「生成」字段 |
| 客户片的原画 | PPT 故事介绍片的原画（图像生成工具制作） | [register.md](register.md) R02、R08 |
| 材质与关键帧 | 发布会动画的材质（本地 Qwen-Image）、动画 PV 的关键帧（Qwen 编辑） | register.md R08 |
| 配音 | MiniMax 语音合成、Edge 在线朗读 | register.md R09 |
| 配乐 | MiniMax-Music3 | register.md R09 |

纯代码逐帧算出来的画面（三渲二形体、着色、墨线、程序化纹理）不算 AI 生成；但一部片只要用了上面任何一种，整部片就「含 AI 生成内容」。

## 显式标识（观众看得见）

固定文字，按实际情况选一句或几句，用「；」连接：

| 情况 | 文字 |
|---|---|
| 画面里有 AI 生成的底板、原画、材质或关键帧 | **含 AI 生成画面** |
| 配音由 AI 合成 | **配音为 AI 合成** |
| 配乐含 AI 生成 | **配乐含 AI 生成** |

写在哪：

1. **片尾**：署名卡或片尾最后一屏写上述文字。参照 GB 45438-2025 对视频显式标识的做法：文字清楚可读，字高不小于画面短边的 5%，停留不少于 2 秒（以标准正文为准）。片尾停留时长要算进 film.json 的时间轴与 QA 的文字停留检查。
2. **作品说明**：Release 说明、作品站的作品卡、README 的作品介绍里各写一次。
3. **发布到平台时**：按平台提供的「AI 生成」声明功能勾选（这一步由用户在平台上操作）。

## 隐式标识（写进成片元数据）

成片 mp4 的 `comment` 元数据写一段 `AIGC{…}` 加一句人读说明。字段名参照 GB 45438-2025 文件元数据隐式标识的字段（以标准正文为准），我们作为内容制作方自愿写入：

```
AIGC{"Label":"1","ContentProducer":"<制作方>","ProduceID":"<作品 id>@<run-id>","ReservedCode1":"","ContentPropagator":"","PropagateID":"","ReservedCode2":""} 含 AI 生成画面（生成工具：Midjourney V8、GPT Image 2.5）
```

| 字段 | 取值 |
|---|---|
| `Label` | `"1"`：属于 AI 生成合成内容（我们的片子只要用了就写 1） |
| `ContentProducer` | 制作方。法律主体待补（[register.md](register.md) R12），暂写「北冥引擎 Beiming Engine」 |
| `ProduceID` | `<film.json 的 id>@<run-id>`，与 `films/<名>/out/<run-id>/run.json` 对得上 |
| `ContentPropagator`、`PropagateID` | 留空（由传播平台填写） |
| 后面的说明 | 显式标识的固定文字，括号里列生成工具 |

**不要手写这串文字**，用工具生成：

```bash
node tools/compliance/aigc.mjs label --id beiming-10s --run 20261110-160000-abc1234 --tool "Midjourney V8" --tool "GPT Image 2.5"
node tools/compliance/aigc.mjs check films/<名>/out/<run-id>/web.mp4     # 用 ffprobe 读回核对；缺失或不合规退出码 4
```

编码器（`engine/render/`、`tools/film/`）直接调用 `tools/compliance/lib/aigc.mjs` 的 `ffmpegMetadataArgs()`，把返回的参数数组拼进 ffmpeg 命令（按数组传参，不经过 shell，Windows 与 macOS 一样）。机器 QA 门用 `parseImplicitLabel()` 判定：film.json 里 `aigc.contains` 为 true 的作品，成片没有合规的隐式标识就不通过。

## 来源链与 C2PA

- **生成的原图**：保留生成服务写入的 C2PA 清单（PNG 的 `caBX` 块、JPEG 的 APP11 段）。原图不要经过会剥掉元数据的转换再入库。
- **处理过的派生图**（裁切、调色、去脏、放大、去背景）：常见的处理流程会丢掉 C2PA——《北冥》13 张底板就是这样丢的（审计 COMP-04：这是**流程会丢失隐式标识，需要修复**，不是有意删除）。二选一补上：
  1. 用 C2PA 工具给派生图写一份新清单，把原图列为成分（ingredient）；
  2. 在底板清单（如 `assets/plates/plates.json`）里，清单顶层写「生成」字段（工具、模型版本、共用参考图、后处理），**每张底板**再写一个「来源」对象：

     ```json
     "来源": { "工具": "Midjourney", "模型": "V8", "日期": "2026-11-02", "提示词": "prompts/sky_dawn.txt", "参考图": "assets/ref/sky_test.png",
               "原图sha256": "<原图的 sha256>", "操作": "<操作人>", "人工修改": ["去脏晕", "色彩对齐", "×2 放大"] }
     ```

     不知道的字段写「待补」，不要编。
- 查看现状：`node tools/compliance/aigc.mjs plates`（逐张列出有没有 C2PA、有没有来源记录）。

## film.json 怎么写

作品描述 film.json（v2，字段定义归作品描述的属主）里声明：

```json
"aigc": { "contains": true, "note": "绘画底板为 AI 生成后人工整理；配音为 AI 合成" }
```

不含 AI 生成内容就写 `"contains": false`。出片编排据此决定要不要加片尾标识与隐式标识，QA 据此核对。用到的生成服务与音色写进 `credits`。

## 对外描述

- 不写：「手绘底板」「底板由代码逐帧绘制」「纯代码生成的画面」（画面里有 AI 生成底板时）。
- 写：「AI 生成（Midjourney V8 / GPT Image 2.5）后经人工整理的绘画底板；镜头、着色与后期由代码逐帧完成」。
- 「手绘质感」「手绘风」描述的是画风，可以用；描述**制作方法**时照实说。

## 生成服务的条款

各服务的使用条款与套餐（例如审计提示 Midjourney 对年收入超过 100 万美元的公司要求 Pro 或 Mega 套餐）由用户核对实际账号，结论登记在 [register.md](register.md) 的 R08、R09；没核对过的音色与生成图不用于新的对外交付。

## 存量作品怎么处理

- 已发布的 v1.0 Release 附件不覆盖（D05）；重渲《北冥》时按本页加显式与隐式标识，另发版本。
- 历史案例（`cases/`）的成片不逐个重做；在案例卡与作品站作品卡的说明里补显式标识，由案例库与作品站的属主处理。
- 修改 Release 说明属于公开动作，需要用户授权后执行。

## 机器检查

| 检查 | 命令 | 判据 |
|---|---|---|
| 入口文档措辞 | `node tools/compliance/scan.mjs --only aigc` | 入口文档（README、AGENTS、ROUTES、docs/TRACKS、路线手册、作品站首页）里出现「手绘底板」或「底板…代码逐帧绘制」且同一行没有「AI」「生成」之类的限定 → 阻断 |
| 底板来源链 | 同上 | 底板清单没有清单级生成记录 → 阻断；有底板既无 C2PA 也无逐张「来源」→ 提示 |
| film.json 声明 | 同上 | 作品或模版的 film.json 没有 `aigc.contains` → 提示 |
| 成片隐式标识 | `node tools/compliance/aigc.mjs check <成片>` | 缺 `AIGC{…}`、Label 不是 1/2/3、缺制作方或作品编号、缺人读说明 → 退出码 4 |
