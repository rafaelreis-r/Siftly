import OpenAI from 'openai'

/**
 * Resolve a MiniMax-compatible OpenAI client.
 *
 * MiniMax exposes an OpenAI-compatible API at https://api.minimax.io/v1.
 * Auth priority:
 *   1. Override key (from request body — explicit per-request test)
 *   2. MINIMAX_API_KEY env var — deployment source of truth
 *   3. DB-saved key — UI fallback when no env is set
 *   4. Custom base URL (proxy)
 *
 * Env beats the DB key so a stale key left in /settings can't silently
 * override the deployment's env-configured key (mirrors the MINIMAX_MODEL /
 * AI_PROVIDER env overrides).
 */
export function resolveMiniMaxClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
} = {}): OpenAI {
  const baseURL = options.baseURL ?? process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1'

  if (options.overrideKey?.trim()) {
    return new OpenAI({ apiKey: options.overrideKey.trim(), baseURL })
  }

  const envKey = process.env.MINIMAX_API_KEY?.trim()
  if (envKey) return new OpenAI({ apiKey: envKey, baseURL })

  if (options.dbKey?.trim()) {
    return new OpenAI({ apiKey: options.dbKey.trim(), baseURL })
  }

  if (options.baseURL) return new OpenAI({ apiKey: 'proxy', baseURL })

  throw new Error('No MiniMax API key found. Add your key in Settings, or set MINIMAX_API_KEY.')
}
