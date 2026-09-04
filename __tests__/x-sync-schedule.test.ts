import { describe, it, expect } from 'vitest'
import { evaluateSchedule, parseSyncError } from '@/lib/x-sync'
import type { ScheduleSnapshot, SyncError } from '@/lib/x-sync'

const HOUR = 60 * 60 * 1000

function snapshot(overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    interval: '4h',
    hasCredentials: true,
    lastSyncAt: null,
    lastError: null,
    ...overrides,
  }
}

describe('evaluateSchedule', () => {
  const now = new Date('2026-09-04T12:00:00.000Z')

  it('should be off when the interval is off', () => {
    const state = evaluateSchedule(snapshot({ interval: 'off' }), now)
    expect(state).toEqual({ kind: 'off' })
  })

  it('should be off even when a sync is overdue', () => {
    const state = evaluateSchedule(
      snapshot({ interval: 'off', lastSyncAt: new Date(now.getTime() - 100 * HOUR) }),
      now,
    )
    expect(state).toEqual({ kind: 'off' })
  })

  it('should report missing credentials when the interval is on', () => {
    const state = evaluateSchedule(snapshot({ hasCredentials: false }), now)
    expect(state).toEqual({ kind: 'no-credentials' })
  })

  it('should prefer off over missing credentials', () => {
    const state = evaluateSchedule(snapshot({ interval: 'off', hasCredentials: false }), now)
    expect(state).toEqual({ kind: 'off' })
  })

  it('should be due when it has never synced', () => {
    const state = evaluateSchedule(snapshot({ lastSyncAt: null }), now)
    expect(state).toEqual({ kind: 'due' })
  })

  it('should wait when the interval has not elapsed', () => {
    const lastSyncAt = new Date(now.getTime() - 1 * HOUR)
    const state = evaluateSchedule(snapshot({ interval: '4h', lastSyncAt }), now)
    expect(state).toEqual({
      kind: 'waiting',
      nextDueAt: new Date(lastSyncAt.getTime() + 4 * HOUR),
    })
  })

  it('should be due at exactly the due instant', () => {
    const lastSyncAt = new Date(now.getTime() - 4 * HOUR)
    const state = evaluateSchedule(snapshot({ interval: '4h', lastSyncAt }), now)
    expect(state).toEqual({ kind: 'due' })
  })

  it('should be due when overdue by days', () => {
    const lastSyncAt = new Date(now.getTime() - 30 * 24 * HOUR)
    const state = evaluateSchedule(snapshot({ interval: '8h', lastSyncAt }), now)
    expect(state).toEqual({ kind: 'due' })
  })

  it('should honour each interval length', () => {
    const cases: Array<[ScheduleSnapshot['interval'], number]> = [
      ['1h', 1],
      ['4h', 4],
      ['8h', 8],
      ['24h', 24],
    ]
    for (const [interval, hours] of cases) {
      const lastSyncAt = new Date(now.getTime() - hours * HOUR + 1)
      expect(evaluateSchedule(snapshot({ interval, lastSyncAt }), now)).toEqual({
        kind: 'waiting',
        nextDueAt: new Date(lastSyncAt.getTime() + hours * HOUR),
      })
    }
  })

  it('should not push the due instant for a transient error', () => {
    const lastSyncAt = new Date(now.getTime() - 4 * HOUR)
    const lastError: SyncError = {
      message: 'socket hang up',
      at: now.toISOString(),
      kind: 'transient',
    }
    const state = evaluateSchedule(snapshot({ interval: '4h', lastSyncAt, lastError }), now)
    expect(state).toEqual({ kind: 'due' })
  })

  it('should push the due instant a full interval past an auth error', () => {
    const lastSyncAt = new Date(now.getTime() - 10 * HOUR)
    const erroredAt = new Date(now.getTime() - 1 * HOUR)
    const lastError: SyncError = {
      message: 'Request failed with status 403',
      at: erroredAt.toISOString(),
      kind: 'auth',
    }
    const state = evaluateSchedule(snapshot({ interval: '4h', lastSyncAt, lastError }), now)
    expect(state).toEqual({
      kind: 'waiting',
      nextDueAt: new Date(erroredAt.getTime() + 4 * HOUR),
    })
  })

  it('should be due again once the interval past an auth error has elapsed', () => {
    const erroredAt = new Date(now.getTime() - 5 * HOUR)
    const lastError: SyncError = {
      message: '401 Unauthorized',
      at: erroredAt.toISOString(),
      kind: 'auth',
    }
    const state = evaluateSchedule(
      snapshot({ interval: '4h', lastSyncAt: new Date(now.getTime() - 6 * HOUR), lastError }),
      now,
    )
    expect(state).toEqual({ kind: 'due' })
  })

  it('should ignore an auth error older than the last sync', () => {
    const lastSyncAt = new Date(now.getTime() - 1 * HOUR)
    const lastError: SyncError = {
      message: '401 Unauthorized',
      at: new Date(now.getTime() - 50 * HOUR).toISOString(),
      kind: 'auth',
    }
    const state = evaluateSchedule(snapshot({ interval: '4h', lastSyncAt, lastError }), now)
    expect(state).toEqual({
      kind: 'waiting',
      nextDueAt: new Date(lastSyncAt.getTime() + 4 * HOUR),
    })
  })

  it('should fall back to the last sync when an auth error timestamp is unusable', () => {
    const lastSyncAt = new Date(now.getTime() - 1 * HOUR)
    const lastError: SyncError = { message: '403 Forbidden', at: 'yesterday', kind: 'auth' }
    const state = evaluateSchedule(snapshot({ interval: '4h', lastSyncAt, lastError }), now)
    expect(state).toEqual({
      kind: 'waiting',
      nextDueAt: new Date(lastSyncAt.getTime() + 4 * HOUR),
    })
  })

  it('should be due when it has never synced despite an auth error', () => {
    const lastError: SyncError = {
      message: '403 Forbidden',
      at: now.toISOString(),
      kind: 'auth',
    }
    const state = evaluateSchedule(snapshot({ lastSyncAt: null, lastError }), now)
    expect(state).toEqual({ kind: 'due' })
  })
})

