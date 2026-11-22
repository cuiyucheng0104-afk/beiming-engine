// 合成器共用的采样率与随机流。audio.mjs 也从原入口导出这两项。
export const SAMPLE_RATE = 48000;

/** 带种子的 32 位随机流（mulberry32），出 [-1, 1) 的数 */
export function noise(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const TAU = 2 * Math.PI;
const pitchSt = [-0.75, -0.25, 0.25, 0.75];
const shelfDb = [-1.2, 0.6, 1.2, -0.6];
const shelfPole = 1 - Math.exp(-TAU * 2800 / SAMPLE_RATE);

function material({ salt, preMs, msiHz, contactLimit, bodyMs, bodyHz, overtone = 2.71, frictionDrive, resonant, decayMs, tailMs }) {
  const contact = Math.round(preMs * SAMPLE_RATE / 1000);
  const contactEnd = contact + Math.ceil(0.0017 * SAMPLE_RATE);
  const bodyAt = contact + Math.round(bodyMs * SAMPLE_RATE / 1000);
  const tailAt = bodyAt + Math.round(0.012 * SAMPLE_RATE);
  const length = tailAt + Math.round(tailMs * SAMPLE_RATE / 1000);
  return Object.freeze({
    onset: 0, pcenter: contact, variants: pitchSt.length,
    make(seed = 0, callIdx = 0) {
      // 奇数步长轮遍四个材质变体；每次触发再独立微调音高和高频增益。
      const order = noise(seed ^ salt);
      const first = Math.floor((order() + 1) * 2);
      const slot = (first + callIdx * (order() < 0 ? 1 : 3)) % pitchSt.length;
      const rnd = noise(seed ^ salt ^ Math.imul(slot + 1, 0x9e3779b9));
      const jitter = noise(seed ^ salt ^ Math.imul(callIdx + 1, 0x85ebca6b));
      const pitch = 2 ** ((pitchSt[slot] + 0.12 * jitter()) / 12);
      const shelf = 10 ** ((shelfDb[slot] + 0.3 * jitter()) / 20);
      const omega = TAU * bodyHz * pitch;
      const lowpass = 1 - Math.exp(-TAU * bodyHz * pitch * 3 / SAMPLE_RATE);
      const left = new Float32Array(length), right = new Float32Array(length);
      let low = 0, previous = 0, contactLow = 0;
      for (let i = 0; i < length; i++) {
        const white = rnd();
        low += lowpass * (white - low);
        const bright = (white - previous) * 0.5;
        previous = white;
        let v = 0;
        if (i < contact) {
          const t = i / SAMPLE_RATE;
          const puff = Math.min(1, t / 0.0015) * (0.55 + 0.45 * Math.exp(-t / 0.006));
          v = (0.14 * low + 0.025 * white) * puff * Math.min(1, (contact - i) / 48);
        } else if (i < contactEnd) {
          const t = (i - contact) / SAMPLE_RATE;
          // 短接触先给出高频细节，主体的音高变化只作用在随后到达的共振上。
          const tick = resonant * Math.sin(TAU * msiHz * t) + (1 - 0.7 * resonant) * bright;
          contactLow += shelfPole * (tick - contactLow);
          const release = Math.min(1, (contactEnd - i) / (0.0004 * SAMPLE_RATE));
          v = 0.56 * (contactLow + shelf * (tick - contactLow)) * Math.exp(-t / 0.0016) * release;
          if (contactLimit) v = contactLimit * Math.tanh(v / contactLimit);
        }
        if (i >= bodyAt) {
          const t = (i - bodyAt) / SAMPLE_RATE;
          const ring = 0.74 * Math.sin(omega * t) + 0.26 * Math.sin(omega * overtone * t);
          const friction = frictionDrive ? Math.tanh(frictionDrive * low) : 2 * low;
          v += 0.40 * (resonant * ring + (1 - resonant) * friction) * Math.min(1, t / 0.0008) * Math.exp(-1000 * t / decayMs);
        }
        if (i >= tailAt) {
          const t = (i - tailAt) / SAMPLE_RATE;
          const tail = resonant * Math.sin(omega * 1.63 * t) + (1 - resonant) * 2 * low;
          v += 0.079 * tail * Math.min(1, t / 0.004) * Math.exp(-5000 * t / tailMs);
        }
        left[i] = right[i] = v * Math.min(1, (length - 1 - i) / 96);
      }
      return { left, right };
    },
  });
}

// 接触对齐时，前导也须落在 60 fps 的四分之一帧（4.17 ms）以内。
export const FOLEY_VOICES = Object.freeze({
  'foley.impact': material({ salt: 11, preMs: 2.5, msiHz: 4400, bodyMs: 2.5, bodyHz: 86, resonant: 0.87, decayMs: 36, tailMs: 180 }),
  'foley.step':   material({ salt: 23, preMs: 3.0, msiHz: 3100, contactLimit: 0.31, bodyMs: 2.1, bodyHz: 148, overtone: 1.56, resonant: 0.74, decayMs: 55, tailMs: 120 }),
  'foley.metal':  material({ salt: 37, preMs: 1.8, msiHz: 8300, bodyMs: 1.9, bodyHz: 1170, resonant: 0.97, decayMs: 50, tailMs: 320 }),
  'foley.cloth':  material({ salt: 53, preMs: 3.8, msiHz: 3600, contactLimit: 0.34, bodyMs: 2.9, bodyHz: 490, frictionDrive: 4, resonant: 0.04, decayMs: 105, tailMs: 265 }),
});
