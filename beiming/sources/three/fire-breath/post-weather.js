// Metres in world space. Bake the repeating light-transmission tile, not a camera image.
// R = clear sky, G = weather-front displacement, B = light along a broken cloud edge.
const span = 704,
  sun = [0.558, 0.423, 0.714],
  slope = [sun[0] / sun[1], sun[2] / sun[1]];
const hermite = (t) => ((t = Math.min(1, Math.max(0, t))), t * t * (3 - 2 * t));
const step = (lo, hi, x) => hermite((x - lo) / (hi - lo));
const lerp = (a, b, t) => a + (b - a) * t;
function hash(i, j, channel) {
  const m = Math.imul;
  const h = m(i, 374761393) ^ m(j, 668265263) ^ m(channel, 1274126177);
  const n = m(h ^ (h >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 2 ** 32;
}
function field(x, y, frequency, channel) {
  const u = x * frequency,
    v = y * frequency,
    i = Math.floor(u),
    j = Math.floor(v);
  const sample = (a, b) => hash(a % frequency, b % frequency, channel);
  const t = hermite(u - i);
  return lerp(lerp(sample(i, j), sample(i + 1, j), t), lerp(sample(i, j + 1), sample(i + 1, j + 1), t), hermite(v - j));
}
function bakeTile(THREE) {
  const n = 256,
    mask = new Float32Array(n * n).fill(-80),
    bytes = new Uint8Array(4 * n * n);
  const wx = -5.6 / Math.hypot(5.6, 2.2),
    wz = 2.2 / Math.hypot(5.6, 2.2);
  // Rasterize local ellipses onto a torus rather than visiting every cloud for every pixel.
  function stamp(u, v, r, stretch, cut = false) {
    const range = Math.ceil(((cut ? r : r * stretch + 82) * n) / span) + 1;
    const cx = Math.floor(u * n),
      cy = Math.floor(v * n);
    for (let j = cy - range; j <= cy + range; j++)
      for (let i = cx - range; i <= cx + range; i++) {
        const dx = ((i + 0.5) / n - u) * span,
          dz = ((j + 0.5) / n - v) * span;
        const d = Math.hypot((dx * wx + dz * wz) / stretch, dz * wx - dx * wz);
        const k = (j & (n - 1)) * n + (i & (n - 1));
        mask[k] = cut ? Math.min(mask[k], d - r) : Math.max(mask[k], r - d);
      }
  }
  for (const [cells, skip, jitter, lo, hi, stretch, seed] of [
    [7, 0.14, 0.62, 19, 38, 0.45, 31],
    [15, 0.42, 0.8, 8, 15, 0.6, 51],
  ]) {
    for (let j = 0; j < cells; j++)
      for (let i = 0; i < cells; i++) {
        const rand = (k) => hash(i, j, k + seed);
        if (rand(0) >= skip)
          stamp(
            (i + 0.5 + jitter * (rand(1) - 0.5)) / cells,
            (j + 0.5 + jitter * (rand(2) - 0.5)) / cells,
            lerp(lo, hi, rand(3)),
            1 + stretch * rand(4),
          );
      }
  }
  const groundUV = (x, y, z, t) => [(x - slope[0] * y + 5.6 * t) / span, 0.775 + (z - slope[1] * y - 2.2 * t) / span];
  for (let t = 1; t <= 19; t += 0.5)
    if (t < 6.6 || t > 15.4) {
      for (const [x, y, z] of [
        [0, 24, -12],
        [0, 8, -5],
        [-14, 24, -10],
        [14, 24, -10],
      ])
        stamp(...groundUV(x, y, z, t), 38, 1, true);
    }
  stamp(...groundUV(0, 18, -9, 10.3), 33, 0.62);
  for (let k = 0; k < mask.length; k++) {
    const x = ((k % n) + 0.5) / n,
      y = (Math.floor(k / n) + 0.5) / n,
      noise = (f, s) => field(x, y, f, s);
    const edge = mask[k] + 22 * (0.55 * noise(22, 1) + 0.3 * noise(45, 2) + 0.15 * noise(90, 3) - 0.5);
    const glints = step(0.6, 0.72, 0.65 * noise(29, 41) + 0.35 * noise(61, 42));
    bytes[4 * k] = Math.round(255 * (1 - step(-4.5, 4.5, edge)));
    bytes[4 * k + 1] = Math.round(255 * (0.6 * noise(4, 11) + 0.4 * noise(9, 12)));
    bytes[4 * k + 2] = Math.round(255 * glints * step(-70, -16, edge) * (1 - step(-3, 5, edge)));
    bytes[4 * k + 3] = 255;
  }
  const tex = new THREE.DataTexture(bytes, n, n);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createWeather(THREE, model) {
  const texture = bakeTile(THREE),
    az = Math.hypot(sun[0], sun[2]);
  const shadowCam = new THREE.OrthographicCamera(-150, 150, 170, -170, 20, 1100);
  const centre = new THREE.Vector3(0, 45, -40);
  shadowCam.position.fromArray(sun).normalize().multiplyScalar(520).add(centre);
  shadowCam.lookAt(centre);
  shadowCam.updateMatrixWorld();
  const matrix = new THREE.Matrix4()
    .makeScale(0.5, 0.5, 0.5)
    .setPosition(0.5, 0.5, 0.5)
    .multiply(shadowCam.projectionMatrix)
    .multiply(shadowCam.matrixWorldInverse)
    .toArray();
  const depthOnly = new THREE.MeshDepthMaterial({ colorWrite: false });
  const shadowRT = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RedFormat,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  function shadowMap(renderer, w, lightShadow) {
    if (lightShadow?.map?.depthTexture) {
      // r187's PCF map is a comparison sampler. Blit the *same* depth, unfiltered,
      // into an attachment with no compare function for the volume card's sampler2D.
      const src = lightShadow.map;
      shadowRT.setSize(src.width, src.height);
      renderer.setRenderTarget(shadowRT);
      renderer.copyTextureToTexture(src.depthTexture, shadowRT.depthTexture);
      return { texture: shadowRT.depthTexture, matrix: lightShadow.matrix.elements, packed: false };
    }
    const scene = model.scene,
      background = scene.background,
      override = scene.overrideMaterial;
    const masks = [];
    let hasCaster = false;
    // Layers suppress a draw, not the children beneath it. Do not lose a casting child of a non-caster.
    scene.traverseVisible((o) => {
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
        if (o.castShadow) hasCaster = true;
        else {
          masks.push([o, o.layers.mask]);
          o.layers.mask = 0;
        }
      }
    });
    try {
      if (!hasCaster) return null;
      const n = Math.min(4096, renderer.capabilities.maxTextureSize, 2 ** Math.ceil(Math.log2(Math.max(128, 2 * w))));
      shadowRT.setSize(n, n);
      scene.background = null;
      scene.overrideMaterial = depthOnly;
      renderer.setRenderTarget(shadowRT);
      renderer.clear();
      renderer.render(scene, shadowCam);
      return { texture: shadowRT.depthTexture, matrix, packed: false };
    } finally {
      scene.background = background;
      scene.overrideMaterial = override;
      for (const [o, mask] of masks) o.layers.mask = mask;
    }
  }
  function frame(renderer, w, t, lightShadow) {
    const ceiling = 84 + 4 * Math.sin(0.37 * t + 1) + 1.5 * Math.sin(0.93 * t);
    const segments = [],
      radii = [];
    for (const [i, length] of [172, 150].entries()) {
      let lowest = Infinity;
      const points = [0, 0.33, 0.66, 0.97].map((fraction) => {
        let x = 0,
          y = 0,
          z = 0;
        if (model.railPoint)
          for (let k = -2; k <= 2; k++) {
            const [px, py, pz] = model.railPoint(i, t + 0.6 * k, fraction * length),
              weight = (3 - Math.abs(k)) / 9;
            x += weight * (px - slope[0] * py);
            y += weight * py;
            z += weight * (pz - slope[1] * py);
          }
        lowest = Math.min(y, lowest);
        return [x, z];
      });
      radii.push(model.railPoint ? lerp(40, -70, step(ceiling - 12, ceiling + 6, lowest)) : -70);
      for (let j = 1; j < points.length; j++) segments.push(...points[j - 1], ...points[j]);
    }
    const dusk = 0.75 * step(0, 86, Math.floor(t * 4) / 4),
      key = 0.24 * (1 - 0.34 * dusk);
    return {
      lightColor: [key, key * 0.66 * (1 - 0.3 * dusk * dusk), key * 0.38 * (1 - 0.48 * dusk * dusk)],
      shadow: shadowMap(renderer, w, lightShadow),
      clouds: {
        texture,
        slope,
        azimuth: [sun[0] / az, sun[2] / az],
        frequency: 1 / span,
        cover: 0.8,
        offset: [(5.6 * t) / span, 0.775 - (2.2 * t) / span],
        storm: [27 * (t - 26.6) - 42, 0.9, 520, 0],
        edge: 10,
        ceiling,
        radii,
        segments,
      },
    };
  }
  return {
    frame,
    dispose() {
      texture.dispose();
      depthOnly.dispose();
      shadowRT.dispose();
    },
  };
}
