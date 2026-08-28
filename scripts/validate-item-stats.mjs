// Validates src/itemStats.ts against stats measured from the game engine.
//
// The fixture holds per-item stats derived from Match-V5 timelines: for each
// window where a player bought exactly one item, the delta of their per-minute
// `championStats` is that item's contribution, with any destroyed components
// added back from values already resolved. Windows with a level-up, an undo, a
// sale, or a stat-scaling item (Rabadon's, mana-stackers) in the inventory are
// discarded. 60 matches produced 1342 usable windows and 85 resolved items.
//
// Usage: node scripts/validate-item-stats.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "itemstats-"));
execFileSync("npx", ["tsc", "src/itemStats.ts", "--outDir", out, "--module", "es2020", "--target", "es2020", "--moduleResolution", "bundler", "--skipLibCheck", "--typeRoots", out], { stdio: "inherit" });
const { parseItemStats } = await import(join(out, "itemStats.js"));

const fixture = JSON.parse(readFileSync("scripts/fixtures/measured-item-stats.json", "utf8"));
const measured = fixture.items;
const version = (await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json())[0];

// The fixture is a snapshot of one patch. When Riot rebalances an item the
// parser correctly reports the new number while the fixture still holds the old
// one, and that is a balance change rather than a regression — so say which it
// is instead of failing and leaving the reader to guess.
const patchOf = v => v.split(".").slice(0, 2).join(".");
const samePatch = patchOf(version) === patchOf(fixture.meta.gamePatch);
const dd = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`)).json()).data;

// Only offensive stats are checked. `championStats` reports *live effective*
// values, so health / armor / magic resist are polluted by armor shred, buffs
// and shields — measured Trinity Force came out at -20 armor. Attack damage and
// ability power are almost never shredded, which is why they resolve cleanly.
const CHECKS = [
  ["abilityPower", "abilityPower", 1],
  ["attackDamage", "attackDamage", 1],
  ["magicPen", "magicPen", 1],
  ["magicPenPercent", "magicPenPercent", 1],
  ["armorPenPercent", "armorPenPercent", 1],
];


let checked = 0, failed = 0;
const problems = [];
for (const [id, m] of Object.entries(measured)) {
  const item = dd[id];
  if (!item) continue;
  const parsed = parseItemStats(item.description);
  for (const [mk, pk, scale] of CHECKS) {
    const expected = m[mk];
    const got = parsed[pk] * scale;
    if (expected === 0 && got === 0) continue;
    checked++;
    // engine values carry rounding (Rylai's reports 414 health for a 400 item)
    const tol = Math.max(2, Math.abs(expected) * 0.05);
    if (Math.abs(got - expected) > tol) {
      failed++;
      problems.push(`  ${item.name.padEnd(26)} ${pk.padEnd(16)} medido=${expected}  parser=${got}`);
    }
  }
}
console.log(`\nfixture: parche ${fixture.meta.gamePatch}   Data Dragon actual: ${version}`);
console.log(`comparaciones: ${checked}   discrepancias: ${failed}`);
if (problems.length) console.log(problems.join("\n"));

if (failed && !samePatch) {
  console.log(`\nEl fixture es de un parche anterior, asi que estas diferencias son probablemente
cambios de balance y no fallos del parser. Comprueba las que veas contra el objeto
en el cliente; si el parser coincide con el juego, regenera el fixture.`);
  process.exit(0);
}
if (failed) {
  console.log(`\nMismo parche que el fixture: esto SI es una regresion del parser.`);
}
process.exit(failed ? 1 : 0);
