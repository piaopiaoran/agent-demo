import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { appConfig } from './config/app.config';
import { LlmModule } from './llm/llm.module';
import { McpModule } from './mcp/mcp.module';
import { SkillsModule } from './skills/skills.module';
import { RagModule } from './rag/rag.module';
import { ToolsModule } from './tools/tools.module';
import { AgentModule } from './agent/agent.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    // 前端静态页（public/），/api/* 交给 Controller
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      exclude: ['/api/(.*)'],
    }),

    LlmModule,
    McpModule,
    SkillsModule,
    RagModule,
    ToolsModule,
    AgentModule,
  ],
})
export class AppModule {}
