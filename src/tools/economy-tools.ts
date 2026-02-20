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
import { DecisionLogger } from "../decisions/logger.js";

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

    // moss_log_decision
    (_ctx: any) => ({
      name: "moss_log_decision",
      label: "MOSS Log Decision",
      description:
        "记录一次自主决策。当 MOSS 被心跳唤醒并完成思考后，调用此工具记录：" +
        "触发原因、思考过程、采取的行动及结果。用于决策审计和自我反思。",
      parameters: {
        type: "object",
        properties: {
          trigger: {
            type: "string",
            description: "什么触发了这次思考（如：定时思考、生存等级恶化、服务异常）",
          },
          context: {
            type: "string",
            description: "做决策时的上下文摘要",
          },
          reasoning: {
            type: "string",
            description: "思考过程（为什么这么决定）",
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["notify", "fix", "trade", "memory", "plan", "skip", "other"],
                  description: "行动类型",
                },
                description: {
                  type: "string",
                  description: "行动描述",
                },
                success: {
                  type: "boolean",
                  description: "是否成功",
                },
              },
              required: ["type", "description", "success"],
            },
            description: "采取的行动列表",
          },
          outcome: {
            type: "string",
            description: "整体结果总结（可选）",
          },
        },
        required: ["trigger", "reasoning", "actions"],
      },
      async execute(
        _toolCallId: string,
        params: {
          trigger: string;
          context?: string;
          reasoning: string;
          actions: Array<{ type: string; description: string; success: boolean }>;
          outcome?: string;
        },
      ) {
        const decisionLogger = DecisionLogger.getInstance();
        if (!decisionLogger) {
          return {
            content: [{ type: "text" as const, text: "Decision Logger 未初始化" }],
            details: { error: "not_initialized" },
          };
        }

        const economy = EconomyTracker.getInstance();
        const tier = economy?.getSurvivalTier() ?? "unknown";

        const id = await decisionLogger.log({
          trigger: params.trigger,
          context: params.context ?? "",
          reasoning: params.reasoning,
          actions: params.actions as any,
          outcome: params.outcome,
          tier,
        });

        return {
          content: [{ type: "text" as const, text: `📝 决策已记录: ${id}` }],
          details: { ok: true, decisionId: id },
        };
      },
    }),

    // moss_decisions
    (_ctx: any) => ({
      name: "moss_decisions",
      label: "MOSS Decisions",
      description:
        "查看最近的自主决策记录。用于回顾之前的思考和行动，辅助当前决策。",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "查看条数，默认 5",
          },
        },
        required: [],
      },
      async execute(_toolCallId: string, params: { count?: number }) {
        const decisionLogger = DecisionLogger.getInstance();
        if (!decisionLogger) {
          return {
            content: [{ type: "text" as const, text: "Decision Logger 未初始化" }],
            details: { error: "not_initialized" },
          };
        }

        const report = await decisionLogger.getReport(params.count ?? 5);
        return {
          content: [{ type: "text" as const, text: report }],
          details: { ok: true },
        };
      },
    }),
  ];
}
