import { Pool, type QueryResultRow } from "pg";
import { config } from "./config.js";
import type {
  AdminConnection, AdminUser, Device, DeviceSummary, FirebaseConnection,
  FreeFirebasePanel, ReferralStats, RequiredChannel
} from "./types.js";

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  min: 1,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: config.DATABASE_URL.includes("neon.tech") ? { rejectUnauthorized: false } : undefined
});

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL DEFAULT '',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      referred_by BIGINT,
      referral_verified_at TIMESTAMPTZ
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_verified_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users (referred_by);
    CREATE TABLE IF NOT EXISTS firebase_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      firebase_url TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected',
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked TIMESTAMPTZ,
      UNIQUE (telegram_id, firebase_url)
    );
    CREATE INDEX IF NOT EXISTS firebase_connections_owner_idx ON firebase_connections (telegram_id);
    CREATE TABLE IF NOT EXISTS device_cache (
      firebase_id UUID NOT NULL REFERENCES firebase_connections(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      normalized_device_id TEXT NOT NULL,
      number TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      battery INTEGER,
      last_seen TEXT,
      device_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_id, normalized_device_id)
    );
    CREATE INDEX IF NOT EXISTS device_cache_status_idx ON device_cache (firebase_id, status);
    CREATE TABLE IF NOT EXISTS event_tracking (
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      firebase_id UUID NOT NULL REFERENCES firebase_connections(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_fingerprint TEXT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firebase_id, device_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS system_logs (
      id BIGSERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT,
      telegram_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS system_logs_created_idx ON system_logs (created_at DESC);
    CREATE TABLE IF NOT EXISTS free_firebase_pool (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      firebase_url TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      assigned_to BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
      assigned_at TIMESTAMPTZ,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS free_firebase_pool_available_idx
      ON free_firebase_pool (active, assigned_to, added_at);
    CREATE TABLE IF NOT EXISTS free_panel_claims (
      telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      pool_id UUID REFERENCES free_firebase_pool(id) ON DELETE SET NULL,
      firebase_url TEXT NOT NULL,
      display_name TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS required_channels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      chat_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      invite_link TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO admin_settings (key, value) VALUES
      ('maintenance_mode', 'false'),
      ('firebase_limit', '10'),
      ('minimum_referrals', '3')
    ON CONFLICT (key) DO NOTHING;
    UPDATE admin_settings SET value = '10' WHERE key = 'firebase_limit' AND value = '2';
  `);
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await pool.query<T>(text, values);
  return result.rows;
}

export async function ensureUser(ctx: { from?: { id: number; username?: string; first_name?: string } }) {
  if (!ctx.from) return;
  await query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
     SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_active = NOW()`,
    [ctx.from.id, ctx.from.username ?? null, ctx.from.first_name ?? ""]
  );
}

export async function isBanned(telegramId: number): Promise<boolean> {
  const rows = await query<{ is_banned: boolean }>(
    "SELECT is_banned FROM users WHERE telegram_id = $1",
    [telegramId]
  );
  return rows[0]?.is_banned ?? false;
}

export async function getSetting(key: string, fallback: string): Promise<string> {
  const rows = await query<{ value: string }>("SELECT value FROM admin_settings WHERE key = $1", [key]);
  return rows[0]?.value ?? fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

export async function logSystem(level: string, event: string, detail?: string, telegramId?: number) {
  await query(
    "INSERT INTO system_logs (level, event, detail, telegram_id) VALUES ($1, $2, $3, $4)",
    [level, event, detail?.slice(0, 2000) ?? null, telegramId ?? null]
  ).catch(() => undefined);
}

export async function countConnections(telegramId: number): Promise<number> {
  const rows = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM firebase_connections WHERE telegram_id = $1",
    [telegramId]
  );
  return Number(rows[0]?.count ?? 0);
}

export async function getConnections(telegramId: number): Promise<FirebaseConnection[]> {
  return query<FirebaseConnection>(
    `SELECT id, telegram_id AS "telegramId", firebase_url AS "firebaseUrl",
            display_name AS "displayName", status, added_at AS "addedAt",
            last_checked AS "lastChecked"
     FROM firebase_connections WHERE telegram_id = $1 ORDER BY added_at`,
    [telegramId]
  );
}

export async function getConnection(telegramId: number, id: string): Promise<FirebaseConnection | undefined> {
  const rows = await query<FirebaseConnection>(
    `SELECT id, telegram_id AS "telegramId", firebase_url AS "firebaseUrl",
            display_name AS "displayName", status, added_at AS "addedAt",
            last_checked AS "lastChecked"
     FROM firebase_connections WHERE telegram_id = $1 AND id = $2`,
    [telegramId, id]
  );
  return rows[0];
}

export async function addConnection(telegramId: number, url: string, displayName: string) {
  const rows = await query<{ id: string }>(
    `INSERT INTO firebase_connections (telegram_id, firebase_url, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [telegramId, url, displayName]
  );
  return rows[0].id;
}

export async function removeConnection(telegramId: number, id: string) {
  await query("DELETE FROM firebase_connections WHERE telegram_id = $1 AND id = $2", [telegramId, id]);
}

export async function markConnectionChecked(id: string, status: string) {
  await query(
    "UPDATE firebase_connections SET status = $2, last_checked = NOW() WHERE id = $1",
    [id, status]
  );
}

export async function replaceDevices(firebaseId: string, devices: Device[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM device_cache WHERE firebase_id = $1", [firebaseId]);
    for (const device of devices) {
      await client.query(
        `INSERT INTO device_cache
         (firebase_id, device_id, normalized_device_id, number, status, battery, last_seen, device_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          firebaseId, device.deviceId, device.normalizedDeviceId, device.number ?? null,
          device.status, device.battery ?? null, device.lastSeen ?? null,
          JSON.stringify(device.payload)
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDevices(firebaseId: string): Promise<Device[]> {
  return query<Device>(
    `SELECT device_id AS "deviceId", normalized_device_id AS "normalizedDeviceId",
            number, status, battery, last_seen AS "lastSeen", device_payload AS payload
     FROM device_cache WHERE firebase_id = $1
      ORDER BY CASE WHEN status = 'online' THEN 0 ELSE 1 END,
               normalized_device_id ASC`,
    [firebaseId]
  );
}

export async function getSummary(firebaseId: string): Promise<DeviceSummary> {
  const rows = await query<{ total: string; online: string; offline: string }>(
    `SELECT COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'online')::text AS online,
       COUNT(*) FILTER (WHERE status = 'offline')::text AS offline
     FROM device_cache WHERE firebase_id = $1`,
    [firebaseId]
  );
  const row = rows[0] ?? { total: "0", online: "0", offline: "0" };
  return { total: Number(row.total), online: Number(row.online), offline: Number(row.offline) };
}

export async function eventSeen(firebaseId: string, deviceId: string, eventId: string): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM event_tracking WHERE firebase_id = $1 AND device_id = $2 AND event_id = $3) AS exists",
    [firebaseId, deviceId, eventId]
  );
  return rows[0]?.exists ?? false;
}

export async function markEventSeen(telegramId: number, firebaseId: string, deviceId: string, eventId: string, fingerprint: string) {
  await query(
    `INSERT INTO event_tracking (telegram_id, firebase_id, device_id, event_id, event_fingerprint)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [telegramId, firebaseId, deviceId, eventId, fingerprint]
  );
}

export async function adminStats() {
  const rows = await query<{ users: string; connections: string; devices: string; online: string; offline: string }>(
    `SELECT
      (SELECT COUNT(*) FROM users)::text AS users,
      (SELECT COUNT(*) FROM firebase_connections)::text AS connections,
      (SELECT COUNT(*) FROM device_cache)::text AS devices,
      (SELECT COUNT(*) FROM device_cache WHERE status = 'online')::text AS online,
      (SELECT COUNT(*) FROM device_cache WHERE status = 'offline')::text AS offline`
  );
  return rows[0];
}

export async function getAdminUsers(limit = 20): Promise<AdminUser[]> {
  return query<AdminUser>(
    `SELECT u.telegram_id AS "telegramId", u.username, u.first_name AS "firstName",
            u.joined_at AS "joinedAt", u.last_active AS "lastActive", u.is_banned AS "isBanned",
            COUNT(fc.id)::int AS connections
       FROM users u
       LEFT JOIN firebase_connections fc ON fc.telegram_id = u.telegram_id
      GROUP BY u.telegram_id
      ORDER BY u.last_active DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))]
  );
}

