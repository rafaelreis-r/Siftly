import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I%2BxMb1nYFAA%3DUognEfK4ZPxYowpr4nMskopkC%2FDO'

const FEATURES = JSON.stringify({
  graphql_timeline_v2_bookmark_timeline: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
})

// Query ID for Twitter's internal Bookmarks GraphQL endpoint
// This can change when Twitter deploys updates — update if you get 400 errors
const QUERY_ID = 'j5KExFXy1niL_uGnBhHNxA'

interface MediaVariant {
  content_type?: string
  bitrate?: number
  url?: string
}

interface MediaEntity {
  type?: string
  media_url_https?: string
  video_info?: { variants?: MediaVariant[] }
}

interface TweetLegacy {
  full_text?: string
  created_at?: string
  entities?: { hashtags?: unknown[]; urls?: unknown[]; user_mentions?: unknown[]; media?: MediaEntity[] }
  extended_entities?: { media?: MediaEntity[] }
}

interface TweetCardLegacy {
  binding_values?: unknown
}

interface UserLegacy {
  screen_name?: string
  name?: string
}

interface TweetResult {
  rest_id?: string
  legacy?: TweetLegacy
  card?: { legacy?: TweetCardLegacy }
  core?: { user_results?: { result?: { legacy?: UserLegacy } } }
}

interface UrlEntity {
  url?: string
  expanded_url?: string
  display_url?: string
}

interface StoredEntities {
  urls: Array<{ short: string; expanded: string }>
  hashtags: string[]
  mentions: string[]
}

const MAX_RESOLUTION_CONCURRENCY = 5
const INTERNAL_MEDIA_URL_PATTERNS = [
  /^https:\/\/pbs\.twimg\.com/i,
  /^https:\/\/video\.twimg\.com/i,
]

let activeResolutions = 0
const resolutionQueue: Array<() => void> = []

async function withResolutionSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeResolutions >= MAX_RESOLUTION_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      resolutionQueue.push(resolve)
    })
  }

  activeResolutions++
  try {
    return await task()
  } finally {
    activeResolutions--
    const next = resolutionQueue.shift()
    if (next) next()
  }
}

function isInternalMediaUrl(url: string): boolean {
  return INTERNAL_MEDIA_URL_PATTERNS.some((pattern) => pattern.test(url))
}

async function tryResolveUrlWithMethod(
  url: string,
  method: 'HEAD' | 'GET',
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) return null
    return response.url || url
  } catch {
    return null
  }
}

export async function resolveUrl(url: string): Promise<string> {
  if (!url) return url

  return withResolutionSlot(async () => {
    const headResolved = await tryResolveUrlWithMethod(url, 'HEAD')
    if (headResolved) return headResolved

    const getResolved = await tryResolveUrlWithMethod(url, 'GET')
    if (getResolved) return getResolved

    return url
  })
}

function collectCardUrlCandidates(tweet: TweetResult): Array<{ short: string; candidate: string }> {
  const bindingValues = tweet.card?.legacy?.binding_values
  if (!bindingValues) return []

  const out: Array<{ short: string; candidate: string }> = []

  if (Array.isArray(bindingValues)) {
    for (const entry of bindingValues as Record<string, unknown>[]) {
      const key = String(entry?.key ?? '')
      if (key !== 'card_url') continue

      const valueObj = (entry?.value as Record<string, unknown> | undefined) ?? {}
      const candidate = String(
        valueObj.string_value ?? valueObj.url ?? valueObj.expanded_url ?? ''
      ).trim()
      if (!candidate || isInternalMediaUrl(candidate)) continue
      out.push({ short: candidate, candidate })
    }
    return out
  }

  if (typeof bindingValues === 'object' && bindingValues !== null) {
    const map = bindingValues as Record<string, unknown>
    const rawCardUrl = map.card_url
    if (!rawCardUrl) return out
    const rawObj = rawCardUrl as Record<string, unknown>
    const candidate = String(
      rawObj.string_value ?? rawObj.url ?? rawObj.expanded_url ?? rawCardUrl ?? ''
    ).trim()
    if (!candidate || isInternalMediaUrl(candidate)) return out
    out.push({ short: candidate, candidate })
  }

  return out
}

async function extractAndResolveEntities(tweet: TweetResult): Promise<StoredEntities> {
  const hashtags = (tweet.legacy?.entities?.hashtags ?? [])
    .map((item) => String((item as { text?: string })?.text ?? '').trim())
    .filter(Boolean)
  const mentions = (tweet.legacy?.entities?.user_mentions ?? [])
    .map((item) => String((item as { screen_name?: string })?.screen_name ?? '').trim())
    .filter(Boolean)

  const entityUrlCandidates = (tweet.legacy?.entities?.urls ?? [])
    .map((item) => item as UrlEntity)
    .map((item) => {
      const short = String(item.url ?? '').trim()
      const candidate = String(item.expanded_url ?? item.url ?? '').trim()
      return { short, candidate }
    })
    .filter((item) => item.candidate && !isInternalMediaUrl(item.candidate))

  const allCandidates = [...entityUrlCandidates, ...collectCardUrlCandidates(tweet)]
  if (allCandidates.length === 0) {
    return { urls: [], hashtags, mentions }
  }

  const resolvedEntries = await Promise.all(
    allCandidates.map(async ({ short, candidate }) => {
      const resolved = await resolveUrl(candidate)
      if (!resolved || isInternalMediaUrl(resolved)) return null
      return {
        short: short || candidate,
        expanded: resolved,
      }
    })
  )

  const deduped = new Map<string, { short: string; expanded: string }>()
  for (const entry of resolvedEntries) {
    if (!entry) continue
    const key = `${entry.short}::${entry.expanded}`
    if (!deduped.has(key)) deduped.set(key, entry)
  }

  return { urls: Array.from(deduped.values()), hashtags, mentions }
}

