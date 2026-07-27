// Salva um orçamento no Redis (Upstash) e devolve um id curto.
// POST /api/save   body: { data: { ...ORCAMENTO... } }  ->  { id }
// Variáveis (a integração Upstash da Vercel cria automaticamente):
//   KV_REST_API_URL / KV_REST_API_TOKEN  (ou UPSTASH_REDIS_REST_URL / _TOKEN)

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
  if (!r.ok) throw new Error('redis ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return (await r.json()).result;
}
function genId(n = 6) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST com { data }' });

  const { url, token } = creds();
  if (!url || !token) return res.status(500).json({ error: 'Armazenamento (Redis) não configurado.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const data = body && body.data;
  if (!data) return res.status(400).json({ error: 'Envie { data }.' });

  try {
    const id = genId();
    await redis(['SET', 'orc:' + id, JSON.stringify(data)]);
    const meta = {
      id,
      numero: data.numero || '',
      cliente: (data.cliente && data.cliente.nome) || '',
      titulo: (data.hero && data.hero.titulo) || '',
      destino: data.destinoResumo || '',
      criadoEm: Date.now()
    };
    await redis(['LPUSH', 'orc:index', JSON.stringify(meta)]);
    await redis(['LTRIM', 'orc:index', 0, 499]); // mantém os 500 mais recentes
    return res.status(200).json({ id });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao salvar', detail: String(e).slice(0, 300) });
  }
};
