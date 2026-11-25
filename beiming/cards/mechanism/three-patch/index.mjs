// 补丁只作用于单个材质，不改全局 ShaderChunk。按声明顺序匹配前一条的结果。
const pinned = '0.187.0';
function requireVersion(version, allowed = [pinned]) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(allowed) || !allowed.includes(version)) {
    throw new RangeError(`unsupported three version: ${version}`);
  }
}

function plan({ version, allowedVersions, patches }) {
  requireVersion(version, allowedVersions);
  if (!Array.isArray(patches) || !patches.length) throw new TypeError('expected nonempty patches');
  return Array.from(patches, ({ stage, mode, anchor, code }) => {
    if (!['vertexShader', 'fragmentShader'].includes(stage) || !['before', 'after', 'replace'].includes(mode)) throw new TypeError('invalid patch stage or mode');
    if (typeof anchor !== 'string' || !anchor || typeof code !== 'string') throw new TypeError('invalid patch anchor or code');
    return { stage, mode, anchor, code };
  });
}

function apply(shader, entries) {
  const result = { vertexShader: shader.vertexShader, fragmentShader: shader.fragmentShader };
  for (const { stage, mode, anchor, code } of entries) {
    const text = result[stage], at = text.indexOf(anchor);
    if (at < 0) throw new Error(`${stage}: missing anchor ${anchor}`);
    if (text.indexOf(anchor, at + 1) !== -1) throw new Error(`${stage}: ambiguous anchor ${anchor}`);
    const replacement = mode === 'before' ? code + anchor : mode === 'after' ? anchor + code : code;
    result[stage] = text.slice(0, at) + replacement + text.slice(at + anchor.length);
  }
  return result;
}

/** 返回两个着色阶段的新源码；任一操作失败，两阶段都不改写。 */
export function patchShaderSource(shader, options) {
  return apply(shader, plan(options));
}

/** options.version 是实际宿主版本。闭包控制的已有材质变体应实现自己的 customProgramCacheKey。 */
export function attachMaterialPatch(material, options) {
  const entries = plan(options);
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
  if (typeof compile !== 'function' || typeof key !== 'function') throw new TypeError('expected a three material');
  // Three 默认键依赖 this.onBeforeCompile.toString()；包裹后仍须区分原来的钩子。
  const signature = JSON.stringify([options.version, compile.toString(), entries]);
  material.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    Object.assign(shader, apply(shader, entries));
  };
  material.customProgramCacheKey = function () {
    return JSON.stringify([key.call(this), signature]);
  };
  material.needsUpdate = true;
  return material;
}

/** 原生镜头从 ctx.THREE 取实际版本，不让参数覆盖宿主版本。 */
export function create({ THREE }, { allowedVersions = [pinned] } = {}) {
  const version = `0.${THREE.REVISION}.0`;
  requireVersion(version, allowedVersions);
  const options = patches => ({ version, allowedVersions, patches });
  return {
    patchShaderSource: (shader, patches) => patchShaderSource(shader, options(patches)),
    attachMaterialPatch: (material, patches) => attachMaterialPatch(material, options(patches)),
    dispose() {}, // 不持有材质或 GPU 资源；材质由镜头释放。
  };
}
