# -*- coding: utf-8 -*-
"""北冥引擎 · 商用音效库索引与检索（rog-5090 `/mnt/data1/共享盘/音效库/`，63 G 已购库）。

库本体永不入仓：仓库只存 `engine/audio/sfx_library_index.jsonl`（由 `tools/sfx_library.py index` 从
库根的《音效库总目录.csv》生成的纯元数据索引，UTF-8 BOM 已剥掉），检索离线可跑（CI 无库也绿）。
音频文件路径相对库根，用环境变量 `BEIMING_SFX_ROOT` 指向本机挂载点（sshfs / NFS 两可）；
未设时 `abs_path()` 返回 None，调用方照旧走程序化合成，与 `library.use()` 未启用时的降级一致。
《音效库瑕疵清单.txt》里的文件（AIFF 已改名 .aif 的 145 个）在索引中带 defect 标记，检索默认排除；
已删除的 0 字节空文件不在总目录 CSV 里，自然不在索引中。

接口：
  build_index(csv_path, defects_path=None)      解析总目录 CSV（utf-8-sig）与瑕疵清单 → (行列表, 统计)
  write_index(rows, out_path)                   写 JSONL 索引（每行一个音频文件的元数据）
  load_index(path=None)                         读索引（默认仓库内置索引，进程内缓存）
  available()                                   仓库内置索引是否存在（检索层离线可用性）
  root() / abs_path(rel_path)                   BEIMING_SFX_ROOT 库根与绝对路径（未设返回 None）
  search(query, ...)                            中英关键词（中文经 sfx_vocab 的 UCS 词表翻译成英文检索词）
                                               + 子库/分类/时长过滤 → 候选列表（含相对路径与得分）
许可证核验与使用边界（各子库授权状态为 owner-confirmed、来源注记与待补书面项）见 docs/rights/sfx-library.md。
"""
import json
import math
import os
import re
from functools import lru_cache
from pathlib import Path

from .sfx_vocab import CJK_RE, search_ucs, tokenize_query

INDEX_PATH = Path(__file__).resolve().parent / 'sfx_library_index.jsonl'
ENV_ROOT = 'BEIMING_SFX_ROOT'

# 瑕疵清单的小节标题 → 缺陷标记；标题匹配用关键词（清单是小体量人工文档，见 docs/rights/sfx-library.md）
_DEFECT_KINDS = (
    (('FORM', 'AIFF'), 'aiff_renamed_from_wav'),
    (('0 字节', '空文件'), 'zero_byte_deleted'),
)
# 授权状态（机器字段）：全部子库统一 owner-confirmed——主人 2026-11-24 确认持有授权（item 37；
# Portals / Inner Circle 另确认「在正版购买范围内，用过正版下载替换/确认来源」）。
RIGHTS_STATUS = 'owner-confirmed'
# 来源注记（不是授权状态，不阻塞使用，不排除检索）：这些子库的盘内有第三方渠道残留文件，
# 建议以官方原盘替换拷贝。清单为 2026-11-24 的观察记录，依据见 docs/rights/sfx-library.md 第三节。
SOURCE_RESIDUE = {
    'SoundMorph - Future Weapons 1': ['Ammunitions/About.zip（内含 About.txt：LookAE 声明、LookAE.com / FCPX 资源站 / Audio Jungle 合集 .url）', '重打包站 GBK 乱码目录「更多免费资源下载」'],
    'SoundMorph - Future Weapons 2': ['Source Recordings/About.zip、Designed/Explosions/About.zip（内容同上）', '重打包站 GBK 乱码目录「更多免费资源下载」'],
    'SoundMorph.Portals': ['下载.url（指向 lookae.com，独立复核发现；04:19 复查已不在盘上）'],
    'SoundMorph.Inner.Circle.Transient.Foundations': ['TM DISCOVER.nfo（独立复核发现；04:19 复查已不在盘上）'],
}
RESIDUE_TAG = 'third-party-files'

_REQUIRED_COLS = ('品牌', '子库', '文件名', '所在目录', '时长(秒)', '采样率', '位深', '声道', '描述/关键词', '分类', '子分类')


