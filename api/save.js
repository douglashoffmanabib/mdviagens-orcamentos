// Salva um orçamento no Redis (Upstash), gera código por tipo e link com nome do cliente.
// POST /api/save   body: { data: {...} }  ->  { id, codigo }
//   id  = slug-do-cliente + código  (ex.: ricardo-heleno-pct00042)  -> vira /o/<id>
//   código = PCT/AER/HTL/SGR/CAR + número sequencial (ex.: PCT00042)

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

// remove acentos, espaços e símbolos -> "ricardo-heleno"
function slugify(s) {
  return (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cliente';
}

// define o tipo do orçamento pelos produtos presentes
function tipoDoOrcamento(d) {
  const hasAereo = Array.isArray(d.voos) && d.voos.some(v => v.trechos && v.trechos.length);
  const hasHotel = !!(d.hotel && d.hotel.nome);
  const hasSeguro = !!d.seguro;
  const hasCarro = !!d.carro; // reservado para locação de veículo (futuro)
  const count = [hasAereo, hasHotel, hasSeguro, hasCarro].filter(Boolean).length;
  if (count >= 2) return 'PCT';       // pacote
  if (hasAereo) return 'AER';         // só aéreo
  if (hasHotel) return 'HTL';         // só hotel
  if (hasSeguro) return 'SGR';        // só seguro
  if (hasCarro) return 'CAR';         // só carro
  return 'ORC';
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
    // código sequencial por tipo
    const tipo = tipoDoOrcamento(data);
    const seq = await redis(['INCR', 'seq:' + tipo]);
    const codigo = tipo + String(seq).padStart(5, '0'); // ex.: PCT00042

    // grava o código nos dados e na capa
    data.codigo = codigo;
    data.hero = data.hero || {};
    data.hero.eyebrow = 'Orçamento ' + codigo;

    // id do link = nome do cliente + código
    const id = slugify(data.cliente && data.cliente.nome) + '-' + codigo.toLowerCase();

    await redis(['SET', 'orc:' + id, JSON.stringify(data)]);
    const meta = {
      id, codigo, tipo,
      cliente: (data.cliente && data.cliente.nome) || '',
      telefone: (data.cliente && data.cliente.telefone) || '',
      destinoMsg: data.destinoMensagem || data.destinoResumo || '',
      titulo: (data.hero && data.hero.titulo) || '',
      destino: data.destinoResumo || '',
      criadoEm: Date.now()
    };
    await redis(['LPUSH', 'orc:index', JSON.stringify(meta)]);
    await redis(['LTRIM', 'orc:index', 0, 999]);

    return res.status(200).json({ id, codigo });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao salvar', detail: String(e).slice(0, 300) });
  }
};
