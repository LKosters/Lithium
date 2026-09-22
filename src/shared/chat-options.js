// These are native provider policies, not application-side approval shortcuts.
const MODES = {
  claude: [
    { id: 'default', label: 'Default', description: 'Claude Code asks before actions that need permission.' },
    { id: 'acceptEdits', label: 'Accept edits', description: 'Accept file edits; ask before other restricted actions.' },
    { id: 'auto', label: 'Auto', description: 'Claude’s own classifier reviews actions. Requires an eligible account and model.' },
    { id: 'plan', label: 'Plan', description: 'Explore and plan. Claude asks before write operations.' },
    { id: 'bypassPermissions', label: 'Full access', description: 'Skip ordinary permission prompts. Claude’s enforced rules still apply.', danger: true },
  ],
  codex: [
    { id: 'default', label: 'Default', description: 'Use your Codex config, sandbox and approval settings unchanged.' },
    { id: 'readOnly', label: 'Read only', description: 'Read-only sandbox; ask before escalating access.' },
    { id: 'workspace', label: 'Workspace', description: 'Use Codex’s workspace sandbox and settings; ask when broader access is needed.' },
    { id: 'auto', label: 'Auto review', description: 'Codex’s workspace sandbox and settings, with its native automatic approval reviewer.' },
    { id: 'fullAccess', label: 'Full access', description: 'Unrestricted filesystem and network access, without approval prompts.', danger: true },
  ],
};

function validateSettings(settings) {
  if (!MODES[settings.provider]) throw new Error('Unknown chat provider.');
  if (!MODES[settings.provider].some(m => m.id === settings.permissionMode)) throw new Error('Unknown permission mode.');
  if (typeof settings.model !== 'string' || settings.model.length > 200) throw new Error('Invalid model.');
  if (!['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'].includes(settings.effort || '')) throw new Error('Invalid reasoning effort.');
  return { provider: settings.provider, permissionMode: settings.permissionMode, model: settings.model, effort: settings.effort || '' };
}

function codexPolicy(mode) {
  if (!MODES.codex.some(m => m.id === mode)) throw new Error('Unknown Codex permission mode.');
  if (mode === 'default') return {};
  const full = mode === 'fullAccess';
  const read = mode === 'readOnly';
  const approvalPolicy = full ? 'never' : 'on-request';
  const approvalsReviewer = mode === 'auto' ? 'auto_review' : 'user';
  // Network, extra writable roots and temporary-directory rules are resolved by
  // Codex itself. Do not replace user/managed sandbox settings with UI defaults.
  return { sandbox: full ? 'danger-full-access' : read ? 'read-only' : 'workspace-write', approvalPolicy, approvalsReviewer };
}

const DEFAULT_CHAT_SETTINGS = Object.freeze({ provider: 'claude', model: '', effort: '', permissionMode: 'default' });
function chatDefaults(value) {
  try { return validateSettings(value); }
  catch { return { ...DEFAULT_CHAT_SETTINGS }; }
}

module.exports = { MODES, validateSettings, codexPolicy, DEFAULT_CHAT_SETTINGS, chatDefaults };
