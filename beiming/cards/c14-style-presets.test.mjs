import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCardLibrary } from '../api/runtime.mjs';
import { createCardRegistry, validateCard } from './index.mjs';
import { listLookPresets, loadRegistrySync, loadStyleSync, resolveLook } from '../../engine/style/index.js';

const names = ['wide', 'actor', 'hero', 'hero-sunrise'];
const styleRef = 'beiming-original@v1';
const style = loadStyleSync(styleRef);
const library = loadCardLibrary();
const registry = createCardRegistry(Object.values(library).map(({ card }) => card));

test('原画风登记表的镜头预设与迁移清单一致', () => {
  assert.deepEqual(listLookPresets(loadRegistrySync()).filter(ref => ref.startsWith(styleRef + '/')).sort(),
    names.map(name => styleRef + '/' + name).sort());
});

for (const name of names) {
  test(name + ' 通过 C1、主版本回读与原预设逐字段对照', async () => {
    const id = 'post.beiming-look-' + name;
    const card = registry.getCard(id + '@1');
    assert.ok(card, '注册表缺少 ' + id);
    const validation = validateCard(card);
    assert.ok(validation.ok, JSON.stringify(validation));
    assert.equal(card.visibleToAgent, false);
    assert.deepEqual(card.status.map(row => row.level), ['read']);
    assert.deepEqual(registry.searchCards({ q: id, allowReproduced: true }), []);
    const { evaluate } = await import(new URL('../' + card.impl[0].entry, import.meta.url));
    const expected = {
      ref: styleRef + '/' + name,
      look: resolveLook(style, name),
      overridePaths: Object.assign({}, ...style.allowedOverrides.map(rule => rule.paths)),
    };
    const first = evaluate({}, {}, 0, 0);
    assert.deepEqual(first, { lookPreset: expected });
    first.lookPreset.look.params.outline = null;
    assert.deepEqual(evaluate({}, {}, 137, 0.5), { lookPreset: expected });
  });
}
