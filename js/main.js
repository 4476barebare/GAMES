/**
 * main.js
 * 4人麻雀（オフライン1人対戦 ＆ GASオンライン対人戦ハイブリッド4人卓）統括
 */

import { tileIdToLabel } from "./tiles.js";
import {
  createMatchState,
  advanceNextRoundOrFinish,
  getLegalActions,
  applyAction
} from "./engine.js";
import { buildTurnPromptMarkdown } from "./markdown.js";
import { decideAiMove } from "./llm.js";
import {
  loadSettings,
  saveSettings,
  getSeatApiKey,
  loadMatchSession,
  clearMatchSession,
  getOrCreateOnlineProfile,
  saveOnlinePlayerName,
  getActiveOnlineRoomId,
  setActiveOnlineRoomId,
  loadCachedOnlineRoom,
  clearCachedOnlineRoom
} from "./storage.js";
import { LocalSyncAdapter, GasSyncAdapter } from "./sync.js";
import {
  renderGame,
  updateSelectedTileHighlight,
  renderLogs,
  showRoundResultModal,
  showMatchEndModal,
  resetAllSpeechBubbles
} from "./ui.js";
import {
  DEFAULT_NPC_PROFILES,
  setNpcProfiles,
  getNpcProfile,
  getNpcProfileForPlayer
} from "./npc.js";

const SEAT_NAMES = ["自席（手前）", "下家（右）", "対面（上）", "上家（左）"];
const POLL_INTERVAL_MS = 2500;

let gameState = null;
let gameLogs = [];
let settings = loadSettings();
let baseRulesMd = "";
let personas = [];
let thinkingSeat = null;
let selectedTileId = null;
let isProcessing = false;
let loopToken = 0;
let suppressNextClickAfterSwipe = false;

const localSync = new LocalSyncAdapter();
const gasSync = new GasSyncAdapter();

// オンライン対戦状態
let isOnlineMode = false;
let currentRoom = null;
let pollTimerId = null;
let isPollingNow = false;
let pendingKickTarget = null;

function getViewerSeat() {
  if (!isOnlineMode || !gameState || !Array.isArray(gameState.players)) return 0;
  const profile = getOrCreateOnlineProfile();
  const idx = gameState.players.findIndex((p) => p.id === profile.playerId);
  return idx >= 0 ? idx : 0;
}

