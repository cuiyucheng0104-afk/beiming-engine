# 《校准环》附录：承接探针和快门的对照实验

[技术考察](../../routes/directing/craft/onetake-study.md)解读源码和制作迁移。本页记录实跑条件。北冥基线为 PR #246 的 `21eef0d3a7d6b26a44b3e3a1e87fbf3531765725`，上游为 OneTake `4e024be4c6c696b260f39a35aee6bd56d303b679`。新增输入是本仓库的[独立 Canvas 夹具](continuity-lab.html)和[计量脚本](measure-continuity-lab.py)。夹具里只有程序画出的圆/方块、绝对时钟和手写观测数据。OneTake 及公开案例 MP4 在单独的本地检出中只读调用，私有试映只用于工作站复核。产物均写入本片 `out/`。

本轮环境为 Linux x86_64、RTX 5090、FFmpeg 9.0.2。独立 Canvas 对照和公开案例读数用独立 Python 3.12 环境、Playwright Python 1.65.2 的 Chromium 159.0.8154.6（默认 headless，未传上游的 ANGLE/Metal 参数）和 OpenCV 5.1.0。北冥母版用仓库锁定的 Chromium 153.0.8010.12、ANGLE OpenGL。私有试映回跳用系统 Chromium 155.0.8059.84，显式对照 ANGLE GL 和 SwiftShader。不同浏览器的输出分别比较。

## 身份与画面分离

同一个白圆在 640×360 内以 90 px/s 平移，30 fps、4 s、单 worker、关快门。换 ID 对照只改第 60 帧起的追踪标签，瞬移对照只在同一边界将白圆平移 240 px 并保留原 ID。三版其余绘制与编码参数相同。表中位移取解码 RGB 三通道均 ≥128 的像素的平均 x，像素一致性比较所有 120 帧；探针用同尺寸页面，独立于编码。

| 变体 | 探针 carry / 计入边界 | 相对基准有差异的解码帧 | 第 59→60 帧 | 第 60→61 帧 |
| --- | ---: | ---: | ---: | ---: |
| baseline | 1.00 / 0 | 0 | +3 px | +3 px |
| rename | 0.00 / 1 | 0 | +3 px | +3 px |
| teleport | 1.00 / 0 | 60 | +243 px | +3 px |

rename 的 J=0，合并范围是 48–71 样本（0 基），选择第 48、60 帧，报告中点为 1.80 s，切换时间为 2.00 s。teleport 整片呈现相同身份，J 没发现替换，曲线又将孤立跳步清零，仍报峰值 9 px/帧（归一至 1920 宽）。两例控制了追踪身份和视觉运动，可以分辨自动判分各自的漏报与误报。带有遮挡、背景大变或换材质的真实镜头仍要按交接帧看轮廓和速度。

## 快门子采样与线性光

固定 30 fps 的第 60 帧为 2.000 s。180° 对应 1/60 s 曝光，默认 8 个中点样本相对帧时刻约为 ±1.04、±3.13、±5.21、±7.29 ms。pulse 的白块只在距中心 <4 ms 时出现，第一与最后样本同黑。alternating 在相同窗口内每个子区间交替黑白，四黑四白，且相邻灰度差相同，使「单一跳变」条件失效。

| 变体 | 第 60 帧中心点，PNG → 解码 RGB（三通道相同） | 整片截图次数 / 跳过快门的帧 |
| --- | ---: | ---: |
| pulse，0° | 255 → 255 | 120 / 0 |
| pulse，180° | 0 → 0 | 240 / 120 |
| alternating，180° | 188 → 187 | 246 / 119 |

六个样本均解码 120 帧，H.264 yuv420p、有限范围、BT.709 三项标记，`ffmpeg -xerror` 退出 0。pulse 的完整八点平均按定义应为 sRGB 188，脚本在取得首末黑帧后跳过其余六点，故输出黑色。alternating 观察到 188，符合半强度线性光回 sRGB，末端的 187 是这一版编码再解码后的读数。这里测试的是上游采样器在受控信号上的行为。未对任意色卡、快门形状、时间累计或所有突变做外推。图表生成在本地 `out/onetake-study/fixture-contact.jpg`，以小格检查位移、亮灭和接缝；像素计量见同目录的 `fixture-results.json`。

## 从北冥仓库根复跑

