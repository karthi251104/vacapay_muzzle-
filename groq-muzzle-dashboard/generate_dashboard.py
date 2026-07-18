#!/usr/bin/env python3
from __future__ import annotations

import base64
import html
import json
import os
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


TEST_DIR = Path(r"F:\muzzle_embedding_dataset_final\muzzle_embedding_dataset_final\test")
OUT_DIR = Path(__file__).resolve().parent / "site"
MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


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


def draw_cover(canvas: Image.Image, path: Path, box: tuple[int, int, int, int]) -> None:
    x, y, w, h = box
    image = Image.open(path).convert("RGB")
    ratio = max(w / image.width, h / image.height)
    resized = image.resize((int(image.width * ratio), int(image.height * ratio)), Image.Resampling.LANCZOS)
    left = (resized.width - w) // 2
    top = (resized.height - h) // 2
    canvas.paste(resized.crop((left, top, left + w, top + h)), (x, y))


def make_collage(sample: dict[str, Any], collage_path: Path) -> dict[str, Any]:
    width, height = 1200, 800
    canvas = Image.new("RGB", (width, height), (253, 250, 244))
    draw = ImageDraw.Draw(canvas)
    title_font = font(26)
    label_font = font(17)
    small_font = font(13)
    draw.text((34, 24), "Groq Vision Muzzle Top-5 Verification", fill=(31, 33, 28), font=title_font)
    draw.text((34, 55), f"Query class: {sample['queryClass']}  |  Expected correct: TOP 1", fill=(91, 84, 72), font=small_font)

    layout = [
        ("query", "QUERY MUZZLE", sample["queryImage"], (34, 86, 534, 300)),
        ("top1", f"TOP 1 / {sample['candidates'][0]['classId']}", sample["candidates"][0]["imagePath"], (604, 86, 260, 220)),
        ("top2", f"TOP 2 / {sample['candidates'][1]['classId']}", sample["candidates"][1]["imagePath"], (900, 86, 260, 220)),
        ("top3", f"TOP 3 / {sample['candidates'][2]['classId']}", sample["candidates"][2]["imagePath"], (34, 454, 260, 220)),
        ("top4", f"TOP 4 / {sample['candidates'][3]['classId']}", sample["candidates"][3]["imagePath"], (330, 454, 260, 220)),
        ("top5", f"TOP 5 / {sample['candidates'][4]['classId']}", sample["candidates"][4]["imagePath"], (626, 454, 260, 220)),
    ]
    tile_map: dict[str, Any] = {"width": width, "height": height, "tiles": {}}
    for key, label, path, box in layout:
        x, y, w, h = box
        draw_cover(canvas, Path(path), box)
        draw.rectangle((x, y + h - 38, x + w, y + h), fill=(31, 33, 28))
        draw.text((x + 12, y + h - 28), label, fill="white", font=label_font)
        draw.rectangle((x, y, x + w, y + h), outline=(47, 116, 75) if key == "query" else (191, 174, 145), width=4)
        tile_map["tiles"][key] = {"x": x, "y": y, "width": w, "height": h, "label": label, "path": str(path)}
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


