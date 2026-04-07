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
      const GEMINI_API_KEY = env.GEMINI_API_KEY; 
      const model = "gemini-1.5-flash";
      
      // Menggunakan v1
      const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

      const geminiRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { 
                text: "Bertindak sebagai pakar OCR Dokumen Identiti (MyKad, Pasport Antarabangsa, Lesen Memandu). " +
                      "Tugas anda adalah mengekstrak 'name' dan 'idnum' dalam format JSON yang sah. " +
                      "\n\nLOGIK EKSTRAKSI:" +
                      "\n1. MYKAD/LESEN: Cari nombor 12-digit. Formatkan 'idnum' dengan dash (contoh: 900101-10-5522). Nama mestilah nama penuh pemegang." +
                      "\n2. PASSPORT: Kenalpasti bahagian bawah dokumen (MRZ). Ekstrak nombor pasport (biasanya bermula huruf + 8/9 digit) dan nama penuh. " +
                      "Buang simbol '<<' atau gelaran seperti 'MR/MRS'. Gunakan penaakulan jika teks di atas kabur tetapi MRZ jelas." +
                      "\n3. KUALITI RENDAH: Jika imej silau atau gelap, gunakan konteks sekeliling untuk meneka teks yang paling logik." +
                      "\n\nSYARAT OUTPUT (WAJIB):" +
                      "\n- HANYA pulangkan objek JSON: {\"name\": \"...\", \"idnum\": \"...\"}." +
                      "\n- Jangan berikan sebarang teks penjelasan, pengenalan, atau markdown." +
                      "\n- Jika gagal temui data, pulangkan: {\"name\": \"\", \"idnum\": \"\"}."
              },
              { 
                inline_data: { 
                  mime_type: "image/jpeg", 
                  data: image 
                } 
              }
            ]
          }]
        })
      }); // Kesilapan koma dibetulkan di sini

      const geminiData = await geminiRes.json();
      if (geminiData.error) throw new Error(geminiData.error.message);

      let aiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      
      // Pembersihan tag markdown sekiranya Gemini memulangkan ```json ... ```
      aiContent = aiContent.replace(/```json|```/g, "").trim();
      
      const result = JSON.parse(aiContent);

      return new Response(JSON.stringify({
        name: result.name || "",
        idnum: result.idnum || "",
        raw: "Processed by Gemini 1.5 Flash v1"
      }), {
        headers: { ...corsHeaders(), "Content-Type": "application/json" }
      });

    } catch (err) {
      console.error("RALAT WORKER:", err.message); 
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
