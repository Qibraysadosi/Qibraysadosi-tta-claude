// Rejali vazifalar: har 30 soniyada muddati kelganlarni alohida sessiyada (so'ralmaydigan rejimda) bajaradi.
import type { Schedule, ScheduleSpec } from '../shared/protocol.js';
import type { Service } from './service.js';

function tzParts(date: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; wd: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const wdMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, wd: wdMap[p.weekday] ?? 1 };
}

function tzOffsetMs(date: Date, tz: string): number {
  const p = tzParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, 0);
  const truncated = Math.floor(date.getTime() / 60000) * 60000;
  return asUtc - truncated;
}

/** Berilgan zonadagi (y, m, d, hh:mm) ni epoch ms ga aylantiradi. */
export function zonedToEpoch(y: number, m: number, d: number, hh: number, mm: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  return guess - tzOffsetMs(new Date(guess), tz);
}

export function computeNextRun(spec: ScheduleSpec, now: number, tz: string): number | null {
  if (spec.kind === 'once') return spec.at > now ? spec.at : null;
  if (spec.kind === 'interval') return now + spec.minutes * 60_000;
  const [hh, mm] = spec.time.split(':').map(Number);
  const p = tzParts(new Date(now), tz);
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const at = zonedToEpoch(y, m, d, hh, mm, tz);
    if (at <= now) continue;
    if (spec.kind === 'weekly') {
      const wd = tzParts(new Date(at), tz).wd;
      if (!spec.days.includes(wd)) continue;
    }
    return at;
  }
  return null;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  constructor(private service: Service) {}

  start(): void {
    this.stop();
    for (const s of this.service.store.schedules.all()) {
      if (s.enabled && s.next_run === null) this.service.store.schedules.update(s.id, { next_run: computeNextRun(s.spec, Date.now(), this.service.config.timezone) });
    }
    this.timer = setInterval(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const now = Date.now();
    for (const s of this.service.store.schedules.all()) {
      if (!s.enabled || s.next_run === null || s.next_run > now || this.running.has(s.id)) continue;
      void this.run(s);
    }
  }

  async run(s: Schedule): Promise<string> {
    this.running.add(s.id);
    const service = this.service;
    const user = service.store.users.get(s.user_id);
    let sessionId = '';
    try {
      if (!user || !user.active) throw new Error('foydalanuvchi faol emas');
      if (!service.config.apiKey) throw new Error('API kalit yo\'q');
      const session = service.createSession(user, { project_id: s.project_id, model: s.model, mode: s.mode, title: `⏰ ${s.title}`, origin: 'schedule' });
      sessionId = session.id;
      const runner = service.runnerFor(user, session.id);
      runner.headless = { maxBudgetUsd: s.max_budget_usd, maxTurns: 60 };
      const now = new Date();
      const stamp = now.toLocaleString('uz-UZ', { timeZone: service.config.timezone });
      await runner.send(`[Rejali vazifa: ${s.title} — ${stamp}]\n\n${s.prompt}`, [], 'schedule');
      await runner.waitIdle(55 * 60_000);
      await service.closeRunner(session.id, 'schedule-done');
      service.store.schedules.update(s.id, { last_run: Date.now(), last_session_id: session.id, last_status: runner.lastResultOk ? 'ok' : 'error', next_run: this.nextAfterRun(s) });
    } catch (e) {
      service.log('[scheduler] xato', s.id, e);
      service.store.schedules.update(s.id, { last_run: Date.now(), last_session_id: sessionId || null, last_status: 'error', next_run: this.nextAfterRun(s) });
    } finally {
      this.running.delete(s.id);
    }
    return sessionId;
  }

  private nextAfterRun(s: Schedule): number | null {
    if (s.spec.kind === 'once') return null;
    return computeNextRun(s.spec, Date.now(), this.service.config.timezone);
  }
}
