/**
 * sync.js
 * [ver.1.0 GASオンライン対戦拡張用インターフェース]
 * ver.0.2 では localStorage への自動保存と連携し、ver.1.0 で GAS Webアプリへ差し替える。
 */

import { saveMatchSession, loadMatchSession } from "./storage.js";

export class LocalSyncAdapter {
  async saveState(state, logs = []) {
    saveMatchSession(state, logs);
    return state;
  }

  async fetchState() {
    const session = loadMatchSession();
    return session ? session.gameState : null;
  }
}
