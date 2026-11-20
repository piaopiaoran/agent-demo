import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appConfig, AppConfig } from '../config/app.config';
import type { ToolDescriptor } from '../common/types';
import { evaluateExpression, formatNumber } from './expression-parser';
import { defineTool } from './define-tool';

export const LOCAL_TOOL_META: ToolDescriptor[] = [
  { name: 'calculator', label: '数学计算', group: 'local', description: '手写 AST 求值，不使用 eval' },
  { name: 'current_time', label: '时间查询', group: 'local', description: '任意 IANA 时区的当前时间' },
  { name: 'save_note', label: '写笔记', group: 'local', description: '把结论持久化为本地 Markdown' },
  { name: 'search_notes', label: '搜笔记', group: 'local', description: '关键词命中本地笔记库' },
  { name: 'fetch_webpage', label: '读网页', group: 'local', description: '抓取公开网页正文（含 SSRF 防护）' },
];

const MAX_NOTE_CHARS = 20_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function slugify(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (cleaned || `note-${Date.now()}`).slice(0, 60);
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80')) {
    return true;
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** 只允许访问公网 http(s)，拦截内网/回环地址，避免被 prompt 诱导做 SSRF */
async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https 协议');
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) {
    throw new Error('禁止访问本机地址');
  }
  try {
    const { address } = await lookup(url.hostname);
    if (isPrivateAddress(address)) throw new Error('目标解析到内网地址，已拦截');
  } catch (err) {
    if (err instanceof Error && err.message.includes('内网')) throw err;
    // DNS 解析失败交给 fetch 报错，避免误伤
  }
  return url;
}

function stripHtml(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  const text = html
    .replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();

  return { title, text };
}

/**
 * 5 个本地工具（纯本地执行，除 fetch_webpage 需要网络）。
 * schema 用 zod 声明，模型看到的是自动转换出的 JSON Schema。
 */
@Injectable()
export class LocalToolsService {
  private readonly logger = new Logger(LocalToolsService.name);

  constructor(@Inject(appConfig.KEY) private readonly cfg: AppConfig) {}

  // ---------------------------------------------------------------- 1. calculator
  readonly calculator = defineTool<{ expression: string }>({
    name: 'calculator',
    description:
      '做精确的数学计算。支持 + - * / % ** 与括号，以及 sqrt/log/ln/log2/exp/三角/abs/round/floor/ceil/min/max/factorial 等函数和 pi/e/tau 常量。任何算术都不要心算，一律调用它。',
    schema: z.object({
      expression: z.string().describe('要计算的表达式，例如 (128*3+96)/7 或 sqrt(144)+log10(1000)'),
    }),
    run: async ({ expression }) => {
      try {
        const value = evaluateExpression(expression);
        return `${expression.trim()} = ${formatNumber(value)}`;
      } catch (err) {
        return `计算失败：${(err as Error).message}`;
      }
    },
  });

