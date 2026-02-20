/**
 * MOSS Agent Loop Plugin — 入口
 *
 * 把 Conway Automaton 的核心架构映射到 OpenClaw 插件体系：
 * - registerService → 心跳守护进程（Conway heartbeat/daemon.ts）
 * - registerTool → 经济系统工具（Conway agent/spend-tracker.ts）
 * - registerCommand → /moss 控制面板
 * - on("llm_output") → Token 消耗自动记账
 */

import { createMossLoopService } from "./service.js";
import { createEconomyToolFactories } from "./tools/economy-tools.js";
import { createTokenTrackerHook } from "./hooks/token-tracker.js";
import { createMossCommand } from "./commands/moss-cmd.js";

export interface MossLoopConfig {
  enabled: boolean;
  heartbeatIntervalMs: number;
  thinkIntervalMs: number;
  bossChatId: string;
  serviceUrl: string;
  tradingBotName: string;
}

const DEFAULT_CONFIG: MossLoopConfig = {
  enabled: true,
  heartbeatIntervalMs: 60_000,
  thinkIntervalMs: 3_600_000,
  bossChatId: "7517182289",
  serviceUrl: "https://moss.chobon.top",
  tradingBotName: "solana-trader",
};

/**
 * Plugin entry — exported as a function (api) => void
 * This is the simplest and most reliable export format for OpenClaw plugins.
 */
export default function register(api: any) {
  const config: MossLoopConfig = {
    ...DEFAULT_CONFIG,
    ...(api.pluginConfig ?? {}),
  };

  if (!config.enabled) {
    api.logger.info("[MOSS] Plugin disabled by config");
    return;
  }

  // 1. 后台守护进程（心跳循环）— Conway heartbeat/daemon.ts
  api.registerService(createMossLoopService(config, api));

  // 2. Agent 工具（让 MOSS 能查自己的经济状态）— tool factory pattern
  const toolFactories = createEconomyToolFactories();
  for (const factory of toolFactories) {
    api.registerTool(factory, { optional: true });
  }

  // 3. Hook: 自动追踪每次 LLM token 消耗 — Conway agent/spend-tracker.ts
  api.on("llm_output", createTokenTrackerHook());

  // 4. /moss 命令 — BOSS 控制面板
  api.registerCommand(createMossCommand());

  api.logger.info("[MOSS] Agent Loop plugin registered ✅");
}
