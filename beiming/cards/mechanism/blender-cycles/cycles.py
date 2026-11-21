# blender.cycles：把镜头的渲染器定成 Cycles，降噪器定成 OIDN 并放在显卡上，快门从帧起点打开。
# 每像素采样数、开不开降噪、快门角由帧源按这次出帧的档位逐次写（草稿档低采样加降噪，终稿档取镜头 tiers.final.samples），
# 这张卡只管不随档位变的那一半。apply(f, sub) 不改任何东西，只核对渲染器还是 Cycles：有别的卡把它改成 EEVEE 时报错，不照常出帧。


def create(ctx, params):
    scene = ctx.hostScene
    r, c = scene.render, scene.cycles
    r.engine = 'CYCLES'
    r.motion_blur_position = 'START'
    c.device = 'GPU'
    c.denoiser = 'OPENIMAGEDENOISE'
    c.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
    c.denoising_prefilter = 'ACCURATE'
    c.denoising_quality = 'HIGH'
    c.denoising_use_gpu = True
    c.max_bounces = params['bounces']
    c.sample_clamp_indirect = float(params['clampIndirect'])

    def apply(f, sub):
        if r.engine != 'CYCLES' or r.motion_blur_position != 'START':
            raise RuntimeError('blender.cycles：第 %d 帧渲染器是 %s、快门位置是 %s，必须是 Cycles 和帧起点' % (f, r.engine, r.motion_blur_position))

    def dispose():
        pass

    return {'apply': apply, 'dispose': dispose}
