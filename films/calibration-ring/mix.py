"""校准环的程序化工位声。起音取自 film.json 的事件，混音写到本次运行目录。"""
import json
import os
from pathlib import Path
import sys

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
from engine.audio.dsp import SR, N, T, place
from engine.audio.mixing import master_chain


def tone(freq, length, decay):
    t = T(length)
    attack = np.minimum(t / 0.005, 1)
    release = np.minimum((length - t) / 0.035, 1)
    return (np.sin(2 * np.pi * freq * t) + 0.22 * np.sin(4 * np.pi * freq * t)
            ) * attack * release * np.exp(-decay * t)


def main():
    film = json.loads((HERE / 'film.json').read_text(encoding='utf-8'))
    fmt = film['output']
    dur = float(os.environ.get('BEIMING_DUR', fmt['frameCount'] / fmt['fps']))
    fps = int(os.environ.get('BEIMING_FPS', fmt['fps']))
    time = T(dur)
    bed = (0.026 * np.sin(2 * np.pi * 132 * time)
           + 0.009 * np.sin(2 * np.pi * 179 * time)) * (0.8 + 0.2 * np.cos(2 * np.pi * 0.9 * time))
    bed *= np.minimum(np.minimum(time, dur - time) / 0.15, 1)
    mix = np.column_stack((bed, bed))
    voices = {
        'scan': (tone(420, 0.32, 7), 0.12, -0.15),
        'seat': (tone(152, 0.26, 14), 0.19, 0.06),
        'confirm': (tone(593, 0.66, 3) + 0.52 * tone(791, 0.66, 4), 0.14, 0.16),
    }
    for event in film['events']:
        if event.get('audio') in voices:
            voice, gain, pan = voices[event['audio']]
            frame = round(event['frame'] * fps / fmt['fps'])
            place(mix, voice, frame / fps, gain=gain, pan=pan)
    master, _ = master_chain(mix, target_lufs=-14, max_tp=-2)
    out = Path(os.environ.get('BEIMING_AUDIO_OUT') or HERE / 'out' / 'mix.wav')
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, master[:N(dur)], SR, subtype='PCM_24')


if __name__ == '__main__':
    main()
