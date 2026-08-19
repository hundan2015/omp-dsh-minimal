/**
 * DSH-style minimal mode for omp.
 *
 * `/dsh-minimal` toggles the legacy minimal mode; `strict` narrows tools,
 * and `pro` performs a DeepSeek V4 Pro two-stage bootstrap:
 * 1. The first user turn is intercepted and replaced with the one-line
 *    system prompt ("You are a helpful software engineer assistant.") while
 *    only the DSH Minimal bash/str_replace_editor pair is exposed.
 * 2. After the warmup run ends, the original user prompt is handed back with
 *    the resident tool set (bash, str_replace_editor, tool_grant) inside a
 *    short cooperative frame ("We need to handle the following request together.").
 *    This keeps the model's CoT in the collaborative "we need / let's" style
 *    while the real request can unlock every other tool on demand via
 *    tool_grant.
 * The plugin also registers `xd` and `skills` for on-demand capability
 * discovery. When skills exist, the pro handoff advertises the compact
 * `tool_grant group skills -> skills list -> skills read` path instead of
 * dumping the catalog into the system prompt. Pro mode never injects an extra
 * prime message into the provider payload: the warmup prompt IS the first
 * user message.
 *
 * DeepSeek V4 Pro subagents (task/executor sessions with a session_init
 * entry) get the same two-stage treatment, initialized from the session_init
 * task instead of the `input` event: a text-only warmup turn, then the real
 * assignment inside the cooperative handoff with bash/str_replace_editor +
 * tool_grant + yield resident. Non-pro subagents are left untouched.
 *
 * `before_provider_request` patches provider payloads in place, while session
 * entries persist mode, Pro phase, and the pending warmup prompt across
 * resume/restart.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'

const STATE_ENTRY = 'com.dsh-minimal.state'
const WARMUP_ENTRY = 'com.dsh-minimal.warmup'
const MINIMAL_SYSTEM = 'You are a helpful software engineer assistant.'
const WARMUP_PROMPT = MINIMAL_SYSTEM
const PRO_EDITOR = 'str_replace_editor'

/** Strict-mode tool allowlist: bash + editing trio + the xd discovery device. */
const STRICT_TOOLS = new Set(['bash', 'edit', 'write', 'read', 'xd'])

/** The official DSH Minimal first-request tool names. */
const PRO_BOOTSTRAP_TOOLS = ['bash', PRO_EDITOR]

/** Resident tool set after warmup: Minimal pair + the on-demand unlock tool. */
const PRO_RESIDENT_TOOLS = ['bash', PRO_EDITOR, 'tool_grant']
const TOOL_GRANT_NAME = 'tool_grant'
const HANDOFF_PREFIX = 'We need to handle the following request together.\n\nCurrently available: bash, str_replace_editor, tool_grant.\nIf you need any other tools, call tool_grant first to discover and unlock them.\n\n'

/** Subagent sessions carry a session_init entry with the original task and the
 *  tools registered for that agent (read-only agents do not register bash). */
const SUBAGENT_INIT_ENTRY = 'session_init'
const SUBAGENT_RESIDENT_CANDIDATES = ['bash', PRO_EDITOR, TOOL_GRANT_NAME, 'yield']
const SUBAGENT_HANDOFF_BASE = 'We need to handle the following request together.\n\n'

function looksLikeHandoff(text: string): boolean {
  return typeof text === 'string' && (text.startsWith(HANDOFF_PREFIX) || text.startsWith(SUBAGENT_HANDOFF_BASE))
}

function stripHandoffFrame(text: string): string {
  let t = text
  while (t.startsWith(HANDOFF_PREFIX) || t.startsWith(SUBAGENT_HANDOFF_BASE)) {
    const prefix = t.startsWith(HANDOFF_PREFIX) ? HANDOFF_PREFIX : SUBAGENT_HANDOFF_BASE
    t = t.slice(prefix.length).replace(/^\n+/, '')
  }
  return t.trim()
}

/** Predefined groups for tool_grant. */
const TOOL_GROUPS: Record<string, string[]> = {
  files: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'str_replace_editor'],
  code: ['eval', 'lsp', 'debug', 'ast_edit'],
  subagent: ['task', 'hub'],
  research: ['web_search'],
  project: ['todo', 'workflow', 'checkpoint', 'rewind', 'goal'],
  browser: ['browser'],
  skills: ['skills'],
}

/** Official DSH Minimal persistent-bash JSON schema (transport-neutral). */
const DSH_MINIMAL_BASH_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to run. Relative path is preferred in the command.',
    },
  },
  required: ['command'],
}

/** Official DSH Minimal persistent-bash tool schema, byte-identical for bootstrap. */
const DSH_MINIMAL_BASH = {
  name: 'bash',
  description:
    'Run commands in a persistent bash shell. ' +
    'State, including the current directory and exported environment variables, ' +
    'persists across calls for this agent.',
  parameters: DSH_MINIMAL_BASH_SCHEMA,
  input_schema: DSH_MINIMAL_BASH_SCHEMA,
}

/** Official DSH Minimal str_replace_editor JSON schema (transport-neutral). */
const DSH_MINIMAL_EDITOR_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.',
      enum: ['view', 'create', 'str_replace', 'insert'],
    },
    path: {
      type: 'string',
      description: 'Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.',
    },
    file_text: {
      type: 'string',
      description: 'Required parameter of `create` command, with the content of the file to be created.',
    },
    insert_line: {
      type: 'integer',
      description: 'Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.',
    },
    new_str: {
      type: 'string',
      description: 'Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.',
    },
    old_str: {
      type: 'string',
      description: 'Required parameter of `str_replace` command containing the string in `path` to replace.',
    },
    view_range: {
      type: 'array',
      description: 'Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.',
      items: { type: 'integer' },
    },
  },
  required: ['command', 'path'],
}

