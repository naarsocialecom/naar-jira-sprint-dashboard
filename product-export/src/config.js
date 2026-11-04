const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

function required(name) {
  const value = process.env[name];
  if (!value || value.startsWith("<")) {
    throw new Error(`Missing env var ${name} (set it in .env)`);
  }
  return value;
}

function list(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("<"));
}

const isSet = (name) => Boolean(process.env[name]) && !process.env[name].startsWith("<");

function requiredList(name) {
  const values = list(name);
  if (!values.length) throw new Error(`Missing env var ${name} (set it in .env)`);
  return values;
}

const bool = (name) => String(process.env[name]).toLowerCase() === "true";

function oneOf(name, fallback, allowed) {
  const value = (process.env[name] || fallback).toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be ${allowed.join(", ")} (got "${value}")`);
  }
  return value;
}

// Loads queries/<QUERY>.js and checks it has what index.js needs.
function loadQuery(name) {
  const file = path.resolve(__dirname, "..", "queries", `${name}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`QUERY=${name}: no such file ${path.relative(process.cwd(), file)}`);
  }
  const query = require(file);
  if (query.type === "aggregate" && !Array.isArray(query.pipeline)) {
    throw new Error(`${name}.js: type "aggregate" needs a pipeline array`);
  }
  if (!["aggregate", "find"].includes(query.type)) {
    throw new Error(`${name}.js: type must be "aggregate" or "find"`);
  }
  for (const sheet of query.extraSheets || []) {
    if (!sheet.name || !Array.isArray(sheet.pipeline)) {
      throw new Error(`${name}.js: each extraSheets entry needs a name and a pipeline array`);
    }
  }
  // This tool is read-only: $out/$merge would write to the database, so refuse them
  // anywhere in the query (including inside $lookup/$facet sub-pipelines).
  const writeStage = JSON.stringify(query).match(/"\$(out|merge)"\s*:/);
  if (writeStage) {
    throw new Error(`${name}.js: $${writeStage[1]} writes to the database and is not allowed`);
  }
  return { title: name, ...query };
}

const dryRun = bool("DRY_RUN");
const format = oneOf("EXPORT_FORMAT", "xlsx", ["csv", "xlsx", "both"]);
const delivery = oneOf("DELIVERY", "email", ["email", "slack", "both"]);
const queryName = process.env.QUERY || "active-products";

// Email/Slack settings are only required when we actually send that way
const sendEmail = !dryRun && delivery !== "slack";
const sendSlack = !dryRun && delivery !== "email";

module.exports = {
  mongo: {
    uri: required("MONGO_URI"),
    dbName: required("MONGO_DB_NAME"),
    collection: process.env.MONGO_COLLECTION || "products",
  },
  query: loadQuery(queryName),
  export: {
    format,
    dir: path.resolve(__dirname, "..", process.env.EXPORT_DIR || "exports"),
    filePrefix: process.env.EXPORT_FILE_PREFIX || queryName,
  },
  mail: sendEmail
    ? {
        host: required("SMTP_HOST"),
        port: Number(process.env.SMTP_PORT || 587),
        secure: bool("SMTP_SECURE"),
        user: required("SMTP_USER"),
        pass: required("SMTP_PASS"),
        from: required("MAIL_FROM"),
        to: list("MAIL_TO"),
        cc: list("MAIL_CC"),
        subject: process.env.MAIL_SUBJECT || "Naar Report",
      }
    : null,
  slack: sendSlack
    ? {
        token: required("SLACK_BOT_TOKEN"),
        channelIds: list("SLACK_CHANNEL_ID"),
        userIds: list("SLACK_USER_ID"),
        deletePrevious: bool("SLACK_DELETE_PREVIOUS"),
      }
    : null,
  // Meta Marketing API (read-only); off until META_ACCESS_TOKEN is filled in
  meta: isSet("META_ACCESS_TOKEN")
    ? {
        token: process.env.META_ACCESS_TOKEN,
        accountIds: requiredList("META_AD_ACCOUNT_ID"),
        apiVersion: process.env.META_API_VERSION || "v23.0",
        mappingFile: path.resolve(__dirname, "..", process.env.META_MAPPING_FILE || "meta-campaign-sellers.json"),
      }
    : null,
  dryRun,
  deleteAfterSend: bool("DELETE_AFTER_SEND"),
};
