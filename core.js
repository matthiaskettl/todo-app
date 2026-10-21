// The todo.md model: parsing, writing, dates, views and changes.
// A port of the model in ../todo.py. Keep both in sync: a test checks that
// they read and write files identically (node tests/core-parity.js).
(function (exports) {
  "use strict";

  const INDENT = "  ";
  const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const NO_DUE = "9999-12-31";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; // Date.getDay() order
  const PRIO_COLOR = { 1: "red", 2: "yellow", 3: "cyan" };
  const LABEL_COLORS = ["magenta", "blue", "cyan", "green"];

  const TASK_RE = /^(\s*)[-*+] \[([ xX])\](?:\s+(.*?))?\s*$/;
  const PRIO_RE = /(?:^|\s+)!([1-3])(?=\s|$)/g;
  const DUE_RE = /(?:^|\s+)@(\d{4}-\d{2}-\d{2})(?=\s|$)/g;
  const LABEL_RE = /(?:^|\s+):([^\s,:]+(?:,[^\s,:]+)*):(?=\s|$)/g;
  const REL_DUE_RE = /(^|\s)@(today|tomorrow|tom|mon|tue|wed|thu|fri|sat|sun|\+\d+[dw]?)(?=\s|$)/gi;

  // --- dates (local time, at midnight) ---------------------------------------

  const pad = (n) => String(n).padStart(2, "0");
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const daysBetween = (a, b) => Math.round((b - a) / 86400000);

  function today() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function parseIso(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null;
  }

  /** Turn 'today', 'tomorrow', 'fri', '+3', '+2w' or 'YYYY-MM-DD' into an ISO date. */
  function resolveDate(word, t = today()) {
    const w = word.trim().toLowerCase().replace(/^@+/, "");
    let d;
    if (w === "today") d = t;
    else if (w === "tomorrow" || w === "tom") d = addDays(t, 1);
    else if (/^\+\d+[dw]?$/.test(w)) {
      const n = parseInt(w.slice(1), 10);
      d = addDays(t, w.endsWith("w") ? n * 7 : n);
    } else if (WEEKDAYS.includes(w)) { // next such weekday, never today
      const weekday = (t.getDay() + 6) % 7;
      d = addDays(t, (((WEEKDAYS.indexOf(w) - weekday - 1) % 7) + 7) % 7 + 1);
    } else {
      d = parseIso(w);
      if (!d) throw new Error(`Not a date: ${word}`);
    }
    return isoDate(d);
  }

  /** Short due date for people ('today', 'Wed 21 Oct', '3d overdue') and days from today. */
  function dueText(iso, done = false, t = today()) {
    const d = parseIso(iso);
    const days = daysBetween(t, d);
    let text;
    if (done || days >= 7) {
      text = `${d.getDate()} ${MONTHS[d.getMonth()]}` + (d.getFullYear() !== t.getFullYear() ? ` ${d.getFullYear()}` : "");
    } else if (days < -1) text = `${-days}d overdue`;
    else if (days <= 1) text = ["yesterday", "today", "tomorrow"][days + 1];
    else text = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return { text, days };
  }

  /** [colour, bold] for a due date. */
  function dueStyle(days, done = false) {
    if (done) return ["grey", false];
    if (days < 0) return ["red", true];
    if (days === 0) return ["yellow", true];
    if (days === 1) return ["yellow", false];
    return days < 7 ? ["default", false] : ["grey", false];
  }

  // --- todo text: 'Title !1 @2026-10-12 :a,b:' --------------------------------

  /** Split a todo's text into {title, prio, due, labels}. With relative, @tomorrow etc. are resolved first. */
  function parseText(text, relative = false) {
    if (relative) text = text.replace(REL_DUE_RE, (m, pre, w) => pre + "@" + resolveDate(w));
    let prio = null, due = null;
    const labels = [];
    text = text.replace(PRIO_RE, (m, p) => { prio = +p; return ""; });
    text = text.replace(DUE_RE, (m, s) => {
      const d = parseIso(s);
      if (!d) return m; // e.g. @2026-13-45 stays part of the title
      due = isoDate(d);
      return "";
    });
    text = text.replace(LABEL_RE, (m, group) => {
      for (const label of group.split(",")) {
        if (!labels.some((l) => l.toLowerCase() === label.toLowerCase())) labels.push(label);
      }
      return "";
    });
    return { title: text.trim(), prio, due, labels };
  }

  /** The text of a todo as written in the file, from its parts. */
  function composeText({ title, prio, due, labels }) {
    return [title, prio && `!${prio}`, due && `@${due}`, labels.length && `:${labels.join(",")}:`]
      .filter(Boolean).join(" ");
  }

  class Task {
    constructor(text = "", done = false, parent = null, relative = false) {
      Object.assign(this, parseText(text, relative));
      this.done = done;
      this.parent = parent;
      this.children = [];
      this.notes = []; // non-task lines following this task, kept verbatim
    }

    get text() { return composeText(this); }

    hasLabel(label) {
      label = label.toLowerCase();
      return this.labels.some((l) => l.toLowerCase() === label);
    }

    *walk() {
      for (const c of this.children) {
        yield c;
        yield* c.walk();
      }
    }

    ancestors() { // without the root, which is not a task
      const out = [];
      for (let p = this.parent; p && p.parent; p = p.parent) out.push(p);
      return out;
    }
  }

  // --- the file ----------------------------------------------------------------

  function expandedWidth(indent) { // like Python's str.expandtabs(4)
    let col = 0;
    for (const ch of indent) col += ch === "\t" ? 4 - (col % 4) : 1;
    return col;
  }

  /** Parse todo.md into {root, header}. */
  function parse(content) {
    const root = new Task();
    const header = [];
    const stack = []; // [indent width, task] along the current branch
    let last = null;
    for (const line of content.split(/\r\n|\r|\n/)) {
      const m = TASK_RE.exec(line);
      if (!m) {
        if (!last) header.push(line);
        else if (line.trim()) last.notes.push(line);
        continue;
      }
      const indent = expandedWidth(m[1]);
      while (stack.length && stack[stack.length - 1][0] >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1][1] : root;
      last = new Task(m[3] || "", m[2] !== " ", parent);
      parent.children.push(last);
      stack.push([indent, last]);
    }
    while (header.length && !header[header.length - 1].trim()) header.pop();
    return { root, header };
  }

  function dump(doc) {
    const lines = doc.header.length ? [...doc.header, ""] : [];
    const emit = (task, depth) => {
      for (const t of task.children) {
        lines.push(`${INDENT.repeat(depth)}- [${t.done ? "x" : " "}] ${t.text}`.replace(/\s+$/, ""));
        lines.push(...t.notes);
        emit(t, depth + 1);
      }
    };
    emit(doc.root, 0);
    return lines.join("\n") + "\n";
  }

  // --- views -------------------------------------------------------------------

  const firstLabel = (t) => (t.labels.length ? t.labels.map((l) => l.toLowerCase()).sort()[0] : null);

  const SORTS = { // views, in the order the UI offers them; sorting never changes the file
    due: (t) => [t.done, t.due || NO_DUE, t.prio || 4],
    priority: (t) => [t.done, t.prio || 4, t.due || NO_DUE],
    label: (t) => [t.done, firstLabel(t) || "￿", t.prio || 4, t.due || NO_DUE],
    file: null,
  };

  function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  function labelColor(label) {
    let sum = 0;
    for (const ch of label.toLowerCase()) sum += ch.codePointAt(0);
    return LABEL_COLORS[sum % LABEL_COLORS.length];
  }

  /** [heading, colour] of the group a top-level todo is shown in; null in file order. */
  function section(t, sort) {
    if (sort === "file") return null;
    if (t.done) return ["Done", "green"];
    if (sort === "priority") {
      return { 1: ["High priority", "red"], 2: ["Medium priority", "yellow"], 3: ["Low priority", "cyan"] }[t.prio]
        || ["No priority", "grey"];
    }
    if (sort === "label") {
      const label = firstLabel(t);
      return label ? ["#" + label, labelColor(label)] : ["No label", "grey"];
    }
    if (!t.due) return ["No date", "grey"];
    const { days } = dueText(t.due);
    if (days < 0) return ["Overdue", "red"];
    if (days === 0) return ["Today", "yellow"];
    if (days === 1) return ["Tomorrow", "default"];
    return days < 7 ? ["Next 7 days", "default"] : ["Later", "grey"];
  }

  /** True if t or one of its parents has the label (or there is no label filter). */
  function inFilter(t, label) {
    return !label || [t, ...t.ancestors()].some((a) => a.hasLabel(label));
  }

  /** Children of parent as displayed: filtered, done ones left out if hidden, sorted. */
  function ordered(parent, view) {
    const shown = parent.children.filter((t) => !(view.hideDone && t.done)
      && [t, ...t.walk()].some((d) => inFilter(d, view.label))); // keep parents for context
    const key = SORTS[view.sort];
    return key ? shown.map((t) => [key(t), t]).sort((a, b) => compareKeys(a[0], b[0])).map((x) => x[1]) : shown;
  }

  /** Visible rows [{task, depth}] in display order. */
  function visible(doc, view) {
    const rows = [];
    const walk = (task, depth) => {
      for (const t of ordered(task, view)) {
        rows.push({ task: t, depth });
        walk(t, depth + 1);
      }
    };
    walk(doc.root, 0);
    return rows;
  }

  // --- changes -------------------------------------------------------------------
  // Changes are plain data, so they can be stored while offline and applied again on
  // top of a newer version of the file if another device changed it in the meantime.
  // A todo is found by the texts of its parents and itself (its "key").

  const keyOf = (t) => [...t.ancestors().reverse(), t].map((x) => x.text);

  function find(doc, key) {
    const search = (task, depth) => {
      for (const c of task.children) {
        if (c.text !== key[depth]) continue;
        if (depth === key.length - 1) return c;
        const hit = search(c, depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    return key && key.length ? search(doc.root, 0) : null;
  }

  function reopenAncestors(t) {
    for (const a of t.ancestors()) a.done = false;
  }

  /** Apply a change to doc in place. Returns false if it no longer fits the file. */
  function apply(doc, op) {
    if (op.type === "restore") { // undo: only if nothing else changed since
      if (dump(doc) !== op.after) return false;
      Object.assign(doc, parse(op.before));
      return true;
    }
    if (op.type === "add") {
      const parent = op.parent ? find(doc, op.parent) : doc.root;
      if (!parent) return false;
      const t = new Task(op.text, false, parent);
      const after = op.after ? parent.children.findIndex((c) => c.text === op.after[op.after.length - 1]) : -1;
      parent.children.splice(after >= 0 ? after + 1 : parent.children.length, 0, t);
      reopenAncestors(t); // an open subtodo reopens its parents
      return true;
    }
    const t = find(doc, op.key);
    if (!t) return false;
    switch (op.type) {
      case "edit": Object.assign(t, parseText(op.text)); break;
      case "done":
        t.done = op.done;
        for (const other of op.done ? t.walk() : t.ancestors()) other.done = op.done;
        break;
      case "prio": t.prio = op.prio; break;
      case "due": t.due = op.due; break;
      case "delete": t.parent.children.splice(t.parent.children.indexOf(t), 1); break;
      case "move": { // next to a sibling
        const sibs = t.parent.children;
        const target = sibs.find((c) => c !== t && c.text === op.target[op.target.length - 1]);
        if (!target) return false;
        sibs.splice(sibs.indexOf(t), 1);
        sibs.splice(sibs.indexOf(target) + (op.after ? 1 : 0), 0, t);
        break;
      }
      case "indent": { // become the last subtodo of a sibling
        const into = t.parent.children.find((c) => c !== t && c.text === op.into[op.into.length - 1]);
        if (!into) return false;
        t.parent.children.splice(t.parent.children.indexOf(t), 1);
        into.children.push(t);
        t.parent = into;
        if (!t.done) reopenAncestors(t);
        break;
      }
      case "outdent": {
        const p = t.parent, g = p.parent;
        if (!g) return false;
        p.children.splice(p.children.indexOf(t), 1);
        g.children.splice(g.children.indexOf(p) + 1, 0, t);
        t.parent = g;
        break;
      }
      default: return false;
    }
    return true;
  }

  /** Commit message for a batch of changes, like todo.py. */
  function commitMessage(ops) {
    const msgs = ops.map((o) => o.message);
    return msgs.length === 1 ? msgs[0] : `${msgs.length} changes\n\n${msgs.join("\n")}`;
  }

  Object.assign(exports, {
    INDENT, NO_DUE, PRIO_COLOR, LABEL_COLORS, SORTS,
    today, isoDate, addDays, parseIso, resolveDate, dueText, dueStyle,
    parseText, composeText, Task, parse, dump,
    firstLabel, labelColor, section, inFilter, ordered, visible,
    keyOf, find, apply, commitMessage,
  });
})(typeof module !== "undefined" ? module.exports : (window.TodoCore = {}));
