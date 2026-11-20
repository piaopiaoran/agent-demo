import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import { OpenAIEmbeddings } from '@langchain/openai';
import { appConfig, AppConfig } from '../config/app.config';

export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      '未配置 OPENAI_API_KEY。请把 .env.example 复制为 .env 并填入可用的 key；' +
        '也支持 DeepSeek / 通义千问 / vLLM 等 OpenAI 兼容端点，改 OPENAI_BASE_URL 与 MODEL_NAME 即可。',
    );
    this.name = 'LlmNotConfiguredError';
  }
}

/**
 * 模型工厂。整个应用只在这里 new 模型，便于统一换供应商、统一超时与重试策略。
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private chatModel?: ChatOpenAI;
  private embeddings?: OpenAIEmbeddings | null;

  constructor(@Inject(appConfig.KEY) private readonly cfg: AppConfig) {}

  get modelName(): string {
    return this.cfg.llm.model;
  }

  /** key 缺失或仍是占位符时视为未配置 */
  get isConfigured(): boolean {
    const key = this.cfg.llm.apiKey.trim();
    return key.length > 0 && !/^sk-x+$/i.test(key);
  }

  getChatModel(): ChatOpenAI {
    if (!this.isConfigured) throw new LlmNotConfiguredError();
    if (!this.chatModel) {
      this.chatModel = new ChatOpenAI({
        model: this.cfg.llm.model,
        apiKey: this.cfg.llm.apiKey,
        temperature: this.cfg.llm.temperature,
        maxTokens: this.cfg.llm.maxTokens,
        timeout: 90_000,
        maxRetries: 2,
        configuration: { baseURL: this.cfg.llm.baseUrl },
      });
      this.logger.log(`LLM 就绪：${this.cfg.llm.model} @ ${this.cfg.llm.baseUrl}`);
    }
    return this.chatModel;
  }

  /**
   * embedding 客户端。未配置 key 或显式关闭时返回 null，
   * 调用方（RagService）会自动降级为本地 BM25 词法检索。
   */
  getEmbeddings(): OpenAIEmbeddings | null {
    if (this.cfg.rag.embeddingBackend === 'none') return null;
    if (!this.isConfigured) return null;
    if (this.embeddings === undefined) {
      this.embeddings = new OpenAIEmbeddings({
        model: this.cfg.rag.embeddingModel,
        apiKey: this.cfg.llm.apiKey,
        configuration: { baseURL: this.cfg.llm.baseUrl },
        maxRetries: 2,
        timeout: 60_000,
      });
    }
    return this.embeddings;
  }

  /** embedding 调用失败后禁用，避免每次检索都超时重试 */
  disableEmbeddings(reason: unknown): void {
    this.logger.warn(`Embedding 不可用，降级为 BM25 词法检索：${String(reason).slice(0, 200)}`);
    this.embeddings = null;
  }
}
