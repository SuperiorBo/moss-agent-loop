/**
 * /moss 命令 — BOSS 控制面板
 *
 * BOSS 在 Telegram 直接输入 /moss 查看经济状态。
 * 不经过 LLM，直接返回结果。
 */

import { EconomyTracker } from "../economy/tracker.js";

export function createMossCommand(): any {
  return {
    name: "moss",
    description: "MOSS 经济状态和控制面板",
    acceptsArgs: true,
    requireAuth: true,

    async handler(ctx: any) {
      const args = (ctx.args ?? "").trim();
      const economy = EconomyTracker.getInstance();

      if (!economy) {
        return { text: "❌ MOSS Economy 未初始化\n\n插件可能尚未启动，请检查 openclaw gateway status" };
      }

      // /moss 或 /moss status
      if (!args || args === "status") {
        return { text: economy.getStatusReport() };
      }

      // /moss ledger
      if (args === "ledger") {
        return { text: economy.getRecentLedger(10) };
      }

      // /moss ledger 20
      if (args.startsWith("ledger ")) {
        const count = parseInt(args.split(" ")[1]) || 10;
        return { text: economy.getRecentLedger(count) };
      }

      // /moss reward <amount> [description]
      if (args.startsWith("reward ")) {
        const parts = args.slice(7).trim().split(/\s+/);
        const amount = parseInt(parts[0]);
        const description = parts.slice(1).join(" ") || "BOSS 手动奖励";

        if (isNaN(amount) || amount <= 0) {
          return { text: "❌ 金额无效。用法: /moss reward 50000 完成了xx任务" };
        }

        economy.recordIncome({
          type: "boss_task_reward",
          tokens: amount,
          description,
        });
        await economy.save();

        return {
          text: `✅ 奖励已记录: +${amount.toLocaleString()} tokens — ${description}\n\n当前余额: ${economy.getState().balance.tokenCredits.toLocaleString()} tokens`,
        };
      }

      // /moss help
      return {
        text: [
          "📊 /moss — MOSS 经济控制面板",
          "",
          "命令:",
          "  /moss status — 经济状态总览",
          "  /moss ledger [数量] — 流水记录（默认10条）",
          "  /moss reward <tokens> [描述] — 记录任务奖励",
          "",
          "示例:",
          "  /moss reward 50000 完成 ClawWork 深度分析",
        ].join("\n"),
      };
    },
  };
}
