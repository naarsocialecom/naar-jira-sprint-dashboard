const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { ObjectId, Decimal128 } = require("mongodb");

// Turn Mongo values into something a spreadsheet cell can hold.
// Arrays/objects (attributes, reserved, discount) become compact JSON.
function toCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Decimal128) return Number(value.toString());
  if (value instanceof Date) return value.toISOString();
  if (value._bsontype) return value.toString(); // Long, Binary, etc.
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(", ");
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

const isPlainObject = (v) => v !== null && Object.getPrototypeOf(v) === Object.prototype;

// Nested documents become dotted keys ({ address: { city } } -> "address.city"),
// so each field gets its own column. Arrays stay whole (shown as JSON).
function flatten(doc, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(doc)) {
    const name = prefix + key;
    if (isPlainObject(value) && Object.keys(value).length) flatten(value, `${name}.`, out);
    else out[name] = value;
  }
  return out;
}

// Columns for queries that don't list their own: every key seen, in first-seen order.
function columnsFrom(rows) {
  const keys = new Set();
  rows.forEach((row) => Object.keys(row).forEach((k) => keys.add(k)));
  return [...keys].map((key) => ({ key, header: key }));
}

// "seller.storeName" reads doc.seller.storeName, unless the doc has that exact key.
function getField(doc, key) {
  if (key in doc) return doc[key];
  return key.split(".").reduce((v, part) => (v == null ? undefined : v[part]), doc);
}

function toRow(doc, columns) {
  return columns.map((c) => toCell(getField(doc, c.key)));
}

function csvEscape(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createCsvWriter(filePath, columns) {
  const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
  // BOM so Excel opens UTF-8 (Arabic, ₹, etc.) correctly
  stream.write("﻿" + columns.map((c) => csvEscape(c.header)).join(",") + "\r\n");
  return {
    filePath,
    add: (doc) => stream.write(toRow(doc, columns).map(csvEscape).join(",") + "\r\n"),
    close: () => new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve()))),
  };
}

// One workbook for all sheets. The streaming writer keeps memory flat for large
// exports; sheets are written one after another.
function createXlsxWriter(filePath) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath });
  return {
    filePath,
    startSheet: (name, columns) => {
      const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
      sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(12, c.header.length + 2) }));
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).commit();
      return {
        add: (doc) => sheet.addRow(toRow(doc, columns)).commit(),
        close: async () => sheet.commit(),
      };
    },
    close: () => workbook.commit(),
  };
}

function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Writes each sheet's query results into the requested file format(s).
// sheets: [{ name, cursor, columns, keepRows }] - the first is the main sheet.
// Excel gets one workbook with a tab per sheet; CSV gets one file per sheet.
// With columns given, rows are streamed straight to disk (a column key like
// "seller.storeName" reads a nested field); without, all rows are read first
// so the column list can be built from the data. keepRows returns the rows
// (for the Slack summary), so only use it on small sheets.
// Returns { files: [paths], base (path without extension), rowCount, sheets: [{ name, rowCount, rows }] }.
async function exportSheets(sheets, { format, dir, filePrefix }) {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${filePrefix}_${timestamp()}`);
  const files = [];
  const xlsx = format === "xlsx" || format === "both" ? createXlsxWriter(`${base}.xlsx`) : null;
  const results = [];

  for (const [i, sheet] of sheets.entries()) {
    let { columns } = sheet;
    let rows = sheet.cursor;
    if (!columns || sheet.keepRows) {
      rows = [];
      for await (const doc of sheet.cursor) rows.push(columns ? doc : flatten(doc));
      columns = columns || columnsFrom(rows);
    }

    const writers = [];
    if (format === "csv" || format === "both") {
      const csvPath = i === 0 ? `${base}.csv` : `${base}_${slug(sheet.name)}.csv`;
      writers.push(createCsvWriter(csvPath, columns));
      files.push(csvPath);
    }
    // Excel tab names: max 31 chars, no []:*?/\
    if (xlsx) writers.push(xlsx.startSheet(sheet.name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31), columns));

    let rowCount = 0;
    for await (const doc of rows) {
      writers.forEach((w) => w.add(doc));
      rowCount++;
    }
    await Promise.all(writers.map((w) => w.close()));
    results.push({ name: sheet.name, rowCount, rows: sheet.keepRows ? rows : undefined });
  }

  if (xlsx) {
    await xlsx.close();
    files.push(xlsx.filePath);
  }
  return { files, base, rowCount: results[0].rowCount, sheets: results };
}

module.exports = { exportSheets };
