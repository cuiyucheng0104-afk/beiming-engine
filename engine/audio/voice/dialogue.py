# -*- coding: utf-8 -*-
"""北冥引擎 · 配音 · 对白文件 dialogue.json → 配音轨、字幕（SRT / WebVTT / ASS）、window.TEXTS 的数据、口型提示，同一份时间。

dialogue.json（schema "beiming.dialogue/1"，放在作品目录；别的位置就把路径直接交给命令）：
  {
    "schema": "beiming.dialogue/1",
    "speakers": {                                    说话人 → 怎么发声（服务见 engine/audio/voice/providers.py）
      "narrator": { "provider": "minimax", "voice": "…", "model": "…", "params": {"speed": 1.0}, "gainDb": 0, "pan": 0 }
    },
    "lines": [
      { "id": "L1", "speaker": "narrator",
        "text": "字幕上显示的字（逐字时间也按它算）",
        "read": "可选：送给 TTS 的读法（多音字、数字读法、<#0.3#> 停顿）；不写就念 text",
        "at": 48,                                    开口的那一帧（整数帧；或写 "t": 2.0 秒）。配音的第一个有声样本落在这一帧
        "end": 120,                                  可选：最晚必须说完的帧（放不下就报错，而不是压过下一个镜头）
        "audio": "vo/L1.wav",                        可选：已经录好的音频（相对本文件），不走 TTS
        "gainDb": 0, "pan": 0, "visemes": [...]     可选
      } ],
    "subtitles": { "maxChars": 18, "maxLines": 2, … }   可选，字段见 engine/audio/voice/subtitles.py 的 Config
    "lips": { "leadFrames": 1, "step": 1 }             可选：口型比声音提前几帧、几帧出一个口型（一拍二写 2）
  }

build(dialogue, film=None, out=None, cache=None, offline=False, provider=None, log=print) → 结果 dict
  out（默认 <作品>/out/dialogue/）下写：
    voice.wav       配音轨：48 kHz 立体声 32 位浮点（不削波），长度 = 片长（film.json 的帧数）或最后一句说完再留 0.5 秒
    subtitles.srt / subtitles.vtt / subtitles.ass   同一组起止帧
    texts.json      window.TEXTS 的数据源：每条字幕的文字、分行、起止秒与帧、说话人（engine/audio/voice/texts.mjs 读它排版）
    lips.json       每句每帧的开口度与音节口型（engine/audio/voice/lips.py）
    onsets.json     {onsets: {句子 id: 开口秒}, notes: []}（与 score_onsets.json 同一写法，cuecheck --onsets 可直接读）
    voice.json      明细：每句的服务、缓存键、计时方法（tts / proportional）、开口与说完的时刻、警告
  离线（offline=True）：联网的服务（minimax、edge）只读缓存，缓存没有就报 env.voice-offline（退出码 3）；本机的（synthetic、say、
  command）照常合成。provider="synthetic" 把所有说话人换成确定的临时配音（动态预演、测试用，不是真人声）。
duck_curve(times, spans, depth=0.5, pre=0.12, post=0.35) → 增益曲线（0..1）：配乐、环境声在台词期间让开 depth，给声音脚本用
spans(voice_json) → [(开口秒, 说完秒), …]
"""
import json
import math
import os

import numpy as np

from ..dsp import SR, N, undb, stereo
from .. import stream as S
from . import align as AL
from . import cache as CA
from . import lips as LP
from . import providers as PV
from . import subtitles as ST

SCHEMA = 'beiming.dialogue/1'
LINE_KEYS = {'id', 'speaker', 'text', 'read', 'at', 't', 'end', 'audio', 'gainDb', 'pan', 'visemes', 'note', '说明'}
SPEAKER_KEYS = {'provider', 'voice', 'model', 'params', 'gainDb', 'pan', 'note', '说明'}


class DialogueError(Exception):
    def __init__(self, code, message, hint=None):
        super().__init__(message)
        self.code, self.message, self.hint = code, message, hint


def _err(code, msg, hint=None):
    return DialogueError(code, msg, hint)


