/**
 * score.js
 * 4人麻雀対応 副露（鳴き・喰い下がり・喰いタン）対応 面子分解・役判定・符計算・点数計算・フリテン判定
 */

import { tileIdToKind, isRedDora, indicatorToDoraKind, toCounts34 } from "./tiles.js";
import { calcChiitoiShanten, calcKokushiShanten } from "./shanten.js";

export function decomposeStandard(counts, targetMentsuCount = 4) {
  const results = [];

  function extractMentsu(c, pos, mentsuList) {
    while (pos < 34 && c[pos] === 0) pos++;
    if (pos >= 34) {
      if (mentsuList.length === targetMentsuCount) {
        results.push(mentsuList.map((m) => ({ ...m })));
      }
      return;
    }

    if (c[pos] >= 3) {
      c[pos] -= 3;
      mentsuList.push({ type: "koutsu", kind: pos, open: false });
      extractMentsu(c, pos, mentsuList);
      mentsuList.pop();
      c[pos] += 3;
    }

    if (pos < 27 && pos % 9 <= 6 && c[pos + 1] > 0 && c[pos + 2] > 0) {
      c[pos]--;
      c[pos + 1]--;
      c[pos + 2]--;
      mentsuList.push({ type: "shuntsu", kind: pos, open: false });
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

function meldToMentsuObj(meld) {
  const kinds = meld.tiles.map(tileIdToKind).sort((a, b) => a - b);
  if (meld.type === "chi") {
    return { type: "shuntsu", kind: kinds[0], open: true };
  }
  const isOpen = meld.type !== "ankan";
  return {
    type: "koutsu",
    kind: kinds[0],
    open: isOpen,
    isKan: meld.type === "ankan" || meld.type === "minkan" || meld.type === "kakan"
  };
}

export function evaluateWin({
  handTileIds,
  winTileId,
  melds = [],
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
  const closedTiles = [...handTileIds, winTileId];
  const expectedClosedLen = 14 - melds.length * 3;
  if (closedTiles.length !== expectedClosedLen) return null;

  const meldTiles = melds.flatMap((m) => m.tiles);
  const allTiles = [...closedTiles, ...meldTiles];
  const countsClosed = toCounts34(closedTiles);
  const countsAll = toCounts34(allTiles);
  const winKind = tileIdToKind(winTileId);

  const isMenzen = melds.every((m) => m.type === "ankan");

  const doraKinds = doraIndicators.map(indicatorToDoraKind);
  const uraKinds = isRiichi ? uraDoraIndicators.map(indicatorToDoraKind) : [];

  let doraCount = 0;
  let uraCount = 0;
  let redCount = 0;
  for (const tid of allTiles) {
    const k = tileIdToKind(tid);
    for (const dk of doraKinds) if (k === dk) doraCount++;
    for (const uk of uraKinds) if (k === uk) uraCount++;
    if (isRedDora(tid, redDoraEnabled)) redCount++;
  }

  const candidateResults = [];

  // 1. 国士無双（門前のみ）
  if (melds.length === 0 && calcKokushiShanten(countsClosed) === -1) {
    return buildFinalScore(13, 0, isDealer, isTsumo, [{ name: "国士無双", han: 13 }], true);
  }

  // 2. 七対子（門前のみ）
  if (melds.length === 0 && calcChiitoiShanten(countsClosed) === -1) {
    const yakus = [{ name: "七対子", han: 2 }];
    if (isRiichi) yakus.push({ name: "リーチ", han: 1 });
    if (isIppatsu) yakus.push({ name: "一発", han: 1 });
    if (isTsumo) yakus.push({ name: "門前清自摸和", han: 1 });

    const allTanyao = countsAll.every((cnt, k) => cnt === 0 || !isTerminalOrHonor(k));
    if (allTanyao) yakus.push({ name: "断幺九", han: 1 });

    const allTermHonor = countsAll.every((cnt, k) => cnt === 0 || isTerminalOrHonor(k));
    if (allTermHonor) yakus.push({ name: "混老頭", han: 2 });

    const suits = new Set();
    let hasHonor = false;
    countsAll.forEach((cnt, k) => {
      if (cnt === 0) return;
      if (k >= 27) hasHonor = true;
      else suits.add(Math.floor(k / 9));
    });
    if (suits.size === 0 && hasHonor) {
      return buildFinalScore(13, 0, isDealer, isTsumo, [{ name: "字一色", han: 13 }], true);
    }
    if (suits.size === 1) {
      yakus.push(hasHonor ? { name: "混一色", han: 3 } : { name: "清一色", han: 6 });
    }

    if (doraCount > 0) yakus.push({ name: `ドラ${doraCount}`, han: doraCount });
    if (uraCount > 0) yakus.push({ name: `裏ドラ${uraCount}`, han: uraCount });
    if (redCount > 0) yakus.push({ name: `赤ドラ${redCount}`, han: redCount });

    const totalHan = yakus.reduce((s, y) => s + y.han, 0);
    candidateResults.push(buildFinalScore(totalHan, 25, isDealer, isTsumo, yakus));
  }

  // 3. 通常手（副露面子＋手牌面子分解）
  const fixedMentsu = melds.map(meldToMentsuObj);
  const decompositions = decomposeStandard(countsClosed, 4 - melds.length);
  const seatWindKind = windToKind(seatWind);
  const roundWindKind = windToKind(roundWind);

  for (const dec of decompositions) {
    const allMentsu = [...fixedMentsu, ...dec.mentsu];
    const yakus = [];
    if (isMenzen && isRiichi) yakus.push({ name: "リーチ", han: 1 });
    if (isMenzen && isIppatsu) yakus.push({ name: "一発", han: 1 });
    if (isMenzen && isTsumo) yakus.push({ name: "門前清自摸和", han: 1 });

    const koutsuList = allMentsu.filter((m) => m.type === "koutsu");
    const shuntsuList = allMentsu.filter((m) => m.type === "shuntsu");
    const shuntsuKinds = shuntsuList.map((m) => m.kind);

    const dragonKoutsu = koutsuList.filter((m) => m.kind >= 31 && m.kind <= 33).length;
    if (dragonKoutsu === 3) {
      return buildFinalScore(13, 0, isDealer, isTsumo, [{ name: "大三元", han: 13 }], true);
    }
    const concealedKoutsu = koutsuList.filter(
      (m) => !m.open && (isTsumo || m.kind !== winKind)
    ).length;
    if (concealedKoutsu === 4) {
      return buildFinalScore(13, 0, isDealer, isTsumo, [{ name: "四暗刻", han: 13 }], true);
    }

    const suits = new Set();
    let hasHonor = false;
    countsAll.forEach((cnt, k) => {
      if (cnt === 0) return;
      if (k >= 27) hasHonor = true;
      else suits.add(Math.floor(k / 9));
    });
    if (suits.size === 0 && hasHonor) {
      return buildFinalScore(13, 0, isDealer, isTsumo, [{ name: "字一色", han: 13 }], true);
    }

    // 喰いタンあり
    const allTanyao = countsAll.every((cnt, k) => cnt === 0 || !isTerminalOrHonor(k));
    if (allTanyao) yakus.push({ name: "断幺九", han: 1 });

    // 役牌（鳴いても1翻）
    for (const m of koutsuList) {
      if (m.kind === 31) yakus.push({ name: "役牌:白", han: 1 });
      if (m.kind === 32) yakus.push({ name: "役牌:發", han: 1 });
      if (m.kind === 33) yakus.push({ name: "役牌:中", han: 1 });
      if (m.kind === seatWindKind) yakus.push({ name: "自風牌", han: 1 });
      if (m.kind === roundWindKind) yakus.push({ name: "場風牌", han: 1 });
    }

    if (dragonKoutsu === 2 && dec.head >= 31 && dec.head <= 33) {
      yakus.push({ name: "小三元", han: 2 });
    }

    // 平和（門前のみ）
    const allShuntsu = shuntsuList.length === 4;
    const headIsValue =
      dec.head >= 31 || dec.head === seatWindKind || dec.head === roundWindKind;
    let isRyanmen = false;
    if (isMenzen && allShuntsu && !headIsValue) {
      for (const m of dec.mentsu) {
        if (m.type !== "shuntsu") continue;
        const n = m.kind % 9;
        if (m.kind === winKind && n !== 6) isRyanmen = true;
        if (m.kind + 2 === winKind && n !== 0) isRyanmen = true;
      }
      if (isRyanmen) yakus.push({ name: "平和", han: 1 });
    }

    // 一盃口・二盃口（門前のみ）
    if (isMenzen) {
      const shuntsuMap = new Map();
      for (const sk of shuntsuKinds) shuntsuMap.set(sk, (shuntsuMap.get(sk) || 0) + 1);
      let iipeikouPairs = 0;
      for (const cnt of shuntsuMap.values()) iipeikouPairs += Math.floor(cnt / 2);
      if (iipeikouPairs === 2) yakus.push({ name: "二盃口", han: 3 });
      else if (iipeikouPairs === 1) yakus.push({ name: "一盃口", han: 1 });
    }

    if (koutsuList.length === 4) yakus.push({ name: "対々和", han: 2 });
    if (concealedKoutsu === 3) yakus.push({ name: "三暗刻", han: 2 });

    // 三色同順（喰い下がり1翻）
    for (let n = 0; n <= 6; n++) {
      if (
        shuntsuKinds.includes(n) &&
        shuntsuKinds.includes(9 + n) &&
        shuntsuKinds.includes(18 + n)
      ) {
        yakus.push({ name: "三色同順", han: isMenzen ? 2 : 1 });
        break;
      }
    }

    // 一気通貫（喰い下がり1翻）
    for (let s = 0; s < 3; s++) {
      const base = s * 9;
      if (
        shuntsuKinds.includes(base) &&
        shuntsuKinds.includes(base + 3) &&
        shuntsuKinds.includes(base + 6)
      ) {
        yakus.push({ name: "一気通貫", han: isMenzen ? 2 : 1 });
        break;
      }
    }

    // チャンタ・ジュンチャン（喰い下がり1翻）
    const allMentsuHasTerm = allMentsu.every((m) =>
      m.type === "koutsu"
        ? isTerminalOrHonor(m.kind)
        : m.kind % 9 === 0 || m.kind % 9 === 6
    );
    if (allMentsuHasTerm && isTerminalOrHonor(dec.head) && shuntsuList.length > 0) {
      if (!hasHonor) yakus.push({ name: "純全帯幺九", han: isMenzen ? 3 : 2 });
      else yakus.push({ name: "混全帯幺九", han: isMenzen ? 2 : 1 });
    }

    // 混一色・清一色（喰い下がり1翻）
    if (suits.size === 1) {
      if (hasHonor) yakus.push({ name: "混一色", han: isMenzen ? 3 : 2 });
      else yakus.push({ name: "清一色", han: isMenzen ? 6 : 5 });
    }

    if (yakus.length === 0) continue;

    if (doraCount > 0) yakus.push({ name: `ドラ${doraCount}`, han: doraCount });
    if (uraCount > 0) yakus.push({ name: `裏ドラ${uraCount}`, han: uraCount });
    if (redCount > 0) yakus.push({ name: `赤ドラ${redCount}`, han: redCount });

    const totalHan = yakus.reduce((s, y) => s + y.han, 0);

    let fu = isMenzen ? (isTsumo ? 30 : 40) : 30;
    if (isMenzen && allShuntsu && isRyanmen) {
      fu = isTsumo ? 20 : 30;
    } else if (koutsuList.length >= 2) {
      fu = isMenzen && !isTsumo ? 50 : 40;
    }

    candidateResults.push(buildFinalScore(totalHan, fu, isDealer, isTsumo, yakus));
  }

  if (candidateResults.length === 0) return null;
  candidateResults.sort((a, b) => b.points - a.points);
  return candidateResults[0];
}

function ceil100(n) {
  return Math.ceil(n / 100) * 100;
}

function buildFinalScore(han, fu, isDealer, isTsumo, yakus, isYakuman = false) {
  let basePoints;
  let label = `${han}翻 ${fu}符`;

  if (isYakuman) {
    basePoints = 8000;
    label = "役満";
  } else if (han >= 13) {
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

  let points;
  let tsumoPay = null;

  if (isTsumo) {
    if (isDealer) {
      const eachChild = ceil100(basePoints * 2);
      points = eachChild * 3;
      tsumoPay = { dealerPay: 0, childPay: eachChild, text: `${eachChild}オール` };
    } else {
      const dealerPay = ceil100(basePoints * 2);
      const childPay = ceil100(basePoints);
      points = dealerPay + childPay * 2;
      tsumoPay = { dealerPay, childPay, text: `${childPay}/${dealerPay}` };
    }
  } else {
    points = ceil100(basePoints * (isDealer ? 6 : 4));
  }

  return { han, fu, basePoints, points, tsumoPay, label, yakus };
}

export function checkFuriten(handTileIds, discards, melds = []) {
  const countsClosed = toCounts34(handTileIds);
  const waitKinds = new Set();
  const targetMentsu = 4 - melds.length;

  for (let k = 0; k < 34; k++) {
    if (countsClosed[k] >= 4) continue;
    countsClosed[k]++;
    const isWinShape =
      decomposeStandard(countsClosed, targetMentsu).length > 0 ||
      (melds.length === 0 && calcChiitoiShanten(countsClosed) === -1) ||
      (melds.length === 0 && calcKokushiShanten(countsClosed) === -1);
    countsClosed[k]--;
    if (isWinShape) waitKinds.add(k);
  }

  if (waitKinds.size === 0) return false;
  for (const d of discards) {
    if (waitKinds.has(tileIdToKind(d.tileId))) return true;
  }
  return false;
}
