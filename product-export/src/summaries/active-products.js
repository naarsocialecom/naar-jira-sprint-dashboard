// Daily summary for the Meta campaign stock report: the active Meta campaigns,
// the stores they promote, and those stores' products below the stock threshold.
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

module.exports = function buildSummary({ title, threshold, date, context = {} }) {
  const meta = context.meta || { connected: false, campaignRows: [] };
  const lowStock = context.lowStock || [];
  const variantCount = context.variantCount || 0;
  const storeCount = context.storeCount || 0;
  const outOfStock = lowStock.filter((r) => r.availableQuantity <= 0).length;

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

  // Campaign store -> number of variants below the threshold
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
        (c.lowStock ? `:warning: ${num(c.lowStock)} below ${threshold}` : "stock OK")
      : `• *${esc(cut(clean(c.name), 50))}* → _not matched to a store (not used)_`,
  );
  const slackText = [
    `:mega: *Meta campaign stock report · ${date}*`,
    `*${meta.connected ? num(campaigns.size) : "-"}* active Meta campaigns  ·  *${num(storeCount)}* stores  ·  ` +
      `*${num(variantCount)}* products checked  ·  :warning: *${num(lowStock.length)}* below ${threshold}  ·  ` +
      `:red_circle: *${num(outOfStock)}* out of stock`,
    "",
    "*Active Meta campaigns*",
    metaStatus ||
      (campaignLines.length ? bulletList(campaignLines, campaignList.length - MAX_CAMPAIGNS) : "_No active campaigns_"),
    ...(unmatched.length
      ? [
          `:information_source: _${num(unmatched.length)} campaign(s) not matched: the campaign name has no store name, ` +
            "so its products can't be checked._",
        ]
      : []),
    "",
    `*Products below ${threshold} in campaign stores* (lowest first)`,
    lowStock.length
      ? bulletList(lowStock.slice(0, TOP_N).map((r) => stockLine(r)), lowStock.length - TOP_N)
      : storeCount
        ? `_None, every campaign store has ${threshold} or more of each product_ :white_check_mark:`
        : "_No campaign stores to check_",
    "",
    `:paperclip: Dashboard image and Excel report attached (tabs *Meta campaigns*, *Below ${threshold} - campaign stores*, *Campaign store products*).`,
  ].join("\n");

  const image = renderDashboard({
    date,
    threshold,
    variantCount,
    storeCount,
    lowStock: lowStock.length,
    outOfStock,
    meta: { connected: meta.connected, error: meta.error, unmatched: unmatched.length },
    campaigns: campaignList,
    topShops,
  });

  // Plain-text version for email and the console
  const text = [
    `${title} - ${date}`,
    metaProblem
      ? `Meta: ${metaProblem}`
      : `Active Meta campaigns: ${num(campaigns.size)} (${num(storeCount)} stores, ${num(unmatched.length)} not matched)`,
    ...campaignList.map((c) =>
      c.shops.length
        ? `  - ${clean(c.name)} -> ${c.shops.join(", ")}: ${c.products} products, ${c.lowStock} below ${threshold}`
        : `  - ${clean(c.name)} -> NOT MATCHED (no store name in the campaign name, not used)`,
    ),
    `Products checked in campaign stores: ${num(variantCount)}`,
    `Below ${threshold}: ${num(lowStock.length)} (out of stock: ${num(outOfStock)})`,
    ...lowStock.slice(0, TOP_N).map((r) => "  " + stockLine(r, { plain: true })),
  ].join("\n");

  return { text, slackText, image };
};
