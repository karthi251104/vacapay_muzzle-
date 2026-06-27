# Project Process and Feature Guide

This document explains the complete Vacapay Muzzle project in simple terms for UI, backend, and testing teammates.

## 1. What This Project Does

The app helps field agents enroll cattle and identify if the same cattle is captured again later.

The field agent captures:

- 5 muzzle photos.
- 3 face photos.
- 1 left side photo.
- 1 right side photo.
- 1 back photo.
- 1 udder photo.

Total per cattle visit: 12 images.

The system stores the cattle metadata, photos, GPS location, field agent details, and date/time. The muzzle photos are used for AI matching.

## 2. Users

### Admin

Admin can:

- log in
- create field agents
- view cattle/farmer records
- view images
- select cattle records
- download cattle images as ZIP
- review possible match cases
- merge old duplicate cattle records

### Field Agent

Field agent can:

- log in using phone or agent ID
- enter owner ID and owner name
- use GPS
- check nearby existing cattle
- capture muzzle photos
- upload/capture supporting photos
- save the final visit

Farmers do not use this app. Field agents use it on behalf of farmers/owners.

## 3. Core Business Rule

The same cattle may be captured again after 2 days or another date.

Correct behavior:

- If the app knows it is the same cattle, save the new visit inside the same cattle folder.
- If it is not sure or the animal is new, create a new cattle ID/folder.
- Admin merge exists only as a correction tool for old duplicate data or uncertain cases.

## 4. Current Same-Cattle Logic

When the agent starts capture:

1. Agent enters Owner ID.
2. Agent gets GPS.
3. Backend checks existing cattle records for that owner and nearby location.
4. If exactly one existing cattle is found, backend automatically uses that existing cattle ID.
5. The new visit gets a new date/session folder inside that existing cattle folder.
6. If multiple cattle exist for that owner, backend does not guess. It creates a temporary/new cattle record and waits for muzzle matching.
7. After 5 muzzle photos, DINOv2 matching runs.
8. If confidence is >= 70%, the visit is moved to the matched existing cattle folder.
9. If confidence is below 70%, the new cattle ID remains.

## 5. Folder and Storage Logic

### Local/Docker storage

Local images are stored under:

```text
data/
  cattle-id/
    yyyy-mm-dd/
      muzzle1.jpg
      muzzle2.jpg
      muzzle3.jpg
      muzzle4.jpg
      muzzle5.jpg
      face1.jpg
      face2.jpg
      face3.jpg
      leftside.jpg
      rightside.jpg
      back.jpg
      udder.jpg
```

If same cattle is captured on another date, it becomes:

```text
data/
  same-cattle-id/
    2026-06-27/
      ...12 images...
    2026-06-29/
      ...12 images...
```

If the same date already exists, the backend creates a suffix like:

```text
2026-06-27-2
2026-06-27-3
```

### Cloudinary storage

Cloudinary mirrors the same logical structure:

```text
vacapay/
  cattle/
    cattle-id/
      yyyy-mm-dd/
        muzzle1
        face1
        ...
```

### MongoDB storage

MongoDB stores metadata:

- cattle ID
- owner/farmer ID
- owner/farmer name
- field agent ID/name
- GPS latitude/longitude
- capture date/time
- upload date/time
- folder locations
- Cloudinary URLs
- image metadata
- match results
- sessions/visits

## 6. Image Processing Flow

For each muzzle image:

1. Frontend captures a camera frame.
2. Backend receives image upload.
3. Python YOLO script runs using `best_v4.pt`.
4. YOLO detects the muzzle bounding box.
5. Backend crops the muzzle.
6. CLAHE is applied to improve contrast.
7. Crop is saved as `muzzle1.jpg` to `muzzle5.jpg`.
8. Crop is uploaded to Cloudinary if configured.
9. UI shows detection box and saved photo count.

For non-muzzle photos:

1. Agent selects/captures the image.
2. Backend resizes if needed.
3. Backend saves the image.
4. Backend uploads to Cloudinary if configured.

## 7. Embedding and Match Flow

After muzzle image 5:

1. Backend calls `backend/scripts/embedding_average.py`.
2. The script loads `backend/dinov2_triplet_v2_best.pt`.
3. It creates embeddings for all 5 muzzle crops.
4. It averages the 5 embeddings.
5. It normalizes the average embedding.
6. Backend upserts the vector to Pinecone if configured.
7. Backend searches Pinecone for top matches.
8. Backend also has local cosine comparison fallback.
9. Best match confidence is compared to 70% threshold.
10. Match decision is saved in metadata and match audit.

Formula concept:

```text
average = (emb1 + emb2 + emb3 + emb4 + emb5) / 5
```

## 8. Admin Duplicate Merge

Admin merge is for correction, not normal daily flow.

Use it when old data has duplicate cattle IDs for the same real animal.

Admin process:

1. Select the correct/main cattle row.
2. Tick duplicate cattle rows.
3. Click `Merge into selected`.
4. Backend moves duplicate sessions/images into the main cattle record.
5. Duplicate cattle records are removed.

## 9. ZIP Download

Admin can select cattle rows and download a ZIP.

ZIP structure:

```text
owner-name/
  cattle-id/
    yyyy-mm-dd/
      muzzle1.jpg
      face1.jpg
      ...
```

This helps export data for testing, review, or model training.

## 10. Main Code Files

### Frontend

```text
frontend/src/app/app.component.html   UI template
frontend/src/app/app.component.ts     screen state, capture flow, admin actions
frontend/src/app/app.component.css    all styling and mobile layout
frontend/src/app/api.service.ts       API calls and TypeScript interfaces
frontend/src/app/app.config.ts        Angular providers
frontend/proxy.conf.json              dev proxy from 4200 to backend 3000
```

### Backend

```text
backend/src/server.js                 Express API, auth, storage, matching orchestration
backend/scripts/yolo_crop_clahe.py    YOLO detection, crop, CLAHE
backend/scripts/yolo_status.py        model status check
backend/scripts/embedding_average.py  DINOv2 average embedding
backend/scripts/embedding_status.py   embedding model status check
backend/requirements.txt              Python packages
```

### Root

```text
Dockerfile                            full app image

docker-compose.yml                    local/server Docker run config
.env.example                          environment variable template
best_v4.pt                            YOLO model
backend/dinov2_triplet_v2_best.pt     DINOv2 model
```

## 11. Current Limitations

- This is still a demo app, not final production release.
- Ionic packaging is not finalized; the current app is Angular mobile web/PWA style.
- Offline queue is not implemented yet.
- Admin merge is manual for existing duplicate mistakes.
- Model accuracy depends on final cleaned DINOv2 model and good muzzle photos.
- Production security hardening is still needed.

## 12. Useful Next Improvements

Good UI/team tasks:

- Make capture screens more polished and easy for non-technical field agents.
- Add clearer retake guidance when muzzle is not detected.
- Add pending/offline upload queue.
- Add admin search/filter by owner ID, cattle ID, field agent, date.
- Add simple display ID like `COW-001` while keeping UUID internally.
- Add visit timeline per cattle.
- Add image comparison view for top match candidates.
- Add progress recovery if app closes mid-capture.
