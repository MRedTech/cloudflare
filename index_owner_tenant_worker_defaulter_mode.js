// ==================================================
// SECURE ENTRY OWNER | TENANT - CLOUDFLARE WORKER
// Sensory Residence
//
// Purpose:
// - Fast registration submit -> D1 + optional R2 image -> immediate ACK
// - Background sync to Google Apps Script / Google Sheet / Google Drive
// - Fast D1 search by MYKAD/PASSPORT or REG.NUM
// - Unit Number search returns OWNER DETAILS only from unit_owners
// - 90-day registration retention + retry sync
//
// Frontend contract:
// - GET  / or /search?field=UNITNUMBER|REGNUM|MYKADPASSPORT&value=...
// - POST / or /submit
//
// Registration payload fields:
//   mode              // NORMAL (default) | DEFAULTER
//   namePassport      // NORMAL only; forced blank in DEFAULTER mode
//   mykadPassport     // NORMAL only; forced blank in DEFAULTER mode
//   regnum
//   contact
//   unitNumber
//   category          // OWNER | TENANT
//   reason            // NORMAL selection; forced to DEFAULTER in DEFAULTER mode
//   reasonOther       // NORMAL only
//   tower             // Worker verifies/derives from Unit Number
//   imageUrl          // NORMAL only; ignored in DEFAULTER mode
//
// IMPORTANT:
// - No Visitor Pass / Check In / Check Out / Parking / E-Pass functions here.
// - Owner directory is stored separately in D1 table: unit_owners.
// ==================================================

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

/** =========================
 * Input / normalization helpers
 * ========================= */
function toText(value) {
  return value == null ? "" : String(value).trim();
}

function toUpper(value) {
  return toText(value).toUpperCase();
}

function cleanInput(value, maxLength = 160) {
  return toText(value).slice(0, maxLength);
}

function cleanUpper(value, maxLength = 160) {
  return cleanInput(value, maxLength).toUpperCase();
}

function normKey(value) {
  return toUpper(value).replace(/[^A-Z0-9]/g, "");
}

function contactDigits(value) {
  return toText(value).replace(/[^0-9]/g, "").slice(0, 15);
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(toText(value));
}

function normalizeCategory(value) {
  const raw = cleanUpper(value, 80);
  if (/^OWNER\b/.test(raw)) return "OWNER";
  if (/^TENANT\b/.test(raw)) return "TENANT";
  return raw;
}

