(() => {
  // Toggle if already injected
  if (window.__GF_PIPE_UI__) {
    window.__GF_PIPE_UI__.toggle();
    return;
  }

  const STORAGE_KEY = "__GF_PANEL_STATE_V1__";
  const MIN_W = 420;
  const MIN_H = 220;

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  // -------- pipeline parsing helpers (for highlighting) --------
  function splitPipes(s) {
    const parts = [];
    let cur = "", q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === q) { q = null; cur += ch; continue; }
        cur += ch; continue;
      }
      if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
      if (ch === "|") { parts.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function tokenize(s) {
    const out = [];
    let cur = "", q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === q) { q = null; continue; }
        if (q === '"' && ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
        cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') { q = ch; continue; }
      if (/\s/.test(ch)) { if (cur) out.push(cur), cur = ""; continue; }
      if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  function escapeRegexLiteral(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function gfSendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          const err = chrome.runtime.lastError && chrome.runtime.lastError.message;
          if (err) return resolve({ error: err });
          resolve(resp);
        });
      } catch (e) {
        resolve({ error: String(e && (e.message || e) || e) });
      }
    });
  }

  function safeMakeRegex(src, flags) {
    try {
      const re = new RegExp(src, flags);
      // avoid pathological "matches empty string" patterns
      re.lastIndex = 0;
      const m = re.exec("");
      if (m && (m[0] ?? "").length === 0) return null;
      return re;
    } catch {
      return null;
    }
  }

  function buildHighlightRegexesFromAllGreps(cmd) {
    const stages = splitPipes(cmd).map(tokenize);
    const regexes = [];

    for (const st of stages) {
      if (st[0] !== "grep") continue;

      let ignoreCase = false;
      let fixed = false;
      let word = false;
      let wholeLine = false;

      let pattern = "";

      // first non-flag token is pattern (same assumption as your pipeline engine)
      for (let i = 1; i < st.length; i++) {
        const t = st[i];

        if (t === "-i") { ignoreCase = true; continue; }
        if (t === "-F") { fixed = true; continue; }
        if (t === "-w") { word = true; continue; }
        if (t === "-x") { wholeLine = true; continue; }

        // skip flags that take numeric arg
        if (t === "-m" || t === "-A" || t === "-B" || t === "-C") { i++; continue; }
        if (/^-m\d+$/.test(t) || /^-A\d+$/.test(t) || /^-B\d+$/.test(t) || /^-C\d+$/.test(t)) continue;

        // ignore -n -v -o -c -E and other flags; they don't affect highlight match-set here
        if (t.startsWith("-")) continue;

        if (!pattern) { pattern = t; break; }
      }

      if (!pattern) continue;

      // Safety cap (still "all greps", but prevents a single gigantic regex from freezing rendering)
      if (pattern.length > 1200) continue;

      let src = fixed ? escapeRegexLiteral(pattern) : pattern;
      if (word) src = `\\b(?:${src})\\b`;
      if (wholeLine) src = `^(?:${src})$`;

      const flags = ignoreCase ? "gim" : "gm";
      const re = safeMakeRegex(src, flags);
      if (re) regexes.push(re);
    }

    return regexes.length ? regexes : null;
  }

  // Build intervals for all regex matches, merge, then wrap.
  function highlightLineWithRegexes(raw, regexes) {
    if (!regexes || !regexes.length) return escapeHtml(raw);

    const intervals = [];

    for (const re of regexes) {
      re.lastIndex = 0;

      let m;
      let guard = 0;
      while ((m = re.exec(raw)) !== null) {
        const hit = m[0] ?? "";
        if (!hit.length) break;

        const start = m.index;
        const end = start + hit.length;
        intervals.push([start, end]);

        // guard against infinite loops / catastrophic behavior
        if (re.lastIndex < end) re.lastIndex = end;
        guard++;
        if (guard > 2000) break;
      }
    }

    if (!intervals.length) return escapeHtml(raw);

    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    // merge overlaps
    const merged = [];
    let [cs, ce] = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      const [s, e] = intervals[i];
      if (s <= ce) {
        ce = Math.max(ce, e);
      } else {
        merged.push([cs, ce]);
        cs = s; ce = e;
      }
    }
    merged.push([cs, ce]);

    // render
    let out = "";
    let last = 0;
    for (const [s, e] of merged) {
      out += escapeHtml(raw.slice(last, s));
      out += `<span class="gf_hl">${escapeHtml(raw.slice(s, e))}</span>`;
      last = e;
    }
    out += escapeHtml(raw.slice(last));
    return out;
  }

  function renderOutput(outputText, cmdForHighlight) {
    const regexes = buildHighlightRegexesFromAllGreps(cmdForHighlight);
    const lines = String(outputText || "").split("\n");

    return lines.map(line => {
      // Preserve "123:" line-number prefix (don’t highlight inside it)
      const m = line.match(/^(\d+:)(.*)$/);
      if (!m) return highlightLineWithRegexes(line, regexes);
      const prefix = escapeHtml(m[1]);
      const rest = m[2] ?? "";
      return `${prefix}${highlightLineWithRegexes(rest, regexes)}`;
    }).join("\n");
  }

  // -------- UI --------
  const panel = document.createElement("div");
  panel.id = "gf-host";
  panel.setAttribute("data-findpp", "1");
  panel.style.cssText = `
    position:fixed;
    left:12px; top:12px;
    z-index:2147483647;
    width:min(980px, calc(100vw - 24px));
    height:min(72vh, 560px);
    background:#111; color:#eee;
    border:1px solid #444; border-radius:10px;
    box-shadow:0 10px 30px rgba(0,0,0,.45);
    overflow:hidden;
    font-family:ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    display:flex; flex-direction:column;
  `;

  panel.innerHTML = `
    <style>
      .gf_hl { color:#ff4d4d; font-weight:700; }
    </style>

    <div id="gf_header" style="display:flex; gap:8px; padding:10px; border-bottom:1px solid #333; align-items:center; cursor:move; user-select:none;">
      <div style="font-size:13px; opacity:.9; white-space:nowrap;">Find++</div>

      <label style="display:flex; align-items:center; gap:6px; margin-left:10px; font-size:11px; opacity:.9;">
        <span style="opacity:.8;">Mode</span>
        <select id="gf_mode" style="padding:6px 8px; border-radius:8px; border:1px solid #333; background:#0c0c0c; color:#eee; cursor:pointer;">
          <option value="hybrid" selected>Hybrid</option>
          <option value="pipeline">Pipeline</option>
          <option value="highlight">Highlight</option>
        </select>
      </label>

      <div style="margin-left:auto; display:flex; gap:8px;">
        <button id="gf_prev" title="Prev match (Highlight mode)" style="padding:7px 10px; border-radius:8px; border:1px solid #333; background:#222; color:#eee; cursor:pointer;">Prev</button>
        <button id="gf_next" title="Next match (Highlight mode)" style="padding:7px 10px; border-radius:8px; border:1px solid #333; background:#222; color:#eee; cursor:pointer;">Next</button>
        <button id="gf_clear" title="Clear highlights (Highlight mode)" style="padding:7px 10px; border-radius:8px; border:1px solid #333; background:#222; color:#eee; cursor:pointer;">Clear</button>
        <button id="gf_run" style="padding:7px 10px; border-radius:8px; border:1px solid #333; background:#222; color:#eee; cursor:pointer;">Run</button>
        <button id="gf_x" style="padding:7px 10px; border-radius:8px; border:1px solid #333; background:#222; color:#eee; cursor:pointer;">✕</button>
      </div>
    </div>

    <div style="padding:10px; border-bottom:1px solid #222;">
      <textarea id="gf_cmd" spellcheck="false" style="
        width:100%; height:92px; resize:vertical;
        padding:10px; border-radius:10px; border:1px solid #333;
        background:#0c0c0c; color:#eee; font-size:12px; line-height:1.35;
      "></textarea>
      <div id="gf_hint" style="margin-top:8px; font-size:11px; opacity:.85;">
        Enter runs. Shift+Enter newline. Drag header to move. Drag corner to resize. Esc hides.
        <br/>Modes: <b>Pipeline</b>=extract+grep with context. <b>Highlight</b>=on-page highlight (regex-capable, limited). <b>Hybrid</b>=Pipeline output + on-page highlight.
      <div id="gf_tzbar" style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; font-size:11px;">
  <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
    <input id="gf_tz_on" type="checkbox" style="transform:translateY(1px);" />
    <span style="opacity:.9;">Convert timestamps</span>
  </label>

  <span style="opacity:.75;">QKView TZ</span>
  <input id="gf_tz_from" list="gf_tz_list" placeholder="Etc/UTC" style="width:190px; padding:6px 8px; border-radius:8px; border:1px solid #333; background:#0c0c0c; color:#eee;" />

  <span style="opacity:.85;">→</span>

  <span style="opacity:.75;">Display TZ</span>
  <input id="gf_tz_to" list="gf_tz_list" placeholder="America/Los_Angeles" style="width:210px; padding:6px 8px; border-radius:8px; border:1px solid #333; background:#0c0c0c; color:#eee;" />

  <button id="gf_tz_swap" title="Swap" style="padding:6px 9px; border-radius:8px; border:1px solid #333; background:#222; color:#eee; cursor:pointer;">⇄</button>

  <span id="gf_tz_status" style="margin-left:auto; opacity:.7;"></span>

  <datalist id="gf_tz_list">
    <option value="Etc/UTC"></option>
    <option value="GMT"></option>
    <option value="UTC"></option>
    <option value="America/Los_Angeles"></option>
    <option value="America/New_York"></option>
    <option value="America/Chicago"></option>
    <option value="Europe/London"></option>
    <option value="Europe/Paris"></option>
    <option value="Asia/Tokyo"></option>
    <option value="Australia/Sydney"></option>
  </datalist>
</div>

</div>
    </div>

    <div id="gf_meta" style="padding:8px 10px; border-bottom:1px solid #222; font-size:12px; opacity:.9;"></div>
    <pre id="gf_out" style="margin:0; padding:10px; overflow:auto; flex:1; white-space:pre; font-size:12px; line-height:1.35;"></pre>

    <div id="gf_resize" title="Resize" style="
      position:absolute; right:6px; bottom:6px;
      width:14px; height:14px;
      border-right:2px solid #666; border-bottom:2px solid #666;
      cursor:nwse-resize; opacity:.9;
    "></div>
  `;

  document.documentElement.appendChild(panel);

  const $ = (sel) => panel.querySelector(sel);
  const header = $("#gf_header");
  const resizeHandle = $("#gf_resize");
  const cmdBox = $("#gf_cmd");
  const meta = $("#gf_meta");
  const out = $("#gf_out");
  const modeSel = $("#gf_mode");
  const btnPrev = $("#gf_prev");
  const btnNext = $("#gf_next");
  const btnClear = $("#gf_clear");

