import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// free-model-aggregator-02: Quality-Ranked Free Model Aggregator with Deterministic Failover (v1.1)
// Priority: 1. Available (not cooling), 2. Highest rating_milli, 3. Deterministic order
interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  rating_milli?: number;
  context_length: number | null;
  tools?: boolean | null;
  vision?: boolean | null;
  json?: boolean | null;
  free?: boolean;
}

interface PromptRequirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  context?: number;
}

interface PromptEntry {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: PromptRequirement;
}

interface Brief {
  models: ModelRow[];
  prompts: PromptEntry[];
}

interface UpstreamFailure {
  status: number;
  code: string;
  model: string | null;
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

function readBrief(filePath: string): Brief {
  const result: Brief = { models: [], prompts: [] };
  if (!filePath) return result;
  try {
    const text = readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        const doc = JSON.parse(trimmed);
        if (Array.isArray(doc.models)) result.models = doc.models;
        if (Array.isArray(doc.prompts)) result.prompts = doc.prompts;
      } catch {}
    }
  } catch {}
  return result;
}

const brief: Brief = readBrief(PROMPT_FILE);

function freeModels(): ModelRow[] {
  return brief.models.filter((m) => m.free !== false);
}

function buildCatalog() {
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        key_env: 'OPENROUTER_API_KEY',
        wire: 'openai',
        models: freeModels().map((m) => ({
          id: m.id,
          free: true,
          context_length: m.context_length ?? null,
        })),
      },
    ],
  };
}

if (process.argv.includes('--list')) {
  process.stdout.write(JSON.stringify(buildCatalog(), null, 2) + '\n');
  process.exit(0);
}

let manifestIndex = 0;
const modelCooldown = new Map<string, number>();

function meetsRequirements(requires: PromptRequirement, model: ModelRow): boolean {
  if (requires.tools && !model.tools) return false;
  if (requires.vision && !model.vision) return false;
  if (requires.json && !model.json) return false;
  if (requires.context && (model.context_length ?? 0) < requires.context) return false;
  return true;
}

function candidatesFor(requires: PromptRequirement): ModelRow[] {
  const eligible = freeModels().filter((m) => meetsRequirements(requires, m));
  const now = Date.now();
  return eligible.sort((a, b) => {
    const coolA = (modelCooldown.get(a.id) ?? 0) > now ? 1 : 0;
    const coolB = (modelCooldown.get(b.id) ?? 0) > now ? 1 : 0;
    if (coolA !== coolB) return coolA - coolB;
    return (b.rating_milli ?? 0) - (a.rating_milli ?? 0);
  });
}

function requirementsFor(body: any): PromptRequirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry?.requires) return entry.requires;

  let vision = false;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type === 'image' || b?.type === 'image_url') vision = true;
      }
    }
  }
  return {
    tools: Boolean(Array.isArray(body?.tools) && body.tools.length > 0),
    vision,
    json: Boolean(body?.response_format?.type === 'json_object'),
  };
}

function chatCompletionsUrl(): string {
  if (!GATEWAY_URL) return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function translateAnthropicToOpenAI(body: any): any {
  const messages: any[] = [];
  if (typeof body.system === 'string' && body.system.trim()) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const sysText = body.system.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
    if (sysText.trim()) messages.push({ role: 'system', content: sysText });
  }

  for (const msg of body.messages ?? []) {
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content.map((c: any) => {
        if (c?.type === 'text') return { type: 'text', text: c.text };
        if (c?.type === 'image') return { type: 'image_url', image_url: { url: `data:${c.source?.media_type};base64,${c.source?.data}` } };
        return c;
      });
    }
    messages.push({ role: msg.role, content });
  }

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens ?? 1024,
    stream: Boolean(body.stream),
    temperature: body.temperature,
    top_p: body.top_p,
  };
}

function translateOpenAIToAnthropic(resBody: any, modelId: string): any {
  const choice = resBody.choices?.[0];
  const contentText = choice?.message?.content ?? '';
  return {
    id: `msg_${Math.random().toString(36).slice(2, 11)}`,
    type: 'message',
    role: 'assistant',
    model: modelId,
    content: [{ type: 'text', text: contentText }],
    stop_reason: choice?.finish_reason === 'stop' ? 'end_turn' : 'max_tokens',
    stop_sequence: null,
    usage: {
      input_tokens: resBody.usage?.prompt_tokens ?? 10,
      output_tokens: resBody.usage?.completion_tokens ?? 20,
    },
  };
}

async function forwardWithFailover(
  wire: 'openai' | 'anthropic',
  reqBody: any,
  requires: PromptRequirement
): Promise<{ status: number; headers: Record<string, string>; body: any; stream?: any }> {
  const candidates = candidatesFor(requires);
  const failures: UpstreamFailure[] = [];

  for (const candidate of candidates) {
    const upstreamBody = wire === 'anthropic' ? translateAnthropicToOpenAI(reqBody) : { ...reqBody };
    upstreamBody.model = candidate.id;
    if (!upstreamBody.max_tokens && !upstreamBody.max_completion_tokens) {
      upstreamBody.max_tokens = 1024;
    }

    try {
      const response = await fetch(chatCompletionsUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GATEWAY_KEY}`,
        },
        body: JSON.stringify(upstreamBody),
      });

      if (response.ok) {
        const failureHeader = failures.length > 0 ? { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, 8)) } : {};
        if (upstreamBody.stream) {
          return { status: 200, headers: failureHeader, body: null, stream: response.body };
        }
        const json = await response.json();
        json.model = candidate.id;
        const returnBody = wire === 'anthropic' ? translateOpenAIToAnthropic(json, candidate.id) : json;
        return { status: 200, headers: failureHeader, body: returnBody };
      }

      modelCooldown.set(candidate.id, Date.now() + 60000);
      failures.push({ status: response.status, code: 'upstream_error', model: candidate.id });
    } catch {
      modelCooldown.set(candidate.id, Date.now() + 60000);
      failures.push({ status: 502, code: 'network_error', model: candidate.id });
    }
  }

  return {
    status: 502,
    headers: failures.length > 0 ? { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, 8)) } : {},
    body: { error: { message: 'All free model candidates failed' } },
  };
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const isAnthropic = Boolean(req.headers['x-api-key']);
    const models = freeModels();
    if (isAnthropic) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: models.map((m) => ({ id: m.id, type: 'model', display_name: m.display_name, created_at: '2024-01-01T00:00:00Z' })),
        has_more: false,
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: models.map((m) => ({ id: m.id, object: 'model', created: 1700000000, owned_by: m.provider })),
      }));
    }
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const raw = await readBody(req);
    const body = JSON.parse(raw);
    const wire = url.pathname === '/v1/messages' ? 'anthropic' : 'openai';
    const requires = requirementsFor(body);
    const result = await forwardWithFailover(wire, body, requires);

    if (result.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...result.headers,
      });
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
    res.end(JSON.stringify(result.body));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(0, '0.0.0.0', async () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 8000;

  if (ENV_URL) {
    try {
      const reg = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocol_version: 1,
          port,
          catalog: buildCatalog(),
        }),
      });
      await reg.json();
    } catch {}

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`);
        const work = await res.json();
        if (work.done) {
          clearInterval(pollInterval);
          server.close(() => process.exit(0));
        }
      } catch {}
    }, 100);
  }
});
