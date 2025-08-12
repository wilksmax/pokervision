// functions/api/analyze.js
//
// Cloudflare Pages Function:
// - gpt-4o with json_schema via text.format for strict extraction
// - uses input_image (data URL)  ✅
// - self-check correction pass on gpt-4o-mini
// - robust output parsing for Responses API

// ---------- helpers ----------
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

// Pull text from various Responses API shapes
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

// ---------- strict JSON schema ----------
const TableStateSchema = {
  name: "TableState",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      table: {
        type: "object",
        additionalProperties: false,
        properties: {
          game: { type: "string" },
          stakes: {
            type: "object",
            additionalProperties: false,
            properties: { sb: { type: "number" }, bb: { type: "number" } },
            required: ["sb","bb"]
          },
          minRaise: { type: ["number","null"] },
          maxBet:   { type: ["number","null"] },
          pot:      { type: "number" },
          board:    { type: "array", items: { type:"string" } },
          street:   { enum: ["preflop","flop","turn","river"] }
        },
        required: ["game","stakes","pot","board","street"]
      },
      hero: {
        type: "object",
        additionalProperties: false,
        properties: {
          seat: { type: ["integer","null"] },
          position: { type: ["string","null"] },
          stack: { type: ["number","null"] },
          hole:  { type: "array", items: { type:"string" } },
          toAct: { type: "boolean" },
          committedThisStreet: { type: ["number","null"] }
        },
        required: ["stack","hole","toAct"]
      },
      players: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            seat: { type: ["integer","null"] },
            position: { type: ["string","null"] },
            stack: { type: ["number","null"] },
            committedThisStreet: { type: ["number","null"] },
            inHand: { type: "boolean" }
          },
          required: ["stack","inHand"]
        }
      },
      actionHistory: { type: "array", items: { type: "object" } }
    },
    required: ["table","hero","players","actionHistory"]
  },
  strict: true
};

// ---------- function entry ----------
export async function onRequestPost(context) {
  try {
    const { env, request } = context; // Set OPENAI_API_KEY in Pages → Settings → Environment variables
    const form = await request.formData();
    const file = form.get('image');
    if (!file) {
      return new Response(JSON.stringify({ error: 'No image uploaded' }), { status: 400 });
    }

    // Blob -> base64 data URL
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const dataUrl = `data:${file.type};base64,${b64}`;

    // ---------- 1) Vision extraction (STRICT with schema via text.format) ----------
    const extractionReq = {
      model: 'gpt-4o',
      temperature: 0,
      text: { format: { type: 'json_schema', json_schema: TableStateSchema } },
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
`You read poker client screenshots (WSOP/GG skin). Return ONLY JSON that matches the provided schema.
Skin rules:
- The pot text appears as "Total Pot : X BB".
- Dealer button is the yellow "D"; compute positions from it.
- A folded seat shows card backs and no action chips/halo in front.
- Use null for anything unreadable—never invent values.
- Convert bets to BB when shown as BB.
- Do NOT wrap JSON in code fences.`
            }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract structured table state from this screenshot.' },
            { type: 'input_image', image_url: dataUrl } // ✅ use input_image (string data URL)
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

    // Prefer structured output when using json_schema format
    let state = exJson.output_parsed;
    if (!state) {
      const raw = getOutputText(exJson);
      if (!raw) return new Response(JSON.stringify({ error: 'Failed to parse JSON from vision output', raw }), { status: 422 });
      state = parseJsonLoose(raw);
    }

    if (!state?.table || !state?.hero || !Array.isArray(state?.players)) {
      return new Response(JSON.stringify({ error: 'Incomplete extraction', state }), { status: 422 });
    }

    // ---------- 1b) Self-check / correction pass (also uses json_schema via text.format) ----------
    const correctionReq = {
      model: 'gpt-4o-mini',
      temperature: 0,
      text: { format: { type: 'json_schema', json_schema: TableStateSchema } },
      input: [
        { role: 'system', content: [
          { type: 'input_text', text:
`Validate and correct this TableState:
- Pot (BB) must match the visible "Total Pot" text in the screenshot when present.
- "inHand" true only for seats with action halo or chips in front on this street.
- Street must match board cards: 0=preflop, 3=flop, 4=turn, 5=river.
- If positions conflict with the dealer button, fix positions.
Return corrected JSON only.` }
        ]},
        { role: 'user', content: [
          { type: 'input_text', text: JSON.stringify(state) }
        ]}
      ]
    };

    const corrRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(correctionReq)
    });

    if (corrRes.ok) {
      const corrJson = await corrRes.json();
      const correctedState = corrJson.output_parsed || (() => {
        const t = getOutputText(corrJson);
        return t ? parseJsonLoose(t) : null;
      })();
      if (correctedState) state = correctedState;
    }

    // ---------- 2) Strategy recommendation (textual JSON, no schema needed) ----------
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
- Do NOT wrap the JSON in code fences. Output JSON only.`
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
    const stratRaw = getOutputText(stJson);
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
