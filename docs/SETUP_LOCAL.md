# Local Setup

For the detailed no-Docker guide, read `docs/NO_DOCKER_SETUP.md`. This file is the shorter checklist.

## 1. Prerequisites

### UI-only work

- Git
- Node.js 20+
- pnpm

### Full app without Docker

- Git
- Node.js 20+
- pnpm
- Python 3.10+
- Python virtual environment
- model files

### Full app with Docker

- Docker Desktop
- model files
- `.env`

## 2. Required Model Files

These files must exist for the full AI flow:

```text
best_v4.pt
backend/dinov2_triplet_v2_best.pt
```

If they are missing, use Git LFS or get them from the project owner.

## 3. Environment File

Copy:

```powershell
Copy-Item .env.example .env
```

Fill values for:

```text
MONGODB_URI
MONGODB_DB_NAME
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
CLOUDINARY_ROOT_FOLDER
PINECONE_API_KEY
PINECONE_INDEX_HOST
PINECONE_NAMESPACE
EMBEDDING_MATCH_THRESHOLD
YOLO_IMGSZ
MUZZLE_CONF
```

Do not commit `.env`.

## 4. Install Node Packages

From project root:

```powershell
pnpm install:all
```

Or separately:

```powershell
cd backend
pnpm install
cd ..\frontend
pnpm install
```

## 5. Install Python Packages

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## 6. Run Without Docker

Backend terminal:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
$env:PYTHON_BIN=(Resolve-Path .\.venv\Scripts\python.exe).Path
$env:MODEL_PATH=(Resolve-Path ..\best_v4.pt).Path
$env:DINOV2_MODEL_PATH=(Resolve-Path .\dinov2_triplet_v2_best.pt).Path
node src/server.js
```

Frontend terminal:

```powershell
cd frontend
pnpm start
```

Open:

```text
http://localhost:4200
```

## 7. Run With Docker

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose up -d --build
```

Open:

```text
http://localhost:3000
```

## 8. Mobile Testing

Use HTTPS tunnel for camera permission:

```powershell
.\tools\cloudflared.exe tunnel --url http://localhost:3000
```

Open the generated URL on mobile.
