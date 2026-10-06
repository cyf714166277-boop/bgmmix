/* BGMMix DSP worker: runs analysis, stem separation and time stretching off the main thread. */
importScripts("dsp-core.js");

self.onmessage = (event) => {
  const msg = event.data;
  const { id, cmd } = msg;
  try {
    if (cmd === "ping") {
      self.postMessage({ id, ok: typeof BGMDSP === "object" });
    } else if (cmd === "analyze") {
      const result = BGMDSP.analyze(msg.mono, msg.sr);
      self.postMessage({ id, ok: true, result });
    } else if (cmd === "separate") {
      let last = -1;
      const st = BGMDSP.separate(msg.L, msg.R, msg.sr, (p) => {
        const pct = Math.round(p * 100);
        if (pct !== last) { last = pct; self.postMessage({ id, progress: p }); }
      });
      const result = { mono: st.mono, stems: {} };
      const transfer = [];
      for (const name of BGMDSP.STEM_NAMES) {
        result.stems[name] = st[name];
        transfer.push(st[name][0].buffer, st[name][1].buffer);
      }
      self.postMessage({ id, ok: true, result }, transfer);
    } else if (cmd === "stretch") {
      const { stems, ratio, sr } = msg;
      const names = Object.keys(stems);
      const len = stems[names[0]][0].length;
      // one shared alignment, computed on the full mix, keeps the stems phase-coherent
      const guide = new Float32Array(len);
      for (const n of names) {
        const [l, r] = stems[n];
        for (let i = 0; i < len; i++) guide[i] += 0.5 * (l[i] + r[i]);
      }
      const plan = BGMDSP.wsolaPlan(guide, ratio, sr);
      const stretched = {};
      const transfer = [];
      names.forEach((n, i) => {
        stretched[n] = stems[n].map((ch) => BGMDSP.wsolaApply(ch, plan).slice());
        transfer.push(stretched[n][0].buffer, stretched[n][1].buffer, stems[n][0].buffer, stems[n][1].buffer);
        self.postMessage({ id, progress: (i + 1) / names.length });
      });
      self.postMessage({ id, ok: true, result: { stems, stretched } }, transfer);
    } else {
      throw new Error("unknown command " + cmd);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
