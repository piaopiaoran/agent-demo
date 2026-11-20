import { Module } from '@nestjs/common';
import { LocalToolsService } from './local-tools.service';
import { ToolsService } from './tools.service';
import { RagModule } from '../rag/rag.module';
import { SkillsModule } from '../skills/skills.module';
import { McpModule } from '../mcp/mcp.module';

@Module({
  imports: [RagModule, SkillsModule, McpModule],
  providers: [LocalToolsService, ToolsService],
  exports: [ToolsService],
})
export class ToolsModule {}
