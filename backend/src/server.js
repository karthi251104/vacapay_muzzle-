import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import {
  fieldOfficerFromUser,
  filterAuditsForUser,
  filterRowsForUser,
  findOfflineCapture,
  isAdminUser,
  sameFarmerIdentity,
  userOwnsAudit,
  userOwnsRecord
} from './ownership.js';
import { removeUploadedFile } from './upload-cleanup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });
const dataDir = path.join(rootDir, 'data');
const uploadDir = path.join(dataDir, '_uploads');
const metadataPath = path.join(dataDir, 'enrollments.json');
const matchAuditsPath = path.join(dataDir, 'match_audits.json');
const usersPath = path.join(dataDir, 'users.json');
const sessionsPath = path.join(dataDir, 'sessions.json');
const frontendDistDir = path.join(rootDir, 'frontend', 'dist', 'vacapay', 'browser');

const app = express();
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!String(file.mimetype || '').toLowerCase().startsWith('image/')) {
      callback(new Error('Only image uploads are accepted.'));
      return;
    }
    callback(null, true);
  }
});

const PORT = envNumber('PORT', 3000, 1, 65535, true);
const PYTHON_BIN = resolvePythonBin();
const PYTHON_PROCESS_TIMEOUT_MS = envNumber('PYTHON_PROCESS_TIMEOUT_MS', 180_000, 30_000, 900_000, true);
const DINOV2_MODEL_PATH = process.env.DINOV2_MODEL_PATH || path.join(__dirname, '..', 'dinov2_triplet_v2_best.pt');
const YOLO_MUZZLE_MODEL_PATH = process.env.YOLO_MUZZLE_MODEL_PATH || path.join(__dirname, '..', 'yolo26s.pt');
const MUZZLE_CONF = envNumber('MUZZLE_CONF', 0.55, 0, 1);
const MUZZLE_BAD_CONF = envNumber('MUZZLE_BAD_CONF', 0.35, 0, 1);
const MUZZLE_WET_CONF = envNumber('MUZZLE_WET_CONF', 0.35, 0, 1);
const MUZZLE_BAD_DOMINANCE_MARGIN = envNumber('MUZZLE_BAD_DOMINANCE_MARGIN', 0.05, 0, 1);
const MUZZLE_MIN_SHARPNESS = envNumber('MUZZLE_MIN_SHARPNESS', 14, 0, 1000);
const MUZZLE_IMAGE_COUNT = envNumber('MUZZLE_IMAGE_COUNT', 3, 1, 10, true);
const EMBEDDING_MATCH_THRESHOLD = envNumber('EMBEDDING_MATCH_THRESHOLD', 0.70, 0, 1);
const MIN_EMBEDDING_MEMORY_MB = envNumber('MIN_EMBEDDING_MEMORY_MB', 1200, 256, 65536, true);
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const CLOUDINARY_ROOT_FOLDER = process.env.CLOUDINARY_ROOT_FOLDER || 'vacapay';
const cloudinaryEnabled = Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'vacapay';
const DISABLE_MONGO = ['true', '1', 'yes'].includes(String(process.env.DISABLE_MONGO || '').toLowerCase());
const mongoEnabled = Boolean(MONGODB_URI) && !DISABLE_MONGO;
const REQUIRE_PRODUCTION_SERVICES = ['true', '1', 'yes'].includes(String(process.env.REQUIRE_PRODUCTION_SERVICES || '').toLowerCase());
const INITIAL_ADMIN_PASSWORD = String(process.env.INITIAL_ADMIN_PASSWORD || '');
const INITIAL_ADMIN_PHONE = String(process.env.INITIAL_ADMIN_PHONE || 'admin').trim();
const INITIAL_ADMIN_AGENT_ID = String(process.env.INITIAL_ADMIN_AGENT_ID || 'admin').trim();
const INITIAL_ADMIN_NAME = String(process.env.INITIAL_ADMIN_NAME || 'Vacapay Admin').trim();
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || '';
const PINECONE_INDEX_HOST = normalizePineconeHost(process.env.PINECONE_INDEX_HOST || '');
const PINECONE_NAMESPACE = process.env.PINECONE_NAMESPACE || 'vacapay';
const PINECONE_ENROLMENT_NAMESPACE = process.env.PINECONE_ENROLMENT_NAMESPACE || `${PINECONE_NAMESPACE}-cattle-enrolment`;
const PINECONE_SEARCH_NAMESPACE = process.env.PINECONE_SEARCH_NAMESPACE || `${PINECONE_NAMESPACE}-cattle-search`;
const pineconeEnabled = Boolean(PINECONE_API_KEY && PINECONE_INDEX_HOST);
const APP_VERSION = process.env.APP_VERSION || 'field-test-2026-07-14';
const YOLO_MUZZLE_MODEL_VERSION = process.env.YOLO_MUZZLE_MODEL_VERSION || path.basename(YOLO_MUZZLE_MODEL_PATH);
const PHONE_TFLITE_MODEL_VERSION = process.env.PHONE_TFLITE_MODEL_VERSION || 'yolo26s_float32.tflite';
const DINOV2_MODEL_VERSION = process.env.DINOV2_MODEL_VERSION || path.basename(DINOV2_MODEL_PATH);
const MUZZLE_IMAGE_FILES = Array.from({ length: MUZZLE_IMAGE_COUNT }, (_, index) => `muzzle${index + 1}.jpg`);
const SUPPORT_IMAGE_FILES = [
  'face1.jpg',
  'face2.jpg',
  'face3.jpg',
  'leftside.jpg',
  'rightside.jpg',
  'back.jpg',
  'udder.jpg'
];
const REQUIRED_IMAGES = [...MUZZLE_IMAGE_FILES, ...SUPPORT_IMAGE_FILES];
const JWT_SECRET = process.env.JWT_SECRET || randomUUID();
let writeLock = Promise.resolve();
let embeddingProcessLock = Promise.resolve();

function envNumber(name, fallback, min, max, integer = false) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.min(max, Math.max(min, parsed));
  return integer ? Math.round(bounded) : bounded;
}

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;

  const candidates = process.platform === 'win32'
    ? [
      path.join(rootDir, '.venv-llm-muzzle', 'Scripts', 'python.exe'),
      path.join(rootDir, '.venv', 'Scripts', 'python.exe')
    ]
    : [
      path.join(rootDir, '.venv-llm-muzzle', 'bin', 'python'),
      path.join(rootDir, '.venv', 'bin', 'python')
    ];

  return candidates.find((candidate) => existsSync(candidate)) || 'python';
}

function base64url(bufferOrString) {
  return Buffer.from(bufferOrString).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const b64Header = base64url(JSON.stringify(header));
  const b64Payload = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(b64Header + '.' + b64Payload).digest('base64');
  return `${b64Header}.${b64Payload}.${base64url(Buffer.from(signature, 'base64'))}`;
}

function verifyJwt(token, secret) {
  const [b64Header, b64Payload, signature] = (token || '').split('.');
  if (!b64Header || !b64Payload || !signature) return null;

  const expectedSig = createHmac('sha256', secret).update(b64Header + '.' + b64Payload).digest('base64');
  const expectedSigB64 = base64url(Buffer.from(expectedSig, 'base64'));

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSigB64);
  if (signatureBuffer.length === expectedBuffer.length && timingSafeEqual(signatureBuffer, expectedBuffer)) {
    try {
      const payload = JSON.parse(Buffer.from(b64Payload, 'base64').toString('utf8'));
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }
  return null;
}
let mongoClient = null;
let mongoDb = null;
let MongoClientCtor = null;

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true
  });
}

