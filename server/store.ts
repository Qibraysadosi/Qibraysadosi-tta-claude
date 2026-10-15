// Oddiy JSON ombor: har to'plam DATA_DIR/db/<nom>.json faylida, atomik yoziladi.
// Hajm kichik (foydalanuvchilar, loyihalar, suhbatlar indeksi), shuning uchun baza kerak emas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentDef, Project, Schedule, SessionInfo, UserPublic } from '../shared/protocol.js';

export interface UserRecord extends UserPublic {
  pass_hash: string; // scrypt: salt$hash
  must_change_password: boolean;
}

export interface UsageRecord {
  ts: number;
  user_id: string;
  session_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export function newId(prefix = ''): string {
  return prefix + crypto.randomBytes(8).toString('hex');
}

class Collection<T extends { id: string }> {
  private items = new Map<string, T>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  constructor(private file: string) {
    this.load();
  }
  private load(): void {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf8')) as T[];
      for (const it of arr) this.items.set(it.id, it);
    } catch {
      /* yangi to'plam */
    }
  }
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  private schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (e) {
        console.error('[store] yozishda xato', this.file, e);
      }
    }, 150);
  }
  get(id: string): T | undefined {
    return this.items.get(id);
  }
  all(): T[] {
    return [...this.items.values()];
  }
  find(pred: (t: T) => boolean): T[] {
    return this.all().filter(pred);
  }
  put(item: T): T {
    this.items.set(item.id, item);
    this.schedule();
    return item;
  }
  update(id: string, patch: Partial<T>): T | undefined {
    const cur = this.items.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    this.items.set(id, next);
    this.schedule();
    return next;
  }
  delete(id: string): boolean {
    const ok = this.items.delete(id);
    if (ok) this.schedule();
    return ok;
  }
  get size(): number {
    return this.items.size;
  }
}

export class Store {
  users: Collection<UserRecord>;
  projects: Collection<Project>;
  sessions: Collection<SessionInfo>;
  agents: Collection<AgentDef>;
  schedules: Collection<Schedule>;
  private usageFile: string;

  constructor(public dataDir: string) {
    const db = path.join(dataDir, 'db');
    fs.mkdirSync(db, { recursive: true });
    this.users = new Collection<UserRecord>(path.join(db, 'users.json'));
    this.projects = new Collection<Project>(path.join(db, 'projects.json'));
    this.sessions = new Collection<SessionInfo>(path.join(db, 'sessions.json'));
    this.agents = new Collection<AgentDef>(path.join(db, 'agents.json'));
    this.schedules = new Collection<Schedule>(path.join(db, 'schedules.json'));
    this.usageFile = path.join(db, 'usage.jsonl');
  }

  flushAll(): void {
    for (const c of [this.users, this.projects, this.sessions, this.agents, this.schedules]) c.flush();
  }

  addUsage(rec: UsageRecord): void {
    fs.appendFileSync(this.usageFile, JSON.stringify(rec) + '\n');
  }

  readUsage(since: number): UsageRecord[] {
    try {
      const out: UsageRecord[] = [];
      for (const line of fs.readFileSync(this.usageFile, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (r.ts >= since) out.push(r);
        } catch {
          /* buzilgan qator */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  userByLogin(login: string): UserRecord | undefined {
    const l = login.trim().toLowerCase();
    return this.users.all().find((u) => u.login.toLowerCase() === l);
  }
}

export function publicUser(u: UserRecord): UserPublic {
  const { pass_hash: _p, ...rest } = u;
  return rest;
}
