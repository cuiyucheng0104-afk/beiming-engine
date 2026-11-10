#!/usr/bin/env python3
"""北冥案例库工具：查看、核对与还原去重后的历史案例归档（cases/），从不执行构建、安装或渲染。

用法与命令约定见 docs/cases/casebook.md（退出码、--json 信封同 docs/CLI.md）。命令：
  list                     列出案例（--group 只列一组）
  check                    核对目录、源文件、素材引用、案例卡与 vendor 快照，收集全部问题后再退出
  restore <案例编号>        还原到独立目录（默认 out/casebook/）；默认不还原内部素材（--include-internal）
  rehash --patch <补丁>     按补丁更新源文件的 sha256 与大小（例如去掉签名链接的查询串之后）
  rights [--write|--check]  按 docs/rights/register.json 算出每个案例的权利字段并写回或核对
  index [--check]          由 catalog 生成案例卡、INDEX.md、画廊数据与 NOTICES 署名段
"""
import argparse
import difflib
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent / 'lib'))
from cli import ArgumentParser, CliError, run  # noqa: E402  命令约定库（docs/CLI.md）

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'cases'
PACK_ORIGIN = 'https://github.com/cuiyucheng0104-afk/beiming-engine/releases/download/'
CHUNK = 1 << 20
VERIFIED = '.casebook-verified.json'        # pack folder: (size, mtime) of packs already hashed
TOKEN_RE = re.compile(r'@@[A-Za-z0-9_]+@@')
KNOWN_TOKENS = {'@@CASE_ROOT@@', '@@WORKSPACE_ROOT@@', '@@LEMO_ROOT@@', '@@ROG_HOST@@'}
# Restored paths are pasted into shell, JSON, Python and JS source verbatim. Only accept characters that
# are inert in all of them (\w covers letters, digits and CJK); anything else is refused up front.
SAFE_VALUE = re.compile(r'[\w/.:+,=@~-]+')
SAFE_HOST = re.compile(r'[A-Za-z0-9._:-]+')
CRLF_HINT = ('这些文件只差换行：Git 检出时把 LF 改成了 CRLF（Git for Windows 默认 core.autocrlf=true）。'
             '在仓库根目录执行 git config core.autocrlf false，提交或备份未提交的改动后，'
             '再执行 git rm --cached -r -q . 和 git reset --hard 重新检出（这两步会丢弃未提交的改动）；'
             '新克隆可先设置 git config --global core.autocrlf false。')
# Operating-system clutter and per-checkout installs that never belong to a vendored snapshot.
JUNK_FILES = {'.DS_Store', 'Thumbs.db', 'desktop.ini'}
LOCAL_DIRS = {'node_modules', '.venv', '__pycache__', '.git'}
CLEARANCES = ('public', 'internal', 'client-confidential')   # 权利字段 clearance 的取值（docs/cases/casebook.md）
TECH_STATUSES = ('rendered', 'experiment', 'previs', 'interactive', 'support')   # technical.status
QA_STATUSES = ('not-run', 'pass', 'fail')                                        # technical.qa.status
APPROVAL_STATUSES = ('approved', 'rejected', 'unreviewed')                       # approval.status
LEGACY_STATUS = {'rendered': 'historical-render', 'experiment': 'experiment', 'previs': 'previs',
                 'interactive': 'interactive', 'support': 'support'}            # status 是作品站读的兼容字段
PENDING = '待补'                                         # 不知道就写「待补」，不推断、不编造（docs/rights/README.md）
PENDING_REASON = '原因未记录，待用户补充'
REGISTER = ROOT / 'docs' / 'rights' / 'register.json'    # P01 的授权登记册：rights 字段由它算出
ARCHIVE_LICENSE = 'LicenseRef-Casebook-Archive'          # cases/source/** 的许可（REUSE.toml、LICENSES/）
INTERNAL_KINDS = frozenset({'third-party-ip', 'client-material', 'reference-images', 'trademark'})
RESERVED_NAMES = ('ARCHIVE-RESTORED.json', 'RIGHTS.json')       # restore 写进还原目录的文件
RESERVED_DIR = 'ARCHIVE-LICENSES'                                 # restore 复制许可文本的目录
FONT_FILE = re.compile(r'\.(?:woff2?|ttf|otf|ttc)$', re.I)
THREE_FILE = re.compile(r'(?:^|/)three(?:\.module)?(?:\.min)?\.(?:m?js)$', re.I)
RETRY_HTTP = {408, 425, 429, 500, 502, 503, 504}             # 值得重试的 HTTP 状态
DISK_MARGIN = 256 << 20                                     # 下载与还原前另留的磁盘余量


# --- errors -----------------------------------------------------------------------------------------------
# Library functions raise these (all ValueError subclasses, so callers that catch ValueError keep working);
# the command line maps each to a CliError whose code prefix decides the exit status (docs/CLI.md 第 1、4 节).

class CasebookError(ValueError):
    code = 'contract.invalid'

    def __init__(self, message, hint=None):
        super().__init__(message)
        self.hint = hint


class ChecksumError(CasebookError):
    code = 'contract.checksum'


class UnsafeValueError(CasebookError):
    code = 'usage.unsafe-path'


class DiskSpaceError(CasebookError):
    code = 'env.disk-space'


class UnresolvedTokensError(CasebookError):
    code = 'env.unresolved-tokens'


class CheckFailed(CasebookError):
    """check found problems; `problems` lists every one of them (check collects all before failing)."""
    code = 'contract.check-failed'

    def __init__(self, problems):
        self.problems = list(problems)
        super().__init__(f'{len(self.problems)} 处问题：{listing(self.problems, 40, sort=False)}')


class DownloadInterrupted(ConnectionError):
    """The transfer stopped before the whole pack arrived. <name>.partial is kept; the next run resumes it."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    """SHA-256 of a file read in chunks, so multi-hundred-MB packs never sit in memory. Returns (size, hex)."""
    h, size = hashlib.sha256(), 0
    with open(path, 'rb') as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
            size += len(chunk)
    return size, h.hexdigest()


def safe_path(root, name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:
        raise ValueError(f'Unsafe archive path: {name}')
    result = root.joinpath(*p.parts)
    if not result.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Archive path escapes destination: {name}')
    return result


def read_manifest():
    return json.loads((ARCHIVE / 'catalog.json').read_text(encoding='utf-8'))


def listing(paths, limit=20, sort=True):
    paths = sorted(paths) if sort else list(paths)
    lines = ''.join(f'\n  - {p}' for p in paths[:limit])
    return lines + (f'\n  …另有 {len(paths) - limit} 项' if len(paths) > limit else '')


def fmt_bytes(n):
    for unit, size in (('GB', 1e9), ('MB', 1e6), ('KB', 1e3)):
        if n >= size:
            return f'{n / size:.2f} {unit}'
    return f'{n} B'


def shown_path(p):
    """Repository-relative POSIX path when `p` is inside the repository, else the absolute POSIX path."""
    p = Path(p).resolve()
    try:
        return p.relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return p.as_posix()


def verify_bytes(data, item, label=None):
    if len(data) != item['size'] or digest(data) != item['sha256']:
        raise ChecksumError(f'Checksum mismatch: {label or item.get("path", item.get("filename", "blob"))}')


def archived_bytes(data, item):
    """The archived bytes behind `data`: unchanged, or with Git's checkout-time LF->CRLF conversion undone
    when that alone restores the recorded checksum. None when neither matches."""
    if len(data) == item['size'] and digest(data) == item['sha256']:
        return data
    if b'\r\n' in data:
        fixed = data.replace(b'\r\n', b'\n')
        if len(fixed) == item['size'] and digest(fixed) == item['sha256']:
            return fixed
    return None


def asset_meta(manifest, case, item):
    """The asset record behind a file entry; a broken reference names the case and path instead of a KeyError."""
    label = f'{case["id"]}/{item.get("path")}'
    if 'asset' not in item:
        raise ValueError(f'File entry has neither source nor asset: {label}')
    meta = manifest['assets'].get(item['asset'])
    if meta is None:
        raise ValueError(f'Unknown asset {item["asset"]} referenced by {label}')
    return meta


def groups_of(manifest):
    return sorted({c['group'] for c in manifest['cases']})


def case_clearance(case):
    """Case-level clearance (rights.clearance); 'public' when the catalog records none."""
    return (case.get('rights') or {}).get('clearance') or 'public'


def file_clearance(case, item):
    """A file is internal when its case is, or when the file entry itself is marked (docs/cases/casebook.md)."""
    whole = case_clearance(case)
    return whole if whole != 'public' else (item.get('clearance') or 'public')


# --- .gitignore -----------------------------------------------------------------------------------------

def compile_ignore(line):
    """One .gitignore line -> (regex, negated, directory_only), or None. Implements the documented
    gitignore pattern rules: anchoring, trailing-slash directories, *, ?, [...], **/ and /**."""
    if not line.strip() or line.startswith('#'):
        return None
    line = line.rstrip()
    negate = line.startswith('!')
    if negate:
        line = line[1:]
    elif line.startswith(('\\!', '\\#')):
        line = line[1:]
    dir_only = line.endswith('/')
    line = line.rstrip('/')
    if not line:
        return None
    anchored = '/' in line
    line = line.lstrip('/')
    out, i = [], 0
    while i < len(line):
        if line.startswith('**/', i) and (i == 0 or line[i - 1] == '/'):
            out.append('(?:.*/)?')
            i += 3
        elif line.startswith('/**', i) and i + 3 == len(line):
            out.append('/.*')
            i += 3
        elif line[i] == '*':
            while i < len(line) and line[i] == '*':
                i += 1
            out.append('[^/]*')
        elif line[i] == '?':
            out.append('[^/]')
            i += 1
        elif line[i] == '[' and (j := line.find(']', i + 2)) != -1:
            body = line[i + 1:j]
            body = '^' + body[1:] if body.startswith('!') else body
            out.append('[' + body.replace('\\', '\\\\') + ']')
            i = j + 1
        elif line[i] == '\\' and i + 1 < len(line):
            out.append(re.escape(line[i + 1]))
            i += 2
        else:
            out.append(re.escape(line[i]))
            i += 1
    pattern = ''.join(out)
    return re.compile(pattern if anchored else '(?:.*/)?' + pattern, re.S), negate, dir_only


class GitIgnore:
    """Answers "would git ignore this path?" for files below `top`, reading every .gitignore on the way."""

    def __init__(self, top):
        self.top = top
        self.rules = {}

    def _rules(self, folder):
        if folder not in self.rules:
            f = folder / '.gitignore'
            lines = f.read_text(encoding='utf-8', errors='replace').splitlines() if f.is_file() else []
            self.rules[folder] = [r for r in map(compile_ignore, lines) if r]
        return self.rules[folder]

    def _match(self, parts, is_dir):
        ignored = False
        for depth in range(len(parts)):     # outer .gitignore first; deeper files and later lines win
            sub = '/'.join(parts[depth:])
            for rx, negate, dir_only in self._rules(self.top.joinpath(*parts[:depth])):
                if (is_dir or not dir_only) and rx.fullmatch(sub):
                    ignored = not negate
        return ignored

    def ignored(self, path, is_dir=False):
        parts = path.relative_to(self.top).parts
        # git cannot re-include a file whose parent directory is excluded
        return any(self._match(parts[:i], True) for i in range(1, len(parts))) or self._match(parts, is_dir)


# --- paths written relative to the original home folder ---------------------------------------------------

SHELL_EXT = {'.sh', '.bash', '.zsh', '.command'}
PYTHON_EXT = {'.py'}
JS_EXT = {'.js', '.mjs', '.cjs', '.ts'}
WORD_END = r"""[^\s'"`;|&<>()$\\]*"""
PY_EXPANDUSER = re.compile(r"""(?P<head>expanduser\(\s*)(?P<q>['"])~(?P<rest>/[^'"\n]*)(?P=q)""")
PY_HOME = re.compile(r"""Path\.home\(\)(?P<segs>(?:\s*/\s*(['"])[^'"\n]*\2)+)""")
PY_SEGMENT = re.compile(r"""\s*/\s*(['"])([^'"\n]*)\1""")
SH_HOME = re.compile(r"""\$(?:HOME\b|\{HOME\})(?P<rest>/""" + WORD_END + ')')
SH_TILDE = re.compile(r"""(?:^|(?<=[\s=:;|&(]))~(?P<rest>/""" + WORD_END + ')', re.M)
JS_HOME_CONCAT = re.compile(r"""process\.env\.HOME\s*\+\s*(?P<q>['"])(?P<rest>/[^'"\n]*)(?P=q)""")
JS_HOME_TEMPLATE = re.compile(r"""\$\{\s*process\.env\.HOME\s*\}(?P<rest>/[^`$\n]*)""")
RESIDUAL = {
    'python': [r"""expanduser\(\s*[rRbBuUfF]*['"]~""", r'\bPath\.home\(\)', r'\.expanduser\(\)',
               r"""\bos\.environ\s*\[\s*['"](?:HOME|USERPROFILE)['"]""",
               r"""\b(?:getenv|environ\.get)\(\s*['"](?:HOME|USERPROFILE)['"]"""],
    'shell': [r'\$\{?HOME\b', r'(?:^|(?<=[\s=:;|&(]))~(?=[/\s;|&)]|$)', r'\$\{?USERPROFILE\b'],
    'js': [r'\bhomedir\(\)', r'\bprocess\.env\.(?:HOME|USERPROFILE)\b',
           r"""\bprocess\.env\[\s*['"](?:HOME|USERPROFILE)['"]"""],
}
RESIDUAL = {k: re.compile('|'.join(v), re.M) for k, v in RESIDUAL.items()}
ABSOLUTE_HOME = re.compile(r"""/Users/[^/\s'"`]+/|\b[A-Za-z]:[/\\]+Users[/\\]+[^/\\\s'"`]+|(?<![\w.])/home/[a-z_][a-z0-9_-]*/""")


def code_kind(path, text):
    ext = PurePosixPath(path).suffix.lower()
    if ext in SHELL_EXT:
        return 'shell'
    if ext in PYTHON_EXT:
        return 'python'
    if ext in JS_EXT:
        return 'js'
    if not ext and text.startswith('#!'):
        first = text.split('\n', 1)[0]
        if 'python' in first:
            return 'python'
        if 'node' in first:
            return 'js'
        if re.search(r'\b(?:ba|z|da|k)?sh\b', first):
            return 'shell'
    return None


def line_of(text, pos):
    return text.count('\n', 0, pos) + 1


def in_comment(text, pos):
    start = text.rfind('\n', 0, pos) + 1
    return text[start:pos].lstrip().startswith('#')


