import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';
import { MongoClient } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });
const dataDir = path.join(rootDir, 'data');
const uploadDir = path.join(dataDir, '_uploads');
const metadataPath = path.join(dataDir, 'enrollments.json');
const matchAuditsPath = path.join(dataDir, 'match_audits.json');
const usersPath = path.join(dataDir, 'users.json');
const frontendDistDir = path.join(rootDir, 'frontend', 'dist', 'vacapay', 'browser');

const app = express();
const upload = multer({ dest: uploadDir });

const PORT = Number(process.env.PORT || 3000);
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const MODEL_PATH = process.env.MODEL_PATH || path.join(rootDir, 'best_v4.pt');
const DINOV2_MODEL_PATH = process.env.DINOV2_MODEL_PATH || path.join(__dirname, '..', 'dinov2_triplet_v2_best.pt');
const YOLO_IMGSZ = Number(process.env.YOLO_IMGSZ || 640);
const MUZZLE_CONF = Number(process.env.MUZZLE_CONF || 0.55);
const EMBEDDING_MATCH_THRESHOLD = Number(process.env.EMBEDDING_MATCH_THRESHOLD || 0.70);
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const CLOUDINARY_ROOT_FOLDER = process.env.CLOUDINARY_ROOT_FOLDER || 'vacapay';
const cloudinaryEnabled = Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'vacapay';
const mongoEnabled = Boolean(MONGODB_URI);
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || '';
const PINECONE_INDEX_HOST = normalizePineconeHost(process.env.PINECONE_INDEX_HOST || '');
const PINECONE_NAMESPACE = process.env.PINECONE_NAMESPACE || 'vacapay';
const pineconeEnabled = Boolean(PINECONE_API_KEY && PINECONE_INDEX_HOST);
const REQUIRED_IMAGES = [
  'muzzle1.jpg',
  'muzzle2.jpg',
  'muzzle3.jpg',
  'muzzle4.jpg',
  'muzzle5.jpg',
  'face1.jpg',
  'face2.jpg',
  'face3.jpg',
  'leftside.jpg',
  'rightside.jpg',
  'back.jpg',
  'udder.jpg'
];
const sessions = new Map();
let mongoClient = null;
let mongoDb = null;

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true
  });
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use('/media', express.static(dataDir));

await ensureStorage();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    modelPath: MODEL_PATH,
    dinov2ModelPath: DINOV2_MODEL_PATH,
    embeddingMatchThreshold: EMBEDDING_MATCH_THRESHOLD,
    yoloImageSize: YOLO_IMGSZ,
    storage: dataDir,
    cloudinary: {
      enabled: cloudinaryEnabled,
      cloudName: CLOUDINARY_CLOUD_NAME || null,
      rootFolder: CLOUDINARY_ROOT_FOLDER
    },
    mongodb: {
      enabled: mongoEnabled,
      database: mongoEnabled ? MONGODB_DB_NAME : null
    },
    pinecone: {
      enabled: pineconeEnabled,
      namespace: PINECONE_NAMESPACE,
      indexHost: pineconeEnabled ? PINECONE_INDEX_HOST : null
    }
  });
});

app.get('/api/pinecone/status', async (_req, res) => {
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
      namespace: PINECONE_NAMESPACE,
      indexHost: PINECONE_INDEX_HOST,
      dimension: result.dimension,
      totalVectorCount: result.totalVectorCount,
      namespaces: result.namespaces || {}
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      enabled: true,
      namespace: PINECONE_NAMESPACE,
      indexHost: PINECONE_INDEX_HOST,
      error: error.message || 'Pinecone status check failed.'
    });
  }
});

app.get('/api/yolo/status', async (_req, res) => {
  try {
    const result = await runPythonJson([
      path.join(__dirname, '..', 'scripts', 'yolo_status.py'),
      '--model',
      MODEL_PATH
    ]);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      modelPath: MODEL_PATH,
      error: error.message || 'YOLO status check failed.'
    });
  }
});

app.get('/api/embedding/status', async (_req, res) => {
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
      error: error.message || 'Embedding status check failed.'
    });
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const users = await readUsers();
    const user = users.find((item) => item.active && [item.agentId, item.phone].map((value) => String(value || '').toLowerCase()).includes(identifier));

    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: 'Invalid login details.' });
      return;
    }

    const token = uuidv4();
    const publicUser = toPublicUser(user);
    sessions.set(token, publicUser);
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

