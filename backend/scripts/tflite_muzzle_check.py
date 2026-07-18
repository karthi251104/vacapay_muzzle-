import argparse
import base64
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

MODEL_INPUT_SIZE = 640
MIN_GOOD_CONFIDENCE = 0.50
MIN_BAD_CONFIDENCE = 0.45
BAD_DOMINANCE_MARGIN = 0.12
MIN_SHARPNESS_SCORE = 18
CLASS_NAMES = ["bad muzzle", "goodmuzzle"]


def load_interpreter(model_path: Path):
    try:
        from ai_edge_litert.interpreter import Interpreter
    except ModuleNotFoundError:
        try:
            from tflite_runtime.interpreter import Interpreter
        except ModuleNotFoundError:
            try:
                from tensorflow.lite.python.interpreter import Interpreter
            except ModuleNotFoundError as exc:
                raise RuntimeError(
                    "Backend TFLite runtime is not installed. Install ai-edge-litert, "
                    "tflite-runtime or tensorflow-cpu, or keep using phone fallback."
                ) from exc
    interpreter = Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    return interpreter


def letterbox(image):
    h, w = image.shape[:2]
    scale = min(MODEL_INPUT_SIZE / w, MODEL_INPUT_SIZE / h)
    new_w = int(round(w * scale))
    new_h = int(round(h * scale))
    pad_x = int(round((MODEL_INPUT_SIZE - new_w) / 2))
    pad_y = int(round((MODEL_INPUT_SIZE - new_h) / 2))
    canvas = np.full((MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, 3), 114, dtype=np.uint8)
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized
    return canvas, scale, pad_x, pad_y


def prepare_input(interpreter, image):
    input_info = interpreter.get_input_details()[0]
    shape = list(input_info["shape"])
    tensor = image.astype(np.float32) / 255.0
    if len(shape) == 4 and shape[1] == 3:
        tensor = np.transpose(tensor, (2, 0, 1))[None, ...]
    else:
        tensor = tensor[None, ...]
    if input_info["dtype"] != np.float32:
        scale, zero_point = input_info.get("quantization", (0, 0))
        if scale:
            tensor = tensor / scale + zero_point
        tensor = tensor.astype(input_info["dtype"])
    return input_info["index"], tensor


def best_candidates(output, source_w, source_h, scale, pad_x, pad_y):
    arr = np.array(output)
    arr = np.squeeze(arr)
    best_good = None
    best_bad = None

    def keep(candidate):
        nonlocal best_good, best_bad
        if not candidate:
            return
        threshold = MIN_BAD_CONFIDENCE if candidate["className"] == "bad muzzle" else MIN_GOOD_CONFIDENCE
        if candidate["confidence"] < threshold:
            return
        if candidate["className"] == "goodmuzzle":
            if best_good is None or candidate["confidence"] > best_good["confidence"]:
                best_good = candidate
        else:
            if best_bad is None or candidate["confidence"] > best_bad["confidence"]:
                best_bad = candidate

    if arr.ndim == 2 and arr.shape[0] >= 6 and arr.shape[1] > arr.shape[0]:
        channels, anchors = arr.shape
        for anchor in range(anchors):
            keep(channel_first_candidate(arr, channels, anchors, anchor, source_w, source_h, scale, pad_x, pad_y))
    else:
        rows = arr.reshape(-1, arr.shape[-1] if arr.ndim >= 2 else 6)
        for row in rows:
            if len(row) >= 6:
                keep(row_candidate(row, source_w, source_h, scale, pad_x, pad_y))

    return [c for c in [best_good, best_bad] if c]


def channel_first_candidate(data, channels, anchors, anchor, source_w, source_h, scale, pad_x, pad_y):
    cx = float(data[0, anchor])
    cy = float(data[1, anchor])
    width = float(data[2, anchor])
    height = float(data[3, anchor])
    has_objectness = channels > 6
    objectness = float(data[4, anchor]) if has_objectness else 1.0
    class_start = 5 if has_objectness else 4
    class_scores = data[class_start:, anchor]
    class_id = int(np.argmax(class_scores))
    best_class_score = float(class_scores[class_id])
    return candidate_from_values(cx, cy, width, height, objectness, best_class_score, class_id, source_w, source_h, scale, pad_x, pad_y)


def row_candidate(row, source_w, source_h, scale, pad_x, pad_y):
    cx, cy, width, height = map(float, row[:4])
    has_objectness = len(row) > 6
    objectness = float(row[4]) if has_objectness else 1.0
    class_start = 5 if has_objectness else 4
    class_scores = row[class_start:]
    class_id = int(np.argmax(class_scores))
    best_class_score = float(class_scores[class_id])
    return candidate_from_values(cx, cy, width, height, objectness, best_class_score, class_id, source_w, source_h, scale, pad_x, pad_y)


