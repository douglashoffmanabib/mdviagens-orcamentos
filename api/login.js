// Login do app interno. POST { senha } -> grava o cookie de acesso (30 dias).
// A senha pode ser trocada pela variável de ambiente SENHA_APP (padrão: 2508).

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const senha = String((body && body.senha) || '').trim();
  const certa = String(process.env.SENHA_APP || '2508');

  if (senha !== certa) return res.status(401).json({ error: 'Senha incorreta.' });

  const trintaDias = 60 * 60 * 24 * 30;
  res.setHeader('Set-Cookie',
    `md_auth=md-liberado-2508; Path=/; Max-Age=${trintaDias}; HttpOnly; Secure; SameSite=Lax`);
  return res.status(200).json({ ok: true });
};
