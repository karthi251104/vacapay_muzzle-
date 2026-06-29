# Vacapay Muzzle Demo

Vacapay Muzzle is a mobile-first cattle muzzle field-testing app for agents and admins. Field agents add or search farmers, capture GPS and cattle photos, the backend crops muzzle images with YOLO, creates DINOv2 muzzle embeddings, searches farmer cattle plus the full saved muzzle database, and saves same-cattle matches separately as duplicate evidence for clean testing.

## Documentation

Current project process, reset status, demo flow, duplicate evidence behavior, and implementation summary are in:

```text
docs/FIELD_TESTING_PROGRESS.md
```

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
- Add new farmer flow with required GPS.
- Existing farmer search by GPS, farmer name, or farmer ID.
- Farmer cattle lookup before capture.
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
- Muzzle matching against selected farmer cattle records and all saved muzzle records.
- Top 1 and Top 5 match result tracking.
- Duplicate same-cattle captures saved separately as duplicate evidence.
- Admin testing registry split into unique cattle database and duplicate capture evidence.
- Admin cattle record browsing with image viewer.
- Admin ZIP download for selected cattle records.

## Important Current Behavior

When an agent starts a new capture:

- The agent first adds a new farmer or searches an existing farmer by GPS/name/ID.
- GPS is required before cattle capture starts.
- Backend creates a cattle ID for the new capture.
- After 5 muzzle photos, the backend checks the selected farmer cattle records first.
- The backend also checks all saved muzzle records in the wider database.
- Match results are tagged as `farmer_cattle` or `all_other_muzzle`.
- Top 1 and Top 5 candidates are stored for testing and review.
- If DINOv2 score is at least 70%, the new capture is saved separately as duplicate evidence and linked to the matched original cattle.
- If score is below 70%, the new cattle remains in the unique cattle database.

## Field Testing Progress

For the current field-testing process, demo sequence, reset status, duplicate evidence behavior, and implementation summary, see:

```text
docs/FIELD_TESTING_PROGRESS.md
```

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

Short local run version:

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
