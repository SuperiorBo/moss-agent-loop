/**
 * Decision Logger — 决策日志
 *
 * 对标 Conway: agent/loop.ts 的 Observe→Persist 环节
 * 
 * Agent 被唤醒后做出决策，通过此模块持久化：
 * - 触发原因
 * - 思考过程摘要
 * - 采取的行动
 * - 结果
 *
 * 存储在 data/decisions/ 目录，按天分文件。
 * HeartbeatDaemon 的 packContext() 可以读取最近决策作为上下文。
 */

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────

export interface Decision {
  id: string;
  timestamp: string;
  trigger: string;          // 什么触发了这次思考
  context: string;          // 当时的上下文摘要
  reasoning: string;        // 思考过程
  actions: DecisionAction[];// 采取的行动
  outcome?: string;         // 结果（可事后补充）
  tokensUsed?: number;      // 本次思考消耗的 token
  tier: string;             // 做决策时的生存等级
}

export interface DecisionAction {
  type: "notify" | "fix" | "trade" | "memory" | "plan" | "skip" | "other";
  description: string;
  success: boolean;
}

// ─── Decision Logger ────────────────────────────────────────

export class DecisionLogger {
  private static instance: DecisionLogger | null = null;
  private dataDir: string;

  constructor(baseDir: string, private logger: any) {
    this.dataDir = join(baseDir, "decisions");
  }

  static getInstance(): DecisionLogger | null {
    return DecisionLogger.instance;
  }

  static setInstance(logger: DecisionLogger | null): void {
    DecisionLogger.instance = logger;
  }

  /**
   * Log a decision.
   */
  async log(decision: Omit<Decision, "id" | "timestamp">): Promise<string> {
    await mkdir(this.dataDir, { recursive: true });

    const now = new Date();
    const id = `dec_${now.toISOString().replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 6)}`;
    const full: Decision = {
      id,
      timestamp: now.toISOString(),
      ...decision,
    };

    // Append to today's file
    const today = now.toISOString().slice(0, 10);
    const filePath = join(this.dataDir, `${today}.jsonl`);

    try {
      await writeFile(filePath, JSON.stringify(full) + "\n", { flag: "a" });
      this.logger.info(`[MOSS] 📝 Decision logged: ${id} — ${decision.trigger.slice(0, 50)}`);
    } catch (err) {
      this.logger.error(`[MOSS] Decision log failed: ${err}`);
    }

    return id;
  }

  /**
   * Get recent decisions (last N entries across all days).
   */
  async getRecent(count: number = 10): Promise<Decision[]> {
    try {
      const files = await readdir(this.dataDir);
      const jsonlFiles = files.filter(f => f.endsWith(".jsonl")).sort().reverse();

      const decisions: Decision[] = [];
      for (const file of jsonlFiles) {
        if (decisions.length >= count) break;

        const raw = await readFile(join(this.dataDir, file), "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean).reverse();

        for (const line of lines) {
          if (decisions.length >= count) break;
          try {
            decisions.push(JSON.parse(line));
          } catch {
            // skip malformed lines
          }
        }
      }

      return decisions;
    } catch {
      return [];
    }
  }

  /**
   * Get a summary of recent decisions for context packing.
   */
  async getSummary(count: number = 5): Promise<string> {
    const decisions = await this.getRecent(count);
    if (decisions.length === 0) return "";

    const lines = decisions.map(d => {
      const ago = Math.round((Date.now() - new Date(d.timestamp).getTime()) / 60_000);
      const actionSummary = d.actions.map(a => `${a.success ? "✅" : "❌"} ${a.type}: ${a.description}`).join("; ");
      return `  ${ago}m ago [${d.trigger.slice(0, 30)}] → ${actionSummary}`;
    });

    return `[最近决策]\n${lines.join("\n")}`;
  }

  /**
   * Format for /moss command display.
   */
  async getReport(count: number = 10): Promise<string> {
    const decisions = await this.getRecent(count);
    if (decisions.length === 0) return "📝 暂无决策记录";

    const lines = decisions.map(d => {
      const time = d.timestamp.slice(5, 16);
      const actions = d.actions.map(a => {
        const icon = a.success ? "✅" : "❌";
        return `${icon} ${a.description}`;
      }).join("\n    ");
      return `🧠 ${time} — ${d.trigger}\n    ${actions}`;
    });

    return [`📝 最近 ${decisions.length} 条决策:`, "", ...lines].join("\n");
  }
}
