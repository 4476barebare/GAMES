/**
 * sync.js
 * [ver.1.0 GASオンライン対戦拡張用インターフェース]
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
