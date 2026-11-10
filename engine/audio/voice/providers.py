# -*- coding: utf-8 -*-
"""北冥引擎 · 配音 · TTS 适配层：与服务商无关的统一接口，所有输出统一成 48 kHz 单声道 float64。

  get(name, voice, model, params) → Provider
  Provider.available() → (能用吗, 原因, 下一步)        不联网、不花钱，只看依赖与凭据在不在
  Provider.identity() → dict                            进缓存键的字段（服务、模型、音色、影响声音的参数）
  Provider.synth(text, workdir) → Result                text 是这一段要念的原话（已按 <#秒#> 切段；supports_pause 的服务整句送）
  Result: audio（48 kHz 单声道 float64）、words（[[字词, 起秒, 止秒], …] 或 None）、raw（去掉签名地址与追踪号的原始响应摘要）、billed

内置：
  synthetic  离线、确定的「临时配音」：共振峰嗡声按字发音，时间戳精确（动态预演和测试用；不是真人声，不能交付）
  say        macOS 自带 say（离线；有中文音色 Tingting 等，没有时间戳，按停顿锚定对齐）
  command    任意本地 TTS 命令（Piper、CosyVoice、Windows SAPI 的 PowerShell 脚本……）：params.argv 里用 {text} {text_file} {out}
             {voice} {rate} 占位；可选 params.words 指向它写出的 [[字词, 起, 止], …] JSON
  minimax    MiniMax 语音合成 t2a_v2（联网、按字计费）：密钥只从 MINIMAX_API_KEY 或系统钥匙串 beiming-minimax 读；
             逐字时间戳从返回的字幕文件取；端点用 params.endpoint 或 MINIMAX_API_BASE 换（默认 https://api.minimax.cn）
  edge       edge-tts（可选依赖 pip install edge-tts；联网、免费）：WordBoundary 给逐词时间
出错抛 VoiceError(code, message, hint)：code 前缀 env. → 退出码 3（缺依赖、缺密钥、网络），contract. → 4，其余 1。
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np

from ..dsp import SR
from . import align as AL
from . import secrets as SEC


class VoiceError(Exception):
    def __init__(self, code, message, hint=None):
        super().__init__(message)
        self.code, self.message, self.hint = code, message, hint


class Result:
    def __init__(self, audio, words=None, raw=None, billed=None):
        self.audio, self.words, self.raw, self.billed = np.asarray(audio, dtype=np.float64), words, raw or {}, billed


def to_mono48(x, sr):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        x = x.mean(axis=1)
    if sr != SR:
        import soxr
        x = soxr.resample(x, sr, SR, quality='VHQ')
    return x


def read_audio(path):
    import soundfile as sf
    try:
        x, sr = sf.read(path, dtype='float64', always_2d=True)
    except Exception:
        # soundfile 读不了的格式（mp3 等）交给 ffmpeg 解码
        ff = shutil.which('ffmpeg')
        if not ff:
            raise VoiceError('env.ffmpeg', f'读不了 {os.path.basename(path)}，解码要 ffmpeg', '装 FFmpeg ≥ 7 并放进 PATH') from None
        r = subprocess.run([ff, '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True)
        if r.returncode != 0:
            raise VoiceError('failure.decode', f'ffmpeg 解不开 {os.path.basename(path)}：{r.stderr.decode("utf-8", "replace")[-300:]}') from None
        return np.frombuffer(r.stdout, dtype='<f4').astype(np.float64)
    return to_mono48(x, sr)


def strip_signed(obj):
    """原始响应进缓存前：去掉所有 URL 的查询串（签名、过期时间），去掉 trace_id 一类的请求追踪号"""
    if isinstance(obj, dict):
        return {k: strip_signed(v) for k, v in obj.items() if k.lower() not in ('trace_id', 'traceid', 'request_id', 'x-request-id')}
    if isinstance(obj, list):
        return [strip_signed(v) for v in obj]
    if isinstance(obj, str) and re.match(r'^https?://', obj):
        u = urllib.parse.urlsplit(obj)
        return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, '', ''))
    return obj


class Provider:
    name = ''
    network = False
    supports_pause = False
    defaults = {}

    def __init__(self, voice=None, model=None, params=None):
        self.voice = voice or self.defaults.get('voice')
        self.model = model or self.defaults.get('model')
        self.params = dict(params or {})

    def identity(self):
        keep = {k: v for k, v in sorted(self.params.items()) if k not in ('endpoint', 'timeout', 'minInterval')}
        return {'provider': self.name, 'model': self.model, 'voice': self.voice, 'params': keep}

    def available(self):
        return True, '', None

    def synth(self, text, workdir):
        raise NotImplementedError


# ———————————————— synthetic：确定的临时配音 ————————————————
_VOWELS = [(730, 1090, 2440), (530, 1840, 2480), (270, 2290, 3010), (570, 840, 2410), (300, 870, 2240), (440, 1020, 2240)]
PAUSE_SEC = {'strong': 0.34, 'medium': 0.24, 'weak': 0.16}


class Synthetic(Provider):
    name = 'synthetic'
    defaults = {'voice': 'narrator', 'model': 'formant-v1'}

    def synth(self, text, workdir):
        speed = float(self.params.get('speed', 1.0))
        f0 = float(self.params.get('f0', {'narrator': 150.0, 'female': 220.0, 'child': 290.0}.get(self.voice, 160.0)))
        seed = int(hashlib.sha256(f'{self.voice}|{text}'.encode('utf-8')).hexdigest()[:8], 16)
        r = np.random.default_rng(seed)
        out, words, t = [], [], 0.04
        out.append(np.zeros(int(round(0.04 * SR))))
        for u in AL.units(text):
            if u.kind in ('punct', 'pause'):
                d = u.pause if u.kind == 'pause' else PAUSE_SEC['strong' if u.text in AL.STRONG else ('medium' if u.text in AL.MEDIUM else 'weak')]
                d /= speed
                out.append(np.zeros(int(round(d * SR))))
                t += len(out[-1]) / SR
                continue
            d = (0.21 if u.kind == 'char' else 0.13 * u.weight + 0.08) / speed
            n = int(round(d * SR))
            tt = np.arange(n) / SR
            k = int(hashlib.md5(u.text.encode('utf-8')).hexdigest()[:4], 16)
            fa, fb, fc = _VOWELS[k % len(_VOWELS)]
            tone = (k >> 3) % 4                                   # 四个声调的粗略音高走向
            curve = {0: 0.0 * tt, 1: 0.18 * tt / d, 2: -0.16 * tt / d, 3: -0.1 * np.sin(np.pi * tt / d)}[tone]
            fr = f0 * (1 + curve) * (1 + 0.01 * r.standard_normal())
            ph = 2 * np.pi * np.cumsum(fr) / SR
            sig = np.zeros(n)
            for h in range(1, 30):
                fh = fr * h
                amp = sum(np.exp(-((fh - fo) / (60 + 0.08 * fo)) ** 2) * g for fo, g in ((fa, 1.0), (fb, 0.6), (fc, 0.25))) + 0.02
                sig += amp * np.sin(h * ph) / h
            env = np.minimum(1, tt / 0.018) * np.minimum(1, (d - tt) / 0.045).clip(0, 1)
            burst = r.standard_normal(n) * np.exp(-tt / 0.012) * 0.15
            out.append((sig * env + burst) * 0.25)
            words.append([u.text, round(t, 4), round(t + d, 4)])
            t += n / SR
        out.append(np.zeros(int(round(0.06 * SR))))
        return Result(np.concatenate(out), words, {'engine': 'synthetic formant voice', 'note': '临时配音，不是真人声'})


# ———————————————— say：macOS 离线 TTS ————————————————
class MacSay(Provider):
    name = 'say'
    defaults = {'voice': 'Tingting', 'model': 'macOS say'}

    def available(self):
        if sys.platform != 'darwin' or not shutil.which('say'):
            return False, '只有 macOS 有 say', '其他系统用 command（本地 TTS）或 minimax / edge'
        r = subprocess.run(['say', '-v', '?'], capture_output=True, text=True)
        names = {ln.split('  ')[0].strip() for ln in r.stdout.splitlines()}
        if self.voice not in names:
            return False, f'没有 say 音色 {self.voice}', '系统设置 → 辅助功能 → 朗读内容 → 系统声音里下载，或换 voice（say -v ? 列出可用的）'
        return True, '', None

    def synth(self, text, workdir):
        ok, why, hint = self.available()
        if not ok:
            raise VoiceError('env.voice-provider', why, hint)
        rate = int(round(float(self.params.get('rate', 180)) * float(self.params.get('speed', 1.0))))
        tf, out = os.path.join(workdir, 'say.txt'), os.path.join(workdir, 'say.wav')
        with open(tf, 'w', encoding='utf-8') as f:
            f.write(text)
        r = subprocess.run(['say', '-v', self.voice, '-r', str(rate), '-f', tf, '-o', out, '--file-format=WAVE', '--data-format=LEI16@48000'],
                           capture_output=True, text=True, timeout=float(self.params.get('timeout', 120)))
        if r.returncode != 0 or not os.path.exists(out):
            raise VoiceError('failure.voice-provider', f'say 失败（退出码 {r.returncode}）：{(r.stderr or r.stdout).strip()[-300:]}')
        return Result(read_audio(out), None, {'engine': 'macOS say', 'voice': self.voice, 'rate': rate})


# ———————————————— command：任意本地 TTS ————————————————
class Command(Provider):
    name = 'command'
    defaults = {'voice': 'default', 'model': 'command'}

    def available(self):
        argv = self.params.get('argv')
        if not isinstance(argv, list) or not argv:
            return False, 'command 要在 params.argv 写命令（字符串数组，{text} {text_file} {out} {voice} {rate} 占位）', None
        if not shutil.which(argv[0]) and not os.path.exists(argv[0]):
            return False, f'找不到命令 {argv[0]}', '装好本地 TTS，或写可执行文件的完整路径'
        return True, '', None

    def synth(self, text, workdir):
        ok, why, hint = self.available()
        if not ok:
            raise VoiceError('env.voice-provider', why, hint)
        tf, out = os.path.join(workdir, 'text.txt'), os.path.join(workdir, 'out.wav')
        with open(tf, 'w', encoding='utf-8') as f:
            f.write(text)
        sub = {'text': text, 'text_file': tf, 'out': out, 'voice': self.voice or '', 'rate': str(self.params.get('rate', ''))}
        argv = [str(a).format(**sub) for a in self.params['argv']]
        stdin = str(self.params['stdin']).format(**sub) if self.params.get('stdin') else None
        try:
            r = subprocess.run(argv, input=stdin, capture_output=True, text=True, timeout=float(self.params.get('timeout', 300)))
        except subprocess.TimeoutExpired:
            raise VoiceError('timeout', f'TTS 命令超过 {self.params.get("timeout", 300)} 秒') from None
        if r.returncode != 0 or not os.path.exists(out):
            raise VoiceError('failure.voice-provider', f'TTS 命令失败（退出码 {r.returncode}）：{(r.stderr or r.stdout).strip()[-300:]}',
                             '先在终端里单独跑这条命令确认能出 wav')
        words = None
        if self.params.get('words'):
            wp = str(self.params['words']).format(**sub)
            if os.path.exists(wp):
                with open(wp, encoding='utf-8') as f:
                    words = json.load(f)
        return Result(read_audio(out), words, {'engine': 'command', 'argv0': os.path.basename(argv[0])})


# ———————————————— minimax：云端，逐字时间戳 ————————————————
class MiniMax(Provider):
    name = 'minimax'
    network = True
    supports_pause = True
    defaults = {'voice': 'Chinese (Mandarin)_Reliable_Executive', 'model': 'speech-2.8-hd'}
    ENV = ('MINIMAX_API_KEY', 'BEIMING_MINIMAX_KEY')
    SERVICE = 'beiming-minimax'
    _last = 0.0

    def key(self):
        return SEC.get_secret(self.SERVICE, self.ENV)

    def available(self):
        if not self.key():
            return False, 'MiniMax 的密钥没有设置', SEC.how_to_set(self.SERVICE, self.ENV)
        return True, '', None

    def _post(self, url, body, key, timeout):
        req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'),
                                     headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def synth(self, text, workdir):
        key = self.key()
        if not key:
            raise VoiceError('env.voice-key', 'MiniMax 的密钥没有设置', SEC.how_to_set(self.SERVICE, self.ENV))
        base = (self.params.get('endpoint') or os.environ.get('MINIMAX_API_BASE') or 'https://api.minimax.cn').rstrip('/')
        timeout = float(self.params.get('timeout', 180))
        vs = {'voice_id': self.voice, 'speed': float(self.params.get('speed', 1.0)), 'vol': float(self.params.get('vol', 1.0)),
              'pitch': int(self.params.get('pitch', 0))}
        if self.params.get('emotion'):
            vs['emotion'] = self.params['emotion']
        body = {'model': self.model, 'text': text, 'stream': False, 'voice_setting': vs,
                'audio_setting': {'sample_rate': int(self.params.get('sampleRate', 44100)), 'format': 'wav', 'channel': 1},
                'language_boost': self.params.get('languageBoost', 'Chinese'), 'subtitle_enable': True, 'subtitle_type': 'word',
                'output_format': 'hex', 'aigc_watermark': bool(self.params.get('aigcWatermark', False))}
        gap = float(self.params.get('minInterval', 3.2))           # 默认 20 次 / 分钟以内
        r, last_err = None, None
        for attempt in range(4):
            wait = MiniMax._last + gap - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                r = self._post(f'{base}/v1/t2a_v2', body, key, timeout)
            except (urllib.error.URLError, OSError, ValueError) as e:
                last_err = f'网络：{e}'
                time.sleep(3 * (attempt + 1))
                continue
            finally:
                MiniMax._last = time.time()
            st = (r.get('base_resp') or {}).get('status_code')
            if st == 0 and (r.get('data') or {}).get('audio'):
                break
            msg = (r.get('base_resp') or {}).get('status_msg', '')
            if st in (1004, 2049, 1008, 2013, 2014, 2038, 2022, 1026, 1027, 1042):   # 鉴权、余额、参数、内容审核：重试无用
                raise VoiceError('env.voice-auth' if st in (1004, 2049, 1008) else 'contract.voice-request', f'MiniMax 拒绝（{st}）：{msg}',
                                 '检查密钥与余额' if st in (1004, 2049, 1008) else '检查音色、模型、参数与台词内容')
            last_err = f'状态 {st}：{msg}'
            time.sleep(6 * (attempt + 1))
            r = None
        if r is None:
            raise VoiceError('env.network', f'MiniMax 合成失败：{last_err}', '检查网络或稍后重试；离线时用 --offline 只读缓存')
        wav = os.path.join(workdir, 'mm.wav')
        with open(wav, 'wb') as f:
            f.write(bytes.fromhex(r['data']['audio']))
        words = None
        sub = (r.get('data') or {}).get('subtitle_file')
        if sub:
            try:
                with urllib.request.urlopen(sub, timeout=timeout) as resp:
                    d = json.load(resp)
                words = [[w['word'], w['time_begin'] / 1000.0, w['time_end'] / 1000.0] for s in d for w in s.get('timestamped_words', [])]
            except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError):
                words = None                                          # 没拿到时间戳就按停顿锚定对齐（timing 记 proportional）
        raw = dict(r)
        raw['data'] = {k: ('<音频已存成 wav>' if k == 'audio' else v) for k, v in (r.get('data') or {}).items()}
        ex = r.get('extra_info') or {}
        return Result(read_audio(wav), words, strip_signed(raw), ex.get('usage_characters'))


# ———————————————— edge：edge-tts（可选依赖） ————————————————
class Edge(Provider):
    name = 'edge'
    network = True
    defaults = {'voice': 'zh-CN-YunxiNeural', 'model': 'edge-tts'}

    def available(self):
        try:
            import edge_tts  # noqa: F401
        except ImportError:
            return False, '没装 edge-tts', 'pip install edge-tts（可选依赖，联网使用）'
        return True, '', None

    def synth(self, text, workdir):
        ok, why, hint = self.available()
        if not ok:
            raise VoiceError('env.voice-provider', why, hint)
        import asyncio
        import edge_tts
        speed = float(self.params.get('speed', 1.0))
        kw = {'rate': f'{int(round((speed - 1) * 100)):+d}%', 'pitch': f'{int(self.params.get("pitch", 0)):+d}Hz'}
        mp3, words = os.path.join(workdir, 'edge.mp3'), []

        async def go():
            try:
                comm = edge_tts.Communicate(text, self.voice, boundary='WordBoundary', **kw)
            except TypeError:                                         # 旧版没有 boundary 参数（默认就是逐词）
                comm = edge_tts.Communicate(text, self.voice, **kw)
            with open(mp3, 'wb') as f:
                async for ch in comm.stream():
                    if ch.get('type') == 'audio':
                        f.write(ch['data'])
                    elif ch.get('type') == 'WordBoundary':
                        words.append([ch['text'], ch['offset'] / 1e7, (ch['offset'] + ch['duration']) / 1e7])
        try:
            asyncio.run(go())
        except Exception as e:  # edge-tts 的网络错误类型随版本变
            raise VoiceError('env.network', f'edge-tts 合成失败：{type(e).__name__}: {e}', '检查网络；离线时用 --offline 只读缓存') from None
        return Result(read_audio(mp3), words or None, {'engine': 'edge-tts', 'voice': self.voice, **kw})


PROVIDERS = {p.name: p for p in (Synthetic, MacSay, Command, MiniMax, Edge)}


def get(name, voice=None, model=None, params=None):
    if name not in PROVIDERS:
        raise VoiceError('usage.voice-provider', f'不认识的 TTS：{name!r}', f'可用：{"、".join(PROVIDERS)}')
    return PROVIDERS[name](voice, model, params)


def workdir():
    return tempfile.mkdtemp(prefix='beiming-voice-')
