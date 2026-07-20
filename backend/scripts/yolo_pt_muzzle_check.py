import argparse
import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np

MODEL_INPUT_SIZE = 640
MIN_GOOD_CONFIDENCE = 0.50
MIN_BAD_CONFIDENCE = 0.45
BAD_DOMINANCE_MARGIN = 0.12
MIN_SHARPNESS_SCORE = 18


def normalize_name(name):
    return str(name or '').strip().lower().replace('_', ' ').replace('-', ' ')


def class_kind(name):
    value = normalize_name(name)
    if 'bad' in value:
        return 'bad'
    if 'good' in value:
        return 'good'
    return 'unknown'


def load_model(model_path):
    try:
        from ultralytics import YOLO
    except ModuleNotFoundError as exc:
        raise RuntimeError('Backend YOLO runtime is not installed. Install ultralytics in the backend Python environment.') from exc
    return YOLO(str(model_path))


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
        raise RuntimeError('Could not crop muzzle.')
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
        raise RuntimeError('Could not encode cropped muzzle.')
    return base64.b64encode(encoded.tobytes()).decode('ascii')


def detect_candidates(model, image_path):
    results = model.predict(str(image_path), imgsz=MODEL_INPUT_SIZE, conf=0.20, verbose=False)
    if not results:
        return []
    result = results[0]
    names = getattr(result, 'names', None) or getattr(model, 'names', {}) or {}
    boxes = getattr(result, 'boxes', None)
    if boxes is None or len(boxes) == 0:
        return []
    candidates = []
    xyxy = boxes.xyxy.cpu().numpy()
    confs = boxes.conf.cpu().numpy()
    classes = boxes.cls.cpu().numpy().astype(int)
    for bbox, confidence, class_id in zip(xyxy, confs, classes):
        class_name = names.get(int(class_id), str(class_id)) if isinstance(names, dict) else str(class_id)
        kind = class_kind(class_name)
        candidates.append({
            'className': str(class_name),
            'classId': int(class_id),
            'confidence': float(confidence),
            'bbox': [float(v) for v in bbox],
            'kind': kind,
        })
    return candidates


def select_best(candidates):
    good = None
    bad = None
    for candidate in candidates:
        if candidate['kind'] == 'good' and candidate['confidence'] >= MIN_GOOD_CONFIDENCE:
            if good is None or candidate['confidence'] > good['confidence']:
                good = candidate
        elif candidate['kind'] == 'bad' and candidate['confidence'] >= MIN_BAD_CONFIDENCE:
            if bad is None or candidate['confidence'] > bad['confidence']:
                bad = candidate
    if good:
        if bad and bad['confidence'] >= good['confidence'] + BAD_DOMINANCE_MARGIN:
            return bad
        return good
    return bad or good


def public_candidate(candidate):
    value = dict(candidate)
    value.pop('kind', None)
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--input', required=True)
    args = parser.parse_args()

    model_path = Path(args.model)
    input_path = Path(args.input)
    if not model_path.exists():
        raise RuntimeError(f'Backend YOLO model not found: {model_path}')
    image = cv2.imread(str(input_path))
    if image is None:
        raise RuntimeError('Could not read image.')
    source_h, source_w = image.shape[:2]

    model = load_model(model_path)
    candidates = detect_candidates(model, input_path)
    best = select_best(candidates)
    if not best:
        print(json.dumps({
            'accepted': False,
            'reason': 'No good muzzle box found.',
            'confidence': 0,
            'className': 'none',
            'bbox': None,
            'imageSize': [source_w, source_h],
            'source': 'backend_yolo_pt'
        }))
        return

    best_public = public_candidate(best)
    if best['kind'] != 'good':
        print(json.dumps({
            'accepted': False,
            'reason': f"Bad muzzle rejected ({round(best['confidence'] * 100)}%).",
            **best_public,
            'imageSize': [source_w, source_h],
            'source': 'backend_yolo_pt'
        }))
        return

    crop_quality = sharpness(image, best['bbox'])
    if crop_quality < MIN_SHARPNESS_SCORE:
        print(json.dumps({
            'accepted': False,
            'reason': f'Image is blurry ({round(crop_quality)} sharpness).',
            **best_public,
            'sharpness': round(crop_quality),
            'imageSize': [source_w, source_h],
            'source': 'backend_yolo_pt'
        }))
        return

    crop_b64 = crop_clahe_jpeg(image, best['bbox'])
    print(json.dumps({
        'accepted': True,
        'reason': 'Good muzzle accepted.',
        **best_public,
        'sharpness': round(crop_quality),
        'imageSize': [source_w, source_h],
        'cropBase64': crop_b64,
        'source': 'backend_yolo_pt'
    }))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'accepted': False, 'backendUnavailable': True, 'error': str(exc), 'source': 'backend_yolo_pt'}))
        sys.exit(0)
