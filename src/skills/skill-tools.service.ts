import { Injectable } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { SkillRegistry } from './skill.registry';
import type { ToolDescriptor } from '../common/types';
import { defineTool } from '../tools/define-tool';

export const SKILL_TOOL_META: ToolDescriptor[] = [
  { name: 'list_skills', label: '技能目录', group: 'skill', description: '按需发现 5 个技能包' },
  { name: 'load_skill', label: '加载技能', group: 'skill', description: '把技能手册注入上下文' },
];

@Injectable()
export class SkillToolsService {
  constructor(private readonly registry: SkillRegistry) {}

  readonly listSkills = defineTool<Record<string, never>>({
    name: 'list_skills',
    description:
      '列出当前可用的技能包（每个技能是一套领域工作手册：调研报告 / 数据分析 / 写作润色 / 代码助手 / 翻译）。不确定该用哪个技能时先调用它。',
    schema: z.object({}),
    run: async () => {
      const skills = this.registry.list();
      if (skills.length === 0) return '暂无可用技能。';
      const lines = ['可用技能：'];
      skills.forEach((skill) => {
        lines.push(`- ${skill.name}（${skill.title}）：${skill.description}  标签：${skill.tags.join(',') || '无'}`);
      });
      lines.push('\n需要时用 load_skill(name) 加载对应技能的完整操作规范。');
      return lines.join('\n');
    },
  });

  readonly loadSkill = defineTool<{ name: string }>({
    name: 'load_skill',
    description:
      '加载指定技能的完整工作规范。加载后请在后续回答中严格遵循该规范；同一个技能在一次对话里只需加载一次。',
    schema: z.object({
      name: z.string().describe('技能名，取自 list_skills 的输出，例如 research-report'),
    }),
    run: async ({ name }) => {
      const skill = this.registry.get(name);
      if (!skill) {
        const available = this.registry.list().map((s) => s.name).join(', ') || '无';
        return `技能 ${name} 不存在。可用：${available}`;
      }
      return `已加载技能：${skill.title}（${skill.name}）\n\n${skill.body}`;
    },
  });

  get tools(): StructuredToolInterface[] {
    return [this.listSkills, this.loadSkill];
  }
}
