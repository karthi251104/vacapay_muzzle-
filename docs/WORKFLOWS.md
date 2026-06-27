# Workflows

## 1. Admin Workflow

1. Admin logs in.
2. Admin creates field agents with name, phone, agent ID, and password.
3. Admin views cattle/farm records.
4. Admin opens cattle details and image viewer.
5. Admin downloads selected cattle images as ZIP when needed.
6. Admin reviews uncertain matches.
7. Admin can merge duplicate cattle IDs if old/test data has duplicates.

## 2. Field Agent Enrollment Workflow

1. Agent logs in.
2. Agent taps `Start Enrollment`.
3. Agent enters Owner ID and owner name.
4. Agent captures GPS or enters coordinates.
5. Agent checks nearby existing cattle.
6. Agent starts capture.
7. Agent captures 5 muzzle images.
8. Agent captures 7 supporting images.
9. Agent reviews and saves.

Total images per visit: 12.

## 3. Automatic Same-Folder Workflow

This is the preferred repeat-cattle behavior.

When an agent starts a capture:

1. Backend checks Owner ID/name and GPS radius.
2. If exactly one existing cattle record is found, the backend reuses that cattle ID.
3. A new date/session folder is created under the same cattle folder.
4. Agent sees a message that an existing cattle folder was found.
5. The visit saves under that cattle record.

The agent does not manually enter or choose cattle ID.

## 4. Multiple Cattle for Same Owner

If one owner has multiple cattle, the system should not guess.

Flow:

1. Backend creates/keeps a new capture session.
2. Agent captures 5 muzzle photos.
3. DINOv2 matching runs.
4. If confidence >= 70%, the visit moves into the matched cattle folder.
5. If confidence < 70%, it remains a new cattle record.

## 5. Muzzle Capture Workflow

For each muzzle image:

1. Browser camera frame is captured.
2. Frontend uploads the frame to backend.
3. Backend runs YOLO with `best_v4.pt` and image size 640.
4. YOLO returns muzzle bounding box and confidence.
5. Backend crops the muzzle.
6. CLAHE is applied to the crop.
7. Crop is saved locally and optionally uploaded to Cloudinary.
8. UI shows count and bounding box.

Five muzzle images are required to create a stable average embedding.

## 6. DINOv2 Matching Workflow

After the 5th muzzle image:

1. Backend loads the 5 muzzle crops.
2. `embedding_average.py` creates one embedding per crop.
3. The five embeddings are averaged and normalized.
4. Backend upserts/query vectors in Pinecone if configured.
5. Backend can fall back to local cosine comparison.
6. Top matches are filtered by owner/location context.
7. Match threshold is 70% by default.

## 7. Supporting Images Workflow

After muzzle capture, the agent adds:

- face1
- face2
- face3
- leftside
- rightside
- back
- udder

The save button is enabled only when all 12 images are present.

## 8. Admin Review Workflow

For uncertain/near-threshold cases:

1. Backend stores a match audit.
2. Admin opens manual check/review panel.
3. Admin sees final cattle ID, top matches, confidence, and images.
4. Admin confirms or corrects.

## 9. Admin Duplicate Merge Workflow

Use this only for old duplicate data or mistakes.

1. Select the correct main cattle row.
2. Tick duplicate cattle rows.
3. Click `Merge into selected`.
4. Backend moves sessions/images into the main cattle record.
5. Duplicate cattle IDs are removed.

## 10. ZIP Download Workflow

1. Admin ticks one or more cattle rows.
2. Admin clicks `Download ZIP`.
3. Backend creates a ZIP using local or Cloudinary-backed image references.
4. ZIP groups images by owner/cattle/session folders.
