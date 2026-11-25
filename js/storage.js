/**
 * storage.js
 * 座席別のモデル・APIキー・性格設定および進行中対局（gameState＋ログ）の自動保存・自動復帰管理
 * ※ gameState 内には apiKey を絶対に保存せず、座席別APIキーは本モジュールの設定からのみ参照する
 */

const SETTINGS_KEY = "ai_mahjong_arena_settings_4p_v5";
const SESSION_KEY = "ai_mahjong_arena_saved_match_4p_v5";

const DEFAULT_SETTINGS = {
  matchMode: "human_vs_ai",
  seats: [
    { model: "builtin", apiKey: "", personaId: "occult_flow", customPrompt: "" },
    { model: "builtin", apiKey: "", personaId: "digital_balanced", customPrompt: "" },
    { model: "builtin", apiKey: "", personaId: "aggressive_riichi", customPrompt: "" },
    { model: "builtin", apiKey: "", personaId: "iron_defense", customPrompt: "" }
  ]
};

function normalizeSeatConfig(raw, def) {
  return {
    model: typeof raw?.model === "string" && raw.model ? raw.model : def.model,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey.trim() : def.apiKey,
    personaId: typeof raw?.personaId === "string" && raw.personaId ? raw.personaId : def.personaId,
    customPrompt: typeof raw?.customPrompt === "string" ? raw.customPrompt : def.customPrompt
  };
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    const seats = DEFAULT_SETTINGS.seats.map((def, i) =>
      normalizeSeatConfig(parsed.seats && parsed.seats[i] ? parsed.seats[i] : {}, def)
    );
    const matchMode =
      parsed.matchMode === "ai_vs_ai" ? "ai_vs_ai" : "human_vs_ai";
    return {
      matchMode,
      seats
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(nextSettings) {
  const sanitized = {
    matchMode: nextSettings?.matchMode === "ai_vs_ai" ? "ai_vs_ai" : "human_vs_ai",
    seats: DEFAULT_SETTINGS.seats.map((def, i) =>
      normalizeSeatConfig(nextSettings?.seats && nextSettings.seats[i] ? nextSettings.seats[i] : {}, def)
    )
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
  return sanitized;
}

export function getSeatApiKey(seatIndex) {
  const s = loadSettings();
  const key = s.seats?.[seatIndex]?.apiKey;
  return typeof key === "string" ? key.trim() : "";
}

export function sanitizeGameStateSecrets(gameState) {
  if (!gameState || !Array.isArray(gameState.players)) return gameState;
  const cleaned = structuredClone(gameState);
  for (const p of cleaned.players) {
    if (p && p.aiConfig && "apiKey" in p.aiConfig) {
      delete p.aiConfig.apiKey;
    }
  }
  return cleaned;
}

export function saveMatchSession(gameState, logs = []) {
  try {
    const safeState = sanitizeGameStateSecrets(gameState);
    const payload = {
      savedAt: Date.now(),
      gameState: safeState,
      logs: logs.slice(0, 120)
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Session save failed:", e);
  }
}

export function loadMatchSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.gameState || !Array.isArray(parsed.gameState.players)) {
      return null;
    }
    if (parsed.gameState.players.length !== 4) return null;
    parsed.gameState = sanitizeGameStateSecrets(parsed.gameState);
    return parsed;
  } catch {
    return null;
  }
}

export function clearMatchSession() {
  localStorage.removeItem(SESSION_KEY);
}
