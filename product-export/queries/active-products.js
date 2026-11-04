// Aggregation for the active-products export: one row per product variant,
// enriched with seller, category, sub-category and HSN/GST data.
// Runs on MONGO_COLLECTION; the status comes from EXPORT_STATUS (default "active").
function buildPipeline(status) {
  return [
    { $match: { status } },
    { $unwind: { path: "$variants", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "sellerdetails",
        localField: "sellerId",
        foreignField: "userId",
        as: "seller",
      },
    },
    { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "productcategories",
        localField: "categoryId",
        foreignField: "_id",
        as: "categories",
      },
    },
    {
      $lookup: {
        from: "productsubcategories",
        localField: "subCategoryId",
        foreignField: "_id",
        as: "subcategories",
      },
    },
    {
      $lookup: {
        from: "hsncodes",
        localField: "hsnCode",
        foreignField: "_id",
        as: "hsn",
      },
    },
    {
      $addFields: {
        gstPercent: { $arrayElemAt: ["$hsn.IGST", 0] },
        priceBeforeGST: "$variants.price",
      },
    },
    {
      $addFields: {
        gstAmount: {
          $multiply: [
            { $ifNull: ["$priceBeforeGST", 0] },
            { $divide: [{ $ifNull: ["$gstPercent", 0] }, 100] },
          ],
        },
        priceWithGST: {
          $cond: [
            { $isNumber: "$priceBeforeGST" },
            {
              $ceil: {
                $add: [
                  "$priceBeforeGST",
                  {
                    $multiply: [
                      "$priceBeforeGST",
                      { $divide: [{ $ifNull: ["$gstPercent", 0] }, 100] },
                    ],
                  },
                ],
              },
            },
            null,
          ],
        },
      },
    },
    {
      $project: {
        _id: 1,
        title: 1,
        description: 1,
        status: 1,
        createdAt: 1,
        sellerId: 1,
        sellerName: "$seller.storeName",
        category: { $arrayElemAt: ["$categories.title", 0] },
        subcategory: { $arrayElemAt: ["$subcategories.title", 0] },
        // Variant identification
        variantDocumentId: "$variants._id",
        variantId: "$variants.variantId",
        entryId: "$variants.entryId",
        variantType: "$variants.variantType",
        // Single-variant fields
        variantName: "$variants.variantName",
        variantOption: "$variants.variantOption",
        variantValue: "$variants.variantValue",
        // Multi-variant details
        attributes: { $ifNull: ["$variants.attributes", []] },
        // Pricing and GST
        priceBeforeGST: 1,
        gstPercent: 1,
        gstAmount: 1,
        priceWithGST: 1,
        // Inventory
        quantity: "$variants.quantity",
        reserved: { $ifNull: ["$variants.reserved", []] },
        // Discount information
        discount: { $ifNull: ["$variants.discount", null] },
        // UAE-specific variant details (disabled, uncomment to include)
        // uaePrice: "$variants.regionalFields.AE.price",
        // uaeQuantity: "$variants.regionalFields.AE.quantity",
        // uaeReserved: "$variants.regionalFields.AE.reserved",
        // uaeCurrency: "$variants.regionalFields.AE.currency",
        // GST classification
        hsnCode: 1,
      },
    },
    { $sort: { createdAt: -1 } },
  ];
}

// Column order and headers for the exported file. Keep in sync with $project.
const COLUMNS = [
  { key: "_id", header: "Product ID" },
  { key: "title", header: "Title" },
  { key: "description", header: "Description" },
  { key: "status", header: "Status" },
  { key: "createdAt", header: "Created At" },
  { key: "sellerId", header: "Seller ID" },
  { key: "sellerName", header: "Seller Name" },
  { key: "category", header: "Category" },
  { key: "subcategory", header: "Sub-category" },
  { key: "variantDocumentId", header: "Variant Document ID" },
  { key: "variantId", header: "Variant ID" },
  { key: "entryId", header: "Entry ID" },
  { key: "variantType", header: "Variant Type" },
  { key: "variantName", header: "Variant Name" },
  { key: "variantOption", header: "Variant Option" },
  { key: "variantValue", header: "Variant Value" },
  { key: "attributes", header: "Attributes" },
  { key: "priceBeforeGST", header: "Price Before GST" },
  { key: "gstPercent", header: "GST %" },
  { key: "gstAmount", header: "GST Amount" },
  { key: "priceWithGST", header: "Price With GST" },
  { key: "quantity", header: "Quantity" },
  { key: "reserved", header: "Reserved" },
  { key: "discount", header: "Discount" },
  { key: "hsnCode", header: "HSN Code" },
];

