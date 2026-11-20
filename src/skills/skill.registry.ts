import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillDescriptor } from '../common/types';

export interface Skill extends SkillDescriptor {
  body: string;
  file: string;
}

/** 解析 `---` 包裹的简易 front matter（只为 skill 元数据服务，不引入 yaml 依赖） */
function parseFrontMatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string | string[]> = {};
  let lastKey = '';

  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    if (/^\s+\S/.test(line) && lastKey) {
      meta[lastKey] = `${String(meta[lastKey])} ${line.trim()}`.trim();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    lastKey = key;
    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: match[2] };
}

/**
 * Skill 注册表：扫描 skills/library/*.md，把元数据与正文装进内存。
 *
 * 为什么需要 skill：把领域方法论（怎么写调研报告、怎么审查代码）从 system prompt 里拿出来，
 * 变成可按需加载的"工作手册"。模型先 list_skills 看目录，再 load_skill 把正文注入上下文，
 * 这样常驻 prompt 只有 5 行目录，而不是 5 份完整规范。
 */
@Injectable()
export class SkillRegistry implements OnModuleInit {
  private readonly logger = new Logger(SkillRegistry.name);
  private skills = new Map<string, Skill>();

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  private resolveDir(): string {
    const candidates = [
      join(__dirname, 'library'), // 编译后：dist/skills/library
      join(process.cwd(), 'src', 'skills', 'library'), // 源码运行
    ];
    return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
  }

  async reload(): Promise<void> {
    const dir = this.resolveDir();
    const next = new Map<string, Skill>();
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const raw = await readFile(join(dir, file), 'utf-8');
        const { meta, body } = parseFrontMatter(raw);
        const name = String(meta.name ?? file.replace(/\.md$/, '')).trim();
        const tags = Array.isArray(meta.tags)
          ? meta.tags
          : String(meta.tags ?? '')
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);

        next.set(name, {
          name,
          title: String(meta.title ?? name),
          description: String(meta.description ?? '').trim(),
          tags,
          body: body.trim(),
          file,
        });
      }
    } catch (err) {
      this.logger.warn(`技能目录读取失败：${dir}（${(err as Error).message}）`);
    }
    this.skills = next;
    this.logger.log(`已加载 ${next.size} 个技能：${[...next.keys()].join(', ') || '无'}`);
  }

  get(name: string): Skill | undefined {
    const key = name.trim().toLowerCase();
    const direct = this.skills.get(key);
    if (direct) return direct;
    return [...this.skills.values()].find(
      (skill) => skill.name.toLowerCase() === key || skill.title.toLowerCase() === key,
    );
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  describe(): SkillDescriptor[] {
    return this.list().map(({ name, title, description, tags }) => ({ name, title, description, tags }));
  }

  /** 给 system prompt 用的极简目录（一行一个技能） */
  catalogText(): string {
    return this.list()
      .map((skill) => `- \`${skill.name}\` — ${skill.title}：${skill.description}`)
      .join('\n');
  }
}
