import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { RagService } from './rag.service';
import { RagToolsService } from './rag-tools.service';
import { RagController } from './rag.controller';

@Module({
  imports: [LlmModule],
  controllers: [RagController],
  providers: [RagService, RagToolsService],
  exports: [RagService, RagToolsService],
})
export class RagModule {}
