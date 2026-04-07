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

      // Membaca daripada Cloudflare Secret yang anda namakan GEMINI_API_KEY
      const GEMINI_API_KEY = env.GEMINI_API_KEY; 
      const model = "gemini-1.5-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: "Anda adalah pakar OCR untuk dokumen Malaysia (MyKad, Lesen, Pasport). " +
                      "Ekstrak 'Nama Penuh' dan 'Nombor ID'. " +
                      "Abaikan teks lain seperti alamat atau negeri. " +
                      "Format output mestilah dalam JSON: {\"name\": \"...\", \"idnum\": \"...\"}. " +
                      "Jika MyKad, pastikan format idnum ada dash (contoh: 900101-10-5522)."
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
            response_mime_type: "application/json"
          }
        }),
      });

      const geminiData = await geminiRes.json();
      
      // Semak jika Gemini memulangkan ralat (contoh: API Key salah)
      if (geminiData.error) {
        throw new Error(geminiData.error.message);
      }

      const aiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const result = JSON.parse(aiContent);

      return new Response(JSON.stringify({
        name: result.name || "",
        idnum: result.idnum || "",
        raw: "Processed by Gemini 1.5 Flash"
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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
