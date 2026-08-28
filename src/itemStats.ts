// Structured item stats parsed from Data Dragon's description HTML.
//
// The `stats` object Data Dragon ships alongside each item is a legacy field
// that never tracked modern items: it reports Shadowflame's 110 AP but omits
// its 15 magic penetration entirely, and says nothing about Void Staff's 40%.
// The `<stats>` block inside `description` is the accurate source — it is what
// the client renders in the shop.
//
// Values were validated against stats measured directly from the game engine
// (Match-V5 per-minute `championStats` deltas around item purchases) for 85
// items; see scripts/validate-item-stats.mjs.

export interface ItemStats {
  abilityPower: number;
  attackDamage: number;
  health: number;
  mana: number;
  armor: number;
  magicResist: number;
  abilityHaste: number;
  lethality: number;
  adaptiveForce: number;
  moveSpeed: number;
  magicPen: number;           // flat
  magicPenPercent: number;    // 0-100
  armorPenPercent: number;    // 0-100
  attackSpeedPercent: number;
  critChancePercent: number;
  critDamagePercent: number;
  lifeStealPercent: number;
  omnivampPercent: number;
  healShieldPercent: number;
  moveSpeedPercent: number;
}

export function emptyItemStats(): ItemStats {
  return {
    abilityPower: 0, attackDamage: 0, health: 0, mana: 0, armor: 0, magicResist: 0,
    abilityHaste: 0, lethality: 0, adaptiveForce: 0, moveSpeed: 0,
    magicPen: 0, magicPenPercent: 0, armorPenPercent: 0, attackSpeedPercent: 0,
    critChancePercent: 0, critDamagePercent: 0, lifeStealPercent: 0,
    omnivampPercent: 0, healShieldPercent: 0, moveSpeedPercent: 0,
  };
}

// Several labels exist in both a flat and a percent form (Magic Penetration,
// Move Speed), so the percent sign decides the key, not the label alone.
const FLAT: Record<string, keyof ItemStats> = {
  "ability power": "abilityPower",
  "attack damage": "attackDamage",
  "health": "health",
  "mana": "mana",
  "armor": "armor",
  "magic resist": "magicResist",
  "ability haste": "abilityHaste",
  "lethality": "lethality",
  "adaptive force": "adaptiveForce",
  "move speed": "moveSpeed",
  "magic penetration": "magicPen",
};

const PERCENT: Record<string, keyof ItemStats> = {
  "magic penetration": "magicPenPercent",
  "armor penetration": "armorPenPercent",
  "attack speed": "attackSpeedPercent",
  "critical strike chance": "critChancePercent",
  "critical strike damage": "critDamagePercent",
  "life steal": "lifeStealPercent",
  "omnivamp": "omnivampPercent",
  "heal and shield power": "healShieldPercent",
  "move speed": "moveSpeedPercent",
};

// `<attention>40%</attention> Magic Penetration` — the percent sign sits inside
// the tag, which is easy to miss and silently drops every percent stat.
const ENTRY = /<attention>\s*([\d.]+)\s*(%?)\s*<\/attention>([^<]*)/g;

export function parseItemStats(description: string): ItemStats {
  const out = emptyItemStats();
  const block = /<stats>([\s\S]*?)<\/stats>/.exec(description || "");
  if (!block) return out;

  ENTRY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTRY.exec(block[1])) !== null) {
    const value = parseFloat(m[1]);
    const isPercent = m[2] === "%";
    const label = m[3].replace(/&nbsp;/g, " ").trim().toLowerCase();
    if (!label || !isFinite(value)) continue;
    const key = (isPercent ? PERCENT : FLAT)[label];
    if (key) out[key] += value;
  }
  return out;
}
