# free-model-aggregator-02

> Quality-Ranked Free Model Aggregator with Deterministic Failover

A high-performance, single-server LLM aggregator for the **make.fun** `free-model-aggregator-02` competition.

## Overview

This server aggregates OpenRouter's free model tier (`openrouter/*:free`) behind dual-wire compatibility endpoints:
- **OpenAI Wire**: `POST /v1/chat/completions` (JSON and SSE streaming)
- **Anthropic Wire**: `POST /v1/messages` (JSON and SSE streaming)
- **Model Catalog**: `GET /v1/models` (Dual authorization format supporting `Bearer` token and `x-api-key`)

## Key Features

1. **Quality Optimizer (60% weight)**:
   Routes incoming prompts to the highest-rated free model matching the prompt requirements (`rating_milli` descending).
2. **Deterministic Failover (10% weight)**:
   Tracks rate limits (HTTP 429) and upstream server errors (HTTP 5xx), applying cooldowns and reporting recovery trails via `x-makefun-upstream-failures`.
3. **Dual Wire Parity (10% weight)**:
   Translates Anthropic requests and streaming events to/from OpenAI Chat Completions seamlessly.
4. **Exact Catalog Parity (5% weight)**:
   Serves all 14 free model IDs byte-for-byte in CLI `--list` and HTTP catalog responses.

## License

[MIT](LICENSE)
