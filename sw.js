async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isInjectableUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
  } catch {
    return false;
  }
}

async function ensureUI(tabId) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ["content.css"]
    });
  } catch {
    // ignore: some pages/frames may reject CSS injection
  }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"]
  });
}
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isInjectableUrl(tab.url || "")) return;
  await ensureUI(tab.id);
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "toggle-findpp") return;
  const tab = await getActiveTab();
  if (!tab?.id || !isInjectableUrl(tab.url || "")) return;
  await ensureUI(tab.id);
});


// ---------- On-page highlight (DOM-based; works on most pages) ----------
const __GF_HL_STATE__ = new Map(); // tabId -> { frameId, spec }
const __GF_PIPE_STATE__ = new Map(); // tabId -> { frameId } (last pipeline-selected frame)

function __gf_hl_page(action, spec, opts) {
  // Runs in the page context (isolated world).
  // Two engines:
  //  - DOM engine: wraps Text-node matches in <span class="gfpp-mark">
  //  - Textarea engine: for viewers that render content in a <textarea> (selection-based navigation)
  const MARK_CLASS = "gfpp-mark";
  const ACTIVE_CLASS = "gfpp-active";
  const SKIP_SELECTOR = "#gf-host, #gf_panel, #gf_header, #gf_cmd"; // panel + children
  const MAX_TEXT_NODES = (opts && opts.maxTextNodes) || 60000;
  const MAX_MARKS = (opts && opts.maxMarks) || 5000;

  function ensureStyle() {
    const styleId = "__gfpp_hl_style__";
    try {
      if (document.getElementById(styleId)) return;
      const st = document.createElement("style");
      st.id = styleId;
      st.textContent =
        `.${MARK_CLASS}{background:rgba(255,215,0,0.35); outline:1px solid rgba(255,215,0,0.65); border-radius:2px; padding:0 1px;} ` +
        `.${MARK_CLASS}.${ACTIVE_CLASS}{outline:2px solid rgba(255,0,0,0.85); background:rgba(255,99,71,0.35);} ` +
        `.gfpp-monaco-mark{background:rgba(255,215,0,0.35);} ` +
        `.gfpp-monaco-mark.gfpp-monaco-active{outline:2px solid rgba(255,0,0,0.85); background:rgba(255,99,71,0.35);}`;
      (document.head || document.documentElement).appendChild(st);
    } catch {}
  }

  const state = (window.__GFPP_HL_STATE__ ||= { kind: "dom", marks: [], active: -1, spec: null, ta: null, taMatches: [], wfText: null, wfCaseSensitive: true, wfFound: false, monacoEditor: null, monacoDecIds: [], monacoMatches: [], monacoPartial: false });

  function safeMakeRegex(src, flags) {
    try {
      const f = String(flags || "g");
      // Always global for iteration; keep other flags (i/m/s/u/y) if present.
      const norm = f.includes("g") ? f : f + "g";
      return new RegExp(src, norm);
    } catch {
      return null;
    }
  }

  function unwrapDomMarks(root) {
    const marks = root.querySelectorAll ? root.querySelectorAll("span." + MARK_CLASS) : [];
    for (const m of marks) {
      const txt = document.createTextNode(m.textContent || "");
      m.replaceWith(txt);
      if (txt.parentNode) txt.parentNode.normalize();
    }
  }

  function clearDomHighlights() {
    try { unwrapDomMarks(document); } catch {}
    // best-effort for open shadow roots
    try {
      const all = document.querySelectorAll ? document.querySelectorAll("*") : [];
      let seen = 0;
      for (const el of all) {
        if (el.shadowRoot) {
          unwrapDomMarks(el.shadowRoot);
          seen++;
          if (seen > 200) break;
        }
      }
    } catch {}
  }

  function clearTextareaHighlights() {
    try {
      const ta = state.ta;
      if (ta && typeof ta.setSelectionRange === "function") {
        ta.setSelectionRange(0, 0);
      }
    } catch {}
  }

  
  // ---------- Monaco engine (iHealth classic BIG-IP viewer) ----------
  function getMonacoEditor() {
    try {
      const mon = window.monaco;
      if (!mon || !mon.editor) return null;

      // Some builds expose editor lists
      try {
        if (typeof mon.editor.getEditors === "function") {
          const eds = mon.editor.getEditors();
          if (eds && eds.length) return eds[0];
        }
      } catch {}

      // Standalone accessor (best effort)
      try {
        if (typeof mon.editor.getStandaloneCodeEditor === "function") {
          const el = document.querySelector(".monaco-editor");
          if (el) {
            let n = el;
            for (let i = 0; i < 6 && n; i++) {
              const ed = mon.editor.getStandaloneCodeEditor(n);
              if (ed) return ed;
              n = n.parentElement;
            }
          }
        }
      } catch {}

      // Common globals (site-specific)
      for (const k of ["editor", "monacoEditor", "codeEditor", "theEditor"]) {
        try {
          const v = window[k];
          if (v && typeof v.deltaDecorations === "function" && typeof v.getModel === "function") return v;
        } catch {}
      }
    } catch {}
    return null;
  }

  function clearMonacoHighlights() {
    try {
      const ed = state.monacoEditor;
      if (ed && typeof ed.deltaDecorations === "function") {
        const oldIds = Array.isArray(state.monacoDecIds) ? state.monacoDecIds : [];
        state.monacoDecIds = ed.deltaDecorations(oldIds, []);
      }
    } catch {}
    state.monacoEditor = null;
    state.monacoDecIds = [];
    state.monacoMatches = [];
    state.monacoPartial = false;
  }

  function applyMonacoDecorations(activeIdx) {
    try {
      const ed = state.monacoEditor;
      const matches = Array.isArray(state.monacoMatches) ? state.monacoMatches : [];
      if (!ed || !matches.length || typeof ed.deltaDecorations !== "function") return;

      let idx = Number.isFinite(activeIdx) ? activeIdx : 0;
      if (idx < 0) idx = 0;
      if (idx >= matches.length) idx = matches.length - 1;

      const decs = matches.map((rng, i) => ({
        range: rng,
        options: {
          inlineClassName: i === idx ? "gfpp-monaco-mark gfpp-monaco-active" : "gfpp-monaco-mark"
        }
      }));

      const oldIds = Array.isArray(state.monacoDecIds) ? state.monacoDecIds : [];
      state.monacoDecIds = ed.deltaDecorations(oldIds, decs);

      // Move cursor/viewport to active match
      const rng = matches[idx];
      if (rng) {
        try { if (typeof ed.setSelection === "function") ed.setSelection(rng); } catch {}
        try {
          if (typeof ed.revealRangeInCenter === "function") ed.revealRangeInCenter(rng);
          else if (typeof ed.revealRangeInCenterIfOutsideViewport === "function") ed.revealRangeInCenterIfOutsideViewport(rng);
          else if (typeof ed.revealLineInCenter === "function") ed.revealLineInCenter(rng.startLineNumber);
        } catch {}
      }
    } catch {}
  }

  function runMonacoEngine(src, flags) {
    try {
      const mon = window.monaco;
      const models = mon?.editor?.getModels?.() || [];
      if (!models.length) return null;

      const ed = getMonacoEditor();
      if (!ed || typeof ed.getModel !== "function") return null;

      const model = ed.getModel() || models[0];
      if (!model || typeof model.findMatches !== "function") return null;

      const ignoreCase = String(flags || "").includes("i");
      let found = [];
      try {
        // Monaco's model.findMatches expects a null/Range searchScope (not boolean).
        // Use a sane result limit to avoid huge decoration sets.
        found = model.findMatches(String(src), null, true, !ignoreCase, null, false, MAX_MARKS) || [];
      } catch {
        // Fallback for older Monaco signatures (6 args)
        try { found = model.findMatches(String(src), null, true, !ignoreCase, null, true) || []; } catch {}
      }

      const partial = found.length > MAX_MARKS;
      const picked = found.slice(0, MAX_MARKS).map(m => m.range).filter(Boolean);

      state.kind = "monaco";
      state.monacoEditor = ed;
      state.monacoMatches = picked;
      state.monacoPartial = partial;
      state.active = picked.length ? 0 : -1;

      // Clear other engines’ state
      state.marks = [];
      state.ta = null;
      state.taMatches = [];

      applyMonacoDecorations(state.active);

      return { ok: true, count: picked.length, active: picked.length ? 1 : 0, kind: "monaco", partial };
    } catch {
      return null;
    }
  }

  function navMonaco(delta) {
    const matches = Array.isArray(state.monacoMatches) ? state.monacoMatches : [];
    const n = matches.length;
    if (!n) return { ok: true, count: 0, active: 0, kind: "monaco", partial: !!state.monacoPartial };

    let idx = Number.isFinite(state.active) ? state.active : 0;
    idx = (idx + (delta || 0) + n) % n;
    state.active = idx;

    applyMonacoDecorations(idx);

    return { ok: true, count: n, active: idx + 1, kind: "monaco", partial: !!state.monacoPartial };
  }
function clearAll() {
    clearDomHighlights();
    clearTextareaHighlights();
    clearMonacoHighlights();
    state.kind = "dom";
    state.marks = [];
    state.ta = null;
    state.taMatches = [];
    state.active = -1;
    state.spec = null;
    state.wfText = null;
    state.wfCaseSensitive = true;
    state.wfFound = false;
  }


  function isSkippable(node) {
    const p = node && node.parentElement;
    if (!p) return false;
    return !!p.closest(SKIP_SELECTOR);
  }

  function rangeHasRects(textNode, start, end) {
    try {
      if (!textNode || textNode.nodeType !== 3) return false;
      const len = (textNode.nodeValue || "").length;
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      if (start < 0) start = 0;
      if (end > len) end = len;
      if (end <= start) return false;

      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const rects = range.getClientRects();
      return !!(rects && rects.length);
    } catch {
      return false;
    }
  }

  function setActiveDom(idx) {
    const BASE_BG = "rgba(255,215,0,0.35)";
    const BASE_OUTLINE = "1px solid rgba(255,215,0,0.65)";
    const ACTIVE_BG = "rgba(255,99,71,0.35)";
    const ACTIVE_OUTLINE = "2px solid rgba(255,0,0,0.85)";

    if (!state.marks.length) return { active: 0, count: 0 };

    // clear previous active
    if (state.active >= 0 && state.active < state.marks.length) {
      const prev = state.marks[state.active];
      try { prev.classList.remove(ACTIVE_CLASS); } catch {}
      try {
        prev.style.background = BASE_BG;
        prev.style.outline = BASE_OUTLINE;
      } catch {}
    }

    idx = (idx + state.marks.length) % state.marks.length;
    state.active = idx;

    const el = state.marks[idx];
    try { el.classList.add(ACTIVE_CLASS); } catch {}
    try {
      el.style.background = ACTIVE_BG;
      el.style.outline = ACTIVE_OUTLINE;
    } catch {}

    try {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    } catch {
      try { el.scrollIntoView(); } catch {}
    }

    return { active: idx + 1, count: state.marks.length };
  }


  function pickMainTextarea() {
    const tas = Array.from(document.querySelectorAll ? document.querySelectorAll("textarea") : []);

    function isVisible(ta) {
      try {
        if (!ta || !ta.isConnected) return false;
        if (ta.closest && ta.closest(SKIP_SELECTOR)) return false;
        const cs = window.getComputedStyle ? window.getComputedStyle(ta) : null;
        if (cs) {
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          if (Number(cs.opacity || 1) === 0) return false;
        }
        const r = ta.getBoundingClientRect ? ta.getBoundingClientRect() : null;
        if (!r || r.width < 20 || r.height < 20) return false;

        const vw = window.innerWidth || document.documentElement.clientWidth || 0;
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        // must intersect viewport
        if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
        return true;
      } catch {
        return false;
      }
    }

    const visible = [];
    for (const ta of tas) {
      try {
        const v = String(ta.value || "");
        if (!v) continue;
        if (isVisible(ta)) visible.push({ ta, len: v.length });
      } catch {}
    }

    if (!visible.length) return null;

    visible.sort((a, b) => b.len - a.len);
    return { el: visible[0].ta, len: visible[0].len, visible: true };
  }


  function runTextarea(re) {
    const picked = pickMainTextarea();
    if (!picked) return null;

    const ta = picked.el;
    const v = String(ta.value || "");
    if (!v) return null;

    const matches = [];
    re.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = re.exec(v)) !== null) {
      const hit = m[0] || "";
      if (!hit) break;
      matches.push([m.index, m.index + hit.length]);
      if (matches.length >= MAX_MARKS) break;
      if (++guard > 200000) break;
    }

    // If the visible textarea doesn't contain any matches, fall through to the DOM engine.
    if (!matches.length) return null;

    state.kind = "textarea";
    state.ta = ta;
    state.taMatches = matches;
    state.marks = [];
    state.active = -1;

    // Activate first match
    state.active = 0;
    try {
      ta.focus();
      ta.setSelectionRange(matches[0][0], matches[0][1]);
    } catch {}
    return { ok: true, count: matches.length, active: 1, kind: "textarea", partial: matches.length >= MAX_MARKS };
  }

  function navTextarea(delta) {
    const ta = state.ta;
    const matches = state.taMatches || [];
    if (!ta || !matches.length) return { ok: true, count: 0, active: 0, kind: "textarea", partial: false };
    let idx = Number.isFinite(state.active) ? state.active : 0;
    idx = (idx + delta + matches.length) % matches.length;
    state.active = idx;
    try {
      ta.focus();
      ta.setSelectionRange(matches[idx][0], matches[idx][1]);
    } catch {}
    return { ok: true, count: matches.length, active: idx + 1, kind: "textarea", partial: matches.length >= MAX_MARKS };
  }


  function runWindowFind(text, caseSensitive, backwards) {
    try {
      // window.find(text, caseSensitive, backwards, wrapAround, wholeWord, searchInFrames, showDialog)
      return !!window.find(String(text || ""), !!caseSensitive, !!backwards, true, false, true, false);
    } catch {
      return false;
    }
  }

  function runWindowFindInit(text, caseSensitive) {
    // First find should start from beginning: move selection to start if possible
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) {
        sel.removeAllRanges();
      }
    } catch {}
    return runWindowFind(text, caseSensitive, false);
  }
  if (action === "clear") {
    clearAll();
    return { ok: true, count: 0, active: 0, kind: "none", frameUrl: String(location && location.href ? location.href : "") };
  }

    if (action === "next" || action === "prev") {
    if (state.kind === "monaco") {
      const delta = action === "next" ? 1 : -1;
      const r = navMonaco(delta);
      r.frameUrl = String(location && location.href ? location.href : "");
      return r;
    }
    if (state.kind === "textarea") {
      const r = navTextarea(action === "next" ? 1 : -1);
      r.frameUrl = String(location && location.href ? location.href : "");
      return r;
    }

    if (state.kind === "windowfind") {
      const found = runWindowFind(state.wfText, state.wfCaseSensitive, action === "prev");
      state.wfFound = !!found;
      const r = { ok: true, count: found ? 1 : 0, active: found ? 1 : 0, kind: "windowfind", partial: true };
      r.frameUrl = String(location && location.href ? location.href : "");
      return r;
    }

    const delta = action === "next" ? 1 : -1;
    const r = { ok: true, ...setActiveDom((state.active < 0 ? 0 : state.active) + delta) };
    r.kind = "dom";
    r.frameUrl = String(location && location.href ? location.href : "");
    return r;
  }

  if (action !== "run") {
    return { error: "Unknown action" };
  }

  // action === "run"
  const src = String(spec && spec.src ? spec.src : "").trim();
  const flags = String(spec && spec.flags ? spec.flags : "gm");

  if (!src) return { error: "Missing pattern" };

  ensureStyle();
  clearAll();
  state.spec = { src, flags };

  const re = safeMakeRegex(src, flags);
  if (!re) return { error: "Invalid regex" };

  // 0) Monaco engine (preferred when available)
  const monacoRes = runMonacoEngine(src, flags);
  if (monacoRes) {
    monacoRes.frameUrl = String(location && location.href ? location.href : "");
    return monacoRes;
  }

  // 1) Try textarea engine first (common in some qkview viewers)
  const taRes = runTextarea(re);
  if (taRes) {
    taRes.frameUrl = String(location && location.href ? location.href : "");
    return taRes;
  }

  // 2) DOM engine
  let marks = [];
  let insertedCount = 0;
  let visitedTextNodes = 0;
  let partial = false;

  // Search document + some open shadow roots (best-effort)
  const roots = [document];
  try {
    const all = document.querySelectorAll ? document.querySelectorAll("*") : [];
    let seen = 0;
    for (const el of all) {
      if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        seen++;
        if (seen > 200) break;
      }
    }
  } catch {}

  for (const root of roots) {
    let walker;
    try {
      walker = document.createTreeWalker(root instanceof ShadowRoot ? root : root.body || root, NodeFilter.SHOW_TEXT);
    } catch {
      continue;
    }

    let node;
    while ((node = walker.nextNode())) {
      if (visitedTextNodes++ > MAX_TEXT_NODES) { partial = true; break; }
      if (!node.nodeValue) continue;
      if (isSkippable(node)) continue;

      const raw = node.nodeValue;
      re.lastIndex = 0;
      let m = re.exec(raw);
      if (!m) continue;

      // Skip matches that are not actually rendered (e.g., hidden duplicate text in display:none containers).
      // We test the first match using a Range; if it has no client rects, it's not in layout.
      const firstHit = m[0] || "";
      if (!firstHit) continue;
      if (!rangeHasRects(node, m.index, m.index + firstHit.length)) continue;

      // Build fragment with all matches
      const frag = document.createDocumentFragment();
      let last = 0;
      re.lastIndex = 0;
      let guard = 0;
      while ((m = re.exec(raw)) !== null) {
        const hit = m[0] || "";
        if (!hit) break;
        const start = m.index;
        const end = start + hit.length;

        frag.appendChild(document.createTextNode(raw.slice(last, start)));
        const span = document.createElement("span");
        span.className = MARK_CLASS;
        span.textContent = hit;
        try {
          span.style.background = "rgba(255,215,0,0.35)";
          span.style.outline = "1px solid rgba(255,215,0,0.65)";
          span.style.borderRadius = "2px";
          span.style.padding = "0 1px";
        } catch {}
        frag.appendChild(span);
        marks.push(span);
        insertedCount++;

        last = end;

        if (marks.length >= MAX_MARKS) { partial = true; break; }
        if (++guard > 20000) { partial = true; break; }
      }
      frag.appendChild(document.createTextNode(raw.slice(last)));

      try {
        node.parentNode.replaceChild(frag, node);
      } catch {}

      if (partial) break;
    }
    if (partial) break;
  }

  state.kind = "dom";
  // Prefer visible marks only (some pages contain hidden duplicate text blocks).
  // If we only inserted hidden marks, clear and fall back to window.find.
  const visibleMarks = marks.filter(s => {
    try {
      const r = s.getClientRects();
      if (!r || !r.length) return false;
      const b = s.getBoundingClientRect();
      return (b && b.width > 0 && b.height > 0);
    } catch {
      return false;
    }
  });

  if (insertedCount > 0 && visibleMarks.length === 0) {
    // We probably matched a hidden copy. Remove marks and allow window.find to drive navigation.
    try { clearDomHighlights(); } catch {}
    marks = [];
  } else {
    marks = visibleMarks;
  }

  state.marks = marks;
  state.ta = null;
  state.taMatches = [];

  // 3) window.find fallback (useful when the viewer splits words across spans or renders text in a way
  // that doesn't map cleanly to text nodes). This provides Ctrl+F-like selection + Next/Prev navigation.
  const wfText = String(spec && (spec.raw || spec.src) ? (spec.raw || spec.src) : "").trim();
  const wfCaseSensitive = !String(flags || "").includes("i");
  if (!marks.length && wfText && wfText.length <= 200) {
    const found = runWindowFindInit(wfText, wfCaseSensitive);
    if (found) {
      state.kind = "windowfind";
      state.wfText = wfText;
      state.wfCaseSensitive = wfCaseSensitive;
      state.wfFound = true;
      return { ok: true, count: 1, active: 1, kind: "windowfind", partial: true, frameUrl: String(location && location.href ? location.href : "") };
    }
  }

  const res = { ok: true, count: marks.length, inserted: insertedCount, hidden: Math.max(0, insertedCount - marks.length), partial, kind: "dom", frameUrl: String(location && location.href ? location.href : "") };
  if (marks.length) Object.assign(res, setActiveDom(0));
  else res.active = 0;
  return res;
}

