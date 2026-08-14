// Seletor de foto do destino.
// GET  /api/city-photos?q=<cidade>&pais=<opcional>[&alt=alternativas]
//      -> { oficial:{url,thumb,credito,link}|null, fotos:[{url,thumb,credito,link,categoria,categoriaLabel}], escolhida }
// POST /api/city-photos { cidade, url }                        -> grava a última foto escolhida (cache de conveniência)
// POST /api/city-photos { cidade, url, credito, link, oficial:true }  -> define a foto OFICIAL da cidade (permanente, sem prazo)
// POST /api/city-photos { cidade, oficial:false }               -> remove a foto oficial da cidade
//
// Fonte do banco: Unsplash (licença livre para uso comercial; crédito do fotógrafo vem junto).
// Cache em Redis:
//   foto:oficial:<slug>  -> foto pré-aprovada por você para aquela cidade (permanente, prioridade máxima)
//   foto:lista:<slug>    -> lista de fotos do banco para aquela cidade (7 dias)
//   foto:escolha:<slug>  -> última foto escolhida manualmente (sem prazo, é só conveniência de UI)
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
const CATEGORIAS_FULL = [
  { key: 'geral',       label: 'Geral',            suffix: '',                   n: 2 },
  { key: 'turistico',   label: 'Ponto turístico',  suffix: ' famous landmark',   n: 2 },
  { key: 'aerea',       label: 'Vista aérea',      suffix: ' aerial view drone', n: 2 },
  { key: 'noite',       label: 'Noite',            suffix: ' city night lights', n: 2 },
  { key: 'dia',         label: 'Dia',              suffix: ' city daytime',      n: 2 },
  { key: 'praia',       label: 'Praia',            suffix: ' beach',             n: 2 },
  { key: 'festa',       label: 'Vida noturna',     suffix: ' nightlife party',   n: 2 },
];
// versão reduzida: usada quando já existe foto oficial (só precisamos de um punhado de alternativas)
const CATEGORIAS_CURTA = [
  { key: 'geral',     label: 'Geral',           suffix: '',                 n: 2 },
  { key: 'turistico', label: 'Ponto turístico', suffix: ' famous landmark', n: 2 },
  { key: 'aerea',     label: 'Vista aérea',     suffix: ' aerial view drone', n: 2 },
];

async function unsplash(q, key, perPage) {
  const u = 'https://api.unsplash.com/search/photos?per_page=' + (perPage || 3) + '&orientation=landscape&content_filter=high'
    + '&query=' + encodeURIComponent(q) + '&client_id=' + key;
  const r = await fetch(u);
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results || []).map(p => ({
    id: p.id,
    url: p.urls && (p.urls.regular || p.urls.full),
    thumb: p.urls && (p.urls.small || p.urls.thumb),
    credito: (p.user && p.user.name) ? `Foto: ${p.user.name} / Unsplash` : 'Foto: Unsplash',
    link: p.links && p.links.html
  })).filter(f => f.url && f.id);
}