def load(path):
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
    except FileNotFoundError:
        raise _err('env.dialogue-missing', f'找不到对白文件 {path}', '在作品目录写 dialogue.json（写法见 engine/audio/voice/README.md）') from None
    except ValueError as e:
        raise _err('contract.dialogue-json', f'{path} 不是合法 JSON：{e}') from None
    problems = validate(d)
    if problems:
        raise _err('contract.dialogue', f'{os.path.basename(path)} 有 {len(problems)} 处不合规：' + '；'.join(problems[:8]),
                   '按 engine/audio/voice/README.md 的写法改')
    return d


def validate(d):
    p = []
    if not isinstance(d, dict):
        return ['顶层要是对象']
    if d.get('schema') != SCHEMA:
        p.append(f'schema 要写 {SCHEMA}')
    spk = d.get('speakers')
    if not isinstance(spk, dict) or not spk:
        p.append('speakers 要是非空对象：{说话人: {provider, voice, …}}')
        spk = {}
    for name, s in spk.items():
        if not isinstance(s, dict):
            p.append(f'speakers.{name} 要是对象')
            continue
        bad = sorted(set(s) - SPEAKER_KEYS)
        if bad:
            p.append(f'speakers.{name} 有不认识的字段 {"、".join(bad)}')
        if s.get('provider') not in PV.PROVIDERS:
            p.append(f'speakers.{name}.provider 要是 {"、".join(PV.PROVIDERS)} 之一（收到 {s.get("provider")!r}）')
    lines = d.get('lines')
    if not isinstance(lines, list) or not lines:
        return p + ['lines 要是非空数组']
    seen = set()
    for i, ln in enumerate(lines):
        w = f'lines[{i}]'
        if not isinstance(ln, dict):
            p.append(f'{w} 要是对象')
            continue
        bad = sorted(set(ln) - LINE_KEYS)
        if bad:
            p.append(f'{w} 有不认识的字段 {"、".join(bad)}')
        lid = ln.get('id')
        if not isinstance(lid, str) or not lid:
            p.append(f'{w}.id 要是非空字符串')
        elif lid in seen:
            p.append(f'{w}.id {lid} 重复')
        seen.add(lid)
        if ln.get('speaker') not in spk:
            p.append(f'{w}.speaker {ln.get("speaker")!r} 不在 speakers 里')
        if not isinstance(ln.get('text'), str) or not AL.strip_markers(ln['text']).strip():
            p.append(f'{w}.text 要是非空字符串')
        has_at, has_t = 'at' in ln, 't' in ln
        if has_at == has_t:
            p.append(f'{w} 要写 at（开口帧，整数）或 t（秒）之一')
        elif has_at and (not isinstance(ln['at'], int) or isinstance(ln['at'], bool) or ln['at'] < 0):
            p.append(f'{w}.at 要是非负整数帧')
        elif has_t and (not isinstance(ln['t'], (int, float)) or isinstance(ln['t'], bool) or ln['t'] < 0):
            p.append(f'{w}.t 要是非负秒数')
        if 'end' in ln and (not isinstance(ln['end'], int) or isinstance(ln['end'], bool)):
            p.append(f'{w}.end 要是整数帧')
    try:
        ST.Config(**(d.get('subtitles') or {}))
    except ValueError as e:
        p.append(str(e))
    return p


def _find_film(dialogue_path, film):
    from .. import filmspec as F
    if film:
        return F.load(film)
    d = os.path.dirname(os.path.abspath(dialogue_path))
    for cand in (d, os.path.dirname(d)):
        if os.path.exists(os.path.join(cand, 'film.json')):
            return F.load(cand)
    return None


def resolve_dialogue(target):
    """作品目录（读其中的 dialogue.json）或 dialogue.json 的路径 → (dialogue 路径, 作品目录或 None)"""
    p = os.path.abspath(target)
    if os.path.isdir(p):
        return os.path.join(p, 'dialogue.json'), (p if os.path.exists(os.path.join(p, 'film.json')) else None)
    return p, None