describe('parseSyncError', () => {
  it('should parse a well-formed auth error', () => {
    const error: SyncError = { message: '401', at: '2026-09-04T12:00:00.000Z', kind: 'auth' }
    expect(parseSyncError(JSON.stringify(error))).toEqual(error)
  })

  it('should parse a well-formed transient error', () => {
    const error: SyncError = { message: 'ETIMEDOUT', at: '2026-09-04T12:00:00.000Z', kind: 'transient' }
    expect(parseSyncError(JSON.stringify(error))).toEqual(error)
  })

  it('should read null for a missing value', () => {
    expect(parseSyncError(null)).toBeNull()
    expect(parseSyncError(undefined)).toBeNull()
    expect(parseSyncError('')).toBeNull()
  })

  it('should read null for unparseable JSON', () => {
    expect(parseSyncError('{ not json')).toBeNull()
    expect(parseSyncError('undefined')).toBeNull()
  })

  it('should read null for JSON that is not an object', () => {
    expect(parseSyncError('null')).toBeNull()
    expect(parseSyncError('42')).toBeNull()
    expect(parseSyncError('"a string"')).toBeNull()
    expect(parseSyncError('[]')).toBeNull()
  })

  it('should read null when a field is missing or mistyped', () => {
    expect(parseSyncError('{"at":"2026-09-04T12:00:00.000Z","kind":"auth"}')).toBeNull()
    expect(parseSyncError('{"message":"x","kind":"auth"}')).toBeNull()
    expect(parseSyncError('{"message":"x","at":"2026-09-04T12:00:00.000Z"}')).toBeNull()
    expect(parseSyncError('{"message":1,"at":"2026-09-04T12:00:00.000Z","kind":"auth"}')).toBeNull()
  })

  it('should read null for an unrecognised kind', () => {
    expect(parseSyncError('{"message":"x","at":"2026-09-04T12:00:00.000Z","kind":"fatal"}')).toBeNull()
  })

  it('should not throw on any of these inputs', () => {
    const inputs = ['{ not json', 'null', '[]', '{"kind":"auth"}', '{}', 'NaN']
    for (const input of inputs) {
      expect(() => parseSyncError(input)).not.toThrow()
    }
  })
})
