// 把一次运行里看到的东西写成核对记录。纯函数：只整理观测，不补数、不改数；没观测到的段和字段不写。
// 时间核对记录全片一份；镜头、帧源、元数据三种每个镜头一份。来历是相对测试工具说的，工具在被测的帧源（渲染器加宿主）之外：
//   请求：工具自己传的参数、从片子描述读的值、自己备的夹具的事实；量的：工具读层文件、数交回的东西、照规格求交得出的；
//   旁观：工具放在夹具镜头代码外面的观测点（fixtures/observe.js）看到、经元数据的 readings 交出来的；
//   自报：帧源交回的能力声明、实体清单、元数据里的字段，原样抄。各字段取的是哪一种，逐个列在本目录 README。
//
// obs 的形状：
//   film、caps、lock（例子锁）、holds[] { f, n, result }、scans { path, shot }（各是 { wallClock, unseededRandom }）
//   shots[]        每个镜头一项 one：
//     shot           片子描述里这个镜头的条目
//     localized[]    { frame（工具放进镜头输入事件表的全片帧号）, f（观测点在 ctx.events 里看到的帧号） }
//     metaFrames[]   { frame（那次 render 请求的帧号换成的全片帧号）, f（观测点看到 meta 收到的帧号） }
//     languages[]    从入口文件和它直接引用的本镜头文件认出的语言
//     manifest       帧源交回的实体清单
//     loads[]        每次装上了的 open：{ session, locked, tier, input（这次传的镜头输入） }
//     opens[]        每次 open：{ plain（用的是不是原样的镜头输入）, hasLock, hasSeed, usesCards, usesAssets, host, mode, unfitInput?, status, code? }
//     evaluations[]  { f, sub, mode, digest }；rng[] { run, arg, name（观测点拿到的流名）, digest }；queries[] { kind, status, code?, total?, returned? }
//     badArgs[]      故意把一个参数传出值域的调用：{ call, arg, status, code? }
//     renders[]      每次参数都在值域里的 render：{ call, f, opts, want, locked, tier, status, code?, order?, unsupportedOpts?, unfitOutputs?,
//                    metas（交回了几份元数据）, meta?, metaBytes?, layers?, layerRefs?[{ output, shape, hash, fileHash }], fileBytes?{ <输出>: 层文件的字节数 },
//                    seen?（观测点交出来的 { builds, shot?, metaF?, cardUses[{ as, runtimeKeys }], metaKeys, states[{ f, sub, color, aux }], ctx{ seed?, fps?, frames?, shotIn?, size? } }）,
//                    linearErr?（量出来的累积颜色层对线性平均预言图的差）, auxMismatch?（量出来的编号层对预言图、边缘带之外对不上的像素数） }
// 报的错不带错误码时 code 不出现。

import { renderingOf } from '../eval/input.mjs';

const scanOf = ({ wallClock, unseededRandom }) => ({ wallClock, unseededRandom });
const ok = (one) => one.renders.filter((r) => r.status === 'ok');
const sha = (r, output) => r.layerRefs?.find((x) => x.output === output)?.fileHash;

/** 一次 render 生效的快门，测试工具照「这次调用 → 锁文件 → 镜头条目 → 能力声明」的次序从自己传的参数算 */
export function effectiveShutter(r, shot, caps, lock) {
  const angleDeg = r.opts?.shutter?.angleDeg ?? shot.shutter?.angleDeg ?? 0;
  const samples = r.opts?.shutter?.samples ?? (r.locked ? lock.shots[shot.id].shutterSamples : undefined) ?? shot.shutter?.samples ?? (angleDeg === 0 ? 1 : caps.motionBlur.samples);
  return { angleDeg, samples };
}

/**
 * 一次出了颜色层的调用的逐帧采样观测。观测点没交出东西、没看到任何一遍颜色、或者在 ctx.shot.id 上没读到镜头的标识时返回 null：
 * 旁观的字段没有来源，这一项不出现。入口有一道门盯着每次这样的调用都有一项，少一项就不过。
 */
