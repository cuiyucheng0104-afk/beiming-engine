// 把一次运行里看到的东西写成核对记录。纯函数：只整理观测，不补数、不改数；没观测到的段和字段不写。
// 时间核对记录全片一份；镜头、帧源、元数据三种每个镜头一份。每个字段照契约字段表的「来历」一栏取：
//   请求：测试工具自己传的参数和从片子描述读的值；量的：工具读层文件、数交回的东西得出的；
//   旁观：夹具里的观测点（fixtures/observe.js）记下、经元数据的 readings 交出来的；自报：帧源交回的能力声明、实体清单、元数据里的字段。
//
// obs 的形状：
//   film、caps、lock（例子锁）、holds[] { f, n, result }、scans { path, shot }（各是 { wallClock, unseededRandom }）
//   shots[]        每个镜头一项 one：
//     shot           片子描述里这个镜头的条目
//     languages[]    从入口文件和它直接引用的本镜头文件认出的语言
//     manifest       帧源交回的实体清单
//     opens[]        每次 open：{ plain（用的是不是原样的镜头输入）, hasLock, hasSeed, usesCards, usesAssets, host, mode, status, code? }
//     evaluations[]  { f, sub, mode, digest }；rng[] { run, arg, name, digest }；queries[] { kind, status, code }
//     renders[]      每次 render：{ call, f, opts, want, locked, status, code?, order?, unsupportedOpts?, unfitOutputs?,
//                    metas（交回了几份元数据）, meta?, metaBytes?, layers?, layerRefs?[{ output, shape, sha256, fileSha256 }],
//                    seen?（观测点交出来的 { builds, shotIn, cardUses, metaKeys, states[{ f, sub, color, aux }] }）,
//                    average?（量出来的平均方式）, pixelOffset?（量出来的辅助层像素内位置） }

const scanOf = ({ wallClock, unseededRandom }) => ({ wallClock, unseededRandom });
const ok = (one) => one.renders.filter((r) => r.status === 'ok');
const sha = (r, output) => r.layerRefs?.find((x) => x.output === output)?.fileSha256;

/** 一次 render 生效的快门，测试工具照「这次调用 → 锁文件 → 镜头条目 → 能力声明」的次序从自己传的参数算 */
export function effectiveShutter(r, shot, caps, lock) {
  const angleDeg = r.opts?.shutter?.angleDeg ?? shot.shutter?.angleDeg ?? 0;
  const samples = r.opts?.shutter?.samples ?? (r.locked ? lock.shots[shot.id].shutterSamples : undefined) ?? shot.shutter?.samples ?? (angleDeg === 0 ? 1 : caps.motionBlur.samples);
  return { angleDeg, samples };
}

/** 一次出了颜色层的调用的逐帧采样观测。观测点没交出东西、或者没看到任何一遍颜色时返回 null：旁观的字段没有来源，这一项不出现 */
function frameOf(r, obs, shot) {
  const color = r.seen?.states.filter((s) => s.color > 0) ?? [], aux = r.seen?.states.filter((s) => s.aux > 0) ?? [];
  const seenShot = obs.film.shots.find((s) => s.in === r.seen?.shotIn)?.id;
  if (!color.length || !seenShot) return null;
  const key = (s) => ({ frame: s.f + shot.in, sub: s.sub });
  const subs = aux.map((s) => s.sub);
  return {
    frame: r.f + shot.in,
    shot: shot.id,
    f: color[0].f,
    ...(r.opts?.shutter ? { shutterAngleDeg: r.opts.shutter.angleDeg } : {}),
    samples: color.map((s) => ({ ...key(s), shot: seenShot })),
    // 被测帧源是逐子帧累积的：这一段总是出现，平均方式没量出来就是空的
    accumulation: r.average ? { average: r.average } : {},
    ...(aux.length ? {
      aux: key(aux[0]),
      auxSample: {
        shutterAngleDeg: (Math.max(...subs) - Math.min(...subs)) * 360,
        samples: aux.length,
        ...(r.pixelOffset ? { pixelOffset: r.pixelOffset } : {}),
      },
    } : {}),
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
    rng: each((one, shot) => one.rng.map((r) => ({ run: r.run, shot: shot.id, arg: r.arg, name: r.name, digest: r.digest }))),
    scan: scanOf(obs.scans.path),
  };
}

export function shotCheck(obs, one) {
  const { shot } = one;
  const metas = ok(one).filter((r) => r.meta), seen = ok(one).filter((r) => r.seen).map((r) => r.seen);
  const failed = one.opens.find((o) => o.plain && o.status !== 'ok');
  return {
    format: 'shot-check/0.1',
    shot: shot.id,
    mode: shot.mode,
    entry: shot.entry,
    sources: [...new Set(metas.map((r) => r.meta.source.renderer))],
    languages: one.languages,
    // 契约把这个数标成宿主自己数的；这条链路里宿主没有往外报数的口子，取的是观测点数到的
    buildCalls: seen.find((s) => s.builds !== 1)?.builds ?? seen[0]?.builds ?? 0,
    build: failed ? 'failed' : 'ok',
    ...(failed?.code ? { error: failed.code } : {}),
    entities: one.manifest.entities.map((e) => e.name),
    metaEntities: metas.map((r) => ({ f: r.f, names: r.meta.entities.map((e) => e.name) })),
    evaluations: one.evaluations,
    ...(seen.length ? { metaKeys: [...new Set(seen.flatMap((s) => s.metaKeys))] } : {}),
    declaredCards: (shot.cards ?? []).map((c) => c.as),
    // 观测点只数得到次数：一次都没调写空数组；调过就说不出各次的实例名，这一段不写
    ...(seen.length && seen.every((s) => s.cardUses === 0) ? { cardUses: [] } : {}),
    scan: scanOf(obs.scans.shot),
  };
}

export function sourceCheck(obs, one) {
  const { shot } = one, { caps } = obs;
  const scale1 = (r) => (r.opts?.scale ?? shot.tiers?.final?.scale ?? caps.final.scale) === 1;
  return {
    format: 'source-check/0.1',
    shot: shot.id,
    caps,
    opens: one.opens.map(({ plain, ...o }) => o),
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
      if (r.status !== 'ok') return { ...head, code: r.code };
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
    metaEntities: ok(one).filter((r) => r.meta).map((r) => ({ shotFrame: r.f, entities: r.meta.entities.map(({ id, name, class: c }) => ({ id, name, class: c })) })),
  };
}

/** 一份记录说一个镜头的全部成功的 render */
export function metaCheck(one) {
  return {
    format: 'meta-check/0.1',
    shot: one.shot.id,
    start: one.shot.in,
    renders: ok(one).map((r) => ({
      call: r.call,
      shotFrame: r.f,
      metas: r.metas,
      metaBytes: r.metaBytes ?? 0,
      ...(r.meta ? { metaFrame: r.meta.frame, metaShotFrame: r.meta.shotFrame } : {}),
      ...(sha(r, 'color') ? { colorFileSha256: sha(r, 'color') } : {}),
      ...(r.meta?.hash.color ? { metaHashColor: r.meta.hash.color } : {}),
    })),
  };
}
