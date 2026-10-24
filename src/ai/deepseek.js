// Клиент DeepSeek (API совместим с OpenAI: /chat/completions, инструменты через tools).

export function createDeepSeek({ key, url, model, smartModel }) {
  return {
    model,
    smartModel: smartModel || model,
    async chat({ messages, tools, model: m, temperature = 0.3, maxTokens = 2000, timeoutMs = 60000 }) {
      if (!key) throw new Error("Не задан DEEPSEEK_API_KEY");
      const body = {
        model: m || model,
        messages: messages.map(clean),
        temperature,
        max_tokens: maxTokens,
      };
      if (tools?.length) { body.tools = tools; body.tool_choice = "auto"; }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(`${url}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new Error(e.name === "AbortError" ? "DeepSeek не ответил вовремя" : `DeepSeek недоступен: ${e.message}`);
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        const msg = data?.error?.message || text.slice(0, 200);
        const err = new Error(`DeepSeek: ${res.status} ${msg}`);
        err.status = res.status;
        throw err;
      }
      const choice = data.choices?.[0];
      return {
        message: choice?.message || { role: "assistant", content: "" },
        finish: choice?.finish_reason,
        usage: data.usage || null,
        model: data.model,
      };
    },
  };
}

// В историю обратно передаём только то, что API принимает (без reasoning_content и прочего)
function clean(m) {
  const out = { role: m.role, content: m.content ?? "" };
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: "function", function: c.function }));
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name && m.role !== "tool") out.name = m.name;
  return out;
}
