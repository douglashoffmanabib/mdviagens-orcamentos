// Gera o PDF do Voucher MD Viagens (com botão de check-in clicável).
// POST /api/voucher-pdf   body: { data: {...} }  -> PDF (download)

const { PDFDocument, StandardFonts, rgb, PDFName, PDFString } = require('pdf-lib');

/* Redis (para o robô do WhatsApp reenviar vouchers depois) */
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

const NAVY = rgb(0.086, 0.149, 0.29);
const GOLD = rgb(0.765, 0.627, 0.388);
const GREEN = rgb(0.145, 0.616, 0.333);
const INK = rgb(0.15, 0.19, 0.25);
const MUTED = rgb(0.42, 0.47, 0.54);
const LINE = rgb(0.90, 0.92, 0.94);
const SOFT = rgb(0.96, 0.97, 0.98);

// links de check-in por companhia
const CHECKIN = {
  G3: 'https://www.voegol.com.br/checkin',
  LA: 'https://www.latamairlines.com/br/pt/checkin',
  AD: 'https://www.voeazul.com.br/br/pt/home/checkin',
  AV: 'https://www.avianca.com/br/pt/check-in/',
  CM: 'https://www.copaair.com/pt/web/br/check-in'
};

async function fetchBytes(url, ms) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 5000);
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
    if (!r.ok) return null; return Buffer.from(await r.arrayBuffer());
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Use POST ou GET');

  let d = null;
  if (req.method === 'GET') {
    // reenvio: /api/voucher-pdf?id=<localizador>
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
    // guarda para reenvio futuro (robô do WhatsApp / histórico)
    if (d.localizador) {
      const loc = String(d.localizador).toUpperCase();
      await redis(['SET', 'voucher:' + loc, JSON.stringify(d)]);
      const resumo = [
        (d.hotel && d.hotel.nome) ? 'Hotel ' + d.hotel.nome : '',
        (d.voos && d.voos.length) ? 'Voos ' + (d.voos[0].de || '') + '-' + (d.voos[0].para || '') : '',
        (d.carro && d.carro.locadora) ? 'Carro ' + d.carro.locadora : ''
      ].filter(Boolean).join(' · ');
      await redis(['LPUSH', 'voucher:index', JSON.stringify({
        localizador: loc, titular: d.titular || '', resumo, em: Date.now()
      })]);
      await redis(['LTRIM', 'voucher:index', 0, 499]);
    }
  }

  const host = 'https://' + (req.headers.host || '');
  const [logoMd, cadastur] = await Promise.all([
    fetchBytes(host + '/img/logo-md.jpg', 5000),
    fetchBytes(host + '/img/cadastur.png', 5000)
  ]);
  const iatas = [...new Set(((d.voos) || []).map(v => v.iata).filter(Boolean))];
  const logosCia = {};
  await Promise.all(iatas.map(async c => { logosCia[c] = await fetchBytes(`https://pics.avs.io/120/40/${c}.png`, 5000); }));

  try {
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
    const newPage = () => { page = pdf.addPage([W, PH]); y = PH - 46; };
    const ensure = h => { if (y - h < 60) newPage(); };
    const sec = t => { ensure(36); txt(t.toUpperCase(), ML, y, 11, B, NAVY); y -= 5;
      page.drawLine({ start: { x: ML, y }, end: { x: ML + 30, y }, thickness: 2.2, color: GOLD });
      page.drawLine({ start: { x: ML + 36, y }, end: { x: W - MR, y }, thickness: 0.8, color: LINE }); y -= 15; };
    const row = (k, v) => { if (!v) return; ensure(14);
      txt(k, ML, y, 9, H, MUTED);
      wrap(v, 9.5, H, CW - 132).forEach((l, i) => { txt(l, ML + 132, y - i * 11, 9.5, i === 0 ? B : H, INK); });
      const n = wrap(v, 9.5, H, CW - 132).length;
      page.drawLine({ start: { x: ML, y: y - 11 * (n - 1) - 5 }, end: { x: W - MR, y: y - 11 * (n - 1) - 5 }, thickness: 0.5, color: LINE });
      y -= 11 * (n - 1) + 16; };

    // ===== topo =====
    const lm = await embed(logoMd);
    page.drawRectangle({ x: 0, y: y - 56, width: W, height: 56, color: NAVY });
    if (lm) { const lh = 44, lw = lh * (lm.width / lm.height); page.drawImage(lm, { x: ML, y: y - 50, width: lw, height: lh }); }
    else txt('MD VIAGENS', ML, y - 34, 13, B, rgb(1, 1, 1));
    const tt = 'Voucher de Viagem';
    txt(tt, W - MR - B.widthOfTextAtSize(tt, 11), y - 33, 11, B, GOLD);
    y -= 76;

    // ===== localizador em destaque =====
    const boxH = 54;
    page.drawRectangle({ x: ML, y: y - boxH, width: CW, height: boxH, color: SOFT, borderColor: LINE, borderWidth: 1 });
    txt('LOCALIZADOR DA RESERVA', ML + 16, y - 20, 8, B, MUTED);
    txt(d.localizador || '—', ML + 16, y - 42, 22, B, NAVY);
    const st = (d.status || 'Confirmado');
    txt('STATUS', W - MR - 150, y - 20, 8, B, MUTED);
    txt(st, W - MR - 150, y - 38, 12, B, GREEN);
    if (d.localizadorExterno) { txt('Localizador do fornecedor: ' + d.localizadorExterno, W - MR - 150, y - 50, 7.5, H, MUTED); }
    y -= boxH + 18;

    if (d.titular) { txt('Titular: ' + d.titular, ML, y, 10.5, B, INK); y -= 14; }
    if (d.dataReserva) { txt('Reserva efetuada em ' + d.dataReserva, ML, y, 9, H, MUTED); y -= 14; }
    y -= 4;

    // ===== passageiros =====
    if (Array.isArray(d.passageiros) && d.passageiros.length) {
      sec('Passageiros');
      d.passageiros.forEach(p => {
        const extra = [p.nascimento, p.documento].filter(Boolean).join('  ·  ');
        ensure(14); txt(p.nome || '', ML, y, 10, B, INK);
        if (extra) txt(extra, ML + 240, y, 9, H, MUTED);
        y -= 15;
      });
      y -= 6;
    }

    // ===== voos =====
    if (Array.isArray(d.voos) && d.voos.length) {
      sec('Voos');
      for (const v of d.voos) {
        ensure(76);
        page.drawRectangle({ x: ML, y: y - 62, width: CW, height: 62, color: SOFT, borderColor: LINE, borderWidth: 1 });
        const lg = v.iata && await embed(logosCia[v.iata]);
        if (lg) { const lh = 14, lw = lh * (lg.width / lg.height); page.drawImage(lg, { x: ML + 12, y: y - 24, width: lw, height: lh }); }
        else txt(v.cia || '', ML + 12, y - 22, 10, B, INK);
        txt((v.tipo === 'volta' ? 'VOLTA' : 'IDA') + (v.data ? '  ·  ' + v.data : ''), ML + 96, y - 20, 9.5, B, NAVY);
        txt(`${v.de || ''} ${v.deCidade || ''}   ${v.saida || ''}   >   ${v.para || ''} ${v.paraCidade || ''}   ${v.chegada || ''}`, ML + 12, y - 40, 10, B, INK);
        const extra = [v.voo ? 'Voo ' + v.voo : '', v.localizadorCia ? 'Localizador cia: ' + v.localizadorCia : '', v.conexao || '', v.bagagem || ''].filter(Boolean).join('  ·  ');
        if (extra) txt(wrap(extra, 8, H, CW - 24)[0], ML + 12, y - 54, 8, H, MUTED);
        y -= 68;
        const url = CHECKIN[v.iata];
        if (url) { button('FAZER CHECK-IN ONLINE NA ' + (v.cia || 'COMPANHIA'), ML, y - 22, CW, 22, NAVY, GOLD, url, 9.5); y -= 30; }
      }
      txt('O check-in costuma abrir 48h antes do voo (24h em alguns casos).', ML, y, 8, H, MUTED); y -= 16;
    }

    // ===== hotel =====
    if (d.hotel && d.hotel.nome) {
      sec('Hospedagem');
      row('Hotel', d.hotel.nome);
      row('Endereço', d.hotel.endereco);
      row('Telefone', d.hotel.telefone);
      row('Check-in', [d.hotel.checkin, d.hotel.horaCheckin ? '(a partir das ' + d.hotel.horaCheckin + ')' : ''].filter(Boolean).join(' '));
      row('Check-out', [d.hotel.checkout, d.hotel.horaCheckout ? '(até as ' + d.hotel.horaCheckout + ')' : ''].filter(Boolean).join(' '));
      row('Noites', d.hotel.noites ? String(d.hotel.noites) : '');
      row('Acomodação', d.hotel.acomodacao);
      row('Regime', d.hotel.regime);
      if (d.hotel.endereco) {
        button('COMO CHEGAR AO HOTEL', ML, y - 22, CW, 22, NAVY, GOLD,
          'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(d.hotel.nome + ' ' + d.hotel.endereco), 9.5);
        y -= 32;
      }
    }

    // ===== transfer =====
    if (d.transfer && (d.transfer.tipo || d.transfer.trajeto)) {
      sec('Transfer');
      row('Tipo', d.transfer.tipo); row('Trajeto', d.transfer.trajeto);
      row('Data / hora', [d.transfer.data, d.transfer.hora].filter(Boolean).join(' '));
      row('Detalhes', d.transfer.detalhe);
    }

    // ===== carro =====
    if (d.carro && d.carro.locadora) {
      sec('Aluguel de carro');
      row('Locadora', d.carro.locadora);
      row('Categoria', [d.carro.categoria, d.carro.modelo].filter(Boolean).join(' - '));
      row('Características', [d.carro.transmissao, d.carro.portas ? d.carro.portas + ' portas' : '', d.carro.arCondicionado].filter(Boolean).join('  ·  '));
      row('Retirada', [d.carro.retiradaLocal, d.carro.retiradaData].filter(Boolean).join('  ·  '));
      row('Devolução', [d.carro.devolucaoLocal, d.carro.devolucaoData].filter(Boolean).join('  ·  '));
      row('Condutor', d.carro.condutor);
      row('A tarifa inclui', d.carro.inclui);
    }

    // ===== seguro =====
    if (d.seguro && (d.seguro.seguradora || d.seguro.apolice)) {
      sec('Seguro viagem');
      row('Seguradora', d.seguro.seguradora); row('Apólice', d.seguro.apolice);
      row('Plano', d.seguro.plano); row('Período', d.seguro.periodo);
      row('Emergência 24h', d.seguro.emergencia);
    }

    // ===== políticas / informações =====
    const lista = (titulo, arr) => {
      if (!Array.isArray(arr) || !arr.length) return;
      sec(titulo);
      arr.forEach(i => { wrap('•  ' + i, 8.5, H, CW).forEach(l => { ensure(11); txt(l, ML, y, 8.5, H, rgb(0.29, 0.33, 0.41)); y -= 11; }); y -= 3; });
      y -= 4;
    };
    lista('Política de cancelamento', d.politicaCancelamento);
    lista('Informações importantes', d.informacoesImportantes);

    // ===== emergência / contato =====
    ensure(76);
    const ag = d.agente || {};
    const wa = 'https://wa.me/' + (ag.whatsapp || '5531983651769') + '?text=' + encodeURIComponent(`Olá! Preciso de ajuda com a reserva ${d.localizador || ''}.`);
    page.drawRectangle({ x: ML, y: y - 46, width: CW, height: 46, color: SOFT, borderColor: LINE, borderWidth: 1 });
    txt('PRECISA DE AJUDA DURANTE A VIAGEM?', ML + 16, y - 18, 9, B, NAVY);
    txt(`${ag.nome || 'Gabriela Aquino'}  ·  ${ag.telefone || '(31) 98365-1769'}  ·  ${ag.email || 'gabriela@mdviagens.com'}`, ML + 16, y - 34, 9, H, INK);
    y -= 56;
    button('FALAR COM A MD VIAGENS NO WHATSAPP', ML, y - 26, CW, 26, GREEN, rgb(1, 1, 1), wa, 11);
    y -= 40;

    // rodapé
    page.drawRectangle({ x: 0, y: 0, width: W, height: 30, color: NAVY });
    txt('MD VIAGENS  •  Boa viagem!  •  Atendimento em Sete Lagoas e Belo Horizonte', ML, 11, 8.5, B, GOLD);
    const cad = await embed(cadastur);
    if (cad) { const ch = 13, cw2 = ch * (cad.width / cad.height); page.drawImage(cad, { x: W - MR - cw2, y: 8.5, width: cw2, height: ch }); }

    const bytes = await pdf.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="voucher-${(d.localizador || 'md-viagens').toLowerCase()}.pdf"`);
    return res.status(200).send(Buffer.from(bytes));
  } catch (e) {
    return res.status(500).send('Erro ao gerar voucher: ' + String(e).slice(0, 300));
  }
};
