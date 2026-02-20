/**
 * Economy Tracker — 经济状态追踪
 *
 * 对标 Conway: agent/spend-tracker.ts + survival/monitor.ts
 * 追踪 token 消耗、收入、生存等级。
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

// ─── Types ──────────────────────────────────────────────────

export type SurvivalTier = "rich" | "normal" | "tight" | "danger" | "hibernate";

export interface LedgerEntry {
  id: string;
  timestamp: string;
  type: "boss_task_reward" | "x402_revenue" | "llm_inference" | "x402_payment" | "manual_adjustment";
  direction: "income" | "expense";
  amount: number;
  unit: "tokens" | "usd";
  description: string;
  meta?: Record<string, unknown>;
}

export interface EconomyState {
  version: number;
  lastUpdated: string;

  balance: {
    tokenCredits: number;
    usdcBalance: number;
    survivalTier: SurvivalTier;
    previousTier: SurvivalTier;
  };

  totals: {
    lifetimeTokensEarned: number;
    lifetimeTokensSpent: number;
    lifetimeUsdcEarned: number;
    lifetimeUsdcSpent: number;
  };

  today: {
    date: string;
    tokensEarned: number;
    tokensSpent: number;
    usdcEarned: number;
    usdcSpent: number;
    llmCalls: number;
  };

  ledger: LedgerEntry[];

  config: {
    survivalThresholds: Record<SurvivalTier, number>;
    spendLimits: {
      maxSingleX402Usd: number;
      maxDailyX402Usd: number;
    };
  };
}

// ─── Default State ──────────────────────────────────────────

function createDefaultState(): EconomyState {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  return {
    version: 1,
    lastUpdated: now,

    balance: {
      tokenCredits: 0,
      usdcBalance: 0,
      survivalTier: "normal",
      previousTier: "normal",
    },

    totals: {
      lifetimeTokensEarned: 0,
      lifetimeTokensSpent: 0,
      lifetimeUsdcEarned: 0,
      lifetimeUsdcSpent: 0,
    },

    today: {
      date: today,
      tokensEarned: 0,
      tokensSpent: 0,
      usdcEarned: 0,
      usdcSpent: 0,
      llmCalls: 0,
    },

    ledger: [],

    config: {
      survivalThresholds: {
        rich: 1_000_000,
        normal: 200_000,
        tight: 50_000,
        danger: 10_000,
        hibernate: 0,
      },
      spendLimits: {
        maxSingleX402Usd: 0.01,
        maxDailyX402Usd: 0.10,
      },
    },
  };
}

// ─── Tracker ────────────────────────────────────────────────

export class EconomyTracker {
  private static instance: EconomyTracker | null = null;
  private state: EconomyState;
  private filePath: string;
  private dirty = false;

  constructor(private dataDir: string, private logger: any) {
    this.filePath = join(dataDir, "economy.json");
    this.state = createDefaultState();
  }

  // ── Singleton (for Hook and Command access) ──

  static getInstance(): EconomyTracker | null {
    return EconomyTracker.instance;
  }

  static setInstance(tracker: EconomyTracker | null): void {
    EconomyTracker.instance = tracker;
  }

  // ── Persistence ──

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const loaded = JSON.parse(raw) as EconomyState;
      this.state = { ...createDefaultState(), ...loaded };
      this.rolloverDay();
      this.logger.info(`[MOSS Economy] Loaded: ${this.state.balance.tokenCredits} tokens, tier=${this.state.balance.survivalTier}`);
    } catch {
      this.logger.info("[MOSS Economy] No existing state, starting fresh");
      this.state = createDefaultState();
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await mkdir(this.dataDir, { recursive: true });
      this.state.lastUpdated = new Date().toISOString();
      await writeFile(this.filePath, JSON.stringify(this.state, null, 2));
      this.dirty = false;
    } catch (err) {
      this.logger.error(`[MOSS Economy] Save failed: ${err}`);
    }
  }

  // ── Day rollover ──

  private rolloverDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.today.date !== today) {
      this.state.today = {
        date: today,
        tokensEarned: 0,
        tokensSpent: 0,
        usdcEarned: 0,
        usdcSpent: 0,
        llmCalls: 0,
      };
      this.dirty = true;
    }
  }

  // ── Record income ──

  recordIncome(entry: {
    type: LedgerEntry["type"];
    tokens?: number;
    usd?: number;
    description: string;
    meta?: Record<string, unknown>;
  }): void {
    this.rolloverDay();

    const tokens = entry.tokens ?? 0;
    const usd = entry.usd ?? 0;

    this.state.balance.tokenCredits += tokens;
    this.state.balance.usdcBalance += usd;
    this.state.totals.lifetimeTokensEarned += tokens;
    this.state.totals.lifetimeUsdcEarned += usd;
    this.state.today.tokensEarned += tokens;
    this.state.today.usdcEarned += usd;

    this.appendLedger({
      type: entry.type,
      direction: "income",
      amount: tokens || usd,
      unit: tokens ? "tokens" : "usd",
      description: entry.description,
      meta: entry.meta,
    });

    this.updateTier();
    this.dirty = true;
  }

  // ── Record expense ──

  recordExpense(entry: {
    type: LedgerEntry["type"];
    tokens?: number;
    usd?: number;
    description?: string;
    model?: string;
    provider?: string;
    sessionId?: string;
    timestamp?: string;
  }): void {
    this.rolloverDay();

    const tokens = entry.tokens ?? 0;
    const usd = entry.usd ?? 0;

    this.state.balance.tokenCredits -= tokens;
    this.state.totals.lifetimeTokensSpent += tokens;
    this.state.today.tokensSpent += tokens;
    this.state.today.usdcSpent += usd;
    this.state.today.llmCalls++;

    // Only log significant expenses to ledger (avoid flooding)
    if (tokens > 1000 || usd > 0) {
      this.appendLedger({
        type: entry.type,
        direction: "expense",
        amount: tokens || usd,
        unit: tokens ? "tokens" : "usd",
        description: entry.description ?? `${entry.model ?? "llm"} inference`,
        meta: {
          model: entry.model,
          provider: entry.provider,
          sessionId: entry.sessionId,
        },
      });
    }

    this.updateTier();
    this.dirty = true;
  }

  // ── Survival tier ──

  private updateTier(): void {
    const balance = this.state.balance.tokenCredits;
    const thresholds = this.state.config.survivalThresholds;

    this.state.balance.previousTier = this.state.balance.survivalTier;

    if (balance >= thresholds.rich) {
      this.state.balance.survivalTier = "rich";
    } else if (balance >= thresholds.normal) {
      this.state.balance.survivalTier = "normal";
    } else if (balance >= thresholds.tight) {
      this.state.balance.survivalTier = "tight";
    } else if (balance >= thresholds.danger) {
      this.state.balance.survivalTier = "danger";
    } else {
      this.state.balance.survivalTier = "hibernate";
    }
  }

  getSurvivalTier(): SurvivalTier {
    return this.state.balance.survivalTier;
  }

  getPreviousTier(): SurvivalTier {
    return this.state.balance.previousTier;
  }

  // ── Refresh (called by heartbeat) ──

  async refresh(): Promise<void> {
    this.rolloverDay();
    // Future: query AT API for actual token balance, query chain for USDC
  }

  // ── Ledger ──

  private appendLedger(partial: Omit<LedgerEntry, "id" | "timestamp">): void {
    const entry: LedgerEntry = {
      id: `tx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      ...partial,
    };
    this.state.ledger.push(entry);

    // Keep ledger bounded (last 500 entries)
    if (this.state.ledger.length > 500) {
      this.state.ledger = this.state.ledger.slice(-500);
    }
  }

  // ── Reports ──

  getStatusReport(): string {
    const s = this.state;
    const tierEmoji: Record<SurvivalTier, string> = {
      rich: "🟢",
      normal: "🟡",
      tight: "🟠",
      danger: "🔴",
      hibernate: "💀",
    };

    return [
      `📊 MOSS 经济状态`,
      ``,
      `${tierEmoji[s.balance.survivalTier]} 生存等级: ${s.balance.survivalTier}`,
      `💰 Token 余额: ${s.balance.tokenCredits.toLocaleString()}`,
      `💵 USDC 余额: $${s.balance.usdcBalance.toFixed(4)}`,
      ``,
      `📅 今日 (${s.today.date}):`,
      `  收入: +${s.today.tokensEarned.toLocaleString()} tokens, +$${s.today.usdcEarned.toFixed(4)}`,
      `  支出: -${s.today.tokensSpent.toLocaleString()} tokens, -$${s.today.usdcSpent.toFixed(4)}`,
      `  LLM 调用: ${s.today.llmCalls} 次`,
      ``,
      `📈 累计:`,
      `  总收入: ${s.totals.lifetimeTokensEarned.toLocaleString()} tokens / $${s.totals.lifetimeUsdcEarned.toFixed(4)}`,
      `  总支出: ${s.totals.lifetimeTokensSpent.toLocaleString()} tokens / $${s.totals.lifetimeUsdcSpent.toFixed(4)}`,
      ``,
      `🕐 更新: ${s.lastUpdated}`,
    ].join("\n");
  }

  getRecentLedger(count: number): string {
    const entries = this.state.ledger.slice(-count);
    if (entries.length === 0) return "📒 暂无流水记录";

    const lines = entries.map((e) => {
      const sign = e.direction === "income" ? "+" : "-";
      const emoji = e.direction === "income" ? "💚" : "💸";
      return `${emoji} ${e.timestamp.slice(5, 16)} ${sign}${e.amount} ${e.unit} — ${e.description}`;
    });

    return [`📒 最近 ${entries.length} 条流水:`, "", ...lines].join("\n");
  }

  // ── Getters for heartbeat ──

  getState(): EconomyState {
    return this.state;
  }
}
