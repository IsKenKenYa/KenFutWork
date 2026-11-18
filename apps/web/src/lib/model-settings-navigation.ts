const MODEL_SETTINGS_OPEN_EVENT = "kenfutwork:open-model-settings";

/** 旧Web入口只发导航意图；管理文档仍由工作台唯一持有。 */
export function requestModelSettingsOpen(): void {
  window.dispatchEvent(new Event(MODEL_SETTINGS_OPEN_EVENT));
}

export function addModelSettingsOpenListener(listener: () => void): () => void {
  window.addEventListener(MODEL_SETTINGS_OPEN_EVENT, listener);
  return () => window.removeEventListener(MODEL_SETTINGS_OPEN_EVENT, listener);
}
