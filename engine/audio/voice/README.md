# engine/audio/voice · 配音、字幕与口型

一份 `dialogue.json` 生成四样东西，时间全部同源：配音轨、字幕（SRT / WebVTT / ASS）、页面的 `window.TEXTS` 数据、口型提示。
旁白片、PPT 故事片、带对白的短片都走这一条，不要再从 `cases/` 里抄各自写死密钥路径的 TTS 脚本。

## 一条命令

```sh
node tools/audio/voice.mjs build films/<名>                       # 读 films/<名>/dialogue.json（或 film.json 的 voice.dialogue）
node tools/audio/voice.mjs build films/<名> --provider synthetic  # 动态预演：确定的临时配音，不联网、不花钱（不是真人声，不能交付）
node tools/audio/voice.mjs build films/<名> --offline             # 联网的服务只读缓存（缓存没有就退出 3）
node tools/audio/voice.mjs check films/<名>/dialogue.json         # 只校验写法
node tools/audio/voice.mjs providers                              # 列出服务与本机能不能用
```

等价的 Python 写法：`python -m engine.audio.voice build films/<名>`（在仓库根运行）。退出码：0 成功；2 用法；3 缺依赖、缺密钥、离线时缓存里没有；4 对白不合规、台词放不下或同一个人两句叠在一起。

## dialogue.json

```json
{
 "schema": "beiming.dialogue/1",
 "speakers": {
  "narrator": { "provider": "minimax", "voice": "Chinese (Mandarin)_Reliable_Executive", "model": "speech-2.8-hd", "params": { "speed": 1.0 } },
  "girl": { "provider": "edge", "voice": "zh-CN-XiaoxiaoNeural", "pan": 0.15 }
 },
 "lines": [
  { "id": "L1", "speaker": "narrator", "text": "北冥有鱼，其名为鲲。", "at": 24 },
  { "id": "L2", "speaker": "girl", "text": "鲲之大，不知其几千里也。", "read": "鲲之大，<#0.3#>不知其几千里也。", "at": 96, "end": 216 }
 ],
 "subtitles": { "maxChars": 18, "maxLines": 2 }
}
```

- `at` 是开口帧：配音第一个有声样本落在这一帧上（也可以写 `t` 秒）。改节奏只改这里；镜头切点、片长、帧率、画幅读 film.json。
- `text` 是字幕上显示的字，逐字时间也按它算；`read` 是送给 TTS 的读法（多音字、数字读法、`<#秒#>` 停顿），不写就念 `text`。
- `end`：最晚必须说完的帧，放不下直接报错（退出 4），不会悄悄压过下一个镜头。
- `audio`：已经录好的音频（相对本文件），不走 TTS，时间按停顿锚定的比例分配。
- 服务：`synthetic`（离线临时配音）、`say`（macOS 自带）、`command`（任意本地 TTS：`params.argv` 里用 `{text}` `{text_file}` `{out}` `{voice}` 占位，可选 `params.words` 指向它写出的逐字时间）、`minimax`（逐字时间戳）、`edge`（`pip install edge-tts`，逐词时间）。

## 产物（默认 `films/<名>/out/dialogue/`）

| 文件 | 内容 |
|---|---|
| `voice.wav` | 配音轨，48 kHz 立体声 32 位浮点，长度 = 片长 |
| `subtitles.srt` / `.vtt` / `.ass` | 同一组起止帧；ASS 字高为画高 4.5%、底边留 5% 安全区，用于烧录 |
| `texts.json` | 每条字幕的文字、分行、起止秒与帧、说话人：页面用 `engine/audio/voice/texts.mjs` 排版并挂成 `window.TEXTS` |
| `lips.json` | 每句每帧的开口度（0–1）与音节口型（`M` 闭唇、`F` 唇齿、`O` 圆、`I` 扁、`A` 开、`rest`），口型比声音提前 1 帧 |
| `onsets.json` | `{onsets: {句子: 开口秒}}`，`node tools/audio/cuecheck.mjs <作品> --onsets <它>` 可以核对画面事件 |
| `voice.json` | 每句的服务、缓存键、计时方法（`tts` 逐字时间戳 / `proportional` 比例分配）、开口与说完的时刻、警告 |

字幕规则（数字都能在 `subtitles` 段改）：跟着声音起止；每行 ≤ 18 字、最多两行、每条 ≤ 7 秒，超了在标点处拆；断行守避头尾；停留 ≥ max(1.8 秒, 台词时长 + 0.6 秒) 但给下一条留 2 帧间隔；说完后离切点不到 12 帧吸附到切点；每秒超过 9 字只告警。中文影视字幕习惯：行末的全角 ，。、；： 去掉，行内的 ，、 换空格（`"punct": "keep"` 关掉）。依据：`routes/directing/DIRECTING.md` 步骤 9、`VISUAL-DESIGN.md` §6.3、`craft/animation.md` §5.6。

## 接进作品

声音脚本（`sound.py`）里把配音放进混音，并让配乐与环境声让路：

```python
from engine.audio.voice import dialogue as DL
import soundfile as sf
vo, _ = sf.read('films/<名>/out/dialogue/voice.wav', always_2d=True)
duck = DL.duck_curve(np.arange(len(vo)) / SR, DL.spans('films/<名>/out/dialogue/voice.json'), depth=0.5)
mix = music * duck[:, None] + amb * duck[:, None] + vo
```

页面（字幕画在显示层，位置与 `window.TEXTS` 同一份数）：

```js
import { subtitleLayout, textsFrom } from '../../engine/audio/voice/texts.mjs';
const layout = subtitleLayout(texts, { width: 1920, height: 1080, font: '"Noto Sans SC"' });
window.TEXTS = textsFrom(layout);          // tools/qa texts 读它查安全区、停留时长、对比度、缺字
```

## 凭据、缓存、离线

- 密钥只从环境变量（`MINIMAX_API_KEY`）或系统钥匙串（服务名 `beiming-minimax`：macOS `security`、Linux `secret-tool`、Windows 凭据管理器）读；仓库不读任何密钥文件，也不把密钥写进缓存、日志和报告。`node tools/audio/voice.mjs providers` 会给出三个平台各自的存法。
- 缓存键 = sha256(服务, 模型, 音色, 影响声音的参数, 原话)。原始响应进缓存前去掉所有地址的查询串（签名、过期时间）和请求追踪号。默认在 `films/<名>/out/cache/voice`（不入库）；付费合成的长片设 `BEIMING_VOICE_CACHE` 到仓库外的固定目录，换检出不用重付。
- `--offline`：联网服务只读缓存；本机服务（synthetic、say、command）照常合成。

## 限制

- 中文没有读音表：口型只给开合度与音节边界（粗同步）；要音素级口型，在台词里写 `visemes`（`[[字, 起帧, 止帧, 口型], …]`）覆盖。
- 没有逐字时间戳的服务（say、录音）用停顿锚定的比例分配，`voice.json` 的 `timing` 写 `proportional`；字幕起点仍跟真实开口对齐。