// --- timezone settings (persisted in chrome.storage.sync) ---
const tzOn = $("#gf_tz_on");
const tzFrom = $("#gf_tz_from");
const tzTo = $("#gf_tz_to");
const tzSwap = $("#gf_tz_swap");
const tzStatus = $("#gf_tz_status");

const TZ_DEFAULTS = (() => {
  let localTz = "Etc/UTC";
  try { localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC"; } catch {}
  return { tzEnabled: true, tzFrom: "Etc/UTC", tzTo: localTz };
})();

async function loadTzSettings() {
  try {
    const cfg = await chrome.storage.sync.get(TZ_DEFAULTS);
    tzOn.checked = !!cfg.tzEnabled;
    tzFrom.value = cfg.tzFrom || "Etc/UTC";
    tzTo.value = cfg.tzTo || TZ_DEFAULTS.tzTo;
    tzStatus.textContent = `Using: ${tzFrom.value} → ${tzTo.value}`;
  } catch {
    tzOn.checked = !!TZ_DEFAULTS.tzEnabled;
    tzFrom.value = TZ_DEFAULTS.tzFrom;
    tzTo.value = TZ_DEFAULTS.tzTo;
    tzStatus.textContent = `Using: ${tzFrom.value} → ${tzTo.value}`;
  }
}

let tzSaveTimer = null;
function scheduleTzSave() {
  if (tzSaveTimer) clearTimeout(tzSaveTimer);
  tzSaveTimer = setTimeout(async () => {
    const cfg = {
      tzEnabled: !!tzOn.checked,
      tzFrom: (tzFrom.value || "").trim() || "Etc/UTC",
      tzTo: (tzTo.value || "").trim() || TZ_DEFAULTS.tzTo
    };
    try {
      await chrome.storage.sync.set(cfg);
      tzStatus.textContent = `Using: ${cfg.tzFrom} → ${cfg.tzTo}${cfg.tzEnabled ? "" : " (off)"}`;
    } catch {
      tzStatus.textContent = `Using: ${cfg.tzFrom} → ${cfg.tzTo}${cfg.tzEnabled ? "" : " (off)"} (not saved)`;
    }
  }, 150);
}

tzOn.addEventListener("change", scheduleTzSave);
tzFrom.addEventListener("input", scheduleTzSave);
tzTo.addEventListener("input", scheduleTzSave);

tzSwap.addEventListener("click", () => {
  const a = tzFrom.value;
  tzFrom.value = tzTo.value;
  tzTo.value = a;
  scheduleTzSave();
});

loadTzSettings();


  cmdBox.value = "grep -n -i -m 50 'error|failed|timeout|denied'";

  // Persist mode in localStorage
  try {
    const st2 = loadState();
    if (st2 && typeof st2 === "object" && st2.mode) modeSel.value = st2.mode;
  } catch {}

  modeSel.addEventListener("change", () => {
    try {
      const st2 = loadState() || {};
      st2.mode = modeSel.value;
      saveState(st2);
    } catch {}

    // Avoid stale highlights when switching modes.
    if (modeSel.value === "pipeline") {
      runHighlight("clear").catch(() => {});
      lastFindMeta = "";
      updateMeta();
    }
  });

  // Apply persisted size/position if present
  const st = loadState();
  if (st && typeof st === "object") {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (Number.isFinite(st.w) && Number.isFinite(st.h)) {
      const w = clamp(st.w, MIN_W, vw - 10);
      const h = clamp(st.h, MIN_H, vh - 10);
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
    }

    if (Number.isFinite(st.x) && Number.isFinite(st.y)) {
      const rect = panel.getBoundingClientRect();
      const x = clamp(st.x, 0, vw - rect.width);
      const y = clamp(st.y, 0, vh - rect.height);
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    }
  }

  function persistPanelRect() {
    const r = panel.getBoundingClientRect();
    saveState({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }

  // ---- Find (browser highlight) helpers ----
  function extractHighlightSpec(cmd) {
    const stages = splitPipes(cmd).map(tokenize);

    function extractDelimitedRegex(input) {
      if (!input) return null;
      const s = String(input);
      let start = -1;
      let escaped = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === "/") { start = i; break; }
      }
      if (start < 0) return null;
      escaped = false;
      for (let i = start + 1; i < s.length; i++) {
        const ch = s[i];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === "/") {
          return {
            body: s.slice(start + 1, i),
            suffix: s.slice(i + 1)
          };
        }
      }
      return null;
    }

    function parseGrepStage(st) {
      let ignoreCase = false;
      let fixed = false;
      let pattern = "";

      for (let i = 1; i < st.length; i++) {
        const t = st[i];
        if (t && t.startsWith("-")) {
          if (t.includes("i")) ignoreCase = true;
          if (t.includes("F")) fixed = true;
          continue;
        }
        if (!pattern) pattern = t;
      }

      pattern = String(pattern || "").trim();
      if (!pattern) return null;

      const src = fixed ? escapeRegexLiteral(pattern) : pattern;
      const flags = ignoreCase ? "gim" : "gm";
      return { src, flags, rawPattern: pattern, fixed, ignoreCase };
    }

    function parseAwkStage(st) {
      const program = st.slice(1).find(t => t && !t.startsWith("-"));
      const del = extractDelimitedRegex(program);
      if (!del || !del.body) return null;
      const src = del.body;
      return { src, flags: "gm", rawPattern: del.body, fixed: false, ignoreCase: false };
    }

    function parseSedStage(st) {
      const script = st.slice(1).find(t => t && !t.startsWith("-"));
      if (!script) return null;

      const sub = script.match(/^s(.)(.+?)\1(.*?)\1([gimI]*)$/);
      if (sub) {
        const flags = /i|I/.test(sub[4]) ? "gim" : "gm";
        return { src: sub[2], flags, rawPattern: sub[2], fixed: false, ignoreCase: /i|I/.test(sub[4]) };
      }

      const del = extractDelimitedRegex(script);
      if (!del || !del.body) return null;
      const ignoreCase = /i|I/.test(del.suffix || "");
      const flags = ignoreCase ? "gim" : "gm";
      return { src: del.body, flags, rawPattern: del.body, fixed: false, ignoreCase };
    }

    const stageParsers = {
      grep: parseGrepStage,
      rg: parseGrepStage,
      awk: parseAwkStage,
      gawk: parseAwkStage,
      sed: parseSedStage
    };

    // Try to derive pattern from the last matching stage (grep/awk/sed)
    for (let si = stages.length - 1; si >= 0; si--) {
      const st = stages[si];
      if (!st?.length) continue;
      const parser = stageParsers[st[0]];
      if (!parser) continue;
      const spec = parser(st);
      if (spec?.src) return spec;
    }

    // If user typed a single token (no pipeline), treat it as a literal
    const single = String(cmd || "").trim();
    if (single && single.length <= 120 && !/\s/.test(single)) {
      return { src: escapeRegexLiteral(single), flags: "gm", rawPattern: single, fixed: true, ignoreCase: false };
    }

    return null;
  }


  let lastPipelineMeta = "";
  let lastFindMeta = "";
  function updateMeta() {
    meta.textContent = [lastPipelineMeta, lastFindMeta].filter(Boolean).join(" | ");
  }

  async function runHighlight(action, cmdForRun, noteTag = "") {
    try {
      if (action === "run") {
        const spec = extractHighlightSpec(cmdForRun);
        if (!spec?.src) {
          lastFindMeta = "Highlight: no pattern (use a grep stage like: grep -i <text>)";
          updateMeta();
          return;
        }

        const res = await gfSendMessage({
          type: "GF_HIGHLIGHT",
          action: "run",
          spec: { src: spec.src, flags: spec.flags, raw: spec.rawPattern || spec.src }
        });

        if (res?.error) {
          lastFindMeta = `Highlight error: ${res.error}`;
          updateMeta();
          return;
        }

        const count = Number(res.count || 0);
        const active = Number(res.active || 0);
        const partial = res.partial ? " (partial)" : "";
        const note = noteTag ? ` ${noteTag}` : "";

        const kind = res.kind ? ` [${res.kind}]` : "";
        lastFindMeta = `Highlight: ${count} match(es), active ${active}/${count}${partial}${kind}${note}`;
        updateMeta();
        return;
      }

      if (action === "clear") {
        const res = await gfSendMessage({ type: "GF_HIGHLIGHT", action: "clear" });
        if (res?.error) lastFindMeta = `Highlight error: ${res.error}`;
        else lastFindMeta = "Highlight: cleared";
        updateMeta();
        return;
      }

      if (action === "next" || action === "prev") {
        const res = await gfSendMessage({ type: "GF_HIGHLIGHT", action });
        if (res?.error) {
          lastFindMeta = `Highlight error: ${res.error}`;
          updateMeta();
          return;
        }
        const count = Number(res.count || 0);
        const active = Number(res.active || 0);
        const kind = res.kind ? ` [${res.kind}]` : "";
        const partial = res.partial ? " (partial)" : "";
        lastFindMeta = `Highlight: ${count} match(es), active ${active}/${count}${partial}${kind}`;
        updateMeta();
        return;
      }
    } catch (e) {
      lastFindMeta = `Highlight error: ${String(e && e.message ? e.message : e)}`;
      updateMeta();
    }
  }


  async function run() {
    try {
    const cmd = String(cmdBox.value || "").trim();
    if (!cmd) return;

    const mode = String(modeSel?.value || "hybrid");
    lastPipelineMeta = "";
    if (mode === "pipeline") lastFindMeta = ""; // don't show stale find status in pipeline-only mode
    updateMeta();

    // Highlight-only mode: use on-page highlight and skip pipeline
    if (mode === "highlight") {
      meta.textContent = "Highlighting…";
      out.textContent = "";
      await runHighlight("run", cmd);
      return;
    }

    // Pipeline or Hybrid
    meta.textContent = "Running…";
    out.textContent = "";

    const res = await gfSendMessage({
      type: "GF_PIPELINE",
      cmd,
      caps: { maxOutputLines: 2000, previewChars: 200000 }
    });

    if (res?.error) {
      lastPipelineMeta = `Pipeline error: ${res.error}`;
      updateMeta();
      // In hybrid, still attempt browser-find
      if (mode === "hybrid") await runHighlight("run", cmd);
      return;
    }

    const src = res.sourceKind ? `Source: ${res.sourceKind}${res.sourceDetail ? ` (${res.sourceDetail})` : ''}${res.sourcePartial ? ' [partial]' : ''}` : 'Source: ?';
    const model = res.modelUri ? ` | ${res.modelUri}` : "";
    lastPipelineMeta = `${src} | Matches: ${res.matchLineCount ?? "?"} | Shown: ${res.shownLines ?? "?"} | Total: ${res.totalLines ?? "?"}${model}`;
    updateMeta();

    // Render with highlight (avoid hard crash if a page blocks innerHTML)
    try {
      out.innerHTML = renderOutput(res.output || "", cmd);
    } catch (e) {
      out.textContent = res.output || "";
      lastPipelineMeta = `Render error: ${String(e && e.message ? e.message : e)}`;
      updateMeta();
    }

    // Hybrid: keep pipeline output *and* highlight on the page (Ctrl+F-like behavior).
    if (mode === "hybrid") {
      await runHighlight("run", cmd, "[hybrid]");
    }
    } catch (e) {
      // Surface runtime errors in the panel meta so failures aren't "console only"
      lastPipelineMeta = `Runtime error: ${String(e && e.message ? e.message : e)}`;
      updateMeta();
      try { console.error("[Find++] runtime error", e); } catch {}
    }
  }

  $("#gf_run").addEventListener("click", run);
  $("#gf_x").addEventListener("click", () => (panel.style.display = "none"));

  btnPrev?.addEventListener("click", () => runHighlight("prev"));
  btnNext?.addEventListener("click", () => runHighlight("next"));
  btnClear?.addEventListener("click", () => runHighlight("clear"));

  // Enter runs; Shift+Enter inserts newline
  cmdBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run();
      return;
    }
    if (e.key === "Escape") panel.style.display = "none";
  });

  // Drag to move (header)
  header.addEventListener("pointerdown", (e) => {
    // Allow interacting with controls in the header (mode dropdown, buttons)
    if (e.target?.closest?.("button, select, option, input, textarea, label, a")) return;

    e.preventDefault();
    header.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startY = e.clientY;
    const r = panel.getBoundingClientRect();
    const origLeft = r.left;
    const origTop = r.top;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const newLeft = clamp(origLeft + dx, 0, vw - r.width);
      const newTop = clamp(origTop + dy, 0, vh - r.height);

      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
    }

    function onUp() {
      header.releasePointerCapture(e.pointerId);
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
      header.removeEventListener("pointercancel", onUp);
      persistPanelRect();
    }

    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
    header.addEventListener("pointercancel", onUp);
  });

  // Drag corner to resize
  resizeHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizeHandle.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startY = e.clientY;
    const r = panel.getBoundingClientRect();
    const origW = r.width;
    const origH = r.height;
    const origLeft = r.left;
    const origTop = r.top;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const maxW = Math.max(MIN_W, vw - origLeft - 6);
      const maxH = Math.max(MIN_H, vh - origTop - 6);

      const newW = clamp(origW + dx, MIN_W, maxW);
      const newH = clamp(origH + dy, MIN_H, maxH);

      panel.style.width = `${Math.round(newW)}px`;
      panel.style.height = `${Math.round(newH)}px`;
    }

    function onUp() {
      resizeHandle.releasePointerCapture(e.pointerId);
      resizeHandle.removeEventListener("pointermove", onMove);
      resizeHandle.removeEventListener("pointerup", onUp);
      resizeHandle.removeEventListener("pointercancel", onUp);
      persistPanelRect();
    }

    resizeHandle.addEventListener("pointermove", onMove);
    resizeHandle.addEventListener("pointerup", onUp);
    resizeHandle.addEventListener("pointercancel", onUp);
  });

  // Keep panel on-screen if viewport changes
  window.addEventListener("resize", () => {
    const vw = window.innerWidth;
    const r = panel.getBoundingClientRect();

    const left = clamp(r.left, 0, vw - r.width);
    const top = clamp(r.top, 0, window.innerHeight - r.height);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    persistPanelRect();
  });

  window.__GF_PIPE_UI__ = {
    toggle() {
      panel.style.display = (panel.style.display === "none") ? "flex" : "none";
      if (panel.style.display !== "none") cmdBox.focus();
    }
  };

  cmdBox.focus();
})();
