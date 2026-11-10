// OpenAI Decisions API: one shared input, up to 400 typed questions per call.
// We use it only to LABEL things (keep / drop, meeting / block). It never
// writes text, so it cannot change an author's words.
//   POST https://api.openai.com/v1/decisions   model "gpt-6-luna"
//   $0.10 / 1M input tokens, output free.

export interface Choice { value: string; description?: string }
export interface ChoiceQuestion { type: "choice"; name: string; instructions: string; choices: Choice[] }
export interface Answer { name: string; choice: string | null; confidence: number }
export interface DecideResult { answers: Map<string, Answer>; inputTokens: number; cachedTokens: number; calls: number }

const URL_ = "https://api.openai.com/v1/decisions";
const MODEL = "gpt-6-luna";
const MAX_Q = 400;
export const PRICE_PER_M_INPUT = 0.10;

export async function decide(key: string, input: unknown, questions: ChoiceQuestion[], cacheKey?: string): Promise<DecideResult> {
  const out: DecideResult = { answers: new Map(), inputTokens: 0, cachedTokens: 0, calls: 0 };
  for (let i = 0; i < questions.length; i += MAX_Q) {
    const chunk = questions.slice(i, i + MAX_Q);
    const body: Record<string, unknown> = { model: MODEL, input, questions: chunk };
    if (cacheKey) body.prompt_cache_key = cacheKey.slice(0, 64); // later chunks reuse the same input
    const r = await fetch(URL_, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`decisions API HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as any;
    out.calls++;
    out.inputTokens += j.usage?.input_tokens || 0;
    out.cachedTokens += j.usage?.input_tokens_details?.cached_tokens || 0;
    for (const a of j.answers || []) {
      if (!a?.name) continue;
      out.answers.set(a.name, {
        name: a.name,
        choice: a.type === "choice" ? String(a.choice) : null, // "refusal" -> null
        confidence: typeof a.confidence === "number" ? a.confidence : 0,
      });
    }
  }
  return out;
}

export function cost(tokens: number): string {
  return `$${((tokens / 1e6) * PRICE_PER_M_INPUT).toFixed(5)}`;
}
