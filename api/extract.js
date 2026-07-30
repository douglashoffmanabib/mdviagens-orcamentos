// Extrator de orçamento em PDF -> JSON estruturado (para alimentar o template).
// Como os PDFs de orçamento são IMAGENS (sem texto), usamos visão de IA:
// o PDF é enviado à API da Anthropic (Claude lê a página e devolve os dados).
//
// POST /api/extract   body JSON: { "pdfBase64": "<base64 do PDF>" }
// Resposta: { data: { ...ORCAMENTO... } }  no formato que o template consome.
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  -> sua chave da API da Anthropic (console.anthropic.com)
//   EXTRACT_MODEL      -> (opcional) modelo, padrão "claude-sonnet-5"

const AGENTE_FIXO = {
  nome: "Gabriela Aquino",
  telefone: "(31) 98365-1769",
  email: "gabriela@mdviagens.com",
  whatsapp: "5531983651769"
};

// Coordenadas dos aeroportos mais usados (o mapa de voo usa isto).
// Amplie livremente conforme aparecerem novos códigos.
const AIRPORTS = {
  CNF:[-19.6244,-43.9719], GRU:[-23.4356,-46.4731], CGH:[-23.6266,-46.6556], VCP:[-23.0074,-47.1345],
  SSA:[-12.9086,-38.3225], BPS:[-16.4386,-39.0808], MGF:[-23.4795,-52.0016], REC:[-8.1265,-34.9236],
  BSB:[-15.8697,-47.9208], BEL:[-1.3792,-48.4761], NAT:[-5.7681,-35.3762], JPA:[-7.1484,-34.9506],
  GIG:[-22.8100,-43.2506], SDU:[-22.9105,-43.1631], FOR:[-3.7763,-38.5326], CWB:[-25.5285,-49.1758],
  POA:[-29.9939,-51.1711], FLN:[-27.6705,-48.5525], IOS:[-14.8160,-39.0335], BOG:[4.7016,-74.1469],
  MDE:[6.1645,-75.4231], MED:[6.2447,-75.5748], ADZ:[12.5836,-81.7112], CTG:[10.4424,-75.5130]
};
const iataCoords = (c) => AIRPORTS[(c||"").toUpperCase()] || null;

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

