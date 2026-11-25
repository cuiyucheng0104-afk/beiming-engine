// 独立片单从零起算；轨道、事件和预演表共享 60 Hz 的序列时钟。
import { createScene } from './scene.js';
import { createPipeline } from './pipeline.js';
import film from './film.json' with { type: 'json' };

const shot = film.shots[0];
const switches = new Set([...shot.cards.map((c) => c.use), ...shot.params.dataCards].map((ref) => ref.split('@')[0]));

export const FIRST_FRAME = 2790;
export const FRAME_COUNT = 96;

export function build({ THREE, size, params = {} }) {
  const disabled = new Set(params.disableCards ?? []);
  for (const id of disabled) if (!switches.has(id)) throw new RangeError(`镜头没有可关闭的卡：${id}`);
  params = { ...params, disableCards: disabled };
  const model = createScene(THREE, params, ...size);
  const pipeline = createPipeline(THREE, model, params, ...size);
  const scene = new THREE.Scene();
  scene.add(model.scene);
  let currentFrame = FIRST_FRAME,
    phase = 0;
  let beauty = false,
    skyVisible = true,
    half = 0,
    depth = 0;

  function sample(frame, sub) {
    if (!Number.isInteger(frame) || frame < FIRST_FRAME || frame >= FIRST_FRAME + FRAME_COUNT) {
      throw new RangeError('帧号超出吐息镜头区间');
    }
    if (!Number.isFinite(sub) || sub < 0 || sub >= 1) throw new RangeError('子帧必须在 [0, 1) 内');
    currentFrame = frame;
    phase = sub;
    return model.state(frame, sub);
  }

  // 页面帧源直接画 scene，不调外部 render 钩子。只有颜色目标带 HDR + DepthTexture；
  // 辅助遍照常遍历同一批不透明网格，由宿主换材质，保留米制深度、编号和覆盖率。
  // 实际管线渲染内层 model.scene，不会再进入外层 Scene 的回调。
  scene.onBeforeRender = (_renderer, _scene, _camera, target) => {
    beauty = Boolean(target?.depthTexture && target.texture.type === THREE.HalfFloatType);
    model.scene.visible = !beauty;
    // 天空不写美术深度，辅助材质也不能把无限远的天空误写成一个有限距离的命中。
    skyVisible = model.entities.sky.visible;
    if (!beauty) model.entities.sky.visible = false;
  };
  scene.onAfterRender = (renderer) => {
    model.entities.sky.visible = skyVisible;
    if (!beauty) return;
    model.scene.visible = true;
    beauty = false;
    const target = renderer.getRenderTarget();
    half = Number(target.texture.type === THREE.HalfFloatType);
    depth = Number(target.depthTexture.type === THREE.FloatType);
    pipeline.render(renderer, target, currentFrame, phase);
  };

  return {
    scene,
    camera: model.camera,
    entities: model.entities,
    state(f, sub = 0) {
      return sample(FIRST_FRAME + f, sub);
    },
    meta(f) {
      const meta = model.meta(FIRST_FRAME + f);
      return { ...meta, readings: { ...meta.readings, 'target.halfFloat': half, 'target.depthFloat': depth } };
    },
    render(renderer, target, f, sub = 0) {
      sample(FIRST_FRAME + f, sub);
      pipeline.render(renderer, target, currentFrame, phase);
    },
    renderPasses(renderer, frame, sub = 0) {
      sample(frame, sub);
      pipeline.render(renderer, null, frame, sub);
      return pipeline.passes;
    },
    dispose() {
      pipeline.dispose();
      model.dispose();
      scene.clear();
    },
  };
}
