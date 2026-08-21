export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response("", {
        headers: corsHeaders()
      });
    }

    try {
      if (request.method !== "POST") {
        return jsonResponse({
          error: true,
          message: "Method not allowed."
        }, 405);
      }

      // Parse JSON safely
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

      // Primary model uses ENV. Fallback only for temporary/high-demand errors.
      const PRIMARY_MODEL = (env.GEMINI_MODEL || "gemini-2.5-flash-lite").trim();
      const FALLBACK_MODEL = (env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite").trim();

      const requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [
              {
                text:
                  "You are an expert Security Registration AI. The image you receive is already cropped to the document guideline and enhanced for OCR. " +
                  "FIRST classify whether the image contains a usable identity document, THEN assess readability, THEN extract FULL NAME and IDENTITY NUMBER. " +
                  "Document rules: " +
                  "1. ID_DOCUMENT: a real identity/registration document is visibly present, such as MyKad, driving licence, passport, passport copy, student/staff ID, or another personal identification card/document containing identity details. " +
                  "2. NO_USABLE_DATA: the image is not an identity document, is an unrelated object/scene, or does not contain usable personal identity information. Examples include bottles, food packaging, tables, walls, vehicles, random printed text, receipts, or other non-ID objects. Do not call these images UNREADABLE merely because no identity data exists. " +
                  "3. If document is NO_USABLE_DATA, return empty name and idnum. " +
                  "Quality rules for ID_DOCUMENT only: " +
                  "4. READABLE: the document and important text are generally clear. " +
                  "5. PARTIAL: the document is still readable overall, but only a small local area or about 1-2 characters may be slightly blurred, faded, worn, or unclear. PARTIAL is acceptable. " +
                  "6. UNREADABLE: a real ID document is present, but most or all of the document is out of focus, motion-blurred, heavily obscured by glare/shadow, or important identity text cannot be read without substantial guessing. " +
                  "7. Do NOT reject an otherwise readable old MyKad, driving licence, passport, or passport copy only because 1-2 characters are slightly unclear. " +
                  "8. If quality is UNREADABLE, return empty name and idnum. Do not guess or reconstruct the identity. " +
                  "Extraction rules: " +
                  "9. Name: Extract the person's full name. Exclude words like MALAYSIA, ADDRESS, JANTINA. " +
                  "10. ID Number: Extract the main document number (MyKad, Passport, Driving License, Student/Staff ID). " +
                  "11. Ignore serial numbers, postcodes, or dates. " +
                  "12. For READABLE or PARTIAL ID documents, use only characters supported by the visible document. A small 1-2 character uncertainty is acceptable when the overall field remains confidently identifiable, but never invent a whole name or identity number from a broadly blurred image."
              }
            ]
          },
          contents: [
            {
              parts: [
                {
                  text: "Return strict JSON with document, quality, name and idnum. document must be ID_DOCUMENT or NO_USABLE_DATA. quality must be READABLE, PARTIAL, or UNREADABLE. For NO_USABLE_DATA, use quality UNREADABLE and return empty name/idnum."
                },
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
            temperature: 0.1,
            maxOutputTokens: 150,
            response_mime_type: "application/json",
            response_schema: {
              type: "OBJECT",
              properties: {
                document: {
                  type: "STRING",
                  enum: ["ID_DOCUMENT", "NO_USABLE_DATA"]
                },
                quality: {
                  type: "STRING",
                  enum: ["READABLE", "PARTIAL", "UNREADABLE"]
                },
                name: {
                  type: "STRING"
                },
                idnum: {
                  type: "STRING"
                }
              },
              required: ["document", "quality", "name", "idnum"]
            }
          }
        })
      };

      const { text: geminiText } = await fetchGeminiWithFallback(
        PRIMARY_MODEL,
        FALLBACK_MODEL,
        requestOptions
      );

      const data = JSON.parse(geminiText);

      if (data.error) {
        throw new Error(`Google Error: ${data.error.message}`);
      }

      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!aiText) {
        throw new Error("No candidate text was returned by Gemini.");
      }

      const result = JSON.parse(aiText);
      const documentType = normalizeDocumentType(result.document);
      const quality = normalizeQuality(result.quality, result.name, result.idnum);

      if (documentType === "NO_USABLE_DATA") {
        return jsonResponse({
          success: false,
          retake: false,
          noUsableData: true,
          document: "NO_USABLE_DATA",
          quality: "UNREADABLE",
          name: "",
          idnum: "",
          message: "No usable data was found in the image."
        }, 200);
      }

      if (quality === "UNREADABLE") {
        return jsonResponse({
          success: false,
          retake: true,
          document: "ID_DOCUMENT",
          quality,
          name: "",
          idnum: "",
          message: "ID image is not clear enough. Please take the photo again."
        }, 200);
      }

      return jsonResponse({
        success: true,
        retake: false,
        document: "ID_DOCUMENT",
        quality,
        name: cleanText(result.name),
        idnum: cleanIdNum(result.idnum),
        raw: "OCR Success"
      }, 200);

    } catch (err) {
      console.warn("OCR fallback:", err?.message || err);

      return jsonResponse({
        success: false,
        manual: true,
        message: "OCR service is temporarily unavailable. Please enter details manually."
      }, 200);
    }
  }
};

