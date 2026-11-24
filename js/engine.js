/**
 * engine.js
 * 4人麻雀（半荘戦）鳴き完全対応エンジン（チー・ポン・大明槓・暗槓・加槓・優先順位判定・性格別内蔵AI）
 */

import {
  tileIdToKind,
  tileIdToLabel,
  kindToLabel,
  indicatorToDoraKind,
  sortTileIds,
  toCounts34,
  findTileIdByLabel,
  findMultipleTileIdsByLabels
} from "./tiles.js";
import { calcShanten, analyzeDiscardCandidates } from "./shanten.js";
import { evaluateWin, checkFuriten } from "./score.js";

const WINDS = ["E", "S", "W", "N"];
const UMA_TABLE = [30, 10, -10, -30];
const OKA_BONUS = 20;
const RETURN_POINTS = 30000;

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildWall() {
  const ids = [];
  for (let id = 0; id < 136; id++) ids.push(id);
  const shuffled = shuffle(ids);
  const dead = shuffled.splice(0, 14);
  return {
    live: shuffled,
    dead,
    doraIndicators: [dead[4]],
    uraDoraIndicators: [dead[5]],
    kanCount: 0,
    remaining: shuffled.length
  };
}

export function createMatchState(options = {}) {
  const defaultPlayers = [
    { id: "p0", name: "あなた", control: "human", aiConfig: null },
    {
      id: "p1",
      name: "下家(デジタル)",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", apiKey: "", personaId: "digital_balanced", customPrompt: "" }
    },
    {
      id: "p2",
      name: "対面(超攻撃)",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", apiKey: "", personaId: "aggressive_riichi", customPrompt: "" }
    },
    {
      id: "p3",
      name: "上家(鉄壁守備)",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", apiKey: "", personaId: "iron_defense", customPrompt: "" }
    }
  ];

  const playerConfigs = options.players || defaultPlayers;
  const players = [];
  for (let i = 0; i < 4; i++) {
    const cfg = playerConfigs[i] || defaultPlayers[i];
    players.push({
      seatIndex: i,
      wind: WINDS[i],
      id: cfg.id,
      name: cfg.name,
      control: cfg.control,
      aiConfig: cfg.aiConfig,
      points: options.initialPoints || 25000,
      hand: [],
      drawnTile: null,
      discards: [],
      melds: [],
      isRiichi: false,
      riichiTurn: null,
      isIppatsu: false,
      isFuriten: false,
      isTempFuriten: false,
      isRiichiFuriten: false,
      lastThought: "",
      lastTalk: ""
    });
  }

  const state = {
    schemaVersion: "1.2",
    roomId: options.roomId || null,
    version: 1,
    updatedAt: Date.now(),
    status: "playing",
    config: {
      mode: "4p",
      maxPlayers: 4,
      roundType: "hanchan",
      tileSet: "full136",
      redDora: true,
      openTanyao: true,
      allowCalls: true,
      initialPoints: 25000,
      returnPoints: RETURN_POINTS
    },
    round: {
      wind: "E",
      number: 1,
      honba: 0,
      riichiSticks: 0,
      dealerIndex: 0,
      roundsPlayed: 0
    },
    turn: {
      playerIndex: 0,
      phase: "discard",
      turnCount: 1,
      isRinshanTurn: false,
      lastDiscard: null,
      pendingClaims: [],
      claimResponses: {}
    },
    wall: null,
    players,
    lastResult: null,
    finalSettlement: null,
    history: []
  };

  return dealRound(state);
}

