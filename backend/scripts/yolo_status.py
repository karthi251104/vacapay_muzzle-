import argparse
import json
import os
from pathlib import Path

workspace_data = Path(__file__).resolve().parents[2] / "data"
os.environ.setdefault("YOLO_CONFIG_DIR", str(workspace_data / "ultralytics"))
os.environ.setdefault("MPLCONFIGDIR", str(workspace_data / "matplotlib"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    import cv2
    try:
        from ultralytics import YOLO
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "modelPath": args.model,
                    "opencvVersion": cv2.__version__,
                    "fallbackCropAvailable": True,
                    "error": f"YOLO unavailable: {error}",
                }
            )
        )
        return

    model = YOLO(args.model)
    print(
        json.dumps(
            {
                "ok": True,
                "modelPath": args.model,
                "task": model.task,
                "opencvVersion": cv2.__version__,
            }
        )
    )


if __name__ == "__main__":
    main()