function towerFromUnitNumber(value) {
  const unit = cleanUpper(value, 40);
  const first = normKey(unit).charAt(0);
  if (first === "A") return "TOWER A";
  if (first === "B") return "TOWER B";
  return "";
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

/** =========================
 * Environment / config helpers
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

function r2Prefix(env) {
  const prefix = cleanInput(env.R2_PREFIX || "owner-tenant-sensory", 80)
    .replace(/\\/g, "/")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9/_-]/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");

  return prefix || "owner-tenant-sensory";
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
 * Drive link helpers
 * ========================= */
function extractDriveFileId(url) {
  const value = toText(url);
  if (!value) return "";

  try {
    const parsed = new URL(value);
    const id = parsed.searchParams.get("id");
    if (id) return id;
  } catch (_) {}

  const fileMatch = value.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (fileMatch) return fileMatch[1];

  const idMatch = value.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return idMatch ? idMatch[1] : "";
}

/** =========================
 * Registration record loading
 * ========================= */
const FULL_RECORD_SELECT = `
  SELECT id, created_at, client_txn_id, device_id,
         name_passport, mykad_passport, regnum, contact,
         unit_number, category, reason, reason_other, tower,
         reg_norm, id_norm, unit_norm,
         image_key, image_sha256,
         drive_file_id, drive_url,
         sync_status, sync_attempts, sync_error
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
 * Google Apps Script sync
 * ========================= */
async function markSyncFailed(env, recordId, error) {
  try {
    await dbRun(
      env,
      `UPDATE entries
          SET sync_status = 'FAILED',
              sync_error = ?
        WHERE id = ?`,
      cleanSyncError(error),
      recordId
    );
  } catch (_) {}
}

async function syncToGoogle(env, recordId) {
  if (!recordId) return;

  if (!env.GAS_SYNC_URL) {
    await markSyncFailed(env, recordId, "GAS_SYNC_URL is missing");
    return;
  }

  if (!env.SYNC_TOKEN) {
    await markSyncFailed(env, recordId, "SYNC_TOKEN is missing");
    return;
  }

  const tries = syncTriesPerRun(env);
  const baseDelay = syncRetryDelayMs(env);
  let lastError = null;

  for (let attempt = 1; attempt <= tries; attempt++) {
    const record = await loadRecordById(env, recordId);
    if (!record) return;

    const baseUrl = toText(env.PUBLIC_BASE_URL).replace(/\/$/, "");
    const imageViewUrl =
      record.image_key &&
      !toText(record.drive_url) &&
      baseUrl &&
      env.IMAGE_VIEW_TOKEN
        ? `${baseUrl}/image?id=${encodeURIComponent(record.id)}&token=${encodeURIComponent(env.IMAGE_VIEW_TOKEN)}`
        : "";

    const payload = {
      token: env.SYNC_TOKEN,
      action: "SYNC",

      id: record.id,
      createdAt: record.created_at,
      clientTxnId: record.client_txn_id,
      deviceId: record.device_id,

      // Keep the same clean field structure from Frontend -> Worker -> GAS.
      namePassport: record.name_passport,
      mykadPassport: record.mykad_passport,
      regnum: record.regnum,
      contact: record.contact,
      unitNumber: record.unit_number,
      category: record.category,
      reason: record.reason,
      reasonOther: record.reason_other,
      tower: record.tower,

      // GAS uploads to Drive only when this URL is provided.
      imageViewUrl,
    };

    try {
      try {
        await dbRun(
          env,
          `UPDATE entries
              SET sync_attempts = COALESCE(sync_attempts, 0) + 1
            WHERE id = ?`,
          record.id
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

      await dbRun(
        env,
        `UPDATE entries
            SET sync_status = 'DONE',
                sync_error = '',
                drive_file_id = COALESCE(NULLIF(?, ''), drive_file_id),
                drive_url = COALESCE(NULLIF(?, ''), drive_url)
          WHERE id = ?`,
        driveFileId,
        driveUrl,
        record.id
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < tries) await sleep(baseDelay * attempt);
    }
  }

  await markSyncFailed(env, recordId, lastError);
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

  const result = await dbAll(
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

  const rows = result && Array.isArray(result.results) ? result.results : [];
  for (const row of rows) {
    ctx.waitUntil(syncToGoogle(env, row.id));
  }

  return {
    ok: true,
    queued: rows.length,
    startAt,
    maxAttempts,
    limit,
  };
}

/** =========================
 * Owner directory / Unit Number search
 * - Returns OWNER DETAILS only.
 * - It does NOT return registration history / visitor lists.
 * ========================= */
async function loadUnitOwnerDetails(env, unitNorm, fallbackUnitNumber = "") {
  try {
    const result = await dbAll(
      env,
      `SELECT id, unit_number, unit_norm, owner_name, owner_order
         FROM unit_owners
        WHERE unit_norm = ?
          AND is_active = 1
        ORDER BY owner_order ASC, id ASC`,
      unitNorm
    );

    const rows = result && Array.isArray(result.results) ? result.results : [];
    const owners = rows
      .map((row, index) => ({
        name: cleanUpper(row.owner_name, 160),
        order: Math.max(1, Math.floor(Number(row.owner_order) || (index + 1))),
      }))
      .filter((owner) => !!owner.name);

    return {
      available: true,
      unitFound: rows.length > 0,
      unitNumber: cleanUpper(
        (rows[0] && rows[0].unit_number) || fallbackUnitNumber,
        40
      ),
      ownerRecordCount: rows.length,
      ownerCount: owners.length,
      owners,
    };
  } catch (error) {
    const message = cleanSyncError(error);

    // Friendly response while the new owner directory table is being prepared.
    if (/no such table:\s*unit_owners/i.test(message)) {
      return {
        available: false,
        unitFound: false,
        unitNumber: cleanUpper(fallbackUnitNumber, 40),
        ownerRecordCount: 0,
        ownerCount: 0,
        owners: [],
      };
    }

    throw error;
  }
}

async function d1UnitOwnerSearch(env, value) {
  const unitNumber = cleanUpper(value, 40);
  const unitNorm = normKey(unitNumber);

  if (!unitNorm) {
    return {
      exist: false,
      ownerDetails: {
        available: true,
        unitFound: false,
        unitNumber: "",
        ownerRecordCount: 0,
        ownerCount: 0,
        owners: [],
      },
    };
  }

  const ownerDetails = await loadUnitOwnerDetails(env, unitNorm, unitNumber);

  return {
    exist: ownerDetails.unitFound,
    ownerDetails,
  };
}

/** =========================
 * Registration search by REG.NUM / MYKAD-PASSPORT
 * Response keeps the existing Secure Entry FOUND / EXPIRED contract.
 * ========================= */
async function findLatestPhotoProof(env, column, value) {
  // column is selected only from the fixed whitelist below.
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

  // DEFAULTER audit records intentionally have no MYKAD/PASSPORT.
  // Exclude them from REG.NUM autofill/search so a newer DEFAULTER audit
  // cannot replace the latest reusable NORMAL identity record.
  const normalIdentityFilter = isReg
    ? "AND COALESCE(TRIM(id_norm), '') <> ''"
    : "";

  const row = await dbFirst(
    env,
    `${FULL_RECORD_SELECT}
      WHERE ${column} = ?
        ${normalIdentityFilter}
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

  return {
    exist: true,
    hasHyperlink: true,
    data: {
      namePassport: toText(row.name_passport),
      mykadPassport: toText(row.mykad_passport),
      regnum: toText(row.regnum),
      contact: toText(row.contact),
      unitNumber: toText(row.unit_number),
      category: toText(row.category),

      // Reason is transaction-specific. Guard must select it again.
      reason: "",
      reasonOther: "",

      // Tower is deterministic from Unit Number; frontend will auto-detect too.
      tower: towerFromUnitNumber(row.unit_number),
      photoLink,
    },
  };
}