def _synth(line, spk, prov, cache, offline, workdir, log):
    """一句 → (48 kHz 单声道, 逐字时间 [[字词, 起, 止]] 或 None, 明细)"""
    text = line.get('read') or line['text']
    ident = prov.identity()
    k = CA.key(ident, text)
    hit = cache.get(k)
    if hit is not None:
        audio, meta = hit
        return audio, meta.get('words'), {'cache': 'hit', 'key': k, 'provider': ident}
    if offline and prov.network:
        raise _err('env.voice-offline', f'离线模式下缓存里没有这句（{line["id"]}，{prov.name}）',
                   '联网跑一次（去掉 --offline）把它合成进缓存；或用 --cache 指向已有缓存')
    ok, why, hint = prov.available()
    if not ok:
        raise _err('env.voice-provider', f'{line["speaker"]} 的配音服务 {prov.name} 用不了：{why}', hint)
    segs = [(text, 0.0)] if prov.supports_pause or not AL.PAUSE_RE.search(text) else AL.split_pauses(text)
    parts, words, raws, t = [], [], [], 0.0
    for seg, pause in segs:
        if seg.strip():
            r = PV_call(prov, seg, workdir)
            parts.append(r.audio)
            if r.words:
                words += [[w, a + t, b + t] for w, a, b in r.words]
            raws.append(r.raw)
            t += len(r.audio) / SR
        if pause > 0:
            parts.append(np.zeros(N(pause)))
            t += pause
    audio = np.concatenate(parts) if parts else np.zeros(N(0.1))
    meta = {'provider': ident, 'text': text, 'words': words or None, 'raw': raws[0] if len(raws) == 1 else raws}
    cache.put(k, audio, meta)
    log(f'  合成 {line["id"]}（{prov.name}）{len(audio) / SR:.2f} 秒')
    audio, meta = cache.get(k)          # 用缓存里那一份（24 bit），第一次与之后读缓存的结果逐样本相同
    return audio, meta.get('words'), {'cache': 'miss', 'key': k, 'provider': ident}


def PV_call(prov, text, workdir):
    try:
        return prov.synth(text, workdir)
    except PV.VoiceError as e:
        raise _err(e.code, e.message, e.hint) from None


