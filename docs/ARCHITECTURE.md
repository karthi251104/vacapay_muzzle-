# Architecture

## High-Level System

The system has 5 main pieces:

1. Angular mobile web app
2. Node.js backend
3. Python model scripts
4. Cloud services
5. Docker packaging

## Frontend

Location:

- `F:\vacapay\vacapay muzzle\frontend`

Responsibilities:

- login UI for admin and agent
- enrollment form
- GPS capture
- camera preview
- muzzle capture loop
- body image uploads
- status cards for YOLO, embedding model, Pinecone
- admin review UI for uncertain matches

Main frontend file:

- `F:\vacapay\vacapay muzzle\frontend\src\app\app.component.ts`

The frontend talks to backend via HTTP APIs.

## Backend

Location:

- `F:\vacapay\vacapay muzzle\backend`

Main entry:

- `F:\vacapay\vacapay muzzle\backend\src\server.js`

Responsibilities:

- auth/session handling
- admin + agent management
- enrollment record creation
- image upload/capture processing
- Python script execution
- local storage management
- MongoDB writes/reads
- Cloudinary upload
- Pinecone upsert/query
- match audit storage

## Python Scripts

Location:

- `F:\vacapay\vacapay muzzle\backend\scripts`

Scripts:

- `yolo_status.py`  
  Checks whether YOLO model loads

- `yolo_crop_clahe.py`  
  Runs YOLO, crops muzzle, applies CLAHE

- `resize_image.py`  
  Resizes image if greater than 1024 x 768

- `embedding_status.py`  
  Checks embedding model readiness

- `embedding_average.py`  
  Builds embeddings for muzzle images and averages them

## Datastores

### MongoDB Atlas

Used for:

- users
- cattle metadata
- match audits

### Cloudinary

Used for:

- demo image hosting
- remote image URLs for stored captures

### Pinecone

Used for:

- storing averaged muzzle embeddings
- querying nearest cattle vectors

## Local Filesystem Storage

Root storage folder:

- `F:\vacapay\vacapay muzzle\data`

Contains:

- raw uploads
- processed images
- local fallback JSON files
- cattle folders

Typical cattle folder shape:

```text
data/
  <cattle-id>/
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

## Matching Logic

After 5 muzzle images are accepted:

1. backend collects the 5 processed muzzle crops
2. Python creates one embedding per image
3. the embeddings are averaged
4. the average is normalized
5. Pinecone is queried for nearest vectors
6. matches are filtered by farmer name and location radius
7. if score is above threshold, the cattle can be treated as same cattle
8. otherwise a new cattle ID is kept

## Why Docker Exists Here

Docker is mainly for:

- stable server deployment
- one-command full app run
- consistent Node + Python + OpenCV + Torch environment

Docker is not required for UI-only work.
