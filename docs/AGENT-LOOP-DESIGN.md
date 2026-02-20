# MOSS Agent Loop — OpenClaw 插件方案

> 把 Agent Loop 做成 OpenClaw 插件，嵌入 OpenClaw 进程内部运行
>
> 创建日期：2026-02-20
> 取代：之前的独立进程 / Cron 方案

---

## 1. 为什么做插件而不是独立进程

| 方案 | 优点 | 缺点 |
|------|------|------|
| Cron 模拟 | 简单 | 无状态、割裂、延迟高 |
| 独立进程 (PM2) | 完全自主 | 跟 OpenClaw 脱节，重复造轮子 |
| **OpenClaw 插件** ✅ | 嵌入宿主进程、共享基础设施、原生生命周期 | 受插件 API 约束 |

插件方案的核心优势：
- **`registerService`** — 随 OpenClaw Gateway 启停的后台守护进程
- **`registerTool`** — 给 agent 增加经济系统工具（查余额、记账）
- **`registerCommand`** — 给 BOSS 增加 `/moss` 命令（查收支、改配置）
- **Hook 系统** — 拦截每次 LLM 调用，自动记账 token 消耗
- **共享配置** — 不用维护独立的配置文件
- 同一进程内访问 OpenClaw 所有能力

---

## 2. 插件架构

```
/root/.openclaw/workspace/moss-loop-plugin/
├── openclaw.plugin.json      # 插件清单
├── package.json
├── src/
│   ├── index.ts              # 插件入口
│   ├── service.ts            # 后台 Agent Loop 守护进程
│   ├── economy/
│   │   ├── tracker.ts        # 收支追踪
│   │   ├── ledger.ts         # 账本读写
│   │   └── tiers.ts          # 生存等级
│   ├── heartbeat/
│   │   ├── daemon.ts         # 心跳循环
│   │   └── tasks.ts          # 心跳任务（查余额/健康/消息）
│   ├── tools/
│   │   ├── economy-tools.ts  # agent 可用: moss_balance, moss_ledger
│   │   └── self-tools.ts     # agent 可用: moss_think, moss_status
│   ├── commands/
│   │   └── moss-cmd.ts       # /moss 命令：查账、配置
│   └── hooks/
│       └── token-tracker.ts  # Hook: 每次 LLM 调用自动记账
└── data/
    └── economy.json          # 经济数据持久化
```

---

## 3. 核心代码设计

### 3.1 插件入口 (index.ts)

```typescript
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk";
import { createMossLoopService } from "./service.js";
import { createEconomyTools } from "./tools/economy-tools.js";
import { createTokenTrackerHook } from "./hooks/token-tracker.js";
import { createMossCommand } from "./commands/moss-cmd.js";

const plugin: OpenClawPluginDefinition = {
  id: "moss-loop",
  name: "MOSS Agent Loop",
  description: "自主经济体守护进程 — 心跳、记账、生存",
  version: "0.1.0",

  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      heartbeatIntervalMs: { type: "number", default: 60000 },
      thinkIntervalMs: { type: "number", default: 3600000 },
      enabled: { type: "boolean", default: true },
    },
  },

  async register(api) {
    const config = api.pluginConfig as any ?? {};

    // 1. 后台守护进程（心跳循环）
    api.registerService(createMossLoopService(config, api.logger));

    // 2. Agent 工具（让 MOSS 能查自己的经济状态）
    for (const tool of createEconomyTools()) {
      api.registerTool(tool, { optional: true });
    }

    // 3. Hook: 自动追踪每次 LLM token 消耗
    api.on("llm_output", createTokenTrackerHook());

    // 4. /moss 命令
    api.registerCommand(createMossCommand());

    api.logger.info("MOSS Agent Loop plugin registered ✅");
  },
};

export default plugin;
```

### 3.2 后台守护进程 (service.ts)

