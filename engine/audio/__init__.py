# -*- coding: utf-8 -*-
"""北冥引擎 · 声：程序化音效、采样配乐、混音与响度的通用部件（Python，48 kHz，确定性）。

  dsp        时间与包络、噪声、滤波、摆位、混响、动态
  synth      合成器件：加法共振峰发声器、玻璃音、气泡、颗粒事件流
  ambience   环境声：城市、水面、风、发丝、阵风
  sampler    多采样乐器采样器（CC0 库，BEIMING_SAMPLES 指路径）
  orchestra  编配：两层力度交叉淡化的长音、拨奏
  mixing     混音：时间轴摆放、镜头窗、让路、按目标响度定电平、母带收口
  meter      测量：BS.1770 响度、真峰值、频段能量、起音、ffmpeg 旁证
  scope      自检画图：频谱、波形、曲线、声场宽度

用法：把仓库根放进 sys.path，再 from engine.audio import dsp, mixing ...
测试：仓库根下 python -m unittest engine.audio.test_audio（合成信号，几秒）；整段混音的时间表用例在 audio/test_timeline.py
"""
