'use strict';
/**
 * Vistorias Girollar - app do celular.
 *
 * Tudo que se preenche vive NO APARELHO (IndexedDB), então funciona sem sinal. Quando há rede
 * o app envia a vistoria e as fotos ao Apps Script, que grava no Google Drive (pasta Vistorias)
 * e gera o PDF. Sem login por pessoa: "vistoriado por" identifica quem fez; um código de acesso
 * da equipe é pedido uma vez por aparelho.
 *
 * Tipos: interna, cliente (checklist por ambiente) e revistoria (confere os defeitos que ficaram
 * abertos numa vistoria anterior: corrigido / parcial / não corrigido, com foto de depois).
 */

// ---------- modelo ----------
const BASE = ['Piso', 'Paredes / pintura', 'Teto / forro', 'Portas', 'Janelas / esquadrias', 'Tomadas e interruptores', 'Iluminação'];
const MOLHADO = ['Torneira e sifão', 'Ralos e caimento'];
const AMBIENTES = [
  ['Cozinha', [...BASE, 'Bancada / pia', ...MOLHADO, 'Ponto de gás']],
  ['Lavação', [...BASE, 'Tanque', ...MOLHADO, 'Ponto da máquina de lavar']],
  ['Sala', BASE],
  ['Sacada', ['Piso e caimento', 'Guarda-corpo', 'Ralo', 'Paredes / pintura', 'Esquadrias']],
  ['Quarto 1', BASE],
  ['Quarto 2', BASE],
  ['Banheiro 1', [...BASE, 'Louças (vaso e lavatório)', 'Metais e registros', 'Box / vidro', 'Revestimento cerâmico', ...MOLHADO]],
  ['Banheiro 2 (suíte)', [...BASE, 'Louças (vaso e lavatório)', 'Metais e registros', 'Box / vidro', 'Revestimento cerâmico', ...MOLHADO]],
];
const { contar, pendentesDe, relatorioHTML, fotosDoRelatorio, TIPO } = Relatorio;

// ---------- obra: perfis e diário ----------
const PAPEIS = { vistoriador: 'Vistoriador', engenheiro: 'Engenheiro', mestre: 'Mestre de obras' };
const CLIMAS = [['sol', '☀ Sol'], ['nublado', '⛅ Nublado'], ['chuva', '🌧 Chuva']];
const TIPOS_OCORRENCIA = ['Ocorrência', 'Atraso', 'Falta de material', 'Segurança', 'Visita / fiscalização', 'Retrabalho'];
const fmtDia = (d) => String(d || '').split('-').reverse().join('/');
const hojeISO = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso do aparelho
let perfil = (() => {
  try { return JSON.parse(localStorage.getItem('perfilGirollar')) || null; } catch { return null; }
})();

// Diário de obra: um registro por obra e dia. Mora no mesmo banco das vistorias (tipo 'diario'),
// então reaproveita fotos, fila de envio e sincronização.
function novoDiario({ empreendimento, data, por, papel }) {
  return {
    id: uid(),
    tipo: 'diario',
    empreendimento,
    unidade: '',
    data,
    por,
    papel,
    criadoEm: agora(),
    atualizadoEm: agora(),
    concluida: false,
    fechado: false,
    clima: { manha: null, tarde: null },
    efetivo: { proprio: '', terceiros: '' },
    servicos: [],
    ocorrencias: [],
    obsGerais: '',
    fotosGerais: [],
    _sync: { sujo: true },
  };
}

const uid = () => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') + Date.now().toString(36);
};
const agora = () => new Date().toISOString();

function novaVistoria({ tipo, empreendimento, unidade, por, cliente }) {
  return {
    id: uid(),
    tipo,
    empreendimento,
    unidade,
    por,
    cliente: tipo === 'cliente' ? cliente : '',
    criadoEm: agora(),
    atualizadoEm: agora(),
    concluida: false,
    obsGerais: '',
    fotosGerais: [],
    assinaturaVistoriador: '',
    assinaturaCliente: '',
    ambientes: AMBIENTES.map(([nome, itens]) => ({
      id: uid(),
      nome,
      obs: '',
      fotos: [],
      itens: itens.map((n) => ({ id: uid(), nome: n, estado: null, obs: '', fotos: [] })),
    })),
    _sync: { sujo: true },
  };
}

// A revistoria nasce dos defeitos que ficaram abertos na vistoria anterior (que pode ser outra revistoria).
function novaRevistoria(origem, por) {
  return {
    id: uid(),
    tipo: 'revistoria',
    empreendimento: origem.empreendimento,
    unidade: origem.unidade,
    por,
    cliente: '',
    origem: { id: origem.id, tipo: origem.tipo, criadoEm: origem.criadoEm, por: origem.por },
    criadoEm: agora(),
    atualizadoEm: agora(),
    concluida: false,
    obsGerais: '',
    fotosGerais: [],
    assinaturaVistoriador: '',
    assinaturaCliente: '',
    ambientes: [],
    revisao: pendentesDe(origem).map((p) => ({ id: uid(), ...p, estado: null, obs: '', fotos: [] })),
    novos: [],
    _sync: { sujo: true },
  };
}

// ---------- IndexedDB ----------
let idb;
function abrirBanco() {
  return new Promise((ok, erro) => {
    const r = indexedDB.open('vistorias-girollar', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('vistorias', { keyPath: 'id' });
      r.result.createObjectStore('fotos', { keyPath: 'id' });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  });
}
function tx(store, modo, fn) {
  return new Promise((ok, erro) => {
    const t = idb.transaction(store, modo);
    const s = t.objectStore(store);
    let res;
    const rq = fn(s);
    if (rq) rq.onsuccess = () => (res = rq.result);
    t.oncomplete = () => ok(res);
    t.onerror = () => erro(t.error);
  });
}
const bdTodas = () => tx('vistorias', 'readonly', (s) => s.getAll());
const bdGet = (id) => tx('vistorias', 'readonly', (s) => s.get(id));
const bdPut = (v) => tx('vistorias', 'readwrite', (s) => s.put(v));
const bdDel = (id) => tx('vistorias', 'readwrite', (s) => s.delete(id));
const fotoPut = (f) => tx('fotos', 'readwrite', (s) => s.put(f));
const fotoGet = (id) => tx('fotos', 'readonly', (s) => s.get(id));
const fotoDel = (id) => tx('fotos', 'readwrite', (s) => s.delete(id));
const fotosTodas = () => tx('fotos', 'readonly', (s) => s.getAll());

// ---------- estado ----------
let vis = null; // vistoria aberta
let tela = { nome: 'lista' };
let unidades = {};
let ultimoNome = (perfil && perfil.nome) || localStorage.getItem('vistoriadoPor') || '';
let alvoFoto = null;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let timerSalvar = null;
function tocar() {
  if (!vis) return;
  vis.atualizadoEm = agora();
  vis._sync = { ...(vis._sync || {}), sujo: true };
  clearTimeout(timerSalvar);
  timerSalvar = setTimeout(salvarAgora, 400);
}
async function salvarAgora() {
  clearTimeout(timerSalvar);
  if (!vis) return;
  await bdPut(vis);
  agendarSync();
}

// ---------- fotos: reduz no aparelho antes de guardar/enviar ----------
const LADO_MAX = 1600; // px do lado maior; ~250-450 KB em JPEG 0.8
async function carregarImagem(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return new Promise((ok, erro) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = erro;
      img.src = URL.createObjectURL(file);
    });
  }
}
async function comprimir(file) {
  const bmp = await carregarImagem(file);
  const w0 = bmp.width || bmp.naturalWidth;
  const h0 = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, LADO_MAX / Math.max(w0, h0));
  const w = Math.round(w0 * k);
  const h = Math.round(h0 * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  // Carimbo com unidade e data/hora: a foto vira prova do estado naquele momento.
  const txt = `${vis.tipo === 'diario' ? vis.empreendimento : vis.unidade} · ${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`;
  const fs = Math.max(14, Math.round(Math.max(w, h) * 0.022));
  g.font = `600 ${fs}px system-ui, sans-serif`;
  const tw = g.measureText(txt).width;
  g.fillStyle = 'rgba(0,0,0,.55)';
  g.fillRect(w - tw - fs, h - fs * 1.9, tw + fs, fs * 1.9);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(txt, w - tw - fs / 2, h - fs * 0.95);
  return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
}

