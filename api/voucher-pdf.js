// Voucher MD Viagens — layout novo.
// POST /api/voucher-pdf  body: { data:{...} } -> PDF (download)
// GET  /api/voucher-pdf?id=<localizador>      -> regenera o PDF salvo (reenvio)
//
// Regras: nunca exibe valores/tarifas/comissões/milhas. Identidade visual,
// caixa de atenção de grupo e rodapé são fixos; o resto vem dos dados.

const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');

/* ---------- Redis (reenvio pelo robô do WhatsApp / histórico) ---------- */
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

/* ---------- identidade visual ---------- */
const NAVY = rgb(0.086, 0.149, 0.29);
const GOLD = rgb(0.765, 0.627, 0.388);
const GREEN = rgb(0.145, 0.616, 0.333);
const RED = rgb(0.78, 0.13, 0.13);
const REDBG = rgb(0.99, 0.94, 0.94);
const INK = rgb(0.15, 0.19, 0.25);
const MUTED = rgb(0.42, 0.47, 0.54);
const LINE = rgb(0.90, 0.92, 0.94);
const SOFT = rgb(0.96, 0.97, 0.98);

/* companhias: nome -> IATA (para a logo) e link de check-in */
const CIA_IATA = {
  LATAM: 'LA', GOL: 'G3', AZUL: 'AD', AVIANCA: 'AV', COPA: 'CM',
  IBERIA: 'IB', TAAG: 'DT', TAP: 'TP', 'TAP PORTUGAL': 'TP', 'AIR PORTUGAL': 'TP'
};
const CHECKIN = {
  G3: 'https://www.voegol.com.br/checkin',
  LA: 'https://www.latamairlines.com/br/pt/checkin',
  AD: 'https://www.voeazul.com.br/br/pt/home/checkin',
  AV: 'https://www.avianca.com/br/pt/check-in/',
  CM: 'https://www.copaair.com/pt/web/br/check-in',
  IB: 'https://www.iberia.com/br/check-in-online/',
  TP: 'https://www.flytap.com/pt-br/check-in',
  DT: 'https://www.taag.com/pt/'
};
const iataDaCia = (v) => (v.iata && v.iata.trim())
  ? v.iata.trim().toUpperCase()
  : (CIA_IATA[String(v.cia || '').trim().toUpperCase()] || '');

async function fetchBytes(url, ms) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 5000);
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
    if (!r.ok) return null; return Buffer.from(await r.arrayBuffer());
  } catch (e) { return null; }
}

