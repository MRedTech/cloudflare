// ==================================================
// SECURE ENTRY VISITOR - CLOUDFLARE WORKER
// Fast Check In + D1 Search + Check Out + Overnight Parking + E-Pass + R2 + GAS Sync + Retention
//
// Frontend contract:
// - POST action=CHECK_IN
// - POST action=CHECK_OUT (recordId required)
// - GET field=REGNUM | MYKADPASSPORT | UNITNUMBER | VISITORPASS
// - Required ENV: R2_PREFIX, EPASS_TOKEN_SECRET
// - Parking ENV: PARKING_FREE_SECONDS, PARKING_RESET_SECONDS,
//   PARKING_BLOCK_SECONDS, PARKING_BLOCK_FEE
// - Optional E-Pass ENV: EPASS_LOGO_URL
// ==================================================

const SEARCH_LIST_LIMIT = 30;
const MALAYSIA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/** =========================
 * CORS + response helpers
 * ========================= */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResp(obj, status = 200, cors = corsHeaders(), extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...cors,
      ...extra,
      "Content-Type": "application/json",
    },
  });
}

function textResp(text, status = 200, cors = corsHeaders(), extra = {}) {
  return new Response(text, {
    status,
    headers: { ...cors, ...extra },
  });
}

function toText(value) {
  return value == null ? "" : String(value).trim();
}

function toUpper(value) {
  return toText(value).toUpperCase();
}

function normKey(value) {
  return toUpper(value).replace(/[^A-Z0-9]/g, "");
}

function cleanInput(value, maxLength = 160) {
  return toText(value).slice(0, maxLength);
}

function cleanUpper(value, maxLength = 160) {
  return cleanInput(value, maxLength).toUpperCase();
}

function contactDigits(value) {
  return toText(value).replace(/[^0-9]/g, "").slice(0, 15);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(toText(value));
}

function isCheckedInStatus(value) {
  return normKey(value) === "CHECKEDIN";
}

