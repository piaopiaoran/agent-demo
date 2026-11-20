/** 中文友好分词 + BM25 打分（不依赖任何分词词库）。 */

const EN_TOKEN = /[a-z0-9_]+/g;
const CJK_RUN = /[\u4e00-\u9fff]+/g;

/**
 * 英文/数字按词切；中文按 2-gram 切（"知识库" -> 知识 / 识库）。
 * 2-gram 的好处：不需要词典，召回稳定，代价是索引稍大。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = lower.match(EN_TOKEN) ?? [];

  for (const segment of lower.match(CJK_RUN) ?? []) {
    if (segment.length === 1) {
      tokens.push(segment);
      continue;
    }
    for (let i = 0; i < segment.length - 1; i += 1) {
      tokens.push(segment.slice(i, i + 2));
    }
  }
  return tokens;
}

function counter(tokens: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

/**
 * BM25 打分，返回 0~1 的归一化分数。
 * 归一化基准 = 假设某个文档命中了全部查询词且长度等于平均长度时的理论最高分，
 * 这样 RAG_MIN_SCORE 阈值才有稳定的物理意义。
 */
export function bm25Scores(query: string, documents: string[], k1 = 1.5, b = 0.75): number[] {
  if (documents.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return documents.map(() => 0);

  const docTfs = documents.map((doc) => counter(tokenize(doc)));
  const docLens = docTfs.map((tf) => {
    let sum = 0;
    for (const value of tf.values()) sum += value;
    return sum || 1;
  });
  const avgLen = docLens.reduce((a, b2) => a + b2, 0) / docLens.length;
  const n = documents.length;

  const df = new Map<string, number>();
  for (const tf of docTfs) {
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }

  const idf = (token: string): number => {
    const d = df.get(token) ?? 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };

  const uniqueQuery = [...new Set(queryTokens)];
  let maxPossible = 0;
  for (const token of uniqueQuery) maxPossible += idf(token) * (k1 + 1);
  if (maxPossible <= 0) return documents.map(() => 0);

  return docTfs.map((tf, index) => {
    const dl = docLens[index];
    let score = 0;
    for (const token of queryTokens) {
      const freq = tf.get(token) ?? 0;
      if (freq === 0) continue;
      score += (idf(token) * (freq * (k1 + 1))) / (freq + k1 * (1 - b + (b * dl) / avgLen));
    }
    return Math.min(1, score / maxPossible);
  });
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
