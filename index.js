/**
 * DeBox channel for DeepSeek Harness.
 *
 * Runs inside the Host process: it long-polls DeBox with the bot API key and
 * drives Harness Sessions through the in-process Typert gateway, so no child
 * process is started.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'dsh-im-debox';
export const inject = ['typertGateway', 'connection', 'agents', 'credentials'];

const API_BASE = 'https://open.debox.pro';
const TASK_TIMEOUT_MS = 10 * 60 * 1000;
const REPLY_LIMIT = 4000;
const REPLY_CHUNKS = 6;

const HELP = [
  'DeBox × DeepSeek Harness',
  '直接发消息即可作为任务执行。',
  '/id 查看当前 user_id / chat_id',
  '/new 开启新会话',
  '/stop 停止当前任务',
  '/help 显示本帮助',
].join('\n');

function stateFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im-debox', 'state.json');
}

function logFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'integrations', 'dsh-im-debox', 'plugin.log');
}

async function loadState() {
  try {
    const raw = await readFile(stateFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      offset: Number.isInteger(parsed.offset) ? parsed.offset : 0,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      titles: parsed.titles && typeof parsed.titles === 'object' ? parsed.titles : {},
    };
  } catch {
    return { offset: 0, sessions: {}, groups: {}, titles: {} };
  }
}

async function saveState(state) {
  const file = stateFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Last text the turn itself carries. Some turns finish without a separate
 * assistant/message event (an archived or resumed session, for example), so the
 * turn snapshot is the fallback source for the reply.
 * @param turn - the `turn` payload of a turn/end event.
 * @returns the last assistant text found in the turn's items.
 */
function textOfTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  let text = '';
  for (const item of items) {
    const message = item?.message ?? (item?.type === 'message' ? item : undefined);
    const part = textOfContent(message?.content);
    if (part) text = part;
  }
  return text;
}

