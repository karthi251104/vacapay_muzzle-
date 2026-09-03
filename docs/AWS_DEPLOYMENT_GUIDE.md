# AWS Deployment Guide — Vacapay Muzzle Backend

## What Changed And Why

This document explains every code change made for AWS ECS deployment and teaches
the concepts behind each one.

---

## 1. Dockerfile Changes

**File:** `Dockerfile`

### Change 1: Added `LABEL` instructions

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/karthi251104/vacapay_muzzle-" \
      org.opencontainers.image.description="Vacapay Muzzle backend: Node.js API + PyTorch DINOv2 + YOLO" \
      org.opencontainers.image.authors="vacapay-team"

ARG VERSION=dev
LABEL org.opencontainers.image.version=$VERSION
```

**What are labels?**

Labels are metadata stored inside the Docker image. Think of them as sticky notes
on a shipping container. They don't affect how the app runs — they help humans and
tools identify what's inside.

**Why we need them:**

When you have 10 Docker images in ECR, labels help you know:
- Which Git commit built this image (`VERSION`)
- Which repository it came from (`source`)
- Who maintains it (`authors`)

The `ARG VERSION=dev` lets the CI/CD pipeline pass the Git commit SHA:
```bash
docker build --build-arg VERSION=a1b2c3d .
```

### Change 2: Added `curl` to apt-get install

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv curl \
    && rm -rf /var/lib/apt/lists/*
```

**Why curl?**

The HEALTHCHECK instruction (below) uses `curl` to hit `/api/health`. Without
curl installed in the container, the health check command fails and ECS thinks
the container is unhealthy.

### Change 3: Added `HEALTHCHECK` instruction

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1
```

**What is HEALTHCHECK?**

Docker's built-in way to check if your app is alive. Without it, Docker only
knows the container process is running — it doesn't know if your Express server
crashed, if MongoDB connection failed, or if the app is stuck in an infinite loop.

**How it works step by step:**

```text
Container starts
     │
     ▼
Wait 120 seconds (start-period)
     │  ← PyTorch and DINOv2 models are loading during this time
     │    Your server.js takes ~60-90 seconds to start
     │
     ▼
Every 30 seconds, run: curl http://localhost:3000/api/health
     │
     ├── HTTP 200 returned → Container is HEALTHY ✅
     │
     └── Curl fails or HTTP error → Count as failure
          │
          ├── 1st failure → still healthy, try again in 30s
          ├── 2nd failure → still healthy, try again in 30s
          └── 3rd failure → Container is UNHEALTHY ❌
                              │
                              ▼
                         ECS kills this container
                         and starts a new one
```

**Why 120 seconds start period?**

Your app loads in this order:
1. Node.js starts (instant)
2. MongoDB connection (2-3 seconds)
3. Cloudinary config (instant)
4. Express routes registered (instant)
5. YOLO worker starts loading yolo26s.pt (~10 seconds)
6. DINOv2 model loads dinov2_triplet_v2_best.pt (~60-90 seconds)

Without the 120-second grace period, ECS would see health check failures during
step 5-6 and kill the container before it finishes starting. This is a common
mistake that causes infinite restart loops.

---

## 2. docker-compose.yml Changes

**File:** `docker-compose.yml`

### Added healthcheck section

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
  interval: 30s
  timeout: 10s
  start_period: 120s
  retries: 3
```

Same as the Dockerfile HEALTHCHECK but for docker compose. Lets you check
container health locally:

```bash
docker compose ps
# Shows: vacapay-app   healthy   Up 5 minutes
```

### Added YOLO model volume mount

```yaml
- ./backend/yolo26s.pt:/app/models/yolo26s.pt:ro
```

The original docker-compose.yml only mounted the DINOv2 model. The YOLO model
was missing. Without this, the container uses the model baked into the image
(which is fine), but mounting it as a volume lets you update the model without
rebuilding the entire Docker image.

`:ro` means read-only — the container can read the file but cannot modify it.

---

## 3. GitHub Actions CI/CD Pipeline

**File:** `.github/workflows/deploy.yml`

### What is GitHub Actions?

GitHub Actions is a CI/CD service built into GitHub. It runs code automatically
when events happen (push, pull request, schedule, manual trigger).

```text
You push code → GitHub runs your workflow → App gets deployed
```

### Key sections explained:

**Trigger:**
```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
```
- `push → main`: Auto-runs when you push to the main branch
- `workflow_dispatch`: Adds a "Run workflow" button in GitHub UI

**Steps flow:**

```text
Step 1: Checkout     → Downloads your code to the runner
Step 2: LFS Pull     → Downloads ML model files (353 MB + 20 MB)
Step 3: AWS Auth     → Logs into your AWS account
Step 4: ECR Login    → Gets permission to push Docker images
Step 5: Build+Push   → Builds Docker image and pushes to ECR
Step 6: Task Def     → Creates new ECS task definition revision
Step 7: Deploy       → Tells ECS to use the new task definition
Step 8: Verify       → Confirms deployment succeeded
```

**Critical setting:**
```yaml
wait-for-service-stability: true
```

