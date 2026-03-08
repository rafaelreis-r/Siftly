function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
}

function normalizeWhitespace(text: string): string {
  return decodeHtmlEntities(text.replace(/\s+/g, ' ').trim())
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, ' ')
}

function extractTagContent(html: string, tag: 'title'): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = html.match(regex)
  if (!match?.[1]) return ''
  return normalizeWhitespace(stripTags(match[1]))
}

function extractMetaContent(
  html: string,
  selector: { property?: string; name?: string },
): string {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []

  for (const tag of tags) {
    const propertyMatch = tag.match(/\bproperty\s*=\s*(["'])(.*?)\1/i)
    const nameMatch = tag.match(/\bname\s*=\s*(["'])(.*?)\1/i)
    const contentMatch = tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i)

    if (!contentMatch?.[2]) continue

    if (selector.property && propertyMatch?.[2]?.toLowerCase() === selector.property.toLowerCase()) {
      return normalizeWhitespace(stripTags(contentMatch[2]))
    }

    if (selector.name && nameMatch?.[2]?.toLowerCase() === selector.name.toLowerCase()) {
      return normalizeWhitespace(stripTags(contentMatch[2]))
    }
  }

  return ''
}

export async function fetchUrlContent(
  url: string,
): Promise<{ title: string; description: string } | null> {
  if (!url) return null

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Twitterbot/1.0',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (!response.ok) return null

    const html = await response.text()
    if (!html) return null

    const titleTag = extractTagContent(html, 'title')
    const ogTitle = extractMetaContent(html, { property: 'og:title' })
    const ogDescription = extractMetaContent(html, { property: 'og:description' })
    const metaDescription = extractMetaContent(html, { name: 'description' })
    const ogSiteName = extractMetaContent(html, { property: 'og:site_name' })

    const title = ogTitle || titleTag || ogSiteName
    const description = ogDescription || metaDescription

    if (!title && !description) return null

    return { title, description }
  } catch {
    return null
  }
}