function frameOf(r, obs, shot) {
  const color = r.seen?.states.filter((s) => s.color > 0) ?? [], aux = r.seen?.states.filter((s) => s.aux > 0) ?? [];
  if (!color.length || r.seen.shot === undefined) return null;
  const key = (s) => ({ frame: s.f + shot.in, sub: s.sub });
  return {
    frame: r.f + shot.in,
    shot: shot.id,
    f: color[0].f,
    ...(r.opts?.shutter ? { shutterAngleDeg: r.opts.shutter.angleDeg } : {}),
    // 这个采样是对哪个镜头的状态求值：观测点在 build 收到的 ctx.shot.id 上读到的原文，不替它对，对不对由条文判
    samples: color.map((s) => ({ ...key(s), shot: r.seen.shot })),
    // 逐子帧累积的帧源才有这一段；对预言图的差没量出来就是空的
    ...(obs.caps.motionBlur.mode === 'accumulate' ? { accumulation: r.linearErr === undefined ? {} : { linearErr: r.linearErr } } : {}),
    ...(aux.length ? { aux: key(aux[0]) } : {}),
    ...(r.auxMismatch === undefined ? {} : { auxMismatch: r.auxMismatch }),
  };
}

export function timeCheck(obs) {
  const each = (fn) => obs.shots.flatMap((one) => fn(one, one.shot));
  return {
    format: 'time-check/0.1',
    fps: obs.film.output.fps,
    shots: each((one, shot) => [{ id: shot.id, start: shot.in, frames: shot.out - shot.in, seed: shot.seed, shutterAngleDeg: shot.shutter?.angleDeg ?? 0 }]),
    evaluations: each((one, shot) => one.evaluations.map((e) => ({ shot: shot.id, ...e }))),
    frames: each((one, shot) => ok(one).filter((r) => r.layers.includes('color')).map((r) => frameOf(r, obs, shot)).filter(Boolean)),
    holds: obs.holds,
    // 交给镜头代码的帧号两种都记：ctx.events 的值，和每次 meta 收到的帧号
    localized: each((one, shot) => [...one.localized, ...(one.metaFrames ?? [])].map((x) => ({ shot: shot.id, ...x }))),
    rng: each((one, shot) => one.rng.map((r) => ({ run: r.run, shot: shot.id, arg: r.arg, name: r.name, digest: r.digest }))),
    scan: scanOf(obs.scans.path),
  };
}

export function shotCheck(obs, one) {
  const { shot } = one;
  const metas = ok(one).filter((r) => r.meta), observed = ok(one).filter((r) => r.seen), seen = observed.map((r) => r.seen);
  const failed = one.opens.find((o) => o.plain && o.status !== 'ok');
  // 出帧用的那一套：条目带 renderer 对象时取它里面的
  const { mode, entry } = renderingOf(shot);
  const hasRole = (name) => shot.roles?.hero === name || (shot.roles?.mustSee ?? []).includes(name);
  // 一次装载一项：want 照这次 open 传的镜头输入和 env 算，seen 是观测点在 build 收到的 ctx 上读到的。这次装载没有带观测的 render 就没有这一项
  const ctx = (one.loads ?? []).flatMap((l) => {
    const seenCtx = ok(one).find((r) => r.session === l.session && r.seen)?.seen.ctx;
    if (!seenCtx) return [];
    const { shot: entry, output } = l.input;
    // 缩放不是 1 的装载，ctx.size 跟不跟着缩放还没定，不记 want.size
    const scale1 = (entry.tiers?.[l.tier]?.scale ?? obs.caps[l.tier].scale) === 1;
    return [{ want: { seed: l.locked ? obs.lock.seeds[shot.id] : entry.seed, fps: output.fps, frames: entry.out - entry.in, shotIn: entry.in, ...(scale1 ? { size: output.size } : {}) }, seen: seenCtx }];
  });
  // 观测点包在入口文件的 build 外面：没有入口文件、或者一次观测都没交出来，这三个字段都不写
  const watched = entry !== undefined && seen.length > 0;
  // 卡的调用：取第一个交出观测的会话里最后一次观测（那次装载到那时为止的全部调用）；各次装载跑的是同一份镜头代码
  const lastOfFirst = observed.filter((r) => r.session === observed[0]?.session).at(-1)?.seen;
  return {
    format: 'shot-check/0.1',
    shot: shot.id,
    mode,
    ...(entry === undefined ? {} : { entry }),
    sources: [...new Set(metas.map((r) => r.meta.source.renderer))],
    languages: one.languages,
    // 取的是观测点数到的：build 被包在观测点里面，每跑一次它数一次。有一次装载不是 1 就记那一次，否则记第一次
    ...(watched ? { buildCalls: seen.find((s) => s.builds !== 1)?.builds ?? seen[0].builds } : {}),
    build: failed ? 'failed' : 'ok',
    ...(failed?.code ? { error: failed.code } : {}),
    entities: one.manifest.entities.map((e) => e.name),
    // 可以省的实体：类别照帧源交回的实体清单，角色照片子描述
    omittable: one.manifest.entities.filter((e) => e.class === 'part' && !hasRole(e.name)).map((e) => e.name),
    metaEntities: metas.map((r) => ({ f: r.f, names: r.meta.entities.map((e) => e.name), ...(r.meta.omittedParts ? { omittedParts: r.meta.omittedParts } : {}) })),
    evaluations: one.evaluations,
    ...(watched ? { metaKeys: [...new Set(seen.flatMap((s) => s.metaKeys))] } : {}),
    declaredCards: (shot.cards ?? []).map((c) => c.as),
    ...(watched ? { cardUses: lastOfFirst.cardUses } : {}),
    scan: scanOf(obs.scans.shot),
    ...(ctx.length ? { ctx } : {}),
  };
}

