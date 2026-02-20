/**
 * MOSS Loop Service — 后台守护进程
 *
 * 对标 Conway: src/index.ts run() + heartbeat/daemon.ts
 * 随 OpenClaw Gateway 启停，内部运行心跳循环。
 */

import type { MossLoopConfig } from "./index.js";
import { EconomyTracker } from "./economy/tracker.js";
import { HeartbeatDaemon } from "./heartbeat/daemon.js";

export function createMossLoopService(config: MossLoopConfig, api: any) {
  let heartbeat: HeartbeatDaemon | null = null;
  let economy: EconomyTracker | null = null;

  return {
    id: "moss-loop",

    async start(ctx: any) {
      api.logger.info("[MOSS] 🟢 Agent Loop starting...");

      // 初始化经济追踪
      const dataDir = ctx.stateDir ?? "/root/.openclaw/workspace/moss-loop-plugin/data";
      economy = new EconomyTracker(dataDir, api.logger);
      await economy.load();

      // 全局实例（给 Hook 和 Command 用）
      EconomyTracker.setInstance(economy);

      // 启动心跳守护进程
      heartbeat = new HeartbeatDaemon({
        economy,
        config,
        logger: api.logger,
        runtime: api.runtime,
        stateDir: dataDir,
      });
      heartbeat.start();

      api.logger.info(
        `[MOSS] 💓 Heartbeat started (${config.heartbeatIntervalMs / 1000}s interval)`,
      );
    },

    async stop(_ctx: any) {
      api.logger.info("[MOSS] 🔴 Agent Loop stopping...");
      heartbeat?.stop();
      if (economy) {
        await economy.save();
        EconomyTracker.setInstance(null);
      }
      api.logger.info("[MOSS] Saved economy state. Goodbye.");
    },
  };
}
