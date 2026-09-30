/**
 * zcode 照搬：`@/lib/taskNotificationPreferences.ts`（references/zcode/packages/ui/src/lib/taskNotificationPreferences.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
const TASK_NOTIFICATION_ENABLED_STORAGE_KEY = "zcode-notification-enabled";
const TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY =
  "zcode-notification-sound-enabled";

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value == null) {
      return defaultValue;
    }

    return value !== "false";
  } catch {
    return defaultValue;
  }
}

function persistStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage 不可用时静默忽略，保持 UI 主流程可继续工作。
  }
}

export function isTaskNotificationEnabled(): boolean {
  return readStoredBoolean(TASK_NOTIFICATION_ENABLED_STORAGE_KEY, true);
}

export function isTaskNotificationSoundPreferenceEnabled(): boolean {
  return readStoredBoolean(TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, true);
}

export function isTaskNotificationSoundEnabled(): boolean {
  // 通知声音是任务通知的子能力，之前只有一个总开关时，
  // UI 无法表达“保留桌面通知但关闭提示音”，运行时也不知道声音必须依附通知存在。
  // 这里把声音偏好拆出来，但读取最终生效值时仍强制叠加通知总开关，
  // 保证设置页禁用态和实际播放行为一致，不会出现“通知关了却还能响”的错位。
  return (
    isTaskNotificationEnabled() && isTaskNotificationSoundPreferenceEnabled()
  );
}

export function persistTaskNotificationEnabled(enabled: boolean): void {
  persistStoredBoolean(TASK_NOTIFICATION_ENABLED_STORAGE_KEY, enabled);
}

export function persistTaskNotificationSoundEnabled(enabled: boolean): void {
  persistStoredBoolean(TASK_NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, enabled);
}
