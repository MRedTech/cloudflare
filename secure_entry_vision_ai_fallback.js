export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }

    try {
      if (request.method !== "POST") {
        return jsonResponse({ error: true, message: "Method not allowed." }, 405);
      }

      // Parsing JSON dengan lebih selamat
      const payload = await request.json().catch(() => {
        throw new Error("Invalid JSON format.");
      });

      const { image } = payload;
      if (!image || typeof image !== "string") {
        throw new Error("Image data is missing or invalid.");
      }

      if (!env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set.");
      }

      // Primary model kekal guna ENV semasa. Fallback hanya digunakan untuk temporary/high-demand error.
      const PRIMARY_MODEL = (env.GEMINI_MODEL || "gemini-2.5-flash-lite").trim();
      const FALLBACK_MODEL = (env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite").trim();

      const requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          // SYSTEM INSTRUCTION: Arahan khusus untuk jadikan AI lebih "pintar"
          system_instruction: {
            parts: [{
              text: "You are an expert Security Registration AI. Extract FULL NAME and IDENTITY NUMBER from the document. " +
                    "Guidelines: " +
                    "1. Name: Extract the person's full name. Exclude words like MALAYSIA, ADDRESS, JANTINA. " +
                    "2. ID Number: Extract the main document number (MyKad, Passport, Driving License, Student/Staff ID). " +
                    "3. Ignore serial numbers, postcodes, or dates. " +
                    "4. If unsure, return empty string."
            }]
          },
          contents: [
            {
              parts: [
                { text: "Extract name and idnum in strict JSON format." },
                {
                  inline_data: {
                    mime_type: "image/jpeg",
                    data: image
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1, // Beri sedikit "ruang bernafas" untuk kad yang kabur
            maxOutputTokens: 150,
            response_mime_type: "application/json",
            response_schema: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                idnum: { type: "STRING" }
              },
              required: ["name", "idnum"]
            }
          }
        })
      };

      const { text: geminiText } = await fetchGeminiWithFallback(PRIMARY_MODEL, FALLBACK_MODEL, requestOptions);
      const data = JSON.parse(geminiText);

      if (data.error) throw new Error(`Google Error: ${data.error.message}`);

      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiText) throw new Error("No candidate text was returned by Gemini.");

      const result = JSON.parse(aiText);

      return jsonResponse({
        name: cleanText(result.name),
        idnum: cleanIdNum(result.idnum),
        raw: "OCR Success"
      });

    } catch (err) {
      console.error("WORKER ERROR:", err.message);
      const friendlyMessage = err.message.includes("429")
        ? "Too many requests. Please try again shortly."
        : err.message;
      return jsonResponse({ error: true, message: friendlyMessage }, 200);
    }
  }
};

async function fetchGeminiWithFallback(primaryModel, fallbackModel, options) {
  try {
    return await fetchWithRetry(buildGeminiUrl(primaryModel), options, 2);
  } catch (err) {
    const canFallback = shouldFallbackToBackupModel(err, primaryModel, fallbackModel);
    if (!canFallback) throw err;

    console.warn(`Primary Gemini model failed (${primaryModel}). Switching to fallback model (${fallbackModel}). Reason: ${err.message}`);
    return await fetchWithRetry(buildGeminiUrl(fallbackModel), options, 2);
  }
}

function buildGeminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function shouldFallbackToBackupModel(err, primaryModel, fallbackModel) {
  if (!fallbackModel || fallbackModel === primaryModel) return false;

  const message = String(err?.message || "").toLowerCase();

  // Fallback hanya untuk temporary/model-capacity errors. Error 400/401/403/404 tidak difallback.
  return (
    message.includes("http 500") ||
    message.includes("http 503") ||
    message.includes("unavailable") ||
    message.includes("overloaded") ||
    message.includes("high demand")
  );
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    const text = await res.text();
    if (res.ok) return { res, text };

    if (res.status === 429) throw new Error(`Gemini HTTP 429: ${text}`);
    const shouldRetry = [500, 503].includes(res.status);
    if (!shouldRetry || attempt === maxRetries) throw new Error(`HTTP ${res.status}: ${text}`);

    await new Promise(r => setTimeout(r, Math.min(4000, 700 * Math.pow(2, attempt))));
  }
}

function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function cleanIdNum(value) {
  let v = String(value || "").toUpperCase().trim();
  if (!v) return "";
  v = v.replace(/\b(PASSPORT\s*NO|MYKAD|IC\s*NO|NO\.)\b/gi, "").replace(/[:;]/g, " ").replace(/\s+/g, "").trim();

  const digitsOnly = v.replace(/\D/g, "");
  if (digitsOnly.length === 12 && v.length < 15) {
    return `${digitsOnly.slice(0, 6)}-${digitsOnly.slice(6, 8)}-${digitsOnly.slice(8)}`;
  }
  return v.replace(/[^A-Z0-9-]/g, "").slice(0, 20);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}