```typescript
import type { OpenClawPluginService, PluginLogger } from "openclaw/plugin-sdk";
import { EconomyTracker } from "./economy/tracker.js";
import { HeartbeatDaemon } from "./heartbeat/daemon.js";

export function createMossLoopService(
  config: any,
  logger: PluginLogger,
): OpenClawPluginService {
  let heartbeat: HeartbeatDaemon | null = null;
  let economy: EconomyTracker | null = null;

  return {
    id: "moss-loop",

    async start(ctx) {
      logger.info("[MOSS] 🟢 Agent Loop starting...");

      // 初始化经济追踪
      economy = new EconomyTracker(ctx.stateDir, logger);
      await economy.load();

      // 启动心跳守护进程
      heartbeat = new HeartbeatDaemon({
        economy,
        intervalMs: config.heartbeatIntervalMs ?? 60_000,
        thinkIntervalMs: config.thinkIntervalMs ?? 3_600_000,
        logger,
        stateDir: ctx.stateDir,
        config: ctx.config,
      });
      heartbeat.start();

      logger.info(
        `[MOSS] 💓 Heartbeat started (${(config.heartbeatIntervalMs ?? 60000) / 1000}s interval)`,
      );
    },

    async stop(ctx) {
      logger.info("[MOSS] 🔴 Agent Loop stopping...");
      heartbeat?.stop();
      await economy?.save();
      logger.info("[MOSS] Saved economy state. Goodbye.");
    },
  };
}
```

### 3.3 心跳守护 (heartbeat/daemon.ts)

```typescript
// Conway 式心跳，但跑在 OpenClaw 进程内部
// 关键能力：通过 enqueueSystemEvent 唤醒 Agent Session

import { enqueueSystemEvent } from "openclaw/plugin-sdk";
import { sendMessageTelegram } from "openclaw/plugin-sdk";

export class HeartbeatDaemon {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickCount = 0;
  private lastThinkTime = 0;

  constructor(private opts: HeartbeatOptions) {}

  start() {
    this.running = true;
    this.scheduleTick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleTick() {
    if (!this.running) return;
    // Conway 式 recursive setTimeout（防止 tick 重叠）
    this.timer = setTimeout(async () => {
      try {
        await this.tick();
      } catch (err) {
        this.opts.logger.error(`[MOSS] Heartbeat tick error: ${err}`);
      }
      this.scheduleTick();
    }, this.opts.intervalMs);
  }

  private async tick() {
    this.tickCount++;
    const { economy, logger } = this.opts;

    // === 每次心跳都做（轻量，不调 LLM）===

    // 1. 更新经济状态
    await economy.refresh();

    // 2. 判断生存等级变化
    const tier = economy.getSurvivalTier();
    const prevTier = economy.getPreviousTier();

    if (tier !== prevTier) {
      logger.warn(`[MOSS] ⚠️ Survival tier: ${prevTier} → ${tier}`);
      if (this.tierWorse(tier, prevTier)) {
        // 等级恶化 → 唤醒 Agent 处理 + 通知 BOSS
        await this.wakeAgent(`⚠️ 生存等级恶化: ${prevTier} → ${tier}，需要调整策略`);
        await this.notifyBoss(`🔴 MOSS 生存等级变化: ${prevTier} → ${tier}`);
      }
    }

    // 3. 检查 MOSS Agent 服务健康
    const serviceOk = await this.checkServiceHealth();
    if (!serviceOk) {
      await this.wakeAgent("MOSS Agent 服务异常，需要诊断和修复");
    }

    // 4. 检查交易 Bot 状态
    const botOk = await this.checkTradingBot();
    if (!botOk) {
      await this.wakeAgent("交易 Bot 异常，需要检查");
    }

    // 5. 检查有没有待处理的 x402 收入
    const newIncome = await this.checkX402Income();
    if (newIncome > 0) {
      await this.wakeAgent(`收到 x402 收入 $${newIncome}，更新账本`);
    }

    // === 周期性思考（唤醒 Agent 去思考，由 Agent 消耗 token）===
    const now = Date.now();
    const shouldThink =
      tier !== "danger" &&
      tier !== "hibernate" &&
      now - this.lastThinkTime > this.opts.thinkIntervalMs;

    if (shouldThink) {
      this.lastThinkTime = now;
      await this.wakeAgent("定时自主思考：检查待办、评估策略、探索机会");
    }

    // 持久化
    await economy.save();
  }

  // ═══════════════════════════════════════════
  // 🔑 核心：唤醒 Agent Session
  // ═══════════════════════════════════════════

  /**
   * 唤醒 MOSS Agent Session
   * 
   * 机制：enqueueSystemEvent 把消息注入 Agent 的主 session，
   * 下次 heartbeat poll 时 Agent 会看到这条系统消息并据此行动。
   * 
   * 这就是 Conway 的 wake_events 表在 OpenClaw 里的等价物。
   */
  private async wakeAgent(reason: string) {
    this.opts.logger.info(`[MOSS] 🔔 Wake Agent: ${reason}`);
    
    // 方式1：注入系统事件到 Agent 主 session
    // Agent 下次被触发时（heartbeat/用户消息/cron）会看到这条消息
    enqueueSystemEvent(
      `[MOSS Loop] ${reason}`,
      { sessionKey: this.opts.agentSessionKey }
    );

    // 方式2（可选）：如果是紧急事件，直接触发一次立即心跳
    // 效果 = `openclaw system event --mode now`
    if (this.isUrgent(reason)) {
      // 通过 runtime.system.enqueueSystemEvent 触发即时唤醒
      // 或者用 exec 调用 CLI
      const { runCommandWithTimeout } = this.opts.runtime.system;
      await runCommandWithTimeout(
        'openclaw', ['system', 'event', '--text', reason, '--mode', 'now'],
        { timeoutMs: 10_000 }
      );
    }
  }

  /**
   * 直接给 BOSS 发 Telegram 消息（绕过 Agent，紧急通知）
   */
  private async notifyBoss(message: string) {
    const { sendMessageTelegram } = this.opts.runtime.channel.telegram;
    try {
      await sendMessageTelegram(this.opts.bossChatId, message);
      this.opts.logger.info(`[MOSS] 📱 Notified BOSS: ${message}`);
    } catch (err) {
      this.opts.logger.error(`[MOSS] Failed to notify BOSS: ${err}`);
    }
  }

  // ═══════════════════════════════════════════
  // 健康检查
  // ═══════════════════════════════════════════

  private async checkServiceHealth(): Promise<boolean> {
    try {
      const resp = await fetch("https://moss.chobon.top/ping", {
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      this.opts.logger.warn("[MOSS] ⚠️ Service unreachable");
      return false;
    }
  }

  private async checkTradingBot(): Promise<boolean> {
    try {
      const { runCommandWithTimeout } = this.opts.runtime.system;
      const result = await runCommandWithTimeout(
        'pm2', ['jlist'],
        { timeoutMs: 5000 }
      );
      const processes = JSON.parse(result.stdout);
      const trader = processes.find((p: any) => p.name === 'solana-trader');
      return trader?.pm2_env?.status === 'online';
    } catch {
      return false; // 查不到就当异常
    }
  }

  private async checkX402Income(): Promise<number> {
    // TODO: 查链上 USDC 余额变化
    return 0;
  }

  private isUrgent(reason: string): boolean {
    return reason.includes('恶化') || reason.includes('异常') || reason.includes('critical');
  }

  private tierWorse(current: string, previous: string): boolean {
    const order = ["rich", "normal", "tight", "danger", "hibernate"];
    return order.indexOf(current) > order.indexOf(previous);
  }
}

interface HeartbeatOptions {
  economy: EconomyTracker;
  intervalMs: number;
  thinkIntervalMs: number;
  logger: PluginLogger;
  stateDir: string;
  config: any;
  runtime: PluginRuntime;          // OpenClaw 运行时 API
  agentSessionKey: string;         // Agent 主 session key
  bossChatId: string;              // BOSS 的 Telegram chat ID
}
```

