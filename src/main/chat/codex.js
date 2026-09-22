const { JsonRpcProcess, binary } = require('./process');
const { codexPolicy } = require('../../shared/chat-options');
const { loadGlobalInstructions } = require('../config');

async function connect(cwd, onCreate) {
  const rpc = new JsonRpcProcess(binary('codex'), ['app-server'], { cwd });
  onCreate?.(rpc);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'lithium', title: 'Lithium', version: '0.3.10' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}
async function catalog(cwd) {
  const rpc = await connect(cwd);
  try {
    const [{ account }, models] = await Promise.all([rpc.request('account/read'), rpc.request('model/list', { limit: 100 })]);
    return { connected: account?.type === 'chatgpt', account: account?.type === 'chatgpt' ? `ChatGPT ${account.planType || ''}`.trim() : 'Run codex login to use your ChatGPT subscription', models: models.data.filter(m => !m.hidden).map(m => ({ id: m.model, label: m.displayName, efforts: m.supportedReasoningEfforts?.map(e => e.reasoningEffort) || [] })) };
  } finally { rpc.close(); }
}

class CodexAdapter {
  constructor(context, options = {}) { this.ctx = context; this.stopped = false; this.connect = options.connect || connect; this.items = new Map(); }
  async run(text, attachments) {
    const c = this.ctx;
    this.stopped = false;
    this.items.clear();
    const rpc = this.rpc && !this.rpc.closed ? this.rpc : await this.connect(c.directory, rpc => { this.rpc = rpc; if (this.stopped) rpc.close(); });
    if (this.stopped) { rpc.close(); return; }
    let finish;
    const completed = new Promise((resolve, reject) => { finish = { resolve, reject }; });
    // Attach a handler immediately, including failures during thread initialization.
    completed.catch(() => {});
    const onClosed = error => this.stopped ? finish.resolve() : finish.reject(error);
    const onNotification = ({ method, params: p }) => {
      if (p?.threadId && this.threadId && p.threadId !== this.threadId) return;
      if (method === 'turn/started') this.turnId = p.turn.id;
      if (method === 'item/started' || method === 'item/completed') this.item(p.item, method === 'item/completed');
      if (method === 'item/agentMessage/delta') c.delta(p.itemId, 'assistant', p.delta);
      if (method === 'item/reasoning/summaryTextDelta') c.delta(`${p.itemId}-thinking`, 'thinking', p.delta);
      if (method === 'item/commandExecution/outputDelta') c.delta(p.itemId, 'tool', p.delta);
      if (method === 'thread/tokenUsage/updated') c.update({ usage: p.tokenUsage });
      if (method === 'turn/diff/updated' && p.diff) c.entry({ id: `diff-${p.turnId}`, kind: 'tool', title: 'Changes', text: p.diff, status: 'completed' });
      if (method === 'turn/plan/updated') c.entry({ id: `plan-${p.turnId}`, kind: 'thinking', title: 'Plan', text: p.plan.map(step => `${step.status === 'completed' ? '✓' : '○'} ${step.step}`).join('\n') });
      if (method === 'error' && !p.willRetry) finish.reject(new Error(p.error?.message || 'Codex request failed.'));
      if (method === 'turn/completed') {
        p.turn.error ? finish.reject(new Error(p.turn.error.message)) : finish.resolve();
      }
      if (method === 'item/tool/requestUserInput') {
        c.entry({ id: `question-${p.itemId}`, kind: 'notice', title: 'Codex has a question', text: p.questions.map(q => q.question + (q.options?.length ? '\n' + q.options.map(o => `• ${o.label}: ${o.description}`).join('\n') : '')).join('\n\n') });
      }
    };
    const onRequest = request => this.approval(request).catch(error => { try { rpc.reject(request.id, error.message); } catch {} });
    rpc.on('closed', onClosed); rpc.on('notification', onNotification); rpc.on('request', onRequest);
    try {
      const { account } = await rpc.request('account/read');
      if (account?.type !== 'chatgpt') throw new Error('Sign in with codex login first. Lithium chat requires your ChatGPT subscription and will not fall back to API billing.');
      const policy = codexPolicy(c.settings.permissionMode);
      // Obtain native defaults on a fresh ephemeral thread before resuming. Omitting
      // overrides on resume would otherwise retain a previous Full access policy.
      let thread = await rpc.request('thread/start', { cwd: c.directory, ephemeral: !!c.nativeId, ...policy,
        ...(c.settings.model ? { model: c.settings.model } : {}), developerInstructions: loadGlobalInstructions() || undefined,
      });
      if (c.settings.permissionMode !== 'default') {
        const expectedSandbox = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' }[policy.sandbox];
        if (thread.sandbox.type !== expectedSandbox || thread.approvalPolicy !== policy.approvalPolicy || thread.approvalsReviewer !== policy.approvalsReviewer) {
          throw new Error('Codex did not accept the selected permission mode. No turn was started. Check your native or managed Codex configuration.');
        }
      }
      const defaultTurnPolicy = { sandboxPolicy: thread.sandbox, approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer };
      const defaultEffort = thread.reasoningEffort;
      if (c.nativeId) {
        const probeThreadId = thread.thread.id;
        const sandbox = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' }[thread.sandbox.type];
        if (!sandbox) throw new Error('This Codex sandbox profile cannot be resumed by Lithium yet. Use the official CLI.');
        thread = await rpc.request('thread/resume', { threadId: c.nativeId, cwd: c.directory, sandbox, approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer,
          model: thread.model, developerInstructions: loadGlobalInstructions() || undefined });
        // Release the defaults-only probe; keep only the actual chat loaded.
        if (probeThreadId !== thread.thread.id) await rpc.request('thread/unsubscribe', { threadId: probeThreadId });
      }
      if (this.stopped) return;
      this.threadId = thread.thread.id;
      c.update({ nativeId: this.threadId, effective: { model: thread.model, sandbox: defaultTurnPolicy.sandboxPolicy, approvalPolicy: defaultTurnPolicy.approvalPolicy, approvalsReviewer: defaultTurnPolicy.approvalsReviewer } });
      const input = [{ type: 'text', text, text_elements: [] }, ...attachments.map(a => ({ type: 'image', url: a.dataUrl }))];
      const result = await rpc.request('turn/start', { threadId: this.threadId, input,
        ...defaultTurnPolicy, model: thread.model, effort: c.settings.effort || defaultEffort || null });
      this.turnId = result.turn.id;
      if (this.stopped) await this.stop();
      await completed;
    } catch (error) { rpc.close(); throw error; }
    finally {
      rpc.removeListener('closed', onClosed); rpc.removeListener('notification', onNotification); rpc.removeListener('request', onRequest);
      this.turnId = null;
      // Keep the native session alive between turns, including session approvals.
      if (this.stopped) rpc.close();
    }
  }
  item(item, done) {
    const c = this.ctx;
    this.items.set(item.id, item);
    if (item.type === 'agentMessage') {
      if (done || item.text) c.entry({ id: item.id, kind: 'assistant', text: item.text || '' });
      if (done && item.questions?.length) c.entry({ id: `question-${item.id}`, kind: 'notice', title: 'Codex has a question', text: item.questions.map(q => q.title + (q.options?.length ? '\n' + q.options.map(o => `• ${o}`).join('\n') : '')).join('\n\n') });
    } else if (item.type === 'reasoning') {
      if (item.summary?.length) c.entry({ id: `${item.id}-thinking`, kind: 'thinking', text: item.summary.join('\n') });
    } else if (item.type === 'plan') c.entry({ id: item.id, kind: 'thinking', title: 'Plan', text: item.text });
    else if (item.type === 'commandExecution') c.entry({ id: item.id, kind: 'tool', title: 'Terminal', input: item.command, ...(item.aggregatedOutput != null ? { text: item.aggregatedOutput } : {}), status: done ? item.exitCode ? 'error' : 'completed' : 'running' });
    else if (item.type === 'fileChange') c.entry({ id: item.id, kind: 'tool', title: 'File changes', input: item.changes.map(f => f.path).join('\n'), text: item.changes.map(f => f.diff).join('\n'), status: item.status });
    else if (item.type !== 'userMessage') c.entry({ id: item.id, kind: 'tool', title: item.tool || item.type, input: item.arguments ? JSON.stringify(item.arguments, null, 2) : '', text: item.result ? JSON.stringify(item.result, null, 2) : item.query || '', status: done ? 'completed' : 'running' });
  }
  async approval({ id, method, params: p }) {
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!supported.includes(method)) {
      this.rpc.reject(id, `Lithium does not support ${method}; no permission was granted.`);
      this.ctx.notice(`Unsupported agent request: ${method}. No permission was granted.`);
      return;
    }
    const question = method === 'item/tool/requestUserInput';
    const mcp = method === 'mcpServer/elicitation/request';
    const item = this.items.get(p.itemId);
    const changes = item?.changes?.map(change => `${change.path}\n${change.diff}`).join('\n\n');
    const title = question ? 'Your input is needed' : method.includes('commandExecution') ? 'Allow this command?' : method.includes('fileChange') ? 'Allow these file changes?' : 'Permission requested';
    const answer = await this.ctx.ask({ kind: question ? 'question' : mcp ? 'elicitation' : 'approval', title,
      description: p.reason || p.message || 'Codex needs your approval to continue.', details: p.command || changes || JSON.stringify(p.permissions || p, null, 2), questions: p.questions,
      schema: mcp ? p.requestedSchema : undefined, allowSession: method === 'item/commandExecution/requestApproval' });
    if (this.stopped || this.rpc.closed) return;
    if (question) this.rpc.respond(id, { answers: answer.answers || {} });
    else if (mcp) this.rpc.respond(id, { action: answer.decision === 'allow' ? 'accept' : 'decline', content: answer.content || null, _meta: null });
    else if (method === 'item/permissions/requestApproval') this.rpc.respond(id, { permissions: answer.decision === 'allow' ? Object.fromEntries(Object.entries(p.permissions).filter(([, value]) => value != null)) : {}, scope: 'turn' });
    else this.rpc.respond(id, { decision: answer.decision === 'allow' ? 'accept' : answer.decision === 'session' ? 'acceptForSession' : 'decline' });
  }
  async stop() {
    this.stopped = true;
    if (this.rpc && !this.rpc.closed && this.threadId && this.turnId) {
      try { await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 3000); } catch {}
    }
    this.rpc?.close();
  }
}
module.exports = { CodexAdapter, catalog };
