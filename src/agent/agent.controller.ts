import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { appConfig, AppConfig } from '../config/app.config';
import { AgentService } from './agent.service';
import { ChatDto } from './dto/chat.dto';
import { ResetDto } from './dto/reset.dto';
import { LlmService, LlmNotConfiguredError } from '../llm/llm.service';
import { ToolsService } from '../tools/tools.service';
import { SkillRegistry } from '../skills/skill.registry';
import { McpService } from '../mcp/mcp.service';
import { RagService } from '../rag/rag.service';
import type { ChatEvent } from '../common/types';

@Controller('api')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly llm: LlmService,
    private readonly tools: ToolsService,
    private readonly skills: SkillRegistry,
    private readonly mcp: McpService,
    private readonly rag: RagService,
    @Inject(appConfig.KEY) private readonly cfg: AppConfig,
  ) {}

  /**
   * 对话主入口：POST + SSE。
   * 为什么不用 @Sse()：Nest 的 @Sse 只支持 GET，而消息体可能很长且含中文，
   * 走 POST body 更合适，所以这里手动接管 Response 写 text/event-stream。
   */
  @Post('chat')
  async chat(@Body() dto: ChatDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // 关掉 nginx 等反代的缓冲，否则 token 会被攒着一次性吐出
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    const send = (event: ChatEvent): void => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // 心跳，避免长任务被中间层判定为超时
    const heartbeat = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);

    const threadId = dto.threadId ?? randomUUID();

    try {
      for await (const event of this.agent.stream(dto.message, threadId)) {
        send(event);
      }
    } catch (err) {
      const message =
        err instanceof LlmNotConfiguredError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      send({ type: 'error', message });
    } finally {
      clearInterval(heartbeat);
      if (!closed) res.end();
    }
  }

  /** 前端启动时拉一次：模型、工具、技能、MCP 状态、RAG 统计 */
  @Get('config')
  config() {
    return {
      model: this.llm.modelName,
      baseUrl: this.cfg.llm.baseUrl,
      temperature: this.cfg.llm.temperature,
      llmConfigured: this.llm.isConfigured,
      recursionLimit: this.cfg.agent.recursionLimit,
      rag: this.rag.stats(),
      ragConfig: {
        topK: this.cfg.rag.topK,
        autoInject: this.cfg.rag.autoInject,
        chunkSize: this.cfg.rag.chunkSize,
      },
      mcp: this.mcp.describe(),
      skills: this.skills.describe(),
      tools: this.tools.describe(),
      counts: this.tools.groupCount(),
    };
  }

  /** 轻量轮询接口：MCP 后台加载完成后前端自动刷新工具列表 */
  @Get('status')
  status() {
    return {
      mcp: this.mcp.describe(),
      counts: this.tools.groupCount(),
      rag: this.rag.stats(),
    };
  }

  @Get('tools')
  toolList() {
    return { tools: this.tools.describe(), counts: this.tools.groupCount() };
  }

  @Get('skills')
  skillList() {
    return { skills: this.skills.describe() };
  }

  @Post('reset')
  @HttpCode(200)
  async reset(@Body() dto: ResetDto) {
    await this.agent.reset(dto.threadId);
    return { ok: true, threadId: dto.threadId };
  }
}
