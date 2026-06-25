# Run Commands

## UI Only

Use this for design/UI teammate work.

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm install
pnpm start
```

Open:

```text
http://localhost:4200
```

## Backend Only

```powershell
cd "F:\vacapay\vacapay muzzle\backend"
node src/server.js
```

Health check:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

## Full Local Without Docker

Terminal 1:

```powershell
cd "F:\vacapay\vacapay muzzle\backend"
node src/server.js
```

Terminal 2:

```powershell
cd "F:\vacapay\vacapay muzzle\frontend"
pnpm start
```

Frontend:

```text
http://localhost:4200
```

Backend:

```text
http://localhost:3000
```

## Full App With Docker

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose up -d
```

Health check:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

Stop:

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose down
```

Rebuild:

```powershell
cd "F:\vacapay\vacapay muzzle"
$env:Path="D:\Docker\Desktop\resources\bin;" + $env:Path
docker compose up -d --build
```

Logs:

```powershell
docker logs -f vacapay-app
```

## Mobile Testing Through Tunnel

```powershell
cd "F:\vacapay\vacapay muzzle"
.\tools\cloudflared.exe tunnel --url http://localhost:3000
```

Then open the generated `https://...trycloudflare.com` URL on mobile.

## Useful Checks

YOLO status:

```powershell
Invoke-RestMethod http://localhost:3000/api/yolo/status
```

Embedding status:

```powershell
Invoke-RestMethod http://localhost:3000/api/embedding/status
```

Pinecone status:

```powershell
Invoke-RestMethod http://localhost:3000/api/pinecone/status
```
