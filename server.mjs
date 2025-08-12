import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

// JSON Schema for table state extraction
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


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Loose JSON parser to handle models that return ```json fenced blocks
function parseJsonLoose(s) {
  if (!s || typeof s !== 'string') throw new Error('Empty response');
  let t = s.trim();

  // If wrapped in fences like ```json ... ```
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  } else {
    // Remove any stray backticks
    t = t.replace(/```/g, '').trim();
  }

  try {
    return JSON.parse(t);
  } catch {
    // Fallback: take first {...} slice
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const slice = t.slice(start, end + 1);
      return JSON.parse(slice);
    }
    throw new Error('Could not parse JSON');
  }
}

// Example schema used in the system prompt (kept concise but covers key fields)
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

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const imageB64 = await fs.readFile(req.file.path, { encoding: 'base64' });
    const dataUrl = `data:${req.file.mimetype};base64,${imageB64}`;
    console.log('MIME:', req.file.mimetype, 'b64len:', imageB64.length);

    // ===== 1) Vision extraction =====
    const extraction = await client.responses.create({
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
- Do NOT wrap the JSON in code fences. No backticks. Output JSON only.`
            }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Extract structured table state from this screenshot.' },
            { type: 'input_image', image_url: dataUrl } // string data URL
          ]
        }
      ]
    });

    const raw = extraction.output_text || '';
    let state;
    try {
      state = parseJsonLoose(raw);
    } catch (e) {
      return res.status(422).json({ error: 'Failed to parse JSON from vision output', raw });
    }

    if (!state?.table || !state?.hero || !Array.isArray(state?.players)) {
      return res.status(422).json({ error: 'Incomplete extraction', state });
    }

    // ===== 2) Strategy recommendation =====
    const strategy = await client.responses.create({
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
    });

    const stratRaw = strategy.output_text || '';
    let rec;
    try {
      rec = parseJsonLoose(stratRaw);
    } catch (e) {
      return res.status(422).json({ error: 'Failed to parse strategy JSON', stratRaw, state });
    }

    res.json({ state, recommendation: rec.recommendation });
  } catch (err) {
    console.error('OPENAI ERROR:', err?.response?.data || err?.message || err);
    const status = err?.status || err?.response?.status || 500;
    const msg = err?.response?.data?.error?.message || err?.message || 'Server error';
    res.status(status).json({ error: 'Server error', details: msg });
  } finally {
    if (req.file) {
      try { await fs.unlink(req.file.path); } catch {}
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Poker Vision server running at http://localhost:${port}`));