// Versão menor só para o PDF (o arquivo inteiro vai num POST ao Apps Script).
async function miniaturaDataURL(blob) {
  const bmp = await carregarImagem(blob);
  const w0 = bmp.width || bmp.naturalWidth;
  const h0 = bmp.height || bmp.naturalHeight;
  const k = Math.min(1, 900 / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k);
  c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c.toDataURL('image/jpeg', 0.6);
}

function listaDoAlvo(alvo) {
  if (alvo.t === 'geral') return vis.fotosGerais;
  if (alvo.t === 'rev') return vis.revisao.find((x) => x.id === alvo.i).fotos;
  if (alvo.t === 'novo') return vis.novos.find((x) => x.id === alvo.i).fotos;
  if (alvo.t === 'serv') return vis.servicos.find((x) => x.id === alvo.i).fotos;
  if (alvo.t === 'oc') return vis.ocorrencias.find((x) => x.id === alvo.i).fotos;
  const a = vis.ambientes.find((x) => x.id === alvo.a);
  if (alvo.t === 'amb') return a.fotos;
  return a.itens.find((x) => x.id === alvo.i).fotos;
}

async function receberFotos(files) {
  if (!alvoFoto || !files.length) return;
  const lista = listaDoAlvo(alvoFoto);
  for (const f of files) {
    try {
      const blob = await comprimir(f);
      const id = uid();
      await fotoPut({ id, vid: vis.id, blob, enviada: false });
      lista.push(id);
    } catch (e) {
      alert('Não consegui ler essa foto.');
    }
  }
  tocar();
  await salvarAgora();
  desenhar();
}

async function removerFoto(alvo, id) {
  const lista = listaDoAlvo(alvo);
  const i = lista.indexOf(id);
  if (i >= 0) lista.splice(i, 1);
  await fotoDel(id);
  tocar();
  await salvarAgora();
  desenhar();
}

// Foto local; se não está no aparelho (veio de outra vistoria/aparelho), busca no Drive e guarda.
async function blobDaFoto(vid, fid) {
  const f = await fotoGet(fid);
  if (f && f.blob) return f.blob;
  if (!navigator.onLine) return null;
  try {
    const { b64 } = await Api.fotoGet(vid, fid);
    const blob = b64ParaBlob(b64);
    await fotoPut({ id: fid, vid, blob, enviada: true, remota: true });
    return blob;
  } catch {
    return null;
  }
}

const urlsBlob = [];
async function hidratarFotos() {
  urlsBlob.splice(0).forEach((u) => URL.revokeObjectURL(u));
  for (const img of document.querySelectorAll('img[data-foto]')) {
    const blob = await blobDaFoto(img.dataset.vid || (vis && vis.id), img.dataset.foto);
    if (blob) {
      const u = URL.createObjectURL(blob);
      urlsBlob.push(u);
      img.src = u;
    }
  }
}

// ---------- sincronizacao ----------
let sincronizando = false;
let timerSync = null;
let statusSync = '';
let precisaCodigo = false;
let ultimoErro = '';

function agendarSync() {
  clearTimeout(timerSync);
  timerSync = setTimeout(sincronizar, 2500);
  atualizarTopoSync();
}

async function pendentes() {
  const vs = (await bdTodas()).filter((v) => v._sync && (v._sync.sujo || (v.concluida && v._sync.pdfDe !== v.atualizadoEm)));
  const fs = (await fotosTodas()).filter((f) => !f.enviada);
  return { vs, fs };
}

async function enviarFotosDe(vid, ids) {
  for (const fid of ids) {
    const f = await fotoGet(fid);
    if (!f || !f.blob) continue;
    await Api.foto(vid, fid, await blobParaB64(f.blob));
    f.enviada = true;
    await fotoPut(f);
  }
}

// HTML do relatório com as fotos embutidas (data: URI) — o Apps Script converte em PDF.
async function htmlParaPdf(v) {
  const mapa = {};
  for (const r of fotosDoRelatorio(v)) {
    const blob = await blobDaFoto(r.vid, r.fid);
    if (blob) mapa[r.fid] = await miniaturaDataURL(blob);
  }
  return relatorioHTML(v, (r) => mapa[r.fid] || '', { logo: await logoPng() });
}

// O conversor do Google não desenha SVG: rasteriza o logo uma vez.
let logoCache = '';
function logoPng() {
  if (logoCache) return Promise.resolve(logoCache);
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const h = 120;
      c.width = Math.round((img.naturalWidth / img.naturalHeight) * h) || 360;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      ok((logoCache = c.toDataURL('image/png')));
    };
    img.onerror = () => ok('');
    img.src = 'girollar-logo.svg';
  });
}

async function sincronizar() {
  if (sincronizando || !navigator.onLine) return atualizarTopoSync();
  if (!Api.temToken()) { precisaCodigo = true; return atualizarTopoSync(); }
  sincronizando = true;
  statusSync = 'enviando…';
  atualizarTopoSync();
  try {
    for (const v0 of await bdTodas()) {
      const v = await bdGet(v0.id);
      const fotosPend = (await fotosTodas()).filter((f) => f.vid === v.id && !f.enviada).map((f) => f.id);
      const sujo = v._sync && v._sync.sujo;
      const faltaPdf = v.concluida && (v._sync || {}).pdfDe !== v.atualizadoEm;
      if (!sujo && !fotosPend.length && !faltaPdf) continue;
      const versao = v.atualizadoEm;
      if (sujo || fotosPend.length) {
        const { _sync, ...doc } = v;
        const { faltam } = await Api.salvar(doc);
        await enviarFotosDe(v.id, [...new Set([...(faltam || []), ...fotosPend])]);
      }
      let pdf = {};
      if (v.concluida) pdf = await Api.pdf(v.id, await htmlParaPdf(v));
      // Só marca como enviada se ninguém editou no meio do envio.
      const atual = await bdGet(v.id);
      if (atual && atual.atualizadoEm === versao) {
        atual._sync = { sujo: false, enviadoEm: agora(), pdfDe: v.concluida ? versao : undefined, pdfUrl: pdf.url || (atual._sync || {}).pdfUrl };
        await bdPut(atual);
        if (vis && vis.id === atual.id) vis._sync = atual._sync;
      }
    }
    statusSync = '';
    ultimoErro = '';
    precisaCodigo = false;
  } catch (e) {
    if (e.codigo) {
      precisaCodigo = true;
      localStorage.removeItem('vistoriasToken');
      statusSync = 'código pendente';
      pedirCodigo();
    } else {
      statusSync = 'falha ao enviar';
      ultimoErro = e.message;
    }
  } finally {
    sincronizando = false;
    atualizarTopoSync();
    if (tela.nome === 'lista') desenhar();
  }
}

