const SESSION_VALUE = "v1";
const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const MAX_BODY_BYTES = 200_000;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 48_000;
const MAX_COMPLETION_TOKENS = 4096;

const SYSTEM_PROMPT =
  "你是一个直接、有用的助手。用用户正在使用的语言回答。在回答问题时，要使用简洁明了的语言，不要使用过于复杂的句子。除非用户问起，不要提及自己的模型名称或服务商。";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!sameOrigin(request, url)) {
    return json({ error: "请求来源不被允许" }, 403);
  }

  console.log(JSON.stringify({ message: "request", method: request.method, path: url.pathname }));

  try {
    if (url.pathname === "/api/session" && request.method === "GET") {
      const ok = await hasSession(request, env.APP_PASSWORD);
      return json({ ok }, ok ? 200 : 401);
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      return login(request, env.APP_PASSWORD, url);
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return new Response(null, {
        status: 204,
        headers: { "Set-Cookie": clearCookie(url) },
      });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!(await hasSession(request, env.APP_PASSWORD))) {
        return json({ error: "请先登录" }, 401);
      }
      return chat(request, env);
    }

    return json({ error: "未找到" }, 404);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "request failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return json({ error: "服务暂时不可用" }, 500);
  }
}

async function login(request: Request, password: string, url: URL): Promise<Response> {
  const body = await readJson(request);
  const provided = typeof body?.password === "string" ? body.password : "";
  const matches = await secretsMatch(provided, password);

  if (!matches) {
    await delay(400);
    return json({ error: "口令不正确" }, 401);
  }

  const token = await sign(password, SESSION_VALUE);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, url) });
}

async function chat(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const messages = sanitizeMessages(body?.messages);

  if (!messages || messages.length === 0 || messages.at(-1)?.role !== "user") {
    return json({ error: "请输入消息" }, 400);
  }

  const upstream = await callGroq(env, messages, request.signal);

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text()).replace(/\s+/g, " ").slice(0, 240);
    const colo = (request.cf as { colo?: string } | undefined)?.colo;
    console.error(JSON.stringify({ message: "groq request failed", status: upstream.status, colo, detail }));
    return json({ error: groqError(upstream.status, detail) }, upstream.status === 429 ? 429 : 502);
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

async function callGroq(env: Env, messages: ChatMessage[], signal: AbortSignal): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        "User-Agent": "simple-llm-api/1.0",
      },
      body: JSON.stringify({
        model: env.MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        stream: true,
        reasoning_effort: "none",
        max_tokens: MAX_COMPLETION_TOKENS,
      }),
      signal,
    });
    if (upstream.ok && upstream.body) return upstream;
    last = upstream;
    if (upstream.status !== 403 && upstream.status < 500) break;
    await upstream.body?.cancel();
  }
  return last ?? new Response(null, { status: 502 });
}

function groqError(status: number, detail: string): string {
  if (status === 429) return "模型额度或请求频率已到上限，请稍后再试";
  if (/invalid api key|invalid_api_key/i.test(detail)) return "模型服务拒绝了请求，请检查 Groq 密钥";
  if (/1010|1003|cloudflare/i.test(detail) || status === 403) return "手机网络到模型服务被拒绝了，请再试一次";
  return "模型暂时不可用";
}

function sanitizeMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value)) return null;

  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;
    const text = content.trim();
    if (!text) continue;
    if (text.length > MAX_MESSAGE_CHARS) return null;
    messages.push({ role, content: text });
  }

  const recent = messages.slice(-MAX_MESSAGES);
  while (recent.length > 1 && recent.reduce((total, message) => total + message.content.length, 0) > MAX_TOTAL_CHARS) {
    recent.shift();
  }

  return recent;
}

async function readJson(request: Request): Promise<{ password?: unknown; messages?: unknown } | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error("body too large");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error("body too large");
  }
  if (!text) return null;

  try {
    return JSON.parse(text) as { password?: unknown; messages?: unknown };
  } catch {
    return null;
  }
}

function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

async function hasSession(request: Request, password: string): Promise<boolean> {
  const provided = readCookie(request, SESSION_COOKIE);
  if (!provided) return false;
  const expected = await sign(password, SESSION_VALUE);
  return secretsMatch(provided, expected);
}

function readCookie(request: Request, name: string): string {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }
  return "";
}

async function sign(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function sessionCookie(token: string, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`;
}

function clearCookie(url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

function json(body: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
