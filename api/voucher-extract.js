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

const SCHEMA = `Você é um extrator de vouchers de viagem. Recebe documentos (PDF/imagem) de confirmação de UM fornecedor (companhia aérea, hotel, locadora de carro OU seguradora) e devolve APENAS um JSON válido, sem texto fora do JSON.

PASSO 1 — Antes de preencher qualquer campo, identifique o TIPO do documento:
- "aereo": bilhete/confirmação de companhia aérea (tem número de voo, aeroportos de origem/destino, horário de embarque).
- "carro": voucher de LOCADORA de veículo (Localiza, Movida, Unidas, Hertz, Avis, Foco, etc. — tem local de RETIRADA e DEVOLUÇÃO do carro, categoria/modelo do veículo).
- "hotel": confirmação de hospedagem (check-in/check-out, nome do hotel).
- "seguro": apólice de seguro viagem.
- "transfer": traslado privativo/compartilhado.

PASSO 2 — Preencha SOMENTE a seção correspondente ao tipo identificado. As demais seções ficam null ou [] — NUNCA invente ou "encaixe" dados de um tipo em outro.
REGRA CRÍTICA: retirada/devolução de um CARRO NUNCA viram itens de "voos". Um voucher de locadora não tem voos — "voos" deve ser [] nesse caso, mesmo que o documento tenha datas e locais parecidos com um trecho de viagem.

Extraia fielmente o que estiver no documento. Use null quando não houver. NÃO invente dados.

{
  "localizador": "código principal da reserva (ex: 6M33D8)",
  "localizadorExterno": "localizador do fornecedor, se houver",
  "status": "ex: Confirmado / OK",
  "dataReserva": "DD/MM/AAAA",
  "titular": "nome do cliente titular",
  "grupo": true|false (true quando o documento indicar que é RESERVA DE GRUPO — ex.: "grupo", "reserva de grupo", "bloqueio de grupo"),
  "passageiros": [ { "nome": "NOME COMPLETO", "nascimento": "DD/MM/AAAA ou null", "documento": "CPF/RG ou null" } ],
  "voos": [ // APENAS se o documento for de companhia aérea (tipo="aereo"). Caso contrário: [].
    {
      "tipo": "ida" | "volta" | "trecho",
      "data": "DD/MM/AAAA",
      "de": "IATA origem", "deCidade": "cidade origem",
      "para": "IATA destino", "paraCidade": "cidade destino",
      "cia": "nome da companhia AÉREA (ex: GOL, LATAM, AZUL) — NUNCA o nome de uma locadora de carro",
      "iata": "código IATA da companhia (GOL=G3, LATAM=LA, AZUL=AD, AVIANCA=AV, COPA=CM)",
      "voo": "número do voo (ex: G3 1137)",
      "saida": "HH:MM", "chegada": "HH:MM",
      "conexao": "texto da conexão ou 'Voo direto'",
      "bagagem": "ex: 1 bagagem de mão 10kg",
      "localizadorCia": "localizador na companhia aérea, se aparecer"
    }
  ],
  "hotel": null | { // APENAS se tipo="hotel"
    "nome": "string", "endereco": "endereço completo", "telefone": "telefone do hotel",
    "checkin": "DD/MM/AAAA", "checkout": "DD/MM/AAAA", "horaCheckin": "HH:MM", "horaCheckout": "HH:MM",
    "noites": número, "acomodacao": "ex: Apartamento Duplo Standard", "regime": "ex: Café da manhã / All Inclusive"
  },
  "transfer": null | { "tipo": "ex: Privativo", "trajeto": "ex: Aeroporto -> Hotel", "data": "DD/MM/AAAA", "hora": "HH:MM", "detalhe": "observações" },
  "carro": null | { // APENAS se tipo="carro". Se preencher "carro", "voos" DEVE ser [].
    "locadora": "string", "categoria": "string", "modelo": "string",
    "retiradaLocal": "string", "retiradaData": "DD/MM/AAAA HH:MM",
    "devolucaoLocal": "string", "devolucaoData": "DD/MM/AAAA HH:MM",
    "transmissao": "Automático/Manual", "arCondicionado": true|false, "portas": número, "inclui": "o que está incluso"
  },
  "seguro": null | { "seguradora": "string", "plano": "string", "apolice": "número da apólice", "periodo": "DD/MM a DD/MM", "emergencia": "telefone de emergência" },
  "politicaCancelamento": "texto da política, se houver",
  "informacoesImportantes": ["frases curtas com avisos importantes do documento"]
}

Regras:
- Responda somente o JSON, sem emojis e sem textos longos.
- Se o documento tiver vários trechos aéreos, inclua todos em "voos", em ordem cronológica.
- Um documento normalmente pertence a UM único fornecedor/tipo. Não crie voos, hotel ou seguro fictícios só para preencher o formato.`;

// Nomes de locadoras conhecidas — usado para blindar contra "voos" inventados a partir de um voucher de carro.
const LOCADORAS = ['localiza', 'movida', 'unidas', 'hertz', 'avis', 'foco', 'rentcars', 'budget', 'europcar', 'sixt', 'alamo', 'enterprise', 'thrifty', 'national'];
function pareceLocadora(nome) {
  const n = String(nome || '').toLowerCase();
  return LOCADORAS.some(l => n.includes(l));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST com { arquivos }' });

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });

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

  const model = process.env.EXTRACT_MODEL || 'claude-sonnet-5';
  const tentativas = [Number(process.env.EXTRACT_MAX_TOKENS) || 8000, 4096, 4000];
  let out = null, ultimoErro = '';

  try {
    for (const mt of tentativas) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: mt,
          messages: [{ role: 'user', content }]
        })
      });
      if (r.ok) { out = await r.json(); break; }
      ultimoErro = (await r.text() || '').slice(0, 600);
      if (!/max_tokens|too large|exceed/i.test(ultimoErro)) {
        return res.status(r.status).json({ error: 'Erro na IA', detail: ultimoErro });
      }
    }
    if (!out) return res.status(502).json({ error: 'Erro na IA', detail: ultimoErro });

    const text = (out.content || []).map(b => b.text || '').join('');
    const d = parseModelJson(text);
    if (!d) return res.status(502).json({ error: 'JSON inválido', detail: 'stop_reason=' + (out.stop_reason || '?') + ' | fim: ' + text.slice(-200), raw: text.slice(0, 600) });

    // Blindagem: se é claramente um voucher de CARRO, nenhum "voo" deveria ter sido preenchido.
    // Se a IA mesmo assim inventou "voos" usando o nome da locadora como companhia, descarta.
    if (d.carro && d.carro.locadora && Array.isArray(d.voos) && d.voos.length) {
      const inventado = d.voos.every(v => pareceLocadora(v.cia) || (!v.voo && !v.iata));
      if (inventado) d.voos = [];
    }

    d.agente = { nome: 'Gabriela Aquino', telefone: '(31) 98365-1769', email: 'gabriela@mdviagens.com', whatsapp: '5531983651769' };
    return res.status(200).json({ data: d });
  } catch (e) {
    return res.status(500).json({ error: 'Falha na extração', detail: String(e).slice(0, 300) });
  }
};
