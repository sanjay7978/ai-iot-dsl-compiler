// graph.js — SVG drawings: the syntax tree, the control-flow graph and the scanner DFA.

import { svgEl, textWidth, panZoom, escapeHtml } from "./util.js";

const MONO = "11.5px ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "600 11.5px ui-sans-serif, system-ui, -apple-system, sans-serif";

function nodeText(n) {
  if (n.kind === "logic") return { key: "", value: n.label };
  const i = n.label.indexOf(": ");
  if (i >= 0) return { key: n.label.slice(0, i), value: n.label.slice(i + 2) };
  return { key: n.label, value: "" };
}

function toolbar(container, zoomer, fit) {
  const bar = document.createElement("div");
  bar.className = "graph-tools";
  bar.innerHTML =
    '<button type="button" data-z="in" title="Zoom in">+</button>' +
    '<button type="button" data-z="out" title="Zoom out">−</button>' +
    '<button type="button" data-z="fit" title="Fit to view">Fit</button>';
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.z === "in") zoomer.zoom(1.2);
    else if (b.dataset.z === "out") zoomer.zoom(1 / 1.2);
    else fit();
  });
  container.appendChild(bar);
}

// ---- Syntax tree ------------------------------------------------------------------

// Draws the AST top-down (leaves spread left to right, parents centred over
// their children). Returns {nodes} so callers can link or animate nodes.
export function renderTree(container, root, { onHover, onClick, ruleNumbers = true } = {}) {
  container.innerHTML = "";
  container.classList.add("graph");
  const svg = svgEl("svg", { class: "graph-svg", role: "img", "aria-label": "Abstract syntax tree" }, container);
  const g = svgEl("g", {}, svg);
  const nodes = [];
  const GAP_X = 14, GAP_Y = 64, H = 34;

  let rule = 0;
  function build(n, depth) {
    const t = nodeText(n);
    let key = t.key;
    if (n.kind === "rule" && ruleNumbers) key += " " + ++rule;
    const w = Math.max(textWidth(key, SANS) + (t.value ? textWidth(t.value, MONO) + 8 : 0) + 22, 46);
    const node = { data: n, key, value: t.value, w, depth, children: [] };
    nodes.push(node);
    node.children = n.children.map((c) => build(c, depth + 1));
    return node;
  }
  const top = build(root, 0);

  let cursor = 0;
  function place(node) {
    if (!node.children.length) {
      node.x = cursor + node.w / 2;
      cursor += node.w + GAP_X;
    } else {
      node.children.forEach(place);
      const first = node.children[0], last = node.children[node.children.length - 1];
      node.x = (first.x + last.x) / 2;
      const span = last.x + last.w / 2 - (first.x - first.w / 2);
      if (node.w > span) {   // a wide parent: shift its subtree right to make room
        const shift = (node.w - span) / 2;
        const move = (n) => { n.x += shift; n.children.forEach(move); };
        node.children.forEach(move);
        node.x += shift;
        cursor += node.w - span;
      }
    }
    node.y = node.depth * GAP_Y + 20;
  }
  place(top);
  const width = cursor, height = Math.max(...nodes.map((n) => n.y)) + H + 20;

  const edges = svgEl("g", { class: "g-edges" }, g);
  const layer = svgEl("g", { class: "g-nodes" }, g);
  nodes.forEach((node, i) => {
    node.index = i;
    for (const c of node.children) {
      const y1 = node.y + H, y2 = c.y, my = (y1 + y2) / 2;
      c.edge = svgEl("path", { d: `M${node.x},${y1} C${node.x},${my} ${c.x},${my} ${c.x},${y2}`, class: "g-edge" }, edges);
    }
    const grp = svgEl("g", { class: `g-node k-${node.data.kind}`, transform: `translate(${node.x - node.w / 2},${node.y})`, "data-click": "1" }, layer);
    svgEl("rect", { width: node.w, height: H, rx: 8 }, grp);
    const text = svgEl("text", { x: 11, y: 21 }, grp);
    const k = svgEl("tspan", { class: "g-key" }, text);
    k.textContent = node.key;
    if (node.value) {
      const v = svgEl("tspan", { class: "g-val", dx: 6 }, text);
      v.textContent = node.value;
    }
    node.el = grp;
    grp.addEventListener("mouseenter", () => onHover && onHover(node.data, true));
    grp.addEventListener("mouseleave", () => onHover && onHover(node.data, false));
    grp.addEventListener("click", () => onClick && onClick(node.data));
    if (node.data.start && node.data.start[0])
      grp.dataset.src = [node.data.start[0], node.data.start[1], node.data.end[0], node.data.end[1]].join(",");
  });

  const zoomer = panZoom(svg, g, { wheelZoom: false });
  const fit = () => zoomer.fit(width, height);
  toolbar(container, zoomer, fit);
  requestAnimationFrame(fit);
  return { nodes, fit, svg };
}

// ---- Control-flow graph -------------------------------------------------------------

