# Vacapay

Demo implementation for field cattle enrollment and muzzle search preparation.
## Documentation Map

Team handoff docs are in:

- `F:\vacapay\vacapay muzzle\docs\TEAMMATE_HANDOFF.md`
- `F:\vacapay\vacapay muzzle\docs\ARCHITECTURE.md`
- `F:\vacapay\vacapay muzzle\docs\WORKFLOWS.md`
- `F:\vacapay\vacapay muzzle\docs\SETUP_LOCAL.md`
- `F:\vacapay\vacapay muzzle\docs\RUN_COMMANDS.md`
- `F:\vacapay\vacapay muzzle\docs\DEPLOYMENT.md`

## What is implemented now

- Angular field-officer enrollment UI.
- Admin login and agent creation UI.
- Agent login before field capture.
- Live camera muzzle auto-capture flow until 5 muzzle images are accepted.
- Node.js backend for storing cattle image folders and metadata.
- MongoDB Atlas metadata storage when `MONGODB_URI` is configured, with local JSON fallback for offline demo.
- YOLO muzzle crop using `best_v4.pt` with `imgsz=640`.
- CLAHE enhancement after muzzle crop.
- Optional Cloudinary upload for every accepted processed image.
- DINOv2 triplet embedding model configured at `backend/dinov2_triplet_v2_best.pt`.
- Embedding match confidence threshold configured at `70%`.
- Optional Pinecone vector storage/search when `PINECONE_API_KEY` and `PINECONE_INDEX_HOST` are configured.
- Docker packaging for backend, frontend build, Python inference dependencies, mounted model files, MongoDB, Cloudinary, and Pinecone env.
- MongoDB match audit storage in `match_audits`.
- Admin review screen for uncertain matches near the `70%` threshold.
- Manual capture/upload slots for face, left side, right side, back, and udder.

## Required local software

- Node.js 20+
- pnpm or npm
- Python 3.10+
- Python packages: `ultralytics`, `opencv-python`, `numpy`

Install Python packages:

```bash
python -m pip install ultralytics opencv-python numpy
```

Install app packages:

```bash
pnpm install:all
```

Run backend:

```bash
pnpm dev:backend
```

Run frontend:

```bash
pnpm dev:frontend
```

Open:

```text
http://localhost:4200
```

## Mobile Preview With Dev Tunnels

Run the backend first:

```powershell
cd "<your-folder>\vacapay\backend"
$env:PYTHON_BIN="C:\Users\dev1x\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
C:\Users\dev1x\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe src/server.js
```

Run the frontend in another terminal:

```powershell
cd "<your-folder>\vacapay\frontend"
$env:Path="C:\Users\dev1x\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
C:\Users\dev1x\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd start
```

Create a dev tunnel/public forwarded port for:

```text
4200
```

Open the generated HTTPS tunnel URL on mobile. The frontend uses relative `/api` and `/media` paths, so the single `4200` tunnel proxies backend requests to local port `3000`.

Camera access on mobile requires HTTPS, so use the HTTPS tunnel URL instead of a plain local IP URL.

## Demo Login

Default admin:

```text
ID/phone: admin
Password: admin123
```

Admin can create field agents with:

```text
agent name
phone number
agent ID
temporary password
```

Agents then log in with their phone number or agent ID and password. Capture sessions store the logged-in agent ID/name in the enrollment metadata.

## Cloudinary Image Storage

The backend saves processed images locally first, then uploads the same accepted image to Cloudinary when these environment variables are present:

```powershell
$env:CLOUDINARY_CLOUD_NAME="dcoblsomz"
$env:CLOUDINARY_API_KEY="448473262611422"
$env:CLOUDINARY_API_SECRET="paste-your-current-secret-here"
$env:CLOUDINARY_ROOT_FOLDER="vacapay"
```

Cloudinary folder structure:

```text
vacapay/
  cattle-id/
    yyyy-mm-dd/
      muzzle1
      muzzle2
      face1
      leftside
      ...
```

The metadata stores each image's local path, preview URL, Cloudinary `secureUrl`, `publicId`, size, width, and height. With MongoDB enabled, this image reference object is stored in MongoDB.

## MongoDB Atlas Metadata

The backend uses MongoDB Atlas when `MONGODB_URI` is set:

```powershell
$env:MONGODB_URI="mongodb+srv://USER:PASSWORD@HOST/?appName=Cluster0"
$env:MONGODB_DB_NAME="vacapay"
```

