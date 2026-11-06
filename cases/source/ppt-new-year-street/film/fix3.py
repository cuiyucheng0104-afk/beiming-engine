import build as B
if __name__ == '__main__':
    only = set()
    for i in (15, 16):
        sc = B.TL[i]; only |= set(range(int(sc['a'] * B.FPS), int(sc['b'] * B.FPS) + 1))
    B.frames(only); B.audio(); B.srt(); B.mux()
