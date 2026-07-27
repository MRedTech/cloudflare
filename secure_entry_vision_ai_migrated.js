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

      // Cost-saving setup: use the lower-cost model as primary.
      // Fallback handles temporary capacity/rate-limit and model availability errors.
      const PRIMARY_MODEL = (env.GEMINI_MODEL || "gemini-3.1-flash-lite").trim();
      const FALLBACK_MODEL = (env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite").trim();
      const USAGE_LOG_ENABLED = String(env.GEMINI_USAGE_LOG || "true")
        .trim()
        .toLowerCase() !== "false";

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
                  "You are an expert Security Registration AI. Extract FULL NAME and IDENTITY NUMBER from the document. " +
                  "Guidelines: " +
                  "1. Name: Extract the person's full name. Exclude words like MALAYSIA, ADDRESS, JANTINA. " +
                  "2. ID Number: Extract the main document number (MyKad, Passport, Driving License, Student/Staff ID). " +
                  "3. Ignore serial numbers, postcodes, or dates. " +
                  "4. If unsure, return empty string."
              }
            ]
          },
          contents: [
            {
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
            }
          ],
          generationConfig: {
            // Keep reasoning and image-token usage low for simple OCR extraction.
            thinkingConfig: {
              thinkingLevel: "minimal"
            },
            mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
            maxOutputTokens: 150,
            response_mime_type: "application/json",
            response_schema: {
              type: "OBJECT",
              properties: {
                name: {
                  type: "STRING"
                },
                idnum: {
                  type: "STRING"
                }
              },
              required: ["name", "idnum"]
            }
          }
        })
      };

      const {
        text: geminiText,
        modelUsed,
        fallbackUsed
      } = await fetchGeminiWithFallback(
        PRIMARY_MODEL,
        FALLBACK_MODEL,
        requestOptions
      );

      const data = JSON.parse(geminiText);
      logGeminiUsage(data, modelUsed, fallbackUsed, USAGE_LOG_ENABLED);

      if (data.error) {
        throw new Error(`Google Error: ${data.error.message}`);
      }

      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!aiText) {
        throw new Error("No candidate text was returned by Gemini.");
      }

      const result = JSON.parse(aiText);

      return jsonResponse({
        name: cleanText(result.name),
        idnum: cleanIdNum(result.idnum),
        raw: "OCR Success"
      }, 200);

    } catch (err) {
      console.error("OCR request failed completely:", err?.message || err);

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
    const primaryResponse = await fetchWithRetry(
      buildGeminiUrl(primaryModel),
      options,
      2
    );

    return {
      ...primaryResponse,
      modelUsed: primaryModel,
      fallbackUsed: false
    };

  } catch (primaryError) {
    const canFallback = shouldFallbackToBackupModel(
      primaryError,
      primaryModel,
      fallbackModel
    );

    if (!canFallback) {
      throw primaryError;
    }

    console.warn(
      `Primary Gemini model failed (${primaryModel}). Switching to fallback model (${fallbackModel}). Reason: ${primaryError.message}`
    );

    try {
      const fallbackResponse = await fetchWithRetry(
        buildGeminiUrl(fallbackModel),
        options,
        2
      );

      console.info(`Gemini fallback model succeeded (${fallbackModel}).`);
      return {
        ...fallbackResponse,
        modelUsed: fallbackModel,
        fallbackUsed: true
      };

    } catch (fallbackError) {
      console.error(
        `Gemini OCR failed on both models. Primary: ${primaryModel}. Fallback: ${fallbackModel}. Fallback reason: ${fallbackError.message}`
      );
      throw fallbackError;
    }
  }
}

function buildGeminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function shouldFallbackToBackupModel(err, primaryModel, fallbackModel) {
  if (!fallbackModel || fallbackModel === primaryModel) {
    return false;
  }

  const status = Number(err?.status || 0);
  const message = String(err?.message || "").toLowerCase();

  // Temporary capacity, service and rate-limit errors.
  if ([429, 500, 503].includes(status)) {
    return true;
  }

  // Some older errors may not carry a numeric status property.
  if (
    message.includes("http 429") ||
    message.includes("http 500") ||
    message.includes("http 503") ||
    message.includes("overloaded") ||
    message.includes("high demand")
  ) {
    return true;
  }

  // HTTP 404 may fall back only when the model itself is unavailable,
  // retired, unsupported for the project, or not found.
  if (status === 404 || message.includes("http 404")) {
    return (
      message.includes("no longer available") ||
      message.includes("not available to new users") ||
      message.includes("model is not available") ||
      message.includes("model not found") ||
      message.includes("models/") && message.includes("not found")
    );
  }

  return message.includes("temporarily unavailable");
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
      throw createGeminiHttpError(res.status, text);
    }

    const shouldRetry = [500, 503].includes(res.status);

    if (!shouldRetry || attempt === maxRetries) {
      throw createGeminiHttpError(res.status, text);
    }

    await new Promise(resolve => {
      setTimeout(resolve, Math.min(4000, 700 * Math.pow(2, attempt)));
    });
  }
}

function createGeminiHttpError(status, responseText) {
  const error = new Error(`Gemini HTTP ${status}: ${responseText}`);
  error.status = status;
  return error;
}

function logGeminiUsage(data, modelUsed, fallbackUsed, enabled) {
  if (!enabled) {
    return;
  }

  const usage = data?.usageMetadata;

  if (!usage) {
    console.info("Gemini OCR usage metadata was not returned.", {
      modelUsed,
      fallbackUsed
    });
    return;
  }

  console.info("Gemini OCR token usage:", {
    modelUsed,
    fallbackUsed,
    promptTokenCount: Number(usage.promptTokenCount || 0),
    candidatesTokenCount: Number(usage.candidatesTokenCount || 0),
    thoughtsTokenCount: Number(usage.thoughtsTokenCount || 0),
    totalTokenCount: Number(usage.totalTokenCount || 0)
  });
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
