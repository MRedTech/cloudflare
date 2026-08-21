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

      const { image } = payload;

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
      const gateOptions = buildGateRequestOptions(env.GEMINI_API_KEY, image);
      const gateData = await callGeminiJson(
        PRIMARY_MODEL,
        FALLBACK_MODEL,
        gateOptions
      );

      const gate = normalizeGate(gateData.status);

      if (gate === "NO_USABLE_DATA") {
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

      if (gate === "ID_UNREADABLE") {
        return jsonResponse({
          success: false,
          retake: true,
          noUsableData: false,
          document: "ID_DOCUMENT",
          quality: "UNREADABLE",
          name: "",
          idnum: "",
          message: "ID image is not clear enough. Please take the photo again."
        }, 200);
      }

      /* ==================================================
         PASS 2 — EXTRACTION
         Runs ONLY after Pass 1 says the image is a usable ID.
      ================================================== */
      const quality = gate === "ID_PARTIAL" ? "PARTIAL" : "READABLE";
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

function buildGateRequestOptions(apiKey, image) {
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
            "The image is already cropped to the camera guideline and enhanced for OCR. " +
            "Your ONLY task in this pass is to classify the image. DO NOT read, transcribe, infer, reconstruct, or output any person's name or identity number. " +
            "Return exactly one status using these rules: " +
            "1. ID_READABLE: a personal identity document is visible and the important identity text is generally clear. Examples include MyKad, driving licence, passport or passport copy, student/staff ID, or another personal identity card/document. " +
            "2. ID_PARTIAL: it is clearly a personal identity document and the document is readable overall, but a small local area or about 1-2 characters may be faded, worn, slightly blurred, or unclear. Do not reject an otherwise readable old document for only 1-2 unclear characters. " +
            "3. ID_UNREADABLE: a personal ID document, card-like identity document, licence, passport page/copy, or strongly document-like identity layout is visible, BUT the image is broadly out of focus, motion-blurred, smeared, ghosted, shaken, heavily obscured by glare/shadow, or most important text cannot be read reliably. If multiple text lines show directional streaking/ghosting from camera movement, choose ID_UNREADABLE even if you think you could guess the words. " +
            "4. NO_USABLE_DATA: the image is clearly NOT a personal identity document. Examples: product packaging, bottles, food, labels, receipts, advertisements, books, boxes, walls, tables, vehicles, signs, random printed text, screens, or other unrelated objects/scenes. Clear readable words on an unrelated object NEVER make it an ID document. " +
            "5. Critical precedence rule: first decide whether the visual object/layout is an identity document or identity-document-like. If yes but broadly blurred, choose ID_UNREADABLE, NOT NO_USABLE_DATA. If it is clearly an unrelated object even with sharp text, choose NO_USABLE_DATA. " +
            "6. Never use your ability to infer likely words as evidence that a blurred image is readable. Judge visible image quality, not semantic guessability."
        }]
      },
      contents: [{
        parts: [
          {
            text: "Classify only. Do not extract any text. Return strict JSON with status only."
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
        maxOutputTokens: 40,
        response_mime_type: "application/json",
        response_schema: {
          type: "OBJECT",
          properties: {
            status: {
              type: "STRING",
              enum: ["ID_READABLE", "ID_PARTIAL", "ID_UNREADABLE", "NO_USABLE_DATA"]
            }
          },
          required: ["status"]
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

function normalizeGate(value) {
  const s = String(value || "").trim().toUpperCase();
  if (
    s === "ID_READABLE" ||
    s === "ID_PARTIAL" ||
    s === "ID_UNREADABLE" ||
    s === "NO_USABLE_DATA"
  ) {
    return s;
  }

  // Fail closed for unknown classifier output: do not extract identity data.
  return "ID_UNREADABLE";
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
