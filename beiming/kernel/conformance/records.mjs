// 把一次运行里看到的东西写成核对记录。纯函数：只整理观测，不补数、不改数；没观测到的段不写。
// 时间核对记录全片一份；镜头、帧源、元数据三种每个镜头一份（帧源核对记录按镜头局部帧号比哈希，两个镜头混不到一份里）。
//
// obs 的形状：
//   film、caps、holds[] { f, n, result }
//   scans          { path: 渲染路径的扫描结果, shot: 镜头代码的扫描结果 }，各是 { wallClock, unseededRandom }
//   shots[]        每个镜头一项 one：
//     shot           片子描述里这个镜头的条目
//     manifest、loads[] { buildCalls }、evaluations[] { f, sub, mode, digest }、rng[] { run, arg, name, digest }
//     queries[] { kind, status, code }、cardUses[]、metaKeys[]
//     renders[]      每次 render 调用：{ run, call, f, opts, want, applies[{ f, sub, purpose }], status, code?,
//                    metas, meta?, metaBytes?, layers?, colorSha?, colorCall?, colorTransfer?, order?,
//                    average?（量出来的平均方式）, pixelOffset?（量出来的辅助层像素内位置） }

const scanOf = ({ wallClock, unseededRandom }) => ({ wallClock, unseededRandom });
const ok = (one) => one.renders.filter((r) => r.status === 'ok');

/** 一次调用的逐帧采样观测。帧号、采样时刻、辅助层时刻来自宿主的记账；average、pixelOffset 是另外量出来的，没量就不写那一段 */
function frameOf(r, shot, caps) {
  const key = (a) => ({ frame: a.f + shot.in, sub: a.sub });
  const color = r.applies.filter((a) => a.purpose === 'color'), aux = r.applies.filter((a) => a.purpose === 'aux');
  const subs = aux.map((a) => a.sub);
  return {
    frame: r.f + shot.in,
    shot: shot.id,
    f: color[0].f, // 实际交给镜头代码的帧号
    samples: color.map((a) => ({ ...key(a), shot: shot.id })),
    ...(r.average ? { accumulation: { average: r.average } } : {}),
    ...(aux.length ? { aux: key(aux[0]) } : {}),
    ...(aux.length && r.pixelOffset && caps.motionBlur.auxAt === 'sub0' ? {
      auxSample: {
        apertureM: 0, // 声明值：能力声明的 auxAt 是 sub0（针孔），没有办法从宿主一侧量
        shutterAngleDeg: (Math.max(...subs) - Math.min(...subs)) * 360, // 记账：辅助层写状态的各个时刻跨了多长
        samples: aux.length, // 记账：辅助层写了几次状态
        pixelOffset: r.pixelOffset, // 量的：编号层对各个像素内位置的求交结果
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
    // 只有出了颜色层的调用才有子帧采样
    frames: each((one, shot) => ok(one).filter((r) => r.applies.some((a) => a.purpose === 'color')).map((r) => frameOf(r, shot, obs.caps))),
    holds: obs.holds,
    rng: each((one, shot) => one.rng.map((r) => ({ run: r.run, shot: shot.id, arg: r.arg, name: r.name, digest: r.digest }))),
    scan: scanOf(obs.scans.path),
  };
}

export function shotCheck(obs, one) {
  const { shot } = one;
  const metas = ok(one).filter((r) => r.meta);
  const wrong = one.loads.find((l) => l.buildCalls !== 1);
  return {
    format: 'shot-check/0.1',
    shot: shot.id,
    mode: shot.mode,
    entry: shot.entry,
    sources: [...new Set(metas.map((r) => r.meta.source.renderer))],
    languages: ['js'], // 页面宿主用 import() 装入口文件，装得进来的只有 JS
    buildCalls: wrong ? wrong.buildCalls : 1,
    build: 'ok', // 走到写记录这一步，每次装载都成功了
    entities: one.manifest.entities.map((e) => e.name),
    metaEntities: metas.map((r) => ({ f: r.meta.shotFrame, names: r.meta.entities.map((e) => e.name) })),
    evaluations: one.evaluations,
    metaKeys: one.metaKeys,
    declaredCards: (shot.cards ?? []).map((c) => c.as),
    cardUses: one.cardUses,
    scan: scanOf(obs.scans.shot),
  };
}

export function sourceCheck(obs, one) {
  const { shot } = one;
  return {
    format: 'source-check/0.1',
    caps: obs.caps,
    renders: one.renders.map((r) => {
      // 生效的快门：这次调用给了就用它的，没给用镜头条目的
      const samples = r.opts?.shutter?.samples ?? shot.shutter?.samples;
      const head = {
        shotFrame: r.f,
        want: r.want,
        shutterAngleDeg: r.opts?.shutter?.angleDeg ?? shot.shutter?.angleDeg ?? 0,
        ...(samples === undefined ? {} : { shutterSamples: samples }),
        status: r.status,
      };
      if (r.status !== 'ok') return { ...head, code: r.code };
      return {
        ...head,
        meta: r.metas > 0,
        layers: r.layers,
        ...(r.meta?.camera ? { metaShutterAngleDeg: r.meta.camera.shutterAngleDeg } : {}),
        ...(r.colorTransfer ? { colorTransfer: r.colorTransfer } : {}),
        ...(r.meta ? { colorRef: r.meta.colorRef, shotColorRef: shot.colorRef } : {}),
      };
    }),
    orderRuns: ok(one).filter((r) => r.order).map((r) => ({ shotFrame: r.f, mode: r.order, digest: `sha256:${r.colorSha}` })),
    queries: one.queries,
    manifest: one.manifest,
    metaEntities: ok(one).filter((r) => r.meta).map((r) => ({ shotFrame: r.meta.shotFrame, entities: r.meta.entities.map(({ id, name, class: c }) => ({ id, name, class: c })) })),
  };
}

/** 一份记录说一个镜头在一次运行（run）里的各次成功的 render */
export function metaCheck(one, run) {
  return {
    format: 'meta-check/0.1',
    shot: one.shot.id,
    renders: ok(one).filter((r) => r.run === run).map((r) => ({
      call: r.call,
      shotFrame: r.f,
      metas: r.metas,
      metaBytes: r.metaBytes,
      ...(r.colorCall === undefined ? {} : { colorCall: r.colorCall }),
    })),
  };
}