This makes the pipeline WAIT until ECS confirms the new container is healthy.
Without it, the pipeline shows ✅ immediately even if the container crashes
30 seconds later. With it, if deployment fails, the pipeline shows ❌ and
ECS automatically rolls back to the previous working version.

### Required GitHub Secrets

Go to your GitHub repo → Settings → Secrets and variables → Actions → New secret:

| Secret Name | Where to find it |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM Console → Users → Your user → Security credentials |
| `AWS_SECRET_ACCESS_KEY` | Same place (shown only once when created) |
| `AWS_ACCOUNT_ID` | Top-right corner of AWS Console |

---

## 4. ECS Task Definition

**File:** `aws/task-definition.json`

### What is a Task Definition?

A Task Definition is your `docker-compose.yml` translated for AWS. It tells ECS:
- Which Docker image to run
- How much CPU and RAM to give it
- What environment variables to set
- Where to send logs
- How to check if it's healthy

### Key decisions explained:

**CPU and Memory:**
```json
"cpu": "2048",     // 2 vCPU (1024 units = 1 vCPU)
"memory": "7168"   // 7 GB RAM
```
Your m7i-flex.large has 8 GB total. We give 7 GB to the container and leave
~1 GB for the operating system and ECS agent.

**memoryReservation vs memory:**
```json
"memory": 7168,            // Hard limit — container is KILLED if it exceeds this
"memoryReservation": 4096  // Soft limit — ECS reserves 4 GB, allows burst to 7 GB
```
PyTorch normally uses ~4 GB but can spike during concurrent requests.

**Secrets from Secrets Manager:**
```json
"secrets": [
  {
    "name": "JWT_SECRET",
    "valueFrom": "arn:aws:secretsmanager:ap-south-1:YOUR_ACCOUNT_ID:secret:vacapay/production:JWT_SECRET::"
  }
]
```
Instead of storing `JWT_SECRET=abc123` in a file, ECS fetches it from Secrets
Manager at container startup. The secret is:
- Encrypted at rest (AES-256)
- Access is logged (CloudTrail)
- Never appears in your code or Docker image
- Can be rotated without redeploying

**Log Configuration:**
```json
"logConfiguration": {
  "logDriver": "awslogs",
  "options": {
    "awslogs-group": "/ecs/vacapay-backend"
  }
}
```
On Azure VM you used `docker logs vacapay-backend`. On AWS, all container
stdout/stderr goes to CloudWatch Logs. You can:
- Search logs: `aws logs filter-log-events --log-group-name /ecs/vacapay-backend`
- Tail logs: `aws logs tail /ecs/vacapay-backend --follow`
- Set alarms: Alert when "ERROR" appears in logs

---

## 5. AWS Setup Script

**File:** `aws/setup-infrastructure.sh`

This script creates all AWS resources in the correct order. It is meant to be
read and executed section by section:

| Phase | What it creates | Why |
|---|---|---|
| 1 | Verify CLI | Confirm AWS access works |
| 2 | ECR Repository | Private Docker image storage |
| 3 | VPC + Subnet + IGW + Routes + SG | Private network + firewall |
| 4 | IAM Roles | Permissions for ECS |
| 5 | Secrets Manager | Encrypted secret storage |
| 6 | ECS Cluster | Container management group |
| 7 | EC2 Instance | The actual machine running containers |
| 8 | Task Definition | Container configuration |
| 9 | ECS Service | Keeps container running + auto-restart |
| 10 | Build + Push image | Put your Docker image in ECR |

---

## File Summary

```text
MODIFIED FILES:
  Dockerfile           ← Added HEALTHCHECK, LABEL, curl
  docker-compose.yml   ← Added healthcheck, YOLO volume, build args

NEW FILES:
  .github/workflows/deploy.yml     ← CI/CD pipeline (auto-deploy on push)
  aws/task-definition.json         ← ECS container config
  aws/setup-infrastructure.sh      ← AWS resource creation commands
  docs/AWS_DEPLOYMENT_GUIDE.md     ← This file
```

---

## Quick Reference: Your Current vs New Architecture

```text
BEFORE (Azure VM):
  You SSH → git pull → docker build → docker run → pray 🙏
  One VM, one container, no auto-restart, no health checks

AFTER (AWS ECS):
  You git push → GitHub Actions builds → ECR stores → ECS deploys → auto-heals ✅
  VPC network, security groups, encrypted secrets, auto-restart, health checks
```

---

## Cost Summary (Free Tier / $200 Credits)

| Resource | Cost |
|---|---|
| m7i-flex.large EC2 (8 GB RAM) | ~$0.12/hr (covered by credits) |
| ECR storage (~2.5 GB image) | ~$0.25/month |
| CloudWatch Logs | Free tier: 5 GB |
| Secrets Manager (8 secrets) | ~$3.20/month |
| ECS control plane | FREE |
| GitHub Actions | FREE (2,000 min/month) |
| **Total if running 24/7** | **~$90/month (from $200 credits)** |
| **Total if running 8hr/day** | **~$32/month** |

**Tip:** Stop the EC2 instance when not learning. Stopped instances cost $0
(you only pay ~$0.80/month for the disk).
