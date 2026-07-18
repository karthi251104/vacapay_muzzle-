#!/usr/bin/env python3
from __future__ import annotations

import base64
import html
import json
import os
import random
import re
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


TEST_DIR = Path(r"F:\muzzle_embedding_dataset_final\muzzle_embedding_dataset_final\test")
OUT_DIR = Path(__file__).resolve().parent / "site_gemini_shuffled_top5"
MODELS_TO_TRY = ["gemini-3.5-flash", "gemini-2.5-flash"]
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
RANDOM_SEED = 20260702


def font(size: int) -> ImageFont.ImageFont:
    for name in ("arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def class_images(class_dir: Path, count: int) -> list[Path]:
    images = sorted(path for path in class_dir.iterdir() if path.suffix.lower() in IMAGE_EXTS)
    if len(images) < count:
        raise RuntimeError(f"{class_dir.name} needs at least {count} images")
    return images[:count]


def draw_fit(canvas: Image.Image, path: Path, box: tuple[int, int, int, int], label_height: int = 36) -> dict[str, int]:
    x, y, w, h = box
    image_area_h = h - label_height
    image = Image.open(path).convert("RGB")
    ratio = min(w / image.width, image_area_h / image.height)
    resized = image.resize((int(image.width * ratio), int(image.height * ratio)), Image.Resampling.LANCZOS)
    paste_x = x + (w - resized.width) // 2
    paste_y = y + (image_area_h - resized.height) // 2
    ImageDraw.Draw(canvas).rectangle((x, y, x + w, y + image_area_h), fill=(246, 240, 229))
    canvas.paste(resized, (paste_x, paste_y))
    return {"x": paste_x, "y": paste_y, "width": resized.width, "height": resized.height}


def make_collage(sample: dict[str, Any], collage_path: Path) -> dict[str, Any]:
    width, height = 1300, 760
    canvas = Image.new("RGB", (width, height), (253, 250, 244))
    draw = ImageDraw.Draw(canvas)
    title_font = font(28)
    label_font = font(17)
    small_font = font(14)
    draw.text((34, 24), "Gemini Muzzle Verification - Shuffled Top-5 Classes", fill=(31, 33, 28), font=title_font)
    draw.text((34, 58), "Candidate order is random. Labels show class names only, no Top-1/Top-2 hints.", fill=(91, 84, 72), font=small_font)

    layout = [("query", "QUERY MUZZLE", sample["queryImage"], (34, 100, 430, 300))]
    candidate_boxes = [
        (500, 100, 240, 200),
        (770, 100, 240, 200),
        (1038, 100, 240, 200),
        (500, 350, 240, 200),
        (770, 350, 240, 200),
    ]
    for candidate, box in zip(sample["candidates"], candidate_boxes):
        layout.append((candidate["slotId"], candidate["classId"], candidate["imagePath"], box))

    tile_map: dict[str, Any] = {"width": width, "height": height, "tiles": {}}
    for key, label, path, box in layout:
        x, y, w, h = box
        visible_image = draw_fit(canvas, Path(path), box)
        draw.rectangle((x, y + h - 36, x + w, y + h), fill=(31, 33, 28))
        draw.text((x + 10, y + h - 27), label, fill="white", font=label_font)
        draw.rectangle((x, y, x + w, y + h), outline=(47, 116, 75) if key == "query" else (191, 174, 145), width=4)
        tile_map["tiles"][key] = {"x": x, "y": y, "width": w, "height": h, "visibleImage": visible_image, "label": label, "path": str(path)}
    canvas.save(collage_path, quality=94)
    return tile_map


def extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.I)
    if fenced:
        text = fenced.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    return json.loads(text)


def visible_bounds_text(layout: dict[str, Any]) -> str:
    lines = []
    for key, tile in layout["tiles"].items():
        bounds = tile["visibleImage"]
        lines.append(f"{tile['label']}: x={bounds['x']}, y={bounds['y']}, width={bounds['width']}, height={bounds['height']}")
    return "\n".join(lines)


def box_inside(box: list[Any], bounds: dict[str, int]) -> bool:
    if len(box) != 4:
        return False
    try:
        x, y, w, h = [int(float(value)) for value in box]
    except (TypeError, ValueError):
        return False
    return (
        x >= bounds["x"]
        and y >= bounds["y"]
        and w > 0
        and h > 0
        and x + w <= bounds["x"] + bounds["width"]
        and y + h <= bounds["y"] + bounds["height"]
    )


