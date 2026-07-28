// Gera um PDF real (baixa direto, sem tela de impressão) do orçamento salvo.
// GET /api/pdf?id=<id do link curto>
// Dependência: pdf-lib (declarada no package.json — a Vercel instala sozinha).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

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
const GOLD = rgb(0.765, 0.627, 0.388);
const INK = rgb(0.15, 0.19, 0.25);
const MUTED = rgb(0.42, 0.47, 0.54);
const LINE = rgb(0.90, 0.92, 0.94);

module.exports = async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  if (!id) return res.status(400).send('Informe ?id=');
  const { url, token } = creds();
  if (!url || !token) return res.status(500).send('Armazenamento não configurado.');

  let d;
  try {
    const val = await redis(['GET', 'orc:' + id]);
    if (!val) return res.status(404).send('Orçamento não encontrado.');
    d = JSON.parse(val);
  } catch (e) { return res.status(500).send('Erro ao carregar: ' + String(e).slice(0, 200)); }

  try {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595.28, 841.89]); // A4
    const H = await pdf.embedFont(StandardFonts.Helvetica);
    const B = await pdf.embedFont(StandardFonts.HelveticaBold);
    const W = 595.28, ML = 48, MR = 48, CW = W - ML - MR;
    let y = 841.89;

    const txt = (s, x, yy, size, font, color) => page.drawText(String(s || ''), { x, y: yy, size, font, color: color || INK });
    const wrap = (s, size, font, maxw) => {
      const words = String(s || '').split(/\s+/); const lines = []; let cur = '';
      words.forEach(w => {
        const t = cur ? cur + ' ' + w : w;
        if (font.widthOfTextAtSize(t, size) > maxw && cur) { lines.push(cur); cur = w; } else cur = t;
      });
      if (cur) lines.push(cur); return lines;
    };

    const soVoo = (d.voos && d.voos.length) && !(d.hotel && d.hotel.nome);
    const titulo = soVoo ? 'Cotação de Voos' : 'Cotação de Viagem';

    // faixa topo
    page.drawRectangle({ x: 0, y: y - 44, width: W, height: 44, color: NAVY });
    txt('MD VIAGENS', ML, y - 29, 13, B, rgb(1, 1, 1));
    txt(titulo, W - MR - B.widthOfTextAtSize(titulo, 11), y - 28, 11, B, GOLD);
    y -= 74;

    // título e dados
    txt(titulo, ML, y, 24, B, NAVY); y -= 22;
    const cli = (d.cliente && d.cliente.nome) || '';
    if (cli) { txt('Cliente: ' + cli, ML, y, 10.5, H, MUTED); y -= 15; }
    const cia = (d.voos && d.voos[0] && d.voos[0].trechos && d.voos[0].trechos[0] && d.voos[0].trechos[0].cia) || '';
    const dataCot = (d.valores && d.valores.cotadoEm) || '';
    const lin2 = [cia ? ('Companhia Aérea: ' + cia) : '', dataCot ? ('Data da cotação: ' + dataCot) : '', d.codigo || ''].filter(Boolean).join('   •   ');
    if (lin2) { txt(lin2, ML, y, 10.5, H, MUTED); y -= 15; }
    y -= 8;

    const secTitle = (t) => {
      txt(t, ML, y, 13, B, NAVY); y -= 6;
      page.drawLine({ start: { x: ML, y }, end: { x: W - MR, y }, thickness: 1, color: LINE }); y -= 16;
    };

    // ===== VOOS (tabela) =====
    const trechos = (d.voos && d.voos[0] && d.voos[0].trechos) || [];
    if (trechos.length) {
      secTitle('Itinerário');
      const cols = [
        { t: 'Trecho', w: 46 }, { t: 'Data', w: 92 }, { t: 'Cia', w: 52 },
        { t: 'Origem', w: 100 }, { t: 'Destino', w: 100 }, { t: 'Saída', w: 42 }, { t: 'Chegada', w: 48 }, { t: 'Tipo', w: 60 }
      ];
      let x = ML;
      page.drawRectangle({ x: ML, y: y - 4, width: CW, height: 18, color: NAVY });
      cols.forEach(c => { txt(c.t, x + 4, y, 9, B, rgb(1, 1, 1)); x += c.w; });
      y -= 20;
      trechos.forEach(t => {
        x = ML;
        const vals = [
          t.tipo === 'volta' ? 'Volta' : 'Ida', t.data || '', t.iata || t.cia || '',
          (t.de || '') + ' ' + (t.deCidade || ''), (t.para || '') + ' ' + (t.paraCidade || ''),
          t.saida || '', t.chegada || '', /direto/i.test(t.conexao || '') ? 'Direto' : (t.conexao ? '1 parada' : '—')
        ];
        vals.forEach((v, i) => {
          const lines = wrap(v, 8.5, H, cols[i].w - 8);
          txt(lines[0] || '', x + 4, y, 8.5, H, INK);
          if (lines[1]) txt(lines[1], x + 4, y - 10, 8.5, H, INK);
          x += cols[i].w;
        });
        page.drawLine({ start: { x: ML, y: y - 16 }, end: { x: W - MR, y: y - 16 }, thickness: 0.7, color: LINE });
        y -= 26;
      });
      const nums = trechos.filter(t => t.voo).map(t => (t.tipo === 'volta' ? 'volta voo ' : 'ida voo ') + t.voo);
      if (nums.length) { txt(nums.join(' e ') + '.', ML, y, 9, H, MUTED); y -= 14; }
      const bag = trechos[0] && trechos[0].bagagem;
      if (bag) { txt(bag, ML, y, 9, H, MUTED); y -= 14; }
      y -= 8;
    }

    // ===== HOTEL =====
    if (d.hotel && d.hotel.nome) {
      secTitle('Hospedagem');
      txt(d.hotel.nome, ML, y, 12, B, INK); y -= 15;
      if (d.hotel.endereco) { wrap(d.hotel.endereco, 9.5, H, CW).forEach(l => { txt(l, ML, y, 9.5, H, MUTED); y -= 12; }); }
      const per = [d.hotel.checkin && d.hotel.checkout ? `Período: ${d.hotel.checkin} a ${d.hotel.checkout}` : '', d.hotel.noites ? `${d.hotel.noites} noites` : ''].filter(Boolean).join('   •   ');
      if (per) { txt(per, ML, y, 10, H, INK); y -= 14; }
      (d.hotel.quartos || []).forEach(q => {
        const l = [q.nome, q.ocupacao, q.plano, q.restricao].filter(Boolean).join('  ·  ');
        wrap(l, 9.5, H, CW).forEach(s => { txt(s, ML, y, 9.5, H, INK); y -= 12; });
      });
      y -= 10;
    }

    // ===== TRANSFER / SEGURO =====
    if (d.transfer) {
      secTitle('Transfer');
      const l = [d.transfer.tipo, d.transfer.trajeto, d.transfer.detalhe].filter(Boolean).join('  ·  ');
      wrap(l, 9.5, H, CW).forEach(s => { txt(s, ML, y, 9.5, H, INK); y -= 12; });
      y -= 10;
    }
    if (d.seguro) {
      secTitle('Seguro viagem');
      const l = [d.seguro.nome, d.seguro.plano, d.seguro.periodo, d.seguro.viajantes].filter(Boolean).join('  ·  ');
      wrap(l, 9.5, H, CW).forEach(s => { txt(s, ML, y, 9.5, H, INK); y -= 12; });
      y -= 10;
    }

    // ===== VALOR =====
    secTitle(soVoo ? 'Valor' : 'Forma de Investimento');
    const v = d.valores || {};
    const brl = n => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const pad2 = n => String(n).padStart(2, '0');
    if (v.parcelas && v.valorParcelaNum) {
      txt(`Pagamento em até ${v.parcelas}X sem juros no cartão.`, ML, y, 13, B, NAVY); y -= 17;
      if (v.taxaUnicaNum) {
        txt(`01x ${brl(v.valorParcelaNum + v.taxaUnicaNum)} (${brl(v.taxaUnicaNum)} das taxas de embarque + ${brl(v.valorParcelaNum)} da primeira parcela)`, ML, y, 10.5, B, INK); y -= 14;
        txt(`+ ${pad2(v.parcelas - 1)}X de ${brl(v.valorParcelaNum)}`, ML, y, 10.5, B, INK); y -= 14;
      } else {
        txt(`${pad2(v.parcelas)}X de ${brl(v.valorParcelaNum)}`, ML, y, 10.5, B, INK); y -= 14;
      }
      y -= 4;
    }
    txt(`Valor total${v.taxasInclusas ? ' (taxas inclusas)' : ''}:  ${brl(v.totalNum)}`, ML, y, 11.5, B, INK); y -= 18;
    y -= 6;

    // ===== CONDIÇÕES =====
    secTitle('Condições');
    const conds = [
      'Qualquer alteração, remarcação ou cancelamento estará sujeito a multas e diferenças tarifárias, conforme as regras da companhia aérea e dos hotéis.',
      `Os preços foram cotados em ${v.cotadoEm || ''}. Valores e disponibilidade sujeitos a alteração até o momento da emissão.`,
      'Cotação válida somente para as datas e serviços indicados acima.'
    ];
    conds.forEach(c => {
      wrap('•  ' + c, 9, H, CW).forEach(s => { txt(s, ML, y, 9, H, rgb(0.29, 0.33, 0.41)); y -= 11.5; });
      y -= 3;
    });

    // ===== CONTATO + rodapé =====
    y -= 8;
    const ag = d.agente || {};
    txt(`${ag.nome || 'Gabriela Aquino'}  ·  ${ag.telefone || '(31) 98365-1769'}  ·  ${ag.email || 'gabriela@mdviagens.com'}`, ML, y, 10, B, NAVY);
    page.drawRectangle({ x: 0, y: 0, width: W, height: 34, color: NAVY });
    const foot = 'MD VIAGENS  •  Consulte-nos para emissão!  •  Agência homologada Cadastur';
    txt(foot, (W - B.widthOfTextAtSize(foot, 10)) / 2, 12, 10, B, GOLD);

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
