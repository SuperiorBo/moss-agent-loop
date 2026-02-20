/**
 * Heartbeat Daemon — 心跳守护进程（可扩展架构）
 *
 * 对标 Conway: heartbeat/daemon.ts + heartbeat/scheduler.ts
 *
 * 核心设计：
 * - Task 注册机制：具体业务检查项作为可插拔的 HeartbeatTask
 * - recursive setTimeout（不用 setInterval，防止 tick 重叠）—— Conway 同款
 * - 每次 tick 遍历所有注册的 task，根据 intervalTicks 决定是否执行
 * - 发现问题 → enqueueSystemEvent 唤醒 Agent（带完整上下文）
 * - 紧急情况 → openclaw system event --mode now 立即唤醒
 *
 * 内置只保留经济状态检查（MOSS 生存基础）。
 * 其他业务检查项通过 registerTask() 外部注册。
 */

import type { MossLoopConfig } from "../index.js";
import type { EconomyTracker, SurvivalTier } from "../economy/tracker.js";
import type { HeartbeatTask, HeartbeatTaskResult } from "./tasks.js";
import {
  createEconomyCheckTask,
  createThinkingTask,
} from "./tasks.js";

// ─── Types ──────────────────────────────────────────────────

export interface HeartbeatOptions {
  economy: EconomyTracker;
  config: MossLoopConfig;
  logger: any;
  runtime: any;
  stateDir: string;
}

/** Recent event for context packing */
interface RecentEvent {
  timestamp: number;
  taskName: string;
  message: string;
  urgent: boolean;
}

// ─── HeartbeatDaemon ────────────────────────────────────────

export class HeartbeatDaemon {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickCount = 0;

  /** Registered tasks */
  private tasks: HeartbeatTask[] = [];

  /** Recent wake events for context packing (ring buffer, last 20) */
  private recentEvents: RecentEvent[] = [];
  private readonly MAX_RECENT_EVENTS = 20;

  constructor(private opts: HeartbeatOptions) {
    // Register built-in tasks
    this.registerTask(createEconomyCheckTask(opts.economy));

    // Register periodic thinking task (if thinkIntervalMs > 0)
    if (opts.config.thinkIntervalMs > 0) {
      this.registerTask(
        createThinkingTask(opts.economy, {
          thinkIntervalMs: opts.config.thinkIntervalMs,
          heartbeatIntervalMs: opts.config.heartbeatIntervalMs,
        }),
      );
    }
  }

  // ─── Public API ─────────────────────────────────────────

  /**
   * Register a heartbeat task.
   * Tasks are executed based on their intervalTicks during each tick cycle.
   */
  registerTask(task: HeartbeatTask): void {
    // Prevent duplicate task names
    const existing = this.tasks.findIndex((t) => t.name === task.name);
    if (existing >= 0) {
      this.opts.logger.warn(
        `[MOSS] HeartbeatTask "${task.name}" already registered, replacing`,
      );
      this.tasks[existing] = task;
    } else {
      this.tasks.push(task);
      this.opts.logger.info(
        `[MOSS] HeartbeatTask registered: "${task.name}" (every ${task.intervalTicks} ticks)`,
      );
    }
  }

  /**
   * Unregister a task by name.
   */
  unregisterTask(name: string): boolean {
    const idx = this.tasks.findIndex((t) => t.name === name);
    if (idx >= 0) {
      this.tasks.splice(idx, 1);
      this.opts.logger.info(`[MOSS] HeartbeatTask unregistered: "${name}"`);
      return true;
    }
    return false;
  }

