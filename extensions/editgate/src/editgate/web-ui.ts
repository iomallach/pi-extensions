/**
 * Returns the single-page HTML served by EditgateServer.
 *
 * The page:
 *  • loads Monaco Editor from the jsDelivr CDN (requires internet; a future
 *    improvement can bundle it offline)
 *  • connects to /api/events (SSE) so proposals are pushed in real-time —
 *    the browser tab stays open between proposals
 *  • POSTs a DecisionPayload to /api/decision, which resolves the blocking
 *    awaitDecision() promise back in the pi extension
 */
export function buildWebUiHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Editgate · Review</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #1e1e1e;
      --bg-panel:  #252526;
      --border:    #3c3c3c;
      --text:      #cccccc;
      --muted:     #9e9e9e;
      --dim:       #616161;
      --accent:    #007acc;
    }

    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      overflow: hidden;
    }

    body { display: flex; flex-direction: column; }

    /* ── header ──────────────────────────────────────────────────── */
    #header {
      flex-shrink: 0;
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border);
      padding: 8px 14px;
    }
    #header .row1 {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 3px;
    }
    .badge {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .badge-edit  { background: #0d47a1; color: #90caf9; }
    .badge-write { background: #1a237e; color: #9fa8da; }
    #filepath {
      font-family: "SF Mono", "Fira Code", ui-monospace, Consolas, monospace;
      font-size: 12px;
      color: #e8e8e8;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #stat-add { color: #4caf50; font-family: monospace; font-size: 12px; }
    #stat-del { color: #f44336; font-family: monospace; font-size: 12px; }
    #reason {
      color: var(--muted);
      font-size: 12px;
      font-style: italic;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── diff area ───────────────────────────────────────────────── */
    #diff-wrap {
      flex: 1;
      min-height: 0;
      position: relative;
    }
    #diff-container {
      position: absolute;
      inset: 0;
    }

    /* waiting overlay — covers Monaco when no proposal is active */
    #waiting {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: var(--bg);
      color: var(--dim);
      font-size: 14px;
    }
    #waiting.show { display: flex; }
    #waiting svg  { opacity: .25; }

    /* ── steer panel ─────────────────────────────────────────────── */
    #steer-panel {
      flex-shrink: 0;
      display: none;
      background: var(--bg-panel);
      border-top: 1px solid var(--border);
      padding: 10px 14px;
    }
    #steer-panel.show { display: block; }
    #steer-panel label {
      display: block;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 5px;
    }
    #steer-feedback {
      width: 100%;
      min-height: 56px;
      max-height: 160px;
      padding: 7px 9px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      font: inherit;
      font-size: 12px;
      resize: vertical;
      outline: none;
    }
    #steer-feedback:focus { border-color: var(--accent); }

    /* ── footer ──────────────────────────────────────────────────── */
    #footer {
      flex-shrink: 0;
      background: var(--bg-panel);
      border-top: 1px solid var(--border);
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    button {
      padding: 5px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      transition: filter .1s;
    }
    button:hover:not(:disabled) { filter: brightness(1.15); }
    button:active:not(:disabled) { filter: brightness(.85); }
    button:disabled { opacity: .4; cursor: default; }
    button.active { outline: 2px solid rgba(255,255,255,.25); outline-offset: 1px; }
    .btn-approve { background: #2e7d32; color: #e8f5e9; }
    .btn-edit    { background: #1565c0; color: #e3f2fd; }
    .btn-steer   { background: #e65100; color: #fff3e0; }
    .btn-deny    { background: #b71c1c; color: #ffebee; }
    .btn-cancel  { background: #3a3a3a; color: var(--text); margin-left: auto; }
    #shortcuts {
      font-size: 11px;
      color: var(--dim);
      user-select: none;
      white-space: nowrap;
    }
  </style>
</head>
<body>

<div id="header">
  <div class="row1">
    <span id="badge" class="badge">—</span>
    <span id="filepath">—</span>
    <span id="stat-add"></span>
    <span id="stat-del"></span>
  </div>
  <div id="reason"></div>
</div>

<div id="diff-wrap">
  <div id="diff-container"></div>

  <div id="waiting" class="show">
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
    <span>Waiting for next proposal…</span>
  </div>
</div>

<div id="steer-panel">
  <label for="steer-feedback">
    Describe how pi should revise this change (Ctrl+Enter to send):
  </label>
  <textarea id="steer-feedback"
    placeholder="e.g. Use camelCase · add null guard · split into smaller functions…"
    rows="3"></textarea>
  <button class="btn-steer" id="steer-send" style="margin-top:7px">
    ⇝ Send Feedback
  </button>
</div>

<div id="footer">
  <button class="btn-approve" id="btn-approve">✓ Approve</button>
  <button class="btn-edit"    id="btn-edit">✎ Edit</button>
  <button class="btn-steer"   id="btn-steer">⇝ Steer</button>
  <button class="btn-deny"    id="btn-deny">✕ Deny</button>
  <span id="shortcuts">g/G&nbsp;top/bottom&nbsp;·&nbsp;h/H&nbsp;prev/next&nbsp;hunk&nbsp;·&nbsp;a&nbsp;approve&nbsp;·&nbsp;e&nbsp;edit&nbsp;·&nbsp;s&nbsp;steer&nbsp;·&nbsp;d&nbsp;deny&nbsp;·&nbsp;esc&nbsp;cancel</span>
  <button class="btn-cancel"  id="btn-cancel">Cancel</button>
</div>

<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js"></script>
<script>
  "use strict";

  // ── state ───────────────────────────────────────────────────────────────
  var proposal   = null;
  var diffEditor = null;
  var editMode   = false;
  var steerOpen  = false;
  var busy       = false;

  // ── element refs ────────────────────────────────────────────────────────
  var $ = function(id) { return document.getElementById(id); };
  var badge        = $("badge");
  var filepath     = $("filepath");
  var statAdd      = $("stat-add");
  var statDel      = $("stat-del");
  var reason       = $("reason");
  var diffContainer = $("diff-container");
  var waiting      = $("waiting");
  var steerPanel   = $("steer-panel");
  var steerFeedback = $("steer-feedback");
  var steerSend    = $("steer-send");
  var btnApprove   = $("btn-approve");
  var btnEdit      = $("btn-edit");
  var btnSteer     = $("btn-steer");
  var btnDeny      = $("btn-deny");
  var btnCancel    = $("btn-cancel");
  var allBtns      = [btnApprove, btnEdit, btnSteer, btnDeny, btnCancel, steerSend];

  // ── Monaco bootstrap ─────────────────────────────────────────────────────
  require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
  require(["vs/editor/editor.main"], function() {
    diffEditor = monaco.editor.createDiffEditor(diffContainer, {
      theme: "vs-dark",
      readOnly: true,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      renderLineHighlight: "none",
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });

    // Keep Monaco filling the container as the layout shifts (steer panel
    // appearing / window resize).
    new ResizeObserver(function() { diffEditor.layout(); }).observe(diffContainer);

    connectSSE();
    bindButtons();
    bindKeyboard();
  });

  // ── SSE: receive proposals pushed from the server ────────────────────────
  function connectSSE() {
    var es = new EventSource("/api/events");
    es.addEventListener("proposal", function(e) {
      applyProposal(JSON.parse(e.data));
    });
  }

  // ── apply a new proposal to the UI ──────────────────────────────────────
  function applyProposal(data) {
    proposal  = data;
    editMode  = false;
    steerOpen = false;
    busy      = false;

    // header
    badge.textContent = data.toolName.toUpperCase();
    badge.className   = "badge badge-" + data.toolName;
    filepath.textContent = data.path;
    statAdd.textContent  = "+" + data.diff.additions + "\u00a0";
    statDel.textContent  = "-" + data.diff.removals;
    reason.textContent   = data.reason;

    // reset steer panel
    steerPanel.classList.remove("show");
    steerFeedback.value = "";
    btnSteer.classList.remove("active");

    // reset edit button
    btnEdit.textContent = "✎ Edit";
    btnEdit.classList.remove("active");

    // update Monaco models
    var lang     = data.language || "plaintext";
    var origModel = monaco.editor.createModel(data.originalContent, lang);
    var modModel  = monaco.editor.createModel(data.nextContent,     lang);
    var oldModel  = diffEditor.getModel();
    diffEditor.setModel({ original: origModel, modified: modModel });
    diffEditor.updateOptions({ readOnly: true });
    if (oldModel) {
      if (oldModel.original) oldModel.original.dispose();
      if (oldModel.modified) oldModel.modified.dispose();
    }

    waiting.classList.remove("show");
    setDisabled(false);
  }

  // ── send a decision to the server ───────────────────────────────────────
  function decide(payload) {
    if (!proposal || busy) return;
    busy = true;
    setDisabled(true);

    fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    .then(function(r) {
      if (r.ok) {
        proposal = null;
        waiting.classList.add("show");
        steerPanel.classList.remove("show");
      }
    })
    .catch(function(e) { console.error("decide failed", e); })
    .finally(function() {
      busy = false;
      setDisabled(false);
    });
  }

  function setDisabled(v) {
    allBtns.forEach(function(b) { b.disabled = v; });
  }

  // ── action helpers ───────────────────────────────────────────────────────
  function doApprove() {
    if (!proposal) return;
    var nextContent = editMode
      ? diffEditor.getModifiedEditor().getValue()
      : proposal.nextContent;
    decide({ kind: "approve", nextContent: nextContent });
  }

  function scrollDiffToBoundary(boundary) {
    if (!diffEditor) return;
    var editor = diffEditor.getModifiedEditor();
    editor.setScrollTop(boundary === "top" ? 0 : editor.getScrollHeight());
  }

  function navigateDiffHunk(direction) {
    if (!diffEditor) return;
    diffEditor.goToDiff(direction);
  }

  function toggleEditMode() {
    if (!proposal) return;
    editMode = !editMode;
    diffEditor.updateOptions({ readOnly: !editMode });
    btnEdit.textContent = editMode ? "🔒 Lock" : "✎ Edit";
    btnEdit.classList.toggle("active", editMode);
    if (editMode) diffEditor.getModifiedEditor().focus();
  }

  function toggleSteerPanel() {
    steerOpen = !steerOpen;
    steerPanel.classList.toggle("show", steerOpen);
    btnSteer.classList.toggle("active", steerOpen);
    if (steerOpen) steerFeedback.focus();
  }

  function doSteer() {
    var feedback = steerFeedback.value.trim();
    if (feedback) decide({ kind: "steer", feedback: feedback });
  }

  // ── event binding ────────────────────────────────────────────────────────
  function bindButtons() {
    btnApprove.addEventListener("click", doApprove);
    btnEdit.addEventListener("click", toggleEditMode);
    btnSteer.addEventListener("click", toggleSteerPanel);
    steerSend.addEventListener("click", doSteer);
    btnDeny.addEventListener("click",   function() { decide({ kind: "deny"   }); });
    btnCancel.addEventListener("click", function() { decide({ kind: "cancel" }); });

    // Ctrl+Enter in the steer textarea sends feedback without leaving the box.
    steerFeedback.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doSteer();
      }
    });
  }

  function bindKeyboard() {
    document.addEventListener("keydown", function(e) {
      if (!proposal || busy) return;
      // Let Monaco handle keys while the modified pane is editable.
      if (editMode && e.key !== "Escape") return;
      // Skip shortcuts when focus is inside a form element.
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;

      switch (e.key) {
        case "g":
          e.preventDefault();
          scrollDiffToBoundary("top");
          break;
        case "G":
          e.preventDefault();
          scrollDiffToBoundary("bottom");
          break;
        case "h":
          e.preventDefault();
          navigateDiffHunk("previous");
          break;
        case "H":
          e.preventDefault();
          navigateDiffHunk("next");
          break;
        case "a": case "A": doApprove(); break;
        case "e": case "E": toggleEditMode(); break;
        case "s": case "S": toggleSteerPanel(); break;
        case "d": case "D": decide({ kind: "deny" }); break;
        case "Escape":       decide({ kind: "cancel" }); break;
      }
    });
  }
</script>

</body>
</html>`;
}
