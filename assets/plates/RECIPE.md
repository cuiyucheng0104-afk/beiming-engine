# 底板配方：从生成到入库

读者｜给 A 路线作品做二维底板（天空、云、远景剪影、水面、雾）的人与 agent　状态｜生效　依据｜审计 CRAFT-03 / CRAFT-08 / COMP-04、决定 D10 / D11、[craft/two-five-d.md](../../routes/directing/craft/two-five-d.md) §2

《北冥》的 13 张底板怎么来的、新底板怎么做、入库前查什么。字段定义在 [plates.schema.json](plates.schema.json)，登记表是 [plates.json](plates.json)，准入检查 `node tools/plates/check.mjs`。

## 1. 先算要多大、要画出画框多少

1. **摆多宽**：在起始机位下按屏幕像素摆（`placeOnScreen`），记下每个用法在设计稿（1080 高）上的最大宽度 `screenWidth`，写进 `usage`。
2. **出血**：相机在这一段里怎么动，每条边就要画出画框多少——`node tools/plates/bleed.mjs --depth <米> --fov <度> --tx … --tz … --feather <羽化像素>`（two-five-d §2.1 的公式）。截断边、直线淡出的边永远留在画外。
3. **分辨率**：纹素密度 = 图宽 ÷（`screenWidth` × 档位高 ÷ 1080）。每个要交付的档位都 ≥ 1.0（低于 0.6 准入不过）。4K（`uhd-2160p24`）要的图宽是 1080 档的两倍——「原图 ×2 放大」只是把文件变大，细节没有变多（`check` 报告里的细节密度按原图尺寸 `sourceSize` 算）。

## 2. 生成

- 《北冥》的做法：Midjourney V8 与 GPT Image 2.5 生成，共用一张风格参考（`assets/ref/sky_test.png`，带 C2PA）与一句风格描述，再手工整理。**那句风格描述没有入库**，所以按同一配方复现做不到逐张一致——新底板要把提示词全文存进作品目录（例如 `films/<名>/plates/prompts/<名字>.txt`），在「来源」里写它的路径。
- 原图（生成服务直接给的文件）保留 C2PA，不要先过会剥元数据的转换；原图本身不进 git（D10：大于 5 MiB 的放 Release 或对象存储），只把 sha256 写进「来源」。
- 生成服务的条款与套餐由用户核对（[docs/rights/aigc.md](../../docs/rights/aigc.md)「生成服务的条款」）；没核对过的生成图不用于对外交付。

## 3. 后处理（《北冥》的六道，按顺序）

| # | 步骤 | 要点 | 记进 |
|---|---|---|---|
| 1 | alpha 主体拉满、去脏晕 | 主体内部 alpha = 1；边缘一圈半透明的脏色（生成图常见的灰边）删掉 | 「来源」的「人工修改」 |
| 2 | 透明区颜色外扩 | 透明像素的 RGB 填成邻近主体的颜色，防 mipmap 时边缘发黑；alpha 保持直通（非预乘） | 同上 |
| 3 | 向共享色板对齐 | 色板见 plates.json 的「色板」；整体色相、明度往色板靠，不逐像素换色 | 同上 |
| 4 | 天际线逆光剪影渐变映射 | 只用于城市剪影：按明度映射到「城市剪影」一族，保留窗灯 | 同上 |
| 5 | 截断边柔化 | 留在画外的截断边做软边；**进画的边要做成有机外形**（不能是直线淡出，`check` 会查） | 同上，并写 `edgePolicy` |
| 6 | ×2 放大（预乘 alpha 下放大，再还原直通） | 方法与工具写清（《北冥》这一项的工具没有记录，是「待补」）；写 `sourceSize` 与 `upscale` | `sourceSize`、`upscale.method` |

六道的具体参数（去晕阈值、外扩像素、放大工具）当初没有逐张记录；新底板按上表逐项写进「来源」。

## 4. 登记（plates.json）

每张必填：`name`、`file`（ASCII 小写加下划线）、`size`（与 PNG 一致）、`transparent`、`colorSpace`（彩色 `srgb`，纸纹这类数据贴图 `data`）、`edgePolicy`（四条边各自：`offscreen` 留在画外 / `covered` 被盖住 / `organic-mask` 用时裁成有机外形 / `natural` 本身是自然淡出 / `tiled` 四方连续 / `waived` 豁免并在 `edgeNote` 写理由）。

AI 生成的底板（`aigc: true`）还要：
- **「来源」**八个字段：工具、模型、日期、提示词、参考图、原图sha256、操作、人工修改；不知道的写「待补」，**不要编**；按清单级记录推定的写在「依据」里（[aigc.md](../../docs/rights/aigc.md)「来源链」，决定 D11）。
- **`sourceSize` 与 `upscale`**：原图尺寸、放大倍数与方法（没放大写 `"upscale": null`）。
- 用到它的作品在 film.json 写 `"aigc": { "contains": true, … }`，片尾或说明写「含 AI 生成画面」，成片 mp4 的 comment 由统一出片写入隐式标识。

## 5. 准入

```sh
node tools/plates/check.mjs                                 # 仓库的 13 张：字段 → 尺寸 → 透明与色彩配置 → 四边 alpha 与 edgePolicy → 纹素与细节密度
node tools/plates/check.mjs films/<名>/plates/plates.json   # 作品自带的底板
node tools/compliance/aigc.mjs plates                       # 逐张有没有 C2PA 或「来源」
```

渲出的画面上还会再查一遍：统一出片的 QA 门 `plates`（画内露边、直线淡出、逐帧的纹素密度）。

## 6. 已知问题

- `skyline_bund` 右端的竖向软边在《北冥》镜头 A 的画内（QA 台账 QA-A-001）：放行还是修，要用户决定；`src/` 对工作包只读，修要单独立项。
- 4K 档里天空、江面、前景云墙的纹素密度 0.5–0.75（QA-A-004）：原图都是 ×2 放大来的，4K 交付要么按镜头重新生成更大的图，要么在运行记录写明放大方法并附 1:1 对照。
- `paper.png` 的来历没有记录（扫描、程序生成还是 AI 生成无从核对），「来源」全部「待补」。
