// Proxy de imagem do Google (Places API NEW) — mantém a GOOGLE_MAPS_API_KEY escondida.
// GET /api/place-photo?ref=<places/XXX/photos/YYY>&w=1200

module.exports = async (req, res) => {
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return res.status(500).send('GOOGLE_MAPS_API_KEY não configurada.');

  const ref = (req.query.ref || '').toString(); // ex: places/XXX/photos/YYY
  const w = parseInt(req.query.w, 10) || 1200;
  if (!ref) return res.status(400).send('Informe ?ref=');

  try {
    const url = 'https://places.googleapis.com/v1/' + ref + '/media?maxWidthPx=' + w + '&key=' + KEY;
    const r = await fetch(url); // segue redirect até a imagem
    if (!r.ok) return res.status(r.status).send('Falha ao carregar imagem');
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, s-maxage=604800, max-age=604800, immutable');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).send('Erro: ' + String(e).slice(0, 200));
  }
};
