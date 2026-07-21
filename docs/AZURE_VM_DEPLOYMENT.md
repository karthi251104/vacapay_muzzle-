# Azure Linux VM Backend Deployment

This runbook deploys the Vacapay backend and optional bundled admin UI to an
Azure Linux virtual machine. It does **not** migrate image storage to Azure
Blob Storage. The production services remain:

```text
Azure Linux VM       Node/Express API, DINOv2 and backend YOLO
MongoDB Atlas        users, farmers, cattle, searches and reviews
Cloudinary           permanent cattle and search images
Pinecone             enrolment and cattle-search vectors
Netlify (optional)   administrator website
Android APK          field capture and offline queue
```

The VM's local disk is only for application files, model files, temporary
uploads and logs. Cloudinary remains the permanent image store.

## 1. Recommended VM

Use Ubuntu 22.04 LTS or Ubuntu 24.04 LTS on x64 architecture.

Minimum controlled field-test size:

```text
4 vCPU
8 GB RAM
40 GB Premium SSD
```

DINOv2, PyTorch and YOLO share memory during enrolment and search. Do not use a
512 MB or 1 GB VM. Begin with 8 GB RAM and observe peak memory under concurrent
uploads before reducing the size.

Azure resources required:

```text
Linux virtual machine
Static public IP
Network security group
DNS record for the backend domain
```

An Azure Storage Account is not required while Cloudinary is used.

## 2. Network Rules

Allow these inbound ports in the Azure network security group:

```text
22/tcp   SSH, restricted to administrator IP addresses
80/tcp   HTTP, used for certificate issuance and redirect
443/tcp  HTTPS API traffic
```

Do not expose port `3000` publicly. Nginx listens on ports 80/443 and proxies
requests to Express on `127.0.0.1:3000`.

The VM needs outbound HTTPS access to:

```text
MongoDB Atlas
Cloudinary
Pinecone
GitHub or the private model download location
Ubuntu and Node package repositories
```

Add the VM public IP to MongoDB Atlas Network Access. Prefer one exact `/32`
address instead of allowing every address.

## 3. DNS

Create an `A` record such as:

```text
api.vacapay.example.com -> <VM static public IP>
```

Wait for DNS resolution before requesting the TLS certificate.

## 4. Base VM Installation

Connect with SSH:

```bash
ssh azureuser@<VM_PUBLIC_IP>
```

Install Docker and deployment tools:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git git-lfs nginx ufw
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
rm /tmp/get-docker.sh
sudo usermod -aG docker "$USER"
git lfs install
sudo systemctl enable --now docker nginx
```

Log out and reconnect once so the Docker group membership takes effect.

Enable the host firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 5. Clone And Provision Models

Install the application under `/opt/vacapay`:

```bash
sudo mkdir -p /opt/vacapay
sudo chown "$USER":"$USER" /opt/vacapay
git clone https://github.com/karthi251104/vacapay_muzzle-.git /opt/vacapay/app
cd /opt/vacapay/app
git lfs pull
```

Required backend model files:

```text
backend/dinov2_triplet_v2_best.pt
backend/yolo26s.pt
```

Required Android field-build model:

```text
frontend/src/assets/models/yolo26s_float32.tflite
```

Model binaries should be delivered through Git LFS or a private release/model
store. Do not place private model URLs or credentials in source control.

Verify the backend models before building:

```bash
cd /opt/vacapay/app
test -s backend/dinov2_triplet_v2_best.pt
test -s backend/yolo26s.pt
sha256sum backend/dinov2_triplet_v2_best.pt backend/yolo26s.pt
```

Record approved checksums in the private release record so an accidental or
partial model replacement is detected before deployment.

## 6. Production Environment File

Create a root environment file that is readable only by administrators:

```bash
cd /opt/vacapay/app
sudo install -m 600 /dev/null /etc/vacapay.env
sudo nano /etc/vacapay.env
```

Add values supplied privately by the project owner:

```dotenv
NODE_ENV=production
PORT=3000
REQUIRE_PRODUCTION_SERVICES=true

JWT_SECRET=<at-least-32-random-characters>
INITIAL_ADMIN_PASSWORD=<unique-password-at-least-12-characters>
INITIAL_ADMIN_PHONE=admin
INITIAL_ADMIN_AGENT_ID=ADMIN-001
INITIAL_ADMIN_NAME=Administrator

