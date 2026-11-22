# -*- coding: utf-8 -*-
"""北冥引擎 · 物理拟音层（Foley）：子事件复合（前导/瞬态材质索引 MSI/体积重量/余波）、感知锚点对齐（P-Center）、
防机关枪效应的不重复轮询池（Round-Robin）、共振峰补偿移调，以及受画面运动学驱动的有机颗粒声床。

设计依据：
  · Michel Chion《Audio-Vision》：物质化声音索引（Materializing Sound Indices, MSI）决定接触瞬间的物理真实感；
  · Vanessa Theme Ament《The Foley Grail》/ 游戏音频子事件架构：动作拆解为 Pre（蓄势摩擦/破空）+ Transient（0–30 ms 近麦接触）
    + Body（质量/腔体低频共振）+ Tail（散落/水沫/余振），而非单文件硬贴；
  · Morton (1976) / Scott (1998)：按感知冲击中心（P-Center）锚定在画面结果帧，前导声自然先于冲击帧发生；
  · Andy Farnell《Designing Sound》：湍流涡街、Euler-Bernoulli 金属色散模态与 Minnaert 气泡水动力学物理建模，可与真实录音混合。
"""
import math
import numpy as np
import soxr

from .dsp import (SR, N, T, smoothstep, curve, fade, rng, norm, un_safe, white, pink, brown,
                  lp, hp, bp, peq, shelf, svf, pan_lr, stereo, place, space_place, decor_pair)
from .library import sync_anchor, slices as lib_slices
from .synth import bubble, events


def _to_stereo(x, pan=0.0):
    x = np.asarray(x, dtype=float)
    if x.ndim == 1:
        return stereo(x, pan)
    l, r = pan_lr(pan)
    return np.stack([x[:, 0] * l, x[:, 1] * r], 1)


def place_anchored(buf, x, t_hit, anchor=None, *, gain=1.0, pan=0.0, **space_kw):
    """按感知冲击中心（P-Center）把音效放进立体声缓冲 buf，使冲击点精确落在 t_hit 秒，前导蓄势自然提前。
    给 dist / ir / wet_buf 等关键字参数时自动走 dsp.space_place（物理空间同化）。"""
    anc = sync_anchor(x, SR) if anchor is None else float(anchor)
    at = float(t_hit) - anc
    if space_kw:
        space_place(buf, x, at, gain=gain, pan=pan, **space_kw)
    else:
        place(buf, x, at, gain=gain, pan=pan)
    return {'placed_at': round(at, 6), 'anchor': round(anc, 6), 'hit_t': round(float(t_hit), 6)}


def shift_material(x, semitones, preserve_msi=0.6):
    """保材质移调：小幅移调做高频搁架互补均衡；大幅降调（< -2.5 半音）时从原信号提取 2.8 kHz 以上的接触瞬态（MSI）
    对齐叠回冲击点，避免真实录音降调做巨物时连表面脆度一起变闷糊。"""
    x = np.asarray(x, dtype=float)
    if abs(semitones) < 1e-4:
        return x.copy()
    y = soxr.resample(x, SR * (2.0 ** (semitones / 12.0)), SR)
    if len(y) < 16:
        return y
    if abs(semitones) <= 2.5:
        return shelf(y, 2800.0, float(np.clip(-0.85 * semitones, -3.0, 3.0)), 'high')
    if semitones < -2.5 and preserve_msi > 0.0 and len(x) >= N(0.015):
        anc_x = sync_anchor(x, SR)
        anc_y = sync_anchor(y, SR)
        w_pre, w_post = N(0.008), N(0.055)
        ix = int(round(anc_x * SR))
        ax, bx = max(0, ix - w_pre), min(len(x), ix + w_post)
        msi = hp(x[ax:bx], 2800.0, 2)
        if len(msi) >= 8:
            fin = min(0.0015, len(msi) / SR * 0.15) if ax > 0 else 0.0
            msi = fade(msi, fin, min(0.018, len(msi) / SR * 0.4))
            iy = int(round(anc_y * SR)) - (ix - ax)
            s0 = max(0, iy)
            m0 = max(0, -iy)
            cnt = min(len(y) - s0, len(msi) - m0)
            if cnt > 0:
                y = y.copy()
                y[s0:s0 + cnt] += msi[m0:m0 + cnt] * float(preserve_msi)
    return y


class RoundRobinDeck:
    """不重复洗牌拟音池：消除连续脚步、扑翼、水滴、剑击的“机关枪重复感”（Machine-Gun Effect）。
    每次抽取保证不与上一次同号（池长 ≥ 2），并施加确定性的微移调、中频共振峰微扰与毫秒级次层抖动。"""

    def __init__(self, clips, *, seed=1, pitch_st=1.2, eq_db=1.5, timing_ms=2.5):
        if isinstance(clips, (str, bytes)):
            clips = lib_slices(str(clips))
        self.clips = [np.asarray(c, dtype=float) for c in clips if len(c) > 0]
        if not self.clips:
            raise ValueError('RoundRobinDeck：至少需要一段非空切片')
        self.r = rng(seed)
        self.pitch_st = float(pitch_st)
        self.eq_db = float(eq_db)
        self.timing_ms = float(timing_ms)
        self._bag = []
        self._last = -1

    def _next_index(self):
        n = len(self.clips)
        if n == 1:
            return 0
        if not self._bag:
            order = list(range(n))
            self.r.shuffle(order)
            if order[0] == self._last:
                order[0], order[-1] = order[-1], order[0]
            self._bag = order
        idx = self._bag.pop(0)
        self._last = idx
        return idx

    def draw(self, velocity=1.0):
        """返回 (变形后的切片, 感知锚点秒, 建议次层微时间偏移秒, 抽取的切片下标)"""
        idx = self._next_index()
        x = self.clips[idx]
        st = self.r.uniform(-self.pitch_st, self.pitch_st) if self.pitch_st > 0 else 0.0
        y = shift_material(x, st, preserve_msi=0.45) if abs(st) > 0.02 else x.copy()
        if self.eq_db > 0 and len(y) > 24:
            fc = float(self.r.uniform(950.0, 3400.0))
            gdb = float(self.r.uniform(-self.eq_db, self.eq_db))
            y = peq(y, fc, gdb, q=1.1)
        vel = float(np.clip(velocity, 0.15, 2.5))
        if abs(vel - 1.0) > 0.05 and len(y) > 24:
            y = shelf(y, 2400.0, float(np.clip(3.0 * (vel - 1.0), -4.5, 4.5)), 'high')
        y = y * (vel ** 0.85)
        jit = float(self.r.uniform(-self.timing_ms, self.timing_ms)) * 1e-3 if self.timing_ms > 0 else 0.0
        return y, sync_anchor(y, SR), jit, idx


