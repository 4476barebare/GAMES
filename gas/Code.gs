/**
 * [ver.1.0 拡張用スタブ]
 * 将来的に Google スプレッドシートの "Rooms" シートと接続して
 * 2人打ち・4人打ちのロビー募集および gameState JSON 同期を行うGASスクリプト雛形
 */

const SHEET_NAME = "Rooms";

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "list";
  if (action === "list") {
    return jsonResponse({ status: "ok", rooms: [] });
  }
  return jsonResponse({ status: "ok", message: "AI Mahjong Arena GAS endpoint ready" });
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
