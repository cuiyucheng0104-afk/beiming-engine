# -*- coding: utf-8 -*-
"""北冥引擎 · 声：程序化音效、采样配乐、混音与响度的通用部件（Python，48 kHz，确定性）。

  dsp        时间与包络、噪声、滤波、摆位、混响、动态
  synth      合成器件：加法共振峰发声器、玻璃音、气泡、颗粒事件流
  ambience   环境声：城市、水面、风、发丝、阵风
  sampler    多采样乐器采样器（CC0 库，BEIMING_SAMPLES 指路径）
  library    CC0 真实录音音效库（按清单加载、48 kHz 重采样、感知锚点 P-Center 标定、过零切片与署名，供 --real-sfx 切换）
  foley      物理拟音层：子事件复合（Pre/Transient/Body/Tail）、P-Center 锚定放置、防机关枪轮询池与运动学颗粒声床
  procedural 物理因果与风格化音效程序化合成：刚体模态撞击、PhISEM 随机粒子碰撞、Strouhal 涡街破空、Minnaert 气泡共振与卡通合成原语
  editorial  智能剪辑、运动声像贴合与三干线乐效混音工作台：过程/冲击时值精裁、连击 IOI 防疲劳编排、三维轨迹声像耦合与 ThreeStemWorkstation
  director   导演声学谱与感知 HDR 混音层：听觉视角 POA、峰值前负空间抽空、乐效调性吸附、Murch 2.5 声部聚簇与 6 临界频带动态让位
  sfx_judge  音效物理形态与取证判定（Stage 1，零训练 Timbre Toolbox 描述符：筛伪升频、削波、电源哼声、动作包络错配与口技/合成器谐波污染）
  sfx_vocab  音效库检索词表与世界观三干线锁池（UCS v8.2.1 82 大类 / 753 子类 ucs_vocab.json、24 类复合配方、六种世界观加权与全片音效池规划）
  orchestra  编配：两层力度交叉淡化的长音、拨奏
  mixing     混音：时间轴摆放、镜头窗、让路、按目标响度定电平、母带收口
  meter      测量：BS.1770 响度、真峰值、频段能量、起音、ffmpeg 旁证
  scope      自检画图：频谱、波形、曲线、声场宽度
  stream     长片：float32 稀疏总线（Bus.place 只写元素覆盖的那一段）、分段长底层、分块测量与分块母带（十分钟混音峰值内存约 0.9 GB）
  cues       节拍表与事件表（与 engine/core/tempo.js 同一公式）、起音登记 Onsets、按事件类型分派拟音
  filmspec   声音侧读 film.json（v1 / v2）与交付档位；event_times / shot_spans 给声音脚本取同源时间
  qa         声音 QA 门（python -m engine.audio.qa；Node 入口 tools/audio/qa.mjs）：硬项不达标退出 4，报告是附录 C8 的结构
  cuecheck   声画拍点核对（python -m engine.audio.cuecheck；tools/audio/cuecheck.mjs）：三条路线通用的事件表（页面导出的 events.json，
             或 film.json v2 的 events[].beat / audio，timeline 三种写法），超差退出 4
  scorecache 配乐缓存的输入键：乐谱、时长、采样清单变了就拒绝静默沿用旧配乐
  voice      配音、字幕（SRT / WebVTT / ASS）、window.TEXTS 数据与口型提示（python -m engine.audio.voice；tools/audio/voice.mjs；见 voice/README.md）
  samples.json  配乐采样库（两套 CC0）的固定提交、逐文件地址、字节数与 sha256；取样：node tools/audio/fetch-samples.mjs
  _cli / _env   命令约定（tools/lib/cli.py）与找外部程序（FFMPEG / FFPROBE / BEIMING_SH）、UTF-8 输出；_env.run 起外部程序（留在调用方的进程组里、
                有超时，被打断时连同孙进程一起结束；整组被杀时一起结束，不会被系统收养后接着跑），exit_on_sigterm 让脚本被 SIGTERM / SIGHUP / Ctrl+C 时照常清理、以 143 / 143 / 130 退出

用法：把仓库根放进 sys.path，再 from engine.audio import dsp, mixing ...；短片照用 mixing（《北冥》10 秒样片就是这一套，逐样本不变），
      长片（分钟级）用 stream.Bus 摆放、stream.loudness_to 收口，避免每个元素一条全长 float64 缓冲。
测试：npm run test:audio（即 node tools/run-tests.mjs --only audio）：engine/audio/test_audio.py、audio/test_*.py、tests/audio/
"""
