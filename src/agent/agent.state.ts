import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { RagCitation } from '../common/types';

/**
 * 图状态（LangGraph 的核心概念）。
 *
 * - messages 用 messagesStateReducer：新消息累加，而不是覆盖（这是多轮对话能成立的原因）
 * - context / citations 用「后写覆盖」：每轮重新检索，不累积历史噪声
 */
export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /** prefetch 节点检索到的知识库片段，拼进 system prompt */
  context: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  /** 同一批片段的元信息，推给前端展示引用来源 */
  citations: Annotation<RagCitation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
