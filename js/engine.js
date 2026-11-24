/**
 * engine.js
 * 4人麻雀（半荘戦・チー/ポン/大明槓/暗槓/加槓/嶺上開花/カンドラ完全対応）ゲームエンジン
 */

import {
  tileIdToKind,
  tileIdToLabel,
  kindToLabel,
  sortTileIds,
  toCounts34,
  findTileIdByLabel
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
    rinshanIndex: 0,
    doraIndicators: [dead[4]],
    uraDoraIndicators: [dead[5]],
    remaining: shuffled.length
  };
}

export function createMatchState(options = {}) {
  const defaultPlayers = [
    { id: "p0", name: "あなた", control: "human", aiConfig: null },
    {
      id: "p1",
      name: "下家AI",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", personaId: "digital_balanced", customPrompt: "", apiKey: "" }
    },
    {
      id: "p2",
      name: "対面AI",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", personaId: "aggressive_riichi", customPrompt: "", apiKey: "" }
    },
    {
      id: "p3",
      name: "上家AI",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", personaId: "iron_defense", customPrompt: "", apiKey: "" }
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
      lastDiscard: null,
      pendingClaims: [],
      claimResponses: {},
      afterKan: false
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
    lastDiscard: null,
    pendingClaims: [],
    claimResponses: {},
    afterKan: false
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

function getChiOptions(handTileIds, calledTileId, red) {
  const k = tileIdToKind(calledTileId);
  if (k >= 27) return [];
  const n = k % 9;
  const patterns = [];
  if (n >= 2) patterns.push([k - 2, k - 1]);
  if (n >= 1 && n <= 7) patterns.push([k - 1, k + 1]);
  if (n <= 6) patterns.push([k + 1, k + 2]);

  const options = [];
  for (const [k1, k2] of patterns) {
    const t1 = handTileIds.find((id) => tileIdToKind(id) === k1);
    const t2 = handTileIds.find((id) => tileIdToKind(id) === k2 && id !== t1);
    if (t1 !== undefined && t2 !== undefined) {
      const sorted = sortTileIds([t1, t2, calledTileId]);
      options.push({
        consumeTileIds: [t1, t2],
        meldTileIds: sorted,
        label: sorted.map((id) => tileIdToLabel(id, red)).join("")
      });
    }
  }
  return options;
}

export function getLegalActions(state, seatIndex) {
  const actions = [];
  if (state.status !== "playing") return actions;

  const p = state.players[seatIndex];
  const red = state.config.redDora;
  const totalKans = state.players.reduce(
    (sum, pl) => sum + pl.melds.filter((m) => m.type.includes("kan")).length,
    0
  );

  // 1. 自摸後の打牌・ツモ和了・暗槓・加槓フェーズ
  if (state.turn.phase === "discard" && state.turn.playerIndex === seatIndex) {
    if (p.drawnTile !== null) {
      const winCheck = evaluateWin({
        handTileIds: p.hand,
        winTileId: p.drawnTile,
        melds: p.melds,
        isTsumo: true,
        isRiichi: p.isRiichi,
        isIppatsu: p.isIppatsu,
        isDealer: seatIndex === state.round.dealerIndex,
        seatWind: p.wind,
        roundWind: state.round.wind,
        doraIndicators: state.wall.doraIndicators,
        uraDoraIndicators: state.wall.uraDoraIndicators,
        redDoraEnabled: red
      });
      if (winCheck) {
        if (state.turn.afterKan) {
          winCheck.yakus.push({ name: "嶺上開花", han: 1 });
        }
        actions.push({ action: "tsumo", tile: tileIdToLabel(p.drawnTile, red), winInfo: winCheck });
      }
    }

    const allClosed = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];

    // 暗槓・加槓判定
    if (state.config.allowCalls && totalKans < 4 && state.wall.remaining >= 2 && p.drawnTile !== null) {
      const counts = toCounts34(allClosed);
      for (let k = 0; k < 34; k++) {
        if (counts[k] === 4) {
          if (!p.isRiichi || tileIdToKind(p.drawnTile) === k) {
            const kanTiles = allClosed.filter((id) => tileIdToKind(id) === k);
            actions.push({
              action: "ankan",
              tile: kindToLabel(k),
              consumeTileIds: kanTiles
            });
          }
        }
      }
      if (!p.isRiichi) {
        for (const m of p.melds) {
          if (m.type === "pon") {
            const ponKind = tileIdToKind(m.tiles[0]);
            const addTile = allClosed.find((id) => tileIdToKind(id) === ponKind);
            if (addTile !== undefined) {
              actions.push({
                action: "kakan",
                tile: tileIdToLabel(addTile, red),
                consumeTileIds: [addTile]
              });
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
    const isMenzen = p.melds.every((m) => m.type === "ankan");

    for (const tid of allClosed) {
      const label = tileIdToLabel(tid, red);
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);

      actions.push({ action: "discard", tile: label, tileId: tid });

      if (
        isMenzen &&
        p.points >= 1000 &&
        state.wall.remaining >= 4
      ) {
        const remain = [];
        let removed = false;
        for (const x of allClosed) {
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

  // 2. 他家打牌に対するロン・ポン・大明槓・チー判定フェーズ
  if (state.turn.phase === "claim_check" && state.turn.pendingClaims.includes(seatIndex)) {
    const last = state.turn.lastDiscard;
    if (!last) return actions;

    const calledLabel = tileIdToLabel(last.tileId, red);
    const calledKind = tileIdToKind(last.tileId);
    const isAnyFuriten = p.isFuriten || p.isTempFuriten || p.isRiichiFuriten;

    if (!isAnyFuriten) {
      const ronCheck = evaluateWin({
        handTileIds: p.hand,
        winTileId: last.tileId,
        melds: p.melds,
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
        actions.push({ action: "ron", tile: calledLabel, winInfo: ronCheck });
      }
    }

    if (state.config.allowCalls && !p.isRiichi && state.wall.remaining >= 2) {
      const sameTiles = p.hand.filter((id) => tileIdToKind(id) === calledKind);
      if (sameTiles.length >= 2) {
        actions.push({
          action: "pon",
          tile: calledLabel,
          consumeTileIds: sameTiles.slice(0, 2)
        });
      }
      if (sameTiles.length >= 3 && totalKans < 4) {
        actions.push({
          action: "minkan",
          tile: calledLabel,
          consumeTileIds: sameTiles.slice(0, 3)
        });
      }
      const isShimocha = (last.playerIndex + 1) % 4 === seatIndex;
      if (isShimocha) {
        const chiOpts = getChiOptions(p.hand, last.tileId, red);
        for (const opt of chiOpts) {
          actions.push({
            action: "chi",
            tile: calledLabel,
            chiLabel: opt.label,
            consumeTileIds: opt.consumeTileIds
          });
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

  // A. ツモ和了
  if (actionObj.action === "tsumo") {
    const isDealer = seatIndex === state.round.dealerIndex;
    const winInfo = evaluateWin({
      handTileIds: p.hand,
      winTileId: p.drawnTile,
      melds: p.melds,
      isTsumo: true,
      isRiichi: p.isRiichi,
      isIppatsu: p.isIppatsu,
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

  // A-2. 暗槓・加槓
  if (actionObj.action === "ankan" || actionObj.action === "kakan") {
    const allClosed = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];
    const consumeSet = new Set(actionObj.consumeTileIds);
    p.hand = sortTileIds(allClosed.filter((id) => !consumeSet.has(id)));
    p.drawnTile = null;

    if (actionObj.action === "ankan") {
      p.melds.push({
        type: "ankan",
        tiles: sortTileIds(actionObj.consumeTileIds),
        fromSeat: seatIndex,
        calledTile: null
      });
    } else {
      const addId = actionObj.consumeTileIds[0];
      const targetKind = tileIdToKind(addId);
      const targetMeld = p.melds.find((m) => m.type === "pon" && tileIdToKind(m.tiles[0]) === targetKind);
      if (targetMeld) {
        targetMeld.type = "kakan";
        targetMeld.tiles.push(addId);
      }
    }

    state.players.forEach((pl) => (pl.isIppatsu = false));
    revealNewDora(state);
    drawRinshanTile(state, seatIndex);
    state.version += 1;
    state.updatedAt = Date.now();
    return state;
  }

  // B. 打牌・リーチ宣言
  if (actionObj.action === "discard" || actionObj.action === "riichi") {
    const allClosed = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];
    const targetId =
      actionObj.tileId !== undefined
        ? actionObj.tileId
        : findTileIdByLabel(allClosed, actionObj.tile, red);

    if (targetId === null || !allClosed.includes(targetId)) {
      throw new Error(`Illegal discard tile: ${actionObj.tile}`);
    }

    const isTsumogiri = p.drawnTile !== null && targetId === p.drawnTile;
    const isRiichiDeclare = actionObj.action === "riichi" && !p.isRiichi;

    p.isTempFuriten = false;
    state.turn.afterKan = false;

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
    for (const x of allClosed) {
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
    p.isFuriten = checkFuriten(p.hand, p.discards, p.melds);

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

    // 他家のロン・鳴き（ポン・大明槓・チー）対象者を収集
    const claimers = [];
    for (let offset = 1; offset < n; offset++) {
      const otherIdx = (seatIndex + offset) % n;
      const other = state.players[otherIdx];
      let hasClaim = false;

      const isAnyFuriten = other.isFuriten || other.isTempFuriten || other.isRiichiFuriten;
      if (!isAnyFuriten) {
        const ronCheck = evaluateWin({
          handTileIds: other.hand,
          winTileId: targetId,
          melds: other.melds,
          isTsumo: false,
          isRiichi: other.isRiichi,
          isIppatsu: other.isIppatsu,
          isDealer: otherIdx === state.round.dealerIndex,
          seatWind: other.wind,
          roundWind: state.round.wind,
          doraIndicators: state.wall.doraIndicators,
          uraDoraIndicators: state.wall.uraDoraIndicators,
          redDoraEnabled: red
        });
        if (ronCheck) hasClaim = true;
      }

      if (state.config.allowCalls && !other.isRiichi && state.wall.remaining >= 2) {
        const calledKind = tileIdToKind(targetId);
        const sameCnt = other.hand.filter((id) => tileIdToKind(id) === calledKind).length;
        if (sameCnt >= 2) hasClaim = true;
        if (offset === 1 && getChiOptions(other.hand, targetId, red).length > 0) {
          hasClaim = true;
        }
      }

      if (hasClaim) claimers.push(otherIdx);
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

  // C. 他家打牌への応答（ロン / ポン / 大明槓 / チー / パス）
  if (["ron", "pon", "minkan", "chi", "pass"].includes(actionObj.action)) {
    if (actionObj.action === "pass") {
      // ロン可能だったのを見逃した場合は同巡フリテン
      const wasRonLegal = getLegalActions(prevState, seatIndex).some((a) => a.action === "ron");
      if (wasRonLegal) {
        p.isTempFuriten = true;
        if (p.isRiichi) p.isRiichiFuriten = true;
      }
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

    // 優先度1: ロン（ダブロン・トリロン対応）
    const ronWinners = [];
    for (let offset = 1; offset < n; offset++) {
      const idx = (loserIdx + offset) % n;
      const resp = state.turn.claimResponses[idx];
      if (resp && resp.action === "ron") ronWinners.push(idx);
    }

    if (ronWinners.length > 0) {
      const deltas = new Array(n).fill(0);
      const winnersDetail = [];

      ronWinners.forEach((wIdx, order) => {
        const wp = state.players[wIdx];
        const winInfo = evaluateWin({
          handTileIds: wp.hand,
          winTileId: last.tileId,
          melds: wp.melds,
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

    // 優先度2: ポン・大明槓
    let callerIdx = null;
    let callAct = null;
    for (let offset = 1; offset < n; offset++) {
      const idx = (loserIdx + offset) % n;
      const resp = state.turn.claimResponses[idx];
      if (resp && (resp.action === "pon" || resp.action === "minkan")) {
        callerIdx = idx;
        callAct = resp;
        break;
      }
    }

    // 優先度3: チー
    if (!callAct) {
      const shimoIdx = (loserIdx + 1) % n;
      const resp = state.turn.claimResponses[shimoIdx];
      if (resp && resp.action === "chi") {
        callerIdx = shimoIdx;
        callAct = resp;
      }
    }

    if (callAct && callerIdx !== null) {
      const caller = state.players[callerIdx];
      const consumeSet = new Set(callAct.consumeTileIds);
      caller.hand = sortTileIds(caller.hand.filter((id) => !consumeSet.has(id)));
      caller.melds.push({
        type: callAct.action,
        tiles: [...callAct.consumeTileIds, last.tileId],
        fromSeat: loserIdx,
        calledTile: last.tileId
      });

      const loserDiscards = state.players[loserIdx].discards;
      if (loserDiscards.length > 0) {
        loserDiscards[loserDiscards.length - 1].calledBy = callerIdx;
      }

      state.players.forEach((pl) => (pl.isIppatsu = false));
      state.turn.pendingClaims = [];
      state.turn.claimResponses = {};

      if (callAct.action === "minkan") {
        revealNewDora(state);
        drawRinshanTile(state, callerIdx);
      } else {
        state.turn.playerIndex = callerIdx;
        state.turn.phase = "discard";
        state.turn.afterKan = false;
      }

      state.version += 1;
      state.updatedAt = Date.now();
      return state;
    }

    return advanceToNextDraw(state, (loserIdx + 1) % n);
  }

  return state;
}

function revealNewDora(state) {
  const kanCount = state.wall.doraIndicators.length;
  if (kanCount < 5) {
    const doraIdx = 4 + kanCount * 2;
    const uraIdx = 5 + kanCount * 2;
    if (state.wall.dead[doraIdx] !== undefined) {
      state.wall.doraIndicators.push(state.wall.dead[doraIdx]);
    }
    if (state.wall.dead[uraIdx] !== undefined) {
      state.wall.uraDoraIndicators.push(state.wall.dead[uraIdx]);
    }
  }
}

function drawRinshanTile(state, seatIndex) {
  const p = state.players[seatIndex];
  const rinshanTile = state.wall.dead[state.wall.rinshanIndex] ?? state.wall.live.shift();
  state.wall.rinshanIndex += 1;
  if (state.wall.live.length > 0) {
    state.wall.live.pop();
  }
  state.wall.remaining = state.wall.live.length;
  p.drawnTile = rinshanTile;
  state.turn.playerIndex = seatIndex;
  state.turn.phase = "discard";
  state.turn.afterKan = true;
}

function advanceToNextDraw(state, nextSeatIndex) {
  if (state.wall.live.length === 0) {
    const n = state.players.length;
    const tenpaiSeats = [];
    for (let i = 0; i < n; i++) {
      const pl = state.players[i];
      if (calcShanten(toCounts34(pl.hand), pl.melds.length) === 0) {
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
  state.turn.pendingClaims = [];
  state.turn.claimResponses = {};
  state.turn.afterKan = false;
  if (nextSeatIndex === state.round.dealerIndex) {
    state.turn.turnCount += 1;
  }
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

export function chooseFallbackAction(state, seatIndex) {
  const legal = getLegalActions(state, seatIndex);
  const tsumo = legal.find((a) => a.action === "tsumo");
  if (tsumo) return tsumo;

  const ron = legal.find((a) => a.action === "ron");
  if (ron) return ron;

  if (state.turn.phase === "claim_check") {
    const p = state.players[seatIndex];
    const beforeShanten = calcShanten(toCounts34(p.hand), p.melds.length);
    const ponAct = legal.find((a) => a.action === "pon");
    if (ponAct) {
      const remain = p.hand.filter((id) => !ponAct.consumeTileIds.includes(id));
      const afterShanten = calcShanten(toCounts34(remain), p.melds.length + 1);
      if (afterShanten < beforeShanten) return ponAct;
    }
    const chiAct = legal.find((a) => a.action === "chi");
    if (chiAct && beforeShanten <= 1) {
      const remain = p.hand.filter((id) => !chiAct.consumeTileIds.includes(id));
      const afterShanten = calcShanten(toCounts34(remain), p.melds.length + 1);
      if (afterShanten < beforeShanten) return chiAct;
    }
    return legal.find((a) => a.action === "pass") || legal[0];
  }

  const p = state.players[seatIndex];
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
    state.config.redDora,
    p.melds.length
  );
  const best = candidates[0];
  if (!best) return legal[0];

  const riichiOpt = legal.find((a) => a.action === "riichi" && a.tile === best.label);
  if (riichiOpt) return riichiOpt;

  const discardOpt = legal.find((a) => a.action === "discard" && a.tile === best.label);
  return discardOpt || legal[0];
}