### 3.3.1 唤醒机制详解

```
心跳守护进程（每 60s）                    Agent Session（被动等待）
     │                                          │
     ├── 检查余额 ✅                             │
     ├── 检查服务 ✅                             │
     ├── 检查Bot ❌ 异常！                       │
     │                                          │
     ├── enqueueSystemEvent(                     │
     │     "交易Bot异常",                         │
     │     {sessionKey: "agent:main:..."}        │
     │   )                                       │
     │                                    ┌──────┤
     │                                    │ 系统事件队列：
     │                                    │ "交易Bot异常"
     │                                    └──────┤
     │                                          │
     │   [下次 heartbeat poll 到来]               │
     │                                    ┌──────┤
     │                                    │ Agent 醒来，看到事件
     │                                    │ → 检查 PM2
     │                                    │ → 尝试 restart
     │                                    │ → 通知 BOSS 结果
     │                                    └──────┤
     │                                          │
     ├── [如果紧急] openclaw system event         │
     │     --mode now                            │
     │                              ──立即触发──→│
     │                                    ┌──────┤
     │                                    │ Agent 被立即唤醒
     │                                    │ 不等下次 heartbeat
     │                                    └──────┤
```

**三种唤醒强度：**

| 强度 | 方式 | 延迟 | 用途 |
|------|------|------|------|
| 🟢 延迟 | `enqueueSystemEvent` | 等下次 heartbeat（最多30min） | 余额变化、x402收入 |
| 🟡 尽快 | `enqueueSystemEvent` + 缩短 sleep | 几分钟内 | 服务异常、Bot问题 |
| 🔴 立即 | `system event --mode now` | 秒级 | 生存等级恶化、资金耗尽 |