function parseStoredTweet(rawJson: string): TweetResult | null {
  if (!rawJson) return null
  try {
    return JSON.parse(rawJson) as TweetResult
  } catch {
    return null
  }
}

async function fetchPage(authToken: string, ct0: string, cursor?: string) {
  const variables = JSON.stringify({
    count: 100,
    includePromotedContent: false,
    ...(cursor ? { cursor } : {}),
  })

  const url = `https://x.com/i/api/graphql/${QUERY_ID}/Bookmarks?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(FEATURES)}`

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${BEARER}`,
      'X-Csrf-Token': ct0,
      Cookie: `auth_token=${authToken}; ct0=${ct0}`,
      'X-Twitter-Auth-Type': 'OAuth2Session',
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'en',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://x.com/i/bookmarks',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Twitter API ${res.status}: ${text.slice(0, 300)}`)
  }

  return res.json()
}

function parsePage(data: unknown): { tweets: TweetResult[]; nextCursor: string | null } {
  const instructions =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data as any)?.data?.bookmark_timeline_v2?.timeline?.instructions ?? []

  const tweets: TweetResult[] = []
  let nextCursor: string | null = null

  for (const instruction of instructions) {
    if (instruction.type !== 'TimelineAddEntries') continue
    for (const entry of instruction.entries ?? []) {
      const content = entry.content
      if (content?.entryType === 'TimelineTimelineItem') {
        const tweet: TweetResult = content?.itemContent?.tweet_results?.result
        if (tweet?.rest_id) tweets.push(tweet)
      } else if (
        content?.entryType === 'TimelineTimelineCursor' &&
        content?.cursorType === 'Bottom'
      ) {
        nextCursor = content.value ?? null
      }
    }
  }

  return { tweets, nextCursor }
}

function bestVideoUrl(variants: MediaVariant[]): string | null {
  const mp4 = variants
    .filter((v) => v.content_type === 'video/mp4' && v.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
  return mp4[0]?.url ?? null
}

function extractMedia(tweet: TweetResult) {
  const entities =
    tweet.legacy?.extended_entities?.media ?? tweet.legacy?.entities?.media ?? []
  return entities
    .map((m) => {
      const thumb = m.media_url_https ?? ''
      if (m.type === 'video' || m.type === 'animated_gif') {
        const url = bestVideoUrl(m.video_info?.variants ?? []) ?? thumb
        if (!url) return null
        return { type: m.type === 'animated_gif' ? 'gif' : 'video', url, thumbnailUrl: thumb }
      }
      if (!thumb) return null
      return { type: 'photo' as const, url: thumb, thumbnailUrl: thumb }
    })
    .filter(Boolean) as { type: string; url: string; thumbnailUrl: string }[]
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { authToken?: string; ct0?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { authToken, ct0 } = body
  if (!authToken?.trim() || !ct0?.trim()) {
    return NextResponse.json({ error: 'authToken and ct0 are required' }, { status: 400 })
  }

  let imported = 0
  let skipped = 0
  let cursor: string | undefined

  try {
    while (true) {
      const data = await fetchPage(authToken.trim(), ct0.trim(), cursor)
      const { tweets, nextCursor } = parsePage(data)

      for (const tweet of tweets) {
        if (!tweet.rest_id) continue

        const exists = await prisma.bookmark.findUnique({
          where: { tweetId: tweet.rest_id },
          select: { id: true },
        })

        if (exists) {
          skipped++
          continue
        }

        const media = extractMedia(tweet)
        const userLegacy = tweet.core?.user_results?.result?.legacy ?? {}
        const entities = await extractAndResolveEntities(tweet)

        const created = await prisma.bookmark.create({
          data: {
            tweetId: tweet.rest_id,
            text: tweet.legacy?.full_text ?? '',
            authorHandle: userLegacy.screen_name ?? 'unknown',
            authorName: userLegacy.name ?? 'Unknown',
            tweetCreatedAt: tweet.legacy?.created_at
              ? new Date(tweet.legacy.created_at)
              : null,
            rawJson: JSON.stringify(tweet),
            entities: JSON.stringify(entities),
          },
        })

        if (media.length > 0) {
          await prisma.mediaItem.createMany({
            data: media.map((m) => ({
              bookmarkId: created.id,
              type: m.type,
              url: m.url,
              thumbnailUrl: m.thumbnailUrl ?? null,
            })),
          })
        }

        imported++
      }

      if (!nextCursor || tweets.length === 0) break
      cursor = nextCursor
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch from Twitter' },
      { status: 500 }
    )
  }

  return NextResponse.json({ imported, skipped })
}

export async function PATCH(): Promise<NextResponse> {
  try {
    const bookmarks = await prisma.bookmark.findMany({
      where: {
        OR: [
          { entities: null },
          { entities: { contains: 't.co/' } },
        ],
      },
      take: 50,
      select: { id: true, rawJson: true },
    })

    let updated = 0
    for (const bookmark of bookmarks) {
      const tweet = parseStoredTweet(bookmark.rawJson)
      if (!tweet) continue

      const entities = await extractAndResolveEntities(tweet)
      await prisma.bookmark.update({
        where: { id: bookmark.id },
        data: { entities: JSON.stringify(entities) },
      })
      updated++
    }

    return NextResponse.json({ updated })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to resolve URLs' },
      { status: 500 }
    )
  }
}