export function sourceCheck(obs, one) {
  const { shot } = one, { caps } = obs;
  const scale1 = (r) => (r.opts?.scale ?? shot.tiers?.[r.tier]?.scale ?? caps[r.tier].scale) === 1;
  return {
    format: 'source-check/0.1',
    shot: shot.id,
    caps,
    opens: one.opens.map(({ plain, ...o }) => o),
    ...(one.badArgs ? { badArgs: one.badArgs } : {}),
    renders: one.renders.map((r) => {
      const { angleDeg, samples } = effectiveShutter(r, shot, caps, obs.lock);
      const head = {
        shotFrame: r.f,
        want: r.want,
        shutterAngleDeg: angleDeg,
        shutterSamples: samples,
        // 缩放不是 1 时乘出来怎么取整还没定，不记
        ...(scale1(r) ? { size: obs.film.output.size } : {}),
        ...(r.unsupportedOpts ? { unsupportedOpts: r.unsupportedOpts } : {}),
        ...(r.unfitOutputs ? { unfitOutputs: r.unfitOutputs } : {}),
        status: r.status,
      };
      if (r.status !== 'ok') return { ...head, ...(r.code ? { code: r.code } : {}) };
      return {
        ...head,
        meta: r.metas > 0,
        layers: r.layers,
        layerRefs: r.layerRefs,
        ...(r.meta?.camera ? { metaShutterAngleDeg: r.meta.camera.shutterAngleDeg } : {}),
        ...(r.meta ? { colorRef: r.meta.colorRef, shotColorRef: shot.colorRef } : {}),
      };
    }),
    orderRuns: ok(one).filter((r) => r.order).map((r) => ({ shotFrame: r.f, mode: r.order, digest: sha(r, 'color') })),
    queries: one.queries,
    manifest: one.manifest,
    // 夹具镜头都是镜头代码自己搭的，没有场景包：工具自己备的夹具，它自己知道
    scenePack: false,
    metaEntities: ok(one).filter((r) => r.meta).map((r) => ({ shotFrame: r.f, entities: r.meta.entities.map(({ id, name, class: c }) => ({ id, name, class: c })) })),
  };
}

/** 颜色层的 [高, 宽, 分量数]：层文件的字节数等于层引用的 shape 三项之积乘 4 时才记，对不上或者没交颜色层就不写 */
function colorShape(r) {
  const shape = r.layerRefs?.find((x) => x.output === 'color')?.shape;
  return shape && r.fileBytes?.color === shape[0] * shape[1] * shape[2] * 4 ? { colorShape: shape } : {};
}

/** 一份记录说一个镜头的全部成功的 render。seed 取片子描述里镜头条目的：例子锁里记的是同一个数（测试盯着），带锁的会话生效的也是它。source 是镜头条目顶层写的帧源，从片子描述读 */
export function metaCheck(obs, one) {
  return {
    format: 'meta-check/0.1',
    // 片子、镜头、帧率都从测试工具自己备的片子描述读，不从元数据抄
    film: obs.film.id,
    shot: one.shot.id,
    fps: obs.film.output.fps,
    start: one.shot.in,
    seed: one.shot.seed,
    source: one.shot.source,
    renders: ok(one).map((r) => ({
      call: r.call,
      shotFrame: r.f,
      tier: r.tier,
      metas: r.metas,
      metaBytes: r.metaBytes ?? 0,
      ...(r.meta ? { metaFrame: r.meta.frame, metaShotFrame: r.meta.shotFrame, metaSeed: r.meta.seed, metaSize: r.meta.size, metaTier: r.meta.source.tier, metaSourceId: r.meta.source.id, metaFilm: r.meta.film, metaShot: r.meta.shot, metaFps: r.meta.fps } : {}),
      ...(sha(r, 'color') ? { colorFileHash: sha(r, 'color') } : {}),
      ...colorShape(r),
      ...(r.meta?.hash.color ? { metaHashColor: r.meta.hash.color } : {}),
    })),
  };
}
