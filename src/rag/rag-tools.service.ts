import { Injectable } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { RagService } from './rag.service';
import type { ToolDescriptor } from '../common/types';
import { defineTool } from '../tools/define-tool';

export const RAG_TOOL_META: ToolDescriptor[] = [
  {
    name: 'search_knowledge_base',
    label: '知识库检索',
    group: 'rag',
    description: '向量 / BM25 混合检索，自动降级',
  },
  {
    name: 'add_to_knowledge_base',
    label: '写入知识库',
    group: 'rag',
    description: '把文本沉淀进 RAG 索引',
  },
];

/**
 * 把 RAG 暴露成 Agent 可主动调用的工具。
 * 与「自动注入」互补：prefetch 节点负责每轮自动打底，这里让模型能按需深挖。
 */
@Injectable()
export class RagToolsService {
  constructor(private readonly rag: RagService) {}

  readonly searchKnowledgeBase = defineTool<{ query: string; topK?: number }>({
    name: 'search_knowledge_base',
    description:
      '检索本地知识库（用户上传的文档）。回答任何涉及专有资料、内部文档、用户已上传文件的问题前，必须先调用它，不要凭空回答。',
    schema: z.object({
      query: z.string().describe('要检索的问题或关键词，尽量具体，可包含同义词'),
      topK: z.number().int().min(1).max(10).optional().describe('返回的片段数量，默认 5'),
    }),
    run: async ({ query, topK }) => {
      const hits = await this.rag.search(query, topK);
      if (hits.length === 0) {
        const stats = this.rag.stats();
        return `知识库中未检索到与「${query}」相关的内容（当前 ${stats.documents} 篇文档 / ${stats.chunks} 个片段）。`;
      }
      const lines = [`检索到 ${hits.length} 个相关片段：`];
      hits.forEach((hit, index) => {
        lines.push(
          `\n[${index + 1}] 来源 ${hit.source}（第 ${hit.chunkIndex} 块，相关度 ${hit.score.toFixed(2)}）\n${hit.text.slice(0, 1200)}`,
        );
      });
      return lines.join('\n');
    },
  });

  readonly addToKnowledgeBase = defineTool<{ text: string; title?: string }>({
    name: 'add_to_knowledge_base',
    description:
      '把一段文本写入知识库，之后可用 search_knowledge_base 检索。适合沉淀阶段性结论、会议纪要、长文资料，避免多轮对话后遗忘。',
    schema: z.object({
      text: z.string().describe('要入库的完整文本内容，至少 10 个字符'),
      title: z.string().optional().describe('内容标题，作为来源名展示'),
    }),
    run: async ({ text, title }) => {
      if (text.trim().length < 10) return '内容太短（<10 字），未入库。';
      const doc = await this.rag.ingest(`${title?.trim() || 'agent-note'}.md`, text);
      return `已入库：${doc.source}，${doc.chunks} 个片段，${doc.chars} 字（${doc.vectorized ? '向量索引' : '词法索引'}）。`;
    },
  });

  get tools(): StructuredToolInterface[] {
    return [this.searchKnowledgeBase, this.addToKnowledgeBase];
  }
}
