import prisma from '@/lib/db'
import { fetchPage, parsePage, importTweets } from '@/lib/twitter-api'

// ── Sync ────────────────────────────────────────────────────────────────────────

export async function syncBookmarks(
  authToken: string,
  ct0: string,
): Promise<{ imported: number; skipped: number }> {
  if (scheduler.syncing) throw new Error('A sync is already in progress')
  scheduler.syncing = true

  try {
    let imported = 0
    let skipped = 0
    let cursor: string | undefined
    const MAX_PAGES = 50

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await fetchPage(authToken, ct0, cursor)
      const { tweets, nextCursor } = parsePage(data)

      // On the first page, verify the API response structure hasn't changed
      if (page === 0 && tweets.length === 0 && !nextCursor) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hasTimeline = (data as any)?.data?.bookmark_timeline_v2?.timeline
        if (!hasTimeline) {
          throw new Error('Twitter API response format has changed. The sync feature may need updating.')
        }
      }

      const result = await importTweets(tweets)
      imported += result.imported
      skipped += result.skipped

      if (!nextCursor || tweets.length === 0) break
      cursor = nextCursor

      if (page === MAX_PAGES - 1) {
        console.warn(`[x-sync] Hit max page limit (${MAX_PAGES}), stopping pagination`)
      }
    }

    const now = new Date().toISOString()
    await Promise.all([
      prisma.setting.upsert({
        where: { key: 'x_last_sync' },
        update: { value: now },
        create: { key: 'x_last_sync', value: now },
      }),
      prisma.setting.deleteMany({ where: { key: 'x_sync_error' } }),
    ])

    return { imported, skipped }
  } finally {
    scheduler.syncing = false
  }
}

// ── Schedule ────────────────────────────────────────────────────────────────────

export const SYNC_INTERVALS = ['off', '1h', '4h', '8h', '24h'] as const

export type SyncInterval = (typeof SYNC_INTERVALS)[number]

export type SyncError = { message: string; at: string; kind: 'auth' | 'transient' }

export type ScheduleSnapshot = {
  interval: SyncInterval
  hasCredentials: boolean
  lastSyncAt: Date | null
  lastError: SyncError | null
}

export type ScheduleState =
  | { kind: 'off' }
  | { kind: 'no-credentials' }
  | { kind: 'due' }
  | { kind: 'waiting'; nextDueAt: Date }

const INTERVAL_MS: Record<Exclude<SyncInterval, 'off'>, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

export function isSyncInterval(value: unknown): value is SyncInterval {
  return typeof value === 'string' && (SYNC_INTERVALS as readonly string[]).includes(value)
}

export function parseSyncError(raw: string | null | undefined): SyncError | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { message, at, kind } = parsed as Record<string, unknown>
    if (typeof message !== 'string' || typeof at !== 'string') return null
    if (kind !== 'auth' && kind !== 'transient') return null
    return { message, at, kind }
  } catch {
    return null
  }
}

export function evaluateSchedule(snapshot: ScheduleSnapshot, now: Date): ScheduleState {
  const { interval, hasCredentials, lastSyncAt, lastError } = snapshot

  if (interval === 'off') return { kind: 'off' }
  if (!hasCredentials) return { kind: 'no-credentials' }
  if (!lastSyncAt) return { kind: 'due' }

  let since = lastSyncAt.getTime()
  if (lastError?.kind === 'auth') {
    const erroredAt = new Date(lastError.at).getTime()
    if (Number.isFinite(erroredAt)) since = Math.max(since, erroredAt)
  }

  const dueAt = new Date(since + INTERVAL_MS[interval])
  return now.getTime() >= dueAt.getTime() ? { kind: 'due' } : { kind: 'waiting', nextDueAt: dueAt }
}

const SCHEDULE_KEYS = ['x_auth_token', 'x_ct0', 'x_sync_interval', 'x_last_sync', 'x_sync_error']

