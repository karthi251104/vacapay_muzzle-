FROM node:24-bookworm AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:24-bookworm
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHON_BIN=/app/.venv/bin/python
ENV YOLO_CONFIG_DIR=/app/data/ultralytics
ENV MPLCONFIGDIR=/app/data/matplotlib
ENV PORT=3000

COPY backend/requirements.txt /app/backend/requirements.txt
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --upgrade pip \
    && /app/.venv/bin/pip install -r /app/backend/requirements.txt

COPY backend/package.json /app/backend/package.json
WORKDIR /app/backend
RUN npm install --omit=dev

COPY backend/ /app/backend/
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

EXPOSE 3000
CMD ["node", "src/server.js"]
