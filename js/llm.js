/**
 * llm.js
 * Gemini API 通信・Structured Outputs（チー赤5識別/ポン/カン対応）
 * ・座席別APIキーは storage.js から通信時のみ取得（gameState には保持しない）
 * ・APIトークン／クォータ超過・認証エラー時は該当席をその半荘のみ自動で内蔵簡易AIへ切替
 */

import { labelToKind } from "./tiles.js";
import { getLegalActions, chooseFallbackAction } from "./engine.js";
import { buildTurnPromptMarkdown } from "./markdown.js";
import { getSeatApiKey } from "./storage.js";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    action: {
      type: "STRING",
      enum: ["discard", "riichi", "tsumo", "ron", "pon", "chi", "daiminkan", "ankan", "kakan", "pass"]
    },
    tile: {
      type: "STRING",
      description: "対象となる牌表記（例: 東, 9s, 0m）。pass時は空文字。"
    },
    consume: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "actionがchiの場合のみ、手牌から出す2枚の牌表記（例: ['2m', '3m'] または ['0m', '6m']）。それ以外は空配列。"
    },
    thought: {
      type: "STRING",
      description: "選択理由・押し引きの読み（60〜120文字程度の日本語）"
    },
    talk: {
      type: "STRING",
      description: "卓上に向けた短い一言セリフ（30文字以内）"
    }
  },
  required: ["action", "tile", "consume", "thought", "talk"]
};

function matchLegalAction(legalActions, rawDecision) {
  if (!rawDecision || !rawDecision.action) return null;
  const actType = rawDecision.action;

  if (["tsumo", "ron", "pass", "pon", "daiminkan"].includes(actType)) {
    return legalActions.find((a) => a.action === actType) || null;
  }

  if (actType === "chi") {
    const chiOptions = legalActions.filter((a) => a.action === "chi");
    if (chiOptions.length === 0) return null;
    if (chiOptions.length === 1) return chiOptions[0];

    const reqLabels = Array.isArray(rawDecision.consume)
      ? rawDecision.consume.map((s) => String(s).trim()).sort()
      : [];

    // 1. 赤5（0m/0p/0s）と通常5を区別した完全一致を優先
    const exactMatch = chiOptions.find((opt) => {
      const optLabels = opt.consume.map((s) => String(s).trim()).sort();
      return optLabels.length === reqLabels.length && optLabels.every((v, i) => v === reqLabels[i]);
    });
    if (exactMatch) return exactMatch;

    // 2. フォールバック：種類（kind）一致
    const reqKinds = Array.isArray(rawDecision.consume)
      ? rawDecision.consume.map(labelToKind).sort((a, b) => a - b)
      : [];
    const kindMatch = chiOptions.find((opt) => {
      const optKinds = opt.consume.map(labelToKind).sort((a, b) => a - b);
      return optKinds.length === reqKinds.length && optKinds.every((v, i) => v === reqKinds[i]);
    });
    return kindMatch || chiOptions[0];
  }

  if (["discard", "riichi", "ankan", "kakan"].includes(actType)) {
    const exact = legalActions.find(
      (a) => a.action === actType && a.tile === String(rawDecision.tile).trim()
    );
    if (exact) return exact;

    const targetKind = labelToKind(rawDecision.tile);
    if (targetKind !== -1) {
      const kindMatch = legalActions.find(
        (a) => a.action === actType && labelToKind(a.tile) === targetKind
      );
      if (kindMatch) return kindMatch;
    }
  }
  return null;
}

function classifyQuotaOrAuthError(status, errText) {
  const body = String(errText || "");
  const isQuotaPattern =
    /RESOURCE_EXHAUSTED|QUOTA|RATE_LIMIT|INSUFFICIENT_QUOTA|BILLING|TOKEN.*LIMIT|EXCEEDED/i.test(
      body
    );
  const isAuthPattern = /API_KEY_INVALID|INVALID_ARGUMENT.*API.?KEY|PERMISSION_DENIED|UNAUTHENTICATED/i.test(
    body
  );

  if (status === 429 || status === 402 || isQuotaPattern) {
    return {
      shouldSwitchToBuiltin: true,
      shortReason: `HTTP ${status} / APIトークン・クォータ上限到達`
    };
  }
  if (status === 401 || status === 403 || isAuthPattern) {
    return {
      shouldSwitchToBuiltin: true,
      shortReason: `HTTP ${status} / APIキー認証・権限エラー`
    };
  }
  return {
    shouldSwitchToBuiltin: false,
    shortReason: `HTTP ${status}`
  };
}

