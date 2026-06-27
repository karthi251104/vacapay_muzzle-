# Run Commands

This file is the quick command sheet. For explanations, read `docs/NO_DOCKER_SETUP.md`.

## Project Root

```powershell
cd "F:\vacapay\vacapay muzzle"
```

## Install All Node Packages

```powershell
pnpm install:all
```

## Run Without Docker

### Terminal 1: Backend

```powershell
cd "F:\vacapay\vacapay muzzle\backend"
.\.venv\Scripts\Activate.ps1
$env:PYTHON_BIN=(Resolve-Path .\.venv\Scripts\python.exe).Path
$env:MODEL_PATH=(Resolve-Path ..\best_v4.pt).Path
$env:DINOV2_MODEL_PATH=(Resolve-Path .\dinov2_triplet_v2_best.pt).Path
node src/server.js
```

Backend opens on:

```text
http://localhost:3000
```

### Terminal 2: Frontend

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm start
```

Frontend opens on:

```text
http://localhost:4200
```

## First-Time No-Docker Python Setup

```powershell
cd "F:\vacapay\vacapay muzzle\backend"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Run With Docker

Start/rebuild:

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose up -d --build
```

Open:

```text
http://localhost:3000
```

Stop:

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose down
```

Logs:

```powershell
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker logs -f vacapay-app
```

## Health and Model Checks

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/yolo/status
Invoke-RestMethod http://localhost:3000/api/embedding/status
Invoke-RestMethod http://localhost:3000/api/pinecone/status
```

## Build Checks

Frontend:

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm build
```

Backend syntax:

```powershell
cd "F:\vacapay\vacapay muzzle"
node --check backend/src/server.js
```

## Mobile Test Through HTTPS Tunnel

For Docker/single-port app:

```powershell
cd "F:\vacapay\vacapay muzzle"
.\tools\cloudflared.exe tunnel --url http://localhost:3000
```

For frontend dev server:

```powershell
cd "F:\vacapay\vacapay muzzle"
.\tools\cloudflared.exe tunnel --url http://localhost:4200
```

Open the generated HTTPS URL on mobile.

## Windows Port Debugging

Find process on port 3000:

```powershell
netstat -ano | findstr :3000
tasklist /FI "PID eq <PID>"
```

Find process on port 4200:

```powershell
netstat -ano | findstr :4200
tasklist /FI "PID eq <PID>"
```
