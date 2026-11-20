import { registerAs, ConfigType } from '@nestjs/config';
import { join } from 'node:path';

const bool = (v: string | undefined, def: boolean): boolean => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const num = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/**
 * 全局配置。所有可调参数集中在这里，读取环境变量、给出常用默认值。
 * 注入方式：constructor(@Inject(appConfig.KEY) private readonly cfg: AppConfig) {}
 */
export const appConfig = registerAs('app', () => {
  const root = process.cwd();
  const dataDir = join(root, 'data');

  return {
    port: num(process.env.PORT, 3000),
    // 0.0.0.0 = 本机 + 局域网都可访问；只想本机访问时设 HOST=127.0.0.1
    host: process.env.HOST ?? '0.0.0.0',

    llm: {
      apiKey: process.env.OPENAI_API_KEY ?? '',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.MODEL_NAME ?? 'gpt-4o-mini',
      temperature: num(process.env.TEMPERATURE, 0.3),
      maxTokens: num(process.env.MAX_TOKENS, 2048),
    },

    agent: {
      recursionLimit: num(process.env.RECURSION_LIMIT, 30),
    },

    rag: {
      embeddingBackend: (process.env.EMBEDDING_BACKEND ?? 'auto').toLowerCase(),
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
      topK: num(process.env.RAG_TOP_K, 5),
      chunkSize: num(process.env.RAG_CHUNK_SIZE, 800),
      chunkOverlap: num(process.env.RAG_CHUNK_OVERLAP, 120),
      minScore: num(process.env.RAG_MIN_SCORE, 0.08),
      autoInject: bool(process.env.RAG_AUTO_INJECT, true),
      maxUploadMb: num(process.env.RAG_MAX_UPLOAD_MB, 20),
    },

    mcp: {
      enabled: bool(process.env.MCP_ENABLED, true),
      configFile: join(root, process.env.MCP_CONFIG ?? 'mcp-servers.json'),
      loadTimeoutMs: num(process.env.MCP_LOAD_TIMEOUT, 90_000),
    },

    paths: {
      root,
      data: dataDir,
      notes: join(dataDir, 'notes'),
      uploads: join(dataDir, 'rag', 'uploads'),
      indexDir: join(dataDir, 'index'),
      ragIndexFile: join(dataDir, 'index', 'rag-index.json'),
      skillsDir: join(root, 'src', 'skills', 'library'),
    },
  };
});

export type AppConfig = ConfigType<typeof appConfig>;
