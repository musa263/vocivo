import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { list, put, putMany, readObjects } from '../../shared/object-store.js';
import { requiredEnv } from '../../shared/http.js';
import { hasMigrationMarker, listAllStoredPaths, newestFirstTimestamp, overwriteEntries, saveMigrationMarker, tenantStorageKey } from '../../shared/tenant-storage.js';

export type StoredCallEvent = {
  id: string;
  name: string;
  type: 'webhook';
  event_timestamp: string;
  call_session_id?: string;
  call_leg_id?: string;
  call_control_id?: string;
  direction?: string;
  from?: string;
  to?: string;
  hangup_cause?: string;
  organizationId: string;
  flow?: string;
  routeId?: string;
  sourceExtensionId?: string;
  sourceExtension?: string;
  sourceName?: string;
  destinationExtensionId?: string;
  destinationExtension?: string;
  destinationName?: string;
  /** A receptionist conversation: how it ended and what was said, for the event log. */
  note?: string;
  transcript?: string;
};

function key() { return createHash('sha256').update(`${requiredEnv('AUTH_SECRET')}:call-events`).digest(); }
function encrypt(value: StoredCallEvent) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function decrypt(value: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key(), value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')) as StoredCallEvent;
}

export async function storeCallEvent(event: StoredCallEvent) {
  const organizationId = event.organizationId.trim();
  if (!organizationId) throw new Error('A tenant organization is required before storing a call event.');
  const newestFirst = newestFirstTimestamp(event.event_timestamp);
  const eventKey = createHash('sha256').update(event.id).digest('hex').slice(0, 20);
  await put(`vocivo/call-events/v3/${tenantStorageKey(organizationId)}/${newestFirst}-${eventKey}.bin`, encrypt({ ...event, organizationId }), { access: 'private', contentType: 'application/octet-stream', allowOverwrite: true });
}

async function migrateCallEvents(organizationId: string) {
  const tenantKey = tenantStorageKey(organizationId);
  const marker = `vocivo/migrations/call-events-v3/${tenantKey}.marker`;
  if (await hasMigrationMarker(marker)) return;
  const paths = await listAllStoredPaths('vocivo/call-events/v2/');
  const objects = await readObjects(paths);
  const events = paths.map((pathname) => {
    try { const value = objects.get(pathname); return value ? decrypt(value) : null; } catch { return null; }
  }).filter((event): event is StoredCallEvent => event !== null && event.organizationId === organizationId);
  if (events.length) {
    await putMany(overwriteEntries(events.map((event) => ({
      pathname: `vocivo/call-events/v3/${tenantKey}/${newestFirstTimestamp(event.event_timestamp)}-${createHash('sha256').update(event.id).digest('hex').slice(0, 20)}.bin`,
      value: encrypt({ ...event, organizationId }),
    }))));
  }
  await saveMigrationMarker(marker);
}

async function readEvents(prefix: string, limit: number) {
  const result = await list({ prefix, limit: Math.min(Math.max(limit, 1), 250) });
  const objects = await readObjects(result.blobs.map((blob) => blob.pathname));
  const events = result.blobs.map((blob) => {
    try {
      const value = objects.get(blob.pathname);
      return value ? decrypt(value) : null;
    } catch { return null; }
  }).filter((event): event is StoredCallEvent => Boolean(event));
  return events.sort((a, b) => b.event_timestamp.localeCompare(a.event_timestamp)).slice(0, limit);
}

export async function listCallEvents(limit = 100, organizationId?: string) {
  if (organizationId) {
    await migrateCallEvents(organizationId);
    const events = await readEvents(`vocivo/call-events/v3/${tenantStorageKey(organizationId)}/`, limit);
    return [...new Map(events.map((event) => [event.id, event])).values()]
      .sort((a, b) => b.event_timestamp.localeCompare(a.event_timestamp)).slice(0, limit);
  }
  const [current, legacy] = await Promise.all([
    readEvents('vocivo/call-events/v3/', limit),
    readEvents('vocivo/call-events/v2/', limit),
  ]);
  return [...new Map([...current, ...legacy].map((event) => [event.id, event])).values()]
    .sort((a, b) => b.event_timestamp.localeCompare(a.event_timestamp)).slice(0, limit);
}

/** History needs complete calls: event-level limits can remove a caller's own records. */
export async function listCompleteTenantCallEvents(organizationId: string) {
  await migrateCallEvents(organizationId);
  const prefix = `vocivo/call-events/v3/${tenantStorageKey(organizationId)}/`;
  const events: StoredCallEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    const objects = await readObjects(page.blobs.map((item) => item.pathname));
    for (const value of objects.values()) {
      const event = decrypt(value);
      if (event.organizationId === organizationId) events.push(event);
    }
    cursor = page.hasMore ? page.cursor : undefined;
    if (page.hasMore && !cursor) throw new Error('History pagination cursor is missing.');
  } while (cursor);
  return [...new Map(events.map(event => [event.id, event])).values()];
}

/** Bounded newest-first scan; incomplete coverage is surfaced, never presented as a complete report. */
export async function listReportingEvents(organizationId: string, since: number, maxEvents = 20_000) {
  await migrateCallEvents(organizationId);
  const prefix = `vocivo/call-events/v3/${tenantStorageKey(organizationId)}/`;
  const events: StoredCallEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: Math.min(1000, maxEvents - events.length) });
    const objects = await readObjects(page.blobs.map(item => item.pathname));
    let reachedStart = false;
    for (const blob of page.blobs) {
      const value = objects.get(blob.pathname);
      if (!value) throw new Error('Report event disappeared during read');
      const event = decrypt(value);
      if (event.organizationId !== organizationId) throw new Error('Report tenant mismatch');
      if (Date.parse(event.event_timestamp) < since) reachedStart = true;
      else events.push(event);
    }
    if (reachedStart || !page.hasMore) return { events, complete: true };
    if (events.length >= maxEvents) return { events, complete: false };
    cursor = page.cursor;
    if (!cursor) throw new Error('Report pagination cursor missing');
  } while (cursor);
  return { events, complete: true };
}
