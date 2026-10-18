/**
 * Anthropic-compatible proxy surface test (offline: fake upstream + the real
 * server). The fake is the upstream api.anthropic.com via ANTHROPIC_BASE_URL,
 * exactly like the agent tests — the proxy is exercised end to end.
 *
 *   npx tsx test/proxy.test.ts
 */

import { assert, parseSse, sleep, startHarness } from "./helpers/harness.js";

const message = (content: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100, messages: [{ role: "user", content }], ...extra });

async function main(): Promise<void> {
  // ======================================================= OAuth mode (default)
  {
    const h = await startHarness();
    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });

    // auth: the server key arrives as x-api-key (what Anthropic SDKs send)
    assert((await post("/v1/messages", message("hi"))).status === 401, "no key -> 401");
    assert((await post("/v1/messages", message("hi"), { "x-api-key": "wrong-key-wrong-key" })).status === 401, "wrong x-api-key -> 401");
    assert((await fetch(`${h.base}/v1/messages`, { method: "GET", headers: { "x-api-key": h.key } })).status === 404, "GET /v1/messages is not a route");

    // /v1/info advertises the surface
    const info = (await h.api("GET", "/v1/info")).body;
    assert(info.proxy?.enabled === true && info.proxy.endpoints.includes("POST /v1/messages"), "info lists the proxy endpoints");

    // non-streaming request: JSON response passes through
    const r = await post("/v1/messages", message("[[say hello there]]"), { "x-api-key": h.key });
    const msg = await r.json();
    assert(r.status === 200 && msg.type === "message" && msg.content?.[0]?.text === "hello there", "non-stream JSON passes through");
    assert(msg.stop_reason === "end_turn" && msg.usage?.input_tokens === 100, "message envelope intact (stop_reason, usage)");
    const up = h.fake.requests.at(-1)!;
    assert(String(up.headers["authorization"] ?? "").startsWith("Bearer "), "upstream got the OAuth bearer");
    assert(String(up.headers["user-agent"] ?? "").includes("claude-cli/"), "upstream got the Claude Code user-agent");
    assert(JSON.stringify(up.body.system).includes("x-anthropic-billing-header"), "subscription billing block injected upstream");
    assert(!JSON.stringify(up.headers).includes(h.key), "the client's WrongForge key never leaks upstream");
    assert(up.body.max_tokens === 100, "non-streaming max_tokens untouched");

    // streaming request: SSE events pass through 1:1, CC costume applied
    const s = await post("/v1/messages", message("[[say streamed answer]]", { stream: true }), { "x-api-key": h.key });
    assert(s.status === 200 && (s.headers.get("content-type") ?? "").includes("text/event-stream"), "stream response is SSE");
    const events = parseSse(await s.text());
    const types = events.map((e) => e.event);
    assert(types[0] === "message_start" && types.at(-1) === "message_stop", "SSE sequence intact (message_start..message_stop)");
    assert(events.some((e) => e.event === "content_block_delta" && e.data?.delta?.text === "streamed answer"), "text delta passes through");
    const upStream = h.fake.requests.at(-1)!;
    assert(upStream.body.stream === true && upStream.body.max_tokens === 128_000, "streaming turn carries the CC max_tokens ceiling");
    assert(upStream.url.includes("beta=true"), "messages URL carries ?beta=true like the captured client");

    // a client-chosen effort is never overridden (server default would be high)
    await post("/v1/messages", message("hi", { output_config: { effort: "low" } }), { "x-api-key": h.key });
    assert(h.fake.requests.at(-1)!.body.output_config?.effort === "low", "client effort preserved through the costume");
    await post("/v1/messages", message("hi"), { "x-api-key": h.key });
    assert(h.fake.requests.at(-1)!.body.output_config?.effort === "high", "effort injected when the client sends none");

    // upstream errors pass through untouched (status + error envelope)
    const f = await post("/v1/messages", message("[[fail 429 slow down]]"), { "x-api-key": h.key });
    const ferr = await f.json();
    assert(f.status === 429 && ferr.error?.type === "api_error" && ferr.error?.message === "slow down", "upstream error status + envelope passed through");

    // count_tokens + models
    const ct = await post("/v1/messages/count_tokens", message("count me"), { "x-api-key": h.key });
    assert(ct.status === 200 && (await ct.json()).input_tokens === 42, "count_tokens passes through");
    assert(h.fake.requests.at(-1)!.url.startsWith("/v1/messages/count_tokens"), "count_tokens routed to its own upstream path");
    const models = await fetch(`${h.base}/v1/models`, { headers: { "x-api-key": h.key } });
    const mbody = await models.json();
    assert(models.status === 200 && mbody.data?.length === 3 && mbody.has_more === false, "models list passes through");
    const one = await fetch(`${h.base}/v1/models/claude-sonnet-5-5`, { headers: { "x-api-key": h.key } });
    assert((await one.json()).id === "claude-sonnet-5-5", "model by id passes through");
    assert((await fetch(`${h.base}/v1/models/nope-999`, { headers: { "x-api-key": h.key } })).status === 404, "unknown model 404 passes through");

    // client abort while the upstream is still delaying (headers not sent
    // yet): the upstream call is cancelled, the server must survive
    const ac = new AbortController();
    const aborted = fetch(`${h.base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": h.key, "Content-Type": "application/json" },
      body: message("[[delay 800]] [[say too late]]", { stream: true }),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 150);
    await aborted.catch(() => {}); // AbortError is the expected shape here
    await sleep(250);
    const after = await post("/v1/messages", message("[[say alive]]"), { "x-api-key": h.key });
    assert(after.status === 200 && (await after.json()).content?.[0]?.text === "alive", "server alive after a client abort");

    await h.close();
  }

  // ================================================= API-key mode: pure passthrough
  {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789";
    const h = await startHarness();
    const r = await fetch(`${h.base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": h.key, "Content-Type": "application/json" },
      body: message("[[say plain passthrough]]", { output_config: { effort: "low" } }),
    });
    assert(r.status === 200 && (await r.json()).content?.[0]?.text === "plain passthrough", "api-key mode answers");
    const up = h.fake.requests.at(-1)!;
    assert(up.headers["x-api-key"] === "sk-ant-test-0123456789", "upstream got the real API key");
    assert(!up.headers["authorization"], "no OAuth bearer in api-key mode");
    assert(up.body.system === undefined, "no CC system injection in api-key mode");
    assert(up.body.max_tokens === 100, "no max_tokens bump in api-key mode");
    assert(!up.url.includes("beta=true"), "no beta flag appended in api-key mode");
    assert(up.body.output_config?.effort === "low", "body byte-for-byte (effort field untouched)");
    delete process.env.ANTHROPIC_API_KEY;
    await h.close();
  }

  // ======================================================= WRONGFORGE_PROXY=0
  {
    process.env.WRONGFORGE_PROXY = "0";
    const h = await startHarness();
    const r = await fetch(`${h.base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": h.key, "Content-Type": "application/json" },
      body: message("hi"),
    });
    assert(r.status === 404 && (await r.json()).error?.code === "not_found", "proxy off -> the routes 404");
    const info = (await h.api("GET", "/v1/info")).body;
    assert(info.proxy?.enabled === false, "info reports the proxy disabled");
    delete process.env.WRONGFORGE_PROXY;
    await h.close();
  }

  // ============================================= proxy.call dashboard events
  {
    const h = await startHarness();

    /** Opens /v1/events and accumulates raw SSE text until `ac.abort()`. */
    const openFeed = (): { ac: AbortController; text: { out: string }; done: Promise<void> } => {
      const ac = new AbortController();
      const text = { out: "" };
      const done = (async () => {
        const res = await fetch(`${h.base}/v1/events?key=${h.key}`, { headers: { Accept: "text/event-stream" }, signal: ac.signal });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            text.out += dec.decode(value, { stream: true });
          }
        } catch {
          /* aborted — the normal end of this check */
        }
      })();
      return { ac, text, done };
    };

    /** The `proxy.call` frame whose request body carries `marker` — never the
     * stale previous one: the ring buffer's backlog replay means a fresh SSE
     * connection can already see an OLDER matching-path call before the
     * NEW one has landed, so matching on "last by path" alone is unsafe —
     * each sub-test uses a unique prompt fragment to pick out its own call.
     * request_body is the parsed object for a small body, or a raw (possibly
     * truncated) string once the request itself exceeds the tap's cap —
     * both shapes are checked so an over-cap request still matches. */
    const findProxyCall = (out: string, marker: string): any => {
      for (const block of parseSse(out)) {
        if (block.event !== "proxy.call") continue;
        const req = block.data?.request_body;
        const content = typeof req === "string" ? req : req?.messages?.[0]?.content;
        if (typeof content === "string" && content.includes(marker)) return block.data;
      }
      return null;
    };

    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`${h.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

    {
      const feed = openFeed();
      await sleep(150); // let the stream (and its tap) attach server-side
      await post("/v1/messages", message("[[say mark-nonstream-reply]]"), { "x-api-key": h.key });
      let call: any = null;
      for (let i = 0; i < 50 && !call; i++) {
        call = findProxyCall(feed.text.out, "mark-nonstream-reply");
        if (!call) await sleep(100);
      }
      feed.ac.abort();
      await feed.done;
      assert(call, "a non-stream /v1/messages call produces a proxy.call event");
      assert(call.method === "POST" && call.status === 200 && call.auth_mode === "oauth", "proxy.call carries method/status/auth_mode");
      assert(call.model === "claude-sonnet-5-5" && call.stream !== true, "proxy.call extracts model/stream from the request");
      assert(call.request_body?.messages?.[0]?.content === "[[say mark-nonstream-reply]]", "proxy.call carries the parsed request body");
      assert(typeof call.response_body === "object" && call.response_body?.content?.[0]?.text === "mark-nonstream-reply", "proxy.call carries the parsed response body");
      assert(call.request_truncated === false && call.response_truncated === false, "small bodies are not truncated");
      assert(typeof call.id === "string" && call.id.length > 0, "proxy.call carries a stable id");
    }

    // streaming: exactly one proxy.call, emitted once the upstream SSE body
    // has fully drained, carrying the captured raw SSE text
    {
      const feed = openFeed();
      await sleep(150);
      const r = await post("/v1/messages", message("[[say mark-stream-reply]]", { stream: true }), { "x-api-key": h.key });
      assert(r.status === 200, "streaming call succeeds");
      await r.text(); // drain the client-side body before asserting on the tap
      let call: any = null;
      for (let i = 0; i < 50 && !call; i++) {
        call = findProxyCall(feed.text.out, "mark-stream-reply");
        if (!call) await sleep(100);
      }
      feed.ac.abort();
      await feed.done;
      assert(call, "a streaming /v1/messages call also produces a proxy.call event");
      assert(call.stream === true, "proxy.call reflects stream:true");
      assert(typeof call.response_body === "string" && call.response_body.includes("mark-stream-reply"), "proxy.call captures the raw SSE response text");
    }

    // failures still show up (status >= 400), so "what went wrong" is visible too
    {
      const feed = openFeed();
      await sleep(150);
      await post("/v1/messages", message("[[fail 429 mark-fail-429]]"), { "x-api-key": h.key });
      let call: any = null;
      for (let i = 0; i < 50 && !call; i++) {
        call = findProxyCall(feed.text.out, "mark-fail-429");
        if (!call) await sleep(100);
      }
      feed.ac.abort();
      await feed.done;
      assert(call?.status === 429, "an upstream failure still produces a proxy.call event, with its real status");
    }

    // truncation: a response far larger than a small (256-byte) cap is marked
    // truncated in the tap event — AND the real client still gets it in full,
    // proving the capped capture never touches the actual response to the
    // caller. Scoped to just this sub-test so the other assertions above/below
    // keep using the default (8 KB) cap, large enough to hold a whole reply.
    {
      process.env.WRONGFORGE_PROXY_TAP_BODY_CAP = "256";
      const longText = "mark-trunc-" + "x".repeat(2000);
      const feed = openFeed();
      await sleep(150);
      const r = await post("/v1/messages", message(`[[say ${longText}]]`), { "x-api-key": h.key });
      const clientBody = await r.json();
      assert(clientBody.content[0].text === longText, "the real client receives the full, untruncated response");
      let call: any = null;
      for (let i = 0; i < 50 && !call; i++) {
        call = findProxyCall(feed.text.out, "mark-trunc-");
        if (!call) await sleep(100);
      }
      feed.ac.abort();
      await feed.done;
      delete process.env.WRONGFORGE_PROXY_TAP_BODY_CAP;
      assert(call, "the over-cap call still produces a matching proxy.call event");
      assert(call.request_truncated === true, "an over-cap request is marked truncated too");
      assert(call.response_truncated === true, "the dashboard tap marks an over-cap response as truncated");
      assert(typeof call.response_body === "string" && call.response_body.length <= 256, "the tap's own copy stays within its cap, independent of the real response");
    }

    // api_key mode: auth_mode flips, no behavior change otherwise
    {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-0123456789";
      const feed = openFeed();
      await sleep(150);
      await post("/v1/messages", message("[[say mark-apikey-reply]]"), { "x-api-key": h.key });
      let call: any = null;
      for (let i = 0; i < 50 && !call; i++) {
        call = findProxyCall(feed.text.out, "mark-apikey-reply");
        if (!call) await sleep(100);
      }
      feed.ac.abort();
      await feed.done;
      delete process.env.ANTHROPIC_API_KEY;
      assert(call?.auth_mode === "api_key", "proxy.call reflects api_key mode");
    }

    // backlog replay: a late-connecting dashboard still sees recent proxy.call
    // frames, same guarantee as http.request's backlog
    {
      await post("/v1/messages", message("[[say mark-backlog-reply]]"), { "x-api-key": h.key });
      await sleep(200); // let the tap land before the late connection opens
      const feed = openFeed();
      let call: any = null;
      for (let i = 0; i < 20 && !call; i++) {
        call = findProxyCall(feed.text.out, "mark-backlog-reply");
        if (!call) await sleep(100);
      }
      feed.ac.abort();
      await feed.done;
      assert(call, "a dashboard connecting after the call still sees it via backlog replay");
    }

    delete process.env.WRONGFORGE_PROXY_TAP_BODY_CAP;
    await h.close();
  }

  console.log("PROXY TESTS PASSED ✓ (auth via x-api-key, JSON/SSE/error passthrough, CC costume in OAuth mode, pure passthrough in api-key mode, count_tokens/models, client abort, disable switch, proxy.call dashboard events + truncation + backlog)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