class ActionVariationDeck:
    """通用同质复用 vs. 连续动作三级防听觉疲劳演化器（Consistency vs. Anti-Fatigue Variation）：
    · policy='uniform'：同质视觉符号（如统一规格的 HUD 刻度、制式按钮）保持原样复用，建立界面秩序感；
    · policy='anti_fatigue'：连续物理动作（连续出拳、脚步、挥砍、敲击、拼插）按三级优先级消除机关枪效应，同时守住主音色辨识度：
      1) 首选多条实录轮询（takes ≥ 2 时相邻绝不重复同一条 take）；
      2) 次选按动作力度叠加副层（force 越大，主音色高频瞬态越亮，并在阈值之上按比例叠入 accent_takes 低频体量/擦碰质感层）；
      3) 单样本保底微移调（即使只有 1 条 take，也按力度偏置施加保材质瞬态的微移调与微均衡，确保相邻两次波形绝不雷同）。"""

    def __init__(self, takes, *, accent_takes=None, policy='anti_fatigue', seed=1,
                 pitch_st=1.1, eq_db=1.4, accent_thresh=0.45, accent_gain=0.42):
        if isinstance(takes, np.ndarray) and takes.ndim == 1:
            takes = [takes]
        elif isinstance(takes, (str, bytes)):
            takes = lib_slices(str(takes))
        self.takes = [np.asarray(c, dtype=float) for c in takes if len(c) > 0]
        if not self.takes:
            raise ValueError('ActionVariationDeck：至少需要一段非空主素材')
        if accent_takes is None:
            self.accent_takes = []
        elif isinstance(accent_takes, np.ndarray) and accent_takes.ndim == 1:
            self.accent_takes = [np.asarray(accent_takes, dtype=float)]
        else:
            self.accent_takes = [np.asarray(c, dtype=float) for c in accent_takes if len(c) > 0]
        if policy not in ('uniform', 'anti_fatigue', 'erb'):
            raise ValueError(f"ActionVariationDeck：未知 policy={policy!r}（应为 'uniform'、'anti_fatigue' 或 'erb'）")
        self.policy = policy
        self._erb_i = 0
        self.r = rng(seed)
        self.pitch_st = float(pitch_st)
        self.eq_db = float(eq_db)
        self.accent_thresh = float(accent_thresh)
        self.accent_gain = float(accent_gain)
        self._bag = []
        self._last_idx = -1
        self._last_st = 0.0
        self._accent_idx = 0

    def _next_take(self) -> int:
        n = len(self.takes)
        if n == 1:
            return 0
        if not self._bag:
            order = list(range(n))
            self.r.shuffle(order)
            if order[0] == self._last_idx:
                order[0], order[-1] = order[-1], order[0]
            self._bag = order
        idx = self._bag.pop(0)
        self._last_idx = idx
        return idx

    def trigger(self, force: float = 0.65) -> tuple:
        """按动作力度 force ∈ [0.1, 1.5] 生成单次事件，返回 (波形, P-Center 锚点秒, 元信息 dict)。"""
        f_val = float(np.clip(force, 0.1, 1.5))
        if self.policy == 'uniform':
            base = self.takes[0].copy()
            anc = sync_anchor(base, SR)
            return base, anc, {'takeIndex': 0, 'semitones': 0.0, 'accentAdded': False, 'policy': 'uniform'}

        if self.policy == 'erb':
            # takes 是 erb_foley.ErbTakes 为每个事件各渲好的一条新 take：按事件顺序取，不变调、不均衡、不叠副层，只按力度定增益
            idx = self._erb_i % len(self.takes)
            self._erb_i += 1
            base = self.takes[idx].copy()
            return base * (0.45 + 0.65 * (f_val ** 0.90)), sync_anchor(base, SR), {
                'takeIndex': idx, 'semitones': 0.0, 'accentAdded': False, 'force': round(f_val, 3), 'policy': 'erb'}

        idx = self._next_take()
        x = self.takes[idx]
        # 力度耦合微音高：重击略微下沉显厚重，轻击略微上扬显轻巧；单条素材时强制相邻两次音高差 ≥ 0.35 半音防复读感
        force_bias = -0.55 * (f_val - 0.65)
        span = max(0.45, self.pitch_st) if len(self.takes) == 1 else self.pitch_st
        st = force_bias + (float(self.r.uniform(-span, span)) if span > 0 else 0.0)
        if len(self.takes) == 1 and span > 0 and abs(st - self._last_st) < 0.35:
            st += 0.55 if st >= self._last_st else -0.55
        st = float(np.clip(st, -2.4, 2.4))
        self._last_st = st

        y = shift_material(x, st, preserve_msi=0.60) if abs(st) > 0.03 else x.copy()
        if self.eq_db > 0 and len(y) > 32:
            fc = float(self.r.uniform(850.0, 3600.0))
            y = peq(y, fc, float(self.r.uniform(-self.eq_db, self.eq_db)), q=1.05)
            # 力量越大，高频瞬态咬合越清晰、低频拳风越扎实
            y = shelf(y, 2300.0, float(np.clip(3.8 * (f_val - 0.65), -3.5, 4.0)), 'high')
            if f_val > 0.80:
                y = shelf(y, 160.0, float(min(3.0, 4.0 * (f_val - 0.80))), 'low')

        anc = sync_anchor(y, SR)
        accent_used = False
        if self.accent_takes and f_val >= self.accent_thresh:
            ac = self.accent_takes[self._accent_idx % len(self.accent_takes)]
            self._accent_idx += 1
            ac_st = float(self.r.uniform(-0.9, 0.9))
            ac_w = shift_material(ac, ac_st, preserve_msi=0.50) if abs(ac_st) > 0.05 else ac.copy()
            ac_anc = sync_anchor(ac_w, SR)
            # 将副层与主音色的 P-Center 严格对齐叠加，既丰富重击层次又不破坏起音锐度
            pre_len = max(int(round(anc * SR)), int(round(ac_anc * SR)))
            post_len = max(len(y) - int(round(anc * SR)), len(ac_w) - int(round(ac_anc * SR)))
            tot = max(1, pre_len + post_len)
            merged = np.zeros((tot, 2), dtype=float) if (y.ndim == 2 or ac_w.ndim == 2) else np.zeros(tot, dtype=float)
            y_off = pre_len - int(round(anc * SR))
            a_off = pre_len - int(round(ac_anc * SR))
            w_scale = self.accent_gain * float(np.clip((f_val - self.accent_thresh) / max(0.25, 1.0 - self.accent_thresh), 0.25, 1.35))
            if merged.ndim == 2:
                y2 = _to_stereo(y)
                a2 = _to_stereo(ac_w)
                merged[y_off:y_off + len(y2)] += y2
                merged[a_off:a_off + len(a2)] += a2 * w_scale
            else:
                merged[y_off:y_off + len(y)] += y
                merged[a_off:a_off + len(ac_w)] += ac_w * w_scale
            y = merged
            anc = pre_len / float(SR)
            accent_used = True

        gain = 0.45 + 0.65 * (f_val ** 0.90)
        return y * gain, float(anc), {
            'takeIndex': idx,
            'semitones': round(st, 3),
            'accentAdded': accent_used,
            'force': round(f_val, 3),
            'policy': 'anti_fatigue',
        }


def _unpack_layer(spec):
    if spec is None:
        return None
    if isinstance(spec, dict):
        return dict(spec)
    if isinstance(spec, tuple) and len(spec) == 2:
        return {'x': spec[0], 'anchor': spec[1]}
    return {'x': spec}


