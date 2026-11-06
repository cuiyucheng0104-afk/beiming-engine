import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('casebook', Path(__file__).with_name('casebook.py'))
cb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cb)


class CasebookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
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
        return cb.restore(self.m, 'one', self.root/'out', self.root/'packs', **kw)

    def test_roundtrip_and_tokens(self):
        self.assertEqual(cb.check(self.m), (1, 1))
        p = self.restore()
        self.assertIn(p.as_posix(), (p/'main.js').read_text())
        self.assertEqual((p/'assets/a.bin').read_bytes(), b'asset bytes')
        self.assertFalse(json.loads((p/'ARCHIVE-RESTORED.json').read_text())['sourceOnly'])

    def test_no_overwrite(self):
        p = self.restore()
        (p/'main.js').write_text('user edits')
        with self.assertRaises(FileExistsError): self.restore()
        self.assertEqual((p/'main.js').read_text(), 'user edits')

    def test_traversal_and_absolute(self):
        for name in ['../outside', '/etc/a', 'C:/a', 'a\\..\\b']:
            with self.assertRaises(ValueError): cb.safe_path(self.root, name)

    def test_symlink_escape(self):
        outside = self.root/'outside'
        outside.mkdir()
        base = self.root/'base'
        base.mkdir()
        (base/'link').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): cb.safe_path(base, 'link/a')

    def test_corrupt_pack_fails_before_destination(self):
        (self.root/'packs/assets.zip').write_bytes(b'bad')
        with self.assertRaises(ValueError): self.restore()
        self.assertFalse((self.root/'out/styles/one').exists())

    def test_corrupt_source_cleans_partial(self):
        (cb.ARCHIVE/'source.js').write_text('tampered')
        with self.assertRaises(ValueError): self.restore()
        self.assertFalse((self.root/'out/styles/one').exists())
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
        (cb.ARCHIVE/'vendor/lock.json').write_text(json.dumps(lock))
        self.assertEqual(cb.check(self.m), (1, 1))
        (folder/'extra.js').write_bytes(b'extra')
        with self.assertRaises(ValueError): cb.check(self.m)
        (folder/'extra.js').unlink()
        (folder/'lib.js').write_bytes(b'changed!\n')
        with self.assertRaises(ValueError): cb.check(self.m)


if __name__ == '__main__':
    unittest.main()
