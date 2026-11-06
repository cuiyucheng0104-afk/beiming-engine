"""直接调 5090 ComfyUI：用 hypit_studio/graphs.py 拼任务，提交、等待、下载。

from gen import submit, wait, upload
pid = submit({"mode": "t2i", ...}); files = wait(pid, "out/x")
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.expanduser("~/hypit-remake-lab/pipeline/stages/03-produce/studio/hypit_studio"))
import graphs  # noqa: E402

H = "http://@@ROG_HOST@@:8188"


def _json(url, data=None, headers=None):
    req = urllib.request.Request(url, data, headers or {})
    return json.load(urllib.request.urlopen(req, timeout=60))


def upload(path, name=None):
    """把本地图片/视频传到 ComfyUI input，返回文件名。"""
    name = name or os.path.basename(path)
    boundary = uuid.uuid4().hex
    body = b"".join([
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n".encode(), open(path, "rb").read(), f"\r\n--{boundary}--\r\n".encode()])
    r = _json(H + "/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return r["name"]


def submit(p, loras=()):
    nodes, meta = graphs.build(dict(p), set(loras))
    r = _json(H + "/prompt", json.dumps({"prompt": nodes}).encode(), {"Content-Type": "application/json"})
    return r["prompt_id"]


def wait(pid, out_prefix, poll=4):
    """等任务结束，把产物下载成 out_prefix + 扩展名（多个文件加 _1、_2）。返回本地路径列表。"""
    while True:
        h = _json(f"{H}/history/{pid}")
        if pid in h:
            st = h[pid]["status"]
            if st.get("status_str") == "error":
                msg = [m for m in st.get("messages", []) if m[0] == "execution_error"]
                raise RuntimeError(json.dumps(msg)[-1500:])
            if st.get("completed"):
                break
        time.sleep(poll)
    files = [x for o in h[pid]["outputs"].values() for v in o.values() if isinstance(v, list)
             for x in v if isinstance(x, dict) and x.get("filename") and x.get("type") == "output"]
    os.makedirs(os.path.dirname(out_prefix) or ".", exist_ok=True)
    paths = []
    for i, f in enumerate(files):
        ext = os.path.splitext(f["filename"])[1]
        dst = out_prefix + (f"_{i}" if i else "") + ext
        q = urllib.parse.urlencode({"type": "output", "subfolder": f.get("subfolder", ""), "filename": f["filename"]})
        urllib.request.urlretrieve(f"{H}/view?{q}", dst)
        paths.append(dst)
    return paths
