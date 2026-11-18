import { createLayerLook } from '../../../engine/offscreen/tsl/layers.js';
import { makeSyntheticLayers } from './layers-scene.mjs';

export function build({ THREE, TSL, renderer, width, height }) {
  const layers = makeSyntheticLayers(width, height);
  const look = createLayerLook({ THREE, TSL, renderer }, width, height);
  return {
    render() {
      look.render(layers, globalThis.__LAYERS_OPTS || {});
    },
    dispose() {
      look.dispose();
    },
  };
}