def ask_groq(collage_path: Path) -> dict[str, Any]:
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GROQ_API_KEY is not set")
    image_b64 = base64.b64encode(collage_path.read_bytes()).decode("ascii")
    prompt = """
You are verifying cattle muzzle identity from one labelled collage.
The collage contains QUERY MUZZLE and TOP 1 MUZZLE through TOP 5 MUZZLE.
Choose which Top candidate visually matches the query muzzle best.
Focus on muzzle texture ridges, dark/light skin pattern, central groove shape, and repeated local patterns.
Return only JSON:
{
  "selected_rank": 1,
  "selected_label": "TOP 1 MUZZLE",
  "confidence": "low|medium|high",
  "reason": "short visual reason",
  "match_boxes": [
    {"label": "query matching pattern", "box": [x, y, width, height]},
    {"label": "candidate matching pattern", "box": [x, y, width, height]}
  ]
}
Coordinates must use full collage pixel coordinates. The collage size is 1200x800.
""".strip()
    payload = {
        "model": MODEL,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                ],
            }
        ],
    }
    req = urllib.request.Request(
        "https://api.groq.com/openai/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "muzzle-llm-verification-dashboard/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Groq HTTP {error.code}: {body}") from error
    content = raw["choices"][0]["message"]["content"]
    return {"raw": raw, "parsed": extract_json(content)}


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
        label = str(item.get("label", f"box {index + 1}"))[:32]
        draw.rectangle((x, max(0, y - 25), x + max(120, len(label) * 8), max(24, y)), fill=color)
        draw.text((x + 6, max(2, y - 21)), label, fill="white", font=label_font)
    image.save(boxed_path, quality=94)


def build_samples(classes: list[Path], count: int = 5) -> list[dict[str, Any]]:
    samples = []
    for index, query_class in enumerate(classes[:count]):
        query_image, same_candidate = class_images(query_class, 2)
        other_classes = [c for c in classes if c != query_class][:4]
        candidates = [{"rank": 1, "classId": query_class.name, "imagePath": str(same_candidate), "expectedCorrect": True}]
        for rank, cls in enumerate(other_classes, start=2):
            candidates.append({"rank": rank, "classId": cls.name, "imagePath": str(class_images(cls, 1)[0]), "expectedCorrect": False})
        samples.append({"sampleId": f"sample_{index + 1:02d}", "queryClass": query_class.name, "queryImage": str(query_image), "candidates": candidates})
    return samples


def write_dashboard(results: list[dict[str, Any]]) -> None:
    correct = sum(1 for r in results if r.get("selectedRank") == 1)
    rows = []
    cards = []
    for result in results:
        ok = result.get("selectedRank") == 1
        status = "Correct" if ok else "Wrong"
        rows.append(
            f"<tr><td>{html.escape(result['sampleId'])}</td><td>{html.escape(result['queryClass'])}</td>"
            f"<td>Top {result.get('selectedRank', '-')}</td><td>{html.escape(result.get('confidence', '-'))}</td>"
            f"<td><span class='pill {'ok' if ok else 'bad'}'>{status}</span></td></tr>"
        )
        cards.append(
            f"""
            <article class="card">
              <div class="card-head">
                <div><h2>{html.escape(result['sampleId'])}</h2><p>Query: {html.escape(result['queryClass'])}</p></div>
                <span class="pill {'ok' if ok else 'bad'}">{status}</span>
              </div>
              <img src="{html.escape(result['boxedImage'])}" alt="{html.escape(result['sampleId'])} boxed collage">
              <dl>
                <div><dt>Groq selected</dt><dd>Top {result.get('selectedRank', '-')}</dd></div>
                <div><dt>Confidence</dt><dd>{html.escape(result.get('confidence', '-'))}</dd></div>
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
  <title>Groq Muzzle Verification Dashboard</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{ margin:0; background:#f4f1ea; color:#20221d; font-family:Inter,Segoe UI,Arial,sans-serif; }}
    main {{ width:min(1180px, calc(100vw - 32px)); margin:0 auto; padding:28px 0 42px; }}
    h1 {{ margin:0; font-size:clamp(26px,4vw,42px); letter-spacing:0; }}
    p {{ color:#6a6258; line-height:1.5; }}
    .metrics {{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:22px 0; }}
    .metric,.panel,.card {{ background:#fffdf8; border:1px solid #d8cdbb; border-radius:8px; box-shadow:0 14px 36px rgba(54,45,28,.08); }}
    .metric {{ padding:16px; }}
    .metric small {{ display:block; color:#746b5f; font-weight:800; text-transform:uppercase; font-size:12px; }}
    .metric strong {{ display:block; color:#2f744b; font-size:32px; margin-top:8px; }}
    .panel {{ padding:16px; margin-bottom:16px; }}
    table {{ width:100%; border-collapse:collapse; }}
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
    dl {{ display:grid; grid-template-columns:160px 160px 1fr; gap:10px; margin:12px 0 0; }}
    dt {{ color:#746b5f; font-size:12px; font-weight:900; text-transform:uppercase; }}
    dd {{ margin:4px 0 0; font-weight:800; }}
    @media (max-width:800px) {{ .metrics,dl {{ grid-template-columns:1fr; }} }}
  </style>
</head>
<body>
  <main>
    <h1>Groq Muzzle Verification Dashboard</h1>
    <p>This dashboard tests the senior-requested idea: after Top-5 candidates are available, create a labelled query-vs-candidate collage, ask a vision LLM which candidate is most similar, then plot the returned pattern boxes.</p>
    <section class="metrics">
      <div class="metric"><small>Total Samples</small><strong>{len(results)}</strong></div>
      <div class="metric"><small>Expected Match</small><strong>Top 1</strong></div>
      <div class="metric"><small>Groq Correct</small><strong>{correct}</strong></div>
      <div class="metric"><small>LLM Accuracy</small><strong>{accuracy}%</strong></div>
    </section>
    <section class="panel">
      <table>
        <thead><tr><th>Sample</th><th>Query Class</th><th>Selected</th><th>Confidence</th><th>Status</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
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
        collage_path = sample_dir / "collage.jpg"
        boxed_path = sample_dir / "collage_with_boxes.jpg"
        layout = make_collage(sample, collage_path)
        try:
            groq = ask_groq(collage_path)
            parsed = groq["parsed"]
            (sample_dir / "groq_raw.json").write_text(json.dumps(groq["raw"], indent=2), encoding="utf-8")
            (sample_dir / "groq_result.json").write_text(json.dumps(parsed, indent=2), encoding="utf-8")
            plot_boxes(collage_path, boxed_path, parsed)
            selected_rank = parsed.get("selected_rank")
            confidence = parsed.get("confidence", "-")
            reason = parsed.get("reason", "-")
        except Exception as error:
            selected_rank = None
            confidence = "-"
            reason = str(error)
            shutil.copyfile(collage_path, boxed_path)
            (sample_dir / "error.txt").write_text(str(error), encoding="utf-8")
        record = {
            **sample,
            "layout": layout,
            "collageImage": f"assets/{sample['sampleId']}/collage.jpg",
            "boxedImage": f"assets/{sample['sampleId']}/collage_with_boxes.jpg",
            "selectedRank": selected_rank,
            "confidence": confidence,
            "reason": reason,
        }
        results.append(record)
        print(f"{sample['sampleId']}: selected={selected_rank} confidence={confidence}")
    (OUT_DIR / "summary.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    write_dashboard(results)
    (OUT_DIR / "README.md").write_text(
        "Open index.html or drag this folder into Netlify Drop. API keys are not saved in this folder.\n",
        encoding="utf-8",
    )
    print(f"dashboard={OUT_DIR}")


if __name__ == "__main__":
    main()
