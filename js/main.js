/**
 * main.js
 * 4人麻雀（半荘・鳴きあり・2段階タップ打牌・手牌黄色枠スルー）統括
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
  showRoundResultModal,
  showMatchEndModal
} from "./ui.js";

const SEAT_NAMES = ["自席（手前）", "下家（右）", "対面（上）", "上家（左）"];
const SEAT_SHORT = ["自", "下", "対", "上"];

let gameState = null;
let gameLogs = [];
let settings = loadSettings();
let baseRulesMd = "";
let personas = [];
let openHand = false;
let thinkingSeat = null;
let selectedTileId = null; // 2段階タップ打牌用：1回目タップで選択中のtileId
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
      { id: "aggressive_riichi", name: "超攻撃型", prompt: "聴牌即リーチと仕掛けで押し返します。" },
      { id: "occult_flow", name: "オカルト派", prompt: "ドラと流れを重視します。" },
      { id: "iron_defense", name: "鉄壁守備派", prompt: "放銃回避を最優先します。" }
    ];
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

function buildSeatDisplayName(seatIndex, seatCfg) {
  const tag = seatCfg.model === "builtin" ? "内蔵" : "AI";
  return `${SEAT_SHORT[seatIndex]}・${tag}(${getPersonaName(seatCfg.personaId)})`;
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
  const playersCfg = [0, 1, 2, 3].map((idx) => {
    const sCfg = settings.seats[idx];
    if (idx === 0 && !isAiVsAi) {
      return { id: "p0", name: "あなた", control: "human", aiConfig: null };
    }
    return {
      id: `p${idx}`,
      name: buildSeatDisplayName(idx, sCfg),
      control: "ai",
      aiConfig: {
        provider: "gemini",
        model: sCfg.model,
        apiKey: sCfg.apiKey,
        personaId: sCfg.personaId,
        customPrompt: sCfg.customPrompt
      }
    };
  });

  gameState = createMatchState({ players: playersCfg });

  pushLog(`新規4人半荘を開始（${isAiVsAi ? "AI 4人観戦" : "人間 vs AI 3人"}）`);
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
      // 2段階タップ打牌：1回目タップで選択枠移動、2回目同じ牌タップで打牌確定
      onHumanTileTap: (tileId) => {
        if (selectedTileId === tileId) {
          selectedTileId = null;
          const label = tileIdToLabel(tileId, gameState.config.redDora);
          handlePlayerAction(0, { action: "discard", tile: label, tileId }, {}, loopToken);
        } else {
          selectedTileId = tileId;
          refreshUI();
        }
      },
      // 鳴き判定中に手牌（黄色枠）タップでスルー
      onHumanPass: () => {
        selectedTileId = null;
        handlePlayerAction(0, { action: "pass", tile: "" }, {}, loopToken);
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
  selectedTileId = null;

  try {
    const actor = gameState.players[seatIndex];
    gameState = applyAction(gameState, seatIndex, actionObj, meta);

    const logMap = {
      discard: `${actor.name}: ${actionObj.tile} 切り`,
      riichi: `🔥 ${actor.name}: リーチ宣言！（${actionObj.tile} 切り）`,
      tsumo: `🀄 ${actor.name}: ツモ和了！`,
      ron: `⚡ ${actor.name}: ロン宣言！`,
      pon: `📣 ${actor.name}: ポン（${actionObj.tile}）`,
      chi: `📣 ${actor.name}: チー（${actionObj.tile}）`,
      daiminkan: `💥 ${actor.name}: 大明槓（${actionObj.tile}）`,
      ankan: `💥 ${actor.name}: 暗槓（${actionObj.tile}）`,
      kakan: `💥 ${actor.name}: 加槓（${actionObj.tile}）`,
      pass: `${actor.name}: スルー`
    };
    if (logMap[actionObj.action]) pushLog(logMap[actionObj.action]);

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

  const aiPlayer = gameState.players[targetSeat];
  const hasApi =
    Boolean((aiPlayer.aiConfig?.apiKey || settings.globalApiKey || "").trim()) &&
    aiPlayer.aiConfig?.model !== "builtin";
  const waitMs = hasApi ? 300 : 220;
  await new Promise((r) => setTimeout(r, waitMs));
  if (token !== loopToken) return;

  const personaPrompt = getPersonaPrompt(aiPlayer.aiConfig?.personaId);
  const decision = await decideAiMove({
    state: gameState,
    seatIndex: targetSeat,
    fallbackApiKey: settings.globalApiKey,
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

function renderSeatSettingsForm(currentSettings) {
  const listEl = document.getElementById("seat-config-list");
  listEl.innerHTML = "";

  [0, 1, 2, 3].forEach((idx) => {
    const sCfg = currentSettings.seats[idx];
    const card = document.createElement("div");
    card.className = "seat-cfg-card";
    const note = idx === 0 ? " ※AI観戦モード時に有効" : "";
    const personaOptions = personas
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === sCfg.personaId ? "selected" : ""}>${p.name}</option>`
      )
      .join("");

    card.innerHTML = `
      <div class="seat-cfg-title">${SEAT_NAMES[idx]}${note}</div>
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
          <span>性格・打ち筋</span>
          <select id="seat-persona-${idx}">${personaOptions}</select>
        </label>
        <label class="field">
          <span>個別 Gemini API Key</span>
          <input type="password" id="seat-apikey-${idx}" value="${sCfg.apiKey || ""}" placeholder="AIzaSy... (空欄なら共通キー)" autocomplete="off" />
        </label>
      </div>
      <label class="field">
        <span>個別作戦指示（任意）</span>
        <input type="text" id="seat-prompt-${idx}" value="${sCfg.customPrompt || ""}" placeholder="例：役牌を積極的に鳴いてスピード重視" />
      </label>
    `;
    listEl.appendChild(card);
  });
}

function bindEvents() {
  document.getElementById("btn-new-game").addEventListener("click", () => {
    if (confirm("現在の半荘を破棄して、東1局から新しく始めますか？")) {
      startNewMatch();
    }
  });

  const openBtn = document.getElementById("btn-toggle-open");
  openBtn.addEventListener("click", () => {
    openHand = !openHand;
    openBtn.textContent = `公開:${openHand ? "ON" : "OFF"}`;
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
    document.getElementById("select-match-mode").value = s.matchMode;
    document.getElementById("input-global-api-key").value = s.globalApiKey || "";
    renderSeatSettingsForm(s);
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
      globalApiKey: document.getElementById("input-global-api-key").value.trim(),
      seats: nextSeats
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
