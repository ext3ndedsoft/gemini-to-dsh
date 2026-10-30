// Smoke test for antigravity-bridge: text, tool call, tool round-trip, streaming.
const BASE = process.env.AG_BRIDGE_URL || 'http://127.0.0.1:8787';
const KEY = process.env.AG_BRIDGE_SECRET || 'local-bridge';

const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + KEY };

async function post(body) {
  const res = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(res.status + ' ' + text);
  }
  return res;
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  },
];

async function models() {
  const res = await fetch(BASE + '/v1/models', { headers });
  const json = await res.json();
  console.log('models:', json.data.map((m) => m.id).join(', '));
}

async function plainText() {
  const res = await post({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'Ответь ровно одним словом: работает?' }],
    max_tokens: 512,
  });
  const json = await res.json();
  console.log('text:', JSON.stringify(json.choices[0].message.content), 'finish:', json.choices[0].finish_reason);
  return json.choices[0].message.content;
}

async function toolRoundTrip() {
  const first = await post({
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: 'Какая сейчас погода в Москве? Используй инструмент.' }],
    tools,
    max_tokens: 2048,
  });
  const call = (await first.json()).choices[0].message.tool_calls;
  if (!call || !call.length) throw new Error('no tool call returned');
  const tc = call[0];
  console.log('tool_call:', tc.function.name, tc.function.arguments, 'id:', tc.id);

  const second = await post({
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: 'Какая сейчас погода в Москве? Используй инструмент.' },
      { role: 'assistant', content: null, tool_calls: [tc] },
      { role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify({ temp: '+3', condition: 'пасмурно' }) },
    ],
    tools,
    max_tokens: 2048,
  });
  const answer = (await second.json()).choices[0].message;
  console.log('after tool:', JSON.stringify(answer.content));
  if (!answer.content) throw new Error('empty answer after tool result');
}

async function streamed() {
  const res = await post({
    model: 'gemini-3.8-flash',
    stream: true,
    messages: [{ role: 'user', content: 'Считай до трёх, каждое число с новой строки, без лишних слов.' }],
    max_tokens: 1024,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let sawDone = false;
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!event.startsWith('data: ')) continue;
      const payload = event.slice(6);
      if (payload === '[DONE]') {
        sawDone = true;
        continue;
      }
      const chunk = JSON.parse(payload);
      const delta = chunk.choices[0].delta;
      if (delta.content) text += delta.content;
      if (chunk.usage) usage = chunk.usage;
    }
  }
  console.log('stream text:', JSON.stringify(text), 'done:', sawDone, 'usage:', JSON.stringify(usage));
}

await models();
await plainText();
await toolRoundTrip();
await streamed();
console.log('SMOKE OK');