async function __gf_hl_exec(tabId, action, spec, preferFrameId) {
  // returns array of injection results: [{frameId, result:{...}}]
  const opts = { maxMarks: 5000, maxTextNodes: 60000 };

  // 1) If we have a preferred frame (e.g., pipeline-selected), try it first.
  if (Number.isFinite(preferFrameId)) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [preferFrameId] },
        world: "MAIN",
        func: __gf_hl_page,
        args: [action, spec || null, opts],
      });
      return r;
    } catch {
      // fall through
    }
  }

  // 2) Try per-frame injection to avoid allFrames failing on inaccessible frames.
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (Array.isArray(frames) && frames.length) {
      const results = await Promise.all(
        frames.map(async (frame) => {
          if (!Number.isFinite(frame.frameId)) return null;
          try {
            const r = await chrome.scripting.executeScript({
              target: { tabId, frameIds: [frame.frameId] },
              world: "MAIN",
              func: __gf_hl_page,
              args: [action, spec || null, opts],
            });
            return r?.[0] || null;
          } catch {
            return null;
          }
        })
      );
      const cleaned = results.filter(Boolean);
      if (cleaned.length) return cleaned;
    }
  } catch {
    // fall through
  }

  // 3) Try all frames (best effort). Note: some sites/frames can reject injection.
  try {
    return await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: __gf_hl_page,
      args: [action, spec || null, opts],
    });
  } catch (e) {
    // 4) If allFrames fails due to an inaccessible frame, fall back to top frame.
    return await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: __gf_hl_page,
      args: [action, spec || null, opts],
    });
  }
}


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender?.tab?.id;
    if (!tabId) return;

    // ---- On-page highlight handler ----
    if (msg?.type === "GF_HIGHLIGHT") {
      const action = String(msg.action || "run");
      if (action === "run") {
        const spec = msg.spec || {};
        const pipeFrameId = __GF_PIPE_STATE__.get(tabId)?.frameId;

        // Prefer the same frame the pipeline read from (avoids highlighting nav/side tables).
        const injected = await __gf_hl_exec(tabId, "run", spec, pipeFrameId);

        const okResults = injected
          .map(r => ({ frameId: r.frameId, result: r.result }))
          .filter(r => r.result && r.result.ok);

        // If we have a pipeline frame and it produced matches, use it even if other frames also match.
        let best = null;
        if (Number.isFinite(pipeFrameId)) {
          best = okResults.find(r => r.frameId === pipeFrameId && (r.result.count || 0) > 0) || null;
        }
        if (!best) {
          best = okResults
            .sort((a, b) => (b.result.count || 0) - (a.result.count || 0))[0] || null;
        }

        if (best) {
          __GF_HL_STATE__.set(tabId, { frameId: best.frameId, spec });
          sendResponse({ ok: true, ...best.result });
          return;
        }

        const err = injected.map(r => r.result).find(r => r && r.error)?.error;
        sendResponse({ error: err || "No accessible frame returned a highlight result" });
        return;
      }

      if (action === "clear") {
        const st = __GF_HL_STATE__.get(tabId);
        const injected = await __gf_hl_exec(tabId, "clear", st?.spec || null);
        __GF_HL_STATE__.delete(tabId);
        const any = injected.map(r => r.result).find(r => r && r.ok);
        sendResponse(any || { ok: true, count: 0, active: 0 });
        return;
      }

      if (action === "next" || action === "prev") {
        const st = __GF_HL_STATE__.get(tabId);
        if (!st?.spec) {
          sendResponse({ error: "No active highlight query" });
          return;
        }
        const injected = await __gf_hl_exec(tabId, action === "next" ? "next" : "prev", st.spec, st.frameId);

        const best = injected
          .map(r => ({ frameId: r.frameId, result: r.result }))
          .filter(r => r.frameId === st.frameId && r.result && r.result.ok)[0]
          || injected
          .map(r => ({ frameId: r.frameId, result: r.result }))
          .filter(r => r.result && r.result.ok)
          .sort((a, b) => (b.result.count || 0) - (a.result.count || 0))[0];

        sendResponse(best?.result ? { ok: true, ...best.result } : { error: "Highlight navigation failed" });
        return;
      }

      sendResponse({ error: "Unknown highlight action" });
      return;
    }