async function d1Search(env, field, value) {
  const normalizedField = normKey(field);

  if (normalizedField === "UNITNUMBER" || normalizedField === "UNIT") {
    return d1UnitOwnerSearch(env, value);
  }

  return d1PersonSearch(env, field, value);
}

/** =========================
 * OWNER | TENANT dashboard
 * - D1 is the source of truth.
 * - All selected dates are interpreted in Asia/Kuala_Lumpur (UTC+8).
 * - End Date is inclusive at 23:59:59 local time by using an exclusive
 *   UTC boundary at the next local midnight.
 * - Monthly trends are rolling 3 calendar months including the current
 *   Malaysia month and are NOT affected by the selected date filter.
 * ========================= */
const DASHBOARD_TIMEZONE = "Asia/Kuala_Lumpur";
const DASHBOARD_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

const CARD_ISSUE_REASONS = [
  "BLOCK CARD",
  "LOST CARD",
  "DAMAGED CARD",
  "INSUFFICIENT CARD",
  "CLONE CARD",
];

const DASHBOARD_MONTH_LABELS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

function parseDashboardYmd(value) {
  const raw = toText(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  return { raw, year, month, day };
}

function dashboardDateRangeToUtc(startValue, endValue) {
  const start = parseDashboardYmd(startValue);
  const end = parseDashboardYmd(endValue);

  if (!start || !end) {
    return {
      ok: false,
      message: "Start Date and End Date must use YYYY-MM-DD.",
    };
  }

  const startUtcMs =
    Date.UTC(start.year, start.month - 1, start.day) -
    DASHBOARD_UTC_OFFSET_MS;

  const endExclusiveUtcMs =
    Date.UTC(end.year, end.month - 1, end.day + 1) -
    DASHBOARD_UTC_OFFSET_MS;

  if (endExclusiveUtcMs <= startUtcMs) {
    return {
      ok: false,
      message: "End Date must be the same as or later than Start Date.",
    };
  }

  return {
    ok: true,
    startDate: start.raw,
    endDate: end.raw,
    startUtc: new Date(startUtcMs).toISOString(),
    endExclusiveUtc: new Date(endExclusiveUtcMs).toISOString(),
  };
}

function dashboardRollingThreeMonths(now = new Date()) {
  // Shift UTC by +8h first, then read UTC fields as Malaysia local fields.
  const malaysiaNow = new Date(now.getTime() + DASHBOARD_UTC_OFFSET_MS);
  const currentYear = malaysiaNow.getUTCFullYear();
  const currentMonthIndex = malaysiaNow.getUTCMonth();

  const months = [];

  for (let offset = -2; offset <= 0; offset++) {
    const marker = new Date(
      Date.UTC(currentYear, currentMonthIndex + offset, 1)
    );

    const year = marker.getUTCFullYear();
    const monthIndex = marker.getUTCMonth();
    const monthNumber = monthIndex + 1;

    months.push({
      key: `${year}-${String(monthNumber).padStart(2, "0")}`,
      label: DASHBOARD_MONTH_LABELS[monthIndex],
      year,
    });
  }

  const first = months[0];
  const firstMonthIndex = Number(first.key.slice(5, 7)) - 1;

  const startUtcMs =
    Date.UTC(first.year, firstMonthIndex, 1) -
    DASHBOARD_UTC_OFFSET_MS;

  const nextMonthMarker = new Date(
    Date.UTC(currentYear, currentMonthIndex + 1, 1)
  );

  const endExclusiveUtcMs =
    Date.UTC(
      nextMonthMarker.getUTCFullYear(),
      nextMonthMarker.getUTCMonth(),
      1
    ) - DASHBOARD_UTC_OFFSET_MS;

  return {
    months,
    startUtc: new Date(startUtcMs).toISOString(),
    endExclusiveUtc: new Date(endExclusiveUtcMs).toISOString(),
  };
}

function dashboardPct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((Number(numerator) / Number(denominator)) * 100).toFixed(1));
}

function dashboardRows(result) {
  return result && Array.isArray(result.results) ? result.results : [];
}

