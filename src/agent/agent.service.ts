import { Inject, Injectable, Logger } from '@nestjs/common';
import { MemorySaver } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { appConfig, AppConfig } from '../config/app.config';
import { LlmService, LlmNotConfiguredError } from '../llm/llm.service';
import { RagService } from '../rag/rag.service';
import { SkillRegistry } from '../skills/skill.registry';
import { ToolsService } from '../tools/tools.service';
import { createAgentGraph, type CompiledAgentGraph } from './agent.graph';
import type { ChatEvent, RagCitation } from '../common/types';

/** 把模型返回的 content（字符串或内容块数组）拉平成纯文本 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

function toolOutputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const candidate = output as { content?: unknown; status?: string };
    if (typeof candidate.content === 'string') return candidate.content;
    if (Array.isArray(candidate.content)) return contentToText(candidate.content);
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return String(output ?? '');
}

/**
 * Agent 编排服务。
 *
 * 两个关键点：
 * 1. checkpointer 是单例：同一个 threadId 的多轮对话共享 messages 历史。
 * 2. 图按「工具签名」缓存重建：MCP 后台加载完成后工具列表会变，签名变了自动重建图，
 *    但 checkpointer 不变，所以历史对话不会丢。
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly checkpointer = new MemorySaver();
  private graphCache?: { signature: string; graph: CompiledAgentGraph };

  constructor(
    @Inject(appConfig.KEY) private readonly cfg: AppConfig,
    private readonly llm: LlmService,
    private readonly rag: RagService,
    private readonly skills: SkillRegistry,
    private readonly tools: ToolsService,
  ) {
    // LangSmith 由 @langchain/core 读取环境变量自动上报，这里只做启动提示
    if (AgentService.tracingEnabled()) {
      const project =
        process.env.LANGSMITH_PROJECT ?? process.env.LANGCHAIN_PROJECT ?? 'default';
      this.logger.log(`LangSmith 追踪已开启：project=${project}`);
    }
  }

  private static tracingEnabled(): boolean {
    const flag =
      process.env.LANGSMITH_TRACING ??
      process.env.LANGCHAIN_TRACING_V2 ??
      process.env.LANGCHAIN_TRACING;
    return flag === 'true' && Boolean(process.env.LANGSMITH_API_KEY ?? process.env.LANGCHAIN_API_KEY);
  }

  private getGraph() {
    const tools = this.tools.all();
    const signature = tools
      .map((tool) => tool.name)
      .sort()
      .join('|');

    if (!this.graphCache || this.graphCache.signature !== signature) {
      const counts = this.tools.groupCount();
      const graph = createAgentGraph(
        {
          llm: this.llm,
          tools,
          rag: this.rag,
          skills: this.skills,
          toolSummary: `本地 ${counts.local} 个、RAG ${counts.rag} 个、技能 ${counts.skill} 个、MCP ${counts.mcp} 个`,
          autoInject: this.cfg.rag.autoInject,
          topK: this.cfg.rag.topK,
        },
        this.checkpointer,
      );
      this.graphCache = { signature, graph };
      this.logger.log(`Agent 图已编译（工具 ${tools.length} 个）`);
    }
    return this.graphCache.graph;
  }

  /**
   * 流式执行一轮对话，把 LangGraph 的事件翻译成前端可消费的 ChatEvent。
   * 用 streamEvents(v2) 而不是 stream()，因为需要区分「模型吐字」和「工具开始/结束」。
   */
  async *stream(message: string, threadId: string): AsyncGenerator<ChatEvent> {
    if (!this.llm.isConfigured) throw new LlmNotConfiguredError();

    const graph = this.getGraph();
    const startedAt = Date.now();

    const eventStream = graph.streamEvents(
      { messages: [new HumanMessage(message)] },
      {
        version: 'v2',
        runName: 'nova-agent',
        tags: ['agent-demo', this.cfg.llm.model],
        metadata: { threadId },
        configurable: { thread_id: threadId },
        recursionLimit: this.cfg.agent.recursionLimit,
      },
    );

    const toolStartAt = new Map<string, number>();
    const pendingSkill = new Map<string, string>();

    for await (const event of eventStream) {
      const node = String(event.metadata?.langgraph_node ?? '');

      if (event.event === 'on_chat_model_stream' && node === 'agent') {
        const text = contentToText((event.data as { chunk?: { content?: unknown } })?.chunk?.content);
        if (text) yield { type: 'token', content: text };
        continue;
      }

      if (event.event === 'on_tool_start') {
        const runId = String(event.run_id ?? '');
        const name = String(event.name ?? '');
        const args = (event.data as { input?: unknown })?.input;
        const { label, group } = this.tools.labelOf(name);

        toolStartAt.set(runId, Date.now());
        if (name === 'load_skill') {
          const skillName = (args as { name?: string } | undefined)?.name;
          if (skillName) pendingSkill.set(runId, skillName);
        }

        yield { type: 'tool_start', runId, name, label, group, args };
        continue;
      }

      if (event.event === 'on_tool_end') {
        const runId = String(event.run_id ?? '');
        const name = String(event.name ?? '');
        const output = (event.data as { output?: unknown })?.output;
        const startedThisTool = toolStartAt.get(runId);
        const durationMs = startedThisTool ? Date.now() - startedThisTool : 0;
        const ok = (output as { status?: string } | undefined)?.status !== 'error';

        yield {
          type: 'tool_end',
          runId,
          name,
          output: toolOutputToText(output).slice(0, 4000),
          durationMs,
          ok,
        };

        if (name === 'load_skill' && ok) {
          const skillName = pendingSkill.get(runId);
          const skill = skillName ? this.skills.get(skillName) : undefined;
          if (skill) yield { type: 'skill', name: skill.name, title: skill.title };
        }
        continue;
      }

      if (event.event === 'on_chain_end' && (node === 'prefetch' || event.name === 'prefetch')) {
        const citations = (event.data as { output?: { citations?: RagCitation[] } })?.output?.citations;
        if (Array.isArray(citations) && citations.length > 0) {
          yield { type: 'citations', items: citations };
        }
      }
    }

    yield { type: 'done', threadId, elapsedMs: Date.now() - startedAt };
  }

  /** 清空某个会话的记忆。
   *  MemorySaver 没有 deleteThread 方法（只有 SqliteSaver 等持久化实现才有），
   *  它的存储就是两个以 threadId 为键的普通对象，直接删键即可。
   */
  async reset(threadId: string): Promise<void> {
    delete this.checkpointer.storage[threadId];
    delete this.checkpointer.writes[threadId];
    this.logger.log(`会话 ${threadId} 已重置`);
  }
}
