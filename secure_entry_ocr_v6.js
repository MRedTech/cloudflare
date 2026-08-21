export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }

    try {
      if (request.method !== "POST") {
        return jsonResponse({
          error: true,
          message: "Method not allowed."
        }, 405);
      }

      const payload = await request.json().catch(() => {
        throw new Error("Invalid JSON format.");
      });

      const { image, frontendQuality } = payload;

      if (!image || typeof image !== "string") {
        throw new Error("Image data is missing or invalid.");
      }

      if (!env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set.");
      }

      const PRIMARY_MODEL = (env.GEMINI_MODEL || "gemini-2.5-flash-lite").trim();
      const FALLBACK_MODEL = (env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite").trim();

      /* ==================================================
         PASS 1 — HARD DOCUMENT + READABILITY GATE
         IMPORTANT: this pass does NOT extract name/id.
         Extraction is impossible until this gate passes.
      ================================================== */
      const gateOptions = buildGateRequestOptions(
        env.GEMINI_API_KEY,
        image,
        normalizeFrontendQuality(frontendQuality)
      );
      const gateData = await callGeminiJson(
        PRIMARY_MODEL,
        FALLBACK_MODEL,
        gateOptions
      );

      const documentClass = normalizeDocumentClass(gateData.documentClass);
      const readability = normalizeReadability(gateData.readability);

      // Clear non-ID/unrelated content must never reach extraction.
      if (documentClass === "NOT_ID") {
        return jsonResponse({
          success: false,
          retake: false,
          noUsableData: true,
          document: "NO_USABLE_DATA",
          quality: "NOT_APPLICABLE",
          name: "",
          idnum: "",
          message: "No usable data was found in the image."
        }, 200);
      }

      // A confirmed or possible personal-ID layout that is broadly unreadable
      // must be retaken. This includes motion blur even when OCR could guess text.
      if (
        (documentClass === "PERSONAL_ID" || documentClass === "POSSIBLE_ID") &&
        readability === "UNREADABLE"
      ) {
        return jsonResponse({
          success: false,
          retake: true,
          noUsableData: false,
          document: documentClass,
          quality: "UNREADABLE",
          name: "",
          idnum: "",
          message: "ID image is not clear enough. Please take the photo again."
        }, 200);
      }

      // If the image is only POSSIBLE_ID but is visually clear/partial and AI still
      // cannot confirm a personal identity document, do not OCR unrelated text.
      if (documentClass === "POSSIBLE_ID") {
        return jsonResponse({
          success: false,
          retake: false,
          noUsableData: true,
          document: "NO_USABLE_DATA",
          quality: readability,
          name: "",
          idnum: "",
          message: "No usable data was found in the image."
        }, 200);
      }

      /* ==================================================
         PASS 2 — EXTRACTION
         Runs ONLY after Pass 1 says the image is a usable ID.
      ================================================== */
      const quality = readability === "PARTIAL" ? "PARTIAL" : "READABLE";
      const extractOptions = buildExtractRequestOptions(env.GEMINI_API_KEY, image, quality);
      const extractData = await callGeminiJson(
        PRIMARY_MODEL,
        FALLBACK_MODEL,
        extractOptions
      );

      const name = cleanText(extractData.name);
      const idnum = cleanIdNum(extractData.idnum);

      if (!name && !idnum) {
        return jsonResponse({
          success: false,
          retake: false,
          noUsableData: true,
          document: "ID_DOCUMENT",
          quality,
          name: "",
          idnum: "",
          message: "No usable data was found in the image."
        }, 200);
      }

      return jsonResponse({
        success: true,
        retake: false,
        noUsableData: false,
        document: "ID_DOCUMENT",
        quality,
        name,
        idnum,
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

function buildGateRequestOptions(apiKey, image, frontendQuality) {
  const fq = frontendQuality || {};
  const qualityHint =
    "Frontend processed-image quality signal: " +
    "level=" + (fq.level || "UNKNOWN") +
    ", ratio=" + (Number.isFinite(fq.ratio) ? fq.ratio : "UNKNOWN") +
    ". This is only a secondary signal, not the final document decision. ";

  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text:
            "You are the visual safety gate for a security registration OCR system. " +
            "The image is already cropped to the camera guideline and enhanced/sharpened for OCR. " +
            "DO NOT extract, transcribe, infer, reconstruct, or output any name or identity number in this pass. " +
            qualityHint +
            "Return TWO independent classifications: documentClass and readability. " +

            "DOCUMENT CLASS rules: " +
            "PERSONAL_ID = clearly a personal identity document such as MyKad, driving licence, passport/passport copy, student/staff ID, or another personal identity card/document. " +
            "POSSIBLE_ID = the image is too blurred/obscured to confirm details, but the visual structure strongly resembles a personal ID: card/passport-like rectangle, portrait/photo zone, official identity layout, identity fields, or similar. Use this especially when blur prevents confident recognition. " +
            "NOT_ID = clearly unrelated content such as product packaging, bottles, food, labels, receipts, advertisements, books, boxes, walls, tables, vehicles, random printed text, screens, or ordinary scenes. Clear readable text on an unrelated object NEVER makes it an ID. " +

            "READABILITY rules: " +
            "READABLE = important identity text is generally clear. " +
            "PARTIAL = the document is readable overall but a small local area or about 1-2 characters may be faded, worn, slightly blurred, or unclear. " +
            "UNREADABLE = broad out-of-focus blur, motion blur, directional smearing/streaking/ghosting, heavy glare/shadow, or most important text cannot be read reliably. If multiple text lines show motion streaking or the whole document looks shaken, choose UNREADABLE even if you think you can guess the words. " +
            "NOT_APPLICABLE = only when documentClass is NOT_ID. " +

            "Critical precedence: judge whether the OBJECT/LAYOUT is personal-ID-like separately from whether its text is readable. " +
            "A blurred personal-ID-like card should be POSSIBLE_ID + UNREADABLE, not NOT_ID. " +
            "A clear unrelated product with text should be NOT_ID + NOT_APPLICABLE. " +
            "Do not use semantic guessability as evidence of readability."
        }]
      },
      contents: [{
        parts: [
          {
            text: "Classify only. Do not extract text. Return strict JSON."
          },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: image
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 70,
        response_mime_type: "application/json",
        response_schema: {
          type: "OBJECT",
          properties: {
            documentClass: {
              type: "STRING",
              enum: ["PERSONAL_ID", "POSSIBLE_ID", "NOT_ID"]
            },
            readability: {
              type: "STRING",
              enum: ["READABLE", "PARTIAL", "UNREADABLE", "NOT_APPLICABLE"]
            }
          },
          required: ["documentClass", "readability"]
        }
      }
    })
  };
}

