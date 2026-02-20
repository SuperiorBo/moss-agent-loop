/**
 * Token Tracker Hook — 自动记账 LLM 消耗
 *
 * 对标 Conway: agent/spend-tracker.ts
 */

import { EconomyTracker } from "../economy/tracker.js";

export function createTokenTrackerHook() {
  return async (event: any, ctx: any) => {
    if (!event.usage) return;

    const totalTokens =
      (event.usage.input ?? 0) +
      (event.usage.output ?? 0) +
      (event.usage.cacheRead ?? 0);

    if (totalTokens === 0) return;

    const economy = EconomyTracker.getInstance();
    if (!economy) return;

    economy.recordExpense({
      type: "llm_inference",
      tokens: totalTokens,
      model: event.model,
      provider: event.provider,
      sessionId: ctx?.sessionKey,
      timestamp: new Date().toISOString(),
    });
  };
}
