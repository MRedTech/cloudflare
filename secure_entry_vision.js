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

      const bodyText = await request.text();
      if (!bodyText) {
        throw new Error("No image data was received from the device.");
      }

      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new Error("Invalid JSON format.");
      }

      let { image } = payload;
      if (!image || typeof image !== "string") {
        throw new Error("Image data is missing or invalid.");
      }

      if (!env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set.");
      }

      const MODEL = (env.GEMINI_MODEL || "gemini-2.5-flash-lite").trim();
      const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent`;

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text:
                    "You are extracting data from an identity document image. " +
                    "Return JSON only with this exact format: " +
                    "{\"name\":\"...\",\"idnum\":\"...\"}. " +
                    "Rules for name: " +
                    "1) Extract only the person's full name. " +
                    "2) Do NOT include address, city, state, country, postcode, nationality, religion, gender, birth date, expiry date, issue date, document labels, document titles, or any other non-name text. " +
                    "3) Do NOT return words like MALAYSIA, MYKAD, PASSPORT, IDENTITY CARD, DRIVING LICENCE, DRIVING LICENSE, LESEN MEMANDU, CITIZEN, ADDRESS, or state names as part of the name. " +
                    "4) If unsure, return an empty string for name. " +
                    "Rules for idnum: " +
                    "5) Extract only the main identity document number. This may be a MyKad number, passport number, or driving licence/license number. " +
                    "6) Do NOT include labels such as NO., NO K/P, NO. K/P, PASSPORT NO, PASSPORT NUMBER, LICENCE NO, LICENSE NO, IDENTITY CARD NO, or any explanation. " +
                    "7) If multiple numbers appear, choose the primary document number belonging to the document holder. " +
                    "8) Do NOT return address numbers, postcode, phone number, date of birth, expiry date, or random codes as idnum. " +
                    "9) Do not include markdown, code fences, or extra text. " +
                    "10) If unsure, return an empty string for the field."
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
            temperature: 0,
            maxOutputTokens: 120,
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
      });

      const geminiText = await geminiRes.text();

      if (!geminiRes.ok) {
        throw new Error(`Gemini HTTP ${geminiRes.status}: ${geminiText || "No error details provided."}`);
      }

      if (!geminiText) {
        throw new Error("Google returned an empty response.");
      }

      let data;
      try {
        data = JSON.parse(geminiText);
      } catch {
        throw new Error("Gemini response is not valid JSON.");
      }

      if (data.error) {
        throw new Error(`Google Error: ${data.error.message}`);
      }

      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiText) {
        throw new Error("No candidate text was returned by Gemini.");
      }

      let result;
      try {
        result = JSON.parse(aiText);
      } catch {
        throw new Error("Gemini output is not valid JSON.");
      }

      return jsonResponse({
        name: cleanText(result.name || ""),
        idnum: cleanIdNum(result.idnum || ""),
        raw: "OCR Success"
      });

    } catch (err) {
      console.error("WORKER ERROR:", err.message);
      return jsonResponse({
        error: true,
        message: `Error: ${err.message}`
      }, 200);
    }
  }
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanIdNum(value) {
  let v = String(value || "").toUpperCase().trim();
  if (!v) return "";

  v = v
    .replace(/\b(PASSPORT\s*NO|PASSPORT\s*NUMBER|PASSPORT|NO\.\s*K\/P|NO\s*K\/P|NO\s*KP|NO\.?\s*IC|IC\s*NO|MYKAD|IDENTITY\s*CARD\s*NO|IDENTITY\s*CARD|LICENCE\s*NO|LICENSE\s*NO|DRIVING\s*LICENCE|DRIVING\s*LICENSE|LESEN\s*MEMANDU|NO\.)\b/gi, " ")
    .replace(/[:;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const digitsOnly = v.replace(/\D/g, "");
  if (digitsOnly.length === 12) {
    return `${digitsOnly.slice(0, 6)}-${digitsOnly.slice(6, 8)}-${digitsOnly.slice(8)}`;
  }

  const mykadMatch = v.match(/\b(\d{6})-?(\d{2})-?(\d{4})\b/);
  if (mykadMatch) {
    return `${mykadMatch[1]}-${mykadMatch[2]}-${mykadMatch[3]}`;
  }

  v = v.replace(/[^A-Z0-9]/g, "");

  if (v.length > 20) {
    v = v.slice(0, 20);
  }

  return v;
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
