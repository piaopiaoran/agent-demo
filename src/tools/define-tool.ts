import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ZodTypeAny } from 'zod';

export interface ToolDefinition<Input> {
  name: string;
  description: string;
  /** zod schema：会被转成 JSON Schema 交给模型 */
  schema: ZodTypeAny;
  run: (input: Input) => Promise<string> | string;
}

/**
 * 工具定义的统一入口（所有工具都从这里造）。
 *
 * 为什么不用官方的 `tool()` 工厂：
 * 在当前依赖组合下（@langchain/core 0.3.x + zod 3.25 + TypeScript 5.9），`tool()`
 * 的多重载会触发 TS2589「类型实例化过深」，tsc 堆内存直接爆掉（实测 4GB OOM）。
 * `DynamicStructuredTool` 正是 `tool()` 的底层实现，构造方式稳定、类型可控，
 * 运行期行为完全一致（schema 照样转成 JSON Schema 给模型）。
 *
 * 如果你的项目里只有一份 zod（没有嵌套 node_modules/zod），可以放心换回 `tool()`。
 */
export function defineTool<Input>(def: ToolDefinition<Input>): StructuredToolInterface {
  return new DynamicStructuredTool({
    name: def.name,
    description: def.description,
    // 断言只为绕过「两份 zod 类型」的兼容检查，运行期仍是标准 zod schema
    schema: def.schema as never,
    func: async (input: unknown) => def.run(input as Input),
  });
}