async function loadOwnerTenantDashboard(env, startValue, endValue) {
  const range = dashboardDateRangeToUtc(startValue, endValue);
  if (!range.ok) return range;

  const rollingMonths = dashboardRollingThreeMonths();

  const whereSql = `created_at >= ? AND created_at < ?`;
  const params = [range.startUtc, range.endExclusiveUtc];
  const monthlyParams = [
    rollingMonths.startUtc,
    rollingMonths.endExclusiveUtc,
  ];

  const [
    totalRow,
    hourlyResult,
    reasonResult,
    towerReasonResult,
    defaulterUnitResult,
    monthlyReasonResult,
    monthlyTowerResult,
  ] = await Promise.all([
    dbFirst(
      env,
      `SELECT COUNT(*) AS total
         FROM entries
        WHERE ${whereSql}`,
      ...params
    ),

    dbAll(
      env,
      `SELECT strftime('%H', datetime(created_at, '+8 hours')) AS hour,
              COUNT(*) AS count
         FROM entries
        WHERE ${whereSql}
        GROUP BY hour
        ORDER BY hour ASC`,
      ...params
    ),

    dbAll(
      env,
      `SELECT UPPER(TRIM(reason)) AS reason,
              COUNT(*) AS count
         FROM entries
        WHERE ${whereSql}
        GROUP BY UPPER(TRIM(reason))`,
      ...params
    ),

    dbAll(
      env,
      `SELECT UPPER(TRIM(reason)) AS reason,
              UPPER(TRIM(tower)) AS tower,
              COUNT(*) AS count
         FROM entries
        WHERE ${whereSql}
        GROUP BY UPPER(TRIM(reason)), UPPER(TRIM(tower))`,
      ...params
    ),

    dbAll(
      env,
      `SELECT unit_norm,
              MAX(UPPER(TRIM(unit_number))) AS unit_number,
              COUNT(*) AS count
         FROM entries
        WHERE ${whereSql}
          AND UPPER(TRIM(reason)) = 'DEFAULTER'
          AND COALESCE(TRIM(unit_norm), '') <> ''
        GROUP BY unit_norm
        ORDER BY count DESC, unit_norm ASC
        LIMIT 10`,
      ...params
    ),

    // Rolling 3 months by reason. This is independent from Start/End filter.
    dbAll(
      env,
      `SELECT strftime('%Y-%m', datetime(created_at, '+8 hours')) AS month_key,
              UPPER(TRIM(reason)) AS reason,
              COUNT(*) AS count
         FROM entries
        WHERE created_at >= ?
          AND created_at < ?
        GROUP BY month_key, UPPER(TRIM(reason))
        ORDER BY month_key ASC`,
      ...monthlyParams
    ),

    // Rolling 3 months by tower. This is independent from Start/End filter.
    dbAll(
      env,
      `SELECT strftime('%Y-%m', datetime(created_at, '+8 hours')) AS month_key,
              UPPER(TRIM(tower)) AS tower,
              COUNT(*) AS count
         FROM entries
        WHERE created_at >= ?
          AND created_at < ?
        GROUP BY month_key, UPPER(TRIM(tower))
        ORDER BY month_key ASC`,
      ...monthlyParams
    ),
  ]);

  const totalRegistration = Math.max(0, Number(totalRow && totalRow.total) || 0);

  const hourlyMap = new Map();
  for (const row of dashboardRows(hourlyResult)) {
    const hour = String(row.hour || "").padStart(2, "0");
    if (/^\d{2}$/.test(hour)) {
      hourlyMap.set(hour, Math.max(0, Number(row.count) || 0));
    }
  }

  const hourlyRegistrationTrend = [];
  let peakHour = "";
  let peakHourCount = 0;

  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, "0");
    const count = hourlyMap.get(hh) || 0;
    const label = `${hh}00`;

    hourlyRegistrationTrend.push({ hour: label, count });

    // Strictly greater keeps the earliest hour when there is a tie.
    if (count > peakHourCount) {
      peakHour = label;
      peakHourCount = count;
    }
  }

  const reasonBreakdown = dashboardRows(reasonResult)
    .map((row) => ({
      reason: cleanUpper(row.reason || "UNSPECIFIED", 100) || "UNSPECIFIED",
      count: Math.max(0, Number(row.count) || 0),
    }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));

  const reasonCountMap = new Map(
    reasonBreakdown.map((item) => [item.reason, item.count])
  );

  const defaulterCount = reasonCountMap.get("DEFAULTER") || 0;

  const cardIssueAnalysis = CARD_ISSUE_REASONS
    .map((reason) => ({
      reason,
      count: reasonCountMap.get(reason) || 0,
    }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));

  const cardIssueCount = cardIssueAnalysis.reduce(
    (sum, item) => sum + item.count,
    0
  );

  // The three dashboard rate groups must cover 100% of registrations:
  // CARD ISSUE + DEFAULTER + OTHER ACCESS REASONS.
  // OTHER ACCESS REASONS is the remaining registrations after the first
  // two groups, matching the monthly grouping (e.g. FORGET CARD,
  // UNDER MANAGEMENT PROCESS and OTHER).
  const otherAccessReasonsCount = Math.max(
    0,
    totalRegistration - cardIssueCount - defaulterCount
  );

  const cardIssueRate = dashboardPct(cardIssueCount, totalRegistration);
  const defaulterRate = dashboardPct(defaulterCount, totalRegistration);

  // Use the residual percentage so the three displayed KPI rates add to
  // exactly 100.0% after one-decimal rounding.
  const otherAccessReasonsRate = totalRegistration > 0
    ? Number(Math.max(0, 100 - cardIssueRate - defaulterRate).toFixed(1))
    : 0;

  const reasonDistribution = reasonBreakdown.map((item) => ({
    reason: item.reason,
    count: item.count,
    percentage: dashboardPct(item.count, totalRegistration),
  }));

  const towerReasonMap = new Map();
  for (const row of dashboardRows(towerReasonResult)) {
    const reason = cleanUpper(row.reason || "UNSPECIFIED", 100) || "UNSPECIFIED";
    const tower = cleanUpper(row.tower, 40);
    const count = Math.max(0, Number(row.count) || 0);

    if (!towerReasonMap.has(reason)) {
      towerReasonMap.set(reason, { towerA: 0, towerB: 0 });
    }

    const target = towerReasonMap.get(reason);
    if (tower === "TOWER A") target.towerA += count;
    if (tower === "TOWER B") target.towerB += count;
  }

  const towerComparisonByReason = reasonBreakdown.map((item) => {
    const towerCounts = towerReasonMap.get(item.reason) || {
      towerA: 0,
      towerB: 0,
    };

    return {
      reason: item.reason,
      towerA: towerCounts.towerA,
      towerB: towerCounts.towerB,
      total: towerCounts.towerA + towerCounts.towerB,
    };
  });

  const defaulterAnalysis = dashboardRows(defaulterUnitResult).map((row) => ({
    unitNumber: cleanUpper(row.unit_number, 40),
    count: Math.max(0, Number(row.count) || 0),
  }));

  // --------------------------------------------------
  // MONTHLY REGISTRATION TREND BY REASON
  // Grouping is locked as:
  // - CARD ISSUE = BLOCK / LOST / DAMAGED / INSUFFICIENT / CLONE
  // - DEFAULTER = DEFAULTER
  // - OTHER ACCESS REASONS = every remaining reason, including
  //   FORGET CARD / UNDER MANAGEMENT PROCESS / OTHER.
  // Therefore the three groups always cover all registrations.
  // --------------------------------------------------
  const monthlyReasonMap = new Map(
    rollingMonths.months.map((month) => [
      month.key,
      {
        monthKey: month.key,
        month: month.label,
        year: month.year,
        cardIssue: 0,
        defaulter: 0,
        otherAccessReasons: 0,
        total: 0,
      },
    ])
  );

  for (const row of dashboardRows(monthlyReasonResult)) {
    const monthKey = toText(row.month_key);
    if (!monthlyReasonMap.has(monthKey)) continue;

    const reason = cleanUpper(row.reason || "UNSPECIFIED", 100) || "UNSPECIFIED";
    const count = Math.max(0, Number(row.count) || 0);
    const target = monthlyReasonMap.get(monthKey);

    if (reason === "DEFAULTER") {
      target.defaulter += count;
    } else if (CARD_ISSUE_REASONS.includes(reason)) {
      target.cardIssue += count;
    } else {
      target.otherAccessReasons += count;
    }

    target.total += count;
  }

  const monthlyTrendByReason = rollingMonths.months.map(
    (month) => monthlyReasonMap.get(month.key)
  );

  // --------------------------------------------------
  // MONTHLY REGISTRATION TREND BY TOWER
  // Tower A / Tower B only, matching registration validation.
  // --------------------------------------------------
  const monthlyTowerMap = new Map(
    rollingMonths.months.map((month) => [
      month.key,
      {
        monthKey: month.key,
        month: month.label,
        year: month.year,
        towerA: 0,
        towerB: 0,
        total: 0,
      },
    ])
  );

  for (const row of dashboardRows(monthlyTowerResult)) {
    const monthKey = toText(row.month_key);
    if (!monthlyTowerMap.has(monthKey)) continue;

    const tower = cleanUpper(row.tower, 40);
    const count = Math.max(0, Number(row.count) || 0);
    const target = monthlyTowerMap.get(monthKey);

    if (tower === "TOWER A") target.towerA += count;
    if (tower === "TOWER B") target.towerB += count;

    if (tower === "TOWER A" || tower === "TOWER B") {
      target.total += count;
    }
  }

  const monthlyTrendByTower = rollingMonths.months.map(
    (month) => monthlyTowerMap.get(month.key)
  );

  return {
    ok: true,
    dashboard: "OWNER_TENANT",
    timezone: DASHBOARD_TIMEZONE,
    generatedAt: new Date().toISOString(),

    filter: {
      startDate: range.startDate,
      endDate: range.endDate,
    },

    monthlyWindow: {
      mode: "ROLLING_3_MONTHS",
      startMonth: rollingMonths.months[0].key,
      endMonth: rollingMonths.months[rollingMonths.months.length - 1].key,
      months: rollingMonths.months,
    },

    kpi: {
      totalRegistration,
      peakHour: totalRegistration > 0 ? peakHour : "",
      peakHourCount: totalRegistration > 0 ? peakHourCount : 0,
      defaulterRate,
      defaulterCount,
      cardIssueRate,
      cardIssueCount,
      otherAccessReasonsRate,
      otherAccessReasonsCount,
    },

    charts: {
      hourlyRegistrationTrend,
      reasonBreakdown,
      towerComparisonByReason,
      reasonDistribution,
      defaulterAnalysis,
      cardIssueAnalysis,
      monthlyTrendByReason,
      monthlyTrendByTower,
    },
  };
}

