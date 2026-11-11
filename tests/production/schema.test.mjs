// film.schema.json（给编辑器与 agent 看的结构）与校验器 film.js 的字段白名单、取值表保持一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AIGC_KINDS, AUDIO_MODES, DRIVES, EVALUATIONS, EVENT_DOMAINS, EVENT_SYNCS, FILM_FIELDS, GATE_KEYS, INTENTIONAL_KINDS, TRANSITIONS, validateFilm } from '../../engine/production/film.js';
import { BUILTIN_ROUTES } from '../../engine/production/routes.js';
import { REPO, minimalFilm } from './helpers.mjs';

const schema = JSON.parse(readFileSync(join(REPO, 'engine', 'production', 'film.schema.json'), 'utf8'));
const P = schema.properties;
const keys = o => Object.keys(o).sort();

test('顶层与各段的字段集合和校验器的白名单相同', () => {
  assert.deepEqual(keys(P), [...FILM_FIELDS.top, ...FILM_FIELDS.compat].sort());
  assert.deepEqual(keys(P.output.properties), [...FILM_FIELDS.output].sort());
  assert.deepEqual(keys(P.shots.items.properties), [...FILM_FIELDS.shot].sort());
  assert.deepEqual(keys(P.events.items.properties), [...FILM_FIELDS.event].sort());
  assert.deepEqual(keys(P.qa.properties), [...FILM_FIELDS.qa].sort());
  assert.deepEqual(keys(schema.$defs.intentional.properties), [...FILM_FIELDS.intentional].sort());
  assert.deepEqual(keys(schema.$defs.waiver.properties), [...FILM_FIELDS.waiver].sort());
  assert.deepEqual(keys(P.timeline.properties), [...FILM_FIELDS.timeline].sort());
  assert.deepEqual(keys(P.tempo.items.properties), [...FILM_FIELDS.tempo].sort());
  assert.deepEqual(keys(P.audio.properties), [...FILM_FIELDS.audio].sort());
  assert.deepEqual(keys(P.style.properties), [...FILM_FIELDS.style].sort());
  assert.deepEqual(keys(P.credits.items.properties), [...FILM_FIELDS.credit].sort());
  assert.deepEqual(keys(P.aigc.properties), [...FILM_FIELDS.aigc].sort());
  assert.deepEqual(keys(P.docs.properties), [...FILM_FIELDS.docs].sort());
  assert.deepEqual(keys(P.mirror.properties), [...FILM_FIELDS.mirror].sort());
  assert.deepEqual(keys(P.cuecheck.properties), [...FILM_FIELDS.cuecheck].sort());
  assert.deepEqual(keys(P.methodRefs.items.properties), [...FILM_FIELDS.methodRef].sort());
});

test('取值表相同：路线、后端、评估方式、转场、事件域、声画同步、声音方式、节拍主导、刻意画面种类、AIGC 种类、闸门', () => {
  assert.deepEqual(P.route.enum, BUILTIN_ROUTES.map(r => r.id));
  assert.deepEqual([...P.backend.enum].sort(), [...new Set(BUILTIN_ROUTES.flatMap(r => r.backends))].sort());
  assert.deepEqual(P.shots.items.properties.evaluation.enum, EVALUATIONS);
  assert.deepEqual(P.shots.items.properties.transition.enum, TRANSITIONS);
  assert.deepEqual(P.events.items.properties.domain.enum, EVENT_DOMAINS);
  assert.deepEqual(P.audio.properties.mode.enum, AUDIO_MODES);
  assert.deepEqual(P.drive.enum, DRIVES);
  assert.deepEqual(P.events.items.properties.sync.enum, EVENT_SYNCS);
  assert.deepEqual(schema.$defs.intentional.properties.kind.enum, INTENTIONAL_KINDS);
  assert.deepEqual(P.aigc.properties.kinds.items.enum, Object.keys(AIGC_KINDS));
  assert.deepEqual(keys(P.gates.properties), [...GATE_KEYS].sort());
  // schema 里的必填项，校验器也必填
  for (const k of schema.required.filter(k => !['schemaVersion'].includes(k))) {
    const f = minimalFilm(); delete f[k];
    assert.ok(validateFilm(f, { checkFiles: false }).diagnostics.some(d => d.level === 'error'), `删掉 ${k} 应当报错`);
  }
});
