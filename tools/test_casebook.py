import contextlib
import hashlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import urllib.request
import zipfile

spec = importlib.util.spec_from_file_location('casebook', Path(__file__).with_name('casebook.py'))
cb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cb)
REAL_ARCHIVE = cb.ARCHIVE


def entry(path, source, data, **extra):
    return {'path': path, 'source': source, 'size': len(data), 'sha256': cb.digest(data), **extra}


def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def safe_tempdir():
    """A TemporaryDirectory whose resolved path restore accepts as a token value (casebook.SAFE_VALUE).
    Windows profile folders can contain spaces (C:/Users/John Smith/AppData/Local/Temp); then the
    repository's out/ folder is used, and the tests are skipped when that is not safe either."""
    for base in (None, cb.ROOT / 'out'):
        try:
            if base is not None:
                base.mkdir(exist_ok=True)
            tmp = tempfile.TemporaryDirectory(prefix='casebook-test-', dir=base)
        except OSError:
            continue
        if cb.SAFE_VALUE.fullmatch(Path(tmp.name).resolve().as_posix()):
            return tmp
        tmp.cleanup()
    raise unittest.SkipTest(f'restore refuses token values with spaces or quotes, and neither {tempfile.gettempdir()} '
                            f'nor {cb.ROOT / "out"} is free of them; point TMPDIR/TEMP at such a folder')


def restored_literals(line, prefix):
    """Single-quoted string literals on a restored source line that start with `prefix`, the restore root
    as restore writes it: /Users/... on POSIX, C:/Users/... on Windows, //server/share/... on a UNC path."""
    return [s for s in re.findall(r"'([^'\n]*)'", line) if s.startswith(prefix)]


class PackServer:
    """A real HTTP server on 127.0.0.1 serving one pack, with Range support. When `cut` is set, the next
    response announces the full length but the server closes the connection (FIN, no error) after `cut`
    body bytes; http.client then returns b'' from read() instead of raising."""

    def __init__(self, payload):
        self.payload, self.cut, self.ranges = payload, None, []
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                rng = self.headers.get('Range')
                server.ranges.append(rng)
                start = int(rng[6:-1]) if rng else 0
                body = server.payload[start:]
                self.send_response(206 if rng else 200)
                if rng:
                    self.send_header('Content-Range', f'bytes {start}-{len(server.payload) - 1}/{len(server.payload)}')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                cut, server.cut = server.cut, None
                self.wfile.write(body if cut is None else body[:cut])
                self.wfile.flush()
                self.close_connection = True

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.origin = f'http://127.0.0.1:{self.httpd.server_address[1]}/'
        # no proxies: an http_proxy in the environment must not intercept 127.0.0.1
        self.urlopen = urllib.request.build_opener(urllib.request.ProxyHandler({})).open

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class Response(io.BytesIO):
    """Stand-in for an HTTP response; can drop the connection after `fail_after` bytes."""

    def __init__(self, data, status=200, headers=None, fail_after=None):
        super().__init__(data)
        self.status, self.headers, self.fail_after = status, headers or {}, fail_after

    def read(self, n=-1):
        if self.fail_after is not None and self.tell() >= self.fail_after:
            raise ConnectionResetError('network dropped')
        return super().read(min(n, self.fail_after - self.tell()) if self.fail_after is not None else n)


class CasebookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = safe_tempdir()
        self.root = Path(self.tmp.name)
        self.previous = cb.ARCHIVE
        cb.ARCHIVE = self.root/'archive'
        cb.ARCHIVE.mkdir()
        source = b'const root = "@@CASE_ROOT@@";\n'
        (cb.ARCHIVE/'source.js').write_bytes(source)
        binary = b'asset bytes'
        sha = cb.digest(binary)
        pack = self.root/'packs/assets.zip'
        pack.parent.mkdir()
        with zipfile.ZipFile(pack, 'w') as z:
            z.writestr(sha, binary)
        self.m = {'cases': [{'id': 'one', 'workspacePath': 'styles/one', 'files': [
            {'path': 'main.js', 'source': 'source.js', 'size': len(source), 'sha256': cb.digest(source), 'templated': True},
            {'path': 'assets/a.bin', 'asset': sha, 'size': len(binary), 'sha256': sha}],
            'entrypoints': ['main.js'], 'requirements': [], 'notes': []}],
            'assets': {sha: {'size': len(binary), 'pack': 'assets.zip'}},
            'packs': [{'filename': 'assets.zip', 'size': pack.stat().st_size, 'sha256': cb.digest(pack.read_bytes()), 'url': 'https://invalid.example/assets.zip'}]}

    def tearDown(self):
        cb.ARCHIVE = self.previous
        self.tmp.cleanup()

    def restore(self, **kw):
        out = kw.pop('out', self.root/'out')
        return cb.restore(self.m, kw.pop('case', 'one'), out, self.root/'packs', **kw)

    def add_source(self, name, data, path=None, case='one', **extra):
        (cb.ARCHIVE/name).parent.mkdir(parents=True, exist_ok=True)
        (cb.ARCHIVE/name).write_bytes(data)
        item = entry(path or name, name, data, **extra)
        next(c for c in self.m['cases'] if c['id'] == case)['files'].append(item)
        return item

    def add_case(self, cid, workspace, **extra):
        self.m['cases'].append({'id': cid, 'workspacePath': workspace, 'files': [], 'entrypoints': [],
                                'requirements': [], 'notes': [], **extra})

    def report(self, p):
        return json.loads((p/'ARCHIVE-RESTORED.json').read_text(encoding='utf-8'))

    # --- original behaviour -------------------------------------------------------------------------------

    def test_roundtrip_and_tokens(self):
        self.assertEqual(cb.check(self.m), (1, 1))
        p = self.restore()
        # Compare with the resolved path: an unresolved temp path (Windows 8.3 short names such as RUNNER~1,
        # macOS /var -> /private/var) is not what restore writes.
        self.assertEqual((p/'main.js').read_text(encoding='utf-8'), f'const root = "{p.resolve().as_posix()}";\n')
        self.assertEqual((p/'assets/a.bin').read_bytes(), b'asset bytes')
        report = self.report(p)
        self.assertFalse(report['sourceOnly'])
        self.assertEqual(report['tokens'], {'@@CASE_ROOT@@': p.resolve().as_posix()})

    def test_no_overwrite(self):
        p = self.restore()
        (p/'main.js').write_text('user edits', encoding='utf-8')
        with self.assertRaises(FileExistsError): self.restore()
        self.assertEqual((p/'main.js').read_text(encoding='utf-8'), 'user edits')

    def test_traversal_and_absolute(self):
        for name in ['../outside', '/etc/a', 'C:/a', 'a\\..\\b']:
            with self.assertRaises(ValueError): cb.safe_path(self.root, name)

    def test_restored_path_literals_are_found_on_every_platform(self):
        # The real-archive check reads paths back from restored lines; Windows writes them as C:/Users/...
        for root in ('/Users/a/ws/Desktop/上影ppt/见龙', 'C:/Users/runneradmin/AppData/Local/Temp/tmp1/ws/Desktop/上影ppt/见龙',
                     '//server/share/ws/Desktop/上影ppt/见龙'):
            with self.subTest(root):
                line = f"WAV = '{root}/旁白v2/wav'   # 第二版旁白（音色 Chinese (Mandarin)_Sincere_Adult）；旧版在 旁白/wav"
                self.assertEqual(restored_literals(line, root + '/'), [f'{root}/旁白v2/wav'])
                line = f"TL = json.load(open('{root}/timeline.json'))"
                self.assertEqual(restored_literals(line, root + '/'), [f'{root}/timeline.json'])
                self.assertEqual(restored_literals(f"X = '{root}X/a'", root + '/'), [])

    def test_symlink_escape(self):
        outside = self.root/'outside'
        outside.mkdir()
        base = self.root/'base'
        base.mkdir()
        try:
            (base/'link').symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as error:     # Windows without developer mode or admin rights
            self.skipTest(f'symlinks unavailable: {error}')
        with self.assertRaises(ValueError): cb.safe_path(base, 'link/a')

    def test_corrupt_pack_fails_before_destination(self):
        (self.root/'packs/assets.zip').write_bytes(b'bad')
        with self.assertRaises(ValueError): self.restore()
        self.assertFalse((self.root/'out/styles/one').exists())

    def test_corrupt_source_cleans_partial(self):
        (cb.ARCHIVE/'source.js').write_text('tampered', encoding='utf-8')
        with self.assertRaises(ValueError): self.restore()
        self.assertFalse((self.root/'out/styles/one').exists())
        # Sources are verified before anything is created, so not even the parent folder appears.
        self.assertFalse((self.root/'out').exists())

    def test_corrupt_asset_cleans_partial(self):
        sha = self.m['cases'][0]['files'][1]['asset']
        with zipfile.ZipFile(self.root/'packs/assets.zip', 'w') as z:
            z.writestr(sha, b'other bytes')
        pack = self.root/'packs/assets.zip'
        self.m['packs'][0].update(size=pack.stat().st_size, sha256=cb.digest(pack.read_bytes()))
        with self.assertRaises(ValueError): self.restore()
        self.assertEqual(list((self.root/'out/styles').iterdir()), [])

    def test_source_only_no_asset_download(self):
        (self.root/'packs/assets.zip').unlink()
        p = self.restore(source_only=True)
        self.assertTrue((p/'main.js').exists())
        self.assertFalse((p/'assets/a.bin').exists())

    def test_case_collision(self):
        f = dict(self.m['cases'][0]['files'][0], path='MAIN.JS')
        self.m['cases'][0]['files'].append(f)
        with self.assertRaises(ValueError): cb.check(self.m)

    def test_vendor_snapshot_bytes_and_inventory(self):
        folder = cb.ARCHIVE/'vendor/demo'
        folder.mkdir(parents=True)
        data = b'upstream\n'
        (folder/'lib.js').write_bytes(data)
        item = {'path': 'lib.js', 'size': len(data), 'sha256': cb.digest(data),
                'gitBlob': hashlib.sha1(b'blob 9\0' + data).hexdigest()}
        lock = {'repositories': [{'name': 'demo', 'path': 'vendor/demo', 'files': [item]}]}
        (cb.ARCHIVE/'vendor/lock.json').write_text(json.dumps(lock), encoding='utf-8')
        self.assertEqual(cb.check(self.m), (1, 1))
        (folder/'extra.js').write_bytes(b'extra')
        with self.assertRaises(ValueError): cb.check(self.m)
        (folder/'extra.js').unlink()
        (folder/'lib.js').write_bytes(b'changed!\n')
        with self.assertRaises(ValueError): cb.check(self.m)

    # --- R75: paths resolved through the home folder ---------------------------------------------------------

    def home_fixture(self):
        self.m['homePaths'] = {'lemo': 'lemo-opuscar', 'external': ['.ssh'], 'notArchived': ['other-project']}
        self.m['cases'][0]['legacyRoots'] = ['Old/one']
        self.add_case('two', 'styles/two')
        self.add_source('two/tool.sh', b'#!/bin/sh\necho two\n', path='tool.sh', case='two')
        py = ("import os\nfrom pathlib import Path\n"
              "P = os.path.expanduser('~/Old/one/')\n"
              "LIB = str(Path.home() / 'lemo-opuscar')\n"
              "KEY = Path.home() / '.ssh/id'\n"
              "X = os.path.expanduser(\"~/other-project/lib\")\n"
              "# comment ~/Old/one is left alone\n")
        sh = ("#!/bin/sh\n# 成片移到 ~/Old/one（注释不改）\n"
              "LIB=$HOME/lemo-opuscar\n"
              "R=~/styles/two/tool.sh; cd ~/Old/one/film\n"
              "ffmpeg -y -i a.mp4 \"$HOME/styles/one.mp4\"\n"
              "ssh -i ~/.ssh/id_ed25519 host\n")
        js = "const LIB = process.env.LIB || process.env.HOME + '/lemo-opuscar';\n"
        self.add_source('one/build.py', py.encode(), path='build.py')
        self.add_source('one/run.sh', sh.encode(), path='run.sh', executable=True)
        self.add_source('one/cam.mjs', js.encode(), path='cam.mjs')
        self.add_source('one/README.md', '见 ~/Old/one/README 与 $HOME/lemo-opuscar\n'.encode(), path='README.md')

    def test_home_paths_are_rewritten_into_the_workspace(self):
        self.home_fixture()
        self.assertEqual(cb.check(self.m), (2, 6))
        lemo = self.root/'lemo'
        p = self.restore(lemo=lemo)
        ws, case, lib = (self.root/'out').resolve().as_posix(), p.resolve().as_posix(), lemo.resolve().as_posix()
        self.assertEqual((p/'build.py').read_text(encoding='utf-8'),
                         "import os\nfrom pathlib import Path\n"
                         f"P = os.path.expanduser('{case}/')\n"
                         f"LIB = str(Path('{lib}'))\n"
                         "KEY = Path.home() / '.ssh/id'\n"
                         f"X = os.path.expanduser(\"{ws}/other-project/lib\")\n"
                         "# comment ~/Old/one is left alone\n")
        self.assertEqual((p/'run.sh').read_text(encoding='utf-8'),
                         "#!/bin/sh\n# 成片移到 ~/Old/one（注释不改）\n"
                         f"LIB={lib}\n"
                         f"R={ws}/styles/two/tool.sh; cd {case}/film\n"
                         f"ffmpeg -y -i a.mp4 \"{ws}/styles/one.mp4\"\n"
                         "ssh -i ~/.ssh/id_ed25519 host\n")
        self.assertEqual((p/'cam.mjs').read_text(encoding='utf-8'), f"const LIB = process.env.LIB || '{lib}';\n")
        self.assertEqual((p/'README.md').read_bytes(), (cb.ARCHIVE/'one/README.md').read_bytes())
        report = self.report(p)
        self.assertEqual(len(report['homeRewrites']), 8)
        self.assertEqual(report['relatedCases'], ['two'])
        self.assertEqual([e['reference'] for e in report['externalHomePaths']],
                         ["Path.home() / '.ssh/id'", '~/.ssh/id_ed25519'])
        self.assertEqual([e['path'] for e in report['notArchived']], ['other-project/lib'])
        self.assertEqual(report['tokens'], {'@@CASE_ROOT@@': case, '@@LEMO_ROOT@@': lib, '@@WORKSPACE_ROOT@@': ws})
        self.assertTrue(any('two' in w for w in cb.restore_warnings(report)))

    def test_check_rejects_home_paths_restore_cannot_place(self):
        self.home_fixture()
        cases = {
            'env.py': "import os\nX = os.environ['HOME'] + '/x'\n",
            'unknown.py': "import os\nX = os.path.expanduser('~/Elsewhere/project/')\n",
            'bare.sh': '#!/bin/sh\ncd $HOME\n',
            'note.md': 'built on /Users/someone/Desktop/x\n',
        }
        for name, text in cases.items():
            with self.subTest(name):
                item = self.add_source(f'one/{name}', text.encode(), path=name)
                with self.assertRaisesRegex(ValueError, re.escape(f'one/{name}')): cb.check(self.m)
                self.m['cases'][0]['files'].remove(item)
        self.assertEqual(cb.check(self.m), (2, 6))

    def test_check_rejects_tokens_outside_templated_files(self):
        self.add_source('plain.sh', b'LIB=@@LEMO_ROOT@@\n')
        with self.assertRaisesRegex(ValueError, 'not marked templated'): cb.check(self.m)
        self.m['cases'][0]['files'][-1]['templated'] = True
        self.assertEqual(cb.check(self.m), (1, 2))
        self.add_source('typo.sh', b'LIB=@@LEMO_RO0T@@\n', templated=True)
        with self.assertRaisesRegex(ValueError, 'unknown restore tokens'): cb.check(self.m)

    def test_unreplaced_rog_token_is_reported(self):
        self.add_source('rog.sh', b'ssh ROG@@@ROG_HOST@@ true\n', templated=True)
        p = self.restore()
        self.assertEqual(self.report(p)['unreplacedTokens'], [{'file': 'rog.sh', 'tokens': ['@@ROG_HOST@@']}])
        self.assertTrue(any('--rog-host' in w for w in cb.restore_warnings(self.report(p))))
        p2 = self.restore(out=self.root/'out2', rog='192.0.2.10')     # RFC 5737 documentation address
        self.assertEqual((p2/'rog.sh').read_text(encoding='utf-8'), 'ssh ROG@192.0.2.10 true\n')

    # --- R76: tokens that still point at a project's pre-move location --------------------------------------

    def test_legacy_root_tokens_resolve_to_the_case(self):
        self.add_source('wav.py', b"WAV = '@@WORKSPACE_ROOT@@/Old/one/wav'\nOTHER = '@@WORKSPACE_ROOT@@/Old/oneX/a'\n",
                        templated=True)
        with self.assertRaisesRegex(ValueError, 'Old/one/wav is outside every archived case'): cb.check(self.m)
        self.m['cases'][0]['legacyRoots'] = ['Old/one']
        with self.assertRaisesRegex(ValueError, 'Old/oneX/a is outside'): cb.check(self.m)   # prefix is not a match
        self.m['cases'][0]['files'].pop()
        self.add_source('wav.py', b"WAV = '@@WORKSPACE_ROOT@@/Old/one/wav'\n", templated=True)
        self.assertEqual(cb.check(self.m), (1, 2))
        p = self.restore()
        self.assertEqual((p/'wav.py').read_text(encoding='utf-8'), f"WAV = '{p.resolve().as_posix()}/wav'\n")

    def test_legacy_roots_must_not_overlap_workspaces(self):
        self.add_case('two', 'styles/two')
        for bad in (['styles/two'], ['styles'], ['styles/one/sub']):
            with self.subTest(bad):
                self.m['cases'][0]['legacyRoots'] = bad
                with self.assertRaises(ValueError): cb.check(self.m)

    # --- R77: vendor inventory follows the snapshot's own .gitignore and names the paths ---------------------

    def vendor_fixture(self):
        folder = cb.ARCHIVE/'vendor/demo'
        (folder/'sub').mkdir(parents=True)
        files = {'lib.js': b'upstream\n', '.gitignore': b'assets/\n*.onnx\n!keep.onnx\n/build/\n',
                 'sub/.gitignore': b'cache/\n', 'sub/mod.py': b'pass\n'}
        items = []
        for name, data in files.items():
            (folder/name).write_bytes(data)
            items.append({'path': name, 'size': len(data), 'sha256': cb.digest(data), 'gitBlob': blob(data), 'mode': '100644'})
        lock = {'repositories': [{'name': 'demo', 'path': 'vendor/demo', 'files': items}]}
        (cb.ARCHIVE/'vendor/lock.json').write_text(json.dumps(lock), encoding='utf-8')
        return folder, lock

    def test_vendor_inventory_ignores_downloads_and_names_strays(self):
        folder, lock = self.vendor_fixture()
        for junk in ['.DS_Store', 'sub/.DS_Store', 'assets/instruments/index.json', 'core/model.onnx', 'build/out.bin',
                     'sub/cache/x.bin', 'node_modules/pkg/index.js', '.venv/bin/python', 'sub/__pycache__/m.pyc']:
            (folder/junk).parent.mkdir(parents=True, exist_ok=True)
            (folder/junk).write_bytes(b'runtime download')
        self.assertEqual(cb.check(self.m), (1, 1))
        (folder/'stray.js').write_bytes(b'x')
        (folder/'keep.onnx').write_bytes(b'x')         # re-included by !keep.onnx, so it is a real stray
        (folder/'sub/build').mkdir()
        (folder/'sub/build/y.js').write_bytes(b'x')    # /build/ is anchored to the snapshot root only
        with self.assertRaises(ValueError) as caught: cb.check(self.m)
        for name in ('stray.js', 'keep.onnx', 'sub/build/y.js'):
            self.assertIn(name, str(caught.exception))
        for name in ('stray.js', 'keep.onnx', 'sub/build/y.js'):
            (folder/name).unlink()
        (folder/'sub/mod.py').unlink()
        with self.assertRaisesRegex(ValueError, '缺少的文件：\n  - sub/mod.py'): cb.check(self.m)

    def test_gitignore_matcher(self):
        top = self.root/'gi'
        top.mkdir()
        (top/'.gitignore').write_text('\n'.join([
            '# comment', 'node_modules/', 'core/tts/*.onnx', 'styles/*/demo/out/', '!styles/game-show/demo/voices/*.wav',
            'styles/*/demo/voices/*.wav', '!styles/game-show/demo/voices/*.wav', 'styles/*/demo/**/stems*/',
            '/promo/', '**/tmp/', '*~', 'styles/*/demo/stills/*', '!styles/*/demo/stills/styleframe.jpg', 'lib/**']),
            encoding='utf-8')
        cases = {
            ('node_modules/x.js', False): True, ('a/node_modules/x.js', False): True, ('core/tts/k.onnx', False): True,
            ('core/k.onnx', False): False, ('styles/a/demo/out/f.png', False): True, ('styles/a/demo/out2/f.png', False): False,
            ('styles/a/demo/voices/v.wav', False): True, ('styles/game-show/demo/voices/v.wav', False): False,
            ('styles/a/demo/music/stems_v1/s.wav', False): True, ('styles/a/demo/x/y/stems/s.wav', False): True,
            ('promo/p.md', False): True, ('a/promo/p.md', False): False, ('a/b/tmp/t', False): True, ('tmp/t', False): True,
            ('notes.txt~', False): True, ('styles/a/demo/stills/x.jpg', False): True,
            ('styles/a/demo/stills/styleframe.jpg', False): False, ('lib/a/b.js', False): True, ('lib', True): False,
        }
        ignore = cb.GitIgnore(top)
        for (path, is_dir), expected in cases.items():
            with self.subTest(path):
                self.assertEqual(ignore.ignored(top/path, is_dir), expected)

    # --- R79: Windows checkouts with core.autocrlf=true ------------------------------------------------------

    def test_crlf_checkout_is_diagnosed_and_restored_as_lf(self):
        lf = b'const root = "@@CASE_ROOT@@";\nconsole.log(root);\n'
        item = self.m['cases'][0]['files'][0]
        item.update(size=len(lf), sha256=cb.digest(lf))
        (cb.ARCHIVE/'source.js').write_bytes(lf.replace(b'\n', b'\r\n'))
        with self.assertRaisesRegex(ValueError, 'CRLF') as caught: cb.check(self.m)
        self.assertIn('git rm --cached -r -q .', str(caught.exception))
        p = self.restore()
        self.assertEqual((p/'main.js').read_bytes(), f'const root = "{p.resolve().as_posix()}";\nconsole.log(root);\n'.encode())
        self.assertEqual(self.report(p)['lineEndingsRepaired'], ['main.js'])
        (cb.ARCHIVE/'source.js').write_bytes(b'const root = "@@CASE_ROOT@@";\r\nconsole.log(r00t);\r\n')
        with self.assertRaisesRegex(ValueError, 'Checksum mismatch: one/main.js'): cb.check(self.m)

    def test_crlf_vendor_snapshot_is_diagnosed(self):
        folder, _ = self.vendor_fixture()
        (folder/'lib.js').write_bytes(b'upstream\r\n')
        with self.assertRaisesRegex(ValueError, r'CRLF[\s\S]*vendor/demo/lib.js'): cb.check(self.m)

    # --- R83: every reference, file modes and broken asset references -----------------------------------

    def test_every_reference_to_a_shared_source_is_verified(self):
        self.add_case('two', 'styles/two')
        first = self.m['cases'][0]['files'][0]
        for field, value in (('sha256', '0' * 64), ('size', 999)):
            with self.subTest(field):
                self.m['cases'][1]['files'] = [dict(first, **{field: value})]
                with self.assertRaisesRegex(ValueError, 'two/main.js'): cb.check(self.m)
        self.m['cases'][1]['files'] = [dict(first)]
        self.assertEqual(cb.check(self.m), (2, 1))

    @unittest.skipIf(os.name == 'nt', 'Windows has no executable bit')
    def test_vendor_file_modes_follow_the_lock(self):
        folder, lock = self.vendor_fixture()
        lock['repositories'][0]['files'][0]['mode'] = '100755'
        (cb.ARCHIVE/'vendor/lock.json').write_text(json.dumps(lock), encoding='utf-8')
        # a file system that keeps modes, whatever the machine's own git config says
        with mock.patch.object(cb, 'git_file_mode', return_value=None):
            (folder/'lib.js').chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'mode mismatch[\\s\\S]*lib.js'): cb.check(self.m)
            (folder/'lib.js').chmod(0o755)
            summary = {}
            self.assertEqual(cb.check(self.m, summary), (1, 1))
            self.assertEqual((summary['fileModes'], summary['notices']), ('checked', []))
            (folder/'sub/mod.py').chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'sub/mod.py'): cb.check(self.m)

    @unittest.skipIf(os.name == 'nt', 'Windows has no executable bit')
    def test_file_systems_without_executable_bits_skip_the_mode_check(self):
        """WSL /mnt drives, exFAT/FAT and many SMB shares show every file as executable; git clone then sets
        core.fileMode=false and git status stays clean, so check must not report thousands of mismatches."""
        folder, _ = self.vendor_fixture()
        for f in folder.rglob('*'):
            if f.is_file():
                f.chmod(0o755)
        for file_mode, notice in ((False, 'core.fileMode'), (None, '全部显示为可执行'), (True, '全部显示为可执行')):
            with self.subTest(file_mode=file_mode), mock.patch.object(cb, 'git_file_mode', return_value=file_mode):
                summary = {}
                self.assertEqual(cb.check(self.m, summary), (1, 1))
                self.assertEqual(summary['fileModes'], 'skipped')
                self.assertIn(notice, summary['notices'][0])
        (folder/'lib.js').chmod(0o644)      # modes are stored after all: the stray +x bits are reported again
        with mock.patch.object(cb, 'git_file_mode', return_value=None):
            with self.assertRaisesRegex(ValueError, r'mode mismatch（3 个文件）'): cb.check(self.m)
        with mock.patch.object(cb, 'git_file_mode', return_value=False):    # Git ignores modes: so does check
            self.assertEqual(cb.check(self.m), (1, 1))

    @unittest.skipUnless(shutil.which('git'), 'git is not installed')
    def test_git_file_mode_reads_the_checkout_config(self):
        version = re.search(r'(\d+)\.(\d+)', subprocess.run(['git', '--version'], capture_output=True, text=True).stdout)
        if not version or (int(version[1]), int(version[2])) < (2, 31):
            self.skipTest('GIT_CONFIG_COUNT needs git 2.31+')
        for value, expected in (('false', False), ('true', True)):
            env = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'core.fileMode', 'GIT_CONFIG_VALUE_0': value}
            with self.subTest(value), mock.patch.dict(os.environ, env):
                self.assertIs(cb.git_file_mode(self.root), expected)
        with mock.patch.object(cb.subprocess, 'run', side_effect=FileNotFoundError('git')):
            self.assertIsNone(cb.git_file_mode(self.root))

    # --- R86: case cards repeat the catalog notes ----------------------------------------------------------

    def test_cards_that_drift_from_the_catalog_notes_are_reported(self):
        self.m['cases'][0]['notes'] = ['色阶实验：一个场景、一份楼阁模型。']
        self.add_case('two', 'styles/two', notes=['三维画风实验：按九张参考重建。'])
        (cb.ARCHIVE/'entries').mkdir()
        (cb.ARCHIVE/'entries/one.md').write_text('# one\r\n\r\n色阶实验：一个场景、一份楼阁模型。\r\n', encoding='utf-8')
        (cb.ARCHIVE/'entries/two.md').write_text('# two\n\n画风实验；360图是单视角2.5D代理。\n', encoding='utf-8')
        summary = {}
        self.assertEqual(cb.check(self.m, summary), (2, 1))       # a notice, never a failure
        self.assertEqual(len(summary['notices']), 1)
        self.assertIn('1 张案例卡', summary['notices'][0])
        self.assertIn('entries/two.md', summary['notices'][0])
        self.assertNotIn('entries/one.md', summary['notices'][0])

    def test_unknown_asset_names_case_and_path(self):
        self.m['cases'][0]['files'][1]['asset'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, f'Unknown asset {"f" * 64} referenced by one/assets/a.bin'): cb.check(self.m)
        with self.assertRaisesRegex(ValueError, 'one/assets/a.bin'): self.restore()
        del self.m['cases'][0]['files'][1]['asset']
        with self.assertRaisesRegex(ValueError, 'neither source nor asset'): cb.check(self.m)

    # --- R84: values pasted into shell / JSON / Python source ------------------------------------------------

    def test_unsafe_token_values_are_refused_before_anything_is_written(self):
        self.add_source('build.sh', b'#!/bin/sh\nLIB=@@LEMO_ROOT@@\n', templated=True)
        for kw in ({'out': self.root/'My Projects/out'}, {'lemo': self.root/'q"uote/lemo'},
                   {'lemo': self.root/"it's/lemo"}, {'out': self.root/'a$b/out'}, {'out': self.root/'semi;colon'}):
            with self.subTest(kw):
                with self.assertRaisesRegex(ValueError, '不安全字符'): self.restore(**kw)
                self.assertFalse((kw.get('out', self.root/'out')).exists())
        self.add_source('rog.sh', b'ssh ROG@@@ROG_HOST@@\n', templated=True)
        with self.assertRaisesRegex(ValueError, '@@ROG_HOST@@'): self.restore(rog='host; rm -rf /')
        p = self.restore(lemo=self.root/'库/lemo-opuscar', rog='rog.local')
        self.assertEqual((p/'build.sh').read_text(encoding='utf-8'), f'#!/bin/sh\nLIB={(self.root/"库/lemo-opuscar").resolve().as_posix()}\n')

    def test_unused_tokens_do_not_restrict_the_destination(self):
        plain = b'console.log("no tokens");\n'
        (cb.ARCHIVE/'source.js').write_bytes(plain)
        self.m['cases'][0]['files'][0] = entry('main.js', 'source.js', plain)
        p = self.restore(out=self.root/'My Projects/out', lemo=self.root/'q"uote')
        self.assertEqual((p/'main.js').read_bytes(), plain)
        self.assertEqual(self.report(p)['tokens'], {})

    # --- R85: packs are streamed, hashed once and resumable -------------------------------------------------

    def test_pack_is_hashed_in_chunks_not_read_whole(self):
        real = Path.read_bytes

        def guarded(path):
            if path.suffix in ('.zip', '.partial'):
                raise AssertionError(f'pack read into memory: {path}')
            return real(path)
        with mock.patch.object(Path, 'read_bytes', guarded):
            p = self.restore()
        self.assertEqual((p/'assets/a.bin').read_bytes(), b'asset bytes')

    def test_verified_pack_is_not_hashed_again(self):
        calls = []
        real = cb.file_digest
        with mock.patch.object(cb, 'file_digest', lambda p: calls.append(p) or real(p)):
            self.restore()
            self.assertEqual(len(calls), 1)
            self.restore(out=self.root/'out2')
            self.assertEqual(len(calls), 1)            # same size and mtime: verified record reused
            pack = self.root/'packs/assets.zip'
            os.utime(pack, ns=(pack.stat().st_atime_ns, pack.stat().st_mtime_ns + 10**9))
            self.restore(out=self.root/'out3')
            self.assertEqual(len(calls), 2)            # touched: hashed again
            self.restore(out=self.root/'out4', reverify=True)
            self.assertEqual(len(calls), 3)

    def test_download_streams_once_and_resumes(self):
        pack = self.root/'packs/assets.zip'
        payload = pack.read_bytes()
        pack.unlink()
        self.m['packs'][0]['url'] = cb.PACK_ORIGIN + 'casebook-test/assets.zip'
        half = len(payload) // 2
        requests = []

        def fake_urlopen(request, timeout=None):
            requests.append(dict(request.header_items()))
            if len(requests) == 1:
                return Response(payload, fail_after=half)
            start = int(request.get_header('Range')[6:-1])
            return Response(payload[start:], 206, {'Content-Range': f'bytes {start}-{len(payload) - 1}/{len(payload)}'})
        hashed = []
        real = cb.file_digest
        with mock.patch.object(cb.urllib.request, 'urlopen', fake_urlopen), \
                mock.patch.object(cb, 'file_digest', lambda p: hashed.append(p) or real(p)):
            with self.assertRaisesRegex(cb.DownloadInterrupted, '续传') as caught: self.restore(download=True, retries=0)
            self.assertIsInstance(caught.exception.__cause__, ConnectionResetError)
            self.assertEqual((self.root/'packs/assets.zip.partial').stat().st_size, half)
            self.assertFalse((self.root/'out/styles/one').exists())
            p = self.restore(download=True)
        self.assertEqual(requests[1].get('Range'), f'bytes={half}-')
        self.assertEqual(pack.read_bytes(), payload)
        self.assertFalse((self.root/'packs/assets.zip.partial').exists())
        self.assertEqual(hashed, [])                    # hashed while streaming; never re-read afterwards
        self.assertEqual((p/'assets/a.bin').read_bytes(), b'asset bytes')

    def test_download_restarts_when_range_is_ignored_and_rejects_corruption(self):
        pack = self.root/'packs/assets.zip'
        payload = pack.read_bytes()
        pack.unlink()
        self.m['packs'][0]['url'] = cb.PACK_ORIGIN + 'casebook-test/assets.zip'
        (self.root/'packs/assets.zip.partial').write_bytes(b'stale prefix')
        body = [payload]

        def fake_urlopen(request, timeout=None):
            return io.BytesIO(body[0])                # status 200: the server ignored Range
        with mock.patch.object(cb.urllib.request, 'urlopen', fake_urlopen):
            cb.get_pack(self.m['packs'][0], self.root/'packs', True)
            self.assertEqual(pack.read_bytes(), payload)
            pack.unlink()
            body[0] = payload[:-1] + b'!'
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                cb.get_pack(self.m['packs'][0], self.root/'packs', True)
        self.assertFalse(pack.exists())
        self.assertFalse((self.root/'packs/assets.zip.partial').exists())

    def test_download_discards_a_range_it_did_not_ask_for(self):
        pack = self.root/'packs/assets.zip'
        payload = pack.read_bytes()
        pack.unlink()
        self.m['packs'][0]['url'] = cb.PACK_ORIGIN + 'casebook-test/assets.zip'
        (self.root/'packs/assets.zip.partial').write_bytes(payload[:3])
        asked = []

        def fake_urlopen(request, timeout=None):
            asked.append(request.get_header('Range'))
            if request.get_header('Range'):
                return Response(payload[10:], 206, {'Content-Range': f'bytes 10-{len(payload) - 1}/{len(payload)}'})
            return Response(payload)
        with mock.patch.object(cb.urllib.request, 'urlopen', fake_urlopen):
            cb.get_pack(self.m['packs'][0], self.root/'packs', True)
        self.assertEqual(asked, ['bytes=3-', None])
        self.assertEqual(pack.read_bytes(), payload)

    def test_download_origin_is_enforced(self):
        (self.root/'packs/assets.zip').unlink()
        with self.assertRaisesRegex(ValueError, 'Unexpected download origin'): self.restore(download=True)

    def test_download_keeps_partial_when_the_server_closes_early(self):
        """A clean FIN before Content-Length is satisfied raises nothing in http.client: read() returns b''.
        That is an interruption to resume, not a corrupt pack to delete."""
        pack = self.root/'packs/assets.zip'
        payload = pack.read_bytes()
        pack.unlink()
        server = PackServer(payload)
        self.addCleanup(server.close)
        self.m['packs'][0]['url'] = server.origin + 'casebook-test/assets.zip'
        half = server.cut = len(payload) // 2
        with mock.patch.object(cb, 'PACK_ORIGIN', server.origin), \
                mock.patch.object(cb.urllib.request, 'urlopen', server.urlopen):
            with self.assertRaisesRegex(cb.DownloadInterrupted, f'{half} / {len(payload)} 字节[\\s\\S]*续传'):
                self.restore(download=True, retries=0)
            self.assertEqual((self.root/'packs/assets.zip.partial').read_bytes(), payload[:half])
            self.assertFalse((self.root/'out').exists())
            p = self.restore(download=True)
        self.assertEqual(server.ranges, [None, f'bytes={half}-'])
        self.assertEqual(pack.read_bytes(), payload)
        self.assertFalse((self.root/'packs/assets.zip.partial').exists())
        self.assertEqual((p/'assets/a.bin').read_bytes(), b'asset bytes')

    def test_download_keeps_nothing_that_is_not_this_pack(self):
        pack = self.root/'packs/assets.zip'
        payload = pack.read_bytes()
        pack.unlink()
        self.m['packs'][0]['url'] = cb.PACK_ORIGIN + 'casebook-test/assets.zip'
        partial = self.root/'packs/assets.zip.partial'
        page = b'<html>sign in to continue</html>'
        replies = {'error page': Response(page, 200, {'Content-Length': str(len(page))}),
                   'too long': Response(payload + b'tail')}
        for label, reply in replies.items():
            with self.subTest(label), mock.patch.object(cb.urllib.request, 'urlopen', lambda request, timeout=None: reply):
                with self.assertRaisesRegex(ValueError, '不是目录记录的素材包|more than'):
                    cb.get_pack(self.m['packs'][0], self.root/'packs', True)
                self.assertFalse(partial.exists())
                self.assertFalse(pack.exists())


    # --- T1: collected check problems, stray files, cards, rehash --------------------------------------------

    def test_check_collects_every_problem_before_failing(self):
        self.add_case('two', 'styles/two')
        self.m['cases'][1]['files'] = [dict(self.m['cases'][0]['files'][0], sha256='0' * 64)]       # 1: bad hash
        self.m['cases'][0]['files'][1]['asset'] = 'f' * 64                                         # 2: unknown asset
        self.m['cases'][0]['entrypoints'].append('missing.js')                                    # 3: entry point
        with self.assertRaises(cb.CheckFailed) as caught: cb.check(self.m)
        problems = caught.exception.problems
        self.assertEqual(len(problems), 3, problems)
        self.assertTrue(any('two/main.js' in p for p in problems))
        self.assertTrue(any('Unknown asset' in p for p in problems))
        self.assertTrue(any('Missing entry point: one' in p for p in problems))
        self.assertIsInstance(caught.exception, ValueError)          # callers that catch ValueError keep working

    def test_check_lists_new_and_missing_source_files(self):
        (cb.ARCHIVE/'source/one').mkdir(parents=True)
        (cb.ARCHIVE/'source/one/kept.txt').write_bytes(b'kept\n')
        self.add_source('source/one/kept.txt', b'kept\n', path='kept.txt')
        (cb.ARCHIVE/'source/one/.DS_Store').write_bytes(b'junk')       # operating-system clutter is ignored
        self.assertEqual(cb.check(self.m), (1, 2))
        (cb.ARCHIVE/'source/one/stray.md').write_text('nobody registered me', encoding='utf-8')
        self.add_source('source/one/gone.txt', b'gone\n', path='gone.txt')
        (cb.ARCHIVE/'source/one/gone.txt').unlink()
        with self.assertRaises(cb.CheckFailed) as caught: cb.check(self.m)
        text = '\n'.join(caught.exception.problems)
        self.assertIn('source/one/stray.md', text)
        self.assertIn('（新增）', text)
        self.assertIn('Missing source file（缺失）: one/gone.txt', text)

    def test_check_requires_one_card_per_case_and_existing_posters(self):
        (cb.ARCHIVE/'entries').mkdir()
        (cb.ARCHIVE/'entries/one.md').write_text('# one\n', encoding='utf-8')
        (cb.ARCHIVE/'entries/ghost.md').write_text('# ghost\n', encoding='utf-8')
        self.add_case('two', 'styles/two', poster='previews/two.jpg')
        with self.assertRaises(cb.CheckFailed) as caught: cb.check(self.m)
        text = '\n'.join(caught.exception.problems)
        self.assertIn('entries/ghost.md', text)
        self.assertIn('entries/two.md', text)
        self.assertIn('海报缺失 previews/two.jpg', text)

    def test_check_reports_vendor_file_count(self):
        folder, lock = self.vendor_fixture()
        summary = {}
        cb.check(self.m, summary)
        self.assertEqual((summary['vendorFiles'], summary['vendorRepos']), (4, 1))

    def rehash_fixture(self):
        old = (cb.ARCHIVE/'source.js').read_bytes()
        new = b'const root = "@@CASE_ROOT@@"; // stripped\n'
        (cb.ARCHIVE/'source.js').write_bytes(new)
        self.add_case('two', 'styles/two')
        self.m['cases'][1]['files'] = [dict(self.m['cases'][0]['files'][0])]       # two cases share the source
        patch = {'schemaVersion': 1, 'files': [{'source': 'source.js', 'oldSha256': cb.digest(old), 'newSha256': cb.digest(new),
                                                'oldSize': len(old), 'newSize': len(new)}]}
        return old, new, patch

    def test_rehash_updates_every_reference_once(self):
        old, new, patch = self.rehash_fixture()
        with self.assertRaises(cb.CheckFailed): cb.check(self.m)
        self.assertEqual(cb.rehash(self.m, patch), {'source.js': 2})
        self.assertEqual({(f['size'], f['sha256']) for c in self.m['cases'] for f in c['files'] if f.get('source') == 'source.js'},
                         {(len(new), cb.digest(new))})
        self.assertEqual(cb.check(self.m), (2, 1))
        self.assertEqual(cb.rehash(self.m, patch), {})              # the same patch again changes nothing

    def test_rehash_refuses_patches_that_do_not_match(self):
        old, new, patch = self.rehash_fixture()
        bad = json.loads(json.dumps(patch))
        bad['files'][0]['newSha256'] = '0' * 64                     # disk does not hold the patched bytes
        with self.assertRaisesRegex(cb.CheckFailed, '磁盘上的文件不是补丁写的新内容'): cb.rehash(self.m, bad)
        self.m['cases'][1]['files'][0]['sha256'] = '1' * 64          # catalog records neither old nor new
        with self.assertRaisesRegex(cb.CheckFailed, 'two/main.js'): cb.rehash(self.m, patch)
        self.assertEqual(self.m['cases'][0]['files'][0]['sha256'], cb.digest(old))   # nothing applied

    def test_write_manifest_keeps_the_archive_format(self):
        path = self.root/'catalog.json'
        cb.write_manifest({'b': 1, 'a': ['中文']}, path)
        self.assertEqual(path.read_bytes(), '{\n  "b": 1,\n  "a": [\n    "中文"\n  ]\n}'.encode('utf-8'))

    # --- T1: unresolved tokens, internal clearance, retries, mirrors, disk space -------------------------------

    def test_unresolved_tokens_are_listed_by_line_and_strict_refuses(self):
        self.add_source('rog.sh', b'#!/bin/sh\necho start\nssh ROG@@@ROG_HOST@@ true\nscp a ROG@@@ROG_HOST@@:b\n', templated=True)
        with self.assertRaisesRegex(cb.UnresolvedTokensError, r'2 处还原标记没有值[\s\S]*rog.sh:3') as caught:
            self.restore(strict=True)
        self.assertIn('--rog-host', caught.exception.hint)
        self.assertFalse((self.root/'out').exists())                   # nothing written
        p = self.restore()
        self.assertEqual(self.report(p)['unresolvedTokens'], [{'file': 'rog.sh', 'line': 3, 'token': '@@ROG_HOST@@'},
                                                              {'file': 'rog.sh', 'line': 4, 'token': '@@ROG_HOST@@'}])
        self.assertTrue(any('rog.sh:3' in w and '--strict' in w for w in cb.restore_warnings(self.report(p))))
        p2 = self.restore(out=self.root/'out2', rog='192.0.2.10', strict=True)
        self.assertEqual(self.report(p2)['unresolvedTokens'], [])

    def test_internal_assets_are_withheld_unless_asked_for(self):
        self.m['cases'][0]['files'][1]['clearance'] = 'internal'
        p = self.restore()
        self.assertFalse((p/'assets/a.bin').exists())
        self.assertEqual(self.report(p)['withheld'], [{'path': 'assets/a.bin', 'clearance': 'internal', 'size': 11}])
        self.assertTrue(any('--include-internal' in w for w in cb.restore_warnings(self.report(p))))
        (self.root/'packs/assets.zip').unlink()                         # the pack is not even needed
        p = self.restore(out=self.root/'out2')
        self.assertTrue((p/'main.js').exists())
        with self.assertRaises(FileNotFoundError): self.restore(out=self.root/'out3', include_internal=True)
        self.m['cases'][0]['files'][1].pop('clearance')
        self.m['cases'][0]['rights'] = {'clearance': 'internal'}       # a whole internal case
        plan = cb.plan_restore(self.m, 'one', self.root/'out4', self.root/'packs')
        self.assertEqual(([f['path'] for f in plan['write']], len(plan['withheld'])), (['main.js'], 1))
        plan = cb.plan_restore(self.m, 'one', self.root/'out4', self.root/'packs', include_internal=True)
        self.assertEqual(plan['missingPacks'], ['assets.zip'])

    def test_check_rejects_unknown_clearance(self):
        self.m['cases'][0]['files'][1]['clearance'] = 'secret'
        with self.assertRaisesRegex(cb.CheckFailed, "clearance 'secret'"): cb.check(self.m)

    def download_fixture(self):
        pack = self.root/'packs/assets.zip'
        payload = pack.read_bytes()
        pack.unlink()
        self.m['packs'][0]['url'] = cb.PACK_ORIGIN + 'casebook-test/assets.zip'
        return pack, payload

    def test_download_retries_and_resumes_within_one_run(self):
        pack, payload = self.download_fixture()
        half, calls, slept, seen = len(payload) // 2, [], [], []

        def fake_urlopen(request, timeout=None):
            calls.append(request.get_header('Range'))
            if len(calls) == 1:
                return Response(payload, fail_after=half)
            if len(calls) == 2:
                raise cb.urllib.error.HTTPError(request.full_url, 503, 'busy', {}, None)
            start = int(request.get_header('Range')[6:-1])
            return Response(payload[start:], 206, {'Content-Range': f'bytes {start}-{len(payload) - 1}/{len(payload)}'})
        with mock.patch.object(cb.urllib.request, 'urlopen', fake_urlopen):
            p = self.restore(download=True, retries=3, sleep=slept.append, progress=lambda m, h, t: seen.append(h))
        self.assertEqual(calls, [None, f'bytes={half}-', f'bytes={half}-'])
        self.assertEqual(slept, [1, 2])                                  # exponential backoff
        self.assertEqual(pack.read_bytes(), payload)
        self.assertEqual(seen[-1], len(payload))
        self.assertEqual((p/'assets/a.bin').read_bytes(), b'asset bytes')

    def test_download_does_not_retry_permanent_errors(self):
        pack, payload = self.download_fixture()
        calls = []

        def fake_urlopen(request, timeout=None):
            calls.append(1)
            raise cb.urllib.error.HTTPError(request.full_url, 404, 'gone', {}, None)
        with mock.patch.object(cb.urllib.request, 'urlopen', fake_urlopen):
            with self.assertRaises(cb.urllib.error.HTTPError): self.restore(download=True, retries=3, sleep=lambda s: None)
        self.assertEqual(len(calls), 1)

    def test_mirror_is_verified_against_the_catalog(self):
        pack, payload = self.download_fixture()
        urls = []

        def fake_urlopen(request, timeout=None):
            urls.append(request.full_url)
            return Response(body[0])
        body = [payload[:-1] + b'!']
        with mock.patch.object(cb.urllib.request, 'urlopen', fake_urlopen):
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                self.restore(download=True, mirror='https://mirror.example/casebook/', retries=0)
            body[0] = payload
            p = self.restore(download=True, mirror='https://mirror.example/casebook')
        self.assertEqual(urls, ['https://mirror.example/casebook/assets.zip'] * 2)
        self.assertEqual((p/'assets/a.bin').read_bytes(), b'asset bytes')
        self.assertEqual(cb.pack_url({'filename': '素材 01.zip', 'url': 'x'}, 'https://m.example'), 'https://m.example/%E7%B4%A0%E6%9D%90%2001.zip')

    def test_disk_space_is_checked_before_anything_is_written(self):
        pack, payload = self.download_fixture()
        with mock.patch.object(cb, 'free_bytes', lambda p: (1000, self.root)), \
                mock.patch.object(cb.urllib.request, 'urlopen', side_effect=AssertionError('no download expected')):
            with self.assertRaisesRegex(cb.DiskSpaceError, '磁盘空间不够') as caught: self.restore(download=True)
        self.assertIn('--dry-run', caught.exception.hint)
        self.assertFalse((self.root/'out').exists())
        self.assertFalse(list((self.root/'packs').glob('*.partial')))


