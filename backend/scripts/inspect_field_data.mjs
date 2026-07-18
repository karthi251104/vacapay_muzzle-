import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const mongoUri = process.env.MONGODB_URI || '';
const mongoDbName = process.env.MONGODB_DB_NAME || 'vacapay';
if (!mongoUri) {
  console.log(JSON.stringify({ mongo: false }, null, 2));
  process.exit(0);
}

const client = new MongoClient(mongoUri);
try {
  await client.connect();
  const db = client.db(mongoDbName);
  const cattle = await db.collection('cattle')
    .find({}, {
      projection: {
        _id: 0,
        cattleId: 1,
        farmerId: 1,
        farmerName: 1,
        status: 1,
        workflow: 1,
        activeSessionId: 1,
        sessions: 1,
        duplicateOfCattleId: 1
      }
    })
    .sort({ uploadDateTime: -1, captureDateTime: -1 })
    .limit(20)
    .toArray();

  const summary = cattle.map((row) => {
    const session = row.sessions?.find((item) => item.sessionId === row.activeSessionId) || row.sessions?.at(-1) || null;
    return {
    cattleId: row.cattleId,
    farmerId: row.farmerId,
    farmerName: row.farmerName,
    status: row.status,
    workflow: row.workflow,
    duplicateOfCattleId: row.duplicateOfCattleId || null,
    sessionCount: row.sessions?.length || 0,
      activeSession: session ? {
        sessionId: session.sessionId,
        status: session.status,
        workflow: session.workflow,
        imageCount: Object.keys(session.images || {}).length,
        hasEmbedding: Boolean(session.embedding),
        matchDecision: session.matchResult?.decision || null,
        duplicateSavedSeparately: Boolean(session.matchResult?.duplicateSavedSeparately)
      } : null
    };
  });

  console.log(JSON.stringify({
    count: await db.collection('cattle').countDocuments(),
    audits: await db.collection('match_audits').countDocuments(),
    cattle: summary
  }, null, 2));
} finally {
  await client.close();
}
