// Daily summary for the active-products report: headline numbers, active Meta
// campaigns matched to sellers, and the lowest-stock products by shop.
// Returns { text, slackText, image }: plain text for email and logs, mrkdwn for
// Slack, and the dashboard as an SVG string.
const renderDashboard = require("./dashboard-image");

const TOP_N = 10;
// All active campaigns are listed, matched or not; this only guards the Slack message length
const MAX_CAMPAIGNS = 20;
const MAX_TITLE = 60;

// Slack mrkdwn treats &, < and > as control characters
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n) => Number(n || 0).toLocaleString("en-IN");
const cut = (s, max = MAX_TITLE) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
// Some titles are stored HTML-escaped ("Flowers &amp; Animals") or with runs of spaces
const clean = (s) =>
  String(s ?? "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e])
    .replace(/\s+/g, " ")
    .trim();

// "Size M / Colour Red" from attributes, else "500 g" from the single-variant fields
// Products without real variants have variantName "default"; show nothing for those.
function variantLabel(row) {
  if (row.attributes?.length) return clean(row.attributes.map((a) => `${a.type} ${a.value}`).join(" / "));
  if (!row.variantName || row.variantName === "default") return "";
  return clean([row.variantName, row.variantValue, row.variantOption].filter((v) => v != null && v !== "").join(" "));
}

// Slack line by default; plain: true for email/console (no bold, no escaping)
function stockLine(row, { plain = false } = {}) {
  const variant = variantLabel(row);
  const product = cut(clean(row.title) || "Untitled") + (variant ? ` (${cut(variant, 40)})` : "");
  const shop = clean(row.shopName) || "Unknown shop";
  const left = row.availableQuantity <= 0 ? "out of stock" : `${row.availableQuantity} left`;
  if (plain) return `- ${shop} - ${product} - ${left}`;
  return `• *${esc(cut(shop, 40))}* - ${esc(product)} - *${left}*`;
}

function bulletList(lines, more) {
  return lines.join("\n") + (more > 0 ? `\n_…and ${num(more)} more in the Excel file_` : "");
}

module.exports = function buildSummary({ title, rowCount, sheets, threshold, date, context = {} }) {
  const lowStock = sheets.find((s) => s.name === "Low stock").rows;
  const meta = context.meta || { connected: false, campaignRows: [] };

  const outOfStock = lowStock.filter((r) => r.availableQuantity <= 0).length;
  const lowStockInCampaigns = lowStock.filter((r) => r.metaCampaigns?.length);

  // Meta campaign -> its matched shops and their stock (campaignRows has one row per campaign x seller)
  const campaigns = new Map();
  for (const r of meta.campaignRows) {
    const c = campaigns.get(r.campaignId) || { name: r.campaign, shops: [], products: 0, lowStock: 0 };
    if (r.sellerId) {
      c.shops.push(clean(r.shopName) || r.sellerId);
      c.products += r.activeProducts;
      c.lowStock += r.lowStockVariants;
    }
    campaigns.set(r.campaignId, c);
  }
  // Matched campaigns (most low stock first), then the unmatched ones, which are listed but not used
  const campaignList = [...campaigns.values()].sort(
    (a, b) => !a.shops.length - !b.shops.length || b.lowStock - a.lowStock || a.name.localeCompare(b.name),
  );
  const unmatched = campaignList.filter((c) => !c.shops.length);
  const campaignSellerCount = new Set(meta.campaignRows.filter((r) => r.sellerId).map((r) => r.sellerId)).size;

  // Shop -> number of low-stock variants
  const shops = new Map();
  for (const r of lowStock) {
    const shop = clean(r.shopName) || "Unknown shop";
    shops.set(shop, (shops.get(shop) || 0) + 1);
  }
  const topShops = [...shops].sort((a, b) => b[1] - a[1]);

  // What to say about Meta when there is nothing to list (plain text; Slack adds formatting)
  const metaProblem = meta.error
    ? `Meta campaigns could not be loaded: ${meta.error}`
    : !meta.connected
      ? "Meta not connected yet (set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in .env)"
      : null;
  const metaStatus = metaProblem && (meta.error ? `:x: ${esc(metaProblem)}` : `_${esc(metaProblem)}_`);

  // Slack message (mrkdwn). It goes out as the comment on the uploaded dashboard
  // image and Excel file, so the numbers, the picture and the file arrive together.
  const campaignLines = campaignList.slice(0, MAX_CAMPAIGNS).map((c) =>
    c.shops.length
      ? `• *${esc(cut(clean(c.name), 50))}* → ${esc(cut(c.shops.join(", "), 60))} - ${num(c.products)} active products, ` +
        (c.lowStock ? `:warning: ${num(c.lowStock)} low-stock variants` : "stock OK")
      : `• *${esc(cut(clean(c.name), 50))}* → _not matched to a seller (not used)_`,
  );
  const tabs = meta.connected ? "*Products*, *Low stock*, *Meta campaigns*, *Meta campaign products*" : "*Products*, *Low stock*";
  const slackText = [
    `:bar_chart: *Daily product report · ${date}*`,
    `*${num(rowCount)}* active variants  ·  :warning: *${num(lowStock.length)}* low stock (below ${threshold})  ·  ` +
      `:red_circle: *${num(outOfStock)}* out of stock  ·  :mega: *${meta.connected ? num(campaigns.size) : "-"}* active Meta campaigns` +
      (meta.connected ? ` (${num(campaignSellerCount)} sellers)` : ""),
    "",
    "*Active Meta campaigns*",
    metaStatus ||
      (campaignLines.length ? bulletList(campaignLines, campaignList.length - MAX_CAMPAIGNS) : "_No active campaigns_"),
    ...(unmatched.length
      ? [
          `:information_source: _${num(unmatched.length)} campaign(s) not matched: the campaign name has no shop name, ` +
            "so it can't be linked to a seller's products and is left out of the stock numbers._",
        ]
      : []),
    "",
    ...(meta.connected
      ? [
          "*Low stock in Meta campaign sellers* (lowest first)",
          lowStockInCampaigns.length
            ? bulletList(lowStockInCampaigns.slice(0, TOP_N).map((r) => stockLine(r)), lowStockInCampaigns.length - TOP_N)
            : "_None, campaign sellers are all stocked_ :white_check_mark:",
          "",
        ]
      : []),
    "*Shops with the most low-stock variants:* " +
      (topShops.length ? topShops.slice(0, 5).map(([shop, n]) => `${esc(cut(shop, 40))} (${num(n)})`).join(", ") : "none :white_check_mark:"),
    "",
    `:paperclip: Dashboard image and full Excel report attached (tabs ${tabs}).`,
  ].join("\n");

  const image = renderDashboard({
    date,
    threshold,
    rowCount,
    lowStock: lowStock.length,
    outOfStock,
    shopCount: shops.size,
    meta: { connected: meta.connected, error: meta.error, sellerCount: campaignSellerCount, unmatched: unmatched.length },
    campaigns: campaignList,
    topShops,
  });

  // Plain-text version for email and the console
  const text = [
    `${title} - ${date}`,
    `Active product variants: ${num(rowCount)}`,
    `Low stock (below ${threshold}): ${num(lowStock.length)} (out of stock: ${num(outOfStock)})`,
    metaProblem
      ? `Meta: ${metaProblem}`
      : `Active Meta campaigns: ${num(campaigns.size)} (${num(campaignSellerCount)} sellers, ${num(unmatched.length)} not matched)`,
    ...campaignList.map((c) =>
      c.shops.length
        ? `  - ${clean(c.name)} -> ${c.shops.join(", ")}: ${c.products} products, ${c.lowStock} low-stock variants`
        : `  - ${clean(c.name)} -> NOT MATCHED (no shop name in the campaign name, not used)`,
    ),
    ...(meta.connected
      ? [
          `Low stock in Meta campaign sellers: ${num(lowStockInCampaigns.length)}`,
          ...lowStockInCampaigns.slice(0, TOP_N).map((r) => "  " + stockLine(r, { plain: true })),
        ]
      : []),
    `Shops with the most low-stock variants:`,
    ...topShops.slice(0, 5).map(([shop, n]) => `  - ${shop}: ${n}`),
  ].join("\n");

  return { text, slackText, image };
};
