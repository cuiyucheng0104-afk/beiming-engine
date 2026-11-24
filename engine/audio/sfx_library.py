# -*- coding: utf-8 -*-
"""北冥引擎 · 商用音效库索引、检索与按需缓存加载（63 G 已购库，支持 Google Drive 按需拉取与本地挂载）。

库本体永不入仓：仓库只存元数据索引 `engine/audio/sfx_library_index.jsonl`（< 5 MiB）与 Agent 总地图
`engine/audio/sfx_library_manifest.json`（~5 KB），检索离线可跑（CI 无库也绿）。
音频本体查找优先级（零 M 盘依赖亦可跑通）：
  1. 本机缓存（`BEIMING_SFX_CACHE` 或 `~/.cache/beiming/sfx/raw/<rel_path>`）
  2. 可选本机挂载点（`BEIMING_SFX_ROOT`，向后兼容）
  3. 按需从 Google Drive 单条拉取（`gid` 或 `BEIMING_SFX_REMOTE` 经 `rclone` / `gdown` / HTTPS 落本机缓存）

接口：
  build_index(csv_path, defects_path=None)      解析总目录 CSV（utf-8-sig）与瑕疵清单 → (行列表, 统计)
  write_index(rows, out_path)                   写紧凑 JSONL 索引（dirs 字典化；可选 gid 字段）
  load_index(path=None)                         读索引（进程内缓存）
  enrich_row(row) / stable_id(rel_path)         确定性补全 id、role、norm_cat、vgroup
  build_manifest(rows, source=None) / load_manifest()  生成/读取 Agent 总地图
  backfill_gids(rows, lsjson_items)             从 `rclone lsjson -R --files-only` 回填 Google Drive gid
  search(query, ...)                            中英关键词 + role/norm_cat/时长/变体聚类检索（自动 SQLite FTS5 加速）
  info(id_or_path, ...)                         单条详情 + 同组变体 + 本地缓存状态
  resolve(id_or_path, fetch=False, ...)         解析本地路径（可选按需拉取，防路径穿越）
  fetch(id_or_path, ...)                        按需从 Google Drive 拉单条到本地缓存
  load_audio(id_or_path, ...)                   48 kHz float64 立体声加载（AIFF 兜底、多声道缩混、降调保高频）
  one_shot(pool, seed=0, ...) / bed(id_or_path, dur, seed=0, ...)  确定性变体轮换与无缝循环环境底
许可证核验与使用边界见 docs/rights/sfx-library.md。
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path

from .sfx_vocab import CJK_RE, search_ucs, tokenize_query

INDEX_PATH = Path(__file__).resolve().parent / 'sfx_library_index.jsonl'
MANIFEST_PATH = Path(__file__).resolve().parent / 'sfx_library_manifest.json'
GIDS_PATH = Path(__file__).resolve().parent / 'sfx_library_gids.json.gz'
ENV_ROOT = 'BEIMING_SFX_ROOT'
ENV_REMOTE = 'BEIMING_SFX_REMOTE'
ENV_CACHE = 'BEIMING_SFX_CACHE'

_FTS_SCHEMA_VERSION = '2'

# 瑕疵清单的小节标题 → 缺陷标记
_DEFECT_KINDS = (
    (('FORM', 'AIFF'), 'aiff_renamed_from_wav'),
    (('0 字节', '空文件'), 'zero_byte_deleted'),
)
# 授权状态（机器字段）：全部子库统一 owner-confirmed（见 docs/rights/sfx-library.md）
RIGHTS_STATUS = 'owner-confirmed'
# 来源注记（不是授权状态，不阻塞使用，不排除检索）
SOURCE_RESIDUE = {
    'SoundMorph - Future Weapons 1': ['Ammunitions/About.zip（内含 About.txt：LookAE 声明、LookAE.com / FCPX 资源站 / Audio Jungle 合集 .url）', '重打包站 GBK 乱码目录「更多免费资源下载」'],
    'SoundMorph - Future Weapons 2': ['Source Recordings/About.zip、Designed/Explosions/About.zip（内容同上）', '重打包站 GBK 乱码目录「更多免费资源下载」'],
    'SoundMorph.Portals': ['下载.url（指向 lookae.com，独立复核发现；04:19 复查已不在盘上）'],
    'SoundMorph.Inner.Circle.Transient.Foundations': ['TM DISCOVER.nfo（独立复核发现；04:19 复查已不在盘上）'],
}
RESIDUE_TAG = 'third-party-files'

_REQUIRED_COLS = ('品牌', '子库', '文件名', '所在目录', '时长(秒)', '采样率', '位深', '声道', '描述/关键词', '分类', '子分类')

NORM_CATEGORIES = {
    'ambience': '环境底噪与城市/自然实景（上海外滩、人群、交通、房间底、风雨）',
    'mechanical': '机械机关、金属咬合、伺服电机、齿轮与门锁',
    'impact': '撞击、重击、落物、拳击与低频冲击',
    'whoosh': '破空、挥砍、飞掠、扫频、转场与上升音',
    'energy': '能量、电流、雷电、等离子、蓄力与充放电',
    'ui_scifi': '科幻界面、按键提示音、全息、雷达、警报与故障音',
    'weapon': '枪械、炮火、激光武器、爆炸与装弹',
    'creature': '怪兽、生物吼叫、动物虫鸟与奇幻生物',
    'debris': '碎裂、石块、木头、玻璃、金属残片与坍塌',
    'foley': '拟音脚步、衣物摩擦、身体动作与日常器物',
    'vocal': '人声呼喊、呼吸、低语、嘶吼与实验人声',
    'drone': '持续低鸣、嗡鸣、紧张氛围与噪声底',
    'other': '其他设计音效与实验素材',
}

ROLE_DESCRIPTIONS = {
    'oneshot': '短促单发拟音/打击/提示音（<=4s）',
    'transition': '转场/扫频/破空/蓄力变换（<=12s）',
    'bed': '长环境底/持续氛围（>=10s，适合循环铺底）',
    'sequence': '中长段连续动作/多段机械或演化事件',
}

SUBLIBRARY_NOTES = {
    'Mechanicals Designed': 'BOOM 大型金属机械与复杂机关咬合设计',
    'Pro Sound Effects - First': '通用自然/城市/人群/器物与拟音精选',
    'Pro.Sound.Effects.Shanghai': '上海外滩/南京路/古镇/地铁/磁悬浮实景立体声环境底',
    'SoundMorph - Future Weapons 1': '科幻联盟/反抗军武器、激光与装弹拟音',
    'SoundMorph - Future Weapons 2': '重型科幻枪械、等离子炮、爆炸与分层源素材',
    'SoundMorph.Bloody Nightmare': '暗黑惊悚冲击、低语、脉冲、氛围与上升音',
    'SoundMorph.Energy': '电流、雷电、粒子、充放电、能量武器与破空',
    'SoundMorph.Future.Weapons.3': '全套科幻步枪/狙击/激光/扫描护盾与装弹',
    'SoundMorph.Inner.Circle.Transient.Foundations': '电影级瞬态底鼓、军鼓、节奏切片与合成打击',
    'SoundMorph.Matter Mayhem': '石块/木头/玻璃/金属爆破、碎裂与坍塌',
    'SoundMorph.Mechanism': '精密机械机关、齿轮与机器人机械动作',
    'SoundMorph.Monster_Within': '怪兽攻击、吼叫、脚步、呼吸、肉体打击与变身',
    'SoundMorph.Portals': '中世纪/科幻/石门/传送门开关与空间跃迁',
    'SoundMorph.Road Riders': '摩托车引擎、加速、减速与飞掠',
    'SoundMorph.Robotic Lifeforms': '机器人变形、伺服、金属摩擦、脚步与电子人声',
    'SoundMorph.Solar Sky': '飞船舱门、启停、引擎氛围与星际飞掠',
    'SoundMorph.Steampunk.Weapons': '蒸汽朋克机械枪械、喷火与脉冲武器',
    'SoundMorph.Tension': '悬疑低鸣、水琴摩擦、扭曲噪声与氛围铺底',
    'SoundMorph.Users of Tomorrow': '未来 UI 交互、全息屏、按键、故障与警报',
}

_CAT_RULES = (
    ('ui_scifi', re.compile(r'\b(ui|hud|beep|button|switch|interface|console|hologram|glitch|alarm|confirm|denied|scanner|computer|screen|display|telemetry|data)\b|users of tomorrow', re.I)),
    ('ambience', re.compile(r'\b(ambien|atmos|room.?tone|crowd|walla|street|traffic|city|urban|metro|subway|park|riverside|waitan|shanghai|museum|restaurant|mall|market|rain|river|ocean|sea|forest|jungle|mangrove|ferry|rooftop)\b', re.I)),
    ('debris', re.compile(r'\b(debris|shatter|collapse|rubble|pebble|glass|stone|wood|brick|crumble|break|smash|destruction)\b|matter mayhem', re.I)),
    ('weapon', re.compile(r'\b(weapon|gun|rifle|shotgun|blaster|cannon|rocket|grenade|mine|ammo|ammunition|reload|laser|sniper|flamer|crossbow|explos|blast|blow up|turret)\b|future\.?weapons|steampunk\.weapons', re.I)),
    ('whoosh', re.compile(r'\b(whoosh|passby|pass.?by|flyby|swing|swipe|riser|swell|sweep|morph|transform|teleport|takeoff|accelerat|decelerat|shepard|stinger|power.?up|power.?down)\b', re.I)),
    ('energy', re.compile(r'\b(energy|electric|electricity|lightning|spark|plasma|neutron|particle|centrifuge|reactor|charge|discharge|shield|volt|arc|zap)\b', re.I)),
    ('mechanical', re.compile(r'\b(mechan|servo|gear|ratchet|click|clack|latch|lock|door|hatch|gate|metal|forge|drill|motor|engine|industrial|hydraulic|pneumatic|chain|drawbridge|machine|steam|motorcycle|ducati|honda|yamaha)\b', re.I)),
    ('creature', re.compile(r'\b(monster|creature|beast|roar|growl|snarl|hiss|dragon|alien|insect|bug|bird|frog|animal|wing)\b|monster_within', re.I)),
    ('vocal', re.compile(r'\b(vocal|voice|scream|grunt|breath|whisper|cough|laugh|pain|taunt|evp|speech|chant)\b', re.I)),
    ('foley', re.compile(r'\b(footstep|step|foley|cloth|flesh|body.?movement|jump|dodge|climb|scrape|slide|camera|water|splash|droplet|spray|paper|book|chair|table)\b', re.I)),
    ('impact', re.compile(r'\b(impact|hit|punch|kick|snare|slam|thud|boom|crash|bash|strike|melee|damage|death|transient)\b', re.I)),
    ('drone', re.compile(r'\b(drone|hum|buzz|static|noise|tone|pulse|texture|waterphone|bowed|sustained|tension|nightmare|dark)\b', re.I)),
)

_TRANSITION_RE = re.compile(
    r'\b(whoosh|passby|pass.?by|flyby|riser|swell|sweep|morph|transform|power.?up|power.?down|stinger|teleport|takeoff|accelerat|decelerat|swing|swipe)\b',
    re.I,
)
_BED_RE = re.compile(
    r'\b(ambien|atmos|loop|room.?tone|drone|hum|crowd|walla|traffic|rain|river|wind|static|bed|sustained|texture|noise|engine|motor|idle|rooftop|hallway|street|market|restaurant|park|ferry)\b',
    re.I,
)
_VGROUP_SUFFIX_RE = re.compile(r'(?:[_\-\s]+(?:v|var|take|alt|pt|part)?\d+[a-z]?)+$', re.I)


class IndexBuildError(ValueError):
    """总目录 CSV 缺列或某行数值坏了：消息带行号，调用方（CLI）转成契约错误。"""


class SfxFetchError(RuntimeError):
    """按需解析或从 Google Drive 拉取音效失败（带可执行提示，不静默吞错）。"""


_DEFECT_PATH_RE = re.compile(r'^\S.*\.(wav|aif|aiff|mp3|m4a|flac|ogg)$', re.I)


def parse_defects(text: str) -> dict:
    """解析《音效库瑕疵清单.txt》→ {相对路径: 缺陷标记}。识别不了的小节（如处理记录）跳过。"""
    out: dict = {}
    kind = None
    for line in str(text or '').splitlines():
        s = line.strip()
        if s.startswith('#'):
            kind = None
            for keys, tag in _DEFECT_KINDS:
                if all(k in s for k in keys):
                    kind = tag
                    break
            continue
        if kind and s and not s.startswith('-') and _DEFECT_PATH_RE.match(s):
            out[s.lstrip('./')] = kind
    return out


def _s(r, col):
    return (r.get(col) or '').strip()


def _num(r, col, cast):
    v = _s(r, col)
    if v == '':
        return cast(0)
    try:
        x = cast(v)
    except ValueError:
        raise ValueError(f'{col} 不是数字 {v!r}') from None
    if not math.isfinite(x):
        raise ValueError(f'{col} 不是有限数值 {v!r}')
    return x


def _rel_path(row: dict) -> str:
    if row.get('path'):
        return row['path']
    d = row.get('dir', '')
    f = row.get('file', '')
    return f'{d}/{f}' if d else f


def stable_id(rel_path: str) -> str:
    """相对路径 → 确定性短 ID（sfx_<10位sha1>），无空格、跨平台稳定。"""
    norm = str(rel_path).replace('\\', '/').lstrip('/')
    return 'sfx_' + hashlib.sha1(norm.encode('utf-8')).hexdigest()[:10]


def normalize_category(row: dict) -> str:
    """将各厂商原始分类/描述/子库归一化为 12 个标准大类之一（或 other）。"""
    text = ' '.join((
        row.get('cat', ''),
        row.get('subcat', ''),
        row.get('file', ''),
        row.get('desc', ''),
        row.get('sub', ''),
    ))
    for norm_cat, rx in _CAT_RULES:
        if rx.search(text):
            return norm_cat
    return 'other'


def classify_role(row: dict, norm_cat: str | None = None) -> str:
    """按时长与声学用途自动分型：oneshot / transition / bed / sequence。"""
    dur = float(row.get('dur', 0) or 0)
    nc = norm_cat or normalize_category(row)
    text = ' '.join((row.get('file', ''), row.get('cat', ''), row.get('subcat', ''), row.get('desc', '')))
    if dur >= 10.0 and (nc in ('ambience', 'drone') or _BED_RE.search(text)):
        return 'bed'
    if dur >= 25.0:
        return 'bed'
    if dur <= 12.0 and (nc == 'whoosh' or _TRANSITION_RE.search(text)):
        return 'transition'
    if dur <= 4.0:
        return 'oneshot'
    return 'sequence'


def variant_group(rel_path: str) -> str:
    """剥离文件名尾部编号/变体后缀，把同类变体（如 attack_01..06）归为同一组。"""
    norm = str(rel_path).replace('\\', '/').lstrip('/')
    parent, _, fname = norm.rpartition('/')
    stem = fname.rsplit('.', 1)[0]
    base = _VGROUP_SUFFIX_RE.sub('', stem).strip(' _-.').lower() or stem.lower()
    return f'{parent}/{base}' if parent else base


def enrich_row(row: dict) -> dict:
    """返回补全了 id / path / norm_cat / role / vgroup / rights 的副本（不改原 dict）。"""
    path = _rel_path(row)
    nc = row.get('norm_cat') or normalize_category(row)
    role = row.get('role') or classify_role(row, nc)
    out = dict(row)
    out['path'] = path
    out['id'] = row.get('id') or stable_id(path)
    out['norm_cat'] = nc
    out['role'] = role
    out['vgroup'] = row.get('vgroup') or variant_group(path)
    out['rights'] = RIGHTS_STATUS
    if row.get('source_residue'):
        out['residue_files'] = SOURCE_RESIDUE.get(row.get('sub', ''), [])
    return out


def build_index(csv_path, defects_path=None) -> tuple:
    """读总目录 CSV（UTF-8 BOM）生成索引行；给瑕疵清单时打缺陷标记。"""
    import csv

    defects = {}
    if defects_path:
        with open(defects_path, encoding='utf-8-sig') as f:
            defects = parse_defects(f.read())

    rows, stats = [], {'renamed': 0, 'deleted': 0, 'total': 0}
    with open(csv_path, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        missing = [c for c in _REQUIRED_COLS if c not in (reader.fieldnames or [])]
        if missing:
            raise IndexBuildError(f'总目录 CSV 缺少必需列：{"、".join(missing)}（表头：{reader.fieldnames}）')
        for r in reader:
            stats['total'] += 1
            lineno = reader.line_num
            name = _s(r, '文件名')
            if not name:
                raise IndexBuildError(f'总目录 CSV 第 {lineno} 行：文件名为空')
            try:
                dur, sr, bits, ch = (_num(r, '时长(秒)', float), _num(r, '采样率', int),
                                     _num(r, '位深', int), _num(r, '声道', int))
            except ValueError as e:
                raise IndexBuildError(f'总目录 CSV 第 {lineno} 行（{name}）：{e}') from None
            if dur < 0:
                raise IndexBuildError(f'总目录 CSV 第 {lineno} 行（{name}）：时长(秒) 为负数 {dur}')
            rel = '/'.join(x for x in (_s(r, '所在目录'), name) if x)
            defect = defects.get(rel)
            if defect is None and rel.lower().endswith('.aif'):
                defect = defects.get(re.sub(r'\.aif$', '.wav', rel, flags=re.I))
            if defect == 'aiff_renamed_from_wav':
                stats['renamed'] += 1
            elif defect == 'zero_byte_deleted':
                stats['deleted'] += 1
            row = {
                'brand': _s(r, '品牌'),
                'sub': _s(r, '子库'),
                'file': name,
                'dir': _s(r, '所在目录'),
                'dur': dur,
                'sr': sr,
                'bits': bits,
                'ch': ch,
                'desc': _s(r, '描述/关键词'),
                'cat': _s(r, '分类'),
                'subcat': _s(r, '子分类'),
            }
            if defect:
                row['defect'] = defect
            if row['sub'] in SOURCE_RESIDUE:
                row['source_residue'] = RESIDUE_TAG
            rows.append(row)
    return rows, stats


def write_index(rows, out_path):
    """写紧凑 JSONL 索引；返回字节数。首行目录字典化，严守 < 5 MiB 红线。"""
    dirs, d_idx = [], {}
    for row in rows:
        d = row.get('dir', '')
        if d not in d_idx:
            d_idx[d] = len(dirs)
            dirs.append(d)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    # 只持久化原始核心字段 + 可选标记（gid / defect / source_residue），id/role/norm_cat/vgroup 加载时确定性派生
    skip = {'dir', 'path', 'id', 'role', 'norm_cat', 'vgroup', 'rights', 'residue_files', 'score', 'variant_count', 'variants'}
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps({'dirs': dirs}, ensure_ascii=False, separators=(',', ':')) + '\n')
        for row in rows:
            packed = {'d': d_idx[row.get('dir', '')]}
            packed.update({k: v for k, v in row.items() if k not in skip and v is not None})
            f.write(json.dumps(packed, ensure_ascii=False, separators=(',', ':')) + '\n')
    _load.cache_clear()
    return os.path.getsize(out_path)


@lru_cache(maxsize=4)
def _load(path: str):
    dirs = None
    rows = []
    with open(path, encoding='utf-8') as f:
        first = True
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            if first and isinstance(obj, dict) and 'dirs' in obj:
                dirs = obj['dirs']
                first = False
                continue
            first = False
            if dirs is not None and 'd' in obj:
                obj['dir'] = dirs[obj['d']]
                del obj['d']
            rows.append(obj)
    return rows


def load_index(path=None) -> list:
    """读索引（默认仓库内置索引）。索引随仓库分发，读它不碰库本体，CI 也能跑。"""
    p = Path(path) if path is not None else INDEX_PATH
    rows = _load(str(p.resolve()))
    if path is None and GIDS_PATH.exists():
        gids = load_gids()
        if gids:
            for r in rows:
                if 'gid' not in r:
                    sid = stable_id(_rel_path(r))
                    gid = gids.get(sid)
                    if gid:
                        r['gid'] = gid
    return rows


@lru_cache(maxsize=2)
def _load_gids_cached(path: str) -> dict:
    p = Path(path)
    if p.suffix == '.gz':
        with gzip.open(p, 'rt', encoding='utf-8') as f:
            return json.load(f)
    return json.loads(p.read_text(encoding='utf-8'))


def load_gids(path=None) -> dict:
    """读取紧凑短 ID → Google Drive File ID 映射表（保持主索引 < 5 MiB）。"""
    p = Path(path) if path is not None else GIDS_PATH
    if not p.exists():
        return {}
    return _load_gids_cached(str(p.resolve()))


def write_gids(rows_or_map, out_path=None) -> int:
    """将索引行里的 gid（或 {id: gid} 字典）写成紧凑确定性 JSON/JSON.GZ 文件并返回字节数。"""
    p = Path(out_path) if out_path is not None else GIDS_PATH
    if isinstance(rows_or_map, dict):
        gmap = {str(k): str(v) for k, v in rows_or_map.items() if k and v}
    else:
        gmap = {}
        for r in rows_or_map:
            gid = r.get('gid')
            if gid:
                gmap[stable_id(_rel_path(r))] = str(gid)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(gmap, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n').encode('utf-8')
    if p.suffix == '.gz':
        with open(p, 'wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as gz:
            gz.write(payload)
    else:
        p.write_bytes(payload)
    _load_gids_cached.cache_clear()
    _load.cache_clear()
    return p.stat().st_size


def available() -> bool:
    return INDEX_PATH.exists()


def root():
    """可选本地库根（BEIMING_SFX_ROOT）；未设时返回 None。"""
    return os.environ.get(ENV_ROOT) or None


def default_cache_dir() -> Path:
    """默认本地缓存目录（可通过 BEIMING_SFX_CACHE 覆盖）。"""
    env = os.environ.get(ENV_CACHE)
    if env:
        return Path(env).expanduser()
    return Path.home() / '.cache' / 'beiming' / 'sfx'


def abs_path(rel_path) -> str | None:
    r = root()
    return os.path.join(r, rel_path) if r else None


def build_manifest(rows, source=None) -> dict:
    """根据索引行构建 Agent 总地图 manifest.json（~5 KB）。"""
    cat_counts: dict[str, int] = {}
    role_counts: dict[str, int] = {}
    sub_map: dict[str, dict] = {}
    defective = 0
    with_gid = 0
    for r in rows:
        e = enrich_row(r)
        if e.get('defect'):
            defective += 1
        if e.get('gid'):
            with_gid += 1
        nc = e['norm_cat']
        cat_counts[nc] = cat_counts.get(nc, 0) + 1
        rl = e['role']
        role_counts[rl] = role_counts.get(rl, 0) + 1
        sub = e.get('sub', '')
        if sub not in sub_map:
            sub_map[sub] = {
                'brand': e.get('brand', ''),
                'count': 0,
                'note': SUBLIBRARY_NOTES.get(sub, ''),
                'source_residue': bool(e.get('source_residue')),
            }
        sub_map[sub]['count'] += 1

    src = {
        'provider': 'gdrive',
        'folder_id': '',
        'folder_url': '',
        'rclone_remote': '',
        'env_remote': ENV_REMOTE,
        'env_cache': ENV_CACHE,
        'env_root': ENV_ROOT,
        'rights': RIGHTS_STATUS,
    }
    if isinstance(source, dict):
        src.update({k: v for k, v in source.items() if v is not None})

    return {
        'schema': 'beiming.sfx-manifest/1',
        'index_file': 'engine/audio/sfx_library_index.jsonl',
        'source': src,
        'stats': {
            'total': len(rows),
            'active': len(rows) - defective,
            'defective': defective,
            'with_gid': with_gid,
            'sublibraries': len(sub_map),
        },
        'roles': {
            k: {'count': role_counts.get(k, 0), 'desc': v}
            for k, v in ROLE_DESCRIPTIONS.items()
        },
        'categories': {
            k: {'count': cat_counts.get(k, 0), 'desc': v}
            for k, v in NORM_CATEGORIES.items()
            if cat_counts.get(k, 0) > 0
        },
        'sublibraries': dict(sorted(sub_map.items(), key=lambda kv: (-kv[1]['count'], kv[0]))),
    }


def write_manifest(manifest_obj: dict, out_path=None) -> int:
    p = Path(out_path) if out_path is not None else MANIFEST_PATH
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(manifest_obj, ensure_ascii=False, indent=2) + '\n'
    p.write_text(text, encoding='utf-8')
    return p.stat().st_size


def load_manifest(path=None) -> dict:
    p = Path(path) if path is not None else MANIFEST_PATH
    return json.loads(p.read_text(encoding='utf-8'))


def backfill_gids(rows: list, lsjson_items: list) -> tuple[list, dict]:
    """将 `rclone lsjson -R --files-only` 的输出按相对路径回填到索引行的 gid 字段。"""
    by_path: dict[str, str] = {}
    for item in lsjson_items or []:
        if not isinstance(item, dict) or item.get('IsDir'):
            continue
        p = str(item.get('Path') or item.get('path') or '').replace('\\', '/').lstrip('/')
        gid = str(item.get('ID') or item.get('id') or item.get('gid') or '').strip()
        if p and gid:
            by_path[p] = gid

    matched = 0
    out = []
    for row in rows:
        r = dict(row)
        rel = _rel_path(r).replace('\\', '/').lstrip('/')
        gid = by_path.get(rel)
        if gid:
            r['gid'] = gid
            matched += 1
        out.append(r)
    return out, {
        'total': len(rows),
        'lsjson_files': len(by_path),
        'matched': matched,
        'unmatched_rows': len(rows) - matched,
    }


# ———— 本地 SQLite FTS5 加速缓存 ————
def _fts_db_path(cache_dir=None) -> Path:
    base = Path(cache_dir).expanduser() if cache_dir is not None else default_cache_dir()
    return base / 'index.sqlite'


def _ensure_fts(index_path: Path, cache_dir=None) -> Path | None:
    """按 JSONL 的 (mtime_ns, size) 自动构建或复用本地只读 SQLite FTS5 缓存；无写权限时返回 None 退回内存检索。"""
    try:
        st = index_path.stat()
    except OSError:
        return None
    db_path = _fts_db_path(cache_dir)
    gids_sig = ''
    if index_path.resolve() == INDEX_PATH.resolve() and GIDS_PATH.exists():
        try:
            gst = GIDS_PATH.stat()
            gids_sig = f'|{gst.st_mtime_ns}:{gst.st_size}'
        except OSError:
            pass
    sig = f'{index_path.resolve()}|{st.st_mtime_ns}|{st.st_size}|{_FTS_SCHEMA_VERSION}{gids_sig}'
    if db_path.exists():
        try:
            con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            try:
                row = con.execute("SELECT v FROM meta WHERE k='sig'").fetchone()
                if row and row[0] == sig:
                    return db_path
            finally:
                con.close()
        except sqlite3.Error:
            pass
    try:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = db_path.with_suffix(f'.tmp.{os.getpid()}.sqlite')
        if tmp_path.exists():
            tmp_path.unlink()
        rows = load_index(None if index_path.resolve() == INDEX_PATH.resolve() else index_path)
        con = sqlite3.connect(str(tmp_path))
        try:
            con.execute('PRAGMA journal_mode=OFF')
            con.execute('PRAGMA synchronous=OFF')
            con.execute('CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)')
            con.execute(
                'CREATE TABLE items ('
                ' idx INTEGER PRIMARY KEY, id TEXT, path TEXT, brand TEXT, sub TEXT,'
                ' file TEXT, dir TEXT, dur REAL, sr INTEGER, bits INTEGER, ch INTEGER,'
                ' cat TEXT, subcat TEXT, norm_cat TEXT, role TEXT, vgroup TEXT,'
                ' defect TEXT, source_residue TEXT, gid TEXT, desc TEXT)'
            )
            con.execute(
                'CREATE VIRTUAL TABLE items_fts USING fts5('
                ' stem, desc, ctx, content="", tokenize="unicode61")'
            )
            item_batch, fts_batch = [], []
            for i, raw in enumerate(rows):
                e = enrich_row(raw)
                stem = re.sub(r'[._\-]+', ' ', e['file'].rsplit('.', 1)[0]).lower()
                ctx = ' '.join((e['cat'], e['subcat'], e['sub'], e['brand'], e['norm_cat'], e['role'])).lower()
                item_batch.append((
                    i, e['id'], e['path'], e['brand'], e['sub'], e['file'], e['dir'],
                    float(e['dur']), int(e['sr']), int(e['bits']), int(e['ch']),
                    e['cat'], e['subcat'], e['norm_cat'], e['role'], e['vgroup'],
                    e.get('defect') or '', e.get('source_residue') or '', e.get('gid') or '', e['desc'],
                ))
                fts_batch.append((i, stem, e['desc'].lower(), ctx))
            con.executemany(
                'INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                item_batch,
            )
            con.executemany(
                'INSERT INTO items_fts(rowid, stem, desc, ctx) VALUES (?,?,?,?)',
                fts_batch,
            )
            con.execute("INSERT INTO meta(k, v) VALUES ('sig', ?)", (sig,))
            con.commit()
        finally:
            con.close()
        os.replace(tmp_path, db_path)
        return db_path
    except (OSError, sqlite3.Error):
        return None


def _query_terms(query: str) -> list:
    """检索词展开：英文词原样；中文经 UCS 词表（sfx_vocab.search_ucs）翻成英文类别名与同义词。"""
    terms, seen = [], set()

    def add(t):
        t = t.strip().lower()
        if t and t not in seen and len(t) >= 2:
            seen.add(t)
            terms.append(t)

    for t in tokenize_query(query):
        add(t)
    if not CJK_RE.search(query):
        return terms[:24]
    chunks = [(query, True)]
    chunks += [(query[i:i + 2], True) for i in range(max(0, len(query) - 1))]
    chunks += [(c, False) for c in query]
    for q, rich in chunks:
        for u in search_ucs(q, top_n=4):
            add(u['category'])
            if rich:
                add(u['subCategory'])
                for en in (u['matchedEn'] or u['synonymsEn'][:6]):
                    add(en)
        if sum(1 for t in terms if not CJK_RE.search(t)) >= 4:
            break
    return terms[:24]


def _score_row(row: dict, terms: list, phrase: str | None) -> float:
    stem = re.sub(r'[._\-]+', ' ', row['file'].rsplit('.', 1)[0]).lower()
    stem_toks = set(stem.split())
    desc = row['desc'].lower()
    ctx = ' '.join((row['cat'], row['subcat'], row['sub'], row['brand'])).lower()
    score = 0.0
    for t in terms:
        if t in stem_toks:
            score += 3.0
        elif t in stem:
            score += 1.5
        if t in desc.split(', '):
            score += 2.0
        elif t in desc:
            score += 1.0
        if t in ctx:
            score += 1.0
    if phrase:
        if phrase in desc:
            score += 4.0
        elif phrase in stem:
            score += 3.0
    return round(score, 1)


def _hit(row: dict, score: float) -> dict:
    h = enrich_row(row)
    h['score'] = score
    return h


def _collapse_variants(hits: list) -> list:
    groups: dict[str, list] = {}
    order: list[str] = []
    for h in hits:
        vg = h['vgroup']
        if vg not in groups:
            groups[vg] = []
            order.append(vg)
        groups[vg].append(h)
    out = []
    for vg in order:
        members = groups[vg]
        rep = dict(members[0])
        rep['variant_count'] = len(members)
        rep['variants'] = [
            {'id': m['id'], 'file': m['file'], 'path': m['path'], 'dur': m['dur'], 'score': m['score']}
            for m in members
        ]
        out.append(rep)
    return out


def _fts_candidates(db_path: Path, terms: list, *, brand, sub, cat, subcat, role, norm_cat, dur_min, dur_max, include_defective) -> list[dict] | None:
    where = []
    params: list = []
    if not include_defective:
        where.append("i.defect = ''")
    if brand:
        where.append('lower(i.brand) = ?')
        params.append(brand)
    if sub:
        where.append('lower(i.sub) LIKE ?')
        params.append(sub + '%')
    if cat:
        where.append('instr(lower(i.cat), ?) > 0')
        params.append(cat)
    if subcat:
        where.append('instr(lower(i.subcat), ?) > 0')
        params.append(subcat)
    if role:
        where.append('i.role = ?')
        params.append(role)
    if norm_cat:
        where.append('i.norm_cat = ?')
        params.append(norm_cat)
    if dur_min is not None:
        where.append('i.dur >= ?')
        params.append(float(dur_min))
    if dur_max is not None:
        where.append('i.dur <= ?')
        params.append(float(dur_max))

    fts_tokens = []
    for t in terms:
        tok = re.sub(r'[^0-9a-zA-Z\u4e00-\u9fff]+', ' ', t).strip()
        if tok:
            fts_tokens.append('"' + tok.replace('"', '') + '"*')

    cols = 'i.brand, i.sub, i.file, i.dir, i.dur, i.sr, i.bits, i.ch, i.desc, i.cat, i.subcat, i.defect, i.source_residue, i.gid, i.norm_cat, i.role, i.vgroup, i.id'
    if fts_tokens:
        match_expr = ' OR '.join(fts_tokens)
        sql = f'SELECT {cols} FROM items_fts f JOIN items i ON i.idx = f.rowid WHERE items_fts MATCH ?'
        q_params = [match_expr] + params
        if where:
            sql += ' AND ' + ' AND '.join(where)
    else:
        sql = f'SELECT {cols} FROM items i'
        q_params = params
        if where:
            sql += ' WHERE ' + ' AND '.join(where)

    try:
        con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
        try:
            cur = con.execute(sql, q_params)
            rows = []
            for r in cur:
                obj = {
                    'brand': r[0], 'sub': r[1], 'file': r[2], 'dir': r[3],
                    'dur': r[4], 'sr': r[5], 'bits': r[6], 'ch': r[7],
                    'desc': r[8], 'cat': r[9], 'subcat': r[10],
                    'norm_cat': r[14], 'role': r[15], 'vgroup': r[16], 'id': r[17],
                }
                if r[11]:
                    obj['defect'] = r[11]
                if r[12]:
                    obj['source_residue'] = r[12]
                if r[13]:
                    obj['gid'] = r[13]
                rows.append(obj)
            return rows
        finally:
            con.close()
    except sqlite3.Error:
        return None


def search(query=None, *, brand=None, sub=None, cat=None, subcat=None,
           role=None, norm_cat=None, dur_min=None, dur_max=None,
           include_defective=False, group_variants=False, limit=20,
           index=None, index_path=None, cache_dir=None, use_fts=True) -> list:
    """检索商用库索引，返回按得分排序的候选（每项含 id/path/role/norm_cat/vgroup/score/rights）。"""
    terms = _query_terms(query or '')
    phrase = (query or '').strip().lower()
    phrase = phrase if phrase and ' ' in phrase and not CJK_RE.search(phrase) else None
    q_brand = (brand or '').strip().lower() or None
    q_sub = (sub or '').strip().lower() or None
    q_cat = (cat or '').strip().lower() or None
    q_subcat = (subcat or '').strip().lower() or None
    q_role = (role or '').strip().lower() or None
    q_norm_cat = (norm_cat or '').strip().lower() or None

    candidates = None
    if index is None and use_fts:
        idx_p = Path(index_path) if index_path is not None else INDEX_PATH
        if idx_p.exists():
            db_path = _ensure_fts(idx_p, cache_dir=cache_dir)
            if db_path is not None:
                candidates = _fts_candidates(
                    db_path, terms,
                    brand=q_brand, sub=q_sub, cat=q_cat, subcat=q_subcat,
                    role=q_role, norm_cat=q_norm_cat,
                    dur_min=dur_min, dur_max=dur_max,
                    include_defective=include_defective,
                )

    rows = candidates if candidates is not None else (
        load_index(index_path) if index is None else index
    )

    hits = []
    for row in rows:
        if candidates is None:
            if row.get('defect') and not include_defective:
                continue
            if q_brand and row['brand'].lower() != q_brand:
                continue
            if q_sub and not row['sub'].lower().startswith(q_sub):
                continue
            if q_cat and q_cat not in row['cat'].lower():
                continue
            if q_subcat and q_subcat not in row['subcat'].lower():
                continue
            if dur_min is not None and row['dur'] < float(dur_min):
                continue
            if dur_max is not None and row['dur'] > float(dur_max):
                continue
            if q_norm_cat or q_role:
                nc = row.get('norm_cat') or normalize_category(row)
                if q_norm_cat and nc != q_norm_cat:
                    continue
                if q_role and (row.get('role') or classify_role(row, nc)) != q_role:
                    continue
        if not terms and not phrase:
            hits.append(_hit(row, 0))
            continue
        score = _score_row(row, terms, phrase)
        if score > 0:
            hits.append(_hit(row, score))

    hits.sort(key=lambda h: (-h['score'], h['dur'], h['path']))
    if group_variants:
        hits = _collapse_variants(hits)
    return hits[:max(1, int(limit))]


def _validate_rel_path(rel_path: str) -> str:
    p = str(rel_path or '').replace('\\', '/').strip()
    if not p or '\x00' in p or p.startswith('/') or re.match(r'^[A-Za-z]:', p):
        raise SfxFetchError(f'非法音效路径：{rel_path!r}（仅允许库内相对路径）')
    parts = [seg for seg in p.split('/') if seg]
    if any(seg in ('.', '..') for seg in parts):
        raise SfxFetchError(f'非法音效路径（禁止路径穿越）：{rel_path!r}')
    return '/'.join(parts)


def _find_entry(id_or_path: str, *, index=None, index_path=None) -> dict | None:
    key = str(id_or_path or '').strip()
    if not key:
        return None
    norm = key.replace('\\', '/').lstrip('/')
    rows = load_index(index_path) if index is None else index
    for row in rows:
        p = _rel_path(row)
        if p == norm or stable_id(p) == key:
            return enrich_row(row)
    return None


def info(id_or_path: str, *, index=None, index_path=None, cache_dir=None) -> dict | None:
    """按短 ID 或相对路径查单条完整元数据 + 同组变体列表 + 本地可用状态。"""
    rows = load_index(index_path) if index is None else index
    entry = _find_entry(id_or_path, index=rows)
    if entry is None:
        return None
    vg = entry['vgroup']
    variants = []
    for r in rows:
        p = _rel_path(r)
        if variant_group(p) == vg:
            variants.append({
                'id': stable_id(p),
                'file': r['file'],
                'path': p,
                'dur': r['dur'],
                'defect': r.get('defect'),
            })
    variants.sort(key=lambda v: v['path'])
    cbase = Path(cache_dir).expanduser() if cache_dir is not None else default_cache_dir()
    cpath = cbase / 'raw' / entry['path']
    lpath = abs_path(entry['path'])
    entry['variants'] = variants
    entry['cached'] = cpath.is_file() and cpath.stat().st_size > 0
    entry['cached_path'] = str(cpath) if entry['cached'] else None
    entry['local_path'] = lpath if (lpath and os.path.isfile(lpath)) else None
    return entry


def _default_gdrive_download(entry: dict, dest_path: str, *, remote: str | None = None) -> None:
    """默认按需下载器：优先 rclone（remote/gid），次选 gdown，再次直链下载。"""
    rel = entry['path']
    gid = entry.get('gid') or ''
    rem = remote or os.environ.get(ENV_REMOTE) or ''
    if not rem and MANIFEST_PATH.exists():
        try:
            rem = load_manifest().get('source', {}).get('rclone_remote') or ''
        except (OSError, ValueError):
            rem = ''

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    tmp_dest = dest_path + f'.part.{os.getpid()}'

    try:
        rclone_bin = shutil.which('rclone')
        if rem and rclone_bin:
            if ':' not in rem:
                src = f'{rem}:{rel}'
            elif rem.endswith(':'):
                src = f'{rem}{rel}'
            else:
                src = f"{rem.rstrip('/')}/{rel}"
            r = subprocess.run([rclone_bin, 'copyto', src, tmp_dest], capture_output=True, text=True)
            if r.returncode == 0 and os.path.isfile(tmp_dest) and os.path.getsize(tmp_dest) > 0:
                os.replace(tmp_dest, dest_path)
                return
            raise SfxFetchError(f'rclone 下载失败（exit {r.returncode}）：{(r.stderr or r.stdout).strip()[:240]}')

        if gid:
            gdown_bin = shutil.which('gdown')
            if gdown_bin:
                r = subprocess.run([gdown_bin, '--id', gid, '-O', tmp_dest], capture_output=True, text=True)
                if r.returncode == 0 and os.path.isfile(tmp_dest) and os.path.getsize(tmp_dest) > 0:
                    os.replace(tmp_dest, dest_path)
                    return
                raise SfxFetchError(f'gdown 下载失败（exit {r.returncode}）：{(r.stderr or r.stdout).strip()[:240]}')

            # 纯标准库直链兜底（适用于公开/已授权直链小文件；遇到网络错误或 HTML 拦截页时明确报错）
            url = f'https://drive.google.com/uc?export=download&id={gid}'
            req = urllib.request.Request(url, headers={'User-Agent': 'beiming-sfx/1'})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp, open(tmp_dest, 'wb') as out:
                    head = resp.read(512)
                    if head.lstrip().startswith((b'<!DOCTYPE html', b'<html', b'<HTML')):
                        raise SfxFetchError(
                            f'Google Drive 返回了网页确认/鉴权页（gid={gid}），无法直链下载；'
                            '请安装 rclone 并配置 BEIMING_SFX_REMOTE，或安装 gdown。'
                        )
                    out.write(head)
                    shutil.copyfileobj(resp, out)
            except (urllib.error.URLError, OSError) as e:
                raise SfxFetchError(
                    f'Google Drive 直链下载失败（gid={gid}）：{e}；请检查网络/代理或改用 rclone + BEIMING_SFX_REMOTE。'
                ) from None
            if os.path.isfile(tmp_dest) and os.path.getsize(tmp_dest) > 0:
                os.replace(tmp_dest, dest_path)
                return

        raise SfxFetchError(
            f'无法拉取音效 {rel}：未配置 {ENV_REMOTE}（rclone remote）且该条索引尚未回填 gid。'
            '请先完成 Step 2 上传并运行 backfill-gids，或设置 BEIMING_SFX_REMOTE / BEIMING_SFX_ROOT。'
        )
    finally:
        if os.path.exists(tmp_dest):
            try:
                os.remove(tmp_dest)
            except OSError:
                pass


_SHORT_ID_RE = re.compile(r'^sfx_[0-9a-f]{10}$')


def resolve(id_or_path: str, *, fetch: bool = False, index=None, index_path=None,
            cache_dir=None, remote: str | None = None, downloader=None) -> str | None:
    """解析音效本机路径：优先本机缓存 → 可选 BEIMING_SFX_ROOT → 可选按需拉取到缓存。"""
    entry = _find_entry(id_or_path, index=index, index_path=index_path)
    if entry is not None:
        rel = _validate_rel_path(entry['path'])
    else:
        if _SHORT_ID_RE.match(str(id_or_path or '').strip()):
            raise SfxFetchError(f'索引中找不到短 ID：{id_or_path!r}（请用 search 确认 ID）')
        rel = _validate_rel_path(id_or_path)
        entry = {'id': stable_id(rel), 'path': rel}

    cbase = Path(cache_dir).expanduser() if cache_dir is not None else default_cache_dir()
    cpath = (cbase / 'raw' / rel).resolve()
    raw_root = (cbase / 'raw').resolve()
    try:
        cpath.relative_to(raw_root)
    except ValueError:
        raise SfxFetchError(f'缓存目标越界：{rel}') from None

    if cpath.is_file() and cpath.stat().st_size > 0:
        return str(cpath)

    lpath = abs_path(rel)
    if lpath and os.path.isfile(lpath) and os.path.getsize(lpath) > 0:
        return lpath

    if not fetch:
        return None

    cpath.parent.mkdir(parents=True, exist_ok=True)
    if downloader is not None:
        downloader(entry, str(cpath))
        if not (cpath.is_file() and cpath.stat().st_size > 0):
            raise SfxFetchError(f'downloader 未产出有效文件：{cpath}')
        return str(cpath)

    _default_gdrive_download(entry, str(cpath), remote=remote)
    return str(cpath)


def fetch(id_or_path: str, *, index=None, index_path=None, cache_dir=None,
          remote: str | None = None, downloader=None) -> str:
    """确保单条音效已落在本机缓存（或本地挂载可用）并返回路径；失败抛 SfxFetchError。"""
    p = resolve(
        id_or_path, fetch=True, index=index, index_path=index_path,
        cache_dir=cache_dir, remote=remote, downloader=downloader,
    )
    if not p:
        raise SfxFetchError(f'无法获取音效：{id_or_path}')
    return p


# ———— 确定性音频加载与混音工具（48 kHz float64 立体声） ————
def _decode_via_ffmpeg(path: str, target_sr: int):
    import numpy as np

    ff = shutil.which('ffmpeg')
    if not ff:
        raise SfxFetchError(f'soundfile 无法解码 {path}，且系统未找到 ffmpeg 兜底')
    r = subprocess.run(
        [ff, '-v', 'error', '-i', path, '-f', 'f64le', '-acodec', 'pcm_f64le', '-ar', str(target_sr), '-ac', '2', 'pipe:1'],
        capture_output=True,
    )
    if r.returncode != 0 or not r.stdout:
        raise SfxFetchError(f'ffmpeg 解码失败（{path}）：{r.stderr.decode("utf-8", "replace")[:200]}')
    data = np.frombuffer(r.stdout, dtype=np.float64)
    return data.reshape(-1, 2).copy(), target_sr


def _to_stereo(x):
    import numpy as np

    if x.ndim == 1:
        return np.repeat(x[:, None], 2, axis=1)
    ch = x.shape[1]
    if ch == 1:
        return np.repeat(x, 2, axis=1)
    if ch == 2:
        return x
    # 多声道（如 5.1 / 6ch）：安全缩混为立体声并防止削波
    left = x[:, 0] + (0.7071 * x[:, 2] if ch > 2 else 0.0) + (0.5 * x[:, 4] if ch > 4 else 0.0)
    right = x[:, 1] + (0.7071 * x[:, 2] if ch > 2 else 0.0) + (0.5 * x[:, 5] if ch > 5 else 0.0)
    st = np.stack([left, right], axis=1)
    peak = float(np.abs(st).max())
    if peak > 1.0:
        st = st / peak
    return st


def load_audio(id_or_path: str, *, fetch: bool = False, sr: int = 48000,
               in_s: float = 0.0, out_s: float | None = None,
               pitch_st: float = 0.0, fade_ms: float = 5.0,
               index=None, index_path=None, cache_dir=None,
               remote: str | None = None, downloader=None):
    """加载音效为 48 kHz float64 立体声 (N, 2)；支持 AIFF 兜底、多声道缩混、降调保高频与微淡入淡出。"""
    import numpy as np
    import soundfile as sf
    import soxr

    local_path = resolve(
        id_or_path, fetch=fetch, index=index, index_path=index_path,
        cache_dir=cache_dir, remote=remote, downloader=downloader,
    )
    if not local_path:
        raise FileNotFoundError(f'本地未找到音效 {id_or_path}（可传 fetch=True 按需拉取，或设 {ENV_ROOT}）')

    try:
        x, rate = sf.read(local_path, dtype='float64', always_2d=True)
    except Exception:
        x, rate = _decode_via_ffmpeg(local_path, sr)

    if len(x) == 0:
        raise ValueError(f'空音频文件：{local_path}')
    x = _to_stereo(x)

    # 先按原采样率切片，减少不必要的全文件重采样
    start_i = max(0, int(round(max(0.0, float(in_s)) * rate)))
    end_i = len(x) if out_s is None else min(len(x), int(round(float(out_s) * rate)))
    if end_i <= start_i:
        raise ValueError(f'无效裁剪区间 [{in_s}, {out_s}]（总长 {len(x) / rate:.3f}s）')
    x = x[start_i:end_i]

    # 移调与重采样：大幅降调（pitch_st < -3）先在原采样率变速以保留高频余量
    ratio = 2.0 ** (float(pitch_st) / 12.0)
    effective_in_sr = rate * ratio
    if abs(effective_in_sr - sr) > 1e-3:
        x = soxr.resample(x, effective_in_sr, sr, quality='HQ')
    x = np.asarray(x, dtype=np.float64)

    # 边缘微淡入淡出防咔嗒
    fn = int(round(max(0.0, float(fade_ms)) * 0.001 * sr))
    if fn > 1 and len(x) >= 2 * fn:
        ramp = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, fn)))
        x = x.copy()
        x[:fn] *= ramp[:, None]
        x[-fn:] *= ramp[::-1, None]
    return x


def one_shot(pool: list, seed: int = 0, *, pitch_jitter: float = 0.4,
             gain_jitter_db: float = 1.2, sr: int = 48000, **load_kwargs):
    """从同类变体池里按 seed 确定性挑一条并加轻微音高/电平抖动，避免机枪效应。"""
    import numpy as np

    if not pool:
        raise ValueError('one_shot: pool 不能为空')
    rng = np.random.default_rng(int(seed))
    chosen = pool[int(rng.integers(0, len(pool)))]
    pitch = float(rng.uniform(-abs(pitch_jitter), abs(pitch_jitter))) if pitch_jitter else 0.0
    gain_db = float(rng.uniform(-abs(gain_jitter_db), abs(gain_jitter_db))) if gain_jitter_db else 0.0
    x = load_audio(chosen, sr=sr, pitch_st=pitch, **load_kwargs)
    if gain_db != 0.0:
        x = x * (10.0 ** (gain_db / 20.0))
    return x


def bed(id_or_path: str, dur: float, seed: int = 0, *, xfade: float = 1.5,
        sr: int = 48000, **load_kwargs):
    """生成精确时长 dur 秒的环境底：够长时按 seed 确定性选起点截取；不够长时等功率交叉淡化循环。"""
    import numpy as np

    target_n = int(round(float(dur) * sr))
    if target_n <= 0:
        raise ValueError(f'bed: dur 必须为正数（收到 {dur}）')
    x = load_audio(id_or_path, sr=sr, fade_ms=0.0, **load_kwargs)
    rng = np.random.default_rng(int(seed))

    if len(x) >= target_n:
        max_off = len(x) - target_n
        off = int(rng.integers(0, max_off + 1)) if max_off > 0 else 0
        out = x[off:off + target_n].copy()
    else:
        xf = min(int(round(max(0.01, float(xfade)) * sr)), len(x) // 3)
        step = max(1, len(x) - xf)
        out = np.zeros((target_n, 2), dtype=np.float64)
        fade_in = np.sin(np.linspace(0.0, np.pi / 2.0, xf))[:, None] if xf > 0 else None
        fade_out = np.cos(np.linspace(0.0, np.pi / 2.0, xf))[:, None] if xf > 0 else None
        pos = 0
        first = True
        while pos < target_n:
            chunk = x.copy()
            if not first and xf > 0:
                chunk[:xf] *= fade_in
            end = min(target_n, pos + len(chunk))
            n_write = end - pos
            if not first and xf > 0:
                ov = min(xf, n_write)
                out[pos:pos + ov] *= fade_out[:ov]
            out[pos:end] += chunk[:n_write]
            pos += step
            first = False

    fn = min(int(round(0.01 * sr)), target_n // 4)
    if fn > 1:
        ramp = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, fn)))
        out[:fn] *= ramp[:, None]
        out[-fn:] *= ramp[::-1, None]
    return out
