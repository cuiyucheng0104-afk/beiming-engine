import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCardLibrary } from '../api/runtime.mjs';
import { createCardRegistry, validateCard } from './index.mjs';

const library = loadCardLibrary();
const registry = createCardRegistry(Object.values(library).map(({ card }) => card));
const craft = Object.values(library).filter(({ card }) => card.id.includes('.craft-'));

test('每项占位工艺可按主版本读取，只有独立的参考资料输出', async () => {
  assert.ok(craft.length > 0);
  for (const { card, files, dir } of craft) {
    assert.deepEqual(registry.getCard(card.id + '@1'), card);
    const validation = validateCard(card);
    assert.ok(validation.ok, card.id + ': ' + JSON.stringify(validation));
    assert.deepEqual(card.status.map(({ level }) => level), ['read']);
    assert.equal(card.visibleToAgent, false);
    assert.deepEqual(registry.searchCards({ q: card.id, allowReproduced: true }), []);
    assert.deepEqual(card.params, {});
    assert.deepEqual(card.ports, {
      in: [], out: [{ name: 'reference', type: 'tracks.craftReference' }],
      order: { before: [], after: [] }, requires: [],
    });
    assert.deepEqual(card.livesIn, ['data']);
    assert.deepEqual(card.impl, [{
      livesIn: 'data', entry: dir + '/evaluate.mjs', shape: 'evaluate', hosts: [],
      selftest: 'cards/c14-craft.test.mjs',
    }]);
    assert.deepEqual(Object.keys(files).sort(), ['card.json', 'evaluate.mjs']);
    const { evaluate } = await import(new URL('../' + card.impl[0].entry, import.meta.url));
    const expected = { reference: { title: card.title, source: card.provenance.note } };
    const first = evaluate({}, {}, 0, 0);
    assert.deepEqual(first, expected);
    first.reference.source = '';
    assert.deepEqual(evaluate({}, {}, 137, 0.5), expected);
  }
});
