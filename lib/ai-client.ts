import Anthropic from '@anthropic-ai/sdk'
import prisma from '@/lib/db'
import { createCliAnthropicClient } from '@/lib/claude-cli-auth'

export async function getPreferredModel(): Promise<string> {
  const setting = await prisma.setting.findUnique({ where: { key: 'anthropicModel' } })
  return setting?.value ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6'
}

export async function resolveAiClient(overrideAnthropicKey?: string): Promise<Anthropic> {
  const baseURL = process.env.ANTHROPIC_BASE_URL
  if (overrideAnthropicKey?.trim()) {
    return new Anthropic({ apiKey: overrideAnthropicKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }
  const setting = await prisma.setting.findUnique({ where: { key: 'anthropicApiKey' } })
  if (setting?.value?.trim()) {
    return new Anthropic({ apiKey: setting.value.trim(), ...(baseURL ? { baseURL } : {}) })
  }
  const cliClient = createCliAnthropicClient(baseURL)
  if (cliClient) return cliClient
  const envKey = process.env.ANTHROPIC_API_KEY
  if (envKey?.trim()) {
    return new Anthropic({ apiKey: envKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }
  if (baseURL) return new Anthropic({ apiKey: 'proxy', baseURL })
  throw new Error('No Anthropic API key found. Add one in Settings.')
}
