import fs from "fs/promises";
import os from "os";
import path from "path";
import process from "process";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface SessionInfo {
  path: string;
  title: string;
  modified: number;
  mtimeMs?: number;
  size?: number;
}

export interface SessionHistory {
  messages: PiMessage[];
  model: { provider: string; id: string } | null;
  mtimeMs: number;
  size: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
}

export type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PiMessage = {
  id: string;
  role: string;
  content: string | ContentBlock[];
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
  [key: string]: unknown;
};

export type PiEvent = Record<string, unknown> & { type: string };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type ClientOptions = {
  projectPath: string;
  sessionPath?: string | null;
  noSession?: boolean;
  onEvent: (event: PiEvent) => void;
  onStderr?: (line: string) => void;
  onExit?: (code: number | null | undefined, detail?: string) => void;
};

const SESSION_VERSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");
type PiResolution = { executable: string; pathValue: string };
let piResolutionPromise: Promise<PiResolution> | null = null;

function projectName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const name = path.basename(trimmed);
  return name || value || "Project";
}

export function projectFromPath(value: string): ProjectInfo {
  return { path: value, name: projectName(value) };
}

function projectSessionDir(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, "");
  const flat = trimmed.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
  return path.join(SESSION_VERSION_ROOT, `--${flat}--`);
}

function uniqueDirs(values: string[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    dirs.push(value);
  }
  return dirs;
}

function nodeVersionParts(value: string): number[] {
  const parts = value.replace(/^v/, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  return parts.every(Number.isFinite) ? parts : [];
}

function compareNodeVersionsDescending(a: string, b: string): number {
  const left = nodeVersionParts(a);
  const right = nodeVersionParts(b);
  for (let index = 0; index < 3; index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference) return difference;
  }
  return b.localeCompare(a);
}

async function versionBinDirs(root: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareNodeVersionsDescending)
      .map((name) => path.join(root, name, suffix));
  } catch {
    return [];
  }
}

async function npmPrefixDir(home: string): Promise<string | null> {
  const configured = process.env.NPM_CONFIG_PREFIX;
  if (configured && path.isAbsolute(configured)) return configured;
  try {
    const text = await fs.readFile(path.join(home, ".npmrc"), "utf8");
    for (const line of text.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key?.trim() !== "prefix") continue;
      let value = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      if (value.startsWith("~/")) value = path.join(home, value.slice(2));
      if (path.isAbsolute(value)) return value;
    }
  } catch {}
  return null;
}

async function piCandidateDirs(): Promise<string[]> {
  const home = os.homedir();
  const bunRoot = process.env.BUN_INSTALL;
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(home, "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".npm", "bin"),
    bunRoot && path.isAbsolute(bunRoot) ? path.join(bunRoot, "bin") : path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, "Library", "pnpm"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".deno", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/local/bin",
    "/opt/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];

  const prefix = await npmPrefixDir(home);
  if (prefix) dirs.push(path.join(prefix, "bin"));

  const fnmRoots = uniqueDirs([
    process.env.FNM_DIR ?? "",
    path.join(home, ".local", "share", "fnm"),
    path.join(home, "Library", "Application Support", "fnm"),
  ]);
  for (const root of fnmRoots) {
    dirs.push(path.join(root, "aliases", "default", "bin"));
    dirs.push(...(await versionBinDirs(path.join(root, "node-versions"), path.join("installation", "bin"))));
  }

  const nvmRoots = uniqueDirs([process.env.NVM_DIR ?? "", path.join(home, ".nvm")]);
  for (const root of nvmRoots) {
    dirs.push(...(await versionBinDirs(path.join(root, "versions", "node"), "bin")));
  }

  dirs.push(...(await versionBinDirs(path.join(home, ".local", "share", "mise", "installs", "node"), "bin")));
  return uniqueDirs(dirs);
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() && (process.platform === "windows" || (stats.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function resolvePi(): Promise<PiResolution> {
  const names = process.platform === "windows" ? ["pi.exe", "pi.cmd"] : ["pi"];
  const dirs = await piCandidateDirs();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate)) return { executable: candidate, pathValue: dirs.join(path.delimiter) };
    }
  }
  throw new Error("pi was not found. Install pi or make its executable folder available to the app.");
}

function resolvedPi(): Promise<PiResolution> {
  if (!piResolutionPromise) {
    piResolutionPromise = resolvePi().then(
      (resolution) => resolution,
      (reason) => {
        piResolutionPromise = null;
        throw reason;
      },
    );
  }
  return piResolutionPromise;
}

export function cleanSessionTitle(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 96 ? text.slice(0, 95).trimEnd() + "…" : text;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is ContentBlock => Boolean(block) && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join(" ");
}

function parseLines(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value as Record<string, unknown>);
    } catch {
      // A session being appended to can end with a partial line.
    }
  }
  return records;
}

