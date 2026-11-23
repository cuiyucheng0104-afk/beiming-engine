# -*- coding: utf-8 -*-
"""Suno v6 Cover 配乐生成（--provider suno，对接本地 Magpie Suno MCP）离线模拟单元测试。

严格零积分护栏：
  · 本测试全部对接进程内临时 ThreadingHTTPServer（127.0.0.1:0 随机端口），绝不连接真实 3425 端口，消耗 0 枚真实积分；
  · 覆盖真实线上 Magpie Suno MCP 契约（#158 / #159 核验）：
    1) probe_endpoint(..., provider='suno')：initialize + account-usage（兼容 application/json 与 text/event-stream SSE、Mcp-Session-Id 传递）；
    2) 显式 User-Agent: beiming-music-gen/1.0 护栏（缺失或为 Python-urllib 时模拟服务端直接返 403）；
    3) generate_cover(..., provider='suno', model='v6') 真实协议闭环：
       <15.5s 短导引轨上传前自动平滑补尾至 >=15.5s -> audio-upload-create -> presigned PUT -> audio-upload-complete ->
       audio-wait/audio-retrieve -> audio-covers-create（纯器乐省略 lyrics、绝不发送 max_mode、duration 钳位 [15, 360]、
       controls={'audio_influence': ..., 'style_influence': 0.80}、deterministic idempotency_key）->
       audio-wait -> audio-retrieve（真实线上仅返 song_url 无 audio_url）-> 自动对单条 complete 曲目调 audio-download
       （{"id": clip_id, "format": "wav", "confirm": true}，含 processing >=1s 限流重试与 download_url/url 解包）+
       audio_url 前向兼容直连 -> soxr 重采样并精裁回精确 N(dur) @ 48 kHz 立体声 PCM_24；
    4) SHA-256 磁盘缓存二次命中（cache == 'hit'，离线零网络请求）与 D11 AIGC_SUNO 元数据；
    5) Node CLI tools/audio/music.mjs 的 --provider suno / --model / --negative-style 全链路闭环。

用法（仓库根）：python -m unittest discover -s tests/audio -p "test_music_gen_suno.py"
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import shutil
import sys
import threading
import time
import unittest
import urllib.parse

import numpy as np
import soundfile as sf

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
_ROOT = os.path.abspath(os.path.join(_HERE, '..', '..'))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import _audiotest as H  # noqa: E402
from engine.audio import music_gen as MG  # noqa: E402
from engine.audio._cli import CliError  # noqa: E402


class _MockSunoMcpServer:
    """进程内本机回环 Magpie Suno MCP 模拟服务（含 JSON-RPC / SSE、预签名 PUT 上传、曲目状态机与 audio-download 无损 WAV 导出）。"""

    def __init__(
        self,
        *,
        sse_mode: bool = False,
        gen_sr: int = 44100,
        gen_dur: float = 18.2,
        omit_audio_url: bool = True,
        download_processing_steps: int = 0,
        download_url_field: str = 'download_url',
        multipart_hints: bool = False,
    ):
        self.sse_mode = sse_mode
        self.gen_sr = gen_sr
        self.gen_dur = gen_dur
        self.omit_audio_url = omit_audio_url
        self.download_processing_steps = download_processing_steps
        self.download_url_field = download_url_field
        self.multipart_hints = multipart_hints

        self.user_agents: list[str] = []
        self.accept_headers: list[str] = []
        self.session_headers: list[str | None] = []
        self.rpc_calls: list[dict] = []
        self.put_uploads: dict[str, bytes] = {}
        self.cover_requests: list[dict] = []
        self.download_calls: list[dict] = []
        self.download_timestamps: list[float] = []
        self.cdn_fetches = 0

        self._uploads: dict[str, dict] = {}
        self._clips: dict[str, dict] = {}
        self._dl_polls: dict[str, int] = {}
        self._lock = threading.Lock()

        # 预生成一段 44.1 kHz 立体声 18.2s 和弦测试音频，用于检验跨采样率 soxr 重采样与精确 N(dur) 裁剪
        n = int(round(gen_dur * gen_sr))
        t = np.arange(n, dtype=np.float64) / float(gen_sr)
        ch_l = (
            0.34 * np.sin(2.0 * np.pi * 293.66 * t)
            + 0.22 * np.sin(2.0 * np.pi * 440.00 * t)
            + 0.14 * np.sin(2.0 * np.pi * 587.33 * t)
        )
        ch_r = (
            0.33 * np.sin(2.0 * np.pi * 293.66 * t + 0.12)
            + 0.23 * np.sin(2.0 * np.pi * 369.99 * t)
            + 0.15 * np.sin(2.0 * np.pi * 587.33 * t + 0.08)
        )
        st = np.stack([ch_l, ch_r], axis=1).astype(np.float32)
        buf = io.BytesIO()
        sf.write(buf, st, gen_sr, format='WAV', subtype='PCM_16')
        self._wav_bytes = buf.getvalue()

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return

            def _check_ua(self) -> bool:
                ua = self.headers.get('User-Agent') or ''
                with outer._lock:
                    outer.user_agents.append(ua)
                # 模拟真实 Magpie 网关：拦截默认 Python-urllib UA 或缺失自定义 UA
                if not ua or 'Python-urllib' in ua or ua != 'beiming-music-gen/1.0':
                    raw = b'{"error":"forbidden user-agent"}'
                    self.send_response(403)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return False
                return True

            def _send_rpc(self, req_id, result_obj, *, session_id: str | None = None) -> None:
                rpc_payload = {'jsonrpc': '2.0', 'id': req_id, 'result': result_obj}
                if outer.sse_mode:
                    text = f"event: message\ndata: {json.dumps(rpc_payload, ensure_ascii=False)}\n\n"
                    raw = text.encode('utf-8')
                    ctype = 'text/event-stream; charset=utf-8'
                else:
                    raw = json.dumps(rpc_payload, ensure_ascii=False).encode('utf-8')
                    ctype = 'application/json; charset=utf-8'
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                if session_id:
                    self.send_header('Mcp-Session-Id', session_id)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _tool_result(self, req_id, obj, *, hint: str | None = None) -> None:
                content = [{'type': 'text', 'text': json.dumps(obj, ensure_ascii=False)}]
                if hint and outer.multipart_hints:
                    content.append({'type': 'text', 'text': hint})
                self._send_rpc(req_id, {'content': content})

            def do_PUT(self):
                if not self._check_ua():
                    return
                parsed = urllib.parse.urlparse(self.path)
                if not parsed.path.startswith('/presigned-put/'):
                    self.send_response(404)
                    self.end_headers()
                    return
                up_id = parsed.path.split('/presigned-put/', 1)[1]
                length = int(self.headers.get('Content-Length') or '0')
                body = self.rfile.read(length)
                with outer._lock:
                    outer.put_uploads[up_id] = body
                    if up_id in outer._uploads:
                        outer._uploads[up_id]['uploaded'] = True
                self.send_response(200)
                self.send_header('Content-Length', '0')
                self.end_headers()

            def do_GET(self):
                if not self._check_ua():
                    return
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path.startswith('/cdn/') and parsed.path.endswith('.wav'):
                    with outer._lock:
                        outer.cdn_fetches += 1
                    self.send_response(200)
                    self.send_header('Content-Type', 'audio/wav')
                    self.send_header('Content-Length', str(len(outer._wav_bytes)))
                    self.end_headers()
                    self.wfile.write(outer._wav_bytes)
                    return
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                if not self._check_ua():
                    return
                parsed = urllib.parse.urlparse(self.path)
                if parsed.path != '/mcp/suno':
                    self.send_response(404)
                    self.end_headers()
                    return

                length = int(self.headers.get('Content-Length') or '0')
                raw_body = self.rfile.read(length)
                rpc = json.loads(raw_body.decode('utf-8'))
                req_id = rpc.get('id')
                method = rpc.get('method')
                params = rpc.get('params') or {}

                with outer._lock:
                    outer.accept_headers.append(self.headers.get('Accept') or '')
                    outer.session_headers.append(self.headers.get('Mcp-Session-Id'))
                    outer.rpc_calls.append({'method': method, 'params': params})

                if method == 'initialize':
                    self._send_rpc(
                        req_id,
                        {
                            'protocolVersion': '2025-03-26',
                            'capabilities': {'tools': {}},
                            'serverInfo': {'name': 'Suno', 'version': 'mock-v6'},
                        },
                        session_id='mock-suno-session-001',
                    )
                    return

                if method != 'tools/call':
                    self._send_rpc(req_id, {})
                    return

                tname = params.get('name')
                targs = params.get('arguments') or {}

                if tname == 'account-usage':
                    self._tool_result(req_id, {
                        'allowed_models': ['v6-mini', 'v6', 'v6-wild'],
                        'features': ['generate.cover', 'audio.upload', 'audio.download', 'controls.advanced'],
                        'suno_account': {
                            'credits_remaining': 9890,
                            'download_credits_remaining': 61,
                            'plan': {'name': 'Premier Plan', 'period': 'year'},
                        },
                    })
                    return

                if tname == 'audio-upload-create':
                    with outer._lock:
                        up_id = f'up-{len(outer._uploads) + 1:03d}'
                        outer._uploads[up_id] = {
                            'id': up_id,
                            'title': targs.get('title') or 'untitled',
                            'uploaded': False,
                            'completed': False,
                            'polls': 0,
                        }
                    self._tool_result(req_id, {
                        'id': up_id,
                        'upload_url': f'{outer.base_url}/presigned-put/{up_id}',
                        'upload_page_url': f'{outer.base_url}/upload-page/{up_id}',
                    }, hint='Hint: PUT raw audio bytes to upload_url, then call audio-upload-complete.')
                    return

                if tname == 'audio-upload-complete':
                    up_id = str(targs['id'])
                    with outer._lock:
                        up = outer._uploads[up_id]
                        if not up['uploaded']:
                            self._tool_result(req_id, {'error': 'no file uploaded yet'})
                            return
                        up['completed'] = True
                    self._tool_result(req_id, {'id': up_id, 'status': 'processing'})
                    return

                if tname == 'audio-covers-create':
                    with outer._lock:
                        outer.cover_requests.append(dict(targs))
                        idx_base = len(outer._clips) + 1
                        c1, c2 = f'cov-{idx_base:03d}-a', f'cov-{idx_base:03d}-b'
                        for cid in (c1, c2):
                            clip_doc = {
                                'id': cid,
                                'status': 'streaming',
                                'polls': 0,
                                'title': targs.get('title') or 'Mock Suno v6 Cover',
                                'song_url': f'https://suno.com/song/{cid}',
                                'cover_image_url': f'https://cdn1.suno.ai/image_{cid}.jpeg',
                                'metadata': {
                                    'model': targs.get('model', 'v6'),
                                    'duration': float(targs.get('duration', 15)),
                                    'type': 'cover',
                                },
                            }
                            if not outer.omit_audio_url:
                                clip_doc['audio_url'] = f'{outer.base_url}/cdn/{cid}.wav'
                            outer._clips[cid] = clip_doc
                    self._tool_result(req_id, {'clip_ids': [c1, c2]})
                    return

                if tname == 'audio-wait':
                    ids = list(targs.get('ids') or ([targs['id']] if targs.get('id') else []))
                    clips_out = []
                    with outer._lock:
                        for cid in ids:
                            if cid in outer._uploads:
                                up = outer._uploads[cid]
                                up['polls'] += 1
                                st_s = 'complete' if (up['completed'] and up['polls'] >= 2) else 'processing'
                                clips_out.append({'id': cid, 'status': st_s})
                            elif cid in outer._clips:
                                cl = outer._clips[cid]
                                cl['polls'] += 1
                                if cl['polls'] >= 1:
                                    cl['status'] = 'complete'
                                clips_out.append(dict(cl))
                    first = dict(clips_out[0]) if clips_out else {}
                    first['clips'] = clips_out
                    self._tool_result(req_id, first)
                    return

                if tname == 'audio-retrieve':
                    cid = str(targs['id'])
                    with outer._lock:
                        if cid in outer._uploads:
                            up = outer._uploads[cid]
                            up['polls'] += 1
                            st_s = 'complete' if up['completed'] else 'processing'
                            self._tool_result(req_id, {'id': cid, 'status': st_s})
                            return
                        cl = outer._clips[cid]
                        cl['polls'] += 1
                        cl['status'] = 'complete'
                        res_clip = dict(cl)
                    self._tool_result(req_id, res_clip)
                    return

                if tname == 'audio-download':
                    cid = str(targs['id'])
                    fmt = targs.get('format', 'mp3')
                    confirm = bool(targs.get('confirm', False))
                    now = time.monotonic()
                    with outer._lock:
                        outer.download_calls.append({'id': cid, 'format': fmt, 'confirm': confirm})
                        outer.download_timestamps.append(now)
                        step_idx = outer._dl_polls.get(cid, 0)
                        outer._dl_polls[cid] = step_idx + 1
                    if not confirm:
                        self._tool_result(req_id, {'status': 'requires_credit', 'format': fmt, 'credits_remaining': 61})
                        return
                    if step_idx < outer.download_processing_steps:
                        self._tool_result(req_id, {'status': 'processing', 'format': fmt})
                        return
                    self._tool_result(req_id, {
                        outer.download_url_field: f'{outer.base_url}/cdn/{cid}.wav',
                        'format': fmt,
                    }, hint='Hint: Presigned download URL expires in 10 minutes.')
                    return

                self._tool_result(req_id, {'error': f'unknown tool {tname}'})

        self._httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self._httpd.server_address[1]
        self.base_url = f'http://127.0.0.1:{self.port}'
        self.mcp_url = f'{self.base_url}/mcp/suno'
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5.0)


class SunoMcpProviderTests(unittest.TestCase):
    def setUp(self):
        self.td = H.tmpdir('music-suno')
        self.film_dir = os.path.join(self.td, 'film')
        # 6.0 秒短片（144 帧 @ 24fps）：显著短于 Suno 15.5s 阈值，专门测试 <15.5s 自动平滑补尾与下载后精裁回 N(6.0)
        H.film_json(self.film_dir, frames=144, fps=24, cuts=(72,))
        self.plan = MG.plan_sections_from_film(self.film_dir)
        self.guide_6s, _ = MG.build_guide_score(self.plan, seed=42)
        self.guide_6s_wav = H.write_wav(os.path.join(self.td, 'guide_6s.wav'), self.guide_6s)

    def tearDown(self):
        shutil.rmtree(self.td, ignore_errors=True)

    def test_probe_suno_mcp_json_and_sse_and_session_header(self):
        self.assertEqual(MG.DEFAULT_SUNO_MCP_URL, 'http://127.0.0.1:3425/mcp/suno')
        for sse_flag in (False, True):
            with _MockSunoMcpServer(sse_mode=sse_flag) as srv:
                res = MG.probe_endpoint(endpoint=srv.mcp_url, provider='suno')
                self.assertTrue(res['ok'])
                self.assertTrue(res['online'])
                self.assertEqual(res['provider'], 'suno')
                self.assertEqual(res['serverInfo']['name'], 'Suno')
                self.assertEqual(res['allowed_models'], ['v6-mini', 'v6', 'v6-wild'])
                self.assertEqual(res['credits_remaining'], 9890)
                self.assertEqual(res['download_credits_remaining'], 61)
                self.assertEqual(res['plan'], {'name': 'Premier Plan', 'period': 'year'})

                # 校验每次请求均携带自定义 User-Agent、双格式 Accept 头，并在 initialize 后回传 Mcp-Session-Id
                self.assertGreaterEqual(len(srv.user_agents), 2)
                self.assertTrue(all(ua == 'beiming-music-gen/1.0' for ua in srv.user_agents))
                self.assertTrue(all('application/json' in a and 'text/event-stream' in a for a in srv.accept_headers))
                self.assertEqual(srv.session_headers[0], None)
                self.assertEqual(srv.session_headers[1], 'mock-suno-session-001')

    def test_suno_cover_live_mcp_audio_download_short_guide_autopad_cache_and_aigc(self):
        # 对齐真实 Magpie Suno MCP 行为（omit_audio_url=True，audio-retrieve 仅返 song_url，走 audio-download 无损 WAV + processing 1req/s 轮询）
        cache_dir = os.path.join(self.td, 'cache')
        out_wav = os.path.join(self.td, 'out', 'suno_music.wav')
        prompt = 'Chinese traditional chamber ensemble, solo guzheng and bamboo flute dizi, festive celebration'
        neg_style = 'vocals, singing, choir, synthesizer, edm, distortion'

        with _MockSunoMcpServer(
            sse_mode=False,
            gen_sr=44100,
            gen_dur=18.2,
            omit_audio_url=True,
            download_processing_steps=1,
            download_url_field='download_url',
        ) as srv:
            res1 = MG.generate_cover(
                self.guide_6s_wav,
                prompt=prompt,
                lyrics='[inst]',
                dur=6.0,
                endpoint=srv.mcp_url,
                cover_strength=0.68,
                seed=2026,
                provider='suno',
                model='v6',
                negative_style=neg_style,
                cache_dir=cache_dir,
                out_wav=out_wav,
            )

            self.assertEqual(res1['cache'], 'miss')
            self.assertEqual(res1['samples'], H.N(6.0))
            self.assertAlmostEqual(res1['duration'], 6.0)
            self.assertEqual(res1['aigc'], MG.AIGC_SUNO)
            self.assertEqual(res1['aigc'], {
                'contains': True,
                'kinds': ['music'],
                'tools': ['Suno'],
                'note': '配乐由 Suno Cover 模式依据程序化导引轨生成',
            })

            # 1) 验证 User-Agent 在全部 MCP POST、预签名 PUT 与 CDN GET 上均显式存在
            self.assertTrue(all(ua == 'beiming-music-gen/1.0' for ua in srv.user_agents))

            # 2) 验证 <15.5s 导引轨（6.0s）在上传前已被平滑延展至 >= 15.5s（16.0s @ 48 kHz 立体声）
            self.assertEqual(len(srv.put_uploads), 1)
            raw_uploaded = next(iter(srv.put_uploads.values()))
            up_st, up_sr = sf.read(io.BytesIO(raw_uploaded), always_2d=True)
            self.assertEqual(up_sr, 48000)
            self.assertEqual(up_st.shape[1], 2)
            self.assertGreaterEqual(len(up_st) / float(up_sr), 15.5)
            self.assertTrue(np.all(np.isfinite(up_st)))
            head_n = H.N(5.8)
            self.assertLess(float(np.max(np.abs(up_st[:head_n] - self.guide_6s[:head_n]))), 2e-4)
            tail_rms = float(np.sqrt(np.mean(up_st[H.N(6.2):H.N(14.0)] ** 2)))
            self.assertGreater(tail_rms, 1e-4)

            # 3) 验证 audio-covers-create 参数契约：model='v6'、绝不含 max_mode、纯器乐省略 lyrics、duration 钳位至 15
            self.assertEqual(len(srv.cover_requests), 1)
            cov_req = srv.cover_requests[0]
            self.assertEqual(cov_req['model'], 'v6')
            self.assertEqual(cov_req['style'], prompt)
            self.assertEqual(cov_req['negative_style'], neg_style)
            self.assertEqual(cov_req['duration'], 15)
            self.assertEqual(cov_req['controls'], {'audio_influence': 0.68, 'style_influence': 0.80})
            self.assertNotIn('max_mode', cov_req)
            self.assertNotIn('lyrics', cov_req)
            self.assertTrue(isinstance(cov_req.get('idempotency_key'), str) and len(cov_req['idempotency_key']) >= 16)

            # 4) 验证真实 audio-download 路径：仅针对单条候选 cov-001-a 请求 format='wav', confirm=True，且 processing 重试间隔 >= 1.0s
            self.assertEqual(srv.download_calls, [
                {'id': 'cov-001-a', 'format': 'wav', 'confirm': True},
                {'id': 'cov-001-a', 'format': 'wav', 'confirm': True},
            ])
            self.assertGreaterEqual(srv.download_timestamps[1] - srv.download_timestamps[0], 1.0)
            self.assertEqual(srv.cdn_fetches, 1)

        # 5) 验证输出 WAV 已从 18.2s @ 44.1 kHz 精确重采样并裁剪回 N(6.0) == 288,000 样本 @ 48 kHz 立体声 PCM_24
        info = sf.info(out_wav)
        self.assertEqual((info.samplerate, info.channels, info.frames, info.subtype), (48000, 2, H.N(6.0), 'PCM_24'))
        w1, _ = sf.read(out_wav, always_2d=True)
        self.assertEqual(float(np.max(np.abs(w1[0]))), 0.0)
        self.assertEqual(float(np.max(np.abs(w1[-1]))), 0.0)

        # 6) 模拟服务已关闭！第二次调用直接命中 SHA-256 磁盘缓存（cache == 'hit'，零网络请求）
        out_wav2 = os.path.join(self.td, 'out', 'suno_music_cached.wav')
        res2 = MG.generate_cover(
            self.guide_6s_wav,
            prompt=prompt,
            lyrics='[instrumental]',
            dur=6.0,
            cover_strength=0.68,
            seed=2026,
            provider='suno',
            model='v6',
            negative_style=neg_style,
            cache_dir=cache_dir,
            out_wav=out_wav2,
            offline=True,
        )
        self.assertEqual(res2['cache'], 'hit')
        self.assertEqual(res2['key'], res1['key'])
        self.assertEqual(res2['aigc'], MG.AIGC_SUNO)
        w2, _ = sf.read(out_wav2, always_2d=True)
        self.assertTrue(np.array_equal(w1, w2))

    def test_suno_forward_compat_audio_url_and_explicit_vocal_lyrics(self):
        # 20.0s 导引轨（>= 15.5s，无需补尾）+ SSE 流式响应 + BEIMING_SUNO_MCP_URL 环境变量 + 显式歌词 + audio_url 前向兼容直连
        guide_20s, _ = MG.build_guide_score({'dur': 20.0, 'fps': 24, 'key': 'D', 'scale': 'pentatonic', 'bpm': 108.0, 'sections': []}, seed=7)
        old_env = os.environ.get('BEIMING_SUNO_MCP_URL')
        try:
            with _MockSunoMcpServer(sse_mode=True, gen_sr=48000, gen_dur=22.0, omit_audio_url=False) as srv:
                os.environ['BEIMING_SUNO_MCP_URL'] = srv.mcp_url
                out_wav = os.path.join(self.td, 'vocal_suno.wav')
                res = MG.generate_cover(
                    guide_20s,
                    prompt='festive folk song with bamboo flute',
                    lyrics='[Verse]\n红纸裁出春风意',
                    dur=20.0,
                    cover_strength=0.55,
                    provider='suno',
                    model='v6',
                    prefer_wav_download=False,
                    out_wav=out_wav,
                )
                self.assertEqual(res['samples'], H.N(20.0))
                self.assertEqual(res['aigc'], MG.AIGC_SUNO)

                # >=15.5s 导引轨原长上传，不额外加长
                raw_up = next(iter(srv.put_uploads.values()))
                up_st, up_sr = sf.read(io.BytesIO(raw_up), always_2d=True)
                self.assertEqual((up_sr, len(up_st)), (48000, H.N(20.0)))

                cov_req = srv.cover_requests[0]
                self.assertEqual(cov_req['duration'], 20)
                self.assertEqual(cov_req['lyrics'], '[Verse]\n红纸裁出春风意')
                self.assertNotIn('max_mode', cov_req)
                self.assertNotIn('negative_style', cov_req)

                # 当 clip 已返回直接 audio_url 且 prefer_wav_download=False 时，直接拉取 audio_url（0 次 audio-download）
                self.assertEqual(srv.download_calls, [])
                self.assertEqual(srv.cdn_fetches, 1)

                # 若显式传 prefer_wav_download=True，即使有 audio_url 也走 audio-download(format='wav', confirm=True)
                out_wav_hq = os.path.join(self.td, 'vocal_suno_hq.wav')
                MG.generate_cover(
                    guide_20s,
                    prompt='festive folk song with bamboo flute',
                    lyrics='[Verse]\n红纸裁出春风意',
                    dur=20.0,
                    cover_strength=0.55,
                    seed=99,
                    provider='suno',
                    model='v6',
                    prefer_wav_download=True,
                    out_wav=out_wav_hq,
                )
                self.assertEqual(srv.download_calls, [{'id': 'cov-003-a', 'format': 'wav', 'confirm': True}])
        finally:
            if old_env is None:
                os.environ.pop('BEIMING_SUNO_MCP_URL', None)
            else:
                os.environ['BEIMING_SUNO_MCP_URL'] = old_env

    def test_unreachable_suno_mcp_exits_3(self):
        closed_port = MG._pick_ephemeral_port()
        dead_url = f'http://127.0.0.1:{closed_port}/mcp/suno'
        with self.assertRaises(CliError) as cm:
            MG.probe_endpoint(endpoint=dead_url, provider='suno', timeout_s=1.5)
        self.assertEqual(cm.exception.code, 'env.music-unreachable')
        self.assertEqual(cm.exception.exit_code, 3)

    def test_unwrap_multipart_mcp_content_and_live_hint_blocks(self):
        # 1) 直接回归校验真实线上 Magpie Suno MCP 多段 content: [json_block, hint_block] 与单块尾随提示文本
        multipart_doc = {
            'jsonrpc': '2.0',
            'id': 7,
            'result': {
                'content': [
                    {'type': 'text', 'text': '{"id": "up-live-01", "upload_url": "https://s3.example/put"}'},
                    {'type': 'text', 'text': 'Hint: PUT raw audio bytes to upload_url, then call audio-upload-complete.'},
                ],
            },
        }
        unwrapped_mp = MG._unwrap_mcp_tool_result(multipart_doc, 'audio-upload-create')
        self.assertEqual(unwrapped_mp, {'id': 'up-live-01', 'upload_url': 'https://s3.example/put'})

        trailing_hint_doc = {
            'jsonrpc': '2.0',
            'id': 8,
            'result': {
                'content': [
                    {'type': 'text', 'text': '{"status": "ok", "url": "https://cdn.example/a.wav"}\nHint: expires in 10m'},
                ],
            },
        }
        unwrapped_tr = MG._unwrap_mcp_tool_result(trailing_hint_doc, 'audio-download')
        self.assertEqual(unwrapped_tr, {'status': 'ok', 'url': 'https://cdn.example/a.wav'})

        # 2) 全链路模拟服务端返回多段 [json_str, hint_text] 时 generate_cover 依然顺畅走通
        with _MockSunoMcpServer(multipart_hints=True, omit_audio_url=True) as srv:
            out_mp = os.path.join(self.td, 'multipart_suno.wav')
            res_mp = MG.generate_cover(
                self.guide_6s_wav,
                prompt='Chinese chamber guzheng and dizi',
                lyrics='[inst]',
                dur=6.0,
                endpoint=srv.mcp_url,
                provider='suno',
                model='v6',
                out_wav=out_mp,
            )
            self.assertEqual(res_mp['samples'], H.N(6.0))
            self.assertEqual(srv.cdn_fetches, 1)

    def test_node_cli_suno_probe_and_build_roundtrip(self):
        if not shutil.which('node'):
            self.skipTest('需要 node')

        with _MockSunoMcpServer(
            sse_mode=True,
            gen_sr=44100,
            gen_dur=16.5,
            omit_audio_url=True,
            download_url_field='url',
        ) as srv:
            r_probe = H.run(
                ['node', 'tools/audio/music.mjs', 'probe', '--provider', 'suno', '--endpoint', srv.mcp_url, '--json'],
                BEIMING_PY=sys.executable,
            )
            self.assertEqual(r_probe.returncode, 0, r_probe.stderr)
            env_p = H.envelope(r_probe)
            self.assertTrue(env_p['ok'])
            self.assertTrue(env_p['data']['ok'])
            self.assertEqual(env_p['data']['credits_remaining'], 9890)

            out_wav = os.path.join(self.td, 'cli_suno.wav')
            cache_dir = os.path.join(self.td, 'cli_cache')
            r_build = H.run([
                'node', 'tools/audio/music.mjs', 'build', self.film_dir,
                '--provider', 'suno', '--model', 'v6',
                '--negative-style', 'vocals, edm',
                '--endpoint', srv.mcp_url,
                '--cover-strength', '0.65',
                '--cache', cache_dir,
                '--out', out_wav,
                '--json',
            ], BEIMING_PY=sys.executable)
            self.assertEqual(r_build.returncode, 0, r_build.stderr)
            env_b = H.envelope(r_build)
            self.assertEqual(env_b['data']['cache'], 'miss')
            self.assertEqual(env_b['data']['provider'], 'suno')
            self.assertEqual(env_b['data']['samples'], H.N(6.0))
            self.assertEqual(env_b['data']['aigc'], MG.AIGC_SUNO)
            self.assertEqual(srv.cover_requests[0]['model'], 'v6')
            self.assertEqual(srv.cover_requests[0]['negative_style'], 'vocals, edm')
            self.assertNotIn('max_mode', srv.cover_requests[0])
            self.assertEqual(srv.download_calls, [{'id': 'cov-001-a', 'format': 'wav', 'confirm': True}])

        # 模拟服务退出后，通过 Node CLI --offline 验证本地缓存命中
        r_hit = H.run([
            'node', 'tools/audio/music.mjs', 'build', self.film_dir,
            '--provider', 'suno', '--model', 'v6',
            '--negative-style', 'vocals, edm',
            '--cover-strength', '0.65',
            '--cache', cache_dir,
            '--out', out_wav,
            '--offline', '--json',
        ], BEIMING_PY=sys.executable)
        self.assertEqual(r_hit.returncode, 0, r_hit.stderr)
        self.assertEqual(H.envelope(r_hit)['data']['cache'], 'hit')


if __name__ == '__main__':
    unittest.main()
