import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FaceGenerator, PARAMS, CATEGORIES, PRESETS } from "./face.js";
import { analyzeFace } from "./face-analyzer.js";

// --- Scene Setup ---
const container = document.getElementById("canvas-container");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a1a);

const camera = new THREE.PerspectiveCamera(
  45,
  container.clientWidth / container.clientHeight,
  0.1,
  100
);
camera.position.set(0, 0.1, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.05, 0);
controls.minDistance = 1.5;
controls.maxDistance = 8;
controls.enablePan = false;

// --- Lighting (portrait setup) ---
const ambient = new THREE.AmbientLight(0xc8b8a8, 0.6);
scene.add(ambient);

// Key light (warm, from upper right)
const keyLight = new THREE.DirectionalLight(0xfff0e0, 1.8);
keyLight.position.set(3, 4, 4);
scene.add(keyLight);

// Fill light (cool, from left)
const fillLight = new THREE.DirectionalLight(0xc0d0ff, 0.6);
fillLight.position.set(-3, 2, 3);
scene.add(fillLight);

// Rim light (from behind)
const rimLight = new THREE.DirectionalLight(0xffffff, 0.8);
rimLight.position.set(0, 2, -4);
scene.add(rimLight);

// Subtle bottom fill
const bottomFill = new THREE.DirectionalLight(0xe8d0c0, 0.3);
bottomFill.position.set(0, -3, 2);
scene.add(bottomFill);

