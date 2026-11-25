"""米制 Object 坐标下的工业表面。目录和参数校验可脱离 Blender 使用。"""


from fnmatch import fnmatchcase


class BadArgument(ValueError):
    code = 'usage.bad-argument'

    def __init__(self, detail):
        super().__init__(f'{self.code}: {detail}')


# L18 标定输入。颜色是线性 RGB 千分值；粗糙度为图案中心值，不是渲染亮度。
# 名称、基色、金属度、粗糙度、表面工艺。仅冷白发光面带自发光。
_SURFACES = {
    'cap':           ((600, 610, 630), 1, .28, 'satin'),
    'chip':          ((21, 21, 23),    0, .50, 'resin'),
    'choke':         ((55, 55, 58),  .20, .55, 'cast'),
    'copper':        ((820, 380, 210), 1, .27, 'satin'),
    'die':           ((90, 130, 280),  1, .07, 'film'),
    'emit_white':    ((900, 960, 1000),0, .50, 'luminous'),
    'fan_blade':     ((17, 17, 19),    0, .43, 'mold'),
    'fan_hub':       ((85, 86, 94),    1, .30, 'lathe'),
    'fin_black':     ((18, 18, 20),    0, .36, 'fin'),
    'frame_black':   ((20, 20, 21),    0, .50, 'matte'),
    'frame_dark':    ((100, 98, 100),  1, .50, 'blasted'),
    'frame_edge':    ((400, 400, 415), 1, .26, 'machined'),
    'gold':          ((950, 640, 260), 1, .30, 'satin'),
    'nickel':        ((640, 620, 580), 1, .38, 'satin'),
    'pad_white':     ((780, 780, 760), 0, .68, 'pad'),
    'pcb_black':     ((10, 12, 11),    0, .36, 'traces'),
    'plastic_black': ((15, 15, 16),    0, .46, 'mold'),
    'port_metal':    ((620, 630, 650), 1, .25, 'satin'),
    'rubber':        ((10, 10, 10),    0, .82, 'rubber'),
    'steel':         ((520, 530, 550), 1, .33, 'brush'),
    'substrate':     ((16, 85, 62),    0, .42, 'laminate'),
}


def list_materials():
    return list(_SURFACES)


def get_material_spec(name):
    if not isinstance(name, str) or name not in _SURFACES:
        raise BadArgument(f'未知材质：{name!r}')
    tint, metal, rough, finish = _SURFACES[name]
    return {'name': name, 'baseColor': [x / 1000 for x in tint], 'metallic': metal,
            'roughness': rough, 'emissionStrength': 2.5 if finish == 'luminous' else 0, 'finish': finish}


def validate_assignments(assignments):
    if not isinstance(assignments, dict):
        raise BadArgument('assignments 须为场景对象名到材质名的映射')
    for target, name in assignments.items():
        if not isinstance(target, str) or not target.strip() or '\0' in target:
            raise BadArgument('须填写非空的场景对象名')
        get_material_spec(name)
    return dict(assignments)


def material_readings(names, assigned_count):
    specs = [get_material_spec(name) for name in names]
    readings = {'materialCount': len(specs), 'assignedCount': assigned_count,
                'metallicCount': sum(s['metallic'] == 1 for s in specs),
                'emissiveCount': sum(s['emissionStrength'] > 0 for s in specs)}
    for s in specs:
        for key in ('metallic', 'roughness', 'emissionStrength'):
            readings[s['name'] + '.' + key] = s[key]
    return readings


# 每种磨砂工艺的粗糙度起伏频率 (/m)、微粒间距 (m) 和凹凸深度 (m)。
_GRAIN = {'blasted': (35, .00030, .000016), 'matte': (40, .00030, .000008),
          'mold': (60, .00025, .000010), 'resin': (300, .00018, .000014),
          'cast': (300, .00030, .000020), 'rubber': (100, .00040, .000015),
          'laminate': (200, .00035, .000005), 'pad': (300, 1 / 700, .00012)}


