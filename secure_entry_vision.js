export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response("", { headers: corsHeaders() });
    }

    try {
      if (request.method !== "POST") {
        return jsonResponse({
          error: true,
          message: "Method tidak dibenarkan."
        }, 405);
      }

      const bodyText = await request.text();
      if (!bodyText) {
        throw new Error("Tiada data imej diterima daripada peranti.");
      }

      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        throw new Error("Format JSON tidak sah.");
      }

      let { image } = payload;
      if (!image || typeof image !== "string") {
        throw new Error("Data imej tiada atau tidak sah.");
      }

      if (!env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY belum diset.");
      }

      const url = "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent";

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
                    "Extract only the person's full name and ID number from this identity document image. " +
                    "Return JSON only with this exact format: " +
                    "{\"name\":\"...\",\"idnum\":\"...\"}. " +
                    "Rules: " +
                    "1) name must be the full person name only; " +
                    "2) idnum must be the identification number only; " +
                    "3) do not include labels, explanations or markdown; " +
                    "4) if unsure, return empty string for the field."
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
            maxOutputTokens: 100,
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
        throw new Error(`Gemini HTTP ${geminiRes.status}: ${geminiText || "Tiada butiran ralat"}`);
      }

      if (!geminiText) {
        throw new Error("Google memulangkan respon kosong.");
      }

      let data;
      try {
        data = JSON.parse(geminiText);
      } catch {
        throw new Error("Respon Gemini bukan JSON yang sah.");
      }

      if (data.error) {
        throw new Error(`Google Error: ${data.error.message}`);
      }

      const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!aiText) {
        throw new Error("Tiada candidate text daripada Gemini.");
      }

      let result;
      try {
        result = JSON.parse(aiText);
      } catch {
        throw new Error("Output Gemini bukan JSON yang sah.");
      }

      return jsonResponse({
        name: cleanText(result.name || ""),
        idnum: cleanText(result.idnum || ""),
        raw: "OCR Berjaya"
      });

    } catch (err) {
      console.error("RALAT WORKER:", err.message);
      return jsonResponse({
        error: true,
        message: `Ralat: ${err.message}`
      }, 200);
    }
  }
};

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