/** =========================
 * Registration validation
 * ========================= */
function validateRegistrationPayload(data) {
  // Backward-compatible default: existing frontends that do not send mode
  // continue to use the original NORMAL validation flow.
  const mode = cleanUpper(data.mode, 20) === "DEFAULTER"
    ? "DEFAULTER"
    : "NORMAL";
  const isDefaulterMode = mode === "DEFAULTER";

  // DEFAULTER is an audit-only entry. Identity fields are deliberately
  // cleared even if stale values are accidentally submitted by the frontend.
  const namePassport = isDefaulterMode
    ? ""
    : cleanUpper(data.namePassport, 120);
  const mykadPassport = isDefaulterMode
    ? ""
    : cleanUpper(data.mykadPassport, 40);
  const regnum = cleanUpper(data.regnum, 30);
  const contact = contactDigits(data.contact);
  const unitNumber = cleanUpper(data.unitNumber, 40);

  // Temporary compatibility while the frontend is being finalised:
  // accept legacy "remark" input, but store only clean OWNER/TENANT in category.
  const category = normalizeCategory(data.category || data.remark);

  // In DEFAULTER mode the Worker owns the reason value so the audit record
  // cannot be submitted under another reason by mistake.
  const reason = isDefaulterMode
    ? "DEFAULTER"
    : cleanUpper(data.reason, 100);
  const reasonOther = isDefaulterMode
    ? ""
    : cleanUpper(data.reasonOther, 160);
  const tower = towerFromUnitNumber(unitNumber);

  // NORMAL keeps the existing identity requirements unchanged.
  if (!isDefaulterMode && !namePassport) {
    return { ok: false, message: "Name is required." };
  }
  if (!isDefaulterMode && !mykadPassport) {
    return { ok: false, message: "MyKad / Passport is required." };
  }

  // Shared requirements for NORMAL and DEFAULTER.
  if (!regnum) return { ok: false, message: "Registration Number is required." };
  if (contact.length < 10) {
    return { ok: false, message: "Contact Number must contain at least 10 digits." };
  }
  if (!unitNumber) return { ok: false, message: "Unit Number is required." };
  if (!tower) {
    return {
      ok: false,
      message: "Unit Number must begin with A or B so Tower can be detected automatically.",
    };
  }
  if (category !== "OWNER" && category !== "TENANT") {
    return { ok: false, message: "Category must be OWNER or TENANT." };
  }

  // NORMAL keeps the existing reason rules unchanged.
  if (!isDefaulterMode && !reason) {
    return { ok: false, message: "Reason is required." };
  }
  if (!isDefaulterMode && reason === "OTHER" && !reasonOther) {
    return { ok: false, message: "Please specify the reason." };
  }

  // MyKad format validation applies to NORMAL only.
  if (!isDefaulterMode) {
    const idNorm = normKey(mykadPassport);
    const hasLetter = /[A-Z]/.test(idNorm);
    if (!hasLetter && idNorm.length !== 12) {
      return { ok: false, message: "MyKad must contain 12 digits." };
    }
  }

  return {
    ok: true,
    value: {
      mode,
      namePassport,
      mykadPassport,
      regnum,
      contact,
      unitNumber,
      category,
      reason,
      reasonOther: reason === "OTHER" ? reasonOther : "",
      tower,
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

/** =========================
 * Submit handler
 * ========================= */
async function handleSubmit(data, env, ctx, cors) {
  const validation = validateRegistrationPayload(data);
  if (!validation.ok) {
    return jsonResp(
      { success: false, message: validation.message },
      200,
      cors,
      { "Cache-Control": "no-store" }
    );
  }

  const value = validation.value;
  let clientTxnId = cleanInput(data.clientTxnId, 100);
  if (!clientTxnId) clientTxnId = crypto.randomUUID();

  // Deduplicate accidental double-submit.
  const duplicate = await dbFirst(
    env,
    `SELECT id, created_at, sync_status
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
        createdAt: toText(duplicate.created_at),
        syncStatus: toText(duplicate.sync_status) || "PENDING",
      },
      200,
      cors,
      { "Cache-Control": "no-store" }
    );
  }

  const regNorm = normKey(value.regnum);
  const idNorm = normKey(value.mykadPassport);
  const unitNorm = normKey(value.unitNumber);

  // DEFAULTER mode never stores or reuses an ID photo. Force imageUrl blank
  // so stale frontend image data cannot be uploaded to R2 accidentally.
  const imageUrl = value.mode === "DEFAULTER"
    ? ""
    : toText(data.imageUrl);

  // Keep the original photo-proof requirement unchanged for NORMAL mode only.
  if (value.mode !== "DEFAULTER") {
    if (!imageUrl) {
      const hasProof = await hasExistingPhotoProof(env, regNorm, idNorm);
      if (!hasProof) {
        return jsonResp(
          {
            success: false,
            message: "ID photo is required because no active previous photo was found.",
          },
          200,
          cors,
          { "Cache-Control": "no-store" }
        );
      }
    } else if (!imageUrl.startsWith("data:image/")) {
      return jsonResp(
        { success: false, message: "Invalid imageUrl." },
        200,
        cors,
        { "Cache-Control": "no-store" }
      );
    }
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
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

      imageKey = `${r2Prefix(env)}/${utcYmd(new Date())}/${id}.jpg`;

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
          id, created_at, client_txn_id, device_id,
          name_passport, mykad_passport, regnum, contact,
          unit_number, category, reason, reason_other, tower,
          reg_norm, id_norm, unit_norm,
          image_key, image_sha256,
          drive_file_id, drive_url,
          sync_status, sync_attempts, sync_error
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        createdAt,
        clientTxnId,
        deviceId,
        value.namePassport,
        value.mykadPassport,
        value.regnum,
        value.contact,
        value.unitNumber,
        value.category,
        value.reason,
        value.reasonOther,
        value.tower,
        regNorm,
        idNorm,
        unitNorm,
        imageKey,
        shaHex,
        null,
        null,
        "PENDING",
        0,
        ""
      );
    } catch (dbError) {
      const message = dbError && dbError.message
        ? String(dbError.message)
        : String(dbError);

      // Race-safe dedupe in case two identical requests reached D1 together.
      if (/UNIQUE constraint failed:\s*entries\.client_txn_id/i.test(message)) {
        const existing = await dbFirst(
          env,
          `SELECT id, created_at, sync_status
             FROM entries
            WHERE client_txn_id = ?
            LIMIT 1`,
          clientTxnId
        );

        if (existing && existing.id) {
          if (uploadedToR2 && imageKey && env.BUCKET) {
            try { await env.BUCKET.delete(imageKey); } catch (_) {}
          }

          return jsonResp(
            {
              success: true,
              id: existing.id,
              duplicate: true,
              createdAt: toText(existing.created_at),
              syncStatus: toText(existing.sync_status) || "PENDING",
            },
            200,
            cors,
            { "Cache-Control": "no-store" }
          );
        }
      }

      throw dbError;
    }
  } catch (error) {
    // Avoid an orphan R2 object if D1 insert fails after image upload.
    if (uploadedToR2 && imageKey && env.BUCKET) {
      try { await env.BUCKET.delete(imageKey); } catch (_) {}
    }
    throw error;
  }

  // Fast ACK: Google sync and cleanup continue in the background.
  ctx.waitUntil(syncToGoogle(env, id));
  ctx.waitUntil(cleanupOld(env, ctx));

  return jsonResp(
    {
      success: true,
      id,
      createdAt,
      syncStatus: "PENDING",
      tower: value.tower,
    },
    200,
    cors,
    { "Cache-Control": "no-store" }
  );
}

/** =========================
 * Retention cleanup
 * - Registration records only.
 * - unit_owners is a permanent reference directory and is NOT cleaned here.
 * ========================= */
async function cleanupOld(env, ctx) {
  if (!env.DB) return;

  const cutoffIso = new Date(
    Date.now() - retentionDays(env) * 86400000
  ).toISOString();

  const limit = clampInt(env.CLEANUP_BATCH, 200, 50, 500);
  const maxBatches = clampInt(env.CLEANUP_MAX_BATCHES, 10, 1, 20);

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex++) {
    const result = await dbAll(
      env,
      `SELECT id, image_key, drive_file_id
         FROM entries
        WHERE created_at < ?
        ORDER BY created_at ASC
        LIMIT ${limit}`,
      cutoffIso
    );

    const rows = result && Array.isArray(result.results) ? result.results : [];
    if (!rows.length) break;

    const ids = rows.map((row) => row.id);
    const r2Keys = rows.map((row) => toText(row.image_key)).filter(Boolean);
    const driveIds = rows.map((row) => toText(row.drive_file_id)).filter(Boolean);

    const placeholders = ids.map(() => "?").join(",");

    // Remove D1 first so old records immediately disappear from search.
    await dbRun(
      env,
      `DELETE FROM entries WHERE id IN (${placeholders})`,
      ...ids
    );

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

    // Health check.
    if (request.method === "GET" && path === "/health") {
      return jsonResp(
        {
          ok: true,
          service: "secure-entry-owner-tenant",
          schemaVersion: 1,
          ownerDirectory: true,
          unitSearchMode: "OWNER_DETAILS_ONLY",
          retentionDays: retentionDays(env),
          gasSyncConfigured: !!(env.GAS_SYNC_URL && env.SYNC_TOKEN),
          r2Configured: !!env.BUCKET,
        },
        200,
        cors,
        { "Cache-Control": "no-store" }
      );
    }

    // Protected R2 image endpoint used by GAS when uploading a new image to Drive.
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

    // Safe manual retry for records created on/after SYNC_RETRY_START_AT.
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

    // OWNER | TENANT dashboard aggregate endpoint.
    // Example:
    // GET /dashboard/owner-tenant?start=2026-08-01&end=2026-08-12
    if (request.method === "GET" && path === "/dashboard/owner-tenant") {
      if (!env.DB) {
        return jsonResp(
          { ok: false, message: "DB binding is missing." },
          500,
          cors,
          { "Cache-Control": "no-store" }
        );
      }

      const startDate = cleanInput(url.searchParams.get("start"), 10);
      const endDate = cleanInput(url.searchParams.get("end"), 10);

      try {
        const result = await loadOwnerTenantDashboard(env, startDate, endDate);

        return jsonResp(
          result,
          result.ok ? 200 : 400,
          cors,
          { "Cache-Control": "no-store" }
        );
      } catch (error) {
        return jsonResp(
          {
            ok: false,
            message: error && error.message ? error.message : String(error),
          },
          500,
          cors,
          { "Cache-Control": "no-store" }
        );
      }
    }

    // Frontend warm-up compatibility: ?debug=1 or ?ping=1 / ?ping=2.
    if (
      request.method === "GET" &&
      (path === "/" || path === "/search") &&
      !toText(url.searchParams.get("value")) &&
      (url.searchParams.has("debug") || url.searchParams.has("ping"))
    ) {
      return jsonResp(
        { ok: true, service: "secure-entry-owner-tenant" },
        200,
        cors,
        { "Cache-Control": "no-store" }
      );
    }

    // D1 search: Unit Number -> owner directory only;
    // REG.NUM / MYKAD-PASSPORT -> registration records.
    if (request.method === "GET" && (path === "/" || path === "/search")) {
      const field = cleanInput(url.searchParams.get("field"), 40);
      const value = cleanInput(url.searchParams.get("value"), 100);

      if (!value) {
        return jsonResp(
          { exist: false },
          200,
          cors,
          { "Cache-Control": "no-store" }
        );
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

    // Registration submit. Accept POST /submit and POST / for compatibility.
    if (request.method === "POST" && (path === "/" || path === "/submit")) {
      try {
        if (!env.DB) throw new Error("DB binding is missing");

        const data = await request.json();
        return await handleSubmit(data, env, ctx, cors);
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

    ctx.waitUntil(
      (async () => {
        await retryPendingSync(env, ctx);
        await cleanupOld(env, ctx);
      })().catch((error) => {
        console.error(
          "Scheduled OWNER | TENANT maintenance failed:",
          cleanSyncError(error)
        );
      })
    );
  },
};

/*
==================================================
D1 SCHEMA - OWNER | TENANT
==================================================

-- Registration records.
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  client_txn_id TEXT NOT NULL UNIQUE,
  device_id TEXT,

  name_passport TEXT,
  mykad_passport TEXT,
  regnum TEXT,
  contact TEXT,
  unit_number TEXT,
  category TEXT,
  reason TEXT,
  reason_other TEXT,
  tower TEXT,

  reg_norm TEXT,
  id_norm TEXT,
  unit_norm TEXT,

  image_key TEXT,
  image_sha256 TEXT,
  drive_file_id TEXT,
  drive_url TEXT,

  sync_status TEXT,
  sync_attempts INTEGER DEFAULT 0,
  sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_reg_created
  ON entries(reg_norm, created_at);

CREATE INDEX IF NOT EXISTS idx_entries_id_created
  ON entries(id_norm, created_at);

CREATE INDEX IF NOT EXISTS idx_entries_unit_created
  ON entries(unit_norm, created_at);

CREATE INDEX IF NOT EXISTS idx_entries_created
  ON entries(created_at);

CREATE INDEX IF NOT EXISTS idx_entries_sync_created
  ON entries(sync_status, created_at);

-- Owner reference directory.
-- A unit with no owner name can still be stored using owner_name = ''.
-- Multiple owners for one unit use owner_order = 1, 2, 3 ...
CREATE TABLE IF NOT EXISTS unit_owners (
  id TEXT PRIMARY KEY,
  unit_number TEXT NOT NULL,
  unit_norm TEXT NOT NULL,
  owner_name TEXT DEFAULT '',
  owner_order INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_unit_owners_lookup
  ON unit_owners(unit_norm, is_active, owner_order);

==================================================
EXPECTED UNIT SEARCH RESPONSE
==================================================

GET /?field=UNITNUMBER&value=A-09-03A

{
  "exist": true,
  "ownerDetails": {
    "available": true,
    "unitFound": true,
    "unitNumber": "A-09-03A",
    "ownerRecordCount": 1,
    "ownerCount": 1,
    "owners": [
      { "name": "OWNER NAME", "order": 1 }
    ]
  }
}

There is intentionally NO registration record list / Visitor List in Unit search.

==================================================
ENV / BINDINGS - CLOUDFLARE
==================================================

DB                   : D1 binding
BUCKET               : R2 binding
R2_PREFIX            : recommended "owner-tenant-sensory"

GAS_SYNC_URL         : Apps Script Web App URL (add later)
GAS_DELETE_URL       : optional; default GAS_SYNC_URL
SYNC_TOKEN           : must match future Apps Script token

PUBLIC_BASE_URL      : this Worker public URL, no trailing slash
IMAGE_VIEW_TOKEN     : secret token used by GAS to fetch R2 image

RETENTION_DAYS       : default 90
SYNC_RETRY_START_AT  : ISO date/time; enables safe retry for new records
SYNC_TRIES_PER_RUN   : optional, default 3
SYNC_RETRY_DELAY_MS  : optional, default 1500
SYNC_MAX_ATTEMPTS    : optional, default 8
SYNC_RETRY_BATCH     : optional, default 20
RETRY_TOKEN          : optional; fallback = SYNC_TOKEN
CLEANUP_BATCH        : optional, default 200
CLEANUP_MAX_BATCHES  : optional, default 10

==================================================
FRONTEND WORKER URL
==================================================

After this Worker is deployed, put its public URL into:

const WORKER_URL = "https://<OWNER-TENANT-WORKER>.workers.dev";

OCR remains separate and unchanged:
https://secure-entry-vision01.edreborn86.workers.dev

==================================================
NOTES FOR FUTURE GAS
==================================================

GAS will receive this clean field structure:

TIMESTAMP / createdAt
NAME / namePassport
MYKAD / PASSPORT / mykadPassport
REG.NUM / regnum
CONTACT / contact
UNIT NUMBER / unitNumber
CATEGORY / category
REASON / reason
REASON OTHER / reasonOther
TOWER / tower
PHOTO / imageViewUrl -> Drive URL

Do not rebuild the old "OWNER ( UNIT )" remark format.
==================================================
*/