async function fetchGeminiWithFallback(primaryModel, fallbackModel, options) {
  try {
    return await fetchWithRetry(buildGeminiUrl(primaryModel), options, 2);

  } catch (err) {
    const canFallback = shouldFallbackToBackupModel(
      err,
      primaryModel,
      fallbackModel
    );

    if (!canFallback) {
      throw err;
    }

    console.warn(
      `Primary Gemini model failed (${primaryModel}). Switching to fallback model (${fallbackModel}). Reason: ${err.message}`
    );

    return await fetchWithRetry(buildGeminiUrl(fallbackModel), options, 2);
  }
}

function buildGeminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function shouldFallbackToBackupModel(err, primaryModel, fallbackModel) {
  if (!fallbackModel || fallbackModel === primaryModel) {
    return false;
  }

  const message = String(err?.message || "").toLowerCase();

  // Fallback only for temporary/model-capacity errors.
  // HTTP 400/401/403/404 should not switch model.
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

    if (res.ok) {
      return {
        res,
        text
      };
    }

    if (res.status === 429) {
      throw new Error(`Gemini HTTP 429: ${text}`);
    }

    const shouldRetry = [500, 503].includes(res.status);

    if (!shouldRetry || attempt === maxRetries) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    await new Promise(resolve => {
      setTimeout(resolve, Math.min(4000, 700 * Math.pow(2, attempt)));
    });
  }
}

function normalizeDocumentType(value) {
  const d = String(value || "").trim().toUpperCase();
  if (d === "ID_DOCUMENT" || d === "NO_USABLE_DATA") {
    return d;
  }

  // Conservative compatibility fallback: if the model omits the document label,
  // preserve the prior OCR path instead of falsely classifying a real ID as unrelated.
  return "ID_DOCUMENT";
}

function normalizeQuality(value, name, idnum) {
  const q = String(value || "").trim().toUpperCase();
  if (q === "READABLE" || q === "PARTIAL" || q === "UNREADABLE") {
    return q;
  }

  // Compatibility fallback if a model ever omits/varies the label:
  // usable extracted data remains acceptable; empty output is treated as unreadable.
  return (cleanText(name) || cleanIdNum(idnum)) ? "PARTIAL" : "UNREADABLE";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanIdNum(value) {
  let v = String(value || "")
    .toUpperCase()
    .trim();

  if (!v) {
    return "";
  }

  v = v
    .replace(/\b(PASSPORT\s*NO|MYKAD|IC\s*NO|NO\.)\b/gi, "")
    .replace(/[:;]/g, " ")
    .replace(/\s+/g, "")
    .trim();

  const digitsOnly = v.replace(/\D/g, "");

  if (digitsOnly.length === 12 && v.length < 15) {
    return `${digitsOnly.slice(0, 6)}-${digitsOnly.slice(6, 8)}-${digitsOnly.slice(8)}`;
  }

  return v
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 20);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json"
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