function dealRound(prevState) {
  const state = structuredClone(prevState);
  const dealerIndex = state.round.dealerIndex;
  const n = state.players.length;

  state.wall = buildWall();
  state.status = "playing";
  state.lastResult = null;
  state.round.roundsPlayed += 1;

  for (let i = 0; i < n; i++) {
    const p = state.players[i];
    p.wind = WINDS[(i - dealerIndex + n) % n];
    p.hand = sortTileIds(state.wall.live.splice(0, 13));
    p.drawnTile = null;
    p.discards = [];
    p.melds = [];
    p.isRiichi = false;
    p.riichiTurn = null;
    p.isIppatsu = false;
    p.isFuriten = false;
    p.isTempFuriten = false;
    p.isRiichiFuriten = false;
    p.lastThought = "";
    p.lastTalk = "";
  }

  const dealer = state.players[dealerIndex];
  dealer.drawnTile = state.wall.live.shift();
  state.wall.remaining = state.wall.live.length;

  state.turn = {
    playerIndex: dealerIndex,
    phase: "discard",
    turnCount: 1,
    isRinshanTurn: false,
    lastDiscard: null,
    pendingClaims: [],
    claimResponses: {}
  };
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

export function advanceNextRoundOrFinish(prevState) {
  const state = structuredClone(prevState);
  const res = state.lastResult;
  if (!res) return state;

  const bustedPlayer = state.players.find((p) => p.points < 0);
  if (bustedPlayer) {
    return finalizeHanchan(state, `${bustedPlayer.name} の飛び（トビ）により半荘終了`);
  }

  const dealerIdx = state.round.dealerIndex;
  const isAllLast = state.round.wind === "S" && state.round.number === 4;

  let dealerContinues = false;
  let nextHonba = state.round.honba;

  if (res.type === "tsumo" || res.type === "ron") {
    const dealerWon = res.winners.some((w) => w.seatIndex === dealerIdx);
    if (dealerWon) {
      if (isAllLast && isSeatTop(state, dealerIdx)) {
        return finalizeHanchan(state, "オーラス親のトップ上がりやめにより半荘終了");
      }
      dealerContinues = true;
      nextHonba += 1;
    } else {
      dealerContinues = false;
      nextHonba = 0;
    }
  } else if (res.type === "draw") {
    const dealerTenpai = res.tenpaiSeats && res.tenpaiSeats.includes(dealerIdx);
    nextHonba += 1;
    if (dealerTenpai) {
      if (isAllLast && isSeatTop(state, dealerIdx)) {
        return finalizeHanchan(state, "オーラス親のトップ聴牌やめにより半荘終了");
      }
      dealerContinues = true;
    } else {
      dealerContinues = false;
    }
  }

  if (dealerContinues) {
    state.round.honba = nextHonba;
    return dealRound(state);
  }

  if (isAllLast) {
    return finalizeHanchan(state, "南4局（オーラス）終了により半荘完結");
  }

  state.round.dealerIndex = (dealerIdx + 1) % 4;
  state.round.honba = nextHonba;
  if (state.round.number < 4) {
    state.round.number += 1;
  } else {
    state.round.wind = "S";
    state.round.number = 1;
  }

  return dealRound(state);
}

function isSeatTop(state, seatIndex) {
  const targetPts = state.players[seatIndex].points;
  for (const p of state.players) {
    if (p.seatIndex === seatIndex) continue;
    if (p.points > targetPts) return false;
    if (p.points === targetPts && p.seatIndex < seatIndex) return false;
  }
  return true;
}

function finalizeHanchan(state, reason) {
  const ranked = [...state.players].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.seatIndex - b.seatIndex;
  });

  const leftoverRiichi = state.round.riichiSticks * 1000;
  if (leftoverRiichi > 0) {
    const topSeat = ranked[0].seatIndex;
    state.players[topSeat].points += leftoverRiichi;
    ranked[0].points += leftoverRiichi;
    state.round.riichiSticks = 0;
  }

  const standings = ranked.map((p, idx) => {
    const rank = idx + 1;
    const rawDiffPt = (p.points - RETURN_POINTS) / 1000;
    const uma = UMA_TABLE[idx];
    const oka = rank === 1 ? OKA_BONUS : 0;
    const finalScore = Math.round((rawDiffPt + uma + oka) * 10) / 10;
    return {
      rank,
      seatIndex: p.seatIndex,
      name: p.name,
      points: p.points,
      rawDiffPt: Math.round(rawDiffPt * 10) / 10,
      uma,
      oka,
      finalScore
    };
  });

  state.status = "match_end";
  state.finalSettlement = {
    reason,
    roundsPlayed: state.round.roundsPlayed,
    leftoverRiichiAwarded: leftoverRiichi,
    standings
  };
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

