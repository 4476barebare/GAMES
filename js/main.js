/**
 * main.js
 * 4人麻雀（半荘）アプリケーション統括・自動保存復帰・対局進行ループ
 */

import { tileIdToLabel } from "./tiles.js";
import {
  createMatchState,
  advanceNextRoundOrFinish,
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
let isProcessing = false;
let loopToken = 0; // 新規対局時に旧非同期ループを無効化するためのトークン
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
      { id: "iron_defense", name: "鉄壁守備派", prompt: "放銃回避を最優先します。" }
    ];
  }

  for (const selId of ["select-persona-1", "select-persona-2", "select-persona-3"]) {
    const sel = document.getElementById(selId);
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
  clearMatchSession();

  // 開いている結果モーダルを閉じる
  const resModal = document.getElementById("result-modal");
  const endModal = document.getElementById("match-end-modal");
  if (resModal.open) resModal.close();
  if (endModal.open) endModal.close();

  settings = loadSettings();
  gameLogs = [];

  const isAiVsAi = settings.matchMode === "ai_vs_ai";
  const model = settings.aiModel || "builtin";

  gameState = createMatchState({
    players: [
      {
        id: "p0",
        name: isAiVsAi ? buildAiName("自", model, "occult_flow") : "あなた",
        control: isAiVsAi ? "ai" : "human",
        aiConfig: isAiVsAi
          ? { provider: "gemini", model, personaId: "occult_flow", customPrompt: settings.customPrompt }
          : null
      },
      {
        id: "p1",
        name: buildAiName("下", model, settings.persona1),
        control: "ai",
        aiConfig: { provider: "gemini", model, personaId: settings.persona1, customPrompt: settings.customPrompt }
      },
      {
        id: "p2",
        name: buildAiName("対", model, settings.persona2),
        control: "ai",
        aiConfig: { provider: "gemini", model, personaId: settings.persona2, customPrompt: settings.customPrompt }
      },
      {
        id: "p3",
        name: buildAiName("上", model, settings.persona3),
        control: "ai",
        aiConfig: { provider: "gemini", model, personaId: settings.persona3, customPrompt: settings.customPrompt }
      }
    ]
  });

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
    { openHand, thinkingSeat },
    {
      onHumanDiscard: (tileId) => {
        const label = tileIdToLabel(tileId, gameState.config.redDora);
        handlePlayerAction(0, { action: "discard", tile: label, tileId }, {}, loopToken);
      },
      onHumanAction: (actionObj) => {
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
    } else if (actionObj.action === "tsumo") {
      pushLog(`🀄 ${actor.name}: ツモ和了！`);
    } else if (actionObj.action === "ron") {
      pushLog(`⚡ ${actor.name}: ロン宣言！`);
    } else if (actionObj.action === "pass") {
      pushLog(`${actor.name}: ロン見送り`);
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

  const waitMs = settings.aiModel === "builtin" ? 260 : 350;
  await new Promise((r) => setTimeout(r, waitMs));
  if (token !== loopToken) return;

  const aiPlayer = gameState.players[targetSeat];
  const personaPrompt = getPersonaPrompt(aiPlayer.aiConfig?.personaId);

  const decision = await decideAiMove({
    state: gameState,
    seatIndex: targetSeat,
    apiKey: settings.apiKey,
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

function bindEvents() {
  document.getElementById("btn-new-game").addEventListener("click", () => {
    if (confirm("現在の半荘を破棄して、東1局から新しく始めますか？")) {
      startNewMatch();
    }
  });

  // 手牌公開トグル
  const openBtn = document.getElementById("btn-toggle-open");
  openBtn.addEventListener("click", () => {
    openHand = !openHand;
    openBtn.textContent = `手牌公開: ${openHand ? "ON" : "OFF"}`;
    refreshUI();
  });

  // サイドパネルタブ切替
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document.getElementById("panel-thoughts").classList.toggle("hidden", tab !== "thoughts");
      document.getElementById("panel-logs").classList.toggle("hidden", tab !== "logs");
    });
  });

  // モバイル用サイドパネル開閉
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
    document.getElementById("input-api-key").value = s.apiKey;
    document.getElementById("select-match-mode").value = s.matchMode;
    document.getElementById("select-ai-model").value = s.aiModel;
    document.getElementById("select-persona-1").value = s.persona1;
    document.getElementById("select-persona-2").value = s.persona2;
    document.getElementById("select-persona-3").value = s.persona3;
    document.getElementById("input-custom-prompt").value = s.customPrompt;
    settingsModal.showModal();
  });

  document.getElementById("btn-close-settings").addEventListener("click", () => {
    settingsModal.close();
  });

  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    saveSettings({
      apiKey: document.getElementById("input-api-key").value.trim(),
      matchMode: document.getElementById("select-match-mode").value,
      aiModel: document.getElementById("select-ai-model").value,
      persona1: document.getElementById("select-persona-1").value,
      persona2: document.getElementById("select-persona-2").value,
      persona3: document.getElementById("select-persona-3").value,
      customPrompt: document.getElementById("input-custom-prompt").value.trim()
    });
    settingsModal.close();
    await startNewMatch();
  });

  // 局結果モーダル -> 次局または半荘最終精算へ
  document.getElementById("btn-next-round").addEventListener("click", async () => {
    document.getElementById("result-modal").close();
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

  // 半荘最終精算 -> 新しい半荘を始める
  document.getElementById("btn-match-restart").addEventListener("click", async () => {
    document.getElementById("match-end-modal").close();
    await startNewMatch();
  });

  // 盤面Markdown確認モーダル
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
