// Link curto: /o/:id  ->  busca o orçamento salvo e redireciona para a página montada.
// (rewrite em vercel.json: /o/:id -> /api/o?id=:id)
//
// Exceção: quando quem está batendo é um "robô" de preview de link (WhatsApp, Facebook,
// Telegram, etc.), em vez de redirecionar devolvemos um HTML curto só com as tags Open
// Graph (título, descrição e a logo da MD Viagens), pra aparecer bonitinho como card com
// miniatura ao colar o link no WhatsApp. Pessoas de verdade continuam sendo redirecionadas
// normalmente pro orçamento.

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

const BOT_UA = /facebookexternalhit|WhatsApp|Twitterbot|TelegramBot|LinkedInBot|Slackbot|Discordbot|Pinterest|redditbot|Applebot|SkypeUriPreview|vkShare|Google-InspectionTool|W3C_Validator|Bitrix|Iframely|Embedly/i;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).send('Informe o id.');
  const { url, token } = creds();
  if (!url || !token) return res.status(500).send('Armazenamento não configurado.');

  try {
    const val = await redis(['GET', 'orc:' + id]); // string JSON do orçamento
    if (!val) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(404).send('<h2 style="font-family:sans-serif">Orçamento não encontrado.</h2>');
    }

    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers.host;
    const pageUrl = proto + '://' + host + '/o/' + id;
    const imageUrl = proto + '://' + host + '/og-md-viagens.jpg';

    // ---- Robôs de preview de link (WhatsApp, Facebook, etc.): devolve card com miniatura ----
    const ua = String(req.headers['user-agent'] || '');
    if (BOT_UA.test(ua)) {
      let destino = '', cliente = '';
      try {
        const data = JSON.parse(val);
        destino = data.destinoMensagem || data.destinoResumo || '';
        cliente = (data.cliente && data.cliente.nome) || '';
      } catch {}
      const titulo = 'MD Viagens' + (destino ? ' — Proposta para ' + destino : ' — Proposta de viagem');
      const descricao = cliente
        ? `Olá ${cliente}! Confira sua proposta de viagem com a MD Viagens.`
        : 'Confira sua proposta de viagem com a MD Viagens.';

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).send(`<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8">
<title>${escapeHtml(titulo)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="MD Viagens">
<meta property="og:title" content="${escapeHtml(titulo)}">
<meta property="og:description" content="${escapeHtml(descricao)}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${pageUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(titulo)}">
<meta name="twitter:description" content="${escapeHtml(descricao)}">
<meta name="twitter:image" content="${imageUrl}">
</head><body>
<a href="${pageUrl}">${escapeHtml(titulo)}</a>
</body></html>`);
    }

    // ---- Pessoa de verdade: redireciona para a página montada ----
    const b64 = Buffer.from(val, 'utf8').toString('base64');
    // leva o id (para o botão Baixar PDF) e o ?print=1
    const q = '?id=' + encodeURIComponent(id) + (req.query.print ? '&print=1' : '');
    res.writeHead(302, { Location: '/orcamento.html' + q + '#' + b64 });
    res.end();
  } catch (e) {
    return res.status(500).send('Erro: ' + String(e).slice(0, 200));
  }
};
