import card from './card.json' with { type: 'json' };

export function evaluate() {
  return { reference: { title: card.title, source: card.provenance.note } };
}
