'use strict';
/**
 * Conversa com o "servidor" — um Apps Script que grava no Google Drive (pasta Vistorias).
 * Um só endereço; cada chamada é um POST com { acao, token, ... } em JSON.
 * Content-Type text/plain de propósito: evita o preflight de CORS, que o Apps Script não atende.
 * O endereço vem de config.js (window.VISTORIAS_API).
 */
const Api = (() => {
  const URL_API = () => window.VISTORIAS_API || '';
  const tokenSalvo = () => localStorage.getItem('vistoriasToken') || '';

  async function chamar(acao, dados = {}) {
    if (!URL_API()) throw new Error('servidor não configurado');
    const r = await fetch(URL_API(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ acao, token: tokenSalvo(), ...dados }),
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`${acao}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.erro === 'codigo') throw Object.assign(new Error('codigo'), { codigo: true });
    if (j.erro) throw new Error(j.erro);
    return j;
  }

  return {
    async entrar(pin) {
      const j = await chamar('entrar', { pin });
      localStorage.setItem('vistoriasToken', j.token);
      return j;
    },
    temToken: () => Boolean(tokenSalvo()),
    salvar: (doc) => chamar('salvar', { doc }), // -> { faltam: [fid] }
    foto: (vid, fid, b64) => chamar('foto', { vid, fid, b64 }),
    pdf: (vid, html) => chamar('pdf', { vid, html }), // -> { url }
    listar: () => chamar('listar'), // -> { vistorias: [...] }
    obter: (id) => chamar('obter', { id }), // -> { doc }
    fotoGet: (vid, fid) => chamar('fotoGet', { vid, fid }), // -> { b64 }
  };
})();

// Blob <-> base64 (o Apps Script recebe e devolve bytes em base64).
function blobParaB64(blob) {
  return new Promise((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => erro(r.error);
    r.readAsDataURL(blob);
  });
}
function b64ParaBlob(b64, tipo = 'image/jpeg') {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return new Blob([u], { type: tipo });
}
