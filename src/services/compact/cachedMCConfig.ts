export type CachedMCConfig = {
  enabled: boolean
  triggerThreshold: number
  keepRecent: number
  supportedModels: string[]
  systemPromptSuggestSummaries: boolean
}

const DEFAULT_CACHED_MC_CONFIG: CachedMCConfig = {
  enabled: false,
  triggerThreshold: 12,
  keepRecent: 3,
  supportedModels: ['claude-opus-4-6', 'claude-sonnet-4-6'],
  systemPromptSuggestSummaries: false,
}

export function getCachedMCConfig(): CachedMCConfig {
  return DEFAULT_CACHED_MC_CONFIG
}
