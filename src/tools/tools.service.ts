import { Injectable } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { LocalToolsService, LOCAL_TOOL_META } from './local-tools.service';
import { RagToolsService } from '../rag/rag-tools.service';
import { RAG_TOOL_META } from '../rag/rag-tools.service';
import { SkillToolsService } from '../skills/skill-tools.service';
import { SKILL_TOOL_META } from '../skills/skill-tools.service';
import { McpService } from '../mcp/mcp.service';
import type { ToolDescriptor, ToolGroup } from '../common/types';

/**
 * 工具总装配：本地 5 + RAG 2 + Skill 2 + MCP N。
 * Agent 只依赖这一个 Service，新增工具来源时不必改图。
 */
@Injectable()
export class ToolsService {
  private readonly staticMeta: ToolDescriptor[];

  constructor(
    private readonly localTools: LocalToolsService,
    private readonly ragTools: RagToolsService,
    private readonly skillTools: SkillToolsService,
    private readonly mcp: McpService,
  ) {
    this.staticMeta = [...LOCAL_TOOL_META, ...RAG_TOOL_META, ...SKILL_TOOL_META];
  }

  all(): StructuredToolInterface[] {
    return [
      ...this.localTools.tools,
      ...this.ragTools.tools,
      ...this.skillTools.tools,
      ...this.mcp.getTools(),
    ];
  }

  describe(): ToolDescriptor[] {
    return [...this.staticMeta, ...this.mcp.descriptors()];
  }

  /** 前端 tool_start 事件需要展示中文名与分组 */
  labelOf(name: string): { label: string; group: ToolGroup } {
    const found = this.describe().find((item) => item.name === name);
    if (found) return { label: found.label, group: found.group };
    if (name.startsWith('mcp_')) return { label: name.replace(/^mcp_/, ''), group: 'mcp' };
    return { label: name, group: 'local' };
  }

  groupCount(): Record<ToolGroup, number> {
    return this.describe().reduce(
      (acc, item) => {
        acc[item.group] += 1;
        return acc;
      },
      { local: 0, rag: 0, skill: 0, mcp: 0 } as Record<ToolGroup, number>,
    );
  }
}
