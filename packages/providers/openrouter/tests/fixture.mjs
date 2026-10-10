export function catalogPayload() {
  return {
    data: [{
      id: 'acme/reasoner',
      canonical_slug: 'acme/reasoner-20260920',
      name: 'Acme: Reasoner',
      created: 1_789_900_000,
      description: 'A reasoning model.',
      context_length: 131_072,
      architecture: {
        modality: 'text+image->text',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        tokenizer: 'Acme',
        instruct_type: null,
      },
      pricing: {
        prompt: '0.00000025',
        completion: '0.0000015',
        input_cache_read: '0.000000025',
      },
      top_provider: {
        context_length: 131_072,
        max_completion_tokens: 32_768,
        is_moderated: false,
      },
      supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
      reasoning: {
        mandatory: false,
        default_enabled: true,
        supported_efforts: ['low', 'high'],
        default_effort: 'high',
      },
    }],
    total_count: 1,
    links: { next: null },
  }
}

export function keyPayload() {
  return {
    data: {
      label: 'Companion key',
      limit: 20,
      limit_reset: null,
      limit_remaining: 15,
      include_byok_in_limit: false,
      usage: 5,
      usage_daily: 1,
      usage_weekly: 2,
      usage_monthly: 4,
      byok_usage: 0,
      byok_usage_daily: 0,
      byok_usage_weekly: 0,
      byok_usage_monthly: 0,
      is_free_tier: false,
      free_model_daily_requests: { used: 10, limit: 50, remaining: 40 },
      rate_limit: { requests: 200, interval: '10s' },
    },
  }
}
