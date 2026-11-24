/**
 * storage.js
 * 設定・APIキーおよび進行中対局（gameState＋ログ）の自動保存・自動復帰管理
 */

const SETTINGS_KEY = "ai_mahjong_arena_settings_4p_v1";
const SESSION_KEY = "ai_mahjong_arena_saved_match_4p_v1";

const DEFAULT_SETTINGS = {
  apiKey: "",
  matchMode: "human_vs_ai",
  aiModel: "builtin",
  persona1: "digital_balanced",
  persona2: "aggressive_riichi",
  persona3: "iron_defense",
  customPrompt: ""
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/**
 * 進行中の gameState とログ一覧を即座に自動保存（リロード耐性）
 */
export function saveMatchSession(gameState, logs = []) {
  try {
    const payload = {
      savedAt: Date.now(),
      gameState,
      logs: logs.slice(0, 120) // 最新120件を保持
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("Session save failed:", e);
  }
}

/**
 * 保存済みの対局セッションを復元（存在しない・破損時は null）
 */
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
