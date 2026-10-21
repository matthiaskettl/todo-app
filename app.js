// todo app: the touch UI and the sync with GitHub. The todo.md model is in core.js.
(() => {
  "use strict";
  const C = window.TodoCore;
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const oneLine = (text) => text.replace(/\s+/g, " ").trim();

  // --- state, kept on this device ----------------------------------------------

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("todo." + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("todo." + key, JSON.stringify(value)); } catch { /* private mode: keep in memory */ }
    },
  };
  let cfg = store.get("cfg", null); // {owner, repo, branch, path, token, api}
  let base = store.get("base", null); // the version on GitHub we last saw: {text, sha}
  let pending = store.get("pending", []); // changes not on GitHub yet
  const view = { sort: "due", hideDone: true, label: null, ...store.get("view", {}) };
  let doc = C.parse("");
  let rows = []; // what the list shows: [{task, depth}]
  let status = { state: "idle", detail: "" }; // idle | syncing | synced | offline | error

  function save() {
    store.set("base", base);
    store.set("pending", pending);
    store.set("view", view);
  }

  /** doc = the version on GitHub plus the changes not sent yet. */
  function rebuild() {
    doc = C.parse(base ? base.text : "# Todo\n");
    const kept = pending.filter((op) => C.apply(doc, op));
    if (kept.length < pending.length) {
      toast(`${plural(pending.length - kept.length, "change")} could not be applied: the todo was changed on another device.`);
      pending = kept;
    }
  }

  function change(op, undoable = true) {
    const before = C.dump(doc);
    if (!C.apply(doc, op)) {
      toast(op.type === "restore" ? "Nothing to undo anymore." : "This todo just changed. Please try again.");
      render();
      return;
    }
    const after = C.dump(doc);
    pending.push(op);
    save();
    render();
    syncSoon();
    if (undoable) toast(op.message, "Undo", () => change({ type: "restore", before, after, message: "Undo" }, false));
  }

  // --- GitHub -------------------------------------------------------------------

  const b64encode = (text) => {
    let bin = "";
    for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

  async function api(method, { body, url } = {}) {
    const root = (cfg.api || "https://api.github.com").replace(/\/$/, "");
    const file = cfg.path.split("/").map(encodeURIComponent).join("/");
    url = url || `${root}/repos/${cfg.owner}/${cfg.repo}/contents/${file}` + (method === "GET" ? `?ref=${encodeURIComponent(cfg.branch)}` : "");
    try {
      return await fetch(url.replace("{root}", root), {
        method,
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${cfg.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw Object.assign(new Error("No connection to GitHub."), { offline: true });
    }
  }

  async function apiError(res) {
    let msg = "";
    try { msg = (await res.json()).message || ""; } catch { /* no JSON body */ }
    if (res.status === 401) return new Error("GitHub rejected the token. Check it in Settings.");
    if (res.status === 403 && /rate limit/i.test(msg)) return new Error("GitHub rate limit reached. Try again later.");
    if (res.status === 403) return new Error("The token may not change this repository. It needs Contents: Read and write.");
    if (res.status === 404) return new Error("Repository not found, or the token has no access to it.");
    return new Error(`GitHub answered ${res.status}${msg ? ": " + msg : ""}`);
  }

  async function fetchFile() {
    const res = await api("GET");
    if (res.status === 404) { // no todo.md yet? Then the repo itself must be reachable.
      const repo = await api("GET", { url: `{root}/repos/${cfg.owner}/${cfg.repo}` });
      if (!repo.ok) throw await apiError(repo);
      if (!base || base.sha) { base = { text: "# Todo\n", sha: null }; rebuild(); save(); render(); }
      return;
    }
    if (!res.ok) throw await apiError(res);
    const file = await res.json();
    if (base && base.sha === file.sha) return;
    base = { text: b64decode(file.content), sha: file.sha };
    rebuild();
    save();
    render();
  }

  let running = null, again = false, timer = null;

  function syncSoon() { // wait a moment, so quick taps become one commit
    clearTimeout(timer);
    timer = setTimeout(() => sync(false), 400);
  }

  /** Get the newest todo.md (if pull) and send the pending changes, one commit for all. */
  function sync(pull = true) {
    if (!cfg) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      setStatus("syncing");
      try {
        for (let attempt = 0; ; attempt++) {
          if (pull || !base) { await fetchFile(); pull = false; }
          if (!pending.length) break;
          if (attempt > 4) throw new Error("The file keeps changing on GitHub. Try again in a moment.");
          const sent = pending.length, content = C.dump(doc);
          const res = await api("PUT", { body: {
            message: C.commitMessage(pending.slice(0, sent)),
            content: b64encode(content),
            branch: cfg.branch,
            ...(base.sha ? { sha: base.sha } : {}),
          } });
          if (res.status === 409 || res.status === 422) { pull = true; continue; } // changed on GitHub: rebase
          if (!res.ok) throw await apiError(res);
          base = { text: content, sha: (await res.json()).content.sha };
          pending = pending.slice(sent);
          rebuild();
          save();
          render();
        }
        setStatus("synced");
      } catch (e) {
        setStatus(e.offline ? "offline" : "error", e.message);
      } finally {
        running = null;
        if (again) { again = false; sync(false); }
      }
    })();
    return running;
  }

  function setStatus(state, detail = "") {
    status = { state, detail };
    renderStatus();
  }

  // --- drawing ------------------------------------------------------------------

  function renderStatus() {
    const n = pending.length;
    const el = $("#sync");
    el.className = `sync s-${status.state}`;
    el.textContent = {
      idle: "", syncing: "syncing", synced: "synced", error: "sync error",
      offline: n ? `offline · ${n} waiting` : "offline",
    }[status.state];
    el.title = status.detail;
  }

  function render() {
    rows = C.visible(doc, view);
    const all = [...doc.root.walk()];
    const done = all.filter((t) => t.done).length;
    $("#counts").innerHTML = `<b>${all.length - done} open</b>`
      + (done ? ` · ${done} done${view.hideDone ? " hidden" : ""}` : "");
    $$("#views button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === view.sort)));
    $("#filter").innerHTML = view.label
      ? `<button class="chip c-${C.labelColor(view.label)}" data-clear-filter>#${esc(view.label)} <span aria-hidden="true">✕</span></button>` : "";
    $("#list").innerHTML = listHtml();
    renderStatus();
  }

  function listHtml() {
    if (!cfg) {
      return `<div class="empty"><p>Connect the GitHub repository that holds your <code>todo.md</code>.</p>
        <button class="btn primary" data-open-settings>Connect GitHub</button></div>`;
    }
    if (!rows.length) {
      const msg = view.label ? `No todos labelled #${esc(view.label)}.`
        : doc.root.children.length ? "Nothing open." : "Nothing to do yet. Tap + to add a todo.";
      return `<div class="empty"><p>${msg}</p></div>`;
    }
    const counts = new Map();
    for (const { task, depth } of rows) {
      if (depth) continue;
      const key = (C.section(task, view.sort) || [""])[0];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let html = "", last;
    rows.forEach(({ task, depth }, i) => {
      if (depth === 0) {
        const sec = C.section(task, view.sort), key = sec ? sec[0] : "";
        if (key !== last) {
          if (last !== undefined) html += "</div>";
          if (sec) html += `<h2 class="sec c-${sec[1]}">${esc(sec[0])} <span>${counts.get(key)}</span></h2>`;
          html += `<div class="card">`;
          last = key;
        }
      }
      html += rowHtml(task, depth, i);
    });
    return html + "</div>";
  }

  function rowHtml(t, depth, i) {
    const faded = t.done || !C.inFilter(t, view.label);
    const mark = t.done ? "done" : t.prio ? C.PRIO_COLOR[t.prio] : "none";
    const meta = [];
    if (t.due) {
      const { text, days } = C.dueText(t.due, t.done);
      const [color, bold] = C.dueStyle(days, t.done);
      meta.push(`<span class="due c-${color}${bold ? " bold" : ""}">${esc(text)}</span>`);
    }
    if (t.children.length) meta.push(`<span>${t.children.filter((c) => c.done).length}/${t.children.length}</span>`);
    for (const l of t.labels) meta.push(`<span class="chip c-${faded ? "grey" : C.labelColor(l)}">#${esc(l)}</span>`);
    const cls = ["row", depth && "sub", faded && "faded", t.done && "is-done", t.prio === 1 && !faded && "p1"].filter(Boolean);
    return `<div class="${cls.join(" ")}" data-i="${i}" style="--depth:${depth}">
      <button class="check ${mark}" aria-label="${t.done ? "Reopen" : "Mark done"}"></button>
      <div class="body"><div class="title">${esc(t.title) || "<i>untitled</i>"}</div>
      ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}</div></div>`;
  }

  // --- sheets (dialogs) --------------------------------------------------------------

  function openSheet(html, setup) {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = html;
    $("#sheet").replaceChildren(panel);
    $("#sheet").hidden = false;
    if (!history.state?.sheet) history.pushState({ sheet: true }, ""); // Android back button closes it
    if (setup) setup(panel);
  }
  const hideSheet = () => { $("#sheet").hidden = true; };
  function closeSheet() {
    if (history.state?.sheet) history.back(); // hides it via popstate
    else hideSheet();
  }
  addEventListener("popstate", hideSheet);

  const knownLabels = () => [...new Set([...doc.root.walk()].flatMap((t) => t.labels.map((l) => l.toLowerCase())))].sort();

  function editorHtml(text) {
    const prio = [[1, "High", "red"], [2, "Medium", "yellow"], [3, "Low", "cyan"]]
      .map(([p, name, c]) => `<button type="button" class="pill c-${c}" data-prio="${p}">${name}</button>`).join("");
    return `<textarea class="field" rows="2" enterkeyhint="done" placeholder="What needs doing?">${esc(text)}</textarea>
      <p class="hint">Type <b>!1</b>–<b>!3</b> for priority, <b>@fri</b> <b>@+3</b> for a date, <b>:work:</b> for a label — or tap:</p>
      <div class="pills"><span class="lbl">Priority</span>${prio}</div>
      <div class="pills"><span class="lbl">Due</span>
        <button type="button" class="pill" data-due="today">Today</button>
        <button type="button" class="pill" data-due="tomorrow">Tomorrow</button>
        <button type="button" class="pill" data-due="+7">In a week</button>
        <label class="pill date"><input type="date" aria-label="Due date"></label></div>
      <div class="pills labels"><span class="lbl">Labels</span></div>`;
  }

  /** Wire up the todo editor: typing and the pills keep each other up to date. */
  function setupEditor(panel, submit, { focus = true } = {}) {
    const field = $(".field", panel), date = $("input[type=date]", panel);
    const parts = () => C.parseText(oneLine(field.value), true);
    const set = (p) => { field.value = C.composeText(p); update(); };
    const known = knownLabels();
    function update() {
      const p = parts();
      $$("[data-prio]", panel).forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.prio === p.prio)));
      $$("[data-due]", panel).forEach((b) => b.setAttribute("aria-pressed", String(C.resolveDate(b.dataset.due) === p.due)));
      date.value = p.due || "";
      date.parentElement.setAttribute("aria-pressed", String(!!p.due && !$$("[data-due][aria-pressed=true]", panel).length));
      const labels = [...new Set([...known, ...p.labels.map((l) => l.toLowerCase())])];
      $(".labels", panel).innerHTML = `<span class="lbl">Labels</span>` + (labels.length
        ? labels.map((l) => `<button type="button" class="pill c-${C.labelColor(l)}" data-label="${esc(l)}" aria-pressed="${p.labels.some((x) => x.toLowerCase() === l)}">#${esc(l)}</button>`).join("")
        : `<span class="muted">none yet — type :name:</span>`);
      field.style.height = "auto";
      field.style.height = field.scrollHeight + 2 + "px";
    }
    panel.addEventListener("click", (e) => {
      const b = e.target.closest("button.pill");
      if (!b) return;
      const p = parts();
      if (b.dataset.prio) p.prio = p.prio === +b.dataset.prio ? null : +b.dataset.prio; // tap again to remove
      else if (b.dataset.due) {
        const d = C.resolveDate(b.dataset.due);
        p.due = p.due === d ? null : d;
      } else if (b.dataset.label) {
        const l = b.dataset.label;
        const has = p.labels.some((x) => x.toLowerCase() === l);
        p.labels = has ? p.labels.filter((x) => x.toLowerCase() !== l) : [...p.labels, l];
      }
      set(p);
    });
    date.addEventListener("change", () => set({ ...parts(), due: date.value || null }));
    field.addEventListener("input", update);
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(oneLine(field.value)); }
    });
    $("[data-save]", panel).addEventListener("click", () => submit(oneLine(field.value)));
    update();
    if (focus) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  function openAdd(parent = null) {
    openSheet(`<div class="sheet-head"><b>${parent ? `New subtodo <span class="muted">of ${esc(parent.title)}</span>` : "New todo"}</b>
        <button class="x" data-close aria-label="Close">✕</button></div>
      ${editorHtml(view.label && !parent ? ` :${view.label}:` : "")}
      <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Add</button></div>`,
    (panel) => {
      setupEditor(panel, (text) => {
        if (!text) return;
        const p = C.parseText(text, true);
        closeSheet();
        change({ type: "add", parent: parent && C.keyOf(parent), text: C.composeText(p), message: `Add: ${p.title}` });
      });
      $(".field", panel).setSelectionRange(0, 0);
    });
  }

  function openTask(t) {
    const key = C.keyOf(t);
    const sibs = C.ordered(t.parent, view), i = sibs.indexOf(t);
    const fileOrder = view.sort === "file";
    openSheet(`<div class="sheet-head"><span class="muted">${t.done ? "Done" : "Open"}${t.parent.parent ? ` · subtodo of ${esc(t.parent.title)}` : ""}</span>
        <button class="x" data-close aria-label="Close">✕</button></div>
      ${editorHtml(t.text)}
      <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>
      <div class="actions">
        <button class="btn" data-act="done">${t.done ? "Reopen" : "✓ Done"}</button>
        <button class="btn" data-act="sub">＋ Subtodo</button>
        <button class="btn" data-act="indent" ${i > 0 ? "" : "disabled"} title="Make it a subtodo of the todo above">→ Indent</button>
        <button class="btn" data-act="outdent" ${t.parent.parent ? "" : "disabled"} title="Move it one level up">← Outdent</button>
        ${fileOrder ? `<button class="btn" data-act="up" ${i > 0 ? "" : "disabled"}>↑ Move up</button>
        <button class="btn" data-act="down" ${i < sibs.length - 1 ? "" : "disabled"}>↓ Move down</button>` : ""}
        <button class="btn danger" data-act="delete">Delete</button>
      </div>
      ${fileOrder ? "" : `<p class="fine">Moving by hand works in the File view.</p>`}`,
    (panel) => {
      setupEditor(panel, (text) => {
        if (!text) return;
        const p = C.parseText(text, true), next = C.composeText(p);
        closeSheet();
        if (next !== t.text) change({ type: "edit", key, text: next, message: `Edit: ${p.title}` });
      }, { focus: false }); // don't pop up the keyboard just for looking
      $(".actions", panel).addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (!act) return;
        const ops = {
          done: () => ({ type: "done", key, done: !t.done, message: `${t.done ? "Reopen" : "Done"}: ${t.title}` }),
          indent: () => ({ type: "indent", key, into: C.keyOf(sibs[i - 1]), message: `Indent: ${t.title}` }),
          outdent: () => ({ type: "outdent", key, message: `Outdent: ${t.title}` }),
          up: () => ({ type: "move", key, target: C.keyOf(sibs[i - 1]), after: false, message: `Move: ${t.title}` }),
          down: () => ({ type: "move", key, target: C.keyOf(sibs[i + 1]), after: true, message: `Move: ${t.title}` }),
          delete: () => ({ type: "delete", key, message: `Delete: ${t.title}` }),
        };
        if (act === "sub") return openAdd(t);
        const n = [...t.walk()].length;
        if (act === "delete" && n && !confirm(`Delete “${t.title}” and its ${plural(n, "subtodo")}?`)) return;
        closeSheet();
        change(ops[act]());
      });
    });
  }

  function openMenu() {
    const labels = knownLabels();
    const link = cfg && `https://github.com/${cfg.owner}/${cfg.repo}/blob/${encodeURIComponent(cfg.branch)}/${cfg.path}`;
    openSheet(`<div class="sheet-head"><b>Options</b><button class="x" data-close aria-label="Close">✕</button></div>
      <button class="item" data-act="done">${view.hideDone ? "Show done todos" : "Hide done todos"}</button>
      <div class="pills"><span class="lbl">Only</span>
        <button class="pill" data-filter="" aria-pressed="${!view.label}">All</button>
        ${labels.map((l) => `<button class="pill c-${C.labelColor(l)}" data-filter="${esc(l)}" aria-pressed="${view.label === l}">#${esc(l)}</button>`).join("")}</div>
      <button class="item" data-act="refresh">Refresh now</button>
      <button class="item" data-act="settings">Settings</button>
      ${link ? `<a class="item" href="${esc(link)}" target="_blank" rel="noopener">Open ${esc(cfg.path)} on GitHub ↗</a>` : ""}
      ${status.detail ? `<p class="fine error">${esc(status.detail)}</p>` : ""}`,
    (panel) => panel.addEventListener("click", (e) => {
      const f = e.target.closest("[data-filter]");
      if (f) { view.label = f.dataset.filter || null; save(); render(); closeSheet(); return; }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "done") { view.hideDone = !view.hideDone; save(); render(); closeSheet(); }
      if (act === "refresh") { closeSheet(); sync(true); }
      if (act === "settings") openSettings();
    }));
  }

  function parseRepo(text) {
    const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text.trim()) || /^([^/\s]+)\/([^/\s]+)$/.exec(text.trim());
    return m && { owner: m[1], repo: m[2] };
  }

  function openSettings() {
    const c = cfg || { branch: "main", path: "todo.md", api: "https://api.github.com", token: "" };
    openSheet(`<div class="sheet-head"><b>Connect GitHub</b><button class="x" data-close aria-label="Close">✕</button></div>
      <label class="form">Repository<input name="repo" value="${c.owner ? esc(`${c.owner}/${c.repo}`) : ""}" placeholder="matthiaskettl/todo" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="form">Access token<input name="token" type="password" value="${esc(c.token)}" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <details><summary>Advanced</summary>
        <label class="form">Branch<input name="branch" value="${esc(c.branch)}" autocapitalize="off" spellcheck="false"></label>
        <label class="form">File<input name="path" value="${esc(c.path)}" autocapitalize="off" spellcheck="false"></label>
        <label class="form">API<input name="api" value="${esc(c.api)}" autocapitalize="off" spellcheck="false"></label>
      </details>
      <p class="fine error" hidden></p>
      <div class="sheet-actions"><button class="btn primary" data-connect>Save and connect</button></div>
      <div class="howto"><b>Getting a token</b><ol>
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → new fine-grained token</a>.</li>
        <li><i>Repository access:</i> Only select repositories → your todo repository.</li>
        <li><i>Permissions:</i> Repository permissions → <b>Contents: Read and write</b>.</li>
        <li>Generate it, copy it, paste it above.</li></ol>
        <p>The token is stored only on this device and is sent only to GitHub.</p></div>`,
    (panel) => $("[data-connect]", panel).addEventListener("click", async () => {
      const val = (name) => $(`[name=${name}]`, panel).value.trim();
      const repo = parseRepo(val("repo")), err = $(".error", panel);
      const fail = (msg) => { err.textContent = msg; err.hidden = false; };
      if (!repo) return fail("Enter the repository as owner/name, e.g. matthiaskettl/todo.");
      if (!val("token")) return fail("Enter an access token (see below).");
      const next = { ...repo, token: val("token"), branch: val("branch") || "main", path: val("path") || "todo.md", api: val("api") || "https://api.github.com" };
      const moved = !cfg || ["owner", "repo", "branch", "path", "api"].some((k) => cfg[k] !== next[k]);
      if (moved && pending.length && !confirm(`${plural(pending.length, "change")} not synced yet will be dropped. Continue?`)) return;
      const old = { cfg, base, pending };
      cfg = next;
      if (moved) { base = null; pending = []; }
      $("[data-connect]", panel).disabled = true;
      await sync(true);
      $("[data-connect]", panel).disabled = false;
      if (status.state === "error" || status.state === "offline") {
        ({ cfg, base, pending } = old);
        rebuild();
        render();
        return fail(status.detail);
      }
      store.set("cfg", cfg);
      save();
      closeSheet();
    }));
  }

  // --- toast --------------------------------------------------------------------------

  let toastTimer;
  function toast(text, action, onAction) {
    const el = $("#toast");
    el.innerHTML = `<span>${esc(text)}</span>` + (action ? `<button>${esc(action)}</button>` : "");
    el.hidden = false;
    if (action) $("button", el).onclick = () => { el.hidden = true; onAction(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 5000 : 3500);
  }

  // --- events ---------------------------------------------------------------------------

  $("#list").addEventListener("click", (e) => {
    if (e.target.closest("[data-open-settings]")) return openSettings();
    const row = e.target.closest(".row");
    if (!row) return;
    const t = rows[+row.dataset.i].task;
    if (e.target.closest(".check")) {
      change({ type: "done", key: C.keyOf(t), done: !t.done, message: `${t.done ? "Reopen" : "Done"}: ${t.title}` });
    } else openTask(t);
  });
  $("#views").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]");
    if (!b) return;
    view.sort = b.dataset.sort;
    save();
    render();
    scrollTo({ top: 0 });
  });
  $("#counts").addEventListener("click", () => { view.hideDone = !view.hideDone; save(); render(); });
  $("#filter").addEventListener("click", () => { view.label = null; save(); render(); });
  $("#menu").addEventListener("click", openMenu);
  $("#add").addEventListener("click", () => (cfg ? openAdd() : openSettings()));
  $("#sync").addEventListener("click", () => {
    if (status.detail) toast(status.detail);
    sync(true);
  });
  $("#sheet").addEventListener("click", (e) => {
    if (e.target === e.currentTarget || e.target.closest("[data-close]")) closeSheet();
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });
  // Fetch changes from other devices whenever the app comes back to the screen.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(true); });
  addEventListener("online", () => sync(true));
  setInterval(() => { if (document.visibilityState === "visible" && !running) sync(true); }, 60000);

  rebuild();
  render();
  if (cfg) sync(true);
  else openSettings();
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
