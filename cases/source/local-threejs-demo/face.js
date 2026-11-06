import * as THREE from "three";

// --- Helpers ---
function gauss(x, mean, sigma) {
  const d = x - mean;
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}
function smoothstep(t) {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) { return a + (b - a) * t; }

// --- Parameter Definitions (70 total) ---
// Each: { name, category, min, max, default, regions[] }
// Region: { cx,cy,cz, radius, dx,dy,dz, strength, mirror?, front?, axisScale? }

function R(cx, cy, cz, radius, dx, dy, dz, strength, opts = {}) {
  return { cx, cy, cz, radius, dx, dy, dz, strength, ...opts };
}

export const CATEGORIES = [
  { id: "face",     label: "Face Shape",     icon: "oval" },
  { id: "forehead", label: "Forehead",       icon: "arch" },
  { id: "eyes",     label: "Eyes",           icon: "eye" },
  { id: "eyebrows", label: "Eyebrows",       icon: "brow" },
  { id: "nose",     label: "Nose",           icon: "nose" },
  { id: "mouth",    label: "Mouth & Lips",   icon: "lips" },
  { id: "cheeks",   label: "Cheeks",         icon: "cheek" },
  { id: "jaw",      label: "Jaw & Chin",     icon: "jaw" },
];

export const PARAMS = [
  // === FACE SHAPE (8) ===
  { name: "Face Width",     category: "face", regions: [R(0, 0, 0.2, 1.6, 1,0,0, 0.18, {mirror:true, front:true})] },
  { name: "Face Height",    category: "face", regions: [R(0, 0, 0.2, 1.6, 0,1,0, 0.15, {front:true, ySign:true})] },
  { name: "Face Depth",     category: "face", regions: [R(0, 0, 0.5, 1.2, 0,0,1, 0.15, {front:true})] },
  { name: "Face Roundness", category: "face", regions: [R(0, 0, 0.3, 1.4, 1,0,1, 0.12, {radial:true, front:true})] },
  { name: "Face Taper",     category: "face", regions: [R(0,-0.35,0.2, 0.8, 1,0,0, 0.15, {mirror:true, front:true, yWeight:-1})] },
  { name: "Face Asymmetry", category: "face", regions: [R(0, 0, 0.4, 1.2, 1,0,0, 0.08, {front:true})] },
  { name: "Skull Width",    category: "face", regions: [R(0, 0.4, -0.2, 1.0, 1,0,0, 0.12, {mirror:true})] },
  { name: "Skull Depth",    category: "face", regions: [R(0, 0.3, -0.3, 1.0, 0,0,-1, 0.15)] },

  // === FOREHEAD (6) ===
  { name: "Forehead Width",  category: "forehead", regions: [R(0, 0.65, 0.4, 0.5, 1,0,0, 0.14, {mirror:true, front:true})] },
  { name: "Forehead Height", category: "forehead", regions: [R(0, 0.7, 0.3, 0.5, 0,1,0, 0.12, {front:true})] },
  { name: "Forehead Slope",  category: "forehead", regions: [R(0, 0.6, 0.55, 0.4, 0,0,1, 0.15, {front:true})] },
  { name: "Forehead Bulge",  category: "forehead", regions: [R(0, 0.55, 0.6, 0.35, 0,0,1, 0.12, {front:true})] },
  { name: "Brow Ridge",      category: "forehead", regions: [R(0, 0.38, 0.7, 0.25, 0,0,1, 0.12, {front:true})] },
  { name: "Temple Width",    category: "forehead", regions: [R(0.5, 0.4, 0.2, 0.35, 1,0,0, 0.12, {mirror:true})] },

  // === EYES (14) ===
  { name: "Eye Size",         category: "eyes", regions: [R(0.28, 0.3, 0.7, 0.18, 0,0,-1, 0.12, {mirror:true, front:true})] },
  { name: "Eye Width",        category: "eyes", regions: [R(0.28, 0.3, 0.65, 0.2, 1,0,0, 0.08, {mirror:true, front:true, localScale:true})] },
  { name: "Eye Height",       category: "eyes", regions: [R(0.28, 0.3, 0.65, 0.2, 0,1,0, 0.08, {mirror:true, front:true, localScale:true})] },
  { name: "Eye Spacing",      category: "eyes", regions: [R(0.28, 0.3, 0.7, 0.22, 1,0,0, 0.12, {mirror:true, front:true})] },
  { name: "Eye Depth",        category: "eyes", regions: [R(0.28, 0.3, 0.7, 0.18, 0,0,-1, 0.15, {mirror:true, front:true})] },
  { name: "Eye Tilt",         category: "eyes", regions: [R(0.28, 0.3, 0.7, 0.2, 0,1,0, 0.06, {mirror:true, front:true, xWeight:1})] },
  { name: "Upper Eyelid",     category: "eyes", regions: [R(0.28, 0.34, 0.72, 0.12, 0,1,0, 0.08, {mirror:true, front:true})] },
  { name: "Lower Eyelid",     category: "eyes", regions: [R(0.28, 0.26, 0.72, 0.12, 0,-1,0, 0.08, {mirror:true, front:true})] },
  { name: "Inner Eye Corner",  category: "eyes", regions: [R(0.15, 0.3, 0.72, 0.1, 0,0,1, 0.06, {mirror:true, front:true})] },
  { name: "Outer Eye Corner",  category: "eyes", regions: [R(0.42, 0.3, 0.68, 0.1, 0,0,1, 0.06, {mirror:true, front:true})] },
  { name: "Eye Socket Depth",  category: "eyes", regions: [R(0.28, 0.3, 0.65, 0.25, 0,0,-1, 0.1, {mirror:true, front:true})] },
  { name: "Eye Protrusion",    category: "eyes", regions: [R(0.28, 0.3, 0.75, 0.15, 0,0,1, 0.1, {mirror:true, front:true})] },
  { name: "Under Eye Fullness",category: "eyes", regions: [R(0.28, 0.22, 0.72, 0.12, 0,0,1, 0.08, {mirror:true, front:true})] },
  { name: "Eye Bag",           category: "eyes", regions: [R(0.28, 0.2, 0.7, 0.1, 0,-1,0.5, 0.06, {mirror:true, front:true})] },

  // === EYEBROWS (8) ===
  { name: "Brow Height",       category: "eyebrows", regions: [R(0.28, 0.42, 0.7, 0.18, 0,1,0, 0.1, {mirror:true, front:true})] },
  { name: "Brow Thickness",    category: "eyebrows", regions: [R(0.28, 0.42, 0.72, 0.15, 0,0,1, 0.06, {mirror:true, front:true})] },
  { name: "Brow Arch",         category: "eyebrows", regions: [R(0.32, 0.44, 0.68, 0.12, 0,1,0, 0.08, {mirror:true, front:true})] },
  { name: "Brow Spacing",      category: "eyebrows", regions: [R(0.28, 0.42, 0.7, 0.18, 1,0,0, 0.08, {mirror:true, front:true})] },
  { name: "Brow Inner Height", category: "eyebrows", regions: [R(0.14, 0.42, 0.72, 0.1, 0,1,0, 0.08, {mirror:true, front:true})] },
  { name: "Brow Outer Height", category: "eyebrows", regions: [R(0.44, 0.4, 0.65, 0.1, 0,1,0, 0.08, {mirror:true, front:true})] },
  { name: "Brow Angle",        category: "eyebrows", regions: [R(0.28, 0.42, 0.7, 0.2, 0,1,0, 0.06, {mirror:true, front:true, xWeight:1})] },
  { name: "Brow Depth",        category: "eyebrows", regions: [R(0.28, 0.42, 0.72, 0.15, 0,0,1, 0.08, {mirror:true, front:true})] },

  // === NOSE (12) ===
  { name: "Nose Width",         category: "nose", regions: [R(0, 0.05, 0.85, 0.2, 1,0,0, 0.1, {mirror:true, front:true})] },
  { name: "Nose Height",        category: "nose", regions: [R(0, 0.15, 0.8, 0.3, 0,1,0, 0.12, {front:true})] },
  { name: "Nose Length",         category: "nose", regions: [R(0, 0.05, 0.9, 0.2, 0,-1,0, 0.12, {front:true})] },
  { name: "Nose Bridge Width",   category: "nose", regions: [R(0, 0.25, 0.78, 0.15, 1,0,0, 0.08, {mirror:true, front:true})] },
  { name: "Nose Bridge Depth",   category: "nose", regions: [R(0, 0.22, 0.8, 0.15, 0,0,1, 0.12, {front:true})] },
  { name: "Nose Tip Width",      category: "nose", regions: [R(0, 0.0, 0.95, 0.12, 1,0,0, 0.08, {mirror:true, front:true})] },
  { name: "Nose Tip Height",     category: "nose", regions: [R(0, 0.02, 0.95, 0.1, 0,1,0, 0.08, {front:true})] },
  { name: "Nose Tip Protrusion", category: "nose", regions: [R(0, 0.0, 0.95, 0.12, 0,0,1, 0.12, {front:true})] },
  { name: "Nostril Width",       category: "nose", regions: [R(0.12, -0.05, 0.85, 0.1, 1,0,0, 0.08, {mirror:true, front:true})] },
  { name: "Nostril Height",      category: "nose", regions: [R(0.1, -0.06, 0.85, 0.08, 0,-1,0, 0.06, {mirror:true, front:true})] },
  { name: "Nostril Flare",       category: "nose", regions: [R(0.14, -0.04, 0.82, 0.1, 1,0,-0.3, 0.08, {mirror:true, front:true})] },
  { name: "Nose Curve",          category: "nose", regions: [R(0, 0.15, 0.85, 0.2, 0,0,1, 0.08, {front:true})] },

  // === MOUTH & LIPS (10) ===
  { name: "Mouth Width",          category: "mouth", regions: [R(0, -0.18, 0.82, 0.2, 1,0,0, 0.1, {mirror:true, front:true, localScale:true})] },
  { name: "Mouth Position",       category: "mouth", regions: [R(0, -0.18, 0.82, 0.2, 0,1,0, 0.08, {front:true})] },
  { name: "Upper Lip Thickness",  category: "mouth", regions: [R(0, -0.14, 0.88, 0.1, 0,1,0.5, 0.06, {front:true})] },
  { name: "Lower Lip Thickness",  category: "mouth", regions: [R(0, -0.22, 0.86, 0.1, 0,-1,0.5, 0.06, {front:true})] },
  { name: "Upper Lip Curve",      category: "mouth", regions: [R(0, -0.13, 0.9, 0.08, 0,0,1, 0.06, {front:true})] },
  { name: "Lower Lip Curve",      category: "mouth", regions: [R(0, -0.24, 0.88, 0.08, 0,0,1, 0.06, {front:true})] },
  { name: "Lip Protrusion",       category: "mouth", regions: [R(0, -0.18, 0.88, 0.15, 0,0,1, 0.1, {front:true})] },
  { name: "Mouth Corner Angle",   category: "mouth", regions: [R(0.2, -0.18, 0.78, 0.1, 0,1,0, 0.06, {mirror:true, front:true})] },
  { name: "Cupid Bow",            category: "mouth", regions: [R(0, -0.12, 0.9, 0.06, 0,1,0.5, 0.05, {front:true})] },
  { name: "Philtrum Depth",       category: "mouth", regions: [R(0, -0.08, 0.88, 0.06, 0,0,-1, 0.06, {front:true})] },

  // === CHEEKS (6) ===
  { name: "Cheek Width",          category: "cheeks", regions: [R(0.45, 0.12, 0.5, 0.3, 1,0,0, 0.15, {mirror:true})] },
  { name: "Cheek Height",         category: "cheeks", regions: [R(0.4, 0.15, 0.55, 0.25, 0,1,0, 0.1, {mirror:true})] },
  { name: "Cheek Fullness",       category: "cheeks", regions: [R(0.35, 0.05, 0.6, 0.3, 0.5,0,1, 0.12, {mirror:true, front:true})] },
  { name: "Cheekbone Prominence", category: "cheeks", regions: [R(0.48, 0.18, 0.55, 0.2, 1,0.3,0.3, 0.1, {mirror:true})] },
  { name: "Cheek Hollow",         category: "cheeks", regions: [R(0.38, -0.02, 0.6, 0.18, -0.5,0,-1, 0.08, {mirror:true, front:true})] },
  { name: "Nasolabial Fold",      category: "cheeks", regions: [R(0.18, -0.08, 0.8, 0.12, 0,0,-1, 0.06, {mirror:true, front:true})] },

  // === JAW & CHIN (6) ===
  { name: "Jaw Width",     category: "jaw", regions: [R(0.42, -0.28, 0.35, 0.3, 1,0,0, 0.15, {mirror:true})] },
  { name: "Jaw Height",    category: "jaw", regions: [R(0.35, -0.32, 0.3, 0.25, 0,-1,0, 0.12, {mirror:true})] },
  { name: "Jaw Angle",     category: "jaw", regions: [R(0.45, -0.3, 0.25, 0.2, 1,-1,0, 0.1, {mirror:true})] },
  { name: "Chin Width",    category: "jaw", regions: [R(0, -0.5, 0.5, 0.2, 1,0,0, 0.1, {mirror:true, front:true})] },
  { name: "Chin Height",   category: "jaw", regions: [R(0, -0.5, 0.5, 0.2, 0,-1,0, 0.12, {front:true})] },
  { name: "Chin Protrusion", category: "jaw", regions: [R(0, -0.45, 0.6, 0.18, 0,0,1, 0.12, {front:true})] },
];

