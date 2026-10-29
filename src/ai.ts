/** Model-agnostic adapters. Swap providers with LLM_PROVIDER=openai|anthropic. */
export interface Embedder { embed(texts: string[]): Promise<number[][]> }
export interface Llm { complete(system: string, user: string): Promise<string> }
export interface Ai { embedder: Embedder; llm: Llm }

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export function openAiEmbedder(key: string, model = process.env.EMBED_MODEL ?? "text-embedding-3-small"): Embedder {
  return { async embed(texts) {
    const r = await post("https://api.openai.com/v1/embeddings", { authorization: `Bearer ${key}` }, { model, input: texts });
    return r.data.map((d: any) => d.embedding);
  } };
}
export function openAiLlm(key: string, model = process.env.LLM_MODEL ?? "gpt-4o-mini"): Llm {
  return { async complete(system, user) {
    const r = await post("https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${key}` },
      { model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
    return r.choices[0].message.content;
  } };
}
export function anthropicLlm(key: string, model = process.env.LLM_MODEL ?? "claude-haiku-4-5"): Llm {
  return { async complete(system, user) {
    const r = await post("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model, max_tokens: 600, system, messages: [{ role: "user", content: user }] });
    return r.content.map((c: any) => c.text ?? "").join("");
  } };
}

/** Embeddings always come from OpenAI (Anthropic has none). The LLM is selectable. */
export function aiFromEnv(): Ai {
  const openai = process.env.OPENAI_API_KEY;
  if (!openai) throw new Error("OPENAI_API_KEY is required for embeddings");
  const provider = process.env.LLM_PROVIDER ?? "openai";
  const llm = provider === "anthropic"
    ? anthropicLlm(process.env.ANTHROPIC_API_KEY ?? (() => { throw new Error("ANTHROPIC_API_KEY missing"); })())
    : openAiLlm(openai);
  return { embedder: openAiEmbedder(openai), llm };
}
