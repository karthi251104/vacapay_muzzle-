#!/usr/bin/env python3
"""DINOv2 Top-5 + vision-LLM muzzle verification experiment.

Workflow:
1. Embed images from a class-folder test dataset with the existing DINOv2 model.
2. For each query image, rank cattle classes and keep one best image per class.
3. Build a labelled collage: Query + Top1..Top5.
4. Optionally send the collage to Gemini for visual verification and box coordinates.
5. Plot returned boxes on the collage.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_SCRIPTS = REPO_ROOT / "backend" / "scripts"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


@dataclass(frozen=True)
class ImageItem:
    class_id: str
    path: Path


@dataclass
class Candidate:
    rank: int
    class_id: str
    image_path: Path
    score: float
    correct: bool


def load_manifest(test_dir: Path) -> dict[str, dict[str, str]]:
    manifest_path = test_dir / "manifest.csv"
    if not manifest_path.exists():
        return {}
    with manifest_path.open("r", encoding="utf-8-sig", newline="") as handle:
        return {row["class_id"]: row for row in csv.DictReader(handle) if row.get("class_id")}


def discover_images(test_dir: Path, max_images_per_class: int | None = None) -> list[ImageItem]:
    items: list[ImageItem] = []
    for class_dir in sorted(path for path in test_dir.iterdir() if path.is_dir()):
        images = sorted(path for path in class_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)
        if max_images_per_class:
            images = images[:max_images_per_class]
        items.extend(ImageItem(class_id=class_dir.name, path=path) for path in images)
    return items


def cache_key(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/")


def load_embedding_cache(cache_path: Path) -> dict[str, np.ndarray]:
    if not cache_path.exists():
        return {}
    data = np.load(cache_path, allow_pickle=False)
    return {key: data[key].astype(np.float32) for key in data.files}


def save_embedding_cache(cache_path: Path, cache: dict[str, np.ndarray]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path, **cache)


def embed_dataset(items: list[ImageItem], weights: Path, device_name: str, cache_path: Path) -> dict[str, np.ndarray]:
    cache = load_embedding_cache(cache_path)
    missing = [item for item in items if cache_key(item.path) not in cache]
    if not missing:
        return cache

    if str(BACKEND_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(BACKEND_SCRIPTS))
    try:
        import embedding_average as dinov2
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "DINOv2 embedding needs backend Python dependencies such as cv2, torch and torchvision. "
            "Use the model testing Python environment. Missing module: " + str(error.name)
        ) from error

    device = dinov2.choose_device(device_name)
    model, _config = dinov2.load_model(weights, device)
    transform = dinov2.build_transform()

    for index, item in enumerate(missing, start=1):
        key = cache_key(item.path)
        cache[key] = dinov2.embed_image(model, item.path, transform, device)
        if index % 25 == 0 or index == len(missing):
            print(f"embedded {index}/{len(missing)} new images", flush=True)
            save_embedding_cache(cache_path, cache)

    save_embedding_cache(cache_path, cache)
    return cache


def top5_by_class(query: ImageItem, items: list[ImageItem], embeddings: dict[str, np.ndarray]) -> list[Candidate]:
    query_vec = embeddings[cache_key(query.path)]
    best_by_class: dict[str, tuple[float, ImageItem]] = {}

    for item in items:
        if item.path == query.path:
            continue
        score = float(np.dot(query_vec, embeddings[cache_key(item.path)]))
        previous = best_by_class.get(item.class_id)
        if previous is None or score > previous[0]:
            best_by_class[item.class_id] = (score, item)

    ranked = sorted(best_by_class.items(), key=lambda entry: entry[1][0], reverse=True)[:5]
    return [
        Candidate(
            rank=index,
            class_id=class_id,
            image_path=item.path,
            score=score,
            correct=class_id == query.class_id,
        )
        for index, (class_id, (score, item)) in enumerate(ranked, start=1)
    ]


def load_font(size: int) -> ImageFont.ImageFont:
    for font_name in ["arial.ttf", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(font_name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_tile(image_path: Path, label: str, tile_size: int, label_height: int) -> Image.Image:
    image = Image.open(image_path).convert("RGB")
    image.thumbnail((tile_size, tile_size), Image.Resampling.LANCZOS)
    tile = Image.new("RGB", (tile_size, tile_size + label_height), "white")
    x = (tile_size - image.width) // 2
    y = label_height + (tile_size - image.height) // 2
    tile.paste(image, (x, y))

    draw = ImageDraw.Draw(tile)
    draw.rectangle([0, 0, tile_size, label_height], fill=(20, 32, 44))
    draw.text((8, 7), label, fill="white", font=load_font(18))
    return tile


def make_collage(query: ImageItem, candidates: list[Candidate], output_path: Path, tile_size: int = 280) -> dict[str, Any]:
    label_height = 36
    gap = 12
    labels = [("query", "Query muzzle", query.path)] + [
        (f"top{candidate.rank}", f"Top{candidate.rank}: {candidate.class_id} {candidate.score:.3f}", candidate.image_path)
        for candidate in candidates
    ]
    cols = 3
    rows = 2
    tile_w = tile_size
    tile_h = tile_size + label_height
    width = cols * tile_w + (cols + 1) * gap
    height = rows * tile_h + (rows + 1) * gap
    collage = Image.new("RGB", (width, height), (235, 238, 241))
    layout: dict[str, Any] = {"width": width, "height": height, "tiles": {}}

    for index, (key, label, image_path) in enumerate(labels):
        row = index // cols
        col = index % cols
        x = gap + col * (tile_w + gap)
        y = gap + row * (tile_h + gap)
        collage.paste(make_tile(image_path, label, tile_size, label_height), (x, y))
        layout["tiles"][key] = {"x": x, "y": y, "width": tile_w, "height": tile_h, "imagePath": str(image_path)}

    output_path.parent.mkdir(parents=True, exist_ok=True)
    collage.save(output_path, quality=95)
    return layout


def gemini_prompt() -> str:
    return """
