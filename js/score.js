/**
 * score.js
 * 面子分解・役判定・簡易符計算・点数計算・フリテン判定（ver.0 門前ベース）
 */

import { tileIdToKind, isRedDora, indicatorToDoraKind, toCounts34 } from "./tiles.js";
import { calcChiitoiShanten, calcKokushiShanten } from "./shanten.js";

/**
 * 14枚手牌（門前）を「1雀頭＋4面子」に全通り分解する
 */
export function decomposeStandard(counts) {
  const results = [];

  function extractMentsu(c, pos, mentsuList) {
    while (pos < 34 && c[pos] === 0) pos++;
    if (pos >= 34) {
      if (mentsuList.length === 4) {
        results.push(mentsuList.map((m) => ({ ...m })));
      }
      return;
    }

    // 刻子
    if (c[pos] >= 3) {
      c[pos] -= 3;
      mentsuList.push({ type: "koutsu", kind: pos });
      extractMentsu(c, pos, mentsuList);
      mentsuList.pop();
      c[pos] += 3;
    }

    // 順子
    if (pos < 27 && pos % 9 <= 6 && c[pos + 1] > 0 && c[pos + 2] > 0) {
      c[pos]--;
      c[pos + 1]--;
      c[pos + 2]--;
      mentsuList.push({ type: "shuntsu", kind: pos });
      extractMentsu(c, pos, mentsuList);
      mentsuList.pop();
      c[pos]++;
      c[pos + 1]++;
      c[pos + 2]++;
    }
  }

  for (let head = 0; head < 34; head++) {
    if (counts[head] >= 2) {
      const c = [...counts];
      c[head] -= 2;
      const beforeLen = results.length;
      extractMentsu(c, 0, []);
      for (let i = beforeLen; i < results.length; i++) {
        results[i] = { head, mentsu: results[i] };
      }
    }
  }

  return results;
}

function isTerminalOrHonor(kind) {
  if (kind >= 27) return true;
  const n = kind % 9;
  return n === 0 || n === 8;
}

function windToKind(windChar) {
  if (windChar === "E") return 27;
  if (windChar === "S") return 28;
  if (windChar === "W") return 29;
  return 30;
}

/**
 * アガリ判定と点数計算
 * @param {object} params
 * @returns {object|null} 和了成立時は { han, fu, points, label, yakus }、役なし・未和了は null
 */
