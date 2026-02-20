/**
 * MOSS Agent Loop Plugin — 入口
 *
 * 把 Conway Automaton 的核心架构映射到 OpenClaw 插件体系：
 * - registerService → 心跳守护进程（Conway heartbeat/daemon.ts）
 * - registerTool → 经济系统工具（Conway agent/spend-tracker.ts）
 * - registerCommand → /moss 控制面板
 * - on("llm_output") → Token 消耗自动记账
 *
 * 新增：
 * - 暴露 moss.heartbeat.registerTask 供外部注册心跳检查项
 * - 暴露 HeartbeatTask 类型供外部使用
 */

import { createMossLoopService, getHeartbeatDaemon } from "./service.js";
import { createEconomyToolFactories } from "./tools/economy-tools.js";
import { createTokenTrackerHook } from "./hooks/token-tracker.js";
import { createMossCommand } from "./commands/moss-cmd.js";

// Re-export types for external consumers
export type { HeartbeatTask, HeartbeatTaskResult } from "./heartbeat/tasks.js";
export type { Decision, DecisionAction } from "./decisions/logger.js";
export { getHeartbeatDaemon } from "./service.js";

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

  // 5. 暴露 registerTask 供外部插件注册心跳检查项
  //    用法: api.set('moss.heartbeat.registerTask', ...)
  //    外部获取: const registerTask = otherPluginApi.get('moss.heartbeat.registerTask')
  if (api.set) {
    // Wrap registerTask to handle daemon not-yet-started case
    const registerTaskProxy = (task: any) => {
      const daemon = getHeartbeatDaemon();
      if (daemon) {
        daemon.registerTask(task);
      } else {
        // Daemon not started yet — queue and register on next service start
        api.logger.warn(
          `[MOSS] HeartbeatDaemon not started yet, queuing task "${task.name}"`,
        );
        pendingTasks.push(task);
      }
    };

    const unregisterTaskProxy = (name: string): boolean => {
      const daemon = getHeartbeatDaemon();
      if (daemon) {
        return daemon.unregisterTask(name);
      }
      // Remove from pending queue
      const idx = pendingTasks.findIndex((t: any) => t.name === name);
      if (idx >= 0) {
        pendingTasks.splice(idx, 1);
        return true;
      }
      return false;
    };

    const listTasksProxy = () => {
      const daemon = getHeartbeatDaemon();
      if (daemon) {
        return daemon.listTasks();
      }
      return pendingTasks.map((t: any) => ({
        name: t.name,
        intervalTicks: t.intervalTicks,
        status: "pending",
      }));
    };

    api.set("moss.heartbeat.registerTask", registerTaskProxy);
    api.set("moss.heartbeat.unregisterTask", unregisterTaskProxy);
    api.set("moss.heartbeat.listTasks", listTasksProxy);
    api.set("moss.heartbeat.getDaemon", getHeartbeatDaemon);
  }

  // Handle pending tasks when service starts
  // (gateway_start hook fires after services start)
  if (api.on) {
    api.on("gateway_start", () => {
      if (pendingTasks.length > 0) {
        const daemon = getHeartbeatDaemon();
        if (daemon) {
          for (const task of pendingTasks) {
            daemon.registerTask(task);
          }
          api.logger.info(
            `[MOSS] Registered ${pendingTasks.length} pending heartbeat tasks`,
          );
          pendingTasks.length = 0;
        }
      }
    });
  }

  api.logger.info("[MOSS] Agent Loop plugin registered ✅");
}

/** Queue for tasks registered before daemon starts */
const pendingTasks: any[] = [];
