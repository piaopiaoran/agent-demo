/**
 * 文本切块：先按空行切段落，再按长度合并/硬切，块之间保留 overlap。
 * 目标：块内语义完整（尽量不切断段落），块间有重叠（避免答案横跨边界时丢上下文）。
 */
export function splitText(text: string, size = 800, overlap = 120): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return [];

  const chunkSize = Math.max(200, size);
  const chunkOverlap = Math.max(0, Math.min(overlap, Math.floor(chunkSize / 2)));

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = '';

  for (const paragraph of paragraphs) {
    // 超长段落（代码块、无空行的长文）直接硬切
    if (paragraph.length > chunkSize) {
      if (buffer) {
        chunks.push(buffer);
        buffer = '';
      }
      const step = Math.max(1, chunkSize - chunkOverlap);
      for (let i = 0; i < paragraph.length; i += step) {
        chunks.push(paragraph.slice(i, i + chunkSize));
      }
      continue;
    }

    if (buffer && buffer.length + paragraph.length + 2 > chunkSize) {
      chunks.push(buffer);
      buffer = chunkOverlap > 0 ? `${buffer.slice(-chunkOverlap)}\n\n${paragraph}` : paragraph;
    } else {
      buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks.map((c) => c.trim()).filter(Boolean);
}
