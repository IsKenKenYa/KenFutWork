/**
 * 网络设置保存的统一失败提示：服务端的校验原因已在服务端记录，
 * 界面只给用户「怎么改」的一句话，并把控件保持为旧值（调用方只在成功时更新状态）。
 */
export interface NetworkSettingSaveHints {
  /** 保存成功后的提示。 */
  savedHint: string;
  /** 服务端拒绝后提示用户如何填写。 */
  invalidHint: string;
}

export async function saveNetworkSetting(options: {
  save: () => Promise<unknown>;
  notify: (message: string) => void;
  hints: NetworkSettingSaveHints;
}): Promise<boolean> {
  try {
    await options.save();
  } catch {
    options.notify(options.hints.invalidHint);
    return false;
  }
  options.notify(options.hints.savedHint);
  return true;
}