// ---- Pipeline handler (Monaco/DOM/table extraction) ----
    if (msg?.type !== "GF_PIPELINE") return;

    try {

    if (!tabId) return sendResponse({ error: "No tabId" });

    const cmd = String(msg.cmd || "").trim();
    if (!cmd) return sendResponse({ error: "Empty command" });

    const caps = msg.caps || { maxOutputLines: 2000, previewChars: 200000 };
// Timezone settings (used to convert log timestamps before running pipeline)
const tzDefaults = (() => {
  let localTz = "Etc/UTC";
  try {
    localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  } catch {}
  return { tzEnabled: true, tzFrom: "Etc/UTC", tzTo: localTz };
})();

let tzCfg = tzDefaults;
try {
  tzCfg = await chrome.storage.sync.get(tzDefaults);
} catch {}


    let injected;
    try {
      injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      args: [cmd, caps, tzCfg],
      func: (cmdIn, capsIn, tzCfgIn) => {
        function runFindPipeline(cmd, caps = {}, tzCfg = {}) {
          const {
            maxOutputLines = 2000,
            previewChars = 200000,
            // safety: if source is enormous, don't try to materialize millions of lines
            maxSourceLines = 250000,
            // safety: cap DOM text extraction
            maxDomChars = 8000000,
            // safety: cap table row extraction
            maxTableRows = 200000
          } = caps;

          // lightweight network capture (best-effort) for viewers that fetch log text
          (function ensureNetHook() {
            try {
              if (window.__GF_NET_HOOKED__) return;
              window.__GF_NET_HOOKED__ = true;
              const MAX = 5 * 1024 * 1024;
              const remember = (t) => {
                if (!t) return;
                window.__GF_LAST_TEXT__ = t.length > MAX ? t.slice(0, MAX) : t;
              };

              const origFetch = window.fetch;
              if (typeof origFetch === "function") {
                window.fetch = async (...args) => {
                  const res = await origFetch(...args);
                  try {
                    const clone = res.clone();
                    const ct = (clone.headers.get("content-type") || "").toLowerCase();
                    if (ct.includes("text") || ct.includes("json") || ct.includes("xml")) {
                      remember(await clone.text());
                    }
                  } catch {}
                  return res;
                };
              }

              const oOpen = XMLHttpRequest.prototype.open;
              const oSend = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this.__GF_URL__ = url;
                return oOpen.call(this, method, url, ...rest);
              };
              XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener("load", function() {
                  try {
                    const ct = (this.getResponseHeader("content-type") || "").toLowerCase();
                    if (ct.includes("text") || ct.includes("json") || ct.includes("xml")) {
                      remember(typeof this.responseText === "string" ? this.responseText : "");
                    }
                  } catch {}
                });
                return oSend.apply(this, args);
              };
            } catch {}
          })();

          function detectSourceAdapter() {
            // 1) Monaco (classic BIG-IP iHealth viewer)
            try {
              const models = window.monaco?.editor?.getModels?.() || [];
              if (models.length) {
                const model = models[0];
                return {
                  kind: "monaco",
                  detail: "monaco.editor",
                  partial: false,
                  notice: "",
                  adapter: {
                    uri: model.uri,
                    getLineCount: () => model.getLineCount(),
                    getLineContent: (ln) => model.getLineContent(ln)
                  }
                };
              }
            } catch {}

            // 2) Table (common for some F5OS iHealth views)
            try {
              const rows = Array.from(document.querySelectorAll("table tbody tr"))
                .filter(r => !r.closest("#gf-host"));
              const preMain = document.querySelector("pre");
              const skipTable = preMain && ((preMain.innerText || "").trim().length > 200);

              if (!skipTable && rows.length) {
                const takeRows = Math.min(rows.length, maxTableRows);
                const lines = [];
                for (let i = 0; i < takeRows; i++) {
                  const txt = (rows[i].innerText || "").replace(/\s+$/g, "");
                  if (txt) lines.push(txt);
                  if (lines.length >= maxSourceLines) break;
                }
                const partial = (takeRows < rows.length) || (lines.length >= maxSourceLines);
                const notice = partial
                  ? `--- note: table source is partial/visible rows (rows=${rows.length}, used=${lines.length}) ---\n`
                  : "";
                return {
                  kind: "table",
                  detail: "table tbody tr",
                  partial,
                  notice,
                  adapter: {
                    getLineCount: () => lines.length,
                    getLineContent: (ln) => String(lines[ln - 1] ?? "")
                  }
                };
              }
            } catch {}

            // 3) DOM text blocks (pre/textarea/code)
            try {
              const candidates = [];
              const add = (el, detail, txt) => {
                if (!txt) return;
                if (el.closest && el.closest("#gf-host")) return;
                candidates.push({ detail, txt: String(txt) });
              };

              for (const el of Array.from(document.querySelectorAll("textarea"))) add(el, "textarea", el.value);
              for (const el of Array.from(document.querySelectorAll("pre"))) add(el, "pre", el.innerText);
              for (const el of Array.from(document.querySelectorAll("code"))) add(el, "code", el.innerText);

              candidates.sort((a, b) => (b.txt.length - a.txt.length));
              if (candidates.length && candidates[0].txt.trim().length) {
                let raw = candidates[0].txt;
                const detail = candidates[0].detail;
                let partial = false;
                // NOTE: srcNotice is computed after adapter selection; keep local notice empty unless we truncate.
                let notice = "";

                if (raw.length > maxDomChars) {
                  raw = raw.slice(0, maxDomChars);
                  partial = true;
                  notice = `--- note: DOM source truncated to ${maxDomChars} chars (maxDomChars=${maxDomChars}) ---\n`;
                }

                raw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                let lines = raw.split("\n");

                if (lines.length > maxSourceLines) {
                  lines = lines.slice(0, maxSourceLines);
                  partial = true;
                  notice = `--- note: DOM source truncated to first ${maxSourceLines} lines (maxSourceLines=${maxSourceLines}) ---\n`;
                }

                return {
                  kind: "dom",
                  detail,
                  partial,
                  notice,
                  adapter: {
                    getLineCount: () => lines.length,
                    getLineContent: (ln) => String(lines[ln - 1] ?? "")
                  }
                };
              }
            } catch {}

            // 4) Network last text fallback (best-effort)
            try {
              const raw = String(window.__GF_LAST_TEXT__ || "");
              if (raw && raw.trim().length) {
                let t = raw;
                if (t.length > maxDomChars) t = t.slice(0, maxDomChars);
                t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
                let lines = t.split("\n");
                if (lines.length > maxSourceLines) lines = lines.slice(0, maxSourceLines);
                return {
                  kind: "network",
                  detail: "fetch/xhr",
                  partial: true,
                  notice: "--- note: using last captured network text (best-effort) ---\n",
                  adapter: {
                    getLineCount: () => lines.length,
                    getLineContent: (ln) => String(lines[ln - 1] ?? "")
                  }
                };
              }
            } catch {}

            return { error: "No readable text source found (Monaco/DOM/table)" };
          }

          const src = detectSourceAdapter();
          if (src.error) return { error: src.error };

          const m = src.adapter;
          const srcMeta = { sourceKind: src.kind || "unknown", sourceDetail: src.detail || "", sourcePartial: !!src.partial };
          const srcNotice = src.notice || "";

          function clampInt(n, defVal) {
            const x = Number(n);
            if (!Number.isFinite(x) || x <= 0) return defVal;
            return Math.floor(x);
          }

          
// --- optional timezone conversion (applies to ALL source lines before pipeline stages) ---
const tzEnabled = !!(tzCfg && tzCfg.tzEnabled && tzCfg.tzFrom && tzCfg.tzTo && tzCfg.tzFrom !== tzCfg.tzTo);

const tzConvertLine = (() => {
  if (!tzEnabled) return (s) => s;

  const fromTZ = String(tzCfg.tzFrom);
  const toTZ = String(tzCfg.tzTo);

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const MON2NUM = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

  const dtfCache = new Map();
  function getDTF(tz) {
    let dtf = dtfCache.get(tz);
    if (dtf) return dtf;
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    dtfCache.set(tz, dtf);
    return dtf;
  }

  function partsObj(parts) {
    const o = {};
    for (const p of parts) {
      if (p.type !== "literal") o[p.type] = p.value;
    }
    return {
      year: Number(o.year),
      month: Number(o.month),
      day: Number(o.day),
      hour: Number(o.hour),
      minute: Number(o.minute),
      second: Number(o.second)
    };
  }

  function zonedParts(date, tz) {
    return partsObj(getDTF(tz).formatToParts(date));
  }

  // Convert a "wall clock" timestamp in `tz` into a UTC epoch (ms).
  // Iterative correction handles DST offsets.
  function epochFromZoned(parts, tz) {
    let utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);

    for (let i = 0; i < 4; i++) {
      const actual = zonedParts(new Date(utc), tz);
      const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
      const diff = desiredUtc - actualUtc;
      if (diff === 0) break;
      utc += diff;
    }
    return utc;
  }

  const syslogRe = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})(\s+)/;
  const isoRe = /^(\d{4})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2}):(\d{2})/;

  function pad2(n) { return String(n).padStart(2, "0"); }

  return (line) => {
    try {
      if (!line) return line;

      let m = line.match(syslogRe);
      if (m) {
        const mon = MON2NUM[m[1]];
        if (!mon) return line;

        // If log line has no year, assume current UTC year (DST correctness is best-effort).
        const year = (new Date()).getUTCFullYear();
        const day = Number(m[2]);
        const hour = Number(m[3]);
        const minute = Number(m[4]);
        const second = Number(m[5]);
        const tailWS = m[6];

        const utc = epochFromZoned({ year, month: mon, day, hour, minute, second }, fromTZ);
        const z = zonedParts(new Date(utc), toTZ);

        const prefix = `${MONTHS[z.month - 1]} ${String(z.day).padStart(2, " ")} ${pad2(z.hour)}:${pad2(z.minute)}:${pad2(z.second)}${tailWS}`;
        return prefix + line.slice(m[0].length);
      }

      m = line.match(isoRe);
      if (m) {
        const year = Number(m[1]);
        const month = Number(m[2]);
        const day = Number(m[3]);
        const sep = m[4];
        const hour = Number(m[5]);
        const minute = Number(m[6]);
        const second = Number(m[7]);

        const utc = epochFromZoned({ year, month, day, hour, minute, second }, fromTZ);
        const z = zonedParts(new Date(utc), toTZ);

        const prefix = `${String(z.year).padStart(4, "0")}-${pad2(z.month)}-${pad2(z.day)}${sep}${pad2(z.hour)}:${pad2(z.minute)}:${pad2(z.second)}`;
        return prefix + line.slice(m[0].length);
      }

      return line;
    } catch {
      return line;
    }
  };
})();

