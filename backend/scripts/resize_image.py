import argparse
import json
from pathlib import Path

import cv2


MAX_WIDTH = 1024
MAX_HEIGHT = 768


def resize_inside(image):
    height, width = image.shape[:2]
    scale = min(MAX_WIDTH / width, MAX_HEIGHT / height, 1.0)
    if scale >= 1.0:
        return image

    next_size = (int(width * scale), int(height * scale))
    return cv2.resize(image, next_size, interpolation=cv2.INTER_AREA)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    image = cv2.imread(args.input)
    if image is None:
        raise RuntimeError("image_read_failed")

    resized = resize_inside(image)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(args.output, resized, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    height, width = resized.shape[:2]
    print(json.dumps({"saved": True, "imageSize": [width, height]}))


if __name__ == "__main__":
    main()