app.use(cors((req, callback) => {
  const origin = String(req.get('Origin') || '').replace(/\/$/, '');
  const forwardedProto = String(req.get('X-Forwarded-Proto') || '').split(',')[0].trim();
  const forwardedHost = String(req.get('X-Forwarded-Host') || '').split(',')[0].trim();
  const requestProto = forwardedProto || req.protocol;
  const requestHost = forwardedHost || req.get('Host');
  const requestOrigin = requestHost ? `${requestProto}://${requestHost}` : '';
  const isAllowed = !origin
    || origin === requestOrigin
    || !CORS_ORIGINS.length
    || CORS_ORIGINS.includes('*')
    || CORS_ORIGINS.includes(origin);

  if (isAllowed) {
    callback(null, { origin: true });
    return;
  }

  console.warn('Blocked Origin:', origin);
  callback(new Error('Origin is not allowed by CORS policy.'));
}));
app.use(express.json({ limit: '5mb' }));
app.use('/media', express.static(dataDir));
app.get('/assets/runtime-config.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('application/javascript').send(`window.VACAPAY_CONFIG = ${JSON.stringify({
    apiBaseUrl: '/api',
    mediaBaseUrl: ''
  })};\n`);
});

validateProductionConfig();
console.log(`Starting storage setup. Mongo ${mongoEnabled ? 'enabled' : 'disabled'}. Data: ${dataDir}`);
await ensureStorage();
console.log('Storage setup complete.');

function withWriteLock(fn) {
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => { });
  return next;
}

function validateProductionConfig() {
  if (!REQUIRE_PRODUCTION_SERVICES) return;

  const required = [
    'JWT_SECRET',
    'MONGODB_URI',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'PINECONE_API_KEY',
    'PINECONE_INDEX_HOST'
  ];
  const missing = required.filter((name) => !String(process.env[name] || '').trim());
  if (String(process.env.JWT_SECRET || '').length < 32) missing.push('JWT_SECRET (minimum 32 characters)');
  if (!existsSync(DINOV2_MODEL_PATH)) missing.push(`DINOV2_MODEL_PATH (${DINOV2_MODEL_PATH})`);
  if (missing.length) {
    throw new Error(`Production configuration is incomplete: ${[...new Set(missing)].join(', ')}`);
  }
}

function safeCattleId(cattleId) {
  const id = String(cattleId || '').trim();
  if (!id || /[\/\\:*?"<>|]/.test(id) || id.includes('..') || id.includes('~')) {
    throw new Error('Invalid cattle ID.');
  }
  return id;
}

function safeOfflineCaptureId(captureId) {
  const id = String(captureId || '').trim();
  if (!id) return '';
  if (id.length > 160 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('Invalid offline capture ID.');
  }
  return id;
}

function validGpsCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    appVersion: APP_VERSION,
    embeddingMatchThreshold: EMBEDDING_MATCH_THRESHOLD,
    muzzleImageCount: MUZZLE_IMAGE_COUNT,
    cloudinary: {
      enabled: cloudinaryEnabled
    },
    mongodb: {
      enabled: mongoEnabled
    },
    pinecone: {
      enabled: pineconeEnabled
    }
  });
});

app.get('/api/version', (_req, res) => {
  res.json({
    appVersion: APP_VERSION,
    captureWorkflowVersion: 'cattle-enrolment-search-v2',
    tfliteMuzzleModelVersion: PHONE_TFLITE_MODEL_VERSION,
    backendYoloModelVersion: YOLO_MUZZLE_MODEL_VERSION,
    dinov2ModelVersion: DINOV2_MODEL_VERSION,
    muzzleImageCount: MUZZLE_IMAGE_COUNT,
    thresholds: {
      muzzleConfidence: MUZZLE_CONF,
      badMuzzleConfidence: MUZZLE_BAD_CONF,
      wetMuzzleConfidence: MUZZLE_WET_CONF,
      embeddingMatch: EMBEDDING_MATCH_THRESHOLD,
      embeddingMatchPercent: Math.round(EMBEDDING_MATCH_THRESHOLD * 100)
    },
    pineconeNamespaces: {
      enrolment: PINECONE_ENROLMENT_NAMESPACE,
      search: PINECONE_SEARCH_NAMESPACE
    }
  });
});

app.get('/api/pinecone/status', requireAuth, async (_req, res) => {
  if (!pineconeEnabled) {
    res.json({
      ok: false,
      enabled: false,
      error: 'Set PINECONE_API_KEY and PINECONE_INDEX_HOST to enable vector search.'
    });
    return;
  }

  try {
    const result = await pineconeFetch('/describe_index_stats', {
      method: 'POST',
      body: JSON.stringify({})
    });
    res.json({
      ok: true,
      enabled: true,
      namespace: PINECONE_ENROLMENT_NAMESPACE,
      dimension: result.dimension,
      totalVectorCount: result.totalVectorCount,
      namespaces: result.namespaces || {}
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      enabled: true,
      namespace: PINECONE_ENROLMENT_NAMESPACE,
      error: error.message || 'Pinecone status check failed.'
    });
  }
});

app.get('/api/embedding/status', requireAuth, async (_req, res) => {
  try {
    const result = await runPythonJson([
      path.join(__dirname, '..', 'scripts', 'embedding_status.py'),
      '--weights',
      DINOV2_MODEL_PATH,
      '--threshold',
      String(EMBEDDING_MATCH_THRESHOLD)
    ]);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      modelPath: DINOV2_MODEL_PATH,
      threshold: EMBEDDING_MATCH_THRESHOLD,
      error: publicErrorMessage(error)
    });
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (/^\d+$/.test(identifier) && !/^\d{10}$/.test(identifier)) {
      res.status(400).json({ error: 'Field officer mobile number must contain exactly 10 digits.' });
      return;
    }
    const users = await readUsers();
    const user = users.find((item) => item.active && [item.agentId, item.phone].map((value) => String(value || '').toLowerCase()).includes(identifier));

    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: 'Invalid login details.' });
      return;
    }
    if (user.role === 'agent' && (!/^\d{10}$/.test(identifier) || identifier !== String(user.phone || '').trim())) {
      res.status(400).json({ error: 'Field officers must sign in with their 10-digit mobile number.' });
      return;
    }

    const publicUser = toPublicUser(user);
    const exp = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
    const token = signJwt({ ...publicUser, exp }, JWT_SECRET);
    res.json({ token, user: publicUser });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/agents', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const users = await readUsers();
    res.json({ agents: users.filter((user) => user.role === 'agent').map(toPublicUser) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/farmers/sync', requireAuth, async (req, res, next) => {
  try {
    const rows = filterRowsForUser((await readCleanMetadata()).filter(isRegisteredInventoryRecord), req.user);
    const groups = new Map();

    for (const row of rows) {
      const key = ownerGroupKey(row);
      const sessions = row.sessions || [];
      const lastSession = sessions.at(-1);
      const updatedAt = lastSession?.uploadDateTime || lastSession?.captureDateTime || row.uploadDateTime || row.captureDateTime || '';
      const group = groups.get(key) || {
        key,
        farmerId: row.farmerId || '',
        farmerName: row.farmerName || '',
        locationLat: Number.isFinite(Number(row.locationLat)) ? Number(row.locationLat) : null,
        locationLon: Number.isFinite(Number(row.locationLon)) ? Number(row.locationLon) : null,
        cattleCount: 0,
        visitCount: 0,
        imageCount: 0,
        lastCaptureDate: null,
        updatedAt: ''
      };

      group.cattleCount += 1;
      group.visitCount += sessions.length;
      group.imageCount += sessions.reduce((total, session) => total + Object.keys(session.images || {}).length, 0);
      if (updatedAt && (!group.updatedAt || String(updatedAt).localeCompare(String(group.updatedAt)) > 0)) {
        group.updatedAt = updatedAt;
        group.locationLat = Number.isFinite(Number(row.locationLat)) ? Number(row.locationLat) : group.locationLat;
        group.locationLon = Number.isFinite(Number(row.locationLon)) ? Number(row.locationLon) : group.locationLon;
      }
      const captureDate = lastSession?.captureDate || row.captureDateTime || null;
      if (captureDate && (!group.lastCaptureDate || String(captureDate).localeCompare(String(group.lastCaptureDate)) > 0)) {
        group.lastCaptureDate = captureDate;
      }
      groups.set(key, group);
    }

    const farmers = Array.from(groups.values()).sort((a, b) =>
      String(a.farmerName || a.farmerId).localeCompare(String(b.farmerName || b.farmerId))
    );
    const generatedAt = new Date().toISOString();
    const datasetVersion = farmers.reduce(
      (latest, farmer) => String(farmer.updatedAt || '').localeCompare(latest) > 0 ? String(farmer.updatedAt) : latest,
      ''
    ) || generatedAt;

    res.json({ farmers, farmerCount: farmers.length, generatedAt, datasetVersion });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reviews/matches', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const uncertainOnly = String(req.query.uncertainOnly ?? 'true') !== 'false';
    await backfillEnrollmentMatchAudits();
    const audits = await readMatchAudits();
    const rows = (await readMetadata()).map(normalizeRecord).filter(Boolean);
    const imageLookup = buildSessionImageLookup(rows);
    const lower = EMBEDDING_MATCH_THRESHOLD - 0.10;
    const upper = EMBEDDING_MATCH_THRESHOLD + 0.10;

    const reviews = audits
      .filter((audit) => !uncertainOnly || audit.reviewStatus !== 'confirmed')
      .filter((audit) => {
        if (!uncertainOnly) return true;
        const confidence = Number(audit.confidence || 0);
        return confidence >= lower && confidence <= upper;
      })
      .sort((a, b) => String(b.resolvedAt || '').localeCompare(String(a.resolvedAt || '')))
      .slice(0, 5000)
      .map((audit) => ({
        ...normalizeAuditScores(audit),
        images: imageLookup.get(`${audit.finalCattleId || audit.cattleId}__${audit.sessionId}`) || []
      }));

    res.json({ reviews });
  } catch (error) {
    next(error);
  }
});

app.post('/api/reviews/matches/:auditId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const audits = await readMatchAudits();
    const index = audits.findIndex((audit) => audit.auditId === req.params.auditId);

    if (index < 0) {
      res.status(404).json({ error: 'Match audit not found.' });
      return;
    }

    const action = String(req.body.action || '').trim();
    const reviewScope = req.body.reviewScope === 'farmer' ? 'farmer' : 'overall';
    const scopeDecision = reviewScope === 'farmer'
      ? audits[index].farmerComparison?.decision
      : audits[index].decision;
    if (reviewScope === 'farmer' && !audits[index].farmerComparison?.available) {
      res.status(400).json({ error: 'Selected-farmer comparison is not available for this search.' });
      return;
    }
    if (reviewScope === 'farmer' && action) {
      res.status(400).json({ error: 'Record correction actions apply only to the overall search result.' });
      return;
    }
    const reviewNotes = String(req.body.reviewNotes || '').trim();
    const allowedReviewStatuses = new Set([
      'confirmed', 'found_correct', 'found_incorrect', 'no_cattle_correct',
      'no_cattle_incorrect', 'wrong_moved_to_registered'
    ]);
    const requestedReviewStatus = String(req.body.reviewStatus || '').trim();
    if (action !== 'move_out_as_registered' && !allowedReviewStatuses.has(requestedReviewStatus)) {
      res.status(400).json({ error: 'Invalid match review status.' });
      return;
    }
    if (scopeDecision === 'matched_existing' && requestedReviewStatus.startsWith('no_cattle_')) {
      res.status(400).json({ error: 'A cattle-found result must be reviewed with a cattle-found action.' });
      return;
    }
    if (scopeDecision === 'new_cattle' && requestedReviewStatus.startsWith('found_')) {
      res.status(400).json({ error: 'A no-cattle-found result must be reviewed with a no-cattle-found action.' });
      return;
    }
    const correctCattleId = String(req.body.correctCattleId || '').trim() || null;
    if (requestedReviewStatus === 'no_cattle_incorrect' && !correctCattleId) {
      res.status(400).json({ error: 'Select the registered cattle that should have been found.' });
      return;
    }
    if (correctCattleId) {
      safeCattleId(correctCattleId);
      const correctRecord = normalizeRecord((await readMetadata()).find((row) => row?.cattleId === correctCattleId));
      if (!correctRecord || !isRegisteredInventoryRecord(correctRecord)) {
        res.status(400).json({ error: 'The selected correct cattle ID is not a registered cattle record.' });
        return;
      }
    }
    let correctedRecord = null;

    if (action === 'move_out_as_registered') {
      correctedRecord = await moveMatchedVisitOutAsRegistered(audits[index], {
        reviewedBy: req.user,
        reviewNotes
      });
    }

    const predictedCattleId = reviewScope === 'farmer'
      ? audits[index].farmerComparison?.matchedCattleId
      : audits[index].matchedCattleId;
    const reviewedCorrectCattleId = requestedReviewStatus === 'no_cattle_correct'
      ? null
      : ((requestedReviewStatus === 'found_correct' || requestedReviewStatus === 'confirmed')
        && scopeDecision === 'matched_existing'
        ? predictedCattleId
        : (correctCattleId || (action === 'move_out_as_registered' ? audits[index].finalCattleId : null)));

    const reviewedAt = new Date().toISOString();
    if (reviewScope === 'farmer') {
      audits[index] = {
        ...audits[index],
        farmerComparison: {
          ...audits[index].farmerComparison,
          reviewStatus: requestedReviewStatus,
          correctCattleId: reviewedCorrectCattleId,
          reviewNotes,
          reviewedBy: req.user,
          reviewedAt
        }
      };
    } else {
      audits[index] = {
        ...audits[index],
        reviewStatus: action === 'move_out_as_registered' ? 'wrong_moved_to_registered' : requestedReviewStatus,
        correctCattleId: reviewedCorrectCattleId,
        reviewNotes,
        reviewedBy: req.user,
        reviewedAt,
        correctionAction: action || null
      };
    }
    audits[index].farmerComparison = audits[index].farmerComparison || buildAuditFarmerComparison(audits[index]);

    await persistMatchAudit(audits[index]);
    res.json({ review: audits[index], correctedRecord: correctedRecord ? toCattleSummary(correctedRecord) : null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/agents', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const agentName = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    const agentId = String(req.body.agentId || '').trim();
    const password = String(req.body.password || '');

    if (!agentName || !phone || !agentId || password.length < 8) {
      res.status(400).json({ error: 'Agent name, phone, agent ID, and a password of at least 8 characters are required.' });
      return;
    }
    if (!/^\d{10}$/.test(phone)) {
      res.status(400).json({ error: 'Agent phone number must contain exactly 10 digits.' });
      return;
    }

    const users = await readUsers();
    const normalizedAgentId = agentId.toLowerCase();
    const normalizedPhone = phone.toLowerCase();
    const exists = users.some((user) => [user.agentId, user.phone].map((value) => String(value || '').toLowerCase()).some((value) => value === normalizedAgentId || value === normalizedPhone));

    if (exists) {
      res.status(409).json({ error: 'Agent ID or phone already exists.' });
      return;
    }

    const user = {
      userId: randomUUID(),
      role: 'agent',
      name: agentName,
      phone,
      agentId,
      active: true,
      createdAt: new Date().toISOString(),
      passwordHash: hashPassword(password)
    };

    await persistUser(user);
    res.status(201).json({ agent: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/farmers', requireAuth, async (req, res, next) => {
  try {
    const q = normalizeSearchText(req.query.q);
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = Number(req.query.radiusKm || 7);
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lon);
    const rows = filterRowsForUser((await readCleanMetadata()).filter(isRegisteredInventoryRecord), req.user);
    const groups = new Map();

    for (const row of rows) {
      const farmerIdNorm = normalizeSearchText(row.farmerId);
      const farmerNameNorm = normalizeSearchText(row.farmerName);
      const textMatches = Boolean(q && (farmerIdNorm.includes(q) || farmerNameNorm.includes(q)));
      const distanceKm = hasLocation && Number.isFinite(Number(row.locationLat)) && Number.isFinite(Number(row.locationLon))
        ? haversineKm(lat, lon, Number(row.locationLat), Number(row.locationLon))
        : null;
      const withinRadius = distanceKm !== null && distanceKm <= radiusKm;

      // Text search and nearby search are separate field actions.
      if (q && !textMatches) continue;
      if (!q && hasLocation && !withinRadius) continue;
      if (!q && !hasLocation) continue;

      const key = ownerGroupKey(row);
      const group = groups.get(key) || {
        key,
        farmerId: row.farmerId || '',
        farmerName: row.farmerName || '',
        cattleCount: 0,
        visitCount: 0,
        imageCount: 0,
        distanceKm: null,
        withinRadius: false,
        lastCaptureDate: null
      };

      group.cattleCount += 1;
      group.visitCount += (row.sessions || []).length;
      group.imageCount += (row.sessions || []).reduce((total, session) => total + Object.keys(session.images || {}).length, 0);
      group.distanceKm = group.distanceKm === null ? distanceKm : (distanceKm === null ? group.distanceKm : Math.min(group.distanceKm, distanceKm));
      group.withinRadius = group.withinRadius || withinRadius;
      const lastSession = (row.sessions || []).at(-1);
      const lastCaptureDate = lastSession?.captureDate || row.captureDateTime || null;
      if (lastCaptureDate && (!group.lastCaptureDate || String(lastCaptureDate).localeCompare(String(group.lastCaptureDate)) > 0)) {
        group.lastCaptureDate = lastCaptureDate;
      }

      groups.set(key, group);
    }

    const farmers = Array.from(groups.values())
      .sort((a, b) => {
        if (a.withinRadius !== b.withinRadius) return a.withinRadius ? -1 : 1;
        if (a.distanceKm === null && b.distanceKm === null) return String(a.farmerName).localeCompare(String(b.farmerName));
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
      })
      .slice(0, 10);

    res.json({ farmers });
  } catch (error) {
    next(error);
  }
});

app.get('/api/cattle/search', requireAuth, async (req, res, next) => {
  try {
    const farmerId = normalizeSearchText(req.query.farmerId);
    const farmerName = normalizeSearchText(req.query.farmerName);
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = Number(req.query.radiusKm || 7);
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lon);

    if (!farmerId && !farmerName) {
      res.status(400).json({ error: 'Farmer ID or farmer name is required to search registered cattle.' });
      return;
    }

    const rows = filterRowsForUser((await readCleanMetadata()).filter(isRegisteredInventoryRecord), req.user);

    const ownerNumberMap = buildOwnerCattleNumberMap(rows);

    const cattle = rows
      .filter((row) => {
        const rowFarmerId = normalizeSearchText(row.farmerId);
        const rowFarmerName = normalizeSearchText(row.farmerName);
        if (farmerId && farmerName) return rowFarmerId === farmerId || rowFarmerName.includes(farmerName);
        if (farmerId) return rowFarmerId === farmerId;
        return Boolean(farmerName && rowFarmerName.includes(farmerName));
      })
      .map((row) => {
        const distanceKm = hasLocation && Number.isFinite(Number(row.locationLat)) && Number.isFinite(Number(row.locationLon))
          ? haversineKm(lat, lon, Number(row.locationLat), Number(row.locationLon))
          : null;
        const sessions = row.sessions || [];
        const lastSession = sessions.at(-1);

        return {
          cattleId: row.cattleId,
          cattleNumber: ownerNumberMap.get(row.cattleId) || null,
          cattleLabel: cattleDisplayLabel(ownerNumberMap.get(row.cattleId)),
          farmerId: row.farmerId,
          farmerName: row.farmerName,
          fieldOfficerName: row.fieldOfficerName,
          locationLat: row.locationLat,
          locationLon: row.locationLon,
          rootFolderLocation: row.rootFolderLocation || path.join(dataDir, row.cattleId),
          sessionCount: sessions.length,
          lastCaptureDate: lastSession?.captureDate || null,
          lastStatus: lastSession?.status || row.status || 'draft',
          distanceKm,
          withinRadius: distanceKm === null || distanceKm <= radiusKm
        };
      })
      .sort((a, b) => {
        if (a.distanceKm === null && b.distanceKm === null) return a.farmerName.localeCompare(b.farmerName);
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
      })
      .slice(0, 25);

    res.json({ cattle });
  } catch (error) {
    next(error);
  }
});


app.get('/api/cattle', requireAuth, async (req, res, next) => {
  try {
    const rows = filterRowsForUser((await readCleanMetadata()).filter(isVisibleInventoryRecord), req.user);
    const audits = filterAuditsForUser(
      (await readMatchAudits()).filter((audit) => audit.workflow === 'cattle_search'),
      req.user
    );
    const reviewedStatuses = new Set([
      'confirmed', 'found_correct', 'found_incorrect', 'no_cattle_correct',
      'no_cattle_incorrect', 'wrong_moved_to_registered'
    ]);
    const searchProgressByCattleId = new Map();

    for (const audit of audits) {
      const cattleIds = new Set([audit.matchedCattleId, audit.correctCattleId].filter(Boolean));
      for (const cattleId of cattleIds) {
        const progress = searchProgressByCattleId.get(cattleId) || {
          searchCount: 0,
          reviewedSearchCount: 0,
          lastSearchDate: null
        };
        progress.searchCount += 1;
        if (reviewedStatuses.has(audit.reviewStatus)) progress.reviewedSearchCount += 1;
        const searchDate = audit.captureDate || audit.resolvedAt || null;
        if (searchDate && (!progress.lastSearchDate || String(searchDate).localeCompare(String(progress.lastSearchDate)) > 0)) {
          progress.lastSearchDate = searchDate;
        }
        searchProgressByCattleId.set(cattleId, progress);
      }
    }

    const ownerNumberMap = buildOwnerCattleNumberMap(rows);
    const cattle = rows
      .map((row) => {
        const summary = toCattleSummary(row, ownerNumberMap.get(row.cattleId));
        const progress = searchProgressByCattleId.get(row.cattleId) || {
          searchCount: 0,
          reviewedSearchCount: 0,
          lastSearchDate: null
        };
        const pendingReviewCount = Math.max(0, progress.searchCount - progress.reviewedSearchCount);
        return {
          ...summary,
          ...progress,
          pendingReviewCount,
          searchReviewState: pendingReviewCount > 0
            ? 'pending_review'
            : (progress.reviewedSearchCount > 0 ? 'reviewed' : 'not_searched')
        };
      })
      .sort((a, b) => String(b.lastCaptureDate || '').localeCompare(String(a.lastCaptureDate || '')));

    res.json({
      stats: buildCattleStats(cattle),
      cattle
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/cattle/download', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const cattleIds = Array.isArray(req.body?.cattleIds) ? req.body.cattleIds.map(String) : [];
    if (!cattleIds.length) {
      res.status(400).json({ error: 'Select at least one cattle.' });
      return;
    }

    const selectedIds = new Set(cattleIds);
    const rows = (await readMetadata()).map(normalizeRecord).filter((row) => row && selectedIds.has(row.cattleId));
    const files = [];

    for (const row of rows) {
      const farmerFolder = safeZipName(row.farmerName || row.farmerId || 'unknown-farmer');
      const cattleFolder = safeZipName(row.cattleId);
      for (const session of row.sessions || []) {
        const sessionFolder = safeZipName(session.sessionId || session.captureDate || 'visit');
        for (const image of Object.values(session.images || {})) {
          const data = await readImageForZip(image);
          if (!data) continue;
          files.push({
            zipPath: `${farmerFolder}/${cattleFolder}/${sessionFolder}/${safeZipName(image.fileName || `${image.imageType}.jpg`)}`,
            data
          });
        }
      }
    }

    if (!files.length) {
      res.status(404).json({ error: 'No downloadable images found for selected cattle.' });
      return;
    }

    const zip = createZip(files);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="vacapay-cattle-${stamp}.zip"`);
    res.send(zip);
  } catch (error) {
    next(error);
  }
});
app.post('/api/cattle/merge', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const targetCattleId = String(req.body.targetCattleId || '').trim();
    const sourceCattleIds = Array.isArray(req.body.sourceCattleIds)
      ? req.body.sourceCattleIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];
    const uniqueSourceIds = [...new Set(sourceCattleIds)].filter((id) => id && id !== targetCattleId);

    if (!targetCattleId || !uniqueSourceIds.length) {
      res.status(400).json({ error: 'Select one main cattle and at least one cattle/search record to merge.' });
      return;
    }

    const rows = (await readMetadata()).map(normalizeRecord).filter(Boolean);
    const targetIndex = rows.findIndex((row) => row.cattleId === targetCattleId);

    if (targetIndex < 0) {
      res.status(404).json({ error: 'Main cattle record not found.' });
      return;
    }

    const targetRow = rows[targetIndex];
    const mergedIds = [];

    for (const sourceId of uniqueSourceIds) {
      const sourceIndex = rows.findIndex((row) => row?.cattleId === sourceId);
      const sourceRow = rows[sourceIndex];
      if (!sourceRow) continue;

      for (const session of sourceRow.sessions || []) {
        await moveSessionIntoTargetCattle({ sourceRow, targetRow, session });
      }

      targetRow.farmerId = targetRow.farmerId || sourceRow.farmerId || '';
      targetRow.farmerName = targetRow.farmerName || sourceRow.farmerName || '';
      targetRow.fieldOfficerId = targetRow.fieldOfficerId || sourceRow.fieldOfficerId || '';
      targetRow.fieldOfficerName = targetRow.fieldOfficerName || sourceRow.fieldOfficerName || '';
      targetRow.locationLat = targetRow.locationLat ?? sourceRow.locationLat ?? null;
      targetRow.locationLon = targetRow.locationLon ?? sourceRow.locationLon ?? null;
      targetRow.status = 'admin_merged';
      targetRow.uploadDateTime = new Date().toISOString();
      rows[sourceIndex] = null;
      mergedIds.push(sourceId);

      await fs.rm(path.join(dataDir, sourceId), { recursive: true, force: true }).catch(() => { });
    }

    if (!mergedIds.length) {
      res.status(404).json({ error: 'No cattle/search records were found to merge.' });
      return;
    }

    targetRow.sessions = (targetRow.sessions || []).sort((a, b) => String(a.captureDateTime || '').localeCompare(String(b.captureDateTime || '')));
    targetRow.activeSessionId = targetRow.sessions.at(-1)?.sessionId || targetRow.activeSessionId;
    targetRow.folderLocation = targetRow.sessions.at(-1)?.folderLocation || targetRow.folderLocation;
    targetRow.captureDateTime = targetRow.sessions.at(-1)?.captureDateTime || targetRow.captureDateTime;

    await persistMetadataRecord(targetRow);
    await deleteMetadataRecords(mergedIds);
    res.json({ target: toCattleSummary(targetRow), mergedCattleIds: mergedIds });
  } catch (error) {
    next(error);
  }
});

