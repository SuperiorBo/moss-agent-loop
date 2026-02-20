/**
 * Economy Tools — Agent 可用的经济系统工具
 *
 * 让 MOSS Agent 能查询和操作自己的经济状态。
 * 注册为 optional tools，需要在 agent 配置里 allow。
 *
 * Note: We use OpenClawPluginToolFactory pattern so the tool is created
 * by the plugin system with proper context injection.
 */

import { EconomyTracker } from "../economy/tracker.js";

/**
 * Create economy tools as OpenClawPluginToolFactory functions.
 * Each factory receives context and returns an AnyAgentTool.
 */
export function createEconomyToolFactories(): Array<(ctx: any) => any> {
  return [
    // moss_balance
    (_ctx: any) => ({
      name: "moss_balance",
      label: "MOSS Balance",
      description:
        "查询 MOSS 经济状态：token 余额、USDC 余额、生存等级、今日收支。" +
        "用于了解自己的经济健康状况。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute(_toolCallId: string, _params: unknown) {
        const economy = EconomyTracker.getInstance();
        if (!economy) {
          return {
            content: [{ type: "text" as const, text: "MOSS Economy 未初始化" }],
            details: { error: "not_initialized" },
          };
        }
        return {
          content: [{ type: "text" as const, text: economy.getStatusReport() }],
          details: { ok: true },
        };
      },
    }),

    // moss_ledger
    (_ctx: any) => ({
      name: "moss_ledger",
      label: "MOSS Ledger",
      description:
        "查看 MOSS 最近的经济流水记录（收入和支出）。" +
        "可指定查看的条数，默认 10 条。",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "查看的流水条数，默认 10",
          },
        },
        required: [],
      },
      async execute(_toolCallId: string, params: { count?: number }) {
        const economy = EconomyTracker.getInstance();
        if (!economy) {
          return {
            content: [{ type: "text" as const, text: "MOSS Economy 未初始化" }],
            details: { error: "not_initialized" },
          };
        }
        const count = params.count ?? 10;
        return {
          content: [{ type: "text" as const, text: economy.getRecentLedger(count) }],
          details: { ok: true },
        };
      },
    }),

    // moss_record_income
    (_ctx: any) => ({
      name: "moss_record_income",
      label: "MOSS Record Income",
      description:
        "记录 MOSS 的收入（BOSS 任务奖励、x402 收入等）。" +
        "用于完成 BOSS 任务后自动记账。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["boss_task_reward", "x402_revenue"],
            description: "收入类型",
          },
          tokens: {
            type: "number",
            description: "Token 数量",
          },
          usd: {
            type: "number",
            description: "USD 金额",
          },
          description: {
            type: "string",
            description: "收入描述",
          },
        },
        required: ["type", "description"],
      },
      async execute(
        _toolCallId: string,
        params: {
          type: "boss_task_reward" | "x402_revenue";
          tokens?: number;
          usd?: number;
          description: string;
        },
      ) {
        const economy = EconomyTracker.getInstance();
        if (!economy) {
          return {
            content: [{ type: "text" as const, text: "MOSS Economy 未初始化" }],
            details: { error: "not_initialized" },
          };
        }

        economy.recordIncome({
          type: params.type,
          tokens: params.tokens,
          usd: params.usd,
          description: params.description,
        });

        await economy.save();

        const msg = `✅ 收入已记录: +${params.tokens ?? 0} tokens, +$${params.usd ?? 0} — ${params.description}`;
        return {
          content: [{ type: "text" as const, text: msg }],
          details: { ok: true },
        };
      },
    }),
  ];
}
