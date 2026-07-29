// Link curto: /o/:id  ->  busca o orçamento salvo e redireciona para a página montada.
// (rewrite em vercel.json: /o/:id -> /api/o?id=:id)

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
    const b64 = Buffer.from(val, 'utf8').toString('base64');
    // redireciona para a página montada, levando o id (para o botão Baixar PDF) e o ?print=1
    const q = '?id=' + encodeURIComponent(id) + (req.query.print ? '&print=1' : '');
    res.writeHead(302, { Location: '/orcamento.html' + q + '#' + b64 });
    res.end();
  } catch (e) {
    return res.status(500).send('Erro: ' + String(e).slice(0, 200));
  }
};
