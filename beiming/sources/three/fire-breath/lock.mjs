// 本地锁的可复算输入。数据卡由原生镜头直接求值，不把脊线、粒子或后期轨道
// 冒充成页面宿主能写入的相机轨道。签锁时将这些依赖连同宿主实例一起交给锁生成器。
import {
  analyticAgxCube,
  CONTRACTS_VERSION,
  KERNEL_EVAL_VERSION,
  loadCardLibrary,
  THREE_VERSION,
} from '../../../api/runtime.mjs';
import { generateLock } from '../../../kernel/lock-gen.mjs';

export function resolveFilmLock(film, library = loadCardLibrary()) {
  const shots = film.shots.map((shot) => ({
    ...shot,
    cards: [...shot.cards, ...shot.params.dataCards.map((use) => ({ use }))],
  }));
  return generateLock(
    { ...film, shots },
    {
      issuer: 'local',
      contracts: CONTRACTS_VERSION,
      sources: { three: { version: THREE_VERSION, host: 'page' } },
      cards: Object.fromEntries(
        Object.entries(library).map(([id, { card, files }]) => [
          id,
          { version: card.version, impl: card.livesIn, status: card.status, files },
        ]),
      ),
      tools: {
        data: { host: 'kernel-eval', version: KERNEL_EVAL_VERSION },
        comp: { host: 'node', version: library['comp.display'].card.status.find((s) => s.host === 'node').source },
      },
      view: { 'agx-mhc': analyticAgxCube() },
      templates: { floor: '1.0.0' },
      assets: {},
    },
  );
}
