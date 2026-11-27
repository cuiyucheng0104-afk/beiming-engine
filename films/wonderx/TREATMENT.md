# 最后一页 PPT：当北冥引擎接管舞台（WonderX Phase 2 v4 导演阐述）

## 1. 路线与定位

- **采用路线**：路线 A（北冥风格路线 · WebGL2 三渲二及离线单文件交互演示运行时），沿用 PR #260 奠定的离线打包与演示壳基座（`engine/stage/deck*` + `tools/standalone/build.mjs`），但视觉完全升级为大厂高科技暗场三维实时舞台。
- **视觉红线**：严禁纸雕、瓦楞纸、牛皮纸、旧纸纹贴图（渲染路径显式 `paper: false`、`kuwahara: false`）；所有 10 幕画面 100% 由 WebGL2 实时渲染 + 原生 1920×1080 2D 导演 HUD 构成，绝不以定妆参考图替代 3D 渲染。
- **色盘系统**：黑曜暗场 `#07080B` / `#101218`、拉丝深钛 `#1C212B` / `#8A94A6`、瓷白 `#F2F4F8`、唯一品牌朱红激光 `#D2452C`、冰青 `#4CE0F5` 与暖钨金 `#FFB85C` 三点舞台光。

## 镜头表

整数帧以 `films/wonderx/film.json` 为准（24 fps，总计 324 秒 / 7,776 帧），终点帧属于下一幕。已签认 v4 分镜页顶部总览写作「28 拍」，但逐幕明细之和为 `3 + 3 + 3 + 3 + 3 + 3 + 3 + 3 + 2 + 3 = 29 拍`，本工程以逐幕明细为准统一实装全部 **29 拍**。

| 幕 | ID | 帧区间 | 拍数 | 核心 3D 视效与对位定妆 | 现场交互 |
|---|---|---|---|---|---|
| 01 | `A01` | 0–720 | 3 | H1：白底商务 PPT → 朱红锁死删行 → 8 模态 GLSL 扫屏与激光斜切剖屏 | 空格 / 翻拍触发接管与剖屏 |
| 02 | `A02` | 720–1440 | 3 | H1：64 座拉丝钛 3D 摩天柱拔地而起，朱红增长光轨顶穿悬浮 16:9 线框 | 指针微控低机位大摇臂仰视 |
| 03 | `A03` | 1440–2304 | 3 | H2：原创光学算力核 6 层同轴爆炸拆解 + 6 条实时 3D→2D CAD 工程引线 | 0%–100% 爆炸滑杆 + 自由环绕 |
| 04 | `A04` | 2304–3024 | 3 | H3：高精度水晶切面棱镜物理色散 + 镜面黑曜地面解析流体焦散 | 鼠标实时偏转入射激光与焦散 |
| 05 | `A05` | 3024–3888 | 3 | H4：`full` 档实装 30,000 动态 GPU 微体素（降档 15k/8k/3k），3 形态零掉帧形变 | 3 形态按钮 + 点击/划过电磁波纹 |
| 06 | `A06` | 3888–4608 | 3 | H5a：10⁶ m LiDAR 地形 → 14 道发光光学门框隧道 → 10⁻³ m 核心传感器急停微距 | 指针微调穿梭视差角度 |
| 07 | `A07` | 4608–5472 | 3 | H5b：单一 `BufferGeometry` + 4 套零 `discard` GLSL 着色器，0.0 px 配准 + 2×2 矩阵 | 4 画风键 (`Q/W/E/R`) + 2×2 矩阵 (`G`) |
| 08 | `A08` | 5472–6192 | 3 | 暗黑北冥导演工作台：左单文件离线交互 vs 右 BT.709 4K 成片 + 中文排版 | 电影时间轴拖拽 + 机位锁定切换 |
| 09 | `A09` | 6192–6912 | 2 | H6：左右 7 项指标 1:1 同源（4.8 PFLOPS / 1.6 TB/s / 3.4× 与 42/28/19/11%） | 全屏拖动中央朱红激光手柄 0%–100% |
| 10 | `A10` | 6912–7776 | 3 | 八幕全息时间长河回掠 → 品牌落版 → 「有任何问题吗？」12° 光学玻璃斜透 | 鼠标倾斜 12° 透出三维点阵 + 快捷入口 |

## 节拍表

全片 29 拍均以整数帧写入 `films/wonderx/film.json` 的 `events` 数组：A01（0 / 240 / 480）、A02（720 / 960 / 1200）、A03（1440 / 1728 / 2016）、A04（2304 / 2544 / 2784）、A05（3024 / 3312 / 3600）、A06（3888 / 4128 / 4368）、A07（4608 / 4896 / 5184）、A08（5472 / 5712 / 5952）、A09（6192 / 6552）、A10（6912 / 7200 / 7488）。演讲者可用左右方向键逐拍推进、Shift+方向键切幕、数字键 1–0 或顶部进度条直达定位。

## Cue map

