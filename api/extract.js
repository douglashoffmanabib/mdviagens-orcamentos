// Extrator de orçamento (PDF ou imagem) -> JSON estruturado que alimenta o template.
// Os orçamentos são imagens (sem texto), então usamos visão de IA.
//
// POST /api/extract   body: { arquivos: [ { data:<base64>, mime:"application/pdf"|"image/png" }, ... ] }
// Resposta: { data: { ...ORCAMENTO... } }
//
// Env: ANTHROPIC_API_KEY (obrigatória) · EXTRACT_MODEL (opcional) · EXTRACT_MAX_TOKENS (opcional)

const AGENTE_FIXO = {
  nome: "Gabriela Aquino",
  telefone: "(31) 98365-1769",
  email: "gabriela@mdviagens.com",
  whatsapp: "5531983651769"
};

// Coordenadas dos aeroportos mais usados (o mapa de voo usa isto).
const AIRPORTS = {
  CNF:[-19.6244,-43.9719], GRU:[-23.4356,-46.4731], CGH:[-23.6266,-46.6556], VCP:[-23.0074,-47.1345],
  SSA:[-12.9086,-38.3225], BPS:[-16.4386,-39.0808], MGF:[-23.4795,-52.0016], REC:[-8.1265,-34.9236],
  BSB:[-15.8697,-47.9208], BEL:[-1.3792,-48.4761], NAT:[-5.7681,-35.3762], JPA:[-7.1484,-34.9506],
  GIG:[-22.8100,-43.2506], SDU:[-22.9105,-43.1631], FOR:[-3.7763,-38.5326], CWB:[-25.5285,-49.1758],
  POA:[-29.9939,-51.1711], FLN:[-27.6705,-48.5525], IOS:[-14.8160,-39.0335], BOG:[4.7016,-74.1469],
  MDE:[6.1645,-75.4231], MED:[6.2447,-75.5748], ADZ:[12.5836,-81.7112], CTG:[10.4424,-75.5130],
  SMR:[11.1196,-74.2306], CLO:[3.5432,-76.3816], PEI:[4.8128,-75.7395], BAQ:[10.8896,-74.7808],
  LIS:[38.7756,-9.1354], OPO:[41.2481,-8.6814], MAD:[40.4719,-3.5626], BCN:[41.2971,2.0785],
  CDG:[49.0097,2.5479], FCO:[41.8003,12.2389], ATH:[37.9364,23.9445], JTR:[36.3992,25.4793],
  JNX:[37.0808,25.3681], MCO:[28.4312,-81.3081], MIA:[25.7959,-80.2870], JFK:[40.6413,-73.7781],
  EZE:[-34.8222,-58.5358], SCL:[-33.3930,-70.7858], PTY:[9.0714,-79.3835], LIM:[-12.0219,-77.1143],
  CUN:[21.0365,-86.8771], MVD:[-34.8384,-56.0308], AEP:[-34.5592,-58.4156]
};
const iataCoords = (c) => AIRPORTS[(c || "").toUpperCase()] || null;

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
          "iata": "código IATA da companhia (LATAM=LA, GOL=G3, AZUL=AD, AVIANCA=AV, COPA=CM)",
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
  "transfer": null | { "tipo": "string (ex: Privativo, Compartilhado, Regular)", "trajeto": "string (ex: Aeroporto -> Hotel e Hotel -> Aeroporto)", "detalhe": "observações do transfer se houver, senão null" },
  "seguro": null | { "nome": "string", "plano": "string", "periodo": "string", "viajantes": "string" },
  "extras": [ { "titulo": "string curto (ex: Passeio Cristo Redentor, City Tour, Ingresso Parque X)", "descricao": "o que está incluso nesse item, em uma frase" } ],
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
- "transfer" NÃO deve ficar null por padrão — leia o documento com atenção. Se o orçamento mencionar transfer incluso (privativo, compartilhado, regular, "aeroporto-hotel", "traslado", etc.), preencha o objeto com o que estiver disponível. Só use null quando o documento realmente não incluir transfer nenhum.
- "extras" deve conter APENAS passeios, ingressos, atividades, city tours ou outros itens que estejam EXPLICITAMENTE INCLUSOS no orçamento (ex.: "passeio X incluso", "com ingresso para Y", "city tour incluído"). NÃO liste itens opcionais, sugeridos, à venda separadamente ou "consulte disponibilidade" — esses NÃO entram em "extras". Se não houver nenhum item incluso desse tipo, use [].
- Parcelamento: quando o PDF disser algo como "10 x de BRL 675,85 + 1x 147,98", isso significa parcelas=10, valorParcelaNum=675.85, taxaUnicaNum=147.98. Se for só "10x de 675,85" sem valor extra, taxaUnicaNum=null.
- Números use ponto decimal (675.85), sem "R$".
- Se houver mais de um trecho aéreo (ida e volta), inclua ambos como itens de "trechos".
- Seja objetivo: nada de repetir informação nem escrever textos longos. Responda somente o JSON.`;

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
  // aceita PDF e imagens; formatos antigos continuam funcionando
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
    ? '\n\nIMPORTANTE: os arquivos acima (PDFs e/ou imagens) são partes de UMA MESMA viagem (ex.: um traz o hotel e outro os voos; ou o voo de ida e o de volta separados). Combine TODAS as informações num ÚNICO orçamento: junte todos os voos em "voos" (ida e volta juntos), todos os hotéis, transfer, seguro e extras. No total, SOME os valores dos arquivos. Se só um arquivo trouxer o parcelamento, use o dele; se houver mais de um, some os totais e mantenha um parcelamento coerente.'
    : '';
  content.push({ type: 'text', text: SCHEMA_PROMPT + merge });

  // Chamada à IA com tentativas: se o modelo recusar o max_tokens, tenta menor.
  const tentativas = [Number(process.env.EXTRACT_MAX_TOKENS) || 8000, 4096, 4000];
  let out = null, ultimoErro = '';
  try {
    for (const mt of tentativas) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          max_tokens: mt,
          messages: [{ role: 'user', content }]
        })
      });
      if (r.ok) { out = await r.json(); break; }
      ultimoErro = (await r.text() || '').slice(0, 600);
      // só vale a pena repetir se o problema for o tamanho pedido
      if (!/max_tokens|too large|exceed/i.test(ultimoErro)) {
        return res.status(r.status).json({ error: 'Erro na API Anthropic', detail: ultimoErro });
      }
    }
    if (!out) return res.status(502).json({ error: 'Erro na API Anthropic', detail: ultimoErro });

    const text = (out.content || []).map(b => b.text || '').join('');
    const d = parseModelJson(text);
    if (!d) {
      return res.status(502).json({
        error: 'Não consegui interpretar o JSON do modelo',
        detail: 'stop_reason=' + (out.stop_reason || '?') + ' | fim: ' + text.slice(-200),
        raw: text.slice(0, 800)
      });
    }

    return res.status(200).json({ data: enrich(d) });

  } catch (e) {
    return res.status(500).json({ error: 'Falha na extração', detail: String(e).slice(0, 300) });
  }
};

// ---------------- Enriquecimento: agente fixo, ida/volta na ordem certa, mapas, resumo ----------------
const parseDMY = (s) => {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/?(\d{2,4})?/);
  if (!m) return 0;
  const ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : new Date().getFullYear();
  return new Date(ano, Number(m[2]) - 1, Number(m[1])).getTime();
};

function enrich(d) {
  // ---- hotéis: sempre lista ----
  let hoteis = Array.isArray(d.hoteis) ? d.hoteis.filter(h => h && h.nome) : [];
  if (!hoteis.length && d.hotel && d.hotel.nome) hoteis = [d.hotel];
  hoteis = hoteis.map(h => {
    const quartos = Array.isArray(h.quartos) ? h.quartos : [];
    quartos.forEach(q => { q.cor = q.reembolsavel ? 'green' : 'orange'; });
    return { ...h, quartos, geo: h.geo || null, fotos: [], fotosFonte: '' };
  });

  // ---- voos: junta todos os trechos e ordena por data (o 1º é ida, o último é volta) ----
  const voosBrutos = Array.isArray(d.voos) ? d.voos : [];
  let trechos = [];
  voosBrutos.forEach(v => { (Array.isArray(v.trechos) ? v.trechos : []).forEach(t => trechos.push(t)); });
  trechos = trechos.filter(t => t && (t.de || t.para));
  trechos.sort((a, b) => parseDMY(a.data) - parseDMY(b.data));
  if (trechos.length) {
    trechos.forEach((t, i) => { t.tipo = (i === 0) ? 'ida' : (i === trechos.length - 1 ? 'volta' : (t.tipo || 'trecho')); });
  }
  const viajantes = (voosBrutos.find(v => v.viajantes) || {}).viajantes || '';
  const rota = trechos.length
    ? `${trechos[0].deCidade || trechos[0].de} → ${trechos[0].paraCidade || trechos[0].para}`
    : ((voosBrutos[0] && voosBrutos[0].rota) || '');
  const voos = trechos.length ? [{ rota, viajantes, trechos }] : [];

  // ---- mapa de voo (ida à esquerda, volta à direita) ----
  const ida = trechos[0] || null;
  const volta = trechos.length > 1 ? trechos[trechos.length - 1] : null;
  const ponto = (iata, cidade) => {
    const c = iataCoords(iata);
    return c ? { nome: `${cidade || iata} (${iata})`, lat: c[0], lon: c[1] } : null;
  };
  const buildRoute = (t) => t ? [ponto(t.de, t.deCidade), ponto(t.para, t.paraCidade)].filter(Boolean) : [];
  const mapaVoo = {
    ida: ida ? { rota: `${ida.deCidade || ida.de} → ${ida.paraCidade || ida.para}`, pontos: buildRoute(ida) } : null,
    volta: volta ? { rota: `${volta.deCidade || volta.de} → ${volta.paraCidade || volta.para}`, pontos: buildRoute(volta) } : null
  };

  // ---- chips do topo (sem emojis) ----
  const noitesTotal = hoteis.reduce((s, h) => s + (Number(h.noites) || 0), 0);
  const chips = [];
  if (ida && volta) chips.push(`${ida.data} a ${volta.data}`);
  else if (ida && ida.data) chips.push(ida.data);
  if (noitesTotal) chips.push(`${noitesTotal} noites`);
  if (hoteis.length > 1) chips.push(`${hoteis.length} hotéis`);
  if (viajantes) chips.push(viajantes);
  if (hoteis.some(h => (h.quartos || []).some(q => /all inclusive|tudo incluso/i.test(q.plano || '')))) chips.push('All Inclusive');

  const primeiro = hoteis[0] || {};
  const ultimo = hoteis[hoteis.length - 1] || {};
  const periodo = (ida && volta) ? `${ida.data} a ${volta.data}`
    : (primeiro.checkin && ultimo.checkout ? `${primeiro.checkin} a ${ultimo.checkout}` : '');

  const hoje = new Date().toLocaleDateString('pt-BR');
  const destino = d.destinoResumo || primeiro.cidade || primeiro.nome || 'Sua viagem';

  // extras/passeios inclusos — só entram os que vieram com título ou descrição preenchidos
  const extras = Array.isArray(d.extras)
    ? d.extras.filter(e => e && (e.titulo || e.descricao)).map(e => ({ titulo: e.titulo || '', descricao: e.descricao || '' }))
    : [];

  return {
    numero: d.numero || '',
    agencia: { nome: 'MD Viagens · Milhas e Destinos' },
    agente: AGENTE_FIXO,
    cliente: d.cliente || { nome: '' },
    pais: d.pais || '',
    destinoResumo: d.destinoResumo || '',
    destinoBusca: d.destinoBusca || d.destinoResumo || '',
    destinoMensagem: d.destinoMensagem || d.destinoResumo || '',
    hero: {
      imagem: '',
      eyebrow: d.numero ? `Orçamento Nº ${d.numero}` : 'Orçamento de viagem',
      titulo: destino,
      sub: rota,
      chips
    },
    resumo: [
      { k: 'Destino', v: d.destinoResumo || '' },
      { k: 'Período', v: periodo },
      { k: 'Viajantes', v: viajantes },
      { k: 'Noites', v: noitesTotal || '' }
    ],
    mapaVoo,
    voos,
    hoteis,
    hotel: hoteis[0] || null,
    transfer: d.transfer || null,
    seguro: d.seguro || null,
    extras,
    valores: {
      totalNum: (d.valores && d.valores.totalNum) || 0,
      taxasInclusas: !!(d.valores && d.valores.taxasInclusas),
      cotadoEm: hoje,
      parcelas: (d.valores && d.valores.parcelas) || null,
      valorParcelaNum: (d.valores && d.valores.valorParcelaNum) || null,
      taxaUnicaNum: (d.valores && d.valores.taxaUnicaNum) || null
    }
  };
}
