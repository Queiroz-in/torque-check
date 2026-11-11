/*
 * leitor.js — leitura do visor de torquímetros DIGITAIS (7 segmentos) e
 * utilidades comuns (hash perceptual, SHA-256).
 *
 * Só visão computacional clássica, sem rede neural e sem internet:
 * binarização (Otsu e limiar local), remoção de moldura, correção de
 * inclinação por cisalhamento, componentes conexos e classificação de cada
 * dígito pelos 7 segmentos acesos.
 *
 * Saída: { valor: Number|null, texto: String, confianca: 0..1, motor, detalhes }
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Pré-processamento de imagem
  // ---------------------------------------------------------------------

  function canvasDe(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /** Redimensiona para uma altura fixa e devolve tons de cinza (Uint8Array). */
  function cinzaRedimensionado(origem, alturaAlvo) {
    const esc = alturaAlvo / origem.height;
    const w = Math.max(1, Math.round(origem.width * esc));
    const h = alturaAlvo;
    const c = canvasDe(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(origem, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) {
      // Usa o maior canal além da luminância: visores de LED vermelho/verde
      // ficam bem mais contrastados assim.
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const max = Math.max(px[i], px[i + 1], px[i + 2]);
      g[j] = Math.round(0.6 * lum + 0.4 * max);
    }
    return { g, w, h };
  }

  /** Limiar de Otsu. */
  function otsu(g) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const total = g.length;
    let soma = 0;
    for (let t = 0; t < 256; t++) soma += t * hist[t];
    let somaB = 0, wB = 0, melhor = 0, limiar = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      somaB += t * hist[t];
      const mB = somaB / wB;
      const mF = (soma - somaB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > melhor) { melhor = v; limiar = t; }
    }
    return limiar;
  }

  /** Remove componentes de "tinta" (1) que encostam na borda — moldura do aparelho, sombras. */
  function removerBorda(b, w, h) {
    const pilha = [];
    const marca = (x, y) => {
      const i = y * w + x;
      if (b[i] === 1) { b[i] = 0; pilha.push(i); }
    };
    for (let x = 0; x < w; x++) { marca(x, 0); marca(x, h - 1); }
    for (let y = 0; y < h; y++) { marca(0, y); marca(w - 1, y); }
    while (pilha.length) {
      const i = pilha.pop();
      const x = i % w, y = (i / w) | 0;
      if (x > 0) marca(x - 1, y);
      if (x < w - 1) marca(x + 1, y);
      if (y > 0) marca(x, y - 1);
      if (y < h - 1) marca(x, y + 1);
    }
  }

  /** Dilatação da tinta (une os segmentos separados dos dígitos). */
  function dilatar(b, w, h, r) {
    if (r <= 0) return b;
    // separável: horizontal depois vertical
    const t = new Uint8Array(b.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w && b[y * w + xx]) v = 1;
        }
        t[y * w + x] = v;
      }
    }
    const s = new Uint8Array(b.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -r; k <= r && !v; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h && t[yy * w + x]) v = 1;
        }
        s[y * w + x] = v;
      }
    }
    return s;
  }

  /**
   * Gera uma imagem binária (dígitos pretos em fundo branco, com margem).
   * inverter=false: dígitos escuros sobre fundo claro (LCD comum).
   * inverter=true: dígitos claros sobre fundo escuro (LED / LCD retroiluminado).
   */
  function binarizar(base, { inverter, raioDilatacao, local }) {
    const { g, w, h } = base;
    let b = new Uint8Array(w * h);
    if (local) {
      // limiar local (média da vizinhança) — resiste a reflexo e sombra parciais
      const integral = new Float64Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) {
        let linha = 0;
        for (let x = 0; x < w; x++) {
          linha += g[y * w + x];
          integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + linha;
        }
      }
      const r = Math.max(4, Math.round(h / 6));
      const C = 6;
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
          const soma = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] -
            integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
          const media = soma / ((x1 - x0) * (y1 - y0));
          const v = g[y * w + x];
          b[y * w + x] = (inverter ? v > media + C : v < media - C) ? 1 : 0;
        }
      }
    } else {
      const t = otsu(g);
      for (let i = 0; i < g.length; i++) {
        const escuro = g[i] <= t;
        b[i] = (inverter ? !escuro : escuro) ? 1 : 0;
      }
    }
    removerBorda(b, w, h);
    const semDilatar = b;
    b = dilatar(b, w, h, raioDilatacao);
    const tinta = b.reduce((a, v) => a + v, 0) / b.length;

    const m = Math.round(h * 0.25);
    const c = canvasDe(w + 2 * m, h + 2 * m);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < b.length; i++) {
      const v = b[i] ? 0 : 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, m, m);
    return { canvas: c, tinta, bin: semDilatar, w, h };
  }

  // ---------------------------------------------------------------------
  // Decodificador de 7 segmentos
  //
  // A maioria dos torquímetros digitais usa visor de 7 segmentos, que o OCR
  // genérico lê mal (segmentos separados, dígitos inclinados). Aqui os
  // dígitos são localizados e cada um é classificado olhando quais dos 7
  // segmentos estão acesos.
  // ---------------------------------------------------------------------

  //            a  b  c  d  e  f  g
  const PADROES = [
    ['0', [1, 1, 1, 1, 1, 1, 0]],
    ['1', [0, 1, 1, 0, 0, 0, 0]],
    ['2', [1, 1, 0, 1, 1, 0, 1]],
    ['3', [1, 1, 1, 1, 0, 0, 1]],
    ['4', [0, 1, 1, 0, 0, 1, 1]],
    ['5', [1, 0, 1, 1, 0, 1, 1]],
    ['6', [1, 0, 1, 1, 1, 1, 1]],
    ['6', [0, 0, 1, 1, 1, 1, 1]],
    ['7', [1, 1, 1, 0, 0, 0, 0]],
    ['7', [1, 1, 1, 0, 0, 1, 0]],
    ['8', [1, 1, 1, 1, 1, 1, 1]],
    ['9', [1, 1, 1, 1, 0, 1, 1]],
    ['9', [1, 1, 1, 0, 0, 1, 1]],
  ];
  // regiões de amostragem (u0,u1,v0,v1) em coordenadas normalizadas da caixa do dígito
  const REGIOES = [
    [0.3, 0.7, 0.0, 0.14],   // a
    [0.72, 1.0, 0.16, 0.42], // b
    [0.72, 1.0, 0.58, 0.84], // c
    [0.3, 0.7, 0.86, 1.0],   // d
    [0.0, 0.28, 0.58, 0.84], // e
    [0.0, 0.28, 0.16, 0.42], // f
    [0.3, 0.7, 0.43, 0.57],  // g
  ];

  /** Endireita dígitos inclinados (itálico típico de visores LCD) com cisalhamento. */
  function desinclinar(b, w, h) {
    let melhor = { s: 0, nota: -1 };
    for (let s = -0.35; s <= 0.351; s += 0.05) {
      const off = Math.ceil(Math.abs(s) * h);
      const col = new Float64Array(w + off + 1);
      for (let y = 0; y < h; y++) {
        const dx = s * (y - h / 2);
        for (let x = 0; x < w; x++) if (b[y * w + x]) col[Math.round(x + dx + off / 2)]++;
      }
      let nota = 0;
      for (let i = 0; i < col.length; i++) nota += col[i] * col[i];
      if (nota > melhor.nota) melhor = { s, nota };
    }
    if (Math.abs(melhor.s) < 0.01) return { b, w, h };
    const off = Math.ceil(Math.abs(melhor.s) * h);
    const W = w + off + 1;
    const out = new Uint8Array(W * h);
    for (let y = 0; y < h; y++) {
      const dx = melhor.s * (y - h / 2);
      for (let x = 0; x < w; x++) if (b[y * w + x]) out[y * W + Math.round(x + dx + off / 2)] = 1;
    }
    return { b: out, w: W, h };
  }

  /** Componentes conexos (8-vizinhança) -> caixas {x0,y0,x1,y1,n}. */
  function componentes(b, w, h) {
    const rot = new Int32Array(w * h);
    const caixas = [];
    const pilha = [];
    for (let i = 0; i < b.length; i++) {
      if (!b[i] || rot[i]) continue;
      const cx = { x0: w, y0: h, x1: 0, y1: 0, n: 0 };
      rot[i] = caixas.length + 1;
      pilha.push(i);
      while (pilha.length) {
        const j = pilha.pop();
        const x = j % w, y = (j / w) | 0;
        cx.n++;
        if (x < cx.x0) cx.x0 = x;
        if (x > cx.x1) cx.x1 = x;
        if (y < cx.y0) cx.y0 = y;
        if (y > cx.y1) cx.y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const k = yy * w + xx;
            if (b[k] && !rot[k]) { rot[k] = caixas.length + 1; pilha.push(k); }
          }
        }
      }
      caixas.push(cx);
    }
    return caixas;
  }

  function dilatarRet(b, w, h, rx, ry) {
    // dilatação retangular separável
    const t = new Uint8Array(b.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -rx; k <= rx && !v; k++) { const xx = x + k; if (xx >= 0 && xx < w && b[y * w + xx]) v = 1; }
      t[y * w + x] = v;
    }
    const s = new Uint8Array(b.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -ry; k <= ry && !v; k++) { const yy = y + k; if (yy >= 0 && yy < h && t[yy * w + x]) v = 1; }
      s[y * w + x] = v;
    }
    return s;
  }

  function preenchimento(b, w, cx, r) {
    const bw = cx.x1 - cx.x0 + 1, bh = cx.y1 - cx.y0 + 1;
    const x0 = cx.x0 + Math.floor(r[0] * bw), x1 = cx.x0 + Math.ceil(r[1] * bw);
    const y0 = cx.y0 + Math.floor(r[2] * bh), y1 = cx.y0 + Math.ceil(r[3] * bh);
    let n = 0, t = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { t++; if (b[y * w + x]) n++; }
    return t ? n / t : 0;
  }

  function classificarDigito(b, w, cx, larguraTipica) {
    const bw = cx.x1 - cx.x0 + 1, bh = cx.y1 - cx.y0 + 1;
    if (bw < 0.45 * larguraTipica || bw / bh < 0.3) return { d: '1', conf: 0.9 };
    const f = REGIOES.map((r) => preenchimento(b, w, cx, r));
    const ref = Math.max(...f) || 1;
    const s = f.map((v) => Math.min(1, v / (0.7 * ref))); // normaliza pelo segmento mais cheio
    const custos = PADROES.map(([d, p]) => ({
      d, c: p.reduce((a, on, i) => a + (on ? 1 - s[i] : s[i]), 0),
    })).sort((a, b) => a.c - b.c);
    const melhor = custos[0];
    const segundo = custos.find((c) => c.d !== melhor.d);
    const margem = segundo ? segundo.c - melhor.c : 7;
    const conf = Math.max(0, Math.min(1, 1 - melhor.c / 3.5)) * Math.min(1, 0.4 + margem / 1.5);
    return { d: melhor.d, conf };
  }

  /** Lê um visor de 7 segmentos a partir da matriz binária (tinta=1). */
  function decodificar7seg(bin0, w0, h0, dbg) {
    const log = (m) => { if (dbg) dbg.push(m); };
    const { b, w, h } = desinclinar(bin0, w0, h0);

    // Componentes da tinta original: separa pontos decimais (bolinhas pequenas)
    const brutos = componentes(b, w, h);
    if (!brutos.length) return log('sem tinta'), null;
    // altura aproximada dos dígitos: maior altura após juntar segmentos verticalmente
    const grosso = componentes(dilatarRet(b, w, h, 0, Math.max(2, Math.round(h * 0.08))), w, h);
    const Hest = Math.max(...grosso.map((c) => c.y1 - c.y0 + 1));
    const ehPonto = (c) => {
      const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1;
      return ch <= 0.2 * Hest && cw <= 0.22 * Hest && ch >= 0.04 * Hest &&
        cw / ch > 0.5 && cw / ch < 2 && c.n > 0.5 * cw * ch;
    };
    const pontos = brutos.filter(ehPonto);
    const semPontos = b.slice();
    for (const c of pontos)
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) semPontos[y * w + x] = 0;

    // agrupa segmentos de cada dígito (junta bem mais na vertical que na horizontal)
    const g = dilatarRet(semPontos, w, h, Math.max(1, Math.round(Hest * 0.03)), Math.max(2, Math.round(Hest * 0.14)));
    const caixas = componentes(g, w, h).map((c) => {
      const r = { x0: w, y0: h, x1: 0, y1: 0, n: 0 };
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
        if (!semPontos[y * w + x]) continue;
        r.n++;
        if (x < r.x0) r.x0 = x;
        if (x > r.x1) r.x1 = x;
        if (y < r.y0) r.y0 = y;
        if (y > r.y1) r.y1 = y;
      }
      return r;
    }).filter((c) => c.n > 0);
    if (!caixas.length) return log('sem caixas'), null;

    const H = Math.max(...caixas.map((c) => c.y1 - c.y0 + 1));
    if (H < 12) return log('dígitos pequenos demais: H=' + H), null;
    let digitos = caixas.filter((c) => c.y1 - c.y0 + 1 >= 0.7 * H);
    const yMed = digitos.map((c) => (c.y0 + c.y1) / 2).sort((x, y) => x - y)[digitos.length >> 1];
    digitos = digitos.filter((c) => Math.abs((c.y0 + c.y1) / 2 - yMed) < 0.25 * H)
      .sort((x, y) => x.x0 - y.x0);
    log('H=' + H + ' caixas=' + JSON.stringify(digitos.map((c) => [c.x0, c.y0, c.x1, c.y1])));
    if (!digitos.length || digitos.length > 7) return log('qtd dígitos ' + digitos.length), null;
    const larguraTipica = Math.max(...digitos.map((c) => c.x1 - c.x0 + 1));
    if (larguraTipica / H > 0.95) return log('largo demais ' + (larguraTipica / H).toFixed(2)), null;

    const fundo = Math.max(...digitos.map((c) => c.y1));
    const pontosLinha = pontos.filter((c) => c.y1 > fundo - 0.25 * H && c.y0 < fundo + 0.1 * H);

    let texto = '';
    let somaConf = 0;
    digitos.forEach((c, i) => {
      const r = classificarDigito(semPontos, w, c, larguraTipica);
      texto += r.d;
      somaConf += r.conf;
      const prox = digitos[i + 1];
      if (prox && !texto.includes('.')) {
        const temPonto = pontosLinha.some((p) => {
          const px = (p.x0 + p.x1) / 2;
          return px > c.x1 - 0.25 * larguraTipica && px < prox.x0 + 0.25 * larguraTipica;
        });
        if (temPonto) texto += '.';
      }
    });
    log('texto=' + texto);
    if (!/^\d+(\.\d+)?$/.test(texto)) return null;
    return { texto, valor: parseFloat(texto), confianca: somaConf / digitos.length };
  }

  // ---------------------------------------------------------------------
  // Leitura do visor digital
  // ---------------------------------------------------------------------

  /**
   * Lê o número do recorte do visor (canvas). Testa visor escuro/claro e
   * limiar global/local; quando as variações discordam, a confiança cai e o
   * app pede outra foto em vez de arriscar um valor.
   */
  function lerDigital(recorte) {
    const base = cinzaRedimensionado(recorte, 140);
    const candidatos = [];
    for (const local of [false, true]) {
      for (const inverter of [false, true]) {
        const bin = binarizar(base, { inverter, raioDilatacao: 0, local });
        if (bin.tinta < 0.01 || bin.tinta > 0.6) continue;
        const r = decodificar7seg(bin.bin, bin.w, bin.h);
        if (r) candidatos.push(Object.assign(r, { imagem: bin.canvas }));
      }
    }
    // só candidatos razoáveis votam (os demais vêm de polaridade/limiar errados)
    const fortes = candidatos.filter((c) => c.confianca >= 0.5);
    if (!fortes.length) {
      return { valor: null, texto: '', confianca: 0, motor: 'digital', detalhes: { candidatos: [] } };
    }
    const placar = new Map();
    for (const c of fortes) {
      const p = placar.get(c.texto) || { soma: 0, votos: 0, melhor: c };
      p.soma += c.confianca;
      p.votos += 1;
      if (c.confianca > p.melhor.confianca) p.melhor = c;
      placar.set(c.texto, p);
    }
    const [texto, venc] = [...placar.entries()].sort((a, b) => b[1].soma - a[1].soma)[0];
    const consenso = venc.votos / fortes.length;
    return {
      valor: venc.melhor.valor,
      texto,
      confianca: Math.min(1, venc.melhor.confianca * (0.4 + 0.6 * consenso)),
      motor: 'digital',
      detalhes: {
        consenso,
        candidatos: fortes.map((c) => ({ texto: c.texto, confianca: +c.confianca.toFixed(2) })),
      },
    };
  }

  // ---------------------------------------------------------------------
  // Utilidades antifraude
  // ---------------------------------------------------------------------

  /**
   * Hash perceptual (dHash 16x16 = 256 bits) da foto, com a área do visor
   * apagada. Assim compara o *entorno* (peça, parafuso, carroceria), que muda
   * de um parafuso para outro, e não o visor, que é sempre parecido.
   */
  function hashPerceptual(foto, roi) {
    const W = 17, H = 16;
    const c = canvasDe(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const tmp = canvasDe(foto.width, foto.height);
    const tctx = tmp.getContext('2d');
    tctx.drawImage(foto, 0, 0);
    if (roi) {
      tctx.fillStyle = '#808080';
      tctx.fillRect(roi.x, roi.y, roi.w, roi.h);
    }
    ctx.drawImage(tmp, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const lum = (x, y) => {
      const i = (y * W + x) * 4;
      return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    };
    let bits = '';
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W - 1; x++) bits += lum(x, y) > lum(x + 1, y) ? '1' : '0';
    return bits;
  }

  function distanciaHamming(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
  }

  async function sha256(texto) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  window.LeitorTorque = {
    lerDigital,
    hashPerceptual,
    distanciaHamming,
    sha256,
    // expostos para testes
    _interno: { otsu, decodificar7seg },
  };
})();
