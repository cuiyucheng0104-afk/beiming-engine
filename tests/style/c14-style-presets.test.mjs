import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadCardLibrary } from '../../beiming/api/runtime.mjs';
import { listLookPresets, resolveLook, validateStyleLock } from '../../engine/style/index.js';

const names = ['wide', 'actor', 'hero', 'hero-sunrise'];
const styleRef = 'beiming-original@v1';
const styleRoot = new URL('../../engine/style/', import.meta.url);
const readStyleJson = name => JSON.parse(readFileSync(new URL(name, styleRoot), 'utf8'));
const styleRegistry = readStyleJson('registry.json');
const source = styleRegistry.styles.find(({ id, version }) => `${id}@v${version}` === styleRef);
assert.ok(source, '原注册表缺少 ' + styleRef);
const style = readStyleJson(source.file);
const library = loadCardLibrary();

test('原画风登记表的镜头预设与迁移清单一致', () => {
  assert.equal(`${style.styleId}@${style.version}`, styleRef);
  assert.deepEqual(validateStyleLock(style), []);
  assert.deepEqual(listLookPresets(styleRegistry).filter(ref => ref.startsWith(styleRef + '/')).sort(),
    names.map(name => styleRef + '/' + name).sort());
});

for (const name of names) {
  test(name + ' 的卡数据与登记的画风及覆盖校验输入逐字段一致', async () => {
    const { card } = library['post.beiming-look-' + name];
    const { evaluate } = await import(new URL('../../beiming/' + card.impl[0].entry, import.meta.url));
    assert.deepEqual(evaluate({}, {}, 0, 0).lookPreset, {
      ref: styleRef + '/' + name,
      look: resolveLook(style, name),
      overridePaths: Object.assign({}, ...style.allowedOverrides.map(rule => rule.paths)),
    });
  });
}
