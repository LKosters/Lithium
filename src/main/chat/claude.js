const { randomUUID } = require('crypto');
const { binary, providerEnv, execJson } = require('./process');
const { loadGlobalInstructions } = require('../config');

class InputQueue {
  constructor() { this.values = []; this.waiters = []; this.closed = false; }
  push(value) { if (this.closed) return; const next = this.waiters.shift(); next ? next({ value, done: false }) : this.values.push(value); }
  close() { this.closed = true; for (const next of this.waiters.splice(0)) next({ done: true }); }
  next() { if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise(resolve => this.waiters.push(resolve)); }
  [Symbol.asyncIterator]() { return this; }
}
async function sdk() { return import('@anthropic-ai/claude-agent-sdk'); }
async function account(cwd) {
  const info = await execJson('claude', ['auth', 'status'], cwd);
  if (!info.loggedIn || info.authMethod !== 'claude.ai' || info.apiProvider !== 'firstParty') throw new Error('Sign in using claude auth login with your Claude subscription. API-key and third-party billing are not enabled in Lithium chat.');
  return info;
}
async function catalog(cwd) {
  const info = await account(cwd);
  const { query } = await sdk();
  const input = new InputQueue();
  const q = query({ prompt: input, options: { cwd, pathToClaudeCodeExecutable: binary('claude'), env: providerEnv(), settingSources: ['user', 'project', 'local'], persistSession: false } });
  const timer = setTimeout(() => { input.close(); q.close(); }, 20000);
  try {
    const init = await q.initializationResult();
    return { connected: true, account: `Claude ${info.subscriptionType || 'subscription'}`, models: init.models.map(m => ({ id: m.value, label: m.displayName, efforts: m.supportedEffortLevels || [] })) };
  } finally { clearTimeout(timer); input.close(); q.close(); }
}
class ClaudeAdapter {
  constructor(context, options = {}) {
    this.ctx = context; this.stopped = false; this.blocks = new Map();
    this.account = options.account || account; this.sdk = options.sdk || sdk;
    this.executable = options.executable || (() => binary('claude'));
  }
  async run(text, attachments) {
    const c = this.ctx;
    this.stopped = false;
    this.blocks.clear();
    await this.account(c.directory);
    if (this.stopped) return;
    const { query } = await this.sdk();
    if (this.stopped) return;
    const input = this.input = new InputQueue();
    const instructions = loadGlobalInstructions();
    const q = this.query = query({ prompt: input, options: {
      cwd: c.directory, pathToClaudeCodeExecutable: this.executable(), env: providerEnv(),
      settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code', ...(instructions ? { append: instructions } : {}) },
      permissionMode: c.settings.permissionMode, allowDangerouslySkipPermissions: c.settings.permissionMode === 'bypassPermissions',
      ...(c.settings.model ? { model: c.settings.model } : {}), ...(c.settings.effort ? { effort: c.settings.effort } : {}),
      ...(c.nativeId ? { resume: c.nativeId } : { sessionId: c.id }),
      includePartialMessages: true,
      canUseTool: async (name, toolInput, options) => {
        const isQuestion = name === 'AskUserQuestion';
        const result = await c.ask({ kind: isQuestion ? 'question' : 'approval', title: isQuestion ? 'Claude has a question' : name === 'ExitPlanMode' ? 'Ready to leave plan mode?' : `${name} needs permission`,
          description: options.decisionReason || 'Claude Code is waiting for your decision.', details: JSON.stringify(toolInput, null, 2),
          questions: isQuestion ? toolInput.questions.map((question, index) => ({ ...question, id: String(index) })) : undefined }, options.signal);
        if (result.decision !== 'allow') return { behavior: 'deny', message: 'The user declined this request.' };
        let updatedInput = toolInput;
        if (isQuestion) {
          const answers = {};
          toolInput.questions.forEach((question, index) => { answers[question.question] = (result.answers?.[String(index)]?.answers || []).join(', '); });
          updatedInput = { ...toolInput, answers };
        }
        return { behavior: 'allow', updatedInput };
      },
    } });
    const timer = setTimeout(() => { input.close(); q.close(); }, 30000);
    try {
      const init = await q.initializationResult();
      clearTimeout(timer);
      const a = init.account;
      if (a?.apiKeySource && a.apiKeySource !== 'none' && a.apiKeySource !== 'oauth') throw new Error('Claude selected API-key billing. Remove that configuration and sign in with your subscription.');
      if (this.stopped) return;
      input.push({ type: 'user', session_id: c.nativeId || c.id, parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content: [
        { type: 'text', text }, ...attachments.map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.dataUrl.split(',')[1] } })),
      ] } });
      for await (const message of q) {
        if (this.stopped) break;
        if (message.type === 'system' && message.subtype === 'init') {
          c.update({ nativeId: message.session_id });
          if (message.permissionMode !== c.settings.permissionMode) throw new Error(`Claude selected ${message.permissionMode} instead of ${c.settings.permissionMode}. No further actions were allowed. Select a supported mode and retry.`);
          c.update({ effective: { model: message.model, permissionMode: message.permissionMode } });
        }
        if (message.type === 'assistant' || message.type === 'result') c.update({ nativeId: message.session_id });
        this.message(message);
        if (message.type === 'result') {
          c.update({ usage: { input: message.usage?.input_tokens, output: message.usage?.output_tokens, durationMs: message.duration_ms } });
          if (message.is_error) throw new Error(message.errors?.join('\n') || message.result || 'Claude could not complete this turn.');
          break;
        }
      }
    } finally { clearTimeout(timer); input.close(); q.close(); }
  }
  message(m) {
    const c = this.ctx;
    if (m.type === 'stream_event') {
      const e = m.event;
      const parent = m.parent_tool_use_id || 'main';
      if (e.type === 'message_start') this.blocks.set(`${parent}-message`, e.message.id);
      const messageId = this.blocks.get(`${parent}-message`) || m.uuid;
      const key = `${parent}-${e.index}`;
      if (e.type === 'content_block_start') {
        const b = e.content_block;
        const id = b.type === 'tool_use' ? b.id : `${messageId}-${e.index}`;
        this.blocks.set(key, { id, type: b.type, input: '' });
        if (b.type === 'tool_use') c.entry({ id, kind: 'tool', title: b.name, text: '', status: 'running' });
        if (b.type === 'text' || b.type === 'thinking') c.entry({ id, kind: b.type === 'text' ? 'assistant' : 'thinking', text: b.text || b.thinking || '' });
      }
      if (e.type === 'content_block_delta') {
        const b = this.blocks.get(key);
        if (!b) return;
        if (e.delta.type === 'text_delta') c.delta(b.id, 'assistant', e.delta.text);
        if (e.delta.type === 'thinking_delta') c.delta(b.id, 'thinking', e.delta.thinking);
        if (e.delta.type === 'input_json_delta') { b.input += e.delta.partial_json; c.entry({ id: b.id, kind: 'tool', input: b.input }); }
      }
    }
    if (m.type === 'assistant') {
      (m.message.content || []).forEach((b, i) => {
        if (b.type === 'text' || b.type === 'thinking') c.entry({ id: `${m.message.id}-${i}`, kind: b.type === 'text' ? 'assistant' : 'thinking', text: b.text || b.thinking || '' });
        if (b.type === 'tool_use') c.entry({ id: b.id, kind: 'tool', title: b.name, input: JSON.stringify(b.input, null, 2), status: 'running' });
      });
    }
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) if (b.type === 'tool_result') c.entry({ id: b.tool_use_id, kind: 'tool', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2), status: b.is_error ? 'error' : 'completed' });
    }
    if (m.type === 'rate_limit_event') c.notice(`Claude usage limit: ${m.rate_limit_info?.status || 'reached'}. ${m.rate_limit_info?.resetsAt ? `Resets ${new Date(m.rate_limit_info.resetsAt * 1000).toLocaleString()}.` : ''}`);
    if (m.type === 'system' && m.subtype === 'compact_boundary') c.notice('Claude compacted the conversation. Your session continues with summarized context.');
  }
  async stop() { this.stopped = true; this.input?.close(); this.query?.close(); }
}
module.exports = { ClaudeAdapter, InputQueue, catalog };