export async function setUserBanned(telegramId: number, banned: boolean): Promise<void> {
  await query("UPDATE users SET is_banned = $2 WHERE telegram_id = $1", [telegramId, banned]);
}

export async function registerReferral(telegramId: number, referrerId: number): Promise<void> {
  if (telegramId === referrerId) return;
  await query(
    `UPDATE users
        SET referred_by = $2
      WHERE telegram_id = $1 AND referred_by IS NULL
        AND EXISTS (SELECT 1 FROM users WHERE telegram_id = $2)`,
    [telegramId, referrerId]
  );
}

export async function qualifyReferral(telegramId: number): Promise<void> {
  await query(
    `UPDATE users
        SET referral_verified_at = COALESCE(referral_verified_at, NOW())
      WHERE telegram_id = $1 AND referred_by IS NOT NULL`,
    [telegramId]
  );
}

export async function getReferralStats(telegramId: number): Promise<ReferralStats> {
  const rows = await query<{ total: string; qualified: string; claimed: boolean }>(
    `SELECT
       (SELECT COUNT(*)::text FROM users WHERE referred_by = $1) AS total,
       (SELECT COUNT(*)::text FROM users WHERE referred_by = $1 AND referral_verified_at IS NOT NULL) AS qualified,
       EXISTS (SELECT 1 FROM free_panel_claims WHERE telegram_id = $1) AS claimed`,
    [telegramId]
  );
  const row = rows[0] ?? { total: "0", qualified: "0", claimed: false };
  return { total: Number(row.total), qualified: Number(row.qualified), claimed: row.claimed };
}

