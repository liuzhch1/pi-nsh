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
  Storage,
  Text,
  type InputRef,
  View,
  type ViewRef,
} from "nsh";
import { ContextMenu, Input, MenuItem, MenuSeparator, Popover, TextView } from "nsh/base";
import fs from "fs/promises";
import os from "os";
import path from "path";
import process from "process";
import { Icon } from "./icons";
import {
  discoverProjects,
  loadCatalog,
  type ContentBlock,
  type ModelInfo,
  type PiEvent,
  PiClient,
  type PiMessage,
  projectFromPath,
  type ProjectInfo,
  scanAllProjects,
  scanProjectSessions,
  type SessionInfo,
} from "./pi";
import { colors, content as contentMetrics, Press, roundButtonStyle, sidebar as sidebarMetrics, Spinner } from "./ui";

const PROJECTS_KEY = "pi-nsh.projects.v1";
const VISIBLE_SESSIONS = 5;

type ToolRun = {
  args?: Record<string, unknown>;
  running: boolean;
  result?: string;
  isError?: boolean;
  durationMs?: number;
};

let messageSequence = 0;

function newMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++messageSequence}`;
}

function modelKeyOf(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
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

function oneLine(value: string, limit = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
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
  const expandedProjects = signal<Set<string>>(new Set());
  const showAllSessions = signal<Set<string>>(new Set());
  const activeProject = signal<string | null>(null);
  const activeSession = signal<string | null>(null);
  const messages = signal<PiMessage[]>([]);
  const toolRuns = signal<Record<string, ToolRun>>({});
  const collapsed = signal<Set<string>>(new Set());
  const expandedBlocks = signal<Set<string>>(new Set());
  const running = signal(false);
  const loading = signal(false);
  const booted = signal(false);
  const error = signal<string | null>(null);
  const status = signal<string | null>(null);
  const draft = signal("");
  const inputHeight = signal(22);
  const models = signal<ModelInfo[]>([]);
  const modelKey = signal<string | null>(null);
  const modelChosen = signal(false);
  const modelOpen = signal(false);
  const liveId = signal<string | null>(null);
  const addOpen = signal(false);
  const addPath = signal("");
  const addError = signal<string | null>(null);
  const picking = signal(false);
  const piIssue = signal<string | null>(null);

  let client: PiClient | null = null;
  let clientGeneration = 0;
  let pendingUserId: string | null = null;
  let liveAssistantId: string | null = null;
  let openMessageId: string | null = null;
  let composerInput: InputRef | undefined;
  let addCardRef: ViewRef | undefined;
  let lastStderr = "";

  const currentModel = computed(() => {
    const key = modelKey();
    if (!key) return models()[0] ?? null;
    return models().find((model) => modelKeyOf(model) === key) ?? null;
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
      error.set(`Could not save projects: ${errorText(reason)}`);
    }
  };

  const applyModel = (model: ModelInfo | null | undefined) => {
    if (!model?.provider || !model.id) return;
    const key = modelKeyOf(model);
    modelKey.set(key);
    models.update((list) => (list.some((item) => modelKeyOf(item) === key) ? list : [...list, model]));
  };

  const collapseAllWork = () => {
    const keys = buildTimeline(messages())
      .filter((item): item is TurnDisplay => item.kind === "turn" && item.messages.some((message) => hasWork(message)))
      .map((item) => item.key);
    if (!keys.length) return;
    collapsed.update((set) => {
      const next = new Set(set);
      for (const key of keys) next.add(key);
      return next;
    });
    expandedBlocks.set(new Set());
  };

  const refreshProject = async (projectPath: string) => {
    try {
      const list = await scanProjectSessions(projectPath);
      sessions.update((current) => ({ ...current, [projectPath]: list }));
    } catch {
      // Keep what is already shown.
    }
  };

  const handleEvent = (event: PiEvent, generation: number) => {
    if (generation !== clientGeneration) return;

    switch (event.type) {
      case "agent_start":
      case "turn_start": {
        running.set(true);
        status.set(null);
        break;
      }
      case "message_start": {
        const raw = event.message as PiMessage | undefined;
        if (!raw) break;
        if (raw.role === "user" && pendingUserId) {
          const id = pendingUserId;
          openMessageId = id;
          messages.update((list) => list.map((message) => (message.id === id ? { ...raw, id } : message)));
          pendingUserId = null;
        } else {
          const id = newMessageId(raw.role === "assistant" ? "assistant" : raw.role);
          openMessageId = id;
          if (raw.role === "assistant") {
            liveAssistantId = id;
            liveId.set(id);
          }
          messages.update((list) => [...list, { ...raw, id }]);
        }
        break;
      }
      case "message_update": {
        if (!liveAssistantId) break;
        const update = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
        const id = liveAssistantId;
        messages.update((list) =>
          list.map((message) => (message.id === id ? { ...message, content: applyAssistantDelta(contentBlocks(message.content), update) } : message)),
        );
        break;
      }
      case "message_end": {
        const raw = event.message as PiMessage | undefined;
        if (!raw) break;
        const id = openMessageId ?? newMessageId(raw.role);
        let found = false;
        messages.update((list) =>
          list.map((message) => {
            if (message.id !== id) return message;
            found = true;
            return { ...raw, id };
          }),
        );
        if (!found) messages.update((list) => [...list, { ...raw, id }]);
        if (raw.role === "assistant") {
          liveAssistantId = null;
          liveId.set(null);
        }
        openMessageId = null;
        break;
      }
      case "tool_execution_start": {
        const id = String(event.toolCallId ?? "");
        if (!id) break;
        toolRuns.update((runs) => ({
          ...runs,
          [id]: {
            ...runs[id],
            args: (event.args as Record<string, unknown> | undefined) ?? runs[id]?.args,
            running: true,
          },
        }));
        break;
      }
      case "tool_execution_update": {
        const id = String(event.toolCallId ?? "");
        if (!id) break;
        const partial = event.partialResult as { content?: unknown } | undefined;
        toolRuns.update((runs) => ({
          ...runs,
          [id]: { ...runs[id], running: true, result: textOfContent(partial?.content) },
        }));
        break;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        if (!id) break;
        const result = event.result as { content?: unknown } | undefined;
        toolRuns.update((runs) => ({
          ...runs,
          [id]: {
            ...runs[id],
            running: false,
            result: textOfContent(result?.content),
            isError: event.isError === true,
            durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
          },
        }));
        break;
      }
      case "agent_settled": {
        running.set(false);
        liveId.set(null);
        liveAssistantId = null;
        status.set(null);
        collapseAllWork();
        const projectPath = activeProject();
        if (projectPath) void refreshProject(projectPath);
        break;
      }
      case "auto_retry_start": {
        status.set(`Retrying · attempt ${String(event.attempt ?? "?")}${event.maxAttempts ? ` of ${String(event.maxAttempts)}` : ""}`);
        break;
      }
      case "auto_retry_end": {
        status.set(event.success === false ? `Retry failed: ${String(event.finalError ?? "unknown error")}` : null);
        break;
      }
      case "compaction_start": {
        status.set("Compacting context…");
        break;
      }
      case "compaction_end": {
        status.set(event.errorMessage ? `Compaction failed: ${String(event.errorMessage)}` : null);
        break;
      }
      case "session_info_changed": {
        const projectPath = activeProject();
        if (projectPath) void refreshProject(projectPath);
        break;
      }
      default:
        break;
    }
  };

  const dropClient = () => {
    if (client) {
      client.close();
      client = null;
    }
  };

  const resetChat = () => {
    clientGeneration++;
    dropClient();
    messages.set([]);
    toolRuns.set({});
    collapsed.set(new Set());
    expandedBlocks.set(new Set());
    running.set(false);
    loading.set(false);
    status.set(null);
    error.set(null);
    modelOpen.set(false);
    liveId.set(null);
    liveAssistantId = null;
    openMessageId = null;
    pendingUserId = null;
    draft.set("");
    inputHeight.set(22);
  };

  const startClient = (projectPath: string, sessionPath: string | null, generation: number): PiClient => {
    lastStderr = "";
    const next = new PiClient({
      projectPath,
      sessionPath,
      onEvent: (event) => handleEvent(event, generation),
      onStderr: (line) => {
        if (line.trim()) lastStderr = line.trim();
      },
      onExit: () => {
        if (generation !== clientGeneration) return;
        running.set(false);
        loading.set(false);
        liveId.set(null);
        error.set(lastStderr || "pi stopped unexpectedly.");
      },
    });
    next.start();
    client = next;
    return next;
  };

  const refreshMany = async (list: ProjectInfo[]) => {
    sessions.set(await scanAllProjects(list));
  };

  const openExistingSession = async (projectPath: string, sessionPath: string) => {
    resetChat();
    const generation = clientGeneration;
    activeProject.set(projectPath);
    activeSession.set(sessionPath);
    expandedProjects.update((set) => withSetValue(set, projectPath, true));
    modelChosen.set(false);
    loading.set(true);
    try {
      const started = startClient(projectPath, sessionPath, generation);
      const state = await started.request<{ model?: ModelInfo }>("get_state");
      if (generation !== clientGeneration) return;
      applyModel(state?.model);
      const data = await started.request<{ messages?: PiMessage[] }>("get_messages");
      if (generation !== clientGeneration) return;
      const history = (data?.messages ?? []).map((message, index) => ({ ...message, id: `history-${index}-${message.timestamp ?? 0}` }));
      messages.set(history);
      collapsed.set(new Set(history.filter((message) => hasWork(message)).map((message) => message.id)));
    } catch (reason) {
      if (generation === clientGeneration) error.set(errorText(reason));
    } finally {
      if (generation === clientGeneration) loading.set(false);
    }
  };

  const newChat = (projectPath?: string | null) => {
    resetChat();
    if (projectPath) {
      activeProject.set(projectPath);
      expandedProjects.update((set) => withSetValue(set, projectPath, true));
    }
    activeSession.set(null);
  };

  const send = async () => {
    const text = draft().trim();
    const projectPath = activeProject();
    if (!text || running()) return;
    modelOpen.set(false);
    if (!projectPath) {
      addOpen.set(true);
      return;
    }

    const requestedModel = modelChosen() ? currentModel() : null;
    error.set(null);
    status.set(null);
    draft.set("");
    inputHeight.set(22);
    const localId = newMessageId("local");
    pendingUserId = localId;
    messages.update((list) => [...list, { id: localId, role: "user", content: text, timestamp: Date.now() }]);
    running.set(true);
    try {
      if (!client) {
        const generation = ++clientGeneration;
        loading.set(true);
        const started = startClient(projectPath, activeSession(), generation);
        const state = await started.request<{ sessionFile?: string; model?: ModelInfo }>("get_state");
        if (generation !== clientGeneration) return;
        if (state?.sessionFile && !activeSession()) {
          activeSession.set(state.sessionFile);
          void refreshProject(projectPath);
        }
        applyModel(state?.model);
        if (requestedModel && state?.model && modelKeyOf(requestedModel) !== modelKeyOf(state.model)) {
          await started.request("set_model", { provider: requestedModel.provider, modelId: requestedModel.id });
          applyModel(requestedModel);
        }
        loading.set(false);
      }
      await client?.request("prompt", { message: text });
    } catch (reason) {
      error.set(errorText(reason));
      running.set(false);
      loading.set(false);
      pendingUserId = null;
      messages.update((list) => list.filter((message) => message.id !== localId));
      draft.set(text);
    }
  };

  const stop = async () => {
    if (!client || !running()) return;
    status.set("Stopping…");
    try {
      await client.request("abort");
    } catch (reason) {
      error.set(errorText(reason));
    } finally {
      running.set(false);
      status.set(null);
      liveId.set(null);
    }
  };

  const chooseModel = async (value: string | null) => {
    if (!value) return;
    const previous = modelKey();
    modelKey.set(value);
    modelChosen.set(true);
    const model = models().find((item) => modelKeyOf(item) === value);
    if (model && client) {
      try {
        await client.request("set_model", { provider: model.provider, modelId: model.id });
      } catch (reason) {
        modelKey.set(previous);
        error.set(errorText(reason));
      }
    }
  };

  const toggleCollapsed = (id: string) => {
    collapsed.update((set) => withSetValue(set, id, !set.has(id)));
  };

  const toggleProject = (projectPath: string) => {
    expandedProjects.update((set) => withSetValue(set, projectPath, !set.has(projectPath)));
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
    sessions.update((current) => {
      const copy = { ...current };
      delete copy[projectPath];
      return copy;
    });
    await persistProjects(next);
    if (activeProject() === projectPath) {
      activeProject.set(null);
      activeSession.set(null);
      resetChat();
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
      list = list.filter((item) => item.path !== os.homedir());
      projects.set(list);
      await refreshMany(list);
      if (list.length) {
        activeProject.set(list[0].path);
        expandedProjects.set(new Set(list.map((project) => project.path)));
      }
    } catch (reason) {
      error.set(errorText(reason));
    } finally {
      booted.set(true);
    }
  };

  void boot();
  (async () => {
    try {
      const catalog = await loadCatalog();
      models.set(catalog.models);
      if (catalog.defaultModel) applyModel(catalog.defaultModel);
      piIssue.set(null);
    } catch (reason) {
      piIssue.set(errorText(reason));
    }
  })();

  cleanup(() => {
    clientGeneration++;
    dropClient();
  });

  effect(() => {
    if (addOpen()) addCardRef?.focus();
  });

  cleanup(
    keymap.bind("escape", () => {
      if (!addOpen()) return;
      addOpen.set(false);
      addError.set(null);
    }),
  );

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
              {(session) => (
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
                  <Text
                    style={{
                      width: "100%",
                      numberOfLines: 1,
                      textOverflow: "ellipsis",
                      fontSize: 12.5,
                      color: activeSession() === session().path ? colors.text : colors.mutedText,
                      fontWeight: activeSession() === session().path ? "500" : "400",
                    }}
                  >
                    {session().title}
                  </Text>
                </Press>
              )}
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
          paddingHorizontal: 22,
          gap: 10,
        }}
      >
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
    const toggle = () => expandedBlocks.update((set) => withSetValue(set, props.blockKey(), !expanded()));
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
          onPress={() => expandedBlocks.update((set) => withSetValue(set, block().key, !expanded()))}
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
              if (!nextOpen) expandedBlocks.set(new Set());
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

  function MessageRow(props: { message: () => PiMessage }) {
    const message = props.message;
    const role = computed(() => message().role);
    const text = computed(() => textOfContent(message().content));

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
            <Text style={{ fontFamily: "Menlo", fontSize: 11.5, color: colors.text, userSelect: "text" }}>{String(message().command ?? "")}</Text>
          </View>
        </View>
      );
    }

    if (role() === "user") {
      return (
        <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 8 }}>
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

  function TurnRow(props: { item: () => TurnDisplay }) {
    const item = props.item;
    const turnMessages = computed(() => item().messages);
    const turnKey = computed(() => item().key);
    const text = computed(() =>
      turnMessages()
        .map((message) => assistantText(message))
        .filter(Boolean)
        .join("\n\n"),
    );
    const hasDetails = computed(() => turnMessages().some((message) => hasWork(message)));
    const live = computed(() => turnMessages().some((message) => message.id === liveId()));
    const error = computed(() => {
      for (let index = turnMessages().length - 1; index >= 0; index--) {
        const message = turnMessages()[index];
        if (message.stopReason !== "error" && message.stopReason !== "aborted") continue;
        return String(message.errorMessage ?? (message.stopReason === "aborted" ? "Stopped" : "pi could not finish this response."));
      }
      return "";
    });

    return (
      <View style={{ width: "100%", maxWidth: contentMetrics.maxWidth, alignSelf: "center", paddingHorizontal: contentMetrics.padding, paddingVertical: 8, gap: 9 }}>
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
      </View>
    );
  }

  function TimelineRow(props: { item: () => DisplayItem }) {
    const item = props.item;
    const kind = computed(() => item().kind);
    if (kind() === "user") return <MessageRow message={() => (item() as UserDisplay).message} />;
    if (kind() === "turn") return <TurnRow item={() => item() as TurnDisplay} />;
    return <MessageRow message={() => (item() as NoteDisplay).message} />;
  }

  function ModelPicker() {
    const title = computed(() => {
      const model = currentModel();
      return model?.name || model?.id || "Choose model";
    });
    return (
      <Popover
        open={modelOpen()}
        onOpenChange={({ open }) => modelOpen.set(open)}
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
                        <Text style={{ flex: 1, numberOfLines: 1, textOverflow: "ellipsis", fontSize: 12.5, color: colors.text, fontWeight: modelKeyOf(model()) === modelKey() ? "500" : "400" }}>
                          {model().name || model().id}
                        </Text>
                        <If when={modelKeyOf(model()) === modelKey()}>
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
                onFocus={() => modelOpen.set(false)}
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
              <If when={modelOpen()}>
                <View
                  onPress={() => {
                    modelOpen.set(false);
                    composerInput?.focus();
                  }}
                  style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
                />
              </If>
            </View>
            <View style={{ height: 30, flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 2 }}>
              <ModelPicker />
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
        <If
          when={loading() && messages().length === 0}
          else={
            <List
              each={displayItems()}
              keyExtractor={(item) => item.id}
              estimatedItemSize={180}
              alignment="bottom"
              initialScrollAtEnd
              maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 90 }}
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
      <Sidebar />
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
            <If when={!activeProject()} else={<If when={!activeSession()} else={<Chat />}><NewChat /></If>}>
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
