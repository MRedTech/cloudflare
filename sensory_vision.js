export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: true, message: "Use POST only." }), {
        status: 405,
        headers: corsHeaders(),
      });
    }

    try {
      const { image } = await request.json();

      // ===== Google Vision API =====
      const VISION_API_KEY = "AIzaSyBesfmexK3feou_oP2J-b3lD3PAbQUwqNA";
      const visionRes = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [{
              image: { content: image },
              features: [{ type: "TEXT_DETECTION" }],
            }],
          }),
        }
      );

      const visionData = await visionRes.json();
      const textDetected = visionData.responses?.[0]?.fullTextAnnotation?.text || "";
      const lines = textDetected.split('\n').map(x => x.trim()).filter(Boolean);

      // === Cari ID (MyKad / Lesen / Passport) ===
      let idnum = "";
      for (let ln of lines) {
        const ic =
          ln.match(/(\d{6})\s*-?\s*(\d{2})\s*-?\s*(\d{4})/) ||
          ln.match(/\b\d{12}\b/);

        const passport = ln.match(/^[A-Z]{1,2}\d{6,9}$/);
        const lesen = ln.match(/^[A-Z]\d{8,9}$/);

        if (ic && !idnum) {
          idnum = ic[1] ? `${ic[1]}-${ic[2]}-${ic[3]}` : ic[0];
        }
        if (passport && !idnum) idnum = passport[0];
        if (lesen && !idnum) idnum = lesen[0];
      }

      // === Cari Nama (AI Smart) ===
      const name = getNameSmart(lines, idnum);

      return new Response(JSON.stringify({
        name: name || "",
        idnum: idnum || "",
        raw: textDetected
      }), {
        headers: { ...corsHeaders(), "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: true, message: err.message }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" }
      });
    }
  }
};

// =====================================================
// === AI SMART NAME EXTRACTION (CLEAN VERSION)
// =====================================================
function getNameSmart(lines, idnum) {

  const STATE_WORDS = [
    "SELANGOR","KUALA LUMPUR","PUTRAJAYA","JOHOR","KEDAH","KELANTAN","MELAKA",
    "NEGERI SEMBILAN","PAHANG","PENANG","PULAU PINANG","PERAK","PERLIS",
    "SABAH","SARAWAK","TERENGGANU","LABUAN"
  ];

  const NOT_NAME_WORDS = [
    "MALAYSIA","KAD PENGENALAN","IDENTITY CARD","MYKAD","WARGANEGARA",
    "LESEN MEMANDU","DRIVING LICENCE","VOCATIONAL LICENCE","CLASS",
    "NO","NO.","NO KP","NO IC","NO K/P","D.O.B","TARIKH","TARIKH LAHIR",
    "EXPIRY","VALID","VALIDITY","ADDRESS","ALAMAT",
    "LELAKI","PEREMPUAN","MALE","FEMALE","AGAMA","ISLAM","CHRISTIAN",
    "BUDDHA","HINDU","DIGITAL","GOVERNMENT"
  ];

  const isStateOnly = t => STATE_WORDS.includes(t.toUpperCase());

  const binPattern = /\b(BIN|BINTI|A\/L|A\/P)\b/i;
  const binAtEnd   = /\b(BIN|BINTI|A\/L|A\/P)\s*$/i;
  const binAtStart = /^\s*(BIN|BINTI|A\/L|A\/P)\b/i;

  // === 1. PRIORITY: BIN / BINTI ===
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const up = ln.toUpperCase();

    if (!binPattern.test(ln)) continue;
    if (isStateOnly(ln)) continue;
    if (!isValidName(ln)) continue;
    if (NOT_NAME_WORDS.some(w => up.includes(w))) continue;

    if (binAtEnd.test(ln) && lines[i + 1]) {
      const next = lines[i + 1];
      if (isValidName(next) && !isStateOnly(next)) {
        return `${ln} ${next}`.replace(/\s+/g, " ").trim();
      }
    }

    if (binAtStart.test(ln) && lines[i - 1]) {
      const prev = lines[i - 1];
      if (isValidName(prev) && !isStateOnly(prev)) {
        return `${prev} ${ln}`.replace(/\s+/g, " ").trim();
      }
    }

    return ln.trim();
  }

  // === 2. LABEL NAMA ===
  for (let i = 0; i < lines.length; i++) {
    if (/^(NAMA|NAME)$/i.test(lines[i])) {
      const cand = lines[i + 1];
      if (cand && isValidName(cand) && !isStateOnly(cand)) return cand.trim();
    }

    const m = lines[i].match(/^(NAMA|NAME)[\s:\/.-]+(.+)$/i);
    if (m && isValidName(m[2])) return m[2].trim();
  }

  // === 3. STRONG ALL CAPS (>= 2 perkataan) ===
  const strong = lines.filter(l => {
    const up = l.toUpperCase();
    return (
      l === up &&
      /^[A-Z \-']+$/.test(up) &&
      up.split(/\s+/).length >= 2 &&
      !isStateOnly(l) &&
      !NOT_NAME_WORDS.some(w => up.includes(w))
    );
  });
  if (strong[0]) return strong[0];

  // === 4. BEFORE IC NUMBER ===
  if (idnum) {
    const idx = lines.findIndex(l => l.replace(/\D/g, "") === idnum.replace(/\D/g, ""));
    if (idx > 0 && isValidName(lines[idx - 1])) {
      return lines[idx - 1];
    }
  }

  // === 5. FINAL FALLBACK ===
  const fallback = lines.filter(l =>
    isValidName(l) &&
    !isStateOnly(l) &&
    !NOT_NAME_WORDS.some(w => l.toUpperCase().includes(w))
  );
  return fallback[0] || "";
}

// =====================================================
function isValidName(str) {
  if (!str) return false;
  if (str.length < 4) return false;
  if ((str.match(/\d/g) || []).length > 3) return false;
  if (/^NAMA$|^NAME$/i.test(str)) return false;
  return true;
}

// =====================================================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
