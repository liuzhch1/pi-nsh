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
    "/usr/local/bin",
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

  async start(): Promise<void> {
    if (this.child) return;
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
    let child: ReturnType<typeof process.spawn>;
    try {
      child = process.spawn("pi", args, spawnOptions);
    } catch (reason) {
      if ((reason as { code?: string }).code !== "ENOENT") throw reason;
      const resolution = await resolvedPi();
      child = process.spawn("env", [`PATH=${resolution.pathValue}`, resolution.executable, ...args], spawnOptions);
    }
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
