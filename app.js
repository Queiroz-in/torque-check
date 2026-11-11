/*
 * app.js — fluxo da inspeção de aperto com comprovação por foto.
 *
 * Regras principais:
 *  - A foto vem SÓ da câmera ao vivo (não há upload da galeria).
 *  - O item só é marcado quando o valor lido na foto está dentro da faixa.
 *  - Os itens são feitos em ordem; não dá para pular.
 *  - Toda tentativa (aprovada ou não) fica registrada com foto e horário.
 *  - Alertas antifraude: foto repetida, conferência rápida demais.
 *
 * Leitura só por visão computacional clássica, no próprio aparelho:
 *  - torquímetro digital: decodificador de 7 segmentos (leitor.js)
 *  - torquímetro analógico de relógio: mostrador + ponteiro (leitor-analogico.js),
 *    usando um perfil calibrado uma vez para cada modelo de torquímetro.
 */
(function () {
  'use strict';

  const CHAVE_ESTADO = 'torque-check:estado';
  const CHAVE_CONFIG = 'torque-check:config';
  // Guias, em fração do quadro VISÍVEL da câmera (têm que bater com o CSS)
  const GUIA_RET = { esquerda: 0.14, largura: 0.72, proporcao: 2 }; // visor digital
  const GUIA_CIRC = { raio: 0.36, margem: 1.3 };                    // mostrador analógico
  const HASH_IDENTICA = 6;   // bits de 256 — foto praticamente idêntica: bloqueia
  const HASH_PARECIDA = 30;  // abaixo disso: alerta no relatório
  const DIGITAL = { id: 'digital', tipo: 'digital', nome: 'Digital (visor de números)' };

  const CONFIG_PADRAO = {
    confiancaMinima: 0.8,
    tolPadraoPct: 10,
    intervaloMinimo: 5,
    tentativasSupervisor: 3,
    pinHash: '',
    torquimetros: [], // perfis calibrados de torquímetros analógicos
    listaParafusos: '', // texto "Nome do parafuso : torque", uma linha por parafuso
  };

  const MODELO_TXT = [
    '# Lista de parafusos - uma linha por parafuso',
    '# Formato:  Nome do parafuso : torque (N·m)',
    '# A faixa aceita usa a tolerância padrão das configurações.',
    '# Para uma faixa própria, escreva por exemplo "90 ± 5" ou "85 a 95".',
    '# Linhas começando com # são ignoradas.',
    'Parafuso 1 : 90',
    'Parafuso 2 : 120',
  ].join('\r\n');

  const LISTA_EXEMPLO = [
    'Roda dianteira esquerda - porca 1 : 450 ± 20',
    'Roda dianteira esquerda - porca 2 : 450 ± 20',
    'Suporte do motor lado direito : 90',
    'Suporte do motor lado esquerdo : 90',
    'Barra de direção - terminal : 120',
    'Pinça de freio dianteira - parafuso guia : 30 a 34',
  ].join('\n');

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const fmt = (n, casas = 1) => (n == null || isNaN(n) ? '—' :
    Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas }));
  const agora = () => new Date().toISOString();
  const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR');
  const dataHora = (iso) => new Date(iso).toLocaleString('pt-BR');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const virgula = (t) => String(t).replace('.', ',');

  function lerJSON(chave, padrao) {
    try {
      const v = localStorage.getItem(chave);
      return v ? JSON.parse(v) : padrao;
    } catch (e) {
      return padrao;
    }
  }

  function gravarJSON(chave, valor) {
    try {
      localStorage.setItem(chave, JSON.stringify(valor));
      return true;
    } catch (e) {
      return false;
    }
  }

  function aviso(el, tipo, html) {
    el.className = 'aviso ' + tipo;
    el.innerHTML = html;
    el.classList.remove('oculto');
  }

  function numero(txt, decimalVirgula) {
    if (txt == null) return NaN;
    let t = String(txt).trim().replace(/\s/g, '');
    if (!t) return NaN;
    // "1.234,5" e "32,5" (padrão brasileiro) ou "32.5"
    if (decimalVirgula && t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    return Number(t);
  }

  // ------------------------------------------------------------------
  // Estado
  // ------------------------------------------------------------------
  let config = Object.assign({}, CONFIG_PADRAO, lerJSON(CHAVE_CONFIG, {}));
  let estado = lerJSON(CHAVE_ESTADO, null);
  let planilhaCarregada = null; // { nome, itens, texto }

  function salvarConfig() {
    if (!gravarJSON(CHAVE_CONFIG, config)) alert('Não foi possível salvar as configurações neste aparelho.');
  }

  function salvarEstado() {
    if (!estado) {
      try { localStorage.removeItem(CHAVE_ESTADO); } catch (e) { /* sem armazenamento */ }
      return;
    }
    if (gravarJSON(CHAVE_ESTADO, estado)) return;
    // Sem espaço: descarta as fotos das tentativas reprovadas
    for (const it of estado.itens) {
      for (const t of it.tentativas) {
        if (t.resultado !== 'aprovado') { t.foto = null; t.recorte = null; }
      }
    }
    if (!gravarJSON(CHAVE_ESTADO, estado)) {
      alert('Memória do aparelho cheia: exporte o relatório (JSON) para não perder as evidências.');
    }
  }

  const ferramentaAtual = () => (estado && estado.inspecao.ferramenta) || DIGITAL;

  // ------------------------------------------------------------------
  // Navegação entre telas (a câmera é um único elemento, movido para a tela ativa)
  // ------------------------------------------------------------------
  function mostrarTela(id) {
    document.querySelectorAll('.tela').forEach((t) => t.classList.toggle('ativa', t.id === id));
    window.scrollTo(0, 0);
    const vaga = { 'tela-inspecao': 'vaga-camera-inspecao', 'tela-calibracao': 'vaga-camera-calibracao' }[id];
    if (vaga) {
      $(vaga).appendChild($('camera'));
      ligarCamera();
    } else {
      desligarCamera();
    }
  }

  // ------------------------------------------------------------------
  // Planilha (CSV)
  // ------------------------------------------------------------------
  function normalizarCabecalho(h) {
    return h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z_]/g, '');
  }

  function lerPlanilhaCSV(texto, tolPct) {
    const linhas = texto.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (linhas.length < 2) throw new Error('A planilha precisa de um cabeçalho e pelo menos um item.');
    const cab = linhas[0];
    const sep = cab.includes(';') ? ';' : cab.includes('\t') ? '\t' : ',';
    const decimalVirgula = sep !== ',';
    const colunas = cab.split(sep).map(normalizarCabecalho);
    const achar = (...nomes) => colunas.findIndex((c) => nomes.includes(c));
    const iItem = achar('item', 'id', 'posicao', 'codigo');
    const iDesc = achar('descricao', 'desc', 'parafuso', 'local');
    const iNom = achar('torque_nm', 'torque', 'nominal', 'torque_nominal', 'nm');
    const iMin = achar('min_nm', 'min', 'minimo', 'torque_min');
    const iMax = achar('max_nm', 'max', 'maximo', 'torque_max');
    const iTol = achar('tolerancia_pct', 'tolerancia', 'tol', 'tol_pct');
    if (iNom < 0) throw new Error('Não encontrei a coluna de torque (ex.: "torque_nm").');

    const itens = [];
    linhas.slice(1).forEach((linha, n) => {
      const c = linha.split(sep);
      const nominal = numero(c[iNom], decimalVirgula);
      if (isNaN(nominal) || nominal <= 0) throw new Error(`Linha ${n + 2}: torque inválido ("${c[iNom] ?? ''}").`);
      let min = iMin >= 0 ? numero(c[iMin], decimalVirgula) : NaN;
      let max = iMax >= 0 ? numero(c[iMax], decimalVirgula) : NaN;
      const tol = iTol >= 0 ? numero(c[iTol], decimalVirgula) : NaN;
      const pct = !isNaN(tol) ? tol : tolPct;
      if (isNaN(min)) min = +(nominal * (1 - pct / 100)).toFixed(2);
      if (isNaN(max)) max = +(nominal * (1 + pct / 100)).toFixed(2);
      if (min > max) throw new Error(`Linha ${n + 2}: mínimo maior que o máximo.`);
      itens.push({
        id: (iItem >= 0 && c[iItem] ? c[iItem].trim() : String(n + 1)),
        descricao: iDesc >= 0 && c[iDesc] ? c[iDesc].trim() : `Parafuso ${n + 1}`,
        nominal, min, max,
      });
    });
    return itens;
  }

  /**
   * Lê o torque de uma linha da lista. Aceita:
   *   "90"         -> nominal 90, faixa pela tolerância padrão
   *   "90 ± 5"     -> 85 a 95   (também "90 +- 5", "90 +/- 5", "90 ± 5%")
   *   "85 a 95"    -> 85 a 95   (também "85 - 95", "85 até 95")
   * com ou sem a unidade (Nm, N·m) e com vírgula ou ponto decimal.
   */
  function interpretarTorque(txt, tolPct) {
    const t = String(txt).replace(/n\s*[·.*]?\s*m\b/gi, '').replace(/\s+/g, ' ').trim();
    const N = /(\d+(?:[.,]\d+)?)/.source;
    const num = (v) => numero(v, true);
    let m, nominal, min, max;
    if ((m = t.match(new RegExp('^' + N + '$')))) {
      nominal = num(m[1]);
      min = nominal * (1 - tolPct / 100);
      max = nominal * (1 + tolPct / 100);
    } else if ((m = t.match(new RegExp('^' + N + ' ?(?:±|\\+ ?/? ?-) ?' + N + ' ?(%)?$')))) {
      nominal = num(m[1]);
      const d = m[3] ? nominal * num(m[2]) / 100 : num(m[2]);
      min = nominal - d;
      max = nominal + d;
    } else if ((m = t.match(new RegExp('^' + N + ' ?(?:-|–|a|até) ?' + N + '$', 'i')))) {
      min = num(m[1]);
      max = num(m[2]);
      nominal = (min + max) / 2;
    } else {
      return null;
    }
    if (![nominal, min, max].every(isFinite) || nominal <= 0 || min < 0 || min > max) return null;
    return { nominal: +nominal.toFixed(3), min: +min.toFixed(2), max: +max.toFixed(2) };
  }

  /** Lista no formato texto: "Nome do parafuso : torque", uma por linha. */
  function lerListaTexto(texto, tolPct) {
    const itens = [];
    texto.replace(/^﻿/, '').split(/\r?\n/).forEach((bruta, n) => {
      const linha = bruta.trim();
      if (!linha || linha.startsWith('#')) return;
      const p = linha.lastIndexOf(':');
      if (p < 0) throw new Error(`Linha ${n + 1}: falta o “:” entre o nome e o torque (“${linha}”). Exemplo: Parafuso 1 : 90`);
      const nome = linha.slice(0, p).trim();
      if (!nome) throw new Error(`Linha ${n + 1}: falta o nome do parafuso antes do “:”.`);
      const faixa = interpretarTorque(linha.slice(p + 1), tolPct);
      if (!faixa) throw new Error(`Linha ${n + 1}: torque inválido (“${linha.slice(p + 1).trim()}”). Exemplos: 90 · 90 ± 5 · 85 a 95`);
      itens.push(Object.assign({ id: String(itens.length + 1), descricao: nome }, faixa));
    });
    if (!itens.length) throw new Error('A lista está vazia. Escreva um parafuso por linha: Nome do parafuso : torque');
    return itens;
  }

  /** Lê a lista no formato texto (Nome : torque) ou planilha CSV, detectando qual é. */
  function lerLista(texto, tolPct) {
    const tol = tolPct == null ? config.tolPadraoPct : tolPct;
    const primeira = texto.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!primeira) throw new Error('A lista está vazia. Escreva um parafuso por linha: Nome do parafuso : torque');
    // CSV só quando o cabeçalho tem separador de colunas e não tem “:”
    const csv = !primeira.includes(':') && (primeira.includes(';') || primeira.includes('\t') || primeira.includes(','));
    return csv ? lerPlanilhaCSV(texto, tol) : lerListaTexto(texto, tol);
  }

  function usarLista(nome, texto, origem) {
    const info = $('info-planilha');
    const erro = $('erro-inicio');
    erro.classList.add('oculto');
    try {
      const itens = lerLista(texto);
      planilhaCarregada = { nome, itens, texto, origem };
      aviso(info, 'ok', `<b>${esc(nome)}</b>: ${itens.length} parafuso(s).`);
    } catch (e) {
      planilhaCarregada = null;
      aviso(info, 'erro', `<b>${esc(nome)}</b>: ${esc(e.message)}`);
    }
  }

  /** Carrega a lista salva nas configurações, se o usuário não escolheu outro arquivo. */
  function carregarListaPadrao() {
    if (planilhaCarregada && planilhaCarregada.origem === 'arquivo') return;
    if (config.listaParafusos && config.listaParafusos.trim()) {
      usarLista('Lista das configurações', config.listaParafusos, 'config');
    } else {
      planilhaCarregada = null;
      aviso($('info-planilha'), 'alerta', 'Nenhuma lista de parafusos cadastrada. Toque em <b>Editar lista</b> ' +
        'para digitar ou carregar um arquivo .txt no formato <code>Nome do parafuso : torque</code>.');
    }
  }

  // ------------------------------------------------------------------
  // Tela inicial
  // ------------------------------------------------------------------
  function preencherSeletorTorquimetro() {
    const sel = $('in-torquimetro');
    const atual = sel.value;
    sel.innerHTML = [DIGITAL, ...config.torquimetros].map((t) =>
      `<option value="${esc(t.id)}">${esc(t.tipo === 'analogico'
        ? `Analógico: ${t.nome} (${fmt(t.valorZero)}–${fmt(t.valorFim)} N·m)` : t.nome)}</option>`).join('');
    if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
  }

  function atualizarInicio() {
    preencherSeletorTorquimetro();
    carregarListaPadrao();
    const card = $('card-continuar');
    if (estado && !estado.inspecao.fim) {
      const feitos = estado.itens.filter((i) => i.status !== 'pendente').length;
      $('txt-continuar').textContent =
        `Chassi ${estado.inspecao.chassi} — ${feitos} de ${estado.itens.length} parafusos conferidos ` +
        `(iniciada em ${dataHora(estado.inspecao.inicio)}).`;
      card.classList.remove('oculto');
    } else {
      card.classList.add('oculto');
    }
  }

  $('in-planilha').addEventListener('change', (ev) => {
    const arq = ev.target.files[0];
    if (!arq) return;
    const leitor = new FileReader();
    leitor.onload = () => usarLista(arq.name, leitor.result, 'arquivo');
    leitor.readAsText(arq, 'utf-8');
  });

  $('btn-exemplo').addEventListener('click', () => usarLista('lista de exemplo', LISTA_EXEMPLO, 'arquivo'));
  $('btn-lista-config').addEventListener('click', () => {
    planilhaCarregada = null;
    $('in-planilha').value = '';
    carregarListaPadrao();
  });
  $('btn-editar-lista').addEventListener('click', () => abrirConfig('card-lista'));
  $('btn-cadastrar-analogico').addEventListener('click', () => abrirCalibracao(null, 'tela-inicio'));

  $('btn-iniciar').addEventListener('click', () => {
    const operador = $('in-operador').value.trim();
    const chassi = $('in-chassi').value.trim().toUpperCase();
    const erro = $('erro-inicio');
    if (!operador) return aviso(erro, 'erro', 'Informe a matrícula do inspetor.');
    if (!chassi) return aviso(erro, 'erro', 'Informe o chassi / VIN do veículo.');
    if (!planilhaCarregada) return aviso(erro, 'erro', 'Cadastre ou carregue a lista de parafusos.');
    const idFerr = $('in-torquimetro').value;
    const ferramenta = idFerr === 'digital' ? DIGITAL : config.torquimetros.find((t) => t.id === idFerr);
    if (!ferramenta) return aviso(erro, 'erro', 'Escolha o torquímetro.');
    if (ferramenta.tipo === 'analogico') {
      const lo = Math.min(ferramenta.valorZero, ferramenta.valorFim), hi = Math.max(ferramenta.valorZero, ferramenta.valorFim);
      const fora = planilhaCarregada.itens.filter((i) => i.min < lo || i.max > hi);
      if (fora.length) {
        return aviso(erro, 'erro', `A escala do torquímetro “${esc(ferramenta.nome)}” (${fmt(lo)}–${fmt(hi)} N·m) ` +
          `não cobre ${fora.length} item(ns): ${fora.slice(0, 4).map((i) => esc(i.id)).join(', ')}${fora.length > 4 ? '…' : ''}. ` +
          'Use um torquímetro de faixa adequada.');
      }
    }
    if (estado && !estado.inspecao.fim &&
      !confirm('Já existe uma inspeção em andamento. Descartá-la e começar outra?')) return;
    estado = {
      versao: 2,
      inspecao: {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        operador, chassi,
        planilha: planilhaCarregada.nome,
        ferramenta: JSON.parse(JSON.stringify(ferramenta)), // cópia: recalibrar depois não muda esta inspeção
        inicio: agora(),
        fim: null,
        dispositivo: navigator.userAgent,
      },
      atual: 0,
      itens: planilhaCarregada.itens.map((i) => Object.assign({}, i, {
        status: 'pendente', valorAprovado: null, aprovadoEm: null, liberacao: null, tentativas: [],
      })),
    };
    salvarEstado();
    renderInspecao();
    mostrarTela('tela-inspecao');
  });

  $('btn-continuar').addEventListener('click', () => { renderInspecao(); mostrarTela('tela-inspecao'); });
  $('btn-descartar').addEventListener('click', () => {
    if (!confirm('Descartar a inspeção em andamento? As evidências não exportadas serão perdidas.')) return;
    estado = null;
    salvarEstado();
    atualizarInicio();
  });

  // ------------------------------------------------------------------
  // Câmera
  // ------------------------------------------------------------------
  let stream = null;
  let lanterna = false;
  const botoesCaptura = () => [$('btn-capturar'), $('btn-cal-fotografar')];

  async function ligarCamera() {
    const msg = $('camera-msg');
    if (stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.innerHTML = 'Este navegador não dá acesso à câmera.<br>Abra o app por um endereço <b>https://</b> no Chrome ou Safari.';
      msg.classList.remove('oculto');
      botoesCaptura().forEach((b) => { b.disabled = true; });
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      const v = $('video');
      v.srcObject = stream;
      await v.play().catch(() => {});
      msg.classList.add('oculto');
      botoesCaptura().forEach((b) => { b.disabled = false; });
      const trilha = stream.getVideoTracks()[0];
      const cap = trilha.getCapabilities ? trilha.getCapabilities() : {};
      $('btn-lanterna').classList.toggle('oculto', !cap.torch);
    } catch (e) {
      msg.innerHTML = 'Não foi possível abrir a câmera.<br>Permita o acesso à câmera para continuar.<br><small>' + esc(e.message) + '</small>';
      msg.classList.remove('oculto');
      botoesCaptura().forEach((b) => { b.disabled = true; });
    }
  }

  function desligarCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    lanterna = false;
  }

  $('btn-lanterna').addEventListener('click', async () => {
    if (!stream) return;
    lanterna = !lanterna;
    try {
      await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: lanterna }] });
    } catch (e) { lanterna = false; }
  });

  /** Mostra o guia certo: retângulo (visor digital) ou círculo (mostrador). */
  function definirGuia(ferramenta) {
    const analog = ferramenta && ferramenta.tipo === 'analogico';
    $('guia').classList.toggle('oculto', analog);
    $('guia-circ').classList.toggle('oculto', !analog);
    const marca = $('guia-zero');
    if (analog && ferramenta.anguloZero != null) {
      marca.style.transform = `rotate(${ferramenta.anguloZero}deg)`;
      marca.classList.remove('oculto');
    } else {
      marca.classList.add('oculto');
    }
  }

  /**
   * Captura o quadro atual. Devolve a foto inteira (como o inspetor vê na
   * tela, já cortada pelo object-fit) e o recorte da área do guia.
   */
  function capturarQuadro(tipo) {
    const v = $('video');
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const caixa = $('camera').getBoundingClientRect();
    // object-fit: cover -> parte visível do vídeo
    const escala = Math.max(caixa.width / vw, caixa.height / vh);
    const visW = caixa.width / escala, visH = caixa.height / escala;
    const sx = (vw - visW) / 2, sy = (vh - visH) / 2;

    const maxLado = 1280;
    const red = Math.min(1, maxLado / Math.max(visW, visH));
    const foto = document.createElement('canvas');
    foto.width = Math.round(visW * red);
    foto.height = Math.round(visH * red);
    foto.getContext('2d').drawImage(v, sx, sy, visW, visH, 0, 0, foto.width, foto.height);

    let roi;
    if (tipo === 'analogico') {
      const r = foto.width * GUIA_CIRC.raio;
      const lado = Math.round(Math.min(foto.width, foto.height, 2 * r * GUIA_CIRC.margem));
      roi = { x: Math.round((foto.width - lado) / 2), y: Math.round((foto.height - lado) / 2), w: lado, h: lado };
    } else {
      const rw = foto.width * GUIA_RET.largura;
      const rh = rw / GUIA_RET.proporcao;
      roi = { x: Math.round(foto.width * GUIA_RET.esquerda), y: Math.round((foto.height - rh) / 2), w: Math.round(rw), h: Math.round(rh) };
    }
    const recorte = document.createElement('canvas');
    recorte.width = roi.w;
    recorte.height = roi.h;
    recorte.getContext('2d').drawImage(foto, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    return { foto, recorte, roi };
  }

  function miniatura(canvas, largura, qualidade) {
    const f = Math.min(1, largura / canvas.width);
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * f);
    c.height = Math.round(canvas.height * f);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', qualidade);
  }

  function congelar(foto, sim) {
    const c = $('congelado');
    if (sim) {
      c.width = foto.width;
      c.height = foto.height;
      c.getContext('2d').drawImage(foto, 0, 0);
      c.classList.remove('oculto');
    } else {
      c.classList.add('oculto');
    }
  }

  let timerFaixa = null;
  function faixaStatus(tipo, texto) {
    const el = $('faixa-status');
    clearTimeout(timerFaixa);
    el.className = 'faixa-status ' + tipo;
    el.textContent = texto;
    if (tipo !== 'lendo') timerFaixa = setTimeout(() => el.classList.add('oculto'), 3500);
  }

  // ------------------------------------------------------------------
  // Leitura + validação
  // ------------------------------------------------------------------
  function lerValor(recorte, ferramenta) {
    if (ferramenta.tipo === 'analogico') return window.LeitorAnalogico.lerAnalogico(recorte, ferramenta);
    return window.LeitorTorque.lerDigital(recorte);
  }

  function hashesAnteriores() {
    const lista = [];
    estado.itens.forEach((it, idx) => it.tentativas.forEach((t) => {
      if (t.hash) lista.push({ idx, item: it, t });
    }));
    return lista;
  }

  function ultimaAprovacao() {
    let ultima = null;
    for (const it of estado.itens) {
      if (it.aprovadoEm && (!ultima || it.aprovadoEm > ultima)) ultima = it.aprovadoEm;
    }
    return ultima;
  }

  const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
  let ocupado = false;

  async function aoCapturar() {
    if (ocupado || !estado) return;
    const idx = estado.atual;
    const item = estado.itens[idx];
    if (!item || item.status !== 'pendente') return;
    const ferramenta = ferramentaAtual();

    const q = capturarQuadro(ferramenta.tipo);
    if (!q) return;
    ocupado = true;
    const btn = $('btn-capturar');
    btn.disabled = true;
    btn.textContent = ferramenta.tipo === 'analogico' ? 'Lendo o ponteiro…' : 'Lendo o visor…';
    congelar(q.foto, true);
    faixaStatus('lendo', btn.textContent);
    await esperar(30); // deixa a tela atualizar antes do processamento

    const tentativa = {
      ts: agora(),
      valor: null,
      texto: '',
      confianca: 0,
      motor: ferramenta.tipo,
      resultado: null,
      alertas: [],
      foto: miniatura(q.foto, 360, 0.6),
      recorte: miniatura(q.recorte, 320, 0.75),
      hash: window.LeitorTorque.hashPerceptual(q.foto, q.roi),
    };

    try {
      // 1) foto repetida / muito parecida com outra já usada
      let maisParecida = null;
      for (const h of hashesAnteriores()) {
        const d = window.LeitorTorque.distanciaHamming(tentativa.hash, h.t.hash);
        if (!maisParecida || d < maisParecida.d) maisParecida = { d, ...h };
      }

      if (maisParecida && maisParecida.d <= HASH_IDENTICA && maisParecida.t.resultado === 'aprovado') {
        tentativa.resultado = 'repetida';
        tentativa.alertas.push(`Foto praticamente idêntica à usada no item ${maisParecida.item.id}.`);
      } else {
        if (maisParecida && maisParecida.d <= HASH_PARECIDA && maisParecida.idx !== idx) {
          tentativa.alertas.push(`Foto muito parecida com a do item ${maisParecida.item.id} (${maisParecida.d}/256).`);
        }
        // 2) leitura do valor
        const r = lerValor(q.recorte, ferramenta);
        Object.assign(tentativa, {
          valor: r.valor, texto: r.texto, confianca: +r.confianca.toFixed(2), motor: r.motor, detalhes: r.detalhes,
        });
        // 3) validação
        if (r.valor == null) {
          tentativa.resultado = 'ilegivel';
        } else if (r.confianca < config.confiancaMinima) {
          tentativa.resultado = 'duvidoso';
        } else if (r.valor < item.min - 1e-9 || r.valor > item.max + 1e-9) {
          tentativa.resultado = 'fora_faixa';
        } else {
          tentativa.resultado = 'aprovado';
        }
      }
    } catch (e) {
      tentativa.resultado = 'erro';
      tentativa.alertas.push('Erro na leitura: ' + e.message);
    }

    if (tentativa.resultado === 'aprovado') {
      const anterior = ultimaAprovacao();
      if (anterior) {
        const seg = (Date.parse(tentativa.ts) - Date.parse(anterior)) / 1000;
        if (seg < config.intervaloMinimo) {
          tentativa.alertas.push(`Conferido ${seg.toFixed(1)} s após o item anterior (mínimo esperado: ${config.intervaloMinimo} s).`);
        }
      }
      item.status = 'aprovado';
      item.valorAprovado = tentativa.valor;
      item.aprovadoEm = tentativa.ts;
    }
    item.tentativas.push(tentativa);
    salvarEstado();
    mostrarResultado(item, tentativa);

    ocupado = false;
    btn.textContent = '📷 Fotografar torquímetro';
    btn.disabled = false;

    if (tentativa.resultado === 'aprovado') {
      btn.disabled = true;
      setTimeout(() => {
        congelar(null, false);
        avancar();
        btn.disabled = false;
      }, 1600);
    } else {
      setTimeout(() => congelar(null, false), 1200);
      renderInspecao(true);
    }
  }

  function mostrarResultado(item, t) {
    const analog = t.motor === 'analogico';
    $('card-resultado').classList.remove('oculto');
    $('res-img').src = t.recorte || '';
    $('res-valor').textContent = t.valor != null ? virgula(t.texto) + ' N·m' : (t.texto || '—');
    $('res-motor').textContent = t.valor != null
      ? `${analog ? 'Ponteiro' : 'Visor digital'} · confiança ${Math.round(t.confianca * 100)}%` : '';
    const faixa = `${fmt(item.min, 2)} a ${fmt(item.max, 2)} N·m`;
    const motivo = t.detalhes && t.detalhes.motivo ? ` (${esc(t.detalhes.motivo)})` : '';
    const dicaFoto = analog
      ? 'Encaixe o mostrador inteiro no círculo verde, com o zero na marca, e fotografe de frente, sem reflexo.'
      : 'Enquadre só os números dentro do retângulo verde, evite reflexo e mantenha o celular parado.';
    const msgs = {
      aprovado: ['ok', `✅ <b>Aperto conferido.</b> ${virgula(t.texto)} N·m está dentro da faixa (${faixa}).`],
      fora_faixa: ['erro', `❌ <b>Fora da faixa.</b> ${analog ? 'O ponteiro indica' : 'O visor mostra'} ${virgula(t.texto)} N·m, ` +
        `e o especificado é ${faixa}. Refaça o aperto e fotografe de novo.` +
        (analog ? ' Lembre de zerar o ponteiro de arraste antes de apertar.' : '')],
      ilegivel: ['erro', `⚠️ <b>Não consegui ler ${analog ? 'o ponteiro' : 'o visor'}</b>${motivo}. ${dicaFoto}`],
      duvidoso: ['alerta', `⚠️ <b>Leitura duvidosa</b> (li “${esc(virgula(t.texto))}”). ${dicaFoto}`],
      repetida: ['erro', '🚫 <b>Foto repetida.</b> Esta imagem é igual à de outro parafuso já conferido. ' +
        'Fotografe o torquímetro no parafuso atual.'],
      erro: ['erro', '⚠️ <b>Erro na leitura.</b> Tente de novo.'],
    };
    const [tipo, html] = msgs[t.resultado] || msgs.erro;
    aviso($('res-msg'), tipo, html);
    const curto = {
      aprovado: `✅ ${virgula(t.texto)} N·m — conferido`,
      fora_faixa: `❌ ${virgula(t.texto)} N·m — fora da faixa`,
      ilegivel: '⚠️ Não consegui ler — tente de novo',
      duvidoso: '⚠️ Leitura duvidosa — tente de novo',
      repetida: '🚫 Foto repetida',
      erro: '⚠️ Erro na leitura',
    };
    faixaStatus(tipo, curto[t.resultado] || curto.erro);
    $('res-alertas').innerHTML = t.alertas.map((a) => `<div class="aviso alerta">${esc(a)}</div>`).join('');
  }

  function avancar() {
    const prox = estado.itens.findIndex((i) => i.status === 'pendente');
    if (prox < 0) {
      estado.inspecao.fim = agora();
      salvarEstado();
      renderRelatorio();
      mostrarTela('tela-relatorio');
      return;
    }
    estado.atual = prox;
    salvarEstado();
    $('card-resultado').classList.add('oculto');
    renderInspecao();
  }

  $('btn-capturar').addEventListener('click', aoCapturar);

  // ------------------------------------------------------------------
  // Liberação do supervisor
  // ------------------------------------------------------------------
  $('btn-supervisor').addEventListener('click', () => {
    if (!config.pinHash) {
      alert('Nenhum PIN de supervisor configurado. Configure em Configurações.');
      return;
    }
    $('sup-pin').value = '';
    $('sup-valor').value = '';
    $('sup-motivo').value = '';
    $('sup-erro').classList.add('oculto');
    $('dlg-supervisor').showModal();
  });
  $('sup-cancelar').addEventListener('click', () => $('dlg-supervisor').close());
  $('sup-confirmar').addEventListener('click', async () => {
    const erro = $('sup-erro');
    const item = estado.itens[estado.atual];
    const pin = $('sup-pin').value;
    const valor = numero($('sup-valor').value, true);
    const motivo = $('sup-motivo').value.trim();
    if (await window.LeitorTorque.sha256('torque-check:' + pin) !== config.pinHash) return aviso(erro, 'erro', 'PIN incorreto.');
    if (isNaN(valor)) return aviso(erro, 'erro', 'Informe o valor conferido.');
    if (valor < item.min || valor > item.max) return aviso(erro, 'erro', `Valor fora da faixa (${fmt(item.min, 2)} a ${fmt(item.max, 2)} N·m). Refaça o aperto.`);
    if (motivo.length < 5) return aviso(erro, 'erro', 'Descreva o motivo da liberação.');
    item.status = 'liberado_supervisor';
    item.valorAprovado = valor;
    item.aprovadoEm = agora();
    item.liberacao = { ts: item.aprovadoEm, valor, motivo };
    salvarEstado();
    $('dlg-supervisor').close();
    avancar();
  });

  // ------------------------------------------------------------------
  // Renderização da inspeção
  // ------------------------------------------------------------------
  function renderInspecao(manterResultado) {
    if (!estado) return;
    const total = estado.itens.length;
    const feitos = estado.itens.filter((i) => i.status !== 'pendente').length;
    const ferr = ferramentaAtual();
    $('txt-progresso').textContent = `Veículo ${estado.inspecao.chassi} · ${feitos} de ${total} conferidos`;
    $('txt-ferramenta').textContent = ferr.tipo === 'analogico'
      ? `Torquímetro analógico: ${ferr.nome}` : 'Torquímetro digital';
    $('barra').style.width = (100 * feitos / total) + '%';
    definirGuia(ferr);
    $('dica-analogico').classList.toggle('oculto', ferr.tipo !== 'analogico');

    const item = estado.itens[estado.atual];
    $('item-pos').textContent = `Item ${estado.atual + 1} de ${total}` + (item.id !== String(estado.atual + 1) ? ` · ${item.id}` : '');
    $('item-desc').textContent = item.descricao;
    $('item-nominal').textContent = fmt(item.nominal, 2);
    $('item-faixa').textContent = `${fmt(item.min, 2)} – ${fmt(item.max, 2)}`;
    if (!manterResultado) $('card-resultado').classList.add('oculto');

    const falhas = item.tentativas.filter((t) => t.resultado !== 'aprovado').length;
    $('btn-supervisor').classList.toggle('oculto', falhas < config.tentativasSupervisor);

    $('lista-itens').innerHTML = estado.itens.map((it, i) => {
      const atual = i === estado.atual && it.status === 'pendente';
      const cls = it.status === 'aprovado' ? 'ok' : it.status === 'liberado_supervisor' ? 'sup' : atual ? 'atual' : '';
      const ic = it.status === 'aprovado' ? '✓' : it.status === 'liberado_supervisor' ? 'S' : i + 1;
      const alertas = it.tentativas.some((t) => t.alertas.length) ? '<span class="tag">alerta</span>' : '';
      const vl = it.valorAprovado != null ? `${fmt(it.valorAprovado, 2)} N·m` : `${fmt(it.min, 2)}–${fmt(it.max, 2)}`;
      return `<li class="${atual ? 'atual' : ''}"><span class="st ${cls}">${ic}</span>` +
        `<span class="nm">${esc(it.descricao)}${alertas}</span><span class="vl">${vl}</span></li>`;
    }).join('');
  }

  $('btn-ver-relatorio').addEventListener('click', () => { renderRelatorio(); mostrarTela('tela-relatorio'); });

  // ------------------------------------------------------------------
  // Relatório
  // ------------------------------------------------------------------
  const ROTULO = {
    pendente: 'Pendente',
    aprovado: 'Conferido (foto)',
    liberado_supervisor: 'Liberado supervisor',
  };

  function descreverFerramenta(f) {
    return f.tipo === 'analogico'
      ? `analógico “${f.nome}” (escala ${fmt(f.valorZero)}–${fmt(f.valorFim)} N·m, divisão ${fmt(f.menorDivisao, 2)})`
      : 'digital';
  }

  function dadosExportacao() {
    const f = Object.assign({}, ferramentaAtual());
    delete f.perfilAngular; // dado interno de calibração, não interessa no relatório
    return {
      geradoEm: agora(),
      app: 'torque-check',
      inspecao: Object.assign({}, estado.inspecao, { ferramenta: f }),
      configuracao: { confiancaMinima: config.confiancaMinima, intervaloMinimo: config.intervaloMinimo },
      itens: estado.itens,
    };
  }

  let relatorioCache = null;

  async function renderRelatorio() {
    if (!estado) return;
    const ins = estado.inspecao;
    const ok = estado.itens.filter((i) => i.status === 'aprovado').length;
    const sup = estado.itens.filter((i) => i.status === 'liberado_supervisor').length;
    const pend = estado.itens.length - ok - sup;
    $('rel-cabecalho').innerHTML =
      `Chassi <b>${esc(ins.chassi)}</b> · Inspetor <b>${esc(ins.operador)}</b><br>` +
      `Início ${dataHora(ins.inicio)}${ins.fim ? ' · Fim ' + dataHora(ins.fim) : ' · em andamento'}<br>` +
      `Planilha: ${esc(ins.planilha)} · Torquímetro ${esc(descreverFerramenta(ferramentaAtual()))}`;
    $('rel-ok').textContent = ok;
    $('rel-sup').textContent = sup;
    $('rel-pend').textContent = pend;
    const nAlertas = estado.itens.reduce((a, i) => a + i.tentativas.reduce((b, t) => b + t.alertas.length, 0), 0);
    if (pend) aviso($('rel-status'), 'erro', `Inspeção incompleta: ${pend} parafuso(s) pendente(s).`);
    else if (sup || nAlertas) aviso($('rel-status'), 'alerta', `Inspeção completa com ${sup} liberação(ões) do supervisor e ${nAlertas} alerta(s) para revisão.`);
    else aviso($('rel-status'), 'ok', 'Todos os parafusos conferidos por foto, sem alertas.');

    $('rel-tabela').innerHTML = estado.itens.map((it) => {
      const aprov = it.tentativas.find((t) => t.resultado === 'aprovado');
      const ult = aprov || it.tentativas[it.tentativas.length - 1];
      const alertas = it.tentativas.flatMap((t) => t.alertas);
      return `<tr>
        <td><b>${esc(it.id)}</b><br>${esc(it.descricao)}${alertas.length ? `<br><span class="tag">${alertas.length} alerta(s)</span>` : ''}
          ${ult && ult.recorte ? `<img src="${ult.recorte}" alt="Foto do torquímetro">` : ''}</td>
        <td>${fmt(it.min, 2)}–${fmt(it.max, 2)}</td>
        <td>${it.valorAprovado != null ? fmt(it.valorAprovado, 2) : '—'}${it.aprovadoEm ? '<br><span class="sub">' + hora(it.aprovadoEm) + '</span>' : ''}</td>
        <td>${ROTULO[it.status]}${it.liberacao ? '<br><span class="sub">' + esc(it.liberacao.motivo) + '</span>' : ''}
          <br><span class="sub">${it.tentativas.length} foto(s)</span></td>
      </tr>`;
    }).join('');

    const json = JSON.stringify(dadosExportacao());
    relatorioCache = json;
    $('rel-hash').textContent = 'SHA-256: ' + await window.LeitorTorque.sha256(json);
  }

  function baixar(nome, conteudo, tipo) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const nomeBase = () => `torque_${estado.inspecao.chassi}_${estado.inspecao.inicio.slice(0, 19).replace(/[:T]/g, '-')}`;

  $('btn-csv').addEventListener('click', () => {
    const num = (n) => (n == null ? '' : virgula(n));
    const linhas = [['item', 'descricao', 'min_nm', 'max_nm', 'valor_lido_nm', 'status', 'horario', 'tentativas', 'alertas'].join(';')];
    for (const it of estado.itens) {
      const alertas = it.tentativas.flatMap((t) => t.alertas).join(' | ');
      linhas.push([it.id, it.descricao, num(it.min), num(it.max), num(it.valorAprovado), ROTULO[it.status],
        it.aprovadoEm ? dataHora(it.aprovadoEm) : '', it.tentativas.length, alertas]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'));
    }
    baixar(nomeBase() + '.csv', '\uFEFF' + linhas.join('\r\n'), 'text/csv;charset=utf-8');
  });
  $('btn-json').addEventListener('click', () => baixar(nomeBase() + '.json', relatorioCache || JSON.stringify(dadosExportacao()), 'application/json'));
  $('btn-imprimir').addEventListener('click', () => window.print());
  $('btn-voltar-inspecao').addEventListener('click', () => {
    if (estado.itens.every((i) => i.status !== 'pendente')) return alert('Todos os itens já foram conferidos.');
    renderInspecao();
    mostrarTela('tela-inspecao');
  });
  $('btn-nova').addEventListener('click', () => {
    if (!confirm('Encerrar esta inspeção? Exporte o JSON antes se precisar guardar as evidências.')) return;
    estado = null;
    salvarEstado();
    planilhaCarregada = null;
    $('info-planilha').classList.add('oculto');
    $('in-planilha').value = '';
    $('in-chassi').value = '';
    atualizarInicio();
    mostrarTela('tela-inicio');
  });

  // ------------------------------------------------------------------
  // Calibração de torquímetro analógico
  //
  // Feita uma vez por modelo de torquímetro: o usuário informa a escala,
  // fotografa o mostrador e toca no traço do zero e no traço do fim da
  // escala. O app guarda os ângulos e uma "assinatura" da escala, usada
  // depois para corrigir a rotação de cada foto.
  // ------------------------------------------------------------------
  const cal = { editando: null, voltarPara: 'tela-inicio', foto: null, circulo: null, toques: [], perfil: null };

  function abrirCalibracao(perfil, voltarPara) {
    cal.editando = perfil;
    cal.voltarPara = voltarPara;
    $('cal-nome').value = perfil ? perfil.nome : '';
    $('cal-zero').value = perfil ? perfil.valorZero : 0;
    $('cal-fim').value = perfil ? perfil.valorFim : '';
    $('cal-divisao').value = perfil ? perfil.menorDivisao : '';
    $('cal-cor').value = perfil ? perfil.corPonteiro : 'vermelho';
    $('cal-arraste').checked = perfil ? !!perfil.usarMaiorValor : true;
    $('cal-erro').classList.add('oculto');
    reiniciarFotoCalibracao();
    definirGuia({ tipo: 'analogico' });
    mostrarTela('tela-calibracao');
  }

  function reiniciarFotoCalibracao() {
    cal.foto = null;
    cal.circulo = null;
    cal.toques = [];
    cal.perfil = null;
    $('cal-etapa-foto').classList.remove('oculto');
    $('cal-etapa-toques').classList.add('oculto');
    $('btn-cal-salvar').disabled = true;
  }

  function dadosEscala() {
    const d = {
      nome: $('cal-nome').value.trim(),
      valorZero: numero($('cal-zero').value, true),
      valorFim: numero($('cal-fim').value, true),
      menorDivisao: numero($('cal-divisao').value, true),
      corPonteiro: $('cal-cor').value,
      usarMaiorValor: $('cal-arraste').checked,
    };
    if (!d.nome) throw new Error('Dê um nome ao torquímetro (ex.: modelo e nº de patrimônio).');
    if (isNaN(d.valorZero) || isNaN(d.valorFim) || d.valorFim <= d.valorZero) throw new Error('Informe o valor do início e do fim da escala (fim maior que início).');
    if (isNaN(d.menorDivisao) || d.menorDivisao <= 0) throw new Error('Informe o valor da menor divisão da escala.');
    return d;
  }

  $('btn-cal-fotografar').addEventListener('click', () => {
    const erro = $('cal-erro');
    erro.classList.add('oculto');
    try { dadosEscala(); } catch (e) { return aviso(erro, 'erro', esc(e.message)); }
    const q = capturarQuadro('analogico');
    if (!q) return;
    cal.foto = q.recorte;
    cal.circulo = window.LeitorAnalogico.localizarMostrador(q.recorte);
    if (cal.circulo.suporte < 0.4) {
      return aviso(erro, 'erro', 'Não encontrei o mostrador redondo. Encaixe-o inteiro no círculo verde, de frente, e fotografe de novo.');
    }
    cal.toques = [];
    $('cal-etapa-foto').classList.add('oculto');
    $('cal-etapa-toques').classList.remove('oculto');
    desenharCalibracao();
  });

  function desenharCalibracao() {
    const c = $('cal-canvas');
    c.width = cal.foto.width;
    c.height = cal.foto.height;
    const x = c.getContext('2d');
    x.drawImage(cal.foto, 0, 0);
    const ci = cal.circulo;
    const lw = Math.max(2, c.width / 200);
    x.lineWidth = lw;
    x.strokeStyle = '#39d353';
    x.beginPath(); x.arc(ci.x, ci.y, ci.r, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#39d353';
    x.beginPath(); x.arc(ci.x, ci.y, lw * 2, 0, Math.PI * 2); x.fill();
    const cores = ['#0b62d6', '#c62828'];
    cal.toques.forEach((t, i) => {
      x.strokeStyle = cores[i];
      x.beginPath(); x.moveTo(ci.x, ci.y); x.lineTo(t.x, t.y); x.stroke();
      x.fillStyle = cores[i];
      x.beginPath(); x.arc(t.x, t.y, lw * 3, 0, Math.PI * 2); x.fill();
    });
    const d = (() => { try { return dadosEscala(); } catch (e) { return null; } })();
    const instr = $('cal-instrucao');
    if (cal.toques.length === 0) instr.innerHTML = `<b>1/2</b> Toque no traço do <b>início da escala</b> (${d ? fmt(d.valorZero) : '0'} N·m).`;
    else if (cal.toques.length === 1) instr.innerHTML = `<b>2/2</b> Toque no traço do <b>fim da escala</b> (${d ? fmt(d.valorFim) : ''} N·m).`;
    else instr.innerHTML = 'Pronto. Confira as duas linhas e salve, ou toque em “Refazer toques”.';
  }

  $('cal-canvas').addEventListener('click', (ev) => {
    if (!cal.foto || cal.toques.length >= 2) return;
    const c = $('cal-canvas');
    const r = c.getBoundingClientRect();
    cal.toques.push({ x: (ev.clientX - r.left) * c.width / r.width, y: (ev.clientY - r.top) * c.height / r.height });
    desenharCalibracao();
    if (cal.toques.length === 2) finalizarCalibracao();
  });

  function finalizarCalibracao() {
    const erro = $('cal-erro');
    try {
      const d = dadosEscala();
      const r = window.LeitorAnalogico.calibrar(cal.foto, cal.toques[0], cal.toques[1], d);
      cal.perfil = r.perfil;
      const teste = window.LeitorAnalogico.lerAnalogico(cal.foto, cal.perfil);
      const sw = ((cal.perfil.anguloFim - cal.perfil.anguloZero) % 360 + 360) % 360;
      aviso(erro, 'ok', `Escala de ${fmt(sw, 0)}° de volta. ` +
        (teste.valor != null
          ? `Nesta foto, o ponteiro indica <b>${virgula(teste.texto)} N·m</b> — confira se bate com o mostrador.`
          : 'Nenhum ponteiro de leitura encontrado nesta foto (normal se ele estiver no zero).'));
      $('btn-cal-salvar').disabled = false;
    } catch (e) {
      cal.perfil = null;
      aviso(erro, 'erro', esc(e.message));
    }
  }

  $('btn-cal-refazer').addEventListener('click', () => {
    cal.toques = [];
    cal.perfil = null;
    $('btn-cal-salvar').disabled = true;
    $('cal-erro').classList.add('oculto');
    desenharCalibracao();
  });
  $('btn-cal-nova-foto').addEventListener('click', () => { reiniciarFotoCalibracao(); $('cal-erro').classList.add('oculto'); });
  $('btn-cal-cancelar').addEventListener('click', () => sairCalibracao());

  $('btn-cal-salvar').addEventListener('click', () => {
    if (!cal.perfil) return;
    let d;
    try { d = dadosEscala(); } catch (e) { return aviso($('cal-erro'), 'erro', esc(e.message)); }
    const perfil = Object.assign({}, cal.perfil, d, {
      id: cal.editando ? cal.editando.id : 'an-' + Date.now().toString(36),
      tipo: 'analogico',
      calibradoEm: agora(),
    });
    config.torquimetros = config.torquimetros.filter((t) => t.id !== perfil.id).concat(perfil);
    salvarConfig();
    sairCalibracao(perfil.id);
  });

  function sairCalibracao(idNovo) {
    const destino = cal.voltarPara;
    mostrarTela(destino);
    if (destino === 'tela-config') renderTorquimetros();
    if (destino === 'tela-inicio') {
      atualizarInicio();
      if (idNovo) $('in-torquimetro').value = idNovo;
    }
  }

  // ------------------------------------------------------------------
  // Configurações
  // ------------------------------------------------------------------
  let telaAntesConfig = 'tela-inicio';

  function renderTorquimetros() {
    const lista = $('cfg-torquimetros');
    if (!config.torquimetros.length) {
      lista.innerHTML = '<p class="sub">Nenhum torquímetro analógico cadastrado.</p>';
      return;
    }
    lista.innerHTML = config.torquimetros.map((t) => `
      <div class="torq">
        <div><b>${esc(t.nome)}</b><br><span class="sub">${fmt(t.valorZero)}–${fmt(t.valorFim)} N·m · divisão ${fmt(t.menorDivisao, 2)} ·
          ponteiro ${esc(t.corPonteiro)}${t.usarMaiorValor ? ' · arraste' : ''}<br>calibrado em ${dataHora(t.calibradoEm)}</span></div>
        <div class="linha-btn">
          <button class="btn sec mini" data-recalibrar="${esc(t.id)}" type="button">Recalibrar</button>
          <button class="btn sec mini" data-excluir="${esc(t.id)}" type="button">Excluir</button>
        </div>
      </div>`).join('');
  }

  $('cfg-torquimetros').addEventListener('click', (ev) => {
    const rec = ev.target.getAttribute('data-recalibrar');
    const exc = ev.target.getAttribute('data-excluir');
    if (rec) abrirCalibracao(config.torquimetros.find((t) => t.id === rec), 'tela-config');
    if (exc && confirm('Excluir este torquímetro?')) {
      config.torquimetros = config.torquimetros.filter((t) => t.id !== exc);
      salvarConfig();
      renderTorquimetros();
    }
  });
  $('btn-cfg-novo-torq').addEventListener('click', () => abrirCalibracao(null, 'tela-config'));

  function preencherConfig() {
    $('cfg-confianca').value = config.confiancaMinima;
    $('cfg-tol').value = config.tolPadraoPct;
    $('cfg-intervalo').value = config.intervaloMinimo;
    $('cfg-tentativas').value = config.tentativasSupervisor;
    $('cfg-pin').value = '';
    $('cfg-pin-status').textContent = config.pinHash ? 'PIN do supervisor configurado.' : 'Nenhum PIN configurado ainda.';
    $('cfg-lista').value = config.listaParafusos || '';
    previaLista();
    renderTorquimetros();
  }

  function abrirConfig(foco) {
    const ativa = document.querySelector('.tela.ativa');
    if (ativa.id === 'tela-config' || ativa.id === 'tela-calibracao') return;
    const abrir = () => {
      telaAntesConfig = ativa.id;
      preencherConfig();
      mostrarTela('tela-config');
      if (foco) $(foco).scrollIntoView({ block: 'start' });
    };
    if (estado && !estado.inspecao.fim && ativa.id === 'tela-inspecao' && config.pinHash) {
      // durante a inspeção, só o supervisor muda as regras
      const pin = prompt('PIN do supervisor para alterar configurações:');
      if (pin == null) return;
      window.LeitorTorque.sha256('torque-check:' + pin).then((h) => {
        if (h !== config.pinHash) return alert('PIN incorreto.');
        abrir();
      });
      return;
    }
    abrir();
  }
  $('btn-config').addEventListener('click', () => abrirConfig());

  // Lista de parafusos (texto "Nome : torque")
  function tolNaTela() {
    const v = Number($('cfg-tol').value);
    return isNaN(v) ? config.tolPadraoPct : Math.min(50, Math.max(0, v));
  }

  function previaLista() {
    const el = $('cfg-lista-info');
    const texto = $('cfg-lista').value;
    if (!texto.trim()) {
      aviso(el, 'alerta', 'Lista vazia. Escreva um parafuso por linha, por exemplo: <code>Parafuso 1 : 90</code>');
      return null;
    }
    try {
      const itens = lerLista(texto, tolNaTela());
      const linhas = itens.slice(0, 8).map((i) =>
        `<tr><td>${esc(i.descricao)}</td><td>${fmt(i.nominal, 2)}</td><td>${fmt(i.min, 2)}–${fmt(i.max, 2)}</td></tr>`).join('');
      aviso(el, 'ok', `✓ ${itens.length} parafuso(s)<table class="previa"><thead><tr><th>Parafuso</th><th>Torque</th>` +
        `<th>Faixa aceita</th></tr></thead><tbody>${linhas}</tbody></table>` +
        (itens.length > 8 ? `<span class="sub">… e mais ${itens.length - 8}</span>` : ''));
      return itens;
    } catch (e) {
      aviso(el, 'erro', esc(e.message));
      return null;
    }
  }

  $('cfg-lista').addEventListener('input', previaLista);
  $('cfg-tol').addEventListener('input', previaLista);
  $('cfg-lista-arquivo').addEventListener('change', (ev) => {
    const arq = ev.target.files[0];
    if (!arq) return;
    const leitor = new FileReader();
    leitor.onload = () => {
      const atual = $('cfg-lista').value.trim();
      if (atual && !confirm(`Substituir a lista atual pelo conteúdo de “${arq.name}”?`)) return;
      $('cfg-lista').value = String(leitor.result).replace(/^﻿/, '');
      previaLista();
    };
    leitor.readAsText(arq, 'utf-8');
    ev.target.value = '';
  });
  $('btn-cfg-lista-modelo').addEventListener('click', () => baixar('modelo-lista-parafusos.txt', '﻿' + MODELO_TXT, 'text/plain;charset=utf-8'));
  $('btn-cfg-lista-baixar').addEventListener('click', () => {
    const texto = $('cfg-lista').value;
    if (!texto.trim()) return alert('A lista está vazia.');
    baixar('lista-parafusos.txt', '﻿' + texto.replace(/\r?\n/g, '\r\n'), 'text/plain;charset=utf-8');
  });

  $('btn-cfg-voltar').addEventListener('click', () => {
    mostrarTela(telaAntesConfig);
    if (telaAntesConfig === 'tela-inicio') atualizarInicio();
  });
  $('btn-cfg-salvar').addEventListener('click', async () => {
    const n = (id, min, max, padrao) => {
      const v = Number($(id).value);
      return isNaN(v) ? padrao : Math.min(max, Math.max(min, v));
    };
    // valida a lista antes de salvar qualquer coisa
    const textoLista = $('cfg-lista').value;
    if (textoLista.trim() && !previaLista()) {
      $('card-lista').scrollIntoView({ block: 'start' });
      return alert('Corrija a lista de parafusos antes de salvar (veja a mensagem em vermelho).');
    }
    config.listaParafusos = textoLista.trim() ? textoLista : '';
    config.confiancaMinima = n('cfg-confianca', 0.5, 1, CONFIG_PADRAO.confiancaMinima);
    config.tolPadraoPct = n('cfg-tol', 0, 50, CONFIG_PADRAO.tolPadraoPct);
    config.intervaloMinimo = n('cfg-intervalo', 0, 120, CONFIG_PADRAO.intervaloMinimo);
    config.tentativasSupervisor = Math.round(n('cfg-tentativas', 1, 10, CONFIG_PADRAO.tentativasSupervisor));
    const pin = $('cfg-pin').value;
    if (pin) {
      if (pin.length < 4) return alert('O PIN precisa ter pelo menos 4 dígitos.');
      config.pinHash = await window.LeitorTorque.sha256('torque-check:' + pin);
    }
    salvarConfig();
    // recarrega a lista (o texto ou a tolerância padrão podem ter mudado)
    if (planilhaCarregada && planilhaCarregada.origem === 'arquivo') {
      usarLista(planilhaCarregada.nome, planilhaCarregada.texto, 'arquivo');
    } else {
      planilhaCarregada = null;
      carregarListaPadrao();
    }
    mostrarTela(telaAntesConfig);
    if (telaAntesConfig === 'tela-inspecao') renderInspecao();
    if (telaAntesConfig === 'tela-inicio') atualizarInicio();
  });

  // ------------------------------------------------------------------
  // Início
  // ------------------------------------------------------------------
  document.addEventListener('visibilitychange', () => {
    const ativa = document.querySelector('.tela.ativa').id;
    if (document.hidden) desligarCamera();
    else if (ativa === 'tela-inspecao' || ativa === 'tela-calibracao') ligarCamera();
  });

  // descarta dados em formato antigo ou inválido
  if (estado && (!estado.itens || !estado.inspecao)) estado = null;
  delete config.motor; delete config.apiKey; delete config.modelo; // opções de versões antigas
  atualizarInicio();
})();