// Fill defaults
PARAMS.forEach(p => {
  if (p.min === undefined) p.min = -1;
  if (p.max === undefined) p.max = 1;
  if (p.default === undefined) p.default = 0;
});

// --- Face Generator Class ---
export class FaceGenerator {
  constructor() {
    this.values = {};
    PARAMS.forEach(p => this.values[p.name] = p.default);

    this.group = new THREE.Group();
    this._buildMesh();
  }

  _buildMesh() {
    const geo = new THREE.SphereGeometry(1, 72, 56);
    this._shapeBaseFace(geo);
    geo.computeVertexNormals();

    // Store base
    this.geometry = geo;
    this.basePositions = new Float32Array(geo.attributes.position.array);

    // Vertex colors for skin variation
    this._addVertexColors(geo);

    // Solid material
    this.solidMaterial = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.02,
      clearcoat: 0.15,
      clearcoatRoughness: 0.4,
      sheen: 0.3,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0.8, 0.3, 0.25),
      side: THREE.DoubleSide,
    });

    this.wireMaterial = new THREE.MeshBasicMaterial({
      color: 0xe94560,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
    });

    this.solidMesh = new THREE.Mesh(geo, this.solidMaterial);
    this.wireMesh = new THREE.Mesh(geo, this.wireMaterial);
    this.wireMesh.visible = false;

    this.group.add(this.solidMesh);
    this.group.add(this.wireMesh);
  }

  _shapeBaseFace(geo) {
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);

      const r = Math.sqrt(x * x + y * y + z * z);
      if (r < 0.001) continue;

      // Normalize to unit sphere
      const nx = x / r, ny = y / r, nz = z / r;

      // 1. Elongate vertically (head is taller than wide)
      let sx = 0.82, sy = 1.1, sz = 0.88;
      x = nx * sx; y = ny * sy; z = nz * sz;

      // Re-normalize direction for feature placement
      const faceAngle = Math.atan2(Math.abs(x), z); // 0 = front center

      // 2. Flatten back of head
      if (z < 0) {
        z *= 0.85 + 0.15 * smoothstep(1 - Math.abs(z));
      }

      // 3. Face profile - push forward/back based on Y for front-facing vertices
      if (z > -0.1) {
        const frontness = smoothstep((z + 0.1) / 0.8);

        // Forehead
        z += 0.06 * gauss(y, 0.55, 0.2) * frontness;

        // Brow ridge
        z += 0.07 * gauss(y, 0.38, 0.06) * frontness * (1 - gauss(Math.abs(x), 0, 0.08));

        // Eye sockets
        const eyeL = gauss(x, -0.28, 0.1) * gauss(y, 0.28, 0.07);
        const eyeR = gauss(x,  0.28, 0.1) * gauss(y, 0.28, 0.07);
        z -= 0.12 * (eyeL + eyeR) * frontness;
        y += 0.01 * (eyeL + eyeR) * frontness; // slight upward pull for socket shape

        // Nose bridge
        z += 0.08 * gauss(y, 0.2, 0.12) * gauss(x, 0, 0.06) * frontness;

        // Nose protrusion
        z += 0.18 * gauss(y, 0.04, 0.1) * gauss(x, 0, 0.08) * frontness;

        // Nose tip (rounded)
        const noseTip = gauss(y, -0.02, 0.05) * gauss(x, 0, 0.06);
        z += 0.12 * noseTip * frontness;

        // Nostrils (slight outward bulge)
        z += 0.04 * gauss(y, -0.05, 0.04) * gauss(Math.abs(x), 0.1, 0.04) * frontness;
        x += Math.sign(x) * 0.02 * gauss(y, -0.05, 0.04) * gauss(Math.abs(x), 0.1, 0.04) * frontness;

        // Upper lip
        z += 0.06 * gauss(y, -0.14, 0.03) * gauss(x, 0, 0.12) * frontness;

        // Lower lip
        z += 0.05 * gauss(y, -0.22, 0.03) * gauss(x, 0, 0.1) * frontness;

        // Mouth crease (between lips)
        z -= 0.03 * gauss(y, -0.18, 0.015) * gauss(x, 0, 0.1) * frontness;

        // Philtrum (groove above upper lip)
        z -= 0.025 * gauss(y, -0.08, 0.04) * gauss(x, 0, 0.025) * frontness;

        // Chin
        z += 0.06 * gauss(y, -0.42, 0.08) * gauss(x, 0, 0.15) * frontness;

        // Chin cleft hint
        z -= 0.01 * gauss(y, -0.42, 0.04) * gauss(x, 0, 0.02) * frontness;

        // Cheekbones
        z += 0.04 * gauss(y, 0.12, 0.1) * gauss(Math.abs(x), 0.4, 0.12) * frontness;
        x += Math.sign(x) * 0.03 * gauss(y, 0.12, 0.1) * gauss(Math.abs(x), 0.42, 0.1) * frontness;
      }

      // 4. Face width profile - taper the jaw
      if (y < -0.1) {
        const taper = smoothstep((-0.1 - y) / 0.6);
        const taperAmount = lerp(1.0, 0.55, taper);
        x *= taperAmount;
      }

      // 5. Slight ear bumps
      const earBump = gauss(y, 0.15, 0.12) * gauss(Math.abs(x), 0.75, 0.08) * gauss(z, 0, 0.3);
      x += Math.sign(x) * 0.08 * earBump;

      // 6. Neck taper
      if (y < -0.6) {
        const neckT = smoothstep((y + 0.6) / -0.5);
        x *= lerp(1.0, 0.45, neckT);
        z *= lerp(1.0, 0.55, neckT);
      }

      pos.setXYZ(i, x, y, z);
    }
  }

  setSkinTone(tone) {
    // tone: 'fair-asian', 'medium', 'tan', 'dark', 'pale'
    const tones = {
      "fair-asian": { base: [0.92, 0.82, 0.74], lip: [0.85, 0.55, 0.52], eye: [0.84, 0.74, 0.68], flush: [0.93, 0.70, 0.65] },
      "pale":       { base: [0.95, 0.87, 0.82], lip: [0.88, 0.55, 0.52], eye: [0.88, 0.80, 0.76], flush: [0.95, 0.72, 0.68] },
      "medium":     { base: [0.86, 0.72, 0.62], lip: [0.82, 0.45, 0.42], eye: [0.78, 0.65, 0.58], flush: [0.88, 0.60, 0.55] },
      "tan":        { base: [0.72, 0.55, 0.42], lip: [0.70, 0.38, 0.35], eye: [0.65, 0.50, 0.40], flush: [0.75, 0.48, 0.40] },
      "dark":       { base: [0.45, 0.32, 0.25], lip: [0.50, 0.28, 0.25], eye: [0.40, 0.28, 0.22], flush: [0.48, 0.30, 0.25] },
    };
    const t = tones[tone] || tones["medium"];
    this._applyVertexColors(
      new THREE.Color(...t.base),
      new THREE.Color(...t.lip),
      new THREE.Color(...t.eye),
      new THREE.Color(...t.flush),
    );
  }

  _addVertexColors(geo) {
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // Default: fair Asian skin
    const skinBase = new THREE.Color(0.92, 0.82, 0.74);
    const lipColor = new THREE.Color(0.85, 0.55, 0.52);
    const eyeAreaColor = new THREE.Color(0.84, 0.74, 0.68);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const c = skinBase.clone();

      // Lips: redder
      const lipWeight = gauss(y, -0.14, 0.04) * gauss(x, 0, 0.12) * (z > 0.5 ? 1 : 0)
                       + gauss(y, -0.22, 0.04) * gauss(x, 0, 0.1) * (z > 0.5 ? 1 : 0);
      c.lerp(lipColor, lipWeight * 0.6);

      // Eye area: slightly darker
      const eyeW = (gauss(x, -0.28, 0.12) + gauss(x, 0.28, 0.12)) * gauss(y, 0.28, 0.08) * (z > 0.3 ? 1 : 0);
      c.lerp(eyeAreaColor, eyeW * 0.4);

      // Slight flush on cheeks
      const cheekFlush = gauss(Math.abs(x), 0.32, 0.1) * gauss(y, 0.05, 0.1) * (z > 0.3 ? 1 : 0);
      c.lerp(new THREE.Color(0.93, 0.70, 0.65), cheekFlush * 0.25);

      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  }

  _applyVertexColors(skinBase, lipColor, eyeAreaColor, flushColor) {
    const geo = this.geometry;
    const pos = geo.attributes.position;
    const colors = geo.attributes.color;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const c = skinBase.clone();

      const lipWeight = gauss(y, -0.14, 0.04) * gauss(x, 0, 0.12) * (z > 0.5 ? 1 : 0)
                       + gauss(y, -0.22, 0.04) * gauss(x, 0, 0.1) * (z > 0.5 ? 1 : 0);
      c.lerp(lipColor, lipWeight * 0.6);

      const eyeW = (gauss(x, -0.28, 0.12) + gauss(x, 0.28, 0.12)) * gauss(y, 0.28, 0.08) * (z > 0.3 ? 1 : 0);
      c.lerp(eyeAreaColor, eyeW * 0.4);

      const cheekFlush = gauss(Math.abs(x), 0.32, 0.1) * gauss(y, 0.05, 0.1) * (z > 0.3 ? 1 : 0);
      c.lerp(flushColor, cheekFlush * 0.25);

      colors.setXYZ(i, c.r, c.g, c.b);
    }
    colors.needsUpdate = true;
  }

  setParam(name, value) {
    this.values[name] = value;
    this._applyAll();
  }

  setAllParams(valueMap) {
    Object.assign(this.values, valueMap);
    this._applyAll();
  }

  resetAll() {
    PARAMS.forEach(p => this.values[p.name] = p.default);
    this._applyAll();
  }

  _applyAll() {
    const pos = this.geometry.attributes.position;
    const arr = pos.array;
    const base = this.basePositions;

    // Copy base positions
    arr.set(base);

    // Apply each active parameter
    for (const param of PARAMS) {
      const val = this.values[param.name];
      if (Math.abs(val) < 0.001) continue;

      for (const reg of param.regions) {
        this._applyRegion(arr, base, val, reg);
      }
    }

    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  _applyRegion(arr, base, value, reg) {
    const { cx, cy, cz, radius, dx, dy, dz, strength } = reg;
    const r2 = radius * radius;

    for (let i = 0; i < arr.length; i += 3) {
      const bx = base[i], by = base[i + 1], bz = base[i + 2];

      // Front-only filter
      if (reg.front && bz < 0) continue;

      // Distance to region center (handle mirror)
      let dcx = cx, ddy = dy, ddx = dx;
      if (reg.mirror && bx < 0) {
        dcx = -cx;
        ddx = -dx; // Mirror the X direction
      }

      const ex = bx - dcx, ey = by - cy, ez = bz - cz;
      const dist2 = ex * ex + ey * ey + ez * ez;
      if (dist2 > r2) continue;

      const dist = Math.sqrt(dist2);
      let weight = smoothstep(1 - dist / radius);

      // Optional Y-weighted (stronger at bottom/top)
      if (reg.yWeight) {
        weight *= Math.max(0, by * reg.yWeight);
      }

      // Optional X-weighted (for tilt effects)
      if (reg.xWeight) {
        const localX = reg.mirror ? Math.abs(bx) : bx;
        weight *= (localX - (reg.mirror ? Math.abs(cx) : cx)) * reg.xWeight + 0.5;
        weight = Math.max(0, weight);
      }

      const offset = value * strength * weight;

      if (reg.radial) {
        // Push radially outward from center axis
        const rx = bx - 0, rz = bz - cz;
        const rl = Math.sqrt(rx * rx + rz * rz);
        if (rl > 0.001) {
          arr[i]     += (rx / rl) * offset;
          arr[i + 2] += (rz / rl) * offset;
        }
      } else if (reg.localScale) {
        // Scale around the region center
        arr[i]     += (bx - dcx) * ddx * value * strength * weight;
        arr[i + 1] += (by - cy)  * ddy * value * strength * weight;
        arr[i + 2] += (bz - cz)  * dz  * value * strength * weight;
      } else {
        arr[i]     += ddx * offset;
        arr[i + 1] += ddy * offset;
        arr[i + 2] += dz  * offset;
      }
    }
  }

  setViewMode(mode) {
    this.solidMesh.visible = mode === "solid" || mode === "both";
    this.wireMesh.visible  = mode === "wireframe" || mode === "both";
    if (mode === "both") {
      this.wireMaterial.opacity = 0.15;
    }
  }
}

