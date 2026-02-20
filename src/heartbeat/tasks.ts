/**
 * Heartbeat Tasks — 可插拔心跳检查项
 *
 * 对标 Conway: heartbeat/tasks.ts
 * 每个 task 返回 {shouldWake, urgent?, message?}
 *
 * 内置只保留经济状态检查（MOSS 生存基础）。
 * 其他业务检查项（服务健康、Trading Bot、x402 收入等）
 * 通过 registerTask 外部注册。
 */

import type { EconomyTracker, SurvivalTier } from "../economy/tracker.js";

// ─── Core Interface ─────────────────────────────────────────

export interface HeartbeatTaskResult {
  shouldWake: boolean;
  urgent?: boolean;
  message?: string;
}

export interface HeartbeatTask {
  /** Task name (for logging and dedup) */
  name: string;
  /** Execute every N ticks (1 = every tick, 5 = every 5th tick) */
  intervalTicks: number;
  /** Run the check. Must be lightweight — no LLM calls. */
  run(): Promise<HeartbeatTaskResult>;
}

// ─── Built-in: Economy Check Task ───────────────────────────

/**
 * 经济状态检查 — MOSS 生存基础
 *
 * 每次 tick 执行：
 * - 刷新经济状态
 * - 检测生存等级变化
 * - 余额过低告警
 */
export function createEconomyCheckTask(economy: EconomyTracker): HeartbeatTask {
  const tierOrder: SurvivalTier[] = ["rich", "normal", "tight", "danger", "hibernate"];

  function tierWorse(current: SurvivalTier, previous: SurvivalTier): boolean {
    return tierOrder.indexOf(current) > tierOrder.indexOf(previous);
  }

  return {
    name: "economy-check",
    intervalTicks: 1, // 每次 tick 都检查

    async run(): Promise<HeartbeatTaskResult> {
      // 刷新经济状态（轻量，不调 LLM）
      await economy.refresh();

      const tier = economy.getSurvivalTier();
      const prevTier = economy.getPreviousTier();

      // 生存等级恶化 → 紧急唤醒
      if (tier !== prevTier && prevTier !== undefined) {
        if (tierWorse(tier, prevTier)) {
          return {
            shouldWake: true,
            urgent: true,
            message: `⚠️ 生存等级恶化: ${prevTier} → ${tier}，需要调整策略`,
          };
        }
        // 等级改善，记录但不唤醒
      }

      // 余额低于 danger 阈值但等级未变 → 不重复唤醒
      // （等级变化时已经处理了）

      return { shouldWake: false };
    },
  };
}

// ─── Built-in: Periodic Thinking Task ───────────────────────

/**
 * 定时思考任务 — 让 MOSS 定期反思当前状态
 *
 * 可选，默认关闭。通过 config.thinkIntervalMs 控制。
 * 当 thinkIntervalMs > 0 时注册。
 *
 * 策略：
 * - 只在非危险等级时触发（省 token）
 * - 打包当前经济状态到消息中
 */
export function createThinkingTask(
  economy: EconomyTracker,
  opts: { thinkIntervalMs: number; heartbeatIntervalMs: number },
): HeartbeatTask {
  // 计算需要多少个 tick 间隔
  const intervalTicks = Math.max(
    1,
    Math.round(opts.thinkIntervalMs / opts.heartbeatIntervalMs),
  );

  return {
    name: "periodic-thinking",
    intervalTicks,

    async run(): Promise<HeartbeatTaskResult> {
      const tier = economy.getSurvivalTier();

      // 危险/冬眠模式下不浪费 token 去思考
      if (tier === "danger" || tier === "hibernate") {
        return { shouldWake: false };
      }

      const state = economy.getState();
      const contextLines = [
        `定时自主思考：检查待办、评估策略、探索机会`,
        ``,
        `当前经济状态:`,
        `  生存等级: ${tier}`,
        `  Token 余额: ${state.balance.tokenCredits.toLocaleString()}`,
        `  USDC 余额: $${state.balance.usdcBalance.toFixed(4)}`,
        `  今日消耗: ${state.today.tokensSpent.toLocaleString()} tokens (${state.today.llmCalls} 次 LLM 调用)`,
      ];

      return {
        shouldWake: true,
        urgent: false, // 不紧急，等 OC heartbeat 自然触发
        message: contextLines.join("\n"),
      };
    },
  };
}