function isOnlineHost() {
  if (!isOnlineMode || !currentRoom) return false;
  const profile = getOrCreateOnlineProfile();
  return currentRoom.hostId === profile.playerId;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function loadExternalAssets() {
  try {
    const [rulesRes, personaRes] = await Promise.all([
      fetch("rules/default.md"),
      fetch("rules/personas.json")
    ]);
    baseRulesMd = await rulesRes.text();
    personas = await personaRes.json();
    setNpcProfiles(personas);
  } catch (e) {
    console.warn("Asset load fallback:", e);
    baseRulesMd = "あなたは4人麻雀プレイヤーです。合法アクション一覧から最適な手をJSONで返してください。";
    personas = DEFAULT_NPC_PROFILES.map((p) => ({ ...p }));
    setNpcProfiles(personas);
  }
}

function getPersonaName(personaId) {
  const found = personas.find((p) => p.id === personaId);
  return found ? found.name : "AI";
}

function getPersonaPrompt(personaId) {
  const found = personas.find((p) => p.id === personaId);
  return found ? found.prompt : "";
}

function pushLog(text) {
  gameLogs.unshift(text);
  if (gameLogs.length > 120) gameLogs.length = 120;
  renderLogs(gameLogs);
}

function buildSeatDisplayName(seatCfg) {
  const profile = getNpcProfile(seatCfg.personaId);
  const hasSeatKey = Boolean((seatCfg.apiKey || "").trim());
  const isBuiltin = seatCfg.model === "builtin" || !hasSeatKey;
  return isBuiltin ? profile.characterName : `${profile.characterName}(AI)`;
}

function updateModeBadgeUI() {
  const badge = document.getElementById("mode-badge");
  const onlineBtn = document.getElementById("btn-online-lobby");
  const newBtn = document.getElementById("btn-new-game");
  if (isOnlineMode && currentRoom) {
    badge.textContent = `ONLINE #${currentRoom.roomId}`;
    badge.classList.add("online-badge");
    onlineBtn.textContent = `部屋 #${currentRoom.roomId}`;
    newBtn.classList.add("hidden");
  } else {
    badge.textContent = "4P半荘";
    badge.classList.remove("online-badge");
    onlineBtn.textContent = "オンライン卓";
    newBtn.classList.remove("hidden");
  }
}

/* ======================== オフラインモード進行 ======================== */

async function startNewOfflineMatch() {
  stopOnlinePolling();
  isOnlineMode = false;
  currentRoom = null;
  setActiveOnlineRoomId("");
  updateModeBadgeUI();

  loopToken += 1;
  isProcessing = false;
  thinkingSeat = null;
  selectedTileId = null;
  resetAllSpeechBubbles();
  clearMatchSession();

  const resModal = document.getElementById("result-modal");
  const endModal = document.getElementById("match-end-modal");
  if (resModal.open) resModal.close();
  if (endModal.open) endModal.close();

  settings = loadSettings();
  gameLogs = [];

  const isAiVsAi = settings.matchMode === "ai_vs_ai";
  const playersCfg = [0, 1, 2, 3].map((idx) => {
    const sCfg = settings.seats[idx];
    if (idx === 0 && !isAiVsAi) {
      return { id: "p0", name: "あなた", control: "human", aiConfig: null };
    }
    return {
      id: `p${idx}`,
      name: buildSeatDisplayName(sCfg),
      control: "ai",
      aiConfig: {
        provider: "gemini",
        model: sCfg.model,
        personaId: sCfg.personaId,
        customPrompt: sCfg.customPrompt,
        fallbackActive: false,
        fallbackReason: ""
      }
    };
  });

  gameState = createMatchState({ players: playersCfg });

  pushLog(`新規4人半荘を開始（${isAiVsAi ? "AI 4人観戦" : "人間 vs AI 3人"}）`);
  await localSync.saveState(gameState, gameLogs);
  refreshUI();
  await stepGameLoop(loopToken);
}

async function restoreOfflineOrStart() {
  isOnlineMode = false;
  currentRoom = null;
  updateModeBadgeUI();

  const saved = loadMatchSession();
  if (saved) {
    gameState = saved.gameState;
    let needsResave = false;
    if (Array.isArray(gameState.players)) {
      gameState.players.forEach((p) => {
        if (p.control === "ai" && p.aiConfig?.personaId) {
          const prof = getNpcProfile(p.aiConfig.personaId);
          if (/^(?:[自下対上]・)?(?:内蔵|AI)\(/.test(p.name || "")) {
            const isGemini = p.aiConfig.model !== "builtin" && !p.aiConfig.fallbackActive && /^AI\(/.test(p.name.replace(/^[自下対上]・/, ""));
            p.name = isGemini ? `${prof.characterName}(AI)` : prof.characterName;
            needsResave = true;
          }
        } else if (typeof p.name === "string") {
          const cleanedName = p.name.replace(/^[自下対上]・/, "");
          if (cleanedName !== p.name) {
            p.name = cleanedName;
            needsResave = true;
          }
        }
        if (p.aiConfig && "apiKey" in p.aiConfig) {
          delete p.aiConfig.apiKey;
          needsResave = true;
        }
      });
    }
    gameLogs = Array.isArray(saved.logs) ? saved.logs : [];
    if (needsResave) {
      await localSync.saveState(gameState, gameLogs);
    }
    renderLogs(gameLogs);
    refreshUI();

    if (gameState.status === "round_end") {
      showRoundResultModal(gameState, { isOnline: false });
    } else if (gameState.status === "match_end") {
      showMatchEndModal(gameState);
    } else {
      await stepGameLoop(loopToken);
    }
    return;
  }
  await startNewOfflineMatch();
}

/* ======================== 共通UI描画・アクション適用 ======================== */

function refreshUI() {
  if (!gameState) return;
  const viewerSeat = getViewerSeat();
  const profile = getOrCreateOnlineProfile();

  renderGame(
    gameState,
    {
      viewerSeat,
      thinkingSeat,
      selectedTileId,
      isOnlineHost: isOnlineHost(),
      myPlayerId: profile.playerId
    },
    {
      onHumanTileTap: (tileId) => {
        if (suppressNextClickAfterSwipe) return;
        const mySeat = getViewerSeat();
        if (selectedTileId === tileId) {
          selectedTileId = null;
          const label = tileIdToLabel(tileId, gameState.config.redDora);
          handlePlayerAction(mySeat, { action: "discard", tile: label, tileId }, {}, loopToken);
        } else {
          selectedTileId = tileId;
          updateSelectedTileHighlight(selectedTileId);
        }
      },
      onHumanPass: () => {
        if (suppressNextClickAfterSwipe) return;
        const mySeat = getViewerSeat();
        selectedTileId = null;
        handlePlayerAction(mySeat, { action: "pass", tile: "" }, {}, loopToken);
      },
      onHumanAction: (actionObj) => {
        const mySeat = getViewerSeat();
        selectedTileId = null;
        handlePlayerAction(mySeat, actionObj, {}, loopToken);
      },
      onKickPlayer: (targetId, targetName) => {
        openKickConfirmDialog(targetId, targetName);
      }
    }
  );
}

function formatActionLog(actor, actionObj, meta = {}) {
  const actorName = typeof actor === "string" ? actor : actor?.name || "プレイヤー";
  const prof = typeof actor === "object" ? getNpcProfileForPlayer(actor) : null;
  const icon = prof ? `${prof.emoji} ` : "";
  const talkSuffix =
    meta?.talk && actionObj.action !== "pass" ? `「${meta.talk}」` : "";

  const logMap = {
    discard: `${icon}${actorName}: ${actionObj.tile} 切り${talkSuffix}`,
    riichi: `🔥 ${icon}${actorName}: リーチ宣言！（${actionObj.tile} 切り）${talkSuffix}`,
    tsumo: `✨ ${icon}${actorName}: ツモ和了！${talkSuffix}`,
    ron: `⚡ ${icon}${actorName}: ロン宣言！${talkSuffix}`,
    pon: `📣 ${icon}${actorName}: ポン（${actionObj.tile}）${talkSuffix}`,
    chi: `📣 ${icon}${actorName}: チー（${actionObj.tile}）${talkSuffix}`,
    daiminkan: `💥 ${icon}${actorName}: 大明槓（${actionObj.tile}）${talkSuffix}`,
    ankan: `💥 ${icon}${actorName}: 暗槓（${actionObj.tile}）${talkSuffix}`,
    kakan: `💥 ${icon}${actorName}: 加槓（${actionObj.tile}）${talkSuffix}`,
    pass: `${icon}${actorName}: スルー`
  };
  return logMap[actionObj.action] || "";
}

async function commitOnlineStateMutation(mutatorFn) {
  // 最大4回まで最新状態を取得し直して自分の1操作だけ再適用（A案楽観ロックリトライ）
  for (let attempt = 0; attempt < 4; attempt++) {
    const baseState = structuredClone(gameState);
    const baseLogs = [...gameLogs];
    const expectedVersion = Number(currentRoom?.version || baseState.version || 1);

    const { nextState, nextLogs } = mutatorFn(baseState, baseLogs);
    const res = await gasSync.updateState({
      roomId: currentRoom.roomId,
      expectedVersion,
      gameState: nextState,
      logs: nextLogs
    });

    if (res.status === "ok" && res.room) {
      applySyncedRoomSnapshot(res.room, { triggerLoop: false });
      return true;
    }

    if (res.status === "conflict" && res.room) {
      currentRoom = res.room;
      if (res.room.gameState) {
        gameState = res.room.gameState;
        gameLogs = Array.isArray(res.room.logs) ? res.room.logs : [];
      }
      continue;
    }

    throw new Error(res.message || "サーバー同期エラーが発生しました");
  }
  throw new Error("通信の競合が続いたため操作を反映できませんでした。もう一度お試しください。");
}

async function handlePlayerAction(seatIndex, actionObj, meta = {}, token = loopToken) {
  if (token !== loopToken) return;
  if (isProcessing || !gameState || gameState.status !== "playing") return;
  isProcessing = true;
  selectedTileId = null;

  try {
    if (!isOnlineMode) {
      const actor = gameState.players[seatIndex];
      gameState = applyAction(gameState, seatIndex, actionObj, meta);
      const logLine = formatActionLog(actor, actionObj, meta);
      if (logLine) pushLog(logLine);

      await localSync.saveState(gameState, gameLogs);
      refreshUI();

      if (gameState.status === "round_end") {
        isProcessing = false;
        showRoundResultModal(gameState, { isOnline: false });
        return;
      }
    } else {
      await commitOnlineStateMutation((baseState, baseLogs) => {
        const actor = baseState.players[seatIndex];
        if (!actor) throw new Error("対象プレイヤーが見つかりません");
        const updated = applyAction(baseState, seatIndex, actionObj, meta);
        if (updated.status === "round_end") {
          updated.nextRoundReadyIds = [];
        }
        const logLine = formatActionLog(actor, actionObj, meta);
        const updatedLogs = logLine ? [logLine, ...baseLogs].slice(0, 120) : baseLogs;
        return { nextState: updated, nextLogs: updatedLogs };
      });
    }
  } catch (err) {
    console.warn("Action failed:", err);
    if (isOnlineMode) {
      alert(`操作を反映できませんでした: ${err.message}`);
      await pollOnlineRoomOnce(true);
    }
  } finally {
    isProcessing = false;
  }

  await stepGameLoop(token);
}

/**
 * 次の手番または鳴き/ロン判定の処理
 * ・人間リーチ中のオートツモ切り（自席のみ実行）
 * ・AI思考実行（オフライン時は全AI、オンライン時はホストのみが全AI席を代行実行）
 */
async function stepGameLoop(token) {
  if (token !== loopToken || !gameState || gameState.status !== "playing") return;

  const mySeat = getViewerSeat();
  const self = gameState.players[mySeat];

  // 1. 自席人間プレイヤーのリーチ中オートツモ切り判定
  if (self && self.control === "human" && self.isRiichi) {
    if (gameState.turn.phase === "discard" && gameState.turn.playerIndex === mySeat) {
      const legal = getLegalActions(gameState, mySeat);
      const canTsumo = legal.some((a) => a.action === "tsumo");
      if (!canTsumo) {
        const autoDiscard = legal.find((a) => a.action === "discard");
        if (autoDiscard) {
          await new Promise((r) => setTimeout(r, 420));
          if (token !== loopToken || gameState.status !== "playing") return;
          await handlePlayerAction(mySeat, autoDiscard, {}, token);
          return;
        }
      }
      return;
    }

    if (gameState.turn.phase === "claim_check" && gameState.turn.pendingClaims.includes(mySeat)) {
      return;
    }
  }

  // 2. AIプレイヤーの思考実行（オンライン時はホストのみが実行）
  if (isOnlineMode && !isOnlineHost()) {
    return;
  }

  let targetSeat = null;
  if (gameState.turn.phase === "discard") {
    const p = gameState.players[gameState.turn.playerIndex];
    if (p && p.control === "ai") targetSeat = p.seatIndex;
  } else if (gameState.turn.phase === "claim_check") {
    for (const s of gameState.turn.pendingClaims) {
      if (gameState.players[s] && gameState.players[s].control === "ai") {
        targetSeat = s;
        break;
      }
    }
  }

  if (targetSeat === null) return;

  thinkingSeat = targetSeat;
  refreshUI();

  const aiPlayer = gameState.players[targetSeat];
  // オンライン時もオフライン時もホスト側の設定（座席インデックス基準）からAPIキーを参照
  const apiKeySeat = isOnlineMode ? (aiPlayer.hostConfigSeat ?? targetSeat) : targetSeat;
  const hasApi =
    Boolean(getSeatApiKey(apiKeySeat)) &&
    aiPlayer.aiConfig?.model !== "builtin" &&
    !aiPlayer.aiConfig?.fallbackActive;
  const waitMs = hasApi ? 260 : 500;
  await new Promise((r) => setTimeout(r, waitMs));
  if (token !== loopToken) return;

  const personaPrompt = getPersonaPrompt(aiPlayer.aiConfig?.personaId);
  const decision = await decideAiMove({
    state: gameState,
    seatIndex: targetSeat,
    apiKeySeatIndex: apiKeySeat,
    baseRulesMd,
    personaPrompt
  });

  if (token !== loopToken) return;
  thinkingSeat = null;

  if (decision.switchedToBuiltin && aiPlayer.aiConfig) {
    const prevName = aiPlayer.name;
    aiPlayer.aiConfig.fallbackActive = true;
    aiPlayer.aiConfig.fallbackReason = decision.switchReason || "API上限到達";
    aiPlayer.name = getNpcProfile(aiPlayer.aiConfig.personaId).characterName;
    pushLog(
      `⚠️ ${prevName}: ${aiPlayer.aiConfig.fallbackReason}のため、この半荘は内蔵AIへ自動切替しました`
    );
  }

  await handlePlayerAction(
    targetSeat,
    decision.actionObj,
    { thought: decision.thought, talk: decision.talk },
    token
  );
}

/* ======================== オンラインロビー・待機室・ポーリング ======================== */

function setLobbyStatus(msg, isError = false) {
  const el = document.getElementById("online-status-msg");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("error-text", Boolean(isError));
}

function updateInviteUrlQuery(roomId) {
  try {
    const url = new URL(window.location.href);
    if (roomId) {
      url.searchParams.set("room", roomId);
    } else {
      url.searchParams.delete("room");
    }
    window.history.replaceState({}, "", url.toString());
  } catch {
    // ignore
  }
}

function getInviteUrlForRoom(roomId) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    return url.toString();
  } catch {
    return `?room=${roomId}`;
  }
}

function startOnlinePolling() {
  stopOnlinePolling();
  pollTimerId = setInterval(() => {
    if (!isOnlineMode || !currentRoom) return;
    if (document.hidden) return; // タブ非表示時はGAS無料枠を節約
    pollOnlineRoomOnce(false);
  }, POLL_INTERVAL_MS);
}

function stopOnlinePolling() {
  if (pollTimerId !== null) {
    clearInterval(pollTimerId);
    pollTimerId = null;
  }
}

function applySyncedRoomSnapshot(room, { triggerLoop = true } = {}) {
  const prevVersion = currentRoom ? Number(currentRoom.version) : -1;
  currentRoom = room;
  isOnlineMode = true;
  setActiveOnlineRoomId(room.roomId);
  updateInviteUrlQuery(room.roomId);
  updateModeBadgeUI();

  const lobbyModal = document.getElementById("online-modal");

  if (room.status === "waiting") {
    renderWaitingRoomView(room);
    if (!lobbyModal.open) lobbyModal.showModal();
    return;
  }

  // 対局中または終了済み
  if (lobbyModal.open) lobbyModal.close();

  if (room.gameState) {
    const versionChanged = Number(room.version) !== prevVersion;
    gameState = room.gameState;
    gameLogs = Array.isArray(room.logs) ? room.logs : [];
    renderLogs(gameLogs);
    refreshUI();

    const resModal = document.getElementById("result-modal");
    const endModal = document.getElementById("match-end-modal");
    const profile = getOrCreateOnlineProfile();

    if (gameState.status === "round_end") {
      if (endModal.open) endModal.close();
      showRoundResultModal(gameState, {
        isOnline: true,
        myPlayerId: profile.playerId
      });
    } else if (gameState.status === "match_end") {
      if (resModal.open) resModal.close();
      showMatchEndModal(gameState);
    } else {
      if (resModal.open) resModal.close();
      if (endModal.open) endModal.close();
      if (triggerLoop && versionChanged && !isProcessing) {
        stepGameLoop(loopToken);
      }
    }
  }
}

async function pollOnlineRoomOnce(force = false) {
  if (!isOnlineMode || !currentRoom || isPollingNow || isProcessing) return;
  isPollingNow = true;
  try {
    const res = await gasSync.getRoom(currentRoom.roomId, Number(currentRoom.version || -1), {
      force
    });

    if (res.status === "not_found") {
      stopOnlinePolling();
      clearCachedOnlineRoom(currentRoom.roomId);
      setActiveOnlineRoomId("");
      updateInviteUrlQuery("");
      alert("ルームが解散されたか、有効期限切れで終了しました。オフライン卓に戻ります。");
      await restoreOfflineOrStart();
      return;
    }

    if (res.status === "ok" && !res.unchanged && res.room) {
      const profile = getOrCreateOnlineProfile();
      // 待機中に自分がキックされたか確認
      if (
        res.room.status === "waiting" &&
        !res.room.players.some((p) => p.id === profile.playerId)
      ) {
        stopOnlinePolling();
        clearCachedOnlineRoom(res.room.roomId);
        setActiveOnlineRoomId("");
        updateInviteUrlQuery("");
        isOnlineMode = false;
        currentRoom = null;
        updateModeBadgeUI();
        renderLobbyEntryView();
        setLobbyStatus("ホストによりルームから退出させられました。", true);
        return;
      }

      applySyncedRoomSnapshot(res.room, { triggerLoop: true });
    }
  } catch (e) {
    console.warn("Poll error:", e);
  } finally {
    isPollingNow = false;
  }
}

function renderLobbyEntryView() {
  document.getElementById("lobby-entry-view").classList.remove("hidden");
  document.getElementById("lobby-waiting-view").classList.add("hidden");

  const profile = getOrCreateOnlineProfile();
  const nameInput = document.getElementById("online-player-name");
  if (!nameInput.value && profile.playerName) {
    nameInput.value = profile.playerName;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const queryRoom = urlParams.get("room");
  if (queryRoom && /^[0-9]{4}$/.test(queryRoom)) {
    document.getElementById("online-join-room-id").value = queryRoom;
  }

  refreshPublicRoomsList(false);
}

async function refreshPublicRoomsList(force = true) {
  const listEl = document.getElementById("public-rooms-list");
  listEl.innerHTML = `<div class="hint">公開ルームを読み込み中...</div>`;
  try {
    const rooms = await gasSync.listPublicRooms(force);
    if (rooms.length === 0) {
      listEl.innerHTML = `<div class="hint">現在募集中の公開ルームはありません。上のボタンから新しい部屋を作成できます。</div>`;
      return;
    }
    listEl.innerHTML = "";
    for (const r of rooms) {
      const row = document.createElement("div");
      row.className = "public-room-item";
      row.innerHTML = `
        <div>
          <strong>部屋 #${r.roomId}</strong>
          <span class="hint">ホスト: ${escapeHtmlInline(r.hostName)}（${r.playerCount}/4人）</span>
        </div>
      `;
      const joinBtn = document.createElement("button");
      joinBtn.type = "button";
      joinBtn.className = "btn btn-primary";
      joinBtn.textContent = "参加する";
      joinBtn.onclick = () => handleJoinOnlineRoom(r.roomId);
      row.appendChild(joinBtn);
      listEl.appendChild(row);
    }
  } catch (e) {
    listEl.innerHTML = `<div class="hint error-text">公開ルーム取得エラー: ${escapeHtmlInline(e.message)}</div>`;
  }
}

function renderWaitingRoomView(room) {
  document.getElementById("lobby-entry-view").classList.add("hidden");
  document.getElementById("lobby-waiting-view").classList.remove("hidden");

  const profile = getOrCreateOnlineProfile();
  const amHost = room.hostId === profile.playerId;

  document.getElementById("waiting-room-code").textContent = room.roomId;
  document.getElementById("waiting-room-visibility").textContent = room.isPublic
    ? "公開ロビー表示中"
    : "非公開（番号・URL招待のみ）";
  document.getElementById("waiting-invite-url").value = getInviteUrlForRoom(room.roomId);

  const slotsEl = document.getElementById("waiting-seats-list");
  slotsEl.innerHTML = "";
  const curSettings = loadSettings();

  for (let i = 0; i < 4; i++) {
    const human = room.players[i];
    const slot = document.createElement("div");
    slot.className = "waiting-seat-card";

    if (human) {
      const isHostBadge = human.id === room.hostId ? " [ホスト]" : "";
      const isMeBadge = human.id === profile.playerId ? "（あなた）" : "";
      const left = document.createElement("div");
      left.innerHTML = `<strong>人間着席: ${escapeHtmlInline(human.name)}${isMeBadge}${isHostBadge}</strong>`;
      slot.appendChild(left);

      if (amHost && human.id !== profile.playerId) {
        const kickBtn = document.createElement("button");
        kickBtn.type = "button";
        kickBtn.className = "btn btn-danger";
        kickBtn.textContent = "キック";
        kickBtn.onclick = () => openKickConfirmDialog(human.id, human.name);
        slot.appendChild(kickBtn);
      }
    } else {
      const aiPreviewCfg = curSettings.seats[i];
      const aiLabel = amHost
        ? `空き席 → 開始時にホスト設定のAIで自動補充（${buildSeatDisplayName(aiPreviewCfg)}）`
        : "空き席 → 開始時にホスト設定のAIで自動補充";
      slot.innerHTML = `<span class="hint">${aiLabel}</span>`;
    }
    slotsEl.appendChild(slot);
  }

  const startBtn = document.getElementById("btn-start-online-match");
  const waitHint = document.getElementById("waiting-host-hint");
  if (amHost) {
    startBtn.classList.remove("hidden");
    waitHint.textContent =
      "メンバーが揃ったら「対局開始（席順ランダム）」を押してください。空き席はAIが自動補充し、席順（東南西北）はランダムに決まります。";
  } else {
    startBtn.classList.add("hidden");
    waitHint.textContent = "ホストが対局を開始するのを待っています（自動更新中）...";
  }
}

async function handleCreateOnlineRoom() {
  const nameRaw = document.getElementById("online-player-name").value.trim();
  if (!nameRaw) {
    setLobbyStatus("プレイヤー名を入力してください。", true);
    return;
  }
  const profile = saveOnlinePlayerName(nameRaw);
  const isPublic = document.getElementById("online-room-public").checked;

  setLobbyStatus("ルームを作成しています...");
  try {
    const res = await gasSync.createRoom({
      playerId: profile.playerId,
      playerName: profile.playerName,
      isPublic
    });
    if (res.status !== "ok" || !res.room) {
      throw new Error(res.message || "ルーム作成に失敗しました");
    }
    setLobbyStatus("");
    applySyncedRoomSnapshot(res.room, { triggerLoop: false });
    startOnlinePolling();
  } catch (e) {
    setLobbyStatus(`作成エラー: ${e.message}`, true);
  }
}

async function handleJoinOnlineRoom(targetRoomId) {
  const roomId = String(targetRoomId || "").trim();
  if (!/^[0-9]{4}$/.test(roomId)) {
    setLobbyStatus("4桁の部屋番号を入力してください。", true);
    return;
  }
  const nameRaw = document.getElementById("online-player-name").value.trim();
  if (!nameRaw) {
    setLobbyStatus("参加する前にプレイヤー名を入力してください。", true);
    return;
  }
  const profile = saveOnlinePlayerName(nameRaw);

  setLobbyStatus(`部屋 #${roomId} に接続中...`);
  try {
    const res = await gasSync.joinRoom({
      roomId,
      playerId: profile.playerId,
      playerName: profile.playerName
    });
    if (res.status !== "ok" || !res.room) {
      throw new Error(res.message || "入室できませんでした");
    }
    setLobbyStatus("");
    applySyncedRoomSnapshot(res.room, { triggerLoop: true });
    startOnlinePolling();
  } catch (e) {
    setLobbyStatus(`入室エラー: ${e.message}`, true);
  }
}

async function handleLeaveOnlineRoom() {
  if (!currentRoom) return;
  const profile = getOrCreateOnlineProfile();
  const roomId = currentRoom.roomId;
  stopOnlinePolling();
  try {
    await gasSync.leaveRoom({ roomId, playerId: profile.playerId });
  } catch (e) {
    console.warn("Leave room warning:", e);
  }
  clearCachedOnlineRoom(roomId);
  setActiveOnlineRoomId("");
  updateInviteUrlQuery("");
  isOnlineMode = false;
  currentRoom = null;
  updateModeBadgeUI();
  renderLobbyEntryView();
  setLobbyStatus("ルームから退出しました。");
}

async function handleStartOnlineMatch() {
  if (!currentRoom || !isOnlineHost()) return;
  const profile = getOrCreateOnlineProfile();
  const curSettings = loadSettings();

  // 1〜4人の人間＋空き席をホスト設定のAIで埋めた4人リストを作成
  const rawSlots = [];
  for (let i = 0; i < 4; i++) {
    const human = currentRoom.players[i];
    if (human) {
      rawSlots.push({
        id: human.id,
        name: human.name,
        control: "human",
        aiConfig: null
      });
    } else {
      const sCfg = curSettings.seats[i];
      rawSlots.push({
        id: `ai_slot_${i}`,
        name: buildSeatDisplayName(sCfg),
        control: "ai",
        hostConfigSeat: i,
        aiConfig: {
          provider: "gemini",
          model: sCfg.model,
          personaId: sCfg.personaId,
          customPrompt: sCfg.customPrompt,
          fallbackActive: false,
          fallbackReason: ""
        }
      });
    }
  }

  // 対局開始時に4席の席順（東・南・西・北）をランダムシャッフル
  const shuffledPlayers = shuffleArray(rawSlots);
  const initialState = createMatchState({
    roomId: currentRoom.roomId,
    players: shuffledPlayers
  });
  // hostConfigSeat を state.players にも保持（APIキー参照用）
  initialState.players.forEach((pl, idx) => {
    if (shuffledPlayers[idx].hostConfigSeat !== undefined) {
      pl.hostConfigSeat = shuffledPlayers[idx].hostConfigSeat;
    }
  });
  initialState.nextRoundReadyIds = [];

  const humanCount = shuffledPlayers.filter((p) => p.control === "human").length;
  const initLogs = [
    `オンライン4人半荘を開始（部屋 #${currentRoom.roomId} / 人間${humanCount}人＋AI${4 - humanCount}人 / 席順ランダム決定）`
  ];

  setLobbyStatus("対局を初期化して送信中...");
  try {
    const res = await gasSync.startMatch({
      roomId: currentRoom.roomId,
      hostId: profile.playerId,
      gameState: initialState,
      logs: initLogs
    });
    if (res.status !== "ok" || !res.room) {
      throw new Error(res.message || "対局開始に失敗しました");
    }
    setLobbyStatus("");
    loopToken += 1;
    applySyncedRoomSnapshot(res.room, { triggerLoop: true });
  } catch (e) {
    setLobbyStatus(`開始エラー: ${e.message}`, true);
  }
}

/* ======================== ホストの誤タップ防止キック確認 ======================== */

function openKickConfirmDialog(targetId, targetName) {
  if (!isOnlineMode || !currentRoom || !isOnlineHost()) return;
  pendingKickTarget = { id: targetId, name: targetName };
  const isPlaying = currentRoom.status !== "waiting";
  document.getElementById("kick-confirm-body").textContent = isPlaying
    ? `本当に「${targetName}」をキックしますか？対局中のため、この席は即座に内蔵AI（ホスト代行）へ切り替わります。`
    : `本当に「${targetName}」を待機ルームからキックしますか？`;
  document.getElementById("kick-confirm-modal").showModal();
}

async function executeConfirmedKick() {
  const modal = document.getElementById("kick-confirm-modal");
  if (modal.open) modal.close();
  if (!pendingKickTarget || !currentRoom || !isOnlineHost()) return;

  const { id: targetId } = pendingKickTarget;
  pendingKickTarget = null;
  const profile = getOrCreateOnlineProfile();

  try {
    const res = await gasSync.kickPlayer({
      roomId: currentRoom.roomId,
      hostId: profile.playerId,
      targetId
    });
    if (res.status !== "ok" || !res.room) {
      throw new Error(res.message || "キックに失敗しました");
    }
    applySyncedRoomSnapshot(res.room, { triggerLoop: true });
  } catch (e) {
    alert(`キック処理エラー: ${e.message}`);
  }
}

/* ======================== 起動時自動復帰（招待URL / 進行中オンライン卓 / オフライン） ======================== */

async function bootApplication() {
  const urlParams = new URLSearchParams(window.location.search);
  const queryRoom = urlParams.get("room");
  const savedOnlineRoomId = getActiveOnlineRoomId();
  const profile = getOrCreateOnlineProfile();

  // 1. 招待URL (?room=XXXX) または前回入室していたオンラインルームがある場合
  const targetRoomId =
    queryRoom && /^[0-9]{4}$/.test(queryRoom) ? queryRoom : savedOnlineRoomId;

  if (targetRoomId) {
    try {
      // キャッシュがあればまず即時表示してから最新差分を確認（リロード連打でも無料枠を消費しない）
      const cached = loadCachedOnlineRoom(targetRoomId);
      if (cached && cached.room && cached.room.players.some((p) => p.id === profile.playerId)) {
        applySyncedRoomSnapshot(cached.room, { triggerLoop: false });
      }

      const res = await gasSync.getRoom(targetRoomId, -1, { force: false });
      if (res.status === "ok" && res.room) {
        const alreadyIn = res.room.players.some((p) => p.id === profile.playerId);
        if (alreadyIn) {
          applySyncedRoomSnapshot(res.room, { triggerLoop: true });
          startOnlinePolling();
          return;
        }
        // 未参加の招待URLを開いた場合はオフライン卓を裏で準備しつつ入室モーダルを開く
        await restoreOfflineOrStart();
        renderLobbyEntryView();
        document.getElementById("online-join-room-id").value = targetRoomId;
        setLobbyStatus(`招待ルーム #${targetRoomId} が見つかりました。名前を入力して「番号で参加」を押してください。`);
        document.getElementById("online-modal").showModal();
        return;
      }
    } catch (e) {
      console.warn("Online restore fallback:", e);
    }
    setActiveOnlineRoomId("");
    updateInviteUrlQuery("");
  }

  // 2. 通常はオフライン1人対戦を自動復帰または新規開始
  await restoreOfflineOrStart();
}

/* ======================== 卓全体スワイプ手牌スクロール ======================== */

function setupGlobalTableSwipeScroll() {
  const board = document.getElementById("table-board");
  const scrollWrap = document.getElementById("hand-scroll-wrap");
  if (!board || !scrollWrap) return;

  let isTracking = false;
  let startX = 0;
  let startScrollLeft = 0;
  let hasDragged = false;

  const isInteractiveControl = (target) => {
    return Boolean(target.closest("button, input, select, textarea, a, dialog, #action-buttons"));
  };

  board.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      if (isInteractiveControl(e.target)) {
        isTracking = false;
        return;
      }
      if (e.target.closest("#hand-scroll-wrap")) {
        isTracking = false;
        return;
      }
      isTracking = true;
      hasDragged = false;
      startX = e.touches[0].clientX;
      startScrollLeft = scrollWrap.scrollLeft;
    },
    { passive: true }
  );

  board.addEventListener(
    "touchmove",
    (e) => {
      if (!isTracking || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      if (Math.abs(dx) > 6) {
        hasDragged = true;
        scrollWrap.scrollLeft = startScrollLeft - dx;
      }
    },
    { passive: true }
  );

  board.addEventListener("touchend", () => {
    if (isTracking && hasDragged) {
      suppressNextClickAfterSwipe = true;
      setTimeout(() => {
        suppressNextClickAfterSwipe = false;
      }, 80);
    }
    isTracking = false;
  });

  board.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || isInteractiveControl(e.target)) return;
    isTracking = true;
    hasDragged = false;
    startX = e.clientX;
    startScrollLeft = scrollWrap.scrollLeft;
  });

  window.addEventListener("mousemove", (e) => {
    if (!isTracking) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 6) {
      hasDragged = true;
      scrollWrap.scrollLeft = startScrollLeft - dx;
    }
  });

  window.addEventListener("mouseup", () => {
    if (isTracking && hasDragged) {
      suppressNextClickAfterSwipe = true;
      setTimeout(() => {
        suppressNextClickAfterSwipe = false;
      }, 80);
    }
    isTracking = false;
  });
}