function getChiOptions(handTileIds, discardedTileId, redDora) {
  const dk = tileIdToKind(discardedTileId);
  if (dk >= 27) return [];
  const num = dk % 9;
  const counts = toCounts34(handTileIds);
  const options = [];

  if (num >= 2 && counts[dk - 2] > 0 && counts[dk - 1] > 0) {
    options.push(pickBestChiPair(handTileIds, dk - 2, dk - 1, redDora));
  }
  if (num >= 1 && num <= 7 && counts[dk - 1] > 0 && counts[dk + 1] > 0) {
    options.push(pickBestChiPair(handTileIds, dk - 1, dk + 1, redDora));
  }
  if (num <= 6 && counts[dk + 1] > 0 && counts[dk + 2] > 0) {
    options.push(pickBestChiPair(handTileIds, dk + 1, dk + 2, redDora));
  }

  return options;
}

function pickBestChiPair(handTileIds, kindA, kindB, redDora) {
  const idA = handTileIds.find((id) => tileIdToKind(id) === kindA);
  const idB = handTileIds.find((id) => tileIdToKind(id) === kindB);
  return [tileIdToLabel(idA, redDora), tileIdToLabel(idB, redDora)];
}

export function getLegalActions(state, seatIndex) {
  const actions = [];
  if (state.status !== "playing") return actions;

  const p = state.players[seatIndex];
  const red = state.config.redDora;
  const isMenzen = p.melds.every((m) => m.type === "ankan");

  if (state.turn.phase === "discard" && state.turn.playerIndex === seatIndex) {
    if (p.drawnTile !== null) {
      const winCheck = evaluateWin({
        handTileIds: p.hand,
        melds: p.melds,
        winTileId: p.drawnTile,
        isTsumo: true,
        isRiichi: p.isRiichi,
        isIppatsu: p.isIppatsu,
        isRinshan: state.turn.isRinshanTurn,
        isDealer: seatIndex === state.round.dealerIndex,
        seatWind: p.wind,
        roundWind: state.round.wind,
        doraIndicators: state.wall.doraIndicators,
        uraDoraIndicators: state.wall.uraDoraIndicators,
        redDoraEnabled: red
      });
      if (winCheck) {
        actions.push({ action: "tsumo", tile: tileIdToLabel(p.drawnTile, red), winInfo: winCheck });
      }
    }

    const allHand = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];
    const counts = toCounts34(allHand);

    if (p.drawnTile !== null && state.wall.remaining > 1 && state.wall.kanCount < 4) {
      for (let k = 0; k < 34; k++) {
        if (counts[k] === 4 && !p.isRiichi) {
          actions.push({ action: "ankan", tile: kindToLabel(k), kindId: k });
        }
      }
      if (!p.isRiichi) {
        for (const m of p.melds) {
          if (m.type === "pon") {
            const pk = tileIdToKind(m.tiles[0]);
            if (counts[pk] >= 1) {
              actions.push({ action: "kakan", tile: kindToLabel(pk), kindId: pk });
            }
          }
        }
      }
    }

    if (p.isRiichi) {
      if (p.drawnTile !== null) {
        actions.push({
          action: "discard",
          tile: tileIdToLabel(p.drawnTile, red),
          tileId: p.drawnTile
        });
      }
      return actions;
    }

    const seenLabels = new Set();
    for (const tid of allHand) {
      const label = tileIdToLabel(tid, red);
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);

      actions.push({ action: "discard", tile: label, tileId: tid });

      if (isMenzen && p.points >= 1000 && state.wall.remaining >= 4) {
        const remain = [];
        let removed = false;
        for (const x of allHand) {
          if (!removed && x === tid) {
            removed = true;
            continue;
          }
          remain.push(x);
        }
        if (calcShanten(toCounts34(remain), p.melds.length) === 0) {
          actions.push({ action: "riichi", tile: label, tileId: tid });
        }
      }
    }
    return actions;
  }

  if (state.turn.phase === "claim_check" && state.turn.pendingClaims.includes(seatIndex)) {
    const last = state.turn.lastDiscard;
    if (!last) return actions;

    const dLabel = tileIdToLabel(last.tileId, red);
    const dk = tileIdToKind(last.tileId);
    const isAnyFuriten = p.isFuriten || p.isTempFuriten || p.isRiichiFuriten;

    if (!isAnyFuriten) {
      const ronCheck = evaluateWin({
        handTileIds: p.hand,
        melds: p.melds,
        winTileId: last.tileId,
        isTsumo: false,
        isRiichi: p.isRiichi,
        isIppatsu: p.isIppatsu,
        isDealer: seatIndex === state.round.dealerIndex,
        seatWind: p.wind,
        roundWind: state.round.wind,
        doraIndicators: state.wall.doraIndicators,
        uraDoraIndicators: state.wall.uraDoraIndicators,
        redDoraEnabled: red
      });
      if (ronCheck) {
        actions.push({ action: "ron", tile: dLabel, winInfo: ronCheck });
      }
    }

    if (state.config.allowCalls && !p.isRiichi && state.wall.remaining > 1) {
      const counts = toCounts34(p.hand);

      if (counts[dk] >= 2) {
        actions.push({ action: "pon", tile: dLabel });
      }

      if (counts[dk] === 3 && state.wall.kanCount < 4) {
        actions.push({ action: "daiminkan", tile: dLabel });
      }

      const isShimocha = seatIndex === (last.playerIndex + 1) % 4;
      if (isShimocha) {
        const chiPairs = getChiOptions(p.hand, last.tileId, red);
        for (const pair of chiPairs) {
          actions.push({ action: "chi", tile: dLabel, consume: pair });
        }
      }
    }

    actions.push({ action: "pass", tile: "" });
    return actions;
  }

  return actions;
}

