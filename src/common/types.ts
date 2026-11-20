/** 工具分组：决定前端分组展示与配色 */
export type ToolGroup = 'local' | 'rag' | 'skill' | 'mcp';

export interface ToolDescriptor {
  name: string;
  label: string;
  group: ToolGroup;
  description: string;
  /** MCP 工具额外标注来源 server */
  server?: string;
}

export interface RagCitation {
  docId: string;
  source: string;
  chunkIndex: number;
  score: number;
  preview: string;
}

export interface RagHit extends RagCitation {
  text: string;
}

export interface RagDocument {
  docId: string;
  source: string;
  chunks: number;
  chars: number;
  createdAt: string;
  vectorized: boolean;
}

export interface SkillDescriptor {
  name: string;
  title: string;
  description: string;
  tags: string[];
}

export interface McpServerStatus {
  state: 'pending' | 'ok' | 'error' | 'disabled';
  label: string;
  tools: number;
  error: string;
  elapsedMs?: number;
  toolNames?: string[];
}

/** SSE 推给前端的统一事件结构 */
export type ChatEvent =
  | { type: 'token'; content: string }
  | {
      type: 'tool_start';
      runId: string;
      name: string;
      label: string;
      group: ToolGroup;
      args: unknown;
    }
  | {
      type: 'tool_end';
      runId: string;
      name: string;
      output: string;
      durationMs: number;
      ok: boolean;
    }
  | { type: 'skill'; name: string; title: string }
  | { type: 'citations'; items: RagCitation[] }
  | { type: 'done'; threadId: string; elapsedMs: number }
  | { type: 'error'; message: string };