function renderSeatSettingsForm(currentSettings) {
  const listEl = document.getElementById("seat-config-list");
  listEl.innerHTML = "";

  [0, 1, 2, 3].forEach((idx) => {
    const sCfg = currentSettings.seats[idx];
    const card = document.createElement("div");
    card.className = "seat-cfg-card";
    const note = idx === 0 ? " ※AI観戦・オンライン空き席補充時に有効" : "";
    const personaOptions = personas
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === sCfg.personaId ? "selected" : ""}>${p.name}</option>`
      )
      .join("");

    const curProf = getNpcProfile(sCfg.personaId);
    card.innerHTML = `
      <div class="seat-cfg-head">
        <img class="seat-cfg-avatar" id="seat-avatar-preview-${idx}" src="${curProf.avatar}" alt="${curProf.characterName}" style="--npc-accent:${curProf.accentColor}" />
        <div class="seat-cfg-title">${SEAT_NAMES[idx]}${note}</div>
      </div>
      <div class="seat-cfg-grid">
        <label class="field">
          <span>モデル</span>
          <select id="seat-model-${idx}">
            <option value="builtin" ${sCfg.model === "builtin" ? "selected" : ""}>内蔵AI (API不要)</option>
            <option value="gemini-4-hydrogen" ${sCfg.model === "gemini-4-hydrogen" ? "selected" : ""}>Gemini 4 Hydrogen</option>
            <option value="gemini-4-neon" ${sCfg.model === "gemini-4-neon" ? "selected" : ""}>Gemini 4 Neon</option>
            <option value="gemini-2.5-flash" ${sCfg.model === "gemini-2.5-flash" ? "selected" : ""}>Gemini 2.5 Flash</option>
          </select>
        </label>
        <label class="field">
          <span>キャラクター / 打ち筋</span>
          <select id="seat-persona-${idx}">${personaOptions}</select>
        </label>
        <label class="field">
          <span>個別 Gemini API Key</span>
          <input type="password" id="seat-apikey-${idx}" value="${sCfg.apiKey || ""}" placeholder="AIzaSy... (空欄なら内蔵AI)" autocomplete="off" />
        </label>
      </div>
      <label class="field">
        <span>個別作戦指示（任意）</span>
        <input type="text" id="seat-prompt-${idx}" value="${sCfg.customPrompt || ""}" placeholder="例：役牌を積極的に鳴いてスピード重視" />
      </label>
    `;
    listEl.appendChild(card);
    const personaSel = card.querySelector(`#seat-persona-${idx}`);
    const previewImg = card.querySelector(`#seat-avatar-preview-${idx}`);
    if (personaSel && previewImg) {
      personaSel.addEventListener("change", () => {
        const nextProf = getNpcProfile(personaSel.value);
        previewImg.src = nextProf.avatar;
        previewImg.alt = nextProf.characterName;
        previewImg.style.setProperty("--npc-accent", nextProf.accentColor);
      });
    }
  });
}