// ---------------------------------------------------------------------------
// Low stock: active product variants whose available stock is below the
// threshold. Available = quantity minus unexpired reservations, the same rule
// as the app's ProductVariant.availableQuantity (naar-commerce/models.js).
// ---------------------------------------------------------------------------
const availableQuantity = {
  $subtract: [
    { $ifNull: ["$variants.quantity", 0] },
    {
      $sum: {
        $map: {
          input: {
            $filter: {
              input: { $ifNull: ["$variants.reserved", []] },
              cond: { $gt: ["$$this.paymentExpiry", "$$NOW"] },
            },
          },
          in: "$$this.quantity",
        },
      },
    },
  ],
};

// Stock bucket of one variant, from its available quantity
const stockStatus = (threshold) => ({
  $switch: {
    branches: [
      { case: { $lte: ["$availableQuantity", 0] }, then: "Out of stock" },
      { case: { $lt: ["$availableQuantity", threshold] }, then: "Low stock" },
    ],
    default: "OK",
  },
});

// One row per active product variant with its available stock.
// sellerIds narrows it to those sellers; lowOnly keeps only variants below the threshold.
function buildStockPipeline(status, threshold, { sellerIds, lowOnly = false } = {}) {
  return [
    { $match: { status, ...(sellerIds ? { sellerId: { $in: sellerIds } } : {}) } },
    { $unwind: "$variants" },
    { $addFields: { availableQuantity } },
    ...(lowOnly ? [{ $match: { availableQuantity: { $lt: threshold } } }] : []),
    {
      $lookup: {
        from: "sellerdetails",
        localField: "sellerId",
        foreignField: "userId",
        as: "seller",
      },
    },
    { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        shopName: "$seller.storeName",
        sellerId: 1,
        productId: "$_id",
        title: 1,
        variantId: "$variants.variantId",
        variantName: "$variants.variantName",
        variantValue: "$variants.variantValue",
        variantOption: "$variants.variantOption",
        attributes: { $ifNull: ["$variants.attributes", []] },
        price: "$variants.price",
        quantity: "$variants.quantity",
        availableQuantity: 1,
        stockStatus: stockStatus(threshold),
      },
    },
    { $sort: lowOnly ? { availableQuantity: 1, shopName: 1, title: 1 } : { shopName: 1, availableQuantity: 1, title: 1 } },
  ];
}

const STOCK_COLUMNS = [
  { key: "shopName", header: "Shop Name" },
  { key: "sellerId", header: "Seller ID" },
  { key: "productId", header: "Product ID" },
  { key: "title", header: "Title" },
  { key: "variantId", header: "Variant ID" },
  { key: "variantName", header: "Variant Name" },
  { key: "variantValue", header: "Variant Value" },
  { key: "variantOption", header: "Variant Option" },
  { key: "attributes", header: "Attributes" },
  { key: "price", header: "Price" },
  { key: "quantity", header: "Quantity" },
  { key: "availableQuantity", header: "Available (minus reserved)" },
  { key: "stockStatus", header: "Stock Status" },
  { key: "metaCampaigns", header: "Active Meta Campaigns" },
];

const META_CAMPAIGN_COLUMNS = [
  { key: "campaign", header: "Meta Campaign" },
  { key: "campaignId", header: "Campaign ID" },
  { key: "account", header: "Ad Account" },
  { key: "shopName", header: "Matched Shop" },
  { key: "sellerId", header: "Seller ID" },
  { key: "matchedBy", header: "Matched By" },
  { key: "activeProducts", header: "Active Products" },
  { key: "variants", header: "Variants" },
  { key: "lowStockVariants", header: "Low Stock Variants" },
  { key: "outOfStockVariants", header: "Out of Stock Variants" },
];

// ---------------------------------------------------------------------------
// Sheets for one run. Meta campaigns are read from the Meta Marketing API,
// matched to our sellers, and those sellers' products are pulled with their stock.
// ---------------------------------------------------------------------------
const status = process.env.EXPORT_STATUS || "active";
const threshold = Number(process.env.LOW_STOCK_THRESHOLD || 5);

