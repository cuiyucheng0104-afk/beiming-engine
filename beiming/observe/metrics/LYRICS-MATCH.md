# lyrics.match 英文歌词对词

`lyricsMatch(referenceWords, hypothesisWords)` 是同步 JS 函数。参考歌词先按空白拆成词，识别侧逐项取 Whisper 的 `segments[].words[].word`。两侧逐词转小写，保留 ASCII 字母和直撇号，识别侧丢弃处理后为空的项。参考侧保留纯标点项，计入分母，与案例 20 的 `工程/lyrics_check.py` 一致。每侧最多 512 项，每项最多 256 个 UTF-16 单元。参考侧至少一词，各项须有非空白内容。识别侧可空，此时得分为零。非法输入抛出 `usage.bad-argument`。

对齐采用 Python `difflib.SequenceMatcher(None, ref, hyp, autojunk=False)` 的匹配块规则。每次选择最长连续相同词块，并列时优先参考起点较早者，再优先识别起点较早者。从该块左右各自的剩余区间继续对齐。返回 `matchedWords`（匹配块长度之和）、`referenceWords`、`hypothesisWords` 和 `value = matchedWords / referenceWords`，单位 `ratio`。重复词参加匹配，单纯多识别词可保留满分，因而核对结果时应同时看识别词数。该指标测量识别文本与给定英文歌词的一致程度。

## 案例 20 的两次测量

| 识别数据 | 有效识别词 | 命中词 | 参考词 | value |
| --- | ---: | ---: | ---: | ---: |
| 案例 20《Nobody’s Voice》原案量测文件保存的识别文本 | 38 | 31 | 40 | 0.775 |
| 相同原片、下列固定本机环境重新识别的词级结果 | 40 | 34 | 40 | 0.85 |

历史记录给出了 Whisper small、CPU、英文、词级时间戳和 fp16 关闭，未给出识别包版本。第一行从当年的转写重算，第二行从音轨重识别。测试夹具在两侧共用同一个词相等性映射，只保留词序与重复关系。

## 本地复算

在仓库根运行。环境变量 `CASE_ENGINEERING` 指向案例 20 的工程目录，`CASE_VIDEO` 指向原片，`WHISPER_SMALL_FILE` 指向已有的 small 权重。按需用 `BEIMING_PYTHON` 指定已装识别包的解释器。验证环境为 macOS arm64、openai-whisper 20250625、PyTorch 2.10.0、FFmpeg 8.0.1、CPU 四线程。Whisper 通过 FFmpeg 读取单声道 16 kHz PCM，指定 en、word_timestamps=True、fp16=False，其余解码参数采用该包默认值。显式使用已有权重文件的路径；下面先检查原片与权重的 SHA256。

```sh
node tools/env/py.mjs -B - <<'PY'
import ast, hashlib, json, os, subprocess
from importlib.metadata import version
from pathlib import Path
import torch, whisper

case = Path(os.environ['CASE_ENGINEERING'])
video = Path(os.environ['CASE_VIDEO']).resolve(strict=True)
weights = Path(os.environ['WHISPER_SMALL_FILE']).resolve(strict=True)
for path, expected in [
    (video, 'a764a19c58c3a3f3e2409f6cbab1ef7f46507e02d33d41663007dca9a04e1f99'),
    (weights, '9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794'),
]:
    with path.open('rb') as handle:
        if hashlib.file_digest(handle, 'sha256').hexdigest() != expected:
            raise ValueError('input digest mismatch')
if version('openai-whisper') != '20250625' or version('torch') != '2.10.0':
    raise ValueError('recognizer version mismatch')

# 只读取已归档脚本中的参考歌词字面量，不运行上游代码。
tree = ast.parse((case / 'lyrics_check.py').read_text('utf-8'))
lyrics = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
              and any(isinstance(t, ast.Name) and t.id == 'LYR' for t in n.targets))
ref = [word for line in lyrics for word in line.split()]
archive = (case / '量测结果.txt').read_text('utf-8').splitlines()[31].split()
torch.set_num_threads(4)
model = whisper.load_model(str(weights), device='cpu')
result = model.transcribe(str(video), language='en', word_timestamps=True, fp16=False, verbose=None)
live = [w['word'] for s in result['segments'] for w in s['words']]
js = """
import { readFileSync } from 'node:fs';
import { lyricsMatch } from './beiming/observe/metrics/lyrics-match.mjs';
const [ref, hyp] = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(lyricsMatch(ref, hyp)));
"""
for hyp in [archive, live]:
    subprocess.run(['node', '--input-type=module', '-e', js], check=True,
                   input=json.dumps([ref, hyp]), text=True)
PY
```

识别只在可选核对步骤中运行。日常测试只需 Node，运行 `node --test beiming/observe/metrics/lyrics-match.test.mjs`。