def coordinate_status(parsed: dict[str, Any], layout: dict[str, Any]) -> dict[str, Any]:
    selected_class = parsed.get("selected_class")
    selected_tile = next((tile for tile in layout["tiles"].values() if tile["label"] == selected_class), None)
    boxes = parsed.get("match_boxes", []) or []
    query_ok = bool(boxes) and box_inside(boxes[0].get("box", []), layout["tiles"]["query"]["visibleImage"])
    candidate_ok = len(boxes) > 1 and selected_tile is not None and box_inside(boxes[1].get("box", []), selected_tile["visibleImage"])
    return {"queryBoxInsideImage": query_ok, "candidateBoxInsideImage": candidate_ok, "valid": query_ok and candidate_ok}


def ask_gemini(collage_path: Path, candidate_labels: list[str], layout: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    image_b64 = base64.b64encode(collage_path.read_bytes()).decode("ascii")
    labels = ", ".join(candidate_labels)
    bounds = visible_bounds_text(layout)
    prompt = f"""
You are verifying cattle muzzle identity from one labelled collage.
The collage has one QUERY MUZZLE and 5 candidate muzzle images.
The candidate labels are class names only: {labels}.
The candidates are randomly shuffled, so do not assume any rank order.
Choose which candidate class visually matches the query muzzle best.
Focus on muzzle texture ridges, dark/light skin pattern, central groove shape, and repeated local patterns.
The full cropped muzzle images are visible inside each tile with padding. Do not assume the image fills the entire tile.
Visible muzzle image bounds:
{bounds}
Return only JSON:
{{
  "selected_class": "class_000000",
  "confidence": "low|medium|high",
  "reason": "short visual reason",
  "match_boxes": [
    {{"label": "query matching pattern", "box": [x, y, width, height]}},
    {{"label": "candidate matching pattern", "box": [x, y, width, height]}}
  ]
}}
Coordinate rules:
- Use absolute pixel coordinates in the full collage image, not normalized values.
- The collage origin is top-left: x=0, y=0.
- The collage size is 1300x760.
- Boxes must be integers in [x, y, width, height] format.
- Boxes must be inside the visible muzzle image area, not on the text label.
- Query box must be inside the QUERY MUZZLE visible image bounds listed above.
- Candidate box must be inside the selected candidate class visible image bounds listed above.
- First box should mark the query pattern.
- Second box should mark the matching candidate pattern.
- If exact tiny pattern coordinates are uncertain, return a larger box around the visible matching region.
""".strip()
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}},
                ],
            }
        ],
        "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
    }

    errors: list[str] = []
    for model in MODELS_TO_TRY:
        for attempt in range(1, 4):
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": "muzzle-gemini-shuffled-top5/1.0"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=90) as response:
                    raw = json.loads(response.read().decode("utf-8"))
                text = "".join(part.get("text", "") for part in raw["candidates"][0]["content"]["parts"])
                return {"model": model, "raw": raw, "parsed": extract_json(text)}
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8", errors="replace")
                errors.append(f"Gemini {model} attempt {attempt} HTTP {error.code}: {body}")
                if error.code in {401, 403, 404}:
                    break
                time.sleep(2 * attempt)
            except Exception as error:
                errors.append(f"Gemini {model} attempt {attempt}: {error}")
                time.sleep(2 * attempt)
    raise RuntimeError("\n".join(errors[-4:]) or "Gemini request failed")


def plot_boxes(collage_path: Path, boxed_path: Path, parsed: dict[str, Any]) -> None:
    image = Image.open(collage_path).convert("RGB")
    draw = ImageDraw.Draw(image)
    label_font = font(15)
    colors = [(47, 116, 75), (26, 92, 180), (167, 93, 22), (148, 35, 35)]
    for index, item in enumerate(parsed.get("match_boxes", []) or []):
        box = item.get("box", [])
        if len(box) != 4:
            continue
        x, y, w, h = [int(float(v)) for v in box]
        color = colors[index % len(colors)]
        draw.rectangle((x, y, x + w, y + h), outline=color, width=5)
        label = str(item.get("label", f"box {index + 1}"))[:34]
        draw.rectangle((x, max(0, y - 25), x + max(130, len(label) * 8), max(24, y)), fill=color)
        draw.text((x + 6, max(2, y - 21)), label, fill="white", font=label_font)
    image.save(boxed_path, quality=94)