def candidate_from_values(cx, cy, width, height, objectness, class_score, class_id, source_w, source_h, scale, pad_x, pad_y):
    if max(cx, cy, width, height) <= 1.5:
        cx *= MODEL_INPUT_SIZE
        cy *= MODEL_INPUT_SIZE
        width *= MODEL_INPUT_SIZE
        height *= MODEL_INPUT_SIZE
    if class_id < 0 or class_id >= len(CLASS_NAMES):
        return None
    confidence = float(objectness * class_score)
    if not math.isfinite(confidence) or confidence <= 0:
        return None
    x1 = max(0, ((cx - width / 2) - pad_x) / scale)
    y1 = max(0, ((cy - height / 2) - pad_y) / scale)
    x2 = min(source_w, ((cx + width / 2) - pad_x) / scale)
    y2 = min(source_h, ((cy + height / 2) - pad_y) / scale)
    if x2 <= x1 or y2 <= y1:
        return None
    return {
        "className": CLASS_NAMES[class_id],
        "classId": class_id,
        "confidence": confidence,
        "bbox": [x1, y1, x2, y2],
    }


def select_best(candidates):
    good = next((c for c in candidates if c["className"] == "goodmuzzle"), None)
    bad = next((c for c in candidates if c["className"] == "bad muzzle"), None)
    if good and good["confidence"] >= MIN_GOOD_CONFIDENCE:
        if bad and bad["confidence"] >= good["confidence"] + BAD_DOMINANCE_MARGIN:
            return bad
        return good
    return bad or good


def sharpness(image, bbox):
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    crop = image[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
    if crop.size == 0:
        return 0.0
    sample = cv2.resize(crop, (96, 96), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(sample, cv2.COLOR_BGR2GRAY)
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    return float(np.mean(np.abs(gx)) + np.mean(np.abs(gy))) / 2.0


def crop_clahe_jpeg(image, bbox):
    x1, y1, x2, y2 = [int(round(v)) for v in bbox]
    crop = image[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
    if crop.size == 0:
        raise RuntimeError("Could not crop muzzle.")
    h, w = crop.shape[:2]
    scale = min(1.0, 640 / max(w, h))
    if scale < 1:
        crop = cv2.resize(crop, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
    lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(4, 4))
    l = clahe.apply(l)
    crop = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)
    ok, encoded = cv2.imencode('.jpg', crop, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise RuntimeError("Could not encode cropped muzzle.")
    return base64.b64encode(encoded.tobytes()).decode('ascii')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--input', required=True)
    args = parser.parse_args()
    model_path = Path(args.model)
    input_path = Path(args.input)
    if not model_path.exists():
        raise RuntimeError(f"Backend muzzle model not found: {model_path}")
    image = cv2.imread(str(input_path))
    if image is None:
        raise RuntimeError("Could not read image.")
    source_h, source_w = image.shape[:2]
    letterboxed, scale, pad_x, pad_y = letterbox(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    interpreter = load_interpreter(model_path)
    input_index, tensor = prepare_input(interpreter, letterboxed)
    interpreter.set_tensor(input_index, tensor)
    interpreter.invoke()
    outputs = [interpreter.get_tensor(item['index']) for item in interpreter.get_output_details()]
    candidates = []
    for output in outputs:
        candidates.extend(best_candidates(output, source_w, source_h, scale, pad_x, pad_y))
    best = select_best(candidates)
    if not best:
        print(json.dumps({"accepted": False, "reason": "No muzzle box found.", "confidence": 0, "className": "none", "bbox": None, "imageSize": [source_w, source_h]}))
        return
    if best["className"] != "goodmuzzle":
        print(json.dumps({"accepted": False, "reason": f"Bad muzzle rejected ({round(best['confidence'] * 100)}%).", **best, "imageSize": [source_w, source_h]}))
        return
    crop_quality = sharpness(image, best["bbox"])
    if best["confidence"] < MIN_GOOD_CONFIDENCE:
        print(json.dumps({"accepted": False, "reason": f"Good muzzle confidence too low ({round(best['confidence'] * 100)}%).", **best, "sharpness": round(crop_quality), "imageSize": [source_w, source_h]}))
        return
    if crop_quality < MIN_SHARPNESS_SCORE:
        print(json.dumps({"accepted": False, "reason": f"Image is blurry ({round(crop_quality)} sharpness).", **best, "sharpness": round(crop_quality), "imageSize": [source_w, source_h]}))
        return
    crop_b64 = crop_clahe_jpeg(image, best["bbox"])
    print(json.dumps({"accepted": True, "reason": "Good muzzle accepted.", **best, "sharpness": round(crop_quality), "imageSize": [source_w, source_h], "cropBase64": crop_b64, "source": "backend_tflite"}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({"accepted": False, "backendUnavailable": True, "error": str(exc)}))
        sys.exit(0)
