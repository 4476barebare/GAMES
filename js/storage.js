/**
 * storage.js
 * 座席別のモデル・APIキー・性格設定および進行中対局（gameState＋ログ）の自動保存・自動復帰管理
 */

const SETTINGS_KEY = "ai_mahjong_arena_settings_4p_v3";
const SESSION_KEY = "ai_mahjong_arena_saved_match_4p_v3";

const DEFAULT_SETTINGS = {
  matchMode: "human_vs_ai",
  globalApiKey: "",
  seats: [
    { model: "builtin", apiKey: "", personaId: "occult_flow", customPrompt: "" },
    { model: "builtin", apiKey: "", personaId: "digital_balanced", customPrompt: "" },
    { model: "builtin", apiKey: "", personaId: "aggressive_riichi", customPrompt: "" },
    { model: "builtin", apiKey: "", personaId: "iron_defense", customPrompt: "" }
  ]
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    const seats = DEFAULT_SETTINGS.seats.map((def, i) => ({
      ...def,
      ...(parsed.seats && parsed.seats[i] ? parsed.seats[i] : {})
    }));
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      seats
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(nextSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(nextSettings));
  return nextSettings;
}

export function saveMatchSession(gameState, logs = []) {
  try {
    const payload = {
      savedAt: Date.now(),
      gameState,
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
    return parsed;
  } catch {
    return null;
  }
}

export function clearMatchSession() {
  localStorage.removeItem(SESSION_KEY);
}
