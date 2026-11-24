/**
 * shanten.js
 * シャンテン数計算（副露数 meldCount 対応：通常手・七対子・国士無双）および受け入れ解析
 */

import { tileIdToKind, tileIdToLabel, kindToLabel, toCounts34 } from "./tiles.js";

const KOKUSHI_KINDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

export function calcKokushiShanten(counts) {
  let unique = 0;
  let hasPair = false;
  for (const k of KOKUSHI_KINDS) {
    if (counts[k] >= 1) {
      unique++;
      if (counts[k] >= 2) hasPair = true;
    }
  }
  return 13 - unique - (hasPair ? 1 : 0);
}

export function calcChiitoiShanten(counts) {
  let pairs = 0;
  let kinds = 0;
  for (let i = 0; i < 34; i++) {
    if (counts[i] >= 1) kinds++;
    if (counts[i] >= 2) pairs++;
  }
  const shortage = Math.max(0, 7 - kinds);
  return 6 - pairs + shortage;
}

export function calcStandardShanten(counts, meldCount = 0) {
  const c = [...counts];
  let best = 8;

  function scan(pos, mentsu, tatsu, hasHead) {
    if (mentsu + tatsu > 4 - meldCount) {
      tatsu = 4 - meldCount - mentsu;
    }
    const shanten = 8 - meldCount * 2 - mentsu * 2 - tatsu - (hasHead ? 1 : 0);
    if (shanten < best) best = shanten;

    while (pos < 34 && c[pos] === 0) pos++;
    if (pos >= 34) return;

    if (c[pos] >= 3) {
      c[pos] -= 3;
      scan(pos, mentsu + 1, tatsu, hasHead);
      c[pos] += 3;
    }

    const suitPos = pos % 9;
    if (pos < 27 && suitPos <= 6 && c[pos + 1] > 0 && c[pos + 2] > 0) {
      c[pos]--;
      c[pos + 1]--;
      c[pos + 2]--;
      scan(pos, mentsu + 1, tatsu, hasHead);
      c[pos]++;
      c[pos + 1]++;
      c[pos + 2]++;
    }

    if (c[pos] >= 2) {
      if (!hasHead) {
        c[pos] -= 2;
        scan(pos, mentsu, tatsu, true);
        c[pos] += 2;
      }
      if (mentsu + tatsu < 4 - meldCount) {
        c[pos] -= 2;
        scan(pos, mentsu, tatsu + 1, hasHead);
        c[pos] += 2;
      }
    }

    if (pos < 27 && suitPos <= 7 && c[pos + 1] > 0 && mentsu + tatsu < 4 - meldCount) {
      c[pos]--;
      c[pos + 1]--;
      scan(pos, mentsu, tatsu + 1, hasHead);
      c[pos]++;
      c[pos + 1]++;
    }

    if (pos < 27 && suitPos <= 6 && c[pos + 2] > 0 && mentsu + tatsu < 4 - meldCount) {
      c[pos]--;
      c[pos + 2]--;
      scan(pos, mentsu, tatsu + 1, hasHead);
      c[pos]++;
      c[pos + 2]++;
    }

    scan(pos + 1, mentsu, tatsu, hasHead);
  }

  scan(0, 0, 0, false);
  return best;
}

export function calcShanten(counts, meldCount = 0) {
  const std = calcStandardShanten(counts, meldCount);
  if (meldCount > 0) return std;
  const chiitoi = calcChiitoiShanten(counts);
  const kokushi = calcKokushiShanten(counts);
  return Math.min(std, chiitoi, kokushi);
}

export function getEffectiveTiles(counts13, visibleCounts, meldCount = 0) {
  const baseShanten = calcShanten(counts13, meldCount);
  const waits = [];
  let totalRemaining = 0;

  for (let k = 0; k < 34; k++) {
    if (counts13[k] >= 4) continue;
    counts13[k]++;
    const nextShanten = calcShanten(counts13, meldCount);
    counts13[k]--;

    if (nextShanten < baseShanten) {
      const rem = Math.max(0, 4 - visibleCounts[k]);
      waits.push({
        kindId: k,
        label: kindToLabel(k),
        remaining: rem
      });
      totalRemaining += rem;
    }
  }

  return {
    shanten: baseShanten,
    waits,
    totalRemaining
  };
}

export function analyzeDiscardCandidates(
  handTileIds,
  drawnTileId,
  visibleTileIds,
  redDora = true,
  meldCount = 0
) {
  const allTiles = drawnTileId !== null ? [...handTileIds, drawnTileId] : [...handTileIds];
  const visibleCounts = toCounts34([...allTiles, ...visibleTileIds]);

  const seenLabels = new Set();
  const candidates = [];

  for (const tid of allTiles) {
    const k = tileIdToKind(tid);
    const label = tileIdToLabel(tid, redDora);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);

    const remain = [];
    let removed = false;
    for (const x of allTiles) {
      if (!removed && x === tid) {
        removed = true;
        continue;
      }
      remain.push(x);
    }

    const countsRemain = toCounts34(remain);
    const eff = getEffectiveTiles(countsRemain, visibleCounts, meldCount);

    candidates.push({
      tileId: tid,
      label,
      kindId: k,
      shantenAfter: eff.shanten,
      waits: eff.waits,
      acceptanceCount: eff.totalRemaining
    });
  }

  candidates.sort((a, b) => {
    if (a.shantenAfter !== b.shantenAfter) return a.shantenAfter - b.shantenAfter;
    return b.acceptanceCount - a.acceptanceCount;
  });

  return candidates;
}
