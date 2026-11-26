# 《校准环》

北冥代码动画风格 · 86 式的连续性实验。量测图中的金色缺口环从平面进入三维工位，在同一镜头中落座并触发确认灯。全片 7 秒，1920×1080，24 fps，168 帧。节拍、构图与人工复看问题见[导演阐述](TREATMENT.md)。

[实验附录](ONETAKE-LAB.md)记录另一组独立输入，分别验证追踪身份与实拍位置的关系，以及快门跳采和线性光积分。附录包含复跑命令、公开案例拆解与私有试映复测边界。

## 从仓库根复跑

```sh
npm run env:doctor -- --route c
npm run film -- check films/calibration-ring
npm run film -- stills films/calibration-ring --workers 1 --frames 0,28,63,64,65,121,156,167 --out-root films/calibration-ring/out/look
npm run film -- animatic films/calibration-ring --workers 1 --out-root films/calibration-ring/out/animatic
npm run film -- build films/calibration-ring --final --workers 1 --out-root films/calibration-ring/out/matched
npm run film -- build films/calibration-ring --workers 1 --query variant=unmatched --out-root films/calibration-ring/out/unmatched

film=films/calibration-ring
matched=$(cat "$film/out/matched/latest")
unmatched=$(cat "$film/out/unmatched/latest")
node tools/env/py.mjs "$film/compare.py" "$film/out/matched/$matched/master.mp4" "$film/out/unmatched/$unmatched/master.mp4"
```

成片运行目录里的 `run.json` 记录规格和实际设备，`qa/report.md` 与 `qa/contact.jpg` 给出整片检查。对照脚本把交接前后各帧的联系表和计量写到 `out/comparison/seam.jpg` 与 `out/comparison/seam.json`。

## 取样和结果

两版共用时间轴、几何、配色、声轨、镜头俯仰、分辨率、帧率与编码。错位版仅扰动交接后的投影对位，首帧移右 196 px 并放大 26%，随后归回同一工位。脚本从两条 H.264 母版解码第 62–66 帧，在 RGB 中以固定色域筛选金色环顶面，计算相邻两帧的质心距离、面积变化率、掩膜交并比（IoU）和全帧 RGB 平均绝对差。相邻帧是正常推进的参照。

| 第 63→64 帧 | 匹配版 | 错位对照 |
|---|---:|---:|
| 顶面质心距离 | 4.018 px | 199.682 px |
| 顶面面积变化 | +1.409% | +61.427% |
| 顶面掩膜 IoU | 0.92401 | 0.07577 |
| 全帧 RGB 平均绝对差（0–255） | 0.41920 | 9.28104 |

匹配版前一对第 62→63 帧质心距离为 4.034 px，后一对第 64→65 帧为 4.220 px。两版的联系表均能追踪到缺口，错位版第 64 帧需要重新寻找主体。匹配版第 84 帧已看见座盘，第 120 帧已显出橙色侧壁，第 156 帧可辨确认灯。

在 Linux x86_64、RTX 5090、ANGLE OpenGL、Chromium 153.0.8010.12、FFmpeg 9.0.2 上出片。两版都完整解码 168 帧，AAC 48 kHz 双声道，母版响度 −14.0 LUFS、真峰值 −2.0 dBTP。机器 QA 两版均退出 0，匹配版 37 项通过、1 项注意，错位对照 36 项通过、2 项注意。对照版的 `visual.jumps` 报第 64 帧可疑跳动，匹配版无跳动提示。两版的 `visual.edge-line` 候选对应画面里的量测框与刻度区。两版均检出 3/3 个拟音起音，延迟 2.0–4.3 ms。

## 验证边界

- 测量色域只适合本片的亮金顶面和暗色环境。亮度、编码、遮挡和其他同色元素都可能改变掩膜。对照同时扰动位移与大小，数据量化两者合起来的接缝效果。指标描述接缝异常，审美与叙事由人工全速带声观看判断。
- 确定性实测命令为 `npm run determinism -- films/calibration-ring --seams --workers 4 --cuts 64 --size 1920x1080 --out films/calibration-ring/out/determinism-fixed`。这里用 `--cuts` 指定交接邻帧取样。当前硬件环境三种取帧顺序有 11/12 个样本哈希不同，顺序与新开页面的报告最大通道差 14。两条成片均按仓库建议使用单 worker。未经验证的平台可能得到略有不同的掩膜计量。
- 已输出成片，机器 QA 通过，人工全速带声审片待进行。

## 素材来源

量测图形与三维几何来自 [film.js](film.js)，声音来自 [mix.py](mix.py)，均为本案例的原创程序化素材。页面使用仓库锁定的 Three.js 0.170.0。案例没有外部贴图、字体、声音采样、示例片段或额外运行时。方法与上游许可登记见[长镜头与媒介交接](../../routes/directing/craft/continuous-take.md#方法出处与许可)。