async function readSession(filePath: string, stats: { mtimeMs: number; size: number }): Promise<SessionInfo | null> {
  const text = await fs.readFile(filePath, "utf8");
  let isSession = false;
  let name = "";
  let firstMessage = "";
  for (const record of parseLines(text)) {
    if (record.type === "session") {
      isSession = true;
      continue;
    }
    if (record.type === "session_info" && typeof record.name === "string" && record.name.trim()) {
      name = record.name.trim();
    }
    if (record.type !== "message") continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (!firstMessage && message?.role === "user") firstMessage = cleanSessionTitle(textOfContent(message.content));
  }
  if (!isSession) return null;

  return { path: filePath, title: cleanSessionTitle(name || firstMessage || "New chat"), modified: stats.mtimeMs, mtimeMs: stats.mtimeMs, size: stats.size };
}

type ScannedSession = {
  mtimeMs: number;
  size: number;
  session: SessionInfo | null;
};

const sessionScanCache = new Map<string, ScannedSession>();

async function cachedSession(filePath: string, stats: { mtimeMs: number; size: number }): Promise<SessionInfo | null> {
  const cached = sessionScanCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.session;
  const session = await readSession(filePath, stats);
  if (sessionScanCache.size > 512) sessionScanCache.clear();
  sessionScanCache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, session });
  return session;
}

/** Reuses the sidebar a previous launch saved, so unchanged sessions are not parsed again. */
export function seedSessionCache(sessions: SessionInfo[]): void {
  for (const session of sessions) {
    if (typeof session.mtimeMs !== "number" || typeof session.size !== "number") continue;
    sessionScanCache.set(session.path, { mtimeMs: session.mtimeMs, size: session.size, session });
  }
}

export async function scanProjectSessions(cwd: string): Promise<SessionInfo[]> {
  const dir = projectSessionDir(cwd);
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return [];
    throw error;
  }
  const out: SessionInfo[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const stats = await fs.stat(filePath);
      const session = await cachedSession(filePath, stats);
      if (session) out.push(session);
    } catch {
      // One unreadable or still-empty session must not hide the others.
    }
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