`ONETAKE_CHECKOUT` 指向单独检出的上述提交，`BEIMING_PYTHON` 可指向独立研究环境的 Python，其中需有 Playwright Chromium、numpy、Pillow、matplotlib；公开案例的光流另需 OpenCV。北冥母版仍用仓库原来的 `.venv`（设置研究用 `BEIMING_PYTHON` 前出片，或在独立 shell 里执行下方研究命令）。`--keep-frames` 为中心像素的编码前后比较保留 PNG。

```sh
npm run env:doctor -- --route c
npm run env:gpu
npm run film -- plan films/calibration-ring
npm run film -- build films/calibration-ring --final --workers 1 --out-root films/calibration-ring/out/onetake-recheck

ot="${ONETAKE_CHECKOUT:?set ONETAKE_CHECKOUT to the separate research checkout}"
ot_sha=4e024be4c6c696b260f39a35aee6bd56d303b679
test "$(git -C "$ot" rev-parse HEAD)" = "$ot_sha" || exit 1
export PYTHONDONTWRITEBYTECODE=1
film=films/calibration-ring
out="$film/out/onetake-study"
mkdir -p "$out/probe"

for v in baseline rename teleport; do
  mkdir -p "$out/$v"
  node tools/env/py.mjs "$ot/scripts/probe.py" "$film/continuity-lab.html?variant=$v" \
    --width 640 --height 360 --out "$out/probe/$v" || exit
  node tools/env/py.mjs "$ot/scripts/render.py" "$film/continuity-lab.html?variant=$v" \
    --width 640 --height 360 --workers 1 --shutter 0 --keep-frames --out "$out/$v/film.mp4" || exit
done
for setting in pulse:0 pulse:180 alternating:180; do
  v=${setting%:*}
  shutter=${setting#*:}
  mkdir -p "$out/$v-$shutter"
  node tools/env/py.mjs "$ot/scripts/render.py" "$film/continuity-lab.html?variant=$v" \
    --width 640 --height 360 --workers 1 --shutter "$shutter" --keep-frames \
    --out "$out/$v-$shutter/film.mp4" || exit
done
node tools/env/py.mjs "$film/measure-continuity-lab.py" "$out"
for v in baseline rename teleport pulse-0 pulse-180 alternating-180; do
  ffprobe -v error -count_frames -select_streams v:0 \
    -show_entries stream=width,height,r_frame_rate,nb_read_frames,pix_fmt,color_range,color_space,color_transfer,color_primaries \
    -of csv=p=0 "$out/$v/film.mp4" || exit
  ffmpeg -v error -xerror -i "$out/$v/film.mp4" -f null - || exit
done
```

北冥母版以原匹配版本出片，168 帧，1920×1080、24 fps、AAC 立体声 48 kHz。QA 退出 0，37 项通过，1 项注意（量测框一带的 `visual.edge-line`），3/3 事件检出拟音，未执行人工全速带声审片。上一版双母版、色域 IoU 和 4 worker 取样见[案例正片记录](README.md)；本轮未重跑错位母版和其四路判定。母版报告位于 `out/onetake-recheck/<run-id>/qa/report.md`。

## 抽查公开案例

