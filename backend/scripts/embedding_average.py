import argparse
import json
import os
from pathlib import Path
from typing import Any

workspace_data = Path(__file__).resolve().parents[2] / "data"
runtime_dir = workspace_data / "embedding_runtime"
os.environ.setdefault("TORCH_HOME", str(runtime_dir / "torch"))
os.environ.setdefault("YOLO_CONFIG_DIR", str(workspace_data / "ultralytics"))
os.environ.setdefault("MPLCONFIGDIR", str(workspace_data / "matplotlib"))

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torchvision import transforms

torch.hub.set_dir(str(runtime_dir / "torch" / "hub"))


class DINOv2MLPHead(nn.Module):
    def __init__(self, input_dim: int = 768, hidden_dim: int = 512, output_dim: int = 256) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.ReLU(inplace=True),
            nn.Dropout(0.2),
            nn.Linear(hidden_dim, output_dim),
            nn.BatchNorm1d(output_dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.normalize(self.net(x), p=2, dim=1)


class DINOv2FineTuned(nn.Module):
    def __init__(self, backbone: nn.Module, head: nn.Module) -> None:
        super().__init__()
        self.backbone = backbone
        self.head = head

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.backbone(x))


def checkpoint_embedding_dim(config: dict[str, Any] | None, default: int) -> int:
    cfg = config or {}
    return int(cfg.get("emb_dim", cfg.get("embedding_dim", cfg.get("output_dim", default))))


def build_head(config: dict[str, Any] | None) -> nn.Module:
    cfg = config or {}
    input_dim = int(cfg.get("input_dim", 768))
    hidden_dim = int(cfg.get("head_hidden_dim", cfg.get("hidden_dim", 512)))
    output_dim = checkpoint_embedding_dim(cfg, 256)
    return DINOv2MLPHead(input_dim, hidden_dim, output_dim)


def load_model(weights_path: Path, device: torch.device) -> tuple[nn.Module, dict[str, Any] | None]:
    checkpoint = torch.load(weights_path, map_location="cpu")
    config = checkpoint.get("config") if isinstance(checkpoint, dict) else None
    backbone = torch.hub.load("facebookresearch/dinov2", "dinov2_vitb14", pretrained=False)
    model = DINOv2FineTuned(backbone, build_head(config))

    if isinstance(checkpoint, dict) and "model_state" in checkpoint:
        state_dict = checkpoint["model_state"]
    elif isinstance(checkpoint, dict) and "model_state_dict" in checkpoint:
        state_dict = checkpoint["model_state_dict"]
    else:
        state_dict = checkpoint

    model.load_state_dict(state_dict, strict=False)
    return model.to(device).eval(), config


def l2_normalize(vector: np.ndarray) -> np.ndarray:
    vector = vector.astype(np.float32, copy=False)
    return vector / max(float(np.linalg.norm(vector)), 1e-12)


def preprocess_image(image_path: Path) -> Image.Image:
    image_bgr = cv2.imread(str(image_path))
    if image_bgr is None:
        raise ValueError(f"Could not read image: {image_path}")
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    return Image.fromarray(image_rgb)


def build_transform():
    return transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])


@torch.no_grad()
def embed_image(model: nn.Module, image_path: Path, transform, device: torch.device) -> np.ndarray:
    image = preprocess_image(image_path)
    tensor = transform(image).unsqueeze(0).to(device)
    embedding = model(tensor).detach().cpu().numpy()[0]
    return l2_normalize(embedding)


def choose_device(name: str) -> torch.device:
    if name == "cpu":
        return torch.device("cpu")
    if name == "cuda":
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--images", nargs="+", required=True)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    args = parser.parse_args()

    image_paths = [Path(item) for item in args.images]
    missing = [str(item) for item in image_paths if not item.exists()]
    if missing:
        print(json.dumps({"ok": False, "error": "Missing muzzle image files.", "missing": missing}))
        return

    device = choose_device(args.device)
    model, config = load_model(Path(args.weights), device)
    transform = build_transform()
    embeddings = [embed_image(model, image_path, transform, device) for image_path in image_paths]
    average = l2_normalize(np.mean(np.stack(embeddings, axis=0), axis=0))

    print(json.dumps({
        "ok": True,
        "weights": str(args.weights),
        "imageCount": len(image_paths),
        "embeddingDim": checkpoint_embedding_dim(config, len(average)),
        "device": str(device),
        "embedding": average.astype(float).tolist()
    }))


if __name__ == "__main__":
    main()