async function buildSheets({ db, collection, aggregate, meta }) {
  const products = db.collection(collection);
  const metaResult = await loadMetaCampaigns(db, meta);
  const campaignsBySeller = new Map();
  for (const c of metaResult.campaigns) {
    for (const s of c.sellers) campaignsBySeller.set(s.userId, [...(campaignsBySeller.get(s.userId) || []), c.name]);
  }
  const withCampaigns = (row) => ({ ...row, metaCampaigns: campaignsBySeller.get(row.sellerId) || [] });

  const lowStock = (await aggregate(products, buildStockPipeline(status, threshold, { lowOnly: true })).toArray()).map(withCampaigns);

  const sellerIds = [...campaignsBySeller.keys()];
  const campaignProducts = sellerIds.length
    ? (await aggregate(products, buildStockPipeline(status, threshold, { sellerIds })).toArray()).map(withCampaigns)
    : [];

  // Per seller stock counts, then one row per campaign x matched seller
  const stockBySeller = new Map();
  for (const r of campaignProducts) {
    const s = stockBySeller.get(r.sellerId) || { products: new Set(), variants: 0, low: 0, out: 0 };
    s.products.add(String(r.productId));
    s.variants += 1;
    if (r.availableQuantity < threshold) s.low += 1;
    if (r.availableQuantity <= 0) s.out += 1;
    stockBySeller.set(r.sellerId, s);
  }
  const campaignRows = metaResult.campaigns.flatMap((c) => {
    const base = { campaign: c.name, campaignId: c.id, account: c.account };
    if (!c.sellers.length) {
      // A mapping-file entry whose seller does not exist is called out, so it can be fixed
      const matchedBy = c.unresolved?.length
        ? `mapping file: seller not found (${c.unresolved.join(", ")}) - not used`
        : "not matched (no shop name in the campaign name) - not used";
      return [{ ...base, matchedBy, activeProducts: 0, variants: 0, lowStockVariants: 0, outOfStockVariants: 0 }];
    }
    return c.sellers.map((seller) => {
      const s = stockBySeller.get(seller.userId);
      return {
        ...base,
        shopName: seller.storeName,
        sellerId: seller.userId,
        matchedBy: c.matchedBy,
        activeProducts: s ? s.products.size : 0,
        variants: s?.variants || 0,
        lowStockVariants: s?.low || 0,
        outOfStockVariants: s?.out || 0,
      };
    });
  });

  // Matched campaigns first; the unmatched ones go to the bottom of the tab
  campaignRows.sort((a, b) => Boolean(b.sellerId) - Boolean(a.sellerId));

  const sheets = [
    { name: "Products", cursor: aggregate(products, buildPipeline(status)), columns: COLUMNS },
    { name: "Low stock", cursor: lowStock, columns: STOCK_COLUMNS, keepRows: true },
  ];
  if (metaResult.connected) {
    sheets.push(
      { name: "Meta campaigns", cursor: campaignRows, columns: META_CAMPAIGN_COLUMNS, keepRows: true },
      { name: "Meta campaign products", cursor: campaignProducts, columns: STOCK_COLUMNS },
    );
  }
  return { sheets, context: { meta: { connected: metaResult.connected, error: metaResult.error, campaignRows } } };
}

// Active Meta campaigns matched to sellers; never throws, so a Meta problem
// still lets the rest of the report go out (with the problem shown in it).
async function loadMetaCampaigns(db, meta) {
  if (!meta) return { connected: false, campaigns: [] };
  try {
    const campaigns = await fetchActiveCampaigns(meta);
    const sellers = await db
      .collection("sellerdetails")
      .find({}, { projection: { _id: 0, userId: 1, storeName: 1 } })
      .toArray();
    return { connected: true, campaigns: matchCampaigns(campaigns, sellers, loadMapping(meta.mappingFile)) };
  } catch (err) {
    return { connected: false, error: err.message, campaigns: [] };
  }
}

const { fetchActiveCampaigns, matchCampaigns, loadMapping } = require("../src/meta");

module.exports = {
  title: `${status} products export`,
  type: "aggregate",
  pipeline: buildPipeline(status),
  columns: COLUMNS,
  buildSheets,
  lowStockThreshold: threshold,
  summary: require("../src/summaries/active-products"),
};
