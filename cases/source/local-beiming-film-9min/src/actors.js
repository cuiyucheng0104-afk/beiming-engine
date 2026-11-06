// 《北冥》540s transparent actor/prop module. W/H are DESIGN units (1920/1040).
// For a 3840×2080 canvas the compositor sets ctx.setTransform(2,0,0,2,0,0).
// We inherit that transform; never infer a second DPR scale or clear the target.
import { drawActorProfile } from './actor-profile.js';
import { paintDeck, paintHelm, paintRadio } from './actor-people.js';
import { paintRope, paintSwitch, paintShell, paintWake } from './actor-props.js';
import { frameTime, clamp01 } from './actor-paint.js';

export { actorLightState } from './actor-props.js';
export { actorProfileAnchors } from './actor-profile.js';
export const ACTOR_MODES = Object.freeze(['profile', 'deck', 'helm', 'rope', 'radio', 'switch', 'glasses', 'shell', 'wake']);

/** Pure frame rendering; t is seconds, no duration cap or frame-order dependence.
 * progress (0..1) is a shot-local action phase, NOT t % duration:
 * compute animated progress from the same floor(t*12)/12 held clock;
 * it may also be set explicitly to select a pose for a keyframe.
 *   rope: loose → tied (.50–.63) → released; glasses: remove → hold → replace;
 *   switch: reach → cabin off (.58) → withdraw. lights scales cabin light only.
 * mirror reflects geometry around W/2. Colors/palette never change.
 * glasses=false omits every eyewear element, including in the glasses action.
 * talking uses a tiny profile lip aperture / radio PTT response.
 * Paper, grade, bloom, exposure and the background belong to the original look.
 */
export function drawActor(ctx, t, W, H, {
  mode = 'profile', progress = 0, glasses = true, talking = false, lights = 1, mirror = false,
} = {}) {
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return;
  if (!ACTOR_MODES.includes(mode)) throw new RangeError(`Unknown actor mode: ${mode}`);
  const time = frameTime(t), opts = { progress: clamp01(progress), glasses, talking, lights: clamp01(lights) };
  ctx.save();
  try {
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    switch (mode) {
      case 'profile': drawActorProfile(ctx, time, W, H, opts); break;
      case 'glasses': drawActorProfile(ctx, time, W, H, { ...opts, glassesAction: true }); break;
      case 'deck': paintDeck(ctx, time, W, H, opts); break;
      case 'helm': paintHelm(ctx, time, W, H, opts); break;
      case 'rope': paintRope(ctx, time, W, H, opts); break;
      case 'radio': paintRadio(ctx, time, W, H, opts); break;
      case 'switch': paintSwitch(ctx, time, W, H, opts); break;
      case 'shell': paintShell(ctx, time, W, H, opts); break;
      case 'wake': paintWake(ctx, time, W, H, opts); break;
    }
  } finally { ctx.restore(); }
}

// Same time/options/coordinate contract for all convenience exports.
const modeRenderer = mode => (ctx, t, W, H, opts = {}) => drawActor(ctx, t, W, H, { ...opts, mode });
export const drawProfile = modeRenderer('profile');
export const drawDeckActor = modeRenderer('deck');
export const drawHelmActor = modeRenderer('helm');
export const drawRope = modeRenderer('rope');
export const drawRadio = modeRenderer('radio');
export const drawSwitch = modeRenderer('switch');
export const drawGlasses = modeRenderer('glasses');
export const drawShell = modeRenderer('shell');
export const drawWake = modeRenderer('wake');
