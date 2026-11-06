# 北冥 · 9 分钟声音交付

`mix.wav` 是主合成应使用的唯一总混音，540 秒，48 kHz，双声道，24-bit PCM。`mix_preview.mp3` 仅便于试听；压缩音频的编码边界可能不保持数字零，**精确静音验收必须用 WAV**。

对白时间表 `dialogue.json` 是字幕与口型的唯一主依据，35 条，`file` 相对项目根目录。`dialogue/d01.wav` 至 `d35.wav` 每条从样本 0 放在对应 `start`，文件用尾部零填充到 `end-start`，不要重复时间拉伸。口型可在该 cue 内读取该 WAV 的幅度，尾部补零时闭嘴；不要让整个字幕显示时长持续张嘴。`voice_report.json` 记录实际有声时长及缓存哈希。

- `dialogue.srt`：由同一 JSON 导出，无说话人前缀；`dialogue_speakers.srt` 为审听标记版。
- `stems/dialogue.wav`、`ambience.wav`、`effects.wav`、`music.wav`：540 秒、48 kHz/24-bit stereo，预母带分轨。主混音另有对白闪避和响度处理，直接相加分轨不等于母带。
- `music/01_river.wav`：200 秒起，49 秒；`02_peng.wav`：455 秒起，31 秒；`03_morning.wav`：519 秒起，21 秒。新写的三段编曲，不是循环扩展旧十秒音乐。
- `score_events.json`、`effects_events.json`：音符与声效落点。
- `mix_report.json`：母带响度/真峰值/逐采样静音结果；`verification.json`、`ebur128.txt` 为独立验证。
- `make_voices.py`：在线 EdgeTTS 生成、缓存、对讲机滤波、限幅、适配 cue、SRT 导出。存在完整 MP3 缓存时无需联网请求。
- `produce_audio.py`：环境/声效合成、三段采样编曲、声像、闪避、总混音和两遍 loudnorm。
- `lib_sampler.py`：原引擎采样器的独立拷贝，只将采样率改为本文件常量，没有修改 engine。
- `verify_audio.py`：真实文件、长度、静音、音乐区间、语音频带分离和 FFmpeg EBU R128 校验。
- `samples/`：这次实际用到的 62 个乐器采样、原 CC0 LICENSE 和 SHA256 清单；`tts_cache/` 保留此次语音源。

固定随机种子 **20261105**。采样来自本机已有 VSCO 2 Community Edition / VCSL；音乐为本项目新写。化鹏末段无词合唱为有明确共振峰的合成音色，没有声称使用真实合唱团录音。其他环境及动作声均由交付代码生成。

## 复现

依赖：Python 3.12，FFmpeg，`requirements-audio.txt` 中固定版本。现有工作站 Python 为 `D:\beiming\tools\venv\Scripts\python.exe`；音频目录为 `D:\beiming\projects\beiming-9min\audio`。只用 CPU，不调用 CUDA。

```powershell
& D:\beiming\tools\venv\Scripts\python.exe D:\beiming\projects\beiming-9min\audio\make_voices.py
& D:\beiming\tools\venv\Scripts\python.exe D:\beiming\projects\beiming-9min\audio\produce_audio.py --stage all
& D:\beiming\tools\venv\Scripts\python.exe D:\beiming\projects\beiming-9min\audio\verify_audio.py
```

默认直接使用交付的 `audio/samples/`。也可运行已交付的 `reproduce.ps1`；无需更改任何系统安全策略。保留缓存后可以从本次原始语音重新生成全部文件。云端 TTS 再次请求可能发生版本差异，因此精确再现应保留缓存。

快门机械行程为 485.88–486.00 秒，声响收在 486.000 秒画面落点之前。整个 `[486,488)` 区间逐采样为零，488 秒海风重新渐入。硬静音在母带重采样、限幅之后再次强制写零。
