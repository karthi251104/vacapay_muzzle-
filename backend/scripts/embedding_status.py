import argparse
import json
import os
from pathlib import Path

workspace_data = Path(__file__).resolve().parents[2] / "data"
runtime_dir = workspace_data / "embedding_runtime"
os.environ.setdefault("TORCH_HOME", str(runtime_dir / "torch"))
os.environ.setdefault("MPLCONFIGDIR", str(workspace_data / "matplotlib"))


def checkpoint_embedding_dim(config, default):
    cfg = config or {}
    return int(cfg.get("emb_dim", cfg.get("embedding_dim", cfg.get("output_dim", default))))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--threshold", type=float, default=0.70)
    args = parser.parse_args()

    import torch

    weights = Path(args.weights)
    if not weights.exists():
        print(json.dumps({
            "ok": False,
            "modelPath": str(weights),
            "threshold": args.threshold,
            "error": "DINOv2 weights file not found."
        }))
        return

    checkpoint = torch.load(weights, map_location="cpu")
    config = checkpoint.get("config") if isinstance(checkpoint, dict) else None
    state_keys = []
    if isinstance(checkpoint, dict):
        if "model_state" in checkpoint and hasattr(checkpoint["model_state"], "keys"):
            state_keys = list(checkpoint["model_state"].keys())
        elif "model_state_dict" in checkpoint and hasattr(checkpoint["model_state_dict"], "keys"):
            state_keys = list(checkpoint["model_state_dict"].keys())
        else:
            state_keys = list(checkpoint.keys())

    print(json.dumps({
        "ok": True,
        "modelPath": str(weights),
        "threshold": args.threshold,
        "thresholdPercent": int(args.threshold * 100),
        "embeddingDim": checkpoint_embedding_dim(config, 256),
        "hasConfig": config is not None,
        "stateKeyCount": len(state_keys),
        "torchVersion": torch.__version__
    }))


if __name__ == "__main__":
    main()