class Layout:
    """Where each archived case lands below the restore root, which stands in for the original home folder.
    Catalog data: per-case `legacyRoots` (where a project lived before it was moved to its workspacePath)
    and `homePaths` (the Lemo folder name, dependencies deliberately read from the real home, and known
    projects that were never archived)."""

    def __init__(self, manifest):
        policy = manifest.get('homePaths') or {}
        self.lemo = policy.get('lemo', 'lemo-opuscar')
        self.external = tuple(policy.get('external', ()))
        self.not_archived = tuple(policy.get('notArchived', ()))
        self.cases = {c['id']: c['workspacePath'] for c in manifest['cases'] if 'workspacePath' in c}
        self.legacy = {old: c['workspacePath'] for c in manifest['cases'] for old in c.get('legacyRoots', ())
                       if 'workspacePath' in c}
        self.ancestors = {str(p) for ws in self.cases.values() for p in PurePosixPath(ws).parents if str(p) != '.'}
        names = '|'.join(re.escape(k) for k in sorted(self.legacy, key=len, reverse=True))
        self.legacy_token = re.compile(r'@@WORKSPACE_ROOT@@/(' + names + r""")(?=/|[\s'"`)\]},;|&<>{]|$)""") if names else None

    @staticmethod
    def under(path, prefixes):
        return any(path == p or path.startswith(p + '/') for p in prefixes)

    def translate(self, rel):
        for old in sorted(self.legacy, key=len, reverse=True):
            if rel == old or rel.startswith(old + '/'):
                return self.legacy[old] + rel[len(old):]
        return rel

    def translate_tokens(self, text):
        return self.legacy_token.sub(lambda m: '@@WORKSPACE_ROOT@@/' + self.legacy[m.group(1)], text) if self.legacy_token else text

    def classify(self, rel):
        """'case' (inside a case), 'shared' (a folder that holds restored cases, or a file written straight
        into one, such as a delivered film), 'not-archived' (acknowledged in homePaths) or 'outside'."""
        clean = rel.rstrip('/')
        for cid, ws in self.cases.items():
            if clean == ws or clean.startswith(ws + '/'):
                return 'case', cid
        name = PurePosixPath(clean)
        if clean in self.ancestors or (str(name.parent) in self.ancestors and name.suffix and not rel.endswith('/')):
            return 'shared', None
        return ('not-archived' if self.under(clean, self.not_archived) else 'outside'), None

    def home(self, rest):
        """Token form of `~` + rest, or None when the reference must stay as written."""
        parts = [p for p in rest.split('/') if p not in ('', '.')]
        if not parts or '..' in parts:
            return None, {'kind': 'residual'}
        rel = '/'.join(parts)
        trail = '/' if rest.endswith('/') else ''
        if self.under(rel, self.external):
            return None, {'kind': 'external', 'path': rel}
        if self.under(rel, [self.lemo]):
            return '@@LEMO_ROOT@@' + rel[len(self.lemo):] + trail, {'kind': 'lemo', 'path': rel}
        moved = self.translate(rel)
        where, cid = self.classify(moved)
        return f'@@WORKSPACE_ROOT@@/{moved}{trail}', {'kind': 'workspace', 'path': moved, 'where': where, 'case': cid}


def tokenize_home(text, kind, layout):
    """Turn paths that the original scripts resolved through the home folder (expanduser('~/..'),
    Path.home()/.., $HOME/.., ~/..) into the archive's restore tokens. Returns (text, events)."""
    events, kept = [], []

    def record(match, original, info, token, shown=None):
        if in_comment(text_now[0], match.start()) or info['kind'] == 'residual':
            return original             # residual forms are reported once, by the scan below
        event = dict(info, line=line_of(text_now[0], match.start()), text=(shown or original).strip())
        if token is None:
            events.append(dict(event, kind=info['kind']))
            if info['kind'] == 'external':          # leave as written; hide it from the residual scan
                kept.append(original)
                return f'\0{len(kept) - 1}\0'
            return original
        events.append(dict(event, token=token))
        return None

    def py_expanduser(m):
        token, info = layout.home(m['rest'])
        out = record(m, m[0], info, token, f'~{m["rest"]}')
        return out if out is not None else f'{m["head"]}{m["q"]}{token}{m["q"]}'

    def py_home(m):
        segs = [s[1] for s in PY_SEGMENT.findall(m['segs'])]
        token, info = layout.home('/'.join(segs))
        out = record(m, m[0], info, token)
        quote = PY_SEGMENT.match(m['segs'])[1]
        return out if out is not None else f'Path({quote}{token}{quote})'

    def sh_path(m):
        token, info = layout.home(m['rest'])
        out = record(m, m[0], info, token)
        return out if out is not None else token

    def js_concat(m):
        token, info = layout.home(m['rest'])
        out = record(m, m[0], info, token)
        return out if out is not None else f'{m["q"]}{token}{m["q"]}'

    text_now = [text]
    passes = [(PY_EXPANDUSER, py_expanduser), (PY_HOME, py_home)] if kind in ('python', 'shell') else []
    if kind == 'shell':
        passes += [(SH_HOME, sh_path), (SH_TILDE, sh_path)]
    if kind == 'js':
        passes += [(JS_HOME_CONCAT, js_concat), (JS_HOME_TEMPLATE, sh_path)]
    for rx, fn in passes:
        text_now[0] = rx.sub(fn, text_now[0])
    result = text_now[0]
    for m in RESIDUAL[kind].finditer(result):
        if not in_comment(result, m.start()):
            start = result.rfind('\n', 0, m.start()) + 1
            end = result.find('\n', m.start())
            snippet = result[start:end if end != -1 else None].strip()
            events.append({'kind': 'residual', 'line': line_of(result, m.start()),
                           'text': re.sub(r'\0(\d+)\0', lambda k: kept[int(k[1])], snippet)})
    result = re.sub(r'\0(\d+)\0', lambda k: kept[int(k[1])], result)
    return result, events


