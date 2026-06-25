# Local Setup

## 1. Prerequisites

### For UI work only

- Node.js
- npm or pnpm

### For full app without Docker

- Node.js
- npm or pnpm
- Python 3.10+

### For full app with Docker

- Docker Desktop

## 2. Important Files Needed

These files must exist for full ML flow:

- `F:\vacapay\vacapay muzzle\best_v4.pt`
- `F:\vacapay\vacapay muzzle\backend\dinov2_triplet_v2_best.pt`

## 3. Environment File

Main env file:

- `F:\vacapay\vacapay muzzle\.env`

Important variables include:

- `PORT`
- `PYTHON_BIN`
- `MODEL_PATH`
- `DINOV2_MODEL_PATH`
- `YOLO_IMGSZ`
- `MUZZLE_CONF`
- `EMBEDDING_MATCH_THRESHOLD`
- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `PINECONE_API_KEY`
- `PINECONE_INDEX_HOST`
- `PINECONE_NAMESPACE`

## 4. Install For Frontend-Only Work

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
npm install
```

or

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm install
```

## 5. Install For Backend-Only Work

```powershell
cd "F:\vacapay\vacapay muzzle\backend"
npm install
```

Install Python packages:

```powershell
python -m pip install -r requirements.txt
```

## 6. Install For Full Root Workspace

```powershell
cd "F:\vacapay\vacapay muzzle"
pnpm install
pnpm install:all
```

## 7. Docker Setup

Docker Desktop should be installed and running.

Optional path used on this laptop:

- `D:\Docker\Desktop`