仍在上述研究 shell 执行。从 `summary.json` 取静止比、切点候选和光流，从 `sheet_*.png` 和九张 `frame_*.png` 复核镜头。定义详见[技术考察第一节](../../routes/directing/craft/onetake-study.md#从参考片到看片哪些数据真的相通)。

```sh
for entry in one-dot-15s:one-dot motion-web-15s:motion-web domino-25s:domino clawd-desktop-19s:clawd; do
  case_id=${entry%:*}
  clip=${entry#*:}
  mkdir -p "$out/cases/$case_id"
  node tools/env/py.mjs "$ot/scripts/analyze_ref.py" "$ot/cases/$case_id/$clip.mp4" \
    --out "$out/cases/$case_id" || exit
done
```

| 公开 MP4 | 静止比 | 灰度变动候选 | 低动作最长 | 光流峰，归一 px/帧 @30 fps |
| --- | ---: | ---: | ---: | ---: |
| one-dot | 39.4% | 6 | 2.75 s | 179 |
| motion-web | 53.3% | 1 | 3.83 s | 295 |
| domino | 1.6% | 169 | 0.50 s | 216 |
| clawd-desktop | 0.9% | 12 | 1.00 s | 153 |

这是对公开成片的测量。多数大变动连续落在三维链的快速运镜区，属于区分剪辑和运动的反例；无法从该文件归因某个浏览器差异或重做早期版本的动画/音乐。审阅了联系图和取样静帧，未做公开案例的全速带声验收。

## 私有试映复用与复测

仅复用 ROG 的原创试映 SPEC、原页面、既有 MP4 和工作站机器记录；下列为脱敏结果。授权可访问原试映的人可将 `SCREENING_CHECK` 指向试映回跳脚本，`ECHO_MP4` 指向「半秒回声」交付拷贝。未把素材、合成、私有路径或脚本带进北冥，公开的圆与快门对照可以独立复跑。

| 题材与复用证据 | 本轮新增复测 | 适用范围 |
| --- | --- | --- |
| 「书脊工位」，产品走读。复用双语规格、真实原型转纸/折叠/导出核对，以及既有两条 960 帧 MP4 的带波形机器实播记录。历史 GL 首次回跳英语/简中为 2,461/2,111 个变化像素，最大通道差各 2。 | 1080p 抓图顺序 11.50→29.00→11.50 s，再热回访。GL 首次英语/简中分别 349/1 个变化像素、最大差各 1。SwiftShader 首次为 2,090/0，最大差 2/0，后续仍出现小范围差。 | 两个变体共享场景和动作，用各自时钟测状态；字体、DOM 边缘和截图像素有波动。历史语音识别覆盖三步，但文本有同音差。试映用自己的语音制作流程，未当作对上游 Kokoro 接口的运行验证。 |
| 「夜面开口」，陶片开轴与照明，程序几何 / GLB。复用同视角 4K60、1080 帧整片记录和两版装载证据，历史 GL 首次差 357/356 像素。 | 8.30→16.00→8.30 s，GL 首次再现 357/356、最大通道差 46，后续比较零差；SwiftShader 两版各次均零差。 | 差分集中在边缘，只能说明这组时刻和环境的回跳表现。未重跑 4K 版或全片多 worker 对照。 |
| 「半秒回声」，实录交互 + 代理帧。复用源 WebM 1080p25 无声、30 fps 代理和源标记记录；近/远的往返为 15/33 代理帧。 | 对既有 H.264/AAC 重新解码测 1 ms RMS 起音，得到 2.800/3.300 与 9.000/10.100 s。烧录画面标注相应动作在 84/99 和 270/303 帧，取自此前逐帧证据。 | 两个动作对用于检查声画因果；只重新测了声波，未重新采集操作或重渲交付。到毫秒的数字不能代表 30 fps 原操作的时间分辨率。 |
| 「潮痕」，自然动作。复用已有潮边回抽与留纹镜头、机器解码与它自己的验证记录。 | 仅用既有记录比对题材，未新增实测。自定的片内检查通过，附参考片的 oracle 因参考存在 burst 而本片没有报 FAIL。 | 固定机位小范围回抽不要求补无关快切，按过渡区域和段落语义看。 |

回跳脚本等资源与双次 rAF，取 `[A,B,A,A,B,A]` 的 RGB 截图，首次是索引 0/2；另比较 2/3、2/5、1/4。声轨以 48 kHz 双声道浮点解码，对每个预期动作的 −20…+40 ms 范围找首个 ≥−40 dBFS 的 1 ms RMS 窗。

```sh
node tools/env/py.mjs "${SCREENING_CHECK:?set the authorized local seek check}" gl > "$out/seek-gl.json"
node tools/env/py.mjs "$SCREENING_CHECK" swiftshader > "$out/seek-swiftshader.json"

node tools/env/py.mjs -c '
import subprocess, sys
import numpy as np
raw = subprocess.check_output(["ffmpeg", "-v", "error", "-xerror", "-i", sys.argv[1],
                               "-vn", "-ar", "48000", "-ac", "2", "-f", "f32le", "-"])
pcm = np.frombuffer(raw, dtype="<f4").reshape(-1, 48, 2)
rms = np.sqrt(np.mean(pcm ** 2, axis=(1, 2)))
for n in (2800, 3300, 9000, 10100):
    lo = n - 20
    print((lo + np.flatnonzero(rms[lo:n + 40] >= 0.01)[0]) / 1000)
' "${ECHO_MP4:?set the authorized local echo master}"
```

以上私有对照均未执行本轮的人工全速带声验收。历史实播是播放器和波形证据，人工听感仍待评。
