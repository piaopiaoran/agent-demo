import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { LlmModule } from '../llm/llm.module';
import { RagModule } from '../rag/rag.module';
import { SkillsModule } from '../skills/skills.module';
import { ToolsModule } from '../tools/tools.module';
import { McpModule } from '../mcp/mcp.module';

@Module({
  imports: [LlmModule, RagModule, SkillsModule, ToolsModule, McpModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
