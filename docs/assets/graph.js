/*
 * Concordia ドメイン関連グラフ — 依存ライブラリ無しの canvas force-directed graph.
 * window.GRAPH_DATA = { categories: {key:{label,color}}, nodes: [...], edges: [...] }
 * を読み込んで描画する。CDN を使わないのでオフラインでも動く。
 */
(function () {
  const data = window.GRAPH_DATA;
  if (!data) return;
  const canvas = document.getElementById("graph-canvas");
  const infoBox = document.getElementById("node-info");
  const legendBox = document.getElementById("legend-rows");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const nodes = data.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => ({ from: byId.get(e.from), to: byId.get(e.to) }));

  // ノードごとの入次数 (依存される数) で半径を決める
  const inDeg = new Map(nodes.map((n) => [n.id, 0]));
  edges.forEach((e) => inDeg.set(e.to.id, (inDeg.get(e.to.id) || 0) + 1));
  nodes.forEach((n) => {
    n.r = 9 + Math.min(18, (inDeg.get(n.id) || 0) * 1.6);
    n.deg = inDeg.get(n.id) || 0;
  });

  const catState = {}; // category -> visible
  Object.keys(data.categories).forEach((k) => (catState[k] = true));

  let W = 0, H = 0, DPR = window.devicePixelRatio || 1;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // 初期位置: カテゴリごとに円環状に配置してから力学で整える
  const catKeys = Object.keys(data.categories);
  nodes.forEach((n, i) => {
    const ci = catKeys.indexOf(n.category);
    const ang = (i / nodes.length) * Math.PI * 2;
    const ringBase = 120 + ci * 18;
    n.x = 500 + Math.cos(ang) * ringBase + (Math.random() - 0.5) * 60;
    n.y = 320 + Math.sin(ang) * ringBase + (Math.random() - 0.5) * 60;
    n.vx = 0; n.vy = 0;
  });

  let selected = null;
  let hovered = null;
  let dragging = null;
  let panX = 0, panY = 0, scale = 1;
  let isPanning = false, panStart = null;

  // ---- force simulation ----
  let alpha = 1;
  function tick() {
    const cx = W / 2, cy = H / 2;
    // 反発
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!catState[a.category]) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (!catState[b.category]) continue;
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy || 0.01;
        const f = (4200 * alpha) / d2;
        const d = Math.sqrt(d2);
        const ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f;
        b.vx -= ux * f; b.vy -= uy * f;
      }
    }
    // バネ (エッジ)
    edges.forEach((e) => {
      if (!catState[e.from.category] || !catState[e.to.category]) return;
      let dx = e.to.x - e.from.x, dy = e.to.y - e.from.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = 130;
      const f = ((d - target) / d) * 0.012 * alpha;
      const fx = dx * f, fy = dy * f;
      e.from.vx += fx; e.from.vy += fy;
      e.to.vx -= fx; e.to.vy -= fy;
    });
    // 中心引力 + 摩擦
    nodes.forEach((n) => {
      if (n === dragging) return;
      n.vx += (cx - n.x) * 0.0009 * alpha;
      n.vy += (cy - n.y) * 0.0009 * alpha;
      n.vx *= 0.86; n.vy *= 0.86;
      n.x += n.vx; n.y += n.vy;
    });
    if (alpha > 0.04) alpha *= 0.992;
  }

  function tx(x) { return (x - W / 2) * scale + W / 2 + panX; }
  function ty(y) { return (y - H / 2) * scale + H / 2 + panY; }
  function inv(px, py) {
    return {
      x: (px - W / 2 - panX) / scale + W / 2,
      y: (py - H / 2 - panY) / scale + H / 2,
    };
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const neigh = new Set();
    if (selected || hovered) {
      const focus = selected || hovered;
      neigh.add(focus.id);
      edges.forEach((e) => {
        if (e.from === focus) neigh.add(e.to.id);
        if (e.to === focus) neigh.add(e.from.id);
      });
    }
    // edges
    edges.forEach((e) => {
      if (!catState[e.from.category] || !catState[e.to.category]) return;
      const focus = selected || hovered;
      const active = focus && (e.from === focus || e.to === focus);
      ctx.beginPath();
      ctx.moveTo(tx(e.from.x), ty(e.from.y));
      ctx.lineTo(tx(e.to.x), ty(e.to.y));
      ctx.strokeStyle = active ? "rgba(167,139,250,0.85)" : focus ? "rgba(80,90,120,0.12)" : "rgba(90,100,130,0.28)";
      ctx.lineWidth = active ? 1.8 : 1;
      ctx.stroke();
      // 矢印 (active のみ)
      if (active) {
        const ang = Math.atan2(ty(e.to.y) - ty(e.from.y), tx(e.to.x) - tx(e.from.x));
        const ex = tx(e.to.x) - Math.cos(ang) * (e.to.r * scale + 2);
        const ey = ty(e.to.y) - Math.sin(ang) * (e.to.r * scale + 2);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - Math.cos(ang - 0.4) * 8, ey - Math.sin(ang - 0.4) * 8);
        ctx.lineTo(ex - Math.cos(ang + 0.4) * 8, ey - Math.sin(ang + 0.4) * 8);
        ctx.closePath();
        ctx.fillStyle = "rgba(167,139,250,0.85)";
        ctx.fill();
      }
    });
    // nodes
    nodes.forEach((n) => {
      if (!catState[n.category]) return;
      const focus = selected || hovered;
      const dim = focus && !neigh.has(n.id);
      const col = data.categories[n.category]?.color || "#888";
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.beginPath();
      ctx.arc(tx(n.x), ty(n.y), n.r * scale, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      if (n === selected) {
        ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
      }
      // label
      if (!dim) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#e7eaf3";
        ctx.font = `${Math.max(10, 11 * scale)}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        ctx.fillText(n.label, tx(n.x), ty(n.y) + n.r * scale + 13);
      }
      ctx.globalAlpha = 1;
    });
  }

  function loop() { tick(); draw(); requestAnimationFrame(loop); }

  function nodeAt(px, py) {
    const p = inv(px, py);
    let best = null, bd = Infinity;
    nodes.forEach((n) => {
      if (!catState[n.category]) return;
      const dx = n.x - p.x, dy = n.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < n.r + 6 && d < bd) { bd = d; best = n; }
    });
    return best;
  }

  function showInfo(n) {
    if (!infoBox) return;
    if (!n) {
      infoBox.innerHTML = '<p class="hint">ノードをクリックすると役割・依存先を表示します。ドラッグで移動 / ホイールでズーム。</p>';
      return;
    }
    const cat = data.categories[n.category];
    const out = edges.filter((e) => e.from === n).map((e) => e.to.label);
    const inn = edges.filter((e) => e.to === n).map((e) => e.from.label);
    infoBox.innerHTML =
      `<h3>${n.label}</h3>` +
      `<div class="cat" style="color:${cat?.color}">${cat?.label || n.category}</div>` +
      `<p>${n.role || ""}</p>` +
      (n.files ? `<div class="files">${n.files.join("  ·  ")}</div>` : "") +
      `<div class="deps"><b>依存先 →</b> ${out.length ? out.join(", ") : "—"}</div>` +
      `<div class="deps"><b>← 被依存</b> ${inn.length ? inn.join(", ") : "—"} (${n.deg})</div>`;
  }

  // ---- interaction ----
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (dragging) {
      const p = inv(px, py);
      dragging.x = p.x; dragging.y = p.y; dragging.vx = 0; dragging.vy = 0;
      alpha = Math.max(alpha, 0.3);
      return;
    }
    if (isPanning && panStart) {
      panX = panStart.panX + (px - panStart.x);
      panY = panStart.panY + (py - panStart.y);
      return;
    }
    hovered = nodeAt(px, py);
    canvas.style.cursor = hovered ? "pointer" : "grab";
  });
  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const n = nodeAt(px, py);
    if (n) { dragging = n; }
    else { isPanning = true; panStart = { x: px, y: py, panX, panY }; }
  });
  window.addEventListener("mouseup", (e) => {
    if (dragging && !isPanning) {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const n = nodeAt(px, py);
      if (n === dragging) { selected = selected === n ? null : n; showInfo(selected); }
    }
    dragging = null; isPanning = false; panStart = null;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.min(2.6, Math.max(0.4, scale * delta));
  }, { passive: false });

  // ---- legend ----
  if (legendBox) {
    legendBox.innerHTML = "";
    Object.entries(data.categories).forEach(([key, c]) => {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span class="dot" style="background:${c.color}"></span><span>${c.label}</span>`;
      row.addEventListener("click", () => {
        catState[key] = !catState[key];
        row.classList.toggle("off", !catState[key]);
        alpha = Math.max(alpha, 0.5);
      });
      legendBox.appendChild(row);
    });
  }

  window.addEventListener("resize", resize);
  resize();
  showInfo(null);
  loop();
})();