export function applyAction(prevState, seatIndex, actionObj, meta = {}) {
  const state = structuredClone(prevState);
  const p = state.players[seatIndex];
  const n = state.players.length;
  const red = state.config.redDora;

  if (meta.thought !== undefined) p.lastThought = meta.thought;
  if (meta.talk !== undefined) p.lastTalk = meta.talk;

  if (actionObj.action === "tsumo") {
    const isDealer = seatIndex === state.round.dealerIndex;
    const winInfo = evaluateWin({
      handTileIds: p.hand,
      melds: p.melds,
      winTileId: p.drawnTile,
      isTsumo: true,
      isRiichi: p.isRiichi,
      isIppatsu: p.isIppatsu,
      isRinshan: state.turn.isRinshanTurn,
      isDealer,
      seatWind: p.wind,
      roundWind: state.round.wind,
      doraIndicators: state.wall.doraIndicators,
      uraDoraIndicators: state.wall.uraDoraIndicators,
      redDoraEnabled: red
    });

    const riichiBonus = state.round.riichiSticks * 1000;
    const honbaPerPlayer = state.round.honba * 100;
    const deltas = new Array(n).fill(0);
    let totalCollected = 0;

    for (let i = 0; i < n; i++) {
      if (i === seatIndex) continue;
      const basePay =
        i === state.round.dealerIndex
          ? winInfo.tsumoPay.dealerPay
          : winInfo.tsumoPay.childPay;
      const pay = basePay + honbaPerPlayer;
      deltas[i] = -pay;
      state.players[i].points -= pay;
      totalCollected += pay;
    }

    deltas[seatIndex] = totalCollected + riichiBonus;
    state.players[seatIndex].points += deltas[seatIndex];
    state.round.riichiSticks = 0;
    state.status = "round_end";
    state.lastResult = {
      type: "tsumo",
      winners: [{ seatIndex, name: p.name, winInfo, winTileId: p.drawnTile }],
      scoreDeltas: deltas
    };
    state.version += 1;
    state.updatedAt = Date.now();
    return state;
  }

  if (actionObj.action === "ankan" || actionObj.action === "kakan") {
    const targetKind =
      actionObj.kindId !== undefined
        ? actionObj.kindId
        : findTileIdByLabel([...p.hand, p.drawnTile], actionObj.tile, red) >> 2;
    const allHand = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];

    if (actionObj.action === "ankan") {
      const kanTiles = allHand.filter((id) => tileIdToKind(id) === targetKind).slice(0, 4);
      const remain = allHand.filter((id) => !kanTiles.includes(id));
      p.hand = sortTileIds(remain);
      p.drawnTile = null;
      p.melds.push({ type: "ankan", tiles: kanTiles, fromSeat: seatIndex, calledTile: null });
    } else {
      const meld = p.melds.find((m) => m.type === "pon" && tileIdToKind(m.tiles[0]) === targetKind);
      const addTile = allHand.find((id) => tileIdToKind(id) === targetKind);
      const remain = allHand.filter((id) => id !== addTile);
      p.hand = sortTileIds(remain);
      p.drawnTile = null;
      meld.type = "kakan";
      meld.tiles.push(addTile);
    }

    state.players.forEach((pl) => (pl.isIppatsu = false));
    revealNewDora(state);
    return drawRinshanTile(state, seatIndex);
  }

  if (actionObj.action === "discard" || actionObj.action === "riichi") {
    const allHand = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];
    const targetId =
      actionObj.tileId !== undefined
        ? actionObj.tileId
        : findTileIdByLabel(allHand, actionObj.tile, red);

    if (targetId === null || !allHand.includes(targetId)) {
      throw new Error(`Illegal discard tile: ${actionObj.tile}`);
    }

    const isTsumogiri = p.drawnTile !== null && targetId === p.drawnTile;
    const isRiichiDeclare = actionObj.action === "riichi" && !p.isRiichi;

    p.isTempFuriten = false;
    state.turn.isRinshanTurn = false;

    if (isRiichiDeclare) {
      p.isRiichi = true;
      p.riichiTurn = state.turn.turnCount;
      p.isIppatsu = true;
      p.points -= 1000;
      state.round.riichiSticks += 1;
    } else {
      p.isIppatsu = false;
    }

    const remain = [];
    let removed = false;
    for (const x of allHand) {
      if (!removed && x === targetId) {
        removed = true;
        continue;
      }
      remain.push(x);
    }
    p.hand = sortTileIds(remain);
    p.drawnTile = null;
    p.discards.push({
      tileId: targetId,
      isTsumogiri,
      isRiichi: isRiichiDeclare,
      calledBy: null
    });
    p.isFuriten = checkFuriten(p.hand, p.melds, p.discards);

    state.turn.lastDiscard = {
      playerIndex: seatIndex,
      tileId: targetId,
      isTsumogiri,
      isRiichiDeclare
    };

    state.history.push({
      seq: state.history.length + 1,
      roundKey: `${state.round.wind}${state.round.number}-${state.round.honba}`,
      playerIndex: seatIndex,
      action: actionObj.action,
      tileId: targetId,
      isTsumogiri,
      thought: p.lastThought,
      talk: p.lastTalk
    });

    const claimers = [];
    for (let offset = 1; offset < n; offset++) {
      const otherIdx = (seatIndex + offset) % n;
      const tempState = structuredClone(state);
      tempState.turn.phase = "claim_check";
      tempState.turn.pendingClaims = [otherIdx];
      const opts = getLegalActions(tempState, otherIdx);
      if (opts.some((a) => a.action !== "pass")) {
        claimers.push(otherIdx);
      }
    }

    if (claimers.length > 0) {
      state.turn.phase = "claim_check";
      state.turn.pendingClaims = claimers;
      state.turn.claimResponses = {};
      state.version += 1;
      state.updatedAt = Date.now();
      return state;
    }

    return advanceToNextDraw(state, (seatIndex + 1) % n);
  }

  if (["ron", "pon", "daiminkan", "chi", "pass"].includes(actionObj.action)) {
    const hadRonOption = getLegalActions(prevState, seatIndex).some((a) => a.action === "ron");
    if (hadRonOption && actionObj.action !== "ron") {
      p.isTempFuriten = true;
      if (p.isRiichi) p.isRiichiFuriten = true;
    }

    state.turn.claimResponses[seatIndex] = actionObj;
    state.turn.pendingClaims = state.turn.pendingClaims.filter((idx) => idx !== seatIndex);

    if (state.turn.pendingClaims.length > 0) {
      state.version += 1;
      state.updatedAt = Date.now();
      return state;
    }

    const last = state.turn.lastDiscard;
    const loserIdx = last.playerIndex;

    const ronWinners = [];
    for (let offset = 1; offset < n; offset++) {
      const idx = (loserIdx + offset) % n;
      if (state.turn.claimResponses[idx]?.action === "ron") {
        ronWinners.push(idx);
      }
    }

    if (ronWinners.length > 0) {
      const deltas = new Array(n).fill(0);
      const winnersDetail = [];

      ronWinners.forEach((wIdx, order) => {
        const wp = state.players[wIdx];
        const winInfo = evaluateWin({
          handTileIds: wp.hand,
          melds: wp.melds,
          winTileId: last.tileId,
          isTsumo: false,
          isRiichi: wp.isRiichi,
          isIppatsu: wp.isIppatsu,
          isDealer: wIdx === state.round.dealerIndex,
          seatWind: wp.wind,
          roundWind: state.round.wind,
          doraIndicators: state.wall.doraIndicators,
          uraDoraIndicators: state.wall.uraDoraIndicators,
          redDoraEnabled: red
        });
        const riichiBonus = order === 0 ? state.round.riichiSticks * 1000 : 0;
        const honbaBonus = order === 0 ? state.round.honba * 300 : 0;

        deltas[wIdx] += winInfo.points + riichiBonus + honbaBonus;
        deltas[loserIdx] -= winInfo.points + honbaBonus;
        winnersDetail.push({ seatIndex: wIdx, name: wp.name, winInfo, winTileId: last.tileId });
      });

      for (let i = 0; i < n; i++) state.players[i].points += deltas[i];

      state.round.riichiSticks = 0;
      state.status = "round_end";
      state.lastResult = {
        type: "ron",
        winners: winnersDetail,
        loserIndex: loserIdx,
        scoreDeltas: deltas
      };
      state.version += 1;
      state.updatedAt = Date.now();
      return state;
    }

    let ponKanCaller = null;
    for (let offset = 1; offset < n; offset++) {
      const idx = (loserIdx + offset) % n;
      const resp = state.turn.claimResponses[idx];
      if (resp && (resp.action === "pon" || resp.action === "daiminkan")) {
        ponKanCaller = { seatIndex: idx, resp };
        break;
      }
    }

    if (ponKanCaller) {
      return executeCallMeld(state, ponKanCaller.seatIndex, loserIdx, last.tileId, ponKanCaller.resp);
    }

    const shimochaIdx = (loserIdx + 1) % n;
    const chiResp = state.turn.claimResponses[shimochaIdx];
    if (chiResp && chiResp.action === "chi") {
      return executeCallMeld(state, shimochaIdx, loserIdx, last.tileId, chiResp);
    }

    return advanceToNextDraw(state, (loserIdx + 1) % n);
  }

  return state;
}

