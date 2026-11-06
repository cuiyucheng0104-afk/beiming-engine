"""只重渲指定镜号：python rerender.py 9 14 17"""
import sys
import build as B
if __name__ == '__main__':
    only = set()
    for i in map(int, sys.argv[1:]):
        sc = B.TL[i]; only |= set(range(int(sc['a'] * B.FPS), int(sc['b'] * B.FPS) + 1))
    print(len(only), 'frames', flush=True); B.frames(only); B.mux()