def prepare_text(data, path, templated, layout):
    """Token-form text for a source file that restore must rewrite, else None; plus home-path events."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        if templated:
            raise ValueError(f'Templated file is not UTF-8: {path}')
        return None, []
    kind = code_kind(path, text)
    events = []
    changed = bool(templated)
    if kind:
        new, events = tokenize_home(text, kind, layout)
        changed = changed or new != text
        text = new
    return (layout.translate_tokens(text) if changed else None), events


def workspace_refs(text, layout):
    """Targets of @@WORKSPACE_ROOT@@/x tokens (after legacy-root translation) with their line numbers."""
    text = layout.translate_tokens(text)
    for m in re.finditer(r"""@@WORKSPACE_ROOT@@/([^\s'"`)\]},;|&<>{]*)""", text):
        yield line_of(text, m.start()), m[1]


# --- packs ------------------------------------------------------------------------------------------------

def _load_verified(directory):
    try:
        return json.loads((directory / VERIFIED).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def _remember_verified(p, meta):
    cache = _load_verified(p.parent)
    st = p.stat()
    cache[meta['filename']] = {'size': st.st_size, 'mtimeNs': st.st_mtime_ns, 'sha256': meta['sha256']}
    try:
        tmp = p.parent / (VERIFIED + '.tmp')
        tmp.write_text(json.dumps(cache, indent=1, sort_keys=True), encoding='utf-8')
        tmp.replace(p.parent / VERIFIED)
    except OSError:
        pass        # read-only pack folder: the pack was still verified, only the shortcut is lost


def verify_pack(p, meta, reverify=False):
    """Size check from stat, then a streamed SHA-256 unless this exact file (size + mtime) already passed."""
    st = p.stat()
    if st.st_size != meta['size']:
        raise ChecksumError(f'Checksum mismatch: {meta["filename"]} (size {st.st_size}, expected {meta["size"]})',
                            hint=f'删掉 {p.name} 后加 --download 重新下载，或核对 --packs 指向的目录')
    seen = _load_verified(p.parent).get(meta['filename'])
    if not reverify and seen == {'size': st.st_size, 'mtimeNs': st.st_mtime_ns, 'sha256': meta['sha256']}:
        return
    if file_digest(p) != (meta['size'], meta['sha256']):
        raise ChecksumError(f'Checksum mismatch: {meta["filename"]}',
                            hint=f'删掉 {p.name} 后加 --download 重新下载，或核对 --packs 指向的目录')
    _remember_verified(p, meta)


def _interrupted(meta, part, have, error=None):
    why = f'（{error}）' if error else '（服务器在发完之前关闭了连接）'
    return DownloadInterrupted(f'下载中断{why}：{meta["filename"]} 收到 {have} / {meta["size"]} 字节。'
                               f'已保留 {part}，重新运行同一条命令会从断点续传。')


def _range_start(headers, size):
    """Start offset of a 206 response whose Content-Range runs to the end of this pack, else None."""
    m = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+|\*)', str(headers.get('Content-Range') or '').strip())
    if not m or int(m[2]) != size - 1 or m[3] not in ('*', str(size)):
        return None
    return int(m[1])


def pack_url(meta, mirror=None):
    """Where to fetch a pack: the catalog URL, or <mirror>/<filename>. Any source is checked against the
    catalog sha256, so a mirror only changes where the bytes come from, never what is accepted."""
    if not mirror:
        return meta['url']
    return mirror.rstrip('/') + '/' + urllib.parse.quote(meta['filename'])


def download_pack(meta, p, url=None, progress=None):
    """Stream the pack to <name>.partial while hashing it; resume an interrupted .partial with an HTTP Range
    request. The bytes are hashed exactly once and the file is renamed only after the checksum matches.
    A transfer that stops early keeps the .partial for the next run, whether the connection failed with an
    error or the server simply closed it (http.client then returns b'' instead of raising). The .partial is
    discarded only when the server announces a different size, sends more bytes than the pack has, or the
    complete bytes do not hash to the catalog value. `url` defaults to the catalog URL, which must lie in this
    repository's Release; a mirror URL comes from pack_url(). `progress(meta, have, total)` sees every chunk."""
    url = url or meta['url']
    if url == meta['url'] and not url.startswith(PACK_ORIGIN):
        raise ValueError('Unexpected download origin')
    if not url.startswith(('https://', 'http://')):
        raise ValueError(f'Unexpected download origin: {url}')
    part = p.with_name(p.name + '.partial')
    h, have = hashlib.sha256(), 0
    if part.exists() and part.stat().st_size <= meta['size']:
        with open(part, 'rb') as f:
            while chunk := f.read(CHUNK):
                h.update(chunk)
                have += len(chunk)
    else:
        part.unlink(missing_ok=True)
    if have < meta['size']:
        request = urllib.request.Request(url, headers={'Range': f'bytes={have}-'} if have else {})
        try:
            response = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            if error.code != 416 or not have:
                raise
            part.unlink(missing_ok=True)        # the stored prefix is not a prefix of this file: start over
            return download_pack(meta, p, url, progress)
        with response:
            headers = getattr(response, 'headers', None) or {}
            partial = getattr(response, 'status', 200) == 206
            resumed = bool(have) and partial and _range_start(headers, meta['size']) == have
            if partial and not resumed:         # a range we did not ask for: discard and fetch the whole file
                part.unlink(missing_ok=True)
                if not have:
                    raise ValueError(f'Unexpected partial response for {meta["filename"]}')
                response.close()
                return download_pack(meta, p, url, progress)
            if not resumed:
                h, have = hashlib.sha256(), 0
            declared = str(headers.get('Content-Length') or '').strip()
            if declared.isdigit() and int(declared) != meta['size'] - have:
                part.unlink(missing_ok=True)    # not this pack (an error page, another version): keep nothing
                raise ChecksumError(f'{meta["filename"]}: 服务器声明 {declared} 字节，应为 {meta["size"] - have} 字节；'
                                    '这不是目录记录的素材包，未保存', hint='核对下载地址或 --mirror')
            with open(part, 'ab' if resumed else 'wb') as out:
                while True:
                    try:
                        chunk = response.read(CHUNK)
                    except (OSError, http.client.HTTPException) as error:   # reset, timeout, broken chunking
                        raise _interrupted(meta, part, have, error) from error
                    if not chunk:
                        break
                    out.write(chunk)
                    h.update(chunk)
                    have += len(chunk)
                    if progress:
                        progress(meta, have, meta['size'])
                    if have > meta['size']:
                        break
    if have > meta['size']:
        part.unlink(missing_ok=True)
        raise ChecksumError(f'Checksum mismatch: {meta["filename"]} (downloaded more than {meta["size"]} bytes)')
    if have < meta['size']:
        raise _interrupted(meta, part, have)
    if h.hexdigest() != meta['sha256']:
        part.unlink(missing_ok=True)
        raise ChecksumError(f'Checksum mismatch: {meta["filename"]} (downloaded)', hint='核对下载地址或 --mirror')
    part.replace(p)
    _remember_verified(p, meta)


def fetch_pack(meta, p, mirror=None, retries=3, sleep=time.sleep, progress=None, log=None):
    """download_pack with retries: an interrupted transfer, a network error or a transient HTTP status (408,
    425, 429, 5xx) is retried up to `retries` times after 1, 2, 4… seconds (at most 30); each retry resumes the
    .partial. Anything else (wrong bytes, 404, wrong origin) fails at once."""
    url = pack_url(meta, mirror)
    for attempt in range(retries + 1):
        try:
            return download_pack(meta, p, url, progress)
        except urllib.error.HTTPError as error:
            if error.code not in RETRY_HTTP or attempt == retries:
                raise
            reason = f'HTTP {error.code}'
        except (DownloadInterrupted, urllib.error.URLError, socket.timeout, TimeoutError,
                ConnectionError, http.client.HTTPException) as error:
            if attempt == retries:
                raise
            reason = str(error)
        delay = min(30, 2 ** attempt)
        if log:
            log(f'{meta["filename"]}：{reason}；{delay} 秒后第 {attempt + 1} 次重试（共 {retries} 次）')
        sleep(delay)


def get_pack(meta, directory, download, reverify=False, mirror=None, retries=3, progress=None, log=None,
             sleep=time.sleep):
    p = safe_path(directory, meta['filename'])
    if not p.exists():
        if not download:
            raise FileNotFoundError(f'Missing {p}; download from {meta["url"]} or add --download')
        directory.mkdir(parents=True, exist_ok=True)
        fetch_pack(meta, p, mirror, retries, sleep, progress, log)
        return p
    verify_pack(p, meta, reverify)
    return p


def free_bytes(path):
    """Free space on the file system that holds `path` (or its nearest existing parent)."""
    p = Path(path).resolve()
    while not p.exists() and p != p.parent:
        p = p.parent
    return shutil.disk_usage(p).free, p


def ensure_space(needs):
    """`needs` maps a directory to the bytes about to be written below it. Directories on one file system
    are added up; each file system must keep DISK_MARGIN (or 5 %) free afterwards."""
    by_device = {}
    for directory, n in needs.items():
        if n <= 0:
            continue
        free, anchor = free_bytes(directory)
        try:
            dev = anchor.stat().st_dev
        except OSError:
            dev = str(anchor)
        entry = by_device.setdefault(dev, {'need': 0, 'free': free, 'where': []})
        entry['need'] += n
        entry['where'].append(shown_path(directory))
    for entry in by_device.values():
        margin = max(DISK_MARGIN, entry['need'] // 20)
        if entry['need'] + margin > entry['free']:
            raise DiskSpaceError(f'磁盘空间不够：{"、".join(entry["where"])} 需要写入 {fmt_bytes(entry["need"])}，'
                                 f'所在磁盘只剩 {fmt_bytes(entry["free"])}（另需留 {fmt_bytes(margin)} 余量）',
                                 hint='清理磁盘，或用 --packs、--out 指到空间更大的磁盘；--dry-run 可先看要多少空间')


# --- check ------------------------------------------------------------------------------------------------

def check_layout(manifest, layout, problems):
    seen = {}
    for case in manifest['cases']:
        for old in case.get('legacyRoots', ()):
            try:
                safe_path(ROOT / 'out', old)
            except ValueError as error:
                problems.append(f'{case.get("id")}: legacyRoots {error}')
                continue
            if old in seen:
                problems.append(f'legacyRoots {old} listed by both {seen[old]} and {case["id"]}')
                continue
            seen[old] = case['id']
            for cid, ws in layout.cases.items():
                if Layout.under(ws, [old]) or Layout.under(old, [ws]):
                    problems.append(f'legacyRoots {old} of {case["id"]} overlaps workspacePath {ws} of {cid}')
    for old in seen:
        if any(o != old and Layout.under(o, [old]) for o in seen):
            problems.append(f'legacyRoots nest inside each other: {old}')
    for rel in (layout.lemo, *layout.external, *layout.not_archived):
        try:
            safe_path(ROOT / 'out', rel)
        except ValueError as error:
            problems.append(f'homePaths: {error}')


def scan_source(item, data, layout, problems):
    """Home-folder paths and tokens restore cannot place inside the restored workspace."""
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        if item.get('templated'):
            problems.append(f'{item["source"]}: templated file is not UTF-8')
        return
    where = item['source']
    for m in ABSOLUTE_HOME.finditer(text):
        problems.append(f'{where}:{line_of(text, m.start())}: absolute home path {m[0]!r}')
    tokens = set(TOKEN_RE.findall(text))
    if not item.get('templated') and tokens:
        problems.append(f'{where}: restore tokens {sorted(tokens)} in a file not marked templated')
    if tokens - KNOWN_TOKENS:
        problems.append(f'{where}: unknown restore tokens {sorted(tokens - KNOWN_TOKENS)}')
    kind = code_kind(item['path'], text)
    if not kind:
        return
    for event in tokenize_home(text, kind, layout)[1]:
        if event['kind'] == 'residual':
            problems.append(f'{where}:{event["line"]}: home-folder path restore cannot rewrite: {event["text"]}')
        elif event.get('where') == 'outside':
            problems.append(f'{where}:{event["line"]}: home-folder path {event["text"]} is outside every archived case')
    for line, rel in workspace_refs(text, layout):
        if layout.classify(rel)[0] == 'outside':
            problems.append(f'{where}:{line}: @@WORKSPACE_ROOT@@/{rel} is outside every archived case')


def git_file_mode(top):
    """Git's core.fileMode for the checkout holding `top`. git clone sets it to false on file systems that
    cannot store executable bits (WSL's /mnt drives, exFAT/FAT, many SMB shares): every file then reads as
    executable while `git status` stays clean. None when it is unset or Git cannot answer."""
    try:
        run_ = subprocess.run(['git', '-C', str(top), 'config', '--bool', 'core.fileMode'],
                              capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return {'true': True, 'false': False}.get(run_.stdout.strip()) if run_.returncode == 0 else None


def check_modes(modes, summary, problems):
    """Executable bits against the lock, for (label, lock mode, executable) of every vendored file with a
    recorded mode. Skipped, with a notice, where the checkout cannot hold executable bits at all."""
    if not modes or os.name == 'nt':
        summary['fileModes'] = 'unsupported' if modes else 'absent'
        return
    if git_file_mode(ARCHIVE) is False:
        summary['fileModes'] = 'skipped'
        summary['notices'].append('Git 的 core.fileMode 为 false（这个文件系统不记录执行位，Git 也不比较执行位），'
                                  '跳过 vendor 执行位核对。')
        return
    if all(executable for _, _, executable in modes) and any(mode != '100755' for _, mode, _ in modes):
        summary['fileModes'] = 'skipped'
        summary['notices'].append(f'vendor 的 {len(modes)} 个文件全部显示为可执行，像是不记录执行位的文件系统'
                                  '（WSL 的 /mnt 盘、exFAT/FAT、部分 SMB 共享），跳过 vendor 执行位核对。')
        return
    wrong = [f'{label}（lock 为 {mode}，实际{"可" if executable else "不可"}执行）'
             for label, mode, executable in modes if executable != (mode == '100755')]
    if wrong:
        problems.append(f'Vendor file mode mismatch（{len(wrong)} 个文件）：{listing(wrong)}\n'
                        '复制或解压时可能丢了或多了执行位；Git 检出可用 git checkout -- cases/vendor 按仓库记录恢复'
                        '（会丢弃 vendor 下未提交的改动）。')
    summary['fileModes'] = 'checked'


def check_vendor(lock, crlf, summary, problems):
    modes, files, repos = [], 0, 0
    for repo in json.loads(lock.read_text(encoding='utf-8'))['repositories']:
        repos += 1
        try:
            folder = safe_path(ARCHIVE, repo['path'])
        except ValueError as error:
            problems.append(f'vendor/lock.json {repo.get("name")}: {error}')
            continue
        expected = {f['path'] for f in repo['files']}
        keep_dirs = {str(p) for f in expected for p in PurePosixPath(f).parents}
        ignore = GitIgnore(ARCHIVE.parent)
        actual, extra = set(), []
        for dirpath, dirnames, filenames in os.walk(folder):
            here = Path(dirpath)
            rel_dir = here.relative_to(folder).as_posix()
            rel = (lambda n: n if rel_dir == '.' else f'{rel_dir}/{n}')
            dirnames[:] = [d for d in dirnames if rel(d) in keep_dirs or not (
                d in LOCAL_DIRS or ignore.ignored(here / d, True))]
            for name in filenames:
                path = rel(name)
                actual.add(path)
                if path not in expected and name not in JUNK_FILES and not name.startswith('._') \
                        and not ignore.ignored(here / name):
                    extra.append(path)
        missing = expected - actual
        if extra or missing:
            problems.append(f'Vendor snapshot inventory changed: {repo["name"]}'
                            + (f'\n未登记的文件（不在 lock.json，也不被 .gitignore 忽略）：{listing(extra)}' if extra else '')
                            + (f'\n缺少的文件：{listing(missing)}' if missing else ''))
        for item in repo['files']:
            if item['path'] in missing:
                continue
            files += 1
            p = safe_path(folder, item['path'])
            raw = p.read_bytes()
            data = archived_bytes(raw, item)
            if data is None:
                problems.append(f'Checksum mismatch: {repo["name"]}/{item["path"]}')
                continue
            if data is not raw:
                crlf.append(f'{repo["path"]}/{item["path"]}')
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if blob != item['gitBlob']:
                problems.append(f'Vendor Git blob mismatch: {item["path"]}')
            if 'mode' in item:
                modes.append((f'{repo["path"]}/{item["path"]}', item['mode'], bool(p.stat().st_mode & stat.S_IXUSR)))
    summary['vendorFiles'], summary['vendorRepos'] = files, repos
    check_modes(modes, summary, problems)


def check_cards(manifest, summary, problems):
    """Every case has a card (entries/<id>.md) and every card a case. Cards repeat the catalog notes word for
    word; a card that no longer does is a notice: the catalog is authoritative, and the restore report already
    carries its notes."""
    folder = ARCHIVE / 'entries'
    if not folder.is_dir():
        return
    ids = {c['id'] for c in manifest['cases']}
    cards = {p.stem for p in folder.glob('*.md')}
    if extra := cards - ids:
        problems.append(f'案例卡没有对应的 catalog 记录（新增）：{listing(f"entries/{c}.md" for c in extra)}')
    if missing := ids - cards:
        problems.append(f'catalog 记录缺案例卡（缺失）：{listing(f"entries/{c}.md" for c in missing)}')
    stale = []
    for case in manifest['cases']:
        card = folder / f'{case["id"]}.md'
        if card.is_file():
            text = card.read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n')
            if any(note not in text for note in case.get('notes', ())):
                stale.append(f'entries/{case["id"]}.md')
    if stale:
        summary['notices'].append(f'{len(stale)} 张案例卡里的说明与 catalog.json 的 notes 不一致（以 catalog 为准，'
                                  f'请把卡片上的说明改成 notes 原文）：{listing(stale)}')


def check_posters(manifest, problems):
    for case in manifest['cases']:
        if case.get('poster'):
            try:
                if not safe_path(ARCHIVE, case['poster']).is_file():
                    problems.append(f'{case["id"]}: 海报缺失 {case["poster"]}')
            except ValueError as error:
                problems.append(f'{case["id"]}: poster {error}')


def check_stray_sources(referenced, problems):
    """Files below cases/source/ that no catalog entry references (new files nobody registered)."""
    top = ARCHIVE / 'source'
    if not top.is_dir():
        return
    ignore = GitIgnore(ARCHIVE.parent)
    stray = []
    for dirpath, dirnames, filenames in os.walk(top):
        here = Path(dirpath)
        dirnames[:] = [d for d in dirnames if d not in LOCAL_DIRS and not ignore.ignored(here / d, True)]
        for name in filenames:
            p = here / name
            if name in JUNK_FILES or name.startswith('._') or ignore.ignored(p):
                continue
            if p.resolve() not in referenced:
                stray.append(p.relative_to(ARCHIVE).as_posix())
    if stray:
        problems.append(f'cases/source 下有 catalog 没有登记的文件（新增）：{listing(stray)}\n'
                        '新作品入库要经 casebook 工具登记哈希与归属；误放的文件请移走。')


def legacy_status(case):
    """The legacy `status` that technical + approval imply (tools/build-showcase.py still curates on it)."""
    if (case.get('approval') or {}).get('status') == 'rejected':
        return 'rejected'
    return LEGACY_STATUS.get((case.get('technical') or {}).get('status'))


def check_fields(manifest, problems):
    """schemaVersion 2 fields: technical and approval kept apart (QUAL-16, CRAFT-11), rights present, templated
    entries without originalSha256 (COMP-05), restore's reserved names unused."""
    for case in manifest['cases']:
        cid = case.get('id')
        tech, appr = case.get('technical'), case.get('approval')
        ok = True
        if not isinstance(tech, dict) or tech.get('status') not in TECH_STATUSES:
            problems.append(f'{cid}: technical.status 要是 {"/".join(TECH_STATUSES)} 之一')
            ok = False
        elif (tech.get('qa') or {}).get('status') not in QA_STATUSES:
            problems.append(f'{cid}: technical.qa.status 要是 {"/".join(QA_STATUSES)} 之一')
        if not isinstance(appr, dict) or appr.get('status') not in APPROVAL_STATUSES:
            problems.append(f'{cid}: approval.status 要是 {"/".join(APPROVAL_STATUSES)} 之一')
            ok = False
        elif appr['status'] == 'rejected' and not (appr.get('reasons') and appr.get('evidence')):
            problems.append(f'{cid}: 被否定的记录要有 reasons 与 evidence（查不到用户原话就写「{PENDING_REASON}」，不编造）')
        elif appr['status'] == 'approved' and not (appr.get('by') and appr.get('date') and appr.get('evidence')):
            problems.append(f'{cid}: approved 必须写 by、date 与 evidence（用户原话或评审记录的位置；agent 不能自己批准，D08）')
        if ok and case.get('status') != legacy_status(case):
            problems.append(f'{cid}: status {case.get("status")!r} 与 technical/approval 推出的 {legacy_status(case)!r} 不一致'
                            '（status 是作品站读的兼容字段，随 technical、approval 一起改）')
        for key in ('displayTitle', 'summary'):
            if not isinstance(case.get(key), str):
                problems.append(f'{cid}: 缺 {key}（字符串，可以为空）')
        names = {f.get('path') for f in case['files']}
        for path in case.get('keyFiles', ()):
            if path not in names:
                problems.append(f'{cid}: keyFiles 里的 {path} 不在这个案例的文件里')
        rights = case.get('rights')
        if not isinstance(rights, dict):
            problems.append(f'{cid}: 缺 rights（运行 casebook.py rights --write 按 docs/rights/register.json 生成）')
        elif rights.get('clearance') not in CLEARANCES:
            problems.append(f'{cid}: rights.clearance 要是 {"/".join(CLEARANCES)} 之一')
        for item in case['files']:
            if item.get('templated') and 'originalSha256' in item:
                problems.append(f'{cid}/{item["path"]}: templated 条目不能保留 originalSha256（能反推出还原标记的原值，COMP-05）')
            if item.get('path') in RESERVED_NAMES or str(item.get('path', '')).startswith(RESERVED_DIR + '/'):
                problems.append(f'{cid}/{item["path"]}: 与 restore 写入的 {item["path"].split("/")[0]} 重名')


# --- rights: computed from the register (docs/rights/register.json, maintained by the compliance package) -----

def glob_regex(glob):
    """Same rules as tools/compliance/lib/reuse.mjs globToRegExp: ** crosses folders, * stays inside one,
    \\* is a literal star, everything else is literal. Use with fullmatch."""
    out, j = [], 0
    while j < len(glob):
        c = glob[j]
        if c == '\\' and glob[j + 1:j + 2] == '*':
            out.append(r'\*')
            j += 2
        elif c == '*' and glob[j + 1:j + 2] == '*':
            out.append('.*')
            j += 2
        else:
            out.append('[^/]*' if c == '*' else re.escape(c))
            j += 1
    return re.compile(''.join(out))


def read_register(path=None):
    path = path or REGISTER
    try:
        register = json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise CasebookError(f'找不到授权登记册 {shown_path(path)}', hint='在完整的仓库检出里运行；登记册由合规工作包维护')
    except ValueError as error:
        raise CasebookError(f'授权登记册不是合法的 JSON：{error}', hint='git checkout -- docs/rights/register.json')
    if register.get('schemaVersion') != 1 or not isinstance(register.get('categories'), list):
        raise CasebookError('授权登记册结构变了：要有 schemaVersion 1 与 categories 数组', hint='同步更新 casebook 的 register_hits')
    return register


def source_reader():
    cache = {}

    def read(source):
        if source not in cache:
            try:
                cache[source] = (ARCHIVE / source).read_text(encoding='utf-8', errors='replace')
            except OSError:
                cache[source] = ''
        return cache[source]
    return read


def register_hits(register, manifest, read_text):
    """Which cases each register category touches: {category: {case: {how, files, where}}}. A port of
    computeInventory in tools/compliance/lib/rights.mjs (same match rules, same order, same precedence:
    whole > uses > files); the cases.rights rule of check:repo compares the two."""
    by_id = {c['id']: c for c in manifest['cases']}
    rank = {'whole': 3, 'uses': 2, 'files': 1}
    result = {}
    for cat in register['categories']:
        m = cat.get('match')
        if not m:
            continue
        hits = {}

        def mark(cid, how, path=None, where=None):
            h = hits.setdefault(cid, {'how': how, 'files': set(), 'where': []})
            if rank[how] > rank[h['how']]:
                h['how'] = how
            if path:
                h['files'].add(path)
            if where:
                h['where'].append(where)
        for cid in m.get('cases', ()):
            if cid in by_id:
                mark(cid, 'whole')
        for cid in m.get('uses', ()):
            if cid in by_id:
                mark(cid, 'uses')
        for group in m.get('groups', ()):
            for c in manifest['cases']:
                if c['group'] == group:
                    mark(c['id'], 'whole')
        excluded = [(x.get('case', '*'), glob_regex(x['path'])) for x in m.get('exclude', ())]
        shas = set()
        for rule in m.get('files', ()):
            rx = glob_regex(rule['path'])
            for c in manifest['cases']:
                if rule.get('case') != '*' and rule.get('case') != c['id']:
                    continue
                for f in c['files']:
                    if not rx.fullmatch(f['path']):
                        continue
                    if any((xc == '*' or xc == c['id']) and xr.fullmatch(f['path']) for xc, xr in excluded):
                        continue
                    mark(c['id'], 'files', f['path'])
                    shas.add(f['sha256'])
        if shas and m.get('propagate', True) is not False:
            for c in manifest['cases']:
                for f in c['files']:
                    if f['sha256'] in shas:
                        mark(c['id'], 'files', f['path'])
        for rule in m.get('text', ()):
            rx = glob_regex(rule['path'])
            flags = sum({'i': re.I, 'm': re.M, 's': re.S}.get(ch, 0) for ch in rule.get('flags', ''))
            pattern = re.compile(rule['pattern'], flags)
            for c in manifest['cases']:
                if c['id'] in hits and hits[c['id']]['how'] == 'whole':
                    continue
                for f in c['files']:
                    if 'source' not in f or not rx.fullmatch(f['path']):
                        continue
                    text = read_text(f['source'])
                    found = pattern.search(text)
                    if found:
                        start = text.rfind('\n', 0, found.start()) + 1
                        end = text.find('\n', found.start())
                        mark(c['id'], 'uses', where=(f['source'], line_of(text, found.start()), text[start:end if end != -1 else None]))
                        break
        result[cat['id']] = hits
    return result


def attribution_of(line):
    """A CREDITS line as plain attribution text: list markers and table pipes removed, spacing collapsed."""
    text = line.strip()
    if text.startswith('|'):
        text = ' '.join(cell.strip() for cell in text.strip('|').split('|') if cell.strip())
    return re.sub(r'\s+', ' ', re.sub(r'^[-*+]\s+', '', text)).strip()


def compute_rights(manifest, register, read_text=None):
    """(rights per case, file marks per case). Case rights: clearance (internal when a client, third-party IP,
    reference-image or trademark category touches the whole case or its film), the register categories,
    owner, license, sourceUrl, CC BY attribution lines read from the case's own CREDITS, AI-generation
    categories and evidence. File marks: register categories matched file by file, plus clearance=internal
    for such files in an otherwise public case. Unknown values are 待补."""
    read_text = read_text or source_reader()
    cats = {c['id']: c for c in register['categories']}
    hits = register_hits(register, manifest, read_text)
    rights, marks = {}, {}
    for case in manifest['cases']:
        mine = {k: h[case['id']] for k, h in hits.items() if case['id'] in h}
        internal = sorted(k for k, h in mine.items() if cats[k].get('kind') in INTERNAL_KINDS and h['how'] in ('whole', 'uses'))
        clearance = 'internal' if internal else 'public'
        attribution, evidence = [], [f'docs/rights/register.md 的 {k}' for k in sorted(mine)]
        for k in sorted(mine):
            for source, line, text in mine[k]['where']:
                evidence.append(f'cases/{source}:{line}')
                if cats[k].get('kind') == 'open-license' and re.search(r'\bCC BY\b', cats[k].get('title', '')):
                    attribution.append(attribution_of(text))
        ai = sorted(k for k in mine if cats[k].get('kind') == 'service-terms')
        rights[case['id']] = {
            'clearance': clearance,
            'register': sorted(mine),
            'owner': '；'.join(dict.fromkeys(cats[k].get('holder') or PENDING for k in internal)) or PENDING,
            'license': ARCHIVE_LICENSE,
            'sourceUrl': PENDING if internal else None,
            'attributionText': list(dict.fromkeys(attribution)),
            'aiGenerated': {'present': True, 'register': ai, 'tools': PENDING} if ai else
                           {'present': PENDING, 'register': [], 'tools': PENDING},
            'evidence': evidence,
        }
        files = {}
        for k, h in mine.items():
            for path in h['files']:
                files.setdefault(path, set()).add(k)
        marks[case['id']] = {
            path: {'register': sorted(ks),
                   'clearance': 'internal' if clearance == 'public' and any(cats[k].get('kind') in INTERNAL_KINDS for k in ks) else None}
            for path, ks in files.items()}
    return rights, marks


def _insert_after(record, after, key, value):
    if key in record:
        record[key] = value
        return record
    out = {}
    for k, v in record.items():
        out[k] = v
        if k == after:
            out[key] = value
    if key not in out:
        out[key] = value
    record.clear()
    record.update(out)
    return record


def apply_rights(manifest, register, computed):
    """Write computed rights into the catalog in place (idempotent: stale file marks are removed first)."""
    rights, marks = computed
    _insert_after(manifest, 'homePaths', 'rights', {
        'register': 'docs/rights/register.json', 'registerUpdated': register.get('updated'),
        'internalKinds': sorted(INTERNAL_KINDS),
        'note': '每个案例的 rights 由 casebook.py rights --write 按授权登记册算出，不要手改；登记册改了要重新生成。'
                'clearance=internal 的素材 restore 默认不还原（--include-internal），不得用进新作品或对外物料；'
                '文件条目上的 register、clearance 只标逐文件命中的登记类别（整案命中的写在案例的 rights 上）。'})
    for case in manifest['cases']:
        _insert_after(case, 'approval' if 'approval' in case else 'status', 'rights', rights[case['id']])
        mine = marks.get(case['id'], {})
        for item in case['files']:
            item.pop('register', None)
            item.pop('clearance', None)
            mark = mine.get(item['path'])
            if mark:
                item['register'] = mark['register']
                if mark['clearance']:
                    item['clearance'] = mark['clearance']


def rights_drift(manifest, computed):
    """Differences between the catalog's rights fields and what the register implies now."""
    rights, marks = computed
    problems = []
    for case in manifest['cases']:
        cid = case['id']
        if case.get('rights') != rights[cid]:
            have = case.get('rights') or {}
            keys = sorted(k for k in set(have) | set(rights[cid]) if have.get(k) != rights[cid].get(k))
            problems.append(f'{cid}: rights 与登记册推出的不一致（{"、".join(keys)}）')
        mine = marks.get(cid, {})
        wrong = [item['path'] for item in case['files']
                 if (item.get('register'), item.get('clearance')) != ((mine.get(item['path']) or {}).get('register'),
                                                                     (mine.get(item['path']) or {}).get('clearance'))]
        if wrong:
            problems.append(f'{cid}: {len(wrong)} 个文件条目的 register/clearance 与登记册推出的不一致，例如 {wrong[0]}')
    if problems:
        problems.append('改了 docs/rights/register.json 或 catalog 之后运行：node tools/env/py.mjs tools/casebook.py rights --write')
    return problems


def check_rights(manifest, summary, problems):
    """check --rights: rights fields match the register; packs declared public hold no internal asset."""
    try:
        register = read_register()
    except CasebookError as error:
        problems.append(f'{error}')
        return
    problems.extend(rights_drift(manifest, compute_rights(manifest, register)))
    internal = {item['asset'] for case in manifest['cases'] for item in case['files']
                if 'asset' in item and file_clearance(case, item) != 'public'}
    mixed = []
    for pack in manifest['packs']:
        assets = {sha for sha, meta in manifest['assets'].items() if meta['pack'] == pack['filename']}
        bad = assets & internal
        if pack.get('audience') == 'public' and bad:
            problems.append(f'公开素材包 {pack["filename"]} 含 {len(bad)} 个 clearance≠public 的素材')
        elif pack.get('audience') is None and bad and assets - bad:
            mixed.append(pack['filename'])
    if mixed:
        summary['notices'].append(f'{len(mixed)} 个历史素材包混装了公开与内部素材（casebook-2026.11，D02 不下线）：'
                                  f'{"、".join(mixed)}；新打的包要分 audience=public / internal。')


def check(manifest, summary=None, rights=False):
    """Verify catalog and archive, collecting every problem before failing (CheckFailed lists them all).
    `summary`, when given, receives 'notices' (worth reading although the check passed), 'fileModes'
    (checked, skipped, unsupported or absent), 'vendorFiles' and 'vendorRepos'. `rights` also compares the
    rights fields with docs/rights/register.json and audits the packs. Returns (records, sources)."""
    summary = {} if summary is None else summary
    summary.setdefault('notices', [])
    problems = []
    layout = Layout(manifest)
    check_layout(manifest, layout, problems)
    ids = set()
    verified = {}           # resolved source path -> (size, sha256) of the archived bytes, None when unreadable
    crlf = []
    packs = {p['filename'] for p in manifest['packs']}
    for case in manifest['cases']:
        cid = case.get('id')
        if cid in ids:
            problems.append(f'Duplicate case ID: {cid}')
            continue
        ids.add(cid)
        try:
            safe_path(ROOT / 'out', case['workspacePath'])
        except (KeyError, ValueError) as error:
            problems.append(f'{cid}: workspacePath {error}')
        paths = set()
        for item in case['files']:
            label = f'{cid}/{item.get("path")}'
            try:
                safe_path(ROOT / 'out', item['path'])
            except (KeyError, ValueError) as error:
                problems.append(f'{label}: {error}')
                continue
            key = item['path'].casefold()
            if key in paths:
                problems.append(f'Duplicate/case-colliding file: {label}')
                continue
            paths.add(key)
            if 'source' in item:
                try:
                    p = safe_path(ARCHIVE, item['source'])
                except ValueError as error:
                    problems.append(f'{label}: source {error}')
                    continue
                where = p.resolve()
                if where not in verified:
                    try:
                        raw = p.read_bytes()
                    except OSError:
                        verified[where] = None
                        problems.append(f'Missing source file（缺失）: {label} (source {item["source"]})')
                        continue
                    data = archived_bytes(raw, item)
                    if data is None:
                        verified[where] = None
                        problems.append(f'Checksum mismatch: {label} (source {item["source"]})')
                        continue
                    if data is not raw:
                        crlf.append(item['source'])
                    verified[where] = (item['size'], item['sha256'])
                    scan_source(item, data, layout, problems)
                elif verified[where] is not None and verified[where] != (item['size'], item['sha256']):
                    # Every reference must agree, otherwise check passes while restore of this case fails.
                    problems.append(f'Checksum mismatch: {label} records a different '
                                    f'size/sha256 for {item["source"]} than an earlier case')
            else:
                try:
                    asset = asset_meta(manifest, case, item)
                except ValueError as error:
                    problems.append(str(error))
                    continue
                if asset['pack'] not in packs or asset['size'] != item['size'] or item['asset'] != item['sha256']:
                    problems.append(f'Invalid asset reference: {label}')
            if item.get('clearance', 'public') not in CLEARANCES:
                problems.append(f'{label}: clearance {item["clearance"]!r} 不是 {"/".join(CLEARANCES)} 之一')
        names = {f.get('path') for f in case['files']}
        if any(p not in names for p in case.get('entrypoints', ())):
            problems.append(f'Missing entry point: {cid}')
    check_stray_sources(set(verified), problems)
    lock = ARCHIVE / 'vendor/lock.json'
    if lock.exists():
        check_vendor(lock, crlf, summary, problems)
    if crlf:
        problems.append(f'Checksum mismatch（换行被改成 CRLF）：{len(crlf)} 个文件{listing(crlf, 10)}\n{CRLF_HINT}')
    check_cards(manifest, summary, problems)
    check_posters(manifest, problems)
    if manifest.get('schemaVersion', 1) >= 2:
        check_fields(manifest, problems)
    if rights:
        check_rights(manifest, summary, problems)
    summary['records'], summary['sources'] = len(ids), sum(1 for v in verified.values() if v is not None)
    if problems:
        raise CheckFailed(problems)
    return len(ids), len(verified)


# --- restore ----------------------------------------------------------------------------------------------

def check_value(token, value):
    rule = SAFE_HOST if token == '@@ROG_HOST@@' else SAFE_VALUE
    if not rule.fullmatch(value or '') or '@@' in value:
        bad = ''.join(sorted({ch for ch in value if not rule.fullmatch(ch)})) or value
        raise UnsafeValueError(f'{token} 要写入还原后的脚本，但值 {value!r} 含有不安全字符 {bad!r}'
                               '（空白、引号、$、反斜杠、括号、通配符等会让 shell、JSON 或 Python 源码出错）。'
                               '请换一个只含字母、数字、中文和 / . _ - : 的目录作为 --out、--lemo 或仓库位置。',
                               hint='换一个不含空格与引号的 --out 或 --lemo 目录')


def find_case(manifest, case_id):
    case = next((c for c in manifest['cases'] if c['id'] == case_id), None)
    if case is None:
        raise ValueError(f'Unknown case: {case_id}')
    return case


def case_target(manifest, case_id, output):
    return safe_path(output, find_case(manifest, case_id)['workspacePath'])


def plan_restore(manifest, case_id, output, pack_dir, source_only=False, include_internal=False):
    """What restore would write, withhold and need, without touching the disk or the network."""
    case = find_case(manifest, case_id)
    target = safe_path(output, case['workspacePath'])
    for item in case['files']:          # validate every destination before anything is created
        safe_path(target, item['path'])
    for item in case['files']:
        if item['path'] in RESERVED_NAMES or item['path'].startswith(RESERVED_DIR + '/'):
            raise CasebookError(f'{case_id}/{item["path"]} 与 restore 写入的文件重名', hint='在 catalog 里给这个文件换个路径')
    packs = {p['filename']: p for p in manifest['packs']}
    write, withheld = [], []
    for item in case['files']:
        if 'source' in item:
            write.append(item)
        elif source_only:
            continue
        elif (clearance := file_clearance(case, item)) != 'public' and not include_internal:
            withheld.append({'path': item['path'], 'clearance': clearance, 'size': item['size']})
        else:
            write.append(item)
    needed = sorted({asset_meta(manifest, case, f)['pack'] for f in write if 'source' not in f})
    if unknown := [n for n in needed if n not in packs]:
        raise ValueError(f'{case_id} needs unknown packs: {unknown}')
    missing = [n for n in needed if not (pack_dir / n).exists()]
    return {
        'case': case, 'target': target, 'write': write, 'withheld': withheld, 'packs': needed,
        'missingPacks': missing, 'bytes': sum(f['size'] for f in write),
        'downloadBytes': sum(packs[n]['size'] for n in missing),
    }


LICENSE_TEXTS = {   # restore 复制进 ARCHIVE-LICENSES/ 的许可文本：键 → (源文件, 什么时候需要)
    'LicenseRef-Casebook-Archive.txt': (ROOT / 'LICENSES' / 'LicenseRef-Casebook-Archive.txt', '归档源码与文本的权利说明（每个案例都带）'),
    'OFL-1.1.txt': (ARCHIVE / 'licenses' / 'OFL-1.1.txt', '案例里有字体文件（OFL 第 2 条：随字体分发许可全文；子集也是修改版）'),
    'LemoLab-MIT.txt': (ARCHIVE / 'licenses' / 'LemoLab-MIT.txt', '用到或改写了 LemoLab lemo-opuscar 的代码'),
    'three-MIT.txt': (ARCHIVE / 'licenses' / 'three-MIT.txt', '打包了 three.js'),
    'CC-BY-4.0.txt': (ROOT / 'LICENSES' / 'CC-BY-4.0.txt', '用了 CC BY 4.0 的素材（署名见 RIGHTS.json）'),
}


def rights_record(manifest, case, written, withheld, include_internal, register=None):
    """RIGHTS.json for a restored case, plus the license texts it must carry: [(name, source path)]."""
    rights = case.get('rights') or {'clearance': case_clearance(case), 'register': [], 'owner': PENDING,
                                     'license': ARCHIVE_LICENSE, 'attributionText': [], 'evidence': []}
    names = ['LicenseRef-Casebook-Archive.txt']
    if any(FONT_FILE.search(f['path']) for f in written):
        names.append('OFL-1.1.txt')
    if case.get('upstreamStyle') or any(f.get('upstream') for f in written):
        names.append('LemoLab-MIT.txt')
    if any(THREE_FILE.search(f['path']) for f in written):
        names.append('three-MIT.txt')
    if any('CC BY 4.0' in line for line in rights.get('attributionText', ())):
        names.append('CC-BY-4.0.txt')
    texts = [(n, LICENSE_TEXTS[n][0]) for n in names if LICENSE_TEXTS[n][0].is_file()]
    rules = []
    if register:
        cats = {c['id']: c for c in register.get('categories', ())}
        rules = [{'id': k, 'title': cats[k].get('title'), 'obligations': cats[k].get('obligations'),
                  'agentRule': cats[k].get('agentRule')} for k in rights.get('register', ()) if k in cats]
    return {
        'case': case['id'], 'title': case.get('title'),
        'note': '历史归档的权利记录（由 casebook restore 写出）：代码按 MIT 或上游许可，影片、原画、配音与素材保留原权利，'
                '不因还原而获得复用授权。clearance=internal 的素材只为研究方法，不得用进新作品或对外物料。',
        **{k: rights.get(k) for k in ('clearance', 'register', 'owner', 'license', 'sourceUrl', 'attributionText',
                                      'aiGenerated', 'evidence')},
        'technical': case.get('technical'), 'approval': case.get('approval'),
        'includeInternal': include_internal, 'withheld': len(withheld),
        'licenses': [{'file': f'{RESERVED_DIR}/{n}', 'why': LICENSE_TEXTS[n][1]} for n, _ in texts],
        'register': rights.get('register', []), 'rules': rules,
        'registerFile': 'docs/rights/register.md',
    }, texts


def restore(manifest, case_id, output, pack_dir, download=False, source_only=False, lemo=None, rog=None,
            reverify=False, *, include_internal=False, strict=False, mirror=None, retries=3, progress=None,
            log=None, sleep=time.sleep):
    plan = plan_restore(manifest, case_id, output, pack_dir, source_only, include_internal)
    case, target = plan['case'], plan['target']
    if target.exists():
        raise FileExistsError(f'Refusing to overwrite existing directory: {target}')
    layout = Layout(manifest)
    packs = {p['filename']: p for p in manifest['packs']}
    values = {'@@CASE_ROOT@@': target.resolve().as_posix(), '@@WORKSPACE_ROOT@@': output.resolve().as_posix(),
              '@@LEMO_ROOT@@': (lemo or ARCHIVE/'vendor/lemo-opuscar').resolve().as_posix()}
    if rog:
        values['@@ROG_HOST@@'] = rog
    report = {'case': case_id, 'sourceOnly': source_only, 'entries': case['entrypoints'],
              'requirements': case['requirements'], 'notes': case['notes'],
              'warning': 'Historical archive restored; no film was rendered or visually approved by this command.',
              'clearance': case_clearance(case), 'includeInternal': include_internal,
              'withheld': plan['withheld'],
              'tokens': {}, 'homeRewrites': [], 'externalHomePaths': [], 'notArchived': [], 'relatedCases': [],
              'unreplacedTokens': [], 'unresolvedTokens': [], 'lineEndingsRepaired': []}
    # Read, verify and rewrite every source file in memory (they are small) before touching the disk.
    prepared, used = {}, set()
    for item in case['files']:
        if 'source' not in item:
            continue
        raw = safe_path(ARCHIVE, item['source']).read_bytes()
        data = archived_bytes(raw, item)
        if data is None:
            raise ChecksumError(f'Checksum mismatch: {case_id}/{item["path"]} (source {item["source"]})',
                                hint='仓库里的归档文件被改过：git checkout -- cases/source 恢复后再运行 check')
        if data is not raw:
            report['lineEndingsRepaired'].append(item['path'])
        text, events = prepare_text(data, item['path'], item.get('templated'), layout)
        for e in events:
            ref = {'file': item['path'], 'line': e['line'], 'reference': e['text']}
            if e['kind'] == 'external':
                report['externalHomePaths'].append(ref)
            elif 'token' in e:
                report['homeRewrites'].append(dict(ref, to=e['token'], target=e.get('where', 'lemo')))
                if e.get('where') in ('not-archived', 'outside'):
                    report['notArchived'].append(dict(ref, path=e['path']))
                if e.get('case') and e['case'] != case_id:
                    report['relatedCases'].append(e['case'])
        if text is None:
            prepared[item['path']] = data
            continue
        for _, rel in workspace_refs(text, layout):
            where, cid = layout.classify(rel)
            if cid and cid != case_id:
                report['relatedCases'].append(cid)
        used |= set(TOKEN_RE.findall(text)) & values.keys()
        prepared[item['path']] = text
    for token in sorted(used):
        check_value(token, values[token])
        report['tokens'][token] = values[token]
    for path, text in prepared.items():
        if isinstance(text, str):
            for old, new in values.items():
                text = text.replace(old, new)
            hits = [(line_of(text, m.start()), m[0]) for m in TOKEN_RE.finditer(text)]
            if hits:
                report['unreplacedTokens'].append({'file': path, 'tokens': sorted({t for _, t in hits})})
                report['unresolvedTokens'].extend({'file': path, 'line': n, 'token': t} for n, t in hits)
            prepared[path] = text.encode('utf-8')
    if strict and report['unresolvedTokens']:
        found = report['unresolvedTokens']
        names = sorted({t['token'] for t in found})
        raise UnresolvedTokensError(
            f'{len(found)} 处还原标记没有值（{"、".join(names)}），--strict 拒绝还原：'
            + listing((f'{t["file"]}:{t["line"]} {t["token"]}' for t in found), 10, sort=False),
            hint=('@@ROG_HOST@@ 用 --rog-host <工作站地址> 指定；' if '@@ROG_HOST@@' in names else '')
            + '或去掉 --strict 照常还原，残留会写进 ARCHIVE-RESTORED.json 的 unresolvedTokens')
    for rewrite in report['homeRewrites']:
        for old, new in values.items():
            rewrite['to'] = rewrite['to'].replace(old, new)
    report['relatedCases'] = sorted(set(report['relatedCases']))
    write = {f['path'] for f in plan['write']}
    needs = {target.parent: plan['bytes']}
    if download and plan['missingPacks']:
        needs[pack_dir] = needs.get(pack_dir, 0) + plan['downloadBytes']
    ensure_space(needs)
    opened = {}
    temp = None
    try:
        for name in plan['packs']:
            opened[name] = zipfile.ZipFile(get_pack(packs[name], pack_dir, download, reverify, mirror, retries,
                                                    progress, log, sleep))
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = Path(tempfile.mkdtemp(prefix='.case-restore-', dir=target.parent))
        for item in case['files']:
            if item['path'] not in write:
                continue
            dest = safe_path(temp, item['path'])
            dest.parent.mkdir(parents=True, exist_ok=True)
            if 'source' in item:
                dest.write_bytes(prepared[item['path']])
            else:
                h, size = hashlib.sha256(), 0
                with opened[asset_meta(manifest, case, item)['pack']].open(item['asset']) as src, open(dest, 'wb') as out:
                    while chunk := src.read(CHUNK):
                        out.write(chunk)
                        h.update(chunk)
                        size += len(chunk)
                if size != item['size'] or h.hexdigest() != item['sha256']:
                    raise ChecksumError(f'Checksum mismatch: {case_id}/{item["path"]}')
            if item.get('executable'):
                dest.chmod(0o755)
        (temp/'ARCHIVE-RESTORED.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        try:
            register = read_register()
        except CasebookError:
            register = None                 # the rights record still carries the catalog fields
        record, texts = rights_record(manifest, case, plan['write'], plan['withheld'], include_internal, register)
        (temp/'RIGHTS.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        if texts:
            (temp/RESERVED_DIR).mkdir()
            for name, src in texts:
                shutil.copyfile(src, temp/RESERVED_DIR/name)
        temp.rename(target)
        temp = None
    finally:
        for z in opened.values():
            z.close()
        if temp:
            shutil.rmtree(temp)
    return target


def restore_warnings(report):
    """Human-readable notes about what restore changed or could not provide."""
    out = []
    if report.get('homeRewrites'):
        out.append(f'{len(report["homeRewrites"])} 处原本经家目录解析的路径已改写到还原目录或 Lemo 库'
                   '（明细见 ARCHIVE-RESTORED.json 的 homeRewrites）。')
    if report.get('relatedCases'):
        out.append('脚本还引用了其他案例的文件，请用同一个 --out 一并还原：' + '、'.join(report['relatedCases']))
    for item in report.get('notArchived', []):
        out.append(f'{item["file"]}:{item["line"]} 引用的 {item["path"]} 没有归档，已改写到还原目录内，需要时自行放入。')
    for item in report.get('externalHomePaths', []):
        out.append(f'{item["file"]}:{item["line"]} 仍读取真实家目录中的外部依赖（凭据或工具），未改写：{item["reference"]}')
    unresolved = report.get('unresolvedTokens') or [
        {'file': u['file'], 'line': None, 'token': t} for u in report.get('unreplacedTokens', []) for t in u['tokens']]
    if unresolved:
        names = sorted({t['token'] for t in unresolved})
        hint = '（@@ROG_HOST@@ 需要 --rog-host；加 --strict 时会拒绝还原）' if '@@ROG_HOST@@' in names else ''
        places = '、'.join(f'{t["file"]}:{t["line"]}' if t.get('line') else t['file'] for t in unresolved[:8])
        more = f' 等 {len(unresolved)} 处' if len(unresolved) > 8 else ''
        out.append(f'仍含未替换的还原标记 {"、".join(names)}{hint}：{places}{more}（明细见 unresolvedTokens）')
    if report.get('withheld'):
        n = len(report['withheld'])
        out.append(f'{n} 个内部素材没有还原（客户、第三方 IP 或参考图，权利范围见 docs/rights/register.md）；'
                   '只为研究方法时可加 --include-internal，产物不得对外（明细见 withheld）。')
    if report.get('lineEndingsRepaired'):
        out.append(f'{len(report["lineEndingsRepaired"])} 个文件在仓库里被改成了 CRLF，已按归档的 LF 原样写出。' + CRLF_HINT)
    return out


# --- rehash -----------------------------------------------------------------------------------------------

def rehash(manifest, patch, mark=None):
    """Apply a source patch ({files: [{source, oldSha256, newSha256, oldSize, newSize}]}, the format written by
    node tools/compliance/signed-urls.mjs strip --patch-out) to every catalog entry that references each
    source. Each file on disk must already hold the new bytes, and each entry must still record the old ones:
    the catalog only follows edits that were actually made. `mark` (e.g. 'signed-url-query') is added to each
    patched entry's `redactions`, so a reader can tell why sha256 and originalSha256 differ. Returns the
    updated entry count per source."""
    files = patch.get('files') if isinstance(patch, dict) else None
    if not isinstance(files, list) or not files:
        raise CasebookError('补丁里没有 files 列表', hint='用 node tools/compliance/signed-urls.mjs strip --patch-out 生成')
    refs = {}
    for case in manifest['cases']:
        for item in case['files']:
            if 'source' in item:
                refs.setdefault(item['source'], []).append((case['id'], item))
    problems, plan = [], []
    for entry in files:
        try:
            source, old, new = entry['source'], entry['oldSha256'], entry['newSha256']
            old_size, new_size = int(entry['oldSize']), int(entry['newSize'])
        except (KeyError, TypeError, ValueError):
            problems.append(f'补丁条目缺字段（source、oldSha256、newSha256、oldSize、newSize）：{entry!r}'[:200])
            continue
        if source not in refs:
            problems.append(f'{source}: catalog 里没有引用这个源文件')
            continue
        try:
            size, sha = file_digest(safe_path(ARCHIVE, source))
        except (OSError, ValueError) as error:
            problems.append(f'{source}: 读不出来（{error}）')
            continue
        if (size, sha) != (new_size, new):
            problems.append(f'{source}: 磁盘上的文件不是补丁写的新内容（大小 {size}，应为 {new_size}）')
            continue
        for cid, item in refs[source]:
            if (item['size'], item['sha256']) == (new_size, new):
                if mark and mark not in item.get('redactions', ()):
                    plan.append((source, item, new_size, new))
                continue                     # already applied: rerunning the same patch changes nothing
            if (item['size'], item['sha256']) != (old_size, old):
                problems.append(f'{cid}/{item["path"]}: catalog 记录的既不是补丁的旧值也不是新值')
                continue
            plan.append((source, item, new_size, new))
    if problems:
        raise CheckFailed(problems)
    counts = {}
    for source, item, size, sha in plan:
        item['size'], item['sha256'] = size, sha
        if mark and mark not in item.setdefault('redactions', []):
            item['redactions'].append(mark)
        counts[source] = counts.get(source, 0) + 1
    return counts


def write_manifest(manifest, path=None):
    """Write catalog.json atomically with the archive's fixed formatting (indent 2, UTF-8, no trailing newline)."""
    path = path or ARCHIVE / 'catalog.json'
    body = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(body)
    tmp.replace(path)
    return digest(body)


# --- index: views generated from the catalog ---------------------------------------------------------------
# cases/entries/<id>.md、cases/INDEX.md、cases/index.html 的数据与 cases/NOTICES.md 的署名段都由 catalog 生成（index 命令），
# 不要手改；index --check 核对它们是最新的（规范检查 cases.index 调用同一条命令）。

GROUPS = [   # (分组, 小节标题, 小节说明；{site} = 上站数量，{n} = 记录数)
    ('styles', '北冥代码动画风格 · {n} 部风格实验', '{site_sentence}每部 18 到 20 秒，同一套代码骨架换一组笔触与材质。'),
    ('ppt-stories', 'PPT 故事介绍片 · {n} 部', '{site_sentence}做法见 [PPT 怎样变成代码动画](../docs/cases/ppt-animation.md)。'),
    ('ppt-keynote', '发布会动画 · {works} 个工程与 {support} 组共用资源', '{site} 个工程在作品站展示；共用资源只在归档里。'),
    ('beiming-labs', '北冥画风实验 · {n} 组', '不上站：画风实验和未获认可的试作。'),
    ('local-films', '其他动画与预演 · {n} 个', '不上站：其他题材的成片、交互页面实验和技术预演。'),
]
TECH_LABEL = {'rendered': '历史成片', 'experiment': '画风实验', 'previs': '技术预演', 'interactive': '交互实验', 'support': '共用资源'}
CARD_LABEL = {'rendered': '历史成片·{date} 归档时未重渲', 'experiment': '画风实验·非正式成片', 'previs': '技术预演·非正式作品',
              'interactive': '交互/页面实验', 'support': '共用资源'}
APPROVAL_LABEL = {'approved': '用户认可', 'rejected': '未获认可', 'unreviewed': '未审'}
CLEARANCE_LABEL = {'public': '公开', 'internal': '内部', 'client-confidential': '客户保密'}
SITE_URL = 'https://cuiyucheng0104-afk.github.io/beiming-engine/'
WORKS_META = ROOT / 'site' / 'data' / 'works-meta.json'      # 作品站的策展数据（只读）：上站作品的片名与画风名
PY_CMD = 'node tools/env/py.mjs tools/casebook.py'
ATTRIBUTION_START = '<!-- casebook index:署名 开始（由 tools/casebook.py index 生成，不要手改） -->'
ATTRIBUTION_END = '<!-- casebook index:署名 结束 -->'


def fmt_seconds(value):
    text = f'{round(value, 2):.2f}'.rstrip('0').rstrip('.')
    return text or '0'


def fmt_duration_label(seconds):
    """19.79 秒 / 3 分 14.52 秒 / 3 分 / —（观看版的长度）。"""
    if not seconds:
        return '—'
    minutes, rest = divmod(round(seconds, 2), 60)
    rest = round(rest, 2)
    if minutes and not rest:
        return f'{int(minutes)} 分'
    return (f'{int(minutes)} 分 ' if minutes else '') + f'{fmt_seconds(rest)} 秒'


def md_target(path):
    """A relative link target that Markdown parses: spaces and brackets percent-encoded, the rest as written."""
    return ''.join({' ': '%20', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E'}.get(ch, ch) for ch in path)


def md_cell(text):
    return str(text).replace('|', '\\|').replace('\n', ' ')


def read_works_meta():
    try:
        return json.loads(WORKS_META.read_text(encoding='utf-8')).get('works') or {}
    except (OSError, ValueError):
        return {}


def case_title(case, site):
    return ((site.get(case['id']) or {}).get('title') or case.get('displayTitle') or case['title']).strip()


def approval_text(case):
    appr = case.get('approval') or {}
    status = appr.get('status', 'unreviewed')
    if status == 'unreviewed':
        return '未审：仓库里没有用户认可的记录；上作品站不等于用户认可'
    if status == 'rejected':
        reasons = '；'.join(appr.get('reasons') or [PENDING_REASON])
        return f'未获认可：{reasons}（记录人：{appr.get("by") or PENDING}；日期：{appr.get("date") or PENDING}）'
    return f'用户认可（{appr.get("by")}，{appr.get("date")}）'


def render_card(manifest, case, site):
    cid, tech = case['id'], (case.get('technical') or {}).get('status')
    appr = (case.get('approval') or {}).get('status', 'unreviewed')
    rights = case.get('rights') or {}
    label = '画面效果未获认可' if appr == 'rejected' else CARD_LABEL[tech].format(date=manifest.get('date', PENDING))
    L = [f'# {case["title"]}', '', f'**{label}** · `{cid}`', '']
    if case.get('summary'):
        L += [case['summary'], '']
    if case.get('poster'):
        L += [f'![历史画面](../{case["poster"]})', '']
    if case.get('preview'):
        L += [f'[观看/下载压缩预览]({case["preview"]["url"]}) · 历史成片转码，非重新渲染。', '']
    if case.get('notes'):
        L += [*case['notes'], '']
    qa = ((case.get('technical') or {}).get('qa') or {}).get('status', 'not-run')
    tech_text = TECH_LABEL[tech] + ('（归档时未重渲' if tech == 'rendered' else '（') + \
        ('；机器 QA 未跑）' if qa == 'not-run' else f'；机器 QA：{qa}）')
    tech_text = tech_text.replace('（；', '（')
    L += ['## 状态与权利', '', '| 项 | 记录 |', '|---|---|', f'| 技术状态 | {tech_text} |',
          f'| 用户认可 | {md_cell(approval_text(case))} |']
    evidence = (case.get('approval') or {}).get('evidence') or []
    if evidence:
        L.append(f'| 认可记录出处 | {md_cell("；".join(evidence))} |')
    for line in (case.get('approval') or {}).get('history') or []:
        L.append(f'| 认可经过 | {md_cell(line)} |')
    clearance = rights.get('clearance', 'public')
    if clearance == 'public':
        right_text = '公开归档' + ('（个别素材标为内部，restore 默认不还原，见 catalog 的文件条目）'
                                   if any(f.get('clearance') for f in case['files']) else '')
    else:
        right_text = (f'{CLEARANCE_LABEL[clearance]}：含客户材料、第三方 IP 或参考图，权利方 {rights.get("owner") or PENDING}；'
                      'restore 默认不还原其素材，产物不得用进新作品或对外物料')
    L.append(f'| 权利 | {md_cell(right_text)} |')
    if rights.get('register'):
        L.append(f'| 登记类别 | {"、".join(rights["register"])}（[授权登记册](../../docs/rights/register.md)） |')
    for line in rights.get('attributionText') or []:
        L.append(f'| 署名 | {md_cell(line)} |')
    ai = rights.get('aiGenerated') or {}
    if ai.get('present') is True:
        L.append(f'| AI 生成 | 含（{"、".join(ai.get("register") or [])}；工具与版本{ai.get("tools") or PENDING}） |')
    L += ['', '## 源码与还原', '', '```bash', f'{PY_CMD} restore {cid} --download', '```', '',
          f'还原位置：`out/casebook/{case["workspacePath"]}/`。只看代码可加 `--source-only`；先看要下载多少可加 `--dry-run`。'
          '命令不运行构建。' + ('内部素材默认不还原，只为研究方法时加 `--include-internal`。' if clearance != 'public' else ''),
          '', '| 入口 | 归档原文件 |', '|---|---|']
    by_path = {f['path']: f for f in case['files']}
    for path in [*case['entrypoints'], *case.get('keyFiles', ())]:
        item = by_path[path]
        link = f'[查看](../{md_target(item["source"])})' if 'source' in item else '素材包内'
        L.append(f'| `{path}` | {link} |')
    req = '；'.join(case.get('requirements') or []) or '见本工程说明与依赖文件。'
    L += ['', f'运行前核对：{req}', '',
          '历史脚本含本机路径还原标记。还原会替换工作区和Lemo库路径；网络服务、API、外部采样、Windows远端和旧版构建命令仍需按项目准备。'
          '`@@ROG_HOST@@` 需用 `--rog-host` 指定才会替换；加 `--strict` 时有未替换的标记就拒绝还原。', '']
    if case.get('artifacts'):
        L += ['## 保留的成片版本', '', '| 文件 | 尺寸 / 秒 | 原文件包 | SHA256 |', '|---|---|---|---|']
        packs = {p['filename']: p for p in manifest['packs']}
        for art in case['artifacts']:
            video = art.get('video') or {}
            size = f'{video.get("width")}×{video.get("height")} / {float(video.get("duration") or 0):.3f}'
            pack = packs.get(art.get('pack'), {})
            L.append(f'| {md_cell(art["filename"])} | {size} | [{art["pack"]}]({pack.get("url", "")})，包内 `{art["member"]}` | `{art["sha256"]}` |')
        L.append('')
    L += ['完整文件映射见 [catalog.json](../catalog.json)。来源与署名见 [NOTICES](../NOTICES.md)，授权状态见 [授权登记册](../../docs/rights/register.md)。', '']
    return '\n'.join(L)


def site_counts(manifest, site):
    on_site = {g: sum(1 for c in manifest['cases'] if c['group'] == g and c['id'] in site) for g, _, _ in GROUPS}
    return on_site, sum(on_site.values())


def render_index(manifest, site):
    cases = manifest['cases']
    on_site, total_site = site_counts(manifest, site)
    support = sum(1 for c in cases if (c.get('technical') or {}).get('status') == 'support')
    groups = {g: [c for c in cases if c['group'] == g] for g, _, _ in GROUPS}
    names = {'styles': '北冥代码动画风格', 'ppt-stories': 'PPT 故事介绍片', 'ppt-keynote': '发布会动画'}
    site_list = '、'.join(f'{names[g]} {on_site[g]}' for g in names if on_site.get(g))
    rejected = sum(1 for c in cases if (c.get('approval') or {}).get('status') == 'rejected')
    approved = sum(1 for c in cases if (c.get('approval') or {}).get('status') == 'approved')
    internal = sum(1 for c in cases if (c.get('rights') or {}).get('clearance', 'public') != 'public')
    L = ['# 北冥案例目录', '',
         f'> 读者：要找某个旧作品、看状态或还原工程的人｜状态：由 `{PY_CMD} index` 从 `cases/catalog.json` 生成，不要手改｜'
         f'依据：catalog 第 {manifest.get("schemaVersion", 1)} 版（{manifest.get("date")} 归档）', '',
         f'共 {len(cases)} 条记录：{len(cases) - support} 个创作与实验工程，加 {support} 组共用资源；不是 {len(cases)} 部正式发布的作品。'
         f'其中 {total_site} 部有观看预览的成片在[作品站]({SITE_URL})展示（{site_list}），其余只在这里归档。', '',
         '上站作品的片名与画风名和作品站一致，取自 `site/data/works-meta.json`；其余记录的片名去掉了工程标题里的“TREATMENT”“处理方案”“风格样片”和秒数。'
         f'原始标题见各案例卡。时长是观看版的长度。案例编号用于 `{PY_CMD} restore <编号>`。', '',
         '每条记录有三个互相独立的状态：',
         '',
         '- **技术状态**：历史成片（已有成片，归档时没有重新渲染）、画风实验、技术预演、交互实验（不是正式成片）、共用资源（几个工程共用的素材，不单独成片）。',
         f'- **用户认可**：用户认可 {approved} 条、未获认可 {rejected} 条（画面效果被否定，不作为合格画风或正式作品）、其余未审（仓库里没有用户认可的记录；上作品站不等于用户认可，挑参考片时不要当成“已认可”）。',
         f'- **权利**：公开或内部。内部 {internal} 条含客户材料、第三方 IP 或参考图（[授权登记册](../docs/rights/register.md)）：`restore` 默认不还原其素材，不得用进新作品或对外物料。',
         '',
         '[画廊](index.html) · [还原方法](README.md) · [两套完整风格库](vendor/README.md) · [对比与去重](../docs/cases/comparison.md) · [案例库工具](../docs/cases/casebook.md)', '']
    for group, title, intro in GROUPS:
        rows = groups[group]
        if not rows:
            continue
        works = sum(1 for c in rows if (c.get('technical') or {}).get('status') != 'support')
        site_sentence = '全部在作品站展示。' if on_site[group] == len(rows) else (
            f'{on_site[group]} 部在作品站展示。' if on_site[group] else '不上站。')
        fill = dict(n=len(rows), works=works, support=len(rows) - works, site=on_site[group], site_sentence=site_sentence)
        L += [f'## {title.format(**fill)}', '', intro.format(**fill), '']
        style_col = group == 'styles'
        L.append('| 片名 | ' + ('画风 | ' if style_col else '') + '时长 | 技术状态 | 用户认可 | 权利 | 案例编号 |')
        L.append('|---|' + ('---|' if style_col else '') + '---:|---|---|---|---|')
        for c in rows:
            tech = (c.get('technical') or {}).get('status')
            appr = (c.get('approval') or {}).get('status', 'unreviewed')
            row = [f'[{md_cell(case_title(c, site))}](entries/{c["id"]}.md)']
            if style_col:
                row.append(md_cell((site.get(c['id']) or {}).get('styleName') or '—'))
            row += [fmt_duration_label((c.get('preview') or {}).get('duration')), TECH_LABEL[tech], APPROVAL_LABEL[appr],
                    CLEARANCE_LABEL[(c.get('rights') or {}).get('clearance', 'public')], f'`{c["id"]}`']
            L.append('| ' + ' | '.join(row) + ' |')
        L.append('')
    L += render_sy_section()
    return '\n'.join(L)


def render_sy_section():
    """sy-style-100 的 20 种风格（两期示例）：第三方方法库，不是本仓库的成片。"""
    try:
        refs = json.loads((ARCHIVE / 'references.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    demos = [e for e in refs.get('examples', ()) if e.get('repository') == 'sy' and e.get('category') == 'style-demo']
    vol1 = {e['id'].split('/')[-1]: e for e in demos if e['id'].startswith('styles/')}
    vol2 = {e['id'].split('/')[-1]: e for e in demos if e['id'].startswith('vol2/styles/')}
    if not vol1:
        return []
    repo = next((r for r in refs.get('repositories', ()) if r.get('id') == 'sy'), {})
    L = [f'## 方法库 · sy-style-100 的 {len(vol1)} 种风格', '',
         f'不是本仓库的成片：第三方开源风格库（{repo.get("license", "MIT")}）在 `{repo.get("commit", "")[:8]}` 的固定快照，只读，用来学画法；'
         '每种风格两期示例，浏览器直接打开 `index.html` 就能循环播放。lemo-opuscar 的 66 种风格就是上面的 66 部风格实验（案例的 `upstreamStyle`）。'
         '两库合起来的选型与移植表见 [C 路线风格索引](../routes/c-style/STYLES.md)。', '',
         '| 编号 | 风格 | 第一期示例 | 第二期示例 |', '|---|---|---|---|']
    for key in sorted(vol1):
        number, _, rest = vol1[key]['title'].partition(' ')
        name = rest.split(' · ')[0]
        first = f'[{md_cell(rest.split(" · ", 1)[-1])}](vendor/sy-style-100/styles/{key}/index.html)'
        second = (f'[{md_cell(vol2[key]["title"].split(" · ", 1)[-1])}](vendor/sy-style-100/vol2/styles/{key}/index.html)'
                  if key in vol2 else '—')
        L.append(f'| {number} | {md_cell(name)} | {first} | {second} |')
    L.append('')
    return L


def render_gallery(manifest, site, template):
    """cases/index.html：模板不变，只换 const DATA=[…]; 一行的数据。"""
    data = []
    for c in manifest['cases']:
        tech = (c.get('technical') or {}).get('status')
        appr = (c.get('approval') or {}).get('status', 'unreviewed')
        clearance = (c.get('rights') or {}).get('clearance', 'public')
        status = '画面效果未获认可' if appr == 'rejected' else TECH_LABEL[tech] + ' · ' + APPROVAL_LABEL[appr]
        if clearance != 'public':
            status += ' · 内部素材'
        preview = c.get('preview') or {}
        data.append({'id': c['id'], 'title': case_title(c, site), 'group': c['group'], 'status': status,
                     'poster': c.get('poster'), 'preview': preview.get('url'),
                     'duration': round(preview['duration'], 1) if preview.get('duration') else 0})
    head, sep, rest = template.partition('const DATA=')
    if not sep:
        raise CasebookError('cases/index.html 里找不到 const DATA=，模板被改坏了', hint='git checkout -- cases/index.html')
    end = rest.find('];')
    return head + sep + json.dumps(data, ensure_ascii=False) + rest[end + 1:]


def render_notices(manifest, current):
    """cases/NOTICES.md：手写正文不动，只重写两个标记之间的署名段（CC BY 署名原文，按案例汇总）。"""
    if ATTRIBUTION_START not in current or ATTRIBUTION_END not in current:
        raise CasebookError('cases/NOTICES.md 缺署名段的起止标记', hint=f'在文中放一对 {ATTRIBUTION_START} … {ATTRIBUTION_END}')
    lines = {}
    for c in manifest['cases']:
        for text in (c.get('rights') or {}).get('attributionText') or []:
            lines.setdefault(text, []).append(c['id'])
    body = ['', '| 署名原文（照录案例 CREDITS） | 用到的案例 |', '|---|---|']
    for text, ids in sorted(lines.items()):
        body.append(f'| {md_cell(text)} | {"、".join(f"[{i}](entries/{i}.md)" for i in ids)} |')
    body.append('')
    head = current[:current.index(ATTRIBUTION_START) + len(ATTRIBUTION_START)]
    tail = current[current.index(ATTRIBUTION_END):]
    return head + '\n'.join(body) + '\n' + tail


def index_outputs(manifest):
    """{path relative to cases/: generated text} for every view the index command owns."""
    site = read_works_meta()
    out = {f'entries/{c["id"]}.md': render_card(manifest, c, site) for c in manifest['cases']}
    out['INDEX.md'] = render_index(manifest, site)
    try:
        out['index.html'] = render_gallery(manifest, site, (ARCHIVE / 'index.html').read_text(encoding='utf-8'))
        out['NOTICES.md'] = render_notices(manifest, (ARCHIVE / 'NOTICES.md').read_text(encoding='utf-8'))
    except FileNotFoundError as error:
        raise CasebookError(f'缺生成模板 {error.filename}', hint='git checkout -- cases/index.html cases/NOTICES.md')
    return out


def index_drift(manifest):
    """(stale, extra, outputs): generated views (paths relative to cases/) that differ from the files on disk,
    and cards without a catalog record."""
    outputs = index_outputs(manifest)
    stale = []
    for rel, text in outputs.items():
        try:
            if (ARCHIVE / rel).read_bytes() != text.encode('utf-8'):
                stale.append(rel)
        except OSError:
            stale.append(rel)
    cards = {f'entries/{p.name}' for p in (ARCHIVE / 'entries').glob('*.md')}
    extra = sorted(cards - set(outputs))
    return stale, extra, outputs


def cmd_index(args, ctx, manifest):
    stale, extra, outputs = index_drift(manifest)
    shown = lambda rel: shown_path(ARCHIVE / rel)      # noqa: E731  repository-relative when inside the repository
    stale, extra = [shown(r) for r in stale], [shown(r) for r in extra]
    outputs = {shown(r): t for r, t in outputs.items()}
    if args.verify:
        if stale or extra:
            for rel in stale:
                err_print(ctx, f'过期：{rel}')
            for rel in extra:
                err_print(ctx, f'多余：{rel}（catalog 里没有这个案例）')
            return {'error': {'code': 'contract.index-stale', 'message': f'{len(stale)} 个生成文件与 catalog 不一致，{len(extra)} 张多余的案例卡',
                              'hint': f'运行 {PY_CMD} index 重新生成（不要手改这些文件）'},
                    'data': {'stale': stale, 'extra': extra}}
        ctx.out(f'生成的 {len(outputs)} 个文件都是最新的')
        return {'data': {'stale': [], 'extra': [], 'files': len(outputs)}}
    if args.dry_run:
        ctx.out(f'演练（未写文件）：{len(stale)} 个文件会更新' + (f'，{len(extra)} 张多余的案例卡要人工处理' if extra else ''))
        for rel in stale:
            ctx.out(f'  {rel}')
        return {'data': {'stale': stale, 'extra': extra, 'dryRun': True}}
    written = []
    for rel in stale:
        p = Path(rel) if Path(rel).is_absolute() else ROOT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + '.tmp')
        tmp.write_bytes(outputs[rel].encode('utf-8'))
        tmp.replace(p)
        written.append({'path': rel, 'sha256': digest(outputs[rel].encode('utf-8')), 'kind': 'doc'})
    for rel in extra:
        ctx.warn('cases.extra-card', f'{rel} 没有对应的 catalog 记录，未删除', '确认后手动删除，或在 catalog 里补上这个案例')
    ctx.out(f'已更新 {len(written)} 个文件（共生成 {len(outputs)} 个）' if written else f'生成的 {len(outputs)} 个文件都是最新的')
    return {'data': {'stale': stale, 'extra': extra, 'files': len(outputs)}, 'outputs': written}


# --- command line -----------------------------------------------------------------------------------------

COMMANDS = ('list', 'check', 'restore', 'rehash', 'rights', 'index')
# 每个选项只对这些命令有意义；用错命令时退出 2（docs/CLI.md 第 3 节：严格）
OPTION_COMMANDS = {
    'group': {'list'},
    'out': {'restore'}, 'packs': {'restore'}, 'download': {'restore'}, 'source_only': {'restore'},
    'lemo': {'restore'}, 'rog_host': {'restore'}, 'reverify': {'restore'}, 'mirror': {'restore'},
    'retries': {'restore'}, 'if_exists': {'restore'}, 'include_internal': {'restore'}, 'strict': {'restore'},
    'dry_run': {'restore', 'rehash', 'index'}, 'patch': {'rehash'}, 'mark': {'rehash'},
    'rights': {'check'}, 'write': {'rights'}, 'verify': {'rights', 'index'},
}
EPILOG = '''示例：
  node tools/env/py.mjs tools/casebook.py list --group ppt-stories
  node tools/env/py.mjs tools/casebook.py check --json
  node tools/env/py.mjs tools/casebook.py restore style-02-watercolor --source-only
  node tools/env/py.mjs tools/casebook.py restore style-02-watercolor --download --dry-run
  node tools/env/py.mjs tools/casebook.py rehash --patch out/signed-urls.patch.json --mark signed-url-query
  node tools/env/py.mjs tools/casebook.py rights --check
  node tools/env/py.mjs tools/casebook.py index --check

退出码：0 成功（只有提示也算）；1 运行失败（读写出错、工具内部错误）；2 用法错误（未知选项、
  --group 拼错、案例编号不存在、目标目录已存在、路径含不安全字符）；3 环境问题（缺素材包、
  下载中断或网络不通、磁盘空间不够、--strict 下有未替换的还原标记）；4 核对不通过（校验和不符、
  目录或快照有问题、补丁对不上）；130 / 143 被中断（已删掉临时目录，下载的 .partial 保留以便续传）。
完整说明：docs/cases/casebook.md；命令约定：docs/CLI.md。'''


class _Formatter(argparse.RawDescriptionHelpFormatter):
    def add_usage(self, usage, actions, groups, prefix=None):
        return super().add_usage(usage, actions, groups, '用法：' if prefix is None else prefix)


class Parser(ArgumentParser):
    def format_usage(self):          # cli.run 自己会在前面加「用法：」
        formatter = self._get_formatter()
        formatter.add_usage(self.usage, self._actions, self._mutually_exclusive_groups, prefix='')
        return formatter.format_help()


def build_parser():
    p = Parser(prog='python tools/casebook.py', formatter_class=_Formatter, epilog=EPILOG, add_help=False,
               usage='python tools/casebook.py <命令> [案例编号] [选项]',
               description='北冥案例库：查看、核对、还原去重后的历史案例归档；不执行构建、安装或渲染。\n\n'
                           '命令：\n'
                           '  list                     列出案例：编号、状态、标题（--group 只列一组）\n'
                           '  check                    核对 catalog、源文件、素材引用、案例卡与两套 vendor 快照；\n'
                           '                           收集全部问题后再退出，通过时打印记录数、源文件数与 vendor 文件数\n'
                           '  restore <案例编号>        还原到独立目录（默认 out/casebook/）；不覆盖已有目录、\n'
                           '                           不执行构建；默认不还原内部素材（--include-internal）\n'
                           '  rehash --patch <补丁>     按补丁更新源文件的 sha256 与大小（先核对旧值与磁盘上的新内容）\n'
                           '  rights [--write|--check]  按 docs/rights/register.json 算每个案例的权利字段（clearance、登记类别、\n'
                           '                           署名、AI 生成）；--write 写回 catalog.json，--check 不一致时退出 4\n'
                           '  index [--check]          由 catalog 生成案例卡、INDEX.md、画廊数据与 NOTICES 署名段；--check 只核对')
    p._optionals.title = '选项'
    p._positionals.title = '位置参数'
    p.add_argument('-h', '--help', action='help', help='显示本说明并退出（不读目录、不写文件）')
    p.add_argument('command', choices=COMMANDS, metavar='<命令>', help='list、check、restore、rehash、rights、index')
    p.add_argument('case', nargs='?', metavar='案例编号', help='restore 要还原的案例（list 第一列）')
    g = p.add_argument_group('check')
    g.add_argument('--rights', action='store_true', help='另核对 rights 字段与授权登记册一致、公开素材包不含内部素材')
    g = p.add_argument_group('list')
    g.add_argument('--group', metavar='<分组>', help='只列这一组：styles、ppt-stories、ppt-keynote、beiming-labs、local-films')
    g = p.add_argument_group('restore')
    g.add_argument('--out', type=Path, default=ROOT / 'out/casebook', metavar='<目录>',
                   help='还原到这里（代替原机家目录，案例按 workspacePath 落在其下）；默认 out/casebook')
    g.add_argument('--packs', type=Path, default=ROOT / 'out/casebook-packs', metavar='<目录>',
                   help='素材包所在目录；默认 out/casebook-packs')
    g.add_argument('--download', action='store_true', help='缺素材包时从 Release 下载（流式校验 SHA256，断点续传）')
    g.add_argument('--mirror', metavar='<网址>', help='从镜像下载：<网址>/<包名>；任何来源都按 catalog 的 SHA256 校验')
    g.add_argument('--retries', type=int, default=3, metavar='<次数>', help='下载中断或网络出错时的重试次数；默认 3')
    g.add_argument('--source-only', action='store_true', help='只还原源码，不取素材包')
    g.add_argument('--include-internal', action='store_true',
                   help='同时还原内部素材（客户、第三方 IP、参考图）；只为研究方法，产物不得对外')
    g.add_argument('--if-exists', choices=('fail', 'skip'), default='fail', metavar='<fail|skip>',
                   help='目标目录已存在时：fail 退出 2（默认），skip 跳过并退出 0')
    g.add_argument('--strict', action='store_true', help='有未替换的还原标记（如 @@ROG_HOST@@）时拒绝还原，退出 3')
    g.add_argument('--lemo', type=Path, metavar='<目录>', help='@@LEMO_ROOT@@ 指向的 lemo-opuscar；默认仓库内 cases/vendor/lemo-opuscar')
    g.add_argument('--rog-host', metavar='<主机>', help='@@ROG_HOST@@ 的值（旧脚本里远端工作站的地址）')
    g.add_argument('--reverify', action='store_true', help='素材包即使校验过也重新计算 SHA256')
    g.add_argument('--dry-run', action='store_true', help='只报告会写什么、要下载多少、需要多少磁盘，不写盘不联网')
    g = p.add_argument_group('rehash')
    g.add_argument('--patch', type=Path, metavar='<补丁.json>', help='源文件补丁（signed-urls.mjs strip --patch-out 的输出）')
    g.add_argument('--mark', metavar='<标签>', help='给改过的条目记一笔 redactions（如 signed-url-query），说明哈希为什么变了')
    g = p.add_argument_group('rights / index')
    x = g.add_mutually_exclusive_group()
    x.add_argument('--write', action='store_true', help='把算出的权利字段写回 cases/catalog.json')
    x.add_argument('--check', dest='verify', action='store_true',
                   help='rights、index：只核对（权利字段或生成文件过期时退出 4），不写文件')
    return p


DEFAULTS = {action.dest: action.default for action in build_parser()._actions}


def usage_error(code, message, hint=None):
    return CliError(f'usage.{code}', message, hint=hint)


def validate_options(args):
    for dest, commands in OPTION_COMMANDS.items():
        if getattr(args, dest) != DEFAULTS.get(dest) and args.command not in commands:
            flag = '--' + dest.replace('_', '-')
            raise usage_error('option-not-applicable', f'{flag} 只用于 {"、".join(sorted(commands))}，不用于 {args.command}',
                              '全部选项与适用的命令见 --help')
    if args.case and args.command != 'restore':
        raise usage_error('unexpected-argument', f'{args.command} 不接受案例编号：{args.case}', '只有 restore 需要案例编号')
    if args.command == 'restore' and not args.case:
        raise usage_error('missing-argument', 'restore 需要案例编号', '先运行 list 看案例编号，例如 restore style-02-watercolor')
    if args.command == 'rehash' and not args.patch:
        raise usage_error('missing-argument', 'rehash 需要 --patch <补丁.json>', '补丁由 node tools/compliance/signed-urls.mjs strip --patch-out 生成')
    if args.retries < 0 or args.retries > 20:
        raise usage_error('bad-value', f'--retries 要在 0 到 20 之间，现在是 {args.retries}')
    if args.mark is not None and not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', args.mark):
        raise usage_error('bad-value', f'--mark 用小写 kebab-case 标签：{args.mark}', '例：--mark signed-url-query')
    if args.mirror and not re.match(r'https?://[^/\s]+', args.mirror):
        raise usage_error('bad-value', f'--mirror 要写 http:// 或 https:// 开头的网址：{args.mirror}',
                          '本机已下载的素材包用 --packs <目录>，不用 --mirror')


def suggest(value, choices):
    close = difflib.get_close_matches(value, choices, n=3, cutoff=0.5)
    return f'是不是想写 {"、".join(close)}？' if close else ''


def load_catalog():
    try:
        return read_manifest()
    except FileNotFoundError:
        raise CliError('env.catalog-missing', f'找不到案例目录 {shown_path(ARCHIVE / "catalog.json")}',
                       hint='在完整的仓库检出里运行（cases/ 目录随仓库一起提供）')
    except ValueError as error:
        raise CliError('contract.catalog-invalid', f'cases/catalog.json 不是合法的 JSON：{error}',
                       hint='git checkout -- cases/catalog.json 恢复后再试')


def as_cli_error(error):
    """Map a library exception to the CliError the command reports (code prefix → exit status)."""
    hint = getattr(error, 'hint', None)
    if isinstance(error, CliError):
        return error
    if isinstance(error, CasebookError):
        return CliError(error.code, str(error).split('\n', 1)[0] if isinstance(error, CheckFailed) else str(error), hint=hint)
    if isinstance(error, FileExistsError):
        return CliError('usage.target-exists', str(error), hint='换一个 --out，或加 --if-exists skip 跳过已还原的案例')
    if isinstance(error, FileNotFoundError):
        return CliError('env.missing-pack', str(error), hint='加 --download 下载，或用 --packs 指向已下载素材包的目录')
    if isinstance(error, DownloadInterrupted):
        return CliError('env.download-interrupted', str(error), hint='网络恢复后重新运行同一条命令，会从断点续传')
    if isinstance(error, urllib.error.HTTPError):
        return CliError('env.download-failed', f'下载失败：HTTP {error.code} {error.reason}（{error.url}）',
                        hint='Release 附件不可用时可用 --mirror 指定镜像')
    if isinstance(error, (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, http.client.HTTPException)):
        return CliError('env.network', f'网络错误：{getattr(error, "reason", error)}', hint='检查网络或代理后重试；也可以用 --mirror')
    if isinstance(error, zipfile.BadZipFile):
        return CliError('contract.bad-pack', f'素材包不是有效的 zip：{error}', hint='删掉这个包后加 --download 重新下载')
    if isinstance(error, ValueError):
        return CliError('contract.invalid', str(error), hint=hint)
    if isinstance(error, OSError):
        return CliError('failure.io', f'读写失败：{error}', hint='检查目录权限与磁盘')
    return error


def err_print(ctx, text):
    """Always-printed detail lines on the command's stderr (cli.run hands its streams to the context)."""
    print(text, file=getattr(ctx, '_stderr', None) or sys.stderr)


def cmd_list(args, ctx, manifest):
    groups = groups_of(manifest)
    if args.group is not None and args.group not in groups:
        raise usage_error('bad-group', f'没有这个分组：{args.group}', f'{suggest(args.group, groups)}可选：{"、".join(groups)}')
    rows = [c for c in manifest['cases'] if args.group is None or c['group'] == args.group]
    for c in rows:
        mark = '' if case_clearance(c) == 'public' else '  [内部]'
        ctx.out(f'{c["id"]:42} {c["status"]:18} {c["title"]}{mark}')
    ctx.log(f'共 {len(rows)} 条' + (f'（分组 {args.group}）' if args.group else f'，分组：{"、".join(groups)}'))
    keys = ('id', 'group', 'status', 'title', 'workspacePath', 'technical', 'approval')
    return {'data': {'count': len(rows), 'groups': groups, 'cases': [
        dict({k: c[k] for k in keys if k in c}, clearance=case_clearance(c), preview=(c.get('preview') or {}).get('url'),
             poster=c.get('poster')) for c in rows]}}


def cmd_check(args, ctx, manifest):
    summary = {}
    try:
        records, sources = check(manifest, summary, rights=args.rights)
    except CheckFailed as failed:
        for problem in failed.problems:
            err_print(ctx, f'问题：{problem}')
        for line in summary.get('notices', []):
            ctx.warn('cases.notice', line)
        return {'error': {'code': failed.code, 'message': f'案例库核对不通过：{len(failed.problems)} 处问题（逐条见上方「问题：」）',
                          'hint': '按每条问题修正；归档文件被改动时用 git checkout -- cases 恢复'},
                'data': dict(_summary_data(summary), problems=failed.problems)}
    for line in summary['notices']:
        ctx.warn('cases.notice', line)
    modes = {'checked': '、执行位', 'skipped': '（执行位已跳过，见提示）'}.get(summary.get('fileModes'), '')
    ctx.out(f'通过：{records} 条记录、{sources} 个唯一源文件、{summary.get("vendorFiles", 0)} 个 vendor 文件'
            f'（{summary.get("vendorRepos", 0)} 个快照）；已核对路径、SHA256、素材引用、案例卡、家目录路径'
            f'与 vendor 快照（清单、字节、Git blob{modes}）' + ('；权利字段与授权登记册一致' if args.rights else ''))
    return {'data': dict(_summary_data(summary), problems=[])}


def _summary_data(summary):
    return {'records': summary.get('records'), 'uniqueSourceFiles': summary.get('sources'),
            'vendorFiles': summary.get('vendorFiles'), 'vendorRepos': summary.get('vendorRepos'),
            'fileModes': summary.get('fileModes'), 'notices': summary.get('notices', [])}


class Progress:
    """Throttled download progress on stderr: at most every 5 % or 2 seconds per pack."""

    def __init__(self, ctx, clock=time.monotonic):
        self.ctx, self.clock, self.last = ctx, clock, {}

    def __call__(self, meta, have, total):
        name = meta['filename']
        pct = int(have * 100 / total) if total else 100
        last_pct, last_t = self.last.get(name, (-5, 0.0))
        now = self.clock()
        if have >= total or pct >= last_pct + 5 or now - last_t >= 2:
            self.last[name] = (pct, now)
            self.ctx.log(f'下载 {name}：{pct}%（{fmt_bytes(have)} / {fmt_bytes(total)}）')


def restore_data(plan, args, skipped=False, report=None):
    case = plan['case']
    data = {'case': case['id'], 'target': shown_path(plan['target']), 'skipped': skipped, 'dryRun': bool(args.dry_run),
            'clearance': case_clearance(case), 'includeInternal': args.include_internal, 'sourceOnly': args.source_only,
            'files': len(plan['write']), 'bytes': plan['bytes'], 'withheld': len(plan['withheld']),
            'packs': plan['packs'], 'missingPacks': plan['missingPacks'], 'downloadBytes': plan['downloadBytes']}
    if report is not None:
        data.update(unresolvedTokens=report.get('unresolvedTokens', []), relatedCases=report.get('relatedCases', []),
                    tokens=sorted(report.get('tokens', {})))
    return data


def cmd_restore(args, ctx, manifest):
    ids = [c['id'] for c in manifest['cases']]
    if args.case not in ids:
        raise usage_error('unknown-case', f'没有这个案例：{args.case}', f'{suggest(args.case, ids)}全部编号见 list')
    plan = plan_restore(manifest, args.case, args.out, args.packs, args.source_only, args.include_internal)
    target = plan['target']
    if target.exists():
        if args.if_exists != 'skip':
            raise CliError('usage.target-exists', f'目标目录已存在，不覆盖：{shown_path(target)}',
                           hint='换一个 --out，或加 --if-exists skip 跳过已还原的案例')
        try:
            previous = json.loads((target / 'ARCHIVE-RESTORED.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            previous = None
        if not previous or previous.get('case') != args.case:
            ctx.warn('cases.skip-foreign', f'{shown_path(target)} 已存在，但不是 {args.case} 的还原结果（没有对应的 ARCHIVE-RESTORED.json）；照样跳过')
        ctx.out(f'已存在，跳过：{shown_path(target)}')
        return {'data': restore_data(plan, args, skipped=True, report=previous)}
    if args.dry_run:
        ctx.out(f'演练（未写文件）：{args.case} → {shown_path(target)}')
        ctx.out(f'  写入 {len(plan["write"])} 个文件，共 {fmt_bytes(plan["bytes"])}；'
                f'不还原的内部素材 {len(plan["withheld"])} 个')
        ctx.out(f'  素材包 {len(plan["packs"])} 个' + (f'，其中缺 {len(plan["missingPacks"])} 个（{fmt_bytes(plan["downloadBytes"])}，'
                                                    f'{"会下载" if args.download else "需要 --download"}）' if plan['missingPacks'] else ''))
        return {'data': restore_data(plan, args)}
    if plan['missingPacks'] and not args.download:
        raise CliError('env.missing-pack', f'缺 {len(plan["missingPacks"])} 个素材包（{fmt_bytes(plan["downloadBytes"])}）：'
                       f'{"、".join(plan["missingPacks"])}，不在 {shown_path(args.packs)}',
                       hint='加 --download 下载（可先加 --dry-run 看要多少磁盘），或用 --packs 指向已下载的目录；只看代码加 --source-only')
    target = restore(manifest, args.case, args.out, args.packs, args.download, args.source_only, args.lemo, args.rog_host,
                     args.reverify, include_internal=args.include_internal, strict=args.strict, mirror=args.mirror,
                     retries=args.retries, progress=Progress(ctx), log=ctx.log)
    report_path = target / 'ARCHIVE-RESTORED.json'
    report = json.loads(report_path.read_text(encoding='utf-8'))
    ctx.out(shown_path(target))
    for line in restore_warnings(report):
        ctx.warn('cases.restore', line)
    return {'data': restore_data(plan, args, report=report),
            'outputs': [{'path': shown_path(report_path), 'sha256': digest(report_path.read_bytes()), 'kind': 'report'}]}


def cmd_rehash(args, ctx, manifest):
    try:
        patch = json.loads(args.patch.read_text(encoding='utf-8'))
    except OSError as error:
        raise CliError('usage.bad-patch', f'读不了补丁 {args.patch}：{error}')
    except ValueError as error:
        raise CliError('usage.bad-patch', f'补丁不是合法的 JSON：{error}')
    try:
        counts = rehash(manifest, patch, args.mark)
    except CheckFailed as failed:
        for problem in failed.problems:
            err_print(ctx, f'问题：{problem}')
        return {'error': {'code': failed.code, 'message': f'补丁对不上：{len(failed.problems)} 处（逐条见上方「问题：」），catalog 未改',
                          'hint': '先核对补丁与 cases/source 下的文件；补丁只接受「catalog 记录旧值、磁盘上是新内容」的条目'},
                'data': {'problems': failed.problems}}
    entries = sum(counts.values())
    outputs = []
    if args.dry_run:
        ctx.out(f'演练（未写文件）：会更新 {len(counts)} 个源文件的 {entries} 条记录')
    elif counts:
        sha = write_manifest(manifest)
        outputs.append({'path': 'cases/catalog.json', 'sha256': sha, 'kind': 'catalog'})
        ctx.out(f'已更新 cases/catalog.json：{len(counts)} 个源文件的 {entries} 条记录；下一步运行 check')
    else:
        ctx.out('补丁已经应用过，catalog 无需改动')
    return {'data': {'sources': len(counts), 'entries': entries, 'dryRun': bool(args.dry_run)}, 'outputs': outputs}


def cmd_rights(args, ctx, manifest):
    register = read_register()
    computed = compute_rights(manifest, register)
    rights = computed[0]
    by_clearance, by_category = {}, {}
    for cid, r in rights.items():
        by_clearance[r['clearance']] = by_clearance.get(r['clearance'], 0) + 1
        for k in r['register']:
            by_category[k] = by_category.get(k, 0) + 1
    files = sum(1 for marks in computed[1].values() for m in marks.values() if m['clearance'])
    data = {'cases': len(rights), 'clearance': by_clearance, 'categories': dict(sorted(by_category.items())),
            'internalFiles': files, 'registerUpdated': register.get('updated')}
    ctx.out(f'{len(rights)} 个案例：' + '、'.join(f'{k} {v}' for k, v in sorted(by_clearance.items()))
            + f'；公开案例里逐文件标为内部的素材 {files} 个')
    ctx.out('登记类别涉及的案例数：' + '、'.join(f'{k} {v}' for k, v in sorted(by_category.items())))
    drift = rights_drift(manifest, computed)
    if args.write:
        if not drift:
            ctx.out('catalog 的权利字段已是最新，未改动')
            return {'data': dict(data, written=False)}
        apply_rights(manifest, register, computed)
        sha = write_manifest(manifest)
        ctx.out(f'已写入 cases/catalog.json（{len(drift) - 1} 处更新）；下一步运行 check --rights')
        return {'data': dict(data, written=True), 'outputs': [{'path': 'cases/catalog.json', 'sha256': sha, 'kind': 'catalog'}]}
    if drift:
        for line in drift:
            err_print(ctx, f'不一致：{line}')
        if args.verify:
            return {'error': {'code': 'contract.rights-stale', 'message': f'catalog 的权利字段与授权登记册不一致：{len(drift) - 1} 处',
                              'hint': '运行 node tools/env/py.mjs tools/casebook.py rights --write'}, 'data': dict(data, drift=drift)}
        ctx.warn('cases.rights-stale', f'catalog 的权利字段与登记册不一致 {len(drift) - 1} 处', '加 --write 更新')
    elif args.verify:
        ctx.out('catalog 的权利字段与授权登记册一致')
    return {'data': dict(data, drift=drift)}


def main(args, ctx):
    validate_options(args)
    manifest = load_catalog()
    handler = {'list': cmd_list, 'check': cmd_check, 'restore': cmd_restore, 'rehash': cmd_rehash, 'rights': cmd_rights,
               'index': cmd_index}[args.command]
    try:
        return handler(args, ctx, manifest)
    except (CliError, KeyboardInterrupt):
        raise
    except (ValueError, OSError, zipfile.BadZipFile, http.client.HTTPException) as error:   # OSError: network and files
        raise as_cli_error(error) from error


if __name__ == '__main__':
    sys.exit(run(main, build_parser(), command='casebook'))
