// Draws the daily Meta campaign stock dashboard as an SVG (converted to PNG for Slack in
// index.js). Static image, so every number is printed on it - no hover layer.
// Colors: reference palette (dataviz skill) - series blue for magnitude bars,
// status colors for stock health, each paired with a text label.

const W = 1200;
const PAD = 40;
const INNER = W - PAD * 2;

const C = {
  surface: "#fcfcfb",
  card: "#ffffff",
  border: "#e6e5e0",
  text: "#0b0b0b",
  text2: "#52514e",
  muted: "#7a7974",
  grid: "#ecebe7",
  series: "#2a78d6",
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
};
const FONT = "Helvetica, Arial, sans-serif";

const xml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n) => Number(n || 0).toLocaleString("en-IN");
const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(1)}%` : "0%");
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const text = (x, y, s, { size = 14, weight = 400, fill = C.text, anchor = "start" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${xml(s)}</text>`;

// Horizontal bar anchored at the left baseline: square start, 4px rounded data end
function hbar(x, y, w, h, fill) {
  if (w <= 0) return "";
  const r = Math.min(4, w / 2, h / 2);
  return `<path d="M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z" fill="${fill}"/>`;
}

function kpiTile(x, y, w, { label, value, note, accent }) {
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="112" rx="12" fill="${C.card}" stroke="${C.border}"/>`,
    accent ? `<rect x="${x}" y="${y + 18}" width="4" height="76" rx="2" fill="${accent}"/>` : "",
    text(x + 22, y + 34, label, { size: 15, fill: C.text2 }),
    text(x + 22, y + 76, value, { size: 38, weight: 700 }),
    text(x + 22, y + 99, note, { size: 13, fill: C.muted }),
  ].join("");
}

module.exports = function renderDashboard(s) {
  const out = [];
  let y = PAD;

  // Title
  out.push(text(PAD, y + 26, "Meta campaign stock report", { size: 28, weight: 700 }));
  out.push(text(W - PAD, y + 26, s.date, { size: 18, fill: C.text2, anchor: "end" }));
  y += 56;

  // KPI tiles
  const gap = 16;
  const tileW = (INNER - gap * 3) / 4;
  const tiles = [
    s.meta.connected
      ? {
          label: "Active Meta campaigns",
          value: num(s.campaigns.length),
          note: `${num(s.storeCount)} stores matched` + (s.meta.unmatched ? `, ${num(s.meta.unmatched)} not matched` : ""),
        }
      : { label: "Active Meta campaigns", value: "-", note: s.meta.error ? "could not load from Meta" : "Meta not connected yet" },
    { label: "Products checked", value: num(s.variantCount), note: "variants in campaign stores" },
    { label: `Below ${s.threshold}`, value: num(s.lowStock), note: `${pct(s.lowStock, s.variantCount)} of checked products`, accent: C.warning },
    { label: "Out of stock", value: num(s.outOfStock), note: `${pct(s.outOfStock, s.variantCount)} of checked products`, accent: C.critical },
  ];
  tiles.forEach((t, i) => out.push(kpiTile(PAD + i * (tileW + gap), y, tileW, t)));
  y += 112 + 36;

  // Stock health: one stacked bar, 2px surface gap between segments
  out.push(text(PAD, y, "Stock in campaign stores", { size: 18, weight: 700 }));
  y += 16;
  const healthy = Math.max(0, s.variantCount - s.lowStock);
  const low = s.lowStock - s.outOfStock;
  const segments = [
    { label: "Out of stock", n: s.outOfStock, fill: C.critical },
    { label: `Low (1 to ${s.threshold - 1} left)`, n: low, fill: C.warning },
    { label: `Healthy (${s.threshold}+ left)`, n: healthy, fill: C.good },
  ];
  const total = segments.reduce((a, b) => a + b.n, 0) || 1;
  let x = PAD;
  const visible = segments.filter((seg) => seg.n > 0);
  visible.forEach((seg, i) => {
    const w = (seg.n / total) * (INNER - 2 * (visible.length - 1));
    const first = i === 0;
    const last = i === visible.length - 1;
    const r = Math.min(4, w / 2);
    // Round only the outer ends of the whole bar
    out.push(
      `<path d="M${x + (first ? r : 0)},${y} H${x + w - (last ? r : 0)} ${last ? `Q${x + w},${y} ${x + w},${y + r} V${y + 28 - r} Q${x + w},${y + 28} ${x + w - r},${y + 28}` : `V${y + 28}`} H${x + (first ? r : 0)} ${first ? `Q${x},${y + 28} ${x},${y + 28 - r} V${y + r} Q${x},${y} ${x + r},${y}` : `V${y}`} Z" fill="${seg.fill}"/>`,
    );
    x += w + 2;
  });
  y += 28 + 26;
  // Legend: swatch + label + count + share (identity never by color alone)
  let lx = PAD;
  for (const seg of segments) {
    const label = `${seg.label}: ${num(seg.n)} (${pct(seg.n, total)})`;
    out.push(`<rect x="${lx}" y="${y - 11}" width="12" height="12" rx="3" fill="${seg.fill}"/>`);
    out.push(text(lx + 18, y, label, { size: 14, fill: C.text2 }));
    lx += 18 + label.length * 7.4 + 32;
  }
  y += 40;

  // Two columns: top shops (bars) | active campaigns (table)
  const colW = (INNER - 40) / 2;
  const top = y;

  out.push(text(PAD, y, `Campaign stores with most below ${s.threshold}`, { size: 18, weight: 700 }));
  y += 22;
  const shops = s.topShops.slice(0, 8);
  const maxN = Math.max(1, ...shops.map(([, n]) => n));
  const labelW = 190;
  const barMax = colW - labelW - 60;
  if (!shops.length) out.push(text(PAD, y + 20, s.storeCount ? `Every product has ${s.threshold}+ in stock` : "No campaign stores to check", { size: 14, fill: C.muted }));
  shops.forEach(([shop, n], i) => {
    const ry = y + i * 34;
    out.push(text(PAD, ry + 19, cut(shop, 20), { size: 14, fill: C.text2 }));
    out.push(hbar(PAD + labelW, ry + 5, (n / maxN) * barMax, 20, C.series));
    out.push(text(PAD + labelW + (n / maxN) * barMax + 8, ry + 20, num(n), { size: 14, weight: 700 }));
  });
  const leftBottom = y + Math.max(1, shops.length) * 34;

  const tx = PAD + colW + 40;
  y = top;
  out.push(text(tx, y, "Active Meta campaigns", { size: 18, weight: 700 }));
  y += 22;
  const cols = [
    { h: "Campaign", x: 0, anchor: "start" },
    { h: "Store", x: colW * 0.42, anchor: "start" },
    { h: "Products", x: colW * 0.82, anchor: "end" },
    { h: `Below ${s.threshold}`, x: colW, anchor: "end" },
  ];
  cols.forEach((c) => out.push(text(tx + c.x, y + 16, c.h, { size: 13, weight: 700, fill: C.muted, anchor: c.anchor })));
  y += 26;
  out.push(`<line x1="${tx}" x2="${tx + colW}" y1="${y}" y2="${y}" stroke="${C.border}"/>`);
  // Every active campaign is listed: matched ones first, then the unmatched ones marked "not used"
  const campaigns = s.campaigns.slice(0, 12);
  const unmatched = s.campaigns.filter((c) => !c.shops.length).length;
  if (!campaigns.length) {
    const msg = s.meta.error ? "Could not load campaigns from Meta" : s.meta.connected ? "No active campaigns" : "Meta not connected yet";
    out.push(text(tx, y + 24, msg, { size: 14, fill: C.muted }));
  }
  campaigns.forEach((c, i) => {
    const ry = y + i * 34;
    const matched = c.shops.length > 0;
    out.push(text(tx, ry + 23, cut(c.name || "Unnamed", 24), { size: 14, fill: matched ? C.text : C.text2 }));
    out.push(text(tx + cols[1].x, ry + 23, matched ? cut(c.shops.join(", "), 22) : "not matched", { size: 14, fill: matched ? C.text : C.muted }));
    out.push(text(tx + cols[2].x, ry + 23, matched ? num(c.products) : "-", { size: 14, anchor: "end", fill: matched ? C.text : C.muted }));
    out.push(text(tx + cols[3].x, ry + 23, !matched ? "not used" : c.lowStock ? `⚠ ${num(c.lowStock)}` : "OK", {
      size: 14,
      weight: matched ? 700 : 400,
      fill: !matched ? C.muted : c.lowStock ? C.text : C.good,
      anchor: "end",
    }));
    out.push(`<line x1="${tx}" x2="${tx + colW}" y1="${ry + 34}" y2="${ry + 34}" stroke="${C.grid}"/>`);
  });
  let noteY = y + Math.max(1, campaigns.length) * 34 + 22;
  if (s.campaigns.length > campaigns.length) {
    out.push(text(tx, noteY, `+${s.campaigns.length - campaigns.length} more campaigns in the Excel file`, { size: 13, fill: C.muted }));
    noteY += 22;
  }
  if (unmatched) {
    out.push(text(tx, noteY, "Not matched = no store name in the campaign name, so not checked", { size: 13, fill: C.muted }));
    noteY += 22;
  }
  const rightBottom = Math.max(y + Math.max(1, campaigns.length + 1) * 34, noteY);

  y = Math.max(leftBottom, rightBottom) + 24;
  out.push(
    text(
      PAD,
      y,
      `Only stores in active Meta campaigns are checked. Stock = quantity minus unpaid reservations. Full lists are in the Excel file.`,
      { size: 13, fill: C.muted },
    ),
  );
  const H = y + PAD - 10;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${C.surface}"/>${out.join("")}</svg>`;
};