function splitReply(text) {
  const clean = String(text ?? '').trim() || '(空结果)';
  const chunks = [];
  let rest = clean;
  while (rest && chunks.length < REPLY_CHUNKS) {
    chunks.push(rest.slice(0, REPLY_LIMIT));
    rest = rest.slice(REPLY_LIMIT);
  }
  if (rest) chunks.push('…（回复过长，已截断）');
  return chunks;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DeBoxClient {
  #apiKey;
  #log;

  constructor(apiKey, log) {
    this.#apiKey = apiKey;
    this.#log = log;
  }

  async call(method, body, timeoutMs = 40_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API_BASE}${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.#apiKey },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      const raw = await response.text();
      try {
        return { status: response.status, json: JSON.parse(raw) };
      } catch {
        return { status: response.status, json: { ok: false, raw } };
      }
    } catch (error) {
      return { status: 0, json: { ok: false, error: String(error) } };
    } finally {
      clearTimeout(timer);
    }
  }

  async me() {
    const { json } = await this.call('/openapi/bot/getMe', {}, 20_000);
    if (!json?.ok) throw new Error(`getMe failed: ${JSON.stringify(json).slice(0, 200)}`);
    return json.result ?? json.data ?? json;
  }

  async groupInfo(gid) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${API_BASE}/openapi/group/info?gid=${encodeURIComponent(gid)}`, {
        headers: { 'X-API-KEY': this.#apiKey },
        signal: controller.signal,
      });
      const raw = await response.text();
      try {
        return { status: response.status, json: JSON.parse(raw) };
      } catch {
        return { status: response.status, json: { ok: false, raw } };
      }
    } catch (error) {
      return { status: 0, json: { ok: false, error: String(error) } };
    } finally {
      clearTimeout(timer);
    }
  }

  async update(offset, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`${API_BASE}/openapi/bot/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.#apiKey },
        body: JSON.stringify({ offset, limit: 10, timeout: 30 }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        json = { ok: false, raw };
      }
      return { status: response.status, json };
    } catch (error) {
      return { status: 0, json: { ok: false, error: String(error) } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async send(chatId, chatType, text) {
    const { status, json } = await this.call('/openapi/bot/sendMessage', {
      chat_id: chatId,
      chat_type: chatType,
      content: text,
      parse_mode: 'text',
    });
    if (!(json?.ok && json?.success)) {
      this.#log(`sendMessage failed ${status} ${JSON.stringify(json).slice(0, 200)}`);
      return false;
    }
    return true;
  }
}

class Channel {
  #ctx;
  #config;
  #client;
  #log;
  #state;
  #pending = new Map();
  #stopped = false;
  #abort = new AbortController();
  #queue = Promise.resolve();
  #botUserId = null;
  #peer;
  #status = null;
  #pinned = new Set();
  #workspaceId;

  constructor(ctx, config, log, client, peer, status = null) {
    this.#ctx = ctx;
    this.#peer = peer;
    this.#status = status;
    this.#config = config;
    this.#log = log;
    this.#client = client;
    this.#state = { offset: 0, sessions: {}, groups: {}, titles: {} };
  }

  async init() {
    this.#state = await loadState();
    const me = await this.#client.me();
    this.#botUserId = me?.user_id ?? null;
    this.#log(`connected as ${me?.name ?? '?'} (${this.#botUserId ?? '?'})`);
    if (this.#status) {
      this.#status.connected = true;
      this.#status.botName = me?.name ?? null;
      this.#status.botUserId = this.#botUserId;
      this.#status.lastError = null;
    }
    this.#ctx.on('session/event', (session, event) => {
      try {
        this.#onSessionEvent(session, event);
      } catch (error) {
        this.#log(`session event failed ${error?.message ?? error}`);
      }
    }, { global: true });
    void this.#loop();
  }

  stop() {
    this.#stopped = true;
    this.#abort.abort();
    if (this.#status) this.#status.connected = false;
  }

  #onSessionEvent(session, event) {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string') return;
    const pending = this.#pending.get(sessionId);
    if (!pending || !event || typeof event !== 'object') return;
    if (event.type === 'turn/start') {
      // Appending here would re-enter the event being published; the session is
      // already pinned right after create(), so only record the turn.
      pending.turn = event.data?.turn ?? null;
      pending.text = '';
      return;
    }
    if (event.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content);
      if (text) pending.text = text;
      return;
    }
    if (event.type === 'turn/end') {
      const turn = event.data?.turn;
      if (pending.turn !== null && turn !== pending.turn) return;
      const text = pending.text || textOfTurn(turn);
      if (!text) {
        let shape = '';
        try {
          shape = JSON.stringify(event.data ?? {}).slice(0, 400);
        } catch {
          shape = '(unserializable)';
        }
        this.#log(`turn ended without text ${shape}`);
      }
      pending.settle('ok', text);
    }
  }

  async #loop() {
    while (!this.#stopped) {
      let batch;
      try {
        batch = await this.#client.update(this.#state.offset, this.#abort.signal);
      } catch (error) {
        if (this.#stopped) return;
        if (this.#status) this.#status.lastError = String(error?.message ?? error);
        this.#log(`poll failed ${error?.message ?? error}`);
        await sleep(3000);
        continue;
      }
      const { status, json } = batch;
      if (this.#stopped) return;
      if (status === 0) {
        if (this.#abort.signal.aborted) return;
        await sleep(2000);
        continue;
      }
      if (!json?.ok) {
        this.#log(`getUpdates error ${status} ${JSON.stringify(json).slice(0, 200)}`);
        await sleep(3000);
        continue;
      }
      const updates = Array.isArray(json.result) ? json.result : [];
      for (const update of updates) {
        const id = update?.id;
        if (typeof id === 'number' && id >= this.#state.offset) this.#state.offset = id + 1;
        const message = update?.message;
        if (message) void this.#enqueue(() => this.#handle(message));
      }
      if (updates.length > 0) {
        if (this.#status) this.#status.lastUpdateAt = new Date().toISOString();
        await saveState(this.#state).catch(() => {});
      }
    }
  }

  /** DSH Session ids this channel maps to, for the sidebar row mark. */
  sessionIds() {
    const seen = new Set();
    for (const value of Object.values(this.#state.sessions ?? {})) {
      if (typeof value === 'string' && value) seen.add(value);
    }
    return [...seen];
  }

  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch((error) => this.#log(`task failed ${error?.message ?? error}`));
    return this.#queue;
  }

  // Resolve a chat to a human title: private chats are always "DeBox"; groups are
  // named by DeBox itself (getUpdates only carries the gid), cached in state.json.
  async #chatTitle(message, chatId, chatType) {
    if (chatType === 'private') return 'DeBox';
    const cached = this.#state.groups?.[chatId];
    if (typeof cached === 'string' && cached) return cached;
    const { status, json } = await this.#client.groupInfo(chatId).catch(() => ({ status: 0, json: null }));
    const name = json?.data?.group_name ?? json?.result?.group_name;
    if (typeof name === 'string' && name.trim()) {
      this.#state.groups = { ...(this.#state.groups ?? {}), [chatId]: name.trim() };
      await saveState(this.#state).catch(() => {});
      this.#log(`group ${chatId} → ${name.trim()}`);
      return name.trim();
    }
    if (status === 429) this.#log(`group info rate-limited for ${chatId}; falling back`);
    else this.#log(`group info failed for ${chatId}: ${JSON.stringify(json).slice(0, 160)}`);
    return sessionTitle(message, chatId, chatType);
  }

  async #handle(message) {
    let text = typeof message?.text === 'string' ? message.text.trim() : '';
    const chatId = message?.chat?.id;
    const chatType = message?.chat?.type ?? 'private';
    const userId = message?.from?.user_id;
    if (!text || !chatId) return;
    if (chatType !== 'private') {
      // Group messages arrive with the @mention prefix glued to the text.
      text = text.replace(/^(?:@\S+\s*)+/, '').trim();
      if (!text) return;
    }

    const allowed = this.#config.allowAll === true
      || (Array.isArray(this.#config.allowedUsers) && this.#config.allowedUsers.includes(userId));
    if (!allowed) {
      await this.#client.send(chatId, chatType, `未授权。把你的 user_id 加入白名单即可：\nuser_id: ${userId}\nchat_id: ${chatId}\nchat_type: ${chatType}`);
      this.#log(`denied ${userId}`);
      return;
    }

    if (text === '/id') {
      let extra = '';
      if (chatType !== 'private') {
        const name = await this.#chatTitle(message, chatId, chatType).catch(() => chatId);
        if (name && name !== chatId) extra = `\ngroup_name: ${name}`;
      }
      await this.#client.send(chatId, chatType, `user_id: ${userId}\nchat_id: ${chatId}\nchat_type: ${chatType}${extra}`);
      return;
    }
    if (text === '/help' || text === '/start') {
      await this.#client.send(chatId, chatType, HELP);
      return;
    }

    const key = `${chatType}:${chatId}`;
    const title = await this.#chatTitle(message, chatId, chatType);
    if (text === '/new') {
      this.#state.sessions[key] = null;
      await saveState(this.#state).catch(() => {});
      await this.#client.send(chatId, chatType, '已开启新会话。');
      return;
    }
    if (text === '/stop') {
      const sessionId = this.#state.sessions[key];
      if (!sessionId) {
        await this.#client.send(chatId, chatType, '当前没有会话。');
        return;
      }
      await this.#gateway('session', 'cancel', { request: { sessionId } }).catch(() => {});
      this.#pending.get(sessionId)?.settle('stopped', '');
      await this.#client.send(chatId, chatType, '已请求停止当前任务。');
      return;
    }

    const prompt = text.startsWith('/task ') ? text.slice(6).trim() : text;
    if (!prompt) return;
    const started = Date.now();
    try {
      const sessionId = await this.#ensureSession(key, title);
      let result = await this.#ask(sessionId, prompt);
      if (!result.text) {
        // An archived or detached Session can accept a prompt yet never answer;
        // replacing the mapping gives the next turn a runtime that is still live.
        this.#log(`empty answer ${key}; replacing the session mapping and retrying once`);
        this.#state.sessions[key] = null;
        this.#pinned.delete(sessionId);
        await saveState(this.#state).catch(() => {});
        const fresh = await this.#ensureSession(key, title);
        result = await this.#ask(fresh, prompt);
      }
      const answer = result.text
        || '（这一轮没有拿到回答：助手没有输出文字）\n发 /new 可以立刻换一个新会话再试。';
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      for (const chunk of splitReply(answer)) {
        await this.#client.send(chatId, chatType, chunk);
        await sleep(300);
      }
      this.#log(`done ${key} ${seconds}s`);
    } catch (error) {
      this.#log(`failed ${key} ${error?.message ?? error}`);
      await this.#client.send(chatId, chatType, `执行失败：${error?.message ?? error}`).catch(() => {});
    }
  }

  // Confine every DeBox task to the Harness workspace: no writes outside it and
  // no interactive approvals (there is nobody to answer them on this channel).
  #pinWorkspace(sessionId, session) {
    if (this.#pinned.has(sessionId)) return;
    const target = session ?? this.#ctx.agents?.get?.(sessionId)?.session;
    if (!target || typeof target.append !== 'function') return;
    try {
      target.append('sandbox/mode', { mode: 'workspace-write' });
      target.append('approval/policy', { policy: 'never' });
      this.#pinned.add(sessionId);
      this.#log(`pinned workspace-write ${sessionId}`);
    } catch (error) {
      this.#log(`pin failed ${sessionId} ${error?.message ?? error}`);
    }
  }

  #gateway(namespace, method, args, signal) {
    return this.#ctx.typertGateway.invoke({
      namespace,
      method,
      args,
      peer: this.#peer,
      ...(signal ? { signal } : {}),
    });
  }

  /** Resolve (or create) the Workspace that owns the configured workdir. */
  async #resolveWorkspaceId(path) {
    if (this.#workspaceId !== undefined) return this.#workspaceId;
    if (typeof path !== 'string' || !path) {
      this.#workspaceId = null;
      return null;
    }
    try {
      // `create(request)` is a Typert remote method, so the argument object is
      // wrapped as `{ request }`; fall back to the bare shape if a build differs.
      const resolved = await this.#gateway('workspace', 'create', { request: { path } })
        .catch(() => this.#gateway('workspace', 'create', { path }));
      const workspaceId = resolved?.workspace?.workspaceId;
      this.#workspaceId = typeof workspaceId === 'string' && workspaceId ? workspaceId : null;
      this.#log(`workspace ${this.#workspaceId ?? '(none)'} for ${path}`);
    } catch (error) {
      this.#workspaceId = null;
      this.#log(`workspace resolve failed ${path} ${error?.message ?? error}`);
    }
    return this.#workspaceId;
  }

  async #ensureSession(key, title) {
    const existing = this.#state.sessions[key];
    if (typeof existing === 'string' && existing) {
      this.#pinWorkspace(existing);
      // A cached gid title or a sender-name title can be replaced once the real
      // group name is known; rename only when it actually changed.
      if (typeof title === 'string' && title && this.#state.titles?.[key] !== title) {
        await this.#gateway('session', 'rename', { request: { sessionId: existing, title } })
          .then(() => {
            this.#state.titles = { ...(this.#state.titles ?? {}), [key]: title };
            return saveState(this.#state).catch(() => {});
          })
          .catch((error) => this.#log(`rename failed ${existing} ${error?.message ?? error}`));
      }
      return existing;
    }
    const workdir = this.#config.workdir || process.cwd();
    // `workspaceId` and `cwd` are exclusive: naming the Workspace is what files
    // the Session under that Workspace in the sidebar instead of "Ungrouped".
    const workspaceId = await this.#resolveWorkspaceId(workdir);
    const created = await this.#gateway('session', 'create', {
      request: workspaceId ? { workspaceId } : { cwd: workdir },
    });
    const sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('session.create returned no sessionId');
    }
    this.#pinWorkspace(sessionId);
    if (typeof title === 'string' && title) {
      await this.#gateway('session', 'rename', { request: { sessionId, title } })
        .catch((error) => this.#log(`rename failed ${sessionId} ${error?.message ?? error}`));
    }
    this.#state.sessions[key] = sessionId;
    if (typeof title === 'string' && title) {
      this.#state.titles = { ...(this.#state.titles ?? {}), [key]: title };
    }
    await saveState(this.#state).catch(() => {});
    this.#log(`new session ${sessionId} for ${key}`);
    return sessionId;
  }

  async #ask(sessionId, prompt) {
    let settle;
    const outcome = new Promise((resolve) => {
      settle = (reason, text) => resolve({ reason, text });
    });
    const pending = {
      turn: null,
      text: '',
      settle: (reason, text) => {
        if (this.#pending.get(sessionId) === pending) this.#pending.delete(sessionId);
        settle(reason, text);
      },
    };
    this.#pending.set(sessionId, pending);
    const timer = setTimeout(() => pending.settle('timeout', ''), TASK_TIMEOUT_MS);
    try {
      await this.#gateway('session', 'prompt', {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        },
      });
    } catch (error) {
      pending.settle('error', '');
      clearTimeout(timer);
      throw error;
    }
    const result = await outcome;
    clearTimeout(timer);
    if (result.reason === 'ok') return { text: result.text, reason: 'ok' };
    if (result.reason === 'timeout') throw new Error('任务超时');
    throw new Error('任务已停止');
  }
}

export function apply(ctx, config = {}) {
  const log = typeof ctx?.logger === 'function' ? ctx.logger(name) : ctx?.logger ?? console;
  const write = (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      log?.info?.(line);
    } catch {
      // logging must never break the channel
    }
    void appendFile(logFile(), text).catch(() => {});
  };
  const ref = typeof config.apiKeyRef === 'string' && config.apiKeyRef.trim()
    ? config.apiKeyRef.trim()
    : DEFAULT_API_KEY_REF;
  const literal = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';

  const users = Array.isArray(config.allowedUsers) ? config.allowedUsers : [];
  write(`panel deps: configEditor=${typeof ctx.get === 'function' && ctx.get('configEditor') ? 'yes' : 'no'} entry=${ctx.fiber?.entry ? 'yes' : 'no'} fetch=${typeof ctx.connection?.fetch?.register === 'function' ? 'yes' : 'no'}`);
  write(`config ref=${ref} workdir=${config.workdir || '(cwd)'} allowAll=${config.allowAll === true} allowedUsers=${users.length ? users.join(',') : '(none)'}`);

  /** Live facts for the settings panel; the channel updates them as it runs. */
  const status = { connected: false, botName: null, botUserId: null, lastError: null, lastUpdateAt: null };
  let current = null;

  /** Resolve the key, then (re)build the channel; safe to call again after a key change. */
  const boot = async () => {
    const previous = current;
    current = null;
    status.connected = false;
    if (previous) {
      try { previous.channel.stop(); } catch { /* already stopped */ }
      try { previous.peer.dispose?.(); } catch { /* already disposed */ }
    }
    const apiKey = await resolveApiKey(ctx, ref, literal, write);
    if (!apiKey) {
      write(`no DeBox bot API key: credentials reference ${ref} is not configured; DeBox channel is idle`);
      return;
    }
    if (typeof ctx.connection?.createPeer !== 'function') {
      write('no connection service; DeBox channel is idle');
      return;
    }
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    const client = new DeBoxClient(apiKey, write);
    const channel = new Channel(ctx, config, write, client, peer, status);
    current = { peer, channel };
    try {
      await channel.init();
    } catch (error) {
      status.lastError = String(error?.message ?? error);
      write(`init failed ${status.lastError}`);
    }
  };

  ctx.effect(() => {
    void boot().catch((error) => write(`boot failed ${error?.message ?? error}`));
    return () => {
      const running = current;
      current = null;
      status.connected = false;
      try { running?.channel.stop(); } catch { /* already stopped */ }
      try { running?.peer.dispose?.(); } catch { /* already disposed */ }
    };
  }, 'dsh-im-debox: channel');

  registerSettingsRpc(ctx, {
    ref,
    status,
    config,
    write,
    reload: boot,
    sessions: () => current?.channel?.sessionIds?.() ?? [],
  });
}

/** Credential reference holding the DeBox bot App Key; see ~/.dsh/.credentials.yaml. */
const DEFAULT_API_KEY_REF = 'DSH_DEBOX_BOT_API_KEY';

/**
 * The bot key comes from DSH's credential service, never from this package's
 * shipped patch: a config literal is only a migration input, copied into the
 * credential store once and then cleared from the patch.
 * @param ctx - plugin context.
 * @param ref - credential reference name.
 * @param literal - legacy plaintext key from config, empty in a clean install.
 * @param write - logger.
 * @returns the API key, or an empty string when none is configured.
 */
async function resolveApiKey(ctx, ref, literal, write) {
  const credentials = ctx.credentials;
  let apiKey = literal;
  if (apiKey && typeof credentials?.describe === 'function' && typeof credentials?.set === 'function') {
    try {
      const info = await credentials.describe(ref);
      if (info?.configured !== true) {
        await credentials.set(ref, apiKey);
        write(`migrated the plaintext apiKey config into credentials reference ${ref}; clear apiKey from the patch`);
      }
    } catch (error) {
      write(`could not migrate apiKey into ${ref}: ${error?.message ?? error}`);
    }
  }
  if (!apiKey && typeof credentials?.resolve === 'function') {
    try {
      apiKey = (await credentials.resolve(ref))?.value ?? '';
    } catch (error) {
      write(`could not resolve ${ref}: ${error?.message ?? error}`);
      apiKey = '';
    }
  }
  return apiKey;
}

/** Endpoint the settings panel posts to; the Client addresses it as rpc.call('/api', 'dsh-im-debox', …). */
const SETTINGS_RPC_ENDPOINT = 'dsh-im-debox';

/** Envelope the Client's unary carrier expects for one rpcId. */
function rpcReply(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result });
}

/** JSON body reading with the same validation the carrier applies. */
async function readRpcRequest(request) {
  if (request.method !== 'POST') {
    return { response: new Response('method not allowed', { status: 405 }) };
  }
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return { response: new Response('content type must be application/json', { status: 415 }) };
  }
  let message;
  try {
    message = await request.json();
  } catch {
    return { response: new Response('body is not JSON', { status: 400 }) };
  }
  const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
  const call = message?.payload;
  if (message?.type !== 'client-request' || typeof message.rpcId !== 'string'
    || message.method !== SETTINGS_RPC_ENDPOINT || call === null || typeof call !== 'object'
    || typeof call.method !== 'string' || !Object.hasOwn(call, 'payload')) {
    return { rpcId, response: rpcReply(rpcId, { ok: false, error: { code: 'debox/bad-request', message: 'Invalid DeBox settings request.', details: {} } }) };
  }
  return { rpcId, method: call.method, payload: call.payload ?? {} };
}

/**
 * Serve the settings panel: status, save, key clearing, a live connection test.
 * The panel lives in client.js; this half owns the storage and the bot key.
 * @param ctx - plugin context.
 * @param deps - current config, credential reference, runtime status, logger, channel reload.
 */
function registerSettingsRpc(ctx, deps) {
  if (typeof ctx.connection?.fetch?.register !== 'function') {
    deps.write('connection fetch registry unavailable; the settings panel stays read-only');
    return;
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/${SETTINGS_RPC_ENDPOINT}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const parsed = await readRpcRequest(request);
      if (parsed.response) return parsed.response;
      try {
        const value = await settingsCall(ctx, deps, parsed.method, parsed.payload);
        return rpcReply(parsed.rpcId, { ok: true, value });
      } catch (error) {
        return rpcReply(parsed.rpcId, {
          ok: false,
          error: { code: 'debox/settings-failed', message: String(error?.message ?? error), details: {} },
        });
      }
    },
  }), 'dsh-im-debox: settings rpc');
}

