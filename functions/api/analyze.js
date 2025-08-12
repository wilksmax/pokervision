// functions/api/analyze.js
//
// Cloudflare Pages Function:
// - Strict extraction via text.format json_schema (gpt-4o)
// - Loose fallback (no schema) if strict fails
// - Deterministic corrections (street from board length, numeric coercions)
// - Self-check correction (gpt-4o-mini)
// - Robust Responses API parsing
//
// Set environment variables in Cloudflare Pages:
//   OPENAI_API_KEY = your key
//   STRICT_MODE    = "true" | "false"  (optional; defaults to "true")

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

// Deterministic corrections (safe, non-creative)
function enforceDeterministicCorrections(s) {
  try {
    const board = Array.isArray(s?.table?.board) ? s.table.board.filter(Boolean) : [];
    const streetByLen = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' }[board.length];
    if (streetByLen && s.table) s.table.street = streetByLen;

    // number coercions
    if (s?.table?.pot != null) s.table.pot = Number(s.table.pot);
    if (s?.table?.minRaise != null) s.table.minRaise = (s.table.minRaise===null?null:Number(s.table.minRaise));
    if (s?.table?.maxBet != null) s.table.maxBet = (s.table.maxBet===null?null:Number(s.table.maxBet));
    if (s?.table?.stakes?.sb != null) s.table.stakes.sb = Number(s.table.stakes.sb);
    if (s?.table?.stakes?.bb != null) s.table.stakes.bb = Number(s.table.stakes.bb);
    if (s?.hero?.stack != null) s.hero.stack = Number(s.hero.stack);
    if (s?.hero?.committedThisStreet != null) s.hero.committedThisStreet = (s.hero.committedThisStreet===null?null:Number(s.hero.committedThisStreet));
    if (!Array.isArray(s?.hero?.hole)) s.hero.hole = [];

    if (Array.isArray(s?.players)) {
      s.players = s.players.map(p => ({
        ...p,
        seat: p.seat == null ? null : Number(p.seat),
        stack: p.stack == null ? null : Number(p.stack),
        committedThisStreet: p.committedThisStreet == null ? null : Number(p.committedThisStreet),
        position: p.position ?? null,
        inHand: !!p.inHand
      }));
    }
  } catch {
    // ignore
  }
  return s;
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
            properties: {
              sb: { type: "number" },
              bb: { type: "number" }
            },
            required: ["sb", "bb"]
          },
          minRaise: { type: ["number", "null"] },
          maxBet:   { type: ["number", "null"] },
          pot:      { type: "number" },
          board:    { type: "array", items: { type: "string" } },
          street:   { enum: ["preflop", "flop", "turn", "river"] }
        },
        required: ["game", "stakes", "minRaise", "maxBet", "pot", "board", "street"]
      },

      hero: {
        type: "object",
        additionalProperties: false,
        properties: {
          seat: { type: ["integer", "null"] },
          position: { type: ["string", "null"] },
          stack: { type: ["number", "null"] },
          hole:  { type: "array", items: { type: "string" } },
          toAct: { type: "boolean" },
          committedThisStreet: { type: ["number", "null"] }
        },
        required: ["seat", "position", "stack", "hole", "toAct", "committedThisStreet"]
      },

      players: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            seat: { type: ["integer", "null"] },
            position: { type: ["string", "null"] },
            stack: { type: ["number", "null"] },
            committedThisStreet: { type: ["number", "null"] },
            inHand: { type: "boolean" }
          },
          required: ["seat", "position", "stack", "committedThisStreet", "inHand"]
        }
      },

      actionHistory: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            actor:  { type: "string" },                                // e.g., "BTN" or player name
            action: { enum: ["fold", "check", "call", "bet", "raise"] },
            size:   { type: ["number", "null"] },                       // in BB if known
            street: { enum: ["preflop", "flop", "turn", "river"] }
          },
          required: ["actor", "action", "size", "street"]
        }
      }
    },
    required: ["table", "hero", "players", "actionHistory"]
  },
  strict: true
};

// Build the format expected by Responses API at text.format
const JSON_SCHEMA_FORMAT = {
  type: 'json_schema',
  name: 'TableState',
  schema: TableStateSchema.schema,
  strict: true
};

// ---------- fallback (no schema) ----------
async function extractLoose(env, dataUrl) {
  const req = {
    model: 'gpt-4o',
    temperature: 0,
    input: [
      {
        role: 'system',
        content: [{
          type: 'input_text',
          text:
`Return ONLY valid JSON (no code fences) that matches this shape (keys/types only):
${JSON.stringify(TableStateSchema.schema, null, 2)}
Rules:
- Convert amounts to BB if displayed as BB.
- Use null for unreadable fields; never invent.
- Street must match board length: 0=preflop, 3=flop, 4=turn, 5=river.`
        }]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Extract table state JSON from this screenshot.' },
          { type: 'input_image', image_url: dataUrl }
        ]
      }
    ]
  };

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(req)
  });
  if (!r.ok) return null;
  const j = await r.json();
  const raw = getOutputText(j);
  if (!raw) return null;
  try { return parseJsonLoose(raw); } catch { return null; }
}

// ---------- function entry ----------
export async function onRequestPost(context) {
  try {
    const { env, request } = context;
    const strictMode = (env.STRICT_MODE ?? 'true').toLowerCase() !== 'false';

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

    let state = null;
    let strictErrorText = null;

    // ---------- 1) Strict extraction (json_schema via text.format) ----------
    if (strictMode) {
      const extractionReq = {
        model: 'gpt-4o',
        temperature: 0,
        text: { format: JSON_SCHEMA_FORMAT },
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

      if (exRes.ok) {
        const exJson = await exRes.json();
        state = exJson.output_parsed;
        if (!state) {
          const raw = getOutputText(exJson);
          if (raw) { try { state = parseJsonLoose(raw); } catch {} }
        }
      } else {
        strictErrorText = await exRes.text();
      }
    }

    // ---------- 1b) Loose fallback if needed ----------
    if (!state) {
      const loose = await extractLoose(env, dataUrl);
      state = loose;
      if (!state) {
        return new Response(JSON.stringify({
          error: 'OpenAI extraction error',
          details: strictErrorText || 'Strict & loose extraction failed'
        }), { status: 500 });
      }
    }

    // ---------- 1c) Deterministic corrections ----------
    state = enforceDeterministicCorrections(state);

    // ---------- 1d) Self-check / correction pass ----------
    const correctionReq = {
      model: 'gpt-4o-mini',
      temperature: 0,
      text: { format: JSON_SCHEMA_FORMAT },
      input: [
        { role: 'system', content: [
          { type: 'input_text', text:
`Validate and correct this TableState:
- Pot (BB) must match the visible "Total Pot" text in the screenshot when present (quote it to yourself; then set table.pot).
- Street must match board length: 0=preflop, 3=flop, 4=turn, 5=river.
- "inHand" true only for seats with action halo or chips in front on this street.
- If positions conflict with the dealer button "D", fix positions by rotating from the button.
Return corrected JSON only.`
          }
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
      if (correctedState) state = enforceDeterministicCorrections(correctedState);
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
