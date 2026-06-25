# Vacapay Teammate Handoff

This project is a mobile-first cattle enrollment and muzzle matching demo app.

The app is meant for:

- field officers who collect cattle images in the field
- admins who create agents and review uncertain cattle matches
- a future backend search flow that uses muzzle embeddings to identify cattle

## Main Goal

The product helps register a cattle once, then later re-register the same cattle on another date and decide whether:

- it is the same already-registered cattle
- or it is a new cattle and needs a new cattle ID

This decision is made using:

- farmer name
- GPS proximity
- muzzle image matching with YOLO + DINOv2

## Current Tech Stack

- Frontend: Ionic-style mobile UI built in Angular
- Backend: Node.js + Express
- ML inference helpers: Python scripts
- Muzzle detection: YOLO model `best_v4.pt`
- Muzzle embedding: DINOv2 triplet model `backend/dinov2_triplet_v2_best.pt`
- Database: MongoDB Atlas
- Image/object storage: Cloudinary
- Vector search: Pinecone
- Containerization: Docker

## Folder Overview

```text
F:\vacapay\vacapay muzzle
  backend/                 Node backend + Python scripts
  frontend/                Angular mobile app
  data/                    Local data, uploads, fallback JSON, captured images
  tools/                   Utilities like cloudflared.exe
  best_v4.pt               YOLO muzzle detection model
  backend/dinov2_triplet_v2_best.pt
                           DINOv2 embedding model
  Dockerfile               Full app container build
  docker-compose.yml       Local/server container run config
  .env                     Local environment secrets/config
```

## What Is Already Implemented

- admin login
- agent creation
- agent login
- field enrollment flow
- live camera access in browser
- YOLO muzzle crop flow
- CLAHE enhancement after crop
- local image save
- optional Cloudinary upload
- MongoDB cattle metadata storage
- DINOv2 average embedding creation after 5 muzzle captures
- Pinecone vector upsert/query
- uncertain match audit storage
- admin review screen for uncertain matches

## What Is Not Final Yet

- production Ionic packaging
- final polished UI design
- full end-to-end repeated field test for same cattle across different days
- fully finalized search workflow for the final embedding model behavior
- production deployment hardening

## What Teammates Should Usually Work On

### UI teammate

Focus inside:

- `F:\vacapay\vacapay muzzle\frontend\src\app\`

Main files:

- `F:\vacapay\vacapay muzzle\frontend\src\app\app.component.ts`
- `F:\vacapay\vacapay muzzle\frontend\src\app\app.component.html`
- `F:\vacapay\vacapay muzzle\frontend\src\app\app.component.css`
- `F:\vacapay\vacapay muzzle\frontend\src\app\api.service.ts`

### Backend teammate

Focus inside:

- `F:\vacapay\vacapay muzzle\backend\src\server.js`
- `F:\vacapay\vacapay muzzle\backend\scripts\`

### ML / matching teammate

Focus inside:

- `F:\vacapay\vacapay muzzle\backend\scripts\embedding_average.py`
- `F:\vacapay\vacapay muzzle\backend\scripts\yolo_crop_clahe.py`

## Recommended Reading Order

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/WORKFLOWS.md`
4. `docs/SETUP_LOCAL.md`
5. `docs/RUN_COMMANDS.md`
6. `docs/DEPLOYMENT.md`