MONGODB_URI=<mongodb-atlas-uri>
MONGODB_DB_NAME=vacapay

CLOUDINARY_CLOUD_NAME=<cloud-name>
CLOUDINARY_API_KEY=<api-key>
CLOUDINARY_API_SECRET=<api-secret>
CLOUDINARY_ROOT_FOLDER=vacapay

PINECONE_API_KEY=<api-key>
PINECONE_INDEX_HOST=<index-host>
PINECONE_NAMESPACE=vacapay
PINECONE_ENROLMENT_NAMESPACE=vacapay-cattle-enrolment
PINECONE_SEARCH_NAMESPACE=vacapay-cattle-search

EMBEDDING_MATCH_THRESHOLD=0.70
MUZZLE_IMAGE_COUNT=3
YOLO_IMGSZ=704
MUZZLE_CONF=0.70
MUZZLE_BAD_CONF=0.25
MUZZLE_WET_CONF=0.25
MUZZLE_BAD_DOMINANCE_MARGIN=0.12
MUZZLE_MIN_SHARPNESS=18
PHONE_TFLITE_MODEL_VERSION=yolo26s_float32.tflite

CORS_ORIGINS=https://<admin-netlify-domain>,capacitor://localhost,https://localhost
```

Important:

- Do not set Windows paths such as `E:\vacapay` on Linux.
- Do not set `PYTHON_BIN` when using the supplied Docker image.
- Keep `CLOUDINARY_*`; do not add Azure Blob variables for this deployment.
- Do not include a trailing slash in a CORS origin.
- Remove initial admin bootstrap credentials after the administrator exists if
  the current backend release no longer needs them.
- Rotate any credential that has appeared in a screenshot, repository, build
  log or chat message.

## 7. Recommended Docker Deployment

Build the image on the VM:

```bash
cd /opt/vacapay/app
docker build --pull -t vacapay-backend:$(git rev-parse --short HEAD) .
docker tag vacapay-backend:$(git rev-parse --short HEAD) vacapay-backend:current
```

Create persistent runtime directories:

```bash
sudo mkdir -p /var/lib/vacapay/data /var/log/vacapay
sudo chown -R "$USER":"$USER" /var/lib/vacapay /var/log/vacapay
```

Start the container:

```bash
docker rm -f vacapay-backend 2>/dev/null || true
docker run -d \
  --name vacapay-backend \
  --restart unless-stopped \
  --env-file /etc/vacapay.env \
  -p 127.0.0.1:3000:3000 \
  -v /var/lib/vacapay/data:/app/data \
  vacapay-backend:current
```

Check startup and health:

```bash
docker logs --tail 200 vacapay-backend
curl --fail http://127.0.0.1:3000/api/health
curl --fail http://127.0.0.1:3000/api/version
docker stats --no-stream vacapay-backend
```

Do not continue to DNS/TLS validation unless health returns HTTP 200.

## 8. Nginx And HTTPS

Create `/etc/nginx/sites-available/vacapay`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.vacapay.example.com;

    client_max_body_size 40m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 240s;
        proxy_read_timeout 240s;
    }
}
```

Enable it:

```bash
sudo ln -sfn /etc/nginx/sites-available/vacapay /etc/nginx/sites-enabled/vacapay
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Install Certbot and request TLS:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.vacapay.example.com
sudo certbot renew --dry-run
```

Verify externally:

```bash
curl --fail https://api.vacapay.example.com/api/health
curl --fail https://api.vacapay.example.com/api/version
```

## 9. Netlify And Android Connection

For the Netlify administrator website, set:

```text
VACAPAY_API_BASE_URL=https://api.vacapay.example.com/api
VACAPAY_MEDIA_BASE_URL=https://api.vacapay.example.com
```

Add the exact Netlify domain to `CORS_ORIGINS` in `/etc/vacapay.env`, then
restart the backend container:

```bash
docker restart vacapay-backend
```

For Android, build with the stable Azure backend URL. A new APK is required
when the compiled API URL changes:

```powershell
$env:VACAPAY_API_BASE_URL="https://api.vacapay.example.com/api"
$env:VACAPAY_MEDIA_BASE_URL="https://api.vacapay.example.com"
pnpm --dir frontend run build:field
pnpm --dir frontend exec cap sync android
```