const SCHEMA_PROMPT = `Você é um extrator de orçamentos de viagem. Recebe um PDF (imagem) de um orçamento de agência e devolve APENAS um JSON válido, sem comentários nem texto fora do JSON.

Extraia fielmente o que estiver no documento. Use null quando não houver a informação. NÃO invente dados.

Formato exato do JSON:
{
  "numero": "string (número do orçamento, ex: 4383884)",
  "cliente": { "nome": "string (nome do cliente/passageiro do título)", "telefone": "telefone do cliente se aparecer no documento (ex: (31) 99999-9999), senão null" },
  "destinoResumo": "string (cidade/UF principal do destino)",
  "pais": "país do destino (ex.: Brasil, Colômbia, Portugal)",
  "destinoBusca": "termo curto (2-3 palavras) de UM ÚNICO lugar para buscar uma FOTO turística no banco de imagens. REGRAS: (a) viagem para UMA cidade -> use a cidade + o traço icônico, ex.: 'Porto Seguro praia', 'Gramado inverno', 'Foz do Iguaçu cataratas'; (b) viagem por VÁRIAS cidades no EXTERIOR -> use o PAÍS, ex.: 'Colômbia paisagem', 'Portugal paisagem'; (c) viagem por VÁRIAS cidades no BRASIL -> use a cidade principal ou a região, ex.: 'Bahia praia', 'Serra Gaúcha'. NUNCA junte duas cidades no mesmo termo.",
  "destinoMensagem": "nome do destino para a mensagem de WhatsApp: a CIDADE quando for no Brasil; o PAÍS quando for fora do Brasil (ex.: 'Porto Seguro', 'Gramado', 'Colômbia', 'Portugal')",
  "voos": [
    {
      "rota": "Cidade origem → Cidade destino",
      "viajantes": "ex: 2 adultos",
      "trechos": [
        {
          "tipo": "ida" | "volta",
          "data": "DD/MM/AAAA",
          "de": "IATA origem (3 letras)", "deCidade": "cidade origem",
          "para": "IATA destino", "paraCidade": "cidade destino",
          "cia": "nome da companhia (ex: LATAM, GOL, AZUL)",
          "iata": "código IATA da companhia (LATAM=LA, GOL=G3, AZUL=AD, AVIANCA=AV)",
          "voo": "número do voo se aparecer (ex: G3 1137), senão null",
          "saida": "HH:MM", "chegada": "HH:MM", "dur": "ex: 4h15",
          "classe": "ex: Econômica",
          "conexao": "texto da conexão, ou 'Voo direto'",
          "bagagem": "ex: Não inclui bagagem despachada"
        }
      ]
    }
  ],
  "hoteis": [
    {
      "cidade": "cidade do hotel (importante em roteiros com mais de um hotel)",
      "nome": "string", "estrelas": número(1-5),
      "endereco": "string completo",
      "checkin": "DD/MM", "checkout": "DD/MM", "noites": número,
      "quartos": [ { "nome": "ex: Standard", "ocupacao": "ex: 2 adultos", "plano": "ex: All Inclusive", "restricao": "ex: Reembolsável até 7 dias antes", "reembolsavel": true|false } ],
      "tripadvisor": { "nota": número|null, "avaliacoes": número|null }
    }
  ],
  "transfer": null,
  "seguro": null | { "nome": "string", "plano": "string", "periodo": "string", "viajantes": "string" },
  "valores": {
    "totalNum": número (ex: 6906.51),
    "taxasInclusas": true|false,
    "parcelas": número (qtd de parcelas mensais iguais),
    "valorParcelaNum": número (valor de cada parcela mensal),
    "taxaUnicaNum": número|null (valor cobrado UMA vez junto com a 1ª parcela — normalmente as taxas de embarque, ex: 147.98)
  }
}

Regras:
- "hoteis" é SEMPRE uma lista. Se a viagem tiver MAIS DE UM hotel (roteiros por várias cidades), inclua TODOS, um item por hotel, na ordem cronológica, preenchendo "cidade". Se não houver hotel, use [].
- Parcelamento: quando o PDF disser algo como "10 x de BRL 675,85 + 1x 147,98", isso significa parcelas=10, valorParcelaNum=675.85, taxaUnicaNum=147.98. Se for só "10x de 675,85" sem valor extra, taxaUnicaNum=null.
- Números use ponto decimal (675.85), sem "R$".
- Se houver mais de um trecho aéreo (ida e volta), inclua ambos como itens de "trechos".
- Responda somente o JSON.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST com { pdfBase64 }' });

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  // aceita PDF e imagens. Formatos possíveis do corpo:
  //   { arquivos: [ { data:<base64>, mime:"application/pdf"|"image/png"|... }, ... ] }
  //   { pdfBase64List: [...] }  ou  { pdfBase64: "..." }  (compatibilidade)
  let arquivos = [];
  if (Array.isArray(body && body.arquivos)) arquivos = body.arquivos;
  else if (Array.isArray(body && body.pdfBase64List)) arquivos = body.pdfBase64List.map(d => ({ data: d, mime: 'application/pdf' }));
  else if (body && body.pdfBase64) arquivos = [{ data: body.pdfBase64, mime: 'application/pdf' }];
  arquivos = arquivos.filter(a => a && a.data);
  if (!arquivos.length) return res.status(400).json({ error: 'Envie { arquivos } (PDF ou imagem).' });

  const model = process.env.EXTRACT_MODEL || 'claude-sonnet-5';

  const content = arquivos.map(a => {
    const mime = a.mime || 'application/pdf';
    if (mime.indexOf('image/') === 0) {
      return { type: 'image', source: { type: 'base64', media_type: mime, data: a.data } };
    }
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } };
  });
  const merge = arquivos.length > 1
    ? '\n\nIMPORTANTE: os arquivos acima (PDFs e/ou imagens) são partes de UMA MESMA viagem (ex.: um traz o hotel e outro os voos; ou o voo de ida e o de volta separados). Combine TODAS as informações num ÚNICO orçamento: junte todos os voos em "voos" (ida e volta juntos), todos os hotéis, seguro, etc. No total, SOME os valores dos arquivos. Se só um arquivo trouxer o parcelamento, use o dele; se houver mais de um, some os totais e mantenha um parcelamento coerente.'
    : '';
  content.push({ type: 'text', text: SCHEMA_PROMPT + merge });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 12000,
        messages: [
          { role: 'user', content },
          { role: 'assistant', content: '{' }   // força a resposta a começar já no JSON
        ]
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: 'Erro na API Anthropic', detail: t.slice(0, 600) });
    }

    const out = await r.json();
    const text = '{' + (out.content || []).map(b => b.text || '').join('');
    const d = parseModelJson(text);
    if (!d) {
      return res.status(502).json({
        error: 'Não consegui interpretar o JSON do modelo',
        detail: 'stop_reason=' + (out.stop_reason || '?') + ' | fim: ' + text.slice(-200),
        raw: text.slice(0, 800)
      });
    }

    // Pós-processamento: monta o objeto no formato final do template.
    const data = enrich(d);
    return res.status(200).json({ data });

  } catch (e) {
    return res.status(500).json({ error: 'Falha na extração', detail: String(e).slice(0, 300) });
  }
};

// Enriquecimento: agente fixo, coordenadas dos aeroportos, mapa de voo, capa e resumo.
function enrich(d) {
  // hotéis: aceita lista (vários) ou objeto único (compatibilidade)
  let hoteis = Array.isArray(d.hoteis) ? d.hoteis.filter(h => h && h.nome)
             : (d.hotel && d.hotel.nome ? [d.hotel] : []);
  hoteis = hoteis.map(h => ({
    ...h,
    geo: null,                 // preenchido depois (Google Places) ou geocodificado
    fotos: [],                 // preenchidas pela API na página
    fotosFonte: 'Fotos reais do hotel',
    quartos: (h.quartos || []).map(q => ({ ...q, cor: q.reembolsavel ? 'green' : 'orange' }))
  }));
  const hotel = hoteis[0] || {};
  let voos = Array.isArray(d.voos) ? d.voos : [];

  // Consolida todos os trechos, ORDENA POR DATA (mais cedo = ida) e corrige o rótulo ida/volta.
  const parseDMY = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0; };
  let trechos = [];
  voos.forEach(v => { if (Array.isArray(v.trechos)) trechos.push(...v.trechos); });
  if (trechos.length) {
    trechos.sort((a, b) => parseDMY(a.data) - parseDMY(b.data));
    trechos.forEach((t, i) => { t.tipo = (i === 0 ? 'ida' : (i === trechos.length - 1 ? 'volta' : (t.tipo || 'ida'))); });
    const viaj = (voos[0] && voos[0].viajantes) || '';
    const rota = `${trechos[0].deCidade} → ${trechos[0].paraCidade}`;
    voos = [{ rota, viajantes: viaj, trechos }];
  }

  // mapa de voo a partir dos trechos
  const legs = trechos;
  const ida = legs.find(t => t.tipo === 'ida');
  const volta = legs.find(t => t.tipo === 'volta');
  const ponto = (iata, cidade) => {
    const c = iataCoords(iata);
    return c ? { nome: `${cidade || iata} (${iata})`, lat: c[0], lon: c[1] } : null;
  };
  const buildRoute = (t) => t ? [ponto(t.de, t.deCidade), ponto(t.para, t.paraCidade)].filter(Boolean) : [];
  const mapaVoo = {
    ida: ida ? { rota: `${ida.deCidade} → ${ida.paraCidade}`, pontos: buildRoute(ida) } : null,
    volta: volta ? { rota: `${volta.deCidade} → ${volta.paraCidade}`, pontos: buildRoute(volta) } : null
  };

  const noitesTotal = hoteis.reduce((a, h) => a + (parseInt(h.noites, 10) || 0), 0);
  const chips = [];
  if (ida && volta) chips.push(`📅 ${ida.data} → ${volta.data}`);
  if (noitesTotal) chips.push(`🌙 ${noitesTotal} noites`);
  if (hoteis.length > 1) chips.push(`🏨 ${hoteis.length} hotéis`);
  if (voos[0] && voos[0].viajantes) chips.push(`👥 ${voos[0].viajantes}`);
  if (hoteis.some(h => (h.quartos || []).some(q => /all inclusive|tudo incluso/i.test(q.plano || '')))) chips.push('🍽️ All Inclusive');

  const hoje = new Date().toLocaleDateString('pt-BR');

  return {
    numero: d.numero || '',
    agencia: { nome: 'MD Viagens · Milhas e Destinos' },
    agente: AGENTE_FIXO,
    cliente: d.cliente || { nome: '' },
    destinoResumo: d.destinoResumo || '',
    pais: d.pais || '',
    destinoBusca: d.destinoBusca || d.destinoResumo || '',
    destinoMensagem: d.destinoMensagem || (d.destinoResumo || '').split(',')[0].trim(),
    hero: {
      imagem: '', // preenchida depois pela foto do hotel (Hotelbeds) ou capa do destino
      eyebrow: `Orçamento Nº ${d.numero || ''}`,
      titulo: `${d.destinoResumo || (hotel.nome || 'Sua viagem')}`,
      sub: (voos[0] && voos[0].rota) || '',
      chips
    },
    resumo: [
      { k: 'Destino', v: d.destinoResumo || '' },
      { k: 'Período', v: hoteis.length ? `${hoteis[0].checkin || ''}–${hoteis[hoteis.length - 1].checkout || ''}` : (ida && volta ? `${ida.data}–${volta.data}` : '') },
      { k: 'Viajantes', v: (voos[0] && voos[0].viajantes) || '' },
      { k: hoteis.length > 1 ? 'Hotéis' : 'Noites', v: hoteis.length > 1 ? `${hoteis.length} · ${noitesTotal} noites` : (noitesTotal || '') }
    ],
    mapaVoo,
    voos,
    hoteis,                 // lista completa (1 ou vários hotéis)
    hotel: {
      ...hotel,
      geo: null, // sem coord no PDF -> o template geocodifica pelo endereço; com Hotelbeds vem exata
      fotos: [], // preenchidas pela API Hotelbeds no template
      fotosFonte: 'Fotos puxadas automaticamente da API Hotelbeds pelo código do hotel'
    },
    transfer: d.transfer || null,
    seguro: d.seguro || null,
    valores: {
      totalNum: (d.valores && d.valores.totalNum) || 0,
      taxasInclusas: !!(d.valores && d.valores.taxasInclusas),
      cotadoEm: hoje,
      parcelas: (d.valores && d.valores.parcelas) || null,
      valorParcelaNum: (d.valores && d.valores.valorParcelaNum) || null,
      taxaUnicaNum: (d.valores && d.valores.taxaUnicaNum) || null,
      obsPagamento: 'parcelamento no cartão · fatura direto da plataforma de viagens'
    }
  };
}
