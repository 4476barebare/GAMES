/**
 * storage.js
 * ブラウザ内 localStorage による APIキー・対局設定の永続化（外部サーバー非送信）
 */

const STORAGE_KEY = "ai_mahjong_arena_settings_v0";

const DEFAULT_SETTINGS = {
  apiKey: "",
  matchMode: "human_vs_ai",
  tileSet: "full136",
  oppModel: "gemini-4-hydrogen",
  oppPersona: "digital_balanced",
  customPrompt: ""
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
