// Template for your own report. Copy this file (e.g. to queries/my-report.js),
// change the query, then set QUERY=my-report in .env.
//
// Fields:
//   title       Text used in the Slack message and the email.
//   collection  Collection to query. Leave it out to use MONGO_COLLECTION from .env.
//   type        "aggregate" (uses pipeline) or "find" (uses filter/projection/sort/limit).
//   columns     Optional [{ key, header }] to fix the column order and names.
//               Leave it out and the columns come from the data itself; nested
//               fields become columns like "address.city".
//
// This example counts active products per category.
module.exports = {
  title: "Active products per category",
  type: "aggregate",
  pipeline: [
    { $match: { status: "active" } },
    { $group: { _id: "$categoryId", products: { $sum: 1 } } },
    {
      $lookup: {
        from: "productcategories",
        localField: "_id",
        foreignField: "_id",
        as: "category",
      },
    },
    { $project: { _id: 0, category: { $arrayElemAt: ["$category.title", 0] }, products: 1 } },
    { $sort: { products: -1 } },
  ],
};

// A "find" query looks like this instead:
//
// module.exports = {
//   title: "Products created in the last 7 days",
//   type: "find",
//   filter: { createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
//   projection: { title: 1, status: 1, sellerId: 1, createdAt: 1 },
//   sort: { createdAt: -1 },
//   limit: 5000,
// };
