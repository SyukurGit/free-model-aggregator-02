# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) [![rank](https://make.fun/badge/free-model-aggregator-02/SyukurGit/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) [![reward](https://make.fun/badge/free-model-aggregator-02/SyukurGit/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

> Quality-Ranked Free Model Aggregator with Deterministic Failover

A high-performance, single-server LLM aggregator built for the [make.fun](https://make.fun) bounty **[The best live free-model aggregator](https://make.fun/bounty/free-model-aggregator-02)** ($500 USDC pool).

## Overview

This server aggregates OpenRouter's free model tier (`openrouter/*:free`) behind dual-wire compatibility endpoints:
- **OpenAI Wire**: `POST /v1/chat/completions` (JSON and SSE streaming)
- **Anthropic Wire**: `POST /v1/messages` (JSON and SSE streaming)
- **Model Catalog**: `GET /v1/models` (Dual authorization format supporting `Bearer` token and `x-api-key`)

## Key Features

1. **Quality Optimizer (60% weight)**:
   Routes incoming prompts to the highest-rated free model matching prompt requirements (`rating_milli` descending).
2. **Deterministic Failover (10% weight)**:
   Tracks rate limits (HTTP 429) and upstream server errors (HTTP 5xx), applying cooldowns and reporting recovery trails via `x-makefun-upstream-failures`.
3. **Dual Wire Parity (10% weight)**:
   Translates Anthropic requests and streaming events to/from OpenAI Chat Completions seamlessly.
4. **Exact Catalog Parity (5% weight)**:
   Serves all 14 free model IDs byte-for-byte in CLI `--list` and HTTP catalog responses.

## Run

```bash
node main.ts --list
```

## License

[MIT](LICENSE)
