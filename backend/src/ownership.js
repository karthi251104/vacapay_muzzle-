function normalizeIdentity(value) {
  return String(value || '').trim().toLowerCase();
}

export function isAdminUser(user) {
  return user?.role === 'admin';
}

export function fieldOfficerFromUser(user, body = {}) {
  if (isAdminUser(user)) {
    return {
      fieldOfficerId: String(body.fieldOfficerId || user?.agentId || user?.userId || user?.phone || '').trim(),
      fieldOfficerName: String(body.fieldOfficerName || user?.name || '').trim()
    };
  }

  return {
    fieldOfficerId: String(user?.agentId || user?.userId || user?.phone || '').trim(),
    fieldOfficerName: String(user?.name || '').trim()
  };
}

function userIdentityIds(user) {
  return [user?.agentId, user?.userId, user?.phone].map(normalizeIdentity).filter(Boolean);
}

function recordIdentityIds(record) {
  return [record?.fieldOfficerId, record?.officerId, record?.agentId].map(normalizeIdentity).filter(Boolean);
}

export function userOwnsRecord(user, record) {
  if (isAdminUser(user)) return true;
  if (!user || !record) return false;

  const userIds = userIdentityIds(user);
  const recordIds = recordIdentityIds(record);
  return recordIds.some((id) => userIds.includes(id));
}

export function userOwnsAudit(user, audit) {
  return userOwnsRecord(user, audit);
}

export function filterRowsForUser(rows, user) {
  if (isAdminUser(user)) return rows;
  return rows.filter((row) => userOwnsRecord(user, row));
}

export function filterAuditsForUser(audits, user) {
  if (isAdminUser(user)) return audits;
  return audits.filter((audit) => userOwnsAudit(user, audit));
}

export function findOfflineCapture(rows, offlineCaptureId) {
  if (!offlineCaptureId) return null;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const session = (rows[rowIndex]?.sessions || []).find((item) => item.offlineCaptureId === offlineCaptureId);
    if (session) return { rowIndex, session };
  }

  return null;
}

export function sameFarmerIdentity(first, second) {
  const firstId = normalizeIdentity(first?.farmerId || first?.farmerIdNorm);
  const secondId = normalizeIdentity(second?.farmerId || second?.farmerIdNorm);
  if (firstId || secondId) return Boolean(firstId && secondId && firstId === secondId);

  const firstName = normalizeIdentity(first?.farmerName || first?.farmerNameNorm);
  const secondName = normalizeIdentity(second?.farmerName || second?.farmerNameNorm);
  return Boolean(firstName && secondName && firstName === secondName);
}