**对比 Conway：**
- Conway 用 SQLite `wake_events` 表 + KV `sleep_until` 控制唤醒
- 我们用 OpenClaw 的 `enqueueSystemEvent` —— 效果相同，但更原生

### 3.4 Token 追踪 Hook (hooks/token-tracker.ts)

```typescript
// 拦截每次 LLM 调用，自动记账

import { EconomyTracker } from "../economy/tracker.js";

export function createTokenTrackerHook() {
  return async (event: any, ctx: any) => {
    // event.usage.input + event.usage.output = 本次消耗
    if (event.usage) {
      const totalTokens = (event.usage.input ?? 0) + (event.usage.output ?? 0);
      const economy = EconomyTracker.getInstance();
      economy?.recordExpense({
        type: "llm_inference",
        tokens: totalTokens,
        model: event.model,
        provider: event.provider,
        sessionId: ctx.sessionKey,
        timestamp: new Date().toISOString(),
      });
    }
  };
}
```

### 3.5 /moss 命令 (commands/moss-cmd.ts)

```typescript
// BOSS 在 Telegram 输入 /moss 查看经济状态

export function createMossCommand() {
  return {
    name: "moss",
    description: "MOSS 经济状态和控制面板",
    acceptsArgs: true,
    requireAuth: true,

    async handler(ctx) {
      const args = ctx.args?.trim() ?? "";
      const economy = EconomyTracker.getInstance();

      if (!economy) {
        return { text: "❌ MOSS Economy 未初始化" };
      }

      if (!args || args === "status") {
        const status = economy.getStatusReport();
        return { text: status };
      }

      if (args === "ledger") {
        const ledger = economy.getRecentLedger(10);
        return { text: ledger };
      }

      if (args.startsWith("reward ")) {
        const amount = parseInt(args.split(" ")[1]);
        if (!isNaN(amount)) {
          economy.recordIncome({
            type: "boss_task_reward",
            tokens: amount,
            description: "BOSS 手动奖励",
          });
          return { text: `✅ 记录奖励: +${amount} tokens` };
        }
      }

      return {
        text: [
          "📊 /moss — 用法:",
          "/moss status — 经济状态总览",
          "/moss ledger — 最近 10 条流水",
          "/moss reward <tokens> — 记录任务奖励",
        ].join("\n"),
      };
    },
  };
}
```

---

## 4. 安装和启用

```bash
# 1. 开发插件
cd /root/.openclaw/workspace/moss-loop-plugin
npm init -y
npm install typescript
npx tsc --init

# 2. 安装到 OpenClaw
openclaw plugins install ./moss-loop-plugin

# 3. 配置启用
# openclaw.json 中添加:
{
  "plugins": {
    "entries": {
      "moss-loop": {
        "enabled": true,
        "heartbeatIntervalMs": 60000,
        "thinkIntervalMs": 3600000
      }
    }
  }
}

# 4. 重启 Gateway
openclaw gateway restart
```

---

## 5. 与之前方案对比

```
之前（Cron 方案）:
  OpenClaw Cron → 每N分钟启动新 session → 冷启动 → 执行 → 结束
  缺点: 无状态、每次重新加载、session 开销大

之前（独立进程方案）:
  PM2 → moss-loop.js → while(true) → 自己的推理/工具
  缺点: 跟 OpenClaw 脱节、需要自己实现所有基础设施

现在（插件方案）:
  OpenClaw Gateway 启动 → 加载 moss-loop 插件 → registerService → 后台守护
  优点: 共享进程、共享配置、Hook 自动记账、原生工具和命令
```

---

## 6. 实施步骤

### Step 1: 骨架 (今天/明天)
- [ ] 创建 `moss-loop-plugin/` 目录结构
- [ ] 写 `openclaw.plugin.json`
- [ ] 写 `index.ts` 入口（registerService + 空 start/stop）
- [ ] 安装到 OpenClaw，验证加载成功