class CommandLineTests(unittest.TestCase):
    """The command contract of docs/CLI.md: --help, usage errors (exit 2), --json envelopes, exit 3 / 4."""

    def setUp(self):
        self.base = CasebookTests('test_roundtrip_and_tokens')
        self.base.setUp()
        self.addCleanup(self.base.tearDown)
        self.root, self.m = self.base.root, self.base.m
        self.m['cases'][0].update(group='styles', status='historical-render', title='第一部')
        self.write_catalog()

    def write_catalog(self):
        (cb.ARCHIVE/'catalog.json').write_text(json.dumps(self.m, ensure_ascii=False, indent=2), encoding='utf-8')

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        code = cb.run(cb.main, cb.build_parser(), argv=list(argv), command='casebook', stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def envelope(self, *argv):
        code, out, err = self.run_cli(*argv, '--json')
        env = json.loads(out)                                   # stdout is exactly one JSON object
        self.assertEqual((env['schemaVersion'], env['exitCode'], env['ok'], env['command']), (1, code, code == 0, 'casebook'))
        return code, env, err

    def test_help_has_no_side_effects(self):
        printed = io.StringIO()
        with mock.patch.object(cb, 'read_manifest', side_effect=AssertionError('--help must not read the catalog')), \
                contextlib.redirect_stdout(printed):          # argparse prints help to sys.stdout itself
            code, out, err = self.run_cli('--help')
        out += printed.getvalue()
        self.assertEqual(code, 0)
        for word in ('用法', '退出码', 'restore', '--include-internal', '--if-exists'):
            self.assertIn(word, out)

    def test_usage_errors_exit_2_with_an_envelope(self):
        for argv, error in ((['check', '--no-such-flag'], 'usage.unknown-option'), (['lst'], 'usage.bad-value'),
                            (['list', '--group', 'style'], 'usage.bad-group'), (['restore'], 'usage.missing-argument'),
                            (['restore', 'on'], 'usage.unknown-case'), (['check', 'one'], 'usage.unexpected-argument'),
                            (['list', '--download'], 'usage.option-not-applicable'),
                            (['restore', 'one', '--if-exists', 'replace'], 'usage.bad-value'),
                            (['restore', 'one', '--mirror', 'ftp://x'], 'usage.bad-value'), (['rehash'], 'usage.missing-argument')):
            with self.subTest(argv):
                code, env, err = self.envelope(*argv)
                self.assertEqual((code, env['error']['code']), (2, error))
        code, env, err = self.envelope('list', '--group', 'style')
        self.assertIn('styles', env['error']['hint'])                    # lists the legal values

    def test_list_filters_and_reports_clearance(self):
        self.base.add_case('two', 'local/two', group='local-films', status='rejected', title='第二部 T−15')
        self.m['cases'][0]['rights'] = {'clearance': 'internal'}
        self.write_catalog()
        code, env, err = self.envelope('list')
        self.assertEqual((code, env['data']['count'], env['data']['groups']), (0, 2, ['local-films', 'styles']))
        self.assertEqual([c['clearance'] for c in env['data']['cases']], ['internal', 'public'])
        code, out, err = self.run_cli('list', '--group', 'local-films')
        self.assertEqual((code, out.count('\n')), (0, 1))
        self.assertIn('第二部 T−15', out)

    def test_check_exit_codes_and_data(self):
        code, env, err = self.envelope('check')
        self.assertEqual((code, env['data']['records'], env['data']['uniqueSourceFiles'], env['data']['problems']), (0, 1, 1, []))
        code, out, err = self.run_cli('check')
        self.assertRegex(out, r'^通过：1 条记录、1 个唯一源文件、0 个 vendor 文件')
        (cb.ARCHIVE/'source.js').write_text('tampered', encoding='utf-8')
        self.m['cases'][0]['entrypoints'].append('gone.js')
        self.write_catalog()
        code, env, err = self.envelope('check')
        self.assertEqual((code, env['error']['code'], len(env['data']['problems'])), (4, 'contract.check-failed', 2))
        self.assertIn('问题：Checksum mismatch', err)
        self.assertIn('问题：Missing entry point', err)

    def test_restore_exit_codes(self):
        out = self.root/'cli-out'
        code, env, err = self.envelope('restore', 'one', '--out', str(out), '--packs', str(self.root/'packs'), '--dry-run')
        self.assertEqual((code, env['data']['dryRun'], env['data']['files'], env['outputs']), (0, True, 2, []))
        self.assertFalse(out.exists())
        code, env, err = self.envelope('restore', 'one', '--out', str(out), '--packs', str(self.root/'packs'))
        self.assertEqual(code, 0, err)
        self.assertEqual(env['outputs'][0]['kind'], 'report')
        self.assertTrue(env['outputs'][0]['path'].endswith('styles/one/ARCHIVE-RESTORED.json'))
        code, env, err = self.envelope('restore', 'one', '--out', str(out), '--packs', str(self.root/'packs'))
        self.assertEqual((code, env['error']['code']), (2, 'usage.target-exists'))
        code, env, err = self.envelope('restore', 'one', '--out', str(out), '--packs', str(self.root/'packs'), '--if-exists', 'skip')
        self.assertEqual((code, env['data']['skipped']), (0, True))
        code, env, err = self.envelope('restore', 'one', '--out', str(self.root/'o2'), '--packs', str(self.root/'nowhere'))
        self.assertEqual((code, env['error']['code']), (3, 'env.missing-pack'))
        self.assertIn('--download', env['error']['hint'])
        self.base.add_source('rog.sh', b'ssh ROG@@@ROG_HOST@@ true\n', templated=True)
        self.write_catalog()
        code, env, err = self.envelope('restore', 'one', '--out', str(self.root/'o3'), '--packs', str(self.root/'packs'), '--strict')
        self.assertEqual((code, env['error']['code']), (3, 'env.unresolved-tokens'))
        self.assertFalse((self.root/'o3').exists())
        code, env, err = self.envelope('restore', 'one', '--out', str(self.root/'o4'), '--packs', str(self.root/'packs'))
        self.assertEqual((code, env['data']['unresolvedTokens']), (0, [{'file': 'rog.sh', 'line': 1, 'token': '@@ROG_HOST@@'}]))
        self.assertTrue(any('@@ROG_HOST@@' in w['message'] for w in env['warnings']))
        (self.root/'packs/assets.zip').write_bytes(b'not a zip')
        code, env, err = self.envelope('restore', 'one', '--out', str(self.root/'o5'), '--packs', str(self.root/'packs'))
        self.assertEqual((code, env['error']['code']), (4, 'contract.checksum'))

    def test_rehash_writes_the_catalog_only_when_asked(self):
        old, new, patch = self.base.rehash_fixture()
        self.write_catalog()
        patch_file = self.root/'patch.json'
        patch_file.write_text(json.dumps(patch), encoding='utf-8')
        before = (cb.ARCHIVE/'catalog.json').read_bytes()
        code, env, err = self.envelope('rehash', '--patch', str(patch_file), '--dry-run')
        self.assertEqual((code, env['data']['entries'], (cb.ARCHIVE/'catalog.json').read_bytes()), (0, 2, before))
        code, env, err = self.envelope('rehash', '--patch', str(patch_file))
        self.assertEqual((code, env['outputs'][0]['kind']), (0, 'catalog'))
        self.assertEqual(self.run_cli('check')[0], 0)
        patch['files'][0]['newSha256'] = '0' * 64
        patch_file.write_text(json.dumps(patch), encoding='utf-8')
        code, env, err = self.envelope('rehash', '--patch', str(patch_file))
        self.assertEqual((code, env['error']['code']), (4, 'contract.check-failed'))


@unittest.skipUnless((REAL_ARCHIVE/'catalog.json').exists(), 'case archive not present')
class RealArchiveTests(unittest.TestCase):
    """Regression checks on the real archive for the PPT cases whose scripts used the home folder (R75, R76)."""
    HOME = re.compile(r"""expanduser\(\s*['"]~|\$\{?HOME\b|Path\.home\(\)|process\.env\.HOME""")
    TILDE = re.compile(r"""(?:^|(?<=[\s=:;|&(]))~/""")
    KEPT = re.compile(r"""~/\.(?:ssh|config|claude/skills|rembg)\b|\$HOME/\.(?:ssh|config|rembg)\b|Path\.home\(\) / ['"]\.config""")

    @classmethod
    def setUpClass(cls):
        cls.tmp = safe_tempdir()
        cls.out = Path(cls.tmp.name)/'ws'
        cls.lemo = Path(cls.tmp.name)/'lemo'
        cls.m = cb.read_manifest()
        cls.targets = {cid: cb.restore(cls.m, cid, cls.out, Path(cls.tmp.name)/'packs', source_only=True, lemo=cls.lemo)
                       for cid in ('ppt-before-sunset', 'ppt-understands-you', 'ppt-painting-treasure', 'ppt-jianlong')}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_restored_scripts_do_not_resolve_the_real_home(self):
        for cid, target in self.targets.items():
            for f in target.rglob('*'):
                if f.suffix not in ('.py', '.sh', '.mjs', '.js'):
                    continue
                for n, line in enumerate(f.read_text(encoding='utf-8').splitlines(), 1):
                    if line.lstrip().startswith('#') or self.KEPT.search(line):
                        continue
                    live = self.HOME.search(line) or (f.suffix == '.sh' and self.TILDE.search(line))
                    self.assertFalse(live, f'{cid}/{f.relative_to(target)}:{n}: {line.strip()}')

    def test_project_roots_and_lemo_point_into_the_restore(self):
        sunset = self.targets['ppt-before-sunset']
        self.assertIn(f"P = os.path.expanduser('{sunset.resolve().as_posix()}/')",
                      (sunset/'film/build.py').read_text(encoding='utf-8'))
        you = self.targets['ppt-understands-you']
        self.assertIn(f'LIB={self.lemo.resolve().as_posix()}\n', (you/'build.sh').read_text(encoding='utf-8'))
        film = (self.targets['ppt-painting-treasure']/'film/assemble.sh').read_text(encoding='utf-8')
        self.assertIn(f'"{self.out.resolve().as_posix()}/Desktop/上影ppt/画境追宝_故事介绍.mp4"', film)
        self.assertNotIn('$HOME', film)

    def test_jianlong_paths_resolve_inside_the_restored_case(self):
        target = self.targets['ppt-jianlong']
        prefix = target.resolve().as_posix() + '/'      # C:/Users/... on Windows, not /...
        for rel, line in (('jianlong/tools/mix.py', 17), ('jianlong/tools/voenv.py', 4),
                          ('jianlong/music/score.py', 24), ('jianlong/music/score.py', 25)):
            text = (target/rel).read_text(encoding='utf-8').splitlines()[line - 1]
            paths = restored_literals(text, prefix)
            self.assertEqual(len(paths), 1, f'{rel}:{line}: {text}')
            self.assertTrue(Path(paths[0]).exists(), paths[0])
        self.assertEqual(json.loads((target/'ARCHIVE-RESTORED.json').read_text(encoding='utf-8'))['relatedCases'],
                         ['keynote-shared'])


if __name__ == '__main__':
    unittest.main()
