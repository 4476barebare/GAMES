/**
 * engine.js
 * 4人麻雀（半荘戦）ゲームエンジン・半荘進行・飛び判定・最終精算（ウマ10-30 / オカ+20）
 */

import {
  tileIdToLabel,
  sortTileIds,
  toCounts34,
  findTileIdByLabel
} from "./tiles.js";
import { calcShanten, analyzeDiscardCandidates } from "./shanten.js";
import { evaluateWin, checkFuriten } from "./score.js";

const WINDS = ["E", "S", "W", "N"];
const UMA_TABLE = [30, 10, -10, -30]; // 10-30（ワンスリー）
const OKA_BONUS = 20; // 25,000点持ち・30,000点返し
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
      aiConfig: { provider: "gemini", model: "builtin", personaId: "digital_balanced", customPrompt: "" }
    },
    {
      id: "p2",
      name: "対面AI",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", personaId: "aggressive_riichi", customPrompt: "" }
    },
    {
      id: "p3",
      name: "上家AI",
      control: "ai",
      aiConfig: { provider: "gemini", model: "builtin", personaId: "iron_defense", customPrompt: "" }
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
    schemaVersion: "1.1",
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
      allowCalls: false,
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

/**
 * 現在の round 情報に従って配牌と親の第一ツモを行う
 */
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
    claimResponses: {}
  };
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

/**
 * 局結果を受けて次の局へ進むか、半荘終了（最終精算）へ遷移する
 */
export function advanceNextRoundOrFinish(prevState) {
  const state = structuredClone(prevState);
  const res = state.lastResult;
  if (!res) return state;

  // 1. 飛び終了チェック（持ち点0未満のプレイヤーが存在）
  const bustedPlayer = state.players.find((p) => p.points < 0);
  if (bustedPlayer) {
    return finalizeHanchan(state, `${bustedPlayer.name} の飛び（トビ）により半荘終了`);
  }

  const dealerIdx = state.round.dealerIndex;
  const isAllLast = state.round.wind === "S" && state.round.number === 4;

  // 連荘判定
  let dealerContinues = false;
  let nextHonba = state.round.honba;

  if (res.type === "tsumo" || res.type === "ron") {
    const dealerWon = res.winners.some((w) => w.seatIndex === dealerIdx);
    if (dealerWon) {
      // オーラスで親がトップなら上がりやめ
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
      // オーラスで親がノーテン罰符込みでトップなら聴牌やめ
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

  // 親流れ：オーラスなら半荘終了
  if (isAllLast) {
    return finalizeHanchan(state, "南4局（オーラス）終了により半荘完結");
  }

  // 局を1つ進める
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
    if (p.points === targetPts && p.seatIndex < seatIndex) return false; // 起家優先
  }
  return true;
}

/**
 * 半荘終了・最終精算（残供託トップ総取り＋ウマ10-30＋オカ+20）
 */
function finalizeHanchan(state, reason) {
  // 順位ソート（持ち点降順、同点は起家＝seatIndex昇順）
  const ranked = [...state.players].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return a.seatIndex - b.seatIndex;
  });

  // 残っている供託リーチ棒はトップが総取り
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

