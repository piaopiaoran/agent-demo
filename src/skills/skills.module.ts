import { Module } from '@nestjs/common';
import { SkillRegistry } from './skill.registry';
import { SkillToolsService } from './skill-tools.service';

@Module({
  providers: [SkillRegistry, SkillToolsService],
  exports: [SkillRegistry, SkillToolsService],
})
export class SkillsModule {}
