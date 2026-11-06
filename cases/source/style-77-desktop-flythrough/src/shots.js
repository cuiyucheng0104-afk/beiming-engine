// The one take for 灵感送达: [t, target (Vector3 | subject), dist, az, el, fov, target offset?, {ease}?] and impact shakes [t, amp, decay].
// Every time is a beat of timeline.js. az 0 = camera on the +z side looking toward −z (cards read upright); el in radians.
import { T, b, DUR } from './timeline.js';
import { V } from './anim.js';
const R = { ease: 1 };
export const KEYS = [
  // S1 0 → bar 1: fall from high over the desk onto the title tent and the sticky note (crane down + slow orbit), land on beat 4
  [0.0, 'open', 1.35, .3, .6, 34, V(-.05, .12, -.32)],
  [b(2), 'open', .8, .42, .6, 34, V(-.02, .04, -.12)],
  [T.noteLand, 'open', .74, .44, .64, 34, V(-.02, 0, -.02)],
  [b(5.5), 'bulb', .46, .3, .6, 34],
  [b(6), 'bulb', .45, .24, .58, 34],
  [b(8), 'bulb', .38, .08, .52, 34],
  [b(10.5), 'bulb', .37, -.04, .5, 34],
  [T.hop1[0], 'bulb', .37, -.06, .5, 34, null, R],     // rest: the take-off starts the whip
  // S3 whip to the tower (banking), the drawer lands open on bar 3
  [T.hop1[1], 'drawerFront', .76, .38, .52, 35, V(-.13, 0, .1)],   // the bulb's landing and the open drawer share the frame
  // S4 follow the three hops into the drawer, rising
  [T.hop3[0], 'bulb', .6, .3, .64, 35, V(.12, -.03, -.1)],
  [T.hop3[1], 'city', .56, .2, .82, 35],
  // S5 rise to near top-down over the city: the windows light one per 16th, the plane pops from the runway
  [T.bulbLight, 'city', .5, .12, .88, 35],
  [b(19), 'city', .48, .08, .9, 35, V(.03, 0, .015)],
  [T.planePop, 'city', .47, .02, .9, 35, V(.06, 0, .03), R],
  // S6 the held breath: down low behind the plane, almost still
  [b(22), 'plane', .3, -1.15, .3, 34],
  [T.launch, 'plane', .29, -1.2, .28, 34, null, R],
  // S7 ride along beside-and-behind the messenger (side-rear, so the whole plane and its dotted trail read); it arcs over the mug;
  // the barrel roll is framed wider so the arc, the mug and the roll share the frame
  [b(25), 'plane', .42, -1.02, .42, 36],
  [b(26.5), 'plane', .5, -.8, .44, 36],
  [T.roll[0], 'plane', .66, -.52, .5, 36],
  [T.roll[1], 'plane', .64, -.34, .66, 36],
  // S8 rise to read the notebook: two taps, the bulb hops off, the stamp leaps
  [T.tap1, 'land', .56, -.25, .92, 36],
  [b(31.25), 'land', .6, -.15, 1.0, 36, null, R],
  // S9 hold with a shake: the stamp slams on bar 8
  [T.slam, 'land', .6, -.12, 1.02, 36],
  [b(33), 'land', .62, -.1, 1.04, 36, null, R],
  // S10 pull back over the whole desk (fast on the title's fall, then a slow drift): every stop, the tent card and the ink pad in frame
  [b(34), 'final', 1.62, .05, .98, 36, V(.2, 0, .12)],   // the pull-back keeps the stamped notebook in frame while it widens
  [DUR, 'final', 2.32, .08, 1.03, 36, V(.05, 0, .13)],
];
export const SHAKES = [[T.launch, .0025, 9], [T.slam, .007, 8]];
