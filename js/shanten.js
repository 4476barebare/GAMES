/**
 * shanten.js
 * シャンテン数計算（通常手・七対子・国士無双）および打牌ごとの受け入れ枚数・待ち牌解析
 */

import { tileIdToKind, tileIdToLabel, kindToLabel, toCounts34 } from "./tiles.js";

const KOKUSHI_KINDS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

/**
 * 国士無双のシャンテン数（13枚または14枚対応）
 */
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

/**
 * 七対子のシャンテン数（13枚または14枚対応）
 */
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

/**
 * 通常手のシャンテン数（13枚または14枚対応、meldCountは副露数）
 */
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

    // 1. 刻子抜き出し
    if (c[pos] >= 3) {
      c[pos] -= 3;
      scan(pos, mentsu + 1, tatsu, hasHead);
      c[pos] += 3;
    }

    // 2. 順子抜き出し（数牌かつ7以下）
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

    // 3. 対子抜き出し（雀頭 or 対子塔子）
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

    // 4. 両面・辺張塔子
    if (pos < 27 && suitPos <= 7 && c[pos + 1] > 0 && mentsu + tatsu < 4 - meldCount) {
      c[pos]--;
      c[pos + 1]--;
      scan(pos, mentsu, tatsu + 1, hasHead);
      c[pos]++;
      c[pos + 1]++;
    }

    // 5. 嵌張塔子
    if (pos < 27 && suitPos <= 6 && c[pos + 2] > 0 && mentsu + tatsu < 4 - meldCount) {
      c[pos]--;
      c[pos + 2]--;
      scan(pos, mentsu, tatsu + 1, hasHead);
      c[pos]++;
      c[pos + 2]++;
    }

    // 6. 孤立牌としてスキップ
    scan(pos + 1, mentsu, tatsu, hasHead);
  }

  scan(0, 0, 0, false);
  return best;
}

/**
 * 総合シャンテン数（-1: 和了, 0: 聴牌, 1..: Nシャンテン）
 */
export function calcShanten(counts, meldCount = 0) {
  const std = calcStandardShanten(counts, meldCount);
  if (meldCount > 0) return std;
  const chiitoi = calcChiitoiShanten(counts);
  const kokushi = calcKokushiShanten(counts);
  return Math.min(std, chiitoi, kokushi);
}

/**
 * 13枚の手牌状態から有効牌（シャンテン数が進む牌種）と残り枚数を算出
 */
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

/**
 * 14枚手牌の各打牌候補について、切った後のシャンテン数・待ち牌・受け入れ枚数を解析
 */
export function analyzeDiscardCandidates(handTileIds, drawnTileId, visibleTileIds, redDora = true) {
  const all14 = drawnTileId !== null ? [...handTileIds, drawnTileId] : [...handTileIds];
  const visibleCounts = toCounts34([...all14, ...visibleTileIds]);

  const seenKinds = new Set();
  const candidates = [];

  for (const tid of all14) {
    const k = tileIdToKind(tid);
    const label = tileIdToLabel(tid, redDora);
    const key = `${label}`;
    if (seenKinds.has(key)) continue;
    seenKinds.add(key);

    // 1枚抜いた13枚配列を作成
    const remain13 = [];
    let removed = false;
    for (const x of all14) {
      if (!removed && x === tid) {
        removed = true;
        continue;
      }
      remain13.push(x);
    }

    const counts13 = toCounts34(remain13);
    const eff = getEffectiveTiles(counts13, visibleCounts, 0);

    candidates.push({
      tileId: tid,
      label,
      kindId: k,
      shantenAfter: eff.shanten,
      waits: eff.waits,
      acceptanceCount: eff.totalRemaining
    });
  }

  // シャンテン数が小さい順 -> 受け入れ枚数が多い順にソート
  candidates.sort((a, b) => {
    if (a.shantenAfter !== b.shantenAfter) return a.shantenAfter - b.shantenAfter;
    return b.acceptanceCount - a.acceptanceCount;
  });

  return candidates;
}
