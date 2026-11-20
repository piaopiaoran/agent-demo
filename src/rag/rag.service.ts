import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appConfig, AppConfig } from '../config/app.config';
import { LlmService } from '../llm/llm.service';
import type { RagCitation, RagDocument, RagHit } from '../common/types';
import { splitText } from './rag.splitter';
import { bm25Scores, cosineSimilarity } from './rag.text';

export interface RagChunk {
  id: string;
  docId: string;
  source: string;
  chunkIndex: number;
  text: string;
  vector: number[] | null;
  createdAt: string;
  chars: number;
}

interface RagIndexFile {
  version: number;
  backend: 'openai' | 'lexical';
  embeddingModel: string;
  updatedAt: string;
  chunks: RagChunk[];
}

/**
 * 轻量 RAG：
 *   文档 -> 切块 -> 向量化 -> JSON 索引持久化 -> 混合检索
 *
 * 设计取舍（写给你看的）：
 * 1. 不用向量库（FAISS/Chroma），索引就是一个 JSON 文件，方便肉眼检查、方便删。数据量大再换 pgvector。
 * 2. 有 OpenAI 兼容 embedding 就走余弦；没有或调用失败，自动降级为 BM25 词法检索，保证 demo 永远能跑。
 * 3. 检索分数统一归一到 0~1，阈值配置才有可比性。
 */
