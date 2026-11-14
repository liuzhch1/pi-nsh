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
  onExit?: (code: number | null | undefined) => void;
};

const SESSION_VERSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");

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

function cleanTitle(value: string): string {
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

async function readSession(filePath: string, modified: number): Promise<SessionInfo | null> {
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
    if (!firstMessage && message?.role === "user") firstMessage = cleanTitle(textOfContent(message.content));
  }
  if (!isSession) return null;

  return { path: filePath, title: cleanTitle(name || firstMessage || "New chat"), modified };
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
      const session = await readSession(filePath, stats.mtimeMs);
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
  const home = os.homedir();
  const projects: ProjectInfo[] = [];
  for (const item of found) {
    if (item.project.path === home) continue;
    if (seen.has(item.project.path)) continue;
    seen.add(item.project.path);
    projects.push(item.project);
    if (projects.length >= limit) break;
  }
  return projects;
}

export class PiClient {
  private readonly options: ClientOptions;
  private child: ReturnType<typeof process.spawn> | null = null;
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private closed = false;
  private expectedExit = false;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  start(): void {
    if (this.child) return;
    if (process.platform === "web") {
      throw new Error("pi can only run in the native app");
    }
    const args = ["--mode", "rpc"];
    if (this.options.noSession) args.push("--no-session");
    else if (this.options.sessionPath) args.push("--session", this.options.sessionPath);

    const child = process.spawn("/bin/zsh", ["-lc", 'exec pi "$@"', "pi-nsh", ...args], {
      cwd: this.options.projectPath,
      stdin: "pipe",
      lines: true,
    });
    this.child = child;

    child.on("stdout", (line) => this.consume(line));
    child.on("stderr", (line) => this.options.onStderr?.(line));
    child.on("exit", ({ code }) => {
      this.closed = true;
      const error = new Error(`pi exited${code === null || code === undefined ? "" : ` with code ${code}`}`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      if (!this.expectedExit) this.options.onExit?.(code);
    });
  }

  private consume(line: string): void {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(text) as Record<string, unknown>;
    } catch {
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
    if (this.closed || !this.child) return Promise.reject(new Error("pi is not running"));
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
    if (!this.child) return;
    this.expectedExit = true;
    this.closed = true;
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
    client.start();
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