function formatMalaysiaDateTime(value) {
  const raw = toText(value);
  if (!raw) return "";

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return raw;

  const local = new Date(parsed.getTime() + MALAYSIA_UTC_OFFSET_MS);
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = local.getUTCFullYear();
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const min = String(local.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

/** =========================
 * Image helpers
 * ========================= */
function dataUrlToBytes(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid image data URL");

  const contentType = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return { contentType, bytes };
}

function bufferToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function utcYmd(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** =========================
 * D1 helpers
 * ========================= */
async function dbRun(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).run();
}

async function dbFirst(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).first();
}

async function dbAll(env, sql, ...params) {
  return env.DB.prepare(sql).bind(...params).all();
}

function getChangeCount(result) {
  const changes = result && result.meta ? Number(result.meta.changes) : 0;
  return Number.isFinite(changes) ? changes : 0;
}

/** =========================
 * Environment/config helpers
 * ========================= */
function clampInt(value, fallback, min, max) {
  const parsed = parseInt(toText(value) || String(fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function retentionDays(env) {
  return clampInt(env.RETENTION_DAYS, 90, 1, 3650);
}

function syncTriesPerRun(env) {
  return clampInt(env.SYNC_TRIES_PER_RUN, 3, 1, 5);
}

function syncRetryDelayMs(env) {
  return clampInt(env.SYNC_RETRY_DELAY_MS, 1500, 250, 10000);
}

function syncMaxAttempts(env) {
  return clampInt(env.SYNC_MAX_ATTEMPTS, 8, 1, 30);
}

function syncRetryBatch(env, overrideLimit) {
  return clampInt(overrideLimit || env.SYNC_RETRY_BATCH, 20, 1, 100);
}

function syncRetryStartAt(env) {
  const raw = toText(env.SYNC_RETRY_START_AT);
  if (!raw) return "";

  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString();
}


function parkingFreeSeconds(env) {
  return clampInt(env.PARKING_FREE_SECONDS, 86400, 60, 31536000);
}

function parkingResetSeconds(env) {
  return clampInt(env.PARKING_RESET_SECONDS, 86400, 60, 31536000);
}

function parkingBlockSeconds(env) {
  return clampInt(env.PARKING_BLOCK_SECONDS, 86400, 60, 31536000);
}

function parkingBlockFeeCents(env) {
  const raw = parseFloat(toText(env.PARKING_BLOCK_FEE) || "10");
  if (!Number.isFinite(raw) || raw < 0) return 1000;
  return Math.round(raw * 100);
}

function publicBaseUrl(env) {
  return toText(env.PUBLIC_BASE_URL).replace(/\/$/, "");
}

function ePassSecret(env) {
  return toText(env.EPASS_TOKEN_SECRET);
}

// Required per-site ENV value, for example: visitor-sensory
// Copy the same Worker to another site and change only R2_PREFIX in Cloudflare.
function r2Prefix(env) {
  const prefix = cleanInput(env.R2_PREFIX, 80)
    .replace(/\\/g, "/")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9/_-]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (!prefix) {
    throw new Error("R2_PREFIX environment variable is missing.");
  }

  return prefix;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanSyncError(error) {
  let message = error && error.message
    ? String(error.message)
    : String(error || "Unknown sync error");

  message = message.replace(/<script[\s\S]*?<\/script>/gi, " ");
  message = message.replace(/<style[\s\S]*?<\/style>/gi, " ");
  message = message.replace(/<[^>]+>/g, " ");
  message = message.replace(/\s+/g, " ").trim();
  return message.slice(0, 600);
}


/** =========================
 * Overnight parking + E-Pass helpers
 * ========================= */
function appError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function parseIsoMs(value) {
  const ms = Date.parse(toText(value));
  return Number.isFinite(ms) ? ms : NaN;
}

function secondsBetween(startValue, endValue) {
  const startMs = parseIsoMs(startValue);
  const endMs = parseIsoMs(endValue);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 1000));
}

function addSecondsIso(value, seconds) {
  const ms = parseIsoMs(value);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + Math.max(0, Number(seconds) || 0) * 1000).toISOString();
}

function formatDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatRinggit(cents) {
  const value = Math.max(0, Math.round(Number(cents) || 0)) / 100;
  return `RM${value.toFixed(2)}`;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function ePassSignature(env, sessionId) {
  const secret = ePassSecret(env);
  const id = toText(sessionId);
  if (!secret || !id) return "";

  if (!globalThis.__SE_EP_KEYS) globalThis.__SE_EP_KEYS = new Map();
  let key = globalThis.__SE_EP_KEYS.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    globalThis.__SE_EP_KEYS.set(secret, key);
  }

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`secure-entry-e-pass:${id}`)
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function constantTimeEqual(left, right) {
  const a = toText(left);
  const b = toText(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

async function makeEPassUrl(env, sessionId) {
  const baseUrl = publicBaseUrl(env);
  const signature = await ePassSignature(env, sessionId);
  if (!baseUrl || !signature) return "";
  return `${baseUrl}/e-pass?sid=${encodeURIComponent(sessionId)}&sig=${encodeURIComponent(signature)}`;
}

function parkingStatusLabel(status) {
  const normalized = toUpper(status);
  if (normalized === "ACTIVE") return "CHECKED IN";
  if (normalized === "PAUSED") return "CHECKED OUT";
  if (normalized === "REVOKED") return "DEACTIVATED";
  return "EXPIRED";
}

function computeParkingSnapshot(row, env, nowMs = Date.now()) {
  const sessionId = toText(row.ps_id || row.parking_session_id);
  if (!sessionId) return null;

  const storedStatus = toUpper(row.parking_status || row.ps_status || "");
  const resetAt = toText(row.parking_reset_at || row.ps_reset_at);
  const resetMs = parseIsoMs(resetAt);
  const expiredWhilePaused = storedStatus === "PAUSED" && Number.isFinite(resetMs) && nowMs >= resetMs;
  const status = expiredWhilePaused ? "ENDED" : (storedStatus || "ENDED");

  let durationSeconds = Math.max(0, Math.floor(Number(
    row.parking_accumulated_seconds ?? row.ps_accumulated_seconds ?? 0
  ) || 0));

  const currentCheckInAt = toText(row.parking_current_check_in_at || row.ps_current_check_in_at);
  if (status === "ACTIVE" && currentCheckInAt) {
    durationSeconds += secondsBetween(currentCheckInAt, new Date(nowMs).toISOString());
  }

  const freeSeconds = parkingFreeSeconds(env);
  const blockSeconds = parkingBlockSeconds(env);
  const blockFeeCents = parkingBlockFeeCents(env);
  const freeRemainingSeconds = Math.max(0, freeSeconds - durationSeconds);
  const chargeBlocks = durationSeconds <= freeSeconds
    ? 0
    : Math.ceil((durationSeconds - freeSeconds) / blockSeconds);
  const currentChargeCents = chargeBlocks * blockFeeCents;

  let nextChargeInSeconds = 0;
  if (durationSeconds < freeSeconds) {
    nextChargeInSeconds = freeSeconds - durationSeconds;
  } else {
    let nextThreshold = freeSeconds + Math.max(1, chargeBlocks) * blockSeconds;
    if (nextThreshold <= durationSeconds) nextThreshold += blockSeconds;
    nextChargeInSeconds = Math.max(0, nextThreshold - durationSeconds);
  }

  const resetRemainingSeconds = status === "PAUSED" && Number.isFinite(resetMs)
    ? Math.max(0, Math.floor((resetMs - nowMs) / 1000))
    : 0;

  return {
    sessionId,
    status,
    statusLabel: parkingStatusLabel(status),
    serverNow: new Date(nowMs).toISOString(),
    sessionStartedAt: toText(row.parking_session_started_at || row.ps_session_started_at),
    currentCheckInAt,
    lastCheckOutAt: toText(row.parking_last_check_out_at || row.ps_last_check_out_at),
    resetAt,
    durationSeconds,
    duration: formatDuration(durationSeconds),
    freeSeconds,
    freeRemainingSeconds,
    freeRemaining: formatDuration(freeRemainingSeconds),
    blockSeconds,
    blockFeeCents,
    blockFee: formatRinggit(blockFeeCents),
    chargeBlocks,
    currentChargeCents,
    currentCharge: formatRinggit(currentChargeCents),
    nextChargeInSeconds,
    nextChargeIn: formatDuration(nextChargeInSeconds),
    resetRemainingSeconds,
    resetRemaining: formatDuration(resetRemainingSeconds),
  };
}

async function loadParkingSessionById(env, sessionId) {
  return dbFirst(
    env,
    `SELECT id, regnum, reg_norm, status, session_started_at,
            accumulated_seconds, current_check_in_at, last_check_out_at,
            reset_at, current_entry_id, last_visitor_pass_number,
            last_unit_number, created_at, updated_at, ended_at,
            revoked_at, revocation_reason, version
       FROM parking_sessions
      WHERE id = ?
      LIMIT 1`,
    sessionId
  );
}

async function loadOpenParkingSessionByReg(env, regNorm) {
  return dbFirst(
    env,
    `SELECT id, regnum, reg_norm, status, session_started_at,
            accumulated_seconds, current_check_in_at, last_check_out_at,
            reset_at, current_entry_id, last_visitor_pass_number,
            last_unit_number, created_at, updated_at, ended_at,
            revoked_at, revocation_reason, version
       FROM parking_sessions
      WHERE reg_norm = ?
        AND status IN ('ACTIVE', 'PAUSED')
      ORDER BY updated_at DESC
      LIMIT 1`,
    regNorm
  );
}

async function expireParkingSessionIfNeeded(env, session) {
  if (!session || toUpper(session.status) !== "PAUSED") return session;
  const resetMs = parseIsoMs(session.reset_at);
  if (!Number.isFinite(resetMs) || Date.now() < resetMs) return session;

  const nowIso = new Date().toISOString();
  await dbRun(
    env,
    `UPDATE parking_sessions
        SET status = 'ENDED',
            ended_at = COALESCE(ended_at, reset_at, ?),
            updated_at = ?,
            version = COALESCE(version, 1) + 1
      WHERE id = ?
        AND status = 'PAUSED'
        AND reset_at IS NOT NULL
        AND reset_at <= ?`,
    nowIso,
    nowIso,
    session.id,
    nowIso
  );
  return loadParkingSessionById(env, session.id);
}

async function expirePausedParkingSessions(env) {
  const nowIso = new Date().toISOString();
  const result = await dbRun(
    env,
    `UPDATE parking_sessions
        SET status = 'ENDED',
            ended_at = COALESCE(ended_at, reset_at, ?),
            updated_at = ?,
            version = COALESCE(version, 1) + 1
      WHERE status = 'PAUSED'
        AND reset_at IS NOT NULL
        AND reset_at <= ?`,
    nowIso,
    nowIso,
    nowIso
  );
  return getChangeCount(result);
}

async function createNewParkingSessionForEntry(env, entry, checkInIso) {
  const sessionId = crypto.randomUUID();
  const intervalId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  try {
    await dbRun(
      env,
      `INSERT INTO parking_sessions (
        id, regnum, reg_norm, status, session_started_at,
        accumulated_seconds, current_check_in_at, last_check_out_at,
        reset_at, current_entry_id, last_visitor_pass_number,
        last_unit_number, created_at, updated_at, ended_at,
        revoked_at, revocation_reason, version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sessionId, entry.regnum, entry.reg_norm, "ACTIVE", checkInIso,
      0, checkInIso, null,
      null, entry.id, entry.visitor_pass_number,
      entry.unit_number, nowIso, nowIso, null,
      null, "", 1
    );

    await dbRun(
      env,
      `INSERT INTO parking_intervals (
        id, session_id, visitor_record_id, check_in_time,
        check_out_time, duration_seconds, visitor_pass_number,
        unit_number, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      intervalId, sessionId, entry.id, checkInIso,
      null, 0, entry.visitor_pass_number,
      entry.unit_number, nowIso, nowIso
    );

    await dbRun(
      env,
      `UPDATE entries
          SET parking_session_id = ?, parking_interval_id = ?
        WHERE id = ?`,
      sessionId,
      intervalId,
      entry.id
    );

    return { sessionId, intervalId, resumed: false };
  } catch (error) {
    try { await dbRun(env, `DELETE FROM parking_intervals WHERE id = ?`, intervalId); } catch (_) {}
    try { await dbRun(env, `DELETE FROM parking_sessions WHERE id = ?`, sessionId); } catch (_) {}
    throw error;
  }
}

async function resumeParkingSessionForEntry(env, session, entry, checkInIso) {
  const intervalId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const previous = { ...session };

  const update = await dbRun(
    env,
    `UPDATE parking_sessions
        SET status = 'ACTIVE',
            current_check_in_at = ?,
            current_entry_id = ?,
            reset_at = NULL,
            last_visitor_pass_number = ?,
            last_unit_number = ?,
            updated_at = ?,
            version = COALESCE(version, 1) + 1
      WHERE id = ?
        AND status = 'PAUSED'
        AND reset_at IS NOT NULL
        AND reset_at > ?`,
    checkInIso,
    entry.id,
    entry.visitor_pass_number,
    entry.unit_number,
    nowIso,
    session.id,
    checkInIso
  );

  if (getChangeCount(update) < 1) {
    throw appError(
      "PARKING_SESSION_NOT_RESUMABLE",
      "The previous parking session can no longer be resumed. Please try again."
    );
  }

  try {
    await dbRun(
      env,
      `INSERT INTO parking_intervals (
        id, session_id, visitor_record_id, check_in_time,
        check_out_time, duration_seconds, visitor_pass_number,
        unit_number, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      intervalId, session.id, entry.id, checkInIso,
      null, 0, entry.visitor_pass_number,
      entry.unit_number, nowIso, nowIso
    );

    await dbRun(
      env,
      `UPDATE entries
          SET parking_session_id = ?, parking_interval_id = ?
        WHERE id = ?`,
      session.id,
      intervalId,
      entry.id
    );

    return { sessionId: session.id, intervalId, resumed: true };
  } catch (error) {
    try { await dbRun(env, `DELETE FROM parking_intervals WHERE id = ?`, intervalId); } catch (_) {}
    try {
      await dbRun(
        env,
        `UPDATE parking_sessions
            SET status = ?, current_check_in_at = ?, last_check_out_at = ?,
                reset_at = ?, current_entry_id = ?,
                last_visitor_pass_number = ?, last_unit_number = ?,
                updated_at = ?, version = ?
          WHERE id = ? AND current_entry_id = ?`,
        previous.status,
        previous.current_check_in_at,
        previous.last_check_out_at,
        previous.reset_at,
        previous.current_entry_id,
        previous.last_visitor_pass_number,
        previous.last_unit_number,
        previous.updated_at,
        previous.version,
        session.id,
        entry.id
      );
    } catch (_) {}
    throw error;
  }
}

async function attachParkingSessionForCheckIn(env, entry, checkInIso) {
  let openSession = await loadOpenParkingSessionByReg(env, entry.reg_norm);
  if (openSession) openSession = await expireParkingSessionIfNeeded(env, openSession);

  if (openSession && toUpper(openSession.status) === "ACTIVE") {
    throw appError(
      "VEHICLE_ALREADY_CHECKED_IN",
      `Vehicle ${entry.regnum} already has an active parking record.`
    );
  }

  if (openSession && toUpper(openSession.status) === "PAUSED") {
    const resetMs = parseIsoMs(openSession.reset_at);
    const checkInMs = parseIsoMs(checkInIso);
    if (Number.isFinite(resetMs) && Number.isFinite(checkInMs) && checkInMs < resetMs) {
      return resumeParkingSessionForEntry(env, openSession, entry, checkInIso);
    }

    const nowIso = new Date().toISOString();
    await dbRun(
      env,
      `UPDATE parking_sessions
          SET status = 'ENDED', ended_at = COALESCE(ended_at, reset_at, ?),
              updated_at = ?, version = COALESCE(version, 1) + 1
        WHERE id = ? AND status = 'PAUSED'`,
      nowIso,
      nowIso,
      openSession.id
    );
  }

  return createNewParkingSessionForEntry(env, entry, checkInIso);
}

async function ensureParkingForActiveEntry(env, entry) {
  if (toText(entry.parking_session_id) && toText(entry.parking_interval_id)) {
    return {
      sessionId: toText(entry.parking_session_id),
      intervalId: toText(entry.parking_interval_id),
      resumed: false,
    };
  }

  if (!isCheckedInStatus(entry.visit_status) || toText(entry.check_out_time)) {
    return null;
  }

  const checkInIso = toText(entry.check_in_time || entry.created_at) || new Date().toISOString();
  return attachParkingSessionForCheckIn(env, entry, checkInIso);
}

async function finalizeParkingForEntry(env, entry, checkOutIso) {
  let current = entry;
  if (!toText(current.parking_session_id) || !toText(current.parking_interval_id)) {
    await ensureParkingForActiveEntry(env, current);
    current = await loadRecordById(env, current.id);
  }

  const sessionId = toText(current && current.parking_session_id);
  const intervalId = toText(current && current.parking_interval_id);
  if (!sessionId || !intervalId) return null;

  const durationSeconds = secondsBetween(
    current.check_in_time || current.created_at,
    checkOutIso
  );
  const resetAt = addSecondsIso(checkOutIso, parkingResetSeconds(env));
  const nowIso = new Date().toISOString();

  await dbRun(
    env,
    `UPDATE parking_intervals
        SET check_out_time = COALESCE(check_out_time, ?),
            duration_seconds = CASE
              WHEN check_out_time IS NULL THEN ?
              ELSE duration_seconds
            END,
            updated_at = ?
      WHERE id = ?`,
    checkOutIso,
    durationSeconds,
    nowIso,
    intervalId
  );

  await dbRun(
    env,
    `UPDATE parking_sessions
        SET accumulated_seconds = (
              SELECT COALESCE(SUM(duration_seconds), 0)
                FROM parking_intervals
               WHERE session_id = ?
            ),
            status = 'PAUSED',
            current_check_in_at = NULL,
            last_check_out_at = ?,
            reset_at = ?,
            current_entry_id = NULL,
            last_visitor_pass_number = ?,
            last_unit_number = ?,
            updated_at = ?,
            version = COALESCE(version, 1) + 1
      WHERE id = ?`,
    sessionId,
    checkOutIso,
    resetAt,
    current.visitor_pass_number,
    current.unit_number,
    nowIso,
    sessionId
  );

  return loadParkingSessionById(env, sessionId);
}

function htmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function authorizedEPassSession(url, env) {
  const sessionId = cleanInput(url.searchParams.get("sid"), 100);
  const signature = cleanInput(url.searchParams.get("sig"), 200);
  if (!sessionId || !signature || !ePassSecret(env)) return null;
  const expected = await ePassSignature(env, sessionId);
  if (!expected || !constantTimeEqual(signature, expected)) return null;
  let session = await loadParkingSessionById(env, sessionId);
  if (!session) return null;
  session = await expireParkingSessionIfNeeded(env, session);
  return session;
}

function sessionRowForSnapshot(session) {
  return {
    ps_id: session.id,
    parking_status: session.status,
    parking_session_started_at: session.session_started_at,
    parking_accumulated_seconds: session.accumulated_seconds,
    parking_current_check_in_at: session.current_check_in_at,
    parking_last_check_out_at: session.last_check_out_at,
    parking_reset_at: session.reset_at,
  };
}

function ePassExpiredHtml(status) {
  const revoked = toUpper(status) === "REVOKED";
  const title = revoked ? "E-VISITOR PASS DEACTIVATED" : "E-VISITOR PASS EXPIRED";
  const message = revoked
    ? "This E-Visitor Pass has been deactivated. Please contact the guard house."
    : "This parking session has ended. Please obtain a new E-Visitor Pass for the next visit.";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef7ef;font-family:Arial,sans-serif;color:#173c28;padding:20px;box-sizing:border-box}.card{width:min(390px,100%);background:#fff;border-radius:22px;padding:32px 24px;text-align:center;box-shadow:0 18px 45px rgba(23,107,57,.16);border:1px solid rgba(23,107,57,.12)}h1{font-size:22px;margin:0 0 14px;color:#176b39}.stamp{font-size:46px;margin-bottom:12px;filter:grayscale(1)}p{font-size:14px;line-height:1.55;margin:0}.footer{margin-top:28px;font-size:10px;color:#95a39a;font-weight:700;letter-spacing:1px}</style></head><body><main class="card"><div class="stamp">${revoked ? "⛔" : "⌛"}</div><h1>${title}</h1><p>${message}</p><div class="footer">POWERED BY MRED TECH</div></main></body></html>`;
}

function ePassHtml(env, session, snapshot) {
  const logoUrl = toText(env.EPASS_LOGO_URL);
  const logo = logoUrl
    ? `<img class="logo" src="${htmlEscape(logoUrl)}" alt="Sensory Southville City">`
    : `<div class="wordmark"><b>SENSORY</b><span>Southville City</span></div>`;

  const statusClass = snapshot.status === "ACTIVE" ? "active" : "paused";
  const initialJson = JSON.stringify({
    ...snapshot,
    regnum: session.regnum,
    visitorPassNumber: session.last_visitor_pass_number,
    unitNumber: session.last_unit_number,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sensory E-Visitor Pass</title>
<style>
:root{--g1:#41e671;--g2:#176b39;--ink:#173c28;--soft:#eef8f0}*{box-sizing:border-box}body{margin:0;background:linear-gradient(160deg,#e8f6eb,#f8fffa 55%,#dff4e5);font-family:Arial,sans-serif;color:var(--ink);padding:18px;text-transform:uppercase}.pass{width:min(420px,100%);margin:auto;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 20px 55px rgba(23,107,57,.18);border:1px solid rgba(23,107,57,.12)}.head{padding:22px 20px 18px;text-align:center;background:linear-gradient(145deg,#f8fff9,#e7f7eb)}.logo{max-width:220px;max-height:90px;object-fit:contain}.wordmark b{display:block;font-size:36px;letter-spacing:8px;color:#111}.wordmark span{display:block;font-family:Georgia,serif;font-size:22px;text-transform:none}.title{font-size:18px;font-weight:900;letter-spacing:2px;margin-top:12px;color:#176b39}.badge{display:inline-block;margin-top:10px;padding:7px 14px;border-radius:999px;font-size:11px;font-weight:900;letter-spacing:1px}.badge.active{background:#dff8e7;color:#0c7a38}.badge.paused{background:#fff0d8;color:#9a5b00}.body{padding:18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field{background:var(--soft);padding:12px;border-radius:13px;border:1px solid rgba(23,107,57,.08)}.field.full{grid-column:1/-1}.label{font-size:9px;color:#6f8778;font-weight:800;letter-spacing:.8px}.value{font-size:16px;font-weight:900;margin-top:4px;word-break:break-word}.timer{margin-top:14px;padding:18px;border-radius:17px;background:linear-gradient(145deg,var(--g1),var(--g2));color:#fff;text-align:center}.timer-label{font-size:10px;font-weight:800;letter-spacing:1px;opacity:.9}.timer-value{font-size:34px;font-weight:900;letter-spacing:2px;margin:4px 0 12px}.money{display:flex;gap:10px}.money>div{flex:1;background:rgba(255,255,255,.16);padding:10px;border-radius:12px}.money b{display:block;font-size:18px;margin-top:4px}.terms{margin-top:16px;padding:15px;border-radius:14px;background:#f8faf8;border:1px solid #e2ebe4}.terms h3{font-size:12px;margin:0 0 9px;color:#176b39}.terms ol{padding-left:18px;margin:0;text-transform:none;font-size:10px;line-height:1.5;color:#405649}.notice{margin-top:13px;text-align:center;font-size:10px;font-weight:900;color:#176b39}.footer{text-align:center;padding:16px;font-size:9px;color:#93a199;font-weight:800;letter-spacing:1px;border-top:1px solid #edf1ee}@media(max-width:360px){.grid{grid-template-columns:1fr}.field.full{grid-column:auto}.timer-value{font-size:29px}}
</style></head><body><main class="pass"><header class="head">${logo}<div class="title">E-VISITOR PASS</div><div id="statusBadge" class="badge ${statusClass}">${htmlEscape(snapshot.statusLabel)}</div></header><section class="body"><div class="grid"><div class="field"><div class="label">VISITOR PASS NO.</div><div class="value">${htmlEscape(session.last_visitor_pass_number || "-")}</div></div><div class="field"><div class="label">VEHICLE REG. NO.</div><div class="value">${htmlEscape(session.regnum || "-")}</div></div><div class="field"><div class="label">UNIT NUMBER</div><div class="value">${htmlEscape(session.last_unit_number || "-")}</div></div><div class="field"><div class="label">SESSION STARTED</div><div class="value" style="font-size:12px">${htmlEscape(formatMalaysiaDateTime(session.session_started_at))}</div></div></div><div class="timer"><div class="timer-label">PARKING DURATION</div><div id="duration" class="timer-value">${htmlEscape(snapshot.duration)}</div><div class="money"><div><span id="secondaryLabel" class="timer-label">${snapshot.status === "PAUSED" ? "SESSION RESET IN" : (snapshot.currentChargeCents > 0 ? "NEXT CHARGE IN" : "FREE TIME REMAINING")}</span><b id="secondaryValue">${htmlEscape(snapshot.status === "PAUSED" ? snapshot.resetRemaining : (snapshot.currentChargeCents > 0 ? snapshot.nextChargeIn : snapshot.freeRemaining))}</b></div><div><span class="timer-label">CURRENT CHARGE</span><b id="charge">${htmlEscape(snapshot.currentCharge)}</b></div></div></div><div class="terms"><h3>PARKING TERMS &amp; CONDITIONS</h3><ol><li>The first 24 hours of accumulated parking time are free.</li><li>Each additional started 24-hour block is charged at RM10.</li><li>Only actual time parked inside the property is counted.</li><li>Re-entry within 24 hours after check-out continues the previous parking duration.</li><li>Re-entry at or after 24 hours starts a new parking session.</li><li>This E-Visitor Pass is valid only for the registered vehicle.</li></ol></div><div class="notice">PLEASE ENSURE THE VEHICLE IS CHECKED OUT UPON EXIT.</div></section><footer class="footer">POWERED BY MRED TECH</footer></main>
<script>const initial=${initialJson};const baseClient=Date.now();function fmt(v){v=Math.max(0,Math.floor(v));const h=Math.floor(v/3600),m=Math.floor(v%3600/60),s=v%60;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')}function money(c){return 'RM'+(Math.max(0,c)/100).toFixed(2)}function tick(){const elapsed=Math.max(0,Math.floor((Date.now()-baseClient)/1000));let duration=initial.durationSeconds;if(initial.status==='ACTIVE')duration+=elapsed;const free=initial.freeSeconds,block=initial.blockSeconds,fee=initial.blockFeeCents;const blocks=duration<=free?0:Math.ceil((duration-free)/block);const charge=blocks*fee;document.getElementById('duration').textContent=fmt(duration);document.getElementById('charge').textContent=money(charge);const label=document.getElementById('secondaryLabel'),value=document.getElementById('secondaryValue');if(initial.status==='PAUSED'){label.textContent='SESSION RESET IN';value.textContent=fmt(Math.max(0,initial.resetRemainingSeconds-elapsed));}else if(charge>0){let threshold=free+Math.max(1,blocks)*block;if(threshold<=duration)threshold+=block;label.textContent='NEXT CHARGE IN';value.textContent=fmt(threshold-duration);}else{label.textContent='FREE TIME REMAINING';value.textContent=fmt(free-duration);}}setInterval(tick,1000);tick();</script></body></html>`;
}

/** =========================
 * Record mapping
 * ========================= */
async function mapSearchRecord(row, env) {
  const photoLink = toText(row.photo_link || row.drive_url);
  const checkInRaw = toText(row.check_in_time || row.created_at);
  const checkOutRaw = toText(row.check_out_time);
  const parking = computeParkingSnapshot(row, env);

  if (parking) {
    parking.ePassUrl = await makeEPassUrl(env, parking.sessionId);
  }

  return {
    recordId: toText(row.id),
    id: toText(row.id),

    createdAt: toText(row.created_at),
    timestamp: formatMalaysiaDateTime(checkInRaw),
    checkInTime: formatMalaysiaDateTime(checkInRaw),
    checkOutTime: formatMalaysiaDateTime(checkOutRaw),

    namePassport: toText(row.name_passport),
    mykadPassport: toText(row.mykad_passport),
    regnum: toText(row.regnum),
    contact: toText(row.contact),
    visitorPassNumber: toText(row.visitor_pass_number),
    unitNumber: toText(row.unit_number),

    status: toText(row.visit_status) || (checkOutRaw ? "CHECKED_OUT" : "CHECKED_IN"),
    hasHyperlink: !!photoLink,
    photoLink,

    parking,
    parkingSessionId: parking ? parking.sessionId : "",
    parkingSessionStatus: parking ? parking.status : "",
    parkingDurationSeconds: parking ? parking.durationSeconds : 0,
    parkingDuration: parking ? parking.duration : "",
    freeTimeRemainingSeconds: parking ? parking.freeRemainingSeconds : 0,
    freeTimeRemaining: parking ? parking.freeRemaining : "",
    currentChargeCents: parking ? parking.currentChargeCents : 0,
    currentCharge: parking ? parking.currentCharge : "RM0.00",
    sessionResetAt: parking ? parking.resetAt : "",
    sessionResetRemaining: parking ? parking.resetRemaining : "",
    ePassUrl: parking ? parking.ePassUrl : "",
  };
}

const FULL_RECORD_SELECT = `
  SELECT id, created_at, client_txn_id, device_id, check_out_device_id,
         name_passport, mykad_passport, regnum, contact,
         visitor_pass_number, unit_number,
         reg_norm, id_norm, pass_norm, unit_norm,
         check_in_time, check_out_time, visit_status,
         image_key, image_sha256, drive_file_id, drive_url,
         sync_status, sync_attempts, sync_error, sync_version,
         parking_session_id, parking_interval_id
    FROM entries
`;

const SEARCH_RECORD_SELECT = `
  SELECT e.id, e.created_at, e.client_txn_id, e.device_id, e.check_out_device_id,
         e.name_passport, e.mykad_passport, e.regnum, e.contact,
         e.visitor_pass_number, e.unit_number,
         e.reg_norm, e.id_norm, e.pass_norm, e.unit_norm,
         e.check_in_time, e.check_out_time, e.visit_status,
         e.image_key, e.image_sha256, e.drive_file_id, e.drive_url,
         e.sync_status, e.sync_attempts, e.sync_error, e.sync_version,
         e.parking_session_id, e.parking_interval_id,
         ps.id AS ps_id,
         ps.status AS parking_status,
         ps.session_started_at AS parking_session_started_at,
         ps.accumulated_seconds AS parking_accumulated_seconds,
         ps.current_check_in_at AS parking_current_check_in_at,
         ps.last_check_out_at AS parking_last_check_out_at,
         ps.reset_at AS parking_reset_at
    FROM entries e
    LEFT JOIN parking_sessions ps ON ps.id = e.parking_session_id
`;

async function loadRecordById(env, recordId) {
  return dbFirst(
    env,
    `${FULL_RECORD_SELECT} WHERE id = ? LIMIT 1`,
    recordId
  );
}

async function loadRecordWithParkingById(env, recordId) {
  return dbFirst(
    env,
    `${SEARCH_RECORD_SELECT} WHERE e.id = ? LIMIT 1`,
    recordId
  );
}

/** =========================
 * GAS sync
 * - Uses one upsert-style action: SYNC
 * - sync_version prevents an older CHECK IN sync from marking a newer
 *   CHECK OUT change as DONE.
 * ========================= */
async function markSyncFailed(env, recordId, syncVersion, error) {
  try {
    await dbRun(
      env,
      `UPDATE entries
          SET sync_status = 'FAILED', sync_error = ?
        WHERE id = ? AND sync_version = ?`,
      cleanSyncError(error),
      recordId,
      syncVersion
    );
  } catch (_) {}
}

async function syncToGoogle(env, recordId) {
  if (!recordId) return;

  if (!env.GAS_SYNC_URL) {
    const row = await loadRecordById(env, recordId).catch(() => null);
    if (row) await markSyncFailed(env, recordId, row.sync_version, "GAS_SYNC_URL is missing");
    return;
  }

  if (!env.SYNC_TOKEN) {
    const row = await loadRecordById(env, recordId).catch(() => null);
    if (row) await markSyncFailed(env, recordId, row.sync_version, "SYNC_TOKEN is missing");
    return;
  }

  const tries = syncTriesPerRun(env);
  const baseDelay = syncRetryDelayMs(env);
  let lastError = null;
  let lastVersion = 0;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const record = await loadRecordById(env, recordId);
    if (!record) return;

    const syncVersion = Number(record.sync_version || 1);
    lastVersion = syncVersion;

    const imageViewUrl =
      record.image_key &&
      !toText(record.drive_url) &&
      env.PUBLIC_BASE_URL &&
      env.IMAGE_VIEW_TOKEN
        ? `${toText(env.PUBLIC_BASE_URL).replace(/\/$/, "")}/image?id=${encodeURIComponent(record.id)}&token=${encodeURIComponent(env.IMAGE_VIEW_TOKEN)}`
        : "";

    const payload = {
      token: env.SYNC_TOKEN,
      action: "SYNC",

      id: record.id,
      syncVersion,
      createdAt: record.created_at,
      clientTxnId: record.client_txn_id,
      deviceId: record.device_id,
      checkOutDeviceId: record.check_out_device_id,

      namePassport: record.name_passport,
      mykadPassport: record.mykad_passport,
      regnum: record.regnum,
      contact: record.contact,
      visitorPassNumber: record.visitor_pass_number,
      unitNumber: record.unit_number,

      checkInTime: record.check_in_time,
      checkOutTime: record.check_out_time || "",
      status: record.visit_status,
      imageViewUrl,
    };

    try {
      try {
        await dbRun(
          env,
          `UPDATE entries
              SET sync_attempts = COALESCE(sync_attempts, 0) + 1
            WHERE id = ? AND sync_version = ?`,
          record.id,
          syncVersion
        );
      } catch (_) {}

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let response;
      try {
        response = await fetch(env.GAS_SYNC_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const raw = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(`GAS sync HTTP failed: ${response.status} ${raw.slice(0, 240)}`);
      }

      let result = null;
      try {
        result = JSON.parse(raw || "{}");
      } catch (_) {
        result = null;
      }

      if (!result || result.success !== true) {
        const message = result && result.message
          ? result.message
          : raw.slice(0, 240) || "GAS returned non-success";
        throw new Error(`GAS sync app failed: ${message}`);
      }

      const driveFileId = toText(result.driveFileId);
      const driveUrl = toText(result.driveUrl);

      // Drive information belongs to the same ID image and remains valid even
      // if CHECK OUT increased sync_version while this request was running.
      if (driveFileId || driveUrl) {
        await dbRun(
          env,
          `UPDATE entries
              SET drive_file_id = COALESCE(NULLIF(?, ''), drive_file_id),
                  drive_url = COALESCE(NULLIF(?, ''), drive_url)
            WHERE id = ?`,
          driveFileId,
          driveUrl,
          record.id
        );
      }

      // Mark DONE only for the exact version that was sent. If CHECK OUT
      // changed the record during this request, the newer version stays PENDING.
      await dbRun(
        env,
        `UPDATE entries
            SET sync_status = 'DONE', sync_error = ''
          WHERE id = ? AND sync_version = ?`,
        record.id,
        syncVersion
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < tries) await sleep(baseDelay * attempt);
    }
  }

  await markSyncFailed(env, recordId, lastVersion, lastError);
}

async function retryPendingSync(env, ctx, overrideLimit) {
  if (!env.DB) return { ok: false, message: "DB binding missing" };

  const startAt = syncRetryStartAt(env);
  if (!startAt) {
    return {
      ok: false,
      message: "SYNC_RETRY_START_AT is not set. Scheduled retry is disabled to avoid touching old records.",
    };
  }

  const maxAttempts = syncMaxAttempts(env);
  const limit = syncRetryBatch(env, overrideLimit);

  const rows = await dbAll(
    env,
    `SELECT id
       FROM entries
      WHERE sync_status IN ('PENDING', 'FAILED')
        AND COALESCE(sync_attempts, 0) < ?
        AND created_at >= ?
      ORDER BY created_at ASC
      LIMIT ${limit}`,
    maxAttempts,
    startAt
  );

  const list = rows && Array.isArray(rows.results) ? rows.results : [];
  for (const row of list) ctx.waitUntil(syncToGoogle(env, row.id));

  return {
    ok: true,
    queued: list.length,
    startAt,
    maxAttempts,
    limit,
  };
}

/** =========================
 * Search helpers
 * ========================= */
async function findLatestPhotoProof(env, column, value) {
  return dbFirst(
    env,
    `SELECT drive_url
       FROM entries
      WHERE ${column} = ?
        AND drive_url IS NOT NULL
        AND drive_url <> ''
      ORDER BY created_at DESC
      LIMIT 1`,
    value
  );
}

async function d1PersonSearch(env, field, value) {
  const normalizedField = normKey(field);
  const normalizedValue = normKey(value);
  if (!normalizedValue) return { exist: false };

  const isReg = ["REGNUM", "REG", "CAR", "PLATE"].includes(normalizedField);
  const isId = ["MYKADPASSPORT", "MYKAD", "PASSPORT", "ID"].includes(normalizedField);
  if (!isReg && !isId) return { exist: false };

  const column = isReg ? "reg_norm" : "id_norm";
  let row = null;

  if (isId) {
    row = await dbFirst(
      env,
      `${SEARCH_RECORD_SELECT}
        WHERE e.id_norm = ?
          AND e.visit_status = 'CHECKED_IN'
          AND (e.check_out_time IS NULL OR e.check_out_time = '')
        ORDER BY e.created_at DESC
        LIMIT 1`,
      normalizedValue
    );
  }

  if (!row) {
    row = await dbFirst(
      env,
      `${SEARCH_RECORD_SELECT}
        WHERE e.${column} = ?
        ORDER BY e.created_at DESC
        LIMIT 1`,
      normalizedValue
    );
  }

  if (!row) return { exist: false };

  const proof = await findLatestPhotoProof(env, column, normalizedValue);
  const photoLink = toText(proof && proof.drive_url);
  const activeCheckIn = isCheckedInStatus(row.visit_status) && !toText(row.check_out_time);
  const data = await mapSearchRecord({ ...row, photo_link: photoLink }, env);

  if (activeCheckIn) {
    return {
      exist: true,
      hasHyperlink: !!photoLink,
      activeCheckIn: true,
      data,
    };
  }

  if (!photoLink) {
    return {
      exist: true,
      hasHyperlink: false,
      data: {},
    };
  }

  return {
    exist: true,
    hasHyperlink: true,
    activeCheckIn: false,
    data,
  };
}

const LIST_SEARCH_SELECT = `
  SELECT e.id, e.created_at,
         e.name_passport, e.mykad_passport, e.regnum, e.contact,
         e.visitor_pass_number, e.unit_number,
         e.check_in_time, e.check_out_time, e.visit_status,
         e.parking_session_id, e.parking_interval_id,
         ps.id AS ps_id,
         ps.status AS parking_status,
         ps.session_started_at AS parking_session_started_at,
         ps.accumulated_seconds AS parking_accumulated_seconds,
         ps.current_check_in_at AS parking_current_check_in_at,
         ps.last_check_out_at AS parking_last_check_out_at,
         ps.reset_at AS parking_reset_at,
         COALESCE(
           NULLIF(e.drive_url, ''),
           (
             SELECT p.drive_url
               FROM entries p
              WHERE p.drive_url IS NOT NULL
                AND p.drive_url <> ''
                AND (
                  (e.reg_norm <> '' AND p.reg_norm = e.reg_norm)
                  OR
                  (e.id_norm <> '' AND p.id_norm = e.id_norm)
                )
              ORDER BY p.created_at DESC
              LIMIT 1
           )
         ) AS photo_link
    FROM entries e
    LEFT JOIN parking_sessions ps ON ps.id = e.parking_session_id
`;

async function d1UnitSearch(env, value) {
  const unitNorm = normKey(value);
  if (!unitNorm) return { exist: false, count: 0, records: [] };

  const result = await dbAll(
    env,
    `${LIST_SEARCH_SELECT}
      WHERE e.unit_norm = ?
      ORDER BY e.created_at DESC
      LIMIT ${SEARCH_LIST_LIMIT}`,
    unitNorm
  );

  const rows = result && Array.isArray(result.results) ? result.results : [];
  const records = await Promise.all(rows.map((row) => mapSearchRecord(row, env)));

  return {
    exist: records.length > 0,
    count: records.length,
    records,
  };
}

async function d1PassSearch(env, value) {
  const passNorm = normKey(value);
  if (!passNorm) return { exist: false, count: 0, records: [] };

  const result = await dbAll(
    env,
    `${LIST_SEARCH_SELECT}
      WHERE e.pass_norm = ?
      ORDER BY
        CASE
          WHEN e.visit_status = 'CHECKED_IN'
           AND (e.check_out_time IS NULL OR e.check_out_time = '')
          THEN 0 ELSE 1
        END ASC,
        e.created_at DESC
      LIMIT ${SEARCH_LIST_LIMIT}`,
    passNorm
  );

  const rows = result && Array.isArray(result.results) ? result.results : [];
  const records = await Promise.all(rows.map((row) => mapSearchRecord(row, env)));

  return {
    exist: records.length > 0,
    count: records.length,
    records,
  };
}

async function d1Search(env, field, value) {
  const normalizedField = normKey(field);

  if (normalizedField === "UNITNUMBER" || normalizedField === "UNIT") {
    return d1UnitSearch(env, value);
  }

  if (
    normalizedField === "VISITORPASS" ||
    normalizedField === "VISITORPASSNUMBER" ||
    normalizedField === "PASSNUMBER" ||
    normalizedField === "PASS"
  ) {
    return d1PassSearch(env, value);
  }

  return d1PersonSearch(env, field, value);
}

/** =========================
 * Check-in validation + handlers
 * ========================= */
function validateCheckInPayload(data) {
  const namePassport = cleanUpper(data.namePassport, 120);
  const mykadPassport = cleanUpper(data.mykadPassport, 40);
  const regnum = cleanUpper(data.regnum, 30);
  const contact = contactDigits(data.contact);
  const visitorPassNumber = cleanUpper(data.visitorPassNumber, 20)
    .replace(/[^A-Z0-9-]/g, "");
  const unitNumber = cleanUpper(data.unitNumber, 40);

  if (!namePassport) return { ok: false, message: "Name is required." };
  if (!mykadPassport) return { ok: false, message: "MyKad / Passport is required." };
  if (!regnum) return { ok: false, message: "Registration Number is required." };
  if (contact.length < 10) return { ok: false, message: "Contact Number must contain at least 10 digits." };
  if (!visitorPassNumber) return { ok: false, message: "Visitor Pass Number is required." };
  if (!unitNumber) return { ok: false, message: "Unit Number is required." };

  const idNorm = normKey(mykadPassport);
  const hasLetter = /[A-Z]/.test(idNorm);
  if (!hasLetter && idNorm.length !== 12) {
    return { ok: false, message: "MyKad must contain 12 digits." };
  }

  return {
    ok: true,
    value: {
      namePassport,
      mykadPassport,
      regnum,
      contact,
      visitorPassNumber,
      unitNumber,
    },
  };
}

async function hasExistingPhotoProof(env, regNorm, idNorm) {
  if (!regNorm && !idNorm) return false;

  const row = await dbFirst(
    env,
    `SELECT id
       FROM entries
      WHERE drive_url IS NOT NULL
        AND drive_url <> ''
        AND (
          (reg_norm = ? AND ? <> '')
          OR
          (id_norm = ? AND ? <> '')
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    regNorm,
    regNorm,
    idNorm,
    idNorm
  );

  return !!(row && row.id);
}

async function checkInSuccessPayload(env, recordId, duplicate = false) {
  const joined = await loadRecordWithParkingById(env, recordId);
  const mapped = joined ? await mapSearchRecord(joined, env) : null;
  return {
    success: true,
    id: recordId,
    recordId,
    duplicate,
    createdAt: joined ? toText(joined.created_at) : "",
    checkInTime: joined ? formatMalaysiaDateTime(joined.check_in_time || joined.created_at) : "",
    status: "CHECKED_IN",
    syncStatus: joined ? toText(joined.sync_status) || "PENDING" : "PENDING",
    parking: mapped ? mapped.parking : null,
    parkingSessionId: mapped ? mapped.parkingSessionId : "",
    ePassUrl: mapped ? mapped.ePassUrl : "",
  };
}

async function handleCheckIn(data, env, ctx, cors) {
  const validation = validateCheckInPayload(data);
  if (!validation.ok) {
    return jsonResp({ success: false, message: validation.message }, 200, cors);
  }

  const value = validation.value;
  let clientTxnId = cleanInput(data.clientTxnId, 100);
  if (!clientTxnId) clientTxnId = crypto.randomUUID();

  const duplicate = await dbFirst(
    env,
    `SELECT id FROM entries WHERE client_txn_id = ? LIMIT 1`,
    clientTxnId
  );

  if (duplicate && duplicate.id) {
    return jsonResp(await checkInSuccessPayload(env, duplicate.id, true), 200, cors);
  }

  const regNorm = normKey(value.regnum);
  const idNorm = normKey(value.mykadPassport);
  const passNorm = normKey(value.visitorPassNumber);
  const unitNorm = normKey(value.unitNumber);

  const activeVisitor = await dbFirst(
    env,
    `SELECT id, name_passport, regnum, contact, visitor_pass_number,
            unit_number, check_in_time, created_at
       FROM entries
      WHERE id_norm = ?
        AND visit_status = 'CHECKED_IN'
        AND (check_out_time IS NULL OR check_out_time = '')
      ORDER BY created_at DESC
      LIMIT 1`,
    idNorm
  );

  if (activeVisitor && activeVisitor.id) {
    return jsonResp(
      {
        success: false,
        code: "VISITOR_ALREADY_CHECKED_IN",
        message: "This visitor already has an active check-in record. Please check out the previous record before registering again.",
        activeRecord: {
          recordId: activeVisitor.id,
          namePassport: activeVisitor.name_passport || "",
          regnum: activeVisitor.regnum || "",
          contact: activeVisitor.contact || "",
          visitorPassNumber: activeVisitor.visitor_pass_number || "",
          unitNumber: activeVisitor.unit_number || "",
          checkInTime: formatMalaysiaDateTime(activeVisitor.check_in_time || activeVisitor.created_at),
          status: "CHECKED_IN",
        },
      },
      200,
      cors
    );
  }

  const activePass = await dbFirst(
    env,
    `SELECT id, name_passport, regnum, unit_number
       FROM entries
      WHERE pass_norm = ?
        AND visit_status = 'CHECKED_IN'
        AND (check_out_time IS NULL OR check_out_time = '')
      ORDER BY created_at DESC
      LIMIT 1`,
    passNorm
  );

  if (activePass && activePass.id) {
    return jsonResp(
      {
        success: false,
        code: "VISITOR_PASS_ALREADY_ACTIVE",
        message: `Visitor Pass ${value.visitorPassNumber} is still assigned to an active visitor. Please check out the current visitor first.`,
        activeRecord: {
          recordId: activePass.id,
          namePassport: activePass.name_passport || "",
          regnum: activePass.regnum || "",
          unitNumber: activePass.unit_number || "",
        },
      },
      200,
      cors
    );
  }

  const activeVehicle = await dbFirst(
    env,
    `SELECT id, name_passport, visitor_pass_number, unit_number, check_in_time, created_at
       FROM entries
      WHERE reg_norm = ?
        AND visit_status = 'CHECKED_IN'
        AND (check_out_time IS NULL OR check_out_time = '')
      ORDER BY created_at DESC
      LIMIT 1`,
    regNorm
  );

  if (activeVehicle && activeVehicle.id) {
    return jsonResp(
      {
        success: false,
        code: "VEHICLE_ALREADY_CHECKED_IN",
        message: `Vehicle ${value.regnum} already has an active check-in record. Please check out the vehicle first.`,
        activeRecord: {
          recordId: activeVehicle.id,
          namePassport: activeVehicle.name_passport || "",
          regnum: value.regnum,
          visitorPassNumber: activeVehicle.visitor_pass_number || "",
          unitNumber: activeVehicle.unit_number || "",
          checkInTime: formatMalaysiaDateTime(activeVehicle.check_in_time || activeVehicle.created_at),
          status: "CHECKED_IN",
        },
      },
      200,
      cors
    );
  }

  const imageUrl = toText(data.imageUrl);
  if (!imageUrl) {
    const hasProof = await hasExistingPhotoProof(env, regNorm, idNorm);
    if (!hasProof) {
      return jsonResp(
        {
          success: false,
          message: "ID photo is required because no active previous photo was found.",
        },
        200,
        cors
      );
    }
  } else if (!imageUrl.startsWith("data:image/")) {
    return jsonResp({ success: false, message: "Invalid imageUrl." }, 200, cors);
  }

  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const deviceId = cleanInput(data.deviceId, 100);

  let imageKey = null;
  let shaHex = null;
  let uploadedToR2 = false;
  let entryInserted = false;

  try {
    if (imageUrl) {
      if (!env.BUCKET) throw new Error("R2 BUCKET binding is missing");

      const { contentType, bytes } = dataUrlToBytes(imageUrl);
      const shaBuffer = await crypto.subtle.digest("SHA-256", bytes);
      shaHex = bufferToHex(shaBuffer);

      const prefix = r2Prefix(env);
      imageKey = `${prefix}/${utcYmd(new Date())}/${id}.jpg`;

      await env.BUCKET.put(imageKey, bytes, {
        httpMetadata: { contentType },
        customMetadata: { id, clientTxnId, sha256: shaHex },
      });
      uploadedToR2 = true;
    }

    try {
      await dbRun(
        env,
        `INSERT INTO entries (
          id, created_at, client_txn_id, device_id, check_out_device_id,
          name_passport, mykad_passport, regnum, contact,
          visitor_pass_number, unit_number,
          reg_norm, id_norm, pass_norm, unit_norm,
          check_in_time, check_out_time, visit_status,
          image_key, image_sha256,
          drive_file_id, drive_url,
          sync_status, sync_attempts, sync_error, sync_version,
          parking_session_id, parking_interval_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, nowIso, clientTxnId, deviceId, null,
        value.namePassport, value.mykadPassport, value.regnum, value.contact,
        value.visitorPassNumber, value.unitNumber,
        regNorm, idNorm, passNorm, unitNorm,
        nowIso, null, "CHECKED_IN",
        imageKey, shaHex,
        null, null,
        "PENDING", 0, "", 1,
        null, null
      );
      entryInserted = true;
    } catch (dbError) {
      const message = dbError && dbError.message ? String(dbError.message) : String(dbError);

      if (/UNIQUE constraint failed: entries\.client_txn_id/i.test(message)) {
        const existing = await dbFirst(env, `SELECT id FROM entries WHERE client_txn_id = ? LIMIT 1`, clientTxnId);
        if (existing && existing.id) {
          if (uploadedToR2 && imageKey) {
            try { await env.BUCKET.delete(imageKey); } catch (_) {}
          }
          return jsonResp(await checkInSuccessPayload(env, existing.id, true), 200, cors);
        }
      }

      if (/UNIQUE constraint failed: entries\.id_norm/i.test(message)) {
        throw appError("VISITOR_ALREADY_CHECKED_IN", "This visitor already has an active check-in record. Please check out the previous record before registering again.");
      }

      if (/UNIQUE constraint failed: entries\.pass_norm/i.test(message)) {
        throw appError("VISITOR_PASS_ALREADY_ACTIVE", `Visitor Pass ${value.visitorPassNumber} is still assigned to an active visitor. Please check out the current visitor first.`);
      }

      if (/UNIQUE constraint failed: entries\.reg_norm/i.test(message)) {
        throw appError("VEHICLE_ALREADY_CHECKED_IN", `Vehicle ${value.regnum} already has an active check-in record. Please check out the vehicle first.`);
      }

      throw dbError;
    }

    const entry = await loadRecordById(env, id);
    await attachParkingSessionForCheckIn(env, entry, nowIso);
  } catch (error) {
    if (entryInserted) {
      try { await dbRun(env, `DELETE FROM entries WHERE id = ?`, id); } catch (_) {}
    }
    if (uploadedToR2 && imageKey && env.BUCKET) {
      try { await env.BUCKET.delete(imageKey); } catch (_) {}
    }

    if (error && error.code) {
      return jsonResp(
        {
          success: false,
          code: error.code,
          message: error.message,
          details: error.details || null,
        },
        200,
        cors
      );
    }
    throw error;
  }

  ctx.waitUntil(syncToGoogle(env, id));
  ctx.waitUntil(cleanupOld(env, ctx));

  return jsonResp(await checkInSuccessPayload(env, id, false), 200, cors);
}

async function handleCheckOut(data, env, ctx, cors) {
  const recordId = cleanInput(data.recordId, 100);
  const visitorPassNumber = cleanUpper(data.visitorPassNumber, 20)
    .replace(/[^A-Z0-9-]/g, "");
  const requestedPassNorm = normKey(visitorPassNumber);

  if (!recordId) {
    return jsonResp({ success: false, message: "Record ID is required for check out." }, 200, cors);
  }

  let current = await loadRecordById(env, recordId);
  if (!current) {
    return jsonResp({ success: false, message: "Visitor record was not found." }, 200, cors);
  }

  if (requestedPassNorm && requestedPassNorm !== toText(current.pass_norm)) {
    return jsonResp(
      { success: false, message: "Visitor Pass Number does not match the selected record." },
      200,
      cors
    );
  }

  if (!isCheckedInStatus(current.visit_status) || toText(current.check_out_time)) {
    const joinedDuplicate = await loadRecordWithParkingById(env, recordId);
    const mappedDuplicate = joinedDuplicate ? await mapSearchRecord(joinedDuplicate, env) : null;
    return jsonResp(
      {
        success: true,
        duplicate: true,
        id: recordId,
        recordId,
        visitorPassNumber: toText(current.visitor_pass_number),
        checkInTime: formatMalaysiaDateTime(current.check_in_time || current.created_at),
        checkOutTime: formatMalaysiaDateTime(current.check_out_time),
        status: "CHECKED_OUT",
        syncStatus: toText(current.sync_status) || "PENDING",
        parking: mappedDuplicate ? mappedDuplicate.parking : null,
        ePassUrl: mappedDuplicate ? mappedDuplicate.ePassUrl : "",
      },
      200,
      cors
    );
  }

  await ensureParkingForActiveEntry(env, current);
  current = await loadRecordById(env, recordId);

  const checkOutTime = new Date().toISOString();
  const checkOutDeviceId = cleanInput(data.deviceId, 100);

  const updateResult = await dbRun(
    env,
    `UPDATE entries
        SET check_out_time = ?,
            check_out_device_id = ?,
            visit_status = 'CHECKED_OUT',
            sync_status = 'PENDING',
            sync_attempts = 0,
            sync_error = '',
            sync_version = COALESCE(sync_version, 1) + 1
      WHERE id = ?
        AND visit_status = 'CHECKED_IN'
        AND (check_out_time IS NULL OR check_out_time = '')`,
    checkOutTime,
    checkOutDeviceId,
    recordId
  );

  if (getChangeCount(updateResult) < 1) {
    current = await loadRecordById(env, recordId);
    return jsonResp(
      {
        success: false,
        message: "This visitor record has already been checked out.",
        checkOutTime: formatMalaysiaDateTime(current && current.check_out_time),
      },
      200,
      cors
    );
  }

  await finalizeParkingForEntry(env, current, checkOutTime);
  ctx.waitUntil(syncToGoogle(env, recordId));

  const joined = await loadRecordWithParkingById(env, recordId);
  const mapped = joined ? await mapSearchRecord(joined, env) : null;

  return jsonResp(
    {
      success: true,
      id: recordId,
      recordId,
      visitorPassNumber: toText(current.visitor_pass_number),
      checkInTime: formatMalaysiaDateTime(current.check_in_time || current.created_at),
      checkOutTime: formatMalaysiaDateTime(checkOutTime),
      status: "CHECKED_OUT",
      syncStatus: "PENDING",
      parking: mapped ? mapped.parking : null,
      parkingSessionId: mapped ? mapped.parkingSessionId : "",
      ePassUrl: mapped ? mapped.ePassUrl : "",
    },
    200,
    cors
  );
}

/** =========================
 * Retention cleanup
 * ========================= */
async function cleanupOld(env, ctx) {
  if (!env.DB) return;

  const cutoffIso = new Date(
    Date.now() - retentionDays(env) * 86400000
  ).toISOString();

  const limit = clampInt(env.CLEANUP_BATCH, 200, 50, 500);
  const maxBatches = clampInt(env.CLEANUP_MAX_BATCHES, 10, 1, 20);

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
    const batch = await dbAll(
      env,
      `SELECT id, image_key, drive_file_id
         FROM entries
        WHERE created_at < ?
          AND visit_status = 'CHECKED_OUT'
        ORDER BY created_at ASC
        LIMIT ${limit}`,
      cutoffIso
    );

    const rows = batch && Array.isArray(batch.results) ? batch.results : [];
    if (!rows.length) break;

    const ids = rows.map((row) => row.id);
    const r2Keys = rows.map((row) => toText(row.image_key)).filter(Boolean);
    const driveIds = rows.map((row) => toText(row.drive_file_id)).filter(Boolean);

    const placeholders = ids.map(() => "?").join(",");
    await dbRun(env, `DELETE FROM entries WHERE id IN (${placeholders})`, ...ids);

    if (env.BUCKET) {
      for (const key of r2Keys) {
        try { await env.BUCKET.delete(key); } catch (_) {}
      }
    }

    if (driveIds.length && env.GAS_SYNC_URL && env.SYNC_TOKEN) {
      const deleteUrl = env.GAS_DELETE_URL || env.GAS_SYNC_URL;
      const chunkSize = 50;

      for (let index = 0; index < driveIds.length; index += chunkSize) {
        const fileIds = driveIds.slice(index, index + chunkSize);
        ctx.waitUntil(
          fetch(deleteUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: env.SYNC_TOKEN,
              action: "DELETE_DRIVE",
              fileIds,
            }),
          }).catch(() => {})
        );
      }
    }
  }

  const oldSessions = await dbAll(
    env,
    `SELECT id
       FROM parking_sessions
      WHERE status IN ('ENDED', 'REVOKED')
        AND COALESCE(ended_at, revoked_at, updated_at) < ?
      ORDER BY updated_at ASC
      LIMIT ${limit}`,
    cutoffIso
  );

  const sessions = oldSessions && Array.isArray(oldSessions.results)
    ? oldSessions.results
    : [];

  if (sessions.length) {
    const sessionIds = sessions.map((row) => row.id);
    const placeholders = sessionIds.map(() => "?").join(",");
    await dbRun(env, `DELETE FROM parking_intervals WHERE session_id IN (${placeholders})`, ...sessionIds);
    await dbRun(env, `DELETE FROM parking_sessions WHERE id IN (${placeholders})`, ...sessionIds);
  }
}

/** =========================
 * Worker entry point
 * ========================= */
export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      return jsonResp(
        {
          ok: true,
          service: "secure-entry-visitor",
          schemaVersion: 3,
          overnightParking: true,
          ePassConfigured: !!(publicBaseUrl(env) && ePassSecret(env)),
          parkingPolicy: {
            freeSeconds: parkingFreeSeconds(env),
            resetSeconds: parkingResetSeconds(env),
            blockSeconds: parkingBlockSeconds(env),
            blockFee: formatRinggit(parkingBlockFeeCents(env)),
          },
        },
        200,
        cors,
        { "Cache-Control": "no-store" }
      );
    }

    // Public signed E-Visitor Pass page.
    if (request.method === "GET" && path === "/e-pass") {
      const session = await authorizedEPassSession(url, env);
      if (!session) {
        return new Response(ePassExpiredHtml("ENDED"), {
          status: 404,
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      if (["ENDED", "REVOKED"].includes(toUpper(session.status))) {
        return new Response(ePassExpiredHtml(session.status), {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "Cache-Control": "no-store",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
          },
        });
      }

      const snapshot = computeParkingSnapshot(sessionRowForSnapshot(session), env);
      return new Response(ePassHtml(env, session, snapshot), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
          "Cache-Control": "no-store",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      });
    }

    // JSON endpoint used by the E-Pass/front-end for server-authoritative timing.
    if (request.method === "GET" && path === "/api/e-pass") {
      const session = await authorizedEPassSession(url, env);
      if (!session) {
        return jsonResp({ success: false, code: "EPASS_NOT_FOUND" }, 404, cors, {
          "Cache-Control": "no-store",
        });
      }

      if (["ENDED", "REVOKED"].includes(toUpper(session.status))) {
        return jsonResp(
          {
            success: false,
            code: toUpper(session.status) === "REVOKED" ? "EPASS_REVOKED" : "EPASS_EXPIRED",
            status: session.status,
          },
          200,
          cors,
          { "Cache-Control": "no-store" }
        );
      }

      const parking = computeParkingSnapshot(sessionRowForSnapshot(session), env);
      return jsonResp(
        {
          success: true,
          pass: {
            vehicleRegNumber: session.regnum,
            visitorPassNumber: session.last_visitor_pass_number,
            unitNumber: session.last_unit_number,
            status: parking.statusLabel,
            parking,
          },
        },
        200,
        cors,
        { "Cache-Control": "no-store" }
      );
    }

    // Protected R2 image endpoint for Apps Script.
    if (request.method === "GET" && path === "/image") {
      const id = cleanInput(url.searchParams.get("id"), 100);
      const token = toText(url.searchParams.get("token"));

      if (!id || !env.IMAGE_VIEW_TOKEN || token !== env.IMAGE_VIEW_TOKEN) {
        return textResp("Unauthorized", 401, cors);
      }

      const row = await dbFirst(
        env,
        `SELECT image_key FROM entries WHERE id = ? LIMIT 1`,
        id
      );

      if (!row || !row.image_key || !env.BUCKET) {
        return textResp("Not found", 404, cors);
      }

      const object = await env.BUCKET.get(row.image_key);
      if (!object) return textResp("Not found", 404, cors);

      return new Response(object.body, {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "private, max-age=60",
        },
      });
    }

    // Safe manual retry for records on/after SYNC_RETRY_START_AT.
    if (request.method === "GET" && path === "/admin/retry-sync") {
      const token = toText(url.searchParams.get("token"));
      const expected = toText(env.RETRY_TOKEN || env.SYNC_TOKEN);

      if (!expected || token !== expected) {
        return textResp("Unauthorized", 401, cors);
      }

      const result = await retryPendingSync(
        env,
        ctx,
        url.searchParams.get("limit") || ""
      );

      return jsonResp(result, result.ok ? 200 : 400, cors, {
        "Cache-Control": "no-store",
      });
    }

    // D1 search. No edge cache: Unit/Pass status must be current after check-out.
    if (request.method === "GET" && (path === "/" || path === "/search")) {
      const field = cleanInput(url.searchParams.get("field"), 40);
      const value = cleanInput(url.searchParams.get("value"), 100);

      if (!value) {
        return jsonResp({ exist: false }, 200, cors, {
          "Cache-Control": "no-store",
        });
      }

      if (!env.DB) {
        return jsonResp(
          { success: false, message: "DB binding is missing." },
          500,
          cors,
          { "Cache-Control": "no-store" }
        );
      }

      const result = await d1Search(env, field, value);
      return jsonResp(result, 200, cors, { "Cache-Control": "no-store" });
    }

    // CHECK IN / CHECK OUT. Also accepts POST /submit for compatibility.
    if (request.method === "POST" && (path === "/" || path === "/submit")) {
      try {
        if (!env.DB) throw new Error("DB binding is missing");

        const data = await request.json();
        const action = normKey(data.action || "CHECK_IN");

        if (action === "CHECKOUT") {
          return await handleCheckOut(data, env, ctx, cors);
        }

        if (action === "CHECKIN" || action === "SUBMIT" || !action) {
          return await handleCheckIn(data, env, ctx, cors);
        }

        return jsonResp(
          { success: false, message: "Unsupported action." },
          200,
          cors
        );
      } catch (error) {
        return jsonResp(
          {
            success: false,
            message: error && error.message ? error.message : String(error),
          },
          500,
          cors,
          { "Cache-Control": "no-store" }
        );
      }
    }

    return textResp("Not found", 404, cors);
  },

  async scheduled(event, env, ctx) {
    if (!env.DB) return;

    ctx.waitUntil(expirePausedParkingSessions(env).catch(() => {}));
    ctx.waitUntil(retryPendingSync(env, ctx).catch(() => {}));
    ctx.waitUntil(cleanupOld(env, ctx).catch(() => {}));
  },
};
