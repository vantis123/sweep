import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const dir = resolve(homedir(), ".sweep", "validate");
const htmls = readdirSync(dir)
  .filter((f) => f.startsWith("iiq-rendered-jashard") && f.endsWith(".html"))
  .map((f) => ({ name: f, path: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
if (htmls.length === 0) { console.error("no html"); process.exit(1); }

const html = readFileSync(htmls[0].path, "utf8");
console.log(`HTML: ${htmls[0].name}, size=${html.length}`);

// Find FAIRWAY VILLAGE
const i = html.indexOf("FAIRWAY VILLAGE");
if (i < 0) { console.log("not found"); process.exit(0); }
console.log(`FAIRWAY VILLAGE at offset ${i}`);

// Look ~5000 chars around for the table structure — see which td/columns
// have content
const start = Math.max(0, i - 500);
const chunk = html.slice(start, i + 5000);
// Show the table that follows
const tableStart = chunk.indexOf("<table");
console.log("\n=== HTML table around FAIRWAY VILLAGE ===");
console.log(chunk.slice(tableStart, tableStart + 4000));
