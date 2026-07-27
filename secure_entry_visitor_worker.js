// ==================================================
// SECURE ENTRY VISITOR - CLOUDFLARE WORKER
// Fast Check In + D1 Search + Check Out + R2 + GAS Sync + Retention
//
// Frontend contract:
// - POST action=CHECK_IN
// - POST action=CHECK_OUT (recordId required)
// - GET field=REGNUM | MYKADPASSPORT | UNITNUMBER | VISITORPASS
// ==================================================

const SEARCH_LIST_LIMIT = 10;
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
 * Record mapping
 * ========================= */
function mapSearchRecord(row) {
  const photoLink = toText(row.photo_link || row.drive_url);
  const checkInRaw = toText(row.check_in_time || row.created_at);
  const checkOutRaw = toText(row.check_out_time);

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
  };
}

const FULL_RECORD_SELECT = `
  SELECT id, created_at, client_txn_id, device_id, check_out_device_id,
         name_passport, mykad_passport, regnum, contact,
         visitor_pass_number, unit_number,
         reg_norm, id_norm, pass_norm, unit_norm,
         check_in_time, check_out_time, visit_status,
         image_key, image_sha256, drive_file_id, drive_url,
         sync_status, sync_attempts, sync_error, sync_version
    FROM entries
`;

async function loadRecordById(env, recordId) {
  return dbFirst(
    env,
    `${FULL_RECORD_SELECT} WHERE id = ? LIMIT 1`,
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
  const row = await dbFirst(
    env,
    `${FULL_RECORD_SELECT}
      WHERE ${column} = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    normalizedValue
  );

  if (!row) return { exist: false };

  const proof = await findLatestPhotoProof(env, column, normalizedValue);
  const photoLink = toText(proof && proof.drive_url);

  if (!photoLink) {
    return {
      exist: true,
      hasHyperlink: false,
      data: {},
    };
  }

  const data = mapSearchRecord({ ...row, photo_link: photoLink });
  return {
    exist: true,
    hasHyperlink: true,
    data,
  };
}

const LIST_SEARCH_SELECT = `
  SELECT e.id, e.created_at,
         e.name_passport, e.mykad_passport, e.regnum, e.contact,
         e.visitor_pass_number, e.unit_number,
         e.check_in_time, e.check_out_time, e.visit_status,
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
  const records = rows.map(mapSearchRecord);

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
  const records = rows.map(mapSearchRecord);

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
    `SELECT id, sync_status AS syncStatus
       FROM entries
      WHERE client_txn_id = ?
      LIMIT 1`,
    clientTxnId
  );

  if (duplicate && duplicate.id) {
    return jsonResp(
      {
        success: true,
        id: duplicate.id,
        duplicate: true,
        syncStatus: duplicate.syncStatus || "PENDING",
      },
      200,
      cors
    );
  }

  const regNorm = normKey(value.regnum);
  const idNorm = normKey(value.mykadPassport);
  const passNorm = normKey(value.visitorPassNumber);
  const unitNorm = normKey(value.unitNumber);

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

  try {
    if (imageUrl) {
      if (!env.BUCKET) throw new Error("R2 BUCKET binding is missing");

      const { contentType, bytes } = dataUrlToBytes(imageUrl);
      const shaBuffer = await crypto.subtle.digest("SHA-256", bytes);
      shaHex = bufferToHex(shaBuffer);

      const prefix = cleanInput(env.R2_PREFIX, 80) || "visitor";
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
          sync_status, sync_attempts, sync_error, sync_version
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, nowIso, clientTxnId, deviceId, null,
        value.namePassport, value.mykadPassport, value.regnum, value.contact,
        value.visitorPassNumber, value.unitNumber,
        regNorm, idNorm, passNorm, unitNorm,
        nowIso, null, "CHECKED_IN",
        imageKey, shaHex,
        null, null,
        "PENDING", 0, "", 1
      );
    } catch (dbError) {
      const message = dbError && dbError.message ? String(dbError.message) : String(dbError);
      if (/UNIQUE constraint failed: entries\.client_txn_id/i.test(message)) {
        const existing = await dbFirst(
          env,
          `SELECT id, sync_status AS syncStatus
             FROM entries
            WHERE client_txn_id = ?
            LIMIT 1`,
          clientTxnId
        );

        if (existing && existing.id) {
          if (uploadedToR2 && imageKey) {
            try { await env.BUCKET.delete(imageKey); } catch (_) {}
          }

          return jsonResp(
            {
              success: true,
              id: existing.id,
              duplicate: true,
              syncStatus: existing.syncStatus || "PENDING",
            },
            200,
            cors
          );
        }
      }

      // Database-level protection for two simultaneous check-ins attempting
      // to use the same active Visitor Pass Number.
      if (/UNIQUE constraint failed: entries\.pass_norm/i.test(message)) {
        if (uploadedToR2 && imageKey) {
          try { await env.BUCKET.delete(imageKey); } catch (_) {}
        }

        return jsonResp(
          {
            success: false,
            message: `Visitor Pass ${value.visitorPassNumber} is still assigned to an active visitor. Please check out the current visitor first.`,
          },
          200,
          cors
        );
      }

      throw dbError;
    }
  } catch (error) {
    if (uploadedToR2 && imageKey && env.BUCKET) {
      try { await env.BUCKET.delete(imageKey); } catch (_) {}
    }
    throw error;
  }

  ctx.waitUntil(syncToGoogle(env, id));
  ctx.waitUntil(cleanupOld(env, ctx));

  return jsonResp(
    {
      success: true,
      id,
      createdAt: nowIso,
      checkInTime: formatMalaysiaDateTime(nowIso),
      status: "CHECKED_IN",
      syncStatus: "PENDING",
    },
    200,
    cors
  );
}

async function handleCheckOut(data, env, ctx, cors) {
  const recordId = cleanInput(data.recordId, 100);
  const visitorPassNumber = cleanUpper(data.visitorPassNumber, 20)
    .replace(/[^A-Z0-9-]/g, "");
  const requestedPassNorm = normKey(visitorPassNumber);

  if (!recordId) {
    return jsonResp({ success: false, message: "Record ID is required for check out." }, 200, cors);
  }

  const current = await loadRecordById(env, recordId);
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
    return jsonResp(
      { success: false, message: "This visitor record has already been checked out." },
      200,
      cors
    );
  }

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
    return jsonResp(
      { success: false, message: "This visitor record has already been checked out." },
      200,
      cors
    );
  }

  ctx.waitUntil(syncToGoogle(env, recordId));

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
        ORDER BY created_at ASC
        LIMIT ${limit}`,
      cutoffIso
    );

    const rows = batch && Array.isArray(batch.results) ? batch.results : [];
    if (!rows.length) return;

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
          schemaVersion: 1,
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

    ctx.waitUntil(retryPendingSync(env, ctx).catch(() => {}));
    ctx.waitUntil(cleanupOld(env, ctx).catch(() => {}));
  },
};