| 触发点 | 声音动作 | 素材文件 |
|---|---|---|
| 全片循环背景（首次手势解锁后） | 三轨 Web Audio 主时钟相位锁定无缝循环（56 s） | `stem_pad.ogg` / `stem_pulse.ogg` / `stem_lead.ogg` |
| 进入 A02 / 剖屏转场 | 朱红激光斜切音效 | `sfx_laser_cut.ogg` |
| 进入 A03 / 爆炸拆解交互 | 精密机械层拆解音效 | `sfx_mech_explode.ogg` |
| 进入 A04 / 棱镜偏转 | 光学水晶棱镜泛音 | `sfx_prism_chime.ogg` |
| 进入 A05 / 切换形态或电磁脉冲 | 量子阵列脉冲冲击 | `sfx_quantum_surge.ogg` |
| 进入 A06 / 光学门框穿梭 | 空间穿隧气流音 | `sfx_portal_whoosh.ogg` |
| A07 按 `Q/W/E/R/G` 实时切画风 | 着色器瞬切清脆确认音 | `sfx_shader_snap.ogg` |
| 各幕入点（仅手动按 `V` 开启 AI 导览后） | 对应幕精华中文导览语音（10 句，共 36.744 s） | `vo_V01.ogg`–`vo_V10.ogg` |

## 声音设计

- **冷静音安全**：页面加载后零实时 `AudioContext` 唤醒、零自动发声，仅在首次真实指针/键盘手势后解锁播放；`M` 总静音、`S` 打开三轨独立 Mute/Solo 调音台、`V` 独立切换默认关闭的 AI 导览轨（异步音频准备完成前早按 `V`/`M` 的状态由状态机保真同步）。
- **可移植、固定哈希音频输入（D10）**：3 条 56 秒无缝循环原创高科配乐分轨、6 条程序化拟音、10 句可选 AI 中文导览（19 个 `.ogg` 音频及 6 份许可/声明/校验文件）按决定 D10 发布至公开 Release 标签 `wonderx-v4-assets`（`wonderx-phase2-v4-audio-opus.tar.gz`，`1,618,327 B`，SHA-256 `0d22d6b7d5609dbdd35700644d92a3f07638988fb2517fdd07f402777c539b4f`，不设为项目 latest）；元数据与校验链（`bundle.lock.json`、`fetch.mjs`、`manifest.json`、`used-samples-audit.json`、`vo_batch.json` 及 3 份上游许可全文）入库于 `films/wonderx/audio/`，`/audio/opus/` 写入 `.gitignore`。由 `node films/wonderx/audio/fetch.mjs` 下载并逐字节校验外层与全部 25 个文件，打包器 `tools/standalone/build.mjs` 与正式混音脚本 `films/wonderx/sound.py` 亦强制校验字节数与 SHA-256，不依赖私有 `out/` 或本机绝对路径。
- **同源正式视频混音（`films/wonderx/sound.py`）**：由 `npm run film -- build films/wonderx` 自动调用，读取同一份 `films/wonderx/film.json` 整数帧拍点与校验后的 `films/wonderx/audio/opus/*.ogg`（3 轨原创配乐 + 6 条程序化拟音，**导览配音严格关闭不混入**），母带至 `-14.0 LUFS` / `<= -1.5 dBTP` 并通过 `engine.audio.qa` 声音门禁。
- **可选 AI 中文导览（默认关闭）**：由 `openbmb/VoxCPM2`（Apache-2.0）+ `AudioVAE V2`（Apache-2.0）+ `voxcpm==2.0.3`（Apache-2.0）在 CPU 上仅以纯文本 `--control` 音色描述合成 10 句精华导览（36.744 s），零真人参考音频，界面与 `film.json`（`aigc.contains = true`、`kinds = ["voice"]`）均明确披露 AI 合成。
- **许可与绝对排除清单**：工程自身 MIT 版权声明（`Copyright (c) 2026 北冥引擎 Beiming Engine`）及根目录 `LICENSE` 全文、Three.js MIT、四款字体 OFL-1.1、Versilian CC0-1.0 与 VoxCPM2 Apache-2.0 全文均随单文件内嵌，可在演示页按 `L` 键随时查验；零引用、零打包 `R01`、`R02`、`YuE2`、`A05`、`B03`。

## 可复现构建与正式导出命令

在任意独立空目录的干净仓库检出中执行：

```sh
npm ci
node films/wonderx/audio/fetch.mjs
npm run fonts:fetch
npm run fonts:subset -- films/wonderx
npm run standalone:build -- films/wonderx
```

正式同源带声视频导出（从 `films/wonderx` 作品目录直出，不经单文件绕行）：

```sh
node films/wonderx/audio/fetch.mjs
npm run film -- build films/wonderx --final --profile web-1080p24
# 4K 档位入口示例（整片或片段）：
node engine/render/video.mjs films/wonderx --profile uhd-2160p24 --frames 708:780 --out <clip.mp4>
```

