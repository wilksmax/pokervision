// functions/api/analyze.js

// ---- helpers ----
function parseJsonLoose(s) {
  if (!s || typeof s !== 'string') throw new Error('Empty response');
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  else t = t.replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Could not parse JSON');
  }
}

// Robustly pull text from Responses API payloads
function getOutputText(obj) {
  if (obj?.output_text && obj.output_text.trim()) return obj.output_text.trim();
  const out = [];
  const arr = obj?.output;
  if (Array.isArray(arr)) {
    for (const msg of arr) {
      const content = msg?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === 'string' && part.text.trim()) out.push(part.text.trim());
        }
      }
    }
  }
  return out.join('\n').trim();
}

const TABLE_STATE_JSON_EXAMPLE = {
  table: {
    game: "No Limit Hold'em",
    stakes: { sb: 0.5, bb: 1 },
    minRaise: 2,
    maxBet: null,
    pot: 12.5,
    board: ["Qs", "7d", "2c"],
    street: "flop"
  },
  hero: {
    seat: 4,
    position: "CO",
    stack: 112.4,
    hole: ["Ah", "Kh"],
    toAct: true,
    committedThisStreet: 3
  },
  players: [
    { seat: 1, position: "SB", stack: 48.2, committedThisStreet: 1, inHand: true },
    { seat: 2, position: "BB", stack: 63.0, committedThisStreet: 2, inHand: true },
    { seat: 3, position: "LJ", stack: 155.7, committedThisStreet: 0, inHand: true },
    { seat: 4, position: "CO", stack: 112.4, committedThisStreet: 3, inHand: true },
    { seat: 5, position: "BTN", stack: 97.8, committedThisStreet: 0, inHand: true }
  ],
  actionHistory: []
};

export async function onRequestPost(context) {
  try {
    const { env, request } = context; // OPENAI_API_KEY in env
    const form = await request.formData();
    const file = form.get('image');
    if (!file) {
      return new Response(JSON.stringify({ error: 'No image uploaded' }), { status: 400 });
    }

    // Blob -> data URL
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const dataUrl = `data:${file.type};base64,${b64}`;

    // ---------- 1) Vision extraction ----------
    const extractionReq = {
      model: 'gpt-4o-mini',
      temperature: 0,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
`You extract machine-precise JSON for poker table screenshots. Output ONLY JSON matching this schema: ${JSON.stringify(TABLE_STATE_JSON_EXAMPLE)}.
- Convert all amounts to big blinds (BB) when blinds are visible; otherwise keep currency and include {"currency":"$"}.
- Infer positions from the button and blinds when possible; else use null.
- Use null for unreadable fields; never invent values.
- "committedThisStreet" is per CURRENT street only.
- "actionHistory" is chronological; sizes in BB if blinds are known.
- Do NOT wrap JSON in code fences. Output JSON only.`
            }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract structured table state from this screenshot.' },
            { type: 'input_image', image_url: dataUrl }
          ]
        }
      ]
    };

    const exRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(extractionReq)
    });

    if (!exRes.ok) {
      const errText = await exRes.text();
      return new Response(JSON.stringify({ error: 'OpenAI extraction error', details: errText }), { status: 500 });
    }

    const exJson = await exRes.json();
    const raw = getOutputText(exJson); // <-- robust extraction
    if (!raw) {
      return new Response(JSON.stringify({ error: 'Failed to parse JSON from vision output', raw }), { status: 422 });
    }

    let state;
    try { state = parseJsonLoose(raw); }
    catch { return new Response(JSON.stringify({ error: 'Failed to parse JSON from vision output', raw }), { status: 422 }); }

    if (!state?.table || !state?.hero || !Array.isArray(state?.players)) {
      return new Response(JSON.stringify({ error: 'Incomplete extraction', state }), { status: 422 });
    }

    // ---------- 2) Strategy recommendation ----------
    const strategyReq = {
      model: 'gpt-4o-mini',
      temperature: 0,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
`You are a concise NLHE strategy engine. Return STRICT JSON:
{"recommendation":{"street":"preflop|flop|turn|river","options":[{"action":"fold|call|check|bet|raise","frequency":0-100,"size":null|"BB"|"X pot"}],"notes":"<=280 chars; include pot odds/SPR; flag uncertainty"}}
Rules:
- Frequencies sum to ~100.
- If bet/raise, include explicit size: BB if blinds known; else 0.33x/0.5x/0.66x pot.
- Cite numbers from the state in notes.
- If key fields are null, give a safe default and flag uncertainty.
- Do NOT wrap JSON in code fences. Output JSON only.`
            }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Compute action frequencies and sizes for this table state:' },
            { type: 'input_text', text: JSON.stringify(state) }
          ]
        }
      ]
    };

    const stRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(strategyReq)
    });

    if (!stRes.ok) {
      const errText = await stRes.text();
      return new Response(JSON.stringify({ error: 'OpenAI strategy error', details: errText }), { status: 500 });
    }

    const stJson = await stRes.json();
    const stratRaw = getOutputText(stJson); // <-- robust extraction
    if (!stratRaw) {
      return new Response(JSON.stringify({ error: 'Failed to parse strategy JSON', stratRaw, state }), { status: 422 });
    }

    let rec;
    try { rec = parseJsonLoose(stratRaw); }
    catch { return new Response(JSON.stringify({ error: 'Failed to parse strategy JSON', stratRaw, state }), { status: 422 }); }

    return new Response(JSON.stringify({ state, recommendation: rec.recommendation }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error', details: err?.message || String(err) }), { status: 500 });
  }
}
