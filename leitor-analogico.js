/*
 * leitor-analogico.js — leitura de torquímetros ANALÓGICOS de relógio
 * (mostrador circular com ponteiro), só com visão computacional clássica.
 *
 * Etapas:
 *   1. Acha o mostrador: transformada de Hough para círculos, com votos
 *      guiados pela direção do gradiente (Sobel).
 *   2. Corrige a rotação da foto: compara o "perfil angular" da escala
 *      (traços e números ao redor do mostrador) com o perfil gravado na
 *      calibração, por correlação cruzada circular.
 *   3. Acha o(s) ponteiro(s): para cada ângulo, lança um raio do centro para
 *      fora e mede quanto do raio está coberto pela cor do ponteiro. O
 *      ponteiro é um traço contínuo, então cobre o raio quase inteiro;
 *      números e traços da escala cobrem só um pedaço.
 *   4. Converte o ângulo em valor com a calibração (ângulo do zero e do fim
 *      da escala, tocados pelo usuário numa foto de referência).
 *
 * Convenção de ângulo: graus no sentido horário a partir de "12 horas".
 */
(function () {
  'use strict';

  const BINS = 720;            // perfil angular com resolução de 0,5°
  const PASSO = 360 / BINS;
  const LADO = 360;            // a imagem é reduzida para 360 px antes de processar

  const mod = (a, n) => ((a % n) + n) % n;
  const rad = (g) => (g * Math.PI) / 180;

  // ---------------------------------------------------------------------
  // Imagem
  // ---------------------------------------------------------------------

  function preparar(canvas) {
    const esc = LADO / Math.max(canvas.width, canvas.height);
    const w = Math.round(canvas.width * esc), h = Math.round(canvas.height * esc);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n), L = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      R[j] = d[i]; G[j] = d[i + 1]; B[j] = d[i + 2];
      L[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return { w, h, R, G, B, L, escala: esc };
  }

  function amostrar(arr, w, h, x, y) {
    // bilinear
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    return arr[i] * (1 - fx) * (1 - fy) + arr[i + 1] * fx * (1 - fy) +
      arr[i + w] * (1 - fx) * fy + arr[i + w + 1] * fx * fy;
  }

  function ponto(c, angulo, raio) {
    return { x: c.x + Math.sin(rad(angulo)) * raio, y: c.y - Math.cos(rad(angulo)) * raio };
  }

  function otsu(valores) {
    const hist = new Float64Array(256);
    for (const v of valores) hist[Math.max(0, Math.min(255, v | 0))]++;
    let total = 0, soma = 0;
    for (let t = 0; t < 256; t++) { total += hist[t]; soma += t * hist[t]; }
    let somaB = 0, wB = 0, melhor = -1, limiar = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      somaB += t * hist[t];
      const mB = somaB / wB, mF = (soma - somaB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > melhor) { melhor = v; limiar = t; }
    }
    return limiar;
  }

  // ---------------------------------------------------------------------
  // 1. Detecção do mostrador (Hough de círculos)
  // ---------------------------------------------------------------------

  /**
   * @param img   imagem preparada
   * @param dica  { raioFrac } raio esperado como fração do lado maior
   * @returns { x, y, r, suporte } em pixels da imagem preparada
   */
  function detectarMostrador(img, dica) {
    const { w, h, L } = img;
    const n = w * h;
    // suaviza (box 3x3) e calcula gradiente de Sobel
    const S = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += L[(y + dy) * w + x + dx];
      S[y * w + x] = s / 9;
    }
    const GX = new Float32Array(n), GY = new Float32Array(n), M = new Float32Array(n);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const gx = S[i - w + 1] + 2 * S[i + 1] + S[i + w + 1] - S[i - w - 1] - 2 * S[i - 1] - S[i + w - 1];
      const gy = S[i + w - 1] + 2 * S[i + w] + S[i + w + 1] - S[i - w - 1] - 2 * S[i - w] - S[i - w + 1];
      GX[i] = gx; GY[i] = gy; M[i] = Math.hypot(gx, gy);
    }
    // bordas = 10% de maior gradiente
    const ord = Array.from(M).filter((v) => v > 0).sort((a, b) => a - b);
    const tBorda = Math.max(20, ord[Math.floor(ord.length * 0.9)] || 0);

    const lado = Math.max(w, h);
    const rEsp = (dica && dica.raioFrac ? dica.raioFrac : 0.36) * lado;
    const rMin = Math.max(10, Math.round(rEsp * 0.65)), rMax = Math.round(rEsp * 1.35);

    // votação do centro ao longo da direção do gradiente
    const acc = new Float32Array(n);
    const bordas = [];
    for (let i = 0; i < n; i++) {
      if (M[i] < tBorda) continue;
      const x = i % w, y = (i / w) | 0;
      bordas.push(i);
      const dx = GX[i] / M[i], dy = GY[i] / M[i];
      for (const s of [-1, 1]) {
        for (let r = rMin; r <= rMax; r++) {
          const cx = Math.round(x + s * dx * r), cy = Math.round(y + s * dy * r);
          if (cx < 0 || cy < 0 || cx >= w || cy >= h) break;
          acc[cy * w + cx] += 1;
        }
      }
    }
    // suaviza o acumulador (box 5x5) e pega o máximo perto do meio da imagem
    let melhor = { v: -1, x: w / 2, y: h / 2 };
    for (let y = Math.round(h * 0.2); y < h * 0.8; y++) for (let x = Math.round(w * 0.2); x < w * 0.8; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += acc[(y + dy) * w + x + dx];
      if (s > melhor.v) melhor = { v: s, x, y };
    }
    // refina o centro pela média ponderada da vizinhança
    let sx = 0, sy = 0, sw = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const v = acc[(melhor.y + dy) * w + melhor.x + dx] || 0;
      sx += v * (melhor.x + dx); sy += v * (melhor.y + dy); sw += v;
    }
    const cx = sw ? sx / sw : melhor.x, cy = sw ? sy / sw : melhor.y;

    // raio: histograma das distâncias das bordas cujo gradiente aponta para o centro
    const hist = new Float32Array(rMax + 3);
    for (const i of bordas) {
      const x = i % w, y = (i / w) | 0;
      const vx = x - cx, vy = y - cy, d = Math.hypot(vx, vy);
      if (d < rMin || d > rMax) continue;
      const alinh = Math.abs((vx * GX[i] + vy * GY[i]) / (d * M[i]));
      if (alinh > 0.85) hist[Math.round(d)] += M[i];
    }
    let rMelhor = 0, vMelhor = -1;
    for (let r = rMin; r <= rMax; r++) {
      const v = (hist[r - 1] + 2 * hist[r] + hist[r + 1]) * Math.exp(-(((r - rEsp) / (0.25 * rEsp)) ** 2));
      if (v > vMelhor) { vMelhor = v; rMelhor = r; }
    }
    // refina centro e raio com ajuste de círculo por mínimos quadrados (Kåsa)
    // usando só as bordas próximas do círculo escolhido e com gradiente radial
    let c = { x: cx, y: cy, r: rMelhor };
    for (const tol of [0.08, 0.04, 0.025]) {
      const ajuste = ajustarCirculo(bordas, w, GX, GY, M, c, tol);
      if (!ajuste) break;
      c = ajuste;
    }
    // suporte: em quantos setores de 5° existe borda nesse raio
    const setores = new Uint8Array(72);
    for (const i of bordas) {
      const x = i % w, y = (i / w) | 0;
      const d = Math.hypot(x - c.x, y - c.y);
      if (Math.abs(d - c.r) <= 2.5) {
        const a = mod(Math.atan2(x - c.x, -(y - c.y)) * 180 / Math.PI, 360);
        setores[Math.floor(a / 5)] = 1;
      }
    }
    const suporte = setores.reduce((a, v) => a + v, 0) / 72;
    return { x: c.x, y: c.y, r: c.r, suporte };
  }

  function ajustarCirculo(bordas, w, GX, GY, M, c, tol) {
    // somatórios para o sistema linear de x² + y² + D x + E y + F = 0
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0, n = 0;
    for (const i of bordas) {
      const x = i % w, y = (i / w) | 0;
      const vx = x - c.x, vy = y - c.y, d = Math.hypot(vx, vy);
      if (!d || Math.abs(d - c.r) > tol * c.r) continue;
      if (Math.abs((vx * GX[i] + vy * GY[i]) / (d * M[i])) < 0.85) continue;
      // coordenadas centradas para estabilidade numérica
      const X = vx, Y = vy, Z = X * X + Y * Y;
      Sx += X; Sy += Y; Sxx += X * X; Syy += Y * Y; Sxy += X * Y; Sz += Z; Sxz += X * Z; Syz += Y * Z; n++;
    }
    if (n < 30) return null;
    // [Sxx Sxy Sx][D]   [-Sxz]
    // [Sxy Syy Sy][E] = [-Syz]
    // [Sx  Sy  n ][F]   [-Sz ]
    const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
    const bv = [-Sxz, -Syz, -Sz];
    const sol = resolver3(A, bv);
    if (!sol) return null;
    const [D, E, F] = sol;
    const ox = -D / 2, oy = -E / 2;
    const r = Math.sqrt(ox * ox + oy * oy - F);
    if (!isFinite(r) || Math.hypot(ox, oy) > 0.25 * c.r) return null;
    return { x: c.x + ox, y: c.y + oy, r };
  }

  function resolver3(A, b) {
    const m = A.map((l, i) => [...l, b[i]]);
    for (let k = 0; k < 3; k++) {
      let p = k;
      for (let i = k + 1; i < 3; i++) if (Math.abs(m[i][k]) > Math.abs(m[p][k])) p = i;
      if (Math.abs(m[p][k]) < 1e-9) return null;
      [m[k], m[p]] = [m[p], m[k]];
      for (let i = k + 1; i < 3; i++) {
        const f = m[i][k] / m[k][k];
        for (let j = k; j < 4; j++) m[i][j] -= f * m[k][j];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let s2 = m[i][3];
      for (let j = i + 1; j < 3; j++) s2 -= m[i][j] * x[j];
      x[i] = s2 / m[i][i];
    }
    return x;
  }

  // ---------------------------------------------------------------------
  // 2. Perfil angular da escala e correção de rotação
  // ---------------------------------------------------------------------

  function perfilAngular(img, c, r0, r1) {
    const p = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      const a = b * PASSO;
      let s = 0, n = 0;
      for (let r = r0; r <= r1; r += 0.75) {
        const q = ponto(c, a, r);
        const v = amostrar(img.L, img.w, img.h, q.x, q.y);
        if (!isNaN(v)) { s += 255 - v; n++; }
      }
      p[b] = n ? s / n : 0;
    }
    // passa-alta: tira variações lentas (iluminação desigual), fica com traços e números
    const lento = suavizar(p, 15);
    return normalizar(Float32Array.from(p, (v, i) => v - lento[i]));
  }

  function normalizar(p) {
    let m = 0;
    for (const v of p) m += v;
    m /= p.length;
    let dp = 0;
    for (const v of p) dp += (v - m) * (v - m);
    dp = Math.sqrt(dp / p.length) || 1;
    return Float32Array.from(p, (v) => (v - m) / dp);
  }

  function suavizar(p, sigma) {
    const r = Math.ceil(sigma * 3);
    const k = [];
    for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
    const sk = k.reduce((a, v) => a + v, 0);
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += p[mod(i + j, p.length)] * k[j + r];
      out[i] = s / sk;
    }
    return out;
  }

  function correlacao(a, b, desloc) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[mod(i + desloc, b.length)];
    return s / a.length;
  }

  /**
   * Rotação (graus, horário) da foto atual em relação à de calibração.
   * Busca grossa no perfil suavizado e fina no perfil original.
   */
  function medirRotacao(ref, atual, maxGraus) {
    const lim = Math.round((maxGraus || 30) / PASSO);
    const rs = suavizar(normalizar(ref), 4), as = suavizar(atual, 4);
    let k0 = 0, c0 = -Infinity;
    for (let k = -lim; k <= lim; k++) {
      const c = correlacao(rs, as, k);
      if (c > c0) { c0 = c; k0 = k; }
    }
    const rn = normalizar(ref);
    let k1 = k0, c1 = -Infinity;
    const cs = {};
    for (let k = k0 - 6; k <= k0 + 6; k++) {
      const c = correlacao(rn, atual, k);
      cs[k] = c;
      if (c > c1) { c1 = c; k1 = k; }
    }
    // interpolação parabólica para precisão abaixo de 0,5°
    const ca = cs[k1 - 1], cb = cs[k1 + 1];
    let frac = 0;
    if (ca != null && cb != null) {
      const den = ca - 2 * c1 + cb;
      if (den < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (ca - cb) / den));
    }
    return { graus: (k1 + frac) * PASSO, qualidade: Math.max(c0, c1) };
  }

  // ---------------------------------------------------------------------
  // 3. Ponteiros
  // ---------------------------------------------------------------------

  /** "Cor de ponteiro" de cada pixel (0..255) conforme o tipo configurado. */
  function mapaPonteiro(img, cor) {
    const { R, G, B, L } = img;
    const f = new Float32Array(L.length);
    for (let i = 0; i < f.length; i++) {
      if (cor === 'vermelho') {
        const v = R[i] - Math.max(G[i], B[i]);
        f[i] = v > 0 && R[i] > 70 ? Math.min(255, v * 2) : 0;
      } else if (cor === 'claro') {
        f[i] = L[i];
      } else { // escuro
        f[i] = 255 - L[i];
      }
    }
    return f;
  }

  /**
   * Cobertura de cada ângulo pelo ponteiro, entre os raios r0 e r1.
   * Devolve os picos (candidatos a ponteiro) com ângulo refinado.
   */
  function detectarPonteiros(img, c, cor, r0, r1) {
    const f = mapaPonteiro(img, cor);
    // limiar pelo método de Otsu sobre o miolo do mostrador
    const amostras = [];
    for (let y = Math.max(0, Math.floor(c.y - r1)); y < Math.min(img.h, c.y + r1); y += 2) {
      for (let x = Math.max(0, Math.floor(c.x - r1)); x < Math.min(img.w, c.x + r1); x += 2) {
        if (Math.hypot(x - c.x, y - c.y) <= r1) amostras.push(f[y * img.w + x]);
      }
    }
    let limiar = otsu(amostras);
    if (cor === 'vermelho') limiar = Math.max(limiar, 60);

    const cob = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      const a = b * PASSO;
      let n = 0, sim = 0;
      for (let r = r0; r <= r1; r += 1) {
        const q = ponto(c, a, r);
        const v = amostrar(f, img.w, img.h, q.x, q.y);
        if (isNaN(v)) continue;
        n++;
        if (v > limiar) sim++;
      }
      cob[b] = n ? sim / n : 0;
    }
    const s = suavizar(cob, 1);
    const picos = [];
    for (let b = 0; b < BINS; b++) {
      const v = s[b];
      if (v < 0.5) continue;
      let max = true;
      for (let k = 1; k <= 16 && max; k++) {
        if (s[mod(b + k, BINS)] > v || s[mod(b - k, BINS)] > v) max = false;
      }
      if (!max) continue;
      // ângulo refinado: centróide da região do pico acima de 60% dele
      let sa = 0, sw = 0;
      for (let k = -12; k <= 12; k++) {
        const vv = s[mod(b + k, BINS)];
        if (vv >= 0.6 * v) { sa += (b + k) * vv; sw += vv; }
      }
      picos.push({ angulo: mod((sa / sw) * PASSO, 360), cobertura: v });
    }
    // remove picos duplicados (platôs)
    picos.sort((p, q) => q.cobertura - p.cobertura);
    const unicos = [];
    for (const p of picos) {
      if (!unicos.some((u) => Math.abs(mod(u.angulo - p.angulo + 180, 360) - 180) < 6)) unicos.push(p);
    }
    return { picos: unicos, limiar };
  }

  // ---------------------------------------------------------------------
  // 4. Ângulo -> valor
  // ---------------------------------------------------------------------

  function varredura(perfil) {
    const v = mod(perfil.anguloFim - perfil.anguloZero, 360);
    return v === 0 ? 360 : v;
  }

  function anguloParaValor(angulo, perfil) {
    const sw = varredura(perfil);
    let d = mod(angulo - perfil.anguloZero, 360);
    const folga = Math.min(8, (360 - sw) / 2);
    if (d > 360 - folga) d -= 360;              // um pouco antes do zero
    if (d > sw + folga) return null;            // na faixa morta do mostrador
    return perfil.valorZero + (d / sw) * (perfil.valorFim - perfil.valorZero);
  }

  function arredondar(valor, divisao) {
    const passo = (divisao || 1) / 5;
    const casas = Math.max(0, Math.min(3, Math.ceil(-Math.log10(passo))));
    const v = Math.round(valor / passo) * passo;
    return { valor: +v.toFixed(casas), texto: v.toFixed(casas) };
  }

  // ---------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------

  /**
   * Calibração: a partir da foto do mostrador e dos toques do usuário no
   * traço do zero e no traço do fim da escala (coordenadas do canvas
   * original), monta o perfil do torquímetro.
   */
  function calibrar(canvas, toqueZero, toqueFim, dados) {
    const img = preparar(canvas);
    const circ = detectarMostrador(img, { raioFrac: 0.36 });
    if (circ.suporte < 0.4) throw new Error('Não encontrei o mostrador redondo. Enquadre-o no círculo e tente de novo.');
    const conv = (t) => ({ x: t.x * img.escala, y: t.y * img.escala });
    const z = conv(toqueZero), f = conv(toqueFim);
    const ang = (p) => mod(Math.atan2(p.x - circ.x, -(p.y - circ.y)) * 180 / Math.PI, 360);
    const raioEscala = (Math.hypot(z.x - circ.x, z.y - circ.y) + Math.hypot(f.x - circ.x, f.y - circ.y)) / 2 / circ.r;
    if (raioEscala < 0.4 || raioEscala > 1.15) throw new Error('Toque exatamente nos traços da escala, na borda do mostrador.');
    const perfil = Object.assign({}, dados, {
      anguloZero: +ang(z).toFixed(2),
      anguloFim: +ang(f).toFixed(2),
      raioFrac: circ.r / Math.max(img.w, img.h),
      raioEscala: +raioEscala.toFixed(3),
    });
    const c = { x: circ.x, y: circ.y };
    const r0 = Math.max(0.35, raioEscala - 0.14) * circ.r, r1 = Math.min(1.0, raioEscala + 0.06) * circ.r;
    perfil.perfilAngular = Array.from(perfilAngular(img, c, r0, r1), (v) => Math.round(v * 100) / 100);
    return { perfil, circulo: { x: circ.x / img.escala, y: circ.y / img.escala, r: circ.r / img.escala, suporte: circ.suporte } };
  }

  /** Só detecta o mostrador (para desenhar na tela de calibração). */
  function localizarMostrador(canvas) {
    const img = preparar(canvas);
    const c = detectarMostrador(img, { raioFrac: 0.36 });
    return { x: c.x / img.escala, y: c.y / img.escala, r: c.r / img.escala, suporte: c.suporte };
  }

  /** Lê o valor indicado pelo ponteiro, usando o perfil calibrado. */
  function lerAnalogico(canvas, perfil) {
    const img = preparar(canvas);
    const circ = detectarMostrador(img, { raioFrac: perfil.raioFrac });
    const falha = (motivo, extra) => ({
      valor: null, texto: '', confianca: 0, motor: 'analogico',
      detalhes: Object.assign({ motivo, circulo: circ }, extra || {}),
    });
    if (circ.suporte < 0.4) return falha('mostrador não encontrado');

    const c = { x: circ.x, y: circ.y };
    const re = perfil.raioEscala || 0.85;
    const ref = Float32Array.from(perfil.perfilAngular);
    // O raio detectado pode ser o do aro ou o da face; procura a escala que melhor
    // casa com a calibração junto com a rotação.
    let rot = { qualidade: -Infinity }, rEsc = circ.r;
    for (let f = 0.8; f <= 1.201; f += 0.025) {
      const rr = circ.r * f;
      const r0 = Math.max(0.35, re - 0.14) * rr, r1 = Math.min(1.0, re + 0.06) * rr;
      const m = medirRotacao(ref, perfilAngular(img, c, r0, r1), 30);
      if (m.qualidade > rot.qualidade) { rot = m; rEsc = rr; }
    }
    if (rot.qualidade < 0.35) return falha('escala não reconhecida (posição muito diferente da calibração)', { rotacao: rot });

    // ponteiro: do miolo (fora do eixo e do contrapeso) até antes dos traços da escala
    const p = detectarPonteiros(img, c, perfil.corPonteiro || 'vermelho',
      0.3 * rEsc, Math.max(0.5, re - 0.12) * rEsc);
    const leituras = p.picos.map((pk) => {
      const anguloCal = mod(pk.angulo - rot.graus, 360);
      return { angulo: anguloCal, cobertura: pk.cobertura, valor: anguloParaValor(anguloCal, perfil) };
    }).filter((l) => l.valor != null);
    if (!leituras.length) return falha('ponteiro não encontrado', { rotacao: rot });

    let escolhida;
    if (perfil.usarMaiorValor) {
      // ponteiro de arraste/memória: fica parado no maior valor atingido
      escolhida = leituras.filter((l) => l.cobertura >= 0.6).sort((a, b) => b.valor - a.valor)[0] ||
        leituras.sort((a, b) => b.cobertura - a.cobertura)[0];
    } else {
      escolhida = leituras.sort((a, b) => b.cobertura - a.cobertura)[0];
    }
    const outras = leituras.filter((l) => l !== escolhida);
    // Perto do zero, o ponteiro de arraste fica sobre o ponteiro principal (que volta
    // ao zero) e os dois se confundem: leitura não confiável.
    const sw = varredura(perfil);
    const pertoDoZero = perfil.usarMaiorValor && (perfil.corPonteiro || 'vermelho') !== 'vermelho' &&
      mod(escolhida.angulo - perfil.anguloZero, 360) < Math.max(10, sw * 0.04);
    const r = arredondar(escolhida.valor, perfil.menorDivisao);

    // confiança: mostrador bem definido, escala reconhecida, ponteiro nítido e sem ambiguidade
    const cCirc = Math.min(1, circ.suporte / 0.75);
    const cRot = Math.max(0, Math.min(1, (rot.qualidade - 0.35) / 0.35));
    const cPont = Math.max(0, Math.min(1, (escolhida.cobertura - 0.5) / 0.35));
    let cAmb = 1;
    if (!perfil.usarMaiorValor && outras.length) {
      cAmb = Math.max(0, Math.min(1, (escolhida.cobertura - outras[0].cobertura) / 0.25));
    }
    let confianca = Math.min(cCirc, cRot, cPont, cAmb) * 0.3 + (cCirc * cRot * cPont * cAmb) ** 0.25 * 0.7;
    if (pertoDoZero) confianca = Math.min(confianca, 0.5);

    return {
      valor: r.valor,
      texto: r.texto,
      confianca: +confianca.toFixed(3),
      motor: 'analogico',
      detalhes: {
        circulo: { x: circ.x / img.escala, y: circ.y / img.escala, r: circ.r / img.escala, suporte: +circ.suporte.toFixed(2) },
        rotacao: { graus: +rot.graus.toFixed(2), qualidade: +rot.qualidade.toFixed(2) },
        angulo: +escolhida.angulo.toFixed(2),
        cobertura: +escolhida.cobertura.toFixed(2),
        pertoDoZero,
        outrosPonteiros: outras.map((o) => ({ valor: +o.valor.toFixed(2), cobertura: +o.cobertura.toFixed(2) })),
      },
    };
  }

  window.LeitorAnalogico = {
    calibrar,
    localizarMostrador,
    lerAnalogico,
    _interno: { preparar, detectarMostrador, perfilAngular, medirRotacao, detectarPonteiros, anguloParaValor },
  };
})();
