# ════════════════════════════════════════════════════════════════
# Stage 1: Build Angular frontend (thrown away after build)
# ════════════════════════════════════════════════════════════════
FROM node:24-bookworm AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ════════════════════════════════════════════════════════════════
# Stage 2: Production runtime image
# ════════════════════════════════════════════════════════════════
FROM node:24-bookworm

# ── Metadata labels for ECR/ECS image identification ──────────
# These labels help you identify which Git commit an image was
# built from, and who maintains it. ECS and ECR display these.
LABEL org.opencontainers.image.source="https://github.com/karthi251104/vacapay_muzzle-" \
      org.opencontainers.image.description="Vacapay Muzzle backend: Node.js API + PyTorch DINOv2 + YOLO" \
      org.opencontainers.image.authors="vacapay-team"

ARG VERSION=dev
LABEL org.opencontainers.image.version=$VERSION

WORKDIR /app

# ── Install Python + curl ─────────────────────────────────────
# python3: Required for PyTorch, DINOv2, YOLO ML model inference
# curl: Required by the HEALTHCHECK instruction below so Docker
#       (and ECS) can verify the app is alive via /api/health
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON_BIN=/app/.venv/bin/python
ENV DINOV2_MODEL_PATH=/app/models/dinov2_triplet_v2_best.pt
ENV YOLO_MUZZLE_MODEL_PATH=/app/models/yolo26s.pt
ENV TORCH_HOME=/app/data/embedding_runtime/torch
ENV MPLCONFIGDIR=/app/data/matplotlib
ENV PORT=3000
ENV REQUIRE_PRODUCTION_SERVICES=true

COPY backend/requirements-container.txt /app/backend/requirements-container.txt
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --upgrade pip \
    && /app/.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
    && /app/.venv/bin/pip install -r /app/backend/requirements-container.txt

COPY backend/package.json /app/backend/package.json
WORKDIR /app/backend
RUN npm install --omit=dev

COPY backend/src/ /app/backend/src/
COPY backend/scripts/ /app/backend/scripts/
RUN mkdir -p /app/models /app/data/embedding_runtime/torch/hub
COPY backend/dinov2_triplet_v2_best.pt /app/models/dinov2_triplet_v2_best.pt
COPY backend/yolo26s.pt /app/models/yolo26s.pt
RUN for attempt in 1 2 3; do \
      /app/.venv/bin/python -c "import torch; torch.hub.set_dir('/app/data/embedding_runtime/torch/hub'); torch.hub.load('facebookresearch/dinov2', 'dinov2_vitb14', pretrained=False, skip_validation=True, trust_repo=True)" \
      && break; \
      if [ "$attempt" = "3" ]; then exit 1; fi; \
      sleep 5; \
    done
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

EXPOSE 3000

# ── Health check for ECS/Docker ───────────────────────────────
# ECS uses this to detect unhealthy containers and replace them.
#   --interval=30s    Check every 30 seconds
#   --timeout=10s     If /api/health doesn't respond in 10s, count as failure
#   --start-period=120s  Give the app 120 seconds to start up (PyTorch
#                        and DINOv2 model loading takes ~60-90 seconds)
#   --retries=3       After 3 consecutive failures, mark as unhealthy
#                     ECS will then kill and restart the container
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "src/server.js"]
