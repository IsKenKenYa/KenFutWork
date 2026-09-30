/**
 * zcode 照搬：`@/mentions/nodes/PromptMentionNode.ts`（references/zcode/packages/ui/src/mentions/nodes/PromptMentionNode.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀；P5 适配：可选属性放宽 `| undefined`（exactOptionalPropertyTypes，照搬调用点显式传 undefined）
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { resolveFileDisplayDescriptor } from "@zui/lib/fileDisplay";
import {
  getPromptMentionVariantClassName,
  PROMPT_MENTION_BASE_CLASS_NAME,
} from "@zui/mentions/mentionChip";
import type {
  MentionCategory,
  MentionItemData,
} from "@zui/mentions/mentionTypes";
import { decoratePromptMention } from "@zui/mentions/nodes/promptMentionDecoration";
import { normalizePromptMentionDisplayLabel } from "@zui/mentions/promptMentionLabel";
import {
  $applyNodeReplacement,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  TextNode,
} from "lexical";

export * from "@zui/mentions/nodes/mentionIconDom";

function displayLabel(payload: PromptMentionPayload): string {
  const label = normalizePromptMentionDisplayLabel(
    payload.category,
    payload.label,
    payload.value,
  );
  return payload.category === "files"
    ? resolveFileDisplayDescriptor(
        payload.data?.path ?? payload.data?.relativePath ?? payload.value,
      ).fileName || label
    : label;
}

export interface PromptMentionPayload {
  id: string;
  category: MentionCategory;
  label: string;
  value: string;
  markdown: string;
  description?: string | undefined;
  data?: MentionItemData | undefined;
}

type SerializedPromptMentionNode = SerializedTextNode & {
  category: MentionCategory;
  data?: MentionItemData | undefined;
  description?: string | undefined;
  mentionId: string;
  markdown: string;
  type: "prompt-mention";
  value: string;
  version: 1;
};

export class PromptMentionNode extends TextNode {
  __category: MentionCategory;
  __data?: MentionItemData | undefined;
  __description: string;
  __markdown: string;
  __mentionId: string;
  __value: string;

  static getType(): string {
    return "prompt-mention";
  }

  static clone(node: PromptMentionNode): PromptMentionNode {
    return new PromptMentionNode(
      {
        id: node.__mentionId,
        category: node.__category,
        label: node.__text,
        value: node.__value,
        markdown: node.__markdown,
        description: node.__description,
        data: node.__data,
      },
      node.__key,
    );
  }

  static importJSON(
    serializedNode: SerializedPromptMentionNode,
  ): PromptMentionNode {
    const node = $createPromptMentionNode({
      id: serializedNode.mentionId,
      category: serializedNode.category,
      label: serializedNode.text,
      value: serializedNode.value,
      markdown: serializedNode.markdown,
      description: serializedNode.description,
      data: serializedNode.data,
    });
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }

  constructor(payload: PromptMentionPayload, key?: NodeKey) {
    super(displayLabel(payload), key);
    this.__mentionId = payload.id;
    this.__category = payload.category;
    this.__value = payload.value;
    this.__markdown = payload.markdown;
    this.__description = payload.description ?? "";
    this.__data = payload.data;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    const variantClassName = getPromptMentionVariantClassName(this.__category);
    dom.className = `prompt-mention ${PROMPT_MENTION_BASE_CLASS_NAME} ${variantClassName}`;
    dom.setAttribute("data-mention-category", this.__category);
    dom.setAttribute("data-mention-id", this.__mentionId);
    dom.setAttribute("spellcheck", "false");
    // 根因：TextNode 的 firstChild 链必须通向展示文字，不能被图标截断。
    // 保留 super 创建的文本 DOM，图标只作为不参与选区的 CSS 装饰。
    decoratePromptMention(dom, this.__category, this.__value, this.__data);
    return dom;
  }

  updateDOM(
    prevNode: PromptMentionNode,
    dom: HTMLElement,
    config: EditorConfig,
  ): boolean {
    const shouldUpdate = super.updateDOM(prevNode as this, dom, config);
    if (prevNode.__category !== this.__category) {
      const variantClassName = getPromptMentionVariantClassName(
        this.__category,
      );
      dom.className = `prompt-mention ${PROMPT_MENTION_BASE_CLASS_NAME} ${variantClassName}`;
      dom.setAttribute("data-mention-category", this.__category);
    }

    if (prevNode.__mentionId !== this.__mentionId) {
      dom.setAttribute("data-mention-id", this.__mentionId);
    }

    if (
      prevNode.__text !== this.__text ||
      prevNode.__category !== this.__category ||
      prevNode.__value !== this.__value ||
      prevNode.__data?.path !== this.__data?.path ||
      prevNode.__data?.relativePath !== this.__data?.relativePath ||
      prevNode.__data?.kind !== this.__data?.kind ||
      prevNode.__data?.scope !== this.__data?.scope ||
      prevNode.__data?.icon !== this.__data?.icon
    ) {
      decoratePromptMention(dom, this.__category, this.__value, this.__data);
    }

    return shouldUpdate;
  }

  exportJSON(): SerializedPromptMentionNode {
    return {
      ...super.exportJSON(),
      type: "prompt-mention",
      version: 1,
      mentionId: this.__mentionId,
      category: this.__category,
      value: this.__value,
      markdown: this.__markdown,
      description: this.__description,
      data: this.__data,
    };
  }

  getMarkdown(): string {
    // 编辑器 offset 必须使用展示文字；canonical 仅供发送和剪贴板序列化。
    return this.getLatest().__markdown;
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  getMention(): PromptMentionPayload {
    return {
      id: this.__mentionId,
      category: this.__category,
      label: this.__text,
      value: this.__value,
      markdown: this.__markdown,
      description: this.__description,
      data: this.__data,
    };
  }
}

export function $createPromptMentionNode(
  payload: PromptMentionPayload,
): PromptMentionNode {
  const node = new PromptMentionNode(payload);
  node.setMode("token");
  return $applyNodeReplacement(node);
}

export function $isPromptMentionNode(
  node: LexicalNode | null | undefined,
): node is PromptMentionNode {
  return node instanceof PromptMentionNode;
}