export function evaluateWin({
  handTileIds,
  winTileId,
  isTsumo,
  isRiichi,
  isIppatsu,
  isDealer,
  seatWind,
  roundWind,
  doraIndicators,
  uraDoraIndicators,
  redDoraEnabled = true
}) {
  const all14 = [...handTileIds, winTileId];
  if (all14.length !== 14) return null;

  const counts = toCounts34(all14);
  const winKind = tileIdToKind(winTileId);

  // ドラ枚数カウント
  const doraKinds = doraIndicators.map(indicatorToDoraKind);
  const uraKinds = isRiichi ? uraDoraIndicators.map(indicatorToDoraKind) : [];

  let doraCount = 0;
  let uraCount = 0;
  let redCount = 0;
  for (const tid of all14) {
    const k = tileIdToKind(tid);
    for (const dk of doraKinds) if (k === dk) doraCount++;
    for (const uk of uraKinds) if (k === uk) uraCount++;
    if (isRedDora(tid, redDoraEnabled)) redCount++;
  }

  const candidateResults = [];

  // 1. 国士無双チェック
  if (calcKokushiShanten(counts) === -1) {
    const pts = isDealer ? 48000 : 32000;
    return {
      han: 13,
      fu: 0,
      points: pts,
      label: "役満",
      yakus: [{ name: "国士無双", han: 13 }]
    };
  }

  // 2. 七対子チェック
  if (calcChiitoiShanten(counts) === -1) {
    const yakus = [{ name: "七対子", han: 2 }];
    if (isRiichi) yakus.push({ name: "リーチ", han: 1 });
    if (isIppatsu) yakus.push({ name: "一発", han: 1 });
    if (isTsumo) yakus.push({ name: "門前清自摸和", han: 1 });

    // タンヤオ・混一色・清一色
    const allTanyao = counts.every((cnt, k) => cnt === 0 || !isTerminalOrHonor(k));
    if (allTanyao) yakus.push({ name: "断幺九", han: 1 });

    const suits = new Set();
    let hasHonor = false;
    counts.forEach((cnt, k) => {
      if (cnt === 0) return;
      if (k >= 27) hasHonor = true;
      else suits.add(Math.floor(k / 9));
    });
    if (suits.size === 1) {
      yakus.push(hasHonor ? { name: "混一色", han: 3 } : { name: "清一色", han: 6 });
    }

    if (doraCount > 0) yakus.push({ name: `ドラ${doraCount}`, han: doraCount });
    if (uraCount > 0) yakus.push({ name: `裏ドラ${uraCount}`, han: uraCount });
    if (redCount > 0) yakus.push({ name: `赤ドラ${redCount}`, han: redCount });

    const totalHan = yakus.reduce((s, y) => s + y.han, 0);
    candidateResults.push(buildFinalScore(totalHan, 25, isDealer, yakus));
  }

  // 3. 通常手（面子分解全パターン評価）
  const decompositions = decomposeStandard(counts);
  for (const dec of decompositions) {
    const yakus = [];
    if (isRiichi) yakus.push({ name: "リーチ", han: 1 });
    if (isIppatsu) yakus.push({ name: "一発", han: 1 });
    if (isTsumo) yakus.push({ name: "門前清自摸和", han: 1 });

    // タンヤオ
    const allTanyao = counts.every((cnt, k) => cnt === 0 || !isTerminalOrHonor(k));
    if (allTanyao) yakus.push({ name: "断幺九", han: 1 });

    // 役牌（白・發・中・自風・場風）
    const seatWindKind = windToKind(seatWind);
    const roundWindKind = windToKind(roundWind);
    for (const m of dec.mentsu) {
      if (m.type !== "koutsu") continue;
      if (m.kind === 31) yakus.push({ name: "役牌:白", han: 1 });
      if (m.kind === 32) yakus.push({ name: "役牌:發", han: 1 });
      if (m.kind === 33) yakus.push({ name: "役牌:中", han: 1 });
      if (m.kind === seatWindKind) yakus.push({ name: "自風牌", han: 1 });
      if (m.kind === roundWindKind) yakus.push({ name: "場風牌", han: 1 });
    }

    // ピンフ判定（門前・全順子・雀頭が役牌以外・両面待ち）
    const allShuntsu = dec.mentsu.every((m) => m.type === "shuntsu");
    const headIsValue =
      dec.head >= 31 || dec.head === seatWindKind || dec.head === roundWindKind;
    let isRyanmen = false;
    if (allShuntsu && !headIsValue) {
      for (const m of dec.mentsu) {
        const n = m.kind % 9;
        // 123の3待ち(辺張)や789の7待ち(辺張)を除外
        if (m.kind === winKind && n !== 6) isRyanmen = true;
        if (m.kind + 2 === winKind && n !== 0) isRyanmen = true;
      }
      if (isRyanmen) yakus.push({ name: "平和", han: 1 });
    }

    // 一盃口・二盃口
    const shuntsuKinds = dec.mentsu.filter((m) => m.type === "shuntsu").map((m) => m.kind);
    const shuntsuMap = new Map();
    for (const sk of shuntsuKinds) shuntsuMap.set(sk, (shuntsuMap.get(sk) || 0) + 1);
    let iipeikouPairs = 0;
    for (const cnt of shuntsuMap.values()) {
      iipeikouPairs += Math.floor(cnt / 2);
    }
    if (iipeikouPairs === 2) yakus.push({ name: "二盃口", han: 3 });
    else if (iipeikouPairs === 1) yakus.push({ name: "一盃口", han: 1 });

    // 対々和・三暗刻・四暗刻
    const koutsuList = dec.mentsu.filter((m) => m.type === "koutsu");
    if (koutsuList.length === 4) {
      yakus.push({ name: "対々和", han: 2 });
    }
    const concealedKoutsu = koutsuList.filter((m) => isTsumo || m.kind !== winKind).length;
    if (concealedKoutsu === 4) {
      return {
        han: 13,
        fu: 0,
        points: isDealer ? 48000 : 32000,
        label: "役満",
        yakus: [{ name: "四暗刻", han: 13 }]
      };
    } else if (concealedKoutsu === 3) {
      yakus.push({ name: "三暗刻", han: 2 });
    }

    // 三色同順
    for (let n = 0; n <= 6; n++) {
      if (
        shuntsuKinds.includes(n) &&
        shuntsuKinds.includes(9 + n) &&
        shuntsuKinds.includes(18 + n)
      ) {
        yakus.push({ name: "三色同順", han: 2 });
        break;
      }
    }

    // 一気通貫
    for (let s = 0; s < 3; s++) {
      const base = s * 9;
      if (
        shuntsuKinds.includes(base) &&
        shuntsuKinds.includes(base + 3) &&
        shuntsuKinds.includes(base + 6)
      ) {
        yakus.push({ name: "一気通貫", han: 2 });
        break;
      }
    }

    // 混一色・清一色
    const suits = new Set();
    let hasHonor = false;
    counts.forEach((cnt, k) => {
      if (cnt === 0) return;
      if (k >= 27) hasHonor = true;
      else suits.add(Math.floor(k / 9));
    });
    if (suits.size === 1) {
      yakus.push(hasHonor ? { name: "混一色", han: 3 } : { name: "清一色", han: 6 });
    }

    // 1翻縛りチェック（ドラ加算前に少なくとも1つ役が必要）
    if (yakus.length === 0) continue;

    if (doraCount > 0) yakus.push({ name: `ドラ${doraCount}`, han: doraCount });
    if (uraCount > 0) yakus.push({ name: `裏ドラ${uraCount}`, han: uraCount });
    if (redCount > 0) yakus.push({ name: `赤ドラ${redCount}`, han: redCount });

    const totalHan = yakus.reduce((s, y) => s + y.han, 0);

    // 簡易符計算（ピンフツモ20符 / ピンフロン30符 / 門前ロン40符 / 門前ツモ30符ベース）
    let fu = isTsumo ? 30 : 40;
    if (allShuntsu && isRyanmen) {
      fu = isTsumo ? 20 : 30;
    } else if (koutsuList.length >= 2 && !isTsumo) {
      fu = 50;
    }

    candidateResults.push(buildFinalScore(totalHan, fu, isDealer, yakus));
  }

  if (candidateResults.length === 0) return null;

  // 最も高得点になる解釈を採用
  candidateResults.sort((a, b) => b.points - a.points);
  return candidateResults[0];
}

