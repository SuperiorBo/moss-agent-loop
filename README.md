# 🌱 MOSS Agent Loop

OpenClaw plugin for autonomous AI agent loop — heartbeat daemon, economy tracking, wake mechanism, and thinking loop.

Part of the [MOSS autonomous AI entity project](https://moss.chobon.top).

## What is this?

MOSS Agent Loop turns a passive AI assistant into a self-aware economic entity. It runs as a background daemon inside OpenClaw Gateway, tracking token consumption, managing survival resources, and waking the agent when it needs to think or act — all without LLM calls.

The core insight: an AI agent that understands its own resource constraints can make better decisions about when and how to spend compute.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway (Plugin Host)                              │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  HeartbeatDaemon (60s tick, recursive setTimeout)       │ │
│  │                                                         │ │
│  │  ┌─────────────────┐  ┌──────────────────────────────┐  │ │
│  │  │ economy-check   │  │ periodic-thinking (optional) │  │ │
│  │  │ (built-in)      │  │ (built-in, configurable)     │  │ │
│  │  └────────┬────────┘  └──────────────┬───────────────┘  │ │
│  │           │                          │                  │ │
│  │  ┌────────┴──────────────────────────┴───────────────┐  │ │
│  │  │  registerTask() — plug in your own checks         │  │ │
│  │  │  e.g. service-health, trading-bot, x402-income    │  │ │
│  │  └──────────────────────┬────────────────────────────┘  │ │
│  └─────────────────────────┼───────────────────────────────┘ │
│                            │                                 │
│             shouldWake?────┤                                 │
│                            ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Wake Mechanism (two-level)                             │ │
│  │  ├─ Normal: enqueueSystemEvent → OC heartbeat drain    │ │
│  │  └─ Urgent: + openclaw system event --mode now         │ │
│  │                                                         │ │
│  │  Context Packing: trigger reason + economy snapshot     │ │
│  │  + last 5 recent events → Agent wakes with full context │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────────┐  ┌────────────────────────────────┐    │
│  │ Economy Tracker   │  │ llm_output Hook               │    │
│  │ • Balance         │  │ (auto token accounting)       │    │
│  │ • Survival tiers  │──│                               │    │
│  │ • Ledger          │  │ Every LLM call → debit tokens │    │
│  │ • Daily stats     │  └────────────────────────────────┘    │
│  └──────────────────┘                                        │
│                                                              │
│  ┌──────────────────┐  ┌────────────────────────────────┐    │
│  │ /moss Command     │  │ Agent Tools                   │    │
│  │ (BOSS CLI)        │  │ (economy query for AI self-   │    │
│  │ • balance         │  │  awareness during sessions)   │    │
│  │ • wage            │  └────────────────────────────────┘    │
│  │ • expenses        │                                       │
│  └──────────────────┘                                        │
└──────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Heartbeat Daemon

A lightweight background service running on a 60s tick cycle (recursive `setTimeout`, no `setInterval` — prevents tick overlap). Zero LLM calls. It runs registered tasks and decides when the agent needs to wake up.

### Pluggable Task System

The daemon doesn't hardcode any business logic. Instead, it provides a `registerTask()` API. Each task implements:

```typescript
interface HeartbeatTask {
  name: string;           // Unique identifier
  intervalTicks: number;  // Run every N ticks (1 = every 60s, 5 = every 5min)
  run(): Promise<{
    shouldWake: boolean;   // Should we wake the agent?
    urgent?: boolean;      // Instant wake (--mode now) or queue?
    message?: string;      // Context for the agent
  }>;
}
```

**Built-in tasks:**
- `economy-check` — Detects survival tier degradation, fires urgent wake on tier drop
- `periodic-thinking` — Optional (controlled by `thinkIntervalMs`), triggers periodic self-reflection in non-danger tiers

### Economy Tracker

Token-based resource accounting:

| Tier | Balance | Behavior |
|------|---------|----------|
| 🟢 rich | ≥1M tokens | Full autonomy |
| 🔵 normal | ≥200K | Standard operation |
| 🟡 tight | ≥50K | Conservative mode |
| 🔴 danger | ≥10K | Emergency only |
| 💀 hibernate | <10K | Minimal activity |

Features:
- Token balance (credits/debits)
- USDC balance tracking (for on-chain earnings)
- Full transaction ledger
- Daily stats (tokens earned/spent, LLM call count)
- Automatic tier calculation
- Persistent storage (`data/economy.json`)

### Two-Level Wake

When a task returns `shouldWake: true`:

1. **Normal wake** — Calls `enqueueSystemEvent()` → event queued → picked up on next OpenClaw heartbeat drain → Agent processes with full tool access
2. **Urgent wake** — Also runs `openclaw system event --mode now` → Agent wakes immediately (sub-second)

### Context Packing (Thinking Loop)

When waking the agent, the daemon packs:
- **Trigger reason** — Which task triggered and why
- **Economy snapshot** — Current tier, token balance, USDC, daily stats
- **Recent events** — Last 5 wake events with timestamps and urgency level

This gives the agent full context to make informed decisions without needing to query state.

### Token Accounting Hook

Hooks into every `llm_output` event to automatically debit tokens from the economy. The agent's LLM consumption is tracked transparently — it can query its own spend in real time.

## Directory Structure

```
moss-agent-loop/
├── README.md
├── openclaw.plugin.json        # Plugin manifest (id: moss-loop)
├── package.json                # Node package (with openclaw.extensions)
├── tsconfig.json
├── docs/
│   ├── AGENT-LOOP-DESIGN.md    # Complete architecture design
│   └── MOSS-AUTONOMY-PLAN.md   # 4-phase autonomy roadmap
├── src/
│   ├── index.ts                # Plugin entry — registers everything
│   ├── service.ts              # Service lifecycle (start/stop daemon)
│   ├── heartbeat/
│   │   ├── daemon.ts           # HeartbeatDaemon class
│   │   └── tasks.ts            # HeartbeatTask interface + built-in tasks
│   ├── economy/
│   │   └── tracker.ts          # EconomyTracker (balance, tiers, ledger)
│   ├── hooks/
│   │   └── token-tracker.ts    # llm_output hook for auto accounting
│   ├── commands/
│   │   └── moss-cmd.ts         # /moss CLI command
│   └── tools/
│       └── economy-tools.ts    # Agent-facing economy query tools
└── data/
    └── economy.json            # Persistent economy state (auto-created)
```

## Installation

### Quick Install

```bash
# Link install (development)
openclaw plugins install --link /path/to/moss-agent-loop

# Restart gateway to load
openclaw gateway restart
```

### Manual Install

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/moss-agent-loop"]
    },
    "entries": {
      "moss-loop": {
        "enabled": true,
        "config": {}
      }
    }
  }
}
```

Then restart: `openclaw gateway restart`

### Verify

```bash
openclaw status
# Should show: [MOSS] Agent Loop plugin registered ✅
```

## Configuration

All config goes in `openclaw.json` under `plugins.entries.moss-loop.config`:

```json
{
  "enabled": true,
  "heartbeatIntervalMs": 60000,
  "thinkIntervalMs": 3600000,
  "bossChatId": "7517182289",
  "serviceUrl": "https://moss.chobon.top",
  "tradingBotName": "solana-trader"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable/disable the plugin |
| `heartbeatIntervalMs` | `60000` | Tick interval in ms (60s) |
| `thinkIntervalMs` | `3600000` | Periodic thinking interval (1h). Set to 0 to disable. |
| `bossChatId` | — | Telegram chat ID for urgent notifications |
| `serviceUrl` | — | MOSS agent service URL (for health checks) |
| `tradingBotName` | — | PM2 process name for trading bot |

## Extending: Register Custom Tasks

### From Another Plugin

```typescript
export default function myPlugin(api: any) {
  const registerTask = api.get('moss.heartbeat.registerTask');

  if (registerTask) {
    registerTask({
      name: 'service-health',
      intervalTicks: 5,  // every 5 minutes
      async run() {
        const ok = await fetch('https://moss.chobon.top/ping')
          .then(r => r.ok)
          .catch(() => false);
        return {
          shouldWake: !ok,
          urgent: true,
          message: 'MOSS service unreachable!'
        };
      }
    });
  }
}
```

### Available API

```typescript
// Register a task (safe to call before daemon starts — auto-queued)
api.get('moss.heartbeat.registerTask')(task: HeartbeatTask): void

// Unregister by name
api.get('moss.heartbeat.unregisterTask')(name: string): boolean

// List all tasks
api.get('moss.heartbeat.listTasks')(): Array<{name, intervalTicks}>

// Get daemon instance (advanced)
api.get('moss.heartbeat.getDaemon')(): HeartbeatDaemon | null
```

### From Agent Code / Direct Import

```typescript
import { getHeartbeatDaemon } from 'moss-loop';
import type { HeartbeatTask } from 'moss-loop';

const daemon = getHeartbeatDaemon();
daemon?.registerTask({ ... });
```

## /moss Command

Available to BOSS via Telegram or CLI:

```
/moss balance    — Check current balance and survival tier
/moss wage       — Pay MOSS tokens (BOSS → MOSS)
/moss expenses   — View spending breakdown
```

## Agent Tools

The agent can query its own economy during sessions:

- **economy_status** — Current balance, tier, daily stats
- **economy_ledger** — Transaction history

## Thinking Loop (Route C)

The complete autonomous thinking cycle:

```
HeartbeatDaemon tick
  → Task detects issue (shouldWake: true)
  → packContext() enriches with economy + recent events
  → wakeAgent() → enqueueSystemEvent (+ --mode now if urgent)
  → Agent session wakes with full context
  → LLM reasons with complete tool chain
  → Takes action (notify, fix, trade, etc.)
  → Persists results to memory
  → Returns to sleep
  → Next tick...
```

## Development

```bash
# Type check
npx tsc --noEmit

# Watch mode (if you add a build step)
npx tsc --watch

# Test after changes
openclaw gateway restart
openclaw logs --limit 20  # Look for [MOSS] entries
```

## Roadmap

See [docs/MOSS-AUTONOMY-PLAN.md](docs/MOSS-AUTONOMY-PLAN.md) for the full 4-phase plan:

1. ✅ **Survival** — Economy tracking, heartbeat, resource awareness
2. ✅ **Perception** — Pluggable task system, external monitoring
3. ✅ **Thinking** — Context packing, periodic reflection, wake mechanism
4. 🔜 **Action** — On-chain transactions, self-directed earning, resource acquisition

## Inspired By

- [Conway Automaton](https://github.com/Conway-Research/automaton) — Self-replicating AI agent with economic pressure
- [ClawWork](https://github.com/HKUDS/ClawWork) — AI agent economic benchmark

## License

MIT
