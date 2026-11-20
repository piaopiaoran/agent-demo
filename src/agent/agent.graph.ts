import { START, MemorySaver, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentStateAnnotation, type AgentState } from './agent.state';
import { buildSystemPrompt } from './agent.prompts';
import type { LlmService } from '../llm/llm.service';
import type { RagService } from '../rag/rag.service';
import type { SkillRegistry } from '../skills/skill.registry';

export interface AgentGraphDeps {
  llm: LlmService;
  tools: StructuredToolInterface[];
  rag: RagService;
  skills: SkillRegistry;
  toolSummary: string;
  autoInject: boolean;
  topK: number;
}

/**
 * 单 Agent 的 ReAct 循环（LangGraph 版）：
 *
 *        START
 *          │
 *     ┌────▼─────┐   自动 RAG 预取（可选）
 *     │ prefetch │
 *     └────┬─────┘
 *          │
 *     ┌────▼────┐   LLM 决策：要不要调工具
 *     │  agent  │◀──────────┐
 *     └────┬────┘           │
 *          │ toolsCondition │
 *     ┌────▼────┐           │
 *     │  tools  │───────────┘  执行工具，结果回灌给 agent
 *     └────┬────┘
 *          │ 无工具调用
 *         END
 *
/**
 * 编译后的图的最小接口。
 *
 * ⚠️ 为什么不用 LangGraph 的原始类型：
 * StateGraph 的泛型会随着 addNode/addEdge 链式调用层层叠加，在 strict 模式下
 * tsc 需要展开数 GB 的中间类型（实测 4GB 堆直接 OOM，编译耗时以分钟计）。
 * 这里把「构造过程」和「运行期接口」都用窄类型收敛，编译速度回到秒级，
 * 代价只是失去链式调用的静态检查 —— 节点函数本身仍然有 AgentState 类型约束。
 * 这是 LangGraph JS 项目里常见且推荐的折中。
 */
export interface CompiledAgentGraph {
  streamEvents(input: unknown, options: Record<string, unknown>): AsyncIterable<AgentStreamEvent>;
  getState(config: Record<string, unknown>): Promise<{ values: Partial<AgentState> }>;
}

export interface AgentStreamEvent {
  event: string;
  name?: string;
  run_id?: string;
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

interface GraphBuilderLike {
  addNode(name: string, action: unknown): GraphBuilderLike;
  addEdge(from: string, to: string): GraphBuilderLike;
  addConditionalEdges(from: string, condition: unknown): GraphBuilderLike;
  compile(options: { checkpointer: MemorySaver }): CompiledAgentGraph;
}

/**
 * 与 createReactAgent 的区别：节点自己写，便于插入 RAG 预取、审计、限流等自定义逻辑。
 */
export function createAgentGraph(deps: AgentGraphDeps, checkpointer: MemorySaver): CompiledAgentGraph {
  const toolNode = new ToolNode(deps.tools);

  // ---------------------------------------------------------------- prefetch
  // 把「用户这句话」先去知识库捞一遍，命中就塞进 system prompt。
  // 与工具化 RAG 互补：常见问题不用模型自己想起来调用工具，节省一轮往返。
  const prefetch = async (state: AgentState): Promise<Partial<AgentState>> => {
    if (!deps.autoInject) return { context: '', citations: [] };

    const lastHuman = [...state.messages].reverse().find((message) => message.getType() === 'human');
    const query = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
    if (!query.trim()) return { context: '', citations: [] };

    const hits = await deps.rag.search(query, deps.topK);
    return {
      context: deps.rag.formatContext(hits),
      citations: deps.rag.toCitations(hits),
    };
  };

  // ---------------------------------------------------------------- agent
  const agent = async (state: AgentState): Promise<Partial<AgentState>> => {
    const model = deps.llm.getChatModel().bindTools(deps.tools);
    const systemPrompt = buildSystemPrompt({
      skillsCatalog: deps.skills.catalogText(),
      ragContext: state.context,
      toolSummary: deps.toolSummary,
    });

    const response = await model.invoke([new SystemMessage(systemPrompt), ...state.messages]);

    // 只返回增量，其余状态由 reducer 合并
    return { messages: [response] };
  };

  const builder = new StateGraph(AgentStateAnnotation) as unknown as GraphBuilderLike;

  builder
    .addNode('prefetch', prefetch)
    .addNode('agent', agent)
    .addNode('tools', toolNode)
    .addEdge(START, 'prefetch')
    .addEdge('prefetch', 'agent')
    .addConditionalEdges('agent', toolsCondition)
    .addEdge('tools', 'agent');

  return builder.compile({ checkpointer });
}
