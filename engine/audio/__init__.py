# -*- coding: utf-8 -*-
"""北冥引擎 · 声：程序化音效、采样配乐、混音与响度的通用部件（Python，48 kHz，确定性）。

  dsp        时间与包络、噪声、滤波、摆位、混响、动态
  synth      合成器件：加法共振峰发声器、玻璃音、气泡、颗粒事件流
  ambience   环境声：城市、水面、风、发丝、阵风
  sampler    多采样乐器采样器（CC0 库，BEIMING_SAMPLES 指路径）
  library    CC0 真实录音音效库（按清单加载、48 kHz 重采样、感知锚点 P-Center 标定、过零切片与署名，供 --real-sfx 切换）
  foley      物理拟音层：子事件复合（Pre/Transient/Body/Tail）、P-Center 锚定放置、防机关枪轮询池与运动学颗粒声床
  procedural 物理因果与风格化音效程序化合成：刚体模态撞击（含 radiation='accel' 加速度辐射）、PhISEM 随机粒子碰撞、
             Strouhal 涡街破空、Minnaert 气泡共振、卡通原语，以及三维雷电传播（thunder_strike）、时变四分之一波腔注水
             （pouring_vessel）、简并分裂圆片弹跳与欧拉盘滚振（bouncing_disc）、弹道 N 波与 Friedlander 爆破（shock_blast）
  spotting   自动画面打点与空间轨迹提取：spot_from_kinematics（从页面遥测 kinematics.json 提取切点/静置段/动作峰与角色轨迹）与 spot_from_video（FFmpeg 管道流式 MP4 运动分析）
  editorial  智能剪辑、运动声像贴合与四干线混音工作台：过程/冲击时值精裁、连击 IOI 防疲劳编排、三维轨迹耦合、角色遥测绑定 bind_actor 与 FourStemWorkstation（兼容 ThreeStemWorkstation）
  director   导演声学谱与感知 HDR 混音层：听觉视角 POA、峰值前负空间抽空、分轨互补 EQ（sculpt_stem_eq）、对白共振峰零相位挖槽（carve_dialogue_pocket，保配乐 < 350 Hz 厚度）与 HDRMixer
  sfx_judge  音效物理形态与取证判定（Stage 1，零训练 Timbre Toolbox 描述符：筛伪升频、削波、电源哼声、动作包络错配、
             口技/合成器谐波污染，以及 >6 kHz 周期颗粒调制电嗡声 hf_envelope_buzz 与 4–16 kHz 窄带金属哨音尖刺 hf_whistle_db）
  sfx_vocab  音效库检索词表与世界观三干线锁池（UCS v8.2.1 82 大类 / 753 子类 ucs_vocab.json、24 类复合配方、六种世界观加权与全片音效池规划）
  music_gen  情绪导引乐谱与配乐生成管线：按镜头事件推导能量弧线（plan_sections_from_film）、确定性合成导引乐谱（build_guide_score）与 ACE-Step 1.5 Cover 生成缓存（python -m engine.audio.music_gen；tools/audio/music.mjs）
  orchestra  编配：两层力度交叉淡化的长音、拨奏
  mixing     混音：时间轴摆放、镜头窗、让路、按目标响度定电平、SSL 总线粘合压缩与母带收口（master_chain）
  meter      测量：BS.1770 响度、真峰值、频段能量、起音、ffmpeg 旁证
  scope      自检画图：频谱、波形、曲线、声场宽度
  stream     长片：float32 稀疏总线（Bus.place 只写元素覆盖的那一段）、分段长底层、分块测量与跨块保状态流式粘合母带（stream.bus_glue_compress / stream.master_chain，十分钟混音峰值内存 < 1.0 GB）
  cues       节拍表与事件表（与 engine/core/tempo.js 同一公式）、起音登记 Onsets、页面遥测 Kinematics、按事件类型分派拟音
  filmspec   声音侧读 film.json（v1 / v2）与交付档位；event_times / shot_spans 给声音脚本取同源时间
  qa         声音 QA 门（python -m engine.audio.qa；Node 入口 tools/audio/qa.mjs；film build 的 mix 步骤自动前置拦截）：含响度、真峰值、左右平衡、分轨掩蔽（music_dominance / music_buried）与对白清晰度（audio.dialogue），硬项不达标退出 4
  cuecheck   声画拍点核对（python -m engine.audio.cuecheck；tools/audio/cuecheck.mjs）：三条路线通用的事件表（页面导出的 events.json，
             或 film.json v2 的 events[].beat / audio，timeline 三种写法），超差退出 4
  scorecache 配乐缓存的输入键：乐谱、时长、采样清单变了就拒绝静默沿用旧配乐
  voice      配音、字幕（SRT / WebVTT / ASS）、window.TEXTS 数据与口型提示（python -m engine.audio.voice；tools/audio/voice.mjs；film build 自动发现 dialogue.json 构建；见 voice/README.md）
  samples.json  配乐采样库（两套 CC0）的固定提交、逐文件地址、字节数与 sha256；取样：node tools/audio/fetch-samples.mjs
  _cli / _env   命令约定（tools/lib/cli.py）与找外部程序（FFMPEG / FFPROBE / BEIMING_SH）、UTF-8 输出；_env.run 起外部程序（留在调用方的进程组里、
                有超时，被打断时连同孙进程一起结束；整组被杀时一起结束，不会被系统收养后接着跑），exit_on_sigterm 让脚本被 SIGTERM / SIGHUP / Ctrl+C 时照常清理、以 143 / 143 / 130 退出

用法：把仓库根放进 sys.path，再 from engine.audio import dsp, mixing ...；短片照用 mixing（《北冥》10 秒样片就是这一套，逐样本不变），
      长片（分钟级）用 stream.Bus 摆放、stream.master_chain（或 stream.loudness_to）分块收口，避免每个元素一条全长 float64 缓冲。
测试：npm run test:audio（即 node tools/run-tests.mjs --only audio）：engine/audio/test_audio.py、audio/test_*.py、tests/audio/
"""
