// Fotos, localização e avaliações REAIS do hotel a partir do NOME (Places API NEW).
// GET /api/hotel-photos?q=<nome do hotel + endereço>
// Resposta: { name, coordinates:{lat,lon}, rating, reviewsCount, reviews:[{who,bolhas,txt}], photoRefs:[...] }
//
// Variável de ambiente: GOOGLE_MAPS_API_KEY  (Google Cloud → "Places API (New)" ativada)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY não configurada.' });

  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Informe ?q=<nome do hotel>' });

  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.photos,places.reviews'
      },
      body: JSON.stringify({ textQuery: q, languageCode: 'pt-BR', maxResultCount: 1 })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'Erro na Places API', detail: t.slice(0, 600) });
    }

    const j = await r.json();
    const p = (j.places || [])[0];
    if (!p) return res.status(404).json({ error: 'Hotel não encontrado no Google', query: q });

    const photoRefs = (p.photos || []).map(ph => ph.name).slice(0, 10); // "places/XXX/photos/YYY"
    // prioriza avaliações positivas (4-5 estrelas), da maior para a menor
    const allrev = p.reviews || [];
    const positives = allrev.filter(r => (r.rating || 0) >= 4).sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const picked = (positives.length ? positives : allrev).slice(0, 3);
    const reviews = picked.map(rv => ({
      who: (rv.authorAttribution && rv.authorAttribution.displayName) || 'Hóspede',
      bolhas: rv.rating,
      txt: ((rv.text && rv.text.text) || '').slice(0, 240)
    }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      name: p.displayName && p.displayName.text,
      coordinates: p.location ? { lat: p.location.latitude, lon: p.location.longitude } : null,
      rating: p.rating || null,
      reviewsCount: p.userRatingCount || null,
      reviews,
      photoRefs
    });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao buscar o hotel', detail: String(e).slice(0, 300) });
  }
};