## 10. Deploy An Update

Create a versioned image and keep the previous one for rollback:

```bash
cd /opt/vacapay/app
git fetch origin
git switch main
git pull --ff-only origin main
git lfs pull
NEW_TAG=$(git rev-parse --short HEAD)
docker build -t "vacapay-backend:$NEW_TAG" .
docker tag "vacapay-backend:$NEW_TAG" vacapay-backend:current
docker rm -f vacapay-backend
docker run -d \
  --name vacapay-backend \
  --restart unless-stopped \
  --env-file /etc/vacapay.env \
  -p 127.0.0.1:3000:3000 \
  -v /var/lib/vacapay/data:/app/data \
  vacapay-backend:current
curl --fail http://127.0.0.1:3000/api/health
```

Before field use, also test one admin login, one enrolment upload and one
cattle search using controlled test records.

## 11. Rollback

List available images:

```bash
docker images vacapay-backend
```

Replace `<PREVIOUS_TAG>` with the previous Git commit tag:

```bash
docker rm -f vacapay-backend
docker run -d \
  --name vacapay-backend \
  --restart unless-stopped \
  --env-file /etc/vacapay.env \
  -p 127.0.0.1:3000:3000 \
  -v /var/lib/vacapay/data:/app/data \
  "vacapay-backend:<PREVIOUS_TAG>"
curl --fail http://127.0.0.1:3000/api/health
```

Application rollback does not delete MongoDB, Cloudinary or Pinecone data.
Never run the field-data reset command as part of deployment or rollback.

## 12. Logs And Monitoring

Useful commands:

```bash
docker ps --filter name=vacapay-backend
docker logs --tail 200 vacapay-backend
docker logs -f vacapay-backend
docker stats vacapay-backend
free -h
df -h
sudo journalctl -u nginx --since '30 minutes ago'
sudo tail -n 200 /var/log/nginx/error.log
```

Monitor at minimum:

```text
/api/health availability
HTTP 5xx rate
container restarts
memory and disk usage
embedding duration
Cloudinary upload failures
Pinecone query/upsert failures
MongoDB connection failures
pending field uploads
```

An uptime monitor can call `https://api.vacapay.example.com/api/health` every
one to five minutes. Never expose secrets or full stack traces in health output.

## 13. Backup And Data Ownership

Permanent data is not stored solely on the VM:

```text
MongoDB Atlas  enable backups appropriate to the selected Atlas plan
Cloudinary     retain production assets and restrict destructive API access
Pinecone       preserve separate enrolment and search namespaces
VM             back up only configuration and operational logs as required
```

Keep an encrypted backup of `/etc/vacapay.env` in an approved secret manager.
Do not commit it. Model artifacts and their checksums must also be retained in a
private release location.

## 14. Native systemd Alternative

Docker is preferred because it pins Node and Python dependencies. If Docker
cannot be used, install Node.js 24, Python 3.11, CPU PyTorch, torchvision,
OpenCV, Pillow and NumPy; then create a systemd unit that runs
`node backend/src/server.js` with `EnvironmentFile=/etc/vacapay.env`.

The service must set these Linux paths:

```dotenv
PYTHON_BIN=/opt/vacapay/app/.venv/bin/python
DINOV2_MODEL_PATH=/opt/vacapay/app/backend/dinov2_triplet_v2_best.pt
YOLO_MUZZLE_MODEL_PATH=/opt/vacapay/app/backend/yolo26s.pt
```

Native deployment requires more manual dependency management and should only
be used when the Docker path is unavailable.

## 15. Production Release Checklist

```text
[ ] VM has at least 8 GB RAM and a static public IP
[ ] SSH is restricted and port 3000 is not public
[ ] DNS and HTTPS are valid
[ ] MongoDB allows only required network access
[ ] Cloudinary credentials work; Azure Blob is not configured
[ ] Pinecone enrolment and search namespaces are separate
[ ] DINOv2 and yolo26s.pt checksums match the approved release
[ ] /api/health and /api/version return HTTP 200
[ ] Netlify origin is present in CORS_ORIGINS
[ ] Android APK contains the stable Azure API URL
[ ] one enrolment, one search and one admin review pass
[ ] logs contain no credentials or unnecessary stack traces
[ ] previous Docker image remains available for rollback
```