export async function scanAllProjects(projects: ProjectInfo[]): Promise<Record<string, SessionInfo[]>> {
  const entries = await Promise.all(
    projects.map(async (project) => {
      try {
        return [project.path, await scanProjectSessions(project.path)] as const;
      } catch {
        return [project.path, [] as SessionInfo[]] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export async function discoverProjects(limit = 12): Promise<ProjectInfo[]> {
  let dirs: { name: string; isDirectory: () => boolean }[];
  try {
    dirs = await fs.readdir(SESSION_VERSION_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: { project: ProjectInfo; modified: number }[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(SESSION_VERSION_ROOT, dir.name);
    let files: { name: string; isDirectory: () => boolean }[];
    try {
      files = await fs.readdir(full, { withFileTypes: true });
    } catch {
      continue;
    }
    const candidates: { file: string; modified: number }[] = [];
    for (const file of files) {
      if (file.isDirectory() || !file.name.endsWith(".jsonl")) continue;
      const filePath = path.join(full, file.name);
      try {
        const stats = await fs.stat(filePath);
        candidates.push({ file: filePath, modified: stats.mtimeMs });
      } catch {
        // Skip it.
      }
    }
    candidates.sort((a, b) => b.modified - a.modified);
    for (const candidate of candidates) {
      try {
        const text = await fs.readFile(candidate.file, "utf8");
        const header = parseLines(text).find((record) => record.type === "session");
        if (header && typeof header.cwd === "string") {
          found.push({ project: projectFromPath(header.cwd), modified: candidate.modified });
          break;
        }
      } catch {
        // Try the next file in this project's directory.
      }
    }
  }
  found.sort((a, b) => b.modified - a.modified);
  const seen = new Set<string>();
  const projects: ProjectInfo[] = [];
  for (const item of found) {
    if (seen.has(item.project.path)) continue;
    seen.add(item.project.path);
    projects.push(item.project);
    if (projects.length >= limit) break;
  }
  return projects;
}

const HISTORY_TOOL_RESULT_LIMIT = 2000;
/** The session format this reader projects; newer formats come from pi itself. */
export const SUPPORTED_SESSION_VERSION = 3;

function timestampOf(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function sessionEntryMessages(entry: Record<string, unknown>): PiMessage[] {
  if (entry.type === "message") {
    const message = entry.message as PiMessage | undefined;
    if (!message || typeof message !== "object") return [];
    if (message.content == null) {
      if (message.role === "system") return [{ ...message, content: "" }];
      if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") return [{ ...message, content: [] }];
    }
    return [message];
  }
  if (entry.type === "custom_message") {
    return [
      {
        id: "",
        role: "custom",
        customType: entry.customType,
        content: (entry.content ?? []) as PiMessage["content"],
        display: entry.display,
        details: entry.details,
        timestamp: timestampOf(entry.timestamp),
      } as PiMessage,
    ];
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return [
      { id: "", role: "branchSummary", content: "", summary: entry.summary, fromId: entry.fromId, timestamp: timestampOf(entry.timestamp) } as PiMessage,
    ];
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    const summary = {
      id: "",
      role: "compactionSummary",
      content: "",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: timestampOf(entry.timestamp),
    } as PiMessage;
    const system = entry.systemMessage as PiMessage | undefined;
    return system ? [system, summary] : [summary];
  }
  return [];
}

function applyContextEdit(messages: PiMessage[], replacement: unknown): PiMessage[] {
  if (replacement === null) return [];
  const content = (replacement as { content?: unknown } | undefined)?.content;
  if (content === undefined) return messages;
  return messages.map((message) => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult" && message.role !== "custom") return message;
    const next = (message.role === "assistant" || message.role === "toolResult") && typeof content === "string" ? [{ type: "text", text: content }] : content;
    return { ...message, content: next as PiMessage["content"] };
  });
}

// The chat renders text, thinking and tool calls only: media and clipped tool
// output are dropped so large sessions stay small in memory.
function trimHistoryMessage(message: PiMessage): PiMessage {
  if (typeof message.content === "string") {
    if (message.role !== "toolResult" || message.content.length <= HISTORY_TOOL_RESULT_LIMIT) return message;
    return { ...message, content: `${message.content.slice(0, HISTORY_TOOL_RESULT_LIMIT)}…` };
  }
  if (!Array.isArray(message.content)) return message;
  let trimmed = false;
  const content = message.content.flatMap((block) => {
    if (block?.type === "image" || block?.type === "audio" || block?.type === "file") {
      trimmed = true;
      return [];
    }
    if (message.role !== "toolResult") return [block];
    if (block?.type !== "text") {
      trimmed = true;
      return [];
    }
    if (typeof block.text !== "string" || block.text.length <= HISTORY_TOOL_RESULT_LIMIT) return [block];
    trimmed = true;
    return [{ ...block, text: `${block.text.slice(0, HISTORY_TOOL_RESULT_LIMIT)}…` }];
  });
  return trimmed ? { ...message, content } : message;
}

/**
 * Reads a session file the way pi resumes it: the entries on the current leaf
 * path, with compaction and context edits applied. This keeps opening a chat
 * off the `pi` startup path while matching what `get_messages` would return.
 */
export async function loadSessionHistory(filePath: string): Promise<SessionHistory> {
  const [stats, text] = await Promise.all([fs.stat(filePath), fs.readFile(filePath, "utf8")]);
  const records = parseLines(text);
  const header = records.find((record) => record.type === "session");
  if (!header) {
    if (text.trim()) throw new Error("Not a pi session file.");
    return { messages: [], model: null, mtimeMs: stats.mtimeMs, size: stats.size };
  }
  const version = typeof header.version === "number" ? header.version : 1;
  if (version !== SUPPORTED_SESSION_VERSION) {
    throw new Error(`Unsupported pi session version ${version}; this build reads ${SUPPORTED_SESSION_VERSION}.`);
  }
  const entries = records.filter((record) => record.type !== "session");

  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }

  const path: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | undefined = entries[entries.length - 1];
  const visited = new Set<string>();
  while (current) {
    path.push(current);
    const id = typeof current.id === "string" ? current.id : undefined;
    if (id) {
      if (visited.has(id)) break;
      visited.add(id);
    }
    const parentId: string | undefined = typeof current.parentId === "string" ? current.parentId : undefined;
    current = parentId ? byId.get(parentId) : undefined;
  }
  path.reverse();

  let compaction: Record<string, unknown> | null = null;
  for (const entry of path) {
    if (entry.type === "compaction") compaction = entry;
  }
  let contextEntries = path;
  if (compaction) {
    const index = path.indexOf(compaction);
    const kept: Record<string, unknown>[] = [compaction];
    let foundFirstKept = false;
    for (let entryIndex = 0; entryIndex < index; entryIndex++) {
      const entry = path[entryIndex];
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept && !(entry.type === "message" && (entry.message as PiMessage | undefined)?.role === "system")) kept.push(entry);
    }
    kept.push(...path.slice(index + 1));
    contextEntries = kept;
  }

  const edits = new Map<string, unknown>();
  for (const entry of contextEntries) {
    if (entry.type === "context_edit" && typeof entry.targetId === "string") edits.set(entry.targetId, entry.replacement);
  }

  const history: PiMessage[] = [];
  contextEntries.forEach((entry, index) => {
    if (entry.type === "compaction" && index > 0) return;
    let messages = sessionEntryMessages(entry);
    const edit = typeof entry.id === "string" ? edits.get(entry.id) : undefined;
    if (edit !== undefined) messages = applyContextEdit(messages, edit);
    for (const message of messages) history.push(trimHistoryMessage(message));
  });
  const messages = history.map((message, index) => ({ ...message, id: `history-${index}-${message.timestamp ?? 0}` }));

  let model: SessionHistory["model"] = null;
  for (const entry of path) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      model = { provider: entry.provider, id: entry.modelId };
    } else if (entry.type === "message") {
      const message = entry.message as PiMessage | undefined;
      if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
        model = { provider: message.provider, id: message.model };
      }
    }
  }

  return { messages, model, mtimeMs: stats.mtimeMs, size: stats.size };
}

export class PiClient {
  private readonly options: ClientOptions;
  private child: ReturnType<typeof process.spawn> | null = null;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private closed = false;
  private expectedExit = false;
  private startPromise: Promise<void> | null = null;
  private launchPath = "";
  private outputTail: string[] = [];
  private exitReason: Error | null = null;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (!this.startPromise) this.startPromise = this.launch();
    return this.startPromise;
  }

  private async launch(): Promise<void> {
    if (process.platform === "web") {
      throw new Error("pi can only run in the native app");
    }
    const args = ["--mode", "rpc"];
    if (this.options.noSession) args.push("--no-session");
    else if (this.options.sessionPath) args.push("--session", this.options.sessionPath);

    const spawnOptions = {
      cwd: this.options.projectPath,
      stdin: "pipe",
      lines: true,
    } as const;
    const resolution = await resolvedPi();
    this.launchPath = resolution.executable;
    const child =
      process.platform === "windows"
        ? process.spawn(resolution.executable, args, spawnOptions)
        : process.spawn("env", [`PATH=${resolution.pathValue}`, resolution.executable, ...args], spawnOptions);
    if (this.expectedExit) {
      child.kill();
      return;
    }
    this.child = child;

    child.on("stdout", (line) => this.consume(line));
    child.on("stderr", (line) => {
      this.rememberOutput(line);
      this.options.onStderr?.(line);
    });
    child.on("exit", ({ code, signal, error }) => {
      this.closed = true;
      const status =
        code === null || code === undefined
          ? signal
            ? ` from signal ${signal}`
            : ""
          : ` with code ${code}`;
      const detail = [...this.outputTail, error ?? ""].filter((line) => line.trim()).join("\n");
      const reason = new Error(`pi at ${this.launchPath} exited${status}${detail ? `\n${detail}` : ""}`);
      this.exitReason = reason;
      for (const pending of this.pending.values()) pending.reject(reason);
      this.pending.clear();
      if (!this.expectedExit) this.options.onExit?.(code, detail);
    });
  }

  private rememberOutput(line: string): void {
    const text = line.trim();
    if (!text) return;
    this.outputTail.push(text);
    if (this.outputTail.length > 20) this.outputTail.shift();
  }

  private consume(line: string): void {
    const text = line.trim();
    if (!text.startsWith("{")) {
      this.rememberOutput(text);
      return;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.rememberOutput(text);
      return;
    }

    if (record.type === "response") {
      const id = typeof record.id === "string" ? record.id : undefined;
      if (!id) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (record.success === false) {
        pending.reject(new Error(typeof record.error === "string" ? record.error : "pi rejected the command"));
      } else {
        pending.resolve(record.data);
      }
      return;
    }

    if (record.type === "extension_ui_request") {
      const id = typeof record.id === "string" ? record.id : undefined;
      if (id) {
        this.child?.write(JSON.stringify({ type: "extension_ui_response", id, cancelled: true }) + "\n");
      }
      return;
    }

    this.options.onEvent(record as PiEvent);
  }

  request<T = unknown>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.exitReason ?? new Error("pi is not running"));
    if (!this.child) return Promise.reject(new Error("pi is not running"));
    const id = `req-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.child?.write(JSON.stringify({ id, type, ...data }) + "\n");
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.expectedExit = true;
    this.closed = true;
    if (!this.child) return;
    const error = new Error("pi was closed");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    try {
      this.child.end();
    } catch {
      // Already gone.
    }
    this.child.kill();
    this.child = null;
  }
}

export async function loadCatalog(): Promise<{ models: ModelInfo[]; defaultModel: ModelInfo | null }> {
  const client = new PiClient({
    projectPath: os.homedir(),
    noSession: true,
    onEvent: () => {},
  });
  try {
    await client.start();
    const state = await client.request<{ model?: ModelInfo }>("get_state");
    const available = await client.request<{ models?: ModelInfo[] }>("get_available_models");
    const models = Array.isArray(available?.models) ? available.models : [];
    return { models, defaultModel: state?.model ?? models[0] ?? null };
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    client.close();
  }
}