def build_samples(classes: list[Path], count: int = 5) -> list[dict[str, Any]]:
    rng = random.Random(RANDOM_SEED)
    samples = []
    for index, query_class in enumerate(classes[:count]):
        query_image, correct_candidate = class_images(query_class, 2)
        wrong_classes = [cls for cls in classes if cls != query_class]
        wrong_classes = rng.sample(wrong_classes, 4)
        candidates = [{"classId": query_class.name, "imagePath": str(correct_candidate), "expectedCorrect": True}]
        for cls in wrong_classes:
            candidates.append({"classId": cls.name, "imagePath": str(class_images(cls, 1)[0]), "expectedCorrect": False})
        rng.shuffle(candidates)
        for slot_index, candidate in enumerate(candidates, start=1):
            candidate["slotId"] = f"candidate_{slot_index:02d}"
        samples.append({"sampleId": f"sample_{index + 1:02d}", "queryClass": query_class.name, "queryImage": str(query_image), "candidates": candidates})
    return samples


def write_dashboard(results: list[dict[str, Any]]) -> None:
    correct = sum(1 for result in results if result.get("selectedClass") == result["queryClass"])
    rows, cards = [], []
    for result in results:
        ok = result.get("selectedClass") == result["queryClass"]
        status = "Correct" if ok else "Wrong"
        candidate_order = ", ".join(candidate["classId"] for candidate in result["candidates"])
        rows.append(
            f"<tr><td>{html.escape(result['sampleId'])}</td><td>{html.escape(result['queryClass'])}</td>"
            f"<td>{html.escape(str(result.get('selectedClass', '-')))}</td><td>{html.escape(result.get('model', '-'))}</td>"
            f"<td>{html.escape(result.get('confidence', '-'))}</td><td><span class='pill {'ok' if ok else 'bad'}'>{status}</span></td></tr>"
        )
        cards.append(
            f"""
            <article class="card">
              <div class="card-head">
                <div><h2>{html.escape(result['sampleId'])}</h2><p>Query class: {html.escape(result['queryClass'])}</p></div>
                <span class="pill {'ok' if ok else 'bad'}">{status}</span>
              </div>
              <img src="{html.escape(result['boxedImage'])}" alt="{html.escape(result['sampleId'])} boxed Gemini collage">
              <dl>
                <div><dt>Gemini selected</dt><dd>{html.escape(str(result.get('selectedClass', '-')))}</dd></div>
                <div><dt>Model</dt><dd>{html.escape(result.get('model', '-'))}</dd></div>
                <div><dt>Confidence</dt><dd>{html.escape(result.get('confidence', '-'))}</dd></div>
                <div><dt>Candidate order</dt><dd>{html.escape(candidate_order)}</dd></div>
                <div><dt>Reason</dt><dd>{html.escape(result.get('reason', '-'))}</dd></div>
              </dl>
            </article>
            """
        )
    accuracy = round((correct / max(1, len(results))) * 100, 2)
    html_text = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemini Shuffled Top-5 Muzzle Dashboard</title>
  <style>
    * {{ box-sizing:border-box; }}
    body {{ margin:0; background:#f4f1ea; color:#20221d; font-family:Inter,Segoe UI,Arial,sans-serif; }}
    main {{ width:min(1180px, calc(100vw - 32px)); margin:0 auto; padding:28px 0 42px; }}
    h1 {{ margin:0; font-size:clamp(26px,4vw,42px); letter-spacing:0; }}
    p {{ color:#6a6258; line-height:1.5; }}
    .metrics {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:22px 0; }}
    .metric,.panel,.card {{ background:#fffdf8; border:1px solid #d8cdbb; border-radius:8px; box-shadow:0 14px 36px rgba(54,45,28,.08); }}
    .metric {{ padding:16px; }}
    .metric small {{ display:block; color:#746b5f; font-weight:800; text-transform:uppercase; font-size:12px; }}
    .metric strong {{ display:block; color:#2f744b; font-size:32px; margin-top:8px; }}
    .panel {{ padding:16px; margin-bottom:16px; overflow:auto; }}
    table {{ width:100%; border-collapse:collapse; min-width:760px; }}
    th,td {{ text-align:left; border-bottom:1px solid #e5dccd; padding:11px; }}
    th {{ color:#6a6258; font-size:12px; text-transform:uppercase; }}
    .pill {{ display:inline-flex; border-radius:999px; padding:6px 10px; font-weight:900; font-size:12px; }}
    .pill.ok {{ background:#e8f2eb; color:#205437; }}
    .pill.bad {{ background:#fff0eb; color:#9a3926; }}
    .cards {{ display:grid; grid-template-columns:1fr; gap:16px; }}
    .card {{ padding:14px; }}
    .card-head {{ display:flex; justify-content:space-between; gap:12px; align-items:start; margin-bottom:10px; }}
    h2 {{ margin:0 0 4px; font-size:20px; }}
    .card img {{ width:100%; border-radius:8px; border:1px solid #d8cdbb; display:block; background:#fff; }}
    dl {{ display:grid; grid-template-columns:180px 140px 140px 1fr; gap:10px; margin:12px 0 0; }}
    dt {{ color:#746b5f; font-size:12px; font-weight:900; text-transform:uppercase; }}
    dd {{ margin:4px 0 0; font-weight:800; }}
    dl div:nth-child(4), dl div:nth-child(5) {{ grid-column:1 / -1; }}
    @media (max-width:800px) {{ .metrics,dl {{ grid-template-columns:1fr; }} }}
  </style>
</head>
<body>
  <main>
    <h1>Gemini Shuffled Top-5 Muzzle Dashboard</h1>
    <p>Each sample has one query muzzle and five randomly shuffled candidate classes. Candidate labels are class names only, with no Top rank hints.</p>
    <section class="metrics">
      <div class="metric"><small>Total Samples</small><strong>{len(results)}</strong></div>
      <div class="metric"><small>Candidates Per Sample</small><strong>5</strong></div>
      <div class="metric"><small>Gemini Correct</small><strong>{correct}</strong></div>
      <div class="metric"><small>LLM Accuracy</small><strong>{accuracy}%</strong></div>
    </section>
    <section class="panel">
      <table><thead><tr><th>Sample</th><th>Query Class</th><th>Selected Class</th><th>Model</th><th>Confidence</th><th>Status</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
    </section>
    <section class="cards">{''.join(cards)}</section>
  </main>
</body>
</html>"""
    (OUT_DIR / "index.html").write_text(html_text, encoding="utf-8")


def main() -> None:
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    (OUT_DIR / "assets").mkdir(parents=True, exist_ok=True)
    classes = sorted(path for path in TEST_DIR.iterdir() if path.is_dir())
    samples = build_samples(classes, count=5)
    results: list[dict[str, Any]] = []
    for sample in samples:
        sample_dir = OUT_DIR / "assets" / sample["sampleId"]
        sample_dir.mkdir(parents=True, exist_ok=True)
        collage_path = sample_dir / "collage_gemini_shuffled_top5.jpg"
        boxed_path = sample_dir / "collage_gemini_shuffled_top5_with_boxes.jpg"
        layout = make_collage(sample, collage_path)
        try:
            labels = [candidate["classId"] for candidate in sample["candidates"]]
            gemini = ask_gemini(collage_path, labels, layout)
            parsed = gemini["parsed"]
            parsed["coordinate_status"] = coordinate_status(parsed, layout)
            (sample_dir / "gemini_raw.json").write_text(json.dumps(gemini["raw"], indent=2), encoding="utf-8")
            (sample_dir / "gemini_result.json").write_text(json.dumps(parsed, indent=2), encoding="utf-8")
            plot_boxes(collage_path, boxed_path, parsed)
            selected_class = parsed.get("selected_class")
            confidence = parsed.get("confidence", "-")
            reason = parsed.get("reason", "-")
            model = gemini["model"]
        except Exception as error:
            selected_class = None
            confidence = "-"
            reason = str(error)
            model = "-"
            shutil.copyfile(collage_path, boxed_path)
            (sample_dir / "error.txt").write_text(str(error), encoding="utf-8")
        record = {
            **sample,
            "layout": layout,
            "collageImage": f"assets/{sample['sampleId']}/collage_gemini_shuffled_top5.jpg",
            "boxedImage": f"assets/{sample['sampleId']}/collage_gemini_shuffled_top5_with_boxes.jpg",
            "selectedClass": selected_class,
            "model": model,
            "confidence": confidence,
            "reason": reason,
        }
        results.append(record)
        print(f"{sample['sampleId']}: query={sample['queryClass']} selected={selected_class} model={model} confidence={confidence}")
    (OUT_DIR / "summary.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    write_dashboard(results)
    (OUT_DIR / "README.md").write_text("Open index.html or drag this folder into Netlify Drop. Gemini key is not saved here.\n", encoding="utf-8")
    print(f"dashboard={OUT_DIR}")


if __name__ == "__main__":
    main()
