/*
 * BGMMix DSP core
 * Shared by the analysis/separation worker, the page and the Node tests.
 * Pure JavaScript, no dependencies. Everything here is deterministic.
 */
(function (root) {
  "use strict";

  /* ---------- FFT ---------- */
  const fftCache = new Map();
  function fftPlan(n) {
    let p = fftCache.get(n);
    if (p) return p;
    const levels = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, y = 0;
      for (let j = 0; j < levels; j++) { y = (y << 1) | (x & 1); x >>>= 1; }
      rev[i] = y;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    p = { rev, cos, sin };
    fftCache.set(n, p);
    return p;
  }

  /** In-place complex FFT. inverse=true gives the unscaled inverse (result × n). */
  function fft(re, im, inverse) {
    const n = re.length, p = fftPlan(n), rev = p.rev, cs = p.cos, sn = p.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cs[k], wi = sgn * sn[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
  }

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / Math.sqrt(da * db + 1e-12);
  }

  /* ---------- Analyzer ---------- */
  /**
   * analyze(mono Float32Array, sampleRate) -> musical DNA.
   * Expects ~22.05 kHz mono for speed, works at any rate.
   */
  function analyze(x, sr) {
    const duration = x.length / sr;
    const N = 1024, H = 256, nb = N / 2 + 1, win = hann(N);
    const frames = Math.max(1, Math.floor((x.length - N) / H) + 1);
    const re = new Float64Array(N), im = new Float64Array(N);
    let prev = new Float64Array(nb);
    const flux = new Float32Array(frames), fluxLow = new Float32Array(frames), rmsF = new Float32Array(frames), cent = new Float32Array(frames);

    for (let t = 0; t < frames; t++) {
      const off = t * H;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const s = off + i < x.length ? x[off + i] : 0;
        e += s * s; re[i] = s * win[i]; im[i] = 0;
      }
      rmsF[t] = Math.sqrt(e / N);
      fft(re, im, false);
      let f = 0, fl = 0, num = 0, den = 0;
      const lowK = Math.ceil(220 * N / sr);
      for (let k = 0; k < nb; k++) {
        const m = Math.hypot(re[k], im[k]);
        const c = Math.log1p(100 * m);
        const d = c - prev[k];
        if (d > 0) { f += d; if (k <= lowK) fl += d; }
        prev[k] = c;
        num += k * m; den += m;
      }
      flux[t] = t === 0 ? 0 : f;
      fluxLow[t] = t === 0 ? 0 : fl;
      cent[t] = den > 0 ? (num / den) * sr / N : 0;
    }

    // onset envelope: broadband + low-band (kick) flux, minus local mean, half-wave rectified
    let mF = 0, mL = 0;
    for (let t = 0; t < frames; t++) { mF += flux[t]; mL += fluxLow[t]; }
    mF = mF / frames + 1e-9; mL = mL / frames + 1e-9;
    for (let t = 0; t < frames; t++) flux[t] = flux[t] / mF + 1.5 * fluxLow[t] / mL;
    const fr = sr / H;
    const env = new Float32Array(frames);
    const avgR = Math.max(1, Math.round(0.2 * fr));
    let acc = 0, cnt = 0;
    for (let i = 0; i < Math.min(frames, avgR); i++) { acc += flux[i]; cnt++; }
    for (let t = 0; t < frames; t++) {
      const add = t + avgR, rem = t - avgR - 1;
      if (add < frames) { acc += flux[add]; cnt++; }
      if (rem >= 0) { acc -= flux[rem]; cnt--; }
      const v = flux[t] - acc / cnt;
      env[t] = v > 0 ? v : 0;
    }

    // tempo by autocorrelation with a soft prior around 115 BPM
    const minLag = Math.max(2, Math.floor(fr * 60 / 200));
    const maxLag = Math.ceil(fr * 60 / 55);
    const acLen = Math.min(frames - 1, maxLag * 2 + 2);
    const ac = new Float64Array(acLen + 1);
    for (let l = minLag; l <= acLen; l++) {
      let s = 0;
      for (let i = 0; i + l < frames; i++) s += env[i] * env[i + l];
      ac[l] = s / Math.max(1, frames - l);
    }
    let best = minLag, bestScore = -1, sumScore = 0, nScore = 0;
    const score = new Float64Array(maxLag + 2);
    for (let l = minLag; l <= Math.min(maxLag, acLen); l++) {
      const bpm = 60 * fr / l;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.85, 2));
      const s = w * (ac[l] + (2 * l <= acLen ? 0.5 * ac[2 * l] : 0));
      score[l] = s; sumScore += s; nScore++;
      if (s > bestScore) { bestScore = s; best = l; }
    }
    let lagF = best;
    if (best > minLag && best < maxLag) {
      const a = score[best - 1], b = score[best], c = score[best + 1];
      const d = a - 2 * b + c;
      if (d < 0) lagF = best + 0.5 * (a - c) / d;
    }
    let bpm = 60 * fr / lagF;
    if (!isFinite(bpm) || bpm <= 0) bpm = 120;
    while (bpm < 66) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    // octave check: if every other pulse is clearly stronger, the beat is twice as long
    if (bpm / 2 >= 66) {
      const P1 = 60 * fr / bpm, P2 = 2 * P1;
      const pulse = (ph, per) => { let s = 0, n = 0; for (let k = 0; ; k++) { const i = Math.round(ph + k * per); if (i >= frames) break; s += env[i]; n++; } return s / Math.max(1, n); };
      let bp = 0, bs = -1;
      for (let ph = 0; ph < P2; ph++) { const s = pulse(ph, P2); if (s > bs) { bs = s; bp = ph; } }
      const odd = pulse(bp + P1, P2);
      if (bs > 1.6 * odd) bpm /= 2;
    }
    const tempoConfidence = clamp((bestScore / (sumScore / Math.max(1, nScore) + 1e-12) - 1) / 3, 0, 1);

    // beat phase
    const P = 60 * fr / bpm;
    let bestPhase = 0, bestPhaseScore = -1;
    for (let ph = 0; ph < P; ph++) {
      let s = 0;
      for (let k = 0; ; k++) {
        const idx = Math.round(ph + k * P);
        if (idx >= frames) break;
        s += env[idx];
      }
      if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = ph; }
    }
    const firstBeat = (bestPhase * H + N / 2) / sr;

    // key via chroma + Krumhansl-Schmuckler
    const N2 = sr > 30000 ? 16384 : 8192, H2 = N2 / 2, win2 = hann(N2);
    const re2 = new Float64Array(N2), im2 = new Float64Array(N2);
    const chroma = new Float64Array(12);
    const pcOf = new Int8Array(N2 / 2 + 1).fill(-1);
    for (let k = 1; k <= N2 / 2; k++) {
      const f = k * sr / N2;
      if (f < 60 || f > 2100) continue;
      const midi = 69 + 12 * Math.log2(f / 440);
      pcOf[k] = ((Math.round(midi) % 12) + 12) % 12;
    }
    const frames2 = Math.max(1, Math.floor((x.length - N2) / H2) + 1);
    const fc = new Float64Array(12);
    for (let t = 0; t < frames2; t++) {
      const off = t * H2;
      for (let i = 0; i < N2; i++) { const s = off + i < x.length ? x[off + i] : 0; re2[i] = s * win2[i]; im2[i] = 0; }
      fft(re2, im2, false);
      fc.fill(0);
      let tot = 0;
      for (let k = 1; k <= N2 / 2; k++) {
        const pc = pcOf[k];
        if (pc < 0) continue;
        const m = Math.hypot(re2[k], im2[k]);
        fc[pc] += m; tot += m;
      }
      if (tot <= 1e-9) continue;
      const wgt = Math.sqrt(tot);
      for (let i = 0; i < 12; i++) chroma[i] += wgt * fc[i] / tot;
    }
    let keyIdx = 0, mode = "minor", keyR = -2;
    const rot = new Float64Array(12);
    for (let k = 0; k < 12; k++) {
      for (const [prof, md] of [[MAJOR, "major"], [MINOR, "minor"]]) {
        for (let i = 0; i < 12; i++) rot[i] = prof[(i - k + 12) % 12];
        const r = pearson(chroma, rot);
        if (r > keyR) { keyR = r; keyIdx = k; mode = md; }
      }
    }

    // loudness, brightness, density
    let sq = 0, peak = 0;
    for (let i = 0; i < x.length; i++) { const a = x[i]; sq += a * a; const b = a < 0 ? -a : a; if (b > peak) peak = b; }
    const rms = Math.sqrt(sq / Math.max(1, x.length));
    const loudnessDb = 20 * Math.log10(rms + 1e-9);
    let cw = 0, cs = 0;
    for (let t = 0; t < frames; t++) { cw += rmsF[t]; cs += rmsF[t] * cent[t]; }
    const centroid = cw > 0 ? cs / cw : 0;
    let envMean = 0;
    for (let t = 0; t < frames; t++) envMean += env[t];
    envMean /= frames;
    let onsets = 0;
    for (let t = 1; t < frames - 1; t++) if (env[t] > envMean * 2.5 && env[t] >= env[t - 1] && env[t] > env[t + 1]) onsets++;
    const density = onsets / Math.max(0.5, duration);

    const energy = Math.round(100 * (
      0.45 * clamp((loudnessDb + 32) / 22, 0, 1) +
      0.25 * clamp((density - 0.5) / 4.5, 0, 1) +
      0.15 * clamp((centroid - 700) / 2600, 0, 1) +
      0.15 * clamp((bpm - 70) / 80, 0, 1)));

    const moods = [];
    const push = (m) => { if (moods.length < 3 && !moods.includes(m)) moods.push(m); };
    if (mode === "minor") push(energy < 48 ? "MELANCHOLIC" : "DRAMATIC"); else push(energy < 48 ? "WARM" : "BRIGHT");
    if (energy >= 68) push("DRIVING");
    if (energy < 36) push("CALM");
    if (bpm < 88) push("LAID-BACK");
    if (bpm > 118) push("UPBEAT");
    if (centroid < 1300) push("DUSKY");
    if (centroid > 2600) push("AIRY");
    if (moods.length < 3) push(mode === "minor" ? "INTIMATE" : "OPEN");

    // structure: per-phrase (4 bars) energy levels
    const barDur = 240 / bpm;
    const sections = [];
    const phraseDur = barDur * 4;
    const phrases = [];
    let tStart = 0;
    let firstEdge = firstBeat % barDur;
    if (firstEdge > 0.25 * barDur) phrases.push([0, firstEdge]);
    for (let s = firstEdge; s < duration - 0.5; s += phraseDur) phrases.push([s, Math.min(duration, s + phraseDur)]);
    if (!phrases.length) phrases.push([0, duration]);
    phrases[0][0] = 0;
    phrases[phrases.length - 1][1] = duration;
    const pe = phrases.map(([a, b]) => {
      const fa = Math.floor(a * fr), fb = Math.max(fa + 1, Math.floor(b * fr));
      let s = 0, n = 0;
      for (let t = fa; t < Math.min(fb, frames); t++) { s += rmsF[t] * rmsF[t]; n++; }
      return Math.sqrt(s / Math.max(1, n));
    });
    const maxE = Math.max(...pe, 1e-9);
    const levels = pe.map((e) => { const r = e / maxE; return r < 0.6 ? 0 : r < 0.84 ? 1 : 2; });
    for (let i = 0; i < phrases.length; i++) {
      const last = sections[sections.length - 1];
      if (last && last.level === levels[i]) last.end = phrases[i][1];
      else sections.push({ start: phrases[i][0], end: phrases[i][1], level: levels[i] });
    }
    // absorb fragments shorter than one bar
    for (let i = sections.length - 1; i > 0; i--) {
      if (sections[i].end - sections[i].start < barDur * 0.9) { sections[i - 1].end = sections[i].end; sections.splice(i, 1); }
    }
    sections.forEach((s, i) => {
      if (i === 0 && s.level < 2 && sections.length > 1) s.label = "INTRO";
      else if (i === sections.length - 1 && s.level === 0 && sections.length > 1) s.label = "OUTRO";
      else s.label = s.level === 2 ? "CHORUS" : s.level === 1 ? "VERSE" : "BREAK";
    });
    void tStart;

    return {
      duration, sampleRate: sr,
      bpm: Math.round(bpm * 10) / 10, tempoConfidence: Math.round(tempoConfidence * 100) / 100,
      firstBeat: Math.round(firstBeat * 1000) / 1000,
      key: KEYS[keyIdx], keyIndex: keyIdx, mode, keyConfidence: Math.round(clamp(keyR, 0, 1) * 100) / 100,
      chroma: Array.from(chroma, (v) => Math.round(v * 1000) / 1000),
      loudnessDb: Math.round(loudnessDb * 10) / 10, peakDb: Math.round(20 * Math.log10(peak + 1e-9) * 10) / 10,
      centroid: Math.round(centroid), onsetDensity: Math.round(density * 100) / 100,
      energy, moods, sections,
    };
  }

  /* ---------- sliding median ---------- */
  function slidingMedian(series, W, out) {
    const n = series.length, r = W >> 1;
    const win = new Float64Array(W);
    let size = 0;
    const get = (i) => series[i < 0 ? 0 : i >= n ? n - 1 : i];
    function lowerBound(v) { let lo = 0, hi = size; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } return lo; }
    function insert(v) { const p = lowerBound(v); for (let i = size; i > p; i--) win[i] = win[i - 1]; win[p] = v; size++; }
    function remove(v) { let p = lowerBound(v); if (p >= size) p = size - 1; for (let i = p; i < size - 1; i++) win[i] = win[i + 1]; size--; }
    for (let i = -r; i <= r; i++) insert(get(i));
    for (let t = 0; t < n; t++) {
      out[t] = win[r];
      if (t + 1 < n) { remove(get(t - r)); insert(get(t + r + 1)); }
    }
    return out;
  }

  /* ---------- stem separation ---------- */
  const STEM_NAMES = ["vocals", "drums", "bass", "other"];

  /**
   * Lightweight 4-stem separation.
   * Harmonic/percussive split by median filtering, low band for bass,
   * centre-panned harmonic content in the voice band for vocals.
   * The four soft masks sum to 1, so the stems always add back up to the input.
   */
  function separate(L, R, sr, onProgress) {
    const N = sr > 30000 ? 2048 : 1024, H = N / 4, nb = N / 2 + 1;
    const len = L.length;
    const lead = N - H;
    const frames = Math.ceil((len + lead) / H);
    const win = hann(N);

    // mono detection
    let dd = 0, ss = 0;
    for (let i = 0; i < len; i += 7) { const d = L[i] - R[i]; dd += d * d; ss += L[i] * L[i] + R[i] * R[i]; }
    const mono = dd < ss * 1e-4;

    const re = new Float64Array(N), im = new Float64Array(N);
    function frameSpectrum(t) {
      const start = t * H - lead;
      for (let i = 0; i < N; i++) {
        const p = start + i;
        if (p >= 0 && p < len) { re[i] = L[p] * win[i]; im[i] = R[p] * win[i]; } else { re[i] = 0; im[i] = 0; }
      }
      fft(re, im, false);
    }

    // pass 1: magnitudes
    const X = new Float32Array(frames * nb);
    for (let t = 0; t < frames; t++) {
      frameSpectrum(t);
      const row = t * nb;
      for (let k = 0; k < nb; k++) {
        const j = (N - k) % N;
        const lr = 0.5 * (re[k] + re[j]), li = 0.5 * (im[k] - im[j]);
        const rr = 0.5 * (im[k] + im[j]), ri = -0.5 * (re[k] - re[j]);
        X[row + k] = 0.5 * (Math.hypot(lr, li) + Math.hypot(rr, ri));
      }
      if (onProgress && t % 400 === 0) onProgress(0.3 * t / frames);
    }

    // harmonic estimate: median across time per bin
    const Hm = new Float32Array(frames * nb);
    const series = new Float32Array(frames), med = new Float32Array(frames);
    for (let k = 0; k < nb; k++) {
      for (let t = 0; t < frames; t++) series[t] = X[t * nb + k];
      slidingMedian(series, 17, med);
      for (let t = 0; t < frames; t++) Hm[t * nb + k] = med[t];
      if (onProgress && k % 64 === 0) onProgress(0.3 + 0.25 * k / nb);
    }

    const bassW = new Float64Array(nb), vocB = new Float64Array(nb);
    for (let k = 0; k < nb; k++) {
      const f = k * sr / N;
      bassW[k] = f <= 110 ? 1 : f >= 260 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * (f - 110) / 150);
      vocB[k] = f < 140 ? 0 : f < 260 ? (f - 140) / 120 : f <= 6500 ? 1 : f >= 12000 ? 0.25 : 1 - 0.75 * (f - 6500) / 5500;
    }

    const out = {};
    for (const s of STEM_NAMES) out[s] = [new Float32Array(len), new Float32Array(len)];
    const outs = STEM_NAMES.map((s) => out[s]);
    const masks = [new Float64Array(nb), new Float64Array(nb), new Float64Array(nb), new Float64Array(nb)];
    const Lr = new Float64Array(nb), Li = new Float64Array(nb), Rr = new Float64Array(nb), Ri = new Float64Array(nb);
    const rowP = new Float32Array(nb), rowX = new Float32Array(nb);
    const zr = new Float64Array(N), zi = new Float64Array(N);
    const norm = 1 / (N * 1.5);

    for (let t = 0; t < frames; t++) {
      frameSpectrum(t);
      const row = t * nb;
      for (let k = 0; k < nb; k++) {
        const j = (N - k) % N;
        Lr[k] = 0.5 * (re[k] + re[j]); Li[k] = 0.5 * (im[k] - im[j]);
        Rr[k] = 0.5 * (im[k] + im[j]); Ri[k] = -0.5 * (re[k] - re[j]);
        rowX[k] = X[row + k];
      }
      slidingMedian(rowX, 17, rowP);
      for (let k = 0; k < nb; k++) {
        const h = Hm[row + k], p = rowP[k];
        const h2 = h * h, p2 = p * p;
        const mh = h2 / (h2 + p2 + 1e-18);
        let cw;
        if (mono) cw = 0.6;
        else {
          const pl = Lr[k] * Lr[k] + Li[k] * Li[k], pr = Rr[k] * Rr[k] + Ri[k] * Ri[k];
          let s = 2 * (Lr[k] * Rr[k] + Li[k] * Ri[k]) / (pl + pr + 1e-18);
          if (s < 0) s = 0;
          const s2 = s * s;
          cw = s2 * s2 * s2;
        }
        const mb = mh * bassW[k];
        const mv = mh * (1 - bassW[k]) * vocB[k] * cw;
        const md = 1 - mh;
        masks[0][k] = mv; masks[1][k] = md; masks[2][k] = mb;
        masks[3][k] = Math.max(0, 1 - mv - md - mb);
      }
      const start = t * H - lead;
      for (let s = 0; s < 4; s++) {
        const m = masks[s];
        // pack stem L (real) + i * stem R (real) into one inverse FFT
        for (let k = 0; k < nb; k++) {
          const ar = m[k] * Lr[k], ai = m[k] * Li[k], br = m[k] * Rr[k], bi = m[k] * Ri[k];
          zr[k] = ar - bi; zi[k] = ai + br;
          if (k > 0 && k < N / 2) { zr[N - k] = ar + bi; zi[N - k] = -ai + br; }
        }
        fft(zr, zi, true);
        const oL = outs[s][0], oR = outs[s][1];
        for (let i = 0; i < N; i++) {
          const pos = start + i;
          if (pos < 0 || pos >= len) continue;
          const w = win[i] * norm;
          oL[pos] += zr[i] * w; oR[pos] += zi[i] * w;
        }
      }
      if (onProgress && t % 200 === 0) onProgress(0.55 + 0.45 * t / frames);
    }
    if (onProgress) onProgress(1);
    out.mono = mono;
    return out;
  }

  /* ---------- WSOLA time stretch (pitch preserving) ---------- */
  /** Plan output frame positions from a guide signal; ratio > 1 is faster. */
  function wsolaPlan(guide, ratio, sr) {
    let N = Math.round(0.05 * sr); if (N % 2) N++;
    const Hs = N / 2, tol = Math.round(0.012 * sr);
    const len = guide.length;
    const outLen = Math.floor(len / ratio);
    const nFrames = Math.ceil(outLen / Hs) + 1;
    const pos = new Int32Array(nFrames);
    const maxPos = Math.max(0, len - N - 1);
    let prev = 0;
    const corr = (a, b, step) => {
      let s = 0, e = 0;
      for (let i = 0; i < N; i += step) { const v = guide[b + i]; s += guide[a + i] * v; e += v * v; }
      return s / Math.sqrt(e + 1e-9);
    };
    for (let k = 1; k < nFrames; k++) {
      const nominal = Math.round(k * Hs * ratio);
      const natural = Math.min(maxPos, prev + Hs);
      let bestD = 0, bestC = -Infinity;
      const lo = Math.max(-tol, -nominal), hi = Math.min(tol, maxPos - nominal);
      if (hi < lo) { pos[k] = clamp(nominal, 0, maxPos); prev = pos[k]; continue; }
      for (let d = lo; d <= hi; d += 4) { const c = corr(natural, nominal + d, 4); if (c > bestC) { bestC = c; bestD = d; } }
      const c0 = bestD;
      for (let d = Math.max(lo, c0 - 3); d <= Math.min(hi, c0 + 3); d++) { const c = corr(natural, nominal + d, 2); if (c > bestC || d === c0) { if (c > bestC) { bestC = c; bestD = d; } } }
      pos[k] = clamp(nominal + bestD, 0, maxPos);
      prev = pos[k];
    }
    return { pos, N, Hs, outLen };
  }

  function wsolaApply(x, plan) {
    const { pos, N, Hs, outLen } = plan;
    const w = hann(N);
    const out = new Float32Array(outLen + N);
    for (let k = 0; k < pos.length; k++) {
      const p = pos[k], o = k * Hs;
      for (let i = 0; i < N; i++) { const s = p + i < x.length ? x[p + i] : 0; out[o + i] += s * w[i]; }
    }
    // first half-window only has one contributor: fade-in correction
    for (let i = 0; i < Hs; i++) out[i] = x[i] || 0;
    return out.subarray(0, outLen);
  }

  /* ---------- WAV + ZIP ---------- */
  function encodeWav(chs, sr) {
    const n = chs[0].length, nc = chs.length, bytes = n * nc * 2;
    const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + bytes, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, bytes, true);
    const pcm = new Int16Array(buf, 44, n * nc);
    for (let i = 0, o = 0; i < n; i++) for (let c = 0; c < nc; c++, o++) {
      const s = chs[c][i];
      pcm[o] = s >= 1 ? 32767 : s <= -1 ? -32768 : Math.round(s * 32767);
    }
    return buf;
  }

  let crcTable = null;
  function crc32(u8) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Uncompressed ZIP. entries: [{name, data: Uint8Array|ArrayBuffer|string}] -> Blob parts array */
  function makeZip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = typeof e.data === "string" ? enc.encode(e.data) : e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return parts.concat(central, [new Uint8Array(end.buffer)]);
  }

  const api = { fft, hann, analyze, separate, slidingMedian, wsolaPlan, wsolaApply, encodeWav, crc32, makeZip, STEM_NAMES, KEYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BGMDSP = api;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis);
