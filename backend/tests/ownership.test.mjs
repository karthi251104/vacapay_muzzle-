import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRowsForUser,
  findOfflineCapture,
  sameFarmerIdentity,
  userOwnsRecord
} from '../src/ownership.js';

const ajithOne = { role: 'agent', agentId: 'AGENT-1', userId: 'USER-1', phone: '9000000001', name: 'Ajith' };
const ajithTwo = { role: 'agent', agentId: 'AGENT-2', userId: 'USER-2', phone: '9000000002', name: 'Ajith' };

test('ownership uses immutable IDs, not equal display names', () => {
  const record = { fieldOfficerId: ajithOne.agentId, fieldOfficerName: 'Ajith' };
  assert.equal(userOwnsRecord(ajithOne, record), true);
  assert.equal(userOwnsRecord(ajithTwo, record), false);
  assert.deepEqual(filterRowsForUser([record], ajithTwo), []);
});

test('admin can access all records', () => {
  assert.equal(userOwnsRecord({ role: 'admin' }, { fieldOfficerId: 'AGENT-1' }), true);
});

test('offline capture lookup identifies the exact owning row', () => {
  const rows = [
    { fieldOfficerId: 'AGENT-1', sessions: [{ offlineCaptureId: 'capture-one' }] },
    { fieldOfficerId: 'AGENT-2', sessions: [{ offlineCaptureId: 'capture-two' }] }
  ];
  assert.deepEqual(findOfflineCapture(rows, 'capture-two'), { rowIndex: 1, session: rows[1].sessions[0] });
  assert.equal(findOfflineCapture(rows, 'missing'), null);
});

test('farmer ID takes precedence over an equal farmer name', () => {
  assert.equal(
    sameFarmerIdentity(
      { farmerId: 'FARM-ONE', farmerName: 'Mani' },
      { farmerId: 'FARM-TWO', farmerName: 'Mani' }
    ),
    false
  );
  assert.equal(
    sameFarmerIdentity(
      { farmerId: 'FARM-ONE', farmerName: 'Mani' },
      { farmerIdNorm: 'farm-one', farmerName: 'Different display value' }
    ),
    true
  );
});
