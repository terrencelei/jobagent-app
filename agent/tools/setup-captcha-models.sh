#!/bin/sh
# Installs the free, local CAPTCHA model service (tools/captcha-service.py): a Python venv that
# shares the machine's torch/ultralytics/cv2, plus the two open model weights it loads lazily.
# Everything lands under the gitignored private/. Re-running is safe; downloads resume.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/private/captcha-env"
MODELS="$ROOT/private/models/captcha"
PY="${CAPTCHA_PYTHON:-$(command -v python3.12 || command -v python3)}"
mkdir -p "$MODELS"
[ -x "$VENV/bin/python" ] || "$PY" -m venv --system-site-packages "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
# ddddocr: text OCR + slider matching. faster-whisper: audio fallback when whisper-cli is absent.
"$VENV/bin/python" -m pip install --quiet "ddddocr>=1.5" "faster-whisper>=1.0" "ultralytics>=8.3" "opencv-python-headless" "pillow" "numpy"
# reCAPTCHA tile classifier (DannyLuna/recaptcha-classification-57k, MIT: 13 reCAPTCHA classes + other).
[ -s "$MODELS/recaptcha_cls.pt" ] || curl -fL --retry 3 -C - -o "$MODELS/recaptcha_cls.pt" \
  "https://huggingface.co/DannyLuna/recaptcha-classification-57k/resolve/main/recaptcha_classification_57k_weights.pt"
# COCO instance segmentation (Ultralytics YOLO11m-seg, AGPL-3.0) for 4x4 "select all squares with" grids.
[ -s "$MODELS/yolo11m-seg.pt" ] || curl -fL --retry 3 -C - -o "$MODELS/yolo11m-seg.pt" \
  "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11m-seg.pt"
"$VENV/bin/python" - <<'PY'
import importlib
for m in ("ddddocr", "faster_whisper", "ultralytics", "cv2", "numpy", "PIL"):
    try: importlib.import_module(m); print("ok", m)
    except Exception as e: print("MISSING", m, e)
PY
ls -la "$MODELS"
echo "captcha models ready"
# vendor/captcha-solver (the package as supplied) looks for its venv and weights next to itself and
# writes its log, debug shots and domain cooldowns to ../pipeline; point those at private/ and state/.
SOLVER="$ROOT/vendor/captcha-solver"
mkdir -p "$ROOT/state/captcha-vendor"
ln -sfn "$VENV" "$SOLVER/captcha_env"
ln -sfn "$MODELS" "$SOLVER/captcha_models"
ln -sfn "$ROOT/state/captcha-vendor" "$ROOT/vendor/pipeline"
echo "vendor solver linked"
