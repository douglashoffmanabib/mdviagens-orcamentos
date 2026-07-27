// Lista os orçamentos salvos (mais recentes primeiro).
// GET /api/list  ->  [ { id, numero, cliente, titulo, destino, criadoEm }, ... ]

function creds() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  };
}
async function redis(cmd) {
  const { url, token } = creds();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  const { url, token } = creds();
  if (!url || !token) return res.status(500).json({ error: 'Armazenamento não configurado.' });
  try {
    const arr = await redis(['LRANGE', 'orc:index', 0, 100]);
    const list = (arr || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(list);
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao listar', detail: String(e).slice(0, 200) });
  }
};
