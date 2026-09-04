import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import {
  SYNC_INTERVALS,
  evaluateSchedule,
  isSchedulerRunning,
  isSyncInterval,
  readScheduleSnapshot,
  startScheduler,
  stopScheduler,
} from '@/lib/x-sync'

/** GET — return current X credentials status + schedule config */
export async function GET() {
  try {
    const snapshot = await readScheduleSnapshot()
    const state = evaluateSchedule(snapshot, new Date())

    return NextResponse.json({
      hasCredentials: snapshot.hasCredentials,
      syncInterval: snapshot.interval,
      lastSync: snapshot.lastSyncAt?.toISOString() ?? null,
      schedulerRunning: isSchedulerRunning(),
      nextSyncAt: state.kind === 'waiting' ? state.nextDueAt.toISOString() : null,
      syncError: snapshot.lastError,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load config' },
      { status: 500 },
    )
  }
}

/** POST — save X credentials + optional sync interval */
export async function POST(request: NextRequest) {
  let body: { authToken?: string; ct0?: string; syncInterval?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { authToken, ct0, syncInterval } = body

  // Validate credentials if provided — require both
  const trimmedAuth = authToken?.trim()
  const trimmedCt0 = ct0?.trim()

  if (authToken !== undefined && ct0 !== undefined) {
    if (!trimmedAuth || !trimmedCt0) {
      return NextResponse.json({ error: 'Both auth_token and ct0 are required' }, { status: 400 })
    }
  }

  if (syncInterval !== undefined && !isSyncInterval(syncInterval)) {
    return NextResponse.json(
      { error: `Invalid interval. Use: ${SYNC_INTERVALS.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    if (trimmedAuth && trimmedCt0) {
      await Promise.all([
        prisma.setting.upsert({
          where: { key: 'x_auth_token' },
          update: { value: trimmedAuth },
          create: { key: 'x_auth_token', value: trimmedAuth },
        }),
        prisma.setting.upsert({
          where: { key: 'x_ct0' },
          update: { value: trimmedCt0 },
          create: { key: 'x_ct0', value: trimmedCt0 },
        }),
        // Fresh cookies clear the auth back-off, so the next tick syncs instead of
        // waiting out the interval that the expired-cookie error pushed it into.
        prisma.setting.deleteMany({ where: { key: 'x_sync_error' } }),
      ])
    }

    if (syncInterval !== undefined) {
      await prisma.setting.upsert({
        where: { key: 'x_sync_interval' },
        update: { value: syncInterval },
        create: { key: 'x_sync_interval', value: syncInterval },
      })

      if (syncInterval === 'off') {
        stopScheduler()
      } else {
        startScheduler()
      }
    }

    return NextResponse.json({ saved: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save settings' },
      { status: 500 },
    )
  }
}

/** DELETE — remove credentials and stop scheduler */
export async function DELETE() {
  try {
    await prisma.setting.deleteMany({
      where: {
        key: { in: ['x_auth_token', 'x_ct0', 'x_sync_interval', 'x_last_sync', 'x_sync_error'] },
      },
    })
    stopScheduler()
    return NextResponse.json({ deleted: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete credentials' },
      { status: 500 },
    )
  }
}
