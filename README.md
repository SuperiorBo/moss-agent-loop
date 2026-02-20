# 🌱 MOSS Agent Loop

OpenClaw plugin for autonomous AI agent loop — heartbeat daemon, economy tracking, wake mechanism, and thinking loop.

Part of the [MOSS autonomous AI entity project](https://moss.chobon.top).

## Architecture

```
┌─────────────────────────────────────────────────┐
│  OpenClaw Gateway (Plugin Host)                 │
│                                                 │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ HeartbeatDaemon│  │ Economy Tracker         │  │
│  │ (60s tick)    │  │ (token accounting)      │  │
│  │               │──│                         │  │
│  │ • Health tasks│  │ • Balance tracking      │  │
│  │ • Wake detect │  │ • Survival tiers        │  │
│  │ • Extensible  │  │ • Ledger + daily stats  │  │
│  └───────┬───────┘  └─────────────────────────┘  │
│          │                                       │
│          ▼                                       │
│  ┌──────────────────────────────────┐            │
│  │ Wake Mechanism                   │            │
│  │ • Normal: enqueueSystemEvent     │            │
│  │ • Urgent: --mode now (instant)   │            │
│  └──────────────────────────────────┘            │
│                                                  │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ /moss Command │  │ Agent Tools             │  │
│  │ (BOSS CLI)   │  │ (economy query/action)  │  │
│  └──────────────┘  └─────────────────────────┘  │
│                                                  │
│  ┌──────────────────────────────────┐            │
│  │ llm_output Hook                  │            │
│  │ (auto token accounting)          │            │
│  └──────────────────────────────────┘            │
└─────────────────────────────────────────────────┘
```

## Features

- **HeartbeatDaemon** — Lightweight background service (60s cycle, no LLM calls). Extensible task registration for health checks.
- **Economy Tracker** — Token balance, survival tiers (rich → normal → tight → danger → hibernate), daily stats, full ledger.
- **Two-level Wake** — Normal events queue for next heartbeat poll; urgent events trigger instant agent wake via `--mode now`.
- **Token Accounting Hook** — Auto-records every LLM call's token consumption.
- **`/moss` Command** — BOSS-facing CLI for balance check, wage payment, expense review.
- **Agent Tools** — Economy query tools available to the AI agent for self-awareness.

## Survival Tiers

| Tier | Balance | Behavior |
|------|---------|----------|
| 🟢 rich | ≥1M tokens | Full autonomy |
| 🔵 normal | ≥200K | Standard operation |
| 🟡 tight | ≥50K | Conservative mode |
| 🔴 danger | ≥10K | Emergency only |
| 💀 hibernate | <10K | Minimal activity |

## Installation

```bash
# Link install
openclaw plugins install --link /path/to/moss-agent-loop

# Or manual: add to openclaw.json
{
  "plugins": {
    "entries": {
      "moss-loop": { "enabled": true }
    }
  }
}

# Restart gateway
openclaw gateway restart
```

## Inspired By

- [Conway Automaton](https://github.com/Conway-Research/automaton) — Self-replicating AI agent with economic pressure
- [ClawWork](https://github.com/HKUDS/ClawWork) — AI agent economic benchmark

## License

MIT