export async function addFreeFirebasePanel(firebaseUrl: string, displayName: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO free_firebase_pool (firebase_url, display_name)
     VALUES ($1, $2) RETURNING id`,
    [firebaseUrl, displayName]
  );
  return rows[0].id;
}

export async function getFreeFirebasePanels(): Promise<FreeFirebasePanel[]> {
  return query<FreeFirebasePanel>(
    `SELECT id, firebase_url AS "firebaseUrl", display_name AS "displayName",
            active, assigned_to AS "assignedTo", assigned_at AS "assignedAt",
            added_at AS "addedAt"
       FROM free_firebase_pool
      ORDER BY added_at DESC`
  );
}

export async function removeFreeFirebasePanel(id: string): Promise<void> {
  await query("DELETE FROM free_firebase_pool WHERE id = $1", [id]);
}

export async function getClaimedFreePanel(telegramId: number): Promise<FreeFirebasePanel | undefined> {
  const rows = await query<FreeFirebasePanel>(
    `SELECT p.id, p.firebase_url AS "firebaseUrl", p.display_name AS "displayName",
            p.active, p.assigned_to AS "assignedTo", p.assigned_at AS "assignedAt",
            p.added_at AS "addedAt"
       FROM free_firebase_pool p
       JOIN free_panel_claims c ON c.pool_id = p.id
      WHERE c.telegram_id = $1`,
    [telegramId]
  );
  return rows[0];
}

export async function claimFreeFirebase(telegramId: number): Promise<FreeFirebasePanel | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<FreeFirebasePanel>(
      `SELECT p.id, p.firebase_url AS "firebaseUrl", p.display_name AS "displayName",
              p.active, p.assigned_to AS "assignedTo", p.assigned_at AS "assignedAt",
              p.added_at AS "addedAt"
         FROM free_firebase_pool p
         JOIN free_panel_claims c ON c.pool_id = p.id
        WHERE c.telegram_id = $1`,
      [telegramId]
    );
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return existing.rows[0];
    }
    const available = await client.query<FreeFirebasePanel>(
      `SELECT id, firebase_url AS "firebaseUrl", display_name AS "displayName",
              active, assigned_to AS "assignedTo", assigned_at AS "assignedAt",
              added_at AS "addedAt"
         FROM free_firebase_pool p
        WHERE p.active = TRUE AND p.assigned_to IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM firebase_connections c
             WHERE c.telegram_id = $1 AND c.firebase_url = p.firebase_url
          )
        ORDER BY p.added_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [telegramId]
    );
    const panel = available.rows[0];
    if (!panel) {
      await client.query("COMMIT");
      return undefined;
    }
    const assigned = await client.query<FreeFirebasePanel>(
      `UPDATE free_firebase_pool
          SET assigned_to = $2, assigned_at = NOW()
        WHERE id = $1
      RETURNING id, firebase_url AS "firebaseUrl", display_name AS "displayName",
                active, assigned_to AS "assignedTo", assigned_at AS "assignedAt",
                added_at AS "addedAt"`,
      [panel.id, telegramId]
    );
    await client.query(
      `INSERT INTO free_panel_claims (telegram_id, pool_id, firebase_url, display_name)
       VALUES ($1, $2, $3, $4)`,
      [telegramId, panel.id, panel.firebaseUrl, panel.displayName]
    );
    await client.query(
      `INSERT INTO firebase_connections (telegram_id, firebase_url, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id, firebase_url) DO NOTHING`,
      [telegramId, panel.firebaseUrl, panel.displayName]
    );
    await client.query("COMMIT");
    return assigned.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addRequiredChannel(chatId: string, title: string, inviteLink?: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO required_channels (chat_id, title, invite_link)
     VALUES ($1, $2, $3) RETURNING id`,
    [chatId, title, inviteLink ?? null]
  );
  return rows[0].id;
}

export async function getRequiredChannels(): Promise<RequiredChannel[]> {
  return query<RequiredChannel>(
    `SELECT id, chat_id AS "chatId", title, invite_link AS "inviteLink", added_at AS "addedAt"
       FROM required_channels ORDER BY added_at`
  );
}

export async function removeRequiredChannel(id: string): Promise<void> {
  await query("DELETE FROM required_channels WHERE id = $1", [id]);
}

export async function getAdminConnections(limit = 20): Promise<AdminConnection[]> {
  return query<AdminConnection>(
    `SELECT fc.id, fc.firebase_url AS "firebaseUrl", fc.display_name AS "displayName",
            fc.status, fc.last_checked AS "lastChecked", fc.telegram_id AS "telegramId",
            u.username, u.first_name AS "firstName",
            COUNT(dc.normalized_device_id)::int AS devices,
            COUNT(dc.normalized_device_id) FILTER (WHERE dc.status = 'online')::int AS online
       FROM firebase_connections fc
       JOIN users u ON u.telegram_id = fc.telegram_id
       LEFT JOIN device_cache dc ON dc.firebase_id = fc.id
      GROUP BY fc.id, u.telegram_id
      ORDER BY fc.added_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))]
  );
}