async function readSchedule(): Promise<{
  snapshot: ScheduleSnapshot
  credentials: { authToken: string; ct0: string } | null
}> {
  const rows = await prisma.setting.findMany({ where: { key: { in: SCHEDULE_KEYS } } })
  const value = (key: string) => rows.find((row) => row.key === key)?.value || null

  const authToken = value('x_auth_token')
  const ct0 = value('x_ct0')
  const interval = value('x_sync_interval')
  const lastSync = value('x_last_sync')
  const lastSyncAt = lastSync ? new Date(lastSync) : null

  return {
    credentials: authToken && ct0 ? { authToken, ct0 } : null,
    snapshot: {
      interval: isSyncInterval(interval) ? interval : 'off',
      hasCredentials: !!(authToken && ct0),
      lastSyncAt: lastSyncAt && Number.isFinite(lastSyncAt.getTime()) ? lastSyncAt : null,
      lastError: parseSyncError(value('x_sync_error')),
    },
  }
}

export async function readScheduleSnapshot(): Promise<ScheduleSnapshot> {
  return (await readSchedule()).snapshot
}

// ── Scheduler ───────────────────────────────────────────────────────────────────

const TICK_MS = 15 * 60 * 1000

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null
  syncing: boolean
  lastIdleLog: string | null
}

// Pinned to globalThis, like the PrismaClient in lib/db, because Next bundles this module into
// several server chunks. Plain module-level state would give instrumentation.ts and the route
// handlers a timer and a `syncing` flag each, within one process. `isSchedulerRunning()` would
// not see the timer armed at boot, and two tickers could sync concurrently.
const scheduler = ((globalThis as unknown as { xSyncScheduler?: SchedulerState }).xSyncScheduler ??= {
  timer: null,
  syncing: false,
  lastIdleLog: null,
})

export function startScheduler() {
  stopScheduler()
  scheduler.timer = setInterval(() => void runTick(), TICK_MS)
  console.log(`[x-sync] Scheduler armed, ticking every ${TICK_MS / 60_000}m`)
  void runTick()
}

export function stopScheduler() {
  if (scheduler.timer) {
    clearInterval(scheduler.timer)
    scheduler.timer = null
    scheduler.lastIdleLog = null
    console.log('[x-sync] Scheduler stopped')
  }
}

async function runTick() {
  if (scheduler.syncing) return

  try {
    const { snapshot, credentials } = await readSchedule()
    const state = evaluateSchedule(snapshot, new Date())

    if (state.kind !== 'due') {
      const idle =
        state.kind === 'waiting'
          ? `next sync due at ${state.nextDueAt.toISOString()}`
          : state.kind === 'off'
            ? 'auto-sync is off'
            : 'auto-sync is on but X credentials are missing'
      if (idle !== scheduler.lastIdleLog) {
        scheduler.lastIdleLog = idle
        console.log(`[x-sync] ${idle}`)
      }
      return
    }
    if (!credentials) return
    scheduler.lastIdleLog = null

    try {
      const { imported, skipped } = await syncBookmarks(credentials.authToken, credentials.ct0)
      console.log(`[x-sync] Sync complete: ${imported} imported, ${skipped} skipped`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Losing a race with a manual sync is contention, not a sync failure worth recording.
      if (message.includes('already in progress')) return
      const kind: SyncError['kind'] =
        message.includes('401') || message.includes('403') ? 'auth' : 'transient'
      console.error(`[x-sync] Sync failed (${kind}): ${message}`)
      const record = JSON.stringify({ message, at: new Date().toISOString(), kind } satisfies SyncError)
      await prisma.setting.upsert({
        where: { key: 'x_sync_error' },
        update: { value: record },
        create: { key: 'x_sync_error', value: record },
      })
    }
  } catch (err) {
    console.error('[x-sync] Scheduler tick failed:', err instanceof Error ? err.message : String(err))
  }
}

export function isSchedulerRunning() {
  return scheduler.timer !== null
}

export function isSyncing() {
  return scheduler.syncing
}
