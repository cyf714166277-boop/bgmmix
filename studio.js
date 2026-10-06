/*
 * BGMMix Studio — the full product, running in the browser.
 *
 * Agents
 *   Orchestrator  sequences the pipeline and keeps state
 *   Analyzer      tempo / key / energy / mood / structure + 4-stem separation (dsp-core.js in a worker)
 *   Planner       turns intent into a RemixPlan (Claude via the artifact `sample` capability, local rules otherwise)
 *   Producer      validates the plan, respects locks, records what changed and why, renders with Web Audio
 */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const DSP = window.BGMDSP;
  const MAX_SECONDS = 600;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const r2 = (v) => Math.round(v * 100) / 100;
  const dbToGain = (db) => (db <= -30 ? 0 : Math.pow(10, db / 20));
  const fmtTime = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };

  /* ---------------- parameter contract ---------------- */
  const STEMS = [
    { id: "vocals", label: "VOCALS", cn: "人声", key: "vocalsDb" },
    { id: "drums", label: "DRUMS", cn: "鼓组", key: "drumsDb" },
    { id: "bass", label: "BASS", cn: "贝斯", key: "bassDb" },
    { id: "other", label: "OTHER", cn: "其他乐器", key: "otherDb" },
  ];
  const BEATS = { none: "不加", boombap: "Boom-bap", house: "House 四踩", trap: "Trap", eighties: "80s 鼓机" };
  const PARAMS = [
    { key: "vocalsDb", group: "stems", label: "人声音量", min: -30, max: 6, step: 0.5, unit: "dB" },
    { key: "drumsDb", group: "stems", label: "鼓组音量", min: -30, max: 6, step: 0.5, unit: "dB" },
    { key: "bassDb", group: "stems", label: "贝斯音量", min: -30, max: 6, step: 0.5, unit: "dB" },
    { key: "otherDb", group: "stems", label: "其他乐器音量", min: -30, max: 6, step: 0.5, unit: "dB" },
    { key: "tempoRatio", group: "tempo", label: "速度（不变调）", min: 0.7, max: 1.4, step: 0.01, unit: "×" },
    { key: "highpassHz", group: "tone", label: "低切", min: 20, max: 600, step: 1, unit: "Hz", log: true },
    { key: "lowpassHz", group: "tone", label: "高切", min: 800, max: 20000, step: 10, unit: "Hz", log: true },
    { key: "lowShelfDb", group: "tone", label: "低频", min: -12, max: 12, step: 0.5, unit: "dB" },
    { key: "highShelfDb", group: "tone", label: "高频", min: -12, max: 12, step: 0.5, unit: "dB" },
    { key: "saturation", group: "tone", label: "饱和 / 温暖", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "reverbMix", group: "space", label: "混响量", min: 0, max: 0.7, step: 0.01, unit: "%" },
    { key: "reverbSize", group: "space", label: "空间大小", min: 0.3, max: 6, step: 0.1, unit: "s" },
    { key: "width", group: "space", label: "声场宽度", min: 0, max: 1.8, step: 0.01, unit: "%" },
    { key: "vinyl", group: "texture", label: "黑胶底噪", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "wow", group: "texture", label: "磁带摇晃", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "crush", group: "texture", label: "数字颗粒", min: 0, max: 1, step: 0.01, unit: "%" },
    { key: "beat", group: "groove", label: "加入节拍", type: "enum", options: Object.keys(BEATS) },
    { key: "beatDb", group: "groove", label: "节拍音量", min: -24, max: 0, step: 0.5, unit: "dB" },
    { key: "pump", group: "groove", label: "律动泵感", min: 0, max: 1, step: 0.01, unit: "%" },
  ];
  const P = Object.fromEntries(PARAMS.map((p) => [p.key, p]));
  const GROUPS = [["tempo", "TEMPO", "速度"], ["tone", "TONE", "音色"], ["space", "SPACE", "空间"], ["texture", "TEXTURE", "质感"], ["groove", "GROOVE", "律动"]];
  const NEUTRAL = {
    vocalsDb: 0, drumsDb: 0, bassDb: 0, otherDb: 0, tempoRatio: 1, gridMult: 1,
    highpassHz: 20, lowpassHz: 20000, lowShelfDb: 0, highShelfDb: 0, saturation: 0,
    reverbMix: 0, reverbSize: 1.5, width: 1, vinyl: 0, wow: 0, crush: 0, beat: "none", beatDb: -8, pump: 0,
  };

  const RECIPES = [
    { id: "lofi", code: "LF", name: "LO-FI", cn: "低保真", desc: "Soft grain · 72–88 BPM", tempo: [72, 88],
      p: { vocalsDb: -3, drumsDb: -5, bassDb: 0, otherDb: 0, highpassHz: 60, lowpassHz: 4200, lowShelfDb: 3, highShelfDb: -5, saturation: 0.35, reverbMix: 0.18, reverbSize: 1.6, width: 0.8, vinyl: 0.55, wow: 0.4, crush: 0.25, beat: "boombap", beatDb: -7, pump: 0.15 } },
    { id: "cinematic", code: "CI", name: "CINEMATIC", cn: "电影感", desc: "Wide space · 66–80 BPM", tempo: [66, 80],
      p: { vocalsDb: 0, drumsDb: -10, bassDb: -2, otherDb: 2, highpassHz: 30, lowpassHz: 16000, lowShelfDb: 2, highShelfDb: 1, saturation: 0.1, reverbMix: 0.45, reverbSize: 4.5, width: 1.5, vinyl: 0, wow: 0, crush: 0, beat: "none", beatDb: -10, pump: 0 } },
    { id: "energy", code: "HE", name: "HIGH ENERGY", cn: "高能量", desc: "Hard pulse · 122–128 BPM", tempo: [122, 128],
      p: { vocalsDb: 0, drumsDb: 1, bassDb: 3, otherDb: -1, highpassHz: 30, lowpassHz: 20000, lowShelfDb: 3, highShelfDb: 3, saturation: 0.3, reverbMix: 0.1, reverbSize: 1.2, width: 1.3, vinyl: 0, wow: 0, crush: 0, beat: "house", beatDb: -5, pump: 0.6 } },
    { id: "dreamy", code: "DR", name: "DREAMY", cn: "空灵梦境", desc: "Hazy wash · 10% slower", ratio: 0.9,
      p: { vocalsDb: -2, drumsDb: -14, bassDb: -4, otherDb: 1, highpassHz: 40, lowpassHz: 9000, lowShelfDb: 0, highShelfDb: -2, saturation: 0.05, reverbMix: 0.6, reverbSize: 5.5, width: 1.7, vinyl: 0, wow: 0.15, crush: 0, beat: "none", beatDb: -12, pump: 0 } },
    { id: "retro", code: "80", name: "RETRO 80s", cn: "复古合成器", desc: "Neon drive · 100–118 BPM", tempo: [100, 118],
      p: { vocalsDb: 0, drumsDb: -2, bassDb: 2, otherDb: 0, highpassHz: 35, lowpassHz: 12000, lowShelfDb: 2, highShelfDb: 2, saturation: 0.25, reverbMix: 0.3, reverbSize: 2.2, width: 1.4, vinyl: 0.1, wow: 0.12, crush: 0.1, beat: "eighties", beatDb: -6, pump: 0.25 } },
    { id: "unplugged", code: "UP", name: "UNPLUGGED", cn: "不插电", desc: "Close & warm · natural", ratio: 0.96,
      p: { vocalsDb: 3, drumsDb: -16, bassDb: -6, otherDb: 2, highpassHz: 80, lowpassHz: 11000, lowShelfDb: -1, highShelfDb: 1, saturation: 0.08, reverbMix: 0.22, reverbSize: 1.2, width: 0.9, vinyl: 0, wow: 0, crush: 0, beat: "none", beatDb: -12, pump: 0 } },
  ];
  const RECIPE = Object.fromEntries(RECIPES.map((r) => [r.id, r]));
  const BEAT_RANGE = { boombap: [80, 96], house: [120, 128], trap: [130, 150], eighties: [100, 120], none: [60, 200] };

  /* ---------------- state ---------------- */
  const S = {
    name: "", original: null, analysis: null, stems: null, stemSR: 0, mono: false,
    stretched: null, plan: { ...NEUTRAL }, locks: new Set(), changes: [], title: "原曲参数", summary: "还没有选择方向。挑一个风格配方，或者用一句话告诉 Agent 你想要的感觉。",
    recipeId: null, planner: null, remix: null, dirty: false, busy: false,
    mode: "A", sample: null, downloads: null, inViewer: typeof window.claude?.use === "function",
  };

  /* ---------------- worker ---------------- */
  let worker = null, jobId = 0;
  const jobs = new Map();
  // health check: a worker that cannot load (blocked script, old browser) falls back to the main thread
  const workerReady = new Promise((resolve) => {
    let w;
    try { w = new Worker("dsp-worker.js"); } catch (_) { resolve(null); return; }
    const timer = setTimeout(() => { try { w.terminate(); } catch (_) {} resolve(null); }, 4000);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.id === 0) { clearTimeout(timer); resolve(m.ok ? w : null); return; }
      const job = jobs.get(m.id);
      if (!job) return;
      if (m.progress !== undefined) { job.onProgress && job.onProgress(m.progress); return; }
      jobs.delete(m.id);
      m.ok ? job.resolve(m.result) : job.reject(new Error(m.error));
    };
    w.onerror = () => { clearTimeout(timer); for (const j of jobs.values()) j.reject(new Error("计算线程出错，请刷新页面重试")); jobs.clear(); resolve(null); };
    w.postMessage({ id: 0, cmd: "ping" });
  }).then((w) => (worker = w));

  async function runJob(cmd, payload, transfer, onProgress) {
    await workerReady;
    if (!worker) return runInline(cmd, payload, onProgress);
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      jobs.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, cmd, ...payload }, transfer || []);
    });
  }
  async function runInline(cmd, p, onProgress) {
    await new Promise((r) => setTimeout(r, 30));
    if (cmd === "analyze") return DSP.analyze(p.mono, p.sr);
    if (cmd === "separate") {
      const st = DSP.separate(p.L, p.R, p.sr, onProgress);
      return { mono: st.mono, stems: Object.fromEntries(DSP.STEM_NAMES.map((n) => [n, st[n]])) };
    }
    if (cmd === "stretch") {
      const names = Object.keys(p.stems), len = p.stems[names[0]][0].length, guide = new Float32Array(len);
      for (const n of names) { const [l, r] = p.stems[n]; for (let i = 0; i < len; i++) guide[i] += 0.5 * (l[i] + r[i]); }
      const plan = DSP.wsolaPlan(guide, p.ratio, p.sr);
      const stretched = {};
      for (const n of names) stretched[n] = p.stems[n].map((ch) => DSP.wsolaApply(ch, plan).slice());
      return { stems: p.stems, stretched };
    }
    throw new Error("unknown command");
  }

  /* ---------------- UI refs ---------------- */
  const ui = {
    file: $("#bxFile"), drop: $("#bxDrop"), demo: $("#bxDemo"), name: $("#bxName"), meta: $("#bxMeta"),
    bpm: $("#bxBpm"), key: $("#bxKey"), mode: $("#bxMode"), energy: $("#bxEnergy"), loud: $("#bxLoud"), moods: $("#bxMoods"), conf: $("#bxConf"),
    play: $("#bxPlay"), ab: $("#bxAB"), time: $("#bxTime"), now: $("#bxNow"), wave: $("#bxWave"), sections: $("#bxSections"),
    stemRows: $("#bxStemRows"), stemNote: $("#bxStemNote"), stemState: $("#bxStemState"),
    recipes: $("#bxRecipes"), intent: $("#bxIntent"), ideas: $("#bxIdeas"), ask: $("#bxAsk"), agents: $("#bxAgents"),
    planTitle: $("#bxPlanTitle"), planSummary: $("#bxPlanSummary"), planSource: $("#bxPlanSource"), params: $("#bxParams"),
    render: $("#bxRender"), reset: $("#bxReset"), changes: $("#bxChanges"), dirty: $("#bxDirty"),
    exportMix: $("#bxExportMix"), exportStems: $("#bxExportStems"), exportNote: $("#bxExportNote"),
    status: $("#bxStatus"), badge: $("#bxPlannerBadge"),
  };
  const setStatus = (t) => { ui.status.textContent = t; };

  /* ---------------- agents timeline ---------------- */
  const AGENTS = [
    ["orchestrator", "ORCHESTRATOR", "编排流程"],
    ["analyzer", "ANALYZER", "理解音乐 · 四轨分离"],
    ["planner", "PLANNER", "生成 RemixPlan"],
    ["producer", "PRODUCER", "校验 · 渲染"],
  ];
  ui.agents.innerHTML = AGENTS.map(([id, name, role]) =>
    `<li data-agent="${id}" data-state="idle"><span class="bx-dot" aria-hidden="true"></span><div><strong>${name}</strong><small>${role}</small></div><p id="bxAg-${id}">待命</p></li>`).join("");
  function agent(id, state, text) {
    const li = ui.agents.querySelector(`[data-agent="${id}"]`);
    li.dataset.state = state;
    if (text !== undefined) $("#bxAg-" + id).textContent = text;
  }

  /* ---------------- recipes + ideas ---------------- */
  ui.recipes.innerHTML = RECIPES.map((r, i) =>
    `<button class="bx-recipe" type="button" data-recipe="${r.id}"><span class="preset-index">${String(i + 1).padStart(2, "0")}</span><span class="preset-code">${r.code}</span><strong>${r.name}</strong><small>${r.cn} · ${r.desc}</small></button>`).join("");
  const IDEAS = ["做成适合 vlog 的轻松 lo-fi，人声往后放", "电影预告片那种宏大感", "健身房能用的高能量版本", "去掉鼓，只留温暖的原声感", "复古一点，像 80 年代的夜晚开车"];
  ui.ideas.innerHTML = IDEAS.map((t) => `<button type="button" class="bx-idea">${t}</button>`).join("");
  ui.ideas.addEventListener("click", (e) => { const b = e.target.closest(".bx-idea"); if (b) { ui.intent.value = b.textContent; ui.intent.focus(); } });

  /* ---------------- parameter UI ---------------- */
  const toSlider = (p, v) => p.log ? Math.round(1000 * Math.log(v / p.min) / Math.log(p.max / p.min)) : v;
  const fromSlider = (p, s) => p.log ? Math.round(p.min * Math.pow(p.max / p.min, s / 1000)) : Number(s);
  function fmtParam(key, v) {
    const p = P[key];
    if (key === "tempoRatio") return S.analysis ? `${Math.round(S.analysis.bpm * v)} BPM · ×${v.toFixed(2)}` : `×${v.toFixed(2)}`;
    if (p.type === "enum") return BEATS[v];
    if (p.unit === "%") return `${Math.round(v * 100)}%`;
    if (p.unit === "dB") return v <= -30 ? "静音" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
    if (p.unit === "Hz") return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
    if (p.unit === "s") return `${v.toFixed(1)} s`;
    return String(v);
  }
  function paramRow(p) {
    const lock = `<button type="button" class="bx-lock" data-lock="${p.key}" aria-pressed="false" title="锁定：AI 不会改动这个参数">LOCK</button>`;
    const control = p.type === "enum"
      ? `<select id="bx-p-${p.key}" data-param="${p.key}">${p.options.map((o) => `<option value="${o}">${BEATS[o]}</option>`).join("")}</select>`
      : `<input type="range" id="bx-p-${p.key}" data-param="${p.key}" min="${p.log ? 0 : p.min}" max="${p.log ? 1000 : p.max}" step="${p.log ? 1 : p.step}">`;
    return `<div class="bx-param" data-row="${p.key}"><label for="bx-p-${p.key}">${p.label}</label><output id="bx-o-${p.key}"></output>${control}${lock}</div>`;
  }
  ui.params.innerHTML = GROUPS.map(([g, en, cn]) =>
    `<section class="bx-group"><h4>${en} <span>${cn}</span></h4>${PARAMS.filter((p) => p.group === g).map(paramRow).join("")}</section>`).join("");
  ui.stemRows.innerHTML = STEMS.map((s) => `
    <div class="bx-stem" data-stem="${s.id}">
      <div class="bx-stem-name"><strong>${s.label}</strong><small>${s.cn}</small></div>
      <canvas class="bx-stem-wave" id="bxSW-${s.id}" aria-hidden="true"></canvas>
      <div class="bx-stem-ctl">
        <button type="button" class="bx-solo" data-solo="${s.id}" aria-pressed="false" disabled>▶ 单听</button>
        ${paramRow(P[s.key])}
      </div>
    </div>`).join("");

  function syncParams() {
    for (const p of PARAMS) {
      const el = $(`#bx-p-${p.key}`), v = S.plan[p.key];
      if (p.type === "enum") el.value = v; else el.value = toSlider(p, v);
      $(`#bx-o-${p.key}`).textContent = fmtParam(p.key, v);
      const locked = S.locks.has(p.key);
      const btn = document.querySelector(`[data-lock="${p.key}"]`);
      btn.setAttribute("aria-pressed", locked); btn.textContent = locked ? "LOCKED" : "LOCK";
      document.querySelector(`[data-row="${p.key}"]`).classList.toggle("is-locked", locked);
      document.querySelector(`[data-row="${p.key}"]`).classList.toggle("is-changed", S.changes.some((c) => c.key === p.key));
    }
    ui.planTitle.textContent = S.title;
    ui.planSummary.textContent = S.summary;
    ui.planSource.textContent = S.planner || "—";
    ui.changes.innerHTML = S.changes.length
      ? S.changes.map((c) => `<li><b>${P[c.key].label}</b><span>${fmtParam(c.key, c.from)} → <em>${fmtParam(c.key, c.to)}</em></span><p>${escapeHtml(c.reason)}</p></li>`).join("")
      : `<li class="bx-empty">选择一个方向后，这里会逐条列出 AI 改了哪些参数、从多少改到多少、为什么这样改。</li>`;
    ui.dirty.hidden = !S.dirty;
    document.querySelectorAll(".bx-recipe").forEach((b) => b.classList.toggle("active", b.dataset.recipe === S.recipeId));
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  document.addEventListener("input", (e) => {
    const key = e.target.dataset && e.target.dataset.param;
    if (!key) return;
    const p = P[key];
    const v = p.type === "enum" ? e.target.value : r2(fromSlider(p, e.target.value));
    S.plan[key] = v;
    if (!S.locks.has(key)) { S.locks.add(key); setStatus(`已接管「${p.label}」，AI 之后不会改动它。点 LOCKED 可以交还。`); }
    S.dirty = !!S.analysis;
    syncParams();
    updateButtons();
  });
  document.addEventListener("click", (e) => {
    const lock = e.target.closest("[data-lock]");
    if (lock) { const k = lock.dataset.lock; S.locks.has(k) ? S.locks.delete(k) : S.locks.add(k); syncParams(); return; }
    const solo = e.target.closest("[data-solo]");
    if (solo && !solo.disabled) { const id = solo.dataset.solo; setMode(S.mode === "stem:" + id && player.playing ? "A" : "stem:" + id, true); }
  });

  /* ---------------- tempo fitting + producer ---------------- */
  function fitTempo(bpm, lo, hi) {
    const target = (lo + hi) / 2;
    let best = null;
    for (const m of [0.5, 1, 2]) {
      const r = clamp(target / (bpm * m), 0.7, 1.4), fin = bpm * m * r;
      const miss = fin < lo ? lo - fin : fin > hi ? fin - hi : 0;
      const cost = miss * 10 + Math.abs(Math.log(r));
      if (!best || cost < best.cost) best = { r, cost };
    }
    return r2(best.r);
  }
  function gridFor(beat, finalBpm) {
    const [lo, hi] = BEAT_RANGE[beat] || BEAT_RANGE.none, mid = (lo + hi) / 2;
    let best = 1, bestD = Infinity;
    for (const m of [0.5, 1, 2]) { const d = Math.abs(Math.log(finalBpm * m / mid)); if (d < bestD) { bestD = d; best = m; } }
    return best;
  }
  function recipeParams(id) {
    const r = RECIPE[id], a = S.analysis;
    const out = { ...NEUTRAL, ...r.p };
    out.tempoRatio = r.tempo ? fitTempo(a.bpm, r.tempo[0], r.tempo[1]) : r.ratio;
    return out;
  }
  function reasonFor(key, from, to) {
    const up = typeof to === "number" && typeof from === "number" ? to > from : true;
    const M = {
      vocalsDb: up ? "让人声更靠前、更清楚" : to <= -30 ? "去掉人声，变成纯伴奏" : "人声往后放，给画面和旁白留空间",
      drumsDb: up ? "鼓更有冲击力，推动节奏" : to <= -30 ? "拿掉原曲鼓组，节奏交给新律动或留白" : "原鼓组退后，氛围更松",
      bassDb: up ? "低频更厚，身体能感到律动" : "收一收低频，让整体更轻",
      otherDb: up ? "伴奏乐器更饱满，撑起和声" : "伴奏让位，突出主体",
      tempoRatio: up ? "提速（不变调），能量更足" : "放慢（不变调），情绪更松弛",
      highpassHz: up ? "切掉多余低频，声音更干净" : "放开低频",
      lowpassHz: up ? "放开高频，声音更通透" : "削掉高频，声音更柔、更有年代感",
      lowShelfDb: up ? "加一点低频暖度" : "减少低频的浑浊",
      highShelfDb: up ? "提亮高频，更有空气感" : "压暗高频，听感更柔和",
      saturation: up ? "加饱和，模拟磁带/电子管的温暖" : "减少失真，更干净",
      reverbMix: up ? "加混响，空间更大、更有画面感" : "收干混响，声音更贴近",
      reverbSize: up ? "放大空间，像在大厅或峡谷里" : "缩小空间，更亲密",
      width: up ? "拉宽声场，更包围" : "收窄声场，更集中、更复古",
      vinyl: up ? "加黑胶底噪，营造旧唱片质感" : "去掉底噪",
      wow: up ? "加磁带摇晃，轻微走音的复古感" : "去掉磁带摇晃",
      crush: up ? "降低采样精度，加入数字颗粒感" : "恢复干净的数字音质",
      beat: to === "none" ? "不额外加节拍" : `按 BPM 对齐，叠加 ${BEATS[to]} 律动`,
      beatDb: up ? "新节拍更突出" : "新节拍退后，只作点缀",
      pump: up ? "随拍点压缩，制造呼吸般的泵感" : "减少泵感，更平稳",
    };
    return M[key] || "根据方向调整";
  }
  /** Producer: validate, clamp, respect locks, diff, record reasons. */
  function producerApply(next, meta) {
    const prev = S.plan, merged = { ...prev };
    const reasons = meta.reasons || {};
    for (const p of PARAMS) {
      if (S.locks.has(p.key) || next[p.key] === undefined || next[p.key] === null) continue;
      let v = next[p.key];
      if (p.type === "enum") { if (!p.options.includes(v)) continue; }
      else { v = Number(v); if (!isFinite(v)) continue; v = r2(clamp(v, p.min, p.max)); }
      merged[p.key] = v;
    }
    merged.gridMult = gridFor(merged.beat, S.analysis.bpm * merged.tempoRatio);
    const changes = [];
    for (const p of PARAMS) {
      const a = prev[p.key], b = merged[p.key];
      const same = p.type === "enum" ? a === b : Math.abs(a - b) < (p.step || 0.01) / 2;
      if (!same) changes.push({ key: p.key, from: a, to: b, reason: String(reasons[p.key] || reasonFor(p.key, a, b)).slice(0, 80) });
    }
    S.plan = merged; S.changes = changes;
    S.title = meta.title || S.title; S.summary = meta.summary || S.summary;
    S.recipeId = meta.recipeId || null; S.planner = meta.planner;
    syncParams();
    return changes;
  }

  /* ---------------- planners ---------------- */
  function localPlanner(intent) {
    const t = intent.toLowerCase();
    const has = (...w) => w.some((x) => t.includes(x));
    let id = "lofi";
    if (has("电影", "史诗", "宏大", "预告", "cinematic", "epic", "大片")) id = "cinematic";
    else if (has("健身", "高能", "燃", "派对", "跳舞", "house", "蹦", "运动", "energy", "快节奏")) id = "energy";
    else if (has("梦", "空灵", "氛围", "ambient", "飘", "朦胧")) id = "dreamy";
    else if (has("复古", "80", "合成器", "synth", "霓虹", "开车")) id = "retro";
    else if (has("原声", "不插电", "acoustic", "吉他", "安静", "温柔")) id = "unplugged";
    else if (has("lo-fi", "lofi", "放松", "学习", "咖啡", "vlog", "轻松", "chill")) id = "lofi";
    const p = recipeParams(id), why = {};
    const add = (k, v, w) => { p[k] = v; why[k] = w; };
    if (has("去掉人声", "不要人声", "纯音乐", "伴奏")) add("vocalsDb", -30, "按要求去掉人声");
    else if (has("人声往后", "人声小", "人声弱", "人声退")) add("vocalsDb", Math.min(p.vocalsDb, -6), "按要求把人声往后放");
    else if (has("人声突出", "人声大", "人声往前", "人声清楚")) add("vocalsDb", 3, "按要求让人声更突出");
    if (has("去掉鼓", "不要鼓", "没有鼓")) { add("drumsDb", -30, "按要求去掉原曲鼓组"); add("beat", "none", "去掉鼓后不再叠加节拍"); }
    else if (has("鼓重", "鼓更重", "鼓大", "鼓点更强")) add("drumsDb", 3, "按要求让鼓更有力");
    if (has("低音", "贝斯", "bass") && has("重", "厚", "大", "强")) add("bassDb", 4, "按要求加厚低频");
    if (has("温暖", "暖")) { add("lowShelfDb", Math.max(p.lowShelfDb, 3), "按要求加低频暖度"); add("saturation", Math.max(p.saturation, 0.3), "加饱和让声音更暖"); }
    if (has("明亮", "通透", "清爽")) add("highShelfDb", Math.max(p.highShelfDb, 3), "按要求提亮高频");
    if (has("空间", "混响", "大厅", "辽阔")) add("reverbMix", Math.min(0.7, p.reverbMix + 0.15), "按要求加大空间感");
    if (has("黑胶", "老唱片", "怀旧")) add("vinyl", Math.max(p.vinyl, 0.5), "按要求加入黑胶质感");
    if (has("更快", "快一点", "提速")) add("tempoRatio", clamp(p.tempoRatio * 1.08, 0.7, 1.4), "按要求提速");
    if (has("更慢", "慢一点", "放慢")) add("tempoRatio", clamp(p.tempoRatio * 0.92, 0.7, 1.4), "按要求放慢");
    const r = RECIPE[id];
    return { recipe: id, params: p, reasons: why, title: `${r.cn} · 规则方案`, summary: `本地规则 Planner 从「${intent.slice(0, 40)}」里识别出 ${r.name} 方向，在配方基础上按关键词做了微调。` };
  }

  async function claudePlanner(intent) {
    const a = S.analysis;
    const ranges = PARAMS.map((p) => p.type === "enum" ? `${p.key}: one of ${p.options.join("|")} (${p.label})` : `${p.key}: ${p.min}..${p.max} (${p.label}${p.unit === "%" ? ", 0..1 fraction" : p.unit ? ", " + p.unit : ""})`).join("\n");
    const recipes = RECIPES.map((r) => `${r.id} (${r.name} / ${r.cn}): ${JSON.stringify(r.p)}${r.tempo ? `, target ${r.tempo[0]}-${r.tempo[1]} BPM` : `, tempoRatio ${r.ratio}`}`).join("\n");
    const current = Object.fromEntries(PARAMS.map((p) => [p.key, S.plan[p.key]]));
    const prompt = `You are the Planner agent inside BGMMix, an AI music co-creation tool for non-musicians. A deterministic audio engine executes your RemixPlan on four separated stems (vocals, drums, bass, other); you never touch audio yourself.

Analysis from the Analyzer agent:
${JSON.stringify({ bpm: a.bpm, key: `${a.key} ${a.mode}`, energy: a.energy, loudnessDb: a.loudnessDb, brightnessHz: a.centroid, moods: a.moods, sections: a.sections.map((s) => s.label), durationSec: Math.round(a.duration) })}

Current RemixPlan values: ${JSON.stringify(current)}
Locked parameters (the user took control; never include these keys): ${JSON.stringify([...S.locks])}

Parameter ranges:
${ranges}
tempoRatio multiplies the song tempo without changing pitch; final BPM = ${a.bpm} × tempoRatio.
-30 dB on a stem means muted. "beat" adds a synthesized drum groove locked to the tempo.

Style recipes you can start from:
${recipes}

User intent: """${intent.slice(0, 600)}"""

Pick the closest recipe as a base, then adjust for the intent and this song's analysis (for example keep a sensible BPM for the style, do not stack heavy effects on an already dark or loud track). Reply with JSON only, no prose:
{"recipe":"<recipe id>","title":"<direction name, at most 12 Chinese characters>","summary":"<one or two Chinese sentences on the direction and why it suits this song>","params":{"<key>":<value>},"reasons":{"<key>":"<at most 20 Chinese characters: why this change>"}}
Include in "params" every parameter whose value should differ from the recipe base, and give a reason for each important change.`;
    const res = await S.sample.json(prompt, { modelTier: "quick" });
    if (!res || typeof res !== "object" || !RECIPE[res.recipe]) throw new Error("Planner 返回的方案格式不对");
    const base = recipeParams(res.recipe);
    return { recipe: res.recipe, params: { ...base, ...(res.params || {}) }, reasons: res.reasons || {}, title: String(res.title || RECIPE[res.recipe].cn).slice(0, 24), summary: String(res.summary || "").slice(0, 200) };
  }

  /* ---------------- audio loading ---------------- */
  async function decodeFile(arrayBuffer) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(2, 44100, 44100);
    return await ctx.decodeAudioData(arrayBuffer);
  }
  async function resample(buffer, sr, channels) {
    const len = Math.max(1, Math.ceil(buffer.duration * sr));
    const ctx = new OfflineAudioContext(channels, len, sr);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
    return await ctx.startRendering();
  }
  const bufferToObj = (b) => ({ sr: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)), length: b.length, duration: b.duration });

  async function loadAudio(arrayBuffer, name) {
    if (S.busy) return;
    stopPlayer();
    S.busy = true; updateButtons();
    try {
      agent("orchestrator", "run", `接收 ${name}`);
      ["analyzer", "planner", "producer"].forEach((a) => agent(a, "idle", "待命"));
      setStatus("正在解码音频…");
      const buf = await decodeFile(arrayBuffer);
      if (buf.duration > MAX_SECONDS) throw new Error(`这首歌 ${fmtTime(buf.duration)}，超过 10 分钟上限，请剪短后再上传。`);
      if (buf.duration < 3) throw new Error("音频太短（少于 3 秒），没法分析节奏。");
      Object.assign(S, { name, original: buf, analysis: null, stems: null, stretched: null, remix: null, plan: { ...NEUTRAL }, changes: [], locks: new Set(), recipeId: null, planner: null, dirty: false, title: "原曲参数", summary: "还没有选择方向。挑一个风格配方，或者用一句话告诉 Agent 你想要的感觉。" });
      S._stemBufs = null;
      ["bpm", "key", "mode", "energy", "loud"].forEach((k) => { ui[k].textContent = "—"; });
      ui.moods.innerHTML = ""; ui.conf.textContent = "分析中…";
      ui.stemState.textContent = "WAITING"; ui.stemNote.textContent = "分析完成后自动分离四轨。";
      ui.name.textContent = name;
      ui.meta.textContent = `${fmtTime(buf.duration)} · ${buf.numberOfChannels === 1 ? "单声道" : "立体声"} · ${(buf.sampleRate / 1000).toFixed(1)} kHz`;
      setMode("A", false);
      drawAll();
      syncParams();

      agent("analyzer", "run", "测速度、调性、能量…");
      setStatus("Analyzer 正在听这首歌…");
      const mono = await resample(buf, 22050, 1);
      const monoData = mono.getChannelData(0).slice();
      S.analysis = await runJob("analyze", { mono: monoData, sr: 22050 }, [monoData.buffer]);
      renderDNA();
      drawAll();

      S.stemSR = buf.duration <= 200 ? 32000 : 22050;
      const st = await resample(buf, S.stemSR, 2);
      const L = st.getChannelData(0).slice(), R = st.getChannelData(1).slice();
      ui.stemState.textContent = "分离中 0%";
      const sep = await runJob("separate", { L, R, sr: S.stemSR }, [L.buffer, R.buffer], (p) => {
        ui.stemState.textContent = `分离中 ${Math.round(p * 100)}%`;
        agent("analyzer", "run", `四轨分离 ${Math.round(p * 100)}%`);
      });
      S.stems = sep.stems; S.mono = sep.mono;
      ui.stemState.textContent = "4 STEMS READY";
      ui.stemNote.textContent = S.mono
        ? "单声道音源：人声靠频段估计，分离会比立体声粗糙。四轨相加仍等于原曲。"
        : "轻量 DSP 分离：谐波/打击乐拆分 + 中置声像提取。四轨相加严格等于原曲，可单听检查。";
      agent("analyzer", "done", `${S.analysis.bpm} BPM · ${S.analysis.key} ${S.analysis.mode === "minor" ? "小调" : "大调"} · 四轨就绪`);
      agent("orchestrator", "done", "等待你选择方向");
      setStatus("分析完成。选一个风格配方，或者用一句话描述你想要的感觉。");
      drawAll();
    } catch (err) {
      agent("orchestrator", "error", "载入失败");
      agent("analyzer", "error", err.message);
      setStatus(err.message.includes("decode") || err.name === "EncodingError" ? "浏览器没法解码这个文件，请换成 MP3、WAV 或 M4A。" : err.message);
    } finally {
      S.busy = false; updateButtons();
    }
  }

  /* ---------------- rendering ---------------- */
  let drumKit = null;
  function makeKit(sr) {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const mk = (sec, fn) => { const n = Math.floor(sec * sr), a = new Float32Array(n); fn(a, n); return a; };
    const kick = mk(0.45, (a, n) => { let ph = 0; for (let i = 0; i < n; i++) { const t = i / sr; ph += 2 * Math.PI * (45 + 110 * Math.exp(-t * 28)) / sr; a[i] = Math.sin(ph) * Math.exp(-t * 7) * 0.95 + (i < sr * 0.004 ? rnd() * 0.3 : 0); } });
    const snare = mk(0.28, (a, n) => { let lp = 0; for (let i = 0; i < n; i++) { const t = i / sr, w = rnd(); lp += 0.25 * (w - lp); a[i] = (w - lp) * Math.exp(-t * 18) * 0.55 + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 26) * 0.45; } });
    const clap = mk(0.3, (a, n) => { let lp = 0; for (let i = 0; i < n; i++) { const t = i / sr, w = rnd(); lp += 0.35 * (w - lp); const burst = [0, 0.011, 0.022].reduce((s, o) => s + (t >= o ? Math.exp(-(t - o) * 90) : 0), 0) + Math.exp(-t * 12) * 0.5; a[i] = (w - lp) * burst * 0.45; } });
    const hat = mk(0.07, (a, n) => { let prev = 0; for (let i = 0; i < n; i++) { const w = rnd(), h = w - prev; prev = w; a[i] = h * Math.exp(-(i / sr) * 70) * 0.3; } });
    const open = mk(0.28, (a, n) => { let prev = 0; for (let i = 0; i < n; i++) { const w = rnd(), h = w - prev; prev = w; a[i] = h * Math.exp(-(i / sr) * 13) * 0.22; } });
    return { kick, snare, clap, hat, open, sr };
  }
  const PATTERNS = {
    boombap: { kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], swing: 0.16 },
    house: { kick: [0, 4, 8, 12], clap: [4, 12], open: [2, 6, 10, 14], hat: [1, 3, 5, 7, 9, 11, 13, 15] },
    trap: { kick: [0, 6, 10], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 13, 14, 15] },
    eighties: { kick: [0, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
  };

  function impulse(ctx, seconds) {
    const sr = ctx.sampleRate, n = Math.floor(sr * seconds), ir = ctx.createBuffer(2, n, sr);
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      const pre = Math.floor(0.018 * sr);
      for (let i = pre; i < n; i++) {
        const t = (i - pre) / sr;
        lp += (0.55 - 0.4 * (t / seconds)) * (rnd() - lp);
        d[i] = lp * Math.exp(-6.9 * t / seconds);
      }
    }
    return ir;
  }

  async function ensureStretched(ratio) {
    if (Math.abs(ratio - 1) < 0.005) return S.stems;
    if (S.stretched && Math.abs(S.stretched.ratio - ratio) < 0.001) return S.stretched.data;
    S.stretched = null;
    if (S.mode.startsWith("stem:")) setMode("A", false);
    const transfer = [];
    for (const n of Object.keys(S.stems)) transfer.push(S.stems[n][0].buffer, S.stems[n][1].buffer);
    agent("producer", "run", "变速不变调 0%");
    const res = await runJob("stretch", { stems: S.stems, ratio, sr: S.stemSR }, transfer, (p) => agent("producer", "run", `变速不变调 ${Math.round(p * 100)}%`));
    S.stems = res.stems;
    S.stretched = { ratio, data: res.stretched };
    return res.stretched;
  }

  async function renderRemix() {
    const plan = { ...S.plan }, a = S.analysis, sr = S.stemSR;
    agent("producer", "run", "校验参数…");
    const stems = await ensureStretched(plan.tempoRatio);
    agent("producer", "run", "Web Audio 渲染中…");
    const len = stems.vocals[0].length;
    const tail = Math.floor(sr * Math.min(4, plan.reverbSize * plan.reverbMix * 3 + 0.3));
    const ctx = new OfflineAudioContext(2, len + tail, sr);

    const bus = ctx.createGain();
    const wowGain = ctx.createGain(); wowGain.gain.value = plan.wow * 28;
    const wow = ctx.createOscillator(); wow.frequency.value = 0.55; wow.connect(wowGain);
    const flutGain = ctx.createGain(); flutGain.gain.value = plan.wow * 6;
    const flut = ctx.createOscillator(); flut.frequency.value = 6.3; flut.connect(flutGain);
    for (const s of STEMS) {
      const g = dbToGain(plan[s.key]);
      if (g === 0) continue;
      const b = ctx.createBuffer(2, len, sr);
      b.copyToChannel(stems[s.id][0], 0); b.copyToChannel(stems[s.id][1], 1);
      const src = ctx.createBufferSource(); src.buffer = b;
      if (plan.wow > 0) { wowGain.connect(src.detune); flutGain.connect(src.detune); }
      const gn = ctx.createGain(); gn.gain.value = g;
      src.connect(gn).connect(bus);
      src.start(0);
    }
    if (plan.wow > 0) { wow.start(0); flut.start(0); }

    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = plan.highpassHz; hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = Math.min(plan.lowpassHz, sr / 2 - 100); lp.Q.value = 0.7;
    const ls = ctx.createBiquadFilter(); ls.type = "lowshelf"; ls.frequency.value = 200; ls.gain.value = plan.lowShelfDb;
    const hs = ctx.createBiquadFilter(); hs.type = "highshelf"; hs.frequency.value = Math.min(6000, sr / 2 - 1000); hs.gain.value = plan.highShelfDb;
    const shaper = ctx.createWaveShaper();
    { const k = 1 + plan.saturation * 7, n = 2048, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); } shaper.curve = c; shaper.oversample = "2x"; }
    bus.connect(hp).connect(lp).connect(ls).connect(hs).connect(shaper);

    // stereo width (M/S matrix)
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const w = plan.width, same = 0.5 + 0.5 * w, cross = 0.5 - 0.5 * w;
    const gLL = ctx.createGain(), gRR = ctx.createGain(), gLR = ctx.createGain(), gRL = ctx.createGain();
    gLL.gain.value = same; gRR.gain.value = same; gLR.gain.value = cross; gRL.gain.value = cross;
    shaper.connect(split);
    split.connect(gLL, 0); split.connect(gLR, 0); split.connect(gRR, 1); split.connect(gRL, 1);
    gLL.connect(merge, 0, 0); gRL.connect(merge, 0, 0); gRR.connect(merge, 0, 1); gLR.connect(merge, 0, 1);

    const pumpG = ctx.createGain();
    const dry = ctx.createGain(); dry.gain.value = 1 - plan.reverbMix * 0.5;
    merge.connect(dry).connect(pumpG);
    if (plan.reverbMix > 0.001) {
      const conv = ctx.createConvolver(); conv.normalize = true; conv.buffer = impulse(ctx, plan.reverbSize);
      const wet = ctx.createGain(); wet.gain.value = plan.reverbMix * 1.6;
      merge.connect(conv).connect(wet).connect(pumpG);
    }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.22; comp.knee.value = 8;
    pumpG.connect(comp).connect(ctx.destination);

    // tempo grid in remix time
    const beatDur = 60 / (a.bpm * plan.gridMult * plan.tempoRatio);
    let first = (a.firstBeat / plan.tempoRatio) % beatDur;
    const endT = len / sr;
    if (plan.pump > 0.001) {
      pumpG.gain.setValueAtTime(1, 0);
      const pumpBeat = 60 / (a.bpm * plan.tempoRatio);
      for (let t = (a.firstBeat / plan.tempoRatio) % pumpBeat; t < endT; t += pumpBeat) {
        pumpG.gain.setValueAtTime(1 - plan.pump * 0.65, t);
        pumpG.gain.linearRampToValueAtTime(1, t + pumpBeat * 0.62);
      }
    }
    if (plan.beat !== "none" && PATTERNS[plan.beat]) {
      if (!drumKit || drumKit.sr !== sr) drumKit = makeKit(sr);
      const kitBufs = {};
      for (const k of ["kick", "snare", "clap", "hat", "open"]) { const b = ctx.createBuffer(1, drumKit[k].length, sr); b.copyToChannel(drumKit[k], 0); kitBufs[k] = b; }
      const beatBus = ctx.createGain(); beatBus.gain.value = dbToGain(plan.beatDb) * 0.9;
      const beatHp = ctx.createBiquadFilter(); beatHp.type = "highpass"; beatHp.frequency.value = Math.max(30, plan.highpassHz * 0.6);
      beatBus.connect(beatHp).connect(comp);
      const pat = PATTERNS[plan.beat], step = beatDur / 4;
      const vel = { kick: 1, snare: 0.85, clap: 0.8, hat: 0.5, open: 0.55 };
      const barDur = beatDur * 4;
      for (let bar = first; bar < endT - barDur * 0.5; bar += barDur) {
        for (const inst of Object.keys(vel)) {
          for (const s of pat[inst] || []) {
            let t = bar + s * step;
            if (pat.swing && s % 4 === 2) t += step * pat.swing;
            if (t >= endT) continue;
            const src = ctx.createBufferSource(); src.buffer = kitBufs[inst];
            const g = ctx.createGain(); g.gain.value = vel[inst] * (inst === "hat" && s % 4 ? 0.7 : 1);
            src.connect(g).connect(beatBus); src.start(t);
          }
        }
      }
    }
    void first;

    const out = await ctx.startRendering();
    const L = out.getChannelData(0), R = out.getChannelData(1);
    // texture post-processing
    if (plan.crush > 0.01) {
      const bits = 16 - plan.crush * 9, q = Math.pow(2, bits - 1), hold = 1 + Math.round(plan.crush * 4);
      for (const ch of [L, R]) { let held = 0; for (let i = 0; i < ch.length; i++) { if (i % hold === 0) held = Math.round(ch[i] * q) / q; ch[i] = held; } }
    }
    if (plan.vinyl > 0.01) {
      let seed = 5;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const rate = (2 + plan.vinyl * 10) / sr, hissA = 0.012 * plan.vinyl;
      let hL = 0, hR = 0, pop = 0, popDecay = 0;
      for (let i = 0; i < L.length; i++) {
        hL += 0.2 * ((rnd() * 2 - 1) - hL); hR += 0.2 * ((rnd() * 2 - 1) - hR);
        if (rnd() < rate) { pop = (rnd() * 2 - 1) * (0.04 + 0.16 * rnd()) * plan.vinyl; popDecay = 0.6 + rnd() * 0.25; }
        const c = pop; pop *= popDecay;
        L[i] += hL * hissA + c; R[i] += hR * hissA + c * 0.8;
      }
    }
    let peak = 0;
    for (const ch of [L, R]) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
    const norm = peak > 0 ? 0.89 / peak : 1;
    for (const ch of [L, R]) for (let i = 0; i < ch.length; i++) ch[i] *= norm;
    return out;
  }

  /* ---------------- orchestrator ---------------- */
  async function produce(meta, params) {
    const changes = producerApply(params, meta);
    agent("producer", "run", `采纳 ${changes.length} 处修改，渲染中…`);
    S.remix = await renderRemix();
    S.dirty = false;
    agent("producer", "done", `${fmtTime(S.remix.duration)} · ${Math.round(S.analysis.bpm * S.plan.tempoRatio)} BPM · 已渲染`);
    syncParams();
    setMode("B", false);
    drawAll();
  }

  async function runRecipe(id) {
    if (S.busy || !S.stems) return;
    S.busy = true; updateButtons();
    const r = RECIPE[id];
    try {
      agent("orchestrator", "run", `方向：${r.name}`);
      agent("planner", "run", "读取配方…");
      const params = recipeParams(id);
      agent("planner", "done", `配方 ${r.name} · 速度 ${Math.round(S.analysis.bpm * params.tempoRatio)} BPM`);
      await produce({ recipeId: id, planner: "RECIPE · 确定性配方", title: `${r.name} · ${r.cn}`, summary: `在原曲 ${S.analysis.bpm} BPM、${S.analysis.key} ${S.analysis.mode === "minor" ? "小调" : "大调"} 的基础上套用 ${r.name} 配方，锁定的参数保持不动。` }, params);
      agent("orchestrator", "done", "完成 · 切到 B 试听");
      setStatus(`${r.name} 方向已渲染。按 A / B 对比原曲，或在下方继续调参数。`);
    } catch (err) {
      agent("orchestrator", "error", "渲染失败"); agent("producer", "error", err.message); setStatus("渲染失败：" + err.message);
    } finally { S.busy = false; updateButtons(); }
  }

  async function runIntent() {
    const intent = ui.intent.value.trim();
    if (!intent) { setStatus("先写一句你想要的感觉，比如「做成适合 vlog 的轻松 lo-fi」。"); ui.intent.focus(); return; }
    if (S.busy || !S.stems) return;
    S.busy = true; updateButtons();
    try {
      agent("orchestrator", "run", "意图 → 方案 → 渲染");
      let res, source;
      if (S.sample) {
        agent("planner", "run", "Claude 正在构思方案…");
        try { res = await claudePlanner(intent); source = "CLAUDE · AI Planner"; }
        catch (err) {
          if (err && (err.code === "not_granted" || err.code === "unavailable")) { S.sample = null; updateBadge(); }
          agent("planner", "run", "Claude 暂不可用，改用本地规则");
          res = localPlanner(intent); source = "LOCAL RULES · 本地规则（Claude 不可用）";
        }
      } else {
        agent("planner", "run", "本地规则解析意图…");
        res = localPlanner(intent); source = "LOCAL RULES · 本地规则";
      }
      agent("planner", "done", `${RECIPE[res.recipe].name} 为底 · ${res.title}`);
      await produce({ recipeId: res.recipe, planner: source, title: res.title, summary: res.summary, reasons: res.reasons }, res.params);
      agent("orchestrator", "done", "完成 · 切到 B 试听");
      setStatus("AI 方案已渲染。下方列出了每一处修改和原因；不满意的参数可以直接拖动接管。");
    } catch (err) {
      agent("orchestrator", "error", "失败"); agent("producer", "error", err.message); setStatus("生成失败：" + err.message);
    } finally { S.busy = false; updateButtons(); }
  }

  async function rerender() {
    if (S.busy || !S.stems) return;
    S.busy = true; updateButtons();
    try {
      agent("orchestrator", "run", "按你的修改重新渲染");
      S.plan.gridMult = gridFor(S.plan.beat, S.analysis.bpm * S.plan.tempoRatio);
      if (!String(S.planner || "").includes("手动")) S.planner = `${S.planner || "MANUAL"} + 手动接管`;
      S.remix = await renderRemix();
      S.dirty = false;
      agent("producer", "done", `${fmtTime(S.remix.duration)} · 已渲染`);
      agent("orchestrator", "done", "完成");
      syncParams(); setMode("B", false); drawAll();
      setStatus("已按你的参数重新渲染。");
    } catch (err) { agent("producer", "error", err.message); setStatus("渲染失败：" + err.message); }
    finally { S.busy = false; updateButtons(); }
  }

  function updateButtons() {
    const ready = !!S.stems && !S.busy;
    ui.ask.disabled = !ready;
    ui.render.disabled = !ready || !S.dirty;
    ui.reset.disabled = S.busy || !S.analysis;
    document.querySelectorAll(".bx-recipe").forEach((b) => { b.disabled = !ready; });
    document.querySelectorAll(".bx-solo").forEach((b) => { b.disabled = !S.stems || S.busy; });
    ui.drop.disabled = S.busy; ui.demo.disabled = S.busy;
    ui.exportMix.disabled = !S.remix || S.busy;
    ui.exportStems.disabled = !S.stems || S.busy;
    ui.ab.querySelector('[data-ab="B"]').disabled = !S.remix;
    document.getElementById("studio").classList.toggle("is-busy", S.busy);
  }
  function updateBadge() {
    ui.badge.textContent = S.sample ? "PLANNER · CLAUDE" : "PLANNER · 本地规则";
    ui.badge.classList.toggle("is-on", !!S.sample);
  }

  /* ---------------- DNA panel ---------------- */
  function renderDNA() {
    const a = S.analysis;
    ui.bpm.textContent = Math.round(a.bpm);
    ui.key.textContent = a.key;
    ui.mode.textContent = a.mode === "minor" ? "MINOR" : "MAJOR";
    ui.energy.textContent = a.energy;
    ui.loud.textContent = a.loudnessDb.toFixed(1);
    ui.moods.innerHTML = a.moods.map((m) => `<b>${m}</b>`).join("");
    ui.conf.textContent = `调性可信度 ${Math.round(a.keyConfidence * 100)}% · 节奏可信度 ${Math.round(a.tempoConfidence * 100)}% · 亮度 ${a.centroid} Hz · 段落 ${a.sections.map((s) => s.label).join(" / ")}`;
    syncParams();
  }

  /* ---------------- player ---------------- */
  const player = { ctx: null, src: null, startCtx: 0, offset: 0, playing: false, raf: 0 };
  function currentBuffer() {
    if (S.mode === "B" && S.remix) return S.remix;
    if (S.mode.startsWith("stem:") && S.stems) {
      const id = S.mode.slice(5);
      if (!S._stemBufs) S._stemBufs = {};
      if (!S._stemBufs[id] || S._stemBufs[id]._src !== S.stems[id][0]) {
        const b = new AudioBuffer({ length: S.stems[id][0].length, numberOfChannels: 2, sampleRate: S.stemSR });
        b.copyToChannel(S.stems[id][0], 0); b.copyToChannel(S.stems[id][1], 1);
        b._src = S.stems[id][0];
        S._stemBufs[id] = b;
      }
      return S._stemBufs[id];
    }
    return S.original;
  }
  function position() {
    const b = currentBuffer();
    if (!b) return 0;
    return player.playing ? Math.min(b.duration, player.offset + (player.ctx.currentTime - player.startCtx)) : player.offset;
  }
  function stopPlayer() {
    if (player.src) { player.src.onended = null; try { player.src.stop(); } catch (_) {} player.src.disconnect(); player.src = null; }
    if (player.playing) player.offset = position();
    player.playing = false;
    ui.play.textContent = "▶";
    cancelAnimationFrame(player.raf);
    drawMain();
  }
  function startPlayer() {
    const b = currentBuffer();
    if (!b) return;
    if (!player.ctx) player.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (player.ctx.state === "suspended") player.ctx.resume();
    if (player.offset >= b.duration - 0.05) player.offset = 0;
    const src = player.ctx.createBufferSource();
    src.buffer = b; src.connect(player.ctx.destination);
    src.onended = () => { if (player.src === src) { player.playing = false; player.offset = 0; player.src = null; ui.play.textContent = "▶"; drawMain(); } };
    src.start(0, player.offset);
    player.src = src; player.startCtx = player.ctx.currentTime; player.playing = true;
    ui.play.textContent = "Ⅱ";
    const tick = () => { drawMain(); if (player.playing) player.raf = requestAnimationFrame(tick); };
    tick();
  }
  function setMode(mode, autoplay) {
    const wasPlaying = player.playing;
    const prevBuf = currentBuffer();
    const frac = prevBuf ? position() / prevBuf.duration : 0;
    stopPlayer();
    S.mode = mode;
    const b = currentBuffer();
    player.offset = b ? clamp(frac, 0, 1) * b.duration : 0;
    ui.ab.querySelectorAll("[data-ab]").forEach((x) => x.classList.toggle("active", x.dataset.ab === mode));
    document.querySelectorAll("[data-solo]").forEach((x) => { const on = mode === "stem:" + x.dataset.solo; x.setAttribute("aria-pressed", on); x.textContent = on ? "■ 单听中" : "▶ 单听"; });
    const label = mode === "B" ? `正在听：B · ${S.title}` : mode.startsWith("stem:") ? `正在听：分离轨 · ${STEMS.find((s) => s.id === mode.slice(5)).cn}` : "正在听：A · 原曲";
    ui.now.textContent = label;
    if (wasPlaying || autoplay) startPlayer(); else drawMain();
  }
  ui.play.addEventListener("click", () => (player.playing ? stopPlayer() : startPlayer()));
  ui.ab.addEventListener("click", (e) => { const b = e.target.closest("[data-ab]"); if (b && !b.disabled) setMode(b.dataset.ab, false); });
  ui.wave.addEventListener("click", (e) => {
    const b = currentBuffer(); if (!b) return;
    const rect = ui.wave.getBoundingClientRect();
    const was = player.playing;
    stopPlayer();
    player.offset = clamp((e.clientX - rect.left) / rect.width, 0, 1) * b.duration;
    if (was) startPlayer(); else drawMain();
  });

  /* ---------------- drawing ---------------- */
  const peaksCache = new WeakMap();
  function peaks(chs, cols) {
    const key = chs[0];
    const hit = peaksCache.get(key);
    if (hit && hit.cols === cols) return hit.data;
    const len = chs[0].length, data = new Float32Array(cols * 2), per = len / cols;
    for (let c = 0; c < cols; c++) {
      let mn = 0, mx = 0;
      const a = Math.floor(c * per), b = Math.min(len, Math.floor((c + 1) * per));
      const stride = Math.max(1, Math.floor((b - a) / 200));
      for (let i = a; i < b; i += stride) for (const ch of chs) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      data[c * 2] = mn; data[c * 2 + 1] = mx;
    }
    peaksCache.set(key, { cols, data });
    return data;
  }
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function drawWave(canvas, chs, progress, color, dim) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!chs) { g.fillStyle = dim; g.fillRect(0, h / 2 - 0.5, w, 1); return; }
    const cols = Math.max(1, Math.floor(w / 3)), pk = peaks(chs, cols);
    let max = 0.01; for (let i = 0; i < pk.length; i++) max = Math.max(max, Math.abs(pk[i]));
    for (let c = 0; c < cols; c++) {
      const x = c * 3, top = h / 2 - (pk[c * 2 + 1] / max) * h * 0.46, bot = h / 2 - (pk[c * 2] / max) * h * 0.46;
      g.fillStyle = c / cols <= progress ? color : dim;
      g.fillRect(x, top, 2, Math.max(1, bot - top));
    }
  }
  function drawMain() {
    const b = currentBuffer();
    const acid = css("--acid") || "#d8ff37", dim = "rgba(241,239,230,.28)";
    drawWave(ui.wave, b ? Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i)) : null, b ? position() / b.duration : 0, acid, dim);
    ui.time.textContent = `${fmtTime(position())} / ${fmtTime(b ? b.duration : 0)}`;
  }
  function drawSections() {
    const a = S.analysis;
    if (!a) { ui.sections.innerHTML = ""; return; }
    ui.sections.innerHTML = a.sections.map((s) => `<span data-level="${s.level}" style="flex:${(s.end - s.start).toFixed(2)}">${s.label}</span>`).join("");
  }
  function drawStems() {
    const acid = css("--acid") || "#d8ff37";
    for (const s of STEMS) drawWave($("#bxSW-" + s.id), S.stems ? S.stems[s.id] : null, S.stems ? 1 : 0, s.id === "vocals" ? acid : "rgba(241,239,230,.75)", "rgba(241,239,230,.2)");
  }
  function drawAll() { drawMain(); drawSections(); drawStems(); updateButtons(); }
  window.addEventListener("resize", () => { drawMain(); drawStems(); });

  /* ---------------- export ---------------- */
  async function saveZip(filename, entries) {
    const blob = new Blob(DSP.makeZip(entries), { type: "application/zip" });
    if (S.downloads) {
      try { await S.downloads.save({ filename, data: blob }); ui.exportNote.textContent = `已导出 ${filename}`; }
      catch (err) {
        const msg = { declined: "你取消了这次下载。", rate_limited: "上一个下载确认还没处理完，稍等再试。", extension_not_enabled: "当前查看方式不支持下载 .zip 文件。", too_large: "文件太大，没法从这里下载。" }[err && err.code];
        ui.exportNote.textContent = msg || "当前查看方式不支持下载。";
      }
      return;
    }
    if (!S.inViewer) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      ui.exportNote.textContent = `已导出 ${filename}`;
      return;
    }
    ui.exportNote.textContent = "当前查看方式不支持下载，请登录 Claude 后打开这个页面再导出。";
  }
  const safeName = (s) => s.replace(/\.[a-z0-9]+$/i, "").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40) || "bgmmix";
  function planDoc() {
    const a = S.analysis;
    return JSON.stringify({
      format: "BGMMix RemixPlan v1", createdAt: new Date().toISOString(), source: S.name,
      analysis: { bpm: a.bpm, key: `${a.key} ${a.mode}`, energy: a.energy, loudnessDb: a.loudnessDb, moods: a.moods, sections: a.sections },
      direction: { title: S.title, summary: S.summary, recipe: S.recipeId, planner: S.planner },
      params: Object.fromEntries(PARAMS.map((p) => [p.key, S.plan[p.key]]).concat([["gridMult", S.plan.gridMult]])),
      locked: [...S.locks], changes: S.changes,
      engine: { renderer: "Web Audio OfflineAudioContext", stems: "BGMMix DSP lite separation", sampleRate: S.stemSR },
    }, null, 2);
  }
  ui.exportMix.addEventListener("click", async () => {
    if (!S.remix) return;
    ui.exportNote.textContent = "正在打包…";
    const wav = DSP.encodeWav([S.remix.getChannelData(0), S.remix.getChannelData(1)], S.remix.sampleRate);
    const base = `bgmmix-${safeName(S.name)}-${S.recipeId || "custom"}`;
    await saveZip(`${base}.zip`, [{ name: `${base}.wav`, data: wav }, { name: "remixplan.json", data: planDoc() }]);
  });
  ui.exportStems.addEventListener("click", async () => {
    if (!S.stems) return;
    ui.exportNote.textContent = "正在打包四轨…";
    const base = `bgmmix-${safeName(S.name)}-stems`;
    const entries = STEMS.map((s) => ({ name: `${base}/${s.id}.wav`, data: DSP.encodeWav(S.stems[s.id], S.stemSR) }));
    entries.push({ name: `${base}/analysis.json`, data: JSON.stringify(S.analysis, null, 2) });
    await saveZip(`${base}.zip`, entries);
  });

  /* ---------------- inputs ---------------- */
  ui.drop.addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) await handleFile(f); ui.file.value = ""; });
  ui.drop.addEventListener("dragover", (e) => { e.preventDefault(); ui.drop.classList.add("is-dragging"); });
  ui.drop.addEventListener("dragleave", () => ui.drop.classList.remove("is-dragging"));
  ui.drop.addEventListener("drop", async (e) => { e.preventDefault(); ui.drop.classList.remove("is-dragging"); const f = e.dataTransfer.files[0]; if (f) await handleFile(f); });
  async function handleFile(f) {
    if (f.type && !f.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|webm)$/i.test(f.name)) { setStatus("请选择音频文件（MP3、WAV、M4A、FLAC、OGG）。"); return; }
    await loadAudio(await f.arrayBuffer(), f.name);
  }
  ui.demo.addEventListener("click", () => loadDemo());
  document.querySelectorAll(".bx-recipe").forEach((b) => b.addEventListener("click", () => runRecipe(b.dataset.recipe)));
  ui.ask.addEventListener("click", runIntent);
  ui.intent.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runIntent(); });
  ui.render.addEventListener("click", rerender);
  ui.reset.addEventListener("click", () => {
    S.locks.clear();
    producerApply({ ...NEUTRAL }, { planner: "RESET", title: "原曲参数", summary: "所有参数回到原曲状态，锁定已清除。" });
    S.recipeId = null; S.dirty = !!S.remix; syncParams(); updateButtons();
  });

  /* ---------------- demo track ---------------- */
  async function synthDemo() {
    const sr = 44100, bpm = 92, beat = 60 / bpm, bar = beat * 4, bars = 16, dur = bars * bar + 1.2;
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    let seed = 9;
    const noise = ctx.createBuffer(1, sr, sr), nd = noise.getChannelData(0);
    for (let i = 0; i < sr; i++) nd[i] = ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    const melody = [[76, 74, 72, 74], [72, 72, 69, 72], [72, 74, 76, 79], [79, 77, 74, 71]];
    const part = (b) => (b < 4 ? "intro" : b < 12 ? "full" : b < 14 ? "break" : "full");
    const env = (g, t, a, hold, r, level) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + a); g.gain.setValueAtTime(level, t + a + hold); g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + r); };
    const pan = (p) => { const s = ctx.createStereoPanner(); s.pan.value = p; s.connect(master); return s; };
    const padL = pan(-0.8), padR = pan(0.8), arpL = pan(-0.45), arpR = pan(0.45);
    const padLp = [ctx.createBiquadFilter(), ctx.createBiquadFilter()];
    padLp.forEach((f, i) => { f.type = "lowpass"; f.frequency.value = 1500; f.connect(i ? padR : padL); });
    for (let b = 0; b < bars; b++) {
      const t0 = b * bar, ch = chords[b % 4], pt = part(b);
      for (const m of ch) for (const side of [0, 1]) {
        const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(m); o.detune.value = side ? 9 : -9;
        const g = ctx.createGain(); env(g, t0, 0.25, bar - 0.3, 0.35, 0.022);
        o.connect(g).connect(padLp[side]); o.start(t0); o.stop(t0 + bar + 0.4);
      }
      if (pt === "full") for (let i = 0; i < 8; i++) {
        const t = t0 + i * beat / 2, o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = hz(ch[i % 3] + 12);
        const g = ctx.createGain(); env(g, t, 0.005, 0.03, 0.2, 0.07);
        o.connect(g).connect(i % 2 ? arpR : arpL); o.start(t); o.stop(t + 0.3);
      }
      if (pt !== "intro") for (const [pos, len] of [[0, 1.3], [1.5, 0.4], [2, 0.9], [3, 0.8]]) {
        const t = t0 + pos * beat, o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(ch[0] - 24);
        const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 380;
        const g = ctx.createGain(); env(g, t, 0.01, len * beat * 0.7, 0.12, 0.42);
        o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + len * beat + 0.2);
      }
      for (let k = 0; k < 4; k++) {
        const t = t0 + k * beat;
        if (pt !== "break" && pt !== "intro" && (k === 0 || k === 2)) {
          const o = ctx.createOscillator(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
          const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
          o.connect(g).connect(master); o.start(t); o.stop(t + 0.4);
        }
        if (pt === "full" && (k === 1 || k === 3)) {
          const n = ctx.createBufferSource(); n.buffer = noise;
          const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1900; f.Q.value = 0.8;
          const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
          n.connect(f).connect(g).connect(master); n.start(t, (b * 0.07 + k * 0.11) % 0.5); n.stop(t + 0.2);
        }
        if (pt !== "break") for (const h of [0, 0.5]) {
          const th = t + h * beat, n = ctx.createBufferSource(); n.buffer = noise;
          const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 7500;
          const g = ctx.createGain(); g.gain.setValueAtTime(h ? 0.1 : 0.16, th); g.gain.exponentialRampToValueAtTime(0.001, th + 0.045);
          n.connect(f).connect(g).connect(master); n.start(th, (k * 0.1 + h) % 0.9); n.stop(th + 0.05);
        }
      }
      if (pt === "full") melody[b % 4].forEach((m, k) => {
        const t = t0 + k * beat, o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(m);
        const vib = ctx.createOscillator(); vib.frequency.value = 5.4; const vg = ctx.createGain(); vg.gain.value = 18; vib.connect(vg).connect(o.detune);
        const g = ctx.createGain(); env(g, t, 0.05, beat * 0.78, 0.1, 0.55);
        const sum = ctx.createGain(); sum.gain.value = 1;
        for (const [f0, q, lv] of [[800, 6, 1], [1150, 8, 0.6], [2900, 10, 0.3]]) { const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = f0; f.Q.value = q; const fg = ctx.createGain(); fg.gain.value = lv; o.connect(f).connect(fg).connect(sum); }
        sum.connect(g).connect(master);
        o.start(t); vib.start(t); o.stop(t + beat + 0.2); vib.stop(t + beat + 0.2);
      });
    }
    const out = await ctx.startRendering();
    return DSP.encodeWav([out.getChannelData(0), out.getChannelData(1)], sr);
  }
  async function loadDemo() {
    if (S.busy) return;
    setStatus("正在生成示例曲…");
    const wav = await synthDemo();
    await loadAudio(wav, "midnight-humming-demo.wav");
  }

  /* ---------------- capabilities + boot ---------------- */
  updateBadge();
  syncParams();
  drawAll();
  if (S.inViewer) {
    window.claude.use("sample").then((s) => { S.sample = s; updateBadge(); }).catch(() => {});
    window.claude.use("downloads").then((d) => { S.downloads = d; }).catch(() => {});
  }
  window.BGMMixStudio = { state: S, loadAudio, runRecipe, runIntent, rerender, localPlanner, producerApply };
  loadDemo();
})();