// --- tokenizer that respects quotes AND preserves backslashes ---
          function tokenize(s) {
            const out = [];
            let cur = "", q = null;

            for (let i = 0; i < s.length; i++) {
              const ch = s[i];

              if (q) {
                // preserve escapes inside quotes (do not drop backslashes)
                if (ch === "\\" && i + 1 < s.length) {
                  const nxt = s[i + 1];
                  // allow escaping quote/backslash without losing meaning
                  if (nxt === q || nxt === "\\") {
                    cur += nxt;
                    i++;
                    continue;
                  }
                  // preserve unknown escapes literally (e.g., \n \b \d \[)
                  cur += "\\" + nxt;
                  i++;
                  continue;
                }

                if (ch === q) { q = null; continue; }
                cur += ch;
                continue;
              }

              if (ch === "'" || ch === '"') { q = ch; continue; }

              if (/\s/.test(ch)) {
                if (cur) out.push(cur), cur = "";
                continue;
              }

              // preserve escapes outside quotes
              if (ch === "\\" && i + 1 < s.length) {
                cur += "\\" + s[++i];
                continue;
              }

              cur += ch;
            }

            if (cur) out.push(cur);
            return out;
          }

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

          function parseHeadTail(tokens) {
            let n = 10;
            for (let i = 1; i < tokens.length; i++) {
              const t = tokens[i];
              if (t === "-n" && tokens[i + 1]) { n = clampInt(tokens[i + 1], n); i++; continue; }
              if (t.startsWith("-n") && t.length > 2) { n = clampInt(t.slice(2), n); continue; }
              if (!t.startsWith("-") && /^\d+$/.test(t)) { n = clampInt(t, n); continue; }
            }
            return n;
          }

          function parseSort(tokens) {
            // Supports a useful subset of GNU sort flags:
            // -r (reverse), -n (numeric), -f (fold case), -h (human numeric), -t <delim>, -k <start>[,<end>][flags]
            let reverse = false;
            let numeric = false;
            let foldCase = false;
            let human = false;
            let delimiter = null; // single-char delimiter; null => whitespace fields
            let key = null; // { startField:number|null, endField:number|null, flags:{reverse,numeric,foldCase,human} }

            const decodeDelim = (d) => {
              if (d == null) return null;
              if (d === "\\t") return "\t";
              if (d === "\\n") return "\n";
              if (d === "\\r") return "\r";
              return d;
            };

            const parseKeySpec = (spec) => {
              const out = {
                startField: null,
                endField: null,
                flags: { reverse: false, numeric: false, foldCase: false, human: false }
              };
              if (!spec) return out;

              // Examples: "6", "6,6", "6,6nr", "7r"
              let s = String(spec).trim();
              let startPart = s;
              let endPart = "";
              if (s.includes(",")) {
                const parts = s.split(",", 2);
                startPart = parts[0];
                endPart = parts[1] ?? "";
              }

              // start field
              const sm = startPart.match(/^(\d+)(.*)$/);
              if (sm) {
                out.startField = Number(sm[1]) || null;
                // flags after start field (rare, but allowed)
                const extra = sm[2] || "";
                for (const ch of extra) {
                  if (ch === "r") out.flags.reverse = true;
                  if (ch === "n") out.flags.numeric = true;
                  if (ch === "f") out.flags.foldCase = true;
                  if (ch === "h") out.flags.human = true;
                }
              }

              if (endPart) {
                const em = String(endPart).match(/^(\d+)?(.*)$/);
                if (em) {
                  if (em[1]) out.endField = Number(em[1]) || null;
                  const extra = em[2] || "";
                  for (const ch of extra) {
                    if (ch === "r") out.flags.reverse = true;
                    if (ch === "n") out.flags.numeric = true;
                    if (ch === "f") out.flags.foldCase = true;
                    if (ch === "h") out.flags.human = true;
                  }
                }
              }

              return out;
            };

            for (let i = 1; i < tokens.length; i++) {
              const t = tokens[i];

              if (t === "--") break;

              if (t === "-k") {
                key = parseKeySpec(tokens[i + 1] ?? "");
                i++;
                continue;
              }
              if (t && t.startsWith("-k") && t.length > 2) {
                key = parseKeySpec(t.slice(2));
                continue;
              }
              if (t && t.startsWith("--key=")) {
                key = parseKeySpec(t.slice(6));
                continue;
              }

              if (t === "-t") {
                const d = decodeDelim(tokens[i + 1]);
                i++;
                delimiter = d ? String(d)[0] : null;
                continue;
              }
              if (t && t.startsWith("-t") && t.length > 2) {
                const d = decodeDelim(t.slice(2));
                delimiter = d ? String(d)[0] : null;
                continue;
              }

              // long-form common flags
              if (t === "--reverse") { reverse = true; continue; }
              if (t === "--numeric-sort") { numeric = true; continue; }
              if (t === "--ignore-case") { foldCase = true; continue; }
              if (t === "--human-numeric-sort") { human = true; continue; }

              if (!t || !t.startsWith("-") || t === "-") continue;

              // Combined short flags like -nr or -k6,6nr (handled above for -k)
              for (const ch of t.slice(1)) {
                if (ch === "r") reverse = true;
                if (ch === "n") numeric = true;
                if (ch === "f") foldCase = true;
                if (ch === "h") human = true;
              }
            }

            return { reverse, numeric, foldCase, human, delimiter, key };
          }

          function parseUniq(tokens) {
            let count = false;
            let ignoreCase = false;
            let onlyDups = false;
            let onlyUniques = false;

            for (let i = 1; i < tokens.length; i++) {
              const t = tokens[i];
              if (!t.startsWith("-")) continue;
              for (const ch of t.slice(1)) {
                if (ch === "c") count = true;
                if (ch === "i") ignoreCase = true;
                if (ch === "d") onlyDups = true;
                if (ch === "u") onlyUniques = true;
              }
            }
            return { count, ignoreCase, onlyDups, onlyUniques };
          }

          function parseGrep(tokens) {
            let i = 0;
            if (tokens[0] === "grep") i++;

            const o = {
              lineNumbers: false,
              ignoreCase: false,
              invert: false,
              fixed: false,
              onlyMatching: false,
              word: false,
              wholeLine: false,
              countOnly: false,
              maxMatches: 0,
              before: 0,
              after: 0,
              pattern: ""
            };

            const readNum = () => Number(tokens[++i]) || 0;

            let endOfOptions = false;

            for (; i < tokens.length; i++) {
              const t = tokens[i];

              if (!endOfOptions && t === "--") { endOfOptions = true; continue; }

              if (!endOfOptions) {
                if (t === "-n") { o.lineNumbers = true; continue; }
                if (t === "-i") { o.ignoreCase = true; continue; }
                if (t === "-v") { o.invert = true; continue; }
                if (t === "-F") { o.fixed = true; continue; }
                if (t === "-o") { o.onlyMatching = true; continue; }
                if (t === "-w") { o.word = true; continue; }
                if (t === "-x") { o.wholeLine = true; continue; }
                if (t === "-c") { o.countOnly = true; continue; }

                if (t === "-m") { o.maxMatches = readNum(); continue; }
                if (t.startsWith("-m") && t.length > 2) { o.maxMatches = Number(t.slice(2)) || 0; continue; }

                if (t === "-A") { o.after = readNum(); continue; }
                if (t.startsWith("-A") && t.length > 2) { o.after = Number(t.slice(2)) || 0; continue; }

                if (t === "-B") { o.before = readNum(); continue; }
                if (t.startsWith("-B") && t.length > 2) { o.before = Number(t.slice(2)) || 0; continue; }

                if (t === "-C") { const n = readNum(); o.before = Math.max(o.before, n); o.after = Math.max(o.after, n); continue; }
                if (t.startsWith("-C") && t.length > 2) { const n = Number(t.slice(2)) || 0; o.before = Math.max(o.before, n); o.after = Math.max(o.after, n); continue; }

                if (t === "-E") continue; // regex default (JS)

                // Support combined short flags like -nEi, -iv, -nE, etc.
                if (t.startsWith("-") && !t.startsWith("--") && t.length > 2) {
                  // Skip forms already handled above (-m10, -A2, -B2, -C2)
                  const lead = t.slice(0, 2);
                  if (lead !== "-m" && lead !== "-A" && lead !== "-B" && lead !== "-C" && lead !== "-t" && lead !== "-k") {
                    let handled = false;
                    for (const ch of t.slice(1)) {
                      if (ch === "n") { o.lineNumbers = true; handled = true; continue; }
                      if (ch === "i") { o.ignoreCase = true; handled = true; continue; }
                      if (ch === "v") { o.invert = true; handled = true; continue; }
                      if (ch === "F") { o.fixed = true; handled = true; continue; }
                      if (ch === "o") { o.onlyMatching = true; handled = true; continue; }
                      if (ch === "w") { o.word = true; handled = true; continue; }
                      if (ch === "x") { o.wholeLine = true; handled = true; continue; }
                      if (ch === "c") { o.countOnly = true; handled = true; continue; }
                      if (ch === "E") { handled = true; continue; } // ignore
                    }
                    if (handled) continue;
                  }
                }
              }

              if (!t.startsWith("-") && !o.pattern) { o.pattern = t; continue; }
            }

            return o;
          }

          function buildRegex(g) {
            let src = g.pattern || "";
            if (!src) return { error: "Missing pattern" };

            if (g.fixed) src = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (g.word) src = `\\b(?:${src})\\b`;
            if (g.wholeLine) src = `^(?:${src})$`;

            const flags = g.ignoreCase ? "i" : "";
            let testRe, matchRe;
            try {
              testRe = new RegExp(src, flags);
              matchRe = new RegExp(src, flags + "g");
            } catch (e) {
              return { error: `Invalid regex: ${String(e)}` };
            }
            return { testRe, matchRe };
          }

          function applySed(records, sedTokens) {
            const script = sedTokens.slice(1).join(" ");
            if (!script) return records;

            const del = script.match(/^\/(.+)\/d$/);
            if (del) {
              const re = new RegExp(del[1]);
              return records.filter(r => !re.test(r.text));
            }

            const sub = script.match(/^s(.)(.+?)\1(.*?)\1([gimuy]*)$/);
            if (sub) {
              const src = sub[2];
              const repl = sub[3];
              const flags = sub[4] || "";
              const doGlobal = flags.includes("g");
              const ci = flags.includes("i");

              if (doGlobal) {
                const re = new RegExp(src, ci ? "gi" : "g");
                return records.map(r => ({ ...r, text: String(r.text ?? "").replace(re, repl) }));
              } else {
                const re = new RegExp(src, ci ? "i" : "");
                return records.map(r => ({ ...r, text: String(r.text ?? "").replace(re, repl) }));
              }
            }

            return { error: `Unsupported sed script: ${script}` };
          }

          // ---- upgraded awk subset (rules + vars + printf + exit) ----
          function applyAwk(records, awkTokens) {
                      // AWK subset focused on common triage/forensics one-liners.
                      // Supported:
                      //   -F <regex>
                      //   rules: [pattern] { action } ...
                      //   patterns: /re/ OR boolean expr with vars, NR, NF, $n, && || !, comparisons, match ops ~ !~
                      //   expressions: + - * / % (numeric), implicit concatenation, parentheses
                      //   functions: int(x), length([x]), tolower(x), toupper(x), substr(s, start[, len])
                      //   actions: var=expr, var++, var--, print expr, printf "fmt", args..., exit

                      let fs = /\s+/;
                      let i = 1;

                      if (awkTokens[i] === "-F" && awkTokens[i + 1]) {
                        const fsRaw = awkTokens[i + 1];
                        try {
                          fs = new RegExp(fsRaw);
                        } catch (e) {
                          return { error: `Invalid awk -F regex: ${String(e)}` };
                        }
                        i += 2;
                      }

                      const programRaw = awkTokens.slice(i).join(" ").trim();
                      if (!programRaw) return records;

                      function splitStatements(block) {
                        const out = [];
                        let cur = "", q = null;
                        for (let k = 0; k < block.length; k++) {
                          const ch = block[k];
                          if (q) {
                            if (ch === "\\" && k + 1 < block.length) { cur += ch + block[++k]; continue; }
                            if (ch === q) { q = null; cur += ch; continue; }
                            cur += ch; continue;
                          }
                          if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
                          if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
                          cur += ch;
                        }
                        if (cur.trim()) out.push(cur.trim());
                        return out;
                      }

                      function parseRules(prog) {
                        const rules = [];
                        let p = 0;
                        const len = prog.length;

                        while (p < len) {
                          while (p < len && /\s/.test(prog[p])) p++;
                          if (p >= len) break;

                          // read pattern (optional) until '{'
                          let pattern = "";
                          if (prog[p] !== "{") {
                            const start = p;
                            let q = null;
                            let inRegex = false;

                            while (p < len) {
                              const ch = prog[p];

                              if (q) {
                                if (ch === "\\" && p + 1 < len) { p += 2; continue; }
                                if (ch === q) { q = null; p++; continue; }
                                p++; continue;
                              }

                              if (inRegex) {
                                if (ch === "\\" && p + 1 < len) { p += 2; continue; }
                                if (ch === "/") { inRegex = false; p++; continue; }
                                p++; continue;
                              }

                              if (ch === "'" || ch === '"') { q = ch; p++; continue; }
                              if (ch === "/") { inRegex = true; p++; continue; }
                              if (ch === "{") break;
                              p++;
                            }

                            pattern = prog.slice(start, p).trim();
                          }

                          // If the user omitted "{...}", accept a single bare rule.
                          // - If it looks like an action (print/printf/exit/assign/inc/dec), treat it as "{ action }".
                          // - Otherwise treat it as a pattern with implicit "{ print $0 }".
                          if (p >= len) {
                            const stmt = pattern.trim();
                            if (!stmt) break;
                            const looksLikeAction =
                              /^\s*(print|printf|exit)\b/.test(stmt) ||
                              /(\+\+|--|\+=|-=|\*=|\/=|%=|=)/.test(stmt);

                            rules.push({
                              pattern: looksLikeAction ? "" : stmt,
                              action: looksLikeAction ? stmt : "print $0"
                            });
                            break;
                          }

                          if (prog[p] !== "{") return { error: "Invalid awk: expected '{' in rule" };
                          p++; // '{'

                          const startA = p;
                          let q2 = null;
                          while (p < len) {
                            const ch = prog[p];
                            if (q2) {
                              if (ch === "\\" && p + 1 < len) { p += 2; continue; }
                              if (ch === q2) { q2 = null; p++; continue; }
                              p++; continue;
                            }
                            if (ch === "'" || ch === '"') { q2 = ch; p++; continue; }
                            if (ch === "}") break;
                            p++;
                          }

                          if (prog[p] !== "}") return { error: "Invalid awk: expected '}' in rule" };
                          const action = prog.slice(startA, p).trim();
                          p++; // '}'

                          rules.push({ pattern, action });
                        }

                        return rules;
                      }

                      // --- expression lexer/parser (safe subset) ---
                      function lexExpr(s) {
                        const toks = [];
                        let p = 0;

                        const isIdStart = c => /[A-Za-z_]/.test(c);
                        const isId = c => /[A-Za-z0-9_]/.test(c);

                        const isOperandTok = (t) => {
                          if (!t) return false;
                          return t.t === "num" || t.t === "str" || t.t === "field" || t.t === "id" || t.t === "re" || (t.t === "op" && t.v === ")");
                        };

                        while (p < s.length) {
                          while (p < s.length && /\s/.test(s[p])) p++;
                          if (p >= s.length) break;

                          const ch = s[p];
                          const two = s.slice(p, p + 2);

                          if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "!~") {
                            toks.push({ t: "op", v: two });
                            p += 2;
                            continue;
                          }

                          if (ch === "," ) {
                            toks.push({ t: "op", v: "," });
                            p++;
                            continue;
                          }

                          if ("()!><~+-*%".includes(ch)) {
                            toks.push({ t: "op", v: ch });
                            p++;
                            continue;
                          }

                          if (ch === "/") {
                            // Disambiguate regex literal vs division:
                            // - If previous token is not an operand, allow /re/ (if it closes).
                            // - Otherwise treat as division operator.
                            const prev = toks.length ? toks[toks.length - 1] : null;
                            const canStartRegex = !isOperandTok(prev);

                            if (canStartRegex) {
                              let p2 = p + 1;
                              let src = "";
                              let closed = false;

                              while (p2 < s.length) {
                                const c = s[p2];
                                if (c === "\\" && p2 + 1 < s.length) { src += c + s[p2 + 1]; p2 += 2; continue; }
                                if (c === "/") { closed = true; p2++; break; }
                                src += c; p2++;
                              }

                              if (closed) {
                                toks.push({ t: "re", v: src });
                                p = p2;
                                continue;
                              }
                            }

                            // division
                            toks.push({ t: "op", v: "/" });
                            p++;
                            continue;
                          }

                          if (ch === "$") {
                            p++;
                            let num = "";
                            while (p < s.length && /[0-9]/.test(s[p])) num += s[p++];
                            toks.push({ t: "field", v: Number(num || "0") });
                            continue;
                          }

                          if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(s[p + 1] || ""))) {
                            let num = "";
                            let dotSeen = false;
                            while (p < s.length) {
                              const c = s[p];
                              if (c === "." && !dotSeen) { dotSeen = true; num += c; p++; continue; }
                              if (/[0-9]/.test(c)) { num += c; p++; continue; }
                              break;
                            }
                            toks.push({ t: "num", v: Number(num) });
                            continue;
                          }

                          if (ch === "'" || ch === '"') {
                            const quote = ch;
                            p++;
                            let str = "";
                            while (p < s.length) {
                              const c = s[p];
                              if (c === "\\" && p + 1 < s.length) { str += c + s[p + 1]; p += 2; continue; }
                              if (c === quote) { p++; break; }
                              str += c; p++;
                            }
                            toks.push({ t: "str", v: str });
                            continue;
                          }

                          if (isIdStart(ch)) {
                            let id = "";
                            while (p < s.length && isId(s[p])) id += s[p++];
                            toks.push({ t: "id", v: id });
                            continue;
                          }

                          // unknown char: skip
                          p++;
                        }

                        return toks;
                      }

                      function makeRegex(src) {
                        try { return new RegExp(src); } catch { return null; }
                      }

                      function parseExpr(tokens) {
                        let idx = 0;
                        const peek = () => tokens[idx];
                        const eatOp = (op) => {
                          const t = tokens[idx];
                          if (t && t.t === "op" && t.v === op) { idx++; return true; }
                          return false;
                        };

                        const isStartOfOperand = (t) => {
                          if (!t) return false;
                          return t.t === "num" || t.t === "str" || t.t === "field" || t.t === "id" || t.t === "re" || (t.t === "op" && t.v === "(");
                        };

                        function parsePrimary() {
                          const t = tokens[idx++];
                          if (!t) return { k: "num", v: 0 };

                          if (t.t === "num") return { k: "num", v: t.v };
                          if (t.t === "str") return { k: "str", v: t.v };
                          if (t.t === "field") return { k: "field", v: t.v };
                          if (t.t === "re") return { k: "re", v: t.v };

                          if (t.t === "id") {
                            // function call: name(...)
                            const next = peek();
                            if (next && next.t === "op" && next.v === "(") {
                              idx++; // '('
                              // Collect tokens up to matching ')', then split by commas at depth 0.
                              const inner = [];
                              let depth = 1;
                              while (idx < tokens.length && depth > 0) {
                                const tt = tokens[idx++];
                                if (tt.t === "op" && tt.v === "(") depth++;
                                if (tt.t === "op" && tt.v === ")") depth--;
                                if (depth > 0) inner.push(tt);
                              }

                              const args = [];
                              let cur = [];
                              let d2 = 0;
                              for (const tok of inner) {
                                if (tok.t === "op" && tok.v === "(") d2++;
                                if (tok.t === "op" && tok.v === ")") d2--;
                                if (d2 === 0 && tok.t === "op" && tok.v === ",") {
                                  if (cur.length) args.push(parseExpr(cur));
                                  cur = [];
                                  continue;
                                }
                                cur.push(tok);
                              }
                              if (cur.length) args.push(parseExpr(cur));

                              return { k: "call", name: t.v, args };
                            }

                            return { k: "id", v: t.v };
                          }

                          if (t.t === "op" && t.v === "(") {
                            const e = parseOr();
                            eatOp(")");
                            return e;
                          }

                          return { k: "num", v: 0 };
                        }

                        function parseUnary() {
                          if (eatOp("!")) return { k: "not", a: parseUnary() };
                          if (eatOp("-")) return { k: "neg", a: parseUnary() };
                          if (eatOp("+")) return parseUnary();
                          return parsePrimary();
                        }

                        function parseMul() {
                          let left = parseUnary();
                          while (true) {
                            const t = peek();
                            if (!t || t.t !== "op" || !["*","/","%"].includes(t.v)) break;
                            idx++;
                            const op = t.v;
                            const right = parseUnary();
                            left = { k: "bin", op, a: left, b: right };
                          }
                          return left;
                        }

                        function parseAdd() {
                          let left = parseMul();
                          while (true) {
                            const t = peek();
                            if (!t || t.t !== "op" || !["+","-"].includes(t.v)) break;
                            idx++;
                            const op = t.v;
                            const right = parseMul();
                            left = { k: "bin", op, a: left, b: right };
                          }
                          return left;
                        }

                        // Implicit concatenation (awk adjacency): expr expr
                        // Precedence: between +/− and comparisons (matches awk).
                        function parseConcat() {
                          let left = parseAdd();
                          while (true) {
                            const t = peek();
                            if (!isStartOfOperand(t)) break;
                            const right = parseAdd();
                            left = { k: "cat", a: left, b: right };
                          }
                          return left;
                        }

                        function parseCompare() {
                          let left = parseConcat();
                          const t = peek();
                          if (t && t.t === "op" && ["==","!=",">","<",">=","<=","~","!~"].includes(t.v)) {
                            idx++;
                            const op = t.v;
                            const right = parseConcat();
                            return { k: "cmp", op, a: left, b: right };
                          }
                          return left;
                        }

                        function parseAnd() {
                          let left = parseCompare();
                          while (eatOp("&&")) left = { k: "and", a: left, b: parseCompare() };
                          return left;
                        }

                        function parseOr() {
                          let left = parseAnd();
                          while (eatOp("||")) left = { k: "or", a: left, b: parseAnd() };
                          return left;
                        }

                        return parseOr();
                      }

                      function evalNode(node, ctx, env) {
                        const field = (n) => (n === 0 ? ctx.line : (ctx.fields[n - 1] ?? ""));
                        const toNum = (v) => {
                          if (v && v.__re) return 0;
                          const n = Number(v);
                          return Number.isFinite(n) ? n : 0;
                        };
                        const truthy = (v) => {
                          if (v && v.__re) return true;
                          if (typeof v === "number") return v !== 0;
                          return !!String(v);
                        };

                        if (!node) return 0;

                        if (node.k === "num") return node.v;
                        if (node.k === "str") return node.v;
                        if (node.k === "field") return field(node.v);

                        if (node.k === "id") {
                          if (node.v === "NR") return ctx.NR;
                          if (node.v === "NF") return ctx.NF;
                          if (node.v === "OFMT") return env.OFMT ?? "%.6g";
                          return env[node.v] ?? 0;
                        }

                        if (node.k === "re") return { __re: makeRegex(node.v) };

                        if (node.k === "call") {
                          const nm = String(node.name || "");
                          const args = (node.args || []).map(a => evalNode(a, ctx, env));

                          if (nm === "int") return Math.trunc(toNum(args[0] ?? 0));
                          if (nm === "length") {
                            const s = (args.length ? String(args[0]) : String(ctx.line));
                            return s.length;
                          }
                          if (nm === "tolower") return String(args[0] ?? "").toLowerCase();
                          if (nm === "toupper") return String(args[0] ?? "").toUpperCase();
                          if (nm === "substr") {
                            const s = String(args[0] ?? "");
                            const start = Math.max(1, Math.trunc(toNum(args[1] ?? 1)));
                            if (args.length >= 3) {
                              const len = Math.max(0, Math.trunc(toNum(args[2] ?? 0)));
                              return s.slice(start - 1, (start - 1) + len);
                            }
                            return s.slice(start - 1);
                          }

                          // unknown function => 0 (awk-ish)
                          return 0;
                        }

                        if (node.k === "neg") return -toNum(evalNode(node.a, ctx, env));
                        if (node.k === "not") return truthy(evalNode(node.a, ctx, env)) ? 0 : 1;
                        if (node.k === "and") return (truthy(evalNode(node.a, ctx, env)) && truthy(evalNode(node.b, ctx, env))) ? 1 : 0;
                        if (node.k === "or") return (truthy(evalNode(node.a, ctx, env)) || truthy(evalNode(node.b, ctx, env))) ? 1 : 0;

                        if (node.k === "cat") return String(evalNode(node.a, ctx, env)) + String(evalNode(node.b, ctx, env));

                        if (node.k === "bin") {
                          const A = toNum(evalNode(node.a, ctx, env));
                          const B = toNum(evalNode(node.b, ctx, env));
                          if (node.op === "+") return A + B;
                          if (node.op === "-") return A - B;
                          if (node.op === "*") return A * B;
                          if (node.op === "/") return (B === 0) ? 0 : (A / B);
                          if (node.op === "%") return (B === 0) ? 0 : (A % B);
                          return 0;
                        }

                        if (node.k === "cmp") {
                          const A = evalNode(node.a, ctx, env);
                          const B = evalNode(node.b, ctx, env);

                          if (node.op === "~" || node.op === "!~") {
                            const reObj = (B && B.__re) ? B.__re : null;
                            if (!reObj) return 0;
                            const ok = reObj.test(String(A));
                            return (node.op === "~" ? ok : !ok) ? 1 : 0;
                          }

                          if (B && B.__re) {
                            const ok = B.__re ? B.__re.test(String(A)) : false;
                            if (node.op === "==") return ok ? 1 : 0;
                            if (node.op === "!=") return ok ? 0 : 1;
                          }

                          const an = Number(A);
                          const bn = Number(B);
                          const bothNum = Number.isFinite(an) && Number.isFinite(bn);

                          if (node.op === "==") return (bothNum ? (an === bn) : (String(A) === String(B))) ? 1 : 0;
                          if (node.op === "!=") return (bothNum ? (an !== bn) : (String(A) !== String(B))) ? 1 : 0;
                          if (node.op === ">") return (bothNum ? (an > bn) : (String(A) > String(B))) ? 1 : 0;
                          if (node.op === "<") return (bothNum ? (an < bn) : (String(A) < String(B))) ? 1 : 0;
                          if (node.op === ">=") return (bothNum ? (an >= bn) : (String(A) >= String(B))) ? 1 : 0;
                          if (node.op === "<=") return (bothNum ? (an <= bn) : (String(A) <= String(B))) ? 1 : 0;
                        }

                        return 0;
                      }

                      function unescapeAwkString(s) {
                        return s.replace(/\\n/g, "\n")
                                .replace(/\\t/g, "\t")
                                .replace(/\\r/g, "\r")
                                .replace(/\\\\/g, "\\");
                      }

                      function splitArgs(argStr) {
                        const out = [];
                        let cur = "", q = null;
                        for (let k = 0; k < argStr.length; k++) {
                          const ch = argStr[k];
                          if (q) {
                            if (ch === "\\" && k + 1 < argStr.length) { cur += ch + argStr[++k]; continue; }
                            if (ch === q) { q = null; cur += ch; continue; }
                            cur += ch; continue;
                          }
                          if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
                          if (ch === ",") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
                          cur += ch;
                        }
                        if (cur.trim()) out.push(cur.trim());
                        return out;
                      }

                      function parsePrintf(stmt) {
                        let s = stmt.trim().replace(/^printf\s+/, "").trim();
                        const q = s[0];
                        if (q !== '"' && q !== "'") return { error: "printf missing format string" };

                        let p = 1;
                        let fmt = "";
                        while (p < s.length) {
                          const ch = s[p];
                          if (ch === "\\" && p + 1 < s.length) { fmt += ch + s[p + 1]; p += 2; continue; }
                          if (ch === q) { p++; break; }
                          fmt += ch; p++;
                        }

                        fmt = unescapeAwkString(fmt);

                        while (p < s.length && /\s/.test(s[p])) p++;
                        let args = [];
                        if (s[p] === ",") args = splitArgs(s.slice(p + 1).trim());

                        return { fmt, args };
                      }

                      function formatPrintf(fmt, args) {
                        let ai = 0;
                        let out = "";

                        for (let k = 0; k < fmt.length; k++) {
                          const ch = fmt[k];
                          if (ch !== "%") { out += ch; continue; }
                          if (fmt[k + 1] === "%") { out += "%"; k++; continue; }

                          let j = k + 1;

                          // flags
                          let left = false;
                          if (fmt[j] === "-") { left = true; j++; }

                          // width
                          let widthStr = "";
                          while (j < fmt.length && /[0-9]/.test(fmt[j])) widthStr += fmt[j++];

                          // precision (e.g., %.1f)
                          let prec = null;
                          if (fmt[j] === ".") {
                            j++;
                            let precStr = "";
                            while (j < fmt.length && /[0-9]/.test(fmt[j])) precStr += fmt[j++];
                            prec = precStr ? Number(precStr) : 0;
                          }

                          const type = fmt[j] || "s";
                          k = j;

                          const width = widthStr ? Number(widthStr) : 0;
                          const raw = (ai < args.length) ? args[ai++] : "";

                          let val = "";
                          if (type === "d") {
                            val = String(parseInt(raw, 10) || 0);
                          } else if (type === "f") {
                            const num = Number(raw);
                            const n = Number.isFinite(num) ? num : 0;
                            val = (prec === null) ? String(n) : n.toFixed(prec);
                          } else {
                            val = String(raw);
                            if (prec !== null) val = val.slice(0, prec);
                          }

                          if (width > 0 && val.length < width) {
                            const pad = " ".repeat(width - val.length);
                            out += left ? (val + pad) : (pad + val);
                          } else {
                            out += val;
                          }
                        }

                        return out;
                      }

                      function evalExpr(exprStr, ctx, env) {
                        const toks = lexExpr(exprStr);
                        const ast = parseExpr(toks);
                        const v = evalNode(ast, ctx, env);
                        return v;
                      }

                      const parsed = parseRules(programRaw);
                      if (parsed?.error) return { error: parsed.error };

                      const compiled = parsed.map(r => {
                        const patAst = r.pattern ? parseExpr(lexExpr(r.pattern)) : null;
                        const stmts = splitStatements(r.action).map(s => s.trim()).filter(Boolean);
                        return { patAst, stmts };
                      });

                      const env = Object.create(null);
                      const out = [];
                      let shouldExit = false;

                      for (let ridx = 0; ridx < records.length; ridx++) {
                        const rec = records[ridx];
                        const line = String(rec.text ?? "");
                        const fields = line.split(fs).filter(x => x.length);

                        const ctx = {
                          line,
                          fields,
                          NR: ridx + 1,
                          NF: fields.length
                        };

                        for (const rule of compiled) {
                          let ok = true;

                          if (rule.patAst) {
                            const pv = evalNode(rule.patAst, ctx, env);

                            if (pv && pv.__re) {
                              ok = pv.__re ? pv.__re.test(ctx.line) : false;
                            } else if (typeof pv === "number") {
                              ok = pv !== 0;
                            } else {
                              ok = !!String(pv);
                            }
                          }

                          if (!ok) continue;

                          for (const st of rule.stmts) {
                            // exit
                            if (/^exit(\(\))?$/.test(st) || /^exit\s+/.test(st)) {
                              shouldExit = true;
                              break;
                            }

                            // var++
                            let mm = st.match(/^([A-Za-z_]\w*)\+\+$/);
                            if (mm) {
                              const name = mm[1];
                              const v = Number(env[name] ?? 0) || 0;
                              env[name] = v + 1;
                              continue;
                            }

                            // var--
                            mm = st.match(/^([A-Za-z_]\w*)--$/);
                            if (mm) {
                              const name = mm[1];
                              const v = Number(env[name] ?? 0) || 0;
                              env[name] = v - 1;
                              continue;
                            }

                            // var=expr  (and a minimal set of compound assigns)
                            mm = st.match(/^([A-Za-z_]\w*)\s*([+\-*/%]?=)\s*(.+)$/);
                            if (mm) {
                              const name = mm[1];
                              const op = mm[2];
                              const expr = mm[3].trim();
                              const rhs = evalExpr(expr, ctx, env);
                              const cur = env[name] ?? 0;

                              let v = rhs;
                              if (op !== "=") {
                                const A = Number(cur) || 0;
                                const B = Number(rhs) || 0;
                                if (op === "+=") v = A + B;
                                if (op === "-=") v = A - B;
                                if (op === "*=") v = A * B;
                                if (op === "/=") v = (B === 0) ? 0 : (A / B);
                                if (op === "%=") v = (B === 0) ? 0 : (A % B);
                              }

                              env[name] = (v && v.__re) ? 0 : v;
                              continue;
                            }

                            // print ...
                            if (st === "print" || st.startsWith("print ")) {
                              const exprList = st === "print" ? "$0" : st.replace(/^print\s+/, "").trim();
                              const parts = splitArgs(exprList).map(e => {
                                const v = evalExpr(e, ctx, env);
                                if (v && v.__re) return "";
                                return (typeof v === "number") ? String(v) : String(v);
                              });
                              out.push({ ln: rec.ln, text: parts.join(" ") });
                              continue;
                            }

                            // printf ...
                            if (st.startsWith("printf")) {
                              const pp = parsePrintf(st);
                              if (pp.error) return { error: `Unsupported awk printf: ${pp.error}` };

                              const argVals = pp.args.map(a => {
                                const v = evalExpr(a, ctx, env);
                                if (v && v.__re) return "";
                                return (typeof v === "number") ? String(v) : String(v);
                              });

                              const rendered = formatPrintf(pp.fmt, argVals);

                              // split into lines if fmt contains \n
                              const lines = rendered.split("\n");
                              for (let li = 0; li < lines.length; li++) {
                                if (li === lines.length - 1 && lines[li] === "") break;
                                out.push({ ln: rec.ln, text: lines[li] });
                              }
                              continue;
                            }

                            return { error: `Unsupported awk statement: ${st}` };
                          }

                          if (shouldExit) break;
                        }

                        if (shouldExit) break;
                      }

                      return out;
                    }

          function applyGrepStream(records, grepTokens, state) {
            const g2 = parseGrep(grepTokens);
            state.lineNumbers = state.lineNumbers || g2.lineNumbers;

            if (g2.before || g2.after) {
              return { error: "Pipeline grep does not support -A/-B/-C. Use context only on the first grep." };
            }

            const rr = buildRegex(g2);
            if (rr.error) return { error: rr.error };

            let out = [];
            let matchCount = 0;

            for (const r of records) {
              const line = String(r.text ?? "");
              const isMatch = rr.testRe.test(line);

              if ((isMatch && !g2.invert) || (!isMatch && g2.invert)) {
                matchCount++;

                if (g2.onlyMatching && !g2.invert) {
                  const matches = line.match(rr.matchRe);
                  const text = matches ? matches.join(" ") : "";
                  out.push({ ...r, text });
                } else {
                  out.push(r);
                }

                if (g2.maxMatches && matchCount >= g2.maxMatches) break;
              }
            }

            if (g2.countOnly) return { __countOnly: true, matchLineCount: matchCount };
            return out;
          }

          function applyHead(records, n) {
            return records.slice(0, Math.max(0, n));
          }

          function applyTail(records, n) {
            const k = Math.max(0, n);
            return records.slice(Math.max(0, records.length - k));
          }

          function applySort(records, sortTokens) {
            const opts = parseSort(sortTokens);

            const splitFields = (line) => {
              const s = String(line ?? "");
              if (opts.delimiter != null) return s.split(opts.delimiter);
              const t = s.replace(/^\s+/, "");
              if (!t) return [];
              return t.split(/\s+/);
            };

            const extractKeyText = (line) => {
              let keyText = String(line ?? "");

              if (opts.key && opts.key.startField && opts.key.startField > 0) {
                const fields = splitFields(keyText);
                const start = Math.max(0, opts.key.startField - 1);
                const end = opts.key.endField && opts.key.endField > 0
                  ? Math.min(fields.length - 1, opts.key.endField - 1)
                  : (fields.length - 1);

                const slice = fields.slice(start, end + 1);
                keyText = (opts.delimiter != null) ? slice.join(opts.delimiter) : slice.join(" ");
              }

              const fold = (opts.key && opts.key.flags && opts.key.flags.foldCase) || opts.foldCase;
              if (fold) keyText = keyText.toLowerCase();

              return keyText;
            };

            const parseHuman = (s) => {
              const m = String(s ?? "").trim().match(/^(-?\d+(?:\.\d+)?)([kKmMgGtTpPeE])(?:[bB])?$/);
              if (!m) return NaN;
              const v = Number(m[1]);
              if (!Number.isFinite(v)) return NaN;
              const unit = m[2].toUpperCase();
              const pow = "KMGTPE".indexOf(unit) + 1;
              if (pow <= 0) return v;
              return v * Math.pow(1024, pow);
            };

            const wantHuman = (keyText) => {
              const k = String(keyText ?? "").trim();
              if ((opts.key && opts.key.flags && opts.key.flags.human) || opts.human) return true;
              // Auto-detect common human suffixes (helps with ps outputs showing RSS like 151.1M)
              return /^-?\d+(?:\.\d+)?[kKmMgGtTpPeE](?:[bB])?$/.test(k);
            };

            const wantNumeric = (keyText) => {
              if ((opts.key && opts.key.flags && opts.key.flags.numeric) || opts.numeric) return true;
              // If auto human, treat as numeric too
              return wantHuman(keyText);
            };

            const effectiveReverse = () => {
              if (opts.key && opts.key.flags && opts.key.flags.reverse) return true;
              return !!opts.reverse;
            };

            const decorated = records.map((r, idx) => {
              const line = String(r.text ?? "");
              const keyText = extractKeyText(line);
              const isNum = wantNumeric(keyText);
              const isHum = wantHuman(keyText);
              let keyNum = NaN;
              if (isNum) {
                keyNum = isHum ? parseHuman(keyText) : parseFloat(keyText);
                if (!Number.isFinite(keyNum)) keyNum = -Infinity;
              }
              return { r, idx, keyText, keyNum, isNum };
            });

            decorated.sort((a, b) => {
              if (a.isNum || b.isNum) {
                const av = a.keyNum;
                const bv = b.keyNum;
                if (av !== bv) return av - bv;
              } else {
                const cmp = a.keyText.localeCompare(b.keyText);
                if (cmp !== 0) return cmp;
              }
              return a.idx - b.idx; // stable tie-break
            });

            if (effectiveReverse()) decorated.reverse();
            return decorated.map(x => x.r);
          }

          function applyUniq(records, uniqTokens, state) {
            const { count, ignoreCase, onlyDups, onlyUniques } = parseUniq(uniqTokens);

            // After uniq, line numbers are not meaningful
            state.lineNumbers = false;

            const out = [];
            let i = 0;

            while (i < records.length) {
              const first = records[i];
              const firstText = String(first?.text ?? "");
              const firstKey = ignoreCase ? firstText.toLowerCase() : firstText;

              let runCount = 1;
              let j = i + 1;
              for (; j < records.length; j++) {
                const t = String(records[j]?.text ?? "");
                const k = ignoreCase ? t.toLowerCase() : t;
                if (k !== firstKey) break;
                runCount++;
              }

              const emit =
                (onlyDups && runCount > 1) ||
                (onlyUniques && runCount === 1) ||
                (!onlyDups && !onlyUniques);

              if (emit) {
                const textOut = count ? `${runCount}\t${firstText}` : firstText;
                out.push({ ln: null, text: textOut });
              }

              i = j;
            }

            return out;
          }

          // --- pipeline parse ---
          const stages = splitPipes(cmd).map(seg => tokenize(seg));
          if (!stages.length) return { error: "Empty command" };

          const starters = new Set(["grep", "head", "tail", "sed", "awk", "sort", "uniq"]);
          const first = stages[0]?.[0];

          if (!starters.has(first)) {
            return { error: "Unsupported start. Start with: grep, head, tail, sed, awk, sort, uniq" };
          }

          const lineCount = m.getLineCount();
          const state = { lineNumbers: false };
          let baseCount = null;
          let records = [];
          let stageStartIndex = 0;
          let notice = srcNotice;

          // --- source stage ---
          if (first === "grep") {
            const g = parseGrep(stages[0]);
            state.lineNumbers = g.lineNumbers;

            const r = buildRegex(g);
            if (r.error) return { error: r.error };

            const keep = new Set();
            let matchCount = 0;

            for (let ln = 1; ln <= lineCount; ln++) {
              const line = tzConvertLine(m.getLineContent(ln));
              const isMatch = r.testRe.test(line);

              if ((isMatch && !g.invert) || (!isMatch && g.invert)) {
                matchCount++;

                const start = Math.max(1, ln - g.before);
                const end = Math.min(lineCount, ln + g.after);
                for (let k = start; k <= end; k++) keep.add(k);

                if (g.maxMatches && matchCount >= g.maxMatches) break;
              }
            }

            if (g.countOnly) return { ...srcMeta, totalLines: lineCount, matchLineCount: matchCount };

            baseCount = matchCount;

            records = [...keep].sort((a, b) => a - b).map(ln => {
              let text = tzConvertLine(m.getLineContent(ln));
              if (g.onlyMatching && !g.invert) {
                const matches = text.match(r.matchRe);
                text = matches ? matches.join(" ") : "";
              }
              return { ln, text };
            });

            stageStartIndex = 1; // already processed stage0
          } else if (first === "head") {
            const n = parseHeadTail(stages[0]);
            const take = Math.min(n, lineCount);
            baseCount = take;
            for (let ln = 1; ln <= take; ln++) records.push({ ln, text: tzConvertLine(m.getLineContent(ln)) });
            stageStartIndex = 1;
          } else if (first === "tail") {
            const n = parseHeadTail(stages[0]);
            const take = Math.min(n, lineCount);
            baseCount = take;
            const start = Math.max(1, lineCount - take + 1);
            for (let ln = start; ln <= lineCount; ln++) records.push({ ln, text: tzConvertLine(m.getLineContent(ln)) });
            stageStartIndex = 1;
          } else {
            // Start with sed/awk/sort/uniq => implicit "cat" of the whole file (truncated)
            const take = Math.min(lineCount, maxSourceLines);
            baseCount = take;

            if (take < lineCount) {
              notice = `--- note: source truncated to first ${take} lines (maxSourceLines=${maxSourceLines}) ---\n`;
            }

            for (let ln = 1; ln <= take; ln++) {
              records.push({ ln, text: tzConvertLine(m.getLineContent(ln)) });
            }
            stageStartIndex = 0;
          }

          // --- apply stages ---
          for (let si = stageStartIndex; si < stages.length; si++) {
            const st = stages[si];
            const name = st[0];

            if (name === "grep") {
              const res = applyGrepStream(records, st, state);
              if (res?.error) return res;
              if (res?.__countOnly) return { ...srcMeta, totalLines: lineCount, matchLineCount: res.matchLineCount };
              records = res;
            } else if (name === "sed") {
              const res = applySed(records, st);
              if (res?.error) return res;
              records = res;
            } else if (name === "awk") {
              const res = applyAwk(records, st);
              if (res?.error) return res;
              records = res;
            } else if (name === "head") {
              records = applyHead(records, parseHeadTail(st));
            } else if (name === "tail") {
              records = applyTail(records, parseHeadTail(st));
            } else if (name === "sort") {
              records = applySort(records, st);
            } else if (name === "uniq") {
              records = applyUniq(records, st, state);
            } else {
              return { error: `Unsupported stage: ${name}` };
            }
          }

          // --- format output with caps ---
          let out = notice;
          let shown = 0;

          for (const rcd of records) {
            const hasLn = Number.isFinite(rcd.ln);
            const prefix = (state.lineNumbers && hasLn) ? `${rcd.ln}:` : "";
            out += `${prefix}${rcd.text}\n`;
            shown++;

            if (shown >= maxOutputLines) { out += `--- truncated: maxOutputLines=${maxOutputLines} ---\n`; break; }
            if (out.length >= previewChars) { out += `--- truncated: previewChars=${previewChars} ---\n`; break; }
          }

          return {
            ...srcMeta,
            modelUri: (m && m.uri) ? String(m.uri) : "",
            totalLines: lineCount,
            matchLineCount: baseCount,
            shownLines: shown,
            output: out
          };
        }

        try {
          return runFindPipeline(cmdIn, capsIn, tzCfgIn || {});
        } catch (e) {
          return { error: `Pipeline error: ${String(e && e.message ? e.message : e)}`, stack: String(e && e.stack ? e.stack : "") };
        }
      }
      });
    } catch (e) {
      sendResponse({ error: `Injection failed: ${String(e && e.message ? e.message : e)}`, stack: String(e && e.stack ? e.stack : "") });
      return;
    }

    const best = injected
      .map(r => ({ frameId: r.frameId, result: r.result }))
      .filter(r => !!r.result)
      .sort((a, b) => (b.result.totalLines || 0) - (a.result.totalLines || 0))[0];

    if (best) {
      __GF_PIPE_STATE__.set(tabId, { frameId: best.frameId });
      sendResponse({ ...best.result, sourceFrameId: best.frameId });
    } else {
      sendResponse({ error: "No result returned" });
    }
    } catch (e) {
      sendResponse({ error: `Service worker error: ${String(e && e.message ? e.message : e)}`, stack: String(e && e.stack ? e.stack : "") });
    }
  })();

  return true;
});