async function atualizarTopoSync() {
  const el = $('#sync');
  if (!el) return;
  const { vs, fs } = await pendentes();
  const n = vs.length + fs.length;
  let txt;
  if (!navigator.onLine) txt = n ? `sem sinal · ${n} a enviar` : 'sem sinal';
  else if (sincronizando) txt = 'enviando…';
  else if (precisaCodigo) txt = 'digite o código';
  else if (statusSync === 'falha ao enviar') txt = `falha · ${n} a enviar ↻`;
  else if (n) txt = `${n} a enviar ↻`;
  else txt = '✓ tudo enviado';
  el.textContent = txt;
}

// Aviso que não dá para ignorar: algo preso no aparelho há mais de 6 horas.
async function alertaEnvio() {
  const LIMITE = 6 * 3600 * 1000;
  const presas = (await bdTodas()).filter((v) => v._sync && v._sync.sujo && Date.now() - new Date(v.atualizadoEm) > LIMITE);
  if (!presas.length) {
    if (!precisaCodigo || !(await pendentes()).vs.length) return '';
    return `<div class="aviso">Há registro a enviar e falta o código da equipe. <button class="peq" data-act="sync">Digitar código</button></div>`;
  }
  const motivo = precisaCodigo ? 'falta digitar o código da equipe' : !navigator.onLine ? 'o aparelho está sem internet' : ultimoErro ? `erro: ${esc(ultimoErro)}` : 'o envio não está passando';
  return `<div class="alerta">⚠ ${presas.length ? `${presas.length} registro(s) ainda NÃO chegaram ao Drive` : 'Envio parado'} — ${motivo}.
    Não apague o app nem limpe os dados do navegador. <button class="peq" data-act="sync" style="margin-top:6px">Tentar enviar agora</button></div>`;
}

function pedirCodigo() {
  $('#modalCorpo').innerHTML = `
    <h3 style="margin:0 0 6px">Código de acesso</h3>
    <p class="mudo" style="margin:0 0 8px">Peça o código da equipe. Só é pedido uma vez neste aparelho.</p>
    <input type="text" id="inCodigo" inputmode="numeric" autocomplete="off" placeholder="000000">
    <p id="erroCodigo" style="color:var(--bad);margin:6px 0 0;font-size:13px"></p>
    <div class="acoes"><button class="pri" id="btCodigo">Entrar</button></div>`;
  $('#modal').classList.add('on');
  $('#btCodigo').onclick = async () => {
    try {
      await Api.entrar($('#inCodigo').value.trim());
      $('#modal').classList.remove('on');
      precisaCodigo = false;
      sincronizar();
      if (tela.nome === 'equipe') desenhar();
    } catch (e) {
      $('#erroCodigo').textContent = e.codigo ? 'Código incorreto.' : 'Sem conexão com o servidor. Tente com sinal.';
    }
  };
}

