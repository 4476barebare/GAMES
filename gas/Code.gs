/**
 * [ver.1.0 拡張用スタブ]
 * Google スプレッドシートの "Rooms" シートと接続して
 * 4人麻雀ロビー募集および gameState JSON 同期を行うGASスクリプト雛形
 */

const SHEET_NAME = "Rooms";

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "list";
  if (action === "list") {
    return jsonResponse({ status: "ok", rooms: [] });
  }
  return jsonResponse({ status: "ok", message: "AI Mahjong Arena 4P GAS endpoint ready" });
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || "{}");
  return jsonResponse({ status: "ok", receivedAction: body.action || null });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