  /**
   * List all registered tasks.
   */
  listTasks(): Array<{ name: string; intervalTicks: number }> {
    return this.tasks.map((t) => ({
      name: t.name,
      intervalTicks: t.intervalTicks,
    }));
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // First tick immediately
    this.tick().catch((err) => {
      this.opts.logger.error(`[MOSS] First tick failed: ${err}`);
    });

    // Schedule subsequent ticks — Conway 式 recursive setTimeout
    this.scheduleTick();
    this.opts.logger.info(
      `[MOSS] HeartbeatDaemon started (${this.tasks.length} tasks registered)`,
    );
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opts.logger.info("[MOSS] HeartbeatDaemon stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─── Tick Loop ──────────────────────────────────────────

  private scheduleTick(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        this.opts.logger.error(`[MOSS] Heartbeat tick error: ${err}`);
      }
      this.scheduleTick();
    }, this.opts.config.heartbeatIntervalMs);
  }

  /**
   * The Tick — 遍历所有注册的 task，根据 intervalTicks 决定是否执行
   */
  private async tick(): Promise<void> {
    this.tickCount++;
    const { economy, logger } = this.opts;

    // Run all tasks that are due
    for (const task of this.tasks) {
      if (this.tickCount % task.intervalTicks !== 0) continue;

      try {
        const result = await task.run();

        if (result.shouldWake && result.message) {
          // Pack context and wake agent
          const contextMessage = this.packContext(task.name, result);
          await this.wakeAgent(contextMessage, result.urgent ?? false);

          // Track recent events
          this.trackEvent(task.name, result.message, result.urgent ?? false);

          // Special handling: economy-check urgent → notify BOSS directly
          if (task.name === "economy-check" && result.urgent) {
            await this.notifyBoss(`🔴 ${result.message}`);
          }
        }
      } catch (err) {
        logger.error(`[MOSS] Task "${task.name}" failed: ${err}`);
      }
    }

    // Persist economy data (always, regardless of tasks)
    await economy.save();

    // Periodic log (every 10 ticks, avoid spam)
    if (this.tickCount % 10 === 0) {
      logger.info(
        `[MOSS] 💓 tick #${this.tickCount} | tier=${economy.getSurvivalTier()} | balance=${economy.getState().balance.tokenCredits} | tasks=${this.tasks.length}`,
      );
    }
  }

  // ─── Context Packing (Thinking Loop) ───────────────────

  /**
   * Pack rich context into the wake event message.
   *
   * 当 HeartbeatDaemon 唤醒 Agent 时，把相关信息打包到 event text 中，
   * 让 Agent 醒来后有足够信息做出决策（Route C: Thinking Loop）。
   *
   * 包含：
   * - 触发原因
   * - 当前经济状态摘要
   * - 最近事件历史
   */
  private packContext(taskName: string, result: HeartbeatTaskResult): string {
    const { economy } = this.opts;
    const state = economy.getState();
    const tier = economy.getSurvivalTier();

    const sections: string[] = [];

    // 1. Trigger reason
    sections.push(`[触发] ${taskName}: ${result.message}`);

    // 2. Economy snapshot
    sections.push(
      [
        `[经济状态] 等级=${tier} | Token余额=${state.balance.tokenCredits.toLocaleString()} | USDC=$${state.balance.usdcBalance.toFixed(4)}`,
        `  今日: 收入+${state.today.tokensEarned.toLocaleString()} 支出-${state.today.tokensSpent.toLocaleString()} LLM调用${state.today.llmCalls}次`,
      ].join("\n"),
    );

    // 3. Recent events (last 5, for context)
    if (this.recentEvents.length > 0) {
      const recent = this.recentEvents.slice(-5);
      const eventLines = recent.map((e) => {
        const ago = Math.round((Date.now() - e.timestamp) / 60_000);
        const urgentTag = e.urgent ? "🔴" : "🔵";
        return `  ${urgentTag} ${ago}m ago [${e.taskName}] ${e.message}`;
      });
      sections.push(`[最近事件]\n${eventLines.join("\n")}`);
    }

    return sections.join("\n");
  }

  /**
   * Track a wake event in the recent events ring buffer.
   */
  private trackEvent(taskName: string, message: string, urgent: boolean): void {
    this.recentEvents.push({
      timestamp: Date.now(),
      taskName,
      message,
      urgent,
    });

    // Keep bounded
    if (this.recentEvents.length > this.MAX_RECENT_EVENTS) {
      this.recentEvents = this.recentEvents.slice(-this.MAX_RECENT_EVENTS);
    }
  }

  // ─── Wake Agent ────────────────────────────────────────

  /**
   * 唤醒 Agent Session（两级唤醒机制）
   *
   * 对标 Conway: insertWakeEvent(db, source, reason)
   *
   * 普通事件：enqueueSystemEvent → 等 OC heartbeat drain
   * 紧急事件：+ openclaw system event --mode now → 秒级唤醒
   */
  private async wakeAgent(reason: string, urgent: boolean): Promise<void> {
    this.opts.logger.info(
      `[MOSS] 🔔 Wake${urgent ? " (URGENT)" : ""}: ${reason.split("\n")[0]}`,
    );

    try {
      // Use runtime API to enqueue system event
      const enqueue = this.opts.runtime?.system?.enqueueSystemEvent;
      if (enqueue) {
        enqueue(`[MOSS Loop] ${reason}`);
      }

      // 紧急事件：立即触发 Agent 唤醒
      if (urgent && this.opts.runtime?.system?.runCommandWithTimeout) {
        await this.opts.runtime.system.runCommandWithTimeout(
          "openclaw",
          [
            "system",
            "event",
            "--text",
            `[MOSS Loop] ${reason}`,
            "--mode",
            "now",
          ],
          { timeoutMs: 10_000 },
        );
      }
    } catch (err) {
      this.opts.logger.error(`[MOSS] Wake failed: ${err}`);
    }
  }

  // ─── Notify BOSS ───────────────────────────────────────

  /**
   * 直接给 BOSS 发 Telegram 消息（绕过 Agent，紧急通知）
   *
   * 对标 Conway: heartbeat 里的 distress signal
   */
  private async notifyBoss(message: string): Promise<void> {
    try {
      const sendMsg =
        this.opts.runtime?.channel?.telegram?.sendMessageTelegram;
      if (sendMsg) {
        await sendMsg(this.opts.config.bossChatId, message);
        this.opts.logger.info(`[MOSS] 📱 Notified BOSS: ${message}`);
      } else {
        this.opts.logger.warn(
          "[MOSS] Cannot notify BOSS: Telegram runtime not available",
        );
      }
    } catch (err) {
      this.opts.logger.error(`[MOSS] Notify BOSS failed: ${err}`);
    }
  }
}
