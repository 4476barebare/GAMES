/**
 * main.js
 * アプリケーション統括・対局進行ループ・モーダル制御
 */

import { tileIdToLabel } from "./tiles.js";
import { createMatchState, startNewRound, applyAction } from "./engine.js";
import { buildTurnPromptMarkdown } from "./markdown.js";
import { decideAiMove } from "./llm.js";
import { loadSettings, saveSettings } from "./storage.js";
import { LocalSyncAdapter } from "./sync.js";
import { renderGame, appendLog, showRoundResultModal } from "./ui.js";

let gameState = null;
let settings = loadSettings();
let baseRulesMd = "";
let personas = [];
let openHand = false;
let oppThinking = false;
let isProcessing = false;
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
    baseRulesMd = "あなたは麻雀プレイヤーです。合法アクション一覧から最適な手をJSONで返してください。";
    personas = [
      { id: "digital_balanced", name: "デジタル派", prompt: "期待値と受け入れ枚数重視で打ちます。" }
    ];
  }

  const sel = document.getElementById("select-opp-persona");
  sel.innerHTML = "";
  for (const p of personas) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
}

function getPersonaPrompt(personaId) {
  const found = personas.find((p) => p.id === personaId);
  return found ? found.prompt : "";
}

async function startNewMatch() {
  settings = loadSettings();
  document.getElementById("game-log").innerHTML = "";

  const isAiVsAi = settings.matchMode === "ai_vs_ai";
  const personaObj = personas.find((p) => p.id === settings.oppPersona);
  const oppLabel =
    settings.oppModel === "builtin"
      ? "内蔵AI"
      : `Gemini (${personaObj ? personaObj.name : "AI"})`;

  gameState = createMatchState({
    mode: "2p",
    tileSet: settings.tileSet,
    players: [
      {
        id: "p0",
        name: isAiVsAi ? "Gemini-東 (攻撃型)" : "あなた",
        control: isAiVsAi ? "ai" : "human",
        aiConfig: isAiVsAi
          ? {
              provider: "gemini",
              model: settings.oppModel,
              personaId: "aggressive_riichi",
              customPrompt: ""
            }
          : null
      },
      {
        id: "p1",
        name: oppLabel,
        control: "ai",
        aiConfig: {
          provider: "gemini",
          model: settings.oppModel,
          personaId: settings.oppPersona,
          customPrompt: settings.customPrompt
        }
      }
    ]
  });

  await syncAdapter.saveState(gameState);
  appendLog(`新規対局を開始しました（${isAiVsAi ? "AI vs AI 観戦" : "人間 vs AI"}）`);
  refreshUI();
  await stepGameLoop();
}

function refreshUI() {
  renderGame(
    gameState,
    { openHand, oppThinking },
    {
      onHumanDiscard: (tileId) => {
        const label = tileIdToLabel(tileId, gameState.config.redDora);
        handlePlayerAction(0, { action: "discard", tile: label, tileId });
      },
      onHumanAction: (actionObj) => {
        handlePlayerAction(0, actionObj);
      }
    }
  );
}

async function handlePlayerAction(seatIndex, actionObj, meta = {}) {
  if (isProcessing || gameState.status !== "playing") return;
  isProcessing = true;

  try {
    const actor = gameState.players[seatIndex];
    gameState = applyAction(gameState, seatIndex, actionObj, meta);
    await syncAdapter.saveState(gameState);

    if (actionObj.action === "discard") {
      appendLog(`${actor.name}: ${actionObj.tile} 切り`);
    } else if (actionObj.action === "riichi") {
      appendLog(`🔥 ${actor.name}: リーチ宣言！（${actionObj.tile} 切り）`);
    } else if (actionObj.action === "tsumo") {
      appendLog(`🀄 ${actor.name}: ツモ和了！`);
    } else if (actionObj.action === "ron") {
      appendLog(`⚡ ${actor.name}: ロン和了！`);
    } else if (actionObj.action === "pass") {
      appendLog(`${actor.name}: ロン見送り`);
    }

    refreshUI();

    if (gameState.status === "round_end") {
      isProcessing = false;
      showRoundResultModal(gameState);
      return;
    }
  } finally {
    isProcessing = false;
  }

  await stepGameLoop();
}

/**
 * 次の手番またはロン判定対象がAIなら自動でAI思考を実行
 */
async function stepGameLoop() {
  if (gameState.status !== "playing") return;

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

  oppThinking = targetSeat === 1;
  refreshUI();

  // UI描画反映と観戦テンポのための短いウェイト
  await new Promise((r) => setTimeout(r, 450));

  const aiPlayer = gameState.players[targetSeat];
  const personaPrompt = getPersonaPrompt(aiPlayer.aiConfig?.personaId);

  const decision = await decideAiMove({
    state: gameState,
    seatIndex: targetSeat,
    apiKey: settings.apiKey,
    baseRulesMd,
    personaPrompt
  });

  oppThinking = false;
  await handlePlayerAction(targetSeat, decision.actionObj, {
    thought: decision.thought,
    talk: decision.talk
  });
}

function bindEvents() {
  document.getElementById("btn-new-game").addEventListener("click", () => startNewMatch());

  document.getElementById("chk-open-hand").addEventListener("change", (e) => {
    openHand = e.target.checked;
    refreshUI();
  });

  // 設定モーダル
  const settingsModal = document.getElementById("settings-modal");
  document.getElementById("btn-settings").addEventListener("click", () => {
    const s = loadSettings();
    document.getElementById("input-api-key").value = s.apiKey;
    document.getElementById("select-match-mode").value = s.matchMode;
    document.getElementById("select-tileset").value = s.tileSet;
    document.getElementById("select-opp-model").value = s.oppModel;
    document.getElementById("select-opp-persona").value = s.oppPersona;
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
      tileSet: document.getElementById("select-tileset").value,
      oppModel: document.getElementById("select-opp-model").value,
      oppPersona: document.getElementById("select-opp-persona").value,
      customPrompt: document.getElementById("input-custom-prompt").value.trim()
    });
    settingsModal.close();
    await startNewMatch();
  });

  // 局結果モーダル -> 次局へ
  document.getElementById("btn-next-round").addEventListener("click", async () => {
    document.getElementById("result-modal").close();
    const n = gameState.players.length;
    const res = gameState.lastResult;
    const dealerWon =
      res.winners && res.winners.some((w) => w.seatIndex === gameState.round.dealerIndex);
    const nextDealer = dealerWon
      ? gameState.round.dealerIndex
      : (gameState.round.dealerIndex + 1) % n;

    gameState = startNewRound(gameState, nextDealer, dealerWon);
    await syncAdapter.saveState(gameState);
    appendLog(`--- 次局開始 ---`);
    refreshUI();
    await stepGameLoop();
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
    alert("現在の盤面Markdownをクリップボードにコピーしました");
  });

  document.getElementById("btn-close-md").addEventListener("click", () => {
    mdModal.close();
  });
}

(async function init() {
  await loadExternalAssets();
  bindEvents();
  await startNewMatch();
})();