/**
 * Dispatch one panel call.
 * @param ctx - plugin context.
 * @param deps - see registerSettingsRpc.
 * @param method - panel method name.
 * @param payload - its arguments.
 * @returns the JSON value returned to the panel.
 */
async function settingsCall(ctx, deps, method, payload) {
  if (method === 'status') return settingsStatus(ctx, deps);
  if (method === 'save') return settingsSave(ctx, deps, payload);
  if (method === 'test') return settingsTest(ctx, deps);
  if (method === 'clearKey') {
    await ctx.credentials.unset(deps.ref);
    deps.write('settings: cleared the stored bot key');
    return settingsStatus(ctx, deps);
  }
  throw new Error(`unknown DeBox settings method: ${method}`);
}

/** Current values plus the live connection facts the panel shows. */
async function settingsStatus(ctx, deps) {
  let keyConfigured = false;
  try {
    keyConfigured = (await ctx.credentials.describe(deps.ref))?.configured === true;
  } catch {
    keyConfigured = false;
  }
  const users = Array.isArray(deps.config.allowedUsers) ? deps.config.allowedUsers : [];
  return {
    keyRef: deps.ref,
    keyConfigured,
    workdir: typeof deps.config.workdir === 'string' ? deps.config.workdir : '',
    allowAll: deps.config.allowAll === true,
    allowedUsers: users,
    connected: deps.status.connected === true,
    botName: deps.status.botName,
    botUserId: deps.status.botUserId,
    lastError: deps.status.lastError,
    lastUpdateAt: deps.status.lastUpdateAt,
    sessionIds: typeof deps.sessions === 'function' ? deps.sessions() : [],
  };
}

