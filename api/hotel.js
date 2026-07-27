// Backend Hotelbeds (Content API) — função serverless para Vercel.
// O navegador NUNCA fala direto com o Hotelbeds: ele chama esta função,
// que assina a requisição com a sua API Key + Secret (guardadas no servidor)
// e devolve só o que o orçamento precisa: nome, endereço, estrelas,
// coordenadas e fotos do hotel.
//
// Variáveis de ambiente (configure no painel da Vercel → Settings → Environment Variables):
//   HOTELBEDS_API_KEY   -> sua API Key da HBX/Hotelbeds
//   HOTELBEDS_SECRET    -> seu Secret
//   HOTELBEDS_BASE      -> (opcional) https://api.hotelbeds.com (produção, padrão)
//                          ou https://api.test.hotelbeds.com (test/sandbox)
//   HOTELBEDS_PHOTOS    -> (opcional) https://photos.hotelbeds.com/giata/bigger/ (padrão)
//   ALLOWED_ORIGIN      -> (opcional) domínio do seu site, ex.: https://orcamentos.mdviagens.com
//                          (padrão "*" — recomendável restringir ao seu domínio depois)

const crypto = require('crypto');

module.exports = async (req, res) => {
  // CORS — permite que a página do orçamento chame esta função
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const code = (req.query.code || '').toString().trim();
  if (!code) return res.status(400).json({ error: 'Informe ?code=<código do hotel Hotelbeds>' });

  const KEY    = process.env.HOTELBEDS_API_KEY;
  const SECRET = process.env.HOTELBEDS_SECRET;
  const BASE   = (process.env.HOTELBEDS_BASE   || 'https://api.hotelbeds.com').replace(/\/$/, '');
  const PHOTOS = (process.env.HOTELBEDS_PHOTOS || 'https://photos.hotelbeds.com/giata/bigger/');
  const lang   = (req.query.lang || 'ENG').toString().toUpperCase();

  if (!KEY || !SECRET) {
    return res.status(500).json({ error: 'Credenciais Hotelbeds não configuradas (HOTELBEDS_API_KEY / HOTELBEDS_SECRET).' });
  }

  // Assinatura exigida pelo Hotelbeds: SHA256(apiKey + secret + timestampEmSegundos)
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha256').update(KEY + SECRET + ts).digest('hex');

  const url = `${BASE}/hotel-content-api/1.0/hotels/${encodeURIComponent(code)}/details?language=${lang}&useSecondaryLanguage=false`;

  try {
    const r = await fetch(url, {
      headers: { 'Api-key': KEY, 'X-Signature': signature, 'Accept': 'application/json' }
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(r.status).json({ error: 'Erro na Hotelbeds', status: r.status, detail: detail.slice(0, 600) });
    }

    const data = await r.json();
    const h = data.hotel || {};

    const content = (v) => (v && typeof v === 'object' ? (v.content || '') : (v || ''));

    const images = (h.images || [])
      .slice()
      .sort((a, b) => (a.visualOrder || 999) - (b.visualOrder || 999))
      .map(im => PHOTOS + im.path)
      .filter((v, i, arr) => arr.indexOf(v) === i) // remove duplicadas
      .slice(0, 12);

    const out = {
      code: h.code,
      name: content(h.name),
      stars: parseInt(String(h.categoryCode || '').replace(/\D/g, ''), 10) || null,
      category: h.categoryCode || null,
      address: content(h.address),
      city: content(h.city),
      postalCode: h.postalCode || '',
      coordinates: h.coordinates
        ? { lat: h.coordinates.latitude, lon: h.coordinates.longitude }
        : null,
      description: content(h.description),
      phones: (h.phones || []).map(p => p.phoneNumber),
      images
    };

    // cache de 1 dia na borda da Vercel (as fotos/localização quase não mudam)
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json(out);

  } catch (e) {
    return res.status(500).json({ error: 'Falha ao consultar a Hotelbeds', detail: String(e).slice(0, 300) });
  }
};
