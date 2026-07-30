// Protege as páginas internas do app com senha (cookie).
// Os links dos clientes (/o/..., orcamento.html, PDFs) continuam abertos.

const COOKIE = 'md_auth';
const TOKEN = 'md-liberado-2508';

export const config = {
  matcher: [
    '/',
    '/index.html',
    '/extrair.html',
    '/voucher.html',
    '/historico.html',
    '/leads.html',
    '/api/extract',
    '/api/voucher-extract',
    '/api/save',
    '/api/list',
    '/api/leads'
  ]
};

export default function middleware(req) {
  const cookies = req.headers.get('cookie') || '';
  const ok = cookies.split(';').some(c => {
    const [k, v] = c.trim().split('=');
    return k === COOKIE && v === TOKEN;
  });
  if (ok) return; // deixa passar

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Acesso restrito. Entre com a senha.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }
  return Response.redirect(new URL('/login.html', req.url), 302);
}