If the `mongodb+srv://` URI fails on Windows DNS, use the standard non-SRV URI from Atlas instead:

```powershell
$env:MONGODB_URI="mongodb://USER:PASSWORD@HOST1:27017,HOST2:27017,HOST3:27017/?ssl=true&authSource=admin&replicaSet=REPLICA_SET&retryWrites=true&w=majority&appName=Cluster0"
```

Collections created automatically:

```text
users
cattle
```

Indexes created automatically:

```text
users.userId unique
users.agentId unique
users.phone unique
cattle.cattleId unique
cattle.farmerName
cattle.location 2dsphere
```

If `MONGODB_URI` is not set, the app keeps using local JSON files in `data/`.

On first MongoDB start, if the MongoDB collections are empty, the backend imports existing local `data/enrollments.json` and `data/users.json`.

## DINOv2 Muzzle Matching Flow

After the 5th muzzle crop is accepted:

1. Backend runs `backend/scripts/embedding_average.py`.
2. The script loads `backend/dinov2_triplet_v2_best.pt`.
3. It creates one normalized embedding for each of the 5 muzzle crops.
4. It averages the 5 embeddings and normalizes the average.
5. Backend upserts the vector to Pinecone when Pinecone is configured.
6. Backend queries Pinecone for top vector matches, then filters to same farmer/location radius.
7. If Pinecone is not configured or fails, backend falls back to local cosine comparison.
8. If the best score is at least `70%`, the session is moved into that existing cattle ID folder.
9. If the best score is below `70%`, the new cattle ID is kept.
10. The match decision, confidence score, top 5 candidates, and embedding metadata are stored with the capture session.

The field officer does not manually choose the correct cow. The nearby registered cattle list is only context; DINOv2 makes the decision after the 5 muzzle images.

## Pinecone Vector Search

Create one Pinecone serverless index:

```text
Index name: vacapay
Dimension: 768
Metric: cosine
```

Set these variables before backend start:

```powershell
$env:PINECONE_API_KEY="your-pinecone-api-key"
$env:PINECONE_INDEX_HOST="https://vacapay-u1fuv30.svc.aped-4627-b74a.pinecone.io"
$env:PINECONE_NAMESPACE="vacapay"
```

Check status:

```powershell
Invoke-RestMethod http://localhost:3000/api/pinecone/status
```

The vector ID format is:

```text
cattleId__sessionId
```

Pinecone metadata includes cattle ID, session ID, farmer name, normalized farmer name, field officer, location, capture date, and folder location.

## Admin Match Review

Admins can review uncertain DINOv2 decisions from the admin console.

The backend stores each match decision in MongoDB:

```text
match_audits
```

Review API:

```text
GET  /api/reviews/matches
POST /api/reviews/matches/:auditId
```

The screen shows:

```text
final cattle ID
decision
confidence
threshold
farmer/officer/date
top 5 matches
captured image links
confirm / correct to top 1
```

## Docker Run

Create `.env` from `.env.example`:

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill MongoDB, Cloudinary, and Pinecone secrets in `.env`, then run:

```powershell
docker compose up --build
```

Open:

```text
http://localhost:3000
```

The Docker container mounts:

```text
./data
./best_v4.pt
./backend/dinov2_triplet_v2_best.pt
```

## Defaults

The backend automatically loads the root `.env` file:

```text
<your-folder>\vacapay\.env
```

Use this file for MongoDB, Cloudinary, Pinecone, YOLO, and DINOv2 settings. The `.env` file is ignored by git.

The backend expects the model at:

```text
<your-folder>\vacapay\best_v4.pt
```

The embedding model is expected at:

```text
<your-folder>\vacapay\backend\dinov2_triplet_v2_best.pt
```

The current embedding match threshold is:

```text
70%
```

Override if needed:

```bash
MODEL_PATH="<your-folder>\vacapay\best_v4.pt" pnpm dev:backend
```

Saved demo data goes into:

```text
data/
  enrollments.json
  cattle-id/
    muzzle1.jpg
    ...
```

When Cloudinary is enabled, demo images are also uploaded to the configured Cloudinary account.

## Still To Be Done

- End-to-end field test on mobile with one new cow, then the same cow again.
- Install Docker Desktop if Docker validation/run is needed on this laptop.

