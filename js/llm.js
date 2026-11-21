/**
 * llm.js
 * Gemini API 通信・Structured Outputs・合法手バリデーション・自動リトライ＆フォールバック
 */

import { labelToKind } from "./tiles.js";
import { getLegalActions, chooseFallbackAction } from "./engine.js";
import { buildTurnPromptMarkdown } from "./markdown.js";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    action: {
      type: "STRING",
      enum: ["discard", "riichi", "tsumo", "ron", "pass"]
    },
    tile: {
      type: "STRING",
      description: "discardまたはriichi時に切る牌表記（例: 東, 9s, 0m）。それ以外は空文字。"
    },
    thought: {
      type: "STRING",
      description: "選択理由・押し引きの読み（60〜120文字程度の日本語）"
    },
    talk: {
      type: "STRING",
      description: "対戦相手に向けた短い一言セリフ（30文字以内）"
    }
  },
  required: ["action", "tile", "thought", "talk"]
};

function matchLegalAction(legalActions, rawDecision) {
  if (!rawDecision || !rawDecision.action) return null;
  const actType = rawDecision.action;

  if (actType === "tsumo" || actType === "ron" || actType === "pass") {
    return legalActions.find((a) => a.action === actType) || null;
  }

  if (actType === "discard" || actType === "riichi") {
    const exact = legalActions.find(
      (a) => a.action === actType && a.tile === String(rawDecision.tile).trim()
    );
    if (exact) return exact;

    // 表記ゆれ（"1z" vs "東" 等）を kindId で吸収
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
    throw new Error(`Gemini API Error (${res.status}): ${errText.slice(0, 160)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini API returned empty content");

  return JSON.parse(text);
}

/**
 * AIプレイヤーの次の一手を決定（3段階バリデーション＆フォールバック付き）
 */
export async function decideAiMove({ state, seatIndex, apiKey, baseRulesMd, personaPrompt }) {
  const player = state.players[seatIndex];
  const legalActions = getLegalActions(state, seatIndex);
  const model = player.aiConfig?.model || "gemini-4-hydrogen";

  // APIキー未設定または内蔵AI指定時は即座に内蔵エンジンで判断
  if (!apiKey || model === "builtin") {
    const fallback = chooseFallbackAction(state, seatIndex);
    return {
      actionObj: fallback,
      thought: `内蔵エンジン解析により ${fallback.action}${fallback.tile ? " (" + fallback.tile + ")" : ""} を選択。`,
      talk: fallback.action === "riichi" ? "リーチ！" : fallback.action === "tsumo" ? "ツモ！" : "よし、これだ。"
    };
  }

  const customRule = player.aiConfig?.customPrompt
    ? `\n# 追加の特別作戦指示\n${player.aiConfig.customPrompt}\n`
    : "";

  const systemPrompt = `${baseRulesMd}\n\n# あなたのキャラクター・打ち筋\n${personaPrompt}${customRule}`;
  const userPrompt = buildTurnPromptMarkdown(state, seatIndex);

  try {
    // 1回目リクエスト
    const decision1 = await callGeminiEndpoint({
      apiKey,
      model,
      systemPrompt,
      userPrompt
    });
    const valid1 = matchLegalAction(legalActions, decision1);
    if (valid1) {
      return {
        actionObj: valid1,
        thought: decision1.thought || "",
        talk: decision1.talk || ""
      };
    }

    // 2回目自動リトライ（不正手修正）
    const retryPrompt = `${userPrompt}\n\n【エラー修正指示】前回の回答 \`${JSON.stringify(
      decision1
    )}\` は合法アクション一覧に含まれていません。必ずセクション5のリストにある有効な行動と牌を選び直してください。`;

    const decision2 = await callGeminiEndpoint({
      apiKey,
      model,
      systemPrompt,
      userPrompt: retryPrompt
    });
    const valid2 = matchLegalAction(legalActions, decision2);
    if (valid2) {
      return {
        actionObj: valid2,
        thought: decision2.thought || "",
        talk: decision2.talk || ""
      };
    }

    throw new Error("AI failed to return a legal move after retry");
  } catch (err) {
    console.warn("AI fallback triggered:", err);
    const fallback = chooseFallbackAction(state, seatIndex);
    return {
      actionObj: fallback,
      thought: `[自動補正: ${err.message}] エンジン推奨手を実行しました。`,
      talk: "おっと、手元が狂ったな…"
    };
  }
}
