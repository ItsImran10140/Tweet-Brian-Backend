/** Pull the first JSON object/array out of an LLM reply (handles ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();

  const tryParse = (s: string) => {
    try {
      return { ok: true as const, value: JSON.parse(s) as unknown };
    } catch {
      return { ok: false as const };
    }
  };

  const direct = tryParse(body);
  if (direct.ok) return direct.value;

  const firstObj = body.indexOf('{');
  const lastObj = body.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) {
    const r = tryParse(body.slice(firstObj, lastObj + 1));
    if (r.ok) return r.value;
  }
  const firstArr = body.indexOf('[');
  const lastArr = body.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) {
    const r = tryParse(body.slice(firstArr, lastArr + 1));
    if (r.ok) return r.value;
  }
  throw new Error('The model did not return valid JSON.');
}
