/**
 * main.js
 * 4人麻雀（半荘・鳴きアリ・SVG牌セット・2タップ打牌・卓スワイプ手牌スクロール・リーチ自動ツモ切り）統括
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
  loadMatchSession,
  clearMatchSession
} from "./storage.js";
import { LocalSyncAdapter } from "./sync.js";
import {
  renderGame,
  renderLogs,
  updateTicker,
  showRoundResultModal,
  showMatchEndModal
} from "./ui.js";

let gameState = null;
let gameLogs = [];
let settings = loadSettings();
let baseRulesMd = "";
let personas = [];
let openHand = false;
let thinkingSeat = null;
let selectedTileId = null;
let isProcessing = false;
let loopToken = 0;
const syncAdapter = new LocalSyncAdapter();

async function loadExternalAssets() {
  try {
    const [rulesRes, personaRes] = await Promise.all([
      fetch("rules/default.md"),
      fetch("rules/personas.json")
    ]);
    baseRulesMd = await rulesRes.text();
    personas = await personaRes.json();
  } catch (e) {
    console.warn("Asset load fallback:", e);
    baseRulesMd = "あなたは4人麻雀プレイヤーです。合法アクション一覧から最適な手をJSONで返してください。";
    personas = [
      { id: "digital_balanced", name: "デジタル派", prompt: "期待値と受け入れ枚数重視で打ちます。" },
      { id: "aggressive_riichi", name: "超攻撃型", prompt: "聴牌即リーチで押し返します。" },
      { id: "speed_caller", name: "鳴き仕掛け速攻派", prompt: "積極的に鳴いて局を進めます。" },
      { id: "iron_defense", name: "鉄壁守備派", prompt: "放銃回避を最優先します。" }
    ];
  }

  for (let i = 0; i < 4; i++) {
    const sel = document.getElementById(`select-persona-${i}`);
    if (!sel) continue;
    sel.innerHTML = "";
    for (const p of personas) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
  }
}

function getPersonaName(personaId) {
  const found = personas.find((p) => p.id === personaId);
  return found ? found.name.replace(/（.*?）/g, "") : "AI";
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

function buildAiName(seatLabel, model, personaId) {
  const prefix = model === "builtin" ? "内蔵" : "Gemini";
  return `${seatLabel}・${prefix}(${getPersonaName(personaId)})`;
}

async function startNewMatch() {
  loopToken += 1;
  isProcessing = false;
  thinkingSeat = null;
  selectedTileId = null;
  clearMatchSession();

  const resModal = document.getElementById("result-modal");
  const endModal = document.getElementById("match-end-modal");
  if (resModal.open) resModal.close();
  if (endModal.open) endModal.close();

  settings = loadSettings();
  gameLogs = [];

  const isAiVsAi = settings.matchMode === "ai_vs_ai";
  const seatLabels = ["自", "下", "対", "上"];

  const playersCfg = [0, 1, 2, 3].map((seat) => {
    const sCfg = settings.seats[seat] || { model: "builtin", personaId: "digital_balanced", apiKey: "" };
    const isHuman = seat === 0 && !isAiVsAi;
    return {
      id: `p${seat}`,
      name: isHuman ? "あなた" : buildAiName(seatLabels[seat], sCfg.model, sCfg.personaId),
      control: isHuman ? "human" : "ai",
      aiConfig: isHuman
        ? null
        : {
            provider: "gemini",
            model: sCfg.model,
            personaId: sCfg.personaId,
            apiKey: sCfg.apiKey || "",
            customPrompt: settings.customPrompt || ""
          }
    };
  });

  gameState = createMatchState({ players: playersCfg });

  pushLog(`新規4人半荘を開始しました（${isAiVsAi ? "AI 4人観戦" : "人間 vs AI 3人"}）`);
  updateTicker("卓情報", "東1局 開始！対局よろしくお願いします。");
  await syncAdapter.saveState(gameState, gameLogs);
  refreshUI();
  await stepGameLoop(loopToken);
}

async function restoreOrStartMatch() {
  const saved = loadMatchSession();
  if (saved) {
    gameState = saved.gameState;
    gameLogs = Array.isArray(saved.logs) ? saved.logs : [];
    renderLogs(gameLogs);
    updateTicker("自動復帰", "前回の対局状態をリロードから復元しました。");
    refreshUI();

    if (gameState.status === "round_end") {
      showRoundResultModal(gameState);
    } else if (gameState.status === "match_end") {
      showMatchEndModal(gameState);
    } else {
      await stepGameLoop(loopToken);
    }
    return;
  }
  await startNewMatch();
}

function refreshUI() {
  renderGame(
    gameState,
    { openHand, thinkingSeat, selectedTileId },
    {
      onHumanTileTap: (tileId) => {
        // 1回目タップ: 黄色枠を移動 / 2回目タップ: 打牌確定
        if (selectedTileId !== tileId) {
          selectedTileId = tileId;
          refreshUI();
          return;
        }
        selectedTileId = null;
        const label = tileIdToLabel(tileId, gameState.config.redDora);
        handlePlayerAction(0, { action: "discard", tile: label, tileId }, {}, loopToken);
      },
      onHumanAction: (actionObj) => {
        selectedTileId = null;
        handlePlayerAction(0, actionObj, {}, loopToken);
      }
    }
  );
}

async function handlePlayerAction(seatIndex, actionObj, meta = {}, token = loopToken) {
  if (token !== loopToken) return;
  if (isProcessing || gameState.status !== "playing") return;
  isProcessing = true;

  try {
    const actor = gameState.players[seatIndex];
    gameState = applyAction(gameState, seatIndex, actionObj, meta);

    if (actionObj.action === "discard") {
      pushLog(`${actor.name}: ${actionObj.tile} 切り`);
    } else if (actionObj.action === "riichi") {
      pushLog(`🔥 ${actor.name}: リーチ宣言！（${actionObj.tile} 切り）`);
    } else if (actionObj.action === "pon") {
      pushLog(`📢 ${actor.name}: ポン！（${actionObj.tile}）`);
    } else if (actionObj.action === "chi") {
      pushLog(`📢 ${actor.name}: チー！（${actionObj.chiLabel}）`);
    } else if (actionObj.action === "minkan" || actionObj.action === "ankan" || actionObj.action === "kakan") {
      pushLog(`📢 ${actor.name}: カン！（${actionObj.tile}）`);
    } else if (actionObj.action === "tsumo") {
      pushLog(`🀄 ${actor.name}: ツモ和了！`);
    } else if (actionObj.action === "ron") {
      pushLog(`⚡ ${actor.name}: ロン宣言！`);
    } else if (actionObj.action === "pass") {
      pushLog(`${actor.name}: スルー`);
    }

    if (meta.talk) {
      updateTicker(actor.name, `「${meta.talk}」`);
    }

    await syncAdapter.saveState(gameState, gameLogs);
    refreshUI();

    if (gameState.status === "round_end") {
      isProcessing = false;
      showRoundResultModal(gameState);
      return;
    }
  } finally {
    isProcessing = false;
  }

  await stepGameLoop(token);
}

async function stepGameLoop(token) {
  if (token !== loopToken || gameState.status !== "playing") return;

  // 人間のリーチ中オートツモ切り（ツモ和了・暗槓・鳴き/ロン可能時は手動停止）
  const human = gameState.players[0];
  if (
    human.control === "human" &&
    human.isRiichi &&
    settings.autoRiichiTsumogiri &&
    gameState.turn.phase === "discard" &&
    gameState.turn.playerIndex === 0
  ) {
    const legal = getLegalActions(gameState, 0);
    const hasSpecial = legal.some((a) => a.action === "tsumo" || a.action === "ankan");
    if (!hasSpecial && legal.length === 1 && legal[0].action === "discard") {
      await new Promise((r) => setTimeout(r, 320));
      if (token !== loopToken) return;
      await handlePlayerAction(0, legal[0], {}, token);
      return;
    }
  }

  let targetSeat = null;
  if (gameState.turn.phase === "discard") {
    const p = gameState.players[gameState.turn.playerIndex];
    if (p.control === "ai") targetSeat = p.seatIndex;
  } else if (gameState.turn.phase === "claim_check") {
    for (const s of gameState.turn.pendingClaims) {
      if (gameState.players[s].control === "ai") {
        targetSeat = s;
        break;
      }
    }
  }

  if (targetSeat === null) return;

  thinkingSeat = targetSeat;
  refreshUI();

  const aiPlayer = gameState.players[targetSeat];
  const waitMs = aiPlayer.aiConfig?.model === "builtin" ? 260 : 350;
  await new Promise((r) => setTimeout(r, waitMs));
  if (token !== loopToken) return;

  const personaPrompt = getPersonaPrompt(aiPlayer.aiConfig?.personaId);

  const decision = await decideAiMove({
    state: gameState,
    seatIndex: targetSeat,
    commonApiKey: settings.apiKey,
    baseRulesMd,
    personaPrompt
  });

  if (token !== loopToken) return;
  thinkingSeat = null;

  await handlePlayerAction(
    targetSeat,
    decision.actionObj,
    { thought: decision.thought, talk: decision.talk },
    token
  );
}

function setupTableSwipeHandScroll() {
  const board = document.getElementById("table-board");
  const viewport = document.getElementById("hand-scroll-viewport");
  if (!board || !viewport) return;

  let startX = 0;
  let startScrollLeft = 0;
  let tracking = false;

  board.addEventListener(
    "touchstart",
    (e) => {
      if (e.target.closest("#action-buttons") || e.target.closest("#hand-scroll-viewport")) {
        tracking = false;
        return;
      }
      if (e.touches.length === 1) {
        tracking = true;
        startX = e.touches[0].clientX;
        startScrollLeft = viewport.scrollLeft;
      }
    },
    { passive: true }
  );

  board.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      viewport.scrollLeft = startScrollLeft - dx;
    },
    { passive: true }
  );

  board.addEventListener("touchend", () => {
    tracking = false;
  });
}

function bindEvents() {
  setupTableSwipeHandScroll();

  document.getElementById("btn-new-game").addEventListener("click", () => {
    if (confirm("現在の半荘を破棄して、東1局から新しく始めますか？")) {
      startNewMatch();
    }
  });

  const autoBtn = document.getElementById("btn-auto-tsumogiri");
  autoBtn.textContent = `リーチ自動ツモ切: ${settings.autoRiichiTsumogiri ? "ON" : "OFF"}`;
  autoBtn.addEventListener("click", () => {
    settings = saveSettings({ autoRiichiTsumogiri: !settings.autoRiichiTsumogiri });
    autoBtn.textContent = `リーチ自動ツモ切: ${settings.autoRiichiTsumogiri ? "ON" : "OFF"}`;
  });

  const openBtn = document.getElementById("btn-toggle-open");
  openBtn.addEventListener("click", () => {
    openHand = !openHand;
    openBtn.textContent = `手牌公開: ${openHand ? "ON" : "OFF"}`;
    refreshUI();
  });

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

  const settingsModal = document.getElementById("settings-modal");
  document.getElementById("btn-settings").addEventListener("click", () => {
    const s = loadSettings();
    document.getElementById("input-api-key").value = s.apiKey;
    document.getElementById("select-match-mode").value = s.matchMode;
    document.getElementById("input-custom-prompt").value = s.customPrompt;
    for (let i = 0; i < 4; i++) {
      document.getElementById(`select-model-${i}`).value = s.seats[i]?.model || "builtin";
      document.getElementById(`select-persona-${i}`).value = s.seats[i]?.personaId || "digital_balanced";
      document.getElementById(`input-key-${i}`).value = s.seats[i]?.apiKey || "";
    }
    settingsModal.showModal();
  });

  document.getElementById("btn-close-settings").addEventListener("click", () => {
    settingsModal.close();
  });

  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const seats = [0, 1, 2, 3].map((i) => ({
      model: document.getElementById(`select-model-${i}`).value,
      personaId: document.getElementById(`select-persona-${i}`).value,
      apiKey: document.getElementById(`input-key-${i}`).value.trim()
    }));

    settings = saveSettings({
      apiKey: document.getElementById("input-api-key").value.trim(),
      matchMode: document.getElementById("select-match-mode").value,
      seats,
      customPrompt: document.getElementById("input-custom-prompt").value.trim()
    });
    settingsModal.close();
    await startNewMatch();
  });

  document.getElementById("btn-next-round").addEventListener("click", async () => {
    document.getElementById("result-modal").close();
    selectedTileId = null;
    gameState = advanceNextRoundOrFinish(gameState);

    if (gameState.status === "match_end") {
      pushLog(`=== 半荘終了（${gameState.finalSettlement.reason}） ===`);
      await syncAdapter.saveState(gameState, gameLogs);
      refreshUI();
      showMatchEndModal(gameState);
      return;
    }

    const windJp = { E: "東", S: "南" }[gameState.round.wind] || gameState.round.wind;
    pushLog(`--- ${windJp}${gameState.round.number}局 ${gameState.round.honba}本場 開始 ---`);
    updateTicker("局進行", `${windJp}${gameState.round.number}局 ${gameState.round.honba}本場 開始！`);
    await syncAdapter.saveState(gameState, gameLogs);
    refreshUI();
    await stepGameLoop(loopToken);
  });

  document.getElementById("btn-match-restart").addEventListener("click", async () => {
    document.getElementById("match-end-modal").close();
    await startNewMatch();
  });

  const mdModal = document.getElementById("md-modal");
  document.getElementById("btn-show-md").addEventListener("click", () => {
    const targetSeat = gameState.turn.playerIndex;
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

(async function init() {
  await loadExternalAssets();
  bindEvents();
  await restoreOrStartMatch();
})();
