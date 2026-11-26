import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCardLibrary } from '../../beiming/api/runtime.mjs';
import { listLookPresets, loadRegistrySync, loadStyleSync, resolveLook } from '../../engine/style/index.js';

const names = ['wide', 'actor', 'hero', 'hero-sunrise'];
const styleRef = 'beiming-original@v1';
const style = loadStyleSync(styleRef);
const library = loadCardLibrary();

test('原画风登记表的镜头预设与迁移清单一致', () => {
  assert.deepEqual(listLookPresets(loadRegistrySync()).filter(ref => ref.startsWith(styleRef + '/')).sort(),
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
