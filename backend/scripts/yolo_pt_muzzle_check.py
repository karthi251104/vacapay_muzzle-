import argparse
import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np

MODEL_INPUT_SIZE = 704
def normalize_name(name):
    return str(name or '').strip().lower().replace('_', ' ').replace('-', ' ')


def class_kind(name):
    value = normalize_name(name)
    if 'bad' in value:
        return 'bad'
    if 'good' in value:
        return 'good'
    if 'wet' in value:
        return 'wet'
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


def detect_candidates(model, image):
    results = model.predict(image, imgsz=MODEL_INPUT_SIZE, conf=0.20, verbose=False)
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


def select_best(candidates, min_good_confidence, min_bad_confidence, min_wet_confidence, bad_dominance_margin):
    good = None
    bad = None
    wet = None
    for candidate in candidates:
        if candidate['kind'] == 'good' and candidate['confidence'] >= min_good_confidence:
            if good is None or candidate['confidence'] > good['confidence']:
                good = candidate
        elif candidate['kind'] == 'bad' and candidate['confidence'] >= min_bad_confidence:
            if bad is None or candidate['confidence'] > bad['confidence']:
                bad = candidate
        elif candidate['kind'] == 'wet' and candidate['confidence'] >= min_wet_confidence:
            if wet is None or candidate['confidence'] > wet['confidence']:
                wet = candidate
    rejects = [candidate for candidate in (bad, wet) if candidate is not None]
    strongest_reject = max(rejects, key=lambda value: value['confidence'], default=None)
    if good:
        if strongest_reject and strongest_reject['confidence'] >= good['confidence'] + bad_dominance_margin:
            return strongest_reject
        return good
    return strongest_reject or good


def public_candidate(candidate):
    value = dict(candidate)
    value.pop('kind', None)
    return value


def analyze_image(
    model,
    image,
    min_good_confidence=0.90,
    min_bad_confidence=0.25,
    min_wet_confidence=0.25,
    bad_dominance_margin=0.12,
    min_sharpness=14,
    include_crop=True,
):
    if image is None:
        raise RuntimeError('Could not read image.')

    source_h, source_w = image.shape[:2]
    candidates = detect_candidates(model, image)
    usable_good = sorted(
        (candidate for candidate in candidates
         if candidate['kind'] == 'good' and candidate['confidence'] >= min_good_confidence),
        key=lambda candidate: candidate['confidence'],
        reverse=True,
    )
    usable_bad = sorted(
        (candidate for candidate in candidates
         if candidate['kind'] == 'bad' and candidate['confidence'] >= min_bad_confidence),
        key=lambda candidate: candidate['confidence'],
        reverse=True,
    )
    usable_wet = sorted(
        (candidate for candidate in candidates
         if candidate['kind'] == 'wet' and candidate['confidence'] >= min_wet_confidence),
        key=lambda candidate: candidate['confidence'],
        reverse=True,
    )
    best_good = max(
        (candidate for candidate in candidates if candidate['kind'] == 'good'),
        key=lambda candidate: candidate['confidence'],
        default=None,
    )

    # Match the reference capture contract: wet is always unsafe, and a frame
    # containing multiple usable muzzles must never auto-capture.
    if usable_wet:
        best = usable_wet[0]
    elif len(usable_good) > 1:
        best = usable_good[0]
        return {
            'accepted': False,
            'reason': 'Multiple usable muzzle boxes detected.',
            **public_candidate(best),
            'className': 'multiple_muzzles',
            'imageSize': [source_w, source_h],
            'source': 'backend_yolo_pt',
        }
    elif not usable_good:
        if usable_bad:
            best = usable_bad[0]
        elif best_good:
            return {
                'accepted': False,
                'reason': f"Good muzzle confidence too low ({round(best_good['confidence'] * 100)}%).",
                **public_candidate(best_good),
                'imageSize': [source_w, source_h],
                'source': 'backend_yolo_pt',
            }
        else:
            best = None
    else:
        best = usable_good[0]
        if usable_bad and best['confidence'] - usable_bad[0]['confidence'] < bad_dominance_margin:
            return {
                'accepted': False,
                'reason': (
                    f"Uncertain muzzle: good {round(best['confidence'] * 100)}%, "
                    f"bad {round(usable_bad[0]['confidence'] * 100)}%."
                ),
                **public_candidate(best),
                'className': 'uncertain',
                'imageSize': [source_w, source_h],
                'source': 'backend_yolo_pt',
            }
    if not best:
        return {
            'accepted': False,
            'reason': 'No good muzzle box found.',
            'confidence': 0,
            'className': 'none',
            'bbox': None,
            'imageSize': [source_w, source_h],
            'source': 'backend_yolo_pt',
        }

    best_public = public_candidate(best)
    if best['kind'] != 'good':
        label = 'Wet muzzle' if best['kind'] == 'wet' else 'Bad muzzle'
        return {
            'accepted': False,
            'reason': f"{label} rejected ({round(best['confidence'] * 100)}%).",
            **best_public,
            'imageSize': [source_w, source_h],
            'source': 'backend_yolo_pt',
        }

    crop_quality = sharpness(image, best['bbox'])
    if min_sharpness > 0 and crop_quality < min_sharpness:
        return {
            'accepted': False,
            'reason': f'Image is blurry ({round(crop_quality)} sharpness).',
            **best_public,
            'sharpness': round(crop_quality),
            'imageSize': [source_w, source_h],
            'source': 'backend_yolo_pt',
        }

    result = {
        'accepted': True,
        'reason': 'Good muzzle accepted.',
        **best_public,
        'sharpness': round(crop_quality),
        'imageSize': [source_w, source_h],
        'source': 'backend_yolo_pt',
    }
    if include_crop:
        result['cropBase64'] = crop_clahe_jpeg(image, best['bbox'])
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--good-conf', type=float, default=0.90)
    parser.add_argument('--bad-conf', type=float, default=0.25)
    parser.add_argument('--wet-conf', type=float, default=0.25)
    parser.add_argument('--bad-margin', type=float, default=0.12)
    parser.add_argument('--min-sharpness', type=float, default=14)
    args = parser.parse_args()

    model_path = Path(args.model)
    input_path = Path(args.input)
    if not model_path.exists():
        raise RuntimeError(f'Backend YOLO model not found: {model_path}')
    image = cv2.imread(str(input_path))
    if image is None:
        raise RuntimeError('Could not read image.')
    model = load_model(model_path)
    print(json.dumps(analyze_image(
        model,
        image,
        args.good_conf,
        args.bad_conf,
        args.wet_conf,
        args.bad_margin,
        args.min_sharpness,
    )))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'accepted': False, 'backendUnavailable': True, 'error': str(exc), 'source': 'backend_yolo_pt'}))
        sys.exit(0)
