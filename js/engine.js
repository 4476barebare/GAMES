/**
 * engine.js
 * gameState の初期化・合法手生成・アクション適用（純粋関数設計・2人/4人拡張互換）
 */

import {
  tileIdToKind,
  tileIdToLabel,
  sortTileIds,
  toCounts34,
  findTileIdByLabel
} from "./tiles.js";
import { calcShanten, analyzeDiscardCandidates } from "./shanten.js";
import { evaluateWin, checkFuriten } from "./score.js";

const WINDS = ["E", "S", "W", "N"];

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildWall(tileSet) {
  const ids = [];
  for (let id = 0; id < 136; id++) {
    if (tileSet === "2p_compact") {
      const k = tileIdToKind(id);
      if (k >= 1 && k <= 7) continue; // 2m..8m を除外
    }
    ids.push(id);
  }
  const shuffled = shuffle(ids);
  const dead = shuffled.splice(0, 14); // 王牌14枚
  return {
    live: shuffled,
    dead,
    doraIndicators: [dead[4]],
    uraDoraIndicators: [dead[5]],
    remaining: shuffled.length
  };
}

/**
 * 新規マッチの初期 gameState を生成（players配列長により2人/4人自動対応）
 */
export function createMatchState(options = {}) {
  const mode = options.mode || "2p";
  const maxPlayers = mode === "4p" ? 4 : 2;
  const playerConfigs = options.players || [
    { id: "p0", name: "あなた", control: "human", aiConfig: null },
    {
      id: "p1",
      name: "Gemini",
      control: "ai",
      aiConfig: {
        provider: "gemini",
        model: "gemini-4-hydrogen",
        personaId: "digital_balanced",
        customPrompt: ""
      }
    }
  ];

  const players = [];
  for (let i = 0; i < maxPlayers; i++) {
    const cfg = playerConfigs[i] || {
      id: `p${i}`,
      name: `AI-${i + 1}`,
      control: "ai",
      aiConfig: { provider: "gemini", model: "gemini-4-hydrogen", personaId: "digital_balanced", customPrompt: "" }
    };
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
      lastThought: "",
      lastTalk: ""
    });
  }

  const state = {
    schemaVersion: "1.0",
    roomId: options.roomId || null,
    version: 1,
    updatedAt: Date.now(),
    status: "playing",
    config: {
      mode,
      maxPlayers,
      roundType: "east",
      tileSet: options.tileSet || "full136",
      redDora: options.redDora !== false,
      openTanyao: true,
      allowCalls: false,
      initialPoints: options.initialPoints || 25000
    },
    round: {
      wind: "E",
      number: 1,
      honba: 0,
      riichiSticks: 0,
      dealerIndex: 0
    },
    turn: {
      playerIndex: 0,
      phase: "discard",
      turnCount: 1,
      lastDiscard: null,
      pendingClaims: []
    },
    wall: null,
    players,
    lastResult: null,
    history: []
  };

  return startNewRound(state, 0, false);
}

/**
 * 新しい局（配牌＋親の第一ツモ）を開始する
 */
export function startNewRound(prevState, dealerIndex = 0, keepHonba = false) {
  const state = structuredClone(prevState);
  const n = state.players.length;

  state.wall = buildWall(state.config.tileSet);
  state.status = "playing";
  state.lastResult = null;
  state.round.dealerIndex = dealerIndex;
  if (!keepHonba) {
    // 親流れ時は局進行
    if (prevState.lastResult) {
      state.round.number += 1;
      state.round.honba = 0;
    }
  } else {
    state.round.honba += 1;
  }

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
    p.lastThought = "";
    p.lastTalk = "";
  }

  // 親の第一ツモ
  const dealer = state.players[dealerIndex];
  dealer.drawnTile = state.wall.live.shift();
  state.wall.remaining = state.wall.live.length;

  state.turn = {
    playerIndex: dealerIndex,
    phase: "discard",
    turnCount: 1,
    lastDiscard: null,
    pendingClaims: []
  };
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

/**
 * 指定座席の現在フェーズにおける合法アクション一覧を返す
 */