// Draws basic blocks as boxes in layers (by distance from the entry block),
// with true/false labels on branch edges and liveness under each block.
export function renderCfg(container, cfg, code, { onHover } = {}) {
  container.innerHTML = "";
  container.classList.add("graph");
  const svg = svgEl("svg", { class: "graph-svg cfg-svg", role: "img", "aria-label": "Control-flow graph" }, container);
  const defs = svgEl("defs", {}, svg);
  const marker = svgEl("marker", { id: "cfg-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, defs);
  svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "g-arrow" }, marker);
  const g = svgEl("g", {}, svg);

  const byId = Object.fromEntries(cfg.map((b) => [b.id, b]));
  const layer = {};
  const visit = (id, d) => {
    if (layer[id] !== undefined && layer[id] >= d) return;
    layer[id] = d;
    byId[id].succ.forEach((s) => s > id && visit(s, d + 1));
  };
  if (cfg.length) visit(1, 0);
  cfg.forEach((b) => (layer[b.id] = layer[b.id] ?? 0));
  const layers = [];
  cfg.forEach((b) => (layers[layer[b.id]] = layers[layer[b.id]] || []).push(b));

  const LINE = 17, PADX = 12;
  const boxes = {};
  cfg.forEach((b) => {
    const lines = code.slice(b.first, b.last).map((ins) => ins.text);
    const head = `B${b.id}${b.id === 1 ? "  entry" : ""}`;
    const w = Math.max(...lines.map((l) => textWidth(l, MONO)), textWidth(head, SANS), 70) + PADX * 2;
    const live = `in {${b.liveIn.join(", ")}}  out {${b.liveOut.join(", ")}}`;
    boxes[b.id] = { b, lines, head, live, w: Math.max(w, textWidth(live, MONO) + PADX * 2), h: 30 + lines.length * LINE + 24 };
  });

  let y = 16, width = 0;
  const GAP = 28;
  layers.forEach((row) => {
    const rowW = row.reduce((s, b) => s + boxes[b.id].w, 0) + GAP * (row.length - 1);
    width = Math.max(width, rowW);
  });
  layers.forEach((row) => {
    const rowW = row.reduce((s, b) => s + boxes[b.id].w, 0) + GAP * (row.length - 1);
    let x = (width - rowW) / 2;
    const rowH = Math.max(...row.map((b) => boxes[b.id].h));
    row.forEach((b) => {
      const box = boxes[b.id];
      box.x = x;
      box.y = y;
      x += box.w + GAP;
    });
    y += rowH + 46;
  });
  const height = y;

  const edges = svgEl("g", { class: "g-edges" }, g);
  const nodes = svgEl("g", { class: "g-nodes" }, g);
  cfg.forEach((b) => {
    const from = boxes[b.id];
    const last = code[b.last - 1];
    b.succ.forEach((s) => {
      const to = boxes[s];
      const x1 = from.x + from.w / 2, y1 = from.y + from.h;
      const x2 = to.x + to.w / 2, y2 = to.y;
      let d;
      if (y2 > y1) {
        const my = (y1 + y2) / 2;
        d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2 - 2}`;
      } else {   // backward or same row: route around the side
        const side = Math.max(from.x + from.w, to.x + to.w) + 30;
        d = `M${from.x + from.w},${from.y + from.h / 2} C${side},${from.y + from.h / 2} ${side},${to.y + to.h / 2} ${to.x + to.w},${to.y + to.h / 2}`;
      }
      svgEl("path", { d, class: "g-edge cfg-edge", "marker-end": "url(#cfg-arrow)" }, edges);
      if (last && last.op === "if_false") {
        const isJump = code.findIndex((ins) => ins.op === "label" && ins.label === last.label) === to.b.first;
        const label = svgEl("text", { x: (x1 + x2) / 2 + (x2 < x1 ? -12 : 8), y: (y1 + y2) / 2 + 4, class: "cfg-label" }, edges);
        label.textContent = isJump ? "false" : "true";
      }
    });
    if (b.exits) {
      const x = from.x + from.w / 2, yy = from.y + from.h;
      svgEl("path", { d: `M${x},${yy} L${x},${yy + 22}`, class: "g-edge cfg-edge exit", "marker-end": "url(#cfg-arrow)" }, edges);
      const t = svgEl("text", { x: x + 6, y: yy + 18, class: "cfg-label" }, edges);
      t.textContent = "exit";
    }

    const grp = svgEl("g", { class: "cfg-block", transform: `translate(${from.x},${from.y})`, "data-click": "1" }, nodes);
    svgEl("rect", { width: from.w, height: from.h, rx: 8 }, grp);
    const head = svgEl("text", { x: PADX, y: 19, class: "cfg-head" }, grp);
    head.textContent = from.head;
    svgEl("line", { x1: 0, x2: from.w, y1: 28, y2: 28, class: "cfg-sep" }, grp);
    from.lines.forEach((l, i) => {
      const t = svgEl("text", { x: PADX + (/^L\d+:|^#/.test(l) ? 0 : 10), y: 44 + i * LINE, class: /^#/.test(l) ? "cfg-comment" : "cfg-code" }, grp);
      t.textContent = l;
    });
    const live = svgEl("text", { x: PADX, y: from.h - 9, class: "cfg-live" }, grp);
    live.textContent = from.live;
    grp.addEventListener("mouseenter", () => onHover && onHover(b, true));
    grp.addEventListener("mouseleave", () => onHover && onHover(b, false));
  });

  const zoomer = panZoom(svg, g);
  const fit = () => zoomer.fit(width + 40, height);
  toolbar(container, zoomer, fit);
  requestAnimationFrame(fit);
  return { fit };
}

// ---- Scanner DFA ----------------------------------------------------------------------

// Hand-placed positions for the DFA states (a readable layout of the automaton).
const DFA_POS = {
  START: [300, 246], IDENT: [110, 106], INT: [110, 386], DOT: [110, 506], FRAC: [250, 506],
  GT: [470, 96], GE: [600, 96], LT: [470, 176], LE: [600, 176], ASSIGN: [470, 256], EQ: [600, 256],
  BANG: [470, 336], NE: [600, 336], PUNCT: [300, 436], OP: [420, 476], COMMENT: [300, 76], ERROR: [520, 436],
};

export function renderDfa(container, dfa) {
  container.innerHTML = "";
  const svg = svgEl("svg", { class: "dfa-svg", viewBox: "0 0 680 556", role: "img", "aria-label": "Scanner DFA" }, container);
  const defs = svgEl("defs", {}, svg);
  const marker = svgEl("marker", { id: "dfa-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, defs);
  svgEl("path", { d: "M0,0 L10,5 L0,10 z", class: "g-arrow" }, marker);
  const R = 26;
  const edgeEls = {}, stateEls = {};
  const eg = svgEl("g", {}, svg), sg = svgEl("g", {}, svg);

  for (const [from, to, label] of dfa.edges) {
    const [x1, y1] = DFA_POS[from], [x2, y2] = DFA_POS[to];
    let d, lx, ly;
    if (from === to) {   // self-loop above the state
      d = `M${x1 - 12},${y1 - R + 4} C${x1 - 40},${y1 - 80} ${x1 + 40},${y1 - 80} ${x1 + 12},${y1 - R + 4}`;
      lx = x1; ly = y1 - 66;
      if (from === "INT" || from === "FRAC") { d = `M${x1 - R + 4},${y1 + 12} C${x1 - 80},${y1 + 40} ${x1 - 80},${y1 - 40} ${x1 - R + 4},${y1 - 12}`; lx = x1 - 70; ly = y1 + 4; }
    } else {
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      const sx = x1 + (dx / len) * R, sy = y1 + (dy / len) * R, ex = x2 - (dx / len) * (R + 2), ey = y2 - (dy / len) * (R + 2);
      d = `M${sx},${sy} L${ex},${ey}`;
      lx = (sx + ex) / 2 + (dy / len) * 10;
      ly = (sy + ey) / 2 - (dx / len) * 10 + 4;
    }
    const p = svgEl("path", { d, class: "dfa-edge", "marker-end": "url(#dfa-arrow)" }, eg);
    const t = svgEl("text", { x: lx, y: ly, class: "dfa-label", "text-anchor": "middle" }, eg);
    t.textContent = label;
    edgeEls[from + ">" + to] = [p, t];
  }
  for (const s of dfa.states) {
    const [x, y] = DFA_POS[s.id];
    const grp = svgEl("g", { class: "dfa-state" + (s.accepting ? " accepting" : "") + (s.id === "ERROR" ? " error" : "") }, sg);
    svgEl("circle", { cx: x, cy: y, r: R }, grp);
    if (s.accepting) svgEl("circle", { cx: x, cy: y, r: R - 4, class: "inner" }, grp);
    const t = svgEl("text", { x, y: y + 4, "text-anchor": "middle" }, grp);
    t.textContent = s.id === "START" ? "start" : s.id.toLowerCase();
    const title = svgEl("title", {}, grp);
    title.textContent = `${s.id}: ${s.label}${s.accepting ? " (accepting)" : ""}`;
    stateEls[s.id] = grp;
  }
  const [sx, sy] = DFA_POS.START;
  svgEl("path", { d: `M${sx - 70},${sy} L${sx - R - 2},${sy}`, class: "dfa-edge", "marker-end": "url(#dfa-arrow)" }, eg);

  return {
    highlight(from, to) {
      Object.values(stateEls).forEach((e) => e.classList.remove("active", "previous"));
      Object.values(edgeEls).forEach(([p, t]) => { p.classList.remove("active"); t.classList.remove("active"); });
      if (to && stateEls[to]) stateEls[to].classList.add("active");
      if (from && from !== to && stateEls[from]) stateEls[from].classList.add("previous");
      const e = edgeEls[from + ">" + to];
      if (e) e.forEach((x) => x.classList.add("active"));
    },
  };
}

export { escapeHtml };