def configure_material(material, name):
    """只编辑卡新建的材质。所有插口使用 Blender 5.2 的序号，不依赖界面语言。"""
    s = get_material_spec(name)
    tint = (*s['baseColor'], 1)
    finish, rough = s['finish'], s['roughness']
    material.diffuse_color, material.metallic, material.roughness = tint, s['metallic'], rough
    tree = material.node_tree
    tree.nodes.clear()

    def node(kind, **properties):
        n = tree.nodes.new('ShaderNode' + kind)
        for key, value in properties.items():
            setattr(n, key, value)
        return n

    def wire(socket, dest, index):
        tree.links.new(socket, dest.inputs[index])

    def math_op(op, a, b, c=None):
        n = node('Math', operation=op)
        wire(a, n, 0)
        if isinstance(b, (int, float)):
            n.inputs[1].default_value = b
        else:
            wire(b, n, 1)
        if c is not None:
            n.inputs[2].default_value = c
        return n.outputs[0]

    def noise(vector, frequency):
        n = node('TexNoise')
        wire(vector, n, 0)
        n.inputs[2].default_value = frequency
        n.inputs[3].default_value = 2
        return n.outputs[0]

    def bump(height, depth):
        # 近距保留颗粒，0.12–0.35 m 钳位衰减；相机移动时由 Cycles 逐采样计算。
        fade = node('MapRange', clamp=True)
        wire(node('CameraData').outputs[2], fade, 0)
        for i, v in enumerate((.1225, .35, 1, 0), 1):
            fade.inputs[i].default_value = v
        relief = node('Bump')
        wire(fade.outputs[0], relief, 0)
        relief.inputs[1].default_value = depth
        wire(height, relief, 3)
        wire(relief.outputs[0], surface, 6)

    def ramp(factor, low, high):
        n = node('ValToRGB')
        wire(factor, n, 0)
        n.color_ramp.elements[0].color = (*low, 1)
        n.color_ramp.elements[1].color = (*high, 1)
        return n.outputs[0]

    def wave(mode, axis, frequency):
        n = node('TexWave', wave_type=mode)
        if mode == 'RINGS':
            n.rings_direction = axis
        else:
            n.bands_direction = axis
        wire(coord, n, 0)
        n.inputs[1].default_value = frequency
        return n.outputs[1]

    surface = node('BsdfPrincipled')
    wire(surface.outputs[0], node('OutputMaterial'), 0)
    surface.inputs[0].default_value = tint
    surface.inputs[1].default_value = s['metallic']
    surface.inputs[2].default_value = rough
    coord = node('TexCoord').outputs[3]
    if finish == 'luminous':  # 匀质面无纹理；保留输入坐标约定，不添加辉光合成。
        surface.inputs[28].default_value = tint
        surface.inputs[29].default_value = s['emissionStrength']
        return

    amplitude = .04
    if finish in _GRAIN:
        patch, spacing, depth = _GRAIN[finish]
        pattern = noise(coord, patch)
        bump(noise(coord, 1 / spacing), depth)
        if finish == 'resin':
            surface.inputs[14].default_value = .30
        elif finish == 'pad':
            surface.inputs[9].default_value = .35
            surface.inputs[10].default_value = (1, .9, .8)
            surface.inputs[11].default_value = .0006
        elif finish == 'laminate':
            low, high = ([v * factor for v in s['baseColor']] for factor in (.8, 1.25))
            wire(ramp(noise(coord, 900), low, high), surface, 0)
    elif finish == 'lathe':
        pattern = wave('RINGS', 'Y', 1400)
        bump(pattern, .000004)
        surface.inputs[16].default_value = .8
        wire(node('Tangent', direction_type='RADIAL', axis='Y').outputs[0], surface, 18)
        amplitude = .06
    elif finish == 'traces':
        # 用板面分区交替选择两个轴向的导线，再给阻焊层着色。
        cell = math_op('GREATER_THAN', noise(coord, 70), .5)
        u = math_op('MULTIPLY', wave('BANDS', 'X', 450), cell)
        v = math_op('MULTIPLY', wave('BANDS', 'Z', 450), math_op('LESS_THAN', cell, .5))
        pattern = math_op('GREATER_THAN', math_op('ADD', u, v), .72)
        wire(ramp(pattern, s['baseColor'], (.019, .024, .021)), surface, 0)
        bump(pattern, .000012)
        wire(math_op('MULTIPLY_ADD', pattern, -.06, rough), surface, 2)
        return
    elif finish in ('brush', 'film'):
        stretch = node('Mapping')
        wire(coord, stretch, 0)
        if finish == 'brush':
            stretch.inputs[3].default_value = (1, 60, 60)
            pattern = noise(stretch.outputs[0], 60)
            amplitude = .07
            bump(pattern, .000004)
        else:
            stretch.inputs[2].default_value = (0, .6, 0)
            stretch.inputs[3].default_value = (40, 1, 1)
            pattern = noise(stretch.outputs[0], 250)
            wire(ramp(node('LayerWeight').outputs[1], s['baseColor'], (.26, .15, .33)), surface, 0)
            amplitude = .025
    else:
        pattern = noise(coord, {'satin': 400, 'machined': 80, 'fin': 120}[finish])
        amplitude = {'satin': .025, 'machined': .03, 'fin': .05}[finish]
        if finish == 'fin':
            surface.inputs[14].default_value = .75
    wire(math_op('MULTIPLY_ADD', pattern, 2 * amplitude, rough - amplitude), surface, 2)


