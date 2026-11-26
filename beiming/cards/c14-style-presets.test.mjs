import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCardLibrary } from '../api/runtime.mjs';
import { createCardRegistry, validateCard } from './index.mjs';
const names = ['wide', 'actor', 'hero', 'hero-sunrise'];
const library = loadCardLibrary();
const registry = createCardRegistry(Object.values(library).map(({ card }) => card));

for (const name of names) {
  test(name + ' 通过 C1、主版本回读与数据入口', async () => {
    const id = 'post.beiming-look-' + name;
    const card = registry.getCard(id + '@1');
    assert.ok(card, '注册表缺少 ' + id);
    const validation = validateCard(card);
    assert.ok(validation.ok, JSON.stringify(validation));
    assert.equal(card.visibleToAgent, false);
    assert.deepEqual(card.status.map(row => row.level), ['read']);
    assert.deepEqual(registry.searchCards({ q: id, allowReproduced: true }), []);
    const { evaluate } = await import(new URL('../' + card.impl[0].entry, import.meta.url));
    const expected = { lookPreset: JSON.parse(library[id].files['preset.json']) };
    assert.deepEqual(card.ports.out, [{ name: 'lookPreset', type: 'tracks.lookPreset' }]);
    assert.equal(expected.lookPreset.ref, 'beiming-original@v1/' + name);
    const first = evaluate({}, {}, 0, 0);
    assert.deepEqual(first, expected);
    first.lookPreset.look.params.outline = null;
    assert.deepEqual(evaluate({}, {}, 137, 0.5), expected);
  });
}
