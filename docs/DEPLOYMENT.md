# Deployment

## Why Docker Is Recommended For Server

Server deployment needs:

- Node runtime
- Python runtime
- OpenCV system libs
- Torch
- model files
- env vars

Docker keeps this consistent and avoids manual setup pain.

## Server Requirements

- Docker Desktop or Docker Engine
- Docker Compose
- project folder or git repo
- `.env`
- model files

## Required Files On Server

- project folder
- `.env`
- `best_v4.pt`
- `backend/dinov2_triplet_v2_best.pt`

## Server Start

```bash
docker compose up -d --build
```

## Server Restart After Update

```bash
docker compose down
docker compose up -d --build
```

## External Services Needed

### MongoDB Atlas

Need:

- connection string
- DB user
- network access configured

### Cloudinary

Need:

- cloud name
- api key
- api secret

### Pinecone

Need:

- api key
- index host
- index namespace

Recommended index:

```text
name: vacapay
dimension: 768
metric: cosine
```

## Suggested Production Additions Later

- Nginx reverse proxy
- SSL certificate
- real domain
- process monitoring
- backup plan for MongoDB and Cloudinary metadata
- CPU-only torch image optimization if GPU is not used