def resolve_targets(objects, assignments):
    """在 create 之前展开所有规则，按对象去重；精确名优先，不按 JSON 键顺序争抢。"""
    exact, matches = {}, {}
    for target, name in validate_assignments(assignments).items():
        if any(c in target for c in '*?['):
            hits = [key for key in objects.keys() if fnmatchcase(key, target) and objects[key].type == 'MESH']
            if not hits:
                raise BadArgument(f'规则未匹配到场景网格：{target}')
            for key in hits:
                matches.setdefault(key, set()).add(name)
        else:
            obj = objects.get(target)
            if obj is None or obj.type != 'MESH':
                raise BadArgument(f'目标不是当前场景中的网格：{target}')
            exact[target] = name
    for key, names in matches.items():
        if key not in exact:
            if len(names) > 1:
                raise BadArgument(f'网格 {key} 命中不同材质，请用精确对象名指定')
            exact[key], = names
    return [(objects[key], name) for key, name in sorted(exact.items())]


def create(ctx, params):
    if not isinstance(params, dict) or params.keys() - {'assignments'}:
        raise BadArgument('params 只接受 assignments')
    bindings = resolve_targets(ctx.hostScene.objects, params.get('assignments', {}))

    data = ctx.bpy.data
    materials, overrides, extra_slots, copies = {}, [], [], []

    def alive(block):
        # 宿主按 create 顺序释放。上游资产的 RNA 包装器可能仍在，但底层 ID 已删除。
        try:
            return bool(block.as_pointer())
        except ReferenceError:
            return False

    def dispose():
        while overrides:
            obj, mesh, idx, link, saved = overrides.pop()
            if alive(obj) and alive(mesh):
                slot = obj.material_slots[idx]
                slot.material = saved if saved is not None and alive(saved) else None
                slot.link = link
        while extra_slots:
            mesh = extra_slots.pop()
            if alive(mesh):
                mesh.materials.pop(index=0)
        while copies:
            obj, original, owned = copies.pop()
            if alive(obj) and alive(original):
                obj.data = original
            if alive(owned):
                data.meshes.remove(owned)
        while materials:
            _, owned = materials.popitem()
            if alive(owned):
                data.materials.remove(owned)

    try:
        for name in list_materials():
            mat = materials[name] = data.materials.new('mat.library.' + name)
            configure_material(mat, name)
        for obj, name in bindings:
            if not obj.material_slots:
                # 无槽位的共享网格不能给单一实例增槽，否则未指定的兄弟实例也会被改。
                if obj.data.users > 1:
                    original = obj.data
                    owned = original.copy()
                    copies.append((obj, original, owned))
                    obj.data = owned
                obj.data.materials.append(materials[name])
                extra_slots.append(obj.data)
            else:
                # 保留每个面已有的槽号。按对象覆盖，即使共用 mesh 也可分配不同材质。
                for idx, slot in enumerate(obj.material_slots):
                    link = slot.link
                    slot.link = 'OBJECT'
                    overrides.append((obj, obj.data, idx, link, slot.material))
                    slot.material = materials[name]
    except Exception:
        dispose()
        raise

    readings = material_readings(materials, len(bindings))
    return {'materials': materials, 'entities': {}, 'readings': readings.copy,
            'apply': lambda f, sub: None, 'meta': lambda f: {'readings': readings.copy()}, 'dispose': dispose}