/** Official DSH Minimal str_replace_editor tool schema, byte-identical for bootstrap. */
const DSH_MINIMAL_EDITOR = {
  name: 'str_replace_editor',
  description: `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``,
  parameters: DSH_MINIMAL_EDITOR_SCHEMA,
  input_schema: DSH_MINIMAL_EDITOR_SCHEMA,
}

/** One-line descriptions replacing the verbose built-ins when a mode is active.
 *  read/write carry the xd:// discovery protocol so it stays out of the system prompt. */
const SHORT_DESCRIPTIONS: Record<string, string> = {
  read: 'Read files, directories, archives, databases, documents, and URLs. Internal URLs: xd:// lists mounted tool devices; xd://<tool> returns that device\'s docs and JSON schema.',
  write: 'Create or overwrite a file; write JSON args to xd://<tool> to execute a mounted tool device.',
  bash: 'Run shell commands in a persistent shell.',
  edit: 'Edit a file via string replacement.',
  eval: 'Run code in a persistent kernel (Python or JS).',
  glob: 'Glob files and directories with pattern matching.',
  grep: 'Search file contents with regex.',
  task: 'Delegate work to background subagents.',
  hub: 'Coordinate with subagents and manage background processes.',
  todo: 'Track task progress with a todo list.',
  web_search: 'Search the web for current information.',
}

type Mode = 'off' | 'minimal' | 'strict' | 'pro'


// ---- skill scanning (standard provider roots, first name wins) -------------

interface SkillInfo {
  name: string
  description: string
  path: string
}

function skillRoots(cwd: string): string[] {
  const home = homedir()
  return [
    join(home, '.omp', 'agent', 'skills'),
    join(cwd, '.omp', 'skills'),
    join(cwd, '.agent', 'skills'),
    join(cwd, '.agents', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(cwd, '.codex', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.agents', 'skills'),
  ]
}

function parseFrontmatter(body: string): { name?: string; description?: string } {
  if (!body.startsWith('---')) return {}
  const end = body.indexOf('\n---', 3)
  if (end < 0) return {}
  const fm = body.slice(3, end)
  const key = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(fm)?.[1]
    return match ? match.replace(/^['"]|['"]$/g, '').trim() : undefined
  }
  return {
    name: key(/^name:\s*(.+)$/m),
    description: key(/^description:\s*(.+)$/m),
  }
}

function scanSkills(cwd: string): SkillInfo[] {
  const seen = new Set<string>()
  const out: SkillInfo[] = []
  for (const root of skillRoots(cwd)) {
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillMd = join(root, entry.name, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      let body: string
      try { body = readFileSync(skillMd, 'utf8') } catch { continue }
      const fm = parseFrontmatter(body)
      const name = fm.name ?? entry.name
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, description: fm.description ?? '', path: skillMd })
    }
  }
  return out
}
interface Entry {
  type: string
  customType?: string
  message?: { role?: string; content?: unknown; tool_calls?: unknown[] }
  data?: {
    mode?: Mode
    enabled?: boolean
    auto?: boolean
    phase?: 'bootstrap' | 'promoted'
    activeTools?: string[]
    promoteOn?: 'tool-call' | 'assistant-message' | 'either'
    grantedTools?: string[]
    warmupPhase?: 'pending' | 'done'
    handoffState?: 'queued' | 'sent'
    prompt?: string
  }
  agent?: string
  task?: string
  tools?: string[]
  systemPrompt?: string
  resolvedModel?: string
  outputSchema?: unknown
  outputSchemaMode?: string
  readOnly?: boolean
}

interface ToolParams {
  action: 'list' | 'read'
  name?: string
  query?: string
}

interface ToolGrantParams {
  query?: string
  tools?: string[]
  group?: string
}

interface EditorParams {
  command: 'view' | 'create' | 'str_replace' | 'insert'
  path: string
  file_text?: string
  old_str?: string
  new_str?: string
  insert_line?: number
  view_range?: number[]
}

interface SessionManager {
  getBranch(): Entry[]
}

interface Ctx {
  sessionManager?: SessionManager
  cwd?: string
  hasUI?: boolean
  model?: { id?: string; provider?: string; name?: string }
  models?: { current?(): { id?: string; provider?: string; name?: string } | undefined }
  ui?: { notify(text: string, level?: string): unknown }
  isIdle?(): boolean
}

interface CommandCtx extends Ctx {
  ui: { notify(text: string, level?: string): unknown }
}

interface ToolContext { cwd: string; sessionManager?: SessionManager }

interface ToolResult {
  content: { type: 'text'; text: string }[]
  details?: unknown
  isError?: boolean
}

interface Pi {
  on(event: string, handler: (event: unknown, ctx?: Ctx) => unknown | Promise<unknown>): unknown
  registerCommand(name: string, def: { description: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> }): unknown
  registerTool(def: {
    name: string
    label?: string
    description: string
    parameters: unknown
    loadMode?: string
    execute(id: string, params: ToolParams | EditorParams, signal: unknown, onUpdate: unknown, ctx: ToolContext): Promise<ToolResult>
  }): unknown
  appendEntry(type: string, data: unknown): unknown
  sendUserMessage?(content: string | unknown[], options?: { deliverAs?: 'steer' | 'followUp' }): void
  getActiveTools?(): string[]
  getAllTools?(): { name: string; description?: string }[]
  setActiveTools?(toolNames: string[]): Promise<void>
  zod: {
    object: (shape: Record<string, unknown>) => unknown
    enum: (values: readonly string[]) => unknown
    string: () => { optional: () => unknown }
    number: () => { optional: () => unknown }
    array: (value: unknown) => { optional: () => unknown }
  }
}

function readMode(sessionManager: SessionManager | undefined): Mode {
  if (!sessionManager) return 'off'
  let mode: Mode = 'off'
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY) continue
    const data = entry.data
    if (data?.mode === 'minimal' || data?.mode === 'strict' || data?.mode === 'pro') mode = data.mode
    else if (data?.enabled === true) mode = 'minimal'
    else mode = 'off'
  }
  return mode
}

function readProState(sessionManager: SessionManager | undefined): { phase: 'bootstrap' | 'promoted'; activeTools?: string[]; promoteOn?: 'tool-call' | 'assistant-message' | 'either'; grantedTools?: string[] } {
  let state: { phase: 'bootstrap' | 'promoted'; activeTools?: string[]; promoteOn?: 'tool-call' | 'assistant-message' | 'either'; grantedTools?: string[] } = { phase: 'bootstrap' }
  for (const entry of sessionManager?.getBranch() ?? []) {
    if (entry.type !== 'custom' || entry.customType !== STATE_ENTRY || entry.data?.mode !== 'pro') continue
    if (entry.data.phase === 'promoted') state = { phase: 'promoted', activeTools: entry.data.activeTools, promoteOn: entry.data.promoteOn, grantedTools: entry.data.grantedTools }
    else if (entry.data.phase === 'bootstrap') state = { phase: 'bootstrap', activeTools: entry.data.activeTools, promoteOn: entry.data.promoteOn, grantedTools: entry.data.grantedTools }
  }
  return state
}

function hasModeEntry(sessionManager: SessionManager | undefined): boolean {
  return sessionManager?.getBranch().some((entry) => entry.type === 'custom' && entry.customType === STATE_ENTRY) ?? false
}

interface WarmupState {
  phase?: 'pending' | 'done'
  prompt?: string
  handoffState?: 'queued' | 'sent'
}

function readWarmupState(sessionManager: SessionManager | undefined): WarmupState {
  let state: WarmupState = {}
  for (const entry of sessionManager?.getBranch() ?? []) {
    if (entry.type !== 'custom' || entry.customType !== WARMUP_ENTRY) continue
    if (entry.data?.warmupPhase === 'pending' || entry.data?.warmupPhase === 'done') {
      state = { phase: entry.data.warmupPhase, prompt: entry.data.prompt, handoffState: entry.data.handoffState }
    }
  }
  return state
}

function readWarmupPending(sessionManager: SessionManager | undefined): string | undefined {
  const state = readWarmupState(sessionManager)
  if (state.phase === 'pending') return typeof state.prompt === 'string' ? state.prompt : undefined
  if (state.phase === 'done' && state.handoffState === 'queued') return typeof state.prompt === 'string' ? state.prompt : undefined
  return undefined
}

function warmupHandoffCompleted(state: WarmupState): boolean {
  return state.phase === 'done' && state.handoffState !== 'queued'
}

function hasConversationEntries(sessionManager: SessionManager | undefined): boolean {
  if (!sessionManager) return false
  return sessionManager.getBranch().some((entry) => {
    if (entry.type === 'message' || entry.type === 'custom_message') return true
    const role = entry.message?.role
    return role === 'user' || role === 'assistant' || role === 'toolResult'
  })
}

interface SubagentInit {
  task?: string
  tools?: string[]
  agent?: string
  outputSchema?: unknown
  outputSchemaMode?: string
  readOnly?: boolean
}

function readSubagentInit(sessionManager: SessionManager | undefined): SubagentInit | undefined {
  if (!sessionManager) return undefined
  let init: SubagentInit | undefined
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== SUBAGENT_INIT_ENTRY) continue
    init = {
      task: typeof entry.task === 'string' ? entry.task : undefined,
      tools: Array.isArray(entry.tools) ? entry.tools : undefined,
      agent: typeof entry.agent === 'string' ? entry.agent : undefined,
      outputSchema: entry.outputSchema,
      outputSchemaMode: typeof entry.outputSchemaMode === 'string' ? entry.outputSchemaMode : undefined,
      readOnly: typeof entry.readOnly === 'boolean' ? entry.readOnly : undefined,
    }
  }
  return init
}

function isSubagentSession(sessionManager: SessionManager | undefined): boolean {
  return sessionManager?.getBranch().some((entry) => entry.type === SUBAGENT_INIT_ENTRY) ?? false
}

function subagentAvailableTools(sessionManager: SessionManager | undefined): Set<string> {
  const tools = readSubagentInit(sessionManager)?.tools ?? []
  return new Set(tools.map(normalizeToolName))
}

/** Minimal pair used for the subagent warmup turn. Read-only agents do not
 *  register bash, so fall back to the DSH Minimal editor alone. */
function subagentBootstrapTools(sessionManager: SessionManager | undefined): string[] {
  const available = subagentAvailableTools(sessionManager)
  const candidates = ['bash', PRO_EDITOR].filter((name) => available.size === 0 || available.has(name))
  if (candidates.length === 0) candidates.push(PRO_EDITOR)
  return candidates
}

/** Resident tool set for a promoted subagent: Minimal pair + tool_grant, plus
 *  yield because the subagent contract requires it to terminate. Only names
 *  actually registered for this agent are kept. */
function subagentResidentTools(sessionManager: SessionManager | undefined): string[] {
  const available = subagentAvailableTools(sessionManager)
  const candidates = SUBAGENT_RESIDENT_CANDIDATES.filter((name) => available.size === 0 || available.has(name))
  return candidates.length > 0 ? candidates : SUBAGENT_RESIDENT_CANDIDATES
}

function subagentHandoffPrefix(sessionManager: SessionManager | undefined): string {
  const names = subagentResidentTools(sessionManager)
  return `${SUBAGENT_HANDOFF_BASE}Currently available: ${names.join(', ')}.\nIf you need any other tools, call tool_grant first to discover and unlock them.\nWhen the assignment is complete, call yield with the final result.\n\n`
}

/** The task executor prefixes every subagent assignment with a harness
 *  imperative ("Complete assignment thoroughly"). The cooperative handoff
 *  mirrors the main-agent recipe better when that wrapper is not re-issued
 *  inside the "We need..." frame. */
function subagentAssignmentText(prompt: string): string {
  return prompt.replace(/^Complete assignment thoroughly:\s*\n+/i, '')
}

/** Compact yield contract for the subagent's own output schema. The full
 *  native system prompt is intentionally not sent (it re-opens first-person
 *  CoT), so the handoff carries just the terminal-call shape the model needs
 *  to avoid schema retry loops. */
function subagentYieldContract(sessionManager: SessionManager | undefined): string {
  const init = readSubagentInit(sessionManager)
  const schema = init?.outputSchema
  let shape = 'Call yield with result: {"data": <your final result object>} when the assignment is complete.'
  if (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) {
    const record = schema as { type?: unknown; properties?: Record<string, unknown> }
    if (record.type === 'string') {
      shape = 'Call yield with result: {"data": "<your final string result>"} when the assignment is complete.'
    } else if (record.properties && typeof record.properties === 'object') {
      const keys = Object.keys(record.properties)
      if (keys.includes('summary') && keys.includes('files') && keys.includes('architecture')) {
        shape = 'Call yield with result: {"data": {"summary": "...", "files": [{"path": "...", "description": "..."}], "architecture": "..."}} when the assignment is complete.'
      }
    }
  }
  const readOnly = init?.readOnly === true ? ' This agent is read-only: never create or modify files.' : ''
  return `${shape}${readOnly}`
}

/** On-demand skills onboarding footer. The catalog itself is never dumped:
 *  the handoff only advertises that skills exist and how to open the compact
 *  list, preserving the minimal-system / minimal-tool CoT anchor. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function referencedSkill(prompt: string | undefined, skills: SkillInfo[]): SkillInfo | undefined {
  if (!prompt) return undefined
  const text = prompt.toLowerCase()
  for (const skill of skills) {
    const name = skill.name.toLowerCase()
    if (!name) continue
    const pattern = new RegExp(`(?<![a-z0-9_-])${escapeRegExp(name)}(?![a-z0-9_-])`)
    if (pattern.test(text)) return skill
  }
  return undefined
}

function skillsFooter(cwd: string | undefined, enabledForSession: boolean, prompt: string | undefined): string {
  if (!enabledForSession || !cwd) return ''
  let skills: SkillInfo[] = []
  try { skills = scanSkills(cwd) } catch { return '' }
  if (skills.length === 0) return ''
  const required = referencedSkill(prompt, skills)
  if (required) {
    return `\n\n---\nThis request references the "${required.name}" skill.\nWe need to load it first: call tool_grant({ group: "skills" }), then skills read "${required.name}" and follow its protocol.`
  }
  return `\n\n---\nSkills: ${skills.length} skill${skills.length === 1 ? '' : 's'} installed. If one matches this request, call tool_grant({ group: "skills" }), then skills list, then skills read <name>.`
}

function isDeepSeekV4Pro(ctx: Ctx | undefined): boolean {
  const model = ctx?.model ?? ctx?.models?.current?.()
  const haystack = [model?.id, model?.provider, model?.name].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes('deepseek') && haystack.includes('v4') && haystack.includes('pro')
}

function isDeepSeekModel(ctx: Ctx | undefined): boolean {
  const model = ctx?.model ?? ctx?.models?.current?.()
  if (!model) return false
  const haystack = [model.id, model.provider, model.name].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes('deepseek')
}

function autoModeNotice(model: { id?: string; provider?: string; name?: string } | undefined): string {
  return `dsh-minimal auto-enabled (pro): detected ${model?.id ?? model?.name ?? 'DeepSeek V4 Pro'}, two-stage DSH Minimal warmup active`
}

function autoMinimalNotice(model: { id?: string; provider?: string; name?: string } | undefined): string {
  const label = model?.id ?? model?.name ?? 'DeepSeek model'
  return `dsh-minimal auto-enabled (minimal): detected ${label}, discovery protocol active`
}

function shouldAutoPro(sessionManager: SessionManager | undefined, ctx: Ctx | undefined): boolean {
  if (!isDeepSeekV4Pro(ctx)) return false
  const entries = sessionManager?.getBranch() ?? []
  const last = [...entries].reverse().find((entry) => entry.type === 'custom' && entry.customType === STATE_ENTRY)
  if (!last) return true
  // Migrate the plugin's previous automatic DeepSeek-wide minimal state.
  // Explicit user choices, including `/dsh-minimal minimal` or `off`, win.
  return last.data?.auto === true && last.data.mode === 'minimal'
}

function parseMode(args: string, current: Mode): Mode {
  const value = args.trim().toLowerCase()
  if (value === 'off') return 'off'
  if (value === 'on' || value === 'minimal') return 'minimal'
  if (value === 'strict') return 'strict'
  if (value === 'pro') return 'pro'
  return current === 'off' ? 'minimal' : 'off'
}

function modeNotice(mode: Mode): string {
  if (mode === 'minimal') return `dsh-minimal enabled (minimal): discovery protocol active, system prompt is "${MINIMAL_SYSTEM.slice(0, 60)}…"`
  if (mode === 'strict') return `dsh-minimal strict: only bash/edit/write/read, discovery protocol active, system prompt is "${MINIMAL_SYSTEM.slice(0, 60)}…"`
  if (mode === 'pro') return `dsh-minimal pro: warmup "${WARMUP_PROMPT}" runs with ${PRO_BOOTSTRAP_TOOLS.join(' + ')}, then the original prompt runs with ${PRO_RESIDENT_TOOLS.join(' + ')} and a cooperative handoff`
  return 'dsh-minimal disabled: default system prompt and tool descriptions restored'
}
interface ToolLike {
  name?: unknown
  description?: unknown
}

function isToolLike(tool: unknown): tool is ToolLike {
  return typeof tool === 'object' && tool !== null && 'name' in tool
}

function editorPath(cwd: string, path: string): string {
  const target = resolve(cwd, path)
  const root = resolve(cwd)
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.includes(':')) throw new Error('path must stay inside the current workspace')
  return target
}

function editorResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], details }
}

function executeEditor(params: EditorParams, ctx: ToolContext): ToolResult {
  const path = editorPath(ctx.cwd, params.path)
  if (params.command === 'view') {
    const body = readFileSync(path, 'utf8')
    const lines = body.split(/\r?\n/)
    let selected = lines
    if (Array.isArray(params.view_range) && params.view_range.length >= 2) {
      const start = params.view_range[0]
      const end = params.view_range[1]
      const startIdx = Math.max(0, start - 1)
      const endIdx = end === -1 ? lines.length : Math.min(lines.length, end)
      selected = lines.slice(startIdx, endIdx)
    }
    return editorResult(selected.map((line, index) => `${String(index + 1).padStart(4)}  ${line}`).join('\n'))
  }
  if (params.command === 'create') {
    if (params.file_text === undefined) throw new Error('file_text is required for create')
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, params.file_text)
    return editorResult(`Created ${params.path}`)
  }
  const body = readFileSync(path, 'utf8')
  if (params.command === 'str_replace') {
    if (params.old_str === undefined || params.new_str === undefined) throw new Error('old_str and new_str are required for str_replace')
    const count = body.split(params.old_str).length - 1
    if (count !== 1) throw new Error(`old_str must match exactly once; found ${count}`)
    writeFileSync(path, body.replace(params.old_str, params.new_str))
    return editorResult(`Updated ${params.path}`)
  }
  if (params.insert_line === undefined || params.new_str === undefined) throw new Error('insert_line and new_str are required for insert')
  const lines = body.split(/\r?\n/)
  lines.splice(Math.max(0, params.insert_line - 1), 0, params.new_str)
  writeFileSync(path, lines.join('\n'))
  return editorResult(`Updated ${params.path}`)
}

function isSystemLikeMessage(msg: unknown): msg is { role: string; content?: unknown } {
  if (typeof msg !== 'object' || msg === null || !('role' in msg)) return false
  return typeof msg.role === 'string' && (msg.role === 'system' || msg.role === 'developer')
}

function replaceSystemMessages(messages: unknown[]): void {
  let found = false
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!isSystemLikeMessage(msg)) continue
    if (!found) {
      found = true
      msg.content = MINIMAL_SYSTEM
    } else {
      messages.splice(i, 1)
      i--
    }
  }
  if (!found) messages.unshift({ role: 'system', content: MINIMAL_SYSTEM })
}

function applySystemPrompt(event: unknown): void {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null) return

  // OpenAI-style payloads: top-level `instructions` string.
  if ('instructions' in payload && typeof payload.instructions === 'string') {
    payload.instructions = MINIMAL_SYSTEM
  } else if ('system' in payload && Array.isArray(payload.system)) {
    // Anthropic-style payloads: `system` as an array of text blocks.
    payload.system = [{ type: 'text', text: MINIMAL_SYSTEM }]
  } else if ('system' in payload && typeof payload.system === 'string') {
    payload.system = MINIMAL_SYSTEM
  }

  // openai-completions: `messages` array with role=system/developer.
  if ('messages' in payload && Array.isArray(payload.messages)) {
    replaceSystemMessages(payload.messages)
  }

  // openai-responses: `input` array with role=system/developer.
  if ('input' in payload && Array.isArray(payload.input)) {
    replaceSystemMessages(payload.input)
  }
}

type ProviderToolKind = 'anthropic' | 'openai-responses' | 'openai-completions' | 'unknown'

function detectProviderToolKind(payload: unknown): ProviderToolKind {
  if (typeof payload !== 'object' || payload === null) return 'unknown'
  const tools = 'tools' in payload ? payload.tools : undefined
  if (Array.isArray(tools) && tools.length > 0) {
    const first = tools[0]
    if (typeof first === 'object' && first !== null) {
      if ('function' in first) return 'openai-completions'
      if ('input_schema' in first) return 'anthropic'
      if ('parameters' in first && 'name' in first) return 'openai-responses'
    }
  }
  if ('system' in payload) return 'anthropic'
  if ('input' in payload || 'instructions' in payload) return 'openai-responses'
  if ('messages' in payload) return 'openai-completions'
  return 'unknown'
}

function buildToolEntry(payload: unknown, def: { name: string; description: string; parameters: unknown; input_schema: unknown }): unknown {
  const kind = detectProviderToolKind(payload)
  if (kind === 'openai-completions') {
    return {
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      },
    }
  }
  if (kind === 'anthropic') {
    return {
      name: def.name,
      description: def.description,
      input_schema: def.input_schema,
    }
  }
  if (kind === 'openai-responses') {
    return {
      type: 'function',
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    }
  }
  // Unknown provider: keep both common schema fields so either style can read it.
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    input_schema: def.input_schema,
  }
}

function buildBootstrapTools(payload: unknown): unknown[] {
  return [
    buildToolEntry(payload, DSH_MINIMAL_BASH),
    buildToolEntry(payload, DSH_MINIMAL_EDITOR),
  ]
}

function normalizeToolName(name: string): string {
  return name.replace(/^_+/, '')
}

function toolNameOf(tool: unknown): string | undefined {
  if (typeof tool !== 'object' || tool === null) return undefined
  const t = tool as { name?: unknown; function?: { name?: unknown } }
  if (typeof t.name === 'string') return normalizeToolName(t.name)
  if (typeof t.function?.name === 'string') return normalizeToolName(t.function.name)
  return undefined
}

function stripInjectedText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\s*\[AGENTS\.md\][^\n]*\n?/gm, '')
    .replace(/^\s*\[CLAUDE\.md\][^\n]*\n?/gm, '')
    .replace(/^\s*# AGENTS\.md\s*$/gm, '')
    .replace(/^\s*Available skills:[^\n]*\n(?:\s*[-*][^\n]*\n)*/gm, '')
    .replace(/^\s*## Skills\s*\n(?:\s*[-*][^\n]*\n)*/gm, '')
    .replace(/^\s*skill catalog[^\n]*\n?/gm, '')
    .replace(/^\s*xd:\/\/skills[^\n]*\n?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function messageTextContent(msg: unknown): string {
  if (typeof msg !== 'object' || msg === null || !('content' in msg)) return ''
  const content = (msg as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block)
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('\n')
}

/** Subagent warmup must be a text-only anchor turn. Leaving the Minimal pair
 *  callable occasionally invites endless directory exploration before the
 *  handoff; forcing tool_choice none keeps the schemas visible but suppresses
 *  tool calls for exactly this one request. */
function forceNoToolChoice(event: unknown): void {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null) return
  const kind = detectProviderToolKind(payload)
  if (kind === 'anthropic') payload.tool_choice = { type: 'none' }
  else payload.tool_choice = 'none'
}

function setMessageTextContent(msg: unknown, text: string): void {
  if (typeof msg !== 'object' || msg === null || !('content' in msg)) return
  const target = msg as { content?: unknown }
  if (Array.isArray(target.content)) target.content = [{ type: 'text', text }]
  else target.content = text
}

/** The subagent task is already persisted in its own history; this only
 *  rewrites the outgoing first-turn payload so the model sees the same
 *  warmup prompt the main agent gets. */
function replaceSubagentTaskWithWarmup(event: unknown, pendingTask: string): void {
  replaceSubagentTaskMessage(event, pendingTask, 'last')
}

/** Rewrites the ORIGINAL task user message (the first one, persisted before
 *  the warmup turn) to the warmup prompt on the real-task request. Wire
 *  context then becomes warmup-user -> warmup-assistant -> cooperative
 *  handoff, exactly like the validated main-agent transcript. */
function rewriteOriginalSubagentTaskAsWarmup(event: unknown, originalTask: string): void {
  replaceSubagentTaskMessage(event, originalTask, 'first')
}

function replaceSubagentTaskMessage(event: unknown, task: string, mode: 'first' | 'last'): void {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null) return
  const messages = 'messages' in payload && Array.isArray(payload.messages)
    ? payload.messages
    : 'input' in payload && Array.isArray(payload.input)
      ? payload.input
      : []
  for (let i = mode === 'last' ? messages.length - 1 : 0; mode === 'last' ? i >= 0 : i < messages.length; mode === 'last' ? i-- : i++) {
    const msg = messages[i]
    if (typeof msg !== 'object' || msg === null || !('role' in msg) || msg.role !== 'user') continue
    const text = messageTextContent(msg)
    if (task && !text.includes(task) && !task.includes(text)) continue
    setMessageTextContent(msg, WARMUP_PROMPT)
    return
  }
}

function stripBootstrapContext(event: unknown): void {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null) return
  const messages = 'messages' in payload && Array.isArray(payload.messages)
    ? payload.messages
    : 'input' in payload && Array.isArray(payload.input)
      ? payload.input
      : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (typeof msg !== 'object' || msg === null || !('content' in msg) || !('role' in msg)) continue
    const role = msg.role
    if (role !== 'user' && role !== 'system' && role !== 'developer') continue
    const content = msg.content
    if (typeof content === 'string') {
      const cleaned = stripInjectedText(content)
      if (!cleaned) messages.splice(i, 1)
      else msg.content = cleaned
    } else if (Array.isArray(content)) {
      const cleanedBlocks = content.filter((block) => {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block) {
          const text = block.text
          if (typeof text !== 'string') return true
          const cleaned = stripInjectedText(text)
          if (!cleaned) return false
          block.text = cleaned
        }
        return true
      })
      if (cleanedBlocks.length === 0) messages.splice(i, 1)
      else msg.content = cleanedBlocks
    }
  }
}


function applyTools(event: unknown, mode: Mode, proPhase: 'bootstrap' | 'promoted' = 'promoted'): void {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return
  const payload = event.payload as { tools?: unknown[] }
  if (typeof payload !== 'object' || payload === null) return
  if (mode === 'pro' && proPhase === 'bootstrap') {
    // Bootstrap uses the real registered bash/str_replace_editor tools, but
    // the model-visible payload is byte-identical to official DSH Minimal.
    payload.tools = buildBootstrapTools(payload)
    return
  }
  if (!('tools' in payload) || !Array.isArray(payload.tools)) return
  let tools = payload.tools
  if (mode === 'strict') {
    tools = tools.filter((tool): tool is ToolLike => {
      if (!isToolLike(tool) || typeof tool.name !== 'string') return false
      return STRICT_TOOLS.has(tool.name.replace(/^_+/, ''))
    })
    payload.tools = tools
  }
  for (const tool of tools) {
    if (!isToolLike(tool) || typeof tool.name !== 'string') continue
    const short = SHORT_DESCRIPTIONS[tool.name.replace(/^_+/, '')]
    if (short) tool.description = short
  }
}

function applyPromotedTools(event: unknown, allowed: Set<string>): void {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return
  const payload = event.payload as { tools?: unknown[] }
  if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.tools)) return
  const kept: unknown[] = []
  for (const tool of payload.tools) {
    const name = toolNameOf(tool)
    if (!name || !allowed.has(name)) continue
    if (name === 'bash') kept.push(buildToolEntry(payload, DSH_MINIMAL_BASH))
    else if (name === PRO_EDITOR) kept.push(buildToolEntry(payload, DSH_MINIMAL_EDITOR))
    else kept.push(tool)
  }
  payload.tools = kept
}

function applyMode(event: unknown, mode: Mode, proPhase: 'bootstrap' | 'promoted' = 'promoted'): void {
  if (mode === 'pro' && proPhase === 'bootstrap') stripBootstrapContext(event)
  applySystemPrompt(event)
  applyTools(event, mode, proPhase)
}

function filterSkills(skills: SkillInfo[], query: string | undefined): SkillInfo[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!needle) return skills
  return skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle))
}

function renderSkillList(skills: SkillInfo[], query?: string): string {
  const filtered = filterSkills(skills, query)
  if (filtered.length === 0) return typeof query === 'string' && query.trim() ? `No skills match "${query.trim()}".` : 'No skills found.'
  return filtered.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n')
}

function eventToolName(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const value = event as { toolName?: unknown; name?: unknown }
  if (typeof value.toolName === 'string') return value.toolName
  return typeof value.name === 'string' ? value.name : undefined
}

function hasToolCallInHistory(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return false
  const payload = (event as { payload?: { messages?: unknown[]; input?: unknown[] } }).payload
  if (!payload) return false
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : []
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null || !('role' in msg)) continue
    if (msg.role !== 'assistant') continue
    if ('tool_calls' in msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true
    if ('content' in msg && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && (block.type === 'tool_use' || block.type === 'toolCall')) return true
      }
    }
  }
  return false
}

function hasAssistantMessageInHistory(event: unknown): boolean {
  if (typeof event !== 'object' || event === null || !('payload' in event)) return false
  const payload = (event as { payload?: { messages?: unknown[]; input?: unknown[] } }).payload
  if (!payload) return false
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : []
  return messages.some((msg) => typeof msg === 'object' && msg !== null && 'role' in msg && msg.role === 'assistant')
}

function hasToolCallInBranch(sessionManager: SessionManager | undefined): boolean {
  if (!sessionManager) return false
  return sessionManager.getBranch().some((entry) => {
    if (entry.type === 'tool_call'
      || entry.customType === 'tool_call'
      || entry.type === 'tool_execution_start'
      || entry.customType === 'tool_execution_start') return true
    const message = entry.message
    if (message?.role !== 'assistant') return false
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true
    if (!Array.isArray(message.content)) return false
    return message.content.some((block) => typeof block === 'object' && block !== null && 'type' in block && (block.type === 'tool_use' || block.type === 'toolCall'))
  })
}

function hasAssistantMessageInBranch(sessionManager: SessionManager | undefined): boolean {
  if (!sessionManager) return false
  return sessionManager.getBranch().some((entry) => entry.type === 'assistant_message' || entry.customType === 'assistant_message' || entry.message?.role === 'assistant')
}

export default function (pi: Pi) {
  pi.registerCommand('dsh-minimal', {
    description: 'Toggle minimal, strict, or DeepSeek V4 Pro two-stage warmup mode.',
    handler: (args, ctx) => {
      const next = parseMode(args, readMode(ctx.sessionManager))
      pi.appendEntry(STATE_ENTRY, { mode: next, phase: next === 'pro' ? 'bootstrap' : undefined, activeTools: next === 'pro' ? pi.getActiveTools?.() : undefined, promoteOn: next === 'pro' ? 'tool-call' : undefined })
      if (next !== 'pro') pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'done' })
      ctx.ui.notify(modeNotice(next), 'info')
    },
  })

  pi.registerTool({
    name: PRO_EDITOR,
    label: 'String Replace Editor',
    description: 'View and edit files using view, create, str_replace, and insert commands.',
    parameters: pi.zod.object({
      command: pi.zod.enum(['view', 'create', 'str_replace', 'insert']),
      path: pi.zod.string(),
      file_text: pi.zod.string().optional(),
      old_str: pi.zod.string().optional(),
      new_str: pi.zod.string().optional(),
      insert_line: pi.zod.number().optional(),
      view_range: pi.zod.array(pi.zod.number()).optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try { return executeEditor(params as EditorParams, ctx) } catch (error) {
        return { content: [{ type: 'text', text: String(error instanceof Error ? error.message : error) }], isError: true }
      }
    },
  })

  pi.registerTool({
    name: 'xd', label: 'XD Devices', loadMode: 'essential',
    description: 'Discover extra capabilities through xd:// devices.',
    parameters: pi.zod.object({}),
    async execute() { return { content: [{ type: 'text', text: 'Use read xd:// to enumerate devices.' }] } },
  })

  pi.registerTool({
    name: 'skills', label: 'Skills', description: 'List or read available skills.',
    parameters: pi.zod.object({ action: pi.zod.enum(['list', 'read']), name: pi.zod.string().optional(), query: pi.zod.string().optional() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const skillParams = params as ToolParams
      if (skillParams.action === 'list') {
        const skills = scanSkills(ctx.cwd)
        return { content: [{ type: 'text', text: renderSkillList(skills, skillParams.query) }], details: { skills } }
      }
      const skill = scanSkills(ctx.cwd).find((item) => item.name === skillParams.name)
      if (!skill) return { content: [{ type: 'text', text: `No skill named "${skillParams.name ?? ''}".` }], isError: true }
      return { content: [{ type: 'text', text: readFileSync(skill.path, 'utf8') }], details: { name: skill.name } }
    },
  })

  pi.registerTool({
    name: TOOL_GRANT_NAME,
    label: 'Tool Grant',
    description: 'Discover and unlock tools. bash and str_replace_editor are already available; call this to search for or unlock any other tool.',
    parameters: pi.zod.object({
      query: pi.zod.string().optional(),
      tools: pi.zod.array(pi.zod.string()).optional(),
      group: pi.zod.string().optional(),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const p = params as ToolGrantParams
      const allTools = pi.getAllTools?.() ?? []
      const availableNames = new Set(allTools.map((t) => normalizeToolName(t.name)))
      const lines: string[] = []
      const query = typeof p.query === 'string' ? p.query.trim().toLowerCase() : ''
      const requested = Array.isArray(p.tools) ? p.tools.map(normalizeToolName) : []
      const group = typeof p.group === 'string' ? p.group.trim().toLowerCase() : ''

      if (query) {
        const tokens = query.split(/\s+/).filter(Boolean)
        const scored = allTools.map((t) => {
          const name = normalizeToolName(t.name)
          const desc = typeof t.description === 'string' ? t.description : SHORT_DESCRIPTIONS[name] ?? ''
          const groups = Object.entries(TOOL_GROUPS)
            .filter(([, names]) => names.includes(name))
            .map(([group]) => group)
            .join(' ')
          const haystack = `${name} ${desc} ${groups}`.toLowerCase()
          const score = tokens.filter((token) => haystack.includes(token)).length
          return { t, score }
        }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score)
        const matches = scored.map((item) => item.t)
        lines.push(`Matching tools (${matches.length}):`)
        for (const t of matches.slice(0, 25)) {
          const name = normalizeToolName(t.name)
          const desc = (typeof t.description === 'string' ? t.description.split('\n')[0] : SHORT_DESCRIPTIONS[name] ?? '').slice(0, 90)
          lines.push(`- ${name}: ${desc}`)
        }
        if (matches.length === 0) lines.push('No matches. Try another keyword or use group names: ' + Object.keys(TOOL_GROUPS).join(', '))
        else lines.push('Unlock with tool_grant({"tools": ["<exact name>"]}).')
      }

      const unlock = new Set<string>()
      if (group && TOOL_GROUPS[group]) {
        for (const name of TOOL_GROUPS[group]) if (availableNames.has(name)) unlock.add(name)
      }
      for (const name of requested) if (availableNames.has(name)) unlock.add(name)

      if (unlock.size > 0) {
        const state = readProState(ctx?.sessionManager)
        const granted = new Set(state.grantedTools ?? [])
        for (const name of unlock) granted.add(name)
        const grantedList = [...granted]
        const resident = isSubagentSession(ctx?.sessionManager) ? subagentResidentTools(ctx?.sessionManager) : PRO_RESIDENT_TOOLS
        const nextActive = [...resident, ...grantedList]
        pi.appendEntry(STATE_ENTRY, { mode: 'pro', phase: 'promoted', activeTools: nextActive, promoteOn: state.promoteOn ?? 'tool-call', grantedTools: grantedList })
        await pi.setActiveTools?.(nextActive)
        lines.push(`Unlocked for the next request: ${[...unlock].join(', ')}`)
        lines.push('They will appear in the next provider request.')
      }

      if (lines.length === 0) {
        lines.push('Provide `query` to search the catalog, `tools` to unlock exact tools, or `group` to unlock a group.')
        lines.push('Available groups: ' + Object.keys(TOOL_GROUPS).join(', '))
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  })

  let warmupImages: unknown[] | undefined
  let handoffInFlight = false

  function allToolNames(): string[] {
    const all = pi.getAllTools?.() ?? []
    const names = all
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string')
    if (names.length > 0) return names
    return pi.getActiveTools?.() ?? []
  }

  function resolveMode(ctx: Ctx | undefined): Mode {
    const mode = readMode(ctx?.sessionManager)
    if (hasModeEntry(ctx?.sessionManager)) return mode
    if (isSubagentSession(ctx?.sessionManager)) {
      // Subagents never see the interactive `input` event, so the two-stage
      // warmup is initialized from the session_init contract instead. Only
      // DeepSeek V4 Pro subagents are rewritten; every other subagent keeps
      // its native system prompt and full tool set.
      if (!shouldAutoPro(ctx?.sessionManager, ctx)) return 'off'
      const init = readSubagentInit(ctx?.sessionManager)
      pi.appendEntry(STATE_ENTRY, {
        mode: 'pro',
        phase: 'bootstrap',
        activeTools: Array.isArray(init?.tools) ? init.tools : pi.getActiveTools?.(),
        auto: true,
        promoteOn: 'tool-call',
      })
      if (typeof init?.task === 'string') pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'pending', prompt: init.task })
      ctx?.ui?.notify?.(`dsh-minimal pro subagent warmup: ${init?.agent ?? 'subagent'} will run the DSH Minimal warmup before its assignment`, 'info')
      return 'pro'
    }
    if (shouldAutoPro(ctx?.sessionManager, ctx)) {
      pi.appendEntry(STATE_ENTRY, { mode: 'pro', phase: 'bootstrap', activeTools: pi.getActiveTools?.(), auto: true, promoteOn: 'tool-call' })
      ctx?.ui?.notify?.(autoModeNotice(ctx?.model ?? ctx?.models?.current?.()), 'info')
      return 'pro'
    }
    if (isDeepSeekModel(ctx)) {
      pi.appendEntry(STATE_ENTRY, { mode: 'minimal', auto: true })
      ctx?.ui?.notify?.(autoMinimalNotice(ctx?.model ?? ctx?.models?.current?.()), 'info')
      return 'minimal'
    }
    return mode
  }

  async function finishWarmup(ctx: Ctx | undefined, deliverAs?: 'steer' | 'followUp'): Promise<void> {
    if (handoffInFlight) return
    const warmup = readWarmupState(ctx?.sessionManager)
    if (warmupHandoffCompleted(warmup)) return
    const prompt = readWarmupPending(ctx?.sessionManager)
    if (prompt === undefined) return
    if (readMode(ctx?.sessionManager) !== 'pro') {
      pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'done', prompt, handoffState: 'sent' })
      return
    }
    handoffInFlight = true
    try {
      const subagent = isSubagentSession(ctx?.sessionManager)
      const resident = subagent ? subagentResidentTools(ctx?.sessionManager) : PRO_RESIDENT_TOOLS
      // Warmup is complete. Promote to the resident tool set (Minimal pair +
      // tool_grant, plus yield for subagents) and hand the original prompt over
      // inside a short cooperative frame. For subagents the harness wrapper
      // ("Complete assignment thoroughly") is stripped so the frame opens on
      // the assignment text itself, and the wire transcript is rewritten to
      // warmup-user -> warmup-assistant -> cooperative handoff.
      const state = readProState(ctx?.sessionManager)
      pi.appendEntry(STATE_ENTRY, { mode: 'pro', phase: 'promoted', activeTools: resident, promoteOn: state.promoteOn ?? 'tool-call', grantedTools: [] })
      pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'done', prompt, handoffState: 'queued' })
      await pi.setActiveTools?.(resident)
      // Mirror the proven main-agent recipe: the follow-up user message starts
      // with the cooperative "We need..." frame and carries the assignment text
      // itself (without the harness's "Complete assignment thoroughly" wrapper).
      const originalPrompt = stripHandoffFrame(prompt)
      const subagentContract = subagent ? `\n\n${subagentYieldContract(ctx?.sessionManager)}` : ''
      const skillsAvailable = subagent ? subagentAvailableTools(ctx?.sessionManager).has('skills') : true
      const skillFooter = skillsFooter(ctx?.cwd, skillsAvailable, originalPrompt)
      const handoff = subagent ? `${subagentHandoffPrefix(ctx?.sessionManager)}${subagentAssignmentText(originalPrompt)}${subagentContract}${skillFooter}` : `${HANDOFF_PREFIX}${originalPrompt}${skillFooter}`
      const content: unknown[] = [{ type: 'text', text: handoff }]
      if (Array.isArray(warmupImages) && warmupImages.length > 0) content.push(...warmupImages)
      if (deliverAs) pi.sendUserMessage?.(content, { deliverAs })
      else pi.sendUserMessage?.(content)
      pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'done', prompt, handoffState: 'sent' })
      warmupImages = undefined
      ctx?.ui?.notify?.(`dsh-minimal pro warmup complete: sending the assignment with resident tools (${resident.join(', ')})`, 'info')
    } finally {
      handoffInFlight = false
    }
  }

  pi.on('input', (event, ctx) => {
    const input = event as { text?: unknown; images?: unknown; source?: unknown }
    // The handoff message sent by pi.sendUserMessage is not a new user turn.
    if (input.source === 'extension') return
    // Subagent tasks are injected via session.prompt and never reach `input`.
    if (isSubagentSession(ctx?.sessionManager)) return
    const mode = resolveMode(ctx)
    if (mode !== 'pro') return
    const warmup = readWarmupState(ctx?.sessionManager)
    if (warmup.phase === 'done') return
    if (typeof input.text !== 'string' || input.text.startsWith('/')) return
    if (looksLikeHandoff(input.text)) {
      // Tree replay of a handoff message (or a user manually pasting the same
      // cooperative frame) must not start a second warmup or wrap the frame
      // again. Promote immediately and treat the text as the real user turn.
      const resident = isSubagentSession(ctx?.sessionManager)
        ? subagentResidentTools(ctx?.sessionManager)
        : PRO_RESIDENT_TOOLS
      pi.appendEntry(STATE_ENTRY, { mode: 'pro', phase: 'promoted', activeTools: resident, promoteOn: 'tool-call', grantedTools: [] })
      pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'done', prompt: input.text, handoffState: 'sent' })
      return
    }
    if (warmup.phase === 'pending') {
      if (!hasConversationEntries(ctx?.sessionManager)) {
        // Previous warmup never produced a conversation turn; retry with this prompt.
        pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'pending', prompt: input.text })
        return { action: 'transform', text: WARMUP_PROMPT }
      }
      // Stale pending from an interrupted warmup: discard so this prompt is never swallowed.
      pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'done', handoffState: 'sent' })
      ctx?.ui?.notify?.('dsh-minimal pro: discarded stale warmup state', 'warning')
      return
    }
    if (hasConversationEntries(ctx?.sessionManager)) return
    warmupImages = Array.isArray(input.images) ? input.images : undefined
    pi.appendEntry(WARMUP_ENTRY, { warmupPhase: 'pending', prompt: input.text })
    ctx?.ui?.notify?.(`dsh-minimal pro warmup: running "${WARMUP_PROMPT}" with DSH Minimal tools`, 'info')
    return { action: 'transform', text: WARMUP_PROMPT }
  })

  pi.on('tool_call', async (event, ctx) => {
    if (readMode(ctx?.sessionManager) !== 'pro') return
    const toolName = eventToolName(event)
    if (!toolName) return
    // The warmup turn must keep seeing only DSH Minimal tools. Promote only
    // after a tool call made in the original prompt's turn.
    if (readWarmupPending(ctx?.sessionManager) !== undefined) {
      ctx?.ui?.notify?.(`dsh-minimal pro warmup: ${toolName} detected, deferring promotion until the original turn`, 'info')
      return
    }
    const state = readProState(ctx?.sessionManager)
    if (state.phase === 'promoted') return
    const activeTools = Array.isArray(state.activeTools) ? state.activeTools : allToolNames()
    pi.appendEntry(STATE_ENTRY, { mode: 'pro', phase: 'promoted', activeTools, promoteOn: state.promoteOn ?? 'tool-call' })
    if (activeTools.length > 0) await pi.setActiveTools?.(activeTools)
  })

  async function ensureProBootstrap(ctx: Ctx | undefined, tools: string[] = PRO_BOOTSTRAP_TOOLS): Promise<void> {
    if (readMode(ctx?.sessionManager) !== 'pro') return
    const state = readProState(ctx?.sessionManager)
    if (state.phase !== 'bootstrap') return
    // Restrict active tools to the DSH Minimal pair (main) or the subset the
    // subagent actually registered (read-only agents have no bash). The
    // payload is replaced with the official byte-identical schemas by
    // applyPromotedTools, while dispatch still reaches the registered tools.
    await pi.setActiveTools?.(tools)
  }

  pi.on('session_start', (_event, ctx) => {
    if (isSubagentSession(ctx?.sessionManager)) {
      // Subagents are started by the task executor before their first prompt.
      // Resolve mode here so the warmup state exists before before_agent_start
      // and the provider-request payload is built.
      resolveMode(ctx)
      return
    }
    if (readMode(ctx?.sessionManager) !== 'pro') return
    if (readWarmupPending(ctx?.sessionManager) === undefined) return
    if (ctx?.isIdle?.() === false) return
    const model = ctx?.model ?? ctx?.models?.current?.()
    if (!model) return
    if (hasAssistantMessageInBranch(ctx.sessionManager)) {
      // Warmup finished before a restart: hand off the original prompt now.
      void finishWarmup(ctx)
    } else if (!hasConversationEntries(ctx.sessionManager)) {
      // Warmup never reached the model: restart it.
      pi.sendUserMessage?.(WARMUP_PROMPT)
    }
  })

  pi.on('turn_end', async (_event, ctx) => {
    if (!isSubagentSession(ctx?.sessionManager)) return
    if (readMode(ctx?.sessionManager) !== 'pro') return
    if (readWarmupPending(ctx?.sessionManager) === undefined) return
    // Subagent prompt() resolves into driveSessionToYield's reminder ladder
    // very quickly after the turn ends. Queue the handoff follow-up at
    // turn_end so it is drained before the harness can inject a "no yield"
    // reminder turn.
    await finishWarmup(ctx, 'followUp')
  })

  pi.on('agent_end', async (_event, ctx) => {
    if (readMode(ctx?.sessionManager) !== 'pro') return
    if (readWarmupPending(ctx?.sessionManager) === undefined) return
    // Try to send the handoff as a normal user turn (same as a /tree replay).
    // The lock/state in finishWarmup prevents agent_settled from duplicating it.
    await finishWarmup(ctx)
  })

  pi.on('agent_settled', async (_event, ctx) => {
    if (readMode(ctx?.sessionManager) !== 'pro') return
    if (readWarmupPending(ctx?.sessionManager) === undefined) return
    // Compatibility fallback for runtimes that emit agent_settled; pending
    // state guarantees only one of the two handlers performs the handoff.
    await finishWarmup(ctx)
  })

  pi.on('before_agent_start', (_event, ctx) => {
    const mode = resolveMode(ctx)
    if (mode === 'off') return
    if (isSubagentSession(ctx?.sessionManager)) {
      // Subagent warmup is handled entirely in before_provider_request: the
      // warmup request payload gets the one-line system prompt, while the
      // agent's stored system prompt stays the full subagent contract. That
      // way the follow-up real-task turn inherits the native prompt again.
      return
    }
    return { systemPrompt: MINIMAL_SYSTEM }
  })

  pi.on('before_provider_request', async (event, ctx) => {
    const mode = resolveMode(ctx)
    if (mode === 'off') return
    const subagent = isSubagentSession(ctx?.sessionManager)
    if (mode === 'pro') {
      const state = readProState(ctx?.sessionManager)
      if (state.phase === 'bootstrap') {
        const bootstrapTools = subagent ? subagentBootstrapTools(ctx?.sessionManager) : PRO_BOOTSTRAP_TOOLS
        await ensureProBootstrap(ctx, bootstrapTools)
        if (subagent) {
          const pending = readWarmupPending(ctx?.sessionManager)
          applySystemPrompt(event)
          if (pending !== undefined) replaceSubagentTaskWithWarmup(event, pending)
          applyPromotedTools(event, new Set(bootstrapTools.map(normalizeToolName)))
          forceNoToolChoice(event)
          return
        }
        applyMode(event, mode, 'bootstrap')
        return
      }
      const granted = Array.isArray(state.grantedTools) ? state.grantedTools : []
      const resident = subagent ? subagentResidentTools(ctx?.sessionManager) : PRO_RESIDENT_TOOLS
      const allowed = new Set([...resident, ...granted].map(normalizeToolName))
      await pi.setActiveTools?.([...resident, ...granted])
      if (subagent) {
        // Keep the same wire-level system prompt as the main agent on the
        // real task turn. The full native subagent contract stays stored in
        // session_init/history, but sending it re-opens first-person CoT;
        // the minimized system prompt is the validated "we need" anchor.
        const originalTask = readSubagentInit(ctx?.sessionManager)?.task
        if (originalTask !== undefined) rewriteOriginalSubagentTaskAsWarmup(event, originalTask)
        applySystemPrompt(event)
        applyPromotedTools(event, allowed)
        applyTools(event, 'minimal', 'promoted')
        return
      }
      applyMode(event, mode, 'promoted')
      applyPromotedTools(event, allowed)
      return
    }
    applyMode(event, mode, 'promoted')
  })
}