function buildExtractRequestOptions(apiKey, image, quality) {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text:
            "You are an expert Security Registration OCR extractor. " +
            "A separate visual gate has already confirmed that this image is a personal identity document and is " + quality + ". " +
            "Extract only FULL NAME and the main IDENTITY NUMBER visible on the document. " +
            "Name rules: extract the person's full name; exclude labels such as MALAYSIA, ADDRESS, ALAMAT, JANTINA, NAME, NAMA. " +
            "ID rules: extract the main MyKad, passport, driving licence, student/staff ID, or equivalent identity-document number; ignore serial numbers, postcodes and dates. " +
            "For PARTIAL images, 1-2 slightly unclear characters are acceptable only when the overall field is strongly supported by the visible document. Do not invent a different whole name or identity number. " +
            "If a field cannot be supported by the visible image, return an empty string for that field."
        }]
      },
      contents: [{
        parts: [
          {
            text: "Extract name and idnum in strict JSON format."
          },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: image
            }
          }
        ]
      }],
      generationConfig: {
        temperature: 0,
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
}

async function callGeminiJson(primaryModel, fallbackModel, options) {
  const { text: geminiText } = await fetchGeminiWithFallback(
    primaryModel,
    fallbackModel,
    options
  );

  const data = JSON.parse(geminiText);

  if (data.error) {
    throw new Error(`Google Error: ${data.error.message}`);
  }

  const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!aiText) {
    throw new Error("No candidate text was returned by Gemini.");
  }

  return JSON.parse(aiText);
}

function normalizeFrontendQuality(value) {
  const v = value && typeof value === "object" ? value : {};
  const level = ["CLEAR", "BORDERLINE", "BLURRY", "SEVERE"].includes(String(v.level || "").toUpperCase())
    ? String(v.level).toUpperCase()
    : "UNKNOWN";

  const ratioNum = Number(v.ratio);

  return {
    level,
    ratio: Number.isFinite(ratioNum) ? Math.max(0, Math.min(10, ratioNum)) : null
  };
}

function normalizeDocumentClass(value) {
  const v = String(value || "").trim().toUpperCase();
  if (v === "PERSONAL_ID" || v === "POSSIBLE_ID" || v === "NOT_ID") return v;
  return "NOT_ID";
}

function normalizeReadability(value) {
  const v = String(value || "").trim().toUpperCase();
  if (v === "READABLE" || v === "PARTIAL" || v === "UNREADABLE" || v === "NOT_APPLICABLE") return v;
  return "UNREADABLE";
}

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
      return { res, text };
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

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanIdNum(value) {
  let v = String(value || "")
    .toUpperCase()
    .trim();

  if (!v) return "";

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
