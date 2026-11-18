import type { FileInfo, GrepMatch } from "deepagents";

export interface FileLimits {
  codeReadMaxBytes: number;
  codeReadPageCharacters: number;
  codeSearchMaxResults: number;
  codeSearchMaxBytes: number;
  codePatchMaxBytes: number;
  codePdfMaxPages: number;
  codePdfRenderScale: number;
}

/** Columns are zero-based UTF-16 offsets; cursors always stop at a Unicode boundary. */
export interface ReadCursor {
  line: number;
  column: number;
  version: string;
}

export interface ReadPageInput {
  path: string;
  signal?: AbortSignal | undefined;
  line?: number;
  column?: number;
  limit?: number;
  continuation?: ReadCursor;
}

export interface TextPage {
  type: "text";
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  totalLines: number;
  sizeBytes: number;
  bytesRead: number;
  version: string;
  truncated: boolean;
  truncationReason?: "characters" | "lines";
  continuation?: ReadCursor;
  partialViewNotice?: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileCommit {
  type: "create" | "update" | "delete";
  filePath: string;
  content: string;
  originalFile: string | null;
  structuredPatch: DiffHunk[];
  version: string;
  userModified: false;
}

export interface WriteFileInput {
  path: string;
  signal?: AbortSignal | undefined;
  content: string;
  expectedVersion?: string;
  createOnly?: boolean;
  operationId?: string;
}

export interface EditFileInput {
  signal?: AbortSignal | undefined;
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  expectedVersion?: string;
  operationId?: string;
}

export interface EditCommit extends FileCommit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
  occurrences: number;
  matchStrategy: "exact";
}

export interface SearchCursor {
  offset: number;
  fingerprint: string;
  skip?: number | undefined;
  resume?:
    | {
        path: string;
        line: number;
        matchOffset: number;
        modifiedAt?: string | undefined;
      }
    | undefined;
}

export interface GlobPage {
  files: FileInfo[];
  truncated: boolean;
  continuation?: SearchCursor;
}

export interface GrepPage {
  matches: Array<
    GrepMatch & {
      count?: number;
      context?: Array<{ line: number; text: string }>;
    }
  >;
  truncated: boolean;
  continuation?: SearchCursor;
}

export interface GlobPageInput {
  signal?: AbortSignal | undefined;
  pattern: string;
  path?: string;
  continuation?: SearchCursor;
  limit?: number;
  offset?: number;
}
export interface GrepPageInput {
  signal?: AbortSignal | undefined;
  pattern: string;
  path?: string;
  glob?: string;
  continuation?: SearchCursor;
  limit?: number;
  offset?: number;
  caseInsensitive?: boolean;
  multiline?: boolean;
  onlyMatching?: boolean;
  type?: string;
  contextBefore?: number;
  contextAfter?: number;
  mode?: "content" | "files_with_matches" | "count";
}

export interface PatchFileChange {
  filePath: string;
  type: "add" | "update" | "delete" | "move";
  movePath?: string;
  structuredPatch: DiffHunk[];
  additions: number;
  deletions: number;
  version: string;
}
export interface PatchResult {
  files: PatchFileChange[];
  failures: Array<{ filePath: string; error: string }>;
  structuredPatch: DiffHunk[];
  summary: string;
}

export interface FileModelCapabilities {
  image: boolean;
  pdf: boolean;
}
export interface MediaReadInput {
  signal?: AbortSignal | undefined;
  path: string;
  capabilities: FileModelCapabilities;
  pages?: string;
  pdfContinuation?: { page: number; character: number; version: string };
}
export interface MediaFile {
  type: "image" | "pdf";
  filePath: string;
  version: string;
  mimeType: string;
  base64: string;
  originalSize: number;
  dimensions?: {
    originalWidth?: number;
    originalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
  };
  extractedText?: string;
  pages?: string;
  numPages?: number;
  truncated?: boolean;
  pdfContinuation?: { page: number; character: number; version: string };
  modelContent: Array<Record<string, unknown>>;
  canonicalOutput: Record<string, unknown>;
  preview: {
    path: string;
    mimeType: string;
    sizeBytes: number;
    version: string;
  };
}

export interface PatchInput {
  patchText: string;
  operationId?: string;
  signal?: AbortSignal | undefined;
}

export interface BinaryObservation {
  path: string;
  version: string | null;
  sizeBytes: number;
  mode?: number;
}
export interface FileRestoreChange {
  path: string;
  bytes: Uint8Array | null;
  expectedVersion: string | null;
  mode?: number;
}
export interface BinaryFileCommit {
  filePath: string;
  type: "create" | "update" | "delete" | "noop";
  version: string | null;
  sizeBytes: number;
}
export interface FileBatchResult<T> {
  files: BinaryFileCommit[];
  failures: Array<{ filePath: string; error: string }>;
  newScope?: T;
  complete: boolean;
}
