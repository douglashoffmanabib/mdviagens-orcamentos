// Seletor de foto do destino.
// GET  /api/city-photos?q=<cidade>&pais=<opcional>[&alt=alternativas]  -> { fotos:[{url,thumb,credito,link,categoria,categoriaLabel}], escolhida }
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

// Categorias buscadas em paralelo pra dar variedade de opções de capa.
// O "suffix" é somado à query (cidade + país) pra enviesar o resultado do Unsplash pro tipo certo de foto.
const CATEGORIAS = [
  { key: 'geral',       label: 'Geral',            suffix: '',                   n: 2 },
  { key: 'turistico',   label: 'Ponto turístico',  suffix: ' famous landmark',   n: 2 },
  { key: 'aerea',       label: 'Vista aérea',      suffix: ' aerial view drone', n: 2 },
  { key: 'noite',       label: 'Noite',            suffix: ' city night lights', n: 2 },
  { key: 'dia',         label: 'Dia',              suffix: ' city daytime',      n: 2 },
  { key: 'praia',       label: 'Praia',            suffix: ' beach',             n: 2 },
  { key: 'festa',       label: 'Vida noturna',     suffix: ' nightlife party',   n: 2 },
];

async function unsplash(q, key, perPage) {
  const u = 'https://api.unsplash.com/search/photos?per_page=' + (perPage || 3) + '&orientation=landscape&content_filter=high'
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

// Busca por categorias em paralelo, sempre combinando cidade + país (quando houver) pra evitar
// resultado de lugar homônimo (ex.: "Natal" cidade x a festa de Natal; "Paris" França x outra Paris).
async function buscarPorCategorias(base, key) {
  const listas = await Promise.all(CATEGORIAS.map(async c => {
    try {
      const fotos = await unsplash((base + c.suffix).trim(), key, c.n + 1);
      return fotos.slice(0, c.n).map(f => ({ ...f, categoria: c.key, categoriaLabel: c.label }));
    } catch (e) { return []; }
  }));
  const vistos = new Set();
  const fotos = [];
  for (const lista of listas) {
    for (const f of lista) {
      if (vistos.has(f.url)) continue;
      vistos.add(f.url);
      fotos.push(f);
    }
  }
  return fotos.slice(0, 10);
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
  const pais = (req.query.pais || '').toString().trim();
  const KEY = process.env.UNSPLASH_ACCESS_KEY;
  if (!KEY) return res.status(500).json({ error: 'UNSPLASH_ACCESS_KEY não configurada.' });
  // combina cidade + país na busca principal desde o início (evita confundir com lugar homônimo)
  const base = (pais && !q.toLowerCase().includes(pais.toLowerCase())) ? `${q}, ${pais}` : q;
  const s = slug(base);
  const [cacheLista, escolhida] = await Promise.all([
    redis(['GET', 'foto:lista:' + s]),
    redis(['GET', 'foto:escolha:' + slug(q)])
  ]);
  if (cacheLista) {
    try { return res.status(200).json({ fotos: JSON.parse(cacheLista), escolhida: escolhida || null, cache: true }); }
    catch (e) {}
  }
  try {
    let fotos = await buscarPorCategorias(base, KEY);
    // fallback: se veio pouca coisa (cidade pequena/pouco fotografada), tenta as alternativas antigas
    if (fotos.length < 4) {
      const alts = (req.query.alt || '').toString().split(',').map(x => x.trim()).filter(Boolean);
      for (const a of alts) {
        if (fotos.length >= 10) break;
        const mais = await unsplash(a, KEY, 4);
        for (const f of mais) {
          if (fotos.length >= 10) break;
          if (!fotos.some(x => x.url === f.url)) fotos.push({ ...f, categoria: 'geral', categoriaLabel: 'Geral' });
        }
      }
    }
    fotos = fotos.slice(0, 10);
    if (fotos.length) await redis(['SET', 'foto:lista:' + s, JSON.stringify(fotos), 'EX', 604800]); // 7 dias
    return res.status(200).json({ fotos, escolhida: escolhida || null });
  } catch (e) {
    return res.status(500).json({ error: 'Falha na busca de fotos', detail: String(e).slice(0, 200) });
  }
};