app.get('/api/reviews/matches', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const uncertainOnly = String(req.query.uncertainOnly ?? 'true') !== 'false';
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
      .slice(0, 100)
      .map((audit) => ({
        ...audit,
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

    audits[index] = {
      ...audits[index],
      reviewStatus: String(req.body.reviewStatus || 'reviewed'),
      correctCattleId: String(req.body.correctCattleId || '').trim() || null,
      reviewNotes: String(req.body.reviewNotes || '').trim(),
      reviewedBy: req.user,
      reviewedAt: new Date().toISOString()
    };

    await writeMatchAudits(audits);
    res.json({ review: audits[index] });
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

    if (!agentName || !phone || !agentId || password.length < 4) {
      res.status(400).json({ error: 'Agent name, phone, agent ID, and password are required.' });
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
      userId: uuidv4(),
      role: 'agent',
      name: agentName,
      phone,
      agentId,
      active: true,
      createdAt: new Date().toISOString(),
      passwordHash: hashPassword(password)
    };

    users.push(user);
    await writeUsers(users);
    res.status(201).json({ agent: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/farmers', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = await readMetadata();
    const farmers = rows
      .filter((row) => !q || row.farmerName.toLowerCase().includes(q))
      .map((row) => ({ farmerId: row.farmerId, farmerName: row.farmerName }))
      .filter((row, index, arr) => arr.findIndex((item) => item.farmerId === row.farmerId) === index)
      .slice(0, 10);

    res.json({ farmers });
  } catch (error) {
    next(error);
  }
});

app.get('/api/cattle/search', async (req, res, next) => {
  try {
    const farmerName = String(req.query.farmerName || '').trim().toLowerCase();
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radiusKm = Number(req.query.radiusKm || 7);
    const hasLocation = Number.isFinite(lat) && Number.isFinite(lon);
    const rows = (await readMetadata()).map(normalizeRecord).filter(Boolean);

    const cattle = rows
      .filter((row) => !farmerName || row.farmerName.toLowerCase().includes(farmerName))
      .map((row) => {
        const distanceKm = hasLocation && Number.isFinite(Number(row.locationLat)) && Number.isFinite(Number(row.locationLon))
          ? haversineKm(lat, lon, Number(row.locationLat), Number(row.locationLon))
          : null;
        const sessions = row.sessions || [];
        const lastSession = sessions.at(-1);

        return {
          cattleId: row.cattleId,
          farmerId: row.farmerId,
          farmerName: row.farmerName,
          fieldOfficerName: row.fieldOfficerName,
          locationLat: row.locationLat,
          locationLon: row.locationLon,
          rootFolderLocation: row.rootFolderLocation || path.join(dataDir, row.cattleId),
          sessionCount: sessions.length,
          lastCaptureDate: lastSession?.captureDate || null,
          lastStatus: lastSession?.status || row.status || 'draft',
          distanceKm
        };
      })
      .filter((row) => row.distanceKm === null || row.distanceKm <= radiusKm)
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
    const rows = (await readMetadata()).map(normalizeRecord).filter(Boolean);
    const cattle = rows
      .map(toCattleSummary)
      .sort((a, b) => String(b.lastCaptureDate || '').localeCompare(String(a.lastCaptureDate || '')));

    res.json({
      stats: buildCattleStats(cattle),
      cattle
    });
  } catch (error) {
    next(error);
  }
});
app.post('/api/enrollments', async (req, res, next) => {
  try {
    const now = new Date().toISOString();
    const cattleId = String(req.body.cattleId || '').trim() || uuidv4();
    const rows = await readMetadata();
    const existingIndex = rows.findIndex((row) => row.cattleId === cattleId);
    const existing = existingIndex >= 0 ? normalizeRecord(rows[existingIndex]) : null;
    const rootFolder = path.join(dataDir, cattleId);
    const session = await createCaptureSession({ cattleId, captureDateTime: req.body.captureDateTime || now });

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

    record.farmerId = req.body.farmerId || record.farmerId || '';
    record.farmerName = req.body.farmerName || record.farmerName || '';
    record.fieldOfficerName = req.body.fieldOfficerName || record.fieldOfficerName || '';
    record.fieldOfficerId = req.body.fieldOfficerId || record.fieldOfficerId || '';
    record.locationLat = req.body.locationLat ?? record.locationLat ?? null;
    record.locationLon = req.body.locationLon ?? record.locationLon ?? null;
    record.rootFolderLocation = rootFolder;
    record.folderLocation = session.folderLocation;
    record.captureDateTime = session.captureDateTime;
    record.uploadDateTime = now;
    record.status = 'draft';
    record.activeSessionId = session.sessionId;
    session.fieldOfficerId = record.fieldOfficerId;
    session.fieldOfficerName = record.fieldOfficerName;
    record.sessions = [...(record.sessions || []), session];

    if (existingIndex >= 0) rows[existingIndex] = record;
    else rows.push(record);

    await writeMetadata(rows);

    res.status(201).json({ enrollment: record });
  } catch (error) {
    next(error);
  }
});

app.post('/api/enrollments/:cattleId/muzzle', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'image is required' });
      return;
    }

    const { folder, mediaPrefix } = await getActiveCaptureFolder(req.params.cattleId);
    const requestedSlot = Number(req.body.slot || 0);
    const slot = requestedSlot > 0 ? requestedSlot : (await nextSlot(folder, 'muzzle', 5));
    const fileName = `muzzle${slot}.jpg`;

    if (slot > 5) {
      res.status(409).json({ error: 'All 5 muzzle images are already captured.' });
      return;
    }

    const result = await runYoloCrop({
      inputPath: req.file.path,
      outputDir: folder,
      outputName: fileName
    });

    if (!result.detected) {
      await fs.unlink(req.file.path).catch(() => {});
      res.status(422).json({ error: 'Muzzle not detected clearly. Retake the image.', result });
      return;
    }

    await fs.unlink(req.file.path).catch(() => {});
    const previewUrl = `/media/${mediaPrefix}/${fileName}`;
    const imageRef = await saveImageReference({
      cattleId: req.params.cattleId,
      imageType: `muzzle${slot}`,
      localPath: path.join(folder, fileName),
      previewUrl
    });
    const matchResolution = slot === 5 ? await resolveMuzzleMatch(req.params.cattleId) : null;

    res.json({
      slot,
      savedAs: fileName,
      previewUrl,
      cloudinaryUrl: imageRef.cloudinary?.secureUrl || null,
      imageRef,
      matchResolution,
      result
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/enrollments/:cattleId/images', upload.single('image'), async (req, res, next) => {
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

    const { folder, mediaPrefix } = await getActiveCaptureFolder(req.params.cattleId);
    const fileName = `${imageType}.jpg`;
    const outPath = path.join(folder, fileName);

    await resizeAndSave(req.file.path, outPath);
    await fs.unlink(req.file.path).catch(() => {});
    const previewUrl = `/media/${mediaPrefix}/${fileName}`;
    const imageRef = await saveImageReference({
      cattleId: req.params.cattleId,
      imageType,
      localPath: outPath,
      previewUrl
    });

    res.json({
      savedAs: fileName,
      previewUrl,
      cloudinaryUrl: imageRef.cloudinary?.secureUrl || null,
      imageRef
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/enrollments/:cattleId/complete', async (req, res, next) => {
  try {
    const cattleId = req.params.cattleId;
    const rows = await readMetadata();
    const row = normalizeRecord(rows.find((item) => item.cattleId === cattleId));

    if (!row) {
      res.status(404).json({ error: 'Enrollment not found.' });
      return;
    }

    const session = getActiveSession(row);
    const folder = session.folderLocation;
    const files = await fs.readdir(folder);
    const missing = REQUIRED_IMAGES.filter((file) => !files.includes(file));

    if (missing.length) {
      res.status(409).json({ error: 'Enrollment is incomplete.', missing });
      return;
    }

    row.status = 'ready_for_embedding';
    session.status = 'ready_for_embedding';
    row.uploadDateTime = new Date().toISOString();
    await writeMetadata(rows);
    res.json({ enrollment: row });
  } catch (error) {
    next(error);
  }
});

app.post('/api/enrollments/:cattleId/resolve-muzzle-match', async (req, res, next) => {
  try {
    const matchResolution = await resolveMuzzleMatch(req.params.cattleId);
    res.json({ matchResolution });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(frontendDistDir));

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
  res.status(500).json({ error: error.message || 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`Muzzle backend listening on http://localhost:${PORT}`);
});

async function ensureStorage() {
  await fs.mkdir(uploadDir, { recursive: true });

  if (mongoEnabled) {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGODB_DB_NAME);
    await mongoDb.collection('cattle').createIndex({ cattleId: 1 }, { unique: true });
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

    const admin = await mongoDb.collection('users').findOne({ role: 'admin', agentId: 'admin' });
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

async function writeMetadata(rows) {
  if (mongoDb) {
    const collection = mongoDb.collection('cattle');
    if (!rows.length) return;

    await collection.bulkWrite(rows.map((row) => ({
      replaceOne: {
        filter: { cattleId: row.cattleId },
        replacement: addMongoGeoPoint(stripMongoId(row)),
        upsert: true
      }
    })));
    return;
  }

  await fs.writeFile(metadataPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

async function readUsers() {
  if (mongoDb) {
    return mongoDb.collection('users').find({}, { projection: { _id: 0 } }).toArray();
  }

  const raw = await fs.readFile(usersPath, 'utf8');
  return JSON.parse(raw);
}

async function writeUsers(users) {
  if (mongoDb) {
    const collection = mongoDb.collection('users');
    if (!users.length) return;

    await collection.bulkWrite(users.map((user) => ({
      replaceOne: {
        filter: { userId: user.userId },
        replacement: stripMongoId(user),
        upsert: true
      }
    })));
    return;
  }

  await fs.writeFile(usersPath, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
}

async function readMatchAudits() {
  if (mongoDb) {
    return mongoDb.collection('match_audits').find({}, { projection: { _id: 0 } }).toArray();
  }

  const raw = await fs.readFile(matchAuditsPath, 'utf8');
  return JSON.parse(raw);
}

async function writeMatchAudits(audits) {
  if (mongoDb) {
    const collection = mongoDb.collection('match_audits');
    if (!audits.length) return;

    await collection.bulkWrite(audits.map((audit) => ({
      replaceOne: {
        filter: { auditId: audit.auditId },
        replacement: stripMongoId(audit),
        upsert: true
      }
    })));
    return;
  }

  await fs.writeFile(matchAuditsPath, `${JSON.stringify(audits, null, 2)}\n`, 'utf8');
}

function createDefaultAdmin() {
  return {
    userId: uuidv4(),
    role: 'admin',
    name: 'Demo Admin',
    phone: 'admin',
    agentId: 'admin',
    active: true,
    createdAt: new Date().toISOString(),
    passwordHash: hashPassword('admin123')
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
  const user = sessions.get(token);

  if (!user) {
    res.status(401).json({ error: 'Login required.' });
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

  session.images = {
    ...(session.images || {}),
    [imageType]: reference
  };
  row.uploadDateTime = reference.uploadedAt;
  session.uploadDateTime = reference.uploadedAt;
  rows[rowIndex] = row;
  await writeMetadata(rows);
  return reference;
}

async function resolveMuzzleMatch(cattleId) {
  const rows = (await readMetadata()).map(normalizeRecord);
  const queryIndex = rows.findIndex((item) => item?.cattleId === cattleId);
  const queryRow = rows[queryIndex];

  if (!queryRow) {
    throw new Error('Enrollment not found. Create enrollment first.');
  }

  const querySession = getActiveSession(queryRow);
  if (querySession.matchResult?.resolved) {
    return {
      ...querySession.matchResult,
      enrollment: queryRow
    };
  }

  const queryEmbedding = await ensureSessionEmbedding(queryRow, querySession);
  await upsertSessionVector(queryRow, querySession).catch(() => null);

  const preparedCandidates = [];

  for (let index = 0; index < rows.length; index += 1) {
    const candidateRow = rows[index];
    if (!candidateRow || candidateRow.cattleId === cattleId) continue;
    if (!isSameFarmerCandidate(queryRow, candidateRow)) continue;

    const distanceKm = distanceBetweenRowsKm(queryRow, candidateRow);
    if (distanceKm !== null && distanceKm > Number(queryRow.matchRadiusKm || 7)) continue;

    for (const candidateSession of candidateRow.sessions || []) {
      const candidateEmbedding = await ensureSessionEmbedding(candidateRow, candidateSession).catch(() => null);
      if (!candidateEmbedding) continue;
      await upsertSessionVector(candidateRow, candidateSession).catch(() => null);

      preparedCandidates.push({
        cattleId: candidateRow.cattleId,
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

  const pineconeMatches = await queryPineconeMatches({
    queryRow,
    queryEmbedding,
    preparedCandidates
  }).catch(() => []);
  const candidates = pineconeMatches.length ? pineconeMatches : preparedCandidates;
  candidates.sort((a, b) => b.score - a.score);
  const topMatches = candidates.slice(0, 5).map(toPublicMatchResult);
  const bestMatch = candidates[0] || null;
  const isMatched = Boolean(bestMatch && bestMatch.score >= EMBEDDING_MATCH_THRESHOLD);

  if (isMatched) {
    const matchedRow = await mergeSessionIntoExistingCattle({
      rows,
      queryIndex,
      targetIndex: bestMatch.rowIndex,
      topMatches
    });
    const matchResult = getActiveSession(matchedRow).matchResult;
    await writeMetadata(rows.filter(Boolean));
    await storeMatchAudit({
      cattleId,
      finalCattleId: matchedRow.cattleId,
      session: getActiveSession(matchedRow),
      matchResult,
      farmerName: matchedRow.farmerName,
      fieldOfficerName: matchedRow.fieldOfficerName,
      locationLat: matchedRow.locationLat,
      locationLon: matchedRow.locationLon
    });
    return {
      ...matchResult,
      enrollment: matchedRow
    };
  }

  const now = new Date().toISOString();
  const matchResult = {
    resolved: true,
    decision: 'new_cattle',
    confidence: bestMatch?.score || 0,
    confidencePercent: Math.round((bestMatch?.score || 0) * 100),
    threshold: EMBEDDING_MATCH_THRESHOLD,
    thresholdPercent: Math.round(EMBEDDING_MATCH_THRESHOLD * 100),
    matchedCattleId: null,
    topMatches,
    resolvedAt: now
  };

  querySession.matchResult = matchResult;
  querySession.status = 'muzzle_no_match_new_cattle';
  queryRow.status = 'muzzle_no_match_new_cattle';
  queryRow.uploadDateTime = now;
  await writeMetadata(rows.filter(Boolean));
  await storeMatchAudit({
    cattleId: queryRow.cattleId,
    finalCattleId: queryRow.cattleId,
    session: querySession,
    matchResult,
    farmerName: queryRow.farmerName,
    fieldOfficerName: queryRow.fieldOfficerName,
    locationLat: queryRow.locationLat,
    locationLon: queryRow.locationLon
  });

  return {
    ...matchResult,
    enrollment: queryRow
  };
}


function toCattleSummary(row) {
  const sessions = (row.sessions || []).map((session) => toSessionSummary(row, session));
  const lastSession = sessions.at(-1) || null;
  const imageCount = sessions.reduce((total, session) => total + session.imageCount, 0);
  const cloudinaryRootFolder = `${CLOUDINARY_ROOT_FOLDER}/cattle/${row.cattleId}`;

  return {
    cattleId: row.cattleId,
    farmerId: row.farmerId || '',
    farmerName: row.farmerName || '',
    fieldOfficerId: row.fieldOfficerId || '',
    fieldOfficerName: row.fieldOfficerName || '',
    locationLat: row.locationLat ?? null,
    locationLon: row.locationLon ?? null,
    status: row.status || 'draft',
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
    status: session.status || 'draft',
    folderLocation: session.folderLocation,
    cloudinaryFolder: cloudinaryEnabled ? cloudinaryFolder : null,
    productionFolder: cloudinaryEnabled ? cloudinaryFolder : session.folderLocation,
    imageCount: imageRefs.length,
    previewUrl: firstImage?.url || null,
    cloudinaryUrl: firstImage?.cloudinaryUrl || null,
    matchResult: session.matchResult || null,
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
  const order = ['muzzle1', 'muzzle2', 'muzzle3', 'muzzle4', 'muzzle5', 'face1', 'face2', 'face3', 'leftside', 'rightside', 'back', 'udder'];
  const index = order.indexOf(imageType);
  return index >= 0 ? index : order.length;
}

function buildCattleStats(cattle) {
  const farmerMap = new Map();
  let imageCount = 0;
  let sessionCount = 0;
  let repeatedCattleCount = 0;

  for (const cow of cattle) {
    imageCount += cow.imageCount;
    sessionCount += cow.sessionCount;
    if (cow.sessionCount > 1) repeatedCattleCount += 1;

    const key = (cow.farmerName || cow.farmerId || 'Unknown farmer').trim() || 'Unknown farmer';
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

  return {
    cattleCount: cattle.length,
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

async function muzzleImagePaths(session) {
  const files = [];
  for (let slot = 1; slot <= 5; slot += 1) {
    files.push(path.join(session.folderLocation, `muzzle${slot}.jpg`));
  }

  const missing = [];
  for (const file of files) {
    if (!await pathExists(file)) missing.push(path.basename(file));
  }

  if (missing.length) {
    throw new Error(`Need 5 muzzle crops before DINOv2 matching. Missing: ${missing.join(', ')}`);
  }

  return files;
}

function runAverageEmbedding(imagePaths) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'embedding_average.py');
  return runPythonJson([
    scriptPath,
    '--weights',
    DINOV2_MODEL_PATH,
    '--images',
    ...imagePaths
  ]);
}

function isSameFarmerCandidate(queryRow, candidateRow) {
  const queryFarmer = String(queryRow.farmerName || '').trim().toLowerCase();
  const candidateFarmer = String(candidateRow.farmerName || '').trim().toLowerCase();
  if (!queryFarmer || !candidateFarmer) return true;
  return candidateFarmer.includes(queryFarmer) || queryFarmer.includes(candidateFarmer);
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

function toPublicMatchResult(match) {
  return {
    cattleId: match.cattleId,
    sessionId: match.sessionId,
    farmerName: match.farmerName,
    fieldOfficerName: match.fieldOfficerName,
    locationLat: match.locationLat,
    locationLon: match.locationLon,
    distanceKm: match.distanceKm,
    score: match.score,
    confidencePercent: Math.round(match.score * 100)
  };
}

async function mergeSessionIntoExistingCattle({ rows, queryIndex, targetIndex, topMatches }) {
  const queryRow = rows[queryIndex];
  const targetRow = rows[targetIndex];
  const session = getActiveSession(queryRow);
  const previousCattleId = queryRow.cattleId;
  const targetRoot = await ensureCattleFolder(targetRow.cattleId);
  const nextFolder = await nextSessionFolder(targetRoot, session.captureDate);
  const oldFolder = session.folderLocation;

  await fs.mkdir(path.dirname(nextFolder), { recursive: true });
  await fs.rename(oldFolder, nextFolder);

  session.sessionId = path.basename(nextFolder);
  session.folderLocation = nextFolder;
  session.status = 'muzzle_matched_existing';
  session.matchedFromCattleId = previousCattleId;
  rebaseSessionImageRefs(session, targetRow.cattleId);

  if (cloudinaryEnabled && session.images) {
    await refreshCloudinaryRefs(targetRow.cattleId, session);
  }

  const now = new Date().toISOString();
  session.matchResult = {
    resolved: true,
    decision: 'matched_existing',
    confidence: topMatches[0]?.score || 0,
    confidencePercent: topMatches[0]?.confidencePercent || 0,
    threshold: EMBEDDING_MATCH_THRESHOLD,
    thresholdPercent: Math.round(EMBEDDING_MATCH_THRESHOLD * 100),
    matchedCattleId: targetRow.cattleId,
    previousCattleId,
    topMatches,
    resolvedAt: now
  };

  targetRow.sessions = [...(targetRow.sessions || []), session];
  targetRow.activeSessionId = session.sessionId;
  targetRow.folderLocation = session.folderLocation;
  targetRow.captureDateTime = session.captureDateTime;
  targetRow.uploadDateTime = now;
  targetRow.status = 'muzzle_matched_existing';
  targetRow.fieldOfficerId = queryRow.fieldOfficerId || targetRow.fieldOfficerId;
  targetRow.fieldOfficerName = queryRow.fieldOfficerName || targetRow.fieldOfficerName;
  targetRow.embedding = session.embedding || targetRow.embedding;

  const remainingSessions = (queryRow.sessions || []).filter((item) => item.sessionId !== queryRow.activeSessionId);
  if (remainingSessions.length) {
    queryRow.sessions = remainingSessions;
    queryRow.activeSessionId = remainingSessions.at(-1).sessionId;
    queryRow.status = 'merged_into_existing';
  } else {
    rows[queryIndex] = null;
    if (mongoDb) {
      await mongoDb.collection('cattle').deleteOne({ cattleId: previousCattleId });
    }
    await fs.rm(path.join(dataDir, previousCattleId), { recursive: true, force: true }).catch(() => {});
  }

  return targetRow;
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

async function storeMatchAudit({ cattleId, finalCattleId, session, matchResult, farmerName, fieldOfficerName, locationLat, locationLon }) {
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
    sessionId: session.sessionId,
    decision: matchResult.decision,
    confidence,
    confidencePercent: matchResult.confidencePercent,
    threshold: matchResult.threshold,
    thresholdPercent: matchResult.thresholdPercent,
    matchedCattleId: matchResult.matchedCattleId,
    previousCattleId: matchResult.previousCattleId || null,
    topMatches: matchResult.topMatches || [],
    farmerName: farmerName || '',
    fieldOfficerName: fieldOfficerName || '',
    locationLat: locationLat ?? null,
    locationLon: locationLon ?? null,
    folderLocation: session.folderLocation,
    captureDate: session.captureDate,
    resolvedAt: matchResult.resolvedAt || new Date().toISOString(),
    reviewStatus: isUncertain ? 'needs_review' : 'auto_accepted',
    correctCattleId: null,
    reviewNotes: ''
  };

  if (existingIndex >= 0) audits[existingIndex] = { ...audits[existingIndex], ...audit };
  else audits.push(audit);

  await writeMatchAudits(audits);
  return audit;
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

async function upsertSessionVector(row, session) {
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
          farmerName: row.farmerName || '',
          farmerNameNorm: normalizeSearchText(row.farmerName),
          fieldOfficerName: row.fieldOfficerName || session.fieldOfficerName || '',
          locationLat: Number(row.locationLat) || 0,
          locationLon: Number(row.locationLon) || 0,
          captureDate: session.captureDate || '',
          folderLocation: session.folderLocation || ''
        }
      }
    ],
    namespace: PINECONE_NAMESPACE
  };

  await pineconeFetch('/vectors/upsert', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  session.embedding.pinecone = {
    vectorId,
    namespace: PINECONE_NAMESPACE,
    upsertedAt: new Date().toISOString()
  };
  return session.embedding.pinecone;
}

async function queryPineconeMatches({ queryRow, queryEmbedding, preparedCandidates }) {
  if (!pineconeEnabled || !preparedCandidates.length) {
    return [];
  }

  const candidateByVectorId = new Map(
    preparedCandidates.map((candidate) => [pineconeVectorId(candidate.cattleId, candidate.sessionId), candidate])
  );
  const farmerNameNorm = normalizeSearchText(queryRow.farmerName);
  const filter = farmerNameNorm ? { farmerNameNorm: { $eq: farmerNameNorm } } : undefined;
  const payload = {
    vector: queryEmbedding,
    topK: Math.max(50, preparedCandidates.length + 5),
    includeMetadata: true,
    namespace: PINECONE_NAMESPACE,
    ...(filter ? { filter } : {})
  };
  const result = await pineconeFetch('/query', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  return (result.matches || [])
    .map((match) => {
      const candidate = candidateByVectorId.get(match.id);
      if (!candidate) return null;
      return {
        ...candidate,
        score: Number(match.score || 0),
        vectorId: match.id
      };
    })
    .filter(Boolean);
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
    const folderLocation = row.folderLocation || path.join(dataDir, row.cattleId);
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

  return row;
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

function runYoloCrop({ inputPath, outputDir, outputName }) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'yolo_crop_clahe.py');
  const args = [
    scriptPath,
    '--model', MODEL_PATH,
    '--input', inputPath,
    '--output-dir', outputDir,
    '--output-name', outputName,
    '--imgsz', String(YOLO_IMGSZ),
    '--conf', String(MUZZLE_CONF)
  ];

  return runPythonJson(args);
}

function runPythonJson(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `YOLO crop process exited with code ${code}`));
        return;
      }

      try {
        const jsonLine = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('{') && line.endsWith('}'))
          .at(-1);
        resolve(JSON.parse(jsonLine || stdout));
      } catch (error) {
        reject(new Error(`Invalid YOLO output: ${stdout || error.message}`));
      }
    });
  });
}