  // ---------------------------------------------------------------- 2. current_time
  readonly currentTime = defineTool<{ timezone: string }>({
    name: 'current_time',
    description: '获取指定时区的当前日期时间（含星期、ISO 与 unix 时间戳）。涉及"今天/现在/本周"时必须先调用。',
    schema: z.object({
      timezone: z.string().describe('IANA 时区名，例如 Asia/Shanghai、UTC、America/New_York'),
    }),
    run: async ({ timezone }) => {
      try {
        const now = new Date();
        const formatted = new Intl.DateTimeFormat('zh-CN', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          weekday: 'long',
          timeZoneName: 'shortOffset',
        }).format(now);
        return `${formatted}\n时区: ${timezone}\nISO(UTC): ${now.toISOString()}\nunix: ${Math.floor(now.getTime() / 1000)}`;
      } catch {
        return `错误：无效时区 ${timezone}，示例：Asia/Shanghai、UTC、America/New_York`;
      }
    },
  });

  // ---------------------------------------------------------------- 3. save_note
  readonly saveNote = defineTool<{ title: string; content: string; tags?: string }>({
    name: 'save_note',
    description:
      '把一段内容写成 Markdown 笔记持久化到本地笔记库。适合沉淀阶段结论、待办清单、资料摘要，之后可用 search_notes 找回。',
    schema: z.object({
      title: z.string().describe('笔记标题，同时用于生成文件名'),
      content: z.string().describe('笔记正文，支持 Markdown'),
      tags: z.string().optional().describe('可选标签，英文逗号分隔，例如 langgraph,rag'),
    }),
    run: async ({ title, content, tags }) => {
      if (!content.trim()) return '错误：内容为空，未写入。';
      if (content.length > MAX_NOTE_CHARS) return `错误：内容过长（>${MAX_NOTE_CHARS} 字），请拆分后再保存。`;

      const slug = slugify(title);
      const file = join(this.cfg.paths.notes, `${slug}.md`);
      await mkdir(this.cfg.paths.notes, { recursive: true });

      const tagList = (tags ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      const body =
        `# ${title.trim() || slug}\n\n` +
        `<!-- saved_at: ${new Date().toISOString()} tags: ${tagList.join(',')} -->\n\n` +
        `${content.trim()}\n`;

      await writeFile(file, body, 'utf-8');
      this.logger.log(`笔记已写入 ${file}`);
      return `已保存笔记：${slug}.md（${content.length} 字，标签：${tagList.join('、') || '无'}）`;
    },
  });

  // ---------------------------------------------------------------- 4. search_notes
  readonly searchNotes = defineTool<{ query: string; limit: number }>({
    name: 'search_notes',
    description: '在本地笔记库中按关键词检索，返回命中的文件名、修改时间与相关片段。query 留空则返回最近的笔记。',
    schema: z.object({
      query: z.string().describe('关键词，多个关键词用空格分隔；留空表示列出最近笔记'),
      limit: z.number().int().min(1).max(10).describe('最多返回几条'),
    }),
    run: async ({ query, limit }) => {
      const dir = this.cfg.paths.notes;
      await mkdir(dir, { recursive: true });

      const names = (await readdir(dir)).filter((name) => name.endsWith('.md'));
      if (names.length === 0) return '笔记库为空。';

      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const scored: Array<{ name: string; score: number; text: string; mtime: number }> = [];

      for (const name of names) {
        const full = join(dir, name);
        const [text, info] = await Promise.all([readFile(full, 'utf-8'), stat(full)]);
        const low = text.toLowerCase();
        let score = 0;
        if (terms.length === 0) {
          score = 1;
        } else {
          for (const term of terms) {
            score += low.split(term).length - 1;
            if (name.toLowerCase().includes(term)) score += 3;
          }
        }
        if (score > 0) scored.push({ name, score, text, mtime: info.mtimeMs });
      }

      if (scored.length === 0) return `没有找到包含「${query}」的笔记（库内共 ${names.length} 条）。`;

      scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
      const top = scored.slice(0, Math.min(Math.max(limit ?? 5, 1), 10));

      const lines = [`命中 ${scored.length} 条，展示前 ${top.length} 条：`];
      top.forEach((item, index) => {
        const plain = item.text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
        const positions = terms.map((term) => plain.toLowerCase().indexOf(term)).filter((pos) => pos >= 0);
        const hitAt = positions.length ? Math.min(...positions) : 0;
        const snippet = plain.slice(Math.max(0, hitAt - 60), hitAt + 300);
        const time = new Date(item.mtime).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`\n[${index + 1}] ${item.name}（${time}，相关度 ${item.score}）\n${snippet}`);
      });
      return lines.join('\n');
    },
  });

  // ---------------------------------------------------------------- 5. fetch_webpage
  readonly fetchWebpage = defineTool<{ url: string; maxChars: number }>({
    name: 'fetch_webpage',
    description:
      '抓取一个公开网页并抽取可读正文（HTML 转纯文本）。用于阅读文章、官方文档、公告等外部资料；禁止用于内网地址。',
    schema: z.object({
      url: z.string().describe('完整 URL，必须以 http:// 或 https:// 开头'),
      maxChars: z.number().int().min(500).max(20_000).describe('正文最多返回多少字符，默认 6000'),
    }),
    run: async ({ url, maxChars }) => {
      let target: URL;
      try {
        target = await assertPublicUrl(url);
      } catch (err) {
        return `抓取失败：${(err as Error).message}`;
      }

      const limit = Math.min(Math.max(maxChars ?? 6000, 500), 20_000);
      try {
        const response = await fetch(target, {
          redirect: 'follow',
          signal: AbortSignal.timeout(25_000),
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 LangGraphDemo/1.0',
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          },
        });
        if (!response.ok) return `抓取失败：HTTP ${response.status} ${response.statusText}`;

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_HTML_BYTES) {
          return `抓取失败：页面过大（${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB > 2MB）`;
        }
        const raw = new TextDecoder('utf-8').decode(buffer);
        const contentType = response.headers.get('content-type') ?? '';
        const { title, text } =
          contentType.includes('html') || raw.trimStart().startsWith('<')
            ? stripHtml(raw)
            : { title: '', text: raw };

        if (!text) return `页面无可读正文（content-type=${contentType || 'unknown'}）`;
        const truncated = text.length > limit;
        return [
          `URL: ${target.toString()}`,
          `标题: ${title || '(无)'}`,
          `字符数: ${text.length}${truncated ? '（已截断）' : ''}`,
          '',
          text.slice(0, limit),
        ].join('\n');
      } catch (err) {
        return `抓取失败：${(err as Error).name}: ${(err as Error).message}`;
      }
    },
  });

  get tools(): StructuredToolInterface[] {
    return [this.calculator, this.currentTime, this.saveNote, this.searchNotes, this.fetchWebpage];
  }
}
