# -*- coding: utf-8 -*-
"""音效库检索词表、世界观调性路由与全片三干线声族池规划单元测试（engine/audio/sfx_vocab.py 与 tools/fetch_sfx.py）。"""
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)
from engine.audio import director as DIR  # noqa: E402
from engine.audio import sfx_judge as SJ  # noqa: E402
from engine.audio import sfx_vocab as SV  # noqa: E402
import tools.fetch_sfx as FS  # noqa: E402


class SfxVocabTests(unittest.TestCase):
    def test_load_ucs_caches_parsed_table(self):
        """load_ucs 文档写缓存：同一进程内第二次调用命中 lru_cache，不再解析词表。"""
        SV.load_ucs.cache_clear()
        a = SV.load_ucs()
        self.assertEqual(SV.load_ucs.cache_info().misses, 1)
        b = SV.load_ucs()
        self.assertIs(a, b)
        info = SV.load_ucs.cache_info()
        self.assertEqual(info.hits, 1)
        self.assertEqual(info.misses, 1)
        self.assertEqual(len(a['entries']), 753)

    def test_ucs_table_completeness_and_upstream_fixes(self):
        ucs = SV.load_ucs()
        self.assertEqual(ucs['ucsVersion'], '8.2.1')
        self.assertEqual(ucs['license'], 'CC0-1.0')
        self.assertEqual(len(ucs['entries']), 753)
        cats = SV.list_categories()
        self.assertEqual(len(cats), 82)
        self.assertGreaterEqual(ucs['stats']['uniqueSynonymsEn'], 9900)
        self.assertGreaterEqual(ucs['stats']['uniqueSynonymsZh'], 3000)

        by_id = {e['catId']: e for e in ucs['entries']}
        # 验证上游中文译表 8 处错位/互换均已勘误修正
        self.assertEqual(by_id['OBJFash']['subCategoryZh'], '时尚服饰')
        self.assertEqual(by_id['OBJFurn']['subCategoryZh'], '家具')
        self.assertEqual(by_id['OBJGrdn']['subCategoryZh'], '园艺')
        self.assertEqual(by_id['OBJGym']['subCategoryZh'], '健身器材')
        self.assertEqual(by_id['PAPRFric']['subCategoryZh'], '摩擦')
        self.assertEqual(by_id['PAPRImpt']['subCategoryZh'], '打击')
        self.assertEqual(by_id['AERORadio']['subCategoryZh'], '遥控飞行器')
        self.assertEqual(by_id['CLOCKChim']['subCategoryZh'], '报时钟声')
        # 验证全部 24 条配方引用的 CatID 100% 存在于权威词表
        for rec in SV.DESIGNER_RECIPES:
            for cid in rec['catIds']:
                self.assertIn(cid, by_id, f"{rec['id']} 引用了不存在的 CatID {cid}")

    def test_bilingual_ucs_search_and_cat_lookup(self):
        gear_hits = SV.search_ucs('齿轮', top_n=5)
        self.assertTrue(any(h['catId'] == 'MECHGear' for h in gear_hits))

        beep_hits = SV.search_ucs('UIBeep', top_n=3)
        self.assertEqual(beep_hits[0]['catId'], 'UIBeep')

        ratchet_hits = SV.search_ucs('ratchet', top_n=10)
        self.assertGreaterEqual(len(ratchet_hits), 1)

        mech_rows = SV.get_cat('MECH')
        self.assertEqual(len(mech_rows), 12)

    def test_designer_recipes_align_with_fetch_sfx_ontology_guards(self):
        # 1. 无源机械（圆珠笔/精密齿轮）必须标记 passive 且生成的英文检索词能触发防电机污染守卫
        pen = SV.expand_for_freesound('圆珠笔按压')
        self.assertEqual(pen['power'], 'passive')
        self.assertEqual(pen['archetype'], 'mechanical')
        self.assertTrue(any('ballpoint pen' in q for q in pen['queries']))
        self.assertTrue(any(FS._PASSIVE_MECH_QUERY_RE.search(q) for q in pen['queries']))

        gear = SV.expand_for_freesound('精密齿轮')
        self.assertEqual(gear['power'], 'passive')
        self.assertTrue(any('escapement' in q or 'dial' in q for q in gear['queries']))

        # 2. 高科技界面（菜单弹出/细线走线）必须标记 digital 且检索词触发 is_hitech_query 放行
        hud = SV.expand_for_freesound('菜单弹出')
        self.assertEqual(hud['power'], 'digital')
        self.assertEqual(hud['archetype'], 'ui')
        self.assertTrue(any(FS.is_hitech_query(q) for q in hud['queries']))

        laser = SV.expand_for_freesound('细线走线')
        self.assertEqual(laser['power'], 'digital')
        self.assertTrue(any(FS.is_hitech_query(q) for q in laser['queries']))

        # 3. 有源伺服电机明确归入 motorized
        servo = SV.expand_for_freesound('机器人伺服电机')
        self.assertEqual(servo['power'], 'motorized')
        self.assertEqual(servo['archetype'], 'motorized')

    def test_world_palettes_and_six_worlds_routing(self):
        expected_worlds = {'realistic', 'semi_realistic', 'hitech', 'scifi', 'cartoon', 'poetic'}
        self.assertEqual(set(SV.WORLD_PALETTES), expected_worlds)
        for w in expected_worlds:
            self.assertEqual(SV.WORLD_PALETTES[w]['foley_enabled'], DIR.WORLD_PROFILES[w]['foley_enabled'])
            self.assertEqual(SV.WORLD_PALETTES[w]['stems_lufs'], DIR.WORLD_PROFILES[w]['stems_lufs'])

        with self.assertRaises(ValueError):
            SV.search_by_world('齿轮', world='unknown_world')

        # 1. cartoon：优先 TOON / TOY / WHST，搜「弹簧」和「口哨滑音」直达卡通声族
        toon_spring = SV.search_by_world('弹簧', world='cartoon', top_n=6)
        self.assertEqual(toon_spring['ucs'][0]['catId'], 'TOONBoing')
        self.assertTrue(any('cartoon' in q for q in toon_spring['queries']))

        toon_whistle = SV.search_by_world('口哨滑音', world='cartoon', top_n=6)
        self.assertTrue(any(u['catShort'] in ('WHST', 'TOON') for u in toon_whistle['ucs']))

        # 2. realistic：严禁混入 TOON / SCI / UI / LASR
        real_spring = SV.search_by_world('弹簧', world='realistic', top_n=6)
        self.assertIn('TOON', real_spring['excludedCats'])
        self.assertTrue(all(u['catShort'] not in ('TOON', 'SCI', 'UI', 'LASR') for u in real_spring['ucs']))
        self.assertTrue(any(u['catShort'] in ('METL', 'CLOCK', 'MECH') for u in real_spring['ucs']))

        real_hit = SV.search_by_world('打击', world='realistic', top_n=8)
        self.assertTrue(all(u['catShort'] not in ('TOON', 'SCI', 'LASR') for u in real_hit['ucs']))
        self.assertTrue(any(u['catShort'] in ('WOOD', 'METL', 'ROCK') for u in real_hit['ucs']))

        # 3. semi_realistic：定格积木/拼插优先 PLAS / TOY / MECH / WOOD
        semi_brick = SV.search_by_world('积木拼插', world='semi_realistic', top_n=6)
        self.assertTrue(any(u['catShort'] in ('PLAS', 'TOY', 'MECH', 'WOOD') for u in semi_brick['ucs'][:3]))

        # 4. hitech：优先 UI / BEEP / LASR / MECH / CLOCK，排除 TOON / ANML / CRWD / GORE
        hi_menu = SV.search_by_world('菜单弹出', world='hitech', top_n=6)
        self.assertEqual(hi_menu['power'], 'digital')
        self.assertEqual(hi_menu['archetype'], 'tonal_ui')
        self.assertTrue(any(u['catShort'] in ('UI', 'BEEP') for u in hi_menu['ucs'][:3]))
        self.assertTrue(all(u['catShort'] not in ('TOON', 'GORE', 'CRWD', 'ANML') for u in hi_menu['ucs']))

        # 5. scifi：优先 SCI / LASR / ROBT，排除 TOON
        sci_door = SV.search_by_world('舱门开启', world='scifi', top_n=6)
        self.assertEqual(sci_door['ucs'][0]['catId'], 'SCIDoor')
        sci_mech = SV.search_by_world('机甲关节伺服', world='scifi', top_n=6)
        self.assertTrue(any(u['catShort'] in ('ROBT', 'MOTR', 'SCI') for u in sci_mech['ucs'][:3]))
        self.assertEqual(sci_mech['power'], 'motorized')

        # 6. poetic：东方水墨写意优先 WIND / WATR / BELL / PAPR / CLOTH，严禁 TOON / SCI / MOTR / LASR
        poetic_ink = SV.search_by_world('落笔水墨画卷', world='poetic', top_n=6)
        self.assertTrue(any(u['catShort'] in ('PAPR', 'WATR') for u in poetic_ink['ucs'][:3]))
        poetic_no_motor = SV.search_by_world('机器人伺服电机', world='poetic', top_n=6)
        self.assertIn('MOTR', poetic_no_motor['excludedCats'])
        self.assertNotEqual(poetic_no_motor['power'], 'motorized')
        self.assertTrue(all(u['catShort'] not in ('MOTR', 'ROBT', 'SCI', 'TOON') for u in poetic_no_motor['ucs']))

    def test_classify_stem_three_stems_and_hitech_policy(self):
        # 环境氛围层 amb
        c_amb = SV.classify_stem('雾江清晨山风与环境声铺底', world='realistic')
        self.assertEqual(c_amb['stem'], 'amb')
        self.assertEqual(c_amb['action'], 'keep')
        self.assertTrue(c_amb['enabled'])

        # 硬效与设计层 fx
        c_fx = SV.classify_stem('圆珠笔按钮按压与精密棘轮咬合', world='hitech')
        self.assertEqual(c_fx['stem'], 'fx')
        self.assertEqual(c_fx['action'], 'keep')
        self.assertTrue(c_fx['enabled'])

        # 生命体动作层 foley（在写实与水墨世界观下正常启用）
        c_fol = SV.classify_stem('主角踏碎石路快步走过，衣袂翻飞', world='realistic')
        self.assertEqual(c_fol['stem'], 'foley')
        self.assertEqual(c_fol['action'], 'keep')
        self.assertTrue(c_fol['enabled'])

        # 纯无生命体 hitech 世界观：非必要人物/动物拟音给出 skip 跳过建议
        c_hi_skip = SV.classify_stem('人物碎石路脚步声与衣料摩擦', world='hitech')
        self.assertEqual(c_hi_skip['rawStem'], 'foley')
        self.assertEqual(c_hi_skip['action'], 'skip')
        self.assertFalse(c_hi_skip['enabled'])
        self.assertIn('skip', c_hi_skip['suggestion'])

        # hitech 下含机械/界面主体的人手交互给出降级并入 fx 建议
        c_hi_down = SV.classify_stem('手指轻触微动开关按钮', world='hitech')
        self.assertEqual(c_hi_down['rawStem'], 'foley')
        self.assertEqual(c_hi_down['stem'], 'fx')
        self.assertEqual(c_hi_down['action'], 'downgrade_to_fx')
        self.assertTrue(c_hi_down['enabled'])

    def test_plan_film_sound_pool_real_films_and_events(self):
        all_cids = {e['catId'] for e in SV.load_ucs()['entries']}
        beiming_path = os.path.join(ROOT, 'films', 'beiming-10s', 'film.json')

        # 1. 真实《北冥》10s 样片规划（realistic / hitech 对比）
        plan_real = SV.plan_film_sound_pool(beiming_path, world='realistic')
        self.assertEqual(plan_real['filmId'], 'beiming-10s')
        self.assertEqual(len(plan_real['amb_pool']), 3)
        self.assertEqual([x['shot'] for x in plan_real['amb_pool']], ['A', 'B', 'C'])
        self.assertGreaterEqual(len(plan_real['fx_pool']), 8)
        self.assertGreaterEqual(len(plan_real['foley_pool']), 3)
        # 配乐与母带淡出事件不应混入音效检索池
        fx_ids = {x['id'] for x in plan_real['fx_pool']}
        self.assertNotIn('c.strings_in', fx_ids)
        self.assertNotIn('c.end_fade', fx_ids)

        for pool in (plan_real['amb_pool'], plan_real['fx_pool'], plan_real['foley_pool']):
            for item in pool:
                self.assertIn(item['catId'], all_cids)
                self.assertTrue(all(cid in all_cids for cid in item['catIds']))
                self.assertIn(item['archetype'], SJ.ARCHETYPES)
                self.assertIn(item['power'], ('passive', 'motorized', 'digital'))
                self.assertTrue(item['identity'] and item['detail'] and item['avoid'])

        plan_hi = SV.plan_film_sound_pool(beiming_path, world='hitech')
        self.assertEqual(plan_hi['foley_pool'], [])
        self.assertGreaterEqual(len(plan_hi['suppressed_foley']), 2)

        # 2. C 路线水墨模版 film.json（无 shots/events，按 tempo + cues 自动推导）
        c_tpl_path = os.path.join(ROOT, 'routes', 'c-style', 'template', 'film.json')
        plan_c = SV.plan_film_sound_pool(c_tpl_path, world='poetic')
        self.assertEqual(plan_c['world'], 'poetic')
        self.assertEqual(len(plan_c['amb_pool']), 1)
        self.assertAlmostEqual(plan_c['amb_pool'][0]['out_s'], 8.0, places=2)
        all_c_ids = {x['id'] for x in (*plan_c['fx_pool'], *plan_c['foley_pool'])}
        self.assertIn('cue:title', all_c_ids)
        self.assertIn('cue:seal', all_c_ids)

        # 3. 直接输入事件字符串列表规划
        plan_list = SV.plan_film_sound_pool(
            ['山谷晨雾微风环境铺底', '侠客踏竹叶轻步落地', '青锋长剑出鞘清鸣'],
            world='poetic',
        )
        self.assertEqual(len(plan_list['amb_pool']), 1)
        self.assertEqual(len(plan_list['foley_pool']), 1)
        self.assertEqual(len(plan_list['fx_pool']), 1)
        self.assertEqual(plan_list['fx_pool'][0]['archetype'], 'metal_blade')

    def test_fetch_sfx_vocab_world_and_plan_cli(self):
        fetch_py = os.path.join(ROOT, 'tools', 'fetch_sfx.py')
        r = subprocess.run(
            [sys.executable, fetch_py, '--vocab', '棘轮', '-n', '3'],
            capture_output=True, text=True, encoding='utf-8', check=True, cwd=ROOT,
        )
        self.assertIn('MECHGear', r.stdout)
        self.assertIn('pocket watch escapement', r.stdout)

        r_cats = subprocess.run(
            [sys.executable, fetch_py, '--list-categories'],
            capture_output=True, text=True, encoding='utf-8', check=True, cwd=ROOT,
        )
        self.assertIn('82 大类', r_cats.stdout)
        self.assertIn('USER INTERFACE', r_cats.stdout)

        # --vocab 配合 --world 与 --json
        r_toon = subprocess.run(
            [sys.executable, fetch_py, '--vocab', '弹簧', '--world', 'cartoon', '--json', '-n', '4'],
            capture_output=True, text=True, encoding='utf-8', check=True, cwd=ROOT,
        )
        d_toon = json.loads(r_toon.stdout)
        self.assertEqual(d_toon['world'], 'cartoon')
        self.assertEqual(d_toon['ucs'][0]['catId'], 'TOONBoing')

        # --plan 输出结构化 JSON 与人类可读报告
        beiming_path = os.path.join(ROOT, 'films', 'beiming-10s', 'film.json')
        r_plan_json = subprocess.run(
            [sys.executable, fetch_py, '--plan', beiming_path, '--world', 'poetic', '--json'],
            capture_output=True, text=True, encoding='utf-8', check=True, cwd=ROOT,
        )
        d_plan = json.loads(r_plan_json.stdout)
        self.assertEqual(d_plan['filmId'], 'beiming-10s')
        self.assertEqual(d_plan['world'], 'poetic')
        self.assertEqual(len(d_plan['amb_pool']), 3)

        c_tpl_path = os.path.join(ROOT, 'routes', 'c-style', 'template', 'film.json')
        r_plan_txt = subprocess.run(
            [sys.executable, fetch_py, '--plan', c_tpl_path, '--world', 'poetic'],
            capture_output=True, text=True, encoding='utf-8', check=True, cwd=ROOT,
        )
        self.assertIn('AMB 环境氛围干线池', r_plan_txt.stdout)
        self.assertIn('SFX 硬效与设计音效干线池', r_plan_txt.stdout)
        self.assertIn('cue:seal', r_plan_txt.stdout)

        # 验证 fetch_sfx.human_score 对不同 world 的标签准入与拒止逻辑
        toon_item = {
            'id': 1, 'name': 'cartoon_spring_boing.wav', 'samplerate': 48000, 'bitdepth': 24, 'type': 'wav',
            'num_downloads': 200, 'avg_rating': 4.5, 'num_ratings': 25,
            'tags': ['cartoon', 'boing', 'spring'], 'description': 'Clean cartoon boing spring recorded in studio',
        }
        self.assertGreater(FS.human_score(toon_item, query='cartoon spring boing', world='cartoon'), 10.0)
        self.assertLess(FS.human_score(toon_item, query='spring', world='realistic'), 0.0)

    def test_scene_ambience_layers_and_decompose_scene_ambience(self):
        by_id = {e['catId']: e for e in SV.load_ucs()['entries']}
        self.assertGreaterEqual(len(SV.SCENE_AMBIENCE_LAYERS), 8)
        for sc_id, spec in SV.SCENE_AMBIENCE_LAYERS.items():
            for lk in ('base_hum', 'primary_texture', 'spot_life'):
                for cid in spec[lk]['catIds']:
                    self.assertIn(cid, by_id, f'{sc_id}.{lk} 引用了无效 CatID: {cid}')

        # 海岸小镇 + 黄昏：拆解出都市远景底床 + 海浪主纹理 + 海鸥/暮蝉生机点缀
        coastal = SV.decompose_scene_ambience('夏日海岸小镇电车公路与黄昏夕阳', world='semi_realistic')
        self.assertEqual(coastal['sceneType'], 'coastal_town')
        self.assertEqual(set(coastal['layers'].keys()), {'base_hum', 'primary_texture', 'spot_life'})
        self.assertTrue(any('town' in q or 'city' in q for q in coastal['layers']['base_hum']['queries']))
        self.assertTrue(any('wave' in q or 'surf' in q for q in coastal['layers']['primary_texture']['queries']))
        self.assertTrue(any('gull' in q for q in coastal['layers']['spot_life']['queries']))
        self.assertTrue(any('cicada' in q for q in coastal['layers']['spot_life']['queries']))
        self.assertGreaterEqual(len(coastal['queries']), 6)

        # 六种世界观调性下拆解均不混入 forbidden_cats；hitech 自动关闭生物鸟虫点缀
        for w, pal in SV.WORLD_PALETTES.items():
            forb = set(pal['forbidden_cats'])
            dec = SV.decompose_scene_ambience('海边港口与飞鸟', world=w)
            for lk in ('base_hum', 'primary_texture', 'spot_life'):
                for cid in dec['layers'][lk]['catIds']:
                    self.assertNotIn(by_id[cid]['catShort'], forb, f'{w}.{lk} 混入禁入大类 {cid}')
        hi_dec = SV.decompose_scene_ambience('海边港口与飞鸟', world='hitech')
        self.assertFalse(hi_dec['layers']['spot_life']['enabled'])

        # 验证 plan_film_sound_pool 已并入三层环境拆解
        plan_coastal = SV.plan_film_sound_pool(
            {
                'id': 'coastal-demo',
                'title': '追电车测试',
                'fps': 24,
                'shots': [{'id': 'S1', 'in': 0, 'out': 96, 'name': '夏日海边小镇海岸'}],
                'events': [{'id': 'tram_horn', 'frame': 48, 'shot': 'S1', 'audio': 'horn', 'desc': '电车喇叭声'}],
            },
            world='semi_realistic',
        )
        amb0 = plan_coastal['amb_pool'][0]
        self.assertEqual(amb0['sceneType'], 'coastal_town')
        self.assertIn('layers', amb0)
        self.assertTrue(any('gull' in q for q in amb0['queries']))
        txt_rep = SV.format_sound_pool_plan(plan_coastal)
        self.assertIn('Base Hum', txt_rep)
        self.assertIn('Spot Life', txt_rep)


if __name__ == '__main__':
    unittest.main()
