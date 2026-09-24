// Fotos, localização e avaliações REAIS do hotel a partir do NOME (Places API NEW).
//
// Dois modos, pra evitar puxar o hotel errado quando existe mais de um com o mesmo nome:
//
//  1) BUSCA (sem placeId): GET /api/hotel-photos?q=<nome do hotel + endereço>
//     Devolve até 5 candidatos (sem baixar fotos completas ainda) pra agente escolher qual é:
//     { candidatos: [ { id, name, endereco, rating, reviewsCount, thumbRef } ] }
//
//  2) DETALHE (com placeId): GET /api/hotel-photos?placeId=<id do candidato escolhido>
//     Devolve os dados completos do hotel ESCOLHIDO (mesmo formato de antes):
//     { name, endereco, coordinates:{lat,lon}, rating, reviewsCount, reviews:[...], photoRefs:[...] }
//
// Quando a busca já devolve só 1 candidato (nome único, sem ambiguidade), o extrator pode pular
// direto pro modo detalhe com o id desse único candidato — sem precisar perguntar nada à agente.
//
// Variável de ambiente: GOOGLE_MAPS_API_KEY  (Google Cloud → "Places API (New)" ativada)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'GOOGLE_MAPS_API_KEY não configurada.' });

  const placeId = (req.query.placeId || '').toString().trim();

  try {
    // ---- modo DETALHE: já sei qual place é (a agente escolheu), busca tudo dele ----
    if (placeId) {
      const r = await fetch('https://places.googleapis.com/v1/' + placeId, {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': KEY,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,rating,userRatingCount,photos,reviews'
        }
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: 'Erro na Places API', detail: t.slice(0, 600) });
      }
      const p = await r.json();
      const photoRefs = (p.photos || []).map(ph => ph.name).slice(0, 10);
      const allrev = p.reviews || [];
      const positives = allrev.filter(rv => (rv.rating || 0) >= 4).sort((a, b) => (b.rating || 0) - (a.rating || 0));
      const picked = (positives.length ? positives : allrev).slice(0, 3);
      const reviews = picked.map(rv => ({
        who: (rv.authorAttribution && rv.authorAttribution.displayName) || 'Hóspede',
        bolhas: rv.rating,
        txt: ((rv.text && rv.text.text) || '').slice(0, 240)
      }));
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({
        name: p.displayName && p.displayName.text,
        endereco: p.formattedAddress || '',
        coordinates: p.location ? { lat: p.location.latitude, lon: p.location.longitude } : null,
        rating: p.rating || null,
        reviewsCount: p.userRatingCount || null,
        reviews,
        photoRefs
      });
    }

    // ---- modo BUSCA: lista candidatos pra agente escolher qual é o hotel certo ----
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Informe ?q=<nome do hotel> ou ?placeId=<id>' });

    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.photos'
      },
      body: JSON.stringify({ textQuery: q, languageCode: 'pt-BR', maxResultCount: 5 })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'Erro na Places API', detail: t.slice(0, 600) });
    }

    const j = await r.json();
    const places = j.places || [];
    if (!places.length) return res.status(404).json({ error: 'Hotel não encontrado no Google', query: q });

    const candidatos = places.map(p => ({
      id: p.id ? 'places/' + p.id : '',
      name: (p.displayName && p.displayName.text) || '',
      endereco: p.formattedAddress || '',
      rating: p.rating || null,
      reviewsCount: p.userRatingCount || null,
      thumbRef: (p.photos && p.photos[0] && p.photos[0].name) || ''
    })).filter(c => c.id);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ candidatos });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao buscar o hotel', detail: String(e).slice(0, 300) });
  }
};
