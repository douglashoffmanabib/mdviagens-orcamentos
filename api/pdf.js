// PDF rico do orçamento: foto do destino, hotéis (vários), mapas, seções e botões clicáveis.
// GET /api/pdf?id=<id>

const {
  PDFDocument, StandardFonts, rgb, PDFName, PDFString,
  pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath
} = require('pdf-lib');

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

const NAVY = rgb(0.086, 0.149, 0.29);
const NAVY2 = rgb(0.125, 0.204, 0.36);
const GOLD = rgb(0.765, 0.627, 0.388);
const GREEN = rgb(0.145, 0.616, 0.333);
const INK = rgb(0.15, 0.19, 0.25);
const MUTED = rgb(0.42, 0.47, 0.54);
const LINE = rgb(0.90, 0.92, 0.94);

async function fetchBytes(url, ms) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 6000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).send('Informe ?id=');
  const { url: rUrl, token } = creds();
  if (!rUrl || !token) return res.status(500).send('Armazenamento não configurado.');

  let d;
  try {
    const val = await redis(['GET', 'orc:' + id]);
    if (!val) return res.status(404).send('Orçamento não encontrado.');
    d = JSON.parse(val);
  } catch (e) { return res.status(500).send('Erro ao carregar: ' + String(e).slice(0, 200)); }

  const host = 'https://' + (req.headers.host || '');
  const gkey = process.env.GOOGLE_MAPS_API_KEY || '';

  // hotéis: lista (vários) ou objeto único (compatibilidade)
  d.hoteis = (Array.isArray(d.hoteis) && d.hoteis.length) ? d.hoteis.filter(h => h && h.nome)
           : ((d.hotel && d.hotel.nome) ? [d.hotel] : []);
  if (d.hoteis.length) d.hotel = d.hoteis[0];
  const temVoo = !!(d.voos && d.voos.length);
  const soVoo = temVoo && !d.hoteis.length;
  const soHotel = !temVoo && d.hoteis.length > 0;
  const extras = Array.isArray(d.extras) ? d.extras.filter(e => e && (e.titulo || e.descricao)) : [];

  // ---------- imagens em paralelo ----------
  const jobs = {};
  if (!soVoo) {
    const destQ = d.destinoBusca || d.destinoResumo || '';
    const alts = [d.pais, d.destinoMensagem, (d.destinoResumo || '').split(',')[0]].filter(Boolean).join(',');
    // foto escolhida manualmente no extrator tem prioridade sobre a busca automática
    if (d.hero && d.hero.imagem && /^https?:/.test(d.hero.imagem)) {
      jobs.city = fetchBytes(d.hero.imagem, 7000);
    } else if (destQ) jobs.city = (async () => {
      try {
        const r = await fetch(host + '/api/city-photo?q=' + encodeURIComponent(destQ) + (alts ? '&alt=' + encodeURIComponent(alts) : ''));
        if (!r.ok) return null; const j = await r.json();
        return j.imagem ? await fetchBytes(j.imagem, 7000) : null;
      } catch (e) { return null; }
    })();
    d.hoteis.slice(0, 4).forEach((h, i) => {
      jobs['hotelFotos' + i] = (async () => {
        try {
          const q = encodeURIComponent(`${h.nome} ${h.endereco || ''}`);
          const r = await fetch(host + '/api/hotel-photos?q=' + q);
          if (!r.ok) return [];
          const j = await r.json();
          if (j.coordinates) h.geo = { lat: j.coordinates.lat, lon: j.coordinates.lon };
          const refs = (j.photoRefs || []).slice(0, 4);
          const imgs = await Promise.all(refs.map(ref => fetchBytes(host + '/api/place-photo?ref=' + encodeURIComponent(ref) + '&w=400', 7000)));
          return imgs.filter(Boolean);
        } catch (e) { return []; }
      })();
    });
  }
  const ida = d.mapaVoo && d.mapaVoo.ida && d.mapaVoo.ida.pontos && d.mapaVoo.ida.pontos.length >= 2 ? d.mapaVoo.ida.pontos : null;
  if (gkey && ida) {
    const p1 = ida[0], p2 = ida[ida.length - 1];
    jobs.mapaVoo = fetchBytes(`https://maps.googleapis.com/maps/api/staticmap?size=480x300&language=pt-BR&path=color:0x3a7ca5ff%7Cweight:3%7C${p1.lat},${p1.lon}%7C${p2.lat},${p2.lon}&markers=size:mid%7Ccolor:0xc3a063%7C${p1.lat},${p1.lon}&markers=size:mid%7Ccolor:0x1f9d55%7C${p2.lat},${p2.lon}&key=${gkey}`, 7000);
  }
  // logos das companhias
  const trechosAll = (d.voos && d.voos[0] && d.voos[0].trechos) || [];
  const iatas = [...new Set(trechosAll.map(t => t.iata).filter(Boolean))];
  iatas.forEach(c => { jobs['logo_' + c] = fetchBytes(`https://pics.avs.io/120/40/${c}.png`, 5000); });
  // marca e parceiros
  jobs.logoMd = fetchBytes(host + '/img/logo-md.jpg', 5000);
  jobs.cadastur = fetchBytes(host + '/img/cadastur.png', 5000);
  ['rextur', 'cvc', 'flytour', 'sakura', 'patria'].forEach(k => { jobs[k] = fetchBytes(host + '/img/' + k + '.png', 5000); });

  const assets = {};
  await Promise.all(Object.keys(jobs).map(async k => { assets[k] = await jobs[k]; }));
  if (gkey) {
    await Promise.all(d.hoteis.slice(0, 4).map(async (h, i) => {
      if (h.geo && h.geo.lat) assets['mapaHotel' + i] = await fetchBytes(`https://maps.googleapis.com/maps/api/staticmap?size=480x300&zoom=14&language=pt-BR&markers=color:red%7C${h.geo.lat},${h.geo.lon}&key=${gkey}`, 7000);
    }));
  }

  try {
    const pdf = await PDFDocument.create();
    const H = await pdf.embedFont(StandardFonts.Helvetica);
    const B = await pdf.embedFont(StandardFonts.HelveticaBold);
    const W = 595.28, PH = 841.89, ML = 46, MR = 46, CW = W - ML - MR;
    let page = pdf.addPage([W, PH]);
    let y = PH;

    const embed = async (buf) => {
      if (!buf) return null;
      try { return await pdf.embedJpg(buf); } catch (e) { try { return await pdf.embedPng(buf); } catch (e2) { return null; } }
    };
    const clean = (s) => String(s || '').replace(/[\u{1F000}-\u{1FFFF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{2600}-\u{26FF}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
    const txt = (s, x, yy, size, font, color) => page.drawText(clean(s), { x, y: yy, size, font, color: color || INK });
    const wrap = (s, size, font, maxw) => {
      const words = clean(s).split(/\s+/); const lines = []; let cur = '';
      words.forEach(w => { const t = cur ? cur + ' ' + w : w;
        if (font.widthOfTextAtSize(t, size) > maxw && cur) { lines.push(cur); cur = w; } else cur = t; });
      if (cur) lines.push(cur); return lines;
    };
    const cover = (img, x, yBot, w, h) => {
      const s = Math.max(w / img.width, h / img.height);
      const iw = img.width * s, ih = img.height * s;
      page.pushOperators(pushGraphicsState(), moveTo(x, yBot), lineTo(x + w, yBot), lineTo(x + w, yBot + h), lineTo(x, yBot + h), closePath(), clip(), endPath());
      page.drawImage(img, { x: x - (iw - w) / 2, y: yBot - (ih - h) / 2, width: iw, height: ih });
      page.pushOperators(popGraphicsState());
    };
    const addLink = (x, yBot, w, h, url) => {
      const ann = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, yBot, x + w, yBot + h], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) } });
      const ref = pdf.context.register(ann);
      let annots = page.node.lookup(PDFName.of('Annots'));
      if (!annots) { annots = pdf.context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
      annots.push(ref);
    };
    const button = (label, x, yBot, w, h, bg, fg, url, size) => {
      page.drawRectangle({ x, y: yBot, width: w, height: h, color: bg });
      const fs = size || 9.5;
      const tw = B.widthOfTextAtSize(clean(label), fs);
      txt(label, x + (w - tw) / 2, yBot + (h - fs) / 2 + 1.5, fs, B, fg);
      addLink(x, yBot, w, h, url);
    };
    const newPage = () => { page = pdf.addPage([W, PH]); y = PH - 50; };
    const ensure = (h) => { if (y - h < 64) newPage(); };
    const secTitle = (t) => {
      ensure(40);
      txt(t.toUpperCase(), ML, y, 11.5, B, NAVY); y -= 5;
      page.drawLine({ start: { x: ML, y }, end: { x: ML + 34, y }, thickness: 2.4, color: GOLD });
      page.drawLine({ start: { x: ML + 40, y }, end: { x: W - MR, y }, thickness: 0.8, color: LINE });
      y -= 16;
    };

    const titulo = soVoo ? 'Cotação de Voos' : (soHotel ? 'Cotação de Hospedagem' : 'Cotação de Viagem');

    // ===== topo com a logo =====
    const logoMd = await embed(assets.logoMd);
    page.drawRectangle({ x: 0, y: y - 56, width: W, height: 56, color: NAVY });
    if (logoMd) { const lh = 44, lw = lh * (logoMd.width / logoMd.height); page.drawImage(logoMd, { x: ML, y: y - 50, width: lw, height: lh }); }
    else txt('MD VIAGENS', ML, y - 34, 13, B, rgb(1, 1, 1));
    txt(titulo, W - MR - B.widthOfTextAtSize(titulo, 11), y - 33, 11, B, GOLD);
    y -= 56;

    // ===== foto do destino =====
    const cityImg = await embed(assets.city);
    if (cityImg) { cover(cityImg, 0, y - 150, W, 150); y -= 150; }
    y -= 26;

    // ===== título e dados =====
    txt(d.hero && d.hero.titulo ? d.hero.titulo : titulo, ML, y, 20, B, NAVY); y -= 20;
    const cli = (d.cliente && d.cliente.nome) || '';
    const lin = [cli ? 'Cliente: ' + cli : '', (d.valores && d.valores.cotadoEm) ? 'Cotado em ' + d.valores.cotadoEm : '', d.codigo || ''].filter(Boolean).join('   •   ');
    if (lin) { txt(lin, ML, y, 10, H, MUTED); y -= 14; }
    y -= 8;

    // ===== VOOS =====
    const trechos = trechosAll;
    if (trechos.length) {
      secTitle('Voos');
      const cols = [{ w: 40 }, { w: 78 }, { w: 48 }, { w: 90 }, { w: 90 }, { w: 40 }, { w: 46 }, { w: 54 }];
      const heads = ['Trecho', 'Data', 'Cia', 'Origem', 'Destino', 'Saída', 'Chegada', 'Tipo'];
      const logos = {};
      for (const c of iatas) { logos[c] = await embed(assets['logo_' + c]); }
      ensure(24 + trechos.length * 26);
      let x = ML;
      page.drawRectangle({ x: ML, y: y - 5, width: CW, height: 18, color: NAVY });
      heads.forEach((t, i) => { txt(t, x + 4, y - 1, 8.5, B, rgb(1, 1, 1)); x += cols[i].w; });
      y -= 22;
      trechos.forEach(t => {
        x = ML;
        const vals = [t.tipo === 'volta' ? 'Volta' : 'Ida', t.data || '', null,
          (t.de || '') + ' ' + (t.deCidade || ''), (t.para || '') + ' ' + (t.paraCidade || ''),
          t.saida || '', t.chegada || '', /direto/i.test(t.conexao || '') ? 'Direto' : (t.conexao ? '1 parada' : '-')];
        vals.forEach((v, i) => {
          if (i === 2) {
            const lg = t.iata && logos[t.iata];
            if (lg) { const lw = Math.min(cols[i].w - 8, 12 * (lg.width / lg.height)); page.drawImage(lg, { x: x + 4, y: y - 4, width: lw, height: 12 }); }
            else txt(t.iata || t.cia || '', x + 4, y, 8, H, INK);
          } else {
            const ls = wrap(v, 8, H, cols[i].w - 8);
            txt(ls[0] || '', x + 4, y, 8, H, INK);
            if (ls[1]) txt(ls[1], x + 4, y - 9, 8, H, INK);
          }
          x += cols[i].w;
        });
        page.drawLine({ start: { x: ML, y: y - 14 }, end: { x: W - MR, y: y - 14 }, thickness: 0.6, color: LINE });
        y -= 24;
      });
      const bag = trechos[0] && trechos[0].bagagem;
      if (bag) { txt(bag, ML, y, 8.5, H, MUTED); y -= 13; }
      y -= 6;
    }

    // ===== MAPAS =====
    const mV = await embed(assets.mapaVoo);
    const mapasHotel = [];
    for (let i = 0; i < d.hoteis.length; i++) { const im = await embed(assets['mapaHotel' + i]); if (im) mapasHotel.push({ im, nome: d.hoteis[i].cidade || d.hoteis[i].nome }); }
    if (mV || mapasHotel.length) {
      secTitle('Mapas');
      const mw = (CW - 12) / 2, mh = 120;
      let col = 0;
      const put = (img, legenda) => {
        if (col === 0) ensure(mh + 26);
        const x = ML + col * (mw + 12);
        cover(img, x, y - mh, mw, mh);
        txt(legenda, x, y - mh - 11, 8, H, MUTED);
        col++;
        if (col === 2) { y -= mh + 24; col = 0; }
      };
      if (mV) put(mV, 'Rota do voo');
      mapasHotel.forEach(m => put(m.im, m.nome));
      if (col === 1) y -= mh + 24;
    }

    // ===== HOSPEDAGEM (um bloco por hotel) =====
    if (d.hoteis.length) {
      secTitle(d.hoteis.length > 1 ? 'Hospedagem · ' + d.hoteis.length + ' hoteis' : 'Hospedagem');
      for (let hi = 0; hi < d.hoteis.length; hi++) {
        const h = d.hoteis[hi];
        ensure(50);
        if (h.cidade) { txt(String(h.cidade).toUpperCase(), ML, y, 9, B, GOLD); y -= 13; }
        txt(h.nome + (h.estrelas ? `  ·  ${h.estrelas} estrelas` : ''), ML, y, 12, B, INK); y -= 13;
        if (h.endereco) { txt(wrap(h.endereco, 9, H, CW)[0], ML, y, 9, H, MUTED); y -= 12; }
        const per = [h.checkin && h.checkout ? `Período: ${h.checkin} a ${h.checkout}` : '', h.noites ? `${h.noites} noites` : ''].filter(Boolean).join('   •   ');
        if (per) { txt(per, ML, y, 9.5, H, INK); y -= 13; }
        (h.quartos || []).slice(0, 2).forEach(q => {
          const l = [q.nome, q.ocupacao, q.plano, q.restricao].filter(Boolean).join('  ·  ');
          txt(wrap(l, 9, H, CW)[0], ML, y, 9, H, INK); y -= 12;
        });
        const fotos = [];
        for (const b of (assets['hotelFotos' + hi] || [])) { const im = await embed(b); if (im) fotos.push(im); }
        if (fotos.length) {
          const fw = (CW - 3 * 8) / 4, fh = 58;
          ensure(fh + 12); y -= 4;
          fotos.slice(0, 4).forEach((im, i) => cover(im, ML + i * (fw + 8), y - fh, fw, fh));
          y -= fh + 10;
        }
        if (hi < d.hoteis.length - 1) { page.drawLine({ start: { x: ML, y: y - 2 }, end: { x: W - MR, y: y - 2 }, thickness: 0.6, color: LINE }); y -= 14; }
      }
      y -= 6;
    }

    // ===== TRANSFER / SEGURO =====
    if (d.transfer) {
      secTitle('Transfer');
      const l = [d.transfer.tipo, d.transfer.trajeto, d.transfer.detalhe].filter(Boolean).join('  ·  ');
      wrap(l, 9, H, CW).forEach(s => { ensure(12); txt(s, ML, y, 9, H, INK); y -= 12; }); y -= 6;
    }
    if (d.seguro) {
      secTitle('Seguro viagem');
      const l = [d.seguro.nome, d.seguro.plano, d.seguro.periodo, d.seguro.viajantes].filter(Boolean).join('  ·  ');
      wrap(l, 9, H, CW).forEach(s => { ensure(12); txt(s, ML, y, 9, H, INK); y -= 12; }); y -= 6;
    }

    // ===== PASSEIOS E EXTRAS INCLUSOS =====
    if (extras.length) {
      secTitle('Passeios e Extras Inclusos');
      extras.forEach(e => {
        ensure(24);
        if (e.titulo) { txt(e.titulo, ML, y, 10, B, INK); y -= 12; }
        if (e.descricao) { wrap(e.descricao, 9, H, CW).forEach(s => { ensure(11); txt(s, ML, y, 9, H, MUTED); y -= 11; }); }
        y -= 6;
      });
    }

    // ===== INVESTIMENTO =====
    const v = d.valores || {};
    const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const pad2 = n => String(n).padStart(2, '0');
    const boxLines = [];
    if (v.parcelas && v.valorParcelaNum) {
      boxLines.push({ t: `Pagamento em até ${v.parcelas}X sem juros no cartão.`, s: 13, f: B });
      if (v.taxaUnicaNum) {
        boxLines.push({ t: `01x ${brl(v.valorParcelaNum + v.taxaUnicaNum)} (${brl(v.taxaUnicaNum)} das taxas de embarque + ${brl(v.valorParcelaNum)} da primeira parcela)`, s: 10, f: B });
        boxLines.push({ t: `+ ${pad2(v.parcelas - 1)}X de ${brl(v.valorParcelaNum)}`, s: 10, f: B });
      } else boxLines.push({ t: `${pad2(v.parcelas)}X de ${brl(v.valorParcelaNum)}`, s: 10, f: B });
    }
    boxLines.push({ t: `Valor total${v.taxasInclusas ? ' · taxas inclusas' : ''}: ${brl(v.totalNum)}`, s: 9.5, f: H });
    boxLines.push({ t: 'Confira abaixo as condições desta proposta.', s: 8, f: H });
    const bh = 20 + boxLines.reduce((a, l) => a + l.s + 7, 0);
    secTitle('Forma de Investimento');
    ensure(bh + 10);
    page.drawRectangle({ x: ML, y: y - bh, width: CW, height: bh, color: NAVY });
    let by = y - 18;
    boxLines.forEach(l => { txt(l.t, ML + 16, by, l.s, l.f, rgb(1, 1, 1)); by -= l.s + 7; });
    y -= bh + 16;

    // ===== BOTÕES =====
    const cod = d.codigo || d.numero || '';
    const waMod = op => 'https://wa.me/5531983651769?text=' + encodeURIComponent(`Olá! Sobre o orçamento ${cod}: quero ${op}.`);
    ensure(130);
    const bt = 'Quer modificar? Escolha:';
    txt(bt, ML + (CW - B.widthOfTextAtSize(bt, 12)) / 2, y, 12, B, NAVY); y -= 22;
    const bw = (CW - 12) / 2, bhh = 24;
    button('OUTRA OPÇÃO DE VOO', ML, y - bhh, bw, bhh, GOLD, NAVY, waMod('OUTRA OPÇÃO DE VOO'));
    button('MUDAR NÚMERO DE DIAS', ML + bw + 12, y - bhh, bw, bhh, GOLD, NAVY, waMod('MUDAR NÚMERO DE DIAS'));
    y -= bhh + 8;
    button('MODIFICAR HOTEL', ML, y - bhh, bw, bhh, GOLD, NAVY, waMod('MODIFICAR HOTEL'));
    button('ADICIONAR TRANSFER', ML + bw + 12, y - bhh, bw, bhh, GOLD, NAVY, waMod('ADICIONAR TRANSFER'));
    y -= bhh + 14;
    ensure(84);
    button('FALAR NO WHATSAPP E FECHAR MINHA VIAGEM', ML, y - 32, CW, 32, GREEN, rgb(1, 1, 1), 'https://wa.me/5531983651769?text=' + encodeURIComponent(`Olá! Quero fechar o orçamento ${cod}!`), 12);
    y -= 40;
    button('VER ORÇAMENTO INTERATIVO COMPLETO', ML, y - 26, CW, 26, NAVY2, GOLD, host + '/o/' + encodeURIComponent(id), 10.5);
    y -= 40;

    // ===== CONDIÇÕES + contato =====
    secTitle('Condições desta proposta');
    const conds = [
      `Os preços foram cotados em ${v.cotadoEm || ''}. Estes preços são dinâmicos e podem mudar a qualquer momento, sem aviso prévio.`,
      'As tarifas deste orçamento são não reembolsáveis e estarão sujeitas a multas e taxas cobradas pelos hotéis e companhias aéreas em caso de alterações ou cancelamentos.'
    ];
    conds.forEach(c => { wrap('•  ' + c, 8.5, H, CW).forEach(s => { ensure(11); txt(s, ML, y, 8.5, H, MUTED); y -= 11; }); y -= 3; });
    ensure(40);
    const ag = d.agente || {};
    txt(`${ag.nome || 'Gabriela Aquino'}  ·  ${ag.telefone || '(31) 98365-1769'}  ·  ${ag.email || 'gabriela@mdviagens.com'}`, ML, y, 9.5, B, NAVY);

    // ===== rodapé: parceiros + faixa =====
    if (y < 110) newPage();
    const pImgs = [];
    for (const k of ['rextur', 'cvc', 'flytour', 'sakura', 'patria']) { const im = await embed(assets[k]); if (im) pImgs.push(im); }
    if (pImgs.length) {
      const cap = 'Trabalhamos com os melhores fornecedores';
      txt(cap, (W - H.widthOfTextAtSize(cap, 7.5)) / 2, 66, 7.5, H, MUTED);
      const lh = 15, gap = 20;
      const widths = pImgs.map(im => lh * (im.width / im.height));
      const tot = widths.reduce((a, b) => a + b, 0) + gap * (pImgs.length - 1);
      let px = (W - tot) / 2;
      pImgs.forEach((im, i) => { page.drawImage(im, { x: px, y: 42, width: widths[i], height: lh }); px += widths[i] + gap; });
    }
    page.drawRectangle({ x: 0, y: 0, width: W, height: 30, color: NAVY });
    txt('MD VIAGENS  •  Atendimento em Sete Lagoas e Belo Horizonte', ML, 11, 8.5, B, GOLD);
    const cad = await embed(assets.cadastur);
    if (cad) { const ch = 13, cw2 = ch * (cad.width / cad.height); page.drawImage(cad, { x: W - MR - cw2, y: 8.5, width: cw2, height: ch }); }

    const bytes = await pdf.save();
    const nome = ('orcamento-' + (d.codigo || id) + '.pdf').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.status(200).send(Buffer.from(bytes));
  } catch (e) {
    return res.status(500).send('Erro ao gerar PDF: ' + String(e).slice(0, 300));
  }
};
