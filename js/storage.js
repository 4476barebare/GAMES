/**
 * storage.js
 * 座席別設定・APIキー・オートツモ切り・進行中対局（gameState＋ログ）の自動保存管理
 */

const SETTINGS_KEY = "ai_mahjong_arena_settings_4p_v3";
const SESSION_KEY = "ai_mahjong_arena_saved_match_4p_v3";

const DEFAULT_SETTINGS = {
  apiKey: "",
  matchMode: "human_vs_ai",
  autoRiichiTsumogiri: true,
  seats: [
    { model: "builtin", personaId: "digital_balanced", apiKey: "" },
    { model: "builtin", personaId: "digital_balanced", apiKey: "" },
    { model: "builtin", personaId: "aggressive_riichi", apiKey: "" },
    { model: "builtin", personaId: "iron_defense", apiKey: "" }
  ],
  customPrompt: ""
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    const merged = { ...structuredClone(DEFAULT_SETTINGS), ...parsed };
    if (!Array.isArray(merged.seats) || merged.seats.length !== 4) {
      merged.seats = structuredClone(DEFAULT_SETTINGS.seats);
    }
    return merged;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
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