function executeCallMeld(state, callerIdx, fromSeatIdx, calledTileId, resp) {
  const caller = state.players[callerIdx];
  const fromPlayer = state.players[fromSeatIdx];
  const red = state.config.redDora;
  const dk = tileIdToKind(calledTileId);

  state.players.forEach((pl) => (pl.isIppatsu = false));

  const lastRiverItem = fromPlayer.discards[fromPlayer.discards.length - 1];
  if (lastRiverItem && lastRiverItem.tileId === calledTileId) {
    lastRiverItem.calledBy = callerIdx;
  }

  let consumedIds = [];
  if (resp.action === "pon") {
    consumedIds = caller.hand.filter((id) => tileIdToKind(id) === dk).slice(0, 2);
  } else if (resp.action === "daiminkan") {
    consumedIds = caller.hand.filter((id) => tileIdToKind(id) === dk).slice(0, 3);
  } else if (resp.action === "chi") {
    const consumeLabels = Array.isArray(resp.consume) ? resp.consume : [];
    consumedIds = findMultipleTileIdsByLabels(caller.hand, consumeLabels, red);
    if (!consumedIds || consumedIds.length !== 2) {
      const fallbackPair = getChiOptions(caller.hand, calledTileId, red)[0];
      consumedIds = findMultipleTileIdsByLabels(caller.hand, fallbackPair, red);
    }
  }

  caller.hand = sortTileIds(caller.hand.filter((id) => !consumedIds.includes(id)));
  const meldTiles = sortTileIds([...consumedIds, calledTileId]);
  caller.melds.push({
    type: resp.action,
    tiles: meldTiles,
    fromSeat: fromSeatIdx,
    calledTile: calledTileId
  });
  caller.isFuriten = checkFuriten(caller.hand, caller.melds, caller.discards);

  state.turn.phase = "discard";
  state.turn.playerIndex = callerIdx;
  state.turn.pendingClaims = [];
  state.turn.claimResponses = {};

  if (resp.action === "daiminkan") {
    revealNewDora(state);
    return drawRinshanTile(state, callerIdx);
  }

  caller.drawnTile = null;
  state.turn.isRinshanTurn = false;
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

function revealNewDora(state) {
  state.wall.kanCount += 1;
  const nextIndIdx = 4 + state.wall.kanCount * 2;
  const nextUraIdx = 5 + state.wall.kanCount * 2;
  if (state.wall.dead[nextIndIdx] !== undefined) {
    state.wall.doraIndicators.push(state.wall.dead[nextIndIdx]);
  }
  if (state.wall.dead[nextUraIdx] !== undefined) {
    state.wall.uraDoraIndicators.push(state.wall.dead[nextUraIdx]);
  }
}

function drawRinshanTile(state, seatIndex) {
  const player = state.players[seatIndex];
  const rinshanTile = state.wall.dead.shift();
  player.drawnTile = rinshanTile !== undefined ? rinshanTile : state.wall.live.shift();
  state.wall.remaining = state.wall.live.length;
  state.turn.playerIndex = seatIndex;
  state.turn.phase = "discard";
  state.turn.isRinshanTurn = true;
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

function advanceToNextDraw(state, nextSeatIndex) {
  if (state.wall.live.length === 0) {
    const n = state.players.length;
    const tenpaiSeats = [];
    for (let i = 0; i < n; i++) {
      const p = state.players[i];
      if (calcShanten(toCounts34(p.hand), p.melds.length) === 0) {
        tenpaiSeats.push(i);
      }
    }
    const deltas = new Array(n).fill(0);
    if (tenpaiSeats.length > 0 && tenpaiSeats.length < n) {
      const gain = Math.floor(3000 / tenpaiSeats.length);
      const loss = Math.floor(3000 / (n - tenpaiSeats.length));
      for (let i = 0; i < n; i++) {
        deltas[i] = tenpaiSeats.includes(i) ? gain : -loss;
        state.players[i].points += deltas[i];
      }
    }

    state.status = "round_end";
    state.lastResult = {
      type: "draw",
      winners: [],
      tenpaiSeats,
      scoreDeltas: deltas
    };
    state.version += 1;
    state.updatedAt = Date.now();
    return state;
  }

  const nextPlayer = state.players[nextSeatIndex];
  nextPlayer.drawnTile = state.wall.live.shift();
  state.wall.remaining = state.wall.live.length;

  state.turn.playerIndex = nextSeatIndex;
  state.turn.phase = "discard";
  state.turn.isRinshanTurn = false;
  state.turn.pendingClaims = [];
  state.turn.claimResponses = {};
  if (nextSeatIndex === state.round.dealerIndex) {
    state.turn.turnCount += 1;
  }
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

export function chooseFallbackAction(state, seatIndex) {
  const legal = getLegalActions(state, seatIndex);
  const p = state.players[seatIndex];
  const persona = p.aiConfig?.personaId || "digital_balanced";
  const red = state.config.redDora;

  const tsumo = legal.find((a) => a.action === "tsumo");
  if (tsumo) return tsumo;
  const ron = legal.find((a) => a.action === "ron");
  if (ron) return ron;

  if (state.turn.phase === "claim_check") {
    const passAct = legal.find((a) => a.action === "pass") || legal[0];
    if (persona === "iron_defense") return passAct;

    const currentShanten = calcShanten(toCounts34(p.hand), p.melds.length);
    const last = state.turn.lastDiscard;
    const dk = tileIdToKind(last.tileId);
    const isYakuhai =
      dk >= 31 ||
      (dk === 27 && p.wind === "E") ||
      (dk === 28 && p.wind === "S") ||
      (dk === 29 && p.wind === "W") ||
      (dk === 30 && p.wind === "N");

    const ponAct = legal.find((a) => a.action === "pon");
    if (ponAct) {
      if (isYakuhai) return ponAct;
      if (persona === "aggressive_riichi" && currentShanten <= 2) return ponAct;
      if (persona === "occult_flow" && currentShanten <= 1) return ponAct;
    }

    const chiAct = legal.find((a) => a.action === "chi");
    if (chiAct && (persona === "aggressive_riichi" || persona === "occult_flow") && currentShanten === 1) {
      return chiAct;
    }

    return passAct;
  }

  const visible = [];
  state.players.forEach((pl) => {
    pl.discards.forEach((d) => visible.push(d.tileId));
    pl.melds.forEach((m) => m.tiles.forEach((t) => visible.push(t)));
  });
  state.wall.doraIndicators.forEach((d) => visible.push(d));

  const candidates = analyzeDiscardCandidates(
    p.hand,
    p.drawnTile,
    visible,
    red,
    p.melds.length
  );
  if (candidates.length === 0) return legal[0];

  const riichiOpponents = state.players.filter((pl) => pl.seatIndex !== seatIndex && pl.isRiichi);
  const safeKinds = new Set();
  for (const opp of riichiOpponents) {
    opp.discards.forEach((d) => safeKinds.add(tileIdToKind(d.tileId)));
  }

  if (
    riichiOpponents.length > 0 &&
    (persona === "iron_defense" || (persona === "digital_balanced" && candidates[0].shantenAfter >= 2))
  ) {
    const safeCand = candidates.find((c) => safeKinds.has(c.kindId));
    if (safeCand) {
      const dAct = legal.find((a) => a.action === "discard" && a.tile === safeCand.label);
      if (dAct) return dAct;
    }
  }

  const doraKinds = new Set(state.wall.doraIndicators.map(indicatorToDoraKind));
  const scored = candidates.map((c) => {
    let score = -c.shantenAfter * 100 + c.acceptanceCount;
    const isDora = doraKinds.has(c.kindId) || c.label.startsWith("0");

    if (persona === "occult_flow") {
      if (isDora) score -= 45;
    } else if (persona === "iron_defense") {
      if (safeKinds.has(c.kindId)) score -= 18;
    } else if (persona === "aggressive_riichi") {
      score += c.acceptanceCount * 0.5;
    }
    return { cand: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].cand;

  const riichiOpt = legal.find((a) => a.action === "riichi" && a.tile === best.label);
  if (riichiOpt) {
    if (persona === "iron_defense" && riichiOpponents.length > 0 && best.acceptanceCount <= 3) {
      // 守備派は追っかけ愚形リーチをダマに構える
    } else {
      return riichiOpt;
    }
  }

  const discardOpt = legal.find((a) => a.action === "discard" && a.tile === best.label);
  return discardOpt || legal[0];
}