// ── Approve a blocked duplicate enrolment as new registered cattle ──
app.post('/api/cattle/:cattleId/approve-blocked', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const cattleId = safeCattleId(req.params.cattleId);
    const reviewNotes = String(req.body.reviewNotes || 'Admin confirmed this is a different cow. AI match was incorrect.');

    const rows = await readMetadata();
    const rowIndex = rows.findIndex((r) => normalizeRecord(r)?.cattleId === cattleId);
    if (rowIndex < 0) {
      res.status(404).json({ error: 'Cattle record not found.' });
      return;
    }

    const row = normalizeRecord(rows[rowIndex]);
    if (!row) {
      res.status(404).json({ error: 'Could not read cattle record.' });
      return;
    }

    const now = new Date().toISOString();
    const previousMatchedId = row.duplicateOfCattleId || null;
    const correctedSessions = [];

    // Clear duplicate flags and promote to registered cattle
    delete row.duplicateOfCattleId;
    delete row.duplicateOfFarmerName;
    row.status = 'ready_for_embedding';
    row.uploadDateTime = now;
    row.adminCorrection = {
      action: 'approve_blocked_as_new',
      reviewedAt: now,
      reviewedBy: req.user?.userId || req.user?.name || '',
      reviewNotes,
      previousMatchedCattleId: previousMatchedId
    };

    for (const session of row.sessions || []) {
      if (session.matchResult?.duplicateSavedSeparately) {
        const previousMatchResult = session.matchResult || {};
        const sessionPreviousMatchedId = previousMatchResult.matchedCattleId || previousMatchResult.duplicateOfCattleId || previousMatchedId;
        session.status = 'ready_for_embedding';
        session.matchResult = {
          ...previousMatchResult,
          resolved: true,
          decision: 'new_cattle',
          duplicateSavedSeparately: false,
          matchedCattleId: null,
          duplicateOfCattleId: null,
          duplicateOfFarmerName: '',
          adminCorrection: row.adminCorrection,
          correctedAt: now
        };
        correctedSessions.push({
          session,
          previousMatchResult,
          previousMatchedId: sessionPreviousMatchedId
        });
      }
    }

    for (const { session } of correctedSessions) {
      await upsertSessionVector(row, session, {
        namespace: PINECONE_ENROLMENT_NAMESPACE,
        workflow: 'cattle_enrolment'
      }).catch(() => null);
    }

    rows[rowIndex] = row;
    await persistMetadataRecord(row);

    if (correctedSessions.length) {
      const audits = await readMatchAudits();
      for (const { session, previousMatchResult, previousMatchedId: sessionPreviousMatchedId } of correctedSessions) {
        const auditId = `${row.cattleId}__${session.sessionId}`;
        const auditIndex = audits.findIndex((audit) => audit.auditId === auditId);
        const review = {
          auditId,
          cattleId: row.cattleId,
          finalCattleId: row.cattleId,
          workflow: 'cattle_enrolment',
          sessionId: session.sessionId,
          decision: 'matched_existing',
          confidence: Number(previousMatchResult.confidence || 0),
          confidencePercent: Number(previousMatchResult.confidencePercent || Math.round(Number(previousMatchResult.confidence || 0) * 100)),
          threshold: Number(previousMatchResult.threshold || EMBEDDING_MATCH_THRESHOLD),
          thresholdPercent: Number(previousMatchResult.thresholdPercent || Math.round(EMBEDDING_MATCH_THRESHOLD * 100)),
          appVersion: APP_VERSION,
          captureWorkflowVersion: 'cattle-enrolment-search-v2',
          tfliteMuzzleModelVersion: PHONE_TFLITE_MODEL_VERSION,
          backendYoloModelVersion: YOLO_MUZZLE_MODEL_VERSION,
          dinov2ModelVersion: DINOV2_MODEL_VERSION,
          captureDurationSeconds: Number(session.captureDurationSeconds || 0) || null,
          muzzleImageCount: MUZZLE_IMAGE_COUNT,
          matchedCattleId: sessionPreviousMatchedId,
          previousCattleId: previousMatchResult.previousCattleId || row.cattleId,
          topMatches: previousMatchResult.topMatches || [],
          rankedTopMatches: previousMatchResult.rankedTopMatches || previousMatchResult.topMatches || [],
          farmerId: row.farmerId || '',
          farmerName: row.farmerName || '',
          fieldOfficerId: row.fieldOfficerId || session.fieldOfficerId || '',
          fieldOfficerName: row.fieldOfficerName || session.fieldOfficerName || '',
          locationLat: row.locationLat ?? null,
          locationLon: row.locationLon ?? null,
          locationAccuracyM: row.locationAccuracyM ?? null,
          matchRadiusKm: Number(row.matchRadiusKm || 7),
          searchStrategy: 'enrolment_duplicate_check',
          folderLocation: session.folderLocation,
          captureDate: session.captureDate,
          resolvedAt: previousMatchResult.resolvedAt || now,
          reviewStatus: 'wrong_moved_to_registered',
          correctCattleId: row.cattleId,
          reviewNotes,
          reviewedBy: req.user,
          reviewedAt: now,
          correctionAction: 'approve_blocked_as_new',
          previousMatchedCattleId: sessionPreviousMatchedId
        };
        if (auditIndex >= 0) audits[auditIndex] = { ...audits[auditIndex], ...review };
        else audits.push(review);
      }
      await Promise.all(audits.map((audit) => persistMatchAudit(audit)));
    }

    res.json({ cattle: toCattleSummary(row), message: 'Cattle approved as new registered record.' });
  } catch (error) {
    next(error);
  }
});
app.post('/api/enrollments', requireAuth, async (req, res, next) => {
  try {
    const now = new Date().toISOString();
    const requestLat = Number(req.body.locationLat);
    const requestLon = Number(req.body.locationLon);
    const requestAccuracy = Number(req.body.locationAccuracyM);

    if (!validGpsCoordinate(requestLat, requestLon)) {
      res.status(400).json({ error: 'Use GPS first before starting cow capture.' });
      return;
    }

    const requestedCattleId = String(req.body.cattleId || '').trim();
    const offlineCaptureId = safeOfflineCaptureId(req.body.offlineCaptureId);
    const rows = await readMetadata();
    const existingOfflineCapture = findOfflineCapture(rows, offlineCaptureId);
    const existingOfflineRowIndex = existingOfflineCapture?.rowIndex ?? -1;

    if (existingOfflineRowIndex >= 0) {
      const existingOfflineRow = normalizeRecord(rows[existingOfflineRowIndex]);
      if (!userOwnsRecord(req.user, existingOfflineRow)) {
        res.status(409).json({ error: 'This offline capture ID is already assigned to another field officer.' });
        return;
      }
      const existingOfflineSession = existingOfflineRow.sessions.find((session) => session.offlineCaptureId === offlineCaptureId);
      existingOfflineRow.activeSessionId = existingOfflineSession.sessionId;
      existingOfflineRow.uploadDateTime = now;
      rows[existingOfflineRowIndex] = existingOfflineRow;
      await persistMetadataRecord(existingOfflineRow);
      res.status(200).json({ enrollment: existingOfflineRow, reusedOfflineCapture: true });
      return;
    }

    const cattleId = requestedCattleId ? safeCattleId(requestedCattleId) : randomUUID();
    const existingIndex = rows.findIndex((row) => row.cattleId === cattleId);
    const existing = existingIndex >= 0 ? normalizeRecord(rows[existingIndex]) : null;
    const workflow = normalizeWorkflow(req.body.workflow, existing ? 'cattle_search' : 'cattle_enrolment');
    const rootFolder = path.join(dataDir, cattleId);

    if (existing && !userOwnsRecord(req.user, existing)) {
      res.status(403).json({
        error: 'This cattle record belongs to another field officer. Select your saved farmer/cow or use Cattle Search.'
      });
      return;
    }

    const record = existing || {
      cattleId,
      farmerId: '',
      farmerName: '',
      fieldOfficerName: '',
      locationLat: null,
      locationLon: null,
      rootFolderLocation: rootFolder,
      sessions: []
    };

    if (existing && offlineCaptureId) {
      const existingSession = (record.sessions || []).find((item) => item.offlineCaptureId === offlineCaptureId);
      if (existingSession) {
        record.activeSessionId = existingSession.sessionId;
        record.uploadDateTime = now;
        rows[existingIndex] = record;
        await persistMetadataRecord(record);
        res.status(200).json({ enrollment: record });
        return;
      }
    }

    if (existing && workflow === 'cattle_enrolment') {
      res.status(409).json({
        error: 'This cow is already enrolled. Use Cattle Search when photographing it again.'
      });
      return;
    }

    const session = await createCaptureSession({ cattleId, captureDateTime: req.body.captureDateTime || now });
    if (offlineCaptureId) session.offlineCaptureId = offlineCaptureId;

    const officer = fieldOfficerFromUser(req.user, req.body);
    const officerRows = filterRowsForUser(rows, req.user);
    const isNewFarmer = req.body.newFarmer === true || req.body.newFarmer === 'true';
    const requestedFarmerId = String(req.body.farmerId || record.farmerId || '').trim();
    const requestedFarmerName = String(req.body.farmerName || record.farmerName || '').trim();
    const likelyExistingFarmer = !existing
      ? findLikelyExistingFarmer(officerRows, requestedFarmerName, requestLat, requestLon)
      : null;
    const requestedIdOwner = requestedFarmerId
      ? officerRows.find((row) => normalizeSearchText(row?.farmerId) === normalizeSearchText(requestedFarmerId))
      : null;
    const safeRequestedFarmerId = requestedIdOwner
      && normalizeSearchText(requestedIdOwner.farmerName) !== normalizeSearchText(requestedFarmerName)
      ? ''
      : requestedFarmerId;
    record.farmerId = workflow === 'cattle_search'
      ? requestedFarmerId
      : (existing
        ? (safeRequestedFarmerId || record.farmerId || generateUniqueFarmerId(rows))
        : (isNewFarmer
          ? (likelyExistingFarmer?.farmerId || safeRequestedFarmerId || generateUniqueFarmerId(rows))
          : (safeRequestedFarmerId || likelyExistingFarmer?.farmerId || generateUniqueFarmerId(rows))));
    record.farmerName = requestedFarmerName;
    record.fieldOfficerName = officer.fieldOfficerName || record.fieldOfficerName || '';
    record.fieldOfficerId = officer.fieldOfficerId || record.fieldOfficerId || '';
    record.locationLat = requestLat;
    record.locationLon = requestLon;
    record.locationAccuracyM = Number.isFinite(requestAccuracy) && requestAccuracy >= 0 ? requestAccuracy : null;
    record.locationCapturedAt = String(req.body.locationCapturedAt || now);
    const requestedRadiusKm = Number(req.body.matchRadiusKm || record.matchRadiusKm || 7);
    record.matchRadiusKm = Number.isFinite(requestedRadiusKm)
      ? Math.min(50, Math.max(0.1, requestedRadiusKm))
      : 7;
    record.rootFolderLocation = rootFolder;
    record.folderLocation = session.folderLocation;
    record.captureDateTime = session.captureDateTime;
    record.uploadDateTime = now;
    record.workflow = workflow;
    record.status = workflow === 'cattle_search' ? 'cattle_search_draft' : 'draft';
    record.autoSelectedExistingCattle = false;
    record.activeSessionId = session.sessionId;
    session.workflow = workflow;
    session.fieldOfficerId = record.fieldOfficerId;
    session.fieldOfficerName = record.fieldOfficerName;
    record.sessions = [...(record.sessions || []), session];

    if (existingIndex >= 0) rows[existingIndex] = record;
    else rows.push(record);

    await persistMetadataRecord(record);

    res.status(201).json({ enrollment: record });
  } catch (error) {
    next(error);
  }
});

