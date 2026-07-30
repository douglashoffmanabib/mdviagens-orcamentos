// Seletor de foto do destino.
// GET  /api/city-photos?q=<cidade>[&alt=alternativas]  -> { fotos:[{url,thumb,credito,link}], escolhida }
// POST /api/city-photos { cidade, url }                -> grava a foto escolhida para a cidade (cache)
//
// Fonte: Unsplash (licença livre para uso comercial; crédito do fotógrafo vem junto).
// Cache em Redis: lista de fotos por cidade (7 dias) e última escolha por cidade (sem prazo).

function creds() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  };
}
async function redis(cmd) {
  const { url, token } = creds();
  if (!url || !token) return null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    if (!r.ok) return null;
    return (await r.json()).result;
  } catch (e) { return null; }
}
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function unsplash(q, key) {
  const u = 'https://api.unsplash.com/search/photos?per_page=5&orientation=landscape'
    + '&query=' + encodeURIComponent(q) + '&client_id=' + key;
  const r = await fetch(u);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map(p => ({
    url: p.urls && (p.urls.regular || p.urls.full),
    thumb: p.urls && (p.urls.small || p.urls.thumb),
    credito: (p.user && p.user.name) ? `Foto: ${p.user.name} / Unsplash` : 'Foto: Unsplash',
    link: p.links && p.links.html
  })).filter(f => f.url);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // POST: grava a escolha
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const cidade = slug(body && body.cidade);
    const url = (body && body.url) || '';
    if (!cidade || !url) return res.status(400).json({ error: 'Envie { cidade, url }' });
    await redis(['SET', 'foto:escolha:' + cidade, url]);
    return res.status(200).json({ ok: true });
  }

  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Informe ?q=<cidade>' });
  const KEY = process.env.UNSPLASH_ACCESS_KEY;
  if (!KEY) return res.status(500).json({ error: 'UNSPLASH_ACCESS_KEY não configurada.' });

  const s = slug(q);
  const [cacheLista, escolhida] = await Promise.all([
    redis(['GET', 'foto:lista:' + s]),
    redis(['GET', 'foto:escolha:' + s])
  ]);

  if (cacheLista) {
    try { return res.status(200).json({ fotos: JSON.parse(cacheLista), escolhida: escolhida || null, cache: true }); }
    catch (e) {}
  }

  try {
    let fotos = await unsplash(q, KEY);
    // alternativas quando a busca principal não rende (ex.: país, destino resumido)
    if (fotos.length < 3) {
      const alts = (req.query.alt || '').toString().split(',').map(x => x.trim()).filter(Boolean);
      for (const a of alts) {
        if (fotos.length >= 5) break;
        const mais = await unsplash(a, KEY);
        for (const f of mais) {
          if (fotos.length >= 5) break;
          if (!fotos.some(x => x.url === f.url)) fotos.push(f);
        }
      }
    }
    fotos = fotos.slice(0, 5);
    if (fotos.length) await redis(['SET', 'foto:lista:' + s, JSON.stringify(fotos), 'EX', 604800]); // 7 dias
    return res.status(200).json({ fotos, escolhida: escolhida || null });
  } catch (e) {
    return res.status(500).json({ error: 'Falha na busca de fotos', detail: String(e).slice(0, 200) });
  }
};