/**
 * Sidebar title for a new Session. The row carries the DeBox mark already, so a
 * private chat is just `DeBox` and a group is the bare group name.
 * @param message - the normalized DeBox message.
 * @param chatId - chat identity used when no group name is known.
 * @param chatType - `private` or `group`.
 * @returns the title to write on the Session.
 */
function sessionTitle(message, chatId, chatType) {
  if (chatType === 'private') return 'DeBox';
  // Only the group's own name: the sender's nickname never titles a group row.
  const name = message?.chat?.title ?? message?.chat?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : chatId;
}

/** Normalize the allowlist the panel sends: a list, or comma/space separated text. */
function normalizeUsers(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，]+/) : [];
  return [...new Set(raw.map((entry) => String(entry).trim()).filter(Boolean))];
}

/** Live getMe with the stored key, so the panel can prove the credential works. */
async function settingsTest(ctx, deps) {
  const apiKey = await resolveApiKey(ctx, deps.ref, '', deps.write);
  if (!apiKey) throw new Error('还没有保存 Bot App Key');
  const me = await new DeBoxClient(apiKey, () => {}).me();
  return { name: me?.name ?? null, userId: me?.user_id ?? null, level: me?.level ?? null };
}

/**
 * Store what the panel sent: the key goes to the credential store, the rest to
 * the profile's own patch through the config editor (which reloads the plugin).
 */
