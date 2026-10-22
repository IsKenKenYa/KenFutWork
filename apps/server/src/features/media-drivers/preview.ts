import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import { type Node, traverseFast } from "@babel/types";
import {
  type MediaDriverMethod,
  mediaDriverManifestSchema,
  mediaDriverMethodSchema,
  mediaDriverPreviewResponseSchema,
} from "@kenfutwork/shared";
import { transform } from "esbuild";

export class MediaDriverFileError extends Error {
  readonly statusCode = 400;
  readonly code = "media_driver_invalid_file";
}

function invalid(message: string): never {
  throw new MediaDriverFileError(message);
}

/** 仅解释 JSON 形式的语法树；不调用待导入文件中的表达式。 */
function literal(node: Node): unknown {
  switch (node.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return literal(node.expression);
    case "StringLiteral":
    case "BooleanLiteral":
    case "NumericLiteral":
      return node.value;
    case "NullLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "NumericLiteral")
        return -node.argument.value;
      break;
    case "ArrayExpression":
      return node.elements.map((item) =>
        item ? literal(item) : invalid("模型声明不能包含空数组项"),
      );
    case "ObjectExpression": {
      const value: Record<string, unknown> = Object.create(null);
      for (const item of node.properties) {
        if (item.type !== "ObjectProperty" || item.computed)
          invalid("manifest 请使用普通对象字段");
        const key =
          item.key.type === "Identifier"
            ? item.key.name
            : item.key.type === "StringLiteral"
              ? item.key.value
              : invalid("manifest 字段名称无效");
        if (Object.hasOwn(value, key)) invalid("manifest 字段不能重复");
        value[key] = literal(item.value);
      }
      return value;
    }
  }
  return invalid("manifest 请直接声明数据，不使用变量或函数调用");
}

function parseSource(source: string) {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  } catch {
    return invalid("TypeScript 语法错误，请检查供应商文件");
  }
  traverseFast(ast, (node) => {
    if (
      node.type === "Import" ||
      node.type === "ImportExpression" ||
      node.type === "TSImportEqualsDeclaration" ||
      (node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require")
    )
      invalid("供应商文件需要自包含，请移除模块导入");
  });
  return ast;
}

function readDeclarations(ast: ReturnType<typeof parse>) {
  let declaration: unknown;
  const methods: MediaDriverMethod[] = [];
  for (const item of ast.program.body) {
    if (
      item.type === "ImportDeclaration" ||
      item.type === "ExportAllDeclaration" ||
      (item.type === "ExportNamedDeclaration" && item.source)
    )
      invalid("供应商文件需要自包含，请移除模块导入");
    if (item.type !== "ExportNamedDeclaration" || !item.declaration) continue;
    const entry = item.declaration;
    if (entry.type === "VariableDeclaration") {
      for (const variable of entry.declarations) {
        if (variable.id.type !== "Identifier") continue;
        if (variable.id.name === "manifest" && variable.init)
          declaration = literal(variable.init);
        if (
          variable.init?.type === "ArrowFunctionExpression" ||
          variable.init?.type === "FunctionExpression"
        ) {
          const method = mediaDriverMethodSchema.safeParse(variable.id.name);
          if (method.success) methods.push(method.data);
        }
      }
    }
    if (entry.type === "FunctionDeclaration") {
      const method = mediaDriverMethodSchema.safeParse(entry.id?.name);
      if (method.success) methods.push(method.data);
    }
  }
  const parsed = mediaDriverManifestSchema.safeParse(declaration);
  if (!parsed.success)
    invalid("manifest 声明无效，请检查接口版本、模型、参数和访问地址");
  if (!methods.includes("submit")) invalid("请导出 submit 函数");
  if (
    parsed.data.models.some((model) => model.execution === "async") &&
    !methods.includes("query")
  )
    invalid("异步模型需要导出 query 函数");
  return { manifest: parsed.data, methods };
}

export async function previewMediaDriverSource(
  source: string,
  options: { maxBytes: number },
) {
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (!source.trim() || sourceBytes > options.maxBytes)
    invalid("供应商文件为空或超过大小设置，请修改文件");
  const declarations = readDeclarations(parseSource(source));
  let compiledCode: string;
  try {
    compiledCode = (
      await transform(source, {
        loader: "ts",
        format: "esm",
        target: "node22",
        sourcemap: false,
      })
    ).code;
  } catch {
    return invalid("供应商文件编译失败，请检查 TypeScript 代码");
  }
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  return {
    ...mediaDriverPreviewResponseSchema.parse({
      ...declarations,
      sourceDigest: digest(source),
      compiledDigest: digest(compiledCode),
      sourceBytes,
      maxBytes: options.maxBytes,
      validation: "format_only",
    }),
    compiledCode,
  };
}
