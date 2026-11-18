#!/usr/bin/env python3
"""Local CAPTCHA model service: free, offline models behind one localhost port (2026-10-24).

Runs from the venv tools/setup-captcha-models.sh creates (private/captcha-env, sharing the machine's
torch/cv2). src/captcha-service.mjs starts it on first use (detached) and talks to it directly.
Models load lazily on first call. Nothing leaves this Mac.

  POST /ocr        {image_b64}                         -> {ok, text, alt, agree}  ddddocr (classic + beta model)
  POST /slide      {bg, piece}                         -> {ok, x, conf, method}   ddddocr slide_match, OpenCV outline/shadow/edges vote
  POST /audio      {audio_b64}                         -> {ok, text}              faster-whisper (fallback when whisper-cli is absent)
  POST /recaptcha  {image_b64, cells, label, grid}     -> {ok, tiles, uncertain}  YOLO tile classifier + COCO segmentation
  GET  /health                                         -> {ok, pid, loaded, weights}
Port: CAPTCHA_SERVICE_PORT (8796). Binds 127.0.0.1 only.
"""
import base64, io, json, os, re, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("CAPTCHA_SERVICE_PORT", "8796"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.environ.get("CAPTCHA_MODELS_DIR") or os.path.join(ROOT, "private", "models", "captcha")
_lock = threading.Lock()
_M = {}


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def model(name, loader):
    with _lock:
        if name not in _M:
            t0 = time.time()
            _M[name] = loader()
            log(f"loaded {name} in {time.time() - t0:.1f}s")
        return _M[name]


# -- OCR ---------------------------------------------------------------------------------------
def ocr(d):
    import ddddocr
    img = base64.b64decode(d["image_b64"])
    a = model("ocr", lambda: ddddocr.DdddOcr(show_ad=False)).classification(img)
    b = model("ocr_beta", lambda: ddddocr.DdddOcr(show_ad=False, beta=True)).classification(img)
    clean = lambda s: re.sub(r"[^0-9A-Za-z]", "", s or "")
    a, b = clean(a), clean(b)
    return {"ok": bool(a or b), "text": a or b, "alt": b if b != a else "", "agree": a.lower() == b.lower() and bool(a)}


# -- Slider ------------------------------------------------------------------------------------
# Estimators of the slot's x (the piece element's left edge, in background pixels):
#   outline - the piece's alpha-mask outline matched against the background's edges (the slot is a cut-out of that shape)
#   shadow  - where the background is darker inside the piece's shape than in a ring around it (the slot's shadow)
#   opencv  - Canny edges of the piece image vs the background
#   ddddocr / ddddocr-simple
# Pieces are often padded PNGs: every x is reported for the piece ELEMENT (its transparent margin subtracted).
def _slot_estimators(bg_rgb, pc_rgba):
    import cv2, numpy as np
    out = []
    g = cv2.cvtColor(bg_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    if pc_rgba.shape[2] == 4:
        a = (pc_rgba[:, :, 3] > 40).astype(np.uint8)
    else:
        a = (cv2.cvtColor(pc_rgba, cv2.COLOR_RGB2GRAY) > 10).astype(np.uint8)
    ys, xs = np.where(a > 0)
    if not len(xs):
        return out, 0
    left = int(xs.min())
    m = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    H, W = m.shape
    if H >= g.shape[0] or W >= g.shape[1]:
        return out, left
    k = np.ones((3, 3), np.uint8)
    outline = cv2.morphologyEx(m * 255, cv2.MORPH_GRADIENT, k).astype(np.float32)
    edges = cv2.Canny(g.astype(np.uint8), 60, 160).astype(np.float32)
    edges = cv2.GaussianBlur(edges, (3, 3), 0)
    r = cv2.matchTemplate(edges, outline, cv2.TM_CCORR_NORMED)
    _, mv, _, ml = cv2.minMaxLoc(r)
    out.append({"x": int(ml[0]) - left, "y": int(ml[1]), "method": "outline", "conf": round(float(mv), 3)})
    inside = m.astype(np.float32); inside /= inside.sum()
    ringm = (cv2.dilate(m, np.ones((7, 7), np.uint8)) - m).astype(np.float32); ringm /= max(ringm.sum(), 1)
    ins = cv2.filter2D(g, -1, inside, anchor=(0, 0), borderType=cv2.BORDER_CONSTANT)
    ring = cv2.filter2D(g, -1, ringm, anchor=(0, 0), borderType=cv2.BORDER_CONSTANT)
    sc = (ring - ins)[: g.shape[0] - H, : g.shape[1] - W]
    sc[:, : max(1, W // 2)] = -1e9  # the slot is never at the very start of the track
    yy, xx = np.unravel_index(int(np.argmax(sc)), sc.shape)
    out.append({"x": int(xx) - left, "y": int(yy), "method": "shadow", "conf": round(float(sc[yy, xx]), 2)})
    return out, left


def slide(d):
    import ddddocr, cv2, numpy as np
    bg, piece = base64.b64decode(d["bg"]), base64.b64decode(d["piece"])
    bgi = cv2.imdecode(np.frombuffer(bg, np.uint8), cv2.IMREAD_COLOR)
    pc = cv2.imdecode(np.frombuffer(piece, np.uint8), cv2.IMREAD_UNCHANGED)
    if pc is None or bgi is None:
        return {"ok": False, "error": "could not decode images"}
    bgi = cv2.cvtColor(bgi, cv2.COLOR_BGR2RGB)
    if pc.ndim == 2:
        pc = cv2.cvtColor(pc, cv2.COLOR_GRAY2RGB)
    pc_rgba = cv2.cvtColor(pc, cv2.COLOR_BGRA2RGBA) if pc.shape[2] == 4 else cv2.cvtColor(pc, cv2.COLOR_BGR2RGB)
    out, left = [], 0
    try:
        est, left = _slot_estimators(bgi, pc_rgba); out += est
    except Exception as e:
        log("slot estimators", e)
    det = model("slide", lambda: ddddocr.DdddOcr(det=False, ocr=False, show_ad=False))
    for simple in (False, True):
        try:
            r = det.slide_match(piece, bg, simple_target=simple)
            # non-simple mode crops the piece to its alpha box first: its x is the shape's x, not the element's
            out.append({"x": int(r["target"][0]) - (0 if simple else left), "method": "ddddocr" + ("-simple" if simple else "")})
        except Exception as e:
            log("slide_match", simple, e)
    try:
        g = lambda b: cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_GRAYSCALE)
        bgg, pcg = g(bg), g(piece)
        if pc.shape[2] == 4:
            ys, xs = np.where(pc[:, :, 3] > 30)
            if len(xs):
                pcg = pcg[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        res = cv2.matchTemplate(cv2.Canny(bgg, 100, 200), cv2.Canny(pcg, 100, 200), cv2.TM_CCOEFF_NORMED)
        _, mv, _, ml = cv2.minMaxLoc(res)
        out.append({"x": int(ml[0]) - left, "method": "opencv", "conf": round(float(mv), 3)})
    except Exception as e:
        log("opencv slide", e)
    if not out:
        return {"ok": False, "error": "no slide estimate"}
    # OpenCV edge match on the alpha-cropped piece leads; it is overruled only when shadow AND outline agree with each
    # other (+-6 px) and OpenCV is the outlier.
    by = {o["method"]: o for o in out}
    oc, sh, ol = by.get("opencv"), by.get("shadow"), by.get("outline")
    W = bgi.shape[1]
    sane = lambda o: o is not None and 0 <= o["x"] <= W - 10
    if sane(sh) and sane(ol) and abs(sh["x"] - ol["x"]) <= 6 and (not sane(oc) or abs(oc["x"] - sh["x"]) > 12):
        x, how = int(round((sh["x"] + ol["x"]) / 2)), "shadow+outline"
    elif sane(oc):
        x, how = oc["x"], "opencv"
    else:
        xs = [o["x"] for o in out if sane(o)] or [o["x"] for o in out]
        best = max(xs, key=lambda v: sum(1 for u in xs if abs(u - v) <= 6)); x, how = best, "vote"
    agree = sum(1 for o in out if abs(o["x"] - x) <= 6)
    return {"ok": True, "x": x, "method": how, "votes": out, "conf": round(agree / len(out), 2), "margin": left}


# -- Audio -------------------------------------------------------------------------------------
def audio(d):
    from faster_whisper import WhisperModel
    import tempfile
    raw = base64.b64decode(d["audio_b64"])
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(raw); p = f.name
    try:
        m = model("whisper", lambda: WhisperModel(os.environ.get("CAPTCHA_WHISPER", "small.en"), device="cpu", compute_type="int8",
                                                 download_root=os.path.join(MODELS_DIR, "whisper")))
        segs, _ = m.transcribe(p, language="en", beam_size=5, vad_filter=True)
        text = " ".join(s.text for s in segs).strip()
        text = re.sub(r"[^\w\s']", "", text).strip().lower()
        return {"ok": bool(text), "text": text}
    finally:
        try: os.unlink(p)
        except Exception: pass


# -- reCAPTCHA image grid (YOLO) ---------------------------------------------------------------
# Classifier: DannyLuna/recaptcha-classification-57k (MIT). Its weights name the classes Bicycle, Bridge, Bus, Car, Chimney,
# Crosswalk, Hydrant, Motorcycle, Mountain, Other, Palm, Stair, Tractor, Traffic Light (checked 2026-10-24). 4x4 photos of a COCO object also
# go through COCO instance segmentation (yolo11m-seg): a cell counts when the object's mask covers part of it.
# prompt word -> (classifier class, COCO class)
LABELS = {
    "traffic light": ("Traffic Light", "traffic light"), "fire hydrant": ("Hydrant", "fire hydrant"), "hydrant": ("Hydrant", "fire hydrant"),
    "parking meter": (None, "parking meter"), "crosswalk": ("Crosswalk", None), "motorcycle": ("Motorcycle", "motorcycle"), "motorbike": ("Motorcycle", "motorcycle"),
    "bicycle": ("Bicycle", "bicycle"), "bridge": ("Bridge", None), "bus": ("Bus", "bus"), "taxi": ("Car", "car"), "car": ("Car", "car"), "vehicle": ("Car", "car"),
    "chimney": ("Chimney", None), "mountain": ("Mountain", None), "hill": ("Mountain", None), "palm": ("Palm", None), "stair": ("Stair", None),
    "tractor": ("Tractor", None), "boat": (None, "boat"),
}


def canon_label(text):
    t = (text or "").lower()
    for k in sorted(LABELS, key=len, reverse=True):
        if re.search(r"\b" + re.escape(k), t):
            return k
    return None


def _class_index(names, wanted):
    """The model's class id for a label, matching the model card's names loosely (case, spaces, underscores)."""
    norm = lambda s: re.sub(r"[^a-z]", "", str(s).lower())
    for k, v in names.items():
        if norm(v) == norm(wanted):
            return k
    return None


def recaptcha(d):
    """{image_b64: the grid as one image, cells: [[x,y,w,h],...] in image px (reading order), label, grid} ->
    {tiles: confident picks (1-based), uncertain: [1-based], probs: [p per cell]}"""
    from ultralytics import YOLO
    from PIL import Image
    import numpy as np
    key = canon_label(d.get("label", ""))
    if not key:
        return {"ok": False, "error": "unknown label: " + str(d.get("label", ""))[:80]}
    cls_name, coco_name = LABELS[key]
    img = Image.open(io.BytesIO(base64.b64decode(d["image_b64"]))).convert("RGB")
    cells = d.get("cells") or []
    grid = int(d.get("grid") or round(len(cells) ** 0.5) or 3)
    if not cells:
        return {"ok": False, "error": "no cells"}
    probs = [0.0] * len(cells)
    cls_path = os.path.join(MODELS_DIR, "recaptcha_cls.pt")
    if cls_name and os.path.exists(cls_path):
        m = model("rc_cls", lambda: YOLO(cls_path, task="classify"))
        idx = _class_index(m.names, cls_name)
        if idx is None:
            return {"ok": False, "error": f"classifier has no class {cls_name}: {list(m.names.values())}"}
        crops = [img.crop((int(x), int(y), int(x + w), int(y + h))) for x, y, w, h in cells]
        for i, r in enumerate(m.predict(crops, verbose=False, imgsz=224)):
            probs[i] = float(r.probs.data[idx])
    elif cls_name and not coco_name:
        return {"ok": False, "error": "recaptcha_cls.pt missing (run tools/setup-captcha-models.sh)"}
    cover = [0.0] * len(cells)
    seg_path = os.path.join(MODELS_DIR, "yolo11m-seg.pt")
    if coco_name and grid == 4 and os.path.exists(seg_path):
        sm = model("rc_seg", lambda: YOLO(seg_path))
        cid = _class_index(sm.names, coco_name)
        r = sm.predict(img, verbose=False, conf=0.3, classes=[cid], imgsz=640)[0] if cid is not None else None
        if r is not None and r.masks is not None:
            import cv2
            mask = np.zeros((img.height, img.width), np.uint8)
            for poly in r.masks.xy:
                if len(poly) >= 3:
                    cv2.fillPoly(mask, [poly.astype(np.int32)], 1)
            for i, (x, y, w, h) in enumerate(cells):
                sub = mask[int(y):int(y + h), int(x):int(x + w)]
                cover[i] = float(sub.mean()) if sub.size else 0.0
    if grid == 4:  # a square counts when the object visibly enters it
        conf = [i + 1 for i in range(len(cells)) if cover[i] >= 0.06 or probs[i] >= 0.6]
        unc = [i + 1 for i in range(len(cells)) if i + 1 not in conf and (cover[i] >= 0.01 or probs[i] >= 0.25)]
    else:
        conf = [i + 1 for i in range(len(cells)) if probs[i] >= 0.7]
        unc = [i + 1 for i in range(len(cells)) if 0.2 <= probs[i] < 0.7]
    return {"ok": True, "tiles": conf, "uncertain": unc, "probs": [round(p, 3) for p in probs], "cover": [round(c, 3) for c in cover],
            "label": key, "classifier": cls_name, "coco": coco_name if grid == 4 else None}


ROUTES = {"/ocr": ocr, "/slide": slide, "/audio": audio, "/recaptcha": recaptcha}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/health"):
            have = {f: os.path.exists(os.path.join(MODELS_DIR, f)) for f in ("recaptcha_cls.pt", "yolo11m-seg.pt")}
            return self._send({"ok": True, "pid": os.getpid(), "loaded": sorted(_M), "weights": have, "models_dir": MODELS_DIR})
        self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        fn = ROUTES.get(self.path.split("?")[0])
        if not fn:
            return self._send({"ok": False, "error": "not found"}, 404)
        try:
            d = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            t0 = time.time(); r = fn(d); r["ms"] = int((time.time() - t0) * 1000)
            self._send(r)
        except Exception as e:
            log(self.path, "error", e); traceback.print_exc()
            self._send({"ok": False, "error": str(e)[:200]})


if __name__ == "__main__":
    os.makedirs(MODELS_DIR, exist_ok=True)
    log(f"captcha service on 127.0.0.1:{PORT}, models in {MODELS_DIR}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
