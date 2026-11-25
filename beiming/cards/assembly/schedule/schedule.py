"""镜头局部装配工序：交接编排表和到位事件，不改场景。"""

import importlib.util
from bisect import bisect_right
from pathlib import Path


_spec = importlib.util.spec_from_file_location(
    'beiming_blender_choreo', Path(__file__).resolve().parents[3] / 'sources/blender/choreo.py')
_choreo = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_choreo)


def create(ctx, params):
    groups = params.get('groups', [])
    if (not isinstance(groups, (list, tuple)) or any(not isinstance(g, str) or not g for g in groups)
            or len(set(groups)) != len(groups)):
        raise ValueError('groups 必须是不重复的组名列表')
    plan = _choreo.schedule_assembly(
        params.get('parts', [{'id': 'part', 'rest_pos': [0, 0, 0]}]), groups,
        fps=ctx.fps, seed=ctx.seed, shot=ctx.shot['id'], start_frame=params.get('startFrame', 0),
        gap_frames=params.get('gapFrames', 3), fly_frames=params.get('flyFrames', 18),
        offset_m=params.get('offsetM', 1.0), spin_deg=params.get('spinDeg', 30.0),
    )
    events = plan['events']
    arrivals = sorted(event['frame'] for event in events['events'])
    count = len(plan['parts'])

    def meta(f):
        return {'readings': {'partCount': count, 'arrivedCount': bisect_right(arrivals, f)}}

    def apply(f, sub):
        pass

    def dispose():
        pass

    return {'apply': apply, 'meta': meta, 'dispose': dispose, 'schedule': plan, 'events': events}
