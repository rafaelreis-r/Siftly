import { NextResponse } from 'next/server'
import prisma from '@/lib/db'

function parseBookmarkEntities(
  entities: string | null,
): { urls?: Array<{ short?: string; expanded?: string }>; hashtags?: string[]; mentions?: string[] } | null {
  if (!entities) return null
  try {
    return JSON.parse(entities) as {
      urls?: Array<{ short?: string; expanded?: string }>
      hashtags?: string[]
      mentions?: string[]
    }
  } catch {
    return null
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const [
      totalBookmarks,
      totalCategories,
      totalMedia,
      recentBookmarks,
      topCategoriesRaw,
    ] = await Promise.all([
      prisma.bookmark.count(),
      prisma.category.count(),
      prisma.mediaItem.count(),
      prisma.bookmark.findMany({
        take: 5,
        orderBy: { importedAt: 'desc' },
        include: {
          mediaItems: {
            select: { id: true, type: true, url: true, thumbnailUrl: true },
          },
          categories: {
            include: {
              category: {
                select: { id: true, name: true, slug: true, color: true },
              },
            },
          },
        },
      }),
      prisma.category.findMany({
        include: {
          _count: { select: { bookmarks: true } },
        },
        orderBy: {
          bookmarks: { _count: 'desc' },
        },
        take: 5,
      }),
    ])

    const formattedRecent = recentBookmarks.map((b) => ({
      id: b.id,
      tweetId: b.tweetId,
      text: b.text,
      entities: parseBookmarkEntities(b.entities),
      authorHandle: b.authorHandle,
      authorName: b.authorName,
      tweetCreatedAt: b.tweetCreatedAt?.toISOString() ?? null,
      importedAt: b.importedAt.toISOString(),
      mediaItems: b.mediaItems,
      categories: b.categories.map((bc) => ({
        id: bc.category.id,
        name: bc.category.name,
        slug: bc.category.slug,
        color: bc.category.color,
        confidence: bc.confidence,
      })),
    }))

    const topCategories = topCategoriesRaw.map((cat) => ({
      name: cat.name,
      slug: cat.slug,
      color: cat.color,
      count: cat._count.bookmarks,
    }))

    return NextResponse.json({
      totalBookmarks,
      totalCategories,
      totalMedia,
      recentBookmarks: formattedRecent,
      topCategories,
    })
  } catch (err) {
    console.error('Stats fetch error:', err)
    return NextResponse.json(
      { error: `Failed to fetch stats: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
