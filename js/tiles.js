/**
 * tiles.js
 * 136枚固有ID(0..135) ⇔ 34種インデックス(0..33) ⇔ 文字表記の相互変換・ユーティリティ
 */

const HONOR_NAMES = ["東", "南", "西", "北", "白", "發", "中"];
const HONOR_CODES = ["1z", "2z", "3z", "4z", "5z", "6z", "7z"];

export const RED_TILE_IDS = new Set([16, 52, 88]);

export function tileIdToKind(tileId) {
  return Math.floor(tileId / 4);
}

export function isRedDora(tileId, redDoraEnabled = true) {
  return redDoraEnabled && RED_TILE_IDS.has(tileId);
}

export function kindToLabel(kindId, useKanjiHonor = true) {
  if (kindId >= 0 && kindId <= 8) return `${kindId + 1}m`;
  if (kindId >= 9 && kindId <= 17) return `${kindId - 8}p`;
  if (kindId >= 18 && kindId <= 26) return `${kindId - 17}s`;
  if (kindId >= 27 && kindId <= 33) {
    return useKanjiHonor ? HONOR_NAMES[kindId - 27] : HONOR_CODES[kindId - 27];
  }
  throw new Error(`Invalid kindId: ${kindId}`);
}

export function tileIdToLabel(tileId, redDoraEnabled = true, useKanjiHonor = true) {
  if (isRedDora(tileId, redDoraEnabled)) {
    const kindId = tileIdToKind(tileId);
    if (kindId === 4) return "0m";
    if (kindId === 13) return "0p";
    if (kindId === 22) return "0s";
  }
  return kindToLabel(tileIdToKind(tileId), useKanjiHonor);
}

export function labelToKind(label) {
  const s = String(label).trim();
  const honorIdx = HONOR_NAMES.indexOf(s);
  if (honorIdx !== -1) return 27 + honorIdx;

  const m = s.match(/^([0-9])([mpsz])$/i);
  if (!m) return -1;
  let num = parseInt(m[1], 10);
  const suit = m[2].toLowerCase();
  if (suit === "z") {
    return num >= 1 && num <= 7 ? 26 + num : -1;
  }
  if (num === 0) num = 5;
  if (num < 1 || num > 9) return -1;
  if (suit === "m") return num - 1;
  if (suit === "p") return 9 + (num - 1);
  if (suit === "s") return 18 + (num - 1);
  return -1;
}

export function indicatorToDoraKind(indicatorTileId) {
  const k = tileIdToKind(indicatorTileId);
  if (k <= 8) return k === 8 ? 0 : k + 1;
  if (k <= 17) return k === 17 ? 9 : k + 1;
  if (k <= 26) return k === 26 ? 18 : k + 1;
  if (k <= 30) return k === 30 ? 27 : k + 1;
  return k === 33 ? 31 : k + 1;
}

export function sortTileIds(tileIds) {
  return [...tileIds].sort((a, b) => a - b);
}

export function toCounts34(tileIds) {
  const counts = new Array(34).fill(0);
  for (const id of tileIds) {
    counts[tileIdToKind(id)]++;
  }
  return counts;
}

export function findTileIdByLabel(tileIds, label, redDoraEnabled = true) {
  const s = String(label).trim();
  if (s === "0m" && tileIds.includes(16)) return 16;
  if (s === "0p" && tileIds.includes(52)) return 52;
  if (s === "0s" && tileIds.includes(88)) return 88;

  const targetKind = labelToKind(s);
  if (targetKind === -1) return null;

  if (targetKind === 4 || targetKind === 13 || targetKind === 22) {
    const nonRed = tileIds.find(
      (id) => tileIdToKind(id) === targetKind && !isRedDora(id, redDoraEnabled)
    );
    if (nonRed !== undefined) return nonRed;
  }
  const found = tileIds.find((id) => tileIdToKind(id) === targetKind);
  return found !== undefined ? found : null;
}

/**
 * 複数枚のラベル配列（チーの消費牌など）に対応する固有tileId配列を取得
 */
export function findMultipleTileIdsByLabels(tileIds, labels, redDoraEnabled = true) {
  const pool = [...tileIds];
  const picked = [];
  for (const lbl of labels) {
    const id = findTileIdByLabel(pool, lbl, redDoraEnabled);
    if (id === null) return null;
    picked.push(id);
    pool.splice(pool.indexOf(id), 1);
  }
  return picked;
}

export function getTileVisual(tileId, redDoraEnabled = true) {
  const kindId = tileIdToKind(tileId);
  const red = isRedDora(tileId, redDoraEnabled);
  if (kindId <= 8) {
    return { top: String(kindId + 1), bottom: "萬", cls: red ? "suit-m red-dora" : "suit-m" };
  }
  if (kindId <= 17) {
    return { top: String(kindId - 8), bottom: "筒", cls: red ? "suit-p red-dora" : "suit-p" };
  }
  if (kindId <= 26) {
    return { top: String(kindId - 17), bottom: "索", cls: red ? "suit-s red-dora" : "suit-s" };
  }
  return { top: HONOR_NAMES[kindId - 27], bottom: "", cls: "suit-z" };
}
