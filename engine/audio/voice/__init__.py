# -*- coding: utf-8 -*-
"""北冥引擎 · 配音：与服务商无关的 TTS 接口、逐字时间、字幕、window.TEXTS 数据、口型提示（写法与例子见 README.md）。

  providers  synthetic（离线临时配音）/ say（macOS）/ command（任意本地 TTS）/ minimax / edge；统一输出 48 kHz 单声道
  secrets    凭据只从环境变量或系统钥匙串读（macOS security、Linux secret-tool、Windows 凭据管理器、keyring）
  cache      sha256(服务, 模型, 音色, 参数, 原话) 为键；原始响应先去掉签名地址与追踪号再存
  align      计时单位与逐字时间（TTS 时间戳按序列比对重分配；没有时间戳时按停顿锚定的比例分配）
  subtitles  切条、断行（避头尾）、起止帧（跟声音、最短停留、间隔、切点吸附、读速）、SRT / WebVTT / ASS
  lips       每帧开口度与音节口型（口型提前 1–2 帧）
  dialogue   dialogue.json → 全部产物；duck_curve 给配乐与环境声让路
命令：python -m engine.audio.voice build <作品或 dialogue.json> [--offline] [--provider synthetic]；Node 入口 node tools/audio/voice.mjs
"""
