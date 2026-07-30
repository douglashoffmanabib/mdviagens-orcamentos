// Extrai dados de vouchers/confirmações de fornecedores (PDF ou imagem) -> JSON do voucher MD Viagens.
// POST /api/voucher-extract   body: { arquivos:[{data,mime}] }  ->  { data: {...} }

// ---- Leitura tolerante do JSON devolvido pela IA (aceita texto em volta e conserta JSON cortado) ----
function repairJson(s) {
  let out = '', inStr = false, esc = false; const stack = [];
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (inStr && ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (!inStr) {
      if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    out += ch;
  }
  if (inStr) out += '"';
  let prev;
  do {
    prev = out;
    out = out.replace(/\s+$/, '').replace(/,$/, '').replace(/"[^"]*"\s*:\s*$/, '').replace(/,$/, '');
  } while (out !== prev);
  while (stack.length) out += stack.pop();
  return out;
}
function parseModelJson(text) {
  let s = String(text || '').trim();
  const i = s.indexOf('{'); if (i > 0) s = s.slice(i);
  const j = s.lastIndexOf('}');
  if (j > 0) { try { return JSON.parse(s.slice(0, j + 1)); } catch (e) {} }
  try { return JSON.parse(s); } catch (e) {}
  try { return JSON.parse(repairJson(s)); } catch (e) {}
  return null;
}

const SCHEMA = `Você é um extrator de vouchers de viagem. Recebe documentos (PDF/imagem) de confirmação de fornecedores (companhias aéreas, hotéis, locadoras, seguros) e devolve APENAS um JSON válido, sem texto fora do JSON.

Extraia fielmente. Use null quando não houver. NÃO invente dados.

{
  "localizador": "código principal da reserva (ex: 6M33D8)",
  "localizadorExterno": "localizador do fornecedor, se houver",
  "status": "ex: Confirmado / OK",
  "dataReserva": "DD/MM/AAAA",
  "titular": "nome do cliente titular",
  "passageiros": [ { "nome": "NOME COMPLETO", "nascimento": "DD/MM/AAAA ou null", "documento": "CPF/RG ou null" } ],
  "voos": [
    { "tipo": "ida"|"volta", "data": "DD/MM/AAAA", "cia": "ex: GOL", "iata": "código IATA da cia (GOL=G3, LATAM=LA, AZUL=AD)",
      "voo": "número do voo (ex: G3 1137)", "localizadorCia": "localizador da companhia, se houver",
      "de": "IATA origem", "deCidade": "cidade origem", "para": "IATA destino", "paraCidade": "cidade destino",
      "saida": "HH:MM", "chegada": "HH:MM", "bagagem": "texto sobre bagagem", "conexao": "texto ou 'Voo direto'" }
  ],
  "hotel": { "nome": "", "endereco": "", "telefone": "", "checkin": "DD/MM/AAAA", "horaCheckin": "ex: 15:00",
             "checkout": "DD/MM/AAAA", "horaCheckout": "ex: 12:00", "noites": número,
             "acomodacao": "ex: Quarto Standard (2 adultos)", "regime": "ex: Café da manhã / All inclusive" },
  "transfer": { "tipo": "", "trajeto": "", "data": "", "hora": "", "detalhe": "" },
  "carro": { "locadora": "", "categoria": "", "modelo": "", "transmissao": "", "portas": "", "arCondicionado": "",
             "retiradaLocal": "", "retiradaData": "DD/MM/AAAA HH:MM", "devolucaoLocal": "", "devolucaoData": "DD/MM/AAAA HH:MM",
             "condutor": "", "inclui": "o que a tarifa inclui" },
  "seguro": { "seguradora": "", "apolice": "", "plano": "", "periodo": "", "emergencia": "telefone 24h" },
  "politicaCancelamento": ["item 1", "item 2"],
  "informacoesImportantes": ["item 1", "item 2"]
}

Regras:
- Preencha só os blocos que existirem no documento; os demais devem ser null.
- Se houver vários documentos, combine tudo num único voucher (ex.: voo num arquivo e hotel em outro).
- Responda somente o JSON.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const arquivos = (body && Array.isArray(body.arquivos) ? body.arquivos : []).filter(a => a && a.data);
  if (!arquivos.length) return res.status(400).json({ error: 'Envie { arquivos }.' });

  const content = arquivos.map(a => {
    const mime = a.mime || 'application/pdf';
    return mime.indexOf('image/') === 0
      ? { type: 'image', source: { type: 'base64', media_type: mime, data: a.data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } };
  });
  content.push({ type: 'text', text: SCHEMA });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.EXTRACT_MODEL || 'claude-sonnet-5',
        max_tokens: 12000,
        messages: [{ role: 'user', content }, { role: 'assistant', content: '{' }]
      })
    });
    if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: 'Erro na IA', detail: t.slice(0, 500) }); }
    const out = await r.json();
    const text = '{' + (out.content || []).map(b => b.text || '').join('');
    const d = parseModelJson(text);
    if (!d) return res.status(502).json({ error: 'JSON inválido', detail: 'stop_reason=' + (out.stop_reason || '?') + ' | fim: ' + text.slice(-200), raw: text.slice(0, 600) });
    d.agente = { nome: 'Gabriela Aquino', telefone: '(31) 98365-1769', email: 'gabriela@mdviagens.com', whatsapp: '5531983651769' };
    return res.status(200).json({ data: d });
  } catch (e) {
    return res.status(500).json({ error: 'Falha na extração', detail: String(e).slice(0, 300) });
  }
};
