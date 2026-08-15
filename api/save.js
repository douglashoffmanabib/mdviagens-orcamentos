// Salva um orçamento no Redis (Upstash), gera código por tipo e link com nome do cliente.
// POST /api/save   body: { data: {...} }              -> cria um orçamento novo -> { id, codigo }
// POST /api/save   body: { data: {...}, editId: 'x' }  -> atualiza o orçamento existente 'x' no lugar
//                                                          (mesmo link/PDF/WhatsApp), guardando a versão
//                                                          anterior para poder restaurar depois.
// POST /api/save   body: { revertId: 'x' }             -> restaura a versão anterior do orçamento 'x'
// GET  /api/save?id=x                                  -> devolve os dados brutos salvos ({ data })
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

// tira a entrada 'id' de orc:index e devolve a lista restante (mantendo a ordem: mais recente primeiro)
async function removerDoIndice(id) {
  const raw = await redis(['LRANGE', 'orc:index', 0, 999]);
  const kept = (raw || []).filter(s => {
    try { return JSON.parse(s).id !== id; } catch { return true; }
  });
  await redis(['DEL', 'orc:index']);
  // recoloca do mais antigo pro mais novo, já que LPUSH empilha na frente
  for (let i = kept.length - 1; i >= 0; i--) await redis(['LPUSH', 'orc:index', kept[i]]);
  return kept;
}

async function empurrarIndice(meta) {
  await redis(['LPUSH', 'orc:index', JSON.stringify(meta)]);
  await redis(['LTRIM', 'orc:index', 0, 999]);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { url, token } = creds();
  if (!url || !token) return res.status(500).json({ error: 'Armazenamento (Redis) não configurado.' });

  // ---- GET: devolve os dados brutos salvos de um orçamento (usado pela edição) ----
  if (req.method === 'GET') {
    const id = (req.query.id || '').toString().trim();
    if (!id) return res.status(400).json({ error: 'Informe o id.' });
    try {
      const val = await redis(['GET', 'orc:' + id]);
      if (!val) return res.status(404).json({ error: 'Orçamento não encontrado.' });
      return res.status(200).json({ data: JSON.parse(val) });
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao buscar', detail: String(e).slice(0, 300) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use GET ?id= ou POST com { data }' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  // ---- POST revertId: restaura a versão anterior de um orçamento já editado ----
  if (body && body.revertId) {
    const id = String(body.revertId);
    try {
      const backupRaw = await redis(['GET', 'orc:' + id + ':anterior']);
      if (!backupRaw) return res.status(404).json({ error: 'Não há versão anterior salva para este orçamento.' });
      const atualRaw = await redis(['GET', 'orc:' + id]);
      if (atualRaw) await redis(['SET', 'orc:' + id + ':refeito', atualRaw]); // não perde a versão redone
      const restored = JSON.parse(backupRaw);
      restored.avisoRevert = true; // mostra o banner "voltando ao original" na página
      await redis(['SET', 'orc:' + id, JSON.stringify(restored)]);
      return res.status(200).json({ id, codigo: restored.codigo || '' });
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao restaurar', detail: String(e).slice(0, 300) });
    }
  }

  const data = body && body.data;
  if (!data) return res.status(400).json({ error: 'Envie { data }.' });

  // ---- POST editId: atualiza um orçamento existente no lugar (mesmo link/PDF/WhatsApp) ----
  const editId = body.editId ? String(body.editId) : '';
  if (editId) {
    try {
      const existingRaw = await redis(['GET', 'orc:' + editId]);
      if (existingRaw) {
        await redis(['SET', 'orc:' + editId + ':anterior', existingRaw]); // guarda a versão pré-edição
        const existing = JSON.parse(existingRaw);
        data.codigo = existing.codigo;
        data.hero = data.hero || {};
        data.hero.eyebrow = 'Orçamento ' + existing.codigo;
        delete data.avisoRevert;

        await redis(['SET', 'orc:' + editId, JSON.stringify(data)]);

        await removerDoIndice(editId); // evita linha duplicada no histórico
        const tipo = tipoDoOrcamento(data);
        const meta = {
          id: editId, codigo: existing.codigo, tipo,
          cliente: (data.cliente && data.cliente.nome) || '',
          telefone: (data.cliente && data.cliente.telefone) || '',
          destinoMsg: data.destinoMensagem || data.destinoResumo || '',
          titulo: (data.hero && data.hero.titulo) || '',
          destino: data.destinoResumo || '',
          criadoEm: Date.now()
        };
        await empurrarIndice(meta);

        return res.status(200).json({ id: editId, codigo: existing.codigo, tipo });
      }
      // se o id informado não existir mais, cai para o fluxo normal de criação abaixo
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao editar', detail: String(e).slice(0, 300) });
    }
  }

  // ---- POST normal: cria um orçamento novo ----
  try {
    const tipo = tipoDoOrcamento(data);
    const seq = await redis(['INCR', 'seq:' + tipo]);
    const codigo = tipo + String(seq).padStart(5, '0'); // ex.: PCT00042

    data.codigo = codigo;
    data.hero = data.hero || {};
    data.hero.eyebrow = 'Orçamento ' + codigo;

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
    await empurrarIndice(meta);

    return res.status(200).json({ id, codigo });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao salvar', detail: String(e).slice(0, 300) });
  }
};
