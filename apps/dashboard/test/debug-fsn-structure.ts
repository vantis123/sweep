import * as cheerio from "cheerio";
import { readFileSync } from "node:fs";

const html = readFileSync("/tmp/sweep-validation/fsn-html-shaun-bailer.html", "utf8");
const $ = cheerio.load(html);

const strongs = $('strong[data-uw-ignore-translate="true"]').toArray();
for (const s of strongs) {
  const $s = $(s);
  const cred = $s.text().trim();
  if (/^(transunion|experian|equifax)/i.test(cred)) continue;
  if (!cred) continue;
  console.log(`\n=== ${cred} ===`);
  const $grid = $s.closest("p").nextAll("div.d-grid.grid-cols-4").first();
  if ($grid.length === 0) {
    console.log("  no grid found");
    continue;
  }
  // Look at $grid parent and its descendants
  const $parent = $grid.parent();
  console.log(`  grid.parent: tag=${($parent.get(0) as any)?.tagName}  class="${$parent.attr("class")}"`);
  const $grandparent = $parent.parent();
  console.log(`  grid.parent.parent: tag=${($grandparent.get(0) as any)?.tagName}  class="${$grandparent.attr("class")}"`);
  
  // Test where payment-history blocks live relative to grid
  console.log(`  ph in grid.parent: ${$parent.find("div.payment-history").length}`);
  console.log(`  ph in grid.parent.parent: ${$grandparent.find("div.payment-history").length}`);
  console.log(`  ph in grid siblings: ${$grid.nextAll("*").find("div.payment-history").length + $grid.nextAll("div.payment-history").length}`);
}
