// Foto turística da cidade/destino (Unsplash) para a capa do orçamento.
// GET /api/city-photo?q=<cidade>  ->  { imagem, autor, autorLink }
// Variável de ambiente: UNSPLASH_ACCESS_KEY  (unsplash.com/developers)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const KEY = process.env.UNSPLASH_ACCESS_KEY;
  if (!KEY) return res.status(500).json({ error: 'UNSPLASH_ACCESS_KEY não configurada.' });

  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Informe ?q=<cidade>' });

  try {
    const url = 'https://api.unsplash.com/search/photos?orientation=landscape&per_page=1&content_filter=high&query='
      + encodeURIComponent(q);
    const r = await fetch(url, { headers: { Authorization: 'Client-ID ' + KEY } });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'Erro na Unsplash', detail: t.slice(0, 300) });
    }
    const j = await r.json();
    const p = (j.results || [])[0];
    if (!p) return res.status(404).json({ error: 'Sem foto para ' + q });

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      imagem: (p.urls && (p.urls.regular || p.urls.full || p.urls.raw)) || null,
      autor: p.user && p.user.name,
      autorLink: p.user && p.user.links && p.user.links.html
    });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao buscar a foto', detail: String(e).slice(0, 200) });
  }
};