class IndexBuildError(ValueError):
    """总目录 CSV 缺列或某行数值坏了：消息带行号，调用方（CLI）转成契约错误。"""


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
    return (r.get(col) or '').strip()  # 短行缺的列 DictReader 给 None


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


def build_index(csv_path, defects_path=None) -> tuple:
    """读总目录 CSV（UTF-8 BOM）生成索引行；给瑕疵清单时打缺陷标记（文件名按 CSV 原样保留，
    清单的 .wav 路径与 CSV 修复后 .aif 的行两种写法都能对上）。"""
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
                # 总目录 CSV 是在瑕疵修复之后导出的：改名后的行已是 .aif，清单里记的还是 .wav
                defect = defects.get(re.sub(r'\.aif$', '.wav', rel, flags=re.I))
            if defect == 'aiff_renamed_from_wav':  # 主人 2026-11-24 确认已改名：内容完好，标记留痕
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
    """写 JSONL 索引；返回字节数。音频本体不入仓，这里只有元数据与相对路径。

    首行是目录字典 {"dirs": [...]}（所在目录高度重复，字典化把索引压到 5 MiB 大文件红线以下），
    其余每行一个音频文件，"d" 是目录下标；load_index 会还原成 "dir"。"""
    dirs, d_idx = [], {}
    for row in rows:
        d = row.get('dir', '')
        if d not in d_idx:
            d_idx[d] = len(dirs)
            dirs.append(d)
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps({'dirs': dirs}, ensure_ascii=False, separators=(',', ':')) + '\n')
        for row in rows:
            packed = {'d': d_idx[row.get('dir', '')]}
            packed.update({k: v for k, v in row.items() if k != 'dir'})
            f.write(json.dumps(packed, ensure_ascii=False, separators=(',', ':')) + '\n')
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
    return _load(str(p.resolve()))


def available() -> bool:
    return INDEX_PATH.exists()


def root():
    """库根目录（BEIMING_SFX_ROOT 指向本机挂载点，如 sshfs 挂的 /mnt/rog5090/音效库）。"""
    return os.environ.get(ENV_ROOT) or None


def abs_path(rel_path) -> str | None:
    r = root()
    return os.path.join(r, rel_path) if r else None


def _query_terms(query: str) -> list:
    """检索词展开：英文词原样；中文经 UCS 词表（sfx_vocab.search_ucs）翻成英文类别名与同义词。

    UCS 的中文同义词是词级的（「怪兽」「电流」能查到，「怪兽吼叫」查不到），
    所以整句查不到时退到二字滑动词、再退到单字，凑够英文检索词就停。"""
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


def _hit(row, score):
    h = {**row, 'path': f"{row['dir']}/{row['file']}", 'score': score, 'rights': RIGHTS_STATUS}
    if row.get('source_residue'):
        h['residue_files'] = SOURCE_RESIDUE.get(row['sub'], [])
    return h


def search(query=None, *, brand=None, sub=None, cat=None, subcat=None,
           dur_min=None, dur_max=None, include_defective=False, limit=20,
           index=None) -> list:
    """检索商用库索引，返回按得分排序的候选（每项含相对路径 path、得分 score 与元数据）。

    query   中英关键词；中文自动经 UCS 词表翻成英文检索词（库内描述是英文）
    brand   品牌精确匹配（如 'BOOM Library'）；sub 子库前缀匹配（如 'SoundMorph.Mechanism'）
    cat/subcat  分类/子分类子串匹配；dur_min/dur_max  时长范围（秒）
    include_defective  连瑕疵清单里的坏文件一起返回（默认排除）
    """
    rows = load_index() if index is None else index
    terms = _query_terms(query or '')
    phrase = (query or '').strip().lower()
    phrase = phrase if phrase and ' ' in phrase and not CJK_RE.search(phrase) else None
    q_brand = (brand or '').strip().lower() or None
    q_sub = (sub or '').strip().lower() or None
    q_cat = (cat or '').strip().lower() or None
    q_subcat = (subcat or '').strip().lower() or None

    hits = []
    for row in rows:
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
        if not terms and not phrase:
            hits.append(_hit(row, 0))
            continue
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
        if score > 0:
            hits.append(_hit(row, round(score, 1)))
    hits.sort(key=lambda h: (-h['score'], h['dur'], h['path']))
    return hits[:max(1, int(limit))]
