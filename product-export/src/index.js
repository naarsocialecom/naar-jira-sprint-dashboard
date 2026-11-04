const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const sharp = require("sharp");
const config = require("./config");
const { exportSheets } = require("./exporter");
const { aggregate } = require("./db");
const { sendExport } = require("./mailer");
const { sendToSlack } = require("./slack");

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function runQuery(collection, query) {
  if (query.type === "find") {
    const { filter = {}, projection, sort, limit } = query;
    return collection.find(filter, { projection, sort, limit });
  }
  return aggregate(collection, query.pipeline);
}

async function main() {
  const { query } = config;
  const collectionName = query.collection || config.mongo.collection;
  const client = new MongoClient(config.mongo.uri);
  let result;
  let context = {};

  try {
    await client.connect();
    const db = client.db(config.mongo.dbName);
    log(`Connected to ${config.mongo.dbName}.${collectionName}, running "${query.title}"`);

    let sheets;
    if (query.buildSheets) {
      // The query builds its own sheets (and extra data for its summary)
      ({ sheets, context = {} } = await query.buildSheets({ db, collection: collectionName, aggregate, meta: config.meta }));
    } else {
      // Main sheet first, then any extra sheets (always aggregations)
      sheets = [
        { name: query.sheetName || "Report", cursor: runQuery(db.collection(collectionName), query), columns: query.columns },
        ...(query.extraSheets || []).map((sheet) => ({
          name: sheet.name,
          cursor: aggregate(db.collection(sheet.collection || collectionName), sheet.pipeline),
          columns: sheet.columns,
          keepRows: Boolean(query.summary),
        })),
      ];
    }
    if (context.meta?.error) log(`WARNING Meta campaigns not loaded: ${context.meta.error}`);
    result = await exportSheets(sheets, config.export);
    log(`Exported ${result.sheets.map((s) => `${s.name}: ${s.rowCount} rows`).join(", ")} -> ${result.files.join(", ")}`);
  } finally {
    await client.close();
  }

  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const summary = query.summary
    ? query.summary({ ...result, context, title: query.title, threshold: query.lowStockThreshold, date })
    : null;
  if (summary) log(`Summary:\n${summary.text}`);
  if (summary?.image) {
    // 2x density so the dashboard stays sharp on retina screens; first in the list so Slack previews it
    const png = `${result.base}_dashboard.png`;
    await sharp(Buffer.from(summary.image), { density: 144 }).png().toFile(png);
    result.files.unshift(png);
    log(`Dashboard image -> ${png}`);
  }

  if (config.dryRun) {
    log("DRY_RUN=true, nothing sent");
    return;
  }

  const report = { ...result, title: query.title, summary, filePrefix: config.export.filePrefix };

  if (config.slack) {
    const posts = await sendToSlack(config.slack, report);
    for (const p of posts) {
      const cleanup = config.slack.deletePrevious ? `, ${p.warning || `${p.deleted} previous report post(s) deleted`}` : "";
      log(`Posted to Slack ${p.channel}${cleanup}`);
    }
  }

  if (config.mail) {
    const messageId = await sendExport(config.mail, report);
    log(`Email sent (${messageId}) to ${config.mail.to.join(", ")}`);
  }

  if (config.deleteAfterSend) {
    result.files.forEach((f) => fs.unlinkSync(f));
    log("Local export files deleted");
  } else {
    const removed = removeOlderExports(config.export, result.files);
    if (removed) log(`${removed} older local export file(s) deleted, only today's report is kept`);
  }
}

// After a successful send only the newest report stays on disk, like in Slack.
// Only files of this report (its file prefix) in the export folder are touched.
function removeOlderExports({ dir, filePrefix }, keep) {
  const current = new Set(keep.map((f) => path.resolve(f)));
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (name.startsWith(`${filePrefix}_`) && !current.has(file) && fs.statSync(file).isFile()) {
      fs.unlinkSync(file);
      removed++;
    }
  }
  return removed;
}

main().catch((err) => {
  // Slack errors carry the useful reason (e.g. not_in_channel) in data.error,
  // and for missing_scope also the scope that is needed
  let reason = err.data?.error ? `${err.message} (${err.data.error})` : err.message;
  if (err.data?.needed) reason += ` - the Slack app needs scope: ${err.data.needed}`;
  console.error(`[${new Date().toISOString()}] Export failed:`, reason);
  process.exit(1);
});
