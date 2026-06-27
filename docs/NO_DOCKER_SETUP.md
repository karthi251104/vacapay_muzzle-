# Run Without Docker

Use this guide when a teammate wants to work on UI or backend without Docker Desktop.

## 1. Required Software

Install these on the system:

- Git
- Node.js 20 or newer
- pnpm
- Python 3.10 or newer
- Visual C++ Build Tools may be needed for some Python packages on Windows

Check versions:

```powershell
git --version
node --version
pnpm --version
python --version
```

If pnpm is missing:

```powershell
npm install -g pnpm
```

## 2. Clone Project

```powershell
git clone https://github.com/karthi251104/vacapay_muzzle-.git
cd "vacapay_muzzle-"
```

If the folder name is different, use that folder in all commands.

## 3. Required Model Files

These files must exist:

```text
best_v4.pt
backend/dinov2_triplet_v2_best.pt
```

If Git LFS is configured:

```powershell
git lfs install
git lfs pull
```

If files are still missing, get them from the project owner and place them in the exact paths above.

## 4. Environment File

Copy `.env.example` to `.env`:

```powershell
Copy-Item .env.example .env
```

Fill these values if available:

```text
MONGODB_URI=...
MONGODB_DB_NAME=vacapay
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CLOUDINARY_ROOT_FOLDER=vacapay
PINECONE_API_KEY=...
PINECONE_INDEX_HOST=...
PINECONE_NAMESPACE=vacapay
EMBEDDING_MATCH_THRESHOLD=0.70
YOLO_IMGSZ=640
MUZZLE_CONF=0.55
```

For UI-only work, MongoDB/Cloudinary/Pinecone can be absent, but backend features will be limited.

## 5. Install Node Packages

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

## 6. Install Python Packages

From backend folder:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

If PowerShell blocks activation:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Then run activation again.

## 7. Start Backend

Terminal 1:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
$env:PYTHON_BIN=(Resolve-Path .\.venv\Scripts\python.exe).Path
$env:MODEL_PATH=(Resolve-Path ..\best_v4.pt).Path
$env:DINOV2_MODEL_PATH=(Resolve-Path .\dinov2_triplet_v2_best.pt).Path
node src/server.js
```

Backend should show:

```text
Muzzle backend listening on http://localhost:3000
```

Health check in another terminal:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

## 8. Start Frontend

Terminal 2:

```powershell
cd frontend
pnpm start
```

Open:

```text
http://localhost:4200
```

The frontend proxy sends `/api` and `/media` to backend port 3000.

## 9. UI-Only Work Without Backend Models

If the teammate only changes UI, they can still run frontend:

```powershell
cd frontend
pnpm start
```

But login and capture require backend. For pure UI design, edit these files:

```text
frontend/src/app/app.component.html
frontend/src/app/app.component.css
frontend/src/app/app.component.ts
```

## 10. Mobile Camera Test Without Docker

Camera on mobile needs HTTPS. If running frontend on 4200:

```powershell
cd <project-root>
.\tools\cloudflared.exe tunnel --url http://localhost:4200
```

Open the generated HTTPS URL on mobile.

If testing the production-style Docker/single-port app, tunnel port 3000 instead.

## 11. Common Problems

### Port 3000 already used

```powershell
netstat -ano | findstr :3000
tasklist /FI "PID eq <PID>"
```

Stop that process or change backend port.

### Camera permission denied

Use HTTPS tunnel URL on mobile. Browser camera usually fails on plain `http://192.168...`.

### YOLO/torch import error

Activate backend virtual environment and reinstall requirements:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

### Model file missing

Confirm:

```powershell
Test-Path ..\best_v4.pt
Test-Path .\dinov2_triplet_v2_best.pt
```

### MongoDB connection fails

Check Atlas network access and username/password. For demo UI work, remove `MONGODB_URI` from `.env` and local JSON fallback will be used.

## 12. Build Check

Frontend build:

```powershell
cd frontend
pnpm build
```

Backend syntax check:

```powershell
cd ..
node --check backend/src/server.js
```
