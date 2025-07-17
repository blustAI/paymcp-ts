/**
 * Minimal "MCP-like" surface we need.  Deliberately *structural* so that paymcp
 * does NOT take a hard (runtime) dependency on @modelcontextprotocol/sdk.
 *
 * Any object that exposes a `registerTool(name, config, handler)` function
 * compatible with the MCP server API will work.  Optional `tools` map is used
 * only when `retrofitExisting` is enabled; it's best‑effort and safe to omit.
 */
export interface McpServerLike {
  registerTool(
    name: string,
    config: any,
    handler: (...args: any[]) => Promise<any> | any
  ): any;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- some servers expose a Map<string, {config, handler}>
  tools?: Map<string, { config: any; handler: (...args: any[]) => any }>;
}