// ==================================================
// SECURE ENTRY - WORKER (OPTION B - FAST SUBMIT + D1 FAST SEARCH + RETENTION CLEANUP)
// - POST /submit: save to D1 (always) + upload R2 (only if imageUrl provided) -> ACK cepat
// - Sync to Google Apps Script: async (ctx.waitUntil)
//   * Apps Script will upload to Google Drive ONLY when imageViewUrl provided
//   * Apps Script returns driveFileId/driveUrl (if new photo) -> Worker updates D1
// - GET / or /search: FAST search from D1 (no Sheet scan) with the same response format as Apps Script doGet
// - GET /image: protected fetch for Apps Script to pull image from R2
// - scheduled: retry sync + cleanup old D1 rows + (optional) auto-delete Drive files
// ==================================================

/** =========================
 * CORS + Response helpers
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
    headers: { ...cors, ...extra, "Content-Type": "application/json" },
  });
}
function textResp(text, status = 200, cors = corsHeaders(), extra = {}) {
  return new Response(text, { status, headers: { ...cors, ...extra } });
}

function toText(v) {
  return (v == null ? "" : String(v)).trim();
}
function toUpper(v) {
  return toText(v).toUpperCase();
}

/** =========================
 * Key normalize (match frontend/appscript behaviour)
 * - Keep only A-Z0-9, uppercase
 * ========================= */
function normKey(v) {
  return toUpper(v).replace(/[^A-Z0-9]/g, "");
}

/** =========================
 * Display helpers (match Apps Script formatting)
 * ========================= */
function fmtRemark(remarkRaw, unitNumberRaw) {
  const r = toUpper(remarkRaw);
  const u = toUpper(unitNumberRaw);
  if ((r === "OWNER" || r === "TENANT") && u) return `${r} ( ${u} )`;
  return r;
}
function fmtReason(reasonRaw, reasonOtherRaw) {
  const r = toUpper(reasonRaw);
  const o = toUpper(reasonOtherRaw);
  if (r === "OTHER" && o) return `OTHER ( ${o} )`;
  return r;
}

/** =========================
 * Drive link helpers
 * ========================= */
function isHttpUrl(v) {
  return /^https?:\/\//i.test(toText(v));
}
function extractDriveFileId(url) {
  const s = toText(url);
  if (!s) return "";
  // Common: https://drive.google.com/uc?export=view&id=FILEID
  try {
    const u = new URL(s);
    const id = u.searchParams.get("id");
    if (id) return id;
  } catch (_) {}
  // Alternate: /file/d/FILEID/view
  const m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  // Fallback: any id=FILEID in string
  const m2 = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m2) return m2[1];
  return "";
}

/** =========================
 * Image helpers
 * ========================= */
function dataUrlToBytes(dataUrl) {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid image data URL");
  const contentType = m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { contentType, bytes };
}
function bufToHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
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

