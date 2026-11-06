/**
 * Flowith-style thinking canvas — Host half.
 *
 * The board itself is browser state; this half owns exactly one thing: a
 * streaming bridge to the Harness model. The Client posts one prompt and reads
 * newline-delimited JSON events back (`meta` → `text` / `reason` → `finish` →
 * `done`), so a node can render tokens while the model is still writing.
 *
 * No extra dependency, no generated Remote codec: the route is served by the
 * shared browser HTTP carrier (`ctx.webServer`), which is already bound to the
 * page that renders the board.
 */
const ROUTE_PATH = '/flowith-api';
const MAX_BODY_BYTES = 512 * 1024;

/** Services the route needs; the model itself is optional and resolved per call. */
export const inject = ['webServer'];

export function apply(ctx, config) {
  const options = config && typeof config === 'object' ? config : {};

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: (req, res) => {
          handle(ctx, options, req, res).catch((error) => {
            if (!res.headersSent) {
              sendJson(res, 500, { error: describe(error) });
            } else if (!res.writableEnded) {
              res.end();
            }
          });
        },
      }),
    'flowith-canvas-api',
  );
}

async function handle(ctx, options, req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const action = url.pathname.slice(ROUTE_PATH.length).replace(/^\/+/, '');

  if (req.method === 'GET' && action === 'health') {
    const resolved = resolveModel(ctx, options, {});
    sendJson(res, 200, {
      ok: true,
      route: ROUTE_PATH,
      revision: 2,
      llm: Boolean(ctx.get('llm')),
      provider: resolved.provider ?? null,
      model: resolved.model ?? null,
    });
    return;
  }

  if (action !== 'ask') {
    sendJson(res, 404, { error: 'unknown flowith endpoint: ' + (action || '/') });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'POST required' });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: describe(error) });
    return;
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) {
    sendJson(res, 400, { error: 'prompt is empty' });
    return;
  }

  const llm = ctx.get('llm');
  if (!llm || typeof llm.stream !== 'function') {
    sendJson(res, 503, { error: 'The Harness model service (llm) is not mounted in this profile.' });
    return;
  }

  const resolved = resolveModel(ctx, options, body);
  if (!resolved.provider || !resolved.model) {
    sendJson(res, 503, {
      error: 'No model route is configured for this Harness profile. Pick a model in Settings → Models first.',
    });
    return;
  }

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // A Client that aborts mid-stream (the Stop button, a closed tab) must never
  // surface as an unhandled stream error on the Host.
  res.on('error', () => {});

  const emit = (event) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(JSON.stringify(event) + '\n');
    } catch {
      /* peer already gone */
    }
  };

  emit({ t: 'meta', provider: resolved.provider, model: resolved.model });

  const request = {
    provider: resolved.provider,
    model: resolved.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    signal: controller.signal,
  };
  if (typeof body.system === 'string' && body.system.trim()) request.system = body.system;
  if (resolved.reasoningEffort) request.reasoningEffort = resolved.reasoningEffort;
  if (Number.isFinite(body.maxTokens) && body.maxTokens > 0) request.maxTokens = Math.floor(body.maxTokens);

  try {
    for await (const chunk of llm.stream(request)) {
      if (controller.signal.aborted) break;
      switch (chunk && chunk.type) {
        case 'text-delta':
          if (chunk.text) emit({ t: 'text', d: chunk.text });
          break;
        case 'reasoning-delta':
          if (chunk.text) emit({ t: 'reason', d: chunk.text });
          break;
        case 'finish': {
          const reason = chunk.reason || {};
          emit({
            t: 'finish',
            reason: reason.kind,
            failure: reason.failure
              ? { message: describe(reason.failure), code: reason.failure.code }
              : undefined,
          });
          break;
        }
        default:
          break;
      }
    }
    emit({ t: 'done' });
  } catch (error) {
    if (controller.signal.aborted) emit({ t: 'done', aborted: true });
    else emit({ t: 'error', m: describe(error) });
  } finally {
    res.removeListener('close', onClose);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

/**
 * Explicit row config wins, then the Client's per-request override, then the
 * profile's default-model selection (which also carries the reasoning effort).
 */
function resolveModel(ctx, options, body) {
  if (body && body.provider && body.model) {
    return { provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort };
  }

  let selection;
  try {
    const owner = ctx.get('agentDefaultModel');
    selection = owner && typeof owner.currentSelection === 'function' ? owner.currentSelection() : undefined;
  } catch {
    selection = undefined;
  }
  const fromSelection = selection || {};

  return {
    provider: options.provider || fromSelection.provider || fromSelection.providerId,
    model: options.model || fromSelection.model || fromSelection.modelId,
    reasoningEffort: body && body.reasoningEffort ? body.reasoningEffort : fromSelection.reasoningEffort,
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  if (res.writableEnded || res.destroyed) return;
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  } catch {
    /* the peer closed before the response was written */
  }
}

function describe(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
