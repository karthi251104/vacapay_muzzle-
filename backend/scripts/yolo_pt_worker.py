import argparse
import json
import sys
import time

import cv2
import numpy as np

from yolo_pt_muzzle_check import MODEL_INPUT_SIZE, analyze_image, load_model


def write(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    args = parser.parse_args()

    model = load_model(args.model)
    model.predict(
        np.zeros((MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, 3), dtype=np.uint8),
        imgsz=MODEL_INPUT_SIZE,
        conf=0.20,
        verbose=False,
    )
    write({'type': 'ready'})

    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            request_id = request.get('requestId')
            image = cv2.imread(str(request['input']))
            started_at = time.perf_counter()
            result = analyze_image(
                model,
                image,
                float(request.get('goodConfidence', 0.55)),
                float(request.get('badConfidence', 0.35)),
                float(request.get('wetConfidence', 0.35)),
                float(request.get('badDominanceMargin', 0.05)),
                float(request.get('minSharpness', 14)),
            )
            result['inferenceMs'] = round((time.perf_counter() - started_at) * 1000)
            write({'requestId': request_id, 'result': result})
        except Exception as exc:
            write({
                'requestId': request.get('requestId') if 'request' in locals() else None,
                'error': str(exc),
            })


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        write({'type': 'startup_error', 'error': str(exc)})
        sys.exit(1)
