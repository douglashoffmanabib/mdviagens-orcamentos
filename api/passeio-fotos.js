// Fotos e opiniões REAIS de um passeio/ponto turístico a partir do nome (Places API NEW).
// GET /api/passeio-fotos?q=<nome do passeio, ex.: "Parque Xcaret, México">
// Resposta: { nome, fotos:[{url,thumb,credito}], opinioes:[{autor,nota,texto}] }
//
// Reaproveita a MESMA variável de ambiente já usada em hotéis e destinos: GOOGLE_MAPS_API_KEY
// As opiniões voltam SEMPRE filtradas pra nota 4 ou 5 (nunca negativas) — se não achar
// nenhuma opinião positiva, "opinioes" volta vazio (o front-end simplesmente não mostra a caixa).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY não configurada.' });

  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Informe ?q=<nome do passeio>' });

  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.photos,places.reviews,places.rating,places.userRatingCount'
      },
      body: JSON.stringify({ textQuery: q, languageCode: 'pt-BR', maxResultCount: 1 })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'Erro na Places API', detail: t.slice(0, 600) });
    }

    const j = await r.json();
    const p = (j.places || [])[0];
    if (!p) return res.status(404).json({ error: 'Passeio não encontrado no Google', query: q });

    const fotos = (p.photos || []).slice(0, 10).map(ph => ({
      url: '/api/place-photo?ref=' + encodeURIComponent(ph.name) + '&w=1600',
      thumb: '/api/place-photo?ref=' + encodeURIComponent(ph.name) + '&w=400',
      credito: 'Foto: Google Maps'
    }));

    // só opiniões positivas (4 ou 5 estrelas) — nunca mostramos avaliação negativa neste espaço
    const allrev = p.reviews || [];
    const positivas = allrev.filter(rv => (rv.rating || 0) >= 4).sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const opinioes = positivas.slice(0, 3).map(rv => ({
      autor: (rv.authorAttribution && rv.authorAttribution.displayName) || 'Viajante',
      nota: rv.rating || 5,
      texto: ((rv.text && rv.text.text) || '').slice(0, 260)
    }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      nome: p.displayName && p.displayName.text,
      fotos,
      opinioes
    });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao buscar o passeio', detail: String(e).slice(0, 300) });
  }
};
