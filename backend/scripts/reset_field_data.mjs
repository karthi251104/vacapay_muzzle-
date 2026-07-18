import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v2 as cloudinary } from 'cloudinary';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const backendDir = path.resolve(path.dirname(__filename), '..');
const rootDir = path.resolve(backendDir, '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const dataDir = path.join(rootDir, 'data');
const metadataPath = path.join(dataDir, 'enrollments.json');
const matchAuditsPath = path.join(dataDir, 'match_audits.json');
const uploadDir = path.join(dataDir, '_uploads');

const mongoUri = process.env.MONGODB_URI || '';
const mongoDbName = process.env.MONGODB_DB_NAME || 'vacapay';
const disableMongo = ['true', '1', 'yes'].includes(String(process.env.DISABLE_MONGO || '').toLowerCase());
const pineconeApiKey = process.env.PINECONE_API_KEY || '';
const pineconeHost = normalizePineconeHost(process.env.PINECONE_INDEX_HOST || '');
const pineconeNamespace = process.env.PINECONE_NAMESPACE || 'vacapay';
const pineconeNamespaces = [
  process.env.PINECONE_ENROLMENT_NAMESPACE || `${pineconeNamespace}-cattle-enrolment`,
  process.env.PINECONE_SEARCH_NAMESPACE || `${pineconeNamespace}-cattle-search`
];
const cloudinaryRootFolder = process.env.CLOUDINARY_ROOT_FOLDER || 'vacapay';

await fs.mkdir(dataDir, { recursive: true });

await fs.writeFile(metadataPath, '[]\n', 'utf8');
await fs.writeFile(matchAuditsPath, '[]\n', 'utf8');
console.log('local json: cleared enrollments and match audits');

await clearLocalCaptureFolders();

if (mongoUri && !disableMongo) {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(mongoDbName);
    const cattleResult = await db.collection('cattle').deleteMany({});
    const auditResult = await db.collection('match_audits').deleteMany({});
    console.log(`mongo: deleted ${cattleResult.deletedCount} cattle records`);
    console.log(`mongo: deleted ${auditResult.deletedCount} match audits`);
  } finally {
    await client.close();
  }
} else {
  console.log('mongo: skipped because it is disabled or not configured');
}

if (pineconeApiKey && pineconeHost) {
  for (const namespace of pineconeNamespaces) {
    await deletePineconeNamespace(namespace);
  }
} else {
  console.log('pinecone: skipped because it is not configured');
}

if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  try {
    await deleteCloudinaryPrefix(`${cloudinaryRootFolder}/cattle/`);
  } catch (error) {
    console.warn(`cloudinary: cleanup skipped after network/API error: ${error?.message || error}`);
  }
} else {
  console.log('cloudinary: skipped because it is not configured');
}

console.log('reset complete');

async function clearLocalCaptureFolders() {
  await fs.mkdir(uploadDir, { recursive: true });
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  let deletedFolders = 0;
  for (const entry of entries) {
    const fullPath = path.join(dataDir, entry.name);
    if (entry.isDirectory() && (entry.name === '_uploads' || isUuid(entry.name))) {
      await fs.rm(fullPath, { recursive: true, force: true });
      deletedFolders += 1;
    }
  }
  await fs.mkdir(uploadDir, { recursive: true });
  console.log(`local folders: deleted ${deletedFolders} capture/upload folder(s)`);
}

async function deletePineconeNamespace(namespace) {
  const response = await fetch(`${pineconeHost}/vectors/delete`, {
    method: 'POST',
    headers: {
      'Api-Key': pineconeApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ deleteAll: true, namespace })
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 404 && /Namespace not found/i.test(text)) {
      console.log(`pinecone: namespace ${namespace} already empty`);
      return;
    }
    throw new Error(`pinecone ${namespace}: ${response.status} ${text}`);
  }
  console.log(`pinecone: cleared namespace ${namespace}`);
}

async function deleteCloudinaryPrefix(prefix) {
  let deleted = 0;
  let nextCursor;
  do {
    const result = await cloudinary.api.delete_resources_by_prefix(prefix, {
      resource_type: 'image',
      type: 'upload',
      max_results: 1000,
      next_cursor: nextCursor,
      invalidate: true
    });
    deleted += Object.keys(result.deleted || {}).length;
    nextCursor = result.next_cursor;
  } while (nextCursor);
  console.log(`cloudinary: deleted ${deleted} image(s) under ${prefix}`);
}

function normalizePineconeHost(value) {
  return value ? value.replace(/\/+$/, '') : '';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
