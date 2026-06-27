# Vacapay Muzzle Demo

Vacapay Muzzle is a mobile-first cattle enrollment demo for field agents and admins. Field agents capture cattle photos, the backend crops muzzle images with YOLO, creates DINOv2 muzzle embeddings, searches Pinecone/MongoDB records, and saves repeat visits under the correct cattle folder when the same cattle is found.

## Quick Documentation Map

Read in this order if you are new to the project:

1. `docs/PROJECT_PROCESS.md` - what the app does, feature list, and full business workflow.
2. `docs/NO_DOCKER_SETUP.md` - how to run locally without Docker.
3. `docs/UI_HANDOFF.md` - where UI code lives and how a UI teammate should work.
4. `docs/RUN_COMMANDS.md` - copy-paste commands for daily work.
5. `docs/ARCHITECTURE.md` - backend/frontend/storage/model architecture.
6. `docs/WORKFLOWS.md` - detailed user and model workflows.

## Current Stack

- Frontend: Angular 18 mobile-first single page app.
- Backend: Node.js + Express.
- ML helpers: Python scripts.
- Muzzle detection: YOLO model `best_v4.pt`, image size 640.
- Muzzle crop enhancement: CLAHE after YOLO crop.
- Embedding model: DINOv2 triplet model `backend/dinov2_triplet_v2_best.pt`.
- Metadata DB: MongoDB Atlas, with local JSON fallback.
- Image storage: Cloudinary for demo/remote storage, local `data/` for fallback.
- Vector DB: Pinecone cosine index, dimension 768.
- Container option: Docker Compose.

## Main Features Implemented

- Admin login.
- Admin creates field agents with phone, agent ID, and password.
- Agent login.
- Mobile field-agent capture flow.
- Owner ID and GPS based nearby cattle check.
- Camera based muzzle capture.
- YOLO muzzle detection and crop.
- CLAHE applied after crop.
- 5 muzzle images per cattle visit.
- 7 supporting images: 3 face, left side, right side, back, udder.
- Total 12 images per visit.
- MongoDB metadata storage.
- Cloudinary image upload.
- DINOv2 average embedding from 5 muzzle crops.
- Pinecone vector upsert/search.
- Automatic same-cattle repeat visit handling.
- Admin cattle record browsing with image viewer.
- Admin ZIP download for selected cattle records.
- Admin merge tool for old duplicate cattle records.

## Important Current Behavior

When an agent starts a new capture:

- The field agent does not enter a cattle ID.
- Backend creates a cattle ID for a new cattle.
- If owner/GPS has exactly one existing cattle record, backend automatically reuses that cattle ID and creates a new date/session folder.
- If the owner has multiple possible cattle, the app does not guess. It waits for muzzle matching after 5 muzzle photos.
- If DINOv2 score is at least 70%, the visit moves into the matched existing cattle folder.
- If score is below 70%, the new cattle ID remains.

## Default Demo Login

Default admin is created automatically when no users exist:

```text
ID/phone: admin
Password: admin123
```

Agents are created by the admin inside the app.

## Run With Docker

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose up -d --build
```

Open:

```text
http://localhost:3000
```

## Run Without Docker

See `docs/NO_DOCKER_SETUP.md` for full steps. Short version:

Terminal 1:

```powershell
cd "F:\vacapay\vacapay muzzle\backend"
pnpm install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:PYTHON_BIN=(Resolve-Path .\.venv\Scripts\python.exe).Path
node src/server.js
```

Terminal 2:

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm install
pnpm start
```

Open:

```text
http://localhost:4200
```

## Mobile Camera Testing

Camera on mobile needs HTTPS. Use the bundled Cloudflare tunnel:

```powershell
cd "F:\vacapay\vacapay muzzle"
.\tools\cloudflared.exe tunnel --url http://localhost:3000
```

Open the generated HTTPS URL on mobile.

## Models

Required files:

```text
best_v4.pt
backend/dinov2_triplet_v2_best.pt
```

These files are large and should be handled with Git LFS or shared separately if missing on another system.

## Environment

Copy `.env.example` to `.env`, then fill MongoDB, Cloudinary, and Pinecone values.

Do not commit `.env`.
