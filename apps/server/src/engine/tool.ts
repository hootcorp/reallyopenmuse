import type { z } from "zod";

/**
 * A server-side tool the model may call. `parameters` is a Zod schema; `execute` receives the
 * parsed arguments. Method syntax keeps tools with different schemas assignable to ToolDefinition[].
 */
export interface ToolDefinition<TParameters extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: TParameters;
  execute(args: z.infer<TParameters>): Promise<unknown>;
}

export function defineTool<TParameters extends z.ZodType>(
  tool: ToolDefinition<TParameters>,
): ToolDefinition<TParameters> {
  return tool;
}
