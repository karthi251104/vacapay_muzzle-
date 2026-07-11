FROM node:24-bookworm AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:24-bookworm
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON_BIN=/app/.venv/bin/python
ENV DINOV2_MODEL_PATH=/app/models/dinov2_triplet_v2_best.pt
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
RUN /app/.venv/bin/python -c "import torch; torch.hub.set_dir('/app/data/embedding_runtime/torch/hub'); torch.hub.load('facebookresearch/dinov2', 'dinov2_vitb14', pretrained=False)"
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

EXPOSE 3000
CMD ["node", "src/server.js"]