function bindEvents() {
  setupGlobalTableSwipeScroll();

  document.getElementById("btn-new-game").addEventListener("click", () => {
    if (isOnlineMode) return;
    if (confirm("現在の半荘を破棄して、東1局から新しく始めますか？")) {
      startNewOfflineMatch();
    }
  });

  // オンラインロビーモーダル制御
  const onlineModal = document.getElementById("online-modal");
  document.getElementById("btn-online-lobby").addEventListener("click", () => {
    setLobbyStatus("");
    if (isOnlineMode && currentRoom && currentRoom.status === "waiting") {
      renderWaitingRoomView(currentRoom);
    } else if (isOnlineMode && currentRoom) {
      // 対局中は部屋情報＋オフライン復帰案内を表示
      renderWaitingRoomView(currentRoom);
      document.getElementById("btn-start-online-match").classList.add("hidden");
      document.getElementById("waiting-host-hint").textContent =
        "現在オンライン対局中です。招待URLを共有すれば未接続メンバーも再接続できます。";
    } else {
      renderLobbyEntryView();
    }
    onlineModal.showModal();
  });

  document.getElementById("btn-close-online").addEventListener("click", () => {
    onlineModal.close();
  });

  document.getElementById("btn-switch-offline").addEventListener("click", async () => {
    onlineModal.close();
    stopOnlinePolling();
    setActiveOnlineRoomId("");
    updateInviteUrlQuery("");
    await restoreOfflineOrStart();
  });

  document.getElementById("btn-create-online-room").addEventListener("click", () => {
    handleCreateOnlineRoom();
  });

  document.getElementById("btn-join-online-room").addEventListener("click", () => {
    const rid = document.getElementById("online-join-room-id").value.trim();
    handleJoinOnlineRoom(rid);
  });

  document.getElementById("btn-refresh-rooms").addEventListener("click", () => {
    refreshPublicRoomsList(true);
  });

  document.getElementById("btn-copy-invite-url").addEventListener("click", async () => {
    const txt = document.getElementById("waiting-invite-url").value;
    await navigator.clipboard.writeText(txt);
    alert("招待URLをコピーしました！LINEやDiscord等で共有してください。");
  });

  document.getElementById("btn-leave-online-room").addEventListener("click", () => {
    handleLeaveOnlineRoom();
  });

  document.getElementById("btn-start-online-match").addEventListener("click", () => {
    handleStartOnlineMatch();
  });

  // キック確認モーダル
  document.getElementById("btn-cancel-kick").addEventListener("click", () => {
    pendingKickTarget = null;
    document.getElementById("kick-confirm-modal").close();
  });
  document.getElementById("btn-confirm-kick").addEventListener("click", () => {
    executeConfirmedKick();
  });

  // サイドパネルタブ
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.getElementById("panel-thoughts").classList.toggle("hidden", tab !== "thoughts");
      document.getElementById("panel-logs").classList.toggle("hidden", tab !== "logs");
    });
  });

  const sidePanel = document.getElementById("side-panel");
  document.getElementById("btn-show-log-mobile").addEventListener("click", () => {
    sidePanel.classList.toggle("open");
  });
  document.getElementById("btn-close-panel").addEventListener("click", () => {
    sidePanel.classList.remove("open");
  });

  // 設定モーダル
  const settingsModal = document.getElementById("settings-modal");
  document.getElementById("btn-settings").addEventListener("click", () => {
    const s = loadSettings();
    document.getElementById("select-match-mode").value = s.matchMode;
    renderSeatSettingsForm(s);
    const submitBtn = document.getElementById("btn-save-settings");
    submitBtn.textContent = isOnlineMode ? "AI設定を保存" : "保存して新規半荘";
    settingsModal.showModal();
  });

  document.getElementById("btn-close-settings").addEventListener("click", () => {
    settingsModal.close();
  });

  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nextSeats = [0, 1, 2, 3].map((idx) => ({
      model: document.getElementById(`seat-model-${idx}`).value,
      personaId: document.getElementById(`seat-persona-${idx}`).value,
      apiKey: document.getElementById(`seat-apikey-${idx}`).value.trim(),
      customPrompt: document.getElementById(`seat-prompt-${idx}`).value.trim()
    }));

    saveSettings({
      matchMode: document.getElementById("select-match-mode").value,
      seats: nextSeats
    });
    settingsModal.close();

    if (isOnlineMode) {
      if (currentRoom && currentRoom.status === "waiting") {
        renderWaitingRoomView(currentRoom);
      }
    } else {
      await startNewOfflineMatch();
    }
  });

  // 局結果モーダル「次の局へ / OK」
  document.getElementById("btn-next-round").addEventListener("click", async () => {
    if (!isOnlineMode) {
      document.getElementById("result-modal").close();
      selectedTileId = null;
      gameState = advanceNextRoundOrFinish(gameState);

      if (gameState.status === "match_end") {
        pushLog(`=== 半荘終了（${gameState.finalSettlement.reason}） ===`);
        await localSync.saveState(gameState, gameLogs);
        refreshUI();
        showMatchEndModal(gameState);
        return;
      }

      const windJp = { E: "東", S: "南" }[gameState.round.wind] || gameState.round.wind;
      pushLog(`--- ${windJp}${gameState.round.number}局 ${gameState.round.honba}本場 開始 ---`);
      await localSync.saveState(gameState, gameLogs);
      refreshUI();
      await stepGameLoop(loopToken);
      return;
    }

    // オンライン対戦時：全員OK方式
    const profile = getOrCreateOnlineProfile();
    const nextBtn = document.getElementById("btn-next-round");
    nextBtn.disabled = true;
    nextBtn.textContent = "OK送信中...";

    try {
      const okRes = await gasSync.sendNextRoundOk({
        roomId: currentRoom.roomId,
        playerId: profile.playerId
      });
      if (okRes.status !== "ok" || !okRes.room) {
        throw new Error(okRes.message || "OK送信に失敗しました");
      }

      applySyncedRoomSnapshot(okRes.room, { triggerLoop: false });

      if (okRes.allReady) {
        document.getElementById("result-modal").close();
        selectedTileId = null;

        await commitOnlineStateMutation((baseState, baseLogs) => {
          if (baseState.status !== "round_end") {
            return { nextState: baseState, nextLogs: baseLogs };
          }
          const advanced = advanceNextRoundOrFinish(baseState);
          advanced.nextRoundReadyIds = [];

          // hostConfigSeat の引き継ぎ保証
          advanced.players.forEach((pl, idx) => {
            if (baseState.players[idx]?.hostConfigSeat !== undefined) {
              pl.hostConfigSeat = baseState.players[idx].hostConfigSeat;
            }
          });

          let logLine = "";
          if (advanced.status === "match_end") {
            logLine = `=== 半荘終了（${advanced.finalSettlement.reason}） ===`;
          } else {
            const windJp = { E: "東", S: "南" }[advanced.round.wind] || advanced.round.wind;
            logLine = `--- ${windJp}${advanced.round.number}局 ${advanced.round.honba}本場 開始 ---`;
          }
          return {
            nextState: advanced,
            nextLogs: logLine ? [logLine, ...baseLogs].slice(0, 120) : baseLogs
          };
        });

        await stepGameLoop(loopToken);
      }
    } catch (e) {
      alert(`次局進行エラー: ${e.message}`);
      await pollOnlineRoomOnce(true);
    }
  });

  document.getElementById("btn-match-restart").addEventListener("click", async () => {
    document.getElementById("match-end-modal").close();
    if (isOnlineMode) {
      stopOnlinePolling();
      if (currentRoom) clearCachedOnlineRoom(currentRoom.roomId);
      setActiveOnlineRoomId("");
      updateInviteUrlQuery("");
      isOnlineMode = false;
      currentRoom = null;
      updateModeBadgeUI();
      renderLobbyEntryView();
      document.getElementById("online-modal").showModal();
    } else {
      await startNewOfflineMatch();
    }
  });

  // Markdown確認モーダル（自分の手牌基準で表示）
  const mdModal = document.getElementById("md-modal");
  document.getElementById("btn-show-md").addEventListener("click", () => {
    const targetSeat = isOnlineMode ? getViewerSeat() : gameState.turn.playerIndex;
    document.getElementById("md-preview-text").value = buildTurnPromptMarkdown(
      gameState,
      targetSeat
    );
    mdModal.showModal();
  });

  document.getElementById("btn-copy-md").addEventListener("click", async () => {
    const txt = document.getElementById("md-preview-text").value;
    await navigator.clipboard.writeText(txt);
    alert("現在の盤面Markdownをコピーしました");
  });

  document.getElementById("btn-close-md").addEventListener("click", () => {
    mdModal.close();
  });
}

function escapeHtmlInline(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

(async function init() {
  await loadExternalAssets();
  bindEvents();
  await bootApplication();
})();
