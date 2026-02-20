/**
 * Heartbeat Daemon — 心跳守护进程
 *
 * 对标 Conway: heartbeat/daemon.ts + heartbeat/scheduler.ts
 *
 * 关键设计：
 * - recursive setTimeout（不用 setInterval，防止 tick 重叠）—— Conway 同款
 * - 每次 tick 做轻量检查（不调 LLM）
 * - 发现问题 → enqueueSystemEvent 唤醒 Agent
 * - 紧急情况 → openclaw system event --mode now 立即唤醒
 */

import type { MossLoopConfig } from "../index.js";
import type { EconomyTracker, SurvivalTier } from "../economy/tracker.js";

export interface HeartbeatOptions {
  economy: EconomyTracker;
  config: MossLoopConfig;
  logger: any;
  runtime: any;
  stateDir: string;
}

export class HeartbeatDaemon {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickCount = 0;
  private lastThinkTime = 0;
  private lastServiceCheck: boolean = true;
  private lastBotCheck: boolean = true;

  constructor(private opts: HeartbeatOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastThinkTime = Date.now();

    // First tick immediately
    this.tick().catch((err) => {
      this.opts.logger.error(`[MOSS] First tick failed: ${err}`);
    });

    // Schedule subsequent ticks — Conway 式 recursive setTimeout
    this.scheduleTick();
    this.opts.logger.info("[MOSS] HeartbeatDaemon started");
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

  // ─── The Tick ──────────────────────────────────────────────

  private async tick(): Promise<void> {
    this.tickCount++;
    const { economy, logger, config } = this.opts;

    // === 每次心跳都做（轻量，不调 LLM）===

    // 1. 刷新经济状态
    await economy.refresh();

    // 2. 检查生存等级变化
    const tier = economy.getSurvivalTier();
    const prevTier = economy.getPreviousTier();

    if (tier !== prevTier && prevTier !== undefined) {
      logger.warn(`[MOSS] Survival tier: ${prevTier} → ${tier}`);
      if (this.tierWorse(tier, prevTier)) {
        await this.wakeAgent(
          `⚠️ 生存等级恶化: ${prevTier} → ${tier}，需要调整策略`,
          true, // 紧急
        );
        await this.notifyBoss(`🔴 MOSS 生存等级变化: ${prevTier} → ${tier}`);
      }
    }

    // 3. 检查 MOSS Agent 服务健康（每 5 次心跳检查一次 = 5 分钟）
    if (this.tickCount % 5 === 0) {
      const serviceOk = await this.checkServiceHealth();
      if (!serviceOk && this.lastServiceCheck) {
        // 从 OK 变成 NOT OK，首次故障才告警（避免重复）
        await this.wakeAgent("MOSS Agent 服务异常，需要诊断和修复", true);
      }
      this.lastServiceCheck = serviceOk;
    }

    // 4. 检查交易 Bot 状态（每 5 次心跳 = 5 分钟）
    if (this.tickCount % 5 === 0) {
      const botOk = await this.checkTradingBot();
      if (!botOk && this.lastBotCheck) {
        await this.wakeAgent("交易 Bot 异常，需要检查", true);
      }
      this.lastBotCheck = botOk;
    }

    // 5. 检查 x402 收入（TODO: 链上 USDC 查询）

    // === 周期性思考（唤醒 Agent 去思考，由 Agent 消耗 token）===
    const now = Date.now();
    const shouldThink =
      tier !== "danger" &&
      tier !== "hibernate" &&
      now - this.lastThinkTime > config.thinkIntervalMs;

    if (shouldThink) {
      this.lastThinkTime = now;
      await this.wakeAgent(
        "定时自主思考：检查待办、评估策略、探索机会",
        false, // 不紧急，等 OC heartbeat 自然触发
      );
    }

    // 持久化经济数据
    await economy.save();

    // 每 10 次 tick 打一条日志（避免刷屏）
    if (this.tickCount % 10 === 0) {
      logger.info(
        `[MOSS] 💓 tick #${this.tickCount} | tier=${tier} | balance=${economy.getState().balance.tokenCredits}`,
      );
    }
  }

  // ─── Wake Agent ────────────────────────────────────────────

  /**
   * 唤醒 Agent Session
   *
   * 对标 Conway: insertWakeEvent(db, source, reason)
   *
   * 普通事件：enqueueSystemEvent → 等 OC heartbeat drain
   * 紧急事件：+ openclaw system event --mode now → 秒级唤醒
   */
  private async wakeAgent(reason: string, urgent: boolean): Promise<void> {
    this.opts.logger.info(`[MOSS] 🔔 Wake${urgent ? " (URGENT)" : ""}: ${reason}`);

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
          ["system", "event", "--text", `[MOSS Loop] ${reason}`, "--mode", "now"],
          { timeoutMs: 10_000 },
        );
      }
    } catch (err) {
      this.opts.logger.error(`[MOSS] Wake failed: ${err}`);
    }
  }

  // ─── Notify BOSS ───────────────────────────────────────────

  /**
   * 直接给 BOSS 发 Telegram 消息（绕过 Agent，紧急通知）
   *
   * 对标 Conway: heartbeat 里的 distress signal
   */
  private async notifyBoss(message: string): Promise<void> {
    try {
      const sendMsg = this.opts.runtime?.channel?.telegram?.sendMessageTelegram;
      if (sendMsg) {
        await sendMsg(this.opts.config.bossChatId, message);
        this.opts.logger.info(`[MOSS] 📱 Notified BOSS: ${message}`);
      } else {
        this.opts.logger.warn("[MOSS] Cannot notify BOSS: Telegram runtime not available");
      }
    } catch (err) {
      this.opts.logger.error(`[MOSS] Notify BOSS failed: ${err}`);
    }
  }

  // ─── Health Checks ─────────────────────────────────────────

  private async checkServiceHealth(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.opts.config.serviceUrl}/ping`, {
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async checkTradingBot(): Promise<boolean> {
    try {
      const run = this.opts.runtime?.system?.runCommandWithTimeout;
      if (!run) return true; // 没有 runtime 就跳过

      const result = await run("pm2", ["jlist"], { timeoutMs: 5_000 });
      const processes = JSON.parse(result.stdout || "[]");
      const trader = processes.find(
        (p: any) => p.name === this.opts.config.tradingBotName,
      );
      return trader?.pm2_env?.status === "online";
    } catch {
      return true; // pm2 不可用不算 Bot 异常
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  private tierWorse(current: SurvivalTier, previous: SurvivalTier): boolean {
    const order: SurvivalTier[] = ["rich", "normal", "tight", "danger", "hibernate"];
    return order.indexOf(current) > order.indexOf(previous);
  }
}