// ---------- assinatura ----------
function ligarAssinatura(canvas, inicial, aoMudar) {
  const ratio = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * ratio;
  canvas.height = r.height * ratio;
  const g = canvas.getContext('2d');
  g.scale(ratio, ratio);
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  g.strokeStyle = '#111';
  if (inicial) {
    const img = new Image();
    img.onload = () => g.drawImage(img, 0, 0, r.width, r.height);
    img.src = inicial;
  }
  let desenhando = false;
  const pos = (e) => {
    const b = canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  canvas.onpointerdown = (e) => {
    desenhando = true;
    canvas.setPointerCapture(e.pointerId);
    g.beginPath();
    g.moveTo(...pos(e));
  };
  canvas.onpointermove = (e) => {
    if (!desenhando) return;
    g.lineTo(...pos(e));
    g.stroke();
  };
  const fim = () => {
    if (!desenhando) return;
    desenhando = false;
    aoMudar(canvas.toDataURL('image/png'));
  };
  canvas.onpointerup = fim;
  canvas.onpointercancel = fim;
}

// ---------- telas ----------
function topo({ titulo, voltar }) {
  $('#topo').innerHTML = `
    ${voltar ? `<button class="voltar" data-act="voltar" aria-label="Voltar">‹</button>` : `<img src="girollar-logo-reduzido.svg" alt="">`}
    <h1>${esc(titulo)}</h1>
    <button id="sync" data-act="sync"></button>`;
  atualizarTopoSync();
}

// Linha do índice (lista da equipe) já traz "abertos"; vistoria completa é contada aqui.
const abertosDe = (v) => (v.ambientes || v.revisao ? contar(v).abertos : v.abertos || 0);

function pillSituacao(v) {
  const abertos = abertosDe(v);
  if (!v.concluida) return '<span class="pill lar">em andamento</span>';
  if (abertos) return `<span class="pill bad">${abertos} em aberto</span>`;
  return '<span class="pill ok">liberada</span>';
}

function resumoItens(v) {
  const c = contar(v);
  if (v.tipo === 'revistoria') return `${c.feitos}/${c.tot} conferidos · ${c.ok} corrigido(s)${c.novos ? ` · ${c.novos} novo(s)` : ''}`;
  return `${c.feitos}/${c.tot} itens${c.d ? ` · <b style="color:var(--bad)">${c.d} defeito(s)</b>` : ''}`;
}

function abas(atual) {
  return `<div class="seg" style="margin-bottom:6px">
      <button class="s-t ${atual === 'lista' ? 'on' : ''}" data-act="aba" data-aba="lista">Vistorias</button>
      <button class="s-t ${atual === 'obra' ? 'on' : ''}" data-act="aba" data-aba="obra">Obra</button></div>
    <div class="mudo" style="margin:0 2px 10px">👤 ${perfil ? `${esc(perfil.nome)} · ${PAPEIS[perfil.papel]}` : 'sem identificação'} <button class="peq" data-act="perfil">alterar</button></div>`;
}

function pedirPerfil(obrigatorio) {
  const p = perfil || { nome: ultimoNome, papel: 'vistoriador' };
  $('#modalCorpo').innerHTML = `
    <h3 style="margin:0 0 6px">Quem é você?</h3>
    <p class="mudo" style="margin:0 0 8px">Seu nome e função aparecem nos registros. Fica guardado neste aparelho.</p>
    <label>Nome</label><input type="text" id="inNome" value="${esc(p.nome)}" autocomplete="off" placeholder="Seu nome">
    <label>Função</label>
    <select id="inPapel">${Object.entries(PAPEIS).map(([k, r]) => `<option value="${k}" ${p.papel === k ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <p id="erroPerfil" style="color:var(--bad);margin:6px 0 0;font-size:13px"></p>
    <div class="acoes"><button class="pri" id="btPerfil">Salvar</button>${obrigatorio ? '' : '<button class="peq" id="btPerfilCancela">Cancelar</button>'}</div>`;
  $('#modal').classList.add('on');
  if ($('#btPerfilCancela')) $('#btPerfilCancela').onclick = () => $('#modal').classList.remove('on');
  $('#btPerfil').onclick = () => {
    const nome = $('#inNome').value.trim();
    if (!nome) { $('#erroPerfil').textContent = 'Digite seu nome.'; return; }
    const primeira = !perfil;
    perfil = { nome, papel: $('#inPapel').value };
    ultimoNome = nome;
    localStorage.setItem('perfilGirollar', JSON.stringify(perfil));
    localStorage.setItem('vistoriadoPor', nome);
    $('#modal').classList.remove('on');
    if (primeira && perfil.papel === 'mestre' && tela.nome === 'lista') tela = { nome: 'obra' };
    desenhar();
  };
}

// ---------- obra: lista de diários ----------
const cardDiario = (v, acao) => `<div class="card tap" data-act="${acao}" data-id="${v.id}">
    <div class="linha"><div class="esp"><div class="neg">${esc(v.empreendimento)} · ${fmtDia(v.data)}</div>
      <div class="mudo">${esc(v.por)}${v.papel ? ' · ' + esc(PAPEIS[v.papel] || '') : ''}</div></div>
      <span class="pill ${v.fechado ? 'ok' : 'lar'}">${v.fechado ? 'fechado' : 'em aberto'}</span></div>
    ${v.servicos ? `<div class="linha" style="margin-top:8px"><span class="mudo esp">${v.servicos.length} serviço(s) · ${v.ocorrencias.length} ocorrência(s)</span>
      <span class="pill ${v._sync && v._sync.sujo ? '' : 'ok'}">${v._sync && v._sync.sujo ? 'a enviar' : '✓ no Drive'}</span></div>` : ''}</div>`;

async function telaObra() {
  topo({ titulo: 'Obra' });
  const dias = (await bdTodas()).filter((v) => v.tipo === 'diario')
    .sort((a, b) => (b.data || '').localeCompare(a.data || '') || b.atualizadoEm.localeCompare(a.atualizadoEm));
  $('#tela').innerHTML = `
    ${abas('obra')}
    ${await alertaEnvio()}
    <h2 class="sec" style="margin-top:4px">Diário de obra</h2>
    <div class="card">
      <label style="margin-top:0">Obra</label>
      <input type="text" id="fObra" list="dlEmp" value="${esc(localStorage.getItem('ultimaObra') || '')}" placeholder="Escolha ou digite" autocomplete="off">
      <datalist id="dlEmp">${Object.keys(unidades).map((e) => `<option value="${esc(e)}">`).join('')}</datalist>
      <label>Data</label>
      <input type="date" id="fData" value="${hojeISO()}" style="width:100%;font:inherit;padding:10px;border:1.5px solid #d1d5db;border-radius:10px">
      <div class="acoes"><button class="pri" data-act="criardiario">Abrir diário do dia</button></div>
    </div>
    <h2 class="sec">Neste aparelho</h2>
    ${dias.length ? dias.map((v) => cardDiario(v, 'abrir')).join('') : '<div class="vazio">Nenhum diário ainda.</div>'}
    <h2 class="sec">Equipe</h2>
    <button class="sec" style="width:100%" data-act="equipeobra">Ver diários de todos (precisa de sinal)</button>`;
}

async function telaEquipeObra() {
  topo({ titulo: 'Diários da equipe', voltar: true });
  $('#tela').innerHTML = '<div class="vazio">Carregando…</div>';
  if (!Api.temToken()) { pedirCodigo(); $('#tela').innerHTML = '<div class="vazio">Digite o código da equipe.</div>'; return; }
  try {
    const lista = ((await Api.listarObra()).diarios || []).sort((a, b) => (b.data || '').localeCompare(a.data || ''));
    $('#tela').innerHTML = lista.length ? lista.map((v) => cardDiario(v, 'remotodiario')).join('') : '<div class="vazio">Nada enviado ainda.</div>';
  } catch (e) {
    if (e.codigo) { pedirCodigo(); return; }
    $('#tela').innerHTML = '<div class="aviso">Sem conexão com o servidor. Isso só funciona com sinal.</div>';
  }
}

function telaDiario() {
  topo({ titulo: `${vis.empreendimento} · ${fmtDia(vis.data)}`, voltar: true });
  const clima = (p) => `<div class="seg">${CLIMAS.map(([k, r]) => `<button class="s-t ${vis.clima[p] === k ? 'on' : ''}" data-act="clima" data-p="${p}" data-k="${k}">${r}</button>`).join('')}</div>`;
  const servs = vis.servicos.map((s) => `
    <div class="item">
      <div class="linha"><input type="text" class="esp" data-bind="srvLocal" data-i="${s.id}" value="${esc(s.local)}" placeholder="Local (ex.: Bloco 1, 5º pav.)" autocomplete="off">
        <button class="peq perigo" data-act="rmserv" data-i="${s.id}">×</button></div>
      <textarea data-bind="srvTexto" data-i="${s.id}" style="margin-top:6px" placeholder="Serviço executado (ex.: alvenaria 60% concluída)">${esc(s.texto)}</textarea>
      ${blocoFotos({ t: 'serv', i: s.id }, s.fotos)}
    </div>`);
  const ocs = vis.ocorrencias.map((o) => `
    <div class="item"><div class="defeito">
      <div class="linha"><select class="esp" data-bind="ocTipo" data-i="${o.id}">${TIPOS_OCORRENCIA.map((t) => `<option ${o.tipo === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <button class="peq perigo" data-act="rmoc" data-i="${o.id}">×</button></div>
      <textarea data-bind="ocTexto" data-i="${o.id}" style="margin-top:6px" placeholder="O que aconteceu">${esc(o.texto)}</textarea>
      ${blocoFotos({ t: 'oc', i: o.id }, o.fotos)}
    </div></div>`);
  $('#tela').innerHTML = `
    <div class="card"><div class="linha"><div class="esp"><div class="neg">Diário de obra</div>
      <div class="mudo">por ${esc(vis.por)}${vis.papel ? ' · ' + esc(PAPEIS[vis.papel] || '') : ''}</div></div>
      <span class="pill ${vis.fechado ? 'ok' : 'lar'}">${vis.fechado ? 'fechado' : 'em aberto'}</span></div>
      <label>Data</label>
      <input type="date" data-bind="data" value="${esc(vis.data)}" style="width:100%;font:inherit;padding:10px;border:1.5px solid #d1d5db;border-radius:10px"></div>
    <h2 class="sec">Clima</h2>
    <div class="card"><label style="margin-top:0">Manhã</label>${clima('manha')}<label>Tarde</label>${clima('tarde')}</div>
    <h2 class="sec">Efetivo (pessoas na obra)</h2>
    <div class="card"><div class="linha">
      <div class="esp"><label style="margin-top:0">Próprios</label><input type="text" inputmode="numeric" data-bind="efProprio" value="${esc(vis.efetivo.proprio)}" placeholder="0"></div>
      <div class="esp"><label style="margin-top:0">Terceirizados</label><input type="text" inputmode="numeric" data-bind="efTerceiros" value="${esc(vis.efetivo.terceiros)}" placeholder="0"></div></div></div>
    <h2 class="sec">Serviços executados</h2>
    ${servs.length ? `<div class="card">${servs.join('')}</div>` : ''}
    <button class="sec" style="width:100%;margin-bottom:6px" data-act="novoserv">+ Adicionar serviço</button>
    <h2 class="sec">Ocorrências</h2>
    ${ocs.length ? `<div class="card">${ocs.join('')}</div>` : ''}
    <button class="sec" style="width:100%;margin-bottom:6px" data-act="novooc">+ Registrar ocorrência</button>
    <h2 class="sec">Fechamento</h2>
    <div class="card"><label style="margin-top:0">Observações do dia</label>
      <textarea data-bind="obsGerais" placeholder="Visitas, entregas de material, decisões…">${esc(vis.obsGerais)}</textarea>
      ${blocoFotos({ t: 'geral' }, vis.fotosGerais)}</div>
    <button class="pri" data-act="fechardia">${vis.fechado ? 'Reabrir dia' : 'Fechar o dia'}</button>
    <div class="acoes"><button class="peq perigo" data-act="excluir">Excluir</button></div>`;
}

async function telaLista() {
  topo({ titulo: 'Vistorias' });
  const todas = (await bdTodas()).filter((v) => v.tipo !== 'diario').sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm));
  const cards = todas.map((v) => {
    const sujo = v._sync && v._sync.sujo;
    return `<div class="card tap" data-act="abrir" data-id="${v.id}">
      <div class="linha"><div class="esp"><div class="neg">${esc(v.empreendimento)} · ${esc(v.unidade)}</div>
        <div class="mudo">${esc(TIPO[v.tipo])}${v.tipo === 'cliente' ? ': ' + esc(v.cliente || '—') : ''} · ${esc(v.por)} · ${new Date(v.criadoEm).toLocaleDateString('pt-BR')}</div></div>
        ${pillSituacao(v)}</div>
      <div class="linha" style="margin-top:8px">
        <span class="mudo esp">${resumoItens(v)}</span>
        <span class="pill ${sujo ? '' : 'ok'}">${sujo ? 'a enviar' : '✓ no Drive'}</span>
        <button class="peq" data-act="relatorio" data-id="${v.id}">Relatório</button>
      </div></div>`;
  });
  $('#tela').innerHTML = `
    ${abas('lista')}
    ${await alertaEnvio()}
    <button class="pri" data-act="nova">+ Nova vistoria</button>
    <h2 class="sec">Neste aparelho</h2>
    ${cards.length ? cards.join('') : '<div class="vazio">Nenhuma vistoria ainda.<br>Toque em “Nova vistoria” para começar.</div>'}
    <h2 class="sec">Equipe</h2>
    <button class="sec" style="width:100%" data-act="equipe">Ver vistorias de todos (precisa de sinal)</button>`;
}

function telaNova() {
  topo({ titulo: 'Nova vistoria', voltar: true });
  $('#tela').innerHTML = `
    <div class="card">
      <label>Tipo</label>
      <div class="seg" id="segTipo"><button class="s-t on" data-tipo="interna">Interna</button><button class="s-t" data-tipo="cliente">Do cliente</button></div>
      <p class="mudo" style="margin:8px 0 0">Para conferir correções, abra a vistoria anterior e toque em “Fazer revistoria”.</p>
      <label>Empreendimento</label>
      <input type="text" id="fEmp" list="dlEmp" placeholder="Escolha ou digite" autocomplete="off">
      <datalist id="dlEmp">${Object.keys(unidades).map((e) => `<option value="${esc(e)}">`).join('')}</datalist>
      <label>Unidade</label>
      <input type="text" id="fUni" list="dlUni" placeholder="Ex.: 205 BLOCO 1" autocomplete="off">
      <datalist id="dlUni"></datalist>
      <div id="blocoCliente" style="display:none"><label>Nome do cliente</label><input type="text" id="fCli" autocomplete="off"></div>
      <label>Vistoriado por</label>
      <input type="text" id="fPor" value="${esc(ultimoNome)}" placeholder="Seu nome" autocomplete="off">
    </div>
    <button class="pri" data-act="criar">Começar vistoria</button>`;
  let tipo = 'interna';
  $('#segTipo').onclick = (e) => {
    const b = e.target.closest('button[data-tipo]');
    if (!b) return;
    tipo = b.dataset.tipo;
    document.querySelectorAll('#segTipo button').forEach((x) => x.classList.toggle('on', x === b));
    $('#blocoCliente').style.display = tipo === 'cliente' ? 'block' : 'none';
  };
  $('#fEmp').oninput = () => {
    const lista = unidades[$('#fEmp').value] || [];
    $('#dlUni').innerHTML = lista.map((u) => `<option value="${esc(u)}">`).join('');
  };
  tela.lerForm = () => ({ tipo, empreendimento: $('#fEmp').value.trim(), unidade: $('#fUni').value.trim(), por: $('#fPor').value.trim(), cliente: ($('#fCli').value || '').trim() });
}

function blocoFotos(alvo, lista) {
  const dados = `data-t="${alvo.t}" data-a="${alvo.a || ''}" data-i="${alvo.i || ''}"`;
  return `<div class="fotos">${lista.map((id) => `<div class="f"><img data-foto="${id}" alt=""><button class="x" data-act="rmfoto" ${dados} data-f="${id}">×</button></div>`).join('')}</div>
    <div class="acoes"><button class="peq" data-act="foto" data-modo="camera" ${dados}>📷 Tirar foto</button><button class="peq" data-act="foto" data-modo="galeria" ${dados}>🖼 Galeria</button></div>`;
}
const fotosSoLeitura = (refs) => (refs && refs.length ? `<div class="fotos">${refs.map((r) => `<div class="f"><img data-foto="${r.fid}" data-vid="${r.vid}" alt=""></div>`).join('')}</div>` : '');

function blocoFinalizar() {
  return `<h2 class="sec">Finalizar</h2>
    <div class="card">
      <label>Observações gerais</label>
      <textarea data-bind="obsGerais" placeholder="Algo que vale registrar da unidade como um todo">${esc(vis.obsGerais)}</textarea>
      ${blocoFotos({ t: 'geral' }, vis.fotosGerais)}
      <label>Assinatura de quem vistoriou (${esc(vis.por)})</label>
      <canvas class="assin" id="pad1"></canvas><div class="acoes"><button class="peq" data-act="limpar" data-n="1">Limpar assinatura</button></div>
      ${vis.tipo === 'cliente' ? `<label>Assinatura do cliente (${esc(vis.cliente || '')})</label><canvas class="assin" id="pad2"></canvas><div class="acoes"><button class="peq" data-act="limpar" data-n="2">Limpar assinatura</button></div>` : ''}
    </div>
    <button class="pri" data-act="concluir">${vis.concluida ? 'Reabrir vistoria' : 'Concluir vistoria'}</button>
    ${vis.concluida && contar(vis).abertos ? `<button class="sec" style="width:100%;margin-top:8px" data-act="revistoria">↻ Fazer revistoria (${contar(vis).abertos} defeito(s) em aberto)</button>` : ''}
    <div class="acoes"><button class="sec" style="flex:1" data-act="relatorio" data-id="${vis.id}">Ver relatório</button><button class="peq perigo" data-act="excluir">Excluir</button></div>`;
}

function ligarAssinaturas() {
  ligarAssinatura($('#pad1'), vis.assinaturaVistoriador, (d) => { vis.assinaturaVistoriador = d; tocar(); });
  if ($('#pad2')) ligarAssinatura($('#pad2'), vis.assinaturaCliente, (d) => { vis.assinaturaCliente = d; tocar(); });
}

function telaVistoria() {
  if (vis.tipo === 'diario') return telaDiario();
  if (vis.tipo === 'revistoria') return telaRevistoria();
  const c = contar(vis);
  topo({ titulo: `${vis.empreendimento} · ${vis.unidade}`, voltar: true });
  const amb = vis.ambientes.map((a) => {
    const d = a.itens.filter((i) => i.estado === 'defeito').length;
    const f = a.itens.filter((i) => i.estado).length;
    return `<div class="card tap" data-act="amb" data-a="${a.id}"><div class="linha"><div class="esp neg">${esc(a.nome)}</div>
      ${d ? `<span class="pill bad">${d} defeito(s)</span>` : ''}<span class="pill ${f === a.itens.length && f ? 'ok' : ''}">${f}/${a.itens.length}</span><span class="mudo">›</span></div></div>`;
  });
  $('#tela').innerHTML = `
    <div class="card"><div class="linha"><div class="esp"><div class="neg">${esc(TIPO[vis.tipo])}</div>
      <div class="mudo">${vis.tipo === 'cliente' ? 'Cliente: ' + esc(vis.cliente || '—') + ' · ' : ''}por ${esc(vis.por)}</div></div>
      <span class="pill ${c.d ? 'bad' : 'ok'}">${c.d} defeito(s)</span></div></div>
    <h2 class="sec">Ambientes</h2>${amb.join('')}
    <button class="sec" style="width:100%;margin-bottom:6px" data-act="novoamb">+ Adicionar ambiente</button>
    ${blocoFinalizar()}`;
  ligarAssinaturas();
}

function telaRevistoria() {
  const c = contar(vis);
  topo({ titulo: `Revistoria · ${vis.unidade}`, voltar: true });
  const o = vis.origem || {};
  const itens = vis.revisao.map((r) => `
    <div class="item">
      <div class="nome">${esc(r.ambiente)} · ${esc(r.item)}</div>
      <div class="antes"><span class="mudo">Apontado em ${Relatorio.dataBR(r.desde, true)}:</span> ${esc(r.obsAntes || '—')}${fotosSoLeitura(r.fotosAntes)}</div>
      <div class="seg">
        <button class="s-rev ${r.estado === 'corrigido' ? 'on' : ''}" data-act="estrev" data-i="${r.id}" data-e="corrigido">✔ Corrigido</button>
        <button class="s-par ${r.estado === 'parcial' ? 'on' : ''}" data-act="estrev" data-i="${r.id}" data-e="parcial">◐ Parcial</button>
        <button class="s-nao ${r.estado === 'nao' ? 'on' : ''}" data-act="estrev" data-i="${r.id}" data-e="nao">✖ Não</button>
      </div>
      ${r.estado ? `<div class="${r.estado === 'corrigido' ? '' : 'defeito'}" style="margin-top:8px">
        <textarea data-bind="rev" data-i="${r.id}" placeholder="${r.estado === 'corrigido' ? 'Observação (opcional)' : 'O que ainda falta corrigir'}">${esc(r.obs)}</textarea>
        ${blocoFotos({ t: 'rev', i: r.id }, r.fotos)}</div>` : ''}
    </div>`);
  const novos = vis.novos.map((n) => `
    <div class="item"><div class="linha"><div class="nome esp">${esc(n.ambiente)} · ${esc(n.nome)}</div><button class="peq perigo" data-act="rmnovo" data-i="${n.id}">Remover</button></div>
      <div class="defeito"><textarea data-bind="novo" data-i="${n.id}" placeholder="Descreva o defeito">${esc(n.obs)}</textarea>${blocoFotos({ t: 'novo', i: n.id }, n.fotos)}</div></div>`);
  $('#tela').innerHTML = `
    <div class="card"><div class="linha"><div class="esp"><div class="neg">Revistoria</div>
      <div class="mudo">confere a ${esc((TIPO[o.tipo] || 'vistoria').toLowerCase())} de ${Relatorio.dataBR(o.criadoEm, true)}${o.por ? ` (${esc(o.por)})` : ''} · feita por ${esc(vis.por)}</div></div>
      <span class="pill ${c.abertos ? 'bad' : 'ok'}">${c.ok}/${c.tot} corrigidos</span></div></div>
    <h2 class="sec">Defeitos apontados</h2>
    <div class="card">${itens.join('') || '<div class="mudo">Nenhum defeito em aberto.</div>'}</div>
    <h2 class="sec">Defeitos novos</h2>
    ${novos.length ? `<div class="card">${novos.join('')}</div>` : ''}
    <button class="sec" style="width:100%;margin-bottom:6px" data-act="novodef">+ Registrar defeito novo</button>
    ${blocoFinalizar()}`;
  ligarAssinaturas();
}

function telaAmbiente() {
  const a = vis.ambientes.find((x) => x.id === tela.a);
  topo({ titulo: a.nome, voltar: true });
  const itens = a.itens.map((i) => `
    <div class="item">
      <div class="nome">${esc(i.nome)}</div>
      <div class="seg">
        <button class="s-ok ${i.estado === 'ok' ? 'on' : ''}" data-act="estado" data-i="${i.id}" data-e="ok">✔ Ok</button>
        <button class="s-bad ${i.estado === 'defeito' ? 'on' : ''}" data-act="estado" data-i="${i.id}" data-e="defeito">✖ Defeito</button>
        <button class="s-na ${i.estado === 'na' ? 'on' : ''}" data-act="estado" data-i="${i.id}" data-e="na">— N/A</button>
      </div>
      ${i.estado === 'defeito' ? `<div class="defeito"><textarea data-bind="item" data-i="${i.id}" placeholder="Descreva o defeito (onde, tamanho…)">${esc(i.obs)}</textarea>${blocoFotos({ t: 'item', a: a.id, i: i.id }, i.fotos)}</div>` : ''}
    </div>`);
  $('#tela').innerHTML = `
    <div class="card">${itens.join('')}
      <button class="peq" style="margin-top:10px" data-act="novoitem">+ Adicionar item</button></div>
    <div class="card"><label>Observações do ambiente</label>
      <textarea data-bind="amb" placeholder="Opcional">${esc(a.obs)}</textarea>${blocoFotos({ t: 'amb', a: a.id }, a.fotos)}</div>
    <div class="acoes"><button class="pri" data-act="voltar">Concluir ambiente</button></div>
    <div class="acoes"><button class="peq perigo" data-act="rmamb">Remover este ambiente</button></div>`;
}

let listaEquipe = [];
async function telaEquipe() {
  topo({ titulo: 'Equipe', voltar: true });
  $('#tela').innerHTML = '<div class="vazio">Carregando…</div>';
  if (!Api.temToken()) { pedirCodigo(); $('#tela').innerHTML = '<div class="vazio">Digite o código da equipe.</div>'; return; }
  try {
    listaEquipe = (await Api.listar()).vistorias || [];
    // agrupa por unidade, mais recente primeiro
    const grupos = {};
    for (const v of listaEquipe.sort((a, b) => b.criadoEm.localeCompare(a.criadoEm))) (grupos[`${v.empreendimento} · ${v.unidade}`] ||= []).push(v);
    $('#tela').innerHTML = Object.keys(grupos).length
      ? Object.entries(grupos).map(([un, vs]) => `<h2 class="sec">${esc(un)}</h2>${vs.map((v) => `<div class="card"><div class="linha"><div class="esp">
          <div class="neg">${esc(TIPO[v.tipo] || v.tipo)}</div>
          <div class="mudo">${esc(v.por)} · ${new Date(v.criadoEm).toLocaleDateString('pt-BR')}</div></div>${pillSituacao(v)}</div>
          <div class="acoes"><button class="peq" data-act="relremoto" data-id="${v.id}">Relatório</button>
          ${v.concluida && v.abertos && v === vs[0] ? `<button class="peq" data-act="revremota" data-id="${v.id}">↻ Fazer revistoria</button>` : ''}</div></div>`).join('')}`).join('')
      : '<div class="vazio">Nada enviado ainda.</div>';
  } catch (e) {
    if (e.codigo) { pedirCodigo(); return; }
    $('#tela').innerHTML = '<div class="aviso">Sem conexão com o servidor. Isso só funciona com sinal.</div>';
  }
}

// Relatório montado no próprio aparelho: funciona sem sinal para o que está aqui.
async function telaRelatorio() {
  const v = tela.doc;
  topo({ titulo: `Relatório · ${v.unidade}`, voltar: true });
  $('#tela').innerHTML = '<div class="vazio">Montando relatório…</div>';
  const mapa = {};
  for (const r of fotosDoRelatorio(v)) {
    const blob = await blobDaFoto(r.vid, r.fid);
    if (blob) { mapa[r.fid] = URL.createObjectURL(blob); urlsBlob.push(mapa[r.fid]); }
  }
  const html = relatorioHTML(v, (r) => mapa[r.fid] || '', { logo: new URL('girollar-logo.svg', location.href).href });
  const pdf = v._sync && v._sync.pdfUrl;
  $('#tela').innerHTML = `<div class="acoes" style="margin:0 0 8px"><button class="peq" data-act="imprimir">🖨 Imprimir / salvar PDF</button>
      ${pdf ? `<a class="peq" style="text-decoration:none;color:inherit;border:1px solid #d1d5db;border-radius:8px;padding:8px 11px" href="${esc(pdf)}" target="_blank">PDF no Drive</a>` : ''}</div>
    <iframe class="rel" id="frRel"></iframe>`;
  $('#frRel').srcdoc = html;
}

function desenhar() {
  const t = tela.nome;
  if (t === 'lista') telaLista();
  else if (t === 'obra') telaObra();
  else if (t === 'equipeobra') telaEquipeObra();
  else if (t === 'nova') telaNova();
  else if (t === 'vistoria') telaVistoria();
  else if (t === 'amb') telaAmbiente();
  else if (t === 'equipe') telaEquipe();
  else if (t === 'relatorio') return telaRelatorio();
  Promise.resolve().then(hidratarFotos);
}

function ir(nome, extra = {}) {
  tela = { nome, ...extra };
  history.pushState({ nome }, '');
  desenhar();
  window.scrollTo(0, 0);
}

function voltar() {
  if (tela.nome === 'amb') { tela = { nome: 'vistoria' }; }
  else if (tela.nome === 'relatorio') { tela = tela.de || { nome: 'lista' }; }
  else if (tela.nome === 'vistoria') { const dia = vis && vis.tipo === 'diario'; salvarAgora(); vis = null; tela = { nome: dia ? 'obra' : 'lista' }; }
  else if (tela.nome === 'equipeobra') tela = { nome: 'obra' };
  else tela = { nome: 'lista' };
  desenhar();
  window.scrollTo(0, 0);
}

async function abrirRevistoria(origem) {
  const por = prompt('Quem está fazendo a revistoria?', ultimoNome) || '';
  if (!por.trim()) return;
  ultimoNome = por.trim();
  localStorage.setItem('vistoriadoPor', ultimoNome);
  vis = novaRevistoria(origem, ultimoNome);
  await bdPut(vis);
  agendarSync();
  tela = { nome: 'vistoria' };
  history.replaceState({ nome: 'vistoria' }, '');
  desenhar();
  window.scrollTo(0, 0);
}

// ---------- eventos ----------
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const d = b.dataset;
  if (act === 'sync') { if (precisaCodigo) pedirCodigo(); else sincronizar(); return; }
  if (act === 'voltar') return history.back();
  if (act === 'nova') return ir('nova');
  if (act === 'equipe') return ir('equipe');
  if (act === 'equipeobra') return ir('equipeobra');
  if (act === 'perfil') return pedirPerfil(false);
  if (act === 'aba') {
    tela = { nome: d.aba };
    history.replaceState({ nome: d.aba }, '');
    return desenhar();
  }
  if (act === 'criardiario') {
    const emp = $('#fObra').value.trim();
    const data = $('#fData').value || hojeISO();
    if (!emp) return alert('Escolha a obra.');
    if (!perfil) return pedirPerfil(true);
    localStorage.setItem('ultimaObra', emp);
    // Já existe diário desta obra neste dia neste aparelho? Abre em vez de duplicar.
    const ja = (await bdTodas()).find((v) => v.tipo === 'diario' && v.empreendimento === emp && v.data === data);
    vis = ja || novoDiario({ empreendimento: emp, data, por: perfil.nome, papel: perfil.papel });
    if (!ja) { await bdPut(vis); agendarSync(); }
    return ir('vistoria');
  }
  if (act === 'remotodiario') {
    try {
      let local = await bdGet(d.id);
      if (!local) {
        const { doc } = await Api.obter(d.id);
        local = { ...doc, _sync: { sujo: false } };
        await bdPut(local);
      }
      vis = local;
      return ir('vistoria');
    } catch (err) {
      if (err.codigo) return pedirCodigo();
      return alert('Não consegui buscar esse diário. Precisa de sinal.');
    }
  }
  if (act === 'imprimir') { const f = $('#frRel'); if (f) f.contentWindow.print(); return; }
  if (act === 'relatorio') {
    e.stopPropagation();
    if (vis) await salvarAgora();
    return ir('relatorio', { doc: await bdGet(d.id), de: { ...tela } });
  }
  if (act === 'relremoto' || act === 'revremota') {
    try {
      const local = await bdGet(d.id);
      const doc = local || (await Api.obter(d.id)).doc;
      if (act === 'relremoto') return ir('relatorio', { doc, de: { nome: 'equipe' } });
      return abrirRevistoria(doc);
    } catch (err) {
      if (err.codigo) return pedirCodigo();
      return alert('Não consegui buscar essa vistoria. Precisa de sinal.');
    }
  }
  if (act === 'abrir') { vis = await bdGet(d.id); return ir('vistoria'); }
  if (act === 'criar') {
    const f = tela.lerForm();
    if (!f.empreendimento || !f.unidade || !f.por) return alert('Preencha empreendimento, unidade e quem está vistoriando.');
    if (f.tipo === 'cliente' && !f.cliente) return alert('Informe o nome do cliente.');
    ultimoNome = f.por;
    localStorage.setItem('vistoriadoPor', f.por);
    vis = novaVistoria(f);
    await bdPut(vis);
    agendarSync();
    tela = { nome: 'vistoria' };
    history.replaceState({ nome: 'vistoria' }, '');
    return desenhar();
  }
  if (!vis) return;
  if (act === 'revistoria') { await salvarAgora(); return abrirRevistoria(vis); }
  if (act === 'clima') {
    vis.clima[d.p] = vis.clima[d.p] === d.k ? null : d.k;
    tocar();
    return desenhar();
  }
  if (act === 'novoserv') {
    vis.servicos.push({ id: uid(), local: '', texto: '', fotos: [] });
    tocar();
    return desenhar();
  }
  if (act === 'novooc') {
    vis.ocorrencias.push({ id: uid(), tipo: TIPOS_OCORRENCIA[0], texto: '', fotos: [] });
    tocar();
    return desenhar();
  }
  if (act === 'rmserv' || act === 'rmoc') {
    const campo = act === 'rmserv' ? 'servicos' : 'ocorrencias';
    const it = vis[campo].find((x) => x.id === d.i);
    if ((it.texto || (it.fotos || []).length) && !confirm('Remover este item e as fotos dele?')) return;
    for (const f of it.fotos || []) await fotoDel(f);
    vis[campo] = vis[campo].filter((x) => x.id !== d.i);
    tocar();
    return desenhar();
  }
  if (act === 'fechardia') {
    vis.fechado = !vis.fechado;
    tocar();
    await salvarAgora();
    return desenhar();
  }
  if (act === 'amb') return ir('amb', { a: d.a });
  if (act === 'estado') {
    const a = vis.ambientes.find((x) => x.id === tela.a);
    const i = a.itens.find((x) => x.id === d.i);
    i.estado = i.estado === d.e ? null : d.e; // tocar de novo desfaz
    tocar();
    return desenhar();
  }
  if (act === 'estrev') {
    const r = vis.revisao.find((x) => x.id === d.i);
    r.estado = r.estado === d.e ? null : d.e;
    tocar();
    return desenhar();
  }
  if (act === 'novodef') {
    const ambiente = prompt('Em qual ambiente? (ex.: Cozinha)');
    if (!ambiente || !ambiente.trim()) return;
    const nome = prompt('Qual item? (ex.: Piso)');
    if (!nome || !nome.trim()) return;
    vis.novos.push({ id: uid(), ambiente: ambiente.trim(), nome: nome.trim(), obs: '', fotos: [] });
    tocar();
    return desenhar();
  }
  if (act === 'rmnovo') {
    if (!confirm('Remover este defeito novo?')) return;
    vis.novos = vis.novos.filter((x) => x.id !== d.i);
    tocar();
    return desenhar();
  }
  if (act === 'novoitem') {
    const nome = prompt('Nome do item:');
    if (!nome || !nome.trim()) return;
    vis.ambientes.find((x) => x.id === tela.a).itens.push({ id: uid(), nome: nome.trim(), estado: null, obs: '', fotos: [] });
    tocar();
    return desenhar();
  }
  if (act === 'novoamb') {
    const nome = prompt('Nome do ambiente:');
    if (!nome || !nome.trim()) return;
    vis.ambientes.push({ id: uid(), nome: nome.trim(), obs: '', fotos: [], itens: BASE.map((n) => ({ id: uid(), nome: n, estado: null, obs: '', fotos: [] })) });
    tocar();
    return desenhar();
  }
  if (act === 'rmamb') {
    if (!confirm('Remover este ambiente e o que foi preenchido nele?')) return;
    vis.ambientes = vis.ambientes.filter((x) => x.id !== tela.a);
    tocar();
    return history.back();
  }
  if (act === 'foto') {
    alvoFoto = { t: d.t, a: d.a, i: d.i };
    return (d.modo === 'camera' ? $('#inCamera') : $('#inGaleria')).click();
  }
  if (act === 'rmfoto') {
    if (!confirm('Apagar esta foto?')) return;
    return removerFoto({ t: d.t, a: d.a, i: d.i }, d.f);
  }
  if (act === 'limpar') {
    if (d.n === '1') vis.assinaturaVistoriador = ''; else vis.assinaturaCliente = '';
    tocar();
    return desenhar();
  }
  if (act === 'concluir') {
    if (!vis.concluida) {
      const c = contar(vis);
      const falta = c.tot - c.feitos;
      if (falta && !confirm(`Faltam ${falta} item(ns) sem marcar. Concluir mesmo assim?`)) return;
    }
    vis.concluida = !vis.concluida;
    tocar();
    await salvarAgora();
    return desenhar();
  }
  if (act === 'excluir') {
    const enviada = vis._sync && !vis._sync.sujo;
    const dia = vis.tipo === 'diario';
    const que = dia ? 'este diário' : 'esta vistoria';
    if (!confirm(enviada ? `Excluir ${que} deste aparelho? (A cópia no Drive permanece.)` : `ATENÇÃO: ${que} ainda NÃO foi enviado(a) ao Drive. Excluir apaga de vez. Continuar?`)) return;
    await bdDel(vis.id);
    vis = null;
    tela = { nome: dia ? 'obra' : 'lista' };
    return desenhar();
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!vis || !t.dataset || !t.dataset.bind) return;
  const b = t.dataset.bind;
  if (b === 'obsGerais') vis.obsGerais = t.value;
  else if (b === 'amb') vis.ambientes.find((x) => x.id === tela.a).obs = t.value;
  else if (b === 'item') vis.ambientes.find((x) => x.id === tela.a).itens.find((x) => x.id === t.dataset.i).obs = t.value;
  else if (b === 'rev') vis.revisao.find((x) => x.id === t.dataset.i).obs = t.value;
  else if (b === 'novo') vis.novos.find((x) => x.id === t.dataset.i).obs = t.value;
  else if (b === 'data') vis.data = t.value;
  else if (b === 'efProprio') vis.efetivo.proprio = t.value;
  else if (b === 'efTerceiros') vis.efetivo.terceiros = t.value;
  else if (b === 'srvLocal') vis.servicos.find((x) => x.id === t.dataset.i).local = t.value;
  else if (b === 'srvTexto') vis.servicos.find((x) => x.id === t.dataset.i).texto = t.value;
  else if (b === 'ocTipo') vis.ocorrencias.find((x) => x.id === t.dataset.i).tipo = t.value;
  else if (b === 'ocTexto') vis.ocorrencias.find((x) => x.id === t.dataset.i).texto = t.value;
  tocar();
});

for (const sel of ['#inCamera', '#inGaleria']) {
  $(sel).addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await receberFotos(files);
  });
}

window.addEventListener('popstate', () => { if (tela.nome !== 'lista' && tela.nome !== 'obra') voltar(); });
window.addEventListener('online', sincronizar);
window.addEventListener('offline', atualizarTopoSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') salvarAgora();
  else sincronizar();
});
window.addEventListener('pagehide', salvarAgora);
setInterval(sincronizar, 60000);

// ---------- partida ----------
(async () => {
  idb = await abrirBanco();
  try { unidades = await (await fetch('unidades.json')).json(); } catch { unidades = {}; }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (perfil && perfil.papel === 'mestre') tela = { nome: 'obra' };
  history.replaceState({ nome: tela.nome }, '');
  desenhar();
  if (!perfil) pedirPerfil(true);
  if (!Api.temToken()) precisaCodigo = true;
  sincronizar();
})();
