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

      const PRIMARY_MODEL = (env.GEMINI_MODEL || "gemini-3.1-flash-lite").trim();
      const FALLBACK_MODEL = (env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite").trim();

      /* ==================================================
         PASS 0 — PURE VISUAL QUALITY GATE
         IMPORTANT:
         - This pass judges blur/smear only.
         - It must NOT identify the document or read/guess text.
         - A broadly motion-blurred image is rejected BEFORE
           document classification or extraction can run.
      ================================================== */
      const normalizedFrontendQuality = normalizeFrontendQuality(frontendQuality);

      const visualOptions = buildVisualQualityRequestOptions(
        env.GEMINI_API_KEY,
        image,
        normalizedFrontendQuality
      );

      const visualData = await callGeminiJson(
        PRIMARY_MODEL,
        FALLBACK_MODEL,
        visualOptions
      );

      const visualQuality = normalizeVisualQuality(visualData.visualQuality);
      const motionBlur = visualData.motionBlur === true;
      const broadSmear = visualData.broadSmear === true;

      // Hard veto: whole-frame / broad motion blur must never reach OCR extraction,
      // even if a later model could infer or guess the visible words.
      if (visualQuality === "UNREADABLE" || motionBlur || broadSmear) {
        return jsonResponse({
          success: false,
          retake: true,
          noUsableData: false,
          document: "POSSIBLE_ID",
          quality: "UNREADABLE",
          name: "",
          idnum: "",
          message: "ID image is not clear enough. Please take the photo again."
        }, 200);
      }

      /* ==================================================
         PASS 1 — HARD DOCUMENT + READABILITY GATE
         IMPORTANT: this pass does NOT extract name/id.
         Extraction is impossible until this gate passes.
      ================================================== */
      const gateOptions = buildGateRequestOptions(
        env.GEMINI_API_KEY,
        image,
        normalizedFrontendQuality
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
      const confidence = normalizeExtractionConfidence(extractData.confidence);

      // V8 CONFIDENCE GATE:
      // Do not autofill when the extractor itself is uncertain.
      // A mostly clear document with only 1-2 slightly unclear characters may still
      // be CONFIDENT when there is one consistent reading. If there are multiple
      // plausible readings, several guessed characters, or reconstruction is needed,
      // confidence must be UNCERTAIN and no PII is returned to the frontend.
      if (confidence !== "CONFIDENT") {
        return jsonResponse({
          success: false,
          manual: true,
          retake: false,
          noUsableData: false,
          document: "ID_DOCUMENT",
          quality,
          confidence: "UNCERTAIN",
          name: "",
          idnum: "",
          message: "OCR could not read the identity details confidently. Please enter the details manually."
        }, 200);
      }

      // A confident autofill requires both key identity fields.
      // If either key field is missing, avoid partial autofill and fall back to manual entry.
      if (!name || !idnum) {
        return jsonResponse({
          success: false,
          manual: true,
          retake: false,
          noUsableData: false,
          document: "ID_DOCUMENT",
          quality,
          confidence: "UNCERTAIN",
          name: "",
          idnum: "",
          message: "OCR could not read the identity details confidently. Please enter the details manually."
        }, 200);
      }

      return jsonResponse({
        success: true,
        retake: false,
        noUsableData: false,
        document: "ID_DOCUMENT",
        quality,
        confidence: "CONFIDENT",
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

function buildVisualQualityRequestOptions(apiKey, image, frontendQuality) {
  const fq = frontendQuality || {};
  const qualityHint =
    "Frontend processed-image blur signal: " +
    "level=" + (fq.level || "UNKNOWN") +
    ", ratio=" + (Number.isFinite(fq.ratio) ? fq.ratio : "UNKNOWN") +
    ". Treat this only as supporting evidence. ";

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
            "You are a PURE VISUAL IMAGE-QUALITY INSPECTOR for a security OCR camera. " +
            "Judge ONLY optical readability and motion/focus quality of the processed guideline crop. " +
            "DO NOT identify the object, DO NOT decide whether it is an ID, DO NOT read or transcribe words, " +
            "DO NOT infer names/numbers, and DO NOT reward an image merely because you can guess what blurred text says. " +
            qualityHint +

            "Return visualQuality plus two booleans: motionBlur and broadSmear. " +

            "READABLE = most fine edges and character strokes are optically crisp enough for reliable OCR. " +
            "PARTIAL = image is generally crisp/readable, with only small local softness, wear, fade, or about 1-2 unclear characters/areas. " +
            "UNREADABLE = broad or whole-image optical degradation: camera shake, motion blur, directional streaking, ghosting, doubled edges, smeared text rows, strong out-of-focus softness, or widespread loss of fine detail. " +

            "motionBlur=true when directional streaking/ghosting/doubled edges from camera/object movement is visible across multiple areas. " +
            "broadSmear=true when a substantial portion of the image has smeared/soft detail rather than a small isolated patch. " +

            "HARD RULES: " +
            "1. If multiple text-like rows or fine-detail regions are visibly stretched/smeared in one direction, choose UNREADABLE and motionBlur=true. " +
            "2. If the whole card/page/object appears shaken or fine strokes merge together, choose UNREADABLE even if semantic content seems guessable. " +
            "3. PARTIAL is ONLY for mostly sharp images with limited local defects. It must never be used for whole-image motion blur. " +
            "4. Ignore the meaning of visible text completely; judge pixels/edges only."
        }]
      },
      contents: [{
        parts: [
          {
            text: "Inspect visual quality only. Return strict JSON. Do not read the text."
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
        maxOutputTokens: 60,
        response_mime_type: "application/json",
        response_schema: {
          type: "OBJECT",
          properties: {
            visualQuality: {
              type: "STRING",
              enum: ["READABLE", "PARTIAL", "UNREADABLE"]
            },
            motionBlur: { type: "BOOLEAN" },
            broadSmear: { type: "BOOLEAN" }
          },
          required: ["visualQuality", "motionBlur", "broadSmear"]
        }
      }
    })
  };
}

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
            "You are an expert Security Registration OCR extractor with a FINAL CONFIDENCE GATE. " +
            "A separate visual gate has already confirmed that this image is a personal identity document and is " + quality + ". " +

            "Extract only FULL NAME and the main IDENTITY NUMBER visible on the document. " +
            "Name rules: extract the person's full name; exclude labels such as MALAYSIA, ADDRESS, ALAMAT, JANTINA, NAME, NAMA. " +
            "ID rules: extract the main MyKad, passport, driving licence, student/staff ID, or equivalent identity-document number; ignore serial numbers, postcodes and dates. " +

            "You MUST also return confidence as CONFIDENT or UNCERTAIN. " +
            "CONFIDENT means the visible image supports one consistent reading of BOTH the full name and identity number. " +
            "A small local defect or about 1-2 slightly faded/blurred characters is acceptable as CONFIDENT ONLY when the surrounding visible characters and document structure support one clear, consistent reading with no realistic alternative. " +
            "UNCERTAIN means you would need to guess several characters, reconstruct a name/number from context, choose between two or more plausible readings, or any important part of the name/identity number is not visually supported. " +

            "HARD RULES: " +
            "1. Never invent or autocomplete an identity from familiarity, context, common names, number patterns, or likely spellings. " +
            "2. If several characters are unclear or multiple readings are plausible, set confidence=UNCERTAIN. " +
            "3. If confidence=UNCERTAIN, return empty strings for BOTH name and idnum. " +
            "4. Do not mark UNCERTAIN merely because 1-2 characters are slightly imperfect if there is still one visually supported reading. " +
            "5. Accuracy is more important than forcing an autofill."
        }]
      },
      contents: [{
        parts: [
          {
            text: "Extract name and idnum and judge confidence. Return strict JSON."
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
        maxOutputTokens: 170,
        response_mime_type: "application/json",
        response_schema: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            idnum: { type: "STRING" },
            confidence: {
              type: "STRING",
              enum: ["CONFIDENT", "UNCERTAIN"]
            }
          },
          required: ["name", "idnum", "confidence"]
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

function normalizeVisualQuality(value) {
  const v = String(value || "").trim().toUpperCase();
  if (v === "READABLE" || v === "PARTIAL" || v === "UNREADABLE") return v;
  return "UNREADABLE";
}

function normalizeExtractionConfidence(value) {
  const v = String(value || "").trim().toUpperCase();
  if (v === "CONFIDENT" || v === "UNCERTAIN") return v;
  return "UNCERTAIN";
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