async function callGeminiEndpoint({ apiKey, model, systemPrompt, userPrompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    const classified = classifyQuotaOrAuthError(res.status, errText);
    const err = new Error(`Gemini API Error (${res.status}): ${errText.slice(0, 140)}`);
    err.shouldSwitchToBuiltin = classified.shouldSwitchToBuiltin;
    err.shortReason = classified.shortReason;
    throw err;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini API returned empty content");

  return JSON.parse(text);
}

function buildBuiltinDecision(state, seatIndex, prefixNote = "") {
  const player = state.players[seatIndex];
  const fallback = chooseFallbackAction(state, seatIndex);
  const talkMap = {
    riichi: "リーチ！勝負だ。",
    tsumo: "ツモ！いただきました。",
    ron: "ロン！そこだ！",
    pon: "ポン！",
    chi: "チー！",
    daiminkan: "カン！",
    ankan: "暗槓！",
    kakan: "加槓！",
    pass: "ここはスルー。",
    discard: `よし、${fallback.tile}切り。`
  };
  const tag = prefixNote ? `${prefixNote} ` : "";
  return {
    actionObj: fallback,
    thought: `${tag}[内蔵:${player.aiConfig?.personaId || "standard"}] ${fallback.action}${
      fallback.tile ? " (" + fallback.tile + ")" : ""
    } を選択。`,
    talk: talkMap[fallback.action] || "これで行こう。",
    switchedToBuiltin: false,
    switchReason: ""
  };
}

export async function decideAiMove({ state, seatIndex, baseRulesMd, personaPrompt }) {
  const player = state.players[seatIndex];
  const legalActions = getLegalActions(state, seatIndex);
  const model = player.aiConfig?.model || "builtin";

  // 既にこの半荘でトークン切れ等により内蔵AIへ自動切替済みの場合はAPIを叩かない
  if (player.aiConfig?.fallbackActive) {
    return buildBuiltinDecision(state, seatIndex, "[API上限切替中]");
  }

  const effectiveApiKey = getSeatApiKey(seatIndex);
  if (!effectiveApiKey || model === "builtin") {
    return buildBuiltinDecision(state, seatIndex);
  }

  const customRule = player.aiConfig?.customPrompt
    ? `\n# 追加の特別作戦指示\n${player.aiConfig.customPrompt}\n`
    : "";

  const systemPrompt = `${baseRulesMd}\n\n# あなたのキャラクター・打ち筋\n${personaPrompt}${customRule}`;
  const userPrompt = buildTurnPromptMarkdown(state, seatIndex);

  try {
    const decision1 = await callGeminiEndpoint({
      apiKey: effectiveApiKey,
      model,
      systemPrompt,
      userPrompt
    });
    const valid1 = matchLegalAction(legalActions, decision1);
    if (valid1) {
      return {
        actionObj: valid1,
        thought: decision1.thought || "",
        talk: decision1.talk || "",
        switchedToBuiltin: false,
        switchReason: ""
      };
    }

    const retryPrompt = `${userPrompt}\n\n【エラー修正指示】前回の回答 \`${JSON.stringify(decision1)}\` は合法アクション一覧に含まれていません。必ずセクション5のリストにある有効な行動を選び直してください。`;

    const decision2 = await callGeminiEndpoint({
      apiKey: effectiveApiKey,
      model,
      systemPrompt,
      userPrompt: retryPrompt
    });
    const valid2 = matchLegalAction(legalActions, decision2);
    if (valid2) {
      return {
        actionObj: valid2,
        thought: decision2.thought || "",
        talk: decision2.talk || "",
        switchedToBuiltin: false,
        switchReason: ""
      };
    }

    throw new Error("AI failed to return a legal move after retry");
  } catch (err) {
    console.warn("AI fallback triggered:", err);
    const fallback = chooseFallbackAction(state, seatIndex);

    if (err.shouldSwitchToBuiltin) {
      const reason = err.shortReason || "API上限到達";
      return {
        actionObj: fallback,
        thought: `[自動切替: ${reason}] この半荘の残りは内蔵簡易AIで続行します。`,
        talk: "思考回路が限界だ…ここからは直感で打つ！",
        switchedToBuiltin: true,
        switchReason: reason
      };
    }

    return {
      actionObj: fallback,
      thought: `[自動補正: ${err.message}] 内蔵AI推奨手を実行しました。`,
      talk: "おっと、手元が狂ったな…",
      switchedToBuiltin: false,
      switchReason: ""
    };
  }
}
