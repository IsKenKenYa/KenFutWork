/**
 * HA 配置流表单的「免人工」取值规则（纯函数，便于单测）。
 *
 * 用户口径（2026-10-26）：「米家授权完之后自动全部导入，不要让我手动配置」。
 * 授权完成后的步骤都是纯选项（选家庭、区域命名、过滤器），可以按 schema 推出来；
 * 一旦出现没有默认值的文本/密码字段，就必须停下来交给用户本人。
 */

/** options 的三种形状（`[[value,label]]` / `[value]` / `{value: label}`）取 value 列表。 */
export function optionValues(options) {
  if (Array.isArray(options)) {
    return options.map((option) =>
      String(Array.isArray(option) ? option[0] : option),
    );
  }
  return Object.keys(options ?? {});
}

/**
 * 推导整张表单的值；返回 `null` 表示这一步必须人工填写。
 *
 * - `boolean`：用 `default`（缺省 false）。
 * - `select`：用 `default`，否则取第一项。
 * - `multi_select`：有非空 `default` 用它；**必选**且无默认 → 全选（米家「选择家庭」=
 *   全部导入）；**可选**且无默认 → 空数组（房间/类型/型号过滤器默认不排除任何东西）。
 * - 其它类型：有 `default` 用它，否则判定必须人工。
 */
export function autoFillFields(schema) {
  const fields = {};
  for (const field of schema ?? []) {
    const name = field?.name;
    if (!name) return null;
    if (field.type === "boolean") {
      fields[name] = field.default === true;
      continue;
    }
    if (field.type === "select") {
      const values = optionValues(field.options);
      if (field.default !== undefined) fields[name] = field.default;
      else if (values.length > 0) fields[name] = values[0];
      else return null;
      continue;
    }
    if (field.type === "multi_select") {
      if (Array.isArray(field.default) && field.default.length > 0) {
        fields[name] = field.default;
        continue;
      }
      const values = optionValues(field.options);
      if (field.required === true) {
        if (values.length === 0) return null;
        fields[name] = values;
        continue;
      }
      fields[name] = [];
      continue;
    }
    if (field.default !== undefined) {
      fields[name] = field.default;
      continue;
    }
    return null;
  }
  return fields;
}
