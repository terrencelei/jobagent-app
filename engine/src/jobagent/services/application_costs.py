"""API-equivalent estimates for application agent token usage."""

# USD per million tokens, Anthropic and OpenAI standard API pricing checked 2026-10-26.
# Plan and CLI subscriptions are not billed at these per-token rates; these figures are a
# consistent comparison of model usage, not an invoice or a claim about subscription spend.
MODEL_RATES = {
    'claude-fable-5-1': {'input': 10.0, 'cache_read': 0.25, 'cache_write': 12.5, 'output': 50.0},
    'claude-fable-5': {'input': 10.0, 'cache_read': 1.0, 'cache_write': 12.5, 'output': 50.0},
    'claude-opus-5': {'input': 5.0, 'cache_read': 0.50, 'cache_write': 6.25, 'output': 25.0},
    'claude-opus-5-5': {'input': 4.0, 'cache_read': 0.20, 'cache_write': 5.0, 'output': 20.0},
    'claude-opus-4-8': {'input': 5.0, 'cache_read': 0.50, 'cache_write': 6.25, 'output': 25.0},
    'claude-opus-4-7': {'input': 5.0, 'cache_read': 0.50, 'cache_write': 6.25, 'output': 25.0},
    'claude-opus-4-6': {'input': 5.0, 'cache_read': 0.50, 'cache_write': 6.25, 'output': 25.0},
    'claude-opus-4-5': {'input': 5.0, 'cache_read': 0.50, 'cache_write': 6.25, 'output': 25.0},
    'claude-sonnet-5-5': {'input': 2.0, 'cache_read': 0.10, 'cache_write': 2.50, 'output': 10.0},
    'claude-sonnet-5': {'input': 2.0, 'cache_read': 0.20, 'cache_write': 2.50, 'output': 10.0},
    'claude-sonnet-4-6': {'input': 3.0, 'cache_read': 0.30, 'cache_write': 3.75, 'output': 15.0},
    'claude-sonnet-4-5': {'input': 3.0, 'cache_read': 0.30, 'cache_write': 3.75, 'output': 15.0},
    'claude-haiku-5-5': {'input': 0.10, 'cache_read': 0.01, 'cache_write': 0.125, 'output': 0.50},
    'claude-haiku-4-5': {'input': 1.0, 'cache_read': 0.10, 'cache_write': 1.25, 'output': 5.0},
    'gpt-6.1-sol': {'input': 2.0, 'cache_read': 0.10, 'cache_write': 2.5, 'output': 10.0},
    'gpt-6.1-terra': {'input': 1.0, 'cache_read': 0.05, 'cache_write': 1.25, 'output': 5.0},
    'gpt-6-luna': {'input': 0.10, 'cache_read': 0.01, 'cache_write': 0.125, 'output': 0.50},
    'gpt-5.6-luna': {'input': 0.20, 'cache_read': 0.02, 'cache_write': 0.25, 'output': 1.20},
}


def model_id(value):
    value = str(value or '').strip().lower()
    if ':' in value:
        value = value.rsplit(':', 1)[-1]
    if '/' in value:
        value = value.rsplit('/', 1)[-1]
    if value in MODEL_RATES:
        return value
    # OpenCode's catalog marks free models explicitly; report their API-equivalent usage as $0.
    return value if value.endswith('-free') else None


def estimate(tokens, model, legacy=False):
    """Return a known-model API-equivalent cost, or None if there is no rate."""
    key = model_id(model)
    if key and key.endswith('-free'):
        return 0.0
    rates = MODEL_RATES.get(key) if key else None
    if not rates:
        return None
    if legacy:
        # Earlier counters combined cache reads/writes with ordinary input. Charge all such
        # tokens at the highest input tier so this remains an upper bound.
        amount = (tokens.get('input_tokens', 0) * max(rates['input'], rates['cache_write']) +
                  tokens.get('output_tokens', 0) * rates['output']) / 1_000_000
    else:
        amount = (tokens.get('input_tokens', 0) * rates['input'] +
                  tokens.get('cache_read_input_tokens', 0) * rates['cache_read'] +
                  tokens.get('cache_creation_input_tokens', 0) * rates['cache_write'] +
                  tokens.get('output_tokens', 0) * rates['output']) / 1_000_000
    return round(amount, 8)