/* =================== função reutilizável: render_voucher(dados) -> PDF =================== */
async function renderVoucher(d, host) {
  const logoMdB = await fetchBytes(host + '/img/logo-md.jpg', 5000);
  const voos = Array.isArray(d.voos) ? d.voos : [];
  const iatas = [...new Set(voos.map(iataDaCia).filter(Boolean))];
  const logosCia = {};
  await Promise.all(iatas.map(async c => { logosCia[c] = await fetchBytes(`https://pics.avs.io/160/50/${c}.png`, 5000); }));

  const pdf = await PDFDocument.create();
  const H = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, PH = 841.89, ML = 46, MR = 46, CW = W - ML - MR;
  let page = pdf.addPage([W, PH]); let y = PH;

  const clean = s => String(s || '').replace(/[\u{1F000}-\u{1FFFF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{2600}-\u{26FF}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
  const txt = (s, x, yy, size, font, color) => page.drawText(clean(s), { x, y: yy, size, font, color: color || INK });
  const wrap = (s, size, font, maxw) => {
    const words = clean(s).split(/\s+/); const lines = []; let cur = '';
    words.forEach(w => { const t = cur ? cur + ' ' + w : w; if (font.widthOfTextAtSize(t, size) > maxw && cur) { lines.push(cur); cur = w; } else cur = t; });
    if (cur) lines.push(cur); return lines;
  };
  const embed = async b => { if (!b) return null; try { return await pdf.embedJpg(b); } catch (e) { try { return await pdf.embedPng(b); } catch (e2) { return null; } } };
  const addLink = (x, yBot, w, h, url) => {
    const ann = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, yBot, x + w, yBot + h], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) } });
    const ref = pdf.context.register(ann);
    let annots = page.node.lookup(PDFName.of('Annots'));
    if (!annots) { annots = pdf.context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
    annots.push(ref);
  };
  const button = (label, x, yBot, w, h, bg, fg, url, size) => {
    page.drawRectangle({ x, y: yBot, width: w, height: h, color: bg });
    const fs = size || 9.5; const tw = B.widthOfTextAtSize(clean(label), fs);
    txt(label, x + (w - tw) / 2, yBot + (h - fs) / 2 + 1.5, fs, B, fg);
    addLink(x, yBot, w, h, url);
  };
  const RODAPE_H = 64;
  const newPage = () => { page = pdf.addPage([W, PH]); y = PH - 46; };
  const ensure = h => { if (y - h < RODAPE_H + 20) newPage(); };
  const sec = t => { ensure(38); txt(t.toUpperCase(), ML, y, 12, B, NAVY); y -= 6;
    page.drawLine({ start: { x: ML, y }, end: { x: ML + 34, y }, thickness: 2.4, color: GOLD });
    page.drawLine({ start: { x: ML + 40, y }, end: { x: W - MR, y }, thickness: 0.8, color: LINE }); y -= 16; };
  const row = (k, v) => { if (!v) return; ensure(16);
    const lines = wrap(v, 9.5, H, CW - 132);
    txt(k, ML, y, 9, H, MUTED);
    lines.forEach((l, i) => { txt(l, ML + 132, y - i * 11, 9.5, i === 0 ? B : H, INK); });
    page.drawLine({ start: { x: ML, y: y - 11 * (lines.length - 1) - 5 }, end: { x: W - MR, y: y - 11 * (lines.length - 1) - 5 }, thickness: 0.5, color: LINE });
    y -= 11 * (lines.length - 1) + 16; };

  /* ===== 1) Barra superior azul + logo + título grande ===== */
  const barH = 92;
  page.drawRectangle({ x: 0, y: PH - barH, width: W, height: barH, color: NAVY });
  const lm = await embed(logoMdB);
  if (lm) { const lh = 56, lw = lh * (lm.width / lm.height); page.drawImage(lm, { x: ML, y: PH - barH + (barH - lh) / 2, width: lw, height: lh }); }
  else txt('MD VIAGENS', ML, PH - 54, 16, B, rgb(1, 1, 1));
  txt('Voucher de Viagem', ML + 150, PH - 58, 26, B, rgb(1, 1, 1));
  y = PH - barH - 18;

  /* faixa: localizador · status · companhia + logo da cia à direita */
  const ciaPrincipal = voos.length ? (voos[0].cia || '') : '';
  const iataPrincipal = voos.length ? iataDaCia(voos[0]) : '';
  const infoH = 58;
  page.drawRectangle({ x: ML, y: y - infoH, width: CW, height: infoH, color: SOFT, borderColor: LINE, borderWidth: 1 });
  txt('LOCALIZADOR', ML + 16, y - 18, 8, B, MUTED);
  txt(d.localizador || '—', ML + 16, y - 42, 22, B, NAVY);
  txt('STATUS', ML + 210, y - 18, 8, B, MUTED);
  txt(d.status || 'Confirmado', ML + 210, y - 38, 12, B, GREEN);
  if (ciaPrincipal) { txt('COMPANHIA', ML + 320, y - 18, 8, B, MUTED); txt(ciaPrincipal, ML + 320, y - 38, 12, B, INK); }
  const logoCiaImg = iataPrincipal ? await embed(logosCia[iataPrincipal]) : null;
  if (logoCiaImg) {
    const lh2 = 22, lw2 = lh2 * (logoCiaImg.width / logoCiaImg.height);
    page.drawImage(logoCiaImg, { x: W - MR - lw2 - 16, y: y - 22 - lh2 / 2 - 8, width: lw2, height: lh2 });
  }
  y -= infoH + 22;

  if (d.titular) row('Titular', d.titular);
  if (d.dataReserva) row('Data da reserva', d.dataReserva);
  if (d.localizadorExterno) row('Loc. do fornecedor', d.localizadorExterno);
  y -= 4;

  /* ===== 2) Passageiros ===== */
  const pax = Array.isArray(d.passageiros) ? d.passageiros.filter(p => p && p.nome) : [];
  if (pax.length) {
    sec('Passageiros');
    const duasCol = pax.length > 4;
    const colW = duasCol ? (CW / 2 - 8) : CW;
    const meio = Math.ceil(pax.length / 2);
    const linha = (p, i, x, yy) => {
      const extra = [p.nascimento, p.documento].filter(Boolean).join(' · ');
      txt(`${i + 1}. ${p.nome}`, x, yy, 10, B, INK);
      if (extra) txt(extra, x + 16, yy - 11, 8.5, H, MUTED);
      return extra ? 26 : 15;
    };
    if (duasCol) {
      let y1 = y, y2 = y;
      pax.slice(0, meio).forEach((p, i) => { ensure(28); y1 -= linha(p, i, ML, y1); });
      pax.slice(meio).forEach((p, i) => { y2 -= linha(p, meio + i, ML + colW + 16, y2); });
      y = Math.min(y1, y2) - 8;
    } else {
      pax.forEach((p, i) => { ensure(28); y -= linha(p, i, ML, y); });
      y -= 8;
    }
  }

  /* ===== 3) Voos — tabela ===== */
  if (voos.length) {
    sec('Voos');
    const cols = [58, 64, 92, 92, 46, 52, 99]; // Trecho, Data, Origem, Destino, Saída, Chegada, Tipo
    const heads = ['Trecho', 'Data', 'Origem', 'Destino', 'Saída', 'Chegada', 'Tipo'];
    const xs = []; let acc = ML; cols.forEach(c => { xs.push(acc); acc += c; });
    const headRow = () => {
      page.drawRectangle({ x: ML, y: y - 16, width: CW, height: 18, color: NAVY });
      heads.forEach((h2, i) => txt(h2, xs[i] + 4, y - 11, 8.5, B, rgb(1, 1, 1)));
      y -= 22;
    };
    ensure(60); headRow();
    voos.forEach((v, i) => {
      ensure(30);
      if (y > PH - 100 && i > 0 && page !== pdf.getPages()[pdf.getPageCount() - 1]) headRow();
      const tipo = v.tipo ? v.tipo.charAt(0).toUpperCase() + v.tipo.slice(1) : ('Trecho ' + (i + 1));
      const origem = (v.deCidade ? v.deCidade + ' ' : '') + (v.de ? '(' + v.de + ')' : '');
      const destino = (v.paraCidade ? v.paraCidade + ' ' : '') + (v.para ? '(' + v.para + ')' : '');
      const tipoVoo = v.conexao && !/direto/i.test(v.conexao) ? v.conexao : 'Voo direto';
      const vals = [tipo + (v.voo ? ' ' + v.voo : ''), v.data || '', origem, destino, v.saida || '', v.chegada || '', tipoVoo];
      vals.forEach((val, k) => {
        const lines = wrap(val, 8.5, H, cols[k] - 8).slice(0, 2);
        lines.forEach((l, li) => txt(l, xs[k] + 4, y - li * 10, 8.5, k === 0 ? B : H, INK));
      });
      page.drawLine({ start: { x: ML, y: y - 14 }, end: { x: W - MR, y: y - 14 }, thickness: 0.5, color: LINE });
      y -= 24;
    });
    // bagagem (por trecho, quando informada)
    const bags = [...new Set(voos.map(v => v.bagagem).filter(Boolean))];
    if (bags.length) { y -= 2; bags.forEach(b2 => { ensure(14); txt('Bagagem: ' + b2, ML, y, 8.5, H, MUTED); y -= 12; }); }
    // localizadores por companhia
    const locs = voos.filter(v => v.localizadorCia).map(v => (v.cia || v.iata || '') + ': ' + v.localizadorCia);
    if (locs.length) { [...new Set(locs)].forEach(l => { ensure(14); txt('Localizador na companhia — ' + l, ML, y, 8.5, H, MUTED); y -= 12; }); }
    // botão de check-in da(s) companhia(s)
    y -= 6;
    let bx = ML;
    iatas.forEach(c => {
      if (!CHECKIN[c]) return;
      ensure(30);
      button('CHECK-IN ' + c, bx, y - 24, 120, 24, GOLD, rgb(0.1, 0.1, 0.1), CHECKIN[c]);
      bx += 132; if (bx + 120 > W - MR) { bx = ML; y -= 30; }
    });
    if (iatas.some(c => CHECKIN[c])) y -= 34;
  }

  /* ===== 4) Caixa de ATENÇÃO (reserva de grupo) ===== */
  if (d.grupo) {
    const texto = 'ATENÇÃO: por se tratar de reserva de grupo, chegar ao aeroporto com 3 horas de antecedência; o check-in do grupo é feito apenas no balcão da companhia aérea (sem check-in online).';
    const lines = wrap(texto, 10, B, CW - 32);
    const boxH2 = lines.length * 13 + 22;
    ensure(boxH2 + 10);
    page.drawRectangle({ x: ML, y: y - boxH2, width: CW, height: boxH2, color: REDBG, borderColor: RED, borderWidth: 1.5 });
    lines.forEach((l, i) => txt(l, ML + 16, y - 18 - i * 13, 10, B, RED));
    y -= boxH2 + 16;
  }

  /* ===== 5) Orientações para Embarque ===== */
  sec('Orientações para Embarque');
  const orient = [
    'Apresente documento de identificação original com foto (RG ou passaporte, conforme o destino).',
    'Chegue ao aeroporto com antecedência: 3 horas para voos internacionais e 2 horas para voos nacionais.',
    'O não comparecimento ao embarque (no-show) cancela automaticamente a reserva.'
  ];
  orient.forEach(o => {
    const lines = wrap(o, 9.5, H, CW - 18);
    ensure(lines.length * 12 + 6);
    txt('•', ML, y, 9.5, B, GOLD);
    lines.forEach((l, i) => txt(l, ML + 14, y - i * 12, 9.5, H, INK));
    y -= lines.length * 12 + 5;
  });
  y -= 8;

  /* ===== extras quando houver (hotel, transfer, carro, seguro) ===== */
  if (d.hotel && d.hotel.nome) {
    sec('Hospedagem');
    row('Hotel', d.hotel.nome);
    row('Endereço', d.hotel.endereco);
    row('Telefone', d.hotel.telefone);
    row('Check-in', [d.hotel.checkin, d.hotel.horaCheckin].filter(Boolean).join(' · '));
    row('Check-out', [d.hotel.checkout, d.hotel.horaCheckout].filter(Boolean).join(' · '));
    row('Noites', d.hotel.noites);
    row('Acomodação', d.hotel.acomodacao);
    row('Regime', d.hotel.regime);
    y -= 4;
  }
  if (d.transfer && (d.transfer.trajeto || d.transfer.tipo)) {
    sec('Transfer');
    row('Tipo', d.transfer.tipo);
    row('Trajeto', d.transfer.trajeto);
    row('Data / hora', [d.transfer.data, d.transfer.hora].filter(Boolean).join(' · '));
    row('Detalhes', d.transfer.detalhe);
    y -= 4;
  }
  if (d.carro && d.carro.locadora) {
    sec('Carro');
    row('Locadora', d.carro.locadora);
    row('Categoria', [d.carro.categoria, d.carro.modelo].filter(Boolean).join(' · '));
    row('Retirada', [d.carro.retiradaLocal, d.carro.retiradaData].filter(Boolean).join(' · '));
    row('Devolução', [d.carro.devolucaoLocal, d.carro.devolucaoData].filter(Boolean).join(' · '));
    row('Condutor', d.carro.condutor);
    y -= 4;
  }
  if (d.seguro && d.seguro.seguradora) {
    sec('Seguro Viagem');
    row('Seguradora', d.seguro.seguradora);
    row('Plano', d.seguro.plano);
    row('Apólice', d.seguro.apolice);
    row('Período', d.seguro.periodo);
    row('Emergência 24h', d.seguro.emergencia);
    y -= 4;
  }
  if (d.politicaCancelamento) { sec('Política de Cancelamento');
    wrap(d.politicaCancelamento, 9, H, CW).forEach(l => { ensure(13); txt(l, ML, y, 9, H, INK); y -= 12; }); y -= 6; }
  if (Array.isArray(d.informacoesImportantes) && d.informacoesImportantes.length) {
    sec('Informações Importantes');
    d.informacoesImportantes.forEach(o => {
      const lines = wrap(o, 9, H, CW - 18);
      ensure(lines.length * 12 + 5);
      txt('•', ML, y, 9, B, GOLD);
      lines.forEach((l, i) => txt(l, ML + 14, y - i * 12, 9, H, INK));
      y -= lines.length * 12 + 4;
    });
  }
  /* contato da agência */
  const ag = d.agente || { nome: 'Gabriela Aquino', telefone: '(31) 98365-1769', email: 'gabriela@mdviagens.com' };
  ensure(30);
  y -= 4;
  txt('Atendimento: ' + ag.nome + ' · ' + ag.telefone + ' · ' + ag.email, ML, y, 9, H, MUTED);

  /* ===== 6) Rodapé azul com a cláusula fixa (em todas as páginas) ===== */
  const CLAUSULA = 'Reserva não reembolsável. Qualquer alteração será passível de multas e taxas e deverá ser tratada diretamente com a MD Viagens ou, caso já esteja no aeroporto, diretamente com a companhia aérea.';
  pdf.getPages().forEach(p => {
    p.drawRectangle({ x: 0, y: 0, width: W, height: RODAPE_H, color: NAVY });
    const lines = wrap(CLAUSULA, 8.5, H, CW);
    lines.forEach((l, i) => p.drawText(clean(l), { x: ML, y: RODAPE_H - 22 - i * 11, size: 8.5, font: H, color: rgb(1, 1, 1) }));
  });

  return await pdf.save();
}

