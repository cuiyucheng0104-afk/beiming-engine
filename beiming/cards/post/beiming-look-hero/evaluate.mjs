import preset from './preset.json' with { type: 'json' };

export function evaluate() {
  return { lookPreset: globalThis.structuredClone(preset) };
}
