/**
 * MOSS Loop Service — 后台守护进程
 *
 * 对标 Conway: src/index.ts run() + heartbeat/daemon.ts
 * 随 OpenClaw Gateway 启停，内部运行心跳循环。
 *
 * 新增：暴露 HeartbeatDaemon 实例，供外部 registerTask。
 */

import type { MossLoopConfig } from "./index.js";
import { EconomyTracker } from "./economy/tracker.js";
import { HeartbeatDaemon } from "./heartbeat/daemon.js";
import { DecisionLogger } from "./decisions/logger.js";

/** Module-level daemon reference for external access */
let _daemonInstance: HeartbeatDaemon | null = null;

/**
 * Get the current HeartbeatDaemon instance.
 * Returns null if service hasn't started yet.
 */
export function getHeartbeatDaemon(): HeartbeatDaemon | null {
  return _daemonInstance;
}

export function createMossLoopService(config: MossLoopConfig, api: any) {
  let heartbeat: HeartbeatDaemon | null = null;
  let economy: EconomyTracker | null = null;

  return {
    id: "moss-loop",

    async start(ctx: any) {
      api.logger.info("[MOSS] 🟢 Agent Loop starting...");

      // 初始化经济追踪
      const dataDir =
        ctx.stateDir ??
        "/root/.openclaw/workspace/moss-loop-plugin/data";
      economy = new EconomyTracker(dataDir, api.logger);
      await economy.load();

      // 全局实例（给 Hook 和 Command 用）
      EconomyTracker.setInstance(economy);

      // 初始化决策日志
      const decisionLogger = new DecisionLogger(dataDir, api.logger);
      DecisionLogger.setInstance(decisionLogger);

      // 启动心跳守护进程
      heartbeat = new HeartbeatDaemon({
        economy,
        config,
        logger: api.logger,
        runtime: api.runtime,
        stateDir: dataDir,
      });
      heartbeat.start();

      // Expose daemon instance for external task registration
      _daemonInstance = heartbeat;

      api.logger.info(
        `[MOSS] 💓 Heartbeat started (${config.heartbeatIntervalMs / 1000}s interval)`,
      );
    },

    async stop(_ctx: any) {
      api.logger.info("[MOSS] 🔴 Agent Loop stopping...");
      heartbeat?.stop();
      _daemonInstance = null;
      if (economy) {
        await economy.save();
        EconomyTracker.setInstance(null);
      }
      DecisionLogger.setInstance(null);
      api.logger.info("[MOSS] Saved economy state. Goodbye.");
    },
  };
}