// --- Environment sphere (gradient background) ---
const envGeo = new THREE.SphereGeometry(30, 32, 32);
const envMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: {
    colorTop: { value: new THREE.Color(0x1a1a2e) },
    colorBot: { value: new THREE.Color(0x0a0a14) },
  },
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    uniform vec3 colorTop, colorBot;
    varying vec3 vWorldPos;
    void main() {
      float t = smoothstep(-10.0, 10.0, vWorldPos.y);
      gl_FragColor = vec4(mix(colorBot, colorTop, t), 1.0);
    }
  `,
});
scene.add(new THREE.Mesh(envGeo, envMat));

// --- Face ---
const face = new FaceGenerator();
scene.add(face.group);

// Subtle auto-rotation
let autoRotate = true;
controls.addEventListener("start", () => autoRotate = false);

// --- Build UI ---
const controlsEl = document.getElementById("controls");
const sliders = {};

// Group params by category
const grouped = {};
CATEGORIES.forEach(c => grouped[c.id] = []);
PARAMS.forEach(p => {
  if (grouped[p.category]) grouped[p.category].push(p);
});

CATEGORIES.forEach(cat => {
  const params = grouped[cat.id];
  if (!params || params.length === 0) return;

  const catDiv = document.createElement("div");
  catDiv.className = "category";

  const header = document.createElement("div");
  header.className = "category-header";
  header.innerHTML = `
    <div><span class="cat-title">${cat.label}</span><span class="cat-count">(${params.length})</span></div>
    <span class="arrow">▼</span>
  `;
  catDiv.appendChild(header);

  const body = document.createElement("div");
  body.className = "category-body";

  params.forEach(param => {
    const row = document.createElement("div");
    row.className = "param-row";
    row.dataset.name = param.name.toLowerCase();

    const label = document.createElement("div");
    label.className = "param-label";

    const initVal = face.values[param.name] ?? param.default;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = param.name;

    const valSpan = document.createElement("span");
    valSpan.className = "param-val";
    valSpan.textContent = initVal.toFixed(2);

    label.appendChild(nameSpan);
    label.appendChild(valSpan);

    const sliderRow = document.createElement("div");
    sliderRow.className = "slider-row";

    const input = document.createElement("input");
    input.type = "range";
    input.min = param.min;
    input.max = param.max;
    input.step = 0.01;
    input.value = initVal;

    const resetBtn = document.createElement("button");
    resetBtn.className = "param-reset";
    resetBtn.textContent = "↺";
    resetBtn.title = "Reset";

    sliderRow.appendChild(input);
    sliderRow.appendChild(resetBtn);

    row.appendChild(label);
    row.appendChild(sliderRow);
    body.appendChild(row);

    // Events
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      valSpan.textContent = v.toFixed(2);
      face.setParam(param.name, v);
    });

    resetBtn.addEventListener("click", () => {
      input.value = param.default;
      valSpan.textContent = param.default.toFixed(2);
      face.setParam(param.name, param.default);
    });

    sliders[param.name] = { input, valSpan };
  });

  catDiv.appendChild(body);
  controlsEl.appendChild(catDiv);

  // Toggle collapse
  header.addEventListener("click", () => {
    header.classList.toggle("collapsed");
    body.classList.toggle("hidden");
  });
});

// --- Reset All ---
document.getElementById("reset-all").addEventListener("click", () => {
  face.resetAll();
  PARAMS.forEach(p => {
    const s = sliders[p.name];
    if (s) {
      s.input.value = p.default;
      s.valSpan.textContent = p.default.toFixed(2);
    }
  });
});

// --- Search ---
document.getElementById("search-input").addEventListener("input", (e) => {
  const query = e.target.value.toLowerCase().trim();
  document.querySelectorAll(".param-row").forEach(row => {
    row.style.display = !query || row.dataset.name.includes(query) ? "" : "none";
  });
  // Show all categories when searching
  if (query) {
    document.querySelectorAll(".category-body").forEach(b => b.classList.remove("hidden"));
    document.querySelectorAll(".category-header").forEach(h => h.classList.remove("collapsed"));
  }
});

// --- Presets ---
function applyPreset(values) {
  // Reset first
  face.resetAll();
  PARAMS.forEach(p => {
    const s = sliders[p.name];
    if (s) { s.input.value = 0; s.valSpan.textContent = "0.00"; }
  });

  // Apply preset values
  if (values) {
    face.setAllParams(values);
    Object.entries(values).forEach(([name, val]) => {
      const s = sliders[name];
      if (s) {
        s.input.value = val;
        s.valSpan.textContent = val.toFixed(2);
      }
    });
  }
}

document.querySelectorAll(".preset-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const key = btn.dataset.preset;
    if (key === "random") {
      const vals = {};
      PARAMS.forEach(p => vals[p.name] = (Math.random() * 2 - 1) * 0.6);
      applyPreset(vals);
    } else {
      applyPreset(PRESETS[key] || {});
    }
  });
});

// --- Skin Tone ---
document.querySelectorAll(".skin-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".skin-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    face.setSkinTone(btn.dataset.tone);
  });
});

// --- Photo Upload ---
const uploadBtn = document.getElementById("upload-btn");
const photoInput = document.getElementById("photo-input");
const previewDiv = document.getElementById("upload-preview");
const previewImg = document.getElementById("preview-img");
const statusEl = document.getElementById("upload-status");

uploadBtn.addEventListener("click", () => photoInput.click());

photoInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Show preview
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  previewDiv.classList.remove("hidden");
  statusEl.className = "";
  statusEl.textContent = "Preparing...";
  uploadBtn.classList.add("loading");
  uploadBtn.textContent = "Analyzing...";

  try {
    // Load image
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });

    // Analyze
    const params = await analyzeFace(img, (msg) => {
      statusEl.textContent = msg;
    });

    // Apply to face model
    applyPreset(params);

    statusEl.textContent = "Face detected! 70 parameters applied.";
    statusEl.className = "success";

    // Deselect preset buttons
    document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
  } catch (err) {
    statusEl.textContent = err.message || "Failed to analyze face";
    statusEl.className = "error";
    console.error(err);
  } finally {
    uploadBtn.classList.remove("loading");
    uploadBtn.textContent = "Upload Photo to Analyze Face";
    URL.revokeObjectURL(url);
  }
});

// --- View Mode ---
document.querySelectorAll(".view-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    face.setViewMode(btn.dataset.mode);
  });
});

// --- Animation Loop ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  if (autoRotate) {
    face.group.rotation.y = Math.sin(clock.getElapsedTime() * 0.3) * 0.3;
  }

  controls.update();
  renderer.render(scene, camera);
}
animate();

// --- Resize ---
window.addEventListener("resize", () => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});