def build(dialogue, film=None, out=None, cache=None, offline=False, provider=None, log=print):
    dpath, film_dir = resolve_dialogue(dialogue)
    d = load(dpath)
    fs = _find_film(dpath, film or film_dir)
    fps = (fs or {}).get('fps') or int(d.get('fps') or 24)
    frames = (fs or {}).get('frameCount')
    size = ((fs or {}).get('width') or 1920, (fs or {}).get('height') or 1080)
    cuts = (fs or {}).get('cuts') or []
    base = (fs or {}).get('filmDir') or os.path.dirname(dpath)
    out = os.path.abspath(out or os.path.join(base, 'out', 'dialogue'))
    cache_dir = os.path.abspath(cache or os.path.join(base, 'out', 'cache', 'voice'))
    cfg = ST.Config(**(d.get('subtitles') or {}))
    lips_cfg = {'leadFrames': 1, 'step': 1}
    lips_cfg.update(d.get('lips') or {})
    store = CA.Cache(cache_dir)
    os.makedirs(out, exist_ok=True)
    warns, rows, cues, lip_rows, placed = [], [], [], [], []
    wd = PV.workdir()
    try:
        for ln in d['lines']:
            spk = d['speakers'][ln['speaker']]
            if ln.get('audio'):
                ap = os.path.join(os.path.dirname(dpath), *ln['audio'].split('/'))
                if not os.path.exists(ap):
                    raise _err('env.voice-audio', f'{ln["id"]} 的录音 {ln["audio"]} 不存在')
                audio, words, info = PV.read_audio(ap), None, {'cache': 'recorded', 'key': None, 'provider': {'provider': 'recorded', 'file': ln['audio']}}
            else:
                if provider:                # 统一换成某个服务（例如动态预演用 synthetic）：说话人之间用音高区分
                    idx = list(d['speakers']).index(ln['speaker'])
                    prov = PV.get(provider, ln['speaker'], None, {'f0': 130.0 + 45.0 * (idx % 4)} if provider == 'synthetic' else None)
                else:
                    prov = PV.get(spk['provider'], spk.get('voice'), spk.get('model'), spk.get('params'))
                audio, words, info = _synth(ln, spk, prov, store, offline, wd, log)
            disp = AL.strip_markers(ln['text'])
            us = AL.units(disp)
            if words:
                timed, method = AL.from_provider(us, words), {'method': 'tts'}
            else:
                timed, how = AL.proportional(audio, SR, us)
                method = {'method': 'proportional', 'anchoring': how['method'], 'regions': how['regions'], 'anchors': how['anchors']}
            regs = AL.voiced_regions(audio, SR)
            lead = regs[0][0] if regs else 0.0
            tail = regs[-1][1] if regs else len(audio) / SR
            start = (ln['at'] / fps) if 'at' in ln else float(ln['t'])
            place = start - lead
            if place < 0:
                warns.append({'code': 'voice.early', 'message': f'{ln["id"]} 开口在第 0 帧之前放不下：整句往后挪了 {-place:.3f} 秒'})
                place = 0.0
            onset, done = place + lead, place + tail
            if 'end' in ln and done > ln['end'] / fps + 1e-9:
                raise _err('contract.voice-too-long', f'{ln["id"]} 说完在 {done:.2f} 秒（第 {math.ceil(done * fps)} 帧），超过 end 第 {ln["end"]} 帧',
                           '加快语速（params.speed）、删字，或把 end 往后放')
            gain = float(undb(float(spk.get('gainDb', 0)) + float(ln.get('gainDb', 0))))
            pan = float(ln.get('pan', spk.get('pan', 0)))
            placed.append((audio * gain, place, pan))
            abs_timed = [[u, round(a + place, 4), round(b + place, 4)] for u, a, b in timed]
            for i, c in enumerate(ST.cue_texts(disp, abs_timed, cfg)):
                c.update(id=f'{ln["id"]}.{i + 1}', line=ln['id'], speaker=ln['speaker'])
                cues.append(c)
            kinds = [u.kind for u in us]
            lead_f = int(lips_cfg.get('leadFrames', 1))
            f_on = int(math.floor(onset * fps + 1e-6))       # 口型曲线从开口那一帧算起（再整体提前 lead 帧）
            off = int(round((f_on / fps - place) * SR))
            seg_audio = audio[off:] if off >= 0 else np.concatenate([np.zeros(-off), audio])
            curve = LP.open_curve(seg_audio, SR, fps, lead=0, step=int(lips_cfg.get('step', 1)))
            if f_on < lead_f:                   # 片头第一句：提前量吃掉的那几帧直接丢
                curve = curve[lead_f - f_on:]
            lip_rows.append({'id': ln['id'], 'speaker': ln['speaker'], 'startFrame': max(0, f_on - lead_f), 'open': curve,
                             'syllables': ln.get('visemes') or LP.syllables(abs_timed, kinds, fps, lead=lead_f),
                             'leadFrames': lead_f})
            rows.append({'id': ln['id'], 'speaker': ln['speaker'], 'text': ln['text'], 'read': ln.get('read'), 'onset': round(onset, 4),
                         'end': round(done, 4), 'onsetFrame': int(math.floor(onset * fps + 1e-6)), 'endFrame': int(math.ceil(done * fps - 1e-6)),
                         'placedAt': round(place, 5), 'seconds': round(len(audio) / SR, 4), 'timing': method.get('method'),
                         'timingDetail': {k: v for k, v in method.items() if k != 'method'}, **info})
    finally:
        import shutil
        shutil.rmtree(wd, ignore_errors=True)
    # 同一个说话人的两句不能叠在一起
    by_spk = {}
    for r in sorted(rows, key=lambda r: r['onset']):
        prev = by_spk.get(r['speaker'])
        if prev and r['onset'] < prev['end'] - 1e-6:
            raise _err('contract.voice-overlap', f'{r["speaker"]} 的 {prev["id"]} 还没说完（{prev["end"]:.2f} 秒）{r["id"]} 就开口了（{r["onset"]:.2f} 秒）',
                       f'把 {r["id"]} 的 at 往后挪到第 {math.ceil(prev["end"] * fps) + 2} 帧以后，或加快 {prev["id"]} 的语速')
        by_spk[r['speaker']] = r
    last = max(r['end'] for r in rows)
    n = N(frames / fps) if frames else N(last + 0.5)
    if frames and last > frames / fps + 1e-9:
        raise _err('contract.voice-past-end', f'最后一句说完在 {last:.2f} 秒，片长只有 {frames / fps:.2f} 秒', '往前挪，或在 film.json 加长片子')
    bus = S.Bus(n, 'voice')
    for x, at, pan in placed:
        bus.place(stereo(x, pan), at)
    cues, w2 = ST.layout_frames(cues, fps, cfg, cuts=cuts, frames=frames)
    warns += w2
    for c in cues:
        c['start'], c['end'] = round(c['startFrame'] / fps, 4), round(c['endFrame'] / fps, 4)
    pk = float(np.abs(bus.buf).max()) if n else 0.0
    if pk > 1.0:
        warns.append({'code': 'voice.over-full-scale', 'message': f'配音轨峰值 {20 * math.log10(pk):+.2f} dBFS（浮点存储没有削波，混音时记得降）'})
    paths = {}
    paths['voice'] = S.write_wav(os.path.join(out, 'voice.wav'), bus.buf, subtype='FLOAT')
    paths['srt'] = ST.write_srt(os.path.join(out, 'subtitles.srt'), cues, fps)
    paths['vtt'] = ST.write_vtt(os.path.join(out, 'subtitles.vtt'), cues, fps)
    paths['ass'] = ST.write_ass(os.path.join(out, 'subtitles.ass'), cues, fps, size)
    texts = {'schema': 'beiming.texts/1', 'fps': fps, 'size': list(size), 'source': os.path.basename(dpath),
             'cues': [{k: c[k] for k in ('id', 'line', 'speaker', 'text', 'lines', 'start', 'end', 'startFrame', 'endFrame')} for c in cues]}
    paths['texts'] = _dump(os.path.join(out, 'texts.json'), texts)
    paths['lips'] = _dump(os.path.join(out, 'lips.json'), {'schema': 'beiming.lips/1', 'fps': fps, 'lines': lip_rows})
    paths['onsets'] = _dump(os.path.join(out, 'onsets.json'), {'onsets': {r['id']: r['onset'] for r in rows}, 'notes': []})
    paths['manifest'] = _dump(os.path.join(out, 'voice.json'), {
        'schema': 'beiming.voice-build/1', 'dialogue': os.path.basename(dpath), 'fps': fps, 'frames': frames, 'seconds': n / SR,
        'offline': offline, 'providerOverride': provider, 'cacheDir': _rel_or(cache_dir), 'subtitles': cfg.as_dict(), 'lips': lips_cfg,
        'lines': rows, 'cues': texts['cues'], 'warnings': warns})
    return {'out': out, 'paths': paths, 'lines': rows, 'cues': cues, 'warnings': warns, 'fps': fps,
            'cache': {'hit': sum(1 for r in rows if r['cache'] == 'hit'), 'miss': sum(1 for r in rows if r['cache'] == 'miss')}}


def _rel_or(p):
    from .._cli import rel
    return rel(p)


def _dump(path, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')
    return path


def spans(voice_json):
    if isinstance(voice_json, dict):
        d = voice_json
    else:
        with open(voice_json, encoding='utf-8') as f:
            d = json.load(f)
    return [(r['onset'], r['end']) for r in d['lines']]


def duck_curve(times, sp, depth=0.5, pre=0.12, post=0.35):
    """配乐 / 环境声在台词期间让开：返回与 times 同形的增益（1 = 不让，1 − depth = 让到底），进出都是 smoothstep"""
    t = np.asarray(times, dtype=np.float64)
    g = np.ones_like(t)
    for a, b in sp:
        on = np.clip((t - (a - pre)) / max(pre, 1e-6), 0, 1)
        off = np.clip(((b + post) - t) / max(post, 1e-6), 0, 1)
        w = np.minimum(on, off)
        w = w * w * (3 - 2 * w)
        g = np.minimum(g, 1 - depth * w)
    return g
