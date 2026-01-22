// ==================================================
// SECURE ENTRY - WORKER (OPTION B - FAST SUBMIT)
// - POST /submit: save to D1 (always) + upload R2 (only if imageUrl provided) -> ACK cepat
// - Sync to Google Apps Script: async (ctx.waitUntil)
// - GET: proxy search to Apps Script doGet
// - GET /image: protected fetch for Apps Script to pull image from R2
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

/** =========================
 * Sync to Google (Apps Script)
 * IMPORTANT: mark DONE only if JSON {success:true}
 * ========================= */
async function syncToGoogle(env, record) {
  if (!env.GAS_SYNC_URL) return;
  if (!env.SYNC_TOKEN) return;

  try {
    await dbRun(env, "UPDATE entries SET sync_attempts = sync_attempts + 1 WHERE id = ?", record.id);

    const imageViewUrl =
      record.image_key && env.PUBLIC_BASE_URL && env.IMAGE_VIEW_TOKEN
        ? `${env.PUBLIC_BASE_URL}/image?id=${encodeURIComponent(record.id)}&token=${encodeURIComponent(env.IMAGE_VIEW_TOKEN)}`
        : "";

    const payload = {
      token: env.SYNC_TOKEN,

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

    // ✅ Apps Script mungkin return 200 tapi success:false
    let js;
    try { js = JSON.parse(text || "{}"); } catch (e) { js = null; }
    if (!js || js.success !== true) {
      const msg = js && js.message ? js.message : text.slice(0, 180) || "GAS returned non-success";
      throw new Error(`GAS sync app failed: ${msg}`);
    }

    await dbRun(env, "UPDATE entries SET sync_status = 'DONE', sync_error = '' WHERE id = ?", record.id);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    await dbRun(
      env,
      "UPDATE entries SET sync_status = 'FAILED', sync_error = ? WHERE id = ?",
      msg.slice(0, 600),
      record.id
    );
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
    // GET / or /search proxy (search) → Apps Script doGet
    // Performance:
    // - Micro-cache at edge (15s) to reduce repeated lookups
    // - Quick reject if value empty
    // =========================
    if (request.method === "GET" && env.GAS_SEARCH_URL && (path === "/" || path === "/search")) {
      const value = toText(url.searchParams.get("value"));
      if (!value) return jsonResp({ exist: false }, 200, cors);

      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: "GET" });

      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const apiUrl = env.GAS_SEARCH_URL + url.search;
      const res = await fetch(apiUrl, { method: "GET", headers: { "Content-Type": "application/json" } });
      const body = await res.text();

      const out = new Response(body, {
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
          return jsonResp({ success: true, id: dup.id, duplicate: true, syncStatus: dup.syncStatus || "PENDING" }, 200, cors);
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

        const imageUrl = toText(data.imageUrl);
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

          // D1 insert
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

    const rows = await dbAll(
      env,
      "SELECT id, created_at, client_txn_id, device_id, name_passport, mykad_passport, regnum, contact, remark, unit_number, tower, reason, reason_other, image_key FROM entries WHERE sync_status IN ('PENDING','FAILED') AND sync_attempts < 5 ORDER BY created_at ASC LIMIT 20"
    );

    const list = rows && rows.results ? rows.results : [];
    for (const r of list) ctx.waitUntil(syncToGoogle(env, r));
  }
};