function buildFinalScore(han, fu, isDealer, yakus) {
  let basePoints;
  let label = `${han}翻 ${fu}符`;

  if (han >= 13) {
    basePoints = 8000;
    label = "数え役満";
  } else if (han >= 11) {
    basePoints = 6000;
    label = "三倍満";
  } else if (han >= 8) {
    basePoints = 4000;
    label = "倍満";
  } else if (han >= 6) {
    basePoints = 3000;
    label = "跳満";
  } else if (han === 5 || (han === 4 && fu >= 40) || (han === 3 && fu >= 70)) {
    basePoints = 2000;
    label = "満貫";
  } else {
    basePoints = fu * Math.pow(2, han + 2);
    if (basePoints > 2000) {
      basePoints = 2000;
      label = "満貫";
    }
  }

  const multiplier = isDealer ? 6 : 4;
  const raw = basePoints * multiplier;
  const points = Math.ceil(raw / 100) * 100;

  return { han, fu, points, label, yakus };
}

/**
 * フリテン判定（自分の捨て牌に自分の待ち牌が含まれているか）
 */
export function checkFuriten(hand13TileIds, discards) {
  const counts13 = toCounts34(hand13TileIds);
  const waitKinds = new Set();

  for (let k = 0; k < 34; k++) {
    if (counts13[k] >= 4) continue;
    counts13[k]++;
    const isWinShape =
      decomposeStandard(counts13).length > 0 ||
      calcChiitoiShanten(counts13) === -1 ||
      calcKokushiShanten(counts13) === -1;
    counts13[k]--;
    if (isWinShape) waitKinds.add(k);
  }

  if (waitKinds.size === 0) return false;
  for (const d of discards) {
    if (waitKinds.has(tileIdToKind(d.tileId))) return true;
  }
  return false;
}