function retentionDays(env) {
  const n = parseInt(toText(env.RETENTION_DAYS) || "120", 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

/** =========================
 * Sync to Google (Apps Script)
 * IMPORTANT:
 * - Mark DONE only if JSON {success:true}
 * - If Apps Script returns driveFileId/driveUrl, store into D1
 * ========================= */
async function syncToGoogle(env, record) {
  if (!env.GAS_SYNC_URL) return;
  if (!env.SYNC_TOKEN) return;

  try {
    try { await dbRun(env, "UPDATE entries SET sync_attempts = sync_attempts + 1 WHERE id = ?", record.id); } catch (_) {}

    const imageViewUrl =
      record.image_key && env.PUBLIC_BASE_URL && env.IMAGE_VIEW_TOKEN
        ? `${env.PUBLIC_BASE_URL}/image?id=${encodeURIComponent(record.id)}&token=${encodeURIComponent(env.IMAGE_VIEW_TOKEN)}`
        : "";

    const payload = {
      token: env.SYNC_TOKEN,

      // default action = SYNC
      action: "SYNC",

      id: record.id,
      createdAt: record.created_at,
      clientTxnId: record.client_txn_id,
      deviceId: record.device_id,

      namePassport: record.name_passport,
      mykadPassport: record.mykad_passport,
      regnum: record.regnum,
      contact: record.contact,
      remark: record.remark,
      unitNumber: record.unit_number,
      tower: record.tower,
      reason: record.reason,
      reasonOther: record.reason_other,

      // Apps Script akan upload Drive hanya jika ada imageViewUrl
      imageViewUrl,
    };

    const res = await fetch(env.GAS_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`GAS sync http failed: ${res.status} ${text.slice(0, 180)}`);

    let js;
    try { js = JSON.parse(text || "{}"); } catch (e) { js = null; }

    if (!js || js.success !== true) {
      const msg = js && js.message ? js.message : text.slice(0, 180) || "GAS returned non-success";
      throw new Error(`GAS sync app failed: ${msg}`);
    }

    // Update drive info if provided (only when NEW photo uploaded)
    const driveFileId = toText(js.driveFileId);
    const driveUrl = toText(js.driveUrl);

    try {
      await dbRun(
        env,
        "UPDATE entries SET sync_status='DONE', sync_error='', drive_file_id = COALESCE(NULLIF(?,''), drive_file_id), drive_url = COALESCE(NULLIF(?,''), drive_url) WHERE id = ?",
        driveFileId,
        driveUrl,
        record.id
      );
    } catch (e2) {
      // If schema doesn't have drive_url/drive_file_id yet, still mark DONE
      try {
        await dbRun(env, "UPDATE entries SET sync_status='DONE', sync_error='' WHERE id = ?", record.id);
      } catch (_) {}
    }
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    try {
      await dbRun(env, "UPDATE entries SET sync_status = 'FAILED', sync_error = ? WHERE id = ?", msg.slice(0, 600), record.id);
    } catch (_) {}
  }
}

/** =========================
 * D1 Search
 * Response format MUST match Apps Script doGet:
 * - { exist:false }
 * - { exist:true, hasHyperlink:false, data:{} }  // EXPIRED
 * - { exist:true, hasHyperlink:true, data:{... , photoLink:"..."} } // ACTIVE
 *
 * Concept:
 * - anyRow = latest row for key (latest details)
 * - actRow = latest row with drive_url (proof photo link)
 * - if actRow not found => EXPIRED
 * ========================= */
async function d1Search(env, field, value) {
  const f = normKey(field);
  const v = normKey(value);
  if (!v) return { exist: false };

  const isReg = (f === "REGNUM" || f === "REG" || f === "CAR" || f === "PLATE");
  const isId  = (f === "MYKADPASSPORT" || f === "MYKAD" || f === "PASSPORT" || f === "ID");

  // If frontend passes unknown field, we auto-try REG then ID (same as existing logic)
  const tryOrder = [];
  if (isReg) tryOrder.push({ col: "reg_norm" });
  else if (isId) tryOrder.push({ col: "id_norm" });
  else tryOrder.push({ col: "reg_norm" }, { col: "id_norm" });

  let anyRow = null;
  let proofRow = null;

  for (const t of tryOrder) {
    anyRow = await dbFirst(
      env,
      `SELECT id, created_at, name_passport, mykad_passport, regnum, contact, remark, unit_number, tower, reason, reason_other
         FROM entries
        WHERE ${t.col} = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 1`,
      v
    );

    if (!anyRow) continue;

    proofRow = await dbFirst(
      env,
      `SELECT drive_url
         FROM entries
        WHERE ${t.col} = ?
          AND drive_url IS NOT NULL
          AND TRIM(drive_url) <> ''
        ORDER BY datetime(created_at) DESC
        LIMIT 1`,
      v
    );

    // Found at least one row, break (keep same key type)
    break;
  }

  if (!anyRow) return { exist: false };

  if (!proofRow || !toText(proofRow.drive_url)) {
    return { exist: true, hasHyperlink: false, data: {} };
  }

  return {
    exist: true,
    hasHyperlink: true,
    data: {
      namePassport: anyRow.name_passport || "",
      mykadPassport: anyRow.mykad_passport || "",
      regnum: anyRow.regnum || "",
      contact: anyRow.contact || "",
      remark: fmtRemark(anyRow.remark, anyRow.unit_number),
      tower: anyRow.tower || "",
      reason: fmtReason(anyRow.reason, anyRow.reason_other),
      photoLink: toText(proofRow.drive_url),
    },
  };
}

/** =========================
 * Cleanup old records (retention days)
 * - Delete old D1 rows
 * - Delete R2 object (if image_key exists)
 * - Optional: delete Drive file via Apps Script action DELETE_DRIVE
 * ========================= */
async function cleanupOld(env, ctx) {
  if (!env.DB) return;

  const days = retentionDays(env);

  // Batch to avoid timeouts
  const batch = await dbAll(
    env,
    `SELECT id, image_key, drive_file_id
       FROM entries
      WHERE datetime(created_at) < datetime('now', ?)
      ORDER BY datetime(created_at) ASC
      LIMIT 200`,
    `-${days} days`
  );

  const list = batch && batch.results ? batch.results : [];
  if (!list.length) return;

  const ids = list.map(r => r.id);
  const driveIds = list.map(r => toText(r.drive_file_id)).filter(Boolean);
  const r2Keys = list.map(r => toText(r.image_key)).filter(Boolean);

  // Delete from D1 first (so search never returns stale rows)
  const placeholders = ids.map(() => "?").join(",");
  await dbRun(env, `DELETE FROM entries WHERE id IN (${placeholders})`, ...ids);

  // Delete R2 objects (best-effort)
  if (env.BUCKET && r2Keys.length) {
    for (const k of r2Keys) {
      try { await env.BUCKET.delete(k); } catch (_) {}
    }
  }

  // Delete Drive files via Apps Script (best-effort, batched)
  if (driveIds.length && env.GAS_SYNC_URL && env.SYNC_TOKEN) {
    const url = env.GAS_DELETE_URL || env.GAS_SYNC_URL;
    const chunkSize = 50;
    for (let i = 0; i < driveIds.length; i += chunkSize) {
      const chunk = driveIds.slice(i, i + chunkSize);
      const payload = { token: env.SYNC_TOKEN, action: "DELETE_DRIVE", fileIds: chunk };
      ctx.waitUntil(fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {}));
    }
  }
}

/** =========================
 * Worker
 * ========================= */
export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders();

    if (request.method === "OPTIONS") return textResp("", 204, cors);

    const url = new URL(request.url);
    const path = url.pathname;

    // Health
    if (request.method === "GET" && path === "/health") {
      return jsonResp({ ok: true }, 200, cors);
    }

    // =========================
    // GET /image?id=...&token=...
    // (Protected image fetch for Apps Script)
    // =========================
    if (request.method === "GET" && path === "/image") {
      const id = url.searchParams.get("id") || "";
      const token = url.searchParams.get("token") || "";

      if (!id || !env.IMAGE_VIEW_TOKEN || token !== env.IMAGE_VIEW_TOKEN) {
        return textResp("Unauthorized", 401, cors);
      }

      const row = await dbFirst(env, "SELECT image_key FROM entries WHERE id = ? LIMIT 1", id);
      if (!row || !row.image_key) return textResp("Not found", 404, cors);

      const obj = await env.BUCKET.get(row.image_key);
      if (!obj) return textResp("Not found", 404, cors);

      return new Response(obj.body, {
        status: 200,
        headers: {
          ...cors,
          "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
          "Cache-Control": "private, max-age=60",
        },
      });
    }

    // =========================
    // GET / or /search (FAST from D1)
    // - micro-cache at edge (15s) to reduce repeated lookups
    // - fallback proxy to Apps Script if env.DB missing (optional)
    // =========================
    if (request.method === "GET" && (path === "/" || path === "/search")) {
      const field = toText(url.searchParams.get("field"));
      const value = toText(url.searchParams.get("value"));

      if (!value) return jsonResp({ exist: false }, 200, cors);

      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });

      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      let bodyObj = null;

      // Prefer D1 (fast path)
      if (env.DB) {
        try {
          bodyObj = await d1Search(env, field, value);
        } catch (_) {
          bodyObj = null;
        }
      }

      // Fallback to Apps Script search:
      // - when D1 is not configured
      // - OR when D1 returns NO_RECORD (legacy records still live in Sheet)
      // - OR when D1 schema is missing required columns (d1Search throws -> bodyObj null)
      const gasBase = env.GAS_SEARCH_URL || env.GAS_SYNC_URL;
      if (gasBase && (!bodyObj || bodyObj.exist === false)) {
        const apiUrl = gasBase + url.search;
        const res = await fetch(apiUrl, { method: "GET", headers: { "Content-Type": "application/json" } });
        const text = await res.text();
        const out = new Response(text, {
          status: res.status,
          headers: {
            ...cors,
            "Content-Type": res.headers.get("content-type") || "application/json",
            "Cache-Control": res.ok ? "public, max-age=15" : "no-store",
          },
        });
        if (res.ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      }

      // Return D1 result
      const out = jsonResp(bodyObj || { exist: false }, 200, cors, {
        "Cache-Control": "public, max-age=15",
      });
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    }

    // =========================
    // POST /submit (FAST)  (Also accept POST /)
    // Rules:
    // - imageUrl OPTIONAL
    //   * NO_RECORD / EXPIRED → frontend send imageUrl
    //   * FOUND → frontend send no imageUrl
    // =========================
    if (request.method === "POST" && (path === "/submit" || path === "/")) {
      try {
        const data = await request.json();

        let clientTxnId = toText(data.clientTxnId);
        if (!clientTxnId) clientTxnId = crypto.randomUUID();

        // Deduplicate
        const dup = await dbFirst(
          env,
          "SELECT id, sync_status AS syncStatus FROM entries WHERE client_txn_id = ? LIMIT 1",
          clientTxnId
        );
        if (dup && dup.id) {
          return jsonResp(
            { success: true, id: dup.id, duplicate: true, syncStatus: dup.syncStatus || "PENDING" },
            200,
            cors
          );
        }

        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();

        const record = {
          id,
          created_at: createdAt,
          client_txn_id: clientTxnId,
          device_id: toText(data.deviceId),

          name_passport: toUpper(data.namePassport),
          mykad_passport: toUpper(data.mykadPassport),
          regnum: toUpper(data.regnum),
          contact: toText(data.contact),
          remark: toUpper(data.remark),
          unit_number: toUpper(data.unitNumber),
          tower: toUpper(data.tower),
          reason: toUpper(data.reason),
          reason_other: toUpper(data.reasonOther),
        };

        // Precompute keys for D1 search speed
        const regNorm = normKey(record.regnum);
        const idNorm  = normKey(record.mykad_passport);

        const imageUrl = toText(data.imageUrl);
        // IMPORTANT: Do NOT carry forward old hyperlink/proof photo into new record.
        // RECORD FOUND should submit without imageUrl; new row stays WITHOUT drive_url.
        const driveUrlInit = "";
        const driveFileIdInit = "";
        let imageKey = null;
        let shaHex = null;
        let r2PutOk = false;

        try {
          // Upload to R2 only if imageUrl exists
          if (imageUrl) {
            if (!imageUrl.startsWith("data:image/")) {
              return jsonResp({ success: false, message: "Invalid imageUrl" }, 400, cors);
            }

            const { contentType, bytes } = dataUrlToBytes(imageUrl);
            const shaBuf = await crypto.subtle.digest("SHA-256", bytes);
            shaHex = bufToHex(shaBuf);

            const prefix = toText(env.R2_PREFIX) || "sensory";
            imageKey = `${prefix}/${utcYmd(new Date())}/${id}.jpg`;

            await env.BUCKET.put(imageKey, bytes, {
              httpMetadata: { contentType },
              customMetadata: { id, clientTxnId, sha256: shaHex },
            });
            r2PutOk = true;
          }

          // D1 insert (tolerant schema upgrade):
          // - Try full schema first (includes reg_norm/id_norm + drive_url)
          // - If D1 schema is missing some new columns (e.g. drive_url), fallback to a reduced insert
          try {
            await dbRun(
              env,
              `INSERT INTO entries (
                id, created_at, client_txn_id, device_id,
                name_passport, mykad_passport, regnum, contact, remark,
                unit_number, tower, reason, reason_other,
                reg_norm, id_norm,
                image_key, image_sha256,
                drive_file_id, drive_url,
                sync_status, sync_attempts, sync_error
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              record.id, record.created_at, record.client_txn_id, record.device_id,
              record.name_passport, record.mykad_passport, record.regnum, record.contact, record.remark,
              record.unit_number, record.tower, record.reason, record.reason_other,
              regNorm, idNorm,
              imageKey, shaHex,
              driveFileIdInit, driveUrlInit,
              "PENDING", 0, ""
            );
          } catch (e1) {
            const msg = (e1 && e1.message) ? String(e1.message) : "";
            // Fallback #1: schema missing drive_* columns
            if (/no such column: (drive_url|drive_file_id)/i.test(msg)) {
              await dbRun(
                env,
                `INSERT INTO entries (
                  id, created_at, client_txn_id, device_id,
                  name_passport, mykad_passport, regnum, contact, remark,
                  unit_number, tower, reason, reason_other,
                  reg_norm, id_norm,
                  image_key, image_sha256,
                  sync_status, sync_attempts, sync_error
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                record.id, record.created_at, record.client_txn_id, record.device_id,
                record.name_passport, record.mykad_passport, record.regnum, record.contact, record.remark,
                record.unit_number, record.tower, record.reason, record.reason_other,
                regNorm, idNorm,
                imageKey, shaHex,
                "PENDING", 0, ""
              );
            } else if (/no such column: (reg_norm|id_norm)/i.test(msg)) {
              // Fallback #2: schema missing norm columns
              await dbRun(
                env,
                `INSERT INTO entries (
                  id, created_at, client_txn_id, device_id,
                  name_passport, mykad_passport, regnum, contact, remark,
                  unit_number, tower, reason, reason_other,
                  image_key, image_sha256,
                  sync_status, sync_attempts, sync_error
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                record.id, record.created_at, record.client_txn_id, record.device_id,
                record.name_passport, record.mykad_passport, record.regnum, record.contact, record.remark,
                record.unit_number, record.tower, record.reason, record.reason_other,
                imageKey, shaHex,
                "PENDING", 0, ""
              );
            } else {
              throw e1;
            }
          }
        } catch (e) {
          // Avoid orphaned R2 object if DB insert fails after upload
          if (r2PutOk && imageKey) {
            try { await env.BUCKET.delete(imageKey); } catch (_) {}
          }
          throw e;
        }

        // Sync in background
        const recordForSync = { ...record, image_key: imageKey };
        ctx.waitUntil(syncToGoogle(env, recordForSync));

        // ACK cepat (instant feel)
        return jsonResp({ success: true, id, createdAt, syncStatus: "PENDING" }, 200, cors);
      } catch (err) {
        return jsonResp({ success: false, message: err && err.message ? err.message : String(err) }, 500, cors);
      }
    }

    return textResp("Not found", 404, cors);
  },

  async scheduled(event, env, ctx) {
    if (!env.DB) return;

    // 1) Retry sync (PENDING/FAILED)
    const rows = await dbAll(
      env,
      "SELECT id, created_at, client_txn_id, device_id, name_passport, mykad_passport, regnum, contact, remark, unit_number, tower, reason, reason_other, image_key FROM entries WHERE sync_status IN ('PENDING','FAILED') AND sync_attempts < 5 ORDER BY datetime(created_at) ASC LIMIT 20"
    );
    const list = rows && rows.results ? rows.results : [];
    for (const r of list) ctx.waitUntil(syncToGoogle(env, r));

    // 2) Retention cleanup (D1 + R2 + optional Drive delete)
    ctx.waitUntil(cleanupOld(env, ctx));
  }
};

/*
==================================================
D1 SCHEMA (required fields for this Worker)
==================================================

-- Add these columns if your current table doesn't have them:
-- reg_norm, id_norm for fast lookup
-- drive_file_id, drive_url to support "record found / expired" concept

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  client_txn_id TEXT NOT NULL UNIQUE,
  device_id TEXT,
  name_passport TEXT,
  mykad_passport TEXT,
  regnum TEXT,
  contact TEXT,
  remark TEXT,
  unit_number TEXT,
  tower TEXT,
  reason TEXT,
  reason_other TEXT,
  reg_norm TEXT,
  id_norm TEXT,
  image_key TEXT,
  image_sha256 TEXT,
  drive_file_id TEXT,
  drive_url TEXT,
  sync_status TEXT,
  sync_attempts INTEGER,
  sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_reg_norm ON entries(reg_norm);
CREATE INDEX IF NOT EXISTS idx_entries_id_norm  ON entries(id_norm);
CREATE INDEX IF NOT EXISTS idx_entries_created  ON entries(created_at);

==================================================
ENV VARS (Cloudflare Worker)
==================================================
DB                : D1 binding
BUCKET            : R2 binding
R2_PREFIX         : optional, default "sensory"
GAS_SYNC_URL      : Apps Script Web App URL (doPost)
GAS_SEARCH_URL    : optional fallback search URL (doGet)
GAS_DELETE_URL    : optional (default = GAS_SYNC_URL)
SYNC_TOKEN        : must match Apps Script SYNC_TOKEN
PUBLIC_BASE_URL   : Worker public base URL (for imageViewUrl)
IMAGE_VIEW_TOKEN  : token for /image
RETENTION_DAYS    : default 120
*/