export function getLegalActions(state, seatIndex) {
  const actions = [];
  if (state.status !== "playing") return actions;

  const p = state.players[seatIndex];
  const red = state.config.redDora;

  // 1. 自分の打牌フェーズ
  if (state.turn.phase === "discard" && state.turn.playerIndex === seatIndex) {
    // ツモ和了チェック
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

    // リーチ中はツモ切りのみ合法
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

    // 通常打牌＆リーチ宣言候補
    const all14 = p.drawnTile !== null ? [...p.hand, p.drawnTile] : [...p.hand];
    const seenLabels = new Set();

    for (const tid of all14) {
      const label = tileIdToLabel(tid, red);
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);

      actions.push({ action: "discard", tile: label, tileId: tid });

      // リーチ宣言可否（門前・持ち点1000以上・残り山4枚以上・切った後シャンテン0）
      if (
        p.melds.length === 0 &&
        p.points >= 1000 &&
        state.wall.remaining >= state.players.length
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
    if (last && !p.isFuriten) {
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

/**
 * アクションを盤面に適用し、新しい gameState を返す
 */
export function applyAction(prevState, seatIndex, actionObj, meta = {}) {
  const state = structuredClone(prevState);
  const p = state.players[seatIndex];
  const n = state.players.length;
  const red = state.config.redDora;

  if (meta.thought !== undefined) p.lastThought = meta.thought;
  if (meta.talk !== undefined) p.lastTalk = meta.talk;

  // A. ツモ和了
  if (actionObj.action === "tsumo") {
    const winInfo = evaluateWin({
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
    const bonus = state.round.riichiSticks * 1000 + state.round.honba * 300;
    const totalGain = winInfo.points + bonus;
    const deltas = new Array(n).fill(0);
    const share = Math.ceil(winInfo.points / (n - 1) / 100) * 100;

    for (let i = 0; i < n; i++) {
      if (i === seatIndex) {
        deltas[i] = totalGain;
        state.players[i].points += totalGain;
      } else {
        const loss = share + Math.floor((state.round.honba * 300) / (n - 1));
        deltas[i] = -loss;
        state.players[i].points -= loss;
      }
    }

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

  // B. 打牌 または リーチ宣言
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

    if (isRiichiDeclare) {
      p.isRiichi = true;
      p.riichiTurn = state.turn.turnCount;
      p.isIppatsu = true;
      p.points -= 1000;
      state.round.riichiSticks += 1;
    } else {
      p.isIppatsu = false;
    }

    // 手牌から対象牌を除去して理牌
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

    // 他家にロン可能なプレイヤーがいるかチェック
    const ronClaimers = [];
    for (let offset = 1; offset < n; offset++) {
      const otherIdx = (seatIndex + offset) % n;
      const other = state.players[otherIdx];
      if (other.isFuriten) continue;
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
      state.version += 1;
      state.updatedAt = Date.now();
      return state;
    }

    return advanceToNextDraw(state, (seatIndex + 1) % n);
  }

  // C. ロン和了
  if (actionObj.action === "ron") {
    const last = state.turn.lastDiscard;
    const loserIdx = last.playerIndex;
    const winInfo = evaluateWin({
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

    const bonus = state.round.riichiSticks * 1000 + state.round.honba * 300;
    const deltas = new Array(n).fill(0);
    deltas[seatIndex] = winInfo.points + bonus;
    deltas[loserIdx] = -(winInfo.points + state.round.honba * 300);

    state.players[seatIndex].points += deltas[seatIndex];
    state.players[loserIdx].points += deltas[loserIdx];
    state.round.riichiSticks = 0;
    state.status = "round_end";
    state.lastResult = {
      type: "ron",
      winners: [{ seatIndex, name: p.name, winInfo, winTileId: last.tileId }],
      loserIndex: loserIdx,
      scoreDeltas: deltas
    };
    state.version += 1;
    state.updatedAt = Date.now();
    return state;
  }

  // D. ロン見送り（パス）
  if (actionObj.action === "pass") {
    state.turn.pendingClaims = state.turn.pendingClaims.filter((idx) => idx !== seatIndex);
    if (state.turn.pendingClaims.length === 0) {
      const nextSeat = (state.turn.lastDiscard.playerIndex + 1) % n;
      return advanceToNextDraw(state, nextSeat);
    }
    state.version += 1;
    state.updatedAt = Date.now();
    return state;
  }

  return state;
}

/**
 * 次の手番プレイヤーのツモ処理（山切れなら流局）
 */
function advanceToNextDraw(state, nextSeatIndex) {
  if (state.wall.live.length === 0) {
    // 荒牌流局＆ノーテン罰符精算
    const n = state.players.length;
    const tenpaiSeats = [];
    for (let i = 0; i < n; i++) {
      if (calcShanten(toCounts34(state.players[i].hand), 0) === 0) {
        tenpaiSeats.push(i);
      }
    }
    const deltas = new Array(n).fill(0);
    const totalPool = n === 2 ? 1000 : 3000;
    if (tenpaiSeats.length > 0 && tenpaiSeats.length < n) {
      const gain = Math.floor(totalPool / tenpaiSeats.length);
      const loss = Math.floor(totalPool / (n - tenpaiSeats.length));
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
  if (nextSeatIndex === state.round.dealerIndex) {
    state.turn.turnCount += 1;
  }
  state.version += 1;
  state.updatedAt = Date.now();
  return state;
}

/**
 * APIキー未入力・エラー時の内蔵ルールベースAIフォールバック選択
 */
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