/* =================== handler =================== */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Use POST ou GET');

  let d = null;
  if (req.method === 'GET') {
    const id = (req.query.id || '').toString().trim().toUpperCase();
    if (!id) return res.status(400).send('Informe ?id=<localizador>');
    const val = await redis(['GET', 'voucher:' + id]);
    if (!val) return res.status(404).send('Voucher não encontrado.');
    try { d = JSON.parse(val); } catch (e) { return res.status(500).send('Voucher inválido.'); }
  } else {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    d = (body && body.data) || null;
    if (!d) return res.status(400).send('Envie { data }');
    if (d.localizador) {
      const loc = String(d.localizador).toUpperCase();
      await redis(['SET', 'voucher:' + loc, JSON.stringify(d)]);
      const resumo = [
        (d.voos && d.voos.length) ? 'Voos ' + (d.voos[0].de || '') + '-' + (d.voos[0].para || '') : '',
        (d.hotel && d.hotel.nome) ? 'Hotel ' + d.hotel.nome : '',
        (d.carro && d.carro.locadora) ? 'Carro ' + d.carro.locadora : ''
      ].filter(Boolean).join(' · ');
      await redis(['LPUSH', 'voucher:index', JSON.stringify({
        localizador: loc, titular: d.titular || '', resumo, em: Date.now()
      })]);
      await redis(['LTRIM', 'voucher:index', 0, 499]);
    }
  }

  try {
    const host = 'https://' + (req.headers.host || '');
    const bytes = await renderVoucher(d, host);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="voucher-' + (d.localizador || 'md-viagens') + '.pdf"');
    return res.status(200).send(Buffer.from(bytes));
  } catch (e) {
    return res.status(500).send('Erro ao gerar o voucher: ' + String(e).slice(0, 300));
  }
};