def layer_event(layers, *, velocity=1.0, mass=1.0, wetness=0.0, seed=1):
    """子事件复合拟音器：把 {'pre': 前导, 'transient': 接触瞬态, 'body': 重量腔体, 'tail': 余波散落}
    按物理因果关系拼成一整条波形，并返回 (复合立体声波形, 冲击锚点秒)。
    调用 place_anchored(buf, wave, t_hit, anchor) 时：pre 在 t_hit 前发生，transient 与 body 在 t_hit 同步爆发，tail 在后展开。"""
    _ = rng(seed)
    vel = float(np.clip(velocity, 0.1, 3.0))
    ms = float(np.clip(mass, 0.2, 4.0))
    wet = float(np.clip(wetness, 0.0, 2.0))
    placements = []   # [(rel_start_sec, stereo_wave)]

    for role in ('pre', 'transient', 'body', 'tail'):
        sp = _unpack_layer(layers.get(role))
        if not sp or sp.get('x') is None or len(sp['x']) == 0:
            continue
        w = np.asarray(sp['x'], dtype=float)
        g = float(sp.get('gain', 1.0))
        off = float(sp.get('offset', 0.0))
        pan = sp.get('pan', 0.0)

        if role == 'pre':
            # 前导蓄势：默认末尾收在冲击点后 6 ms（顺滑交接给冲击瞬态，不断气）
            anc = float(sp['anchor']) if 'anchor' in sp and sp['anchor'] is not None else max(0.0, len(w) / SR - 0.006)
            w = w * (g * (vel ** 0.65))
            rel_t = off - anc
        elif role == 'transient':
            if abs(vel - 1.0) > 0.05 and len(w) > 24:
                w = shelf(w, 2600.0, float(np.clip(3.2 * (vel - 1.0), -4.0, 5.0)), 'high')
            anc = float(sp['anchor']) if 'anchor' in sp and sp['anchor'] is not None else sync_anchor(w, SR)
            w = w * (g * (vel ** 0.85))
            rel_t = off - anc
        elif role == 'body':
            if abs(ms - 1.0) > 0.05:
                st_shift = float(np.clip(-3.5 * math.log2(ms), -9.0, 6.0))
                w = shift_material(w, st_shift, preserve_msi=0.25)
            anc = float(sp['anchor']) if 'anchor' in sp and sp['anchor'] is not None else sync_anchor(w, SR)
            # 腔体/水体质量响应比表面接触晚约 2.5 ms，层次清晰且不糊瞬态
            def_lag = 0.0025 if 'offset' not in sp else 0.0
            w = w * (g * ((vel * ms) ** 0.85))
            rel_t = off + def_lag - anc
        else:  # tail
            def_lag = 0.010 if 'offset' not in sp else 0.0
            scale = 0.55 + 0.45 * max(vel, wet)
            w = w * (g * scale)
            anc = float(sp.get('anchor', 0.0) or 0.0)
            rel_t = off + def_lag - anc

        placements.append((rel_t, _to_stereo(w, pan)))

    if not placements:
        return np.zeros((N(0.05), 2)), 0.0

    t_min = min(0.0, min(rt for rt, _ in placements))
    t_max = max(0.02, max(rt + len(st) / SR for rt, st in placements))
    total_n = max(16, N(t_max - t_min) + 4)
    out = np.zeros((total_n, 2))
    for rt, st in placements:
        place(out, st, rt - t_min, 1.0)
    hit_anchor = float(np.clip(-t_min, 0.0, (total_n - 1) / SR))
    return out, hit_anchor


def granular_bed(clips, dur, *, seed=1, rate=9.0, density=1.0, brightness=None, pan=0.0,
                 pan_spread=0.35, pitch_st=1.6, gain_range=(0.55, 1.15), base_bed=None):
    """有机颗粒纹理层（替代生硬的固定交叉循环 _fit）：
    按泊松事件流 synth.events 投放 RoundRobinDeck 切片，密度、明暗与声像均可由逐样本运动曲线连续驱动。"""
    r = rng(seed)
    n = N(dur)
    out = np.zeros((n, 2))
    if base_bed is not None:
        bb = _to_stereo(base_bed, 0.0)
        m = min(n, len(bb))
        out[:m] += bb[:m]
    deck = RoundRobinDeck(clips, seed=seed + 17, pitch_st=pitch_st, eq_db=1.4, timing_ms=0.0)
    dens = np.full(n, float(density)) if np.isscalar(density) else np.clip(np.asarray(density, dtype=float), 0.0, 1.0)
    pan_arr = np.full(n, float(pan)) if np.isscalar(pan) else np.asarray(pan, dtype=float)
    for tt, i in events(r, dur, float(rate), dens):
        vel = float(0.65 + 0.55 * dens[i])
        grain, _, _, _ = deck.draw(velocity=vel)
        g = float(r.uniform(*gain_range)) * (0.4 + 0.6 * dens[i])
        p = float(np.clip(pan_arr[i] + r.uniform(-pan_spread, pan_spread), -1.0, 1.0))
        place(out, grain, tt, g, p)
    if brightness is not None:
        br = np.full(n, float(brightness)) if np.isscalar(brightness) else np.clip(np.asarray(brightness, dtype=float), 0.0, 1.0)
        fc = 1400.0 + 13500.0 * (br ** 1.3)
        out = svf(out, fc, 0.72, 'lp')
    return fade(out, min(0.015, dur * 0.1), min(0.025, dur * 0.1))


# ———— 常用物理拟音原型（支持混入真实录音切片） ————

def blade_whoosh(dur=0.28, *, speed=1.0, weight=1.0, seed=1, sample=None):
    """剑锋/衣袖破空：气动涡街扫频湍流 + 刃口薄啸；峰值在约 72% 处，返回 (单声道波形, 锚点秒)。"""
    r = rng(seed)
    n = N(dur)
    t = T(dur)
    u = t / max(dur, 1e-6)
    env = (smoothstep(0.0, 0.72, u) ** 1.8) * (1.0 - smoothstep(0.72, 1.0, u) ** 1.2)
    fc_air = (380.0 + 2100.0 * (env ** 1.4) * float(speed)) / max(0.5, float(weight) ** 0.35)
    air = un_safe(svf(pink(n, r), fc_air, 1.35, 'bp'))
    edge_fc = 2400.0 + 3200.0 * (env ** 1.6) * float(speed)
    edge = un_safe(svf(white(n, r), edge_fc, 3.2, 'bp')) * 0.28
    low = un_safe(svf(brown(n, r), 110.0 + 180.0 * env, 0.8, 'lp')) * 0.55 * float(weight)
    x = (air + edge + low) * env
    if sample is not None and len(sample) > 0:
        s = sample.mean(1) if np.ndim(sample) == 2 else np.asarray(sample, dtype=float)
        s = soxr.resample(s, SR * (len(s) / max(n, 1)), SR)[:n]
        if len(s) < n:
            s = np.pad(s, (0, n - len(s)))
        x = 0.55 * un_safe(s) * env + 0.45 * un_safe(x) * env
    x = norm(fade(x, 0.008, 0.015))
    return x, float(0.72 * dur)


def blade_ring(dur=0.70, *, f0=1480.0, key=None, brightness=1.0, seed=1, sample=None):
    """青锋剑鸣/出鞘摩擦：钢刃非谐色散模态 + 鞘口金属刮擦瞬态（MSI），返回 (单声道波形, 锚点秒)。
    传 key='D' 等主音名时自动经 director.harmonic_freq 吸附到配乐调性协和音级。"""
    if key is not None:
        from .director import harmonic_freq
        f0 = harmonic_freq(f0, root=key)
    r = rng(seed)
    n = N(dur)
    t = T(dur)
    # 鞘口金属摩擦前导（18 ms）+ 刃尖清越泛音
    scrape_n = min(n, N(0.028))
    ts = np.arange(scrape_n) / SR
    scrape = un_safe(bp(white(scrape_n, r), 2600, 9500, 2)) * np.sin(np.pi * ts / (scrape_n / SR)) ** 1.4
    modes = [
        (1.000, 0.55, 0.36),
        (1.985, 0.32 * brightness, 0.28),
        (2.758, 0.42 * brightness, 0.22),
        (4.110, 0.18 * brightness, 0.15),
        (5.404, 0.11 * brightness, 0.10),
    ]
    ring = np.zeros(n)
    hit_i = min(n - 1, N(0.014))
    tr = np.maximum(0.0, t - hit_i / SR)
    gate = (t >= hit_i / SR).astype(float)
    for ratio, amp, dec in modes:
        fr = f0 * ratio
        if fr >= 0.44 * SR:
            continue
        beat = float(r.uniform(0.8, 2.6))
        ring += gate * amp * np.exp(-tr / dec) * (
            np.sin(2 * np.pi * fr * tr) + 0.35 * np.sin(2 * np.pi * (fr + beat) * tr + r.uniform(0, 6.28))
        )
    ring *= smoothstep(hit_i / SR, hit_i / SR + 0.002, t)
    x = np.zeros(n)
    x[:scrape_n] += scrape * 0.45
    x += un_safe(ring) * 0.75
    if sample is not None and len(sample) > 0:
        s = sample.mean(1) if np.ndim(sample) == 2 else np.asarray(sample, dtype=float)
        anc_s = sync_anchor(s, SR)
        buf = np.zeros((n, 2))
        place_anchored(buf, s, hit_i / SR, anchor=anc_s, gain=0.75)
        x = 0.65 * buf[:, 0] + 0.45 * x
    return norm(fade(x, 0.002, 0.04)), hit_i / SR


