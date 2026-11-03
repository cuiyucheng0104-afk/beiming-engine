<div align="center">

# 北冥引擎

**Beiming Engine · 代码即影片**

一条三渲二 + 2.5D 的风格化渲染管线。<br>
每一帧都由代码画出：可重渲、可追溯、可以换一种画风重来。

<a href="media/beiming.mp4"><img src="media/preview.gif" width="100%" alt="《北冥》概念样片预览"></a>

<sub>《北冥》概念样片 · 10 秒 · 点击画面观看有声完整版　｜　<a href="https://github.com/cuiyucheng0104-afk/beiming-engine/releases/latest">原生 4K 版</a></sub>

<br>

![three.js](https://img.shields.io/badge/three.js-r170-1d2140?style=flat-square)
![Canvas 2D](https://img.shields.io/badge/Canvas-2D-1d2140?style=flat-square)
![FFmpeg](https://img.shields.io/badge/FFmpeg-H.264-1d2140?style=flat-square)
![RTX](https://img.shields.io/badge/NVIDIA-RTX-1d2140?style=flat-square)
![License](https://img.shields.io/badge/code-MIT-1d2140?style=flat-square)

</div>

---

## 作品

鲲把城市的灯海当成了大海。黎明前，一位轮渡水手透过 AI 眼镜看见了它。

| 雾江 · 0–3 秒 | 她 · 3–5 秒 | 鲲现 · 5–10 秒 |
|:---:|:---:|:---:|
| <img src="media/shot_1.6.jpg" alt="雾江"> | <img src="media/shot_4.0.jpg" alt="她"> | <img src="media/shot_7.6.jpg" alt="鲲现"> |

画面分两层：现实层是手绘质感的三渲二，眼镜显示层是锐利的矢量线条与文字，叠在最上面、不过后期。
故事与视听定调见 [docs/作品.md](docs/作品.md)。

## 一套引擎，不止一种画风

画风不写死在素材里，而是由造型、着色与后期三处代码共同决定。同一条鲲，换一组参数和着色器，就是另一种气质。

<img src="media/styles.jpg" width="100%" alt="同一引擎下的六种鲲">

<sub>六个造型都在 [src/](src) 里，各有一张自测页：`?test=kun_qinglv`、`?test=kun_bronze` ……</sub>

## 管线

```
  造型 ─┐
  着色 ─┼─▶ 三维场景 ─▶ 后期 ─▶ 显示层 ─▶ 逐帧渲染 ─▶ 编码封装
  底板 ─┘      ▲                    ▲          ▲            ▲
         分层时钟              Canvas 2D   无头浏览器     FFmpeg
```

| 层 | 做什么 | 代码 |
|---|---|---|
| **形** | 程序化建模：脊线放样、超椭圆截面、翼型鳍，表面实例化散布海草与藤壶 | `src/kun.js` |
| **光** | 三色分档卡通着色、量化阴影、背光边缘光，色值锁定在色板上 | `src/toon.js` |
| **景** | 2D 手绘底板作为三维空间里的面片分层摆放，镜头一动，视差自然产生 | `src/scene.js` `src/shot*.js` |
| **笔** | 屏幕空间墨线（深度 + 物体 ID）、笔压与抖动、Kuwahara 颜料笔触、纸纹、颗粒 | `src/look.js` |
| **人** | 角色用 Canvas 2D 逐笔绘制：贝塞尔剪影、可变宽墨线、水彩斑驳 | `src/girl.js` |
| **界** | 眼镜显示层与片名，最后一层合成，永远清晰 | `src/hud.js` |
| **时** | 分层时钟：角色一拍二、鲲一拍三，镜头与雾水每帧都动 | 各镜头 `update(t, f)` |
| **声** | 音效全部程序化合成，配乐以采样乐器编写，响度统一归一 | `audio/` |
| **片** | 无头浏览器逐帧截图，多路并行，FFmpeg 编码后无损拼接 | `engine/render/` |

确定性贯穿始终：没有 `Date.now`，没有无种子随机。同一个时刻永远画出同一张图，任何一帧都可以单独重渲。

## 快速开始

需要 Node.js 20+、FFmpeg、Python 3.10+。

```bash
npm run setup                     # 安装依赖与无头浏览器
pip install -r requirements.txt   # 声音部分
```

```bash
sh build.sh          # 一键重建整片：静帧样张 → 混音 → 逐帧渲染 → 封装（1920×1040）
sh build.sh --4k     # 原生 4K（3840×2080）
```

只想看画面：

```bash
npx http-server -p 8080 .         # 任意静态服务器均可
# 打开 http://127.0.0.1:8080/              正片
# 打开 http://127.0.0.1:8080/?test=kun     单个模块的自测页
```

## 页面约定

任何一部影片，只要页面满足这四条，就能交给渲染器：

```js
window.DUR = 10;                 // 时长（秒）
window.render = t => { … };      // 把画面画到时刻 t，必须是确定性的
window.READY = true;             // 贴图、字体、着色器全部就绪
window.TEXTS = t => [ … ];       // 可选：该时刻画面上的文字，供检查
```

渲染器不关心页面里用的是 three.js、Canvas 2D 还是别的什么。

## 目录

```
engine/
  core/      math.js 插值与确定性随机 · noise.js 单纯形噪声 · stroke.js 手绘笔触
  render/    page.mjs 页面与浏览器 · still.mjs 静帧 · video.mjs 视频 · mux.sh 音画封装
src/         《北冥》：镜头、造型、着色、后期、角色、显示层
lab/         各模块的自测页（?test=<名字>）
audio/       音效设计、配乐、混音与自检
assets/      手绘底板与纸纹
docs/        作品说明 · 渲染与 4K 实测 · RTX 工作站指南
```

## 美术素材

底板与风格参考由 Midjourney V8 与 GPT Image 2.5 生成，经手工整理后进入管线。造型、着色、墨线与动画全部由代码完成。

---

## RTX 原生加速

北冥引擎的瓶颈从来不在"画什么"，而在"每一帧要画多久"。卡通着色、Kuwahara 笔触、逐像素墨线都是重着色器负载，最适合交给 RTX 的原生图形栈。

**一条 Vulkan 直通。** 无头浏览器在工作站上默认会落到核显。引擎把 ANGLE 切到 Vulkan 后端，WebGL 直接跑在 RTX 独显上：

```bash
BEIMING_ANGLE=vulkan sh build.sh --4k
```

| | 重着色器单帧 | 原生 4K 整片（240 帧） |
|---|---:|---:|
| RTX 5090 · Vulkan | **0.52 ms** | **31 秒** |
| Apple M5 Pro · Metal | 5.17 ms | 51 秒 |

**原生分辨率优先。** 镜头按设计尺寸摆位，渲染器、后期与显示层按实际像素工作，任何分辨率下构图一致。因此 4K 是直接算出来的，不是放大出来的。

**超分放在它该在的位置。** 我们实测了 RTX Video Super Resolution：它对实拍和 AI 生成的视频素材很有价值，但在手绘平涂区会生出不属于这幅画的纹理。所以引擎的分工是：代码画出的镜头走原生 4K，拿不到原生分辨率的视频素材交给 RTX 超分。

**两台机器，同一张画。** Mac 与 RTX 工作站渲出的 4K 成片 SSIM 0.973，差异只在系统字体的光栅化边缘，肉眼不可见。日常在笔记本上迭代，出片交给工作站。

详细数据见 [docs/渲染与4K.md](docs/渲染与4K.md)，工作站配置见 [docs/RTX工作站.md](docs/RTX工作站.md)。

---

<sub>源代码以 MIT 许可开放；影片、底板与展示图保留所有权利；字体遵循 SIL OFL 1.1。详见 [LICENSE](LICENSE)。</sub>
