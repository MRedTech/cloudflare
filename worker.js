/**
 * SECURE ENTRY - Cloudflare Worker + D1 (Production Ready Baseline)
 *
 * Features:
 * - Fast record search via D1 (records_latest + key_aliases)
 * - Submit updates latest record, optional photo upload via Apps Script
 * - Keep only 1 latest photo per person (update records_latest.photoId/photoUrl)
 * - 120-day retention via scheduled purge (Drive delete first, then D1 cleanup)
 *
 * Required bindings:
 * - D1: DB
 * - Vars:
 *   - APPS_SCRIPT_URL (Apps Script Web App URL)
 *   - RETENTION_DAYS (default 120)
 *   - PURGE_BATCH (default 50)
 *
 * Routes:
 * - GET  /api/health
 * - GET  /api/search?key=...&type=DOC|REG (type optional)
 * - POST /api/submit  (JSON)
 *
 * Cron (wrangler):
 * - triggers scheduled() to purge expired photos & logs
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extraHeaders },
  });
}

function badRequest(msg, extra = {}) {
  return json({ ok: false, error: msg, ...extra }, 400);
}

function normalizeKey(s) {
  return String(s || "").trim().toUpperCase();
}

function makeKey(type, raw) {
  const t = normalizeKey(type);
  const k = normalizeKey(raw);
  if (!k) return null;
  if (t === "DOC") return `DOC:${k}`;
  if (t === "REG") return `REG:${k}`;
  return null;
}

function nowMs() {
  return Date.now();
}

async function readJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function resolvePrimaryKey(db, key, typeOpt) {
  // If type specified, use that only; else try DOC then REG.
  const tries = [];
  const normalized = normalizeKey(key);
  if (!normalized) return { primaryKey: null, guessedType: null };

  if (typeOpt) {
    const k = makeKey(typeOpt, normalized);
    if (k) tries.push(k);
  } else {
    tries.push(makeKey("DOC", normalized), makeKey("REG", normalized));
  }

  for (const k of tries) {
    if (!k) continue;
    // direct record?
    const direct = await db.prepare("SELECT primaryKey FROM key_aliases WHERE aliasKey = ?1").bind(k).first();
    const primaryKey = direct?.primaryKey || k;

    const rec = await db.prepare("SELECT primaryKey FROM records_latest WHERE primaryKey = ?1").bind(primaryKey).first();
    if (rec?.primaryKey) {
      const guessedType = primaryKey.startsWith("DOC:") ? "DOC" : "REG";
      return { primaryKey, guessedType };
    }
  }
  return { primaryKey: null, guessedType: null };
}

async function getRecord(db, primaryKey) {
  return await db
    .prepare(
      `SELECT primaryKey, name, phone, docNo, regNo, category, tower, unitNo, photoId, photoUrl,
              photoUpdatedAt, createdAt, updatedAt
       FROM records_latest
       WHERE primaryKey = ?1`
    )
    .bind(primaryKey)
    .first();
}

function hasValidPhoto(rec) {
  return !!(rec && rec.photoId && rec.photoUrl);
}

async function upsertAliases(db, primaryKey, docNo, regNo) {
  const items = [];
  const d = normalizeKey(docNo);
  const r = normalizeKey(regNo);
  if (d) items.push({ aliasKey: makeKey("DOC", d), primaryKey });
  if (r) items.push({ aliasKey: makeKey("REG", r), primaryKey });

  for (const it of items) {
    if (!it.aliasKey) continue;
    await db.prepare(
      `INSERT INTO key_aliases(aliasKey, primaryKey, updatedAt)
       VALUES(?1, ?2, ?3)
       ON CONFLICT(aliasKey) DO UPDATE SET primaryKey=excluded.primaryKey, updatedAt=excluded.updatedAt`
    ).bind(it.aliasKey, it.primaryKey, nowMs()).run();
  }
}

async function callAppsScript(env, payload) {
  if (!env.APPS_SCRIPT_URL) throw new Error("APPS_SCRIPT_URL not configured");
  const res = await fetch(env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data || data.ok === false) {
    const msg = data?.error || `Apps Script error (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Basic security hardening: disallow huge payloads (optional)
    const cl = request.headers.get("content-length");
    if (cl && Number(cl) > 8_000_000) return badRequest("Payload too large");

    if (url.pathname === "/api/health") {
      return json({ ok: true, ts: nowMs() });
    }

    if (url.pathname === "/api/search" && request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      const type = url.searchParams.get("type") || "";

      const { primaryKey } = await resolvePrimaryKey(env.DB, key, type);
      if (!primaryKey) return json({ ok: true, exist: false, hasPhoto: false, primaryKey: null });

      const record = await getRecord(env.DB, primaryKey);
      if (!record) return json({ ok: true, exist: false, hasPhoto: false, primaryKey: null });

      return json({
        ok: true,
        exist: true,
        hasPhoto: hasValidPhoto(record),
        primaryKey,
        record: {
          ...record,
          // convert ms to ISO for frontend (readability)
          createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : null,
          updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : null,
          photoUpdatedAt: record.photoUpdatedAt ? new Date(record.photoUpdatedAt).toISOString() : null,
        },
      });
    }

    if (url.pathname === "/api/submit" && request.method === "POST") {
      const body = await readJson(request);
      if (!body) return badRequest("Invalid JSON");

      const name = normalizeKey(body.name);
      const phone = normalizeKey(body.phone);
      const docNo = normalizeKey(body.docNo);
      const regNo = normalizeKey(body.regNo);
      const category = normalizeKey(body.category);
      const tower = normalizeKey(body.tower);
      const unitNo = normalizeKey(body.unitNo);
      const purpose = normalizeKey(body.purpose); // optional (log)
      const searchedKey = normalizeKey(body.searchedKey);

      const photoBase64 = body.photoBase64 ? String(body.photoBase64) : null;
      const photoMime = body.photoMime ? String(body.photoMime) : null;

      if (!docNo && !regNo) return badRequest("docNo or regNo is required");

      // Decide primary key: prefer DOC if exists, else REG.
      let primaryKey = docNo ? makeKey("DOC", docNo) : makeKey("REG", regNo);

      // If searchedKey matches an existing record via alias, use that primaryKey to preserve identity.
      if (searchedKey) {
        const resolved = await resolvePrimaryKey(env.DB, searchedKey, body.type || "");
        if (resolved.primaryKey) primaryKey = resolved.primaryKey;
      }

      // If submitting with regNo but docNo exists, we want to map both keys to same primaryKey (doc key).
      if (docNo) primaryKey = makeKey("DOC", docNo);

      const ts = nowMs();

      // Optional photo upload
      let uploaded = null;
      if (photoBase64) {
        if (!photoMime) return badRequest("photoMime required when photoBase64 provided");
        // Upload via Apps Script (Drive)
        uploaded = await callAppsScript(env, {
          action: "upload",
          mimeType: photoMime,
          base64: photoBase64,
          // optional metadata
          meta: { docNo, regNo, name, category, tower, unitNo },
        });
      }

      // Upsert latest record
      const existing = await env.DB.prepare("SELECT createdAt, photoId FROM records_latest WHERE primaryKey=?1").bind(primaryKey).first();
      const createdAt = existing?.createdAt || ts;

      // If new photo uploaded, replace old photo reference in D1 (old photo will be purged by cron if still present in photos table).
      const photoId = uploaded?.photoId || null;
      const photoUrl = uploaded?.photoUrl || null;

      const photoUpdatedAt = uploaded ? ts : (existing?.photoId ? (await env.DB.prepare("SELECT photoUpdatedAt FROM records_latest WHERE primaryKey=?1").bind(primaryKey).first())?.photoUpdatedAt : null);

      await env.DB.prepare(
        `INSERT INTO records_latest(primaryKey, name, phone, docNo, regNo, category, tower, unitNo,
                                   photoId, photoUrl, photoUpdatedAt, createdAt, updatedAt)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(primaryKey) DO UPDATE SET
           name=excluded.name,
           phone=excluded.phone,
           docNo=excluded.docNo,
           regNo=excluded.regNo,
           category=excluded.category,
           tower=excluded.tower,
           unitNo=excluded.unitNo,
           photoId=COALESCE(excluded.photoId, records_latest.photoId),
           photoUrl=COALESCE(excluded.photoUrl, records_latest.photoUrl),
           photoUpdatedAt=COALESCE(excluded.photoUpdatedAt, records_latest.photoUpdatedAt),
           updatedAt=excluded.updatedAt`
      ).bind(
        primaryKey,
        name || null,
        phone || null,
        docNo || null,
        regNo || null,
        category || null,
        tower || null,
        unitNo || null,
        photoId,
        photoUrl,
        uploaded ? ts : photoUpdatedAt,
        createdAt,
        ts
      ).run();

      // Aliases for both DOC and REG to map to this primary record
      await upsertAliases(env.DB, primaryKey, docNo, regNo);

      // Log visit (optional)
      await env.DB.prepare(
        `INSERT INTO visits_log(primaryKey, ts, purpose)
         VALUES(?1, ?2, ?3)`
      ).bind(primaryKey, ts, purpose || null).run();

      // If uploaded photo: insert into photos table with expiresAt
      if (uploaded?.photoId) {
        const retentionDays = Number(env.RETENTION_DAYS || 120);
        const expiresAt = ts + retentionDays * 24 * 60 * 60 * 1000;
        await env.DB.prepare(
          `INSERT INTO photos(photoId, primaryKey, createdAt, expiresAt, deletedAt)
           VALUES(?1, ?2, ?3, ?4, NULL)
           ON CONFLICT(photoId) DO UPDATE SET primaryKey=excluded.primaryKey`
        ).bind(uploaded.photoId, primaryKey, ts, expiresAt).run();
      }

      return json({
        ok: true,
        primaryKey,
        uploaded: uploaded ? { photoId: uploaded.photoId, photoUrl: uploaded.photoUrl } : null,
      });
    }

    return json({ ok: false, error: "Not Found" }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(purgeExpired(env));
  },
};

async function purgeExpired(env) {
  const db = env.DB;
  const retentionDays = Number(env.RETENTION_DAYS || 120);
  const batch = Number(env.PURGE_BATCH || 50);
  const ts = nowMs();

  // 1) Delete expired photos in Drive FIRST (via Apps Script), then mark deletedAt and clear from records if matching
  const expired = await db.prepare(
    `SELECT photoId, primaryKey
     FROM photos
     WHERE deletedAt IS NULL AND expiresAt <= ?1
     LIMIT ?2`
  ).bind(ts, batch).all();

  if (expired?.results?.length) {
    for (const row of expired.results) {
      try {
        await callAppsScript(env, { action: "delete", photoId: row.photoId });
        await db.prepare(`UPDATE photos SET deletedAt=?1 WHERE photoId=?2`).bind(ts, row.photoId).run();
        // Clear photo reference only if still pointing to this photoId
        await db.prepare(
          `UPDATE records_latest
           SET photoId=NULL, photoUrl=NULL, photoUpdatedAt=NULL, updatedAt=?1
           WHERE primaryKey=?2 AND photoId=?3`
        ).bind(ts, row.primaryKey, row.photoId).run();
      } catch (e) {
        // If Drive delete fails, do not mark deletedAt; will retry on next cron
      }
    }
  }

  // 2) Purge old visits logs beyond retention (optional)
  const cutoff = ts - retentionDays * 24 * 60 * 60 * 1000;
  await db.prepare(`DELETE FROM visits_log WHERE ts < ?1`).bind(cutoff).run();

  // 3) (Optional) Purge photos rows that are already deleted long ago (e.g., 30 days)
  const photoCutoff = ts - 30 * 24 * 60 * 60 * 1000;
  await db.prepare(`DELETE FROM photos WHERE deletedAt IS NOT NULL AND deletedAt < ?1`).bind(photoCutoff).run();

  // 4) (Optional) Purge records with no activity beyond retention AND no photo (keep latest clean)
  await db.prepare(
    `DELETE FROM records_latest
     WHERE updatedAt < ?1 AND (photoId IS NULL OR photoUrl IS NULL)`
  ).bind(cutoff).run();

  // 5) Clean aliases pointing to deleted records
  await db.prepare(
    `DELETE FROM key_aliases
     WHERE primaryKey NOT IN (SELECT primaryKey FROM records_latest)`
  ).run();
}