app.post('/api/muzzle/check', requireAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'image is required' });
      return;
    }

    if (!existsSync(YOLO_MUZZLE_MODEL_PATH)) {
      await fs.unlink(req.file.path).catch(() => { });
      res.status(503).json({
        accepted: false,
        backendUnavailable: true,
        error: 'Backend muzzle model is not available on this server.'
      });
      return;
    }

    const result = await runPythonJson([
      path.join(__dirname, '..', 'scripts', 'yolo_pt_muzzle_check.py'),
      '--model',
      YOLO_MUZZLE_MODEL_PATH,
      '--input',
      req.file.path,
      '--good-conf',
      String(MUZZLE_CONF),
      '--bad-conf',
      String(MUZZLE_BAD_CONF),
      '--wet-conf',
      String(MUZZLE_WET_CONF),
      '--bad-margin',
      String(MUZZLE_BAD_DOMINANCE_MARGIN),
      '--min-sharpness',
      String(MUZZLE_MIN_SHARPNESS)
    ]);
    await fs.unlink(req.file.path).catch(() => { });

    if (result?.backendUnavailable) {
      res.status(503).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => { });
    next(error);
  }
});

app.post('/api/enrollments/:cattleId/muzzle', requireAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'image is required' });
      return;
    }

    const cattleId = safeCattleId(req.params.cattleId);
    await assertUserCanAccessCattle(req.user, cattleId);
    const { folder, mediaPrefix } = await getActiveCaptureFolder(cattleId);
    const requestedSlot = Number(req.body.slot || 0);
    if (requestedSlot && (!Number.isInteger(requestedSlot) || requestedSlot < 1 || requestedSlot > MUZZLE_IMAGE_COUNT)) {
      res.status(400).json({ error: `Muzzle slot must be a whole number from 1 to ${MUZZLE_IMAGE_COUNT}.` });
      return;
    }
    const slot = requestedSlot || (await nextSlot(folder, 'muzzle', MUZZLE_IMAGE_COUNT));
    const fileName = `muzzle${slot}.jpg`;

    if (slot > MUZZLE_IMAGE_COUNT) {
      res.status(409).json({ error: `All ${MUZZLE_IMAGE_COUNT} muzzle images are already captured.` });
      return;
    }

    const clientProcessed = ['true', '1', 'yes'].includes(String(req.body.clientProcessed || req.body.preprocessed || '').toLowerCase());
    const outPath = path.join(folder, fileName);
    if (!clientProcessed) {
      await fs.unlink(req.file.path).catch(() => { });
      res.status(422).json({
        error: 'Upload rejected. Muzzle images must pass the phone TFLite check, crop and CLAHE before upload.'
      });
      return;
    }
    const result = await saveClientProcessedMuzzle(req.file.path, outPath);

    if (!result.detected) {
      await fs.unlink(req.file.path).catch(() => { });
      res.status(422).json({ error: 'Muzzle not detected clearly. Retake the image.', result });
      return;
    }

    await fs.unlink(req.file.path).catch(() => { });
    const previewUrl = `/media/${mediaPrefix}/${fileName}`;
    const imageRef = await saveImageReference({
      cattleId,
      imageType: `muzzle${slot}`,
      localPath: outPath,
      previewUrl
    });
    if (cloudinaryEnabled && !imageRef.cloudinary?.secureUrl) {
      res.status(503).json({
        error: `Muzzle ${slot} was processed but durable upload failed. Keep this screen open and retake this slot.`,
        cloudinaryError: imageRef.cloudinaryError || 'Cloudinary upload failed.'
      });
      return;
    }
    res.json({
      slot,
      savedAs: fileName,
      previewUrl,
      cloudinaryUrl: imageRef.cloudinary?.secureUrl || null,
      imageRef,
      matchResolution: null,
      matchPending: slot === MUZZLE_IMAGE_COUNT,
      matchError: null,
      result
    });
  } catch (error) {
    next(error);
  } finally {
    await removeUploadedFile(req.file?.path, fs);
  }
});

app.post('/api/enrollments/:cattleId/images', requireAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'image is required' });
      return;
    }

    const imageType = String(req.body.type || '');
    const allowed = new Set(['face1', 'face2', 'face3', 'leftside', 'rightside', 'back', 'udder']);

    if (!allowed.has(imageType)) {
      res.status(400).json({ error: 'Unsupported image type.' });
      return;
    }

    const cattleIdSafe = safeCattleId(req.params.cattleId);
    await assertUserCanAccessCattle(req.user, cattleIdSafe);
    const { folder, mediaPrefix } = await getActiveCaptureFolder(cattleIdSafe);
    const fileName = `${imageType}.jpg`;
    const outPath = path.join(folder, fileName);

    await resizeAndSave(req.file.path, outPath);
    await fs.unlink(req.file.path).catch(() => { });
    const previewUrl = `/media/${mediaPrefix}/${fileName}`;
    const imageRef = await saveImageReference({
      cattleId: cattleIdSafe,
      imageType,
      localPath: outPath,
      previewUrl
    });
    if (cloudinaryEnabled && !imageRef.cloudinary?.secureUrl) {
      res.status(503).json({
        error: `${fileName} was processed but durable upload failed. Retake this photo before completing the record.`,
        cloudinaryError: imageRef.cloudinaryError || 'Cloudinary upload failed.'
      });
      return;
    }

    res.json({
      savedAs: fileName,
      previewUrl,
      cloudinaryUrl: imageRef.cloudinary?.secureUrl || null,
      imageRef
    });
  } catch (error) {
    next(error);
  } finally {
    await removeUploadedFile(req.file?.path, fs);
  }
});

app.post('/api/enrollments/:cattleId/complete', requireAuth, async (req, res, next) => {
  try {
    const cattleId = safeCattleId(req.params.cattleId);
    let rows = await readMetadata();
    let row = normalizeRecord(rows.find((item) => item.cattleId === cattleId));

    if (!row) {
      res.status(404).json({ error: 'Enrollment not found.' });
      return;
    }
    if (!userOwnsRecord(req.user, row)) {
      res.status(403).json({ error: 'This cattle record belongs to another field officer.' });
      return;
    }

    let session = getActiveSession(row);
    let missing = await findMissingRequiredImages(session);

    if (missing.length && cloudinaryEnabled) {
      await recoverCloudinaryImageReferences(cattleId, session, missing);
      rows = await readMetadata();
      row = normalizeRecord(rows.find((item) => item.cattleId === cattleId));
      session = getActiveSession(row);
      missing = await findMissingRequiredImages(session);
    }

    if (missing.length) {
      res.status(409).json({
        error: 'Enrollment is incomplete.',
        missing,
        savedImageTypes: Object.keys(session.images || {})
      });
      return;
    }

    if (!session.matchResult?.resolved) {
      await resolveMuzzleMatch(cattleId);
      rows = await readMetadata();
      row = normalizeRecord(rows.find((item) => item.cattleId === cattleId));
      session = getActiveSession(row);
    }

    const workflow = normalizeWorkflow(row.workflow || session.workflow, 'cattle_enrolment');

    if (session.matchResult?.duplicateSavedSeparately) {
      const duplicateStatus = workflow === 'cattle_search' ? 'duplicate_saved_separately' : 'enrolment_duplicate_blocked';
      row.status = duplicateStatus;
      session.status = duplicateStatus;
      row.workflow = workflow;
      session.workflow = workflow;
    } else if (workflow === 'cattle_search') {
      row.status = 'cattle_search_no_match';
      session.status = 'cattle_search_no_match';
      row.workflow = 'cattle_search';
      session.workflow = 'cattle_search';
    } else {
      row.status = 'ready_for_embedding';
      session.status = 'ready_for_embedding';
      row.workflow = 'cattle_enrolment';
      session.workflow = 'cattle_enrolment';
    }

    if (req.body.captureDurationSeconds !== undefined) {
      const durationSeconds = Number(req.body.captureDurationSeconds);
      if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
        session.captureDurationSeconds = Math.min(durationSeconds, 24 * 60 * 60);
      }
    }

    row.uploadDateTime = new Date().toISOString();
    await persistMetadataRecord(row);
    res.json({ enrollment: row });
  } catch (error) {
    next(error);
  }
});

