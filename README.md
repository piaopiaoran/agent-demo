# Nova · LangChain + LangGraph 单 Agent 学习 Demo（NestJS）

一个"能看懂"的单 Agent 工程：**1 个 LLM + 1 张 LangGraph 图 + 4 类工具（本地 / RAG / Skill / MCP）+ 1 个前端输入界面**。

不追求功能多，追求每个文件都能对应上一个明确的概念，方便你按图索骥。

```
┌──────────────────────────── 浏览器（public/） ────────────────────────────┐
│  输入框 → POST /api/chat（SSE 流式：token / 工具轨迹 / 引用 / 技能加载）      │
└───────────────────────────────────┬───────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼───────────────────────────────────────┐
│ NestJS                                                                     │
│                                                                            │
│  AgentController ──► AgentService ──► LangGraph 图（MemorySaver 记忆）      │
│                                          │                                 │
│                          ┌───────────────┼────────────────┐                │
│                          ▼               ▼                ▼                │
│                     prefetch 节点     agent 节点       tools 节点            │
│                     （RAG 自动检索）  （LLM 决策）    （执行工具）            │
│                                          │                                 │
│                    ┌─────────────────────┴──────────────────┐              │
│                    ▼            ▼            ▼              ▼              │
│               本地工具 5     RAG 工具 2   Skill 工具 2   MCP 工具 N         │
│               （纯函数）    （向量/BM25） （list/load）  （5 个 server）      │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、快速开始

```bash
npm install
cp .env.example .env          # 填入 OPENAI_API_KEY（DeepSeek 等兼容端点改 BASE_URL + MODEL_NAME）
npm run start:dev
# 打开 http://127.0.0.1:3000
```

> 前端页面由 NestJS 直接托管 `public/`，不需要单独起前端服务。

---

## 二、目录结构与职责

```
src/
├── main.ts                     启动：全局 ValidationPipe、CORS、静态资源
├── app.module.ts               模块装配（Config / 静态页 / 6 个业务模块）
├── config/
│   └── app.config.ts           所有参数集中在这里（registerAs，强类型注入）
├── common/
│   └── types.ts                SSE 事件协议、工具/文档/技能的 DTO
├── llm/
│   └── llm.service.ts          模型工厂：ChatOpenAI + OpenAIEmbeddings（换供应商只改这里）
├── agent/
│   ├── agent.state.ts          ★ LangGraph 状态定义（Annotation + reducer）
│   ├── agent.graph.ts          ★ 图结构：prefetch → agent ⇄ tools
│   ├── agent.prompts.ts        ★ System Prompt 组装（含技能目录、RAG 上下文）
│   ├── agent.service.ts        ★ 图的编译/缓存 + 流式事件翻译成 SSE
│   ├── agent.controller.ts     POST /api/chat（SSE）、/api/config、/api/status
│   └── dto/                    class-validator 入参校验
├── tools/
│   ├── local-tools.service.ts  ★ 5 个本地工具
│   ├── define-tool.ts            工具统一构造入口（为什么不用 tool()，见第九节）
│   ├── expression-parser.ts      手写递归下降解析器（calculator 用它，不用 eval）
│   └── tools.service.ts        工具总装配 + 中文名映射
├── rag/
│   ├── rag.service.ts          ★ 切块 / 向量化 / JSON 索引 / 混合检索
│   ├── rag.splitter.ts            按段落切块 + overlap
│   ├── rag.text.ts                2-gram 分词 + BM25 + 余弦
│   ├── rag-tools.service.ts       search_knowledge_base / add_to_knowledge_base
│   └── rag.controller.ts          文档上传 / 列表 / 删除（multer）
├── skills/
│   ├── skill.registry.ts       ★ 扫描 library/*.md，解析 front matter
│   ├── skill-tools.service.ts     list_skills / load_skill
│   └── library/*.md            ★ 5 个技能包（Markdown 即提示词）
└── mcp/
    └── mcp.service.ts          ★ MultiServerMCPClient，5 个 server 并发加载
public/                         原生 JS 前端（无构建步骤）
mcp-servers.json                MCP server 配置（4 个 stdio + 1 个远程 http）
```

---

## 三、一次请求发生了什么

以「用调研报告技能总结我上传的文档」为例：

1. **前端**：`fetch POST /api/chat`，body `{ message, threadId }`，边读边解析 `data: {...}` 帧。
2. **Controller**：手动写 `text/event-stream`，`flushHeaders()` 后逐条 `res.write()`（原因见下方"为什么不用 @Sse"）。
3. **prefetch 节点**：用用户这句话去 RAG 检索 top-5，命中就存进 `state.context`，并把 `citations` 推给前端。
4. **agent 节点**：把 system prompt（含**技能目录** + RAG 上下文）+ 历史消息交给 LLM，LLM 返回 `tool_calls`。
5. **tools 节点**：`ToolNode` 按名字执行。模型先调 `load_skill({name:"research-report"})`，拿到完整方法论。
6. **回到 agent 节点**：这次带着技能正文，再决定是否调 `search_knowledge_base` 深挖；命中后生成答案。
7. **回流前端**：`on_chat_model_stream` → `token` 事件（打字机效果）；`on_tool_start/end` → 工具轨迹卡片；`on_chain_end(prefetch)` → 引用来源。

---

## 四、四个核心概念，分别看哪里

### 1. 图（LangGraph）

`src/agent/agent.graph.ts` 一共 20 行有效代码：

```ts
new StateGraph(AgentStateAnnotation)
  .addNode('prefetch', prefetch)
  .addNode('agent', agent)
  .addNode('tools', new ToolNode(tools))
  .addEdge(START, 'prefetch')
  .addEdge('prefetch', 'agent')
  .addConditionalEdges('agent', toolsCondition)   // 有 tool_calls 就去 tools，否则 END
  .addEdge('tools', 'agent')                      // 工具结果回灌
  .compile({ checkpointer });
```

三个值得注意的点：

- **state 用 reducer 合并**：`messages` 用 `messagesStateReducer`（累加），`context`/`citations` 用"后写覆盖"。这就是为什么多轮对话能记住上下文，而 RAG 上下文不会越堆越多。
- **`checkpointer` 是记忆本身**：`MemorySaver` 按 `threadId` 存整段 messages。换 `SqliteSaver` 就能持久化。
- **图会被重建，记忆不会丢**：MCP 后台加载完成后工具列表变了，`AgentService` 按"工具名签名"检测到变化就重新 `compile()`，但传入的是同一个 `MemorySaver` 实例，所以历史对话还在。

### 2. 工具（LangChain Tool）

`src/tools/local-tools.service.ts` 的 5 个工具：

| 工具 | 学到什么 |
|---|---|
| `calculator` | 用 zod 声明 schema，模型看到的是 JSON Schema；内部手写解析器，**不用 eval** |
| `current_time` | 用 Intl 处理 IANA 时区，避免自己算时差 |
| `save_note` | 写文件、slug 化、长度校验、错误以字符串返回（模型能读懂并重试） |
| `search_notes` | 本地检索 + 片段截取 |
| `fetch_webpage` | HTTP 抓取 + HTML 转文本 + **SSRF 防护**（拒绝内网地址） |

关键约定：**工具永远返回字符串**，失败也返回 `"计算失败：..."` 而不是 throw。这样模型能看到错误并自我修正，而不是让整条链路崩掉。

### 3. RAG（两条路径，自动降级）

```
文档 → 切块（800字/120重叠）→ embedding → JSON 索引
                                        │
问题 ──┬─► 向量余弦相似度 ──┐
       └─► BM25 词法检索 ───┴─► top-k → 拼进 prompt / 作为工具返回
```

- **有** `OPENAI_API_KEY`：走 `text-embedding-3-small` 向量检索。
- **没有 / 调用失败**：自动降级为 BM25（中文按 2-gram 切），demo 永远能跑。降级逻辑在 `rag.service.ts` 的 `embedDocuments()` + `llm.disableEmbeddings()`。
- 索引就是一个 JSON 文件（`data/index/rag-index.json`），可以直接打开看每块的文本和向量维度——比黑盒向量库更适合学习。
- **双通道**：`prefetch` 节点自动打底（省一轮往返）+ `search_knowledge_base` 工具按需深挖（模型自主）。

### 4. 技能（Skill）

一个 skill = 一个带 front matter 的 Markdown 文件：

```markdown
---
name: research-report
title: 深度调研报告
description: 需要多来源取证、交叉验证并产出结构化调研报告的场合
tags: [research, report, rag]
---
# 深度调研报告技能
1. 拆解问题……
```

**为什么不用 system prompt 直接塞 5 份规范**：常驻 prompt 只放 5 行目录（`skills.catalogText()`），模型判断相关时才 `load_skill` 把正文注入。加 10 个技能也不会撑爆上下文——这就是 Agent Skills 的核心思路。

本项目的 5 个技能：`research-report`（调研）、`data-analyst`（数据分析）、`writing-polish`（写作）、`code-assistant`（代码）、`translator`（翻译）。

### 5. MCP（远程工具）

`mcp-servers.json` 里 5 个 server：

| server | 传输 | 说明 |
|---|---|---|
| filesystem | stdio / npx | 读写 data 目录 |
| memory | stdio / npx | 知识图谱式长期记忆 |
| sequential-thinking | stdio / npx | 结构化思考步骤 |
| git | stdio / npx | 读取仓库历史 |
| deepwiki | **streamable_http** | 真·远程 MCP，无需本地进程 |

对 LangGraph 来说，MCP 工具和本地 `tool()` 完全一样——`MultiServerMCPClient.getTools()` 返回的就是 LangChain Tool。工程上做了三件事：

1. **故障隔离**：每个 server 单独建 client，一个挂掉不影响其它（`loadOne` 各自 try/catch）。
2. **非阻塞启动**：`onModuleInit` 里 `void this.loadAll()`，不 await。首次 `npx` 下载包可能要几十秒，不能拖住 HTTP 服务。
3. **命名空间**：工具名统一 `mcp_<server>_<tool>`，避免重名。

---

## 五、前端（public/）

原生 JS，无构建。核心就三件事：

- **流式解析**：`fetch` 拿到 `ReadableStream`，按 `\n\n` 切帧，`JSON.parse` 后按 `type` 分发（见 `app.js` 的 `sendMessage` / `handleEvent`）。
- **节流渲染**：token 每 50ms 重渲染一次 Markdown，而不是每个 token 都重排 DOM。
- **事件可视化**：`tool_start` 生成一张可展开的卡片（入参 / 结果 / 耗时），`skill` 生成徽章，`citations` 生成来源 chips——把 Agent 的"思考过程"暴露出来，比只显示最终答案更有教学价值。

---

## 六、如何扩展

**加一个本地工具**：在 `local-tools.service.ts` 里 `tool(...)` 一个，加进 `get tools()`，再在 `LOCAL_TOOL_META` 补一行中文名。图会自动重建，不用改别处。

**加一个技能**：往 `src/skills/library/` 丢一个 `.md`，front matter 写 `name/title/description`，重启生效（也可以调 `SkillRegistry.reload()` 热加载）。

**加一个 MCP server**：在 `mcp-servers.json` 里加一项，`enabled: true`。

**换模型**：改 `.env` 的 `OPENAI_BASE_URL` + `MODEL_NAME` 即可。DeepSeek：

```env
OPENAI_BASE_URL=https://api.deepseek.com/v1
MODEL_NAME=deepseek-chat
# 注：DeepSeek 无 embedding 接口，RAG 会自动走 BM25，不影响使用
```

**换持久化记忆**：`AgentService` 里把 `new MemorySaver()` 换成 `SqliteSaver` / `PostgresSaver`。

**支持 PDF / Word**：`rag.controller.ts` 的 `TEXT_EXTENSIONS` 之外加分支，用 `pdf-parse` / `mammoth` 先转文本再 `ingest()`。

---

## 七、几个刻意的设计选择

| 选择 | 原因 |
|---|---|
| 手写图而不用 `createReactAgent` | `createReactAgent` 一行搞定，但插不进 prefetch、审计、限流。手写才知道 LangGraph 在做什么 |
| RAG 用 JSON 索引而非向量库 | 学习场景要能"看见"索引；生产换 pgvector，接口不变 |
| 工具失败返回字符串而非 throw | 让模型读到错误再自我修正，是 Agent 鲁棒性的关键 |
| SSE 用 POST 而非 `@Sse()` | `@Sse()` 只支持 GET；长中文消息走 body 更稳 |
| 前端不用框架 | 少一层构建，直接读 `app.js` 就能看懂请求怎么发、流怎么解 |
| MCP 后台加载 + 轮询状态 | 首次 npx 慢，不能让用户以为服务挂了 |

---

## 八、已知限制（学习 demo 的边界）

- `MemorySaver` 存内存，重启即失忆；生产用 `SqliteSaver`。
- 索引全量存在内存数组里，万级以上片段需要换向量库。
- 无鉴权、无速率限制；只监听 `127.0.0.1`，别直接暴露公网。
- `deepwiki` 是公开示例 MCP，若不可用请在 `mcp-servers.json` 里关掉或换成你自己的 `streamable_http` 端点。
- `calculator` 的解析器只支持算术，不支持变量与方程。

---

## 九、踩过的坑（建议先读，能省你几小时）

### 1. `tool()` 触发 TS2589，tsc 直接吃满 4GB

**现象**：`npm run typecheck` 卡几分钟后 `JavaScript heap out of memory`，或者报 `TS2589: Type instantiation is excessively deep`。

**原因**：`@langchain/core` 0.3.80 + `zod` 3.25 + TypeScript 5.9 的组合下，`tool()` 的多重载配合 `InferInteropZodOutput` 的递归推断会爆栈。更隐蔽的是 **core 自带一份嵌套 zod**（`node_modules/@langchain/core/node_modules/zod`），和你项目根目录的 zod 是两套不同类型，重载匹配直接失败。

**做法**（本项目已采用）：

1. 锁定 `zod@3.23.8`、`@langchain/core@0.3.66`（写死在 `package.json`，不要随意放宽）；
2. 所有工具改用 `src/tools/define-tool.ts` 的 `defineTool()` 构造——底层就是 `DynamicStructuredTool`，正是 `tool()` 的实现，运行期行为完全一致；
3. 结果：全量 `tsc --noEmit` 从 OOM 降到 **2 秒**。

升级依赖后，先跑 `npm run typecheck`，2 秒左右通过才算正常。

### 2. LangGraph 的泛型会随链式调用层层叠加

`new StateGraph(...).addNode().addEdge().compile()` 连续推断会让类型深度爆炸。`agent.graph.ts` 用 `GraphBuilderLike` 窄接口把构造过程收敛掉，代价是链式调用失去静态检查（节点函数本身仍有 `AgentState` 类型约束）。这是 LangGraph JS 项目的常见折中。

### 3. `MemorySaver` 没有 `deleteThread`

只有 `SqliteSaver` / `PostgresSaver` 这类持久化实现才有。MemorySaver 的存储就是 `storage`、`writes` 两个以 threadId 为键的普通对象，重置会话直接 `delete` 键即可（见 `AgentService.reset`）。

### 4. npx 首次拉起 MCP 很慢

`npx -y @modelcontextprotocol/server-*` 第一次要下载包，几十秒很正常。所以 `McpService` 用 `void this.loadAll()` 放后台，前端轮询 `/api/status` 显示"连接中 N/5"，不阻塞 HTTP 服务启动。

### 5. SSE 用 POST 而不是 `@Sse()`

NestJS 的 `@Sse()` 装饰器只支持 GET 路由，而对话消息可能很长且含中文，塞进 query string 不合适。`AgentController.chat()` 直接接管 `Response` 手写 `text/event-stream`，并加 `X-Accel-Buffering: no` 防止反代缓冲导致"憋着不吐字"。