async function settingsSave(ctx, deps, payload) {
  const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (apiKey) {
    await ctx.credentials.set(deps.ref, apiKey);
    deps.write(`settings: stored the bot key in credentials reference ${deps.ref}`);
  }
  const next = {};
  if (typeof payload?.workdir === 'string') next.workdir = payload.workdir.trim();
  if (typeof payload?.allowAll === 'boolean') next.allowAll = payload.allowAll;
  if (payload?.allowedUsers !== undefined) next.allowedUsers = normalizeUsers(payload.allowedUsers);
  if (Object.keys(next).length === 0) {
    if (apiKey) await deps.reload();
    return { saved: true, reloaded: apiKey !== '' };
  }
  const entry = ctx.fiber?.entry;
  const editor = ctx.get?.('configEditor');
  if (entry === undefined || editor === undefined) throw new Error('当前 profile 不能保存插件配置');
  // Return first, then reload: the config write restarts this plugin, which
  // would otherwise cut the response the panel is waiting for.
  setTimeout(() => {
    void editor.edit(entry, (current) => ({ ...current, ...next }))
      .catch((error) => deps.write(`settings: saving config failed ${error?.message ?? error}`));
  }, 60);
  deps.write(`settings: saving ${Object.keys(next).join(',')} through the config editor`);
  return { saved: true, restarting: true };
}