app.post('/api/enrollments/:cattleId/resolve-muzzle-match', requireAuth, async (req, res, next) => {
  try {
    const cattleId = safeCattleId(req.params.cattleId);
    await assertUserCanAccessCattle(req.user, cattleId);
    const matchResolution = await resolveMuzzleMatch(cattleId);
    res.json({ matchResolution });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.use(express.static(frontendDistDir, {
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.get('*', async (_req, res, next) => {
  try {
    await fs.access(path.join(frontendDistDir, 'index.html'));
    res.sendFile(path.join(frontendDistDir, 'index.html'));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const message = String(error?.message || '');
  const inferredStatus = error?.code === 'LIMIT_FILE_SIZE'
    ? 413
    : (/^Invalid |Only image uploads/.test(message) ? 400 : (message.includes('CORS policy') ? 403 : 500));
  const status = Number(error?.statusCode || error?.status || inferredStatus);
  res.status(status >= 400 && status <= 599 ? status : 500).json({
    error: publicErrorMessage(error),
    code: error?.code || undefined,
    retryable: Boolean(error?.retryable)
  });
});

app.listen(PORT, () => {
  console.log(`Muzzle backend listening on http://localhost:${PORT}`);
});

async function ensureStorage() {
  await fs.mkdir(uploadDir, { recursive: true });

  if (mongoEnabled) {
    MongoClientCtor ||= (await import('mongodb')).MongoClient;
    mongoClient = new MongoClientCtor(MONGODB_URI, { serverSelectionTimeoutMS: 7000, connectTimeoutMS: 7000 });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGODB_DB_NAME);
    await mongoDb.collection('cattle').createIndex({ cattleId: 1 }, { unique: true });
    await mongoDb.collection('cattle').createIndex({ 'sessions.offlineCaptureId': 1 }, { unique: true, sparse: true });
    await mongoDb.collection('cattle').createIndex({ farmerName: 1 });
    await mongoDb.collection('cattle').createIndex({ location: '2dsphere' }, { sparse: true });
    await mongoDb.collection('users').createIndex({ userId: 1 }, { unique: true });
    await mongoDb.collection('users').createIndex({ agentId: 1 }, { unique: true, sparse: true });
    await mongoDb.collection('users').createIndex({ phone: 1 }, { unique: true, sparse: true });
    await mongoDb.collection('match_audits').createIndex({ auditId: 1 }, { unique: true });
    await mongoDb.collection('match_audits').createIndex({ resolvedAt: -1 });
    await mongoDb.collection('match_audits').createIndex({ confidence: 1 });
    await mongoDb.collection('match_audits').createIndex({ reviewStatus: 1 });

    await importLocalJsonIfMongoEmpty();

    const admin = await mongoDb.collection('users').findOne({ role: 'admin' });
    if (!admin) {
      await mongoDb.collection('users').insertOne(createDefaultAdmin());
    }

    return;
  }

  try {
    await fs.access(metadataPath);
  } catch {
    await fs.writeFile(metadataPath, '[]\n', 'utf8');
  }

  try {
    await fs.access(usersPath);
  } catch {
    const defaultAdmin = createDefaultAdmin();
    await fs.writeFile(usersPath, `${JSON.stringify([defaultAdmin], null, 2)}\n`, 'utf8');
  }

  const fileUsers = await readUsers();
  if (!fileUsers.some((user) => user.role === 'admin')) {
    await persistUser(createDefaultAdmin());
  }

  try {
    await fs.access(matchAuditsPath);
  } catch {
    await fs.writeFile(matchAuditsPath, '[]\n', 'utf8');
  }
}

async function importLocalJsonIfMongoEmpty() {
  const cattleCount = await mongoDb.collection('cattle').countDocuments();
  if (cattleCount === 0 && await pathExists(metadataPath)) {
    const localRows = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    if (localRows.length) {
      await mongoDb.collection('cattle').insertMany(localRows.map((row) => addMongoGeoPoint(stripMongoId(row))));
    }
  }

  const userCount = await mongoDb.collection('users').countDocuments();
  if (userCount === 0 && await pathExists(usersPath)) {
    const localUsers = JSON.parse(await fs.readFile(usersPath, 'utf8'));
    if (localUsers.length) {
      await mongoDb.collection('users').insertMany(localUsers.map(stripMongoId));
    }
  }
}

async function readMetadata() {
  if (mongoDb) {
    return mongoDb.collection('cattle').find({}, { projection: { _id: 0 } }).toArray();
  }

  const raw = await fs.readFile(metadataPath, 'utf8');
  return JSON.parse(raw);
}

async function readCleanMetadata() {
  const rows = (await readMetadata()).map(normalizeRecord).filter(Boolean);
  const cleanRows = removeStaleMergedRows(rows);

  if (cleanRows.length !== rows.length) {
    const liveIds = new Set(cleanRows.map((row) => row.cattleId));
    await deleteMetadataRecords(rows.filter((row) => !liveIds.has(row.cattleId)).map((row) => row.cattleId));
  }

  return cleanRows;
}

function removeStaleMergedRows(rows) {
  const liveIds = new Set(rows.map((row) => row.cattleId).filter(Boolean));
  return rows.filter((row) => !isStaleMergedRecord(row, liveIds));
}

function isStaleMergedRecord(row, liveIds) {
  if (!row?.cattleId || row.status !== 'merged_into_existing') return false;
  const sessions = row.sessions || [];
  if (!sessions.length) return true;

  return sessions.every((session) => {
    const result = session.matchResult || {};
    const matchedCattleId = result.matchedCattleId || session.matchedCattleId;
    return session.status === 'muzzle_matched_existing'
      && result.decision === 'matched_existing'
      && matchedCattleId
      && matchedCattleId !== row.cattleId
      && liveIds.has(matchedCattleId);
  });
}

async function persistMetadataRecord(value) {
  const record = normalizeRecord(value);
  if (!record?.cattleId) throw new Error('Cannot save a cattle record without a cattle ID.');

  if (mongoDb) {
    await mongoDb.collection('cattle').replaceOne(
      { cattleId: record.cattleId },
      addMongoGeoPoint(stripMongoId(record)),
      { upsert: true }
    );
    return record;
  }

  await withWriteLock(async () => {
    const rows = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const index = rows.findIndex((row) => row?.cattleId === record.cattleId);
    if (index >= 0) rows[index] = record;
    else rows.push(record);
    await fs.writeFile(metadataPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  });
  return record;
}

async function deleteMetadataRecords(cattleIds) {
  const ids = [...new Set((cattleIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return;

  if (mongoDb) {
    await mongoDb.collection('cattle').deleteMany({ cattleId: { $in: ids } });
    return;
  }

  await withWriteLock(async () => {
    const rows = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const idSet = new Set(ids);
    const remaining = rows.filter((row) => !idSet.has(row?.cattleId));
    await fs.writeFile(metadataPath, `${JSON.stringify(remaining, null, 2)}\n`, 'utf8');
  });
}

async function readUsers() {
  if (mongoDb) {
    return mongoDb.collection('users').find({}, { projection: { _id: 0 } }).toArray();
  }

  const raw = await fs.readFile(usersPath, 'utf8');
  return JSON.parse(raw);
}

async function persistUser(value) {
  const user = stripMongoId(value);
  if (!user?.userId) throw new Error('Cannot save a user without a user ID.');

  if (mongoDb) {
    await mongoDb.collection('users').replaceOne(
      { userId: user.userId },
      user,
      { upsert: true }
    );
    return user;
  }

  await withWriteLock(async () => {
    const users = JSON.parse(await fs.readFile(usersPath, 'utf8'));
    const duplicate = users.find((item) => item.userId !== user.userId && (
      normalizeSearchText(item.agentId) === normalizeSearchText(user.agentId)
      || normalizeSearchText(item.phone) === normalizeSearchText(user.phone)
    ));
    if (duplicate) {
      const error = new Error('Agent ID or phone already exists.');
      error.statusCode = 409;
      throw error;
    }
    const index = users.findIndex((item) => item.userId === user.userId);
    if (index >= 0) users[index] = user;
    else users.push(user);
    await fs.writeFile(usersPath, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
  });
  return user;
}

async function readMatchAudits() {
  if (mongoDb) {
    return mongoDb.collection('match_audits').find({}, { projection: { _id: 0 } }).toArray();
  }

  const raw = await fs.readFile(matchAuditsPath, 'utf8');
  return JSON.parse(raw);
}

async function persistMatchAudit(value) {
  const audit = stripMongoId(value);
  if (!audit?.auditId) throw new Error('Cannot save a match review without an audit ID.');

  if (mongoDb) {
    await mongoDb.collection('match_audits').replaceOne(
      { auditId: audit.auditId },
      audit,
      { upsert: true }
    );
    return audit;
  }

  await withWriteLock(async () => {
    const audits = JSON.parse(await fs.readFile(matchAuditsPath, 'utf8'));
    const index = audits.findIndex((item) => item?.auditId === audit.auditId);
    if (index >= 0) audits[index] = { ...audits[index], ...audit };
    else audits.push(audit);
    await fs.writeFile(matchAuditsPath, `${JSON.stringify(audits, null, 2)}\n`, 'utf8');
  });
  return audit;
}

function createDefaultAdmin() {
  const password = INITIAL_ADMIN_PASSWORD || (REQUIRE_PRODUCTION_SERVICES ? '' : 'admin123');
  if (password.length < 12 && REQUIRE_PRODUCTION_SERVICES) {
    throw new Error('No administrator exists. Set INITIAL_ADMIN_PASSWORD to at least 12 characters, then restart once to create the first admin.');
  }
  return {
    userId: randomUUID(),
    role: 'admin',
    name: INITIAL_ADMIN_NAME,
    phone: INITIAL_ADMIN_PHONE,
    agentId: INITIAL_ADMIN_AGENT_ID,
    active: true,
    createdAt: new Date().toISOString(),
    passwordHash: hashPassword(password)
  };
}

function stripMongoId(value) {
  const { _id, ...rest } = value || {};
  return rest;
}

function addMongoGeoPoint(record) {
  const lat = Number(record.locationLat);
  const lon = Number(record.locationLon);

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return {
      ...record,
      location: {
        type: 'Point',
        coordinates: [lon, lat]
      }
    };
  }

  const { location, ...rest } = record;
  return rest;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = verifyJwt(token, JWT_SECRET);

  if (!user) {
    res.status(401).json({ error: 'Login required or session expired.' });
    return;
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }

  next();
}

async function assertUserCanAccessCattle(user, cattleId) {
  const rows = await readMetadata();
  const row = normalizeRecord(rows.find((item) => item?.cattleId === cattleId));
  if (!row) {
    const error = new Error('Enrollment not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!userOwnsRecord(user, row)) {
    const error = new Error('This cattle record belongs to another field officer.');
    error.statusCode = 403;
    throw error;
  }
  return row;
}

function toPublicUser(user) {
  return {
    userId: user.userId,
    role: user.role,
    name: user.name,
    phone: user.phone,
    agentId: user.agentId,
    active: user.active,
    createdAt: user.createdAt
  };
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [scheme, salt, hash] = String(storedHash || '').split('$');
  if (scheme !== 'pbkdf2' || !salt || !hash) return false;

  const candidate = pbkdf2Sync(password, salt, 120000, 32, 'sha256');
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

async function ensureCattleFolder(cattleId) {
  const folder = path.join(dataDir, cattleId);
  await fs.mkdir(folder, { recursive: true });
  return folder;
}

async function createCaptureSession({ cattleId, captureDateTime }) {
  const rootFolder = await ensureCattleFolder(cattleId);
  const dateKey = toDateKey(captureDateTime);
  let folderName = dateKey;
  let folder = path.join(rootFolder, folderName);
  let suffix = 2;

  while (await pathExists(folder)) {
    folderName = `${dateKey}-${suffix}`;
    folder = path.join(rootFolder, folderName);
    suffix += 1;
  }

  await fs.mkdir(folder, { recursive: true });

  return {
    sessionId: folderName,
    captureDate: dateKey,
    captureDateTime,
    uploadDateTime: new Date().toISOString(),
    folderLocation: folder,
    fieldOfficerId: '',
    fieldOfficerName: '',
    status: 'draft'
  };
}

async function getActiveCaptureFolder(cattleId) {
  const rows = await readMetadata();
  const row = normalizeRecord(rows.find((item) => item.cattleId === cattleId));

  if (!row) {
    throw new Error('Enrollment not found. Create enrollment first.');
  }

  const session = getActiveSession(row);
  await fs.mkdir(session.folderLocation, { recursive: true });

  return {
    folder: session.folderLocation,
    mediaPrefix: toMediaPrefix(path.relative(dataDir, session.folderLocation))
  };
}

async function saveClientProcessedMuzzle(inputPath, outPath) {
  // Node's copyFile can return EPERM on Windows drives mounted through WSL even
  // when both paths are writable. Images are small, so read/write is reliable
  // across native Windows, WSL DrvFS, Linux and container filesystems.
  await fs.writeFile(outPath, await fs.readFile(inputPath));
  return {
    detected: true,
    confidence: 1,
    bbox: [],
    imageSize: [],
    claheApplied: true,
    clientProcessed: true,
    imgsz: null
  };
}

async function saveImageReference({ cattleId, imageType, localPath, previewUrl }) {
  const rows = await readMetadata();
  const rowIndex = rows.findIndex((item) => item.cattleId === cattleId);
  const row = normalizeRecord(rows[rowIndex]);

  if (!row) {
    throw new Error('Enrollment not found. Create enrollment first.');
  }

  const session = getActiveSession(row);
  const fileName = path.basename(localPath);
  const reference = {
    imageType,
    fileName,
    localPath,
    previewUrl,
    uploadedAt: new Date().toISOString(),
    cloudinary: null
  };

  if (cloudinaryEnabled) {
    try {
      reference.cloudinary = await uploadImageToCloudinary({ cattleId, sessionId: session.sessionId, imageType, localPath });
    } catch (error) {
      reference.cloudinaryError = error.message || 'Cloudinary upload failed.';
    }
  }

  await persistImageReference(cattleId, session.sessionId, reference);
  return reference;
}

async function persistImageReference(cattleId, sessionId, reference) {
  if (mongoDb) {
    const imagePath = `sessions.$[session].images.${reference.imageType}`;
    const result = await mongoDb.collection('cattle').updateOne(
      { cattleId },
      {
        $set: {
          [imagePath]: reference,
          'sessions.$[session].uploadDateTime': reference.uploadedAt,
          uploadDateTime: reference.uploadedAt
        }
      },
      { arrayFilters: [{ 'session.sessionId': sessionId }] }
    );
    if (!result.matchedCount) throw new Error('Active capture session was not found while saving the image.');
    return;
  }

  await withWriteLock(async () => {
    const rows = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    const rowIndex = rows.findIndex((item) => item.cattleId === cattleId);
    const row = normalizeRecord(rows[rowIndex]);
    if (!row) throw new Error('Enrollment not found. Create enrollment first.');
    const session = row.sessions.find((item) => item.sessionId === sessionId);
    if (!session) throw new Error('Active capture session was not found while saving the image.');

    session.images = { ...(session.images || {}), [reference.imageType]: reference };
    session.uploadDateTime = reference.uploadedAt;
    row.uploadDateTime = reference.uploadedAt;
    rows[rowIndex] = row;
    await fs.writeFile(metadataPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  });
}

async function findMissingRequiredImages(session) {
  const files = new Set(await fs.readdir(session.folderLocation).catch(() => []));
  return REQUIRED_IMAGES.filter((file) => {
    const imageType = path.basename(file, path.extname(file));
    const reference = session.images?.[imageType];
    const hasDurableUpload = Boolean(reference?.cloudinary?.secureUrl);
    const hasLocalFile = files.has(file) || Boolean(reference?.localPath && existsSync(reference.localPath));
    return !hasDurableUpload && !hasLocalFile;
  });
}

async function recoverCloudinaryImageReferences(cattleId, session, missingFiles) {
  for (const fileName of missingFiles) {
    const imageType = path.basename(fileName, path.extname(fileName));
    const publicId = `${CLOUDINARY_ROOT_FOLDER}/cattle/${cattleId}/${session.sessionId}/${imageType}`;
    try {
      const resource = await cloudinary.api.resource(publicId, { resource_type: 'image' });
      const reference = {
        imageType,
        fileName,
        localPath: path.join(session.folderLocation, fileName),
        previewUrl: resource.secure_url,
        uploadedAt: resource.created_at || new Date().toISOString(),
        cloudinary: {
          publicId: resource.public_id,
          secureUrl: resource.secure_url,
          format: resource.format,
          bytes: resource.bytes,
          width: resource.width,
          height: resource.height
        },
        recoveredAt: new Date().toISOString()
      };
      await persistImageReference(cattleId, session.sessionId, reference);
    } catch (error) {
      if (error?.http_code !== 404) {
        console.error(`Could not recover ${imageType} for ${cattleId}:`, error);
      }
    }
  }
}

async function resolveMuzzleMatch(cattleId) {
  const rows = await readCleanMetadata();
  const queryIndex = rows.findIndex((item) => item?.cattleId === cattleId);
  const queryRow = rows[queryIndex];

  if (!queryRow) {
    throw new Error('Enrollment not found. Create enrollment first.');
  }

  const querySession = getActiveSession(queryRow);
  const queryWorkflow = normalizeWorkflow(queryRow.workflow || querySession.workflow, 'cattle_enrolment');
  queryRow.workflow = queryWorkflow;
  querySession.workflow = queryWorkflow;
  if (querySession.matchResult?.resolved) {
    return {
      ...querySession.matchResult,
      enrollment: queryRow
    };
  }

  const queryEmbedding = await ensureSessionEmbedding(queryRow, querySession);

  const ownerNumberMap = buildOwnerCattleNumberMap(rows.filter((row) => row && !isDuplicateEvidenceRecord(row) && isSearchableCattleRecord(row)));
  let rawCandidates = await queryPineconeMatches({ queryRow, queryEmbedding, ownerNumberMap }).catch(() => []);

  if (!rawCandidates.length) {
    const preparedCandidates = [];
    for (let index = 0; index < rows.length; index += 1) {
      const candidateRow = rows[index];
      if (!candidateRow || candidateRow.cattleId === cattleId || isDuplicateEvidenceRecord(candidateRow) || !isSearchableCattleRecord(candidateRow)) continue;
      const distanceKm = distanceBetweenRowsKm(queryRow, candidateRow);
      const searchScope = queryWorkflow === 'cattle_search'
        ? candidateSearchScope(queryRow, candidateRow, distanceKm)
        : (isSameFarmerCandidate(queryRow, candidateRow) ? 'farmer_cattle' : 'all_other_muzzle');

      for (const candidateSession of candidateRow.sessions || []) {
        const candidateEmbedding = candidateSession.embedding?.average;
        if (!candidateEmbedding) continue;

        preparedCandidates.push({
          cattleId: candidateRow.cattleId,
          cattleNumber: ownerNumberMap.get(candidateRow.cattleId) || null,
          cattleLabel: cattleDisplayLabel(ownerNumberMap.get(candidateRow.cattleId)),
          searchScope,
          sessionId: candidateSession.sessionId,
          farmerName: candidateRow.farmerName,
          fieldOfficerName: candidateRow.fieldOfficerName,
          locationLat: candidateRow.locationLat,
          locationLon: candidateRow.locationLon,
          distanceKm,
          score: cosineSimilarity(queryEmbedding, candidateEmbedding),
          rowIndex: index
        });
      }
    }
    rawCandidates = preparedCandidates;
  }

  rawCandidates.sort((a, b) => b.score - a.score);
  const candidates = bestCandidatePerCattle(rawCandidates);
  const farmerCandidates = candidates.filter((candidate) => candidate.searchScope === 'farmer_cattle');
  const nearbyCandidates = candidates.filter((candidate) => candidate.searchScope === 'nearby_location');
  const hasSelectedFarmer = Boolean(normalizeSearchText(queryRow.farmerId) || normalizeSearchText(queryRow.farmerName));
  const bestFarmerMatch = hasSelectedFarmer && farmerCandidates[0]?.score >= EMBEDDING_MATCH_THRESHOLD ? farmerCandidates[0] : null;
  const bestNearbyMatch = queryWorkflow === 'cattle_search' && nearbyCandidates[0]?.score >= EMBEDDING_MATCH_THRESHOLD ? nearbyCandidates[0] : null;
  const bestGlobalMatch = queryWorkflow === 'cattle_enrolment' ? candidates[0] || null : null;
  const eligibleSearchCandidates = hasSelectedFarmer ? [...farmerCandidates, ...nearbyCandidates] : nearbyCandidates;
  const orderedMatches = queryWorkflow === 'cattle_search'
    ? (bestFarmerMatch
      ? [...farmerCandidates, ...nearbyCandidates]
      : (bestNearbyMatch
        ? [...nearbyCandidates, ...farmerCandidates]
        : eligibleSearchCandidates.sort((a, b) => b.score - a.score)))
    : (bestFarmerMatch ? [bestFarmerMatch, ...candidates.filter((candidate) => candidate !== bestFarmerMatch)] : candidates);
  const bestMatch = queryWorkflow === 'cattle_search'
    ? bestFarmerMatch || bestNearbyMatch || orderedMatches[0] || null
    : bestFarmerMatch || bestGlobalMatch;
  const rankedTopMatches = candidates.slice(0, 20).map(toPublicMatchResult);
  const topMatches = orderedMatches.slice(0, 5).map(toPublicMatchResult);
  const farmerComparison = buildFarmerComparison(queryRow, farmerCandidates);
  const isMatched = queryWorkflow === 'cattle_search'
    ? Boolean(bestFarmerMatch || bestNearbyMatch)
    : Boolean(bestMatch && bestMatch.score >= EMBEDDING_MATCH_THRESHOLD);

  if (isMatched) {
    const now = new Date().toISOString();
    const duplicateOf = topMatches[0] || null;
    const duplicateStatus = queryWorkflow === 'cattle_search' ? 'duplicate_saved_separately' : 'enrolment_duplicate_blocked';
    const matchResult = {
      resolved: true,
      decision: 'matched_existing',
      workflow: queryWorkflow,
      duplicateSavedSeparately: true,
      confidence: bestMatch?.score || 0,
      confidencePercent: similarityPercent(bestMatch?.score),
      threshold: EMBEDDING_MATCH_THRESHOLD,
      thresholdPercent: Math.round(EMBEDDING_MATCH_THRESHOLD * 100),
      matchedCattleId: bestMatch.cattleId,
      duplicateOfCattleId: bestMatch.cattleId,
      duplicateOfFarmerName: bestMatch.farmerName || '',
      previousCattleId: queryRow.cattleId,
      topMatches,
      rankedTopMatches,
      farmerComparison,
      resolvedAt: now
    };

    querySession.matchResult = matchResult;
    querySession.status = duplicateStatus;
    queryRow.status = duplicateStatus;
    queryRow.workflow = queryWorkflow;
    querySession.workflow = queryWorkflow;
    queryRow.duplicateOfCattleId = duplicateOf?.cattleId || bestMatch.cattleId;
    queryRow.duplicateOfFarmerName = duplicateOf?.farmerName || bestMatch.farmerName || '';
    queryRow.uploadDateTime = now;
    if (queryWorkflow === 'cattle_search') {
      await upsertSessionVector(queryRow, querySession, { namespace: PINECONE_SEARCH_NAMESPACE, workflow: 'cattle_search' }).catch(() => null);
    }
    await persistMetadataRecord(queryRow);
    await storeMatchAudit({
      cattleId: queryRow.cattleId,
      finalCattleId: queryRow.cattleId,
      session: querySession,
      matchResult,
      farmerId: queryRow.farmerId,
      farmerName: queryRow.farmerName,
      fieldOfficerId: queryRow.fieldOfficerId,
      fieldOfficerName: queryRow.fieldOfficerName,
      locationLat: queryRow.locationLat,
      locationLon: queryRow.locationLon,
      locationAccuracyM: queryRow.locationAccuracyM,
      matchRadiusKm: queryRow.matchRadiusKm
    });
    return {
      ...matchResult,
      enrollment: queryRow
    };
  }

  const now = new Date().toISOString();
  const matchResult = {
    resolved: true,
    decision: 'new_cattle',
    workflow: queryWorkflow,
    confidence: bestMatch?.score || 0,
    confidencePercent: similarityPercent(bestMatch?.score),
    threshold: EMBEDDING_MATCH_THRESHOLD,
    thresholdPercent: Math.round(EMBEDDING_MATCH_THRESHOLD * 100),
    matchedCattleId: null,
    topMatches,
    rankedTopMatches,
    farmerComparison,
    resolvedAt: now
  };

  querySession.matchResult = matchResult;
  querySession.status = queryWorkflow === 'cattle_search' ? 'cattle_search_no_match' : 'muzzle_no_match_new_cattle';
  queryRow.status = queryWorkflow === 'cattle_search' ? 'cattle_search_no_match' : 'muzzle_no_match_new_cattle';
  queryRow.uploadDateTime = now;
  await upsertSessionVector(queryRow, querySession, {
    namespace: queryWorkflow === 'cattle_search' ? PINECONE_SEARCH_NAMESPACE : PINECONE_ENROLMENT_NAMESPACE,
    workflow: queryWorkflow
  }).catch(() => null);
  await persistMetadataRecord(queryRow);
  await storeMatchAudit({
    cattleId: queryRow.cattleId,
    finalCattleId: queryRow.cattleId,
    session: querySession,
    matchResult,
    farmerId: queryRow.farmerId,
    farmerName: queryRow.farmerName,
    fieldOfficerId: queryRow.fieldOfficerId,
    fieldOfficerName: queryRow.fieldOfficerName,
    locationLat: queryRow.locationLat,
    locationLon: queryRow.locationLon,
    locationAccuracyM: queryRow.locationAccuracyM,
    matchRadiusKm: queryRow.matchRadiusKm
  });

  return {
    ...matchResult,
    enrollment: queryRow
  };
}




async function readImageForZip(image) {
  const candidates = [];
  if (image?.localPath) candidates.push(image.localPath);
  if (image?.previewUrl?.startsWith('/media/')) {
    candidates.push(path.join(dataDir, image.previewUrl.replace(/^\/media\//, '')));
  }

  for (const candidate of candidates) {
    if (candidate && await pathExists(candidate)) {
      return fs.readFile(candidate);
    }
  }

  const cloudinaryUrl = image?.cloudinary?.secureUrl;
  if (cloudinaryUrl) {
    const response = await fetch(cloudinaryUrl);
    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }
  }

  return null;
}
function safeZipName(value) {
  return String(value || 'item')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 120) || 'item';
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.zipPath.replace(/\\/g, '/'), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});
function buildOwnerCattleNumberMap(rows) {
  const groups = new Map();
  // Display numbers belong only to canonical enrolled cattle. Search and
  // duplicate-evidence records must never create gaps such as Cattle 1, 4.
  for (const row of rows.map(normalizeRecord).filter(isRegisteredInventoryRecord)) {
    const key = ownerGroupKey(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const numberMap = new Map();
  for (const group of groups.values()) {
    group
      .sort((a, b) => String(firstCaptureDateTime(a) || '').localeCompare(String(firstCaptureDateTime(b) || '')) || String(a.cattleId).localeCompare(String(b.cattleId)))
      .forEach((row, index) => numberMap.set(row.cattleId, index + 1));
  }
  return numberMap;
}

function generateUniqueFarmerId(rows) {
  const existingIds = new Set(rows.map((row) => normalizeSearchText(row?.farmerId)).filter(Boolean));

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = `FARM-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    if (!existingIds.has(normalizeSearchText(candidate))) return candidate;
  }

  return `FARM-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

function findLikelyExistingFarmer(rows, farmerName, locationLat, locationLon) {
  const farmerNameNorm = normalizeSearchText(farmerName);
  if (!farmerNameNorm) return null;

  return rows
    .filter((row) => row?.farmerId
      && normalizeSearchText(row.farmerName) === farmerNameNorm
      && !isDuplicateEvidenceRecord(row))
    .map((row) => ({ row, distanceKm: haversineKm(locationLat, locationLon, row.locationLat, row.locationLon) }))
    .filter((candidate) => candidate.distanceKm !== null && candidate.distanceKm <= 0.25)
    .sort((a, b) => a.distanceKm - b.distanceKm)[0]?.row || null;
}
function ownerGroupKey(row) {
  const farmerId = normalizeSearchText(row.farmerId);
  if (farmerId) return `id:${farmerId}`;
  const farmerName = normalizeSearchText(row.farmerName);
  if (farmerName) return `name:${farmerName}`;
  return 'unknown';
}

function isDuplicateEvidenceRecord(row) {
  return isCattleSearchRecord(row) || row?.status === 'duplicate_saved_separately' || Boolean(row?.duplicateOfCattleId);
}

function isCattleSearchRecord(row) {
  return row?.workflow === 'cattle_search' || String(row?.status || '').startsWith('cattle_search_');
}

function sessionHasRequiredImages(session) {
  const imageNames = new Set(Object.values(session?.images || {}).map((image) => image.fileName).filter(Boolean));
  return REQUIRED_IMAGES.every((fileName) => imageNames.has(fileName));
}

function sessionHasMuzzleImages(session) {
  const imageNames = new Set(Object.values(session?.images || {}).map((image) => image.fileName).filter(Boolean));
  return MUZZLE_IMAGE_FILES.every((fileName) => imageNames.has(fileName));
}

function hasSearchableMuzzleSession(row) {
  return (row?.sessions || []).some((session) => sessionHasMuzzleImages(session) && session.embedding?.average?.length);
}

function hasCompletedSession(row) {
  return (row?.sessions || []).some((session) => sessionHasRequiredImages(session));
}

const VISIBLE_REGISTERED_STATUSES = new Set([
  'ready_for_embedding', 'admin_merged', 'muzzle_matched_existing',
  'muzzle_no_match_new_cattle', 'merged_into_existing'
]);

function isVisibleInventoryRecord(row) {
  if (!row?.cattleId) return false;
  if (row.status === 'draft' || row.status === 'cattle_search_draft' || row.status === 'cattle_search_manual_folder') return false;
  if (isDuplicateEvidenceRecord(row)) return hasCompletedSession(row);
  return hasCompletedSession(row) && VISIBLE_REGISTERED_STATUSES.has(row.status);
}

function isRegisteredInventoryRecord(row) {
  return isVisibleInventoryRecord(row) && !isDuplicateEvidenceRecord(row);
}

function isSearchableCattleRecord(row) {
  if (!row?.cattleId || isDuplicateEvidenceRecord(row)) return false;
  if (row.status === 'draft' || row.status === 'cattle_search_draft' || row.status === 'cattle_search_manual_folder') return false;
  return hasSearchableMuzzleSession(row);
}

function firstCaptureDateTime(row) {
  const sessions = row.sessions || [];
  return sessions[0]?.captureDateTime || row.captureDateTime || '';
}

function cattleDisplayLabel(cattleNumber) {
  return cattleNumber ? `Cattle ${cattleNumber}` : 'Cattle';
}
function toCattleSummary(row, cattleNumber = null) {
  const sessions = (row.sessions || []).map((session) => toSessionSummary(row, session));
  const lastSession = sessions.at(-1) || null;
  const imageCount = sessions.reduce((total, session) => total + session.imageCount, 0);
  const cloudinaryRootFolder = `${CLOUDINARY_ROOT_FOLDER}/cattle/${row.cattleId}`;

  return {
    cattleId: row.cattleId,
    cattleNumber: cattleNumber || null,
    cattleLabel: cattleDisplayLabel(cattleNumber),
    farmerId: row.farmerId || '',
    farmerName: row.farmerName || '',
    fieldOfficerId: row.fieldOfficerId || '',
    fieldOfficerName: row.fieldOfficerName || '',
    workflow: row.workflow || (isCattleSearchRecord(row) ? 'cattle_search' : 'cattle_enrolment'),
    locationLat: row.locationLat ?? null,
    locationLon: row.locationLon ?? null,
    status: row.status || 'draft',
    isDuplicateEvidence: isDuplicateEvidenceRecord(row),
    duplicateOfCattleId: row.duplicateOfCattleId || row.sessions?.find((session) => session.matchResult?.duplicateOfCattleId)?.matchResult?.duplicateOfCattleId || null,
    duplicateOfFarmerName: row.duplicateOfFarmerName || row.sessions?.find((session) => session.matchResult?.duplicateOfFarmerName)?.matchResult?.duplicateOfFarmerName || '',
    rootFolderLocation: row.rootFolderLocation || path.join(dataDir, row.cattleId),
    cloudinaryRootFolder: cloudinaryEnabled ? cloudinaryRootFolder : null,
    productionFolder: cloudinaryEnabled ? cloudinaryRootFolder : (row.rootFolderLocation || path.join(dataDir, row.cattleId)),
    sessionCount: sessions.length,
    imageCount,
    lastCaptureDate: lastSession?.captureDate || null,
    lastCaptureDateTime: lastSession?.captureDateTime || null,
    lastPreviewUrl: lastSession?.previewUrl || null,
    lastCloudinaryUrl: lastSession?.cloudinaryUrl || null,
    sessions
  };
}

function toSessionSummary(row, session) {
  const imageRefs = Object.values(session.images || {})
    .map((ref) => toImageSummary(ref))
    .sort((a, b) => imageSortRank(a.imageType) - imageSortRank(b.imageType));
  const firstImage = imageRefs.find((image) => image.imageType === 'muzzle1') || imageRefs[0] || null;
  const cloudinaryFolder = `${CLOUDINARY_ROOT_FOLDER}/cattle/${row.cattleId}/${session.sessionId}`;

  return {
    sessionId: session.sessionId,
    captureDate: session.captureDate,
    captureDateTime: session.captureDateTime,
    uploadDateTime: session.uploadDateTime,
    workflow: session.workflow || row.workflow || (isCattleSearchRecord(row) ? 'cattle_search' : 'cattle_enrolment'),
    status: session.status || 'draft',
    folderLocation: session.folderLocation,
    cloudinaryFolder: cloudinaryEnabled ? cloudinaryFolder : null,
    productionFolder: cloudinaryEnabled ? cloudinaryFolder : session.folderLocation,
    imageCount: imageRefs.length,
    previewUrl: firstImage?.url || null,
    cloudinaryUrl: firstImage?.cloudinaryUrl || null,
    matchResult: session.matchResult || null,
    duplicateSavedSeparately: Boolean(session.matchResult?.duplicateSavedSeparately),
    duplicateOfCattleId: session.matchResult?.duplicateOfCattleId || null,
    duplicateOfFarmerName: session.matchResult?.duplicateOfFarmerName || '',
    images: imageRefs
  };
}

function toImageSummary(ref) {
  return {
    imageType: ref.imageType,
    fileName: ref.fileName,
    previewUrl: ref.previewUrl,
    cloudinaryUrl: ref.cloudinary?.secureUrl || null,
    url: ref.cloudinary?.secureUrl || ref.previewUrl,
    localPath: ref.localPath,
    uploadedAt: ref.uploadedAt || null,
    cloudinaryPublicId: ref.cloudinary?.publicId || null,
    cloudinaryError: ref.cloudinaryError || null
  };
}

function imageSortRank(imageType) {
  const order = [
    ...Array.from({ length: MUZZLE_IMAGE_COUNT }, (_, index) => `muzzle${index + 1}`),
    'face1',
    'face2',
    'face3',
    'leftside',
    'rightside',
    'back',
    'udder'
  ];
  const index = order.indexOf(imageType);
  return index >= 0 ? index : order.length;
}

function buildCattleStats(cattle) {
  const farmerMap = new Map();
  let imageCount = 0;
  let sessionCount = 0;
  let repeatedCattleCount = 0;
  let duplicateCaptureCount = 0;
  let duplicateImageCount = 0;
  let cattleSearchCount = 0;
  let blockedDuplicateEnrollmentCount = 0;

  for (const cow of cattle) {
    imageCount += cow.imageCount;
    sessionCount += cow.sessionCount;

    if (cow.isDuplicateEvidence) {
      duplicateCaptureCount += 1;
      duplicateImageCount += cow.imageCount;
      if (cow.workflow === 'cattle_search') cattleSearchCount += 1;
      else blockedDuplicateEnrollmentCount += 1;
      continue;
    }

    if (cow.sessionCount > 1) repeatedCattleCount += 1;

    const key = (cow.farmerId || cow.farmerName || 'Unknown farmer').trim() || 'Unknown farmer';
    const farmer = farmerMap.get(key) || {
      farmerName: cow.farmerName || 'Unknown farmer',
      farmerId: cow.farmerId || '',
      cattleIds: new Set(),
      sessionCount: 0,
      imageCount: 0
    };
    farmer.cattleIds.add(cow.cattleId);
    farmer.sessionCount += cow.sessionCount;
    farmer.imageCount += cow.imageCount;
    farmerMap.set(key, farmer);
  }

  const farmers = Array.from(farmerMap.values())
    .map((farmer) => ({
      farmerName: farmer.farmerName,
      farmerId: farmer.farmerId,
      cattleCount: farmer.cattleIds.size,
      sessionCount: farmer.sessionCount,
      imageCount: farmer.imageCount
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount);

  const uniqueCattleCount = cattle.filter((cow) => !cow.isDuplicateEvidence).length;

  return {
    cattleCount: uniqueCattleCount,
    uniqueCattleCount,
    duplicateCaptureCount,
    cattleSearchCount,
    blockedDuplicateEnrollmentCount,
    duplicateImageCount,
    totalRecordCount: cattle.length,
    farmerCount: farmers.length,
    sessionCount,
    imageCount,
    repeatedCattleCount,
    farmers
  };
}
async function ensureSessionEmbedding(row, session) {
  if (session.embedding?.average?.length) {
    return session.embedding.average;
  }

  const imagePaths = await muzzleImagePaths(session);
  await assertEmbeddingMemoryCapacity();
  const result = await runAverageEmbedding(imagePaths);
  if (!result.ok || !result.embedding?.length) {
    throw new Error(result.error || 'Could not generate DINOv2 muzzle embedding.');
  }

  session.embedding = {
    model: 'dinov2_triplet_v2',
    modelPath: DINOV2_MODEL_PATH,
    average: result.embedding,
    imageCount: result.imageCount,
    embeddingDim: result.embeddingDim,
    createdAt: new Date().toISOString()
  };
  row.embedding = session.embedding;
  return session.embedding.average;
}

async function assertEmbeddingMemoryCapacity() {
  if (['true', '1', 'yes'].includes(String(process.env.SKIP_EMBEDDING_MEMORY_CHECK || '').toLowerCase())) {
    return;
  }

  const limitBytes = await containerMemoryLimitBytes();
  const requiredBytes = MIN_EMBEDDING_MEMORY_MB * 1024 * 1024;
  if (!limitBytes || limitBytes >= requiredBytes) return;

  const availableMb = Math.round(limitBytes / 1024 / 1024);
  const error = new Error(
    `Matching server memory is too low (${availableMb} MB). Your photos are saved. ` +
    `Upgrade the backend to at least ${MIN_EMBEDDING_MEMORY_MB} MB RAM, then press Save Registered Cow again.`
  );
  error.statusCode = 503;
  error.code = 'EMBEDDING_MEMORY_LIMIT';
  error.retryable = true;
  throw error;
}

async function containerMemoryLimitBytes() {
  const paths = [
    '/sys/fs/cgroup/memory.max',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes'
  ];

  for (const file of paths) {
    try {
      const value = String(await fs.readFile(file, 'utf8')).trim();
      if (!value || value === 'max') continue;
      const bytes = Number(value);
      if (Number.isFinite(bytes) && bytes > 0 && bytes < Number.MAX_SAFE_INTEGER) return bytes;
    } catch {
      // Windows and hosts without cgroup limits do not expose these files.
    }
  }

  return null;
}

async function muzzleImagePaths(session) {
  const files = [];
  for (let slot = 1; slot <= MUZZLE_IMAGE_COUNT; slot += 1) {
    const imageType = `muzzle${slot}`;
    const file = path.join(session.folderLocation, `${imageType}.jpg`);
    if (!await pathExists(file)) {
      const cloudinaryUrl = session.images?.[imageType]?.cloudinary?.secureUrl;
      if (cloudinaryUrl) {
        const response = await fetch(cloudinaryUrl);
        if (response.ok) {
          await fs.mkdir(session.folderLocation, { recursive: true });
          await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
        }
      }
    }
    files.push(file);
  }

  const missing = [];
  for (const file of files) {
    if (!await pathExists(file)) missing.push(path.basename(file));
  }
  if (missing.length) {
    throw new Error(`Need ${MUZZLE_IMAGE_COUNT} muzzle crops before DINOv2 matching. Missing: ${missing.join(', ')}`);
  }

  return files;
}

function runAverageEmbedding(imagePaths) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'embedding_average.py');
  const run = () => runPythonJson([
      scriptPath,
      '--weights',
      DINOV2_MODEL_PATH,
      '--images',
      ...imagePaths
    ]);
  const next = embeddingProcessLock.then(run, run);
  embeddingProcessLock = next.catch(() => undefined);
  return next;
}

function isSameFarmerCandidate(queryRow, candidateRow) {
  return sameFarmerIdentity(queryRow, candidateRow);
}

function distanceBetweenRowsKm(a, b) {
  const aLat = Number(a.locationLat);
  const aLon = Number(a.locationLon);
  const bLat = Number(b.locationLat);
  const bLon = Number(b.locationLon);

  if (![aLat, aLon, bLat, bLon].every(Number.isFinite)) {
    return null;
  }

  return haversineKm(aLat, aLon, bLat, bLon);
}

function candidateSearchScope(queryRow, candidateRow, distanceKm = distanceBetweenRowsKm(queryRow, candidateRow)) {
  if (isSameFarmerCandidate(queryRow, candidateRow)) return 'farmer_cattle';
  const radiusKm = Math.max(0.1, Number(queryRow.matchRadiusKm || 7));
  return distanceKm !== null && distanceKm <= radiusKm ? 'nearby_location' : 'outside_location';
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }
  return dot / Math.max(Math.sqrt(aNorm) * Math.sqrt(bNorm), 1e-12);
}

function bestCandidatePerCattle(candidates) {
  const bestByCattle = new Map();
  for (const candidate of candidates) {
    const existing = bestByCattle.get(candidate.cattleId);
    if (!existing || candidate.score > existing.score) {
      bestByCattle.set(candidate.cattleId, candidate);
    }
  }
  return Array.from(bestByCattle.values()).sort((a, b) => b.score - a.score);
}
function toPublicMatchResult(match) {
  return {
    cattleId: match.cattleId,
    cattleNumber: match.cattleNumber || null,
    cattleLabel: match.cattleLabel || cattleDisplayLabel(match.cattleNumber),
    searchScope: match.searchScope || 'nearby_location',
    sessionId: match.sessionId,
    farmerName: match.farmerName,
    fieldOfficerName: match.fieldOfficerName,
    locationLat: match.locationLat,
    locationLon: match.locationLon,
    distanceKm: match.distanceKm,
    score: match.score,
    confidencePercent: similarityPercent(match.score)
  };
}

function buildFarmerComparison(queryRow, farmerCandidates) {
  const farmerId = String(queryRow.farmerId || '').trim();
  const farmerName = String(queryRow.farmerName || '').trim();
  const rankedMatches = bestCandidatePerCattle(farmerCandidates || []).slice(0, 20).map(toPublicMatchResult);
  const bestMatch = rankedMatches[0] || null;
  const available = Boolean((farmerId || farmerName) && rankedMatches.length);
  const isMatched = available && Number(bestMatch.score || 0) >= EMBEDDING_MATCH_THRESHOLD;

  return {
    available,
    farmerId,
    farmerName,
    candidateCount: rankedMatches.length,
    decision: available ? (isMatched ? 'matched_existing' : 'new_cattle') : null,
    matchedCattleId: isMatched ? bestMatch.cattleId : null,
    confidence: bestMatch?.score || 0,
    confidencePercent: similarityPercent(bestMatch?.score),
    threshold: EMBEDDING_MATCH_THRESHOLD,
    thresholdPercent: Math.round(EMBEDDING_MATCH_THRESHOLD * 100),
    topMatches: rankedMatches
  };
}

function buildAuditFarmerComparison(audit) {
  const combined = [...(audit.rankedTopMatches || []), ...(audit.topMatches || [])];
  const uniqueFarmerCandidates = Array.from(
    new Map(
      combined
        .filter((candidate) => candidate?.searchScope === 'farmer_cattle' && candidate?.cattleId)
        .map((candidate) => [candidate.cattleId, candidate])
    ).values()
  ).sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  return buildFarmerComparison(audit, uniqueFarmerCandidates);
}

function similarityPercent(score) {
  return Math.round(Math.max(0, Math.min(1, Number(score || 0))) * 100);
}

function normalizeAuditScores(audit) {
  const normalizeMatches = (matches) => (matches || []).map((match) => ({
    ...match,
    confidencePercent: similarityPercent(match.score)
  }));
  const normalized = {
    ...audit,
    confidencePercent: similarityPercent(audit.confidence),
    topMatches: normalizeMatches(audit.topMatches),
    rankedTopMatches: normalizeMatches(audit.rankedTopMatches || audit.topMatches)
  };
  const farmerComparison = audit.farmerComparison || buildAuditFarmerComparison(normalized);
  return {
    ...normalized,
    farmerComparison: {
      ...farmerComparison,
      confidencePercent: similarityPercent(farmerComparison?.confidence),
      topMatches: normalizeMatches(farmerComparison?.topMatches)
    }
  };
}

// mergeSessionIntoExistingCattle removed (BUG-028: was dead code, never called)

async function moveSessionIntoTargetCattle({ sourceRow, targetRow, session }) {
  const targetRoot = await ensureCattleFolder(targetRow.cattleId);
  const dateKey = session.captureDate || String(session.captureDateTime || new Date().toISOString()).slice(0, 10);
  const nextFolder = await nextSessionFolder(targetRoot, dateKey);
  const oldFolder = session.folderLocation;

  if (oldFolder && await pathExists(oldFolder)) {
    await fs.mkdir(path.dirname(nextFolder), { recursive: true });
    await fs.rename(oldFolder, nextFolder);
    session.sessionId = path.basename(nextFolder);
    session.folderLocation = nextFolder;
    rebaseSessionImageRefs(session, targetRow.cattleId);
  } else {
    session.sessionId = session.sessionId || path.basename(nextFolder);
  }

  session.status = 'admin_merged';
  session.adminMergedFromCattleId = sourceRow.cattleId;
  session.matchedFromCattleId = session.matchedFromCattleId || sourceRow.cattleId;

  if (cloudinaryEnabled && session.images) {
    await refreshCloudinaryRefs(targetRow.cattleId, session);
  }

  targetRow.sessions = [...(targetRow.sessions || []), session];
}

async function nextSessionFolder(rootFolder, dateKey) {
  let folderName = dateKey;
  let folder = path.join(rootFolder, folderName);
  let suffix = 2;

  while (await pathExists(folder)) {
    folderName = `${dateKey}-${suffix}`;
    folder = path.join(rootFolder, folderName);
    suffix += 1;
  }

  return folder;
}

function rebaseSessionImageRefs(session, cattleId) {
  const relativeFolder = toMediaPrefix(path.relative(dataDir, session.folderLocation));
  for (const [imageType, ref] of Object.entries(session.images || {})) {
    ref.localPath = path.join(session.folderLocation, ref.fileName || `${imageType}.jpg`);
    ref.previewUrl = `/media/${relativeFolder}/${ref.fileName || `${imageType}.jpg`}`;
  }
}

async function refreshCloudinaryRefs(cattleId, session) {
  for (const [imageType, ref] of Object.entries(session.images || {})) {
    try {
      ref.cloudinary = await uploadImageToCloudinary({
        cattleId,
        sessionId: session.sessionId,
        imageType,
        localPath: ref.localPath
      });
      delete ref.cloudinaryError;
    } catch (error) {
      ref.cloudinaryError = error.message || 'Cloudinary upload failed.';
    }
  }
}

async function uploadImageToCloudinary({ cattleId, sessionId, imageType, localPath }) {
  const publicId = `${CLOUDINARY_ROOT_FOLDER}/cattle/${cattleId}/${sessionId}/${imageType}`;
  const uploaded = await cloudinary.uploader.upload(localPath, {
    public_id: publicId,
    overwrite: true,
    resource_type: 'image',
    folder: undefined
  });

  return {
    publicId: uploaded.public_id,
    secureUrl: uploaded.secure_url,
    format: uploaded.format,
    bytes: uploaded.bytes,
    width: uploaded.width,
    height: uploaded.height
  };
}

async function moveMatchedVisitOutAsRegistered(audit, { reviewedBy, reviewNotes } = {}) {
  const rows = (await readMetadata()).map(normalizeRecord).filter(Boolean);
  const cattleId = audit.finalCattleId || audit.cattleId;
  const row = rows.find((item) => item.cattleId === cattleId);

  if (!row) {
    throw new Error('Could not find the cattle search record to move out.');
  }

  const session = (row.sessions || []).find((item) => item.sessionId === audit.sessionId) || getActiveSession(row);
  const now = new Date().toISOString();
  const previousMatchResult = session?.matchResult || null;

  delete row.duplicateOfCattleId;
  delete row.duplicateOfFarmerName;
  row.status = 'ready_for_embedding';
  row.uploadDateTime = now;
  row.adminCorrection = {
    action: 'move_out_as_registered',
    reviewedAt: now,
    reviewedBy: reviewedBy?.userId || reviewedBy?.agentId || reviewedBy?.name || '',
    reviewNotes: reviewNotes || '',
    previousMatchedCattleId: audit.matchedCattleId || previousMatchResult?.matchedCattleId || null
  };

  if (session) {
    session.status = 'ready_for_embedding';
    session.matchResult = {
      ...(previousMatchResult || {}),
      resolved: true,
      decision: 'new_cattle',
      duplicateSavedSeparately: false,
      matchedCattleId: null,
      duplicateOfCattleId: null,
      duplicateOfFarmerName: '',
      adminCorrection: row.adminCorrection,
      correctedAt: now
    };
    await upsertSessionVector(row, session).catch(() => null);
  }

  await persistMetadataRecord(row);
  return row;
}
async function storeMatchAudit({ cattleId, finalCattleId, session, matchResult, farmerId, farmerName, fieldOfficerId, fieldOfficerName, locationLat, locationLon, locationAccuracyM, matchRadiusKm }) {
  const audits = await readMatchAudits();
  const auditId = `${finalCattleId || cattleId}__${session.sessionId}`;
  const existingIndex = audits.findIndex((audit) => audit.auditId === auditId);
  const confidence = Number(matchResult.confidence || 0);
  const uncertainMargin = 0.10;
  const isUncertain = Math.abs(confidence - EMBEDDING_MATCH_THRESHOLD) <= uncertainMargin;
  const audit = {
    auditId,
    cattleId,
    finalCattleId,
    workflow: matchResult.workflow || session.workflow || 'cattle_search',
    sessionId: session.sessionId,
    decision: matchResult.decision,
    confidence,
    confidencePercent: matchResult.confidencePercent,
    threshold: matchResult.threshold,
    thresholdPercent: matchResult.thresholdPercent,
    appVersion: APP_VERSION,
    captureWorkflowVersion: 'cattle-enrolment-search-v2',
    tfliteMuzzleModelVersion: PHONE_TFLITE_MODEL_VERSION,
    backendYoloModelVersion: YOLO_MUZZLE_MODEL_VERSION,
    dinov2ModelVersion: DINOV2_MODEL_VERSION,
    captureDurationSeconds: Number(session.captureDurationSeconds || 0) || null,
    muzzleImageCount: MUZZLE_IMAGE_COUNT,
    matchedCattleId: matchResult.matchedCattleId,
    previousCattleId: matchResult.previousCattleId || null,
    topMatches: matchResult.topMatches || [],
    rankedTopMatches: matchResult.rankedTopMatches || matchResult.topMatches || [],
    farmerComparison: matchResult.farmerComparison || null,
    farmerId: farmerId || '',
    farmerName: farmerName || '',
    fieldOfficerId: fieldOfficerId || session.fieldOfficerId || '',
    fieldOfficerName: fieldOfficerName || '',
    locationLat: locationLat ?? null,
    locationLon: locationLon ?? null,
    locationAccuracyM: locationAccuracyM ?? null,
    matchRadiusKm: Number(matchRadiusKm || 7),
    searchStrategy: matchResult.workflow === 'cattle_enrolment'
      ? 'enrolment_duplicate_check'
      : (farmerId || farmerName ? 'selected_farmer_then_location' : 'location_only'),
    folderLocation: session.folderLocation,
    captureDate: session.captureDate,
    resolvedAt: matchResult.resolvedAt || new Date().toISOString(),
    reviewStatus: matchResult.workflow === 'cattle_enrolment'
      ? 'needs_review'
      : (isUncertain ? 'needs_review' : 'auto_accepted'),
    correctCattleId: null,
    reviewNotes: ''
  };

  const existing = existingIndex >= 0 ? audits[existingIndex] : null;
  const reviewedStatuses = new Set([
    'confirmed', 'found_correct', 'found_incorrect', 'no_cattle_correct',
    'no_cattle_incorrect', 'wrong_moved_to_registered'
  ]);
  const savedAudit = existing && reviewedStatuses.has(existing.reviewStatus)
    ? {
      ...audit,
      reviewStatus: existing.reviewStatus,
      correctCattleId: existing.correctCattleId || null,
      reviewNotes: existing.reviewNotes || '',
      reviewedBy: existing.reviewedBy,
      reviewedAt: existing.reviewedAt,
      correctionAction: existing.correctionAction || null,
      farmerComparison: audit.farmerComparison
        ? {
          ...audit.farmerComparison,
          reviewStatus: existing.farmerComparison?.reviewStatus || audit.farmerComparison.reviewStatus,
          correctCattleId: existing.farmerComparison?.correctCattleId ?? audit.farmerComparison.correctCattleId ?? null,
          reviewNotes: existing.farmerComparison?.reviewNotes || '',
          reviewedBy: existing.farmerComparison?.reviewedBy,
          reviewedAt: existing.farmerComparison?.reviewedAt
        }
        : null
    }
    : audit;

  if (existing?.farmerComparison?.reviewStatus && savedAudit.farmerComparison) {
    savedAudit.farmerComparison = {
      ...savedAudit.farmerComparison,
      reviewStatus: existing.farmerComparison.reviewStatus,
      correctCattleId: existing.farmerComparison.correctCattleId ?? null,
      reviewNotes: existing.farmerComparison.reviewNotes || '',
      reviewedBy: existing.farmerComparison.reviewedBy,
      reviewedAt: existing.farmerComparison.reviewedAt
    };
  }

  await persistMatchAudit(savedAudit);
  return savedAudit;
}

async function backfillEnrollmentMatchAudits() {
  const [rows, audits] = await Promise.all([readCleanMetadata(), readMatchAudits()]);
  const existingIds = new Set(audits.map((audit) => audit.auditId));

  for (const row of rows) {
    if (normalizeWorkflow(row.workflow, 'cattle_enrolment') !== 'cattle_enrolment') continue;
    for (const session of row.sessions || []) {
      const matchResult = session.matchResult;
      const auditId = `${row.cattleId}__${session.sessionId}`;
      if (!matchResult?.resolved || existingIds.has(auditId)) continue;
      await storeMatchAudit({
        cattleId: row.cattleId,
        finalCattleId: row.cattleId,
        session,
        matchResult,
        farmerId: row.farmerId,
        farmerName: row.farmerName,
        fieldOfficerId: row.fieldOfficerId,
        fieldOfficerName: row.fieldOfficerName,
        locationLat: row.locationLat,
        locationLon: row.locationLon,
        locationAccuracyM: row.locationAccuracyM,
        matchRadiusKm: row.matchRadiusKm
      });
      existingIds.add(auditId);
    }
  }
}

function buildSessionImageLookup(rows) {
  const lookup = new Map();
  for (const row of rows) {
    for (const session of row.sessions || []) {
      const refs = Object.values(session.images || {})
        .filter((ref) => ref?.imageType)
        .map((ref) => ({
          imageType: ref.imageType,
          previewUrl: ref.previewUrl,
          cloudinaryUrl: ref.cloudinary?.secureUrl || null
        }));
      lookup.set(`${row.cattleId}__${session.sessionId}`, refs);
    }
  }
  return lookup;
}

async function upsertSessionVector(row, session, { namespace = PINECONE_ENROLMENT_NAMESPACE, workflow = 'cattle_enrolment' } = {}) {
  if (!pineconeEnabled || !session.embedding?.average?.length) {
    return null;
  }

  const vectorId = pineconeVectorId(row.cattleId, session.sessionId);
  const payload = {
    vectors: [
      {
        id: vectorId,
        values: session.embedding.average,
        metadata: {
          cattleId: row.cattleId,
          sessionId: session.sessionId,
          farmerId: row.farmerId || '',
          farmerIdNorm: normalizeSearchText(row.farmerId),
          farmerName: row.farmerName || '',
          farmerNameNorm: normalizeSearchText(row.farmerName),
          fieldOfficerId: row.fieldOfficerId || session.fieldOfficerId || '',
          fieldOfficerName: row.fieldOfficerName || session.fieldOfficerName || '',
          locationLat: Number(row.locationLat) || 0,
          locationLon: Number(row.locationLon) || 0,
          captureDate: session.captureDate || '',
          folderLocation: session.folderLocation || '',
          workflow
        }
      }
    ],
    namespace
  };

  await pineconeFetch('/vectors/upsert', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  session.embedding.pinecone = {
    vectorId,
    namespace,
    workflow,
    upsertedAt: new Date().toISOString()
  };
  return session.embedding.pinecone;
}

async function queryPineconeMatches({ queryRow, queryEmbedding, ownerNumberMap }) {
  if (!pineconeEnabled) {
    return [];
  }

  const queryWorkflow = normalizeWorkflow(queryRow.workflow, 'cattle_enrolment');
  const farmerIdNorm = normalizeSearchText(queryRow.farmerId);
  const farmerNameNorm = normalizeSearchText(queryRow.farmerName);
  const basePayload = {
    vector: queryEmbedding,
    includeMetadata: true,
    namespace: PINECONE_ENROLMENT_NAMESPACE
  };
  const resultSets = [];

  if (queryWorkflow === 'cattle_search' && (farmerIdNorm || farmerNameNorm)) {
    const farmerFilters = [];
    if (farmerIdNorm) farmerFilters.push({ farmerIdNorm: { '$eq': farmerIdNorm } });
    if (farmerNameNorm) farmerFilters.push({ farmerNameNorm: { '$eq': farmerNameNorm } });
    const farmerResult = await pineconeFetch('/query', {
      method: 'POST',
      body: JSON.stringify({
        ...basePayload,
        topK: 50,
        filter: farmerFilters.length === 1 ? farmerFilters[0] : { '$or': farmerFilters }
      })
    }).catch(() => ({ matches: [] }));
    resultSets.push(...(farmerResult.matches || []));
  }

  const locationResult = await pineconeFetch('/query', {
    method: 'POST',
    body: JSON.stringify({ ...basePayload, topK: queryWorkflow === 'cattle_search' ? 200 : 50 })
  }).catch(() => ({ matches: [] }));
  resultSets.push(...(locationResult.matches || []));

  const uniqueMatches = Array.from(new Map(resultSets.map((match) => [match.id, match])).values());

  return uniqueMatches
    .map((match) => {
      const meta = match.metadata || {};
      const sameFarmer = sameFarmerIdentity(queryRow, meta);
      const distanceKm = haversineKm(queryRow.locationLat, queryRow.locationLon, meta.locationLat, meta.locationLon);
      const radiusKm = Math.max(0.1, Number(queryRow.matchRadiusKm || 7));
      const searchScope = sameFarmer
        ? 'farmer_cattle'
        : (queryWorkflow === 'cattle_search'
          ? (distanceKm !== null && distanceKm <= radiusKm ? 'nearby_location' : 'outside_location')
          : 'all_other_muzzle');
      return {
        cattleId: meta.cattleId,
        cattleNumber: ownerNumberMap.get(meta.cattleId) || null,
        cattleLabel: cattleDisplayLabel(ownerNumberMap.get(meta.cattleId)),
        searchScope,
        sessionId: meta.sessionId,
        farmerName: meta.farmerName,
        fieldOfficerName: meta.fieldOfficerName,
        locationLat: meta.locationLat,
        locationLon: meta.locationLon,
        distanceKm,
        score: Number(match.score || 0),
        vectorId: match.id
      };
    })
    .filter((candidate) => candidate.cattleId !== queryRow.cattleId && ownerNumberMap.has(candidate.cattleId));
}

async function pineconeFetch(pathname, options = {}) {
  const response = await fetch(`${PINECONE_INDEX_HOST}${pathname}`, {
    ...options,
    headers: {
      'Api-Key': PINECONE_API_KEY,
      'Content-Type': 'application/json',
      'X-Pinecone-API-Version': '2025-04',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.message || data.error || `Pinecone request failed with ${response.status}`);
  }

  return data;
}

function pineconeVectorId(cattleId, sessionId) {
  return `${cattleId}__${sessionId}`;
}

function normalizePineconeHost(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`;
}

function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeRecord(row) {
  if (!row) return null;

  if (!row.sessions) {
    const folderLocation = normalizeDataPath(row.folderLocation, row.cattleId, 'legacy');
    row.rootFolderLocation = path.join(dataDir, row.cattleId);
    row.activeSessionId = 'legacy';
    row.sessions = [
      {
        sessionId: 'legacy',
        captureDate: toDateKey(row.captureDateTime || row.uploadDateTime || new Date().toISOString()),
        captureDateTime: row.captureDateTime || row.uploadDateTime || new Date().toISOString(),
        uploadDateTime: row.uploadDateTime || new Date().toISOString(),
        folderLocation,
        status: row.status || 'draft'
      }
    ];
  }

  // Persisted records can outlive the machine or OS that created them. Rebuild
  // storage paths from stable IDs instead of trusting Windows/Linux absolute paths.
  row.rootFolderLocation = path.join(dataDir, row.cattleId);
  row.sessions = row.sessions.map((session) => {
    const normalizedSession = {
      ...session,
      folderLocation: normalizeDataPath(session.folderLocation, row.cattleId, session.sessionId)
    };

    if (normalizedSession.images && typeof normalizedSession.images === 'object') {
      normalizedSession.images = Object.fromEntries(
        Object.entries(normalizedSession.images).map(([imageType, reference]) => [
          imageType,
          reference && typeof reference === 'object'
            ? {
                ...reference,
                localPath: normalizeDataPath(
                  reference.localPath,
                  row.cattleId,
                  session.sessionId,
                  reference.fileName || `${imageType}.jpg`
                )
              }
            : reference
        ])
      );
    }

    return normalizedSession;
  });

  const activeSession = row.sessions.find((session) => session.sessionId === row.activeSessionId)
    || row.sessions.at(-1);
  row.folderLocation = activeSession?.folderLocation || path.join(dataDir, row.cattleId);

  return row;
}

function normalizeDataPath(value, ...fallbackSegments) {
  const normalized = String(value || '').replace(/\\/g, '/');
  const dataMarker = normalized.toLowerCase().lastIndexOf('/data/');

  if (dataMarker >= 0) {
    const relativeParts = normalized.slice(dataMarker + '/data/'.length).split('/').filter(Boolean);
    return path.join(dataDir, ...relativeParts);
  }

  if (normalized && path.isAbsolute(normalized)) return path.normalize(normalized);
  return path.join(dataDir, ...fallbackSegments.filter(Boolean));
}

function normalizeWorkflow(value, fallback = 'cattle_enrolment') {
  return value === 'cattle_search' ? 'cattle_search' : fallback;
}

function getActiveSession(row) {
  const session = row.sessions.find((item) => item.sessionId === row.activeSessionId) || row.sessions.at(-1);
  if (!session) throw new Error('No active capture session found.');
  return session;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function toMediaPrefix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const earthRadiusKm = 6371;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

async function nextSlot(folder, prefix, max) {
  const files = await fs.readdir(folder).catch(() => []);
  for (let index = 1; index <= max; index += 1) {
    if (!files.includes(`${prefix}${index}.jpg`)) return index;
  }
  return max + 1;
}

async function resizeAndSave(inputPath, outputPath) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'resize_image.py');
  const args = [scriptPath, '--input', inputPath, '--output', outputPath];

  await runPythonJson(args);
}

function runPythonJson(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error(`Python processing exceeded ${PYTHON_PROCESS_TIMEOUT_MS} ms.`);
      error.code = 'PYTHON_TIMEOUT';
      error.statusCode = 503;
      error.retryable = true;
      finish(reject, error);
    }, PYTHON_PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish(reject, new Error(`Could not start Python runtime "${PYTHON_BIN}": ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const detail = cleanPythonError(stderr || `Python process exited with code ${code}`);
        const dependencyHint = /ModuleNotFoundError|No module named/i.test(detail)
          ? ` Python runtime: ${PYTHON_BIN}. Install backend/requirements.txt in this environment.`
          : '';
        finish(reject, new Error(`${detail}${dependencyHint}`));
        return;
      }

      try {
        const jsonLine = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('{') && line.endsWith('}'))
          .at(-1);
        finish(resolve, JSON.parse(jsonLine || stdout));
      } catch (error) {
        finish(reject, new Error(`Invalid Python JSON output: ${stdout || error.message}`));
      }
    });
  });
}

function cleanPythonError(message = '') {
  const text = String(message || '').trim();
  if (text.includes('Microsoft Visual C++ Redistributable is not installed') || text.includes('torch\\lib\\c10.dll')) {
    return 'Embedding model runtime is not ready: PyTorch cannot load c10.dll. Install Microsoft Visual C++ Redistributable x64, then restart the backend.';
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastErrorLine = [...lines].reverse().find((line) => /^[A-Za-z]+Error:/.test(line) || line.startsWith('OSError:'));
  return lastErrorLine || lines.at(-1) || 'Python process failed.';
}

function publicErrorMessage(error) {
  if (error?.code === 'LIMIT_FILE_SIZE') return 'Image is too large. Maximum upload size is 12 MB.';
  const message = cleanPythonError(error?.message || 'Unexpected server error.');
  if (/[A-Za-z]:\\|\/app\/|\/mnt\//.test(message)) {
    return 'Server storage or model processing failed. The full diagnostic was recorded in the backend log.';
  }
  return message;
}