You are verifying cattle muzzle identity from a labelled collage.
The collage has six labelled tiles: Query muzzle, Top1 muzzle, Top2 muzzle, Top3 muzzle, Top4 muzzle, Top5 muzzle.
Choose which Top1..Top5 muzzle looks most visually similar to the Query muzzle.
Focus on muzzle ridge texture, pore pattern, ridge spacing, and distinctive dark/light pattern areas.
Return STRICT JSON only, no markdown:
{
  "selected_rank": 1,
  "selected_label": "top1",
  "confidence": 0.0,
  "reason": "short visual reason",
  "matching_boxes": [
    {"label": "query", "box": [x, y, width, height], "pattern": "what matches"},
    {"label": "top1", "box": [x, y, width, height], "pattern": "what matches"}
  ]
}
All box coordinates must be in absolute pixel coordinates relative to the full collage image width and height.
""".strip()


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            raise
        return json.loads(match.group(0))


def ask_gemini(collage_path: Path, model: str) -> dict[str, Any]:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set. Put the key in environment variables, not in source code.")

    image_bytes = collage_path.read_bytes()
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": gemini_prompt()},
                    {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(image_bytes).decode("ascii")}},
                ],
            }
        ],
        "generationConfig": {"temperature": 0.0, "response_mime_type": "application/json"},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini API failed: HTTP {error.code}: {body}") from error

    text = result["candidates"][0]["content"]["parts"][0].get("text", "")
    parsed = extract_json(text)
    return {"raw": result, "parsed": parsed}


def plot_boxes(collage_path: Path, llm_result: dict[str, Any], output_path: Path) -> None:
    image = Image.open(collage_path).convert("RGB")
    draw = ImageDraw.Draw(image)
    font = load_font(18)
    colors = {"query": (20, 120, 255), "top1": (40, 170, 80), "top2": (40, 170, 80), "top3": (40, 170, 80), "top4": (40, 170, 80), "top5": (40, 170, 80)}

    for item in llm_result.get("matching_boxes", []):
        label = str(item.get("label", "box")).lower()
        box = item.get("box", [])
        if len(box) != 4:
            continue
        x, y, w, h = [int(round(float(value))) for value in box]
        color = colors.get(label, (240, 120, 20))
        draw.rectangle([x, y, x + w, y + h], outline=color, width=4)
        draw.rectangle([x, max(0, y - 24), x + 110, y], fill=color)
        draw.text((x + 4, max(0, y - 22)), label, fill="white", font=font)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, quality=95)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-dir", default=r"F:\muzzle_embedding_dataset_final\muzzle_embedding_dataset_final\test")
    parser.add_argument("--weights", default=str(REPO_ROOT / "backend" / "dinov2_triplet_v2_best.pt"))
    parser.add_argument("--output-dir", default=str(REPO_ROOT / "experiments" / "llm_muzzle_verification" / "results"))
    parser.add_argument("--max-queries", type=int, default=3)
    parser.add_argument("--max-images-per-class", type=int, default=8)
    parser.add_argument("--provider", choices=["none", "gemini"], default="none")
    parser.add_argument("--gemini-model", default="gemini-1.5-flash")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--sleep", type=float, default=1.0, help="Delay between LLM calls.")
    args = parser.parse_args()

    test_dir = Path(args.test_dir)
    weights = Path(args.weights)
    output_dir = Path(args.output_dir)
    cache_path = output_dir / "embedding_cache.npz"

    if not test_dir.exists():
        raise SystemExit(f"Test folder not found: {test_dir}")
    if not weights.exists():
        raise SystemExit(f"DINOv2 weights not found: {weights}")

    manifest = load_manifest(test_dir)
    items = discover_images(test_dir, args.max_images_per_class)
    if len({item.class_id for item in items}) < 6:
        raise SystemExit("Need at least 6 cattle classes to build Query + Top5 experiment.")

    print(f"classes: {len({item.class_id for item in items})}, images used: {len(items)}")
    embeddings = embed_dataset(items, weights, args.device, cache_path)

    queries: list[ImageItem] = []
    seen_classes: set[str] = set()
    for item in items:
        if item.class_id in seen_classes:
            continue
        seen_classes.add(item.class_id)
        queries.append(item)
        if len(queries) >= args.max_queries:
            break

    summary: list[dict[str, Any]] = []
    for index, query in enumerate(queries, start=1):
        candidates = top5_by_class(query, items, embeddings)
        query_dir = output_dir / f"query_{index:03d}_{query.class_id}_{query.path.stem}"
        collage_path = query_dir / "collage.jpg"
        boxed_path = query_dir / "collage_with_boxes.jpg"
        layout = make_collage(query, candidates, collage_path)

        record: dict[str, Any] = {
            "query": {"classId": query.class_id, "imagePath": str(query.path), "manifest": manifest.get(query.class_id, {})},
            "collagePath": str(collage_path),
            "layout": layout,
            "top5": [
                {
                    "rank": candidate.rank,
                    "classId": candidate.class_id,
                    "imagePath": str(candidate.image_path),
                    "score": candidate.score,
                    "correct": candidate.correct,
                    "manifest": manifest.get(candidate.class_id, {}),
                }
                for candidate in candidates
            ],
        }

        if args.provider == "gemini":
            gemini = ask_gemini(collage_path, args.gemini_model)
            record["llm"] = gemini["parsed"]
            write_json(query_dir / "gemini_raw.json", gemini["raw"])
            plot_boxes(collage_path, gemini["parsed"], boxed_path)
            record["boxedCollagePath"] = str(boxed_path)
            time.sleep(args.sleep)

        write_json(query_dir / "result.json", record)
        summary.append(record)
        print(f"query {index}: {query.class_id} -> top1 {candidates[0].class_id} ({candidates[0].score:.4f}) collage={collage_path}")

    write_json(output_dir / "summary.json", {"testDir": str(test_dir), "provider": args.provider, "results": summary})
    print(f"saved summary: {output_dir / 'summary.json'}")


if __name__ == "__main__":
    main()

