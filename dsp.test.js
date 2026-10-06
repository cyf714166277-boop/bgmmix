// Run: node dsp.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const D = require("./dsp-core.js");
let passed = 0;
const test = (name, fn) => { const t0 = Date.now(); fn(); passed++; console.log(`  ok  ${name} (${Date.now() - t0} ms)`); };

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function synth(sr, seconds, bpm, chords, opts = {}) {
  const n = Math.floor(sr * seconds), L = new Float32Array(n), R = new Float32Array(n);
  const beat = 60 / bpm, bar = beat * 4;
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr, ci = Math.floor(t / bar) % chords.length;
    let pad = 0; for (const m of chords[ci]) pad += Math.sin(2 * Math.PI * midiHz(m) * t) * 0.08;
    const bt = t % beat; const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-bt * 30)) * bt) * Math.exp(-bt * 18) * 0.8;
    const hat = (t % (beat / 2)) < 0.03 ? rnd() * 0.15 * Math.exp(-(t % (beat / 2)) * 120) : 0;
    const bass = Math.sin(2 * Math.PI * midiHz(chords[ci][0] - 24) * t) * 0.25;
    const voc = opts.voice ? Math.sin(2 * Math.PI * midiHz(76 + (Math.floor(t / beat) % 3)) * t) * 0.15 : 0;
    L[i] = pad * 1.0 + kick + hat + bass + voc + (opts.wide ? Math.sin(2 * Math.PI * 330 * t) * 0.05 : 0);
    R[i] = pad * 0.6 + kick + hat + bass + voc - (opts.wide ? Math.sin(2 * Math.PI * 330 * t) * 0.05 : 0);
  }
  return { L, R, mono: L.map((v, i) => 0.5 * (v + R[i])) };
}

console.log("BGMMix DSP core");
test("FFT round trip", () => {
  const n = 1024, re = new Float64Array(n), im = new Float64Array(n), orig = new Float64Array(n);
  for (let i = 0; i < n; i++) orig[i] = re[i] = Math.sin(i * 0.3) + 0.2 * Math.cos(i * 1.7);
  D.fft(re, im, false); D.fft(re, im, true);
  for (let i = 0; i < n; i++) assert(Math.abs(re[i] / n - orig[i]) < 1e-9);
});
test("FFT finds a pure tone bin", () => {
  const n = 512, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos(2 * Math.PI * 20 * i / n);
  D.fft(re, im, false);
  let best = 0; for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
  assert.strictEqual(best, 20);
});
test("sliding median", () => {
  const out = new Float32Array(7);
  D.slidingMedian(Float32Array.from([1, 9, 2, 8, 3, 7, 4]), 3, out);
  assert.deepStrictEqual(Array.from(out), [1, 2, 8, 3, 7, 4, 4]);
});

const AM = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
for (const bpm of [84, 100, 126]) {
  test(`tempo detection at ${bpm} BPM`, () => {
    const s = synth(22050, 24, bpm, AM);
    const a = D.analyze(s.mono, 22050);
    assert(Math.abs(a.bpm - bpm) / bpm < 0.03, `got ${a.bpm}`);
  });
}
test("key detection: A minor progression", () => {
  const s = synth(22050, 24, 96, AM);
  const a = D.analyze(s.mono, 22050);
  assert(["A minor", "C major"].includes(`${a.key} ${a.mode}`), `got ${a.key} ${a.mode}`);
});
test("key detection: D major progression", () => {
  const s = synth(22050, 24, 96, [[62, 66, 69], [67, 71, 74], [69, 73, 76], [62, 66, 69]]);
  const a = D.analyze(s.mono, 22050);
  assert.strictEqual(`${a.key} ${a.mode}`, "D major");
});
test("analysis returns energy, moods and full-length sections", () => {
  const s = synth(22050, 30, 110, AM);
  const a = D.analyze(s.mono, 22050);
  assert(a.energy >= 0 && a.energy <= 100);
  assert(a.moods.length >= 1 && a.moods.length <= 3);
  assert.strictEqual(a.sections[0].start, 0);
  assert(Math.abs(a.sections[a.sections.length - 1].end - 30) < 0.01);
});

test("separation: stems sum back to the input (stereo)", () => {
  const s = synth(32000, 8, 100, AM, { voice: true, wide: true });
  const st = D.separate(s.L, s.R, 32000);
  assert.strictEqual(st.mono, false);
  let err = 0, ref = 0;
  for (let i = 0; i < s.L.length; i++) {
    const sum = st.vocals[0][i] + st.drums[0][i] + st.bass[0][i] + st.other[0][i];
    err += (sum - s.L[i]) ** 2; ref += s.L[i] ** 2;
  }
  const snr = 10 * Math.log10(ref / err);
  assert(snr > 60, `reconstruction SNR ${snr.toFixed(1)} dB`);
});
test("separation: kick lands in drums, sub bass in bass", () => {
  const s = synth(32000, 8, 100, AM, { voice: true });
  const st = D.separate(s.L, s.R, 32000);
  const e = (x) => x.reduce((a, v) => a + v * v, 0);
  const drums = e(st.drums[0]), bass = e(st.bass[0]);
  assert(drums > 0.05 * e(s.L), "drums carry energy");
  assert(bass > 0.05 * e(s.L), "bass carries energy");
});
test("separation: mono input flagged", () => {
  const s = synth(22050, 4, 100, AM);
  const st = D.separate(s.mono, s.mono, 22050);
  assert.strictEqual(st.mono, true);
});

test("WSOLA keeps pitch while changing tempo", () => {
  const sr = 32000, n = sr * 4, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 440 * i / sr);
  for (const ratio of [0.8, 1.25]) {
    const y = D.wsolaApply(x, D.wsolaPlan(x, ratio, sr));
    assert(Math.abs(y.length - Math.floor(n / ratio)) <= 1);
    let zc = 0; for (let i = sr; i < sr * 2; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
    assert(Math.abs(zc - 440) <= 3, `ratio ${ratio}: ${zc} Hz`);
  }
});

test("WAV + ZIP are valid files", () => {
  const sr = 8000, a = new Float32Array(800).map((_, i) => Math.sin(i / 5) * 0.5);
  const wav = D.encodeWav([a, a], sr);
  const parts = D.makeZip([{ name: "remix.wav", data: wav }, { name: "remixplan.json", data: '{"ok":true}' }, { name: "stems/人声.wav", data: wav }]);
  const total = parts.reduce((s, p) => s + p.length, 0), buf = Buffer.alloc(total);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  const f = path.join(require("os").tmpdir(), "bgmmix-test.zip");
  fs.writeFileSync(f, buf);
  const out = require("child_process").execSync(`python3 -c "
import zipfile,wave,io,sys
z=zipfile.ZipFile('${f}'); assert z.testzip() is None
w=wave.open(io.BytesIO(z.read('remix.wav'))); print(z.namelist(), w.getnchannels(), w.getframerate(), w.getnframes())"`).toString().trim();
  assert(out.includes("'stems/人声.wav'") && out.endsWith("2 8000 800"), out);
});

console.log(`\n${passed} passed`);