def cloth_rustle(dur, motion, *, seed=1, samples=None, snap_thresh=0.72, pan=0.0):
    """衣袂/披风受角色角速度与风力驱动的连续纤维摩擦 + 急停衣角脆响（Snap）。"""
    r = rng(seed)
    n = N(dur)
    mot = np.full(n, float(motion)) if np.isscalar(motion) else np.clip(np.asarray(motion, dtype=float), 0.0, 2.0)
    if len(mot) != n:
        mot = np.interp(np.linspace(0, 1, n), np.linspace(0, 1, len(mot)), mot)
    m01 = np.clip(mot / max(1.0, float(mot.max())), 0.0, 1.0)
    # 织物纤维连续摩擦声（550–4200 Hz 随速度张开，不含周期音调）
    fib_l = un_safe(svf(pink(n, r), 650.0 + 2600.0 * (m01 ** 1.2), 0.95, 'bp'))
    fib_r = un_safe(svf(pink(n, r), 700.0 + 2500.0 * (m01 ** 1.2), 0.95, 'bp'))
    air = decor_pair(brown, n, r, corr=0.35)
    air = un_safe(svf(air, 140.0 + 240.0 * m01, 0.75, 'lp'))
    st = (np.stack([fib_l, fib_r], 1) * 0.55 + air * 0.45) * ((0.06 + 0.94 * (m01 ** 1.35))[:, None])
    if samples:
        st = 0.55 * granular_bed(samples, dur, seed=seed + 3, rate=11.0, density=m01, brightness=0.3 + 0.7 * m01,
                                 pan=pan, pan_spread=0.25) + 0.45 * st
    # 动作急加速处自动补衣摆抽风的短促脆响（非机械硬刺，12–28 ms 宽带织物拍击）
    accel = np.diff(m01, prepend=m01[0]) * SR / 12.0
    last_snap = -N(0.12)
    for i in np.flatnonzero(accel > snap_thresh):
        if i - last_snap < N(0.09):
            continue
        last_snap = int(i)
        sn_len = N(0.024)
        ts = np.arange(sn_len) / SR
        flap = un_safe(bp(white(sn_len, r), 420, 4800, 2)) * np.sin(np.pi * np.minimum(1.0, ts / 0.004) * 0.5) * np.exp(-ts / 0.0075)
        p = float(np.clip((pan if np.isscalar(pan) else pan[i]) + r.uniform(-0.2, 0.2), -1.0, 1.0))
        place(st, flap * float(np.clip(accel[i] * 0.45, 0.25, 0.9)), i / SR, 1.0, p)
    return fade(st, 0.01, 0.02)


def water_cleave(dur=1.85, *, force=1.0, width_pan=0.78, key=None, seed=1, samples=None):
    """剑劈断水复合拟音（Pre 破空+瞬态真空收束 → Transient 水面张力撕裂+刃鸣 → Body 水体空化重击 → Tail 左右水墙轰鸣与水珠散落）：
    samples 可传 dict({'whoosh': .., 'splash': .., 'body': .., 'spray': [..]}) 融入真实录音；key 传调性主音吸附剑鸣频率。返回 (立体声波形, 冲击锚点秒)。"""
    r = rng(seed)
    samples = samples or {}
    # 1. Pre：140 ms 下劈破空，在撞击前最后 22 ms 收束成短暂“气压屏息”，衬托断水爆发力
    pre_w, _ = blade_whoosh(0.16, speed=1.25 * force, weight=1.1, seed=seed + 1, sample=samples.get('whoosh'))
    tp = np.arange(len(pre_w)) / SR
    vacuum = 1.0 - 0.65 * smoothstep(0.125, 0.155, tp)
    pre_w = pre_w * vacuum

    # 2. Transient：水面张力脆裂（1.2–9 kHz 近麦水刃撕裂 MSI）+ 一线青锋清鸣
    tr_n = N(0.055)
    tt = np.arange(tr_n) / SR
    rip = un_safe(bp(white(tr_n, r), 1100, 9200, 2)) * np.minimum(1.0, tt / 0.0012) * np.exp(-tt / 0.011)
    splash_s = samples.get('splash')
    if splash_s is not None and len(splash_s) > 0:
        sp_m = splash_s.mean(1) if np.ndim(splash_s) == 2 else np.asarray(splash_s, dtype=float)
        anc_sp = sync_anchor(sp_m, SR)
        ia = max(0, int(round(anc_sp * SR)) - N(0.004))
        seg = sp_m[ia:ia + tr_n]
        if len(seg) >= 16:
            seg = fade(np.pad(seg, (0, max(0, tr_n - len(seg)))), 0.001, 0.015)
            rip = 0.68 * un_safe(seg) + 0.42 * rip
    ring_w, _ = blade_ring(0.28, f0=1640.0, key=key, brightness=0.85, seed=seed + 2)
    trans = np.zeros(len(ring_w))
    trans[:tr_n] += rip * 1.15
    trans += ring_w * 0.28

    # 3. Body：水体排开与空化重压（42–180 Hz 胸腔冲击 + 湿重水团）
    bd_n = N(0.34)
    tb = np.arange(bd_n) / SR
    f_drop = 118.0 * np.exp(-tb / 0.065) + 42.0
    sub = np.sin(2 * np.pi * np.cumsum(f_drop) / SR) * np.minimum(1.0, tb / 0.003) * np.exp(-tb / 0.085)
    cav = un_safe(svf(brown(bd_n, r), 95.0 + 260.0 * np.exp(-tb / 0.09), 0.85, 'lp')) * np.minimum(1.0, tb / 0.005) * np.exp(-tb / 0.14)
    body = sub * 0.95 + cav * 0.75
    if samples.get('body') is not None and len(samples['body']) > 0:
        bs = samples['body'].mean(1) if np.ndim(samples['body']) == 2 else np.asarray(samples['body'], dtype=float)
        anc_b = sync_anchor(bs, SR)
        ib = max(0, int(round(anc_b * SR)) - N(0.005))
        seg = bs[ib:ib + bd_n]
        if len(seg) >= 16:
            seg = fade(np.pad(seg, (0, max(0, bd_n - len(seg)))), 0.002, 0.04)
            body = 0.60 * un_safe(seg) + 0.55 * body

    # 4. Tail：两面水墙向左右两侧翻卷轰鸣（立体声对称推开 -width_pan / +width_pan）+ 气泡与水珠散落
    tl_dur = max(0.5, dur - 0.16)
    tl_n = N(tl_dur)
    tl_t = np.arange(tl_n) / SR
    wall_env = smoothstep(0.0, 0.08, tl_t) * np.exp(-tl_t / 0.58)
    fc_wall = curve([(0.0, 1800.0), (0.18, 950.0), (tl_dur, 360.0)], tl_t)
    wl = un_safe(svf(pink(tl_n, r), fc_wall, 0.85, 'bp')) * wall_env
    wr = un_safe(svf(pink(tl_n, r), fc_wall * 1.04, 0.85, 'bp')) * wall_env
    foam_l = un_safe(bp(white(tl_n, r), 1600, 6800, 2)) * (wall_env ** 1.3) * 0.32
    foam_r = un_safe(bp(white(tl_n, r), 1600, 6800, 2)) * (wall_env ** 1.3) * 0.32
    tail_st = np.zeros((tl_n, 2))
    # 水墙从中心向左右急推裂开
    pan_open = width_pan * smoothstep(0.0, 0.14, tl_t)
    ll, lr = pan_lr(-pan_open)
    rl, rr = pan_lr(pan_open)
    tail_st[:, 0] += (wl + foam_l) * ll + (wr + foam_r) * rl * 0.25
    tail_st[:, 1] += (wl + foam_l) * lr * 0.25 + (wr + foam_r) * rr

    if samples.get('spray'):
        tail_st += granular_bed(samples['spray'], tl_dur, seed=seed + 9, rate=22.0,
                                density=np.exp(-tl_t / 0.75), pan_spread=width_pan, gain_range=(0.25, 0.65)) * 0.55
    else:
        dens = np.exp(-tl_t / 0.85)
        for bt, i in events(r, tl_dur, 34.0, dens):
            b = bubble(r, lo=520, hi=2600, g=(0.06, 0.24))
            s_side = -1.0 if r.random() < 0.5 else 1.0
            place(tail_st, b, bt, 1.0, float(np.clip(s_side * r.uniform(0.25, width_pan), -1.0, 1.0)))

    comp, anc = layer_event(
        {
            'pre': {'x': pre_w, 'gain': 0.55},
            'transient': {'x': trans, 'anchor': 0.002, 'gain': 0.95},
            'body': {'x': body, 'anchor': 0.004, 'gain': 0.90},
            'tail': {'x': fade(tail_st, 0.008, 0.12), 'offset': 0.006, 'gain': 0.75},
        },
        velocity=force,
        mass=max(0.8, force),
        wetness=1.0,
        seed=seed,
    )
    return norm(comp, 0.95), anc