// --- Presets ---
export const PRESETS = {
  default: {},
  wide: {
    "Face Width": 0.7, "Jaw Width": 0.5, "Cheek Width": 0.4, "Cheek Fullness": 0.3,
    "Chin Width": 0.3, "Forehead Width": 0.4, "Temple Width": 0.3,
  },
  thin: {
    "Face Width": -0.5, "Face Taper": 0.4, "Jaw Width": -0.4, "Cheek Width": -0.3,
    "Cheek Hollow": 0.5, "Chin Width": -0.3, "Forehead Width": -0.2, "Nose Width": -0.3,
  },
  round: {
    "Face Width": 0.5, "Face Roundness": 0.6, "Cheek Fullness": 0.6, "Jaw Width": 0.3,
    "Chin Protrusion": -0.3, "Forehead Bulge": 0.3, "Nose Tip Width": 0.3,
    "Lower Lip Thickness": 0.3, "Cheek Width": 0.3,
  },
  angular: {
    "Cheekbone Prominence": 0.7, "Jaw Angle": 0.5, "Jaw Width": 0.3, "Cheek Hollow": 0.6,
    "Chin Protrusion": 0.4, "Brow Ridge": 0.5, "Face Taper": 0.3, "Nose Bridge Depth": 0.4,
  },
  random: null, // handled in code
  photo: {
    // === Face Shape ===
    "Face Width": -0.30,
    "Face Height": 0.30,
    "Face Depth": -0.10,
    "Face Roundness": -0.15,
    "Face Taper": 0.45,
    "Face Asymmetry": 0.0,
    "Skull Width": -0.10,
    "Skull Depth": 0.0,
    // === Forehead ===
    "Forehead Width": -0.10,
    "Forehead Height": 0.20,
    "Forehead Slope": 0.10,
    "Forehead Bulge": -0.10,
    "Brow Ridge": -0.35,
    "Temple Width": -0.10,
    // === Eyes ===
    "Eye Size": -0.05,
    "Eye Width": 0.25,
    "Eye Height": -0.25,
    "Eye Spacing": 0.12,
    "Eye Depth": 0.15,
    "Eye Tilt": 0.25,
    "Upper Eyelid": -0.20,
    "Lower Eyelid": 0.05,
    "Inner Eye Corner": -0.05,
    "Outer Eye Corner": 0.10,
    "Eye Socket Depth": 0.10,
    "Eye Protrusion": -0.10,
    "Under Eye Fullness": 0.10,
    "Eye Bag": 0.0,
    // === Eyebrows ===
    "Brow Height": 0.10,
    "Brow Thickness": -0.25,
    "Brow Arch": -0.20,
    "Brow Spacing": 0.10,
    "Brow Inner Height": 0.0,
    "Brow Outer Height": -0.10,
    "Brow Angle": -0.10,
    "Brow Depth": -0.10,
    // === Nose ===
    "Nose Width": -0.20,
    "Nose Height": 0.10,
    "Nose Length": 0.10,
    "Nose Bridge Width": -0.30,
    "Nose Bridge Depth": -0.20,
    "Nose Tip Width": 0.0,
    "Nose Tip Height": 0.0,
    "Nose Tip Protrusion": -0.10,
    "Nostril Width": -0.10,
    "Nostril Height": 0.0,
    "Nostril Flare": -0.10,
    "Nose Curve": 0.0,
    // === Mouth ===
    "Mouth Width": -0.20,
    "Mouth Position": 0.0,
    "Upper Lip Thickness": -0.15,
    "Lower Lip Thickness": 0.10,
    "Upper Lip Curve": 0.0,
    "Lower Lip Curve": 0.05,
    "Lip Protrusion": -0.10,
    "Mouth Corner Angle": 0.05,
    "Cupid Bow": -0.10,
    "Philtrum Depth": 0.10,
    // === Cheeks ===
    "Cheek Width": -0.15,
    "Cheek Height": 0.0,
    "Cheek Fullness": -0.10,
    "Cheekbone Prominence": 0.20,
    "Cheek Hollow": 0.10,
    "Nasolabial Fold": -0.10,
    // === Jaw & Chin ===
    "Jaw Width": -0.35,
    "Jaw Height": 0.0,
    "Jaw Angle": -0.25,
    "Chin Width": -0.30,
    "Chin Height": 0.20,
    "Chin Protrusion": -0.05,
  },
};