// Busca por categorias em paralelo, sempre combinando cidade + país (quando houver) pra evitar
// resultado de lugar homônimo (ex.: "Natal" cidade x a festa de Natal; "Paris" França x outra Paris).
// Dedup é feito pelo ID da foto no Unsplash (a URL pode variar entre chamadas mesmo pra mesma foto).
async function buscarPorCategorias(base, key, categorias, max, excluirIds) {
  const listas = await Promise.all(categorias.map(async c => {
    try {
      const fotos = await unsplash((base + c.suffix).trim(), key, c.n + 1);
      return fotos.slice(0, c.n + 1).map(f => ({ ...f, categoria: c.key, categoriaLabel: c.label }));
    } catch (e) { return []; }
  }));
  const vistos = new Set(excluirIds || []);
  const fotos = [];
  for (const lista of listas) {
    for (const f of lista) {
      if (vistos.has(f.id)) continue;
      vistos.add(f.id);
      fotos.push(f);
      if (fotos.length >= max) return fotos;
    }
  }
  return fotos;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // POST: grava a escolha (conveniência) OU define/remove a foto oficial
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const cidadeRaw = (body && body.cidade) || '';
    const pais = (body && body.pais) || '';
    if (!cidadeRaw) return res.status(400).json({ error: 'Envie { cidade, ... }' });
    const baseSlug = slug((pais && !cidadeRaw.toLowerCase().includes(pais.toLowerCase())) ? `${cidadeRaw}, ${pais}` : cidadeRaw);

    if (body.oficial === false) {
      await redis(['DEL', 'foto:oficial:' + baseSlug]);
      return res.status(200).json({ ok: true, removida: true });
    }
    if (body.oficial === true) {
      const url = body.url || '';
      if (!url) return res.status(400).json({ error: 'Envie { cidade, url, oficial:true }' });
      const payload = JSON.stringify({ url, thumb: body.thumb || url, credito: body.credito || 'Foto: Unsplash', link: body.link || '' });
      await redis(['SET', 'foto:oficial:' + baseSlug, payload]);
      return res.status(200).json({ ok: true, oficial: true });
    }
    // escolha simples (última foto usada nesta cidade, cache de conveniência)
    const url = body.url || '';
    if (!url) return res.status(400).json({ error: 'Envie { cidade, url }' });
    await redis(['SET', 'foto:escolha:' + slug(cidadeRaw), url]);
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

  const [oficialRaw, cacheLista, escolhida] = await Promise.all([
    redis(['GET', 'foto:oficial:' + s]),
    redis(['GET', 'foto:lista:' + s]),
    redis(['GET', 'foto:escolha:' + slug(q)])
  ]);

  let oficial = null;
  if (oficialRaw) { try { oficial = JSON.parse(oficialRaw); } catch (e) {} }

  // Se já tem lista de banco em cache, só monta a resposta (oficial + cache), sem gastar cota do Unsplash.
  if (cacheLista) {
    try {
      const fotos = JSON.parse(cacheLista);
      return res.status(200).json({ oficial, fotos, escolhida: escolhida || null, cache: true });
    } catch (e) {}
  }

  try {
    const excluirIds = oficial && oficial.url ? [] : []; // dedup por id feito abaixo; oficial não vem do Unsplash search então não tem id conhecido a priori
    const categorias = oficial ? CATEGORIAS_CURTA : CATEGORIAS_FULL;
    const max = oficial ? 5 : 9; // com oficial: 5 extras do banco. sem oficial: até 9 (+ fallback abaixo completa 10)
    let fotos = await buscarPorCategorias(base, KEY, categorias, max, excluirIds);

    // fallback: se veio pouca coisa (cidade pequena/pouco fotografada), tenta as alternativas antigas
    if (fotos.length < 4) {
      const alts = (req.query.alt || '').toString().split(',').map(x => x.trim()).filter(Boolean);
      const vistos = new Set(fotos.map(f => f.id));
      for (const a of alts) {
        if (fotos.length >= max) break;
        const mais = await unsplash(a, KEY, 4);
        for (const f of mais) {
          if (fotos.length >= max) break;
          if (vistos.has(f.id)) continue;
          vistos.add(f.id);
          fotos.push({ ...f, categoria: 'geral', categoriaLabel: 'Geral' });
        }
      }
    }

    // se a foto oficial por acaso também aparecer no banco (mesma URL), tira ela da lista de opções
    // pra não repetir a mesma imagem duas vezes na grade.
    if (oficial && oficial.url) fotos = fotos.filter(f => f.url !== oficial.url);

    if (fotos.length) await redis(['SET', 'foto:lista:' + s, JSON.stringify(fotos), 'EX', 604800]); // 7 dias
    return res.status(200).json({ oficial, fotos, escolhida: escolhida || null });
  } catch (e) {
    return res.status(500).json({ error: 'Falha na busca de fotos', detail: String(e).slice(0, 200) });
  }
};
