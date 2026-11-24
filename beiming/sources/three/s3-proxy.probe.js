// 这个探针模块先于 two-d.js 求值，用来验证宿主在镜头的第一条语句之前已开始登记。
const TRAPS = ['apply', 'construct', 'defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'has', 'isExtensible', 'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf'];
export const countingHandler = (hit) => Object.fromEntries(TRAPS.map((k) => [k, (...args) => { hit(); return Reflect[k](...args); }]));
export let earlyHits = 0;
const options = { elements: [{ kind: 'dom', html: '<p data-entity="t">x</p>' }] };
export const earlyOptions = Proxy.revocable(options, countingHandler(() => { earlyHits++; })).proxy;
