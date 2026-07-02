import argparse
import json
import os
from pathlib import Path

workspace_data = Path(__file__).resolve().parents[2] / "data"
os.environ.setdefault("YOLO_CONFIG_DIR", str(workspace_data / "ultralytics"))
os.environ.setdefault("MPLCONFIGDIR", str(workspace_data / "matplotlib"))

import cv2
import numpy as np

YOLO_IMPORT_ERROR = None
try:
    from ultralytics import YOLO
except Exception as error:  # pragma: no cover - depends on local ML runtime DLLs
    YOLO = None
    YOLO_IMPORT_ERROR = str(error)


MAX_WIDTH = 1024
MAX_HEIGHT = 768


def resize_inside(image):
    height, width = image.shape[:2]
    scale = min(MAX_WIDTH / width, MAX_HEIGHT / height, 1.0)
    if scale >= 1.0:
        return image

    next_size = (int(width * scale), int(height * scale))
    return cv2.resize(image, next_size, interpolation=cv2.INTER_AREA)


def apply_clahe(image):
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced_l = clahe.apply(l_channel)
    merged = cv2.merge((enhanced_l, a_channel, b_channel))
    return cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)


def padded_box(box, width, height, padding_ratio=0.08):
    x1, y1, x2, y2 = box
    box_w = x2 - x1
    box_h = y2 - y1
    pad_x = box_w * padding_ratio
    pad_y = box_h * padding_ratio
    return [
        max(0, int(x1 - pad_x)),
        max(0, int(y1 - pad_y)),
        min(width, int(x2 + pad_x)),
        min(height, int(y2 + pad_y)),
    ]


def center_crop_box(width, height):
    crop_w = int(width * 0.72)
    crop_h = int(height * 0.72)
    x1 = max(0, (width - crop_w) // 2)
    y1 = max(0, (height - crop_h) // 2)
    return [x1, y1, min(width, x1 + crop_w), min(height, y1 + crop_h)]


def save_crop(image, box, output_dir, output_name):
    x1, y1, x2, y2 = box
    crop = image[y1:y2, x1:x2]
    if crop.size == 0:
        return None

    enhanced = apply_clahe(crop)
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    output_path = os.path.join(output_dir, output_name)
    cv2.imwrite(output_path, enhanced, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    return output_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--output-name", required=True)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--conf", type=float, default=0.55)
    args = parser.parse_args()

    image = cv2.imread(args.input)
    if image is None:
        print(json.dumps({"detected": False, "reason": "image_read_failed"}))
        return

    image = resize_inside(image)
    height, width = image.shape[:2]

    if YOLO is None:
        box = center_crop_box(width, height)
        output_path = save_crop(image, box, args.output_dir, args.output_name)
        if not output_path:
            print(json.dumps({"detected": False, "reason": "empty_fallback_crop", "imageSize": [width, height]}))
            return

        print(
            json.dumps(
                {
                    "detected": True,
                    "confidence": 0.0,
                    "bbox": box,
                    "imageSize": [width, height],
                    "outputPath": output_path,
                    "claheApplied": True,
                    "imgsz": args.imgsz,
                    "fallbackCrop": True,
                    "fallbackReason": f"YOLO unavailable: {YOLO_IMPORT_ERROR}",
                }
            )
        )
        return

    model = YOLO(args.model)
    results = model.predict(image, imgsz=args.imgsz, conf=args.conf, verbose=False)
    boxes = results[0].boxes if results and results[0].boxes is not None else None

    if boxes is None or len(boxes) == 0:
        print(json.dumps({"detected": False, "reason": "no_muzzle_box", "imageSize": [width, height]}))
        return

    confidences = boxes.conf.detach().cpu().numpy()
    best_index = int(np.argmax(confidences))
    confidence = float(confidences[best_index])
    xyxy = boxes.xyxy[best_index].detach().cpu().numpy().tolist()
    x1, y1, x2, y2 = padded_box(xyxy, width, height)

    output_path = save_crop(image, [x1, y1, x2, y2], args.output_dir, args.output_name)
    if not output_path:
        print(json.dumps({"detected": False, "reason": "empty_crop", "confidence": confidence}))
        return

    print(
        json.dumps(
            {
                "detected": True,
                "confidence": confidence,
                "bbox": [x1, y1, x2, y2],
                "imageSize": [width, height],
                "outputPath": output_path,
                "claheApplied": True,
                "imgsz": args.imgsz,
            }
        )
    )


if __name__ == "__main__":
    main()
