const messages: ReadonlyMap<string, string> = new Map([
  ["submission_unknown", "提交结果待确认，请核对供应商记录。"],
  ["provider_balance_insufficient", "供应商额度不足，请检查账户余额。"],
  ["provider_auth_failed", "供应商拒绝访问，请在供应商设置中检查密钥和权限。"],
  ["provider_rate_limited", "供应商请求过多，请稍后重试。"],
  ["provider_config_stale", "供应商配置已更新，请核对原任务后再操作。"],
  ["provider_task_failed", "供应商已确认生成失败，请核对供应商任务记录。"],
  ["video_job_timeout", "视频任务已超时，请核对供应商任务记录。"],
  ["safety_filter", "供应商未通过内容审核，请调整输入。"],
  ["media_input_audio_copyright", "参考音频可能涉及版权限制，请更换音频。"],
  [
    "media_output_audio_copyright",
    "生成的音频可能涉及版权限制，请调整提示词或参考素材。",
  ],
  [
    "media_task_type_constraint",
    "生成参数与模型识别的任务类型不兼容，请检查生成设置。",
  ],
  [
    "media_task_type_mismatch",
    "模型识别的任务类型与请求不一致，请调整提示词和参考素材。",
  ],
  ["invalid_input", "生成参数无效，请检查模型和参考素材。"],
  ["unsupported_parameter", "当前模型不支持此参数，请修改生成设置。"],
  ["no_output", "供应商未返回可用内容，请检查生成参数。"],
  ["media_output_save_failed", "生成结果保存失败，请检查存储空间和写入权限。"],
  [
    "media_output_publish_failed",
    "生成结果添加失败，请检查目标画布或文件权限。",
  ],
]);

export function getMediaJobErrorMessage(code: string | null | undefined) {
  return code == null ? undefined : messages.get(code);
}
