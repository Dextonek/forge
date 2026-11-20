// Zero-token model router: picks a model tier per message with plain heuristics (no LLM call).
//
// Tiers:  quick    -> haiku,  effort low      (tweaks, lookups, renames, value changes)
//         standard -> sonnet, effort medium   (normal feature work)
//         deep     -> opus,   effort high     (architecture, hard bugs, systems design)
//
// "Sticky" rule: the prompt cache is per model, so switching model re-reads the whole thread
// uncached. Once a thread is big, auto mode does NOT downgrade (the cache miss would cost more
// than the cheaper model saves). Upgrades are always allowed: being right beats being cheap.

export const TIERS = {
  quick: { model: 'haiku', effort: 'low', label: 'Quick (Haiku)' },
  standard: { model: 'sonnet', effort: 'medium', label: 'Standard (Sonnet)' },
  deep: { model: 'opus', effort: 'high', label: 'Deep (Opus)' },
};
const ORDER = ['quick', 'standard', 'deep'];

const DEEP = /\b(architect\w*|redesign|refactor\w*|from scratch|whole (game|system)|multiplayer|netcode|networking|save system|procedural|pathfinding|behaviou?r tree|state machine|shader|physics engine|performance|optimi[sz]e|memory leak|race condition|why (does|is|isn't|doesn't)|root cause|plan\b|design (a|the)|system for)\b/i;
const QUICK = /\b(rename|typo|(change|set|make) (the )?([\w-]+ ){0,2}(colou?r|value|speed|size|scale|text|label|number|position|rotation|gravity|damage|health|hp|volume|duration|delay|count|title)( \w+)? (to|=)|set [\w.]+ to|make (it|the \w+) (faster|slower|bigger|smaller|red|blue|green)|where is|which file|what does|explain this line|tweak|bump|toggle|comment out|remove the log|add a log)\b/i;

// Big context: last turn's input (cached + uncached) tokens above which auto mode won't downgrade.
// Base context (system prompt + tools) is ~12k, so above ~16k the thread has real history worth keeping cached.
const STICKY_CONTEXT_TOKENS = 16_000;
// Input price per token tier ($/M, Haiku 5.5 / Sonnet 5.5 / Opus 5.5). Cache read ≈ 0.05×, cache write 1.25×.
const PRICE = { quick: 0.1, standard: 2, deep: 4 };

export function routeMessage(text, { override = 'auto', lastTier = null, lastContextTokens = 0 } = {}) {
  if (override !== 'auto' && TIERS[override]) return { tier: override, reason: 'chosen by you' };

  let tier = 'standard';
  let reason = 'default for normal work';
  if (DEEP.test(text) || text.length > 1500) {
    tier = 'deep';
    reason = DEEP.test(text) ? `mentions "${text.match(DEEP)[0]}"` : 'long, detailed request';
  } else if (QUICK.test(text) && text.length < 300) {
    tier = 'quick';
    reason = `small change ("${text.match(QUICK)[0]}")`;
  }

  // Cache-aware: the prompt cache is per model. Moving to a cheaper model means re-writing the whole
  // thread into that model's cache. Only switch down when that one-off write costs less than a few
  // cached reads on the current model (true for anything -> Haiku, false for Opus -> Sonnet).
  if (lastTier && ORDER.indexOf(tier) < ORDER.indexOf(lastTier) && lastContextTokens > STICKY_CONTEXT_TOKENS) {
    const switchCost = lastContextTokens * PRICE[tier] * 1.25;   // cache write on the new model
    const stayCost = lastContextTokens * PRICE[lastTier] * 0.05 * 3; // ~3 cached turns on the current model
    if (switchCost > stayCost) {
      return { tier: lastTier, reason: `stayed on ${lastTier}: switching down would re-read ~${Math.round(lastContextTokens / 1000)}k tokens uncached` };
    }
  }
  return { tier, reason };
}