# ———— 精密刚体、摩擦、弹簧与微距巨物化（Sonic Caricature）拟音原语 ————

_MAT_FORMANTS = {
    'polymer': ((920.0, 2.2, 0.75), (2450.0, 2.8, 1.0), (5400.0, 3.2, 0.55)),
    'metal': ((1680.0, 4.5, 0.70), (4250.0, 5.5, 1.0), (8600.0, 6.0, 0.65)),
    'elastomer': ((380.0, 1.6, 1.0), (1150.0, 2.0, 0.65), (2600.0, 2.2, 0.25)),
    'wood': ((490.0, 2.4, 1.0), (1380.0, 3.0, 0.75), (3150.0, 3.2, 0.35)),
}


def stick_slip_friction(dur, speed_curve=1.0, *, material='polymer', pressure=1.0, seed=1, sample=None):
    """粘滑微脉冲摩擦（Andy Farnell 摩擦学模型）：按瞬时滑动速度驱动微脱扣脉冲密度与共振峰张开度，
    用于按钮下压皮肤/金属摩擦、凸轮 45° 齿面爬坡蓄力刮擦、游标卡尺滑轨等（绝非白噪套正弦门控）。返回单声道波形。"""
    r = rng(seed)
    n = max(16, N(dur))
    spd = np.full(n, float(speed_curve)) if np.isscalar(speed_curve) else np.asarray(speed_curve, dtype=float)
    if len(spd) != n:
        spd = np.interp(np.linspace(0.0, 1.0, n), np.linspace(0.0, 1.0, len(spd)), spd)
    s01 = np.clip(spd / max(1e-4, float(np.max(spd)), 1.0), 0.0, 1.0)
    pres = float(np.clip(pressure, 0.2, 3.0))

    # 弛豫振荡粘滑脉冲串：速度越高，微脱扣频率从 32 Hz 升至 280 Hz，且带随机抖动消除机械电子感
    rate = (32.0 + 250.0 * (s01 ** 0.85)) * r.uniform(0.92, 1.08)
    ph = np.cumsum(rate / SR)
    slips = np.zeros(n)
    idx = np.flatnonzero(np.diff(np.floor(ph), prepend=0.0) > 0)
    for k in idx:
        jit = int(r.integers(-min(k, 6), min(n - 1 - k, 7) + 1)) if n > 16 else 0
        pos = max(0, min(n - 1, int(k) + jit))
        amp = float((0.35 + 0.65 * s01[pos]) * r.uniform(0.55, 1.35) * (pres ** 0.6))
        m_len = min(n - pos, N(0.0028))
        tt = np.arange(m_len) / SR
        slips[pos:pos + m_len] += amp * np.exp(-tt / 0.00065) * r.choice([-1.0, 1.0])

    # 连续表面微粗糙度湍流层 + 材质三共振峰滤波
    rough = pink(n, r) * (0.18 + 0.82 * (s01 ** 1.15)) * 0.42
    exc = slips + rough
    fms = _MAT_FORMANTS.get(material, _MAT_FORMANTS['polymer'])
    y = np.zeros(n)
    for fc0, q, g in fms:
        fc = np.clip(fc0 * (0.78 + 0.42 * s01) / (pres ** 0.12), 160.0, 0.44 * SR)
        y += un_safe(svf(exc, fc, q, 'bp')) * g

    if sample is not None and len(sample) > 0:
        s = sample.mean(1) if np.ndim(sample) == 2 else np.asarray(sample, dtype=float)
        if len(s) < n:
            xf = min(max(8, N(0.012)), max(1, len(s) // 3))
            ang = np.linspace(0.0, np.pi * 0.5, xf)
            ext = s.copy()
            while len(ext) < n:
                off = int(r.integers(0, max(1, len(s) // 3))) if len(s) > xf * 3 else 0
                ch = s[off:]
                if xf > 0 and len(ch) > xf and len(ext) > xf:
                    ext = np.concatenate([ext[:-xf], ext[-xf:] * np.cos(ang) + ch[:xf] * np.sin(ang), ch[xf:]])
                else:
                    ext = np.concatenate([ext, ch])
            s = ext[:n]
        else:
            s = s[:n]
        y = 0.52 * un_safe(s) * (0.15 + 0.85 * s01) + 0.58 * un_safe(y)
    env = (0.08 + 0.92 * (s01 ** 0.75))
    return norm(fade(y * env, min(0.008, dur * 0.12), min(0.015, dur * 0.18)), 0.92)


def helical_thread(dur=0.32, *, turns=6.5, direction='unscrew', tube_mm=72.0, material='polymer', seed=1, sample=None):
    """精密螺纹旋松 / 旋紧拟音：
    · unscrew：静摩擦破拆微咔 → 加速螺距齿脊滑过 → 末圈脱扣空心圆管气封轻啵（Quarter-wave tube pop）；
    · screw：高速入扣 → 减速咬合 → 止口台肩干脆锁死 clack。返回 (单声道波形, 锚点秒)。"""
    r = rng(seed)
    n = max(32, N(dur))
    t = T(dur)
    u = t / max(dur, 1e-6)
    if direction == 'unscrew':
        spd = smoothstep(0.0, 0.78, u) ** 1.35 * (1.0 - 0.55 * smoothstep(0.84, 1.0, u))
        anc = float(0.12 * dur)
    else:
        spd = (1.0 - smoothstep(0.45, 0.92, u) ** 1.5) * smoothstep(0.0, 0.12, u)
        anc = float(0.88 * dur)

    # 螺距齿脊：总圈数 turns × 每圈 2 个主应力脊
    ridge_rate = max(18.0, (float(turns) * 2.4 / max(dur, 0.05))) * (0.35 + 1.15 * spd)
    ph = np.cumsum(ridge_rate / SR)
    ridges = np.zeros(n)
    for k in np.flatnonzero(np.diff(np.floor(ph), prepend=0.0) > 0):
        m = min(n - int(k), N(0.0035))
        tt = np.arange(m) / SR
        ridges[int(k):int(k) + m] += float(0.4 + 0.6 * spd[int(k)]) * r.uniform(0.7, 1.25) * np.exp(-tt / 0.0009)

    base = stick_slip_friction(dur, spd, material=material, pressure=0.9, seed=seed + 3, sample=sample)
    fms = _MAT_FORMANTS.get(material, _MAT_FORMANTS['polymer'])
    ridge_col = un_safe(bp(ridges * white(n, r), fms[0][0] * 0.9, min(0.44 * SR, fms[2][0] * 1.25), 2))
    x = 0.55 * base + 0.65 * ridge_col

    # 管腔 1/4 波长脱扣气封音 或 旋紧台肩锁死声
    f_tube = float(np.clip(343000.0 / (4.0 * max(25.0, float(tube_mm))), 420.0, 3200.0))
    if direction == 'unscrew':
        i_pop = min(n - N(0.025), int(0.86 * n))
        if i_pop > 0:
            mp = min(n - i_pop, N(0.024))
            tp = np.arange(mp) / SR
            pop = np.sin(2 * np.pi * f_tube * (1.0 + 0.35 * np.exp(-tp / 0.004)) * tp) * np.exp(-tp / 0.0055)
            x[i_pop:i_pop + mp] += pop * 0.55
    else:
        i_lock = min(n - N(0.030), int(0.88 * n))
        if i_lock > 0:
            ml = min(n - i_lock, N(0.028))
            tl = np.arange(ml) / SR
            clack = (un_safe(bp(white(ml, r), 1200, 7800, 2)) * np.exp(-tl / 0.0022) * 0.8
                     + np.sin(2 * np.pi * f_tube * 0.85 * tl) * np.exp(-tl / 0.008) * 0.65)
            x[i_lock:i_lock + ml] += clack * 0.95
    return norm(fade(x, 0.004, 0.012), 0.92), anc


def spring_coil(dur=0.38, *, turns=12, action='release', scale=1.0, key=None, seed=1):
    """高碳钢螺旋弹簧色散模态拟音（Euler-Bernoulli 弯曲+扭转色散模态 + 圈间微擦颤，杜绝卡通颤音正弦波）：
    action ∈ {'compress', 'release', 'shudder'}。返回 (单声道波形, 锚点秒)。"""
    r = rng(seed)
    n = max(32, N(dur))
    t = T(dur)
    sc = float(np.clip(scale, 0.4, 5.0))
    f_base = (2150.0 / (sc ** 0.55)) * (12.0 / max(4.0, float(turns))) ** 0.35
    if key is not None:
        from .director import harmonic_freq
        f_base = harmonic_freq(f_base, root=key)

    x = np.zeros(n)
    if action == 'compress':
        # 压缩：自由长度缩短，圈间微刮擦密度与模态基频持续上扬
        u = t / max(dur, 1e-6)
        sweep = 1.0 + 0.38 * (u ** 1.3)
        fric = stick_slip_friction(dur, 0.25 + 0.75 * u, material='metal', pressure=1.2, seed=seed + 5)
        for k in (1, 2, 3, 4):
            disp = k * math.sqrt(1.0 + 0.024 * k * k)
            fk = np.minimum(0.43 * SR, f_base * 0.55 * disp * sweep)
            ph = 2 * np.pi * np.cumsum(fk) / SR
            x += (0.28 / k) * np.sin(ph + r.uniform(0, 6.28)) * smoothstep(0.0, 0.25, u) * (1.0 - 0.3 * smoothstep(0.88, 1.0, u))
        x = 0.65 * fric + 0.45 * un_safe(x)
        return norm(fade(x, 0.005, 0.010), 0.90), float(0.85 * dur)

    # release / shudder：非谐色散模态簇 + 前 18 ms 钢圈脱扣高频微擦
    burst_n = min(n, N(0.018))
    tb = np.arange(burst_n) / SR
    chatter = un_safe(bp(white(burst_n, r), 2800.0, min(13500.0, 0.44 * SR), 2)) * np.exp(-tb / 0.0035)
    x[:burst_n] += chatter * (0.65 if action == 'release' else 0.35)

    beta = 0.028
    for k in range(1, 8):
        fk = f_base * k * math.sqrt(1.0 + beta * k * k)
        if fk >= 0.44 * SR:
            continue
        # 色散群延迟：高阶弯曲波比基频早几毫秒到达，形成真实弹簧“清脆金属微啾”
        grp_lag = 0.009 / math.sqrt(k)
        tk = np.maximum(0.0, t - grp_lag)
        gate = (t >= grp_lag).astype(float)
        tau = (0.19 if action == 'release' else 0.28) * (sc ** 0.35) / (k ** 0.55)
        beat = float(r.uniform(1.5, 5.5))
        amp = (0.65 / (k ** 0.72))
        x += gate * amp * np.exp(-tk / tau) * (
            np.sin(2 * np.pi * fk * tk) + 0.28 * np.sin(2 * np.pi * (fk + beat) * tk + r.uniform(0, 6.28))
        )
    return norm(fade(x, 0.0015, 0.025), 0.92), 0.002


def _barrel_reflections(x: np.ndarray, tube_mm: float = 136.0, mix: float = 0.28) -> np.ndarray:
    """薄壁圆管微波导早反射（非正弦波振荡器）：按真实笔管长度 L 施加一端闭一端开管腔的三阶轴向往返微反射，
    赋予圆珠笔塑料/金属外壳特有的近麦中空脆感，绝不产生电子正弦哨音。"""
    y = np.asarray(x, dtype=float)
    if mix <= 0.0 or len(y) < 24:
        return y
    base_d = max(6, int(round((2.0 * float(np.clip(tube_mm, 28.0, 260.0)) / 343000.0) * SR)))
    out = y.copy()
    for tap_mul, sign, g in ((1, -1.0, 0.46), (2, -0.65, 0.24), (3, 0.45, 0.12)):
        d = base_d * tap_mul
        if d < len(y):
            out[d:] += sign * g * float(mix) * y[:-d]
    return lp(out, 15500.0, 1)


def composite_mechanism(*, identity, mechanism=None, latch_body=None, pre=None, spring_tail=None,
                        scale=1.0, identity_pitch_st=0.0, mech_pitch_st=None, preserve_msi=0.82,
                        tube_mm=136.0, tube_mix=0.22, bounce_ms=0.0, body_drive=1.8, seed=1):
    """Sound Designer 三层实录复合拟音配方（认知身份锚点 + 精密机构质感 + 物理管腔微反射）：
      · identity：画面本体的近麦真实录音（如真实圆珠笔按压咔嗒），保持高辨识度不失真；
      · mechanism：同族精密机械录音（如 96 kHz 精密棘轮、机械单反快门），补足微距放大时的金属齿咬合密度；
      · latch_body：重型卡扣/弹簧底盘真实录音（替代廉价 EDM 正弦低频扫频），延后 1.8 ms 锚定使主瞬态不糊；
      · pre / spring_tail：前导弹簧蓄力摩擦与尾段细微余振；body_drive 软膝激励抬升壳体与弹簧中段厚度。
    返回 (立体声波形, 感知冲击锚点秒)。"""
    _ = rng(seed)
    sc = float(np.clip(scale, 0.4, 6.0))
    drv = float(np.clip(body_drive, 1.0, 3.5))

    def _cond(w, peak_to=0.95):
        y = norm(w, 0.98)
        if drv > 1.05:
            y = np.tanh(y * drv) / math.tanh(drv)
        return norm(y, peak_to)

    id_m = identity.mean(1) if np.ndim(identity) == 2 else np.asarray(identity, dtype=float)
    if abs(identity_pitch_st) > 0.02:
        id_m = shift_material(id_m, float(identity_pitch_st), preserve_msi=preserve_msi)
    if tube_mm and tube_mix > 0.0:
        id_m = _barrel_reflections(id_m, tube_mm=float(tube_mm), mix=float(tube_mix))
    anc_id = sync_anchor(id_m, SR)

    # 若有锁定微回弹（如笔芯台肩落座 14–22 ms 次生微咔），用同一真实录音的高通微缩反射而非白噪门控
    if bounce_ms and bounce_ms > 2.0 and len(id_m) >= N(0.012):
        ib = int(round(float(bounce_ms) * 1e-3 * SR))
        snip = fade(hp(id_m[:min(len(id_m), N(0.022))], 2000.0, 2), 0.0005, 0.008) * 0.28
        need = int(round(anc_id * SR)) + ib + len(snip)
        if need > len(id_m):
            id_m = np.pad(id_m, (0, need - len(id_m)))
        p0 = max(0, int(round(anc_id * SR)) + ib)
        id_m[p0:p0 + len(snip)] += snip[:len(id_m) - p0]

    trans_buf = np.zeros((max(len(id_m) + N(0.10), N(0.16)), 2))
    t_ref = max(0.025, anc_id + 0.010)
    place_anchored(trans_buf, _cond(id_m, 0.95), t_ref, anchor=anc_id, gain=0.95)

    if mechanism is not None and len(mechanism) > 0:
        mc_m = mechanism.mean(1) if np.ndim(mechanism) == 2 else np.asarray(mechanism, dtype=float)
        st_m = float(np.clip(-3.2 * math.log2(sc), -10.0, 4.0)) if mech_pitch_st is None else float(mech_pitch_st)
        if abs(st_m) > 0.05:
            mc_m = shift_material(mc_m, st_m, preserve_msi=0.75)
        anc_mc = sync_anchor(mc_m, SR)
        place_anchored(trans_buf, _cond(mc_m, 0.95), t_ref + 0.0008, anchor=anc_mc, gain=min(0.88, 0.45 + 0.14 * sc))

    body_layer = None
    if latch_body is not None and len(latch_body) > 0:
        lb_m = latch_body.mean(1) if np.ndim(latch_body) == 2 else np.asarray(latch_body, dtype=float)
        st_b = float(np.clip(-3.8 * math.log2(max(1.0, sc * 0.85)), -11.0, 2.0))
        if abs(st_b) > 0.05:
            lb_m = shift_material(lb_m, st_b, preserve_msi=0.45)
        lb_m = lp(_cond(lb_m, 0.95), min(5400.0, 4200.0 / (sc ** 0.15)), 2)
        body_layer = {'x': norm(lb_m, 0.95), 'anchor': sync_anchor(lb_m, SR), 'offset': 0.0018, 'gain': min(0.98, 0.50 + 0.16 * sc)}

    layers = {'transient': {'x': _cond(trans_buf[:, 0], 0.95), 'anchor': t_ref, 'gain': 1.0}}
    if pre is not None and len(pre) > 0:
        pr_m = pre.mean(1) if np.ndim(pre) == 2 else np.asarray(pre, dtype=float)
        layers['pre'] = {'x': _cond(pr_m, 0.90), 'gain': 0.42}
    if body_layer is not None:
        layers['body'] = body_layer
    if spring_tail is not None and len(spring_tail) > 0:
        tl_m = spring_tail.mean(1) if np.ndim(spring_tail) == 2 else np.asarray(spring_tail, dtype=float)
        layers['tail'] = {'x': fade(_cond(tl_m, 0.90), 0.002, 0.035), 'offset': 0.004, 'gain': 0.36}

    comp, anc = layer_event(layers, velocity=1.0, mass=1.0, wetness=0.15, seed=seed)
    return norm(comp, 0.95), anc


def precision_gear_turn(dur=0.12, *, teeth=5, tooth_sample=None, lock_sample=None,
                        accel=1.35, crisp_hp=2400.0, hover_ms=None, lock_jump_db=None, seed=1):
    """无源精密齿轮转动与咬合拟音（Passive Precision Gear Rotation & Crisp Tooth Mesh）：
    严禁使用电机/伺服连续嗡鸣或周期循环切片；按真实齿轮转角加速度逐颗摆放清脆的独立齿尖拨动微咔，
    经可选蓄力悬停（hover_ms）后在转到位瞬间落入双阶齿轮咬合锁止（KA-TA，可通过 lock_jump_db 显式抬升落锁跃迁），
    突出 3–13 kHz 精密金属/POM 齿尖清晰度。返回 (单声道波形, 落锁冲击锚点秒)。"""
    r = rng(seed)
    d_rot = max(0.04, float(dur))
    k_cnt = max(2, int(teeth))

    def _clean_tooth(src, max_s=0.028, hp_f=crisp_hp):
        if src is not None and len(src) > 0:
            s = src.mean(1) if np.ndim(src) == 2 else np.asarray(src, dtype=float)
            anc = sync_anchor(s, SR)
            ia = max(0, int(round(anc * SR)) - N(0.0015))
            seg = s[ia:ia + N(max_s)].copy()
            if len(seg) >= 12:
                y = peq(hp(norm(seg, 0.95), hp_f, 2), 3500.0, -4.5, q=1.3)
                return fade(norm(y, 0.92), 0.0004, min(0.008, len(y) / SR * 0.45))
        m = N(0.012)
        tt = np.arange(m) / SR
        y = bp(white(m, r), 2800.0, 12500.0, 2) * np.exp(-tt / 0.0016)
        return fade(norm(y, 0.90), 0.0003, 0.004)

    base_tick = _clean_tooth(tooth_sample, max_s=0.024, hp_f=crisp_hp)
    lock_click = _clean_tooth(lock_sample if lock_sample is not None else tooth_sample, max_s=0.085, hp_f=max(1400.0, crisp_hp * 0.65))

    tot_n = N(d_rot + 0.11)
    out = np.zeros(tot_n, dtype=float)
    gap_s = 0.018 if hover_ms is None else float(np.clip(float(hover_ms) * 1e-3, 0.008, max(0.012, d_rot * 0.55)))
    span_rot = max(0.016, d_rot - gap_s)
    # 前 k_cnt 颗齿沿转角加速曲线依次拨过，音高逐齿微升 (+0.35 st/齿) 体现张力聚拢，绝无电机嗡声
    for j in range(k_cnt):
        u = ((j + 0.25) / float(k_cnt + 0.45)) ** (1.0 / max(0.4, float(accel))) if hover_ms is None else ((j / max(1, k_cnt - 1)) ** (1.0 / max(0.4, float(accel))))
        t_j = u * span_rot
        st = -1.2 + 2.2 * (j / max(1, k_cnt - 1)) + float(r.uniform(-0.25, 0.25))
        tk_j = shift_material(base_tick, st, preserve_msi=0.85)
        gain_j = (0.38 + 0.42 * (j / max(1, k_cnt - 1))) * float(r.uniform(0.88, 1.08))
        i0 = max(0, int(round(t_j * SR)))
        m = min(tot_n - i0, len(tk_j))
        if m > 0:
            out[i0:i0 + m] += tk_j[:m] * gain_j

    # 精确在 d_rot 时刻落入主齿槽咬合（主齿面撞击 + 9.5ms 后止逆爪副咔嗒，形成清脆双阶齿轮咬合感）
    lock_gain = 1.05 if lock_jump_db is None else float(0.80 * (10.0 ** (float(lock_jump_db) / 20.0)))
    i_lock = int(round(d_rot * SR))
    anc_lk = sync_anchor(lock_click, SR)
    s_lk = max(0, i_lock - int(round(anc_lk * SR)))
    m_lk = min(tot_n - s_lk, len(lock_click))
    if m_lk > 0:
        out[s_lk:s_lk + m_lk] += lock_click[:m_lk] * lock_gain
    # 止逆爪副咬合微咔（+9.5 ms）
    i_pawl = min(tot_n - 16, i_lock + int(round(0.0095 * SR)))
    pawl = shift_material(base_tick, 1.6, preserve_msi=0.90)
    m_pw = min(tot_n - i_pawl, len(pawl))
    if m_pw > 0:
        out[i_pawl:i_pawl + m_pw] += pawl[:m_pw] * (0.56 * (lock_gain / 1.05))

    return norm(out, 0.95), float(d_rot)


def ratchet_detent(scale=1.0, *, variant='ka', bounce_ms=18.0, tube_mm=136.0, key=None, seed=1,
                   sample=None, latch_sample=None, spring_sample=None):
    """棘齿卡扣复合拟音（支持从 1.0× 桌面微距无缝放大到 4.5× 机构内部巨物化 Sonic Caricature）：
    传入真实录音 sample 时优先走 composite_mechanism 实录声学复合（保留真实圆珠笔/棘轮材质 DNA，杜绝合成正弦哨音与 EDM 低频扫频）；
    未传 sample 时走确定性物理建模兜底。返回 (立体声波形, 感知冲击锚点秒)。"""
    r = rng(seed)
    sc = float(np.clip(scale, 0.4, 6.0))
    pre_d = float(np.clip(0.009 * (sc ** 0.55), 0.006, 0.032))
    pre_w = stick_slip_friction(pre_d, np.linspace(0.3, 1.0, max(16, N(pre_d))),
                                material='polymer' if variant == 'ka' else 'metal', pressure=1.3, seed=seed + 1)

    if sample is not None and len(sample) > 0:
        id_st = float(np.clip(-3.4 * math.log2(sc), -9.5, 3.0)) - (1.8 if variant == 'da' else 0.0)
        return composite_mechanism(
            identity=sample,
            mechanism=latch_sample if sc <= 1.6 else latch_sample,
            latch_body=latch_sample if sc > 1.35 else None,
            pre=pre_w,
            spring_tail=spring_sample,
            scale=sc,
            identity_pitch_st=id_st,
            preserve_msi=0.82,
            tube_mm=tube_mm,
            tube_mix=0.24 if variant == 'ka' else 0.16,
            bounce_ms=bounce_ms,
            seed=seed,
        )

    # 2. Transient：优先用真实聚合物/金属录音经 shift_material 保 >2.8kHz 脆度移调，叠加精准材质瞬态
    tr_d = float(np.clip(0.045 * (sc ** 0.35), 0.030, 0.110))
    tr_n = N(tr_d)
    tt = np.arange(tr_n) / SR
    snap_tau = 0.0024 * (sc ** 0.35)
    if variant == 'ka':
        snap = (un_safe(bp(white(tr_n, r), 2200.0, 12000.0, 2)) * np.exp(-tt / snap_tau) * 1.15
                + np.sin(2 * np.pi * (3400.0 / (sc ** 0.18)) * tt) * np.exp(-tt / (snap_tau * 2.2)) * 0.65)
    else:
        snap = (un_safe(bp(white(tr_n, r), 1100.0, 9200.0, 2)) * np.exp(-tt / (snap_tau * 1.2)) * 0.95
                + np.sin(2 * np.pi * (5800.0 / (sc ** 0.20)) * tt) * np.exp(-tt / (snap_tau * 1.8)) * 0.45)

    if sample is not None and len(sample) > 0:
        s_m = sample.mean(1) if np.ndim(sample) == 2 else np.asarray(sample, dtype=float)
        st_drop = float(np.clip(-4.2 * math.log2(sc), -12.0, 4.0)) - (2.5 if variant == 'da' else 0.0)
        s_sh = shift_material(s_m, st_drop, preserve_msi=0.72)
        anc_s = sync_anchor(s_sh, SR)
        ia = max(0, int(round(anc_s * SR)) - N(0.003))
        seg = s_sh[ia:ia + tr_n]
        if len(seg) >= 16:
            seg = fade(np.pad(seg, (0, max(0, tr_n - len(seg)))), 0.0008, 0.012)
            snap = 0.72 * un_safe(seg) + 0.42 * un_safe(snap)

    # da 的 0.25mm 锁定回弹次生微触击（对应 motion.js 第 21 行物理回弹）
    if bounce_ms and bounce_ms > 2.0:
        ib = int(round(float(bounce_ms) * 1e-3 * (sc ** 0.25) * SR))
        if ib + N(0.008) < tr_n:
            mb = N(0.008)
            tb = np.arange(mb) / SR
            reb = un_safe(bp(white(mb, r), 1600.0, 9000.0, 2)) * np.exp(-tb / 0.0012) * (0.26 if variant == 'da' else 0.16)
            snap[ib:ib + mb] += reb

    # 3. Body：圆管腔体共鸣 + 巨物化超低频胸腔重锤（sc > 1.8 时自然长出 46–110 Hz 钟楼擒纵体量）
    bd_d = float(np.clip(0.14 * (sc ** 0.55), 0.09, 0.55))
    bd_n = N(bd_d)
    tb = np.arange(bd_n) / SR
    f_cav = float(np.clip(343000.0 / (2.0 * max(35.0, float(tube_mm))) / (sc ** 0.45), 140.0, 1600.0))
    if key is not None:
        from .director import harmonic_freq
        f_cav = harmonic_freq(f_cav, root=key)
    cav = (np.sin(2 * np.pi * f_cav * tb) * np.exp(-tb / (0.022 * (sc ** 0.4))) * 0.65
           + un_safe(bp(brown(bd_n, r), max(60.0, f_cav * 0.45), min(3200.0, f_cav * 1.9), 2)) * np.exp(-tb / (0.032 * (sc ** 0.45))) * 0.75)
    if variant == 'da':
        f_thock = 215.0 / (sc ** 0.4)
        cav += np.sin(2 * np.pi * np.cumsum(f_thock * (1.0 + 0.45 * np.exp(-tb / 0.008))) / SR) * np.exp(-tb / 0.028) * 0.85
    if sc > 1.5:
        sub_g = min(0.85, (sc - 1.2) * 0.28)
        f_sub = 96.0 * np.exp(-tb / 0.045) + 46.0
        cav += sub_g * np.sin(2 * np.pi * np.cumsum(f_sub) / SR) * np.minimum(1.0, tb / 0.0025) * np.exp(-tb / (0.075 * (sc ** 0.30)))

    # 4. Tail：冲击激发的内部弹簧轴向微颤余韵
    tl_d = float(np.clip(0.22 * (sc ** 0.5), 0.14, 0.85))
    sp_w, _ = spring_coil(tl_d, turns=12, action='shudder', scale=sc, key=key, seed=seed + 7)
    tail_gain = 0.22 if variant == 'ka' else 0.14
    if sc > 2.0:
        tail_gain = 0.36

    comp, anc = layer_event(
        {
            'pre': {'x': pre_w, 'gain': 0.32},
            'transient': {'x': snap, 'anchor': 0.0015, 'gain': 1.0},
            'body': {'x': cav, 'anchor': 0.0025, 'gain': 0.82},
            'tail': {'x': sp_w, 'offset': 0.005, 'gain': tail_gain},
        },
        velocity=min(2.2, 0.85 + 0.22 * sc),
        mass=min(3.5, 0.8 + 0.35 * sc),
        wetness=0.2,
        seed=seed,
    )
    return norm(comp, 0.95), anc