@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  private chunks: RagChunk[] = [];
  private backend: 'openai' | 'lexical' = 'lexical';
  private embeddingModel = '';
  private loaded = false;

  /** 串行化写索引，避免并发上传互相覆盖 */
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(appConfig.KEY) private readonly cfg: AppConfig,
    private readonly llm: LlmService,
  ) {}

  async onModuleInit(): Promise<void> {
    await mkdir(dirname(this.cfg.paths.ragIndexFile), { recursive: true });
    await this.load();
  }

  // ---------------------------------------------------------------- 持久化
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.cfg.paths.ragIndexFile, 'utf-8');
      const parsed = JSON.parse(raw) as RagIndexFile;
      this.chunks = parsed.chunks ?? [];
      this.backend = parsed.backend ?? 'lexical';
      this.embeddingModel = parsed.embeddingModel ?? '';
      this.logger.log(`载入 RAG 索引：${this.chunks.length} 个片段（${this.backend}）`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`RAG 索引读取失败，按空索引启动：${(err as Error).message}`);
      }
    }
  }

  private async persist(): Promise<void> {
    const payload: RagIndexFile = {
      version: 1,
      backend: this.backend,
      embeddingModel: this.embeddingModel,
      updatedAt: new Date().toISOString(),
      chunks: this.chunks,
    };
    const file = this.cfg.paths.ragIndexFile;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), 'utf-8');
    await rename(tmp, file);
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeLock.then(task, task);
    this.writeLock = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- embedding
  private async embedDocuments(texts: string[]): Promise<number[][] | null> {
    const embedder = this.llm.getEmbeddings();
    if (!embedder) return null;
    try {
      return await embedder.embedDocuments(texts);
    } catch (err) {
      this.llm.disableEmbeddings(err);
      return null;
    }
  }

  private async embedQuery(text: string): Promise<number[] | null> {
    const embedder = this.llm.getEmbeddings();
    if (!embedder) return null;
    try {
      return await embedder.embedQuery(text);
    } catch (err) {
      this.llm.disableEmbeddings(err);
      return null;
    }
  }

  // ---------------------------------------------------------------- 写入
  async ingest(source: string, text: string, docId?: string): Promise<RagDocument> {
    const content = text.trim();
    if (!content) throw new Error('内容为空');

    const id =
      docId ?? createHash('sha1').update(`${source}\n${content.slice(0, 512)}`).digest('hex').slice(0, 12);

    const pieces = splitText(content, this.cfg.rag.chunkSize, this.cfg.rag.chunkOverlap);
    if (pieces.length === 0) throw new Error('切块后没有有效内容');

    // embedding 是慢操作，放在锁外做
    const vectors = await this.embedDocuments(pieces);
    if (vectors) {
      this.backend = 'openai';
      this.embeddingModel = this.cfg.rag.embeddingModel;
    }

    const createdAt = new Date().toISOString();

    await this.withLock(async () => {
      // 同一个 docId 重复上传视为覆盖
      this.chunks = this.chunks.filter((chunk) => chunk.docId !== id);
      pieces.forEach((piece, index) => {
        this.chunks.push({
          id: `${id}-${index}`,
          docId: id,
          source,
          chunkIndex: index,
          text: piece,
          vector: vectors?.[index] ?? null,
          createdAt,
          chars: piece.length,
        });
      });
      if (!this.chunks.some((c) => c.vector)) this.backend = 'lexical';
      await this.persist();
    });

    this.logger.log(`入库 ${source}：${pieces.length} 个片段 / ${content.length} 字（${this.backend}）`);
    return {
      docId: id,
      source,
      chunks: pieces.length,
      chars: content.length,
      createdAt,
      vectorized: Boolean(vectors),
    };
  }

  async deleteDocument(docId: string): Promise<number> {
    return this.withLock(async () => {
      const before = this.chunks.length;
      this.chunks = this.chunks.filter((chunk) => chunk.docId !== docId);
      const removed = before - this.chunks.length;
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      this.chunks = [];
      this.backend = 'lexical';
      await this.persist();
    });
  }

  // ---------------------------------------------------------------- 检索
  async search(query: string, topK?: number): Promise<RagHit[]> {
    const q = query.trim();
    const k = Math.min(Math.max(topK ?? this.cfg.rag.topK, 1), 20);
    if (!q || this.chunks.length === 0) return [];

    const hasVectors = this.chunks.some((chunk) => chunk.vector && chunk.vector.length > 0);
    let scores: number[];

    if (hasVectors) {
      const queryVector = await this.embedQuery(q);
      if (queryVector) {
        scores = this.chunks.map((chunk) =>
          chunk.vector ? Math.max(0, cosineSimilarity(queryVector, chunk.vector)) : 0,
        );
      } else {
        scores = bm25Scores(q, this.chunks.map((chunk) => chunk.text));
      }
    } else {
      scores = bm25Scores(q, this.chunks.map((chunk) => chunk.text));
    }

    return this.chunks
      .map((chunk, index) => ({ chunk, score: scores[index] ?? 0 }))
      .filter((item) => item.score >= this.cfg.rag.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ chunk, score }) => ({
        docId: chunk.docId,
        source: chunk.source,
        chunkIndex: chunk.chunkIndex,
        score: Number(score.toFixed(4)),
        text: chunk.text,
        preview: chunk.text.replace(/\s+/g, ' ').slice(0, 160),
      }));
  }

  /** 把检索结果拼成给模型看的上下文文本 */
  formatContext(hits: RagHit[], maxChars = 4000): string {
    if (hits.length === 0) return '';
    const blocks: string[] = [];
    let used = 0;
    hits.forEach((hit, index) => {
      const head = `[片段${index + 1}] 来源：${hit.source} · 相关度 ${hit.score.toFixed(2)}\n`;
      let body = hit.text;
      if (used + head.length + body.length > maxChars) {
        body = body.slice(0, Math.max(0, maxChars - used - head.length));
      }
      blocks.push(head + body);
      used += head.length + body.length;
    });
    return blocks.join('\n\n');
  }

  toCitations(hits: RagHit[]): RagCitation[] {
    return hits.map(({ docId, source, chunkIndex, score, preview }) => ({
      docId,
      source,
      chunkIndex,
      score,
      preview,
    }));
  }

  // ---------------------------------------------------------------- 视图
  listDocuments(): RagDocument[] {
    const map = new Map<string, RagDocument>();
    for (const chunk of this.chunks) {
      const existing = map.get(chunk.docId);
      if (existing) {
        existing.chunks += 1;
        existing.chars += chunk.chars;
        existing.vectorized ||= Boolean(chunk.vector);
      } else {
        map.set(chunk.docId, {
          docId: chunk.docId,
          source: chunk.source,
          chunks: 1,
          chars: chunk.chars,
          createdAt: chunk.createdAt,
          vectorized: Boolean(chunk.vector),
        });
      }
    }
    return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  stats(): { documents: number; chunks: number; backend: string; embeddingModel: string; vectorized: boolean } {
    return {
      documents: new Set(this.chunks.map((c) => c.docId)).size,
      chunks: this.chunks.length,
      backend: this.backend,
      embeddingModel: this.embeddingModel || this.cfg.rag.embeddingModel,
      vectorized: this.chunks.some((c) => Boolean(c.vector)),
    };
  }
}
