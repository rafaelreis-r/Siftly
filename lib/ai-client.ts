import Anthropic from '@anthropic-ai/sdk'
import prisma from '@/lib/db'
import { createCliAnthropicClient } from '@/lib/claude-cli-auth'

type AnthropicLikeMessage = {
  role: string
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >
}

type AnthropicLikeParams = {
  model: string
  max_tokens: number
  messages: AnthropicLikeMessage[]
}

function extractTextContent(payload: unknown): string {
  const obj = payload as { choices?: Array<{ message?: { content?: string } }> }
  return obj?.choices?.[0]?.message?.content ?? ''
}

function mapMessages(messages: AnthropicLikeMessage[]) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    return {
      role: m.role,
      content: m.content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text }
        return {
          type: 'image_url',
          image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
        }
      }),
    }
  })
}

export function createOpenAIAnthropicShim(apiKey: string, baseURL?: string) {
  const root = (baseURL?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '')
  return {
    messages: {
      async create(params: AnthropicLikeParams) {
        const res = await fetch(`${root}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: params.model,
            messages: mapMessages(params.messages),
            max_tokens: params.max_tokens,
          }),
        })

        const text = await res.text()
        if (!res.ok) {
          throw new Error(`${res.status} ${text.slice(0, 300)}`)
        }
        const json = JSON.parse(text)
        return {
          content: [{ type: 'text', text: extractTextContent(json) }],
        }
      },
    },
  }
}

export async function getPreferredModel(): Promise<string> {
  const [openaiKey, openaiModel, anthropicModel] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'openaiApiKey' } }),
    prisma.setting.findUnique({ where: { key: 'openaiModel' } }),
    prisma.setting.findUnique({ where: { key: 'anthropicModel' } }),
  ])

  const hasOpenAI = !!(openaiKey?.value?.trim() || process.env.OPENAI_API_KEY?.trim())
  if (hasOpenAI) {
    return openaiModel?.value ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  }
  return anthropicModel?.value ?? 'claude-opus-4-6'
}

export async function resolveAiClient(overrideAnthropicKey?: string): Promise<Anthropic | ReturnType<typeof createOpenAIAnthropicShim>> {
  const [openaiSetting, anthropicSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'openaiApiKey' } }),
    prisma.setting.findUnique({ where: { key: 'anthropicApiKey' } }),
  ])

  const openaiKey = openaiSetting?.value?.trim() || process.env.OPENAI_API_KEY || ''
  const openaiBaseURL = process.env.OPENAI_BASE_URL
  if (openaiKey) {
    return createOpenAIAnthropicShim(openaiKey, openaiBaseURL)
  }

  const baseURL = process.env.ANTHROPIC_BASE_URL
  if (overrideAnthropicKey && overrideAnthropicKey.trim() !== '') {
    return new Anthropic({ apiKey: overrideAnthropicKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }
  if (anthropicSetting?.value?.trim()) {
    return new Anthropic({ apiKey: anthropicSetting.value.trim(), ...(baseURL ? { baseURL } : {}) })
  }
  const cliClient = createCliAnthropicClient(baseURL)
  if (cliClient) return cliClient
  const envKey = process.env.ANTHROPIC_API_KEY
  if (envKey?.trim()) {
    return new Anthropic({ apiKey: envKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }
  if (baseURL) return new Anthropic({ apiKey: 'proxy', baseURL })
  throw new Error('No AI API key found. Add one in Settings.')
}
