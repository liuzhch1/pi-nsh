import {
  Clipboard,
  cleanup,
  computed,
  effect,
  keymap,
  List,
  mount,
  openUrl,
  Scroll,
  signal,
  type Signal,
  Storage,
  Text,
  type InputRef,
  View,
  type ViewRef,
} from "nsh";
import { ContextMenu, Input, MenuItem, MenuSeparator, Popover, TextView } from "nsh/base";
import { Window } from "nsh/desktop";
import fs from "fs/promises";
import os from "os";
import path from "path";
import process from "process";
import { Icon } from "./icons";
import {
  clampThinkingLevel,
  cleanSessionTitle,
  discoverProjects,
  loadCatalog,
  loadSessionHistory,
  normalizeThinkingLevel,
  normalizeThinkingLevels,
  supportedThinkingLevels,
  type ContentBlock,
  type ModelInfo,
  type PiEvent,
  PiClient,
  type PiMessage,
  projectFromPath,
  type ProjectInfo,
  scanAllProjects,
  scanProjectSessions,
  seedSessionCache,
  type SessionInfo,
  type ThinkingLevel,
} from "./pi";
import { colors, content as contentMetrics, Press, roundButtonStyle, sidebar as sidebarMetrics, Spinner } from "./ui";

const PROJECTS_KEY = "pi-nsh.projects.v2";
const SESSIONS_KEY = "pi-nsh.sessions.v1";
const EXPANDED_PROJECTS_KEY = "pi-nsh.expanded-projects.v1";
const VISIBLE_SESSIONS = 5;

type ToolRun = {
  args?: Record<string, unknown>;
  running: boolean;
  result?: string;
  isError?: boolean;
  durationMs?: number;
};

type ChatState = {
  messages: PiMessage[];
  toolRuns: Record<string, ToolRun>;
  collapsed: Set<string>;
  expandedBlocks: Set<string>;
  running: boolean;
  loading: boolean;
  status: string | null;
  error: string | null;
  liveId: string | null;
  visibleCount: number;
};

type MessageEdit = {
  chatId: string;
  messageId: string;
  draft: string;
  saving: boolean;
};

type ChatSession = {
  id: string;
  path: string | null;
  projectPath: string | null;
  version: Signal<number>;
  state: ChatState;
  client: PiClient | null;
  clientReady: Promise<PiClient> | null;
  generation: number;
  loadToken: number;
  lastUsed: number;
  loaded: boolean;
  loadedAt: number;
  mtimeMs: number;
  size: number;
  pendingUserId: string | null;
  liveAssistantId: string | null;
  openMessageId: string | null;
  modelKey: string | null;
  modelChosen: boolean;
  thinkingLevel: ThinkingLevel | null;
  thinkingLevels: ThinkingLevel[];
  thinkingChosen: boolean;
};

const PAGE_SIZE = 50;
const MAX_CHATS = 8;
const MAX_LIVE_CLIENTS = 3;
const CHAT_CACHE_TTL_MS = 10 * 60_000;
const CLIENT_IDLE_MS = 10 * 60_000;

function createChatSession(id: string, projectPath: string | null, path: string | null): ChatSession {
  return {
    id,
    path,
    projectPath,
    version: signal(0),
    state: {
      messages: [],
      toolRuns: {},
      collapsed: new Set(),
      expandedBlocks: new Set(),
      running: false,
      loading: false,
      status: null,
      error: null,
      liveId: null,
      visibleCount: PAGE_SIZE,
    },
    client: null,
    clientReady: null,
    generation: 0,
    loadToken: 0,
    lastUsed: 0,
    loaded: false,
    loadedAt: 0,
    mtimeMs: 0,
    size: 0,
    pendingUserId: null,
    liveAssistantId: null,
    openMessageId: null,
    modelKey: null,
    modelChosen: false,
    thinkingLevel: null,
    thinkingLevels: [],
    thinkingChosen: false,
  };
}

let messageSequence = 0;

function newMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++messageSequence}`;
}

function modelKeyOf(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function modelMatchesKey(model: ModelInfo, key: string | null): boolean {
  if (!key) return false;
  if (modelKeyOf(model) === key) return true;
  // A resumed session can name an older provider alias for a catalog model.
  return model.id === key.slice(key.indexOf("/") + 1);
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is ContentBlock => Boolean(block) && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n\n");
}

function contentBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object");
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return [];
}

function isThinkingBlock(block: ContentBlock): block is ContentBlock & { thinking: string } {
  return block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0;
}

function hasWork(message: PiMessage): boolean {
  return message.role === "assistant" && contentBlocks(message.content).some((block) => block.type === "toolCall" || isThinkingBlock(block));
}

function assistantText(message: PiMessage): string {
  return contentBlocks(message.content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n\n");
}

type UserDisplay = { id: string; kind: "user"; message: PiMessage };
type TurnDisplay = { id: string; kind: "turn"; key: string; messages: PiMessage[] };
type NoteDisplay = { id: string; kind: "note"; message: PiMessage };
type DisplayItem = UserDisplay | TurnDisplay | NoteDisplay;
type WorkBlock =
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; call: ContentBlock };

function buildTimeline(messages: PiMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let turn: PiMessage[] = [];
  let turnKey = "";

  const flushTurn = () => {
    if (!turn.length) return;
    items.push({ id: `turn-${turnKey}`, kind: "turn", key: turnKey, messages: turn });
    turn = [];
    turnKey = "";
  };

  for (const message of messages) {
    if (message.role === "toolResult" || message.role === "system") continue;
    if (message.role === "custom" && message.display === false) continue;
    if (message.role === "user") {
      flushTurn();
      items.push({ id: message.id, kind: "user", message });
      continue;
    }
    if (message.role === "assistant") {
      if (!turn.length) turnKey = message.id;
      turn.push(message);
      continue;
    }
    flushTurn();
    items.push({ id: `note-${message.id}`, kind: "note", message });
  }
  flushTurn();
  return items;
}

function workBlocksOf(turnKey: string, messages: PiMessage[]): WorkBlock[] {
  const blocks: WorkBlock[] = [];
  for (const message of messages) {
    contentBlocks(message.content).forEach((block, index) => {
      if (isThinkingBlock(block)) {
        blocks.push({ kind: "thinking", key: `${turnKey}:thinking:${message.id}:${index}`, text: block.thinking });
      } else if (block.type === "toolCall") {
        blocks.push({ kind: "tool", key: `${turnKey}:tool:${String(block.id ?? `${message.id}:${index}`)}`, call: block });
      }
    });
  }
  return blocks;
}

function collapsedTurnsOf(messages: PiMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const item of buildTimeline(messages)) {
    if (item.kind === "turn" && item.messages.some((message) => hasWork(message))) keys.add(item.key);
  }
  return keys;
}

function oneLine(value: string, limit = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function messageTime(timestamp: number | undefined): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const dayNumber = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  const todayNumber = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000;
  const daysAgo = todayNumber - dayNumber;
  if (daysAgo <= 0) return time;
  if (daysAgo < 7) {
    const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
    return `${weekday} ${time}`;
  }
  const day = date.toLocaleDateString("en-US", {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
  });
  return `${day}, ${time}`;
}

function clipText(value: string, limit = 900): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function summarizeArguments(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["command", "path", "file_path", "pattern", "query", "url", "description", "prompt", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, 110);
  }
  const parts = Object.entries(args)
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return oneLine(parts.join(" · "), 110);
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function errorText(reason: unknown): string {
  const value = reason as { message?: string; code?: string; stderr?: string };
  if (value?.code === "ERR_ACCESS_DENIED") return "Pi needs permission for that folder. Projects must be inside your home folder.";
  return value?.message || value?.stderr || String(reason);
}

function withSetValue(set: Set<string>, value: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}

function applyAssistantDelta(blocks: ContentBlock[], event: Record<string, unknown>): ContentBlock[] {
  const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
  const next = blocks.slice();
  const current = next[index] ?? { type: "text", text: "" };
  const type = String(event.type ?? "");
  if (type === "text_start") next[index] = { type: "text", text: "" };
  else if (type === "text_delta") next[index] = { ...current, type: "text", text: `${current.text ?? ""}${String(event.delta ?? "")}` };
  else if (type === "text_end") next[index] = { ...current, type: "text", text: String(event.content ?? "") };
  else if (type === "thinking_start") next[index] = { type: "thinking", thinking: "" };
  else if (type === "thinking_delta") next[index] = { ...current, type: "thinking", thinking: `${current.thinking ?? ""}${String(event.delta ?? "")}` };
  else if (type === "thinking_end") next[index] = { ...current, type: "thinking", thinking: String(event.content ?? "") };
  else if (type === "toolcall_start") {
    next[index] = {
      type: "toolCall",
      id: String(event.id ?? ""),
      name: String(event.toolName ?? "tool"),
      arguments: {},
    };
  } else if (type === "toolcall_end" && event.toolCall && typeof event.toolCall === "object") {
    next[index] = event.toolCall as ContentBlock;
  }
  return next;
}

function App() {
  const projects = signal<ProjectInfo[]>([]);
  const sessions = signal<Record<string, SessionInfo[]>>({});
  const sidebarOpen = signal(true);
  const expandedProjects = signal<Set<string>>(new Set());
  const showAllSessions = signal<Set<string>>(new Set());
  const activeProject = signal<string | null>(null);
  const activeSession = signal<string | null>(null);
  const draftChatId = signal<string | null>(null);
  const booted = signal(false);
  const draft = signal("");
  const inputHeight = signal(22);
  const models = signal<ModelInfo[]>([]);
  const modelKey = signal<string | null>(null);
  const modelChosen = signal(false);
  const modelOpen = signal(false);
  const thinkingLevel = signal<ThinkingLevel | null>(null);
  const thinkingLevels = signal<ThinkingLevel[]>([]);
  const thinkingChosen = signal(false);
  const thinkingOpen = signal(false);
  const messageEdit = signal<MessageEdit | null>(null);
  const editHeight = signal(48);
  const copiedMessageId = signal<string | null>(null);
  const addOpen = signal(false);
  const addPath = signal("");
  const addError = signal<string | null>(null);
  const picking = signal(false);
  const piIssue = signal<string | null>(null);
  const appError = signal<string | null>(null);
  const chatActivity = signal(0);

  let composerInput: InputRef | undefined;
  let addCardRef: ViewRef | undefined;
  let catalogLoading: Promise<void> | null = null;
  let expandedProjectsWrite = Promise.resolve();
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  let draftSequence = 0;
  const chats = new Map<string, ChatSession>();
  const blankChat = createChatSession("", null, null);

  const activeChat = (): ChatSession => {
    const id = activeSession() ?? draftChatId();
    if (!id) return blankChat;
    return chats.get(id) ?? blankChat;
  };

  const chatView = () => {
    const chat = activeChat();
    chat.version();
    return chat.state;
  };

  const setChatState = (chat: ChatSession, patch: Partial<ChatState>) => {
    if (chat === blankChat) return;
    Object.assign(chat.state, patch);
    chat.version.update((value) => value + 1);
    if (patch.running !== undefined || patch.error !== undefined) chatActivity.update((value) => value + 1);
  };

  const messages = computed(() => chatView().messages);
  const toolRuns = computed(() => chatView().toolRuns);
  const collapsed = computed(() => chatView().collapsed);
  const expandedBlocks = computed(() => chatView().expandedBlocks);
  const running = computed(() => chatView().running);
  const loading = computed(() => chatView().loading);
  const status = computed(() => chatView().status);
  const error = computed(() => chatView().error ?? appError());
  const liveId = computed(() => chatView().liveId);
  const chatOpen = computed(() => Boolean(activeSession()) || chatView().messages.length > 0);

  const currentModel = computed(() => {
    const key = modelKey();
    if (!key) return models()[0] ?? null;
    return models().find((model) => modelMatchesKey(model, key)) ?? null;
  });

  const modelGroups = computed(() => {
    const groups: { provider: string; models: ModelInfo[] }[] = [];
    for (const model of models()) {
      let group = groups.find((item) => item.provider === model.provider);
      if (!group) {
        group = { provider: model.provider, models: [] };
        groups.push(group);
      }
      group.models.push(model);
    }
    return groups;
  });

  const modelMenuHeight = computed(() =>
    Math.min(380, Math.max(56, modelGroups().reduce((total, group) => total + 24 + group.models.length * 28, 8))),
  );

  const thinkingOptions = computed(() => {
    const model = currentModel();
    const available = model ? supportedThinkingLevels(model) : thinkingLevels();
    const current = thinkingLevel();
    return current && !available.includes(current) ? [current, ...available.filter((level) => level !== current)] : available;
  });

  const thinkingMenuHeight = computed(() => Math.min(240, Math.max(56, thinkingOptions().length * 28 + 32)));

  const toolResults = computed(() => {
    const results: Record<string, { text: string; isError: boolean }> = {};
    for (const message of messages()) {
      if (message.role !== "toolResult") continue;
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      if (id) results[id] = { text: textOfContent(message.content), isError: message.isError === true };
    }
    return results;
  });

  const displayItems = computed(() => buildTimeline(messages()));

  const lastTurnId = computed(() => {
    const items = displayItems();
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index].kind === "turn") return items[index].id;
    }
    return null;
  });

  const visibleItems = computed(() => {
    const items = displayItems();
    const count = chatView().visibleCount;
    return count >= items.length ? items : items.slice(items.length - count);
  });

  const hasEarlier = computed(() => displayItems().length > chatView().visibleCount);

  const activeProjectInfo = computed(() => projects().find((project) => project.path === activeProject()) ?? null);
  const activeSessionInfo = computed(() => {
    const project = activeProject();
    const session = activeSession();
    if (!project || !session) return null;
    return (sessions()[project] ?? []).find((item) => item.path === session) ?? null;
  });

  const persistProjects = async (list = projects()) => {
    try {
      await Storage.setItem(PROJECTS_KEY, JSON.stringify(list));
    } catch (reason) {
      appError.set(`Could not save projects: ${errorText(reason)}`);
    }
  };

  const persistExpandedProjects = (list = expandedProjects()) => {
    const value = JSON.stringify([...list]);
    expandedProjectsWrite = expandedProjectsWrite
      .catch(() => {})
      .then(() => Storage.setItem(EXPANDED_PROJECTS_KEY, value))
      .catch(() => {
        // Folding still works for this session if the preference cannot be saved.
      });
  };

  const setProjectExpanded = (projectPath: string, open: boolean) => {
    const current = expandedProjects();
    if (current.has(projectPath) === open) return;
    const next = withSetValue(current, projectPath, open);
    expandedProjects.set(next);
    void persistExpandedProjects(next);
  };

  const applyModel = (model: ModelInfo | null | undefined, chat: ChatSession | null = null) => {
    if (!model?.provider || !model.id) return;
    const key = modelKeyOf(model);
    models.update((list) => (list.some((item) => modelKeyOf(item) === key) ? list : [...list, model]));
    if (chat) chat.modelKey = key;
    if (!chat || chat === activeChat()) modelKey.set(key);
  };

  const applyThinking = (
    chat: ChatSession,
    level: ThinkingLevel | null | undefined,
    levels?: ThinkingLevel[],
    model: ModelInfo | null = null,
  ) => {
    if (level !== undefined) chat.thinkingLevel = level;
    if (levels !== undefined) chat.thinkingLevels = levels.length ? levels : supportedThinkingLevels(model);
    if (chat !== activeChat()) return;
    thinkingLevel.set(chat.thinkingLevel);
    thinkingLevels.set(chat.thinkingLevels);
  };

  const readThinkingLevels = async (client: PiClient, model: ModelInfo | null): Promise<ThinkingLevel[]> => {
    try {
      const available = await client.request<{ levels?: string[] }>("get_available_thinking_levels");
      const levels = normalizeThinkingLevels(available?.levels);
      return levels.length ? levels : supportedThinkingLevels(model);
    } catch {
      return supportedThinkingLevels(model);
    }
  };

  const syncThinking = async (client: PiClient, chat: ChatSession) => {
    const state = await client.request<{ model?: ModelInfo; thinkingLevel?: string }>("get_state");
    applyModel(state?.model, chat);
    const model = state?.model ?? models().find((item) => modelMatchesKey(item, chat.modelKey)) ?? null;
    const levels = await readThinkingLevels(client, model);
    applyThinking(chat, normalizeThinkingLevel(state?.thinkingLevel), levels, model);
  };

  const collapseAllWork = (chat = activeChat()) => {
    if (chat === blankChat) return;
    const keys = buildTimeline(chat.state.messages)
      .filter((item): item is TurnDisplay => item.kind === "turn" && item.messages.some((message) => hasWork(message)))
      .map((item) => item.key);
    if (!keys.length) return;
    const next = new Set(chat.state.collapsed);
    for (const key of keys) next.add(key);
    setChatState(chat, { collapsed: next, expandedBlocks: new Set() });
  };

  const showEarlier = () => {
    const chat = activeChat();
    if (chat === blankChat) return;
    setChatState(chat, { visibleCount: chat.state.visibleCount + PAGE_SIZE });
  };

  const refreshProject = async (projectPath: string) => {
    try {
      const list = await scanProjectSessions(projectPath);
      sessions.update((current) => ({ ...current, [projectPath]: list }));
    } catch {
      // Keep what is already shown.
    }
  };

  // pi appends the finished turn before `agent_settled`, so the sidebar can move
  // the chat up without reading its session file again.
  const bumpSession = (chat: ChatSession) => {
    const projectPath = chat.projectPath;
    const sessionPath = chat.path;
    if (!projectPath || !sessionPath) return;
    const list = sessions()[projectPath] ?? [];
    const existing = list.find((item) => item.path === sessionPath);
    // A new chat gets its title from the first user message, which pi writes
    // after the first prompt; rescan just that once.
    if (!existing || existing.title === "New chat") {
      void refreshProject(projectPath);
      return;
    }
    sessions.update((current) => ({
      ...current,
      [projectPath]: [{ ...existing, modified: Date.now() }, ...list.filter((item) => item.path !== sessionPath)],
    }));
  };

  const trimChatStates = () => {
    const loaded = [...chats.values()].filter((chat) => chat.state.messages.length > 0);
    if (loaded.length <= MAX_CHATS) return;
    const active = activeChat();
    loaded.sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = loaded.length - MAX_CHATS;
    for (const chat of loaded) {
      if (excess <= 0) break;
      if (chat === active || chat.state.running || chat.client || chat.clientReady) continue;
      chat.loaded = false;
      setChatState(chat, {
        messages: [],
        toolRuns: {},
        collapsed: new Set(),
        expandedBlocks: new Set(),
        visibleCount: PAGE_SIZE,
        error: null,
        status: null,
        liveId: null,
      });
      excess--;
    }
  };

  const loadHistoryFromPi = async (chat: ChatSession, token?: number) => {
    if (!chat.projectPath) return;
    try {
      const started = chat.client ?? (await ensureClient(chat));
      const [state, data] = await Promise.all([
        started.request<{ model?: ModelInfo; thinkingLevel?: string }>("get_state"),
        started.request<{ messages?: PiMessage[] }>("get_messages"),
      ]);
      if (token !== undefined && token !== chat.loadToken) return;
      applyModel(state?.model, chat);
      const model = state?.model ?? models().find((item) => modelMatchesKey(item, chat.modelKey)) ?? null;
      const levels = await readThinkingLevels(started, model);
      applyThinking(chat, normalizeThinkingLevel(state?.thinkingLevel), levels, model);
      const history = (data?.messages ?? []).map((message, index) => ({ ...message, id: `history-${index}-${message.timestamp ?? 0}` }));
      setChatState(chat, {
        messages: history,
        collapsed: collapsedTurnsOf(history),
        toolRuns: {},
        expandedBlocks: new Set(),
        loading: false,
      });
      chat.loaded = true;
      chat.loadedAt = Date.now();
    } catch (reason) {
      if (token !== undefined && token !== chat.loadToken) return;
      setChatState(chat, { error: errorText(reason), loading: false });
    }
  };

  const loadChat = async (chat: ChatSession, options: { background?: boolean } = {}) => {
    if (!chat.path || chat.client || chat.clientReady) return;
    const token = ++chat.loadToken;
    if (!options.background || chat.state.messages.length === 0) setChatState(chat, { loading: true });
    try {
      const history = await loadSessionHistory(chat.path);
      if (token !== chat.loadToken) return;
      const firstLoad = !chat.loaded;
      setChatState(chat, {
        messages: history.messages,
        toolRuns: {},
        collapsed: collapsedTurnsOf(history.messages),
        expandedBlocks: new Set(),
        loading: false,
        ...(firstLoad ? { visibleCount: PAGE_SIZE } : {}),
      });
      chat.loaded = true;
      chat.loadedAt = Date.now();
      chat.mtimeMs = history.mtimeMs;
      chat.size = history.size;
      if (!chat.modelKey && history.model) {
        const key = `${history.model.provider}/${history.model.id}`;
        chat.modelKey = key;
        if (chat === activeChat()) modelKey.set(key);
      }
      if (!chat.thinkingLevel && history.thinkingLevel) {
        chat.thinkingLevel = history.thinkingLevel;
        if (chat === activeChat()) thinkingLevel.set(history.thinkingLevel);
      }
      if (!chat.thinkingLevels.length) {
        const model = models().find((item) => modelMatchesKey(item, chat.modelKey)) ?? null;
        chat.thinkingLevels = supportedThinkingLevels(model);
        if (chat === activeChat()) thinkingLevels.set(chat.thinkingLevels);
      }
      trimChatStates();
    } catch {
      if (token !== chat.loadToken) return;
      await loadHistoryFromPi(chat, token);
    }
  };

  const revalidateChat = async (chat: ChatSession) => {
    if (!chat.path || chat.client || chat.clientReady) return;
    try {
      const stats = await fs.stat(chat.path);
      const expired = Date.now() - chat.loadedAt > CHAT_CACHE_TTL_MS;
      if (expired || stats.mtimeMs !== chat.mtimeMs || stats.size !== chat.size) await loadChat(chat, { background: true });
    } catch {
      // Keep the cached transcript until the file can be read again.
    }
  };

  const ensureChat = (id: string, projectPath: string | null, path: string | null): ChatSession => {
    let chat = chats.get(id);
    if (!chat) {
      chat = createChatSession(id, projectPath, path);
      chats.set(id, chat);
    } else {
      if (projectPath) chat.projectPath = projectPath;
      if (path) chat.path = path;
    }
    return chat;
  };

  const handleEvent = (event: PiEvent, chat: ChatSession, generation: number) => {
    if (generation !== chat.generation) return;
    chat.lastUsed = Date.now();
    const set = (patch: Partial<ChatState>) => setChatState(chat, patch);
    const updateMessages = (fn: (list: PiMessage[]) => PiMessage[]) => set({ messages: fn(chat.state.messages) });

    switch (event.type) {
      case "agent_start":
      case "turn_start": {
        set({ running: true, status: null });
        break;
      }
      case "message_start": {
        const raw = event.message as PiMessage | undefined;
        if (!raw) break;
        if (raw.role === "user" && chat.pendingUserId) {
          const id = chat.pendingUserId;
          chat.openMessageId = id;
          updateMessages((list) => list.map((message) => (message.id === id ? { ...raw, id } : message)));
          chat.pendingUserId = null;
        } else {
          const id = newMessageId(raw.role === "assistant" ? "assistant" : raw.role);
          chat.openMessageId = id;
          if (raw.role === "assistant") {
            chat.liveAssistantId = id;
            set({ liveId: id });
          }
          updateMessages((list) => [...list, { ...raw, id }]);
        }
        break;
      }
      case "message_update": {
        if (!chat.liveAssistantId) break;
        const update = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
        const id = chat.liveAssistantId;
        updateMessages((list) =>
          list.map((message) => (message.id === id ? { ...message, content: applyAssistantDelta(contentBlocks(message.content), update) } : message)),
        );
        break;
      }
      case "message_end": {
        const raw = event.message as PiMessage | undefined;
        if (!raw) break;
        const id = chat.openMessageId ?? newMessageId(raw.role);
        let found = false;
        updateMessages((list) =>
          list.map((message) => {
            if (message.id !== id) return message;
            found = true;
            return { ...raw, id };
          }),
        );
        if (!found) updateMessages((list) => [...list, { ...raw, id }]);
        if (raw.role === "assistant") {
          chat.liveAssistantId = null;
          set({ liveId: null });
        }
        chat.openMessageId = null;
        break;
      }
      case "model_changed": {
        applyModel(event.model as ModelInfo | undefined, chat);
        if (chat.client) {
          void syncThinking(chat.client, chat).catch((reason) => {
            setChatState(chat, { error: errorText(reason) });
          });
        }
        break;
      }
      case "thinking_level_changed": {
        const level = normalizeThinkingLevel(event.level);
        if (!level) break;
        chat.thinkingLevel = level;
        if (chat === activeChat()) thinkingLevel.set(level);
        break;
      }
      case "tool_execution_start": {
        const id = String(event.toolCallId ?? "");
        if (!id) break;
        const runs = chat.state.toolRuns;
        set({
          toolRuns: {
            ...runs,
            [id]: { ...runs[id], args: (event.args as Record<string, unknown> | undefined) ?? runs[id]?.args, running: true },
          },
        });
        break;
      }
      case "tool_execution_update": {
        const id = String(event.toolCallId ?? "");
        if (!id) break;
        const partial = event.partialResult as { content?: unknown } | undefined;
        const runs = chat.state.toolRuns;
        set({ toolRuns: { ...runs, [id]: { ...runs[id], running: true, result: textOfContent(partial?.content) } } });
        break;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        if (!id) break;
        const result = event.result as { content?: unknown } | undefined;
        const runs = chat.state.toolRuns;
        set({
          toolRuns: {
            ...runs,
            [id]: {
              ...runs[id],
              running: false,
              result: textOfContent(result?.content),
              isError: event.isError === true,
              durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
            },
          },
        });
        break;
      }
      case "agent_settled": {
        chat.liveAssistantId = null;
        set({ running: false, liveId: null, status: null });
        collapseAllWork(chat);
        bumpSession(chat);
        trimChatStates();
        if (chat.path) {
          void fs.stat(chat.path).then(
            (stats) => {
              chat.mtimeMs = stats.mtimeMs;
              chat.size = stats.size;
              chat.loadedAt = Date.now();
            },
            () => {},
          );
        }
        break;
      }
      case "auto_retry_start": {
        set({ status: `Retrying · attempt ${String(event.attempt ?? "?")}${event.maxAttempts ? ` of ${String(event.maxAttempts)}` : ""}` });
        break;
      }
      case "auto_retry_end": {
        set({ status: event.success === false ? `Retry failed: ${String(event.finalError ?? "unknown error")}` : null });
        break;
      }
      case "compaction_start": {
        set({ status: "Compacting context…" });
        break;
      }
      case "compaction_end": {
        set({ status: event.errorMessage ? `Compaction failed: ${String(event.errorMessage)}` : null });
        break;
      }
      case "session_info_changed": {
        const projectPath = chat.projectPath;
        const sessionPath = chat.path;
        const name = typeof event.name === "string" ? event.name.trim() : "";
        if (!projectPath || !sessionPath) break;
        if (!name) {
          void refreshProject(projectPath);
          break;
        }
        const title = cleanSessionTitle(name);
        sessions.update((current) => ({
          ...current,
          [projectPath]: (current[projectPath] ?? []).map((item) => (item.path === sessionPath ? { ...item, title } : item)),
        }));
        break;
      }
      default:
        break;
    }
  };

  const closeChatClient = (chat: ChatSession) => {
    chat.generation++;
    chat.clientReady = null;
    if (chat.client) {
      chat.client.close();
      chat.client = null;
    }
  };

  const liveClientCount = () => {
    let count = 0;
    for (const chat of chats.values()) if (chat.client) count++;
    return count;
  };

  const evictClients = () => {
    const now = Date.now();
    const active = activeChat();
    for (const chat of chats.values()) {
      if (!chat.client || chat === active || chat.state.running) continue;
      if (now - chat.lastUsed > CLIENT_IDLE_MS) closeChatClient(chat);
    }
    let count = liveClientCount();
    if (count > MAX_LIVE_CLIENTS) {
      const candidates = [...chats.values()]
        .filter((chat) => chat.client && chat !== active && !chat.state.running)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      for (const chat of candidates) {
        if (count <= MAX_LIVE_CLIENTS) break;
        closeChatClient(chat);
        count--;
      }
    }
    trimChatStates();
  };

  const startClient = async (chat: ChatSession): Promise<PiClient> => {
    if (!chat.projectPath) throw new Error("Choose a project first.");
    const generation = ++chat.generation;
    const stderr: string[] = [];
    const next = new PiClient({
      projectPath: chat.projectPath,
      sessionPath: chat.path,
      onEvent: (event) => {
        chat.lastUsed = Date.now();
        handleEvent(event, chat, generation);
      },
      onStderr: (line) => {
        if (!line.trim()) return;
        stderr.push(line.trim());
        if (stderr.length > 20) stderr.shift();
      },
      onExit: (code, detail) => {
        if (generation !== chat.generation) return;
        chat.client = null;
        chat.liveAssistantId = null;
        const output = detail || stderr.join("\n");
        const status = code === null || code === undefined ? "pi stopped unexpectedly" : `pi exited with code ${code}`;
        setChatState(chat, { running: false, loading: false, liveId: null, error: output ? `${status}\n${output}` : status });
      },
    });
    await next.start();
    if (generation !== chat.generation) {
      next.close();
      throw new Error("pi was closed");
    }
    chat.client = next;
    chat.lastUsed = Date.now();
    evictClients();
    return next;
  };

  const ensureClient = (chat: ChatSession): Promise<PiClient> => {
    if (chat.client) return Promise.resolve(chat.client);
    if (!chat.clientReady) {
      const pending = startClient(chat);
      chat.clientReady = pending;
      void pending.then(
        () => {
          if (chat.clientReady === pending) chat.clientReady = null;
        },
        () => {
          if (chat.clientReady === pending) chat.clientReady = null;
        },
      );
    }
    return chat.clientReady;
  };

  const activateChat = (chat: ChatSession) => {
    chat.lastUsed = Date.now();
    messageEdit.set(null);
    editHeight.set(48);
    modelKey.set(chat.modelKey);
    modelChosen.set(chat.modelChosen);
    const model = models().find((item) => modelMatchesKey(item, chat.modelKey)) ?? null;
    if (!chat.thinkingLevels.length) chat.thinkingLevels = supportedThinkingLevels(model);
    thinkingLevel.set(chat.thinkingLevel);
    thinkingLevels.set(chat.thinkingLevels);
    thinkingChosen.set(chat.thinkingChosen);
    if (!chat.loaded) void loadChat(chat);
    else if (!chat.client) void revalidateChat(chat);
    evictClients();
  };

  const rememberActiveModel = () => {
    const chat = activeChat();
    if (chat === blankChat) return;
    chat.modelKey = modelKey();
    chat.modelChosen = modelChosen();
    chat.thinkingLevel = thinkingLevel();
    chat.thinkingLevels = thinkingLevels();
    chat.thinkingChosen = thinkingChosen();
  };

  const adoptSessionPath = (chat: ChatSession, sessionPath: string) => {
    if (chat.path === sessionPath) return;
    const wasActive = activeChat() === chat;
    if (chats.get(chat.id) === chat) chats.delete(chat.id);
    chat.id = sessionPath;
    chat.path = sessionPath;
    chats.set(sessionPath, chat);
    if (wasActive) {
      activeSession.set(sessionPath);
      draftChatId.set(null);
    }
    if (chat.projectPath) void refreshProject(chat.projectPath);
  };

  const refreshMany = async (list: ProjectInfo[]) => {
    const next = await scanAllProjects(list);
    sessions.set(next);
    try {
      await Storage.setItem(SESSIONS_KEY, JSON.stringify(next));
    } catch {
      // The sidebar still works without the cache.
    }
  };

  const openExistingSession = (projectPath: string, sessionPath: string) => {
    if (activeProject() === projectPath && activeSession() === sessionPath) return;
    rememberActiveModel();
    const previous = activeChat();
    if (
      previous !== blankChat &&
      !previous.path &&
      !previous.client &&
      !previous.clientReady &&
      previous.state.messages.length === 0 &&
      chats.get(previous.id) === previous
    ) {
      chats.delete(previous.id);
    }
    const chat = ensureChat(sessionPath, projectPath, sessionPath);
    activeProject.set(projectPath);
    activeSession.set(sessionPath);
    draftChatId.set(null);
    setProjectExpanded(projectPath, true);
    activateChat(chat);
  };

  const newChat = (projectPath?: string | null) => {
    rememberActiveModel();
    messageEdit.set(null);
    editHeight.set(48);
    const previous = activeChat();
    if (
      previous !== blankChat &&
      !previous.path &&
      !previous.client &&
      !previous.clientReady &&
      previous.state.messages.length === 0 &&
      chats.get(previous.id) === previous
    ) {
      chats.delete(previous.id);
    }
    const id = `draft:${++draftSequence}`;
    const chat = createChatSession(id, projectPath ?? activeProject(), null);
    chat.modelKey = modelKey();
    chat.modelChosen = modelChosen();
    chat.thinkingLevel = thinkingLevel();
    chat.thinkingLevels = thinkingLevels();
    chat.thinkingChosen = thinkingChosen();
    chats.set(id, chat);
    draftChatId.set(id);
    if (projectPath) {
      activeProject.set(projectPath);
      setProjectExpanded(projectPath, true);
    }
    activeSession.set(null);
    modelOpen.set(false);
    thinkingOpen.set(false);
    evictClients();
  };

  const send = async () => {
    const text = draft().trim();
    if (!text) return;
    if (activeChat() === blankChat) newChat();
    const chat = activeChat();
    if (chat.state.running) return;
    modelOpen.set(false);
    thinkingOpen.set(false);
    const projectPath = chat.projectPath ?? activeProject();
    if (!projectPath) {
      addOpen.set(true);
      return;
    }
    chat.projectPath = projectPath;

    const requestedModel = modelChosen() ? currentModel() : null;
    const wasExisting = Boolean(chat.path);
    const localId = newMessageId("local");
    const optimistic: PiMessage = { id: localId, role: "user", content: text, timestamp: Date.now() };
    chat.pendingUserId = localId;
    appError.set(null);
    setChatState(chat, { messages: [...chat.state.messages, optimistic], running: true, error: null, status: null });
    draft.set("");
    inputHeight.set(22);
    try {
      let started = chat.client;
      if (!started) {
        setChatState(chat, { loading: true });
        started = await ensureClient(chat);
        const state = await started.request<{
          sessionFile?: string;
          messageCount?: number;
          model?: ModelInfo;
          thinkingLevel?: string;
        }>("get_state");
        if (state?.sessionFile && !chat.path) adoptSessionPath(chat, state.sessionFile);
        if (wasExisting && chat.path && typeof state?.messageCount === "number") {
          const historyCount = chat.state.messages.length - 1;
          if (state.messageCount !== historyCount) {
            console.warn(`[pi-nsh] projected ${historyCount} messages, pi has ${state.messageCount}; reloading history`);
            const data = await started.request<{ messages?: PiMessage[] }>("get_messages");
            const history = (data?.messages ?? []).map((message, index) => ({ ...message, id: `history-${index}-${message.timestamp ?? 0}` }));
            setChatState(chat, { messages: [...history, optimistic], collapsed: collapsedTurnsOf(history) });
            chat.loaded = true;
            chat.loadedAt = Date.now();
          }
        }
        applyModel(state?.model, chat);
        const model = state?.model ?? models().find((item) => modelMatchesKey(item, chat.modelKey)) ?? null;
        const levels = await readThinkingLevels(started, model);
        applyThinking(chat, normalizeThinkingLevel(state?.thinkingLevel), levels, model);
        if (requestedModel && state?.model && modelKeyOf(requestedModel) !== modelKeyOf(state.model)) {
          await started.request("set_model", { provider: requestedModel.provider, modelId: requestedModel.id });
          await syncThinking(started, chat);
        }
        if (chat.thinkingChosen && chat.thinkingLevel) {
          await started.request("set_thinking_level", { level: chat.thinkingLevel });
          await syncThinking(started, chat);
        }
        setChatState(chat, { loading: false });
      }
      await started.request("prompt", { message: text });
    } catch (reason) {
      chat.pendingUserId = null;
      setChatState(chat, {
        error: errorText(reason),
        running: false,
        loading: false,
        messages: chat.state.messages.filter((message) => message.id !== localId),
      });
      if (chat === activeChat()) draft.set(text);
    }
  };

  const copyText = async (id: string, text: string) => {
    if (!text) return;
    try {
      await Clipboard.writeText(text);
      copiedMessageId.set(id);
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copiedMessageId.set(null);
        copiedTimer = null;
      }, 1200);
    } catch (reason) {
      appError.set(`Could not copy message: ${errorText(reason)}`);
    }
  };

  const copyMessage = (message: PiMessage) => copyText(message.id, textOfContent(message.content));

  const beginEditMessage = (chat: ChatSession, message: PiMessage) => {
    if (message.role !== "user" || chat.state.running || chat.state.loading) return;
    const text = textOfContent(message.content);
    messageEdit.set({ chatId: chat.id, messageId: message.id, draft: text, saving: false });
    editHeight.set(Math.min(180, Math.max(48, text.split("\n").length * 22 + 18)));
  };

  const updateEditDraft = (value: string) => {
    const current = messageEdit();
    if (!current) return;
    messageEdit.set({ ...current, draft: value });
  };

  const cancelEditMessage = () => {
    if (messageEdit()?.saving) return;
    messageEdit.set(null);
    editHeight.set(48);
  };

  const resolveUserEntryId = async (client: PiClient, chat: ChatSession, message: PiMessage): Promise<string | null> => {
    if (message.entryId) return message.entryId;
    const data = await client.request<{ messages?: Array<{ entryId?: string; text?: string }> }>("get_fork_messages");
    const candidates = (data?.messages ?? []).filter(
      (item): item is { entryId: string; text: string } => typeof item.entryId === "string" && typeof item.text === "string",
    );
    const users = chat.state.messages.filter((item) => item.role === "user" && textOfContent(item.content).trim());
    const targetIndex = users.findIndex((item) => item.id === message.id);
    let candidateIndex = candidates.length - 1;
    for (let index = users.length - 1; index >= 0; index--) {
      const text = textOfContent(users[index].content).trim();
      while (candidateIndex >= 0 && candidates[candidateIndex].text.trim() !== text) candidateIndex--;
      if (candidateIndex < 0) break;
      if (index === targetIndex) return candidates[candidateIndex].entryId;
      candidateIndex--;
    }
    const text = textOfContent(message.content).trim();
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (candidates[index].text.trim() === text) return candidates[index].entryId;
    }
    return null;
  };

  const saveEditedMessage = async () => {
    const edit = messageEdit();
    if (!edit || edit.saving) return;
    const chat = chats.get(edit.chatId);
    if (!chat || chat.state.running || chat.state.loading) return;
    const text = edit.draft.trim();
    if (!text) return;
    const message = chat.state.messages.find((item) => item.id === edit.messageId && item.role === "user");
    if (!message) {
      messageEdit.set(null);
      return;
    }

    messageEdit.set({ ...edit, saving: true });
    let forked = false;
    let forkedMessages: PiMessage[] | null = null;
    try {
      const client = chat.client ?? (await ensureClient(chat));
      const entryId = await resolveUserEntryId(client, chat, message);
      if (!entryId) throw new Error("Could not find that message in the pi session.");
      const result = await client.request<{ text?: string; cancelled?: boolean }>("fork", { entryId });
      if (result?.cancelled) throw new Error("Editing was cancelled.");
      forked = true;

      const state = await client.request<{ sessionFile?: string }>("get_state");
      const nextSessionFile = state?.sessionFile ?? null;
      if (nextSessionFile) {
        try {
          const loaded = await loadSessionHistory(nextSessionFile);
          forkedMessages = loaded.messages;
          chat.mtimeMs = loaded.mtimeMs;
          chat.size = loaded.size;
          chat.loadedAt = Date.now();
        } catch {
          const data = await client.request<{ messages?: PiMessage[] }>("get_messages");
          forkedMessages = (data?.messages ?? []).map((item, index) => ({ ...item, id: `history-${index}-${item.timestamp ?? 0}` }));
        }
      } else {
        const data = await client.request<{ messages?: PiMessage[] }>("get_messages");
        forkedMessages = (data?.messages ?? []).map((item, index) => ({ ...item, id: `history-${index}-${item.timestamp ?? 0}` }));
      }

      const localId = newMessageId("local");
      const optimistic: PiMessage = { id: localId, role: "user", content: text, timestamp: Date.now() };
      chat.pendingUserId = localId;
      chat.liveAssistantId = null;
      chat.openMessageId = null;
      chat.loaded = true;
      setChatState(chat, {
        messages: [...forkedMessages, optimistic],
        toolRuns: {},
        collapsed: collapsedTurnsOf(forkedMessages),
        expandedBlocks: new Set(),
        visibleCount: PAGE_SIZE,
        running: true,
        loading: false,
        liveId: null,
        error: null,
        status: null,
      });
      if (nextSessionFile) adoptSessionPath(chat, nextSessionFile);
      messageEdit.set(null);
      editHeight.set(48);
      await client.request("prompt", { message: text });
    } catch (reason) {
      chat.pendingUserId = null;
      const detail = errorText(reason);
      if (forked) {
        messageEdit.set(null);
        editHeight.set(48);
        setChatState(chat, {
          messages: forkedMessages ?? chat.state.messages,
          running: false,
          loading: false,
          error: detail,
        });
        if (chat === activeChat()) {
          draft.set(text);
          inputHeight.set(22);
        }
      } else {
        messageEdit.set({ ...edit, saving: false });
        setChatState(chat, { running: false, loading: false, error: detail });
      }
    }
  };

  const stop = async () => {
    const chat = activeChat();
    if (!chat.client || !chat.state.running) return;
    setChatState(chat, { status: "Stopping…" });
    try {
      await chat.client.request("abort");
    } catch (reason) {
      setChatState(chat, { error: errorText(reason) });
    } finally {
      if (chat.state.running) setChatState(chat, { running: false, status: null, liveId: null });
    }
  };

  const chooseModel = async (value: string | null) => {
    if (!value) return;
    if (activeChat() === blankChat) newChat();
    const chat = activeChat();
    const previousKey = modelKey();
    const previousLevel = chat.thinkingLevel;
    const previousLevels = chat.thinkingLevels;
    const previousModel = models().find((item) => modelMatchesKey(item, previousKey)) ?? null;
    modelKey.set(value);
    modelChosen.set(true);
    chat.modelKey = value;
    chat.modelChosen = true;
    const model = models().find((item) => modelKeyOf(item) === value);
    if (!model) return;
    if (chat.client) {
      try {
        await chat.client.request("set_model", { provider: model.provider, modelId: model.id });
        await syncThinking(chat.client, chat);
      } catch (reason) {
        modelKey.set(previousKey);
        chat.modelKey = previousKey;
        applyThinking(chat, previousLevel, previousLevels, previousModel);
        setChatState(chat, { error: errorText(reason) });
      }
    } else {
      const levels = supportedThinkingLevels(model);
      const level = chat.thinkingLevel ? clampThinkingLevel(model, chat.thinkingLevel) : null;
      applyThinking(chat, level, levels, model);
    }
  };

  const chooseThinking = async (value: unknown) => {
    const requested = normalizeThinkingLevel(value);
    if (!requested) return;
    if (activeChat() === blankChat) newChat();
    const chat = activeChat();
    const model = currentModel();
    const level = clampThinkingLevel(model, requested);
    const previousLevel = chat.thinkingLevel;
    const previousLevels = chat.thinkingLevels;
    const previousChosen = chat.thinkingChosen;
    chat.thinkingLevel = level;
    chat.thinkingChosen = true;
    thinkingChosen.set(true);
    applyThinking(chat, level, chat.thinkingLevels.length ? chat.thinkingLevels : supportedThinkingLevels(model), model);
    if (!chat.client) return;
    try {
      await chat.client.request("set_thinking_level", { level });
      await syncThinking(chat.client, chat);
    } catch (reason) {
      chat.thinkingChosen = previousChosen;
      thinkingChosen.set(previousChosen);
      applyThinking(chat, previousLevel, previousLevels, model);
      setChatState(chat, { error: errorText(reason) });
    }
  };

  const toggleCollapsed = (id: string) => {
    const chat = activeChat();
    if (chat === blankChat) return;
    setChatState(chat, { collapsed: withSetValue(chat.state.collapsed, id, !chat.state.collapsed.has(id)) });
  };

  const toggleBlock = (key: string) => {
    const chat = activeChat();
    if (chat === blankChat) return;
    setChatState(chat, { expandedBlocks: withSetValue(chat.state.expandedBlocks, key, !chat.state.expandedBlocks.has(key)) });
  };

  const clearExpandedBlocks = () => {
    const chat = activeChat();
    if (chat !== blankChat) setChatState(chat, { expandedBlocks: new Set() });
  };

  const toggleProject = (projectPath: string) => {
    setProjectExpanded(projectPath, !expandedProjects().has(projectPath));
  };

  const chooseFolder = async () => {
    if (process.platform !== "macos") {
      addError.set("Choose folder is available on macOS. Paste the path instead.");
      return;
    }
    picking.set(true);
    addError.set(null);
    try {
      const result = await process.run(
        "osascript",
        ["-e", 'POSIX path of (choose folder with prompt "Choose a project folder for pi")'],
        { timeoutMs: 120_000 },
      );
      if (result.code !== 0) {
        if (!result.stderr.includes("-128")) addError.set(oneLine(result.stderr) || "The folder chooser did not open.");
        return;
      }
      const picked = result.stdout.trim().replace(/\/+$/, "");
      if (picked) addPath.set(picked);
    } catch (reason) {
      addError.set(errorText(reason));
    } finally {
      picking.set(false);
    }
  };

  const addProject = async () => {
    const raw = addPath().trim();
    if (!raw) {
      addError.set("Choose a folder or paste its path.");
      return;
    }
    const resolved = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
    try {
      const stats = await fs.stat(resolved);
      if (!stats.isDirectory()) throw new Error("That path is not a folder.");
      const projectPath = resolved.replace(/[\\/]+$/, "");
      const existing = projects().find((project) => project.path === projectPath);
      if (existing) {
        newChat(existing.path);
      } else {
        const project = projectFromPath(projectPath);
        const next = [project, ...projects()];
        projects.set(next);
        await persistProjects(next);
        await refreshProject(project.path);
        newChat(project.path);
      }
      addOpen.set(false);
      addPath.set("");
      addError.set(null);
    } catch (reason) {
      addError.set(errorText(reason));
    }
  };

  const removeProject = async (projectPath: string) => {
    const next = projects().filter((project) => project.path !== projectPath);
    projects.set(next);
    setProjectExpanded(projectPath, false);
    sessions.update((current) => {
      const copy = { ...current };
      delete copy[projectPath];
      return copy;
    });
    await persistProjects(next);
    for (const chat of [...chats.values()]) {
      if (chat.projectPath !== projectPath) continue;
      closeChatClient(chat);
      chats.delete(chat.id);
    }
    if (activeProject() === projectPath) {
      activeProject.set(null);
      activeSession.set(null);
      draftChatId.set(null);
      modelOpen.set(false);
      thinkingOpen.set(false);
      messageEdit.set(null);
      draft.set("");
      inputHeight.set(22);
    }
  };

  const boot = async () => {
    try {
      const stored = await Storage.getItem(PROJECTS_KEY);
      let list: ProjectInfo[] = [];
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as ProjectInfo[];
          if (Array.isArray(parsed)) list = parsed.filter((item) => item && typeof item.path === "string").map((item) => projectFromPath(item.path));
        } catch {
          list = [];
        }
      } else {
        list = await discoverProjects();
        await Storage.setItem(PROJECTS_KEY, JSON.stringify(list));
      }
      let storedExpanded: string[] | null = null;
      try {
        const raw = await Storage.getItem(EXPANDED_PROJECTS_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            storedExpanded = parsed.filter((path): path is string => typeof path === "string");
          }
        }
      } catch {
        storedExpanded = null;
      }
      let cachedSessions: Record<string, SessionInfo[]> = {};
      try {
        const storedSessions = await Storage.getItem(SESSIONS_KEY);
        if (storedSessions) {
          const parsed = JSON.parse(storedSessions) as Record<string, SessionInfo[]>;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            cachedSessions = Object.fromEntries(Object.entries(parsed).filter(([, list]) => Array.isArray(list)));
            seedSessionCache(Object.values(cachedSessions).flat());
          }
        }
      } catch {
        cachedSessions = {};
      }
      projects.set(list);
      sessions.set(cachedSessions);
      if (list.length) {
        activeProject.set(list[0].path);
        const projectPaths = new Set(list.map((project) => project.path));
        expandedProjects.set(
          storedExpanded === null ? projectPaths : new Set(storedExpanded.filter((projectPath) => projectPaths.has(projectPath))),
        );
      }
      booted.set(true);
      await refreshMany(list);
    } catch (reason) {
      appError.set(errorText(reason));
    } finally {
      booted.set(true);
    }
  };

  const loadModels = (force = false): Promise<void> => {
    if (catalogLoading) return catalogLoading;
    if (!force && models().length) return Promise.resolve();
    const pending = (async () => {
      try {
        const catalog = await loadCatalog();
        models.set(catalog.models);
        if (catalog.defaultModel && !modelKey()) {
          applyModel(catalog.defaultModel);
          const chat = activeChat();
          if (chat !== blankChat && !chat.modelKey) chat.modelKey = modelKey();
        }
        if (!thinkingLevel()) {
          const chat = activeChat();
          if (chat !== blankChat && !chat.path && !chat.thinkingLevel) {
            applyThinking(chat, catalog.thinkingLevel, catalog.thinkingLevels, catalog.defaultModel);
          } else {
            thinkingLevel.set(catalog.thinkingLevel);
            thinkingLevels.set(catalog.thinkingLevels);
          }
        }
        piIssue.set(null);
      } catch (reason) {
        piIssue.set(errorText(reason));
      }
    })();
    catalogLoading = pending;
    void pending
      .finally(() => {
        if (catalogLoading === pending) catalogLoading = null;
      })
      .catch(() => {});
    return pending;
  };

  void boot();
  // The catalog needs its own pi process; let the first chat open first.
  const catalogTimer = setTimeout(() => void loadModels(), 1500);
  const poolTimer = setInterval(evictClients, 60_000);

  cleanup(() => {
    for (const chat of chats.values()) closeChatClient(chat);
    clearTimeout(catalogTimer);
    clearInterval(poolTimer);
    if (copiedTimer) clearTimeout(copiedTimer);
  });

  effect(() => {
    if (addOpen()) addCardRef?.focus();
  });

  effect(() => {
    if (modelOpen() || thinkingOpen()) void loadModels();
  });

  effect(() => {
    const mainWindow = Window.get("main");
    if (!mainWindow) return;
    return mainWindow.on("focusChange", ({ focused }) => {
      if (focused) void loadModels(true);
    });
  });

  cleanup(
    keymap.bind("escape", () => {
      if (!addOpen()) return;
      addOpen.set(false);
      addError.set(null);
    }),
  );

  cleanup(keymap.bind("mod+b", () => sidebarOpen.set(!sidebarOpen()), { when: "always" }));

  function ProjectRow(props: { project: () => ProjectInfo }) {
    const project = props.project;
    const projectPath = computed(() => project().path);
    const open = computed(() => expandedProjects().has(projectPath()));
    const projectSessions = computed(() => sessions()[projectPath()] ?? []);
    const all = computed(() => showAllSessions().has(projectPath()));
    const visible = computed(() => (all() ? projectSessions() : projectSessions().slice(0, VISIBLE_SESSIONS)));
    const isActive = computed(() => activeProject() === projectPath() && !activeSession());
    const hovering = signal(false);

    return (
      <View>
        <ContextMenu
          margin={8}
          popupClass="min-w-[180px] rounded-lg border border-border bg-popover p-1 shadow-lg"
          trigger={
            <View
              hoverStyle={{ backgroundColor: colors.sidebarAccent }}
              onMouseEnter={() => hovering.set(true)}
              onMouseLeave={() => hovering.set(false)}
              style={{
                height: sidebarMetrics.projectRow,
                borderRadius: 8,
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: 7,
                paddingRight: 2,
                backgroundColor: isActive() ? colors.sidebarAccent : "transparent",
              }}
            >
              <Press
                onPress={() => toggleProject(projectPath())}
                hoverStyle={{ backgroundColor: "transparent" }}
                style={{ flex: 1, minWidth: 0, height: 30, borderRadius: 7, paddingHorizontal: 3, flexDirection: "row", alignItems: "center", gap: 8 }}
                accessibilityLabel={`${project().name} project`}
                accessibilityState={{ expanded: open() }}
              >
                <Icon name={open() ? "folder-open" : "folder"} size={15} tint={colors.mutedText} />
                <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, fontSize: 13, color: colors.text }}>{project().name}</Text>
              </Press>
              <View class="transition-opacity duration-150" style={{ opacity: hovering() ? 1 : 0 }}>
                <Press
                  onPress={() => newChat(projectPath())}
                  hoverStyle={{ backgroundColor: "transparent" }}
                  style={{ width: 26, height: 26, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
                  accessibilityLabel={`New chat in ${project().name}`}
                  tooltip={<Text style={{ fontSize: 12 }}>New chat</Text>}
                >
                  <Icon name="compose" size={14} tint={colors.mutedText} />
                </Press>
              </View>
            </View>
          }
        >
          <MenuItem
            onSelect={() => {
              void Clipboard.writeText(projectPath());
            }}
            class="rounded-md px-2.5 py-2 hover:bg-accent focus:bg-accent active:bg-secondary"
          >
            <Text style={{ fontSize: 12.5, color: colors.text }}>Copy path</Text>
          </MenuItem>
          <MenuSeparator class="my-1 h-px bg-border" />
          <MenuItem onSelect={() => void removeProject(projectPath())} class="rounded-md px-2.5 py-2 hover:bg-accent focus:bg-accent active:bg-secondary">
            <Text style={{ fontSize: 12.5, color: colors.danger }}>Remove project</Text>
          </MenuItem>
        </ContextMenu>

        <If when={open()}>
          <View style={{ paddingBottom: 4 }}>
            <If when={projectSessions().length === 0}>
              <View style={{ height: 27, paddingLeft: 30, justifyContent: "center" }}>
                <Text style={{ fontSize: 12, color: colors.faint }}>No chats</Text>
              </View>
            </If>
            <Each of={visible()}>
              {(session) => {
                const busy = computed(() => {
                  chatActivity();
                  return chats.get(session().path)?.state.running ?? false;
                });
                return (
                  <Press
                    onPress={() => void openExistingSession(projectPath(), session().path)}
                    hoverStyle={{ backgroundColor: colors.sidebarAccent }}
                    style={{
                      height: 28,
                      marginLeft: 4,
                      borderRadius: 7,
                      paddingLeft: 27,
                      paddingRight: 8,
                      alignItems: "flex-start",
                      justifyContent: "center",
                      backgroundColor: activeSession() === session().path ? colors.sidebarAccent : "transparent",
                    }}
                    accessibilityLabel={session().title}
                    accessibilityState={{ selected: activeSession() === session().path }}
                  >
                    <View style={{ width: "100%", flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text
                        style={{
                          flex: 1,
                          minWidth: 0,
                          numberOfLines: 1,
                          textOverflow: "ellipsis",
                          fontSize: 12.5,
                          color: activeSession() === session().path ? colors.text : colors.mutedText,
                          fontWeight: activeSession() === session().path ? "500" : "400",
                        }}
                      >
                        {session().title}
                      </Text>
                      <If when={busy()}>
                        <Spinner size={10} tint={colors.faint} />
                      </If>
                    </View>
                  </Press>
                );
              }}
            </Each>
            <If when={projectSessions().length > VISIBLE_SESSIONS}>
              <Press
                onPress={() => showAllSessions.update((set) => withSetValue(set, projectPath(), !all()))}
                hoverStyle={{ backgroundColor: colors.sidebarAccent }}
                style={{ height: 27, marginLeft: 4, borderRadius: 7, paddingLeft: 27, justifyContent: "center" }}
              >
                <Text style={{ fontSize: 12, color: colors.faint }}>{all() ? "Show less" : "Show more"}</Text>
              </Press>
            </If>
          </View>
        </If>
      </View>
    );
  }

  function Sidebar() {
    return (
      <View
        style={{
          width: sidebarMetrics.width,
          flexShrink: 0,
          backgroundColor: colors.sidebar,
          borderRightWidth: 1,
          borderRightColor: colors.sidebarBorder,
          paddingTop: 10,
          paddingBottom: 8,
        }}
      >
        <View style={{ height: 38, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 16 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text, letterSpacing: -0.1 }}>Pi</Text>
        </View>

        <Press
          onPress={() => {
            if (projects().length === 0) addOpen.set(true);
            else newChat(activeProject() ?? projects()[0].path);
          }}
          hoverStyle={{ backgroundColor: colors.sidebarAccent }}
          style={{ height: 34, marginTop: 7, marginHorizontal: 10, borderRadius: 8, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 8 }}
          accessibilityLabel="New chat"
        >
          <Icon name="compose" size={15} tint={colors.mutedText} />
          <Text style={{ fontSize: 13, color: colors.text }}>New chat</Text>
        </Press>

        <View style={{ flex: 1, minHeight: 0 }}>
          <View style={{ height: 34, marginTop: 12, paddingHorizontal: 18, flexDirection: "row", alignItems: "center" }}>
            <Text style={{ flex: 1, fontSize: 11, fontWeight: "600", color: colors.faint, letterSpacing: 0.4 }}>PROJECTS</Text>
            <Press
              onPress={() => {
                addError.set(null);
                addOpen.set(true);
              }}
              hoverStyle={{ backgroundColor: colors.sidebarAccent }}
              style={{ width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" }}
              accessibilityLabel="Add project"
              tooltip={<Text style={{ fontSize: 12 }}>Add project</Text>}
            >
              <Icon name="plus" size={14} tint={colors.faint} />
            </Press>
          </View>
          <Scroll
            style={{ flex: 1, minHeight: 0 }}
            contentStyle={{ paddingHorizontal: 10, paddingBottom: 8 }}
            bounces={false}
          >
            <Each of={projects()}>{(project) => <ProjectRow project={project} />}</Each>
            <If when={booted() && projects().length === 0}>
              <View style={{ paddingHorizontal: 8, paddingTop: 10, gap: 7 }}>
                <Text style={{ fontSize: 12, lineHeight: 17, color: colors.faint }}>Add a project folder to start a chat with pi.</Text>
                <Press
                  onPress={() => addOpen.set(true)}
                  hoverStyle={{ backgroundColor: colors.sidebarAccent }}
                  style={{ alignSelf: "flex-start", height: 28, paddingHorizontal: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 6 }}
                >
                  <Icon name="plus" size={13} tint={colors.mutedText} />
                  <Text style={{ fontSize: 12, color: colors.text }}>Add project</Text>
                </Press>
              </View>
            </If>
          </Scroll>
        </View>
      </View>
    );
  }

  function Header() {
    const project = computed(() => activeProjectInfo());
    const session = computed(() => activeSessionInfo());
    return (
      <View
        style={{
          height: 48,
          flexShrink: 0,
          borderBottomWidth: 1,
          borderBottomColor: colors.line,
          backgroundColor: colors.background,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 14,
          paddingRight: 22,
          gap: 10,
        }}
      >
        <Press
          onPress={() => sidebarOpen.set(!sidebarOpen())}
          hoverStyle={{ backgroundColor: colors.accent }}
          style={{ width: 28, height: 28, borderRadius: 7, alignItems: "center", justifyContent: "center" }}
          accessibilityLabel={sidebarOpen() ? "Hide sidebar" : "Show sidebar"}
          accessibilityState={{ expanded: sidebarOpen() }}
        >
          <Icon name="panel-left" size={16} tint={colors.mutedText} />
        </Press>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Text style={{ numberOfLines: 1, fontSize: 13, fontWeight: "600", color: colors.text }}>{project()?.name ?? "Pi"}</Text>
          <If when={Boolean(session())}>
            <Text style={{ numberOfLines: 1, flexShrink: 1, textOverflow: "ellipsis", fontSize: 13, color: colors.mutedText }}>{session()?.title ?? ""}</Text>
          </If>
        </View>
        <If when={loading() || running()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Spinner size={11} />
            <Text style={{ fontSize: 11, color: colors.faint }}>{status() ?? (loading() ? "Loading" : "Working")}</Text>
          </View>
        </If>
      </View>
    );
  }

  function ToolCard(props: { call: () => ContentBlock; blockKey: () => string }) {
    const call = props.call;
    const id = computed(() => String(call().id ?? ""));
    const name = computed(() => String(call().name ?? "tool"));
    const run = computed(() => toolRuns()[id()]);
    const historical = computed(() => toolResults()[id()]);
    const args = computed(() => run()?.args ?? call().arguments);
    const summary = computed(() => summarizeArguments(args()));
    const result = computed(() => run()?.result ?? historical()?.text ?? "");
    const isRunning = computed(() => run()?.running ?? (!historical() && running()));
    const failed = computed(() => run()?.isError === true || historical()?.isError === true);
    const duration = computed(() => formatDuration(run()?.durationMs));
    const expanded = computed(() => expandedBlocks().has(props.blockKey()));
    const toggle = () => toggleBlock(props.blockKey());
    return (
      <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.card, overflow: "hidden" }}>
        <Press
          onPress={toggle}
          hoverStyle={{ backgroundColor: "transparent" }}
          activeStyle={{ opacity: 0.8 }}
          style={{ minHeight: 30, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 6 }}
          accessibilityLabel={`${expanded() ? "Collapse" : "Expand"} ${name()} ${oneLine(summary(), 60)}`}
          accessibilityState={{ expanded: expanded() }}
        >
          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={11} tint={failed() ? colors.danger : colors.faint} />
          <If when={isRunning()}>
            <Spinner size={11} tint={failed() ? colors.danger : colors.mutedText} />
          </If>
          <Text style={{ fontSize: 11.5, fontWeight: "500", color: failed() ? colors.danger : colors.text }}>{name()}</Text>
          <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, textOverflow: "ellipsis", fontSize: 11.5, color: failed() ? colors.danger : colors.mutedText }}>
            {summary()}
          </Text>
          <If when={Boolean(duration())}>
            <Text style={{ fontSize: 10.5, color: failed() ? colors.danger : colors.faint }}>{duration()}</Text>
          </If>
        </Press>
        <If when={expanded()}>
          <View style={{ paddingHorizontal: 10, paddingBottom: 9, gap: 4 }}>
            <If when={Boolean(result())} else={<Text style={{ fontSize: 11, color: colors.faint }}>{isRunning() ? "Running…" : "No output"}</Text>}>
              <Text
                style={{
                  numberOfLines: 8,
                  textOverflow: "ellipsis",
                  fontFamily: "Menlo",
                  fontSize: 10.5,
                  lineHeight: 15,
                  color: failed() ? colors.danger : colors.mutedText,
                  userSelect: "text",
                }}
              >
                {clipText(result())}
              </Text>
            </If>
          </View>
        </If>
      </View>
    );
  }

  function ThinkingBlock(props: { block: () => Extract<WorkBlock, { kind: "thinking" }> }) {
    const block = props.block;
    const expanded = computed(() => expandedBlocks().has(block().key));
    return (
      <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.card, overflow: "hidden" }}>
        <Press
          onPress={() => toggleBlock(block().key)}
          hoverStyle={{ backgroundColor: "transparent" }}
          activeStyle={{ opacity: 0.8 }}
          style={{ minHeight: 30, paddingHorizontal: 8, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 6 }}
          accessibilityLabel={`${expanded() ? "Collapse" : "Expand"} thinking`}
          accessibilityState={{ expanded: expanded() }}
        >
          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={11} tint={colors.faint} />
          <Text style={{ flex: 1, minWidth: 0, numberOfLines: 1, textOverflow: "ellipsis", fontSize: 11.5, color: colors.mutedText }}>
            {oneLine(block().text, 120)}
          </Text>
        </Press>
        <If when={expanded()}>
          <View style={{ paddingHorizontal: 10, paddingBottom: 9 }}>
            <Text style={{ fontSize: 12, lineHeight: 18, color: colors.mutedText, userSelect: "text" }}>{block().text}</Text>
          </View>
        </If>
      </View>
    );
  }

  function WorkDetails(props: { messages: () => PiMessage[]; turnKey: () => string; live: () => boolean }) {
    const blocks = computed(() => workBlocksOf(props.turnKey(), props.messages()));
    const open = computed(() => props.live() || !collapsed().has(props.turnKey()));
    const label = computed(() => {
      const parts: string[] = [];
      const thinking = blocks().filter((block) => block.kind === "thinking").length;
      const tools = blocks().filter((block) => block.kind === "tool").length;
      if (thinking) parts.push("Thinking");
      if (tools) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
      return parts.join(" · ");
    });

    return (
      <If when={blocks().length > 0}>
        <View style={{ gap: 6 }}>
          <Press
            onPress={() => {
              const nextOpen = !open();
              toggleCollapsed(props.turnKey());
              if (!nextOpen) clearExpandedBlocks();
            }}
            hoverStyle={{ backgroundColor: "transparent" }}
            activeStyle={{ opacity: 0.65 }}
            style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 2 }}
            accessibilityLabel={open() ? "Collapse work details" : "Expand work details"}
            accessibilityState={{ expanded: open() }}
          >
            <Icon name={open() ? "chevron-down" : "chevron-right"} size={12} tint={colors.faint} />
            <Text style={{ fontSize: 12, color: colors.mutedText }}>Work details</Text>
            <Text style={{ fontSize: 12, color: colors.faint }}>{`· ${label()}`}</Text>
            <If when={props.live()}>
              <Spinner size={10} />
            </If>
          </Press>
          <If when={open()}>
            <View style={{ gap: 6 }}>
              <Each of={blocks()}>
                {(block) => (
                  <If
                    when={block().kind === "thinking"}
                    else={<ToolCard call={() => (block() as Extract<WorkBlock, { kind: "tool" }>).call} blockKey={() => block().key} />}
                  >
                    <ThinkingBlock block={() => block() as Extract<WorkBlock, { kind: "thinking" }>} />
                  </If>
                )}
              </Each>
            </View>
          </If>
        </View>
      </If>
    );
  }

  function Markdown(props: { text: () => string }) {
    return (
      <TextView
        markdown={props.text()}
        selectable
        options={{ streaming: true }}
        onLinkPress={({ url }) => {
          if (typeof url === "string") void openUrl(url);
        }}
        styles={{ root: { fontSize: 14.5, lineHeight: 23, color: colors.text } }}
        classes={{
          heading: "text-foreground",
          heading1: "text-2xl",
          heading2: "text-xl",
          heading3: "text-lg",
          blockquote: "border-l-2 border-border pl-3 text-muted-foreground",
          code: "rounded bg-muted px-1",
          codeBlock: "rounded-lg border border-border bg-muted/45",
          codeBlockCode: "text-[12px] leading-5",
          table: "rounded-lg border border-border",
          tableHead: "bg-muted",
          tableCell: "border-border",
          link: "text-foreground underline",
          rule: "border-border",
        }}
      />
    );
  }

  function MessageRow(props: { message: () => PiMessage | undefined }) {
    const message = props.message;
    const role = computed(() => message()?.role ?? "");
    const text = computed(() => textOfContent(message()?.content));
    const hovering = signal(false);
    const editing = computed(() => {
      const edit = messageEdit();
      const current = message();
      return edit && current && edit.chatId === activeChat().id && edit.messageId === current.id ? edit : null;
    });

    if (!message()) return <View />;

    if (role() === "compactionSummary" || role() === "branchSummary") {
      return (
        <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 8 }}>
          <View style={{ height: 1, backgroundColor: colors.line }} />
          <Text style={{ alignSelf: "center", marginTop: -9, paddingHorizontal: 8, backgroundColor: colors.background, fontSize: 10.5, color: colors.faint }}>
            {role() === "compactionSummary" ? "Context compacted" : "Earlier branch"}
          </Text>
        </View>
      );
    }

    if (role() === "bashExecution") {
      return (
        <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 7 }}>
          <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 9, backgroundColor: colors.inset, padding: 10, gap: 4 }}>
            <Text style={{ fontSize: 10.5, color: colors.faint }}>COMMAND</Text>
            <Text style={{ fontFamily: "Menlo", fontSize: 11.5, color: colors.text, userSelect: "text" }}>{String(message()?.command ?? "")}</Text>
          </View>
        </View>
      );
    }

    if (role() === "user") {
      return (
        <View>
          <If when={Boolean(editing())}>
            <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 8 }}>
              <View style={{ width: "100%", borderRadius: 17, backgroundColor: colors.muted, paddingHorizontal: 13, paddingTop: 10, paddingBottom: 8, gap: 8 }}>
                <Input
                  value={editing()?.draft ?? ""}
                  onChange={({ value }) => updateEditDraft(value)}
                  multiline
                  autoFocus
                  scrollbar={false}
                  submitBehavior="submit"
                  onSubmit={() => void saveEditedMessage()}
                  onContentSizeChange={({ size }) => editHeight.set(Math.min(180, Math.max(44, size.height)))}
                  style={{
                    height: editHeight() + 12,
                    paddingHorizontal: 2,
                    paddingVertical: 2,
                    fontSize: 14.5,
                    color: colors.text,
                    placeholderColor: colors.faint,
                    caretColor: colors.text,
                    selectionColor: colors.accent,
                  }}
                  accessibilityLabel="Edit message"
                />
                <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
                  <Press
                    onPress={cancelEditMessage}
                    disabled={editing()?.saving}
                    hoverStyle={{ backgroundColor: colors.secondary }}
                    activeStyle={{ opacity: 0.8 }}
                    style={{ height: 30, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" }}
                    accessibilityLabel="Cancel editing"
                  >
                    <Text style={{ fontSize: 12.5, color: colors.text }}>Cancel</Text>
                  </Press>
                  <Press
                    onPress={() => void saveEditedMessage()}
                    disabled={editing()?.saving || !(editing()?.draft ?? "").trim()}
                    hoverStyle={{ opacity: 0.88 }}
                    activeStyle={{ opacity: 0.72 }}
                    style={{ height: 30, paddingHorizontal: 14, borderRadius: 8, backgroundColor: colors.text, alignItems: "center", justifyContent: "center" }}
                    accessibilityLabel="Send edited message"
                  >
                    <Text style={{ fontSize: 12.5, fontWeight: "500", color: colors.onPrimary }}>Send</Text>
                  </Press>
                </View>
              </View>
            </View>
          </If>
          <If when={!editing()}>
            <View
              onMouseEnter={() => hovering.set(true)}
              onMouseLeave={() => hovering.set(false)}
              style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 8 }}
            >
              <View
                style={{
                  alignSelf: "flex-end",
                  maxWidth: "80%",
                  backgroundColor: colors.muted,
                  borderRadius: 17,
                  paddingHorizontal: 13,
                  paddingVertical: 9,
                }}
              >
                <Text style={{ fontSize: 14.5, lineHeight: 22, color: colors.text, userSelect: "text" }}>{text()}</Text>
              </View>
              <View style={{ alignSelf: "flex-end", height: 22, marginTop: 3, flexDirection: "row", alignItems: "center", gap: 2 }}>
                <If when={hovering()}>
                  <Press
                    onPress={() => void copyMessage(message()!)}
                    hoverStyle={{ backgroundColor: colors.accent }}
                    activeStyle={{ opacity: 0.7 }}
                    style={{ width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" }}
                    accessibilityLabel="Copy message"
                    tooltip={<Text style={{ fontSize: 12 }}>Copy</Text>}
                  >
                    <Icon name={copiedMessageId() === message()?.id ? "check" : "copy"} size={13} tint={colors.mutedText} />
                  </Press>
                  <Press
                    onPress={() => beginEditMessage(activeChat(), message()!)}
                    disabled={running() || loading()}
                    hoverStyle={{ backgroundColor: colors.accent }}
                    activeStyle={{ opacity: 0.7 }}
                    style={{ width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" }}
                    accessibilityLabel="Edit message"
                    tooltip={<Text style={{ fontSize: 12 }}>Edit</Text>}
                  >
                    <Icon name="compose" size={13} tint={colors.mutedText} />
                  </Press>
                </If>
                <If when={Boolean(messageTime(message()?.timestamp))}>
                  <Text style={{ marginLeft: 3, fontSize: 10.5, color: colors.faint }}>{messageTime(message()?.timestamp)}</Text>
                </If>
              </View>
            </View>
          </If>
        </View>
      );
    }

    if (role() === "custom") {
      return (
        <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 5 }}>
          <Text style={{ fontSize: 12, lineHeight: 18, color: colors.mutedText, userSelect: "text" }}>{text()}</Text>
        </View>
      );
    }

    return (
      <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 6 }}>
        <Text style={{ fontSize: 12, lineHeight: 18, color: colors.mutedText, userSelect: "text" }}>{text()}</Text>
      </View>
    );
  }

  function TurnRow(props: { item: () => DisplayItem }) {
    const item = props.item;
    const hovering = signal(false);
    const turnMessages = computed(() => {
      const value = item();
      return value.kind === "turn" ? value.messages : [];
    });
    const turnKey = computed(() => {
      const value = item();
      return value.kind === "turn" ? value.key : "";
    });
    const text = computed(() =>
      turnMessages()
        .map((message) => assistantText(message))
        .filter(Boolean)
        .join("\n\n"),
    );
    const hasDetails = computed(() => turnMessages().some((message) => hasWork(message)));
    const live = computed(() => turnMessages().some((message) => message.id === liveId()));
    const showCopy = computed(() => Boolean(text().trim()) && (hovering() || lastTurnId() === item().id));
    const error = computed(() => {
      for (let index = turnMessages().length - 1; index >= 0; index--) {
        const message = turnMessages()[index];
        if (message.stopReason !== "error" && message.stopReason !== "aborted") continue;
        return String(message.errorMessage ?? (message.stopReason === "aborted" ? "Stopped" : "pi could not finish this response."));
      }
      return "";
    });

    return (
      <View
        onMouseEnter={() => hovering.set(true)}
        onMouseLeave={() => hovering.set(false)}
        style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 8, gap: 9 }}
      >
        <If when={hasDetails()}>
          <WorkDetails messages={turnMessages} turnKey={turnKey} live={live} />
        </If>
        <If when={Boolean(text().trim())}>
          <Markdown text={text} />
        </If>
        <If when={live() && !text().trim() && !hasDetails()}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 3 }}>
            <Spinner size={11} />
            <Text style={{ fontSize: 12.5, color: colors.mutedText }}>Working…</Text>
          </View>
        </If>
        <If when={Boolean(error())}>
          <Text style={{ fontSize: 12, lineHeight: 18, color: colors.danger }}>{error()}</Text>
        </If>
        <If when={showCopy()}>
          <Press
            onPress={() => void copyText(item().id, text())}
            hoverStyle={{ backgroundColor: colors.accent }}
            activeStyle={{ opacity: 0.7 }}
            style={{ alignSelf: "flex-start", width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" }}
            accessibilityLabel="Copy message"
            tooltip={<Text style={{ fontSize: 12 }}>Copy</Text>}
          >
            <Icon name={copiedMessageId() === item().id ? "check" : "copy"} size={13} tint={colors.mutedText} />
          </Press>
        </If>
      </View>
    );
  }

  function TimelineRow(props: { item: () => DisplayItem }) {
    const item = props.item;
    const kind = computed(() => item().kind);
    if (kind() === "user") {
      return <MessageRow message={() => (item().kind === "user" ? (item() as UserDisplay).message : undefined)} />;
    }
    if (kind() === "turn") return <TurnRow item={item} />;
    return <MessageRow message={() => (item().kind === "note" ? (item() as NoteDisplay).message : undefined)} />;
  }

  function ModelPicker() {
    const title = computed(() => {
      const model = currentModel();
      return model?.name || model?.id || "Choose model";
    });
    return (
      <Popover
        open={modelOpen()}
        onOpenChange={({ open }) => {
          modelOpen.set(open);
          if (open) thinkingOpen.set(false);
        }}
        placement="top"
        align="start"
        offset={6}
        margin={10}
        popupClass="rounded-xl border border-border bg-popover shadow-lg"
        trigger={
          <View
            style={{ height: 28, maxWidth: 260, borderRadius: 7, paddingHorizontal: 7, flexDirection: "row", alignItems: "center", gap: 5 }}
            hoverStyle={{ backgroundColor: colors.accent }}
          >
            <Text style={{ numberOfLines: 1, textOverflow: "ellipsis", flexShrink: 1, fontSize: 11.5, color: colors.mutedText }}>
              {models().length ? title() : "pi model"}
            </Text>
            <Icon name="chevron-down" size={12} tint={colors.faint} />
          </View>
        }
      >
        <View style={{ width: 280, height: modelMenuHeight() }}>
          <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 4 }} scrollbar>
            <If when={models().length === 0}>
              <View style={{ height: 32, paddingHorizontal: 8, justifyContent: "center" }}>
                <Text style={{ fontSize: 12, numberOfLines: 1, textOverflow: "ellipsis", color: colors.faint }}>
                  {piIssue() ? oneLine(piIssue() ?? "", 60) : "Loading models…"}
                </Text>
              </View>
            </If>
            <Each of={modelGroups()}>
              {(group) => (
                <View>
                  <View style={{ height: 24, paddingHorizontal: 6, justifyContent: "center" }}>
                    <Text style={{ fontSize: 10, fontWeight: "600", letterSpacing: 0.4, color: colors.faint }}>{group().provider.toUpperCase()}</Text>
                  </View>
                  <Each of={group().models}>
                    {(model) => (
                      <View
                        onPress={() => {
                          void chooseModel(modelKeyOf(model()));
                          modelOpen.set(false);
                        }}
                        role="button"
                        accessibilityLabel={`Use ${model().name || model().id}`}
                        hoverStyle={{ backgroundColor: colors.accent }}
                        activeStyle={{ opacity: 0.75 }}
                        style={{ height: 28, borderRadius: 6, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 8 }}
                      >
                        <Text style={{ flex: 1, numberOfLines: 1, textOverflow: "ellipsis", fontSize: 12.5, color: colors.text, fontWeight: modelMatchesKey(model(), modelKey()) ? "500" : "400" }}>
                          {model().name || model().id}
                        </Text>
                        <If when={modelMatchesKey(model(), modelKey())}>
                          <Icon name="check" size={12} tint={colors.text} />
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </Popover>
    );
  }

  function ThinkingPicker() {
    const title = computed(() => thinkingLevel() ?? "thinking");
    return (
      <Popover
        open={thinkingOpen()}
        onOpenChange={({ open }) => {
          thinkingOpen.set(open);
          if (open) modelOpen.set(false);
        }}
        placement="top"
        align="start"
        offset={6}
        margin={10}
        popupClass="rounded-xl border border-border bg-popover shadow-lg"
        trigger={
          <View
            role="button"
            accessibilityLabel={`Thinking level: ${title()}`}
            style={{ height: 28, maxWidth: 150, borderRadius: 7, paddingHorizontal: 7, flexDirection: "row", alignItems: "center", gap: 5 }}
            hoverStyle={{ backgroundColor: colors.accent }}
          >
            <Text style={{ numberOfLines: 1, textOverflow: "ellipsis", flexShrink: 1, fontSize: 11.5, color: colors.mutedText }}>
              {title()}
            </Text>
            <Icon name="chevron-down" size={12} tint={colors.faint} />
          </View>
        }
      >
        <View style={{ width: 160, height: thinkingMenuHeight() }}>
          <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 4 }} scrollbar>
            <View style={{ height: 24, paddingHorizontal: 6, justifyContent: "center" }}>
              <Text style={{ fontSize: 10, fontWeight: "600", letterSpacing: 0.4, color: colors.faint }}>THINKING</Text>
            </View>
            <Each of={thinkingOptions()}>
              {(level) => (
                <View
                  onPress={() => {
                    void chooseThinking(level());
                    thinkingOpen.set(false);
                  }}
                  role="button"
                  accessibilityLabel={`Use ${level()} thinking`}
                  hoverStyle={{ backgroundColor: colors.accent }}
                  activeStyle={{ opacity: 0.75 }}
                  style={{ height: 28, borderRadius: 6, paddingHorizontal: 6, flexDirection: "row", alignItems: "center", gap: 8 }}
                >
                  <Text style={{ flex: 1, fontSize: 12.5, color: colors.text, fontWeight: thinkingLevel() === level() ? "500" : "400" }}>
                    {level()}
                  </Text>
                  <If when={thinkingLevel() === level()}>
                    <Icon name="check" size={12} tint={colors.text} />
                  </If>
                </View>
              )}
            </Each>
          </Scroll>
        </View>
      </Popover>
    );
  }

  function Composer() {
    const canSend = computed(() => draft().trim().length > 0 && !running() && !loading());
    const placeholder = computed(() => {
      const project = activeProjectInfo();
      return project ? `Ask pi about ${project.name}…` : "Ask pi to build, debug, or explain…";
    });
    return (
      <View style={{ flexShrink: 0, paddingHorizontal: 22, paddingBottom: 22, paddingTop: 8 }}>
        <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center" }}>
          <If when={Boolean(error() || piIssue())}>
            <View style={{ marginBottom: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.background, paddingHorizontal: 10, paddingVertical: 7 }}>
              <Text style={{ fontSize: 11.5, lineHeight: 16, color: colors.danger }}>{error() ?? piIssue()}</Text>
            </View>
          </If>
          <View
            style={{
              borderRadius: 18,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.card,
              paddingHorizontal: 10,
              paddingTop: 7,
              paddingBottom: 7,
              boxShadow: "0 8px 28px rgba(0,0,0,0.07)",
            }}
          >
            <View style={{ position: "relative" }}>
              <Input
                ref={(node) => (composerInput = node)}
                value={draft()}
                onChange={({ value }) => draft.set(value)}
                multiline
                autoFocus
                scrollbar={false}
                onFocus={() => {
                  modelOpen.set(false);
                  thinkingOpen.set(false);
                }}
                placeholder={placeholder()}
                submitBehavior="submit"
                onSubmit={() => void send()}
                onContentSizeChange={({ size }) => inputHeight.set(Math.min(140, Math.max(22, size.height)))}
                style={{
                  height: inputHeight() + 12,
                  paddingHorizontal: 4,
                  paddingVertical: 5,
                  fontSize: 14.5,
                  color: colors.text,
                  placeholderColor: colors.faint,
                  caretColor: colors.text,
                  selectionColor: colors.accent,
                }}
                accessibilityLabel="Message pi"
              />
              <If when={modelOpen() || thinkingOpen()}>
                <View
                  onPress={() => {
                    modelOpen.set(false);
                    thinkingOpen.set(false);
                    composerInput?.focus();
                  }}
                  style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
                />
              </If>
            </View>
            <View style={{ height: 30, flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 2 }}>
              <ModelPicker />
              <ThinkingPicker />
              <View style={{ flex: 1 }} />
              <If
                when={running()}
                else={
                  <Press
                    onPress={() => void send()}
                    disabled={!canSend()}
                    activeStyle={{ opacity: 0.82 }}
                    style={roundButtonStyle(30)}
                    accessibilityLabel="Send message"
                    tooltip={<Text style={{ fontSize: 12 }}>Send · Return</Text>}
                  >
                    <Icon name="arrow-up" size={15} tint={colors.onPrimary} />
                  </Press>
                }
              >
                <Press
                  onPress={() => void stop()}
                  activeStyle={{ opacity: 0.82 }}
                  style={[roundButtonStyle(30), { backgroundColor: colors.text }]}
                  accessibilityLabel="Stop"
                  tooltip={<Text style={{ fontSize: 12 }}>Stop</Text>}
                >
                  <Icon name="stop" size={12} tint={colors.onPrimary} />
                </Press>
              </If>
            </View>
          </View>
        </View>
      </View>
    );
  }

  function EmptyProject() {
    return (
      <View style={{ flex: 1, minHeight: 0, justifyContent: "center", alignItems: "center", paddingHorizontal: 32, paddingBottom: 80 }}>
        <View style={{ width: "100%", maxWidth: 520, alignItems: "center", gap: 14 }}>
          <Text style={{ fontSize: 27, letterSpacing: -0.7, color: colors.text, textAlign: "center" }}>What should we work on?</Text>
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.mutedText, textAlign: "center" }}>Add a project folder, then talk to pi about the code inside it.</Text>
          <Press
            onPress={() => addOpen.set(true)}
            hoverStyle={{ backgroundColor: colors.secondary }}
            style={{ height: 34, paddingHorizontal: 13, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, flexDirection: "row", alignItems: "center", gap: 7 }}
          >
            <Icon name="plus" size={14} tint={colors.text} />
            <Text style={{ fontSize: 12.5, fontWeight: "500", color: colors.text }}>Add project</Text>
          </Press>
          <If when={Boolean(error() || piIssue())}>
            <Text style={{ fontSize: 11.5, lineHeight: 16, color: colors.danger, textAlign: "center" }}>{error() ?? piIssue()}</Text>
          </If>
        </View>
      </View>
    );
  }

  function NewChat() {
    const project = computed(() => activeProjectInfo());
    return (
      <View style={{ flex: 1, minHeight: 0 }}>
        <View style={{ flex: 1, minHeight: 0, justifyContent: "center", alignItems: "center", paddingHorizontal: 32, paddingBottom: 20 }}>
          <View style={{ alignItems: "center", gap: 12, maxWidth: 620 }}>
            <Text style={{ fontSize: 27, letterSpacing: -0.7, color: colors.text, textAlign: "center" }}>
              {`What should we work on in ${project()?.name ?? "Pi"}?`}
            </Text>
          </View>
        </View>
        <Composer />
      </View>
    );
  }

  function Chat() {
    return (
      <View style={{ flex: 1, minHeight: 0 }}>
        <Each of={[activeChat().id]}>
          {() => (
            <If
              when={loading() && messages().length === 0}
              else={
                <List
                  each={visibleItems()}
                  keyExtractor={(item) => item.id}
                  estimatedItemSize={180}
                  alignment="bottom"
                  initialScrollAtEnd
                  maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 90 }}
                  header={
                    hasEarlier() ? (
                      <View style={{ alignItems: "center", paddingVertical: 8 }}>
                        <Press
                          onPress={showEarlier}
                          style={{
                            height: 26,
                            paddingHorizontal: 10,
                            borderRadius: 7,
                            borderWidth: 1,
                            borderColor: colors.line,
                            backgroundColor: colors.card,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Text style={{ fontSize: 11.5, color: colors.mutedText }}>Load earlier messages</Text>
                        </Press>
                      </View>
                    ) : undefined
                  }
                  onLoadMoreAtStart={hasEarlier() ? showEarlier : undefined}
                  loadMoreAtStartThreshold={1.5}
                  testID="chat-list"
                  style={{ flex: 1 }}
                  contentStyle={{ paddingTop: 16, paddingBottom: 4 }}
                  scrollbar
                >
                  {(item) => <TimelineRow item={item} />}
                </List>
              }
            >
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }}>
                <Spinner size={14} />
                <Text style={{ fontSize: 12, color: colors.faint }}>Loading conversation…</Text>
              </View>
            </If>
          )}
        </Each>
        <Composer />
      </View>
    );
  }

  function AddProjectDialog() {
    return (
      <If when={addOpen()}>
        <View
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            backgroundColor: "rgba(0,0,0,0.18)",
          }}
        >
          <View
            ref={(node) => (addCardRef = node)}
            focusable
            role="dialog"
            accessibilityLabel="Add project"
            style={{
              width: 520,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.card,
              padding: 20,
              gap: 13,
              boxShadow: "0 24px 70px rgba(0,0,0,0.2)",
            }}
          >
          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: 18, fontWeight: "600", color: colors.text, letterSpacing: -0.2 }}>Add a project</Text>
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.mutedText }}>Choose the folder pi should work in. Each project keeps its own chats.</Text>
          </View>
          <View style={{ gap: 7 }}>
            <Text style={{ fontSize: 11, fontWeight: "600", color: colors.faint }}>PROJECT FOLDER</Text>
            <View style={{ flexDirection: "row", gap: 7 }}>
              <View style={{ flex: 1, minWidth: 0, height: 34, borderRadius: 8, borderWidth: 1, borderColor: colors.input, backgroundColor: colors.field, justifyContent: "center" }}>
                <Input
                  value={addPath()}
                  onKeyPress={({ key }) => {
                    if (key !== "Escape" && key !== "Esc") return;
                    addOpen.set(false);
                    addError.set(null);
                  }}
                  onChange={({ value }) => {
                    addPath.set(value);
                    addError.set(null);
                  }}
                  placeholder="~/Developer/my-project"
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ height: 32, paddingHorizontal: 9, fontSize: 12.5, color: colors.text, placeholderColor: colors.faint, caretColor: colors.text }}
                  accessibilityLabel="Project folder path"
                />
              </View>
              <Press
                onPress={() => void chooseFolder()}
                disabled={picking()}
                hoverStyle={{ backgroundColor: colors.secondary }}
                style={{ height: 34, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <If when={picking()} else={<Icon name="folder" size={14} tint={colors.mutedText} />}>
                  <Spinner size={11} />
                </If>
                <Text style={{ fontSize: 12, color: colors.text }}>{picking() ? "Choosing…" : "Choose…"}</Text>
              </Press>
            </View>
            <If when={Boolean(addError())}>
              <Text style={{ fontSize: 11.5, lineHeight: 16, color: colors.danger }}>{addError()}</Text>
            </If>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 7, paddingTop: 2 }}>
            <Press
              onPress={() => {
                addOpen.set(false);
                addError.set(null);
              }}
              hoverStyle={{ backgroundColor: colors.secondary }}
              style={{ height: 32, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontSize: 12, color: colors.text }}>Cancel</Text>
            </Press>
            <Press
              onPress={() => void addProject()}
              hoverStyle={{ opacity: 0.88 }}
              style={{ height: 32, paddingHorizontal: 13, borderRadius: 8, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }}
            >
              <Text style={{ fontSize: 12, fontWeight: "500", color: colors.onPrimary }}>Add project</Text>
            </Press>
          </View>
          </View>
        </View>
      </If>
    );
  }

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        flexDirection: "row",
        backgroundColor: colors.background,
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
      }}
    >
      <If when={sidebarOpen()}>
        <Sidebar />
      </If>
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <Header />
        <View style={{ flex: 1, minHeight: 0 }}>
          <If
            when={booted()}
            else={
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 9 }}>
                <Spinner size={14} />
                <Text style={{ fontSize: 12, color: colors.faint }}>Looking for pi sessions…</Text>
              </View>
            }
          >
            <If when={!activeProject()} else={<If when={!chatOpen()} else={<Chat />}><NewChat /></If>}>
              <EmptyProject />
            </If>
          </If>
        </View>
      </View>
      <AddProjectDialog />
    </View>
  );
}

mount(App);
