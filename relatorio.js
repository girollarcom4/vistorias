'use strict';
/**
 * Relatório da vistoria (A4). Um só desenho para três usos: a tela do app (fotos em blob:), o PDF
 * que vai para o Drive (fotos em data: URI, convertido pelo Apps Script) e a migração em Node.
 * O conversor HTML->PDF do Google é antigo: nada de flex/grid — layout com tabela e inline-block.
 *
 * relatorioHTML(v, foto, { barra }) — foto(ref) devolve a URL da imagem; ref = { vid, fid }.
 */
(function (raiz) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dataBR = (iso, soData) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return soData
      ? d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
  };
  const ESTADO_REV = { corrigido: 'Corrigido', parcial: 'Parcialmente corrigido', nao: 'Não corrigido' };
  const TIPO = { interna: 'Vistoria interna', cliente: 'Vistoria do cliente', revistoria: 'Revistoria' };

  function contar(v) {
    if (v.tipo === 'revistoria') {
      const rev = v.revisao || [];
      const corr = rev.filter((r) => r.estado === 'corrigido').length;
      const feitos = rev.filter((r) => r.estado).length;
      const novos = (v.novos || []).length;
      return { tot: rev.length, feitos, ok: corr, d: rev.length - corr + novos, novos, abertos: feitos - corr + (rev.length - feitos) + novos };
    }
    let d = 0, ok = 0, na = 0, tot = 0;
    for (const a of v.ambientes || []) for (const i of a.itens || []) { tot++; if (i.estado === 'defeito') d++; else if (i.estado === 'ok') ok++; else if (i.estado === 'na') na++; }
    return { tot, feitos: ok + d + na, ok, d, na, abertos: d };
  }

  // Defeitos que continuam abertos depois desta vistoria — é o que a próxima revistoria confere.
  function pendentesDe(v) {
    if (v.tipo === 'revistoria') {
      const seguem = (v.revisao || []).filter((r) => r.estado !== 'corrigido').map((r) => ({
        ambiente: r.ambiente,
        item: r.item,
        desde: r.desde,
        obsAntes: (r.obs || '').trim() || r.obsAntes,
        fotosAntes: (r.fotos || []).length ? r.fotos.map((fid) => ({ vid: v.id, fid })) : r.fotosAntes || [],
      }));
      const novos = (v.novos || []).map((n) => ({ ambiente: n.ambiente, item: n.nome, desde: v.criadoEm, obsAntes: n.obs, fotosAntes: (n.fotos || []).map((fid) => ({ vid: v.id, fid })) }));
      return seguem.concat(novos);
    }
    const out = [];
    for (const a of v.ambientes || []) {
      for (const i of a.itens || []) {
        if (i.estado === 'defeito') out.push({ ambiente: a.nome, item: i.nome, desde: v.criadoEm, obsAntes: i.obs, fotosAntes: (i.fotos || []).map((fid) => ({ vid: v.id, fid })) });
      }
    }
    return out;
  }

  function relatorioHTML(v, foto, opts = {}) {
    const grade = (refs) =>
      refs && refs.length ? `<div class="fotos">${refs.map((r) => `<img src="${esc(foto(r))}">`).join('')}</div>` : '';
    const minhas = (lista) => (lista || []).map((fid) => ({ vid: v.id, fid }));
    const c = contar(v);
    let corpo = '';

    if (v.tipo === 'revistoria') {
      const o = v.origem || {};
      const linhas = (v.revisao || []).map((r) => `<tr class="${r.estado === 'corrigido' ? 'corr' : 'aberto'}">
          <td><b>${esc(r.ambiente)} · ${esc(r.item)}</b><br><span class="mudo">apontado em ${esc(dataBR(r.desde, true))}</span><br>${esc(r.obsAntes || '—')}${grade(r.fotosAntes)}</td>
          <td><b class="est">${esc(ESTADO_REV[r.estado] || 'Não conferido')}</b><br>${esc(r.obs || '')}${grade(minhas(r.fotos))}</td></tr>`).join('');
      const novos = (v.novos || []).map((n) => `<tr><td><b>${esc(n.ambiente)} · ${esc(n.nome)}</b></td><td>${esc(n.obs || '—')}${grade(minhas(n.fotos))}</td></tr>`).join('');
      corpo = `
        <p class="mudo">Confere os defeitos da ${esc((TIPO[o.tipo] || 'vistoria').toLowerCase())} de ${esc(dataBR(o.criadoEm, true))}${o.por ? ' (' + esc(o.por) + ')' : ''}.</p>
        <h2>Defeitos apontados — antes × depois</h2>
        ${linhas ? `<table class="def"><thead><tr><th style="width:50%">Antes</th><th>Depois</th></tr></thead><tbody>${linhas}</tbody></table>` : '<p class="mudo">Nenhum defeito em aberto.</p>'}
        ${novos ? `<h2>Defeitos novos encontrados</h2><table class="def"><thead><tr><th style="width:35%">Item</th><th>Descrição</th></tr></thead><tbody>${novos}</tbody></table>` : ''}`;
    } else {
      corpo = (v.ambientes || []).map((a) => {
        const defs = (a.itens || []).filter((i) => i.estado === 'defeito');
        const oks = (a.itens || []).filter((i) => i.estado === 'ok').map((i) => esc(i.nome));
        const nas = (a.itens || []).filter((i) => i.estado === 'na').length;
        const pend = (a.itens || []).filter((i) => !i.estado).length;
        const vazio = !defs.length && !oks.length && !(a.obs || '').trim() && !(a.fotos || []).length;
        if (vazio && !pend) return '';
        return `<div class="amb"><h3>${esc(a.nome)}</h3>
          ${defs.length ? `<table class="def"><thead><tr><th style="width:30%">Defeito apontado</th><th>Observação</th></tr></thead><tbody>${defs
            .map((i) => `<tr><td><b>${esc(i.nome)}</b></td><td>${esc(i.obs || '—')}${grade(minhas(i.fotos))}</td></tr>`).join('')}</tbody></table>` : ''}
          ${oks.length ? `<p class="ok"><b>Conforme:</b> ${oks.join(' · ')}</p>` : ''}
          ${nas ? `<p class="mudo">${nas} item(ns) não se aplica(m).</p>` : ''}
          ${pend ? `<p class="mudo">${pend} item(ns) não vistoriado(s).</p>` : ''}
          ${(a.obs || '').trim() ? `<p><b>Observações:</b> ${esc(a.obs)}</p>` : ''}
          ${grade(minhas(a.fotos))}</div>`;
      }).join('');
      corpo = `<h2>Ambientes</h2>${corpo || '<p class="mudo">Nenhum item preenchido.</p>'}`;
    }

    const resumo = v.tipo === 'revistoria'
      ? `<td class="o"><b>${c.ok}</b>corrigidos</td><td class="d"><b>${c.tot - c.ok}</b>ainda abertos</td><td class="d"><b>${c.novos}</b>defeitos novos</td>`
      : `<td class="o"><b>${c.ok}</b>conformes</td><td class="d"><b>${c.d}</b>defeitos</td><td><b>${c.na}</b>não se aplicam</td>`;
    const situacao = !v.concluida ? 'Em andamento' : c.abertos ? `Concluída · ${c.abertos} defeito(s) em aberto` : 'Concluída · sem defeitos em aberto — unidade liberada';
    const assin = (rotulo, nome, img) => `<td class="assin">${img ? `<img src="${esc(img)}">` : '<div class="vaz"></div>'}<div class="nome">${esc(rotulo)}${nome ? ': ' + esc(nome) : ''}</div></td>`;
    const logo = opts.logo === undefined ? 'girollar-logo.svg' : opts.logo;
    const marca = logo ? `<img src="${esc(logo)}" alt="Girollar">` : '<b style="font-size:20px;color:#1f2f4a;letter-spacing:.08em">GIROLLAR</b>';

    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vistoria ${esc(v.empreendimento)} ${esc(v.unidade)}</title>
<style>
  body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:0;background:#fff}
  .folha{max-width:190mm;margin:0 auto;padding:10px}
  table.cab{width:100%;border-bottom:3px solid #e8731a;margin-bottom:10px} .cab img{height:40px}
  .cab h1{font-size:18px;margin:0;color:#1f2f4a;text-align:right} .cab small{color:#6b7280;display:block;text-align:right}
  table.dados{width:100%;margin-bottom:8px} .dados td{padding:2px 8px 2px 0;vertical-align:top;width:50%} .dados span{color:#6b7280;font-size:11px;display:block}
  table.resumo{width:100%;border-collapse:separate;border-spacing:8px 0;margin:6px 0 12px} .resumo td{border:1px solid #e5e7eb;padding:6px;text-align:center}
  .resumo b{display:block;font-size:19px} .resumo .d b{color:#b91c1c} .resumo .o b{color:#15803d}
  h2{font-size:14px;color:#1f2f4a;margin:14px 0 6px;border-bottom:1px solid #e5e7eb;padding-bottom:3px}
  .amb{margin-bottom:10px;page-break-inside:avoid} .amb h3{margin:8px 0 4px;font-size:13px;background:#f3f4f6;padding:4px 8px;border-left:4px solid #1f2f4a}
  table.def{width:100%;border-collapse:collapse;margin:4px 0} .def th,.def td{border:1px solid #e5e7eb;padding:5px 7px;vertical-align:top;text-align:left}
  .def th{background:#fef2f2;font-size:11px} tr.corr .est{color:#15803d} tr.aberto .est{color:#b91c1c}
  .ok{color:#166534;margin:4px 0} .mudo{color:#6b7280;margin:2px 0;font-size:11px}
  .fotos{margin:5px 0 0} .fotos img{height:120px;margin:0 5px 5px 0;border:1px solid #d1d5db;vertical-align:top}
  table.assinaturas{width:100%;margin-top:24px;page-break-inside:avoid} .assin{text-align:center;padding:0 14px;vertical-align:bottom}
  .assin img{max-height:64px;max-width:100%} .assin .vaz{height:56px} .assin .nome{border-top:1px solid #111;padding-top:3px;font-size:11px}
  .rodape{margin-top:16px;color:#6b7280;font-size:10px;text-align:center}
  .barra{text-align:right;padding:8px 10px;background:#eef0f3} .barra button{background:#1f2f4a;color:#fff;border:0;border-radius:8px;padding:9px 14px;font:inherit;margin-left:6px}
  @media print{.barra{display:none}@page{size:A4;margin:12mm}}
</style></head><body>
${opts.barra ? `<div class="barra">${opts.barra}</div>` : ''}
<div class="folha">
  <table class="cab"><tr><td>${marca}</td><td><h1>Relatório de ${v.tipo === 'revistoria' ? 'Revistoria' : 'Vistoria'}</h1><small>${esc(TIPO[v.tipo] || 'Vistoria')}</small></td></tr></table>
  <table class="dados">
    <tr><td><span>Empreendimento</span>${esc(v.empreendimento)}</td><td><span>Unidade</span>${esc(v.unidade)}</td></tr>
    <tr><td><span>Vistoriado por</span>${esc(v.por)}</td><td><span>Data</span>${esc(dataBR(v.criadoEm))}</td></tr>
    <tr>${v.tipo === 'cliente' ? `<td><span>Cliente</span>${esc(v.cliente || '—')}</td>` : '<td></td>'}<td><span>Situação</span>${esc(situacao)}</td></tr>
  </table>
  <table class="resumo"><tr>${resumo}</tr></table>
  ${corpo}
  ${(v.obsGerais || '').trim() ? `<h2>Observações gerais</h2><p>${esc(v.obsGerais).replace(/\n/g, '<br>')}</p>` : ''}
  ${grade(minhas(v.fotosGerais))}
  <table class="assinaturas"><tr>
    ${assin('Vistoriador', v.por, v.assinaturaVistoriador)}
    ${v.tipo === 'cliente' ? assin('Cliente', v.cliente, v.assinaturaCliente) : ''}
  </tr></table>
  <div class="rodape">Girollar Incorporações e Construções · gerado em ${esc(dataBR(new Date().toISOString()))}</div>
</div></body></html>`;
  }

  // Todas as fotos que o relatório usa (as desta vistoria e as "de antes" de outra).
  function fotosDoRelatorio(v) {
    const out = [];
    const minhas = (l) => (l || []).forEach((fid) => out.push({ vid: v.id, fid }));
    minhas(v.fotosGerais);
    for (const a of v.ambientes || []) { minhas(a.fotos); for (const i of a.itens || []) minhas(i.fotos); }
    for (const r of v.revisao || []) { (r.fotosAntes || []).forEach((x) => out.push(x)); minhas(r.fotos); }
    for (const n of v.novos || []) minhas(n.fotos);
    return out;
  }

  const api = { relatorioHTML, contar, pendentesDe, fotosDoRelatorio, dataBR, TIPO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Relatorio = api;
})(typeof self !== 'undefined' ? self : this);