export function getLegalActions(state, seatIndex) {
  const actions = [];
  if (state.status !== "playing") return actions;

  const p = state.players[seatIndex];
  const red = state.config.redDora;

  // 1. 自分の打牌フェーズ
  if (state.turn.phase === "discard" && state.turn.playerIndex === seatIndex) {
    if (p.drawnTile !== null) {
      const winCheck = evaluateWin({
        handTileIds: p.hand,
        winTileId: p.drawnTile,
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
        actions.push({ action: "tsumo", tile: tileIdToLabel(p.drawnTile, red), winInfo: winCheck });
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

    const all14 = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];
    const seenLabels = new Set();

    for (const tid of all14) {
      const label = tileIdToLabel(tid, red);
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);

      actions.push({ action: "discard", tile: label, tileId: tid });

      if (
        p.melds.length === 0 &&
        p.points >= 1000 &&
        state.wall.remaining >= 4
      ) {
        const remain13 = [];
        let removed = false;
        for (const x of all14) {
          if (!removed && x === tid) {
            removed = true;
            continue;
          }
          remain13.push(x);
        }
        if (calcShanten(toCounts34(remain13), 0) === 0) {
          actions.push({ action: "riichi", tile: label, tileId: tid });
        }
      }
    }
    return actions;
  }

  // 2. 他家の打牌に対するロン判定フェーズ
  if (state.turn.phase === "claim_check" && state.turn.pendingClaims.includes(seatIndex)) {
    const last = state.turn.lastDiscard;
    const isAnyFuriten = p.isFuriten || p.isTempFuriten || p.isRiichiFuriten;
    if (last && !isAnyFuriten) {
      const ronCheck = evaluateWin({
        handTileIds: p.hand,
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
        actions.push({ action: "ron", tile: tileIdToLabel(last.tileId, red), winInfo: ronCheck });
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

  // A. ツモ和了（4人打ちの正確な親子支払い計算）
  if (actionObj.action === "tsumo") {
    const isDealer = seatIndex === state.round.dealerIndex;
    const winInfo = evaluateWin({
      handTileIds: p.hand,
      winTileId: p.drawnTile,
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

  // B. 打牌・リーチ宣言
  if (actionObj.action === "discard" || actionObj.action === "riichi") {
    const all14 = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];
    const targetId =
      actionObj.tileId !== undefined
        ? actionObj.tileId
        : findTileIdByLabel(all14, actionObj.tile, red);

    if (targetId === null || !all14.includes(targetId)) {
      throw new Error(`Illegal discard tile: ${actionObj.tile}`);
    }

    const isTsumogiri = p.drawnTile !== null && targetId === p.drawnTile;
    const isRiichiDeclare = actionObj.action === "riichi" && !p.isRiichi;

    // 自分の打牌により同巡内フリテンは解除
    p.isTempFuriten = false;

    if (isRiichiDeclare) {
      p.isRiichi = true;
      p.riichiTurn = state.turn.turnCount;
      p.isIppatsu = true;
      p.points -= 1000;
      state.round.riichiSticks += 1;
    } else {
      p.isIppatsu = false;
    }

    const remain13 = [];
    let removed = false;
    for (const x of all14) {
      if (!removed && x === targetId) {
        removed = true;
        continue;
      }
      remain13.push(x);
    }
    p.hand = sortTileIds(remain13);
    p.drawnTile = null;
    p.discards.push({
      tileId: targetId,
      isTsumogiri,
      isRiichi: isRiichiDeclare,
      calledBy: null
    });
    p.isFuriten = checkFuriten(p.hand, p.discards);

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

    // 他家（上家優先順）にロン可能なプレイヤーがいるか判定
    const ronClaimers = [];
    for (let offset = 1; offset < n; offset++) {
      const otherIdx = (seatIndex + offset) % n;
      const other = state.players[otherIdx];
      if (other.isFuriten || other.isTempFuriten || other.isRiichiFuriten) continue;
      const ronCheck = evaluateWin({
        handTileIds: other.hand,
        winTileId: targetId,
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
      if (ronCheck) ronClaimers.push(otherIdx);
    }

    if (ronClaimers.length > 0) {
      state.turn.phase = "claim_check";
      state.turn.pendingClaims = ronClaimers;
      state.turn.claimResponses = {};
      state.version += 1;
      state.updatedAt = Date.now();
      return state;
    }

    return advanceToNextDraw(state, (seatIndex + 1) % n);
  }

  // C. ロン / パス応答（複数人ダブロン・トリロン対応）
  if (actionObj.action === "ron" || actionObj.action === "pass") {
    if (actionObj.action === "pass") {
      // 見逃しによるフリテン付与
      p.isTempFuriten = true;
      if (p.isRiichi) p.isRiichiFuriten = true;
    }

    state.turn.claimResponses[seatIndex] = actionObj.action;
    state.turn.pendingClaims = state.turn.pendingClaims.filter((idx) => idx !== seatIndex);

    // まだ応答待ちの他家がいる場合は継続
    if (state.turn.pendingClaims.length > 0) {
      state.version += 1;
      state.updatedAt = Date.now();
      return state;
    }

    // 全員の応答が揃った：放銃者から上家順にロン宣言者を並べる
    const last = state.turn.lastDiscard;
    const loserIdx = last.playerIndex;
    const ronWinners = [];
    for (let offset = 1; offset < n; offset++) {
      const idx = (loserIdx + offset) % n;
      if (state.turn.claimResponses[idx] === "ron") {
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
        // 供託・本場は頭ハネ（放銃者から最も近い上家のみ取得）
        const riichiBonus = order === 0 ? state.round.riichiSticks * 1000 : 0;
        const honbaBonus = order === 0 ? state.round.honba * 300 : 0;

        deltas[wIdx] += winInfo.points + riichiBonus + honbaBonus;
        deltas[loserIdx] -= winInfo.points + honbaBonus;
        winnersDetail.push({ seatIndex: wIdx, name: wp.name, winInfo, winTileId: last.tileId });
      });

      for (let i = 0; i < n; i++) {
        state.players[i].points += deltas[i];
      }

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

    // 全員パス → 次の人のツモへ
    return advanceToNextDraw(state, (loserIdx + 1) % n);
  }

  return state;
}

function advanceToNextDraw(state, nextSeatIndex) {
  if (state.wall.live.length === 0) {
    const n = state.players.length;
    const tenpaiSeats = [];
    for (let i = 0; i < n; i++) {
      if (calcShanten(toCounts34(state.players[i].hand), 0) === 0) {
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

  const p = state.players[seatIndex];
  const visible = [];
  state.players.forEach((pl) => pl.discards.forEach((d) => visible.push(d.tileId)));
  state.wall.doraIndicators.forEach((d) => visible.push(d));

  const candidates = analyzeDiscardCandidates(
    p.hand,
    p.drawnTile,
    visible,
    state.config.redDora
  );
  const best = candidates[0];
  if (!best) return legal[0];

  const riichiOpt = legal.find((a) => a.action === "riichi" && a.tile === best.label);
  if (riichiOpt) return riichiOpt;

  const discardOpt = legal.find((a) => a.action === "discard" && a.tile === best.label);
  return discardOpt || legal[0];
}
