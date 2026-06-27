# Architecture

## 1. High-Level System

Vacapay Muzzle has these main pieces:

1. Angular mobile web frontend.
2. Node.js/Express backend.
3. Python model scripts for YOLO and DINOv2.
4. MongoDB Atlas for metadata.
5. Cloudinary for image/object storage.
6. Pinecone for vector search.
7. Docker packaging for full local/server deployment.

## 2. Frontend

Location:

```text
frontend/
```

Main files:

```text
frontend/src/app/app.component.html
frontend/src/app/app.component.ts
frontend/src/app/app.component.css
frontend/src/app/api.service.ts
frontend/proxy.conf.json
```

Responsibilities:

- login UI for admin and agent
- admin dashboard
- agent creation UI
- field-agent mobile capture flow
- owner ID and GPS input
- camera preview
- muzzle auto capture controls
- detection box display
- 12-image progress
- supporting photo upload slots
- admin cattle list/detail
- image viewer
- ZIP download action
- duplicate merge action
- match review UI

During local dev, Angular runs on port 4200 and proxies `/api` and `/media` to backend port 3000.

## 3. Backend

Location:

```text
backend/
```

Main file:

```text
backend/src/server.js
```

Responsibilities:

- auth/session handling
- default admin creation
- agent management
- enrollment/session creation
- automatic same-folder reuse when one clear existing cattle exists
- image upload handling
- local image storage
- Cloudinary upload
- MongoDB read/write
- YOLO script execution
- DINOv2 embedding script execution
- Pinecone upsert/query
- local vector fallback comparison
- match audit storage
- admin merge endpoint
- ZIP download creation
- serving built Angular app in Docker/single-port mode

## 4. Python Scripts

Location:

```text
backend/scripts/
```

Scripts:

```text
yolo_status.py          checks YOLO model readiness
yolo_crop_clahe.py      detects muzzle, crops, applies CLAHE
resize_image.py         resizes supporting images if needed
embedding_status.py     checks DINOv2 model readiness
embedding_average.py    creates average embedding from 5 muzzle crops
```

## 5. Storage Layout

Local data root:

```text
data/
```

Cattle folder shape:

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

Repeat visits use the same cattle ID with a new date/session folder.

Cloudinary mirrors the logical structure under:

```text
vacapay/cattle/cattle-id/yyyy-mm-dd/
```

## 6. MongoDB Collections

Collections:

```text
users
cattle
match_audits
```

Important cattle data:

- cattle ID
- owner/farmer ID
- owner/farmer name
- field officer ID/name
- GPS
- sessions/visits
- local folder path
- Cloudinary image refs
- embeddings
- match result

If MongoDB is not configured, backend falls back to local JSON files in `data/`.

## 7. Matching Architecture

After 5 muzzle photos:

1. Backend ensures the 5 muzzle crops exist.
2. DINOv2 script creates average embedding.
3. Backend stores embedding in session metadata.
4. Backend upserts vector to Pinecone if configured.
5. Backend searches Pinecone or local candidates.
6. Candidates are filtered by owner/location radius.
7. If score >= 70%, session moves to matched existing cattle folder.
8. If score < 70%, new cattle ID remains.

## 8. Why Docker Exists

Docker is used for:

- one-command full app startup
- consistent Node/Python/Torch/OpenCV environment
- server deployment style
- mounting model files and data volume

Docker is not required for UI-only work.
