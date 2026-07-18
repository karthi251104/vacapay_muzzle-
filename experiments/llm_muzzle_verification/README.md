# LLM Muzzle Verification Experiment

This experiment tests the idea:

```text
DINOv2 embedding model -> Top-5 cattle candidates -> labelled collage -> Gemini/GPT visual verification
```

The LLM is not the primary matcher. DINOv2 retrieves Top-5 first. The LLM only checks which of the Top-5 looks visually closest to the query muzzle and returns visual reasoning plus box coordinates.

## Dataset

Default test folder:

```text
F:\muzzle_embedding_dataset_final\muzzle_embedding_dataset_final\test
```

Expected layout:

```text
test/
  manifest.csv
  class_000009/
    image_4.jpg
    image_5.jpg
  class_000012/
    image_2.jpg
```

Each `class_...` folder is one cattle identity.


## Python Dependencies

This script uses the existing backend DINOv2 helper, so the Python environment must have:

```text
opencv-python
numpy
Pillow
torch
torchvision
```

On this machine, the bundled Python currently fails at `cv2`, so DINOv2 embedding cannot run until the model/testing Python environment is installed or selected.
## Run Without Gemini

This creates DINOv2 Top-5 results and collages only:

```powershell
python experiments/llm_muzzle_verification/run_llm_muzzle_verification.py --provider none --max-queries 3
```

Output:

```text
experiments/llm_muzzle_verification/results/
  summary.json
  query_001_class_.../
    collage.jpg
    result.json
```

## Run With Gemini

Do not put the API key in source code. Set it in the environment:

```powershell
$env:GEMINI_API_KEY="YOUR_ROTATED_KEY"
python experiments/llm_muzzle_verification/run_llm_muzzle_verification.py --provider gemini --max-queries 3
```

If Gemini returns boxes, the script saves:

```text
collage_with_boxes.jpg
```

## Gemini Output Expected

```json
{
  "selected_rank": 1,
  "selected_label": "top1",
  "confidence": 0.78,
  "reason": "similar ridge spacing and central dark pore cluster",
  "matching_boxes": [
    {"label": "query", "box": [x, y, width, height], "pattern": "central ridge group"},
    {"label": "top1", "box": [x, y, width, height], "pattern": "same ridge group"}
  ]
}
```

Coordinates are absolute pixels relative to the full collage image.

## What To Measure

For each query:

```text
Ground truth class
DINOv2 Top-1 class
DINOv2 Top-5 classes
Gemini selected rank/class
Gemini reason quality
Gemini box usefulness
```

If Gemini often selects the correct Top-5 candidate and gives useful boxes, it can be tested later as an admin-side verification step after DINOv2 retrieval.

