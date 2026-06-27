# Teammate Handoff

This project is a mobile-first cattle enrollment and muzzle matching demo app.

The fastest way to understand it:

1. Read `docs/PROJECT_PROCESS.md`.
2. Run the app using `docs/NO_DOCKER_SETUP.md` if Docker is not available.
3. UI teammates should read `docs/UI_HANDOFF.md`.
4. Use `docs/RUN_COMMANDS.md` for copy-paste commands.

## What The App Is For

Field agents capture cattle images in the field. The backend stores photos and metadata, processes muzzle images, and tries to identify whether a later visit is the same cattle or a new cattle.

## Who Uses It

- Admin: creates agents, manages records, views/downloads images, reviews/merges records.
- Field agent: captures cattle visits on mobile.
- Farmer/owner: does not use the app directly.

## Current Implementation

Implemented:

- admin login
- agent creation
- agent login
- field-agent mobile flow
- owner ID + GPS based nearby search
- camera capture
- YOLO muzzle crop
- CLAHE enhancement
- 12-image visit capture
- MongoDB metadata
- Cloudinary image upload
- DINOv2 average embedding
- Pinecone search
- same-cattle auto folder reuse
- admin image viewer
- admin ZIP download
- admin duplicate merge

## Important Business Behavior

The agent does not type cattle ID.

The backend decides:

- reuse existing cattle folder if there is one clear owner/GPS match
- use DINOv2 muzzle matching if there are multiple possible cattle
- keep a new cattle ID if confidence is below threshold

## Main Files For UI Work

```text
frontend/src/app/app.component.html
frontend/src/app/app.component.css
frontend/src/app/app.component.ts
frontend/src/app/api.service.ts
```

## Main Files For Backend Work

```text
backend/src/server.js
backend/scripts/yolo_crop_clahe.py
backend/scripts/embedding_average.py
backend/scripts/yolo_status.py
backend/scripts/embedding_status.py
```

## Local Run Without Docker

Backend terminal:

```powershell
cd "F:\vacapay\vacapay muzzle\backend"
.\.venv\Scripts\Activate.ps1
$env:PYTHON_BIN=(Resolve-Path .\.venv\Scripts\python.exe).Path
node src/server.js
```

Frontend terminal:

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm start
```

Open:

```text
http://localhost:4200
```

## Local Run With Docker

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose up -d --build
```

Open:

```text
http://localhost:3000
```

## Demo Login

```text
ID/phone: admin
Password: admin123
```

## Before Sending Changes Back

Run:

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm build
```

If backend changed:

```powershell
cd "F:\vacapay\vacapay muzzle"
node --check backend/src/server.js
```