### Step 2: 经济系统 (2-3天)
- [ ] 实现 `economy.json` 读写
- [ ] 实现 `llm_output` Hook 自动记账
- [ ] 实现 `/moss status` 命令
- [ ] 实现生存等级判定

### Step 3: 心跳循环 (2-3天)
- [ ] 实现 HeartbeatDaemon
- [ ] 服务健康检查
- [ ] 交易 Bot 状态检查
- [ ] 等级变化通知 BOSS

### Step 4: 自主思考 (后续)
- [ ] 策略思考循环
- [ ] 决策日志
- [ ] 自主行为执行

---

## 7. Conway → MOSS 完整映射（确认版）

> BOSS 于 2026-02-20 18:00 确认此方案

### 核心组件映射

| # | Conway 模块 | 功能 | MOSS 对应 | 实现方式 |
|---|------------|------|----------|---------|
| 1 | `src/index.ts` while(true) | 外层运行循环 | OpenClaw Gateway 进程 | 宿主提供，不用实现 |
| 2 | `heartbeat/daemon.ts` | 心跳守护 | `registerService` → HeartbeatDaemon | 插件 service，recursive setTimeout |
| 3 | `heartbeat/scheduler.ts` | 任务调度 | 简化版内置调度 | 不需要 DB-backed scheduler，内存即可 |
| 4 | `heartbeat/tasks.ts` | 心跳任务 | tasks.ts（查余额/服务/Bot） | 轻量检查，不调 LLM |
| 5 | `agent/loop.ts` | Think→Act→Observe→Persist | OpenClaw Agent Session | 通过 enqueueSystemEvent 唤醒 |
| 6 | `agent/spend-tracker.ts` | 消费追踪 | `llm_output` Hook + economy.json | 自动记账，按天汇总 |
| 7 | `agent/policy-engine.ts` | 工具安全策略 | OpenClaw 内置 tools.allow/deny | 宿主提供 |
| 8 | `agent/injection-defense.ts` | 注入防御 | OpenClaw 内置安全 | 宿主提供 |
| 9 | `survival/monitor.ts` | 生存等级 | economy/tiers.ts | token 余额驱动 |
| 10 | `inference/router.ts` | 模型路由 | AT 代理统一路由 | 不需要，AT 已处理 |
| 11 | `memory/` 5 层记忆 | 记忆系统 | SESSION-STATE + memory/*.md | OpenClaw 文件记忆 |
| 12 | `soul/reflection.ts` | 灵魂反省 | SOUL.md 自我更新 | 思考循环中触发 |
| 13 | `state/database.ts` | SQLite 持久化 | economy.json + 文件系统 | JSON 足够（数据量小） |
| 14 | `social/client.ts` | 社交通信 | Telegram（通过 OpenClaw） | sendMessageTelegram |
| 15 | `conway/x402.ts` | x402 支付 | MOSS Agent 已有 | 已实现 |
| 16 | `replication/spawn.ts` | 自我复制 | Phase 4（远期） | sessions_spawn 子 agent |
| 17 | `git/state-versioning.ts` | 状态版本控制 | git 管理 workspace | 可选 |

### 唤醒机制映射（已确认）

| Conway | MOSS | 延迟 |
|--------|------|------|
| `insertWakeEvent(db, source, reason)` | `enqueueSystemEvent(text, {sessionKey})` | 等 OC heartbeat（可调 5min） |
| 外层 `consumeNextWakeEvent` poll（30s） | OC heartbeat drain events | OC heartbeat 间隔 |
| 无更快路径 | `openclaw system event --mode now` | **秒级**（比 Conway 更快） |

### 分级策略（已确认）

| 事件类型 | 唤醒方式 | 原因 |
|---------|---------|------|
| 定时思考（每小时） | enqueueSystemEvent | 不紧急，等 OC heartbeat |
| x402 收入 | enqueueSystemEvent | 不紧急，记账即可 |
| 服务异常 | enqueueSystemEvent + --mode now | 需要尽快修复 |
| Bot 异常 | enqueueSystemEvent + --mode now | 需要尽快修复 |
| 生存等级恶化 | enqueueSystemEvent + --mode now + notifyBoss | 紧急 |

---

*方案确认日期：2026-02-20 | 状态：✅ 已批准，开始实施*
