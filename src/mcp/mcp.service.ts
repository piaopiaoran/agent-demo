import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { readFile } from 'node:fs/promises';
import { appConfig, AppConfig } from '../config/app.config';
import type { McpServerStatus, ToolDescriptor } from '../common/types';

interface McpServerConfig {
  label?: string;
  enabled?: boolean;
  transport?: 'stdio' | 'sse' | 'http' | 'streamable_http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 连接超时（>${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function safeName(name: string): string {
  return (name || 'tool').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

/** 把配置里的 ${cwd} 占位符替换成项目根目录，避免仓库里出现本机绝对路径 */
function expandCwd(value: string): string {
  return value.split('${cwd}').join(process.cwd());
}

/**
 * MCP 接入层（Model Context Protocol）。
 *
 * 核心思路：MCP server 提供工具清单，`MultiServerMCPClient` 把它们转换成 LangChain Tool，
 * 于是对 LangGraph 来说，远程工具和本地 `tool()` 没有任何区别 —— 这才是 MCP 的价值。
 *
 * 工程上的三个细节：
 * 1. **故障隔离**：每个 server 单独建 client，一个挂掉不影响其它 server。
 * 2. **非阻塞启动**：首次 `npx` 要下载包，可能几十秒，放后台加载，HTTP 服务先起来。
 * 3. **命名空间**：工具名统一 `mcp_<server>_<tool>`，避免不同 server 之间重名。
 */
@Injectable()
export class McpService implements OnModuleInit {
  private readonly logger = new Logger(McpService.name);
  private tools: StructuredToolInterface[] = [];
  private status: Record<string, McpServerStatus> = {};
  private toolServer = new Map<string, string>();
  private loading = false;
  private startedAt = 0;

  constructor(@Inject(appConfig.KEY) private readonly cfg: AppConfig) {}

  onModuleInit(): void {
    // 故意不 await：MCP 慢启动不应该拖住整个应用
    void this.loadAll();
  }

  private async readConfig(): Promise<Record<string, McpServerConfig>> {
    try {
      const raw = await readFile(this.cfg.mcp.configFile, 'utf-8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
      return parsed.mcpServers ?? {};
    } catch (err) {
      this.logger.warn(`MCP 配置读取失败：${(err as Error).message}`);
      this.status = {
        _config: {
          state: 'error',
          label: '配置',
          tools: 0,
          error: `读取 ${this.cfg.mcp.configFile} 失败：${(err as Error).message}`,
        },
      };
      return {};
    }
  }

  async loadAll(): Promise<void> {
    if (this.loading) return;
    if (!this.cfg.mcp.enabled) {
      this.status = { _global: { state: 'disabled', label: 'MCP', tools: 0, error: 'MCP_ENABLED=false' } };
      return;
    }

    this.loading = true;
    this.startedAt = Date.now();
    this.tools = [];
    this.toolServer.clear();

    const servers = await this.readConfig();
    this.status = Object.fromEntries(
      Object.entries(servers).map(([name, conf]) => [
        name,
        {
          state: conf.enabled === false ? 'disabled' : 'pending',
          label: conf.label ?? name,
          tools: 0,
          error: conf.enabled === false ? '配置中已关闭' : '',
        } satisfies McpServerStatus,
      ]),
    );

    try {
      const tasks = Object.entries(servers)
        .filter(([, conf]) => conf.enabled !== false)
        .map(([name, conf]) => this.loadOne(name, conf));
      await Promise.all(tasks);
    } finally {
      this.loading = false;
      const ok = Object.values(this.status).filter((s) => s.state === 'ok').length;
      this.logger.log(`MCP 加载完成：${ok} 个 server 可用，共 ${this.tools.length} 个工具`);
    }
  }

  private async loadOne(name: string, conf: McpServerConfig): Promise<void> {
    const started = Date.now();
    try {
      if (conf.transport === 'stdio' && !conf.command) throw new Error('stdio 模式缺少 command');
      if (conf.transport !== 'stdio' && !conf.url) throw new Error(`${conf.transport} 模式缺少 url`);

      const connection =
        conf.transport === 'stdio'
          ? {
              transport: 'stdio' as const,
              command: conf.command as string,
              args: (conf.args ?? []).map(expandCwd),
              env: conf.env
                ? Object.fromEntries(
                    Object.entries(conf.env).map(([key, value]) => [key, expandCwd(value)]),
                  )
                : undefined,
            }
          : {
              // @langchain/mcp-adapters 0.6 起，远程 transport 的字面量由
              // 'streamable_http' 改名为 'http'，这里同时兼容两种写法。
              transport: (conf.transport === 'sse' ? 'sse' : 'http') as 'sse' | 'http',
              url: conf.url as string,
              headers: conf.headers,
            };

      const client = new MultiServerMCPClient({
        // SDK 的连接类型是「多个形状的交叉类型」，判别式在这里无法收敛，断言一下
        mcpServers: { [name]: connection } as never,
      });
      const tools = await withTimeout(
        client.getTools(),
        this.cfg.mcp.loadTimeoutMs,
        `MCP server「${name}」`,
      );

      const registered: string[] = [];
      for (const item of tools) {
        const toolName = `mcp_${safeName(name)}_${safeName(item.name)}`.slice(0, 64);
        try {
          item.name = toolName; // LangChain Tool 的 name 可写，改完 ToolNode 就能按名字路由
        } catch {
          /* 某些工具 name 只读，保留原名 */
        }
        this.tools.push(item);
        this.toolServer.set(item.name, name);
        registered.push(item.name);
      }

      this.status[name] = {
        state: 'ok',
        label: conf.label ?? name,
        tools: registered.length,
        error: '',
        elapsedMs: Date.now() - started,
        toolNames: registered.slice(0, 40),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status[name] = {
        state: 'error',
        label: conf.label ?? name,
        tools: 0,
        error: message.slice(0, 300),
        elapsedMs: Date.now() - started,
      };
      this.logger.warn(`MCP server「${name}」连接失败：${message.slice(0, 200)}`);
    }
  }

  getTools(): StructuredToolInterface[] {
    return this.tools;
  }

  get isReady(): boolean {
    return !this.loading;
  }

  describe(): { state: string; servers: Record<string, McpServerStatus>; toolCount: number; elapsedMs: number } {
    const states = Object.values(this.status).map((s) => s.state);
    let state = 'pending';
    if (this.loading || states.includes('pending')) state = 'loading';
    else if (states.includes('ok')) state = 'ready';
    else if (states.length > 0 && states.every((s) => s === 'disabled')) state = 'disabled';
    else if (states.length > 0) state = 'error';

    return {
      state,
      servers: this.status,
      toolCount: this.tools.length,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  descriptors(): ToolDescriptor[] {
    return this.tools.map((item) => ({
      name: item.name,
      label: item.name.replace(/^mcp_/, ''),
      group: 'mcp' as const,
      description: (item.description ?? '').replace(/\s+/g, ' ').slice(0, 140),
      server: this.toolServer.get(item.name),
    }));
  }
}
