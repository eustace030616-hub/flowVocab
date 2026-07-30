import { Hono } from "hono";
import { handle } from "hono/vercel";
import { connectDB } from "@/src/lib/db";
import { Paragraph } from "@/src/models/Paragraph";
import { Word } from "@/src/models/Word";
import { ParagraphWord } from "@/src/models/ParagraphWord";

const app = new Hono().basePath("/api");

app.use("*", async (c, next) => {
  await connectDB();
  await next();
});

// ── Paragraphs ────────────────────────────────────

app.get("/paragraphs", async (c) => {
  const paragraphs = await Paragraph.find();
  return c.json(paragraphs);
});

app.get("/paragraphs/:id", async (c) => {
  const paragraph = await Paragraph.findById(c.req.param("id"));
  if (!paragraph) return c.json({ error: "Not found" }, 404);
  return c.json(paragraph);
});

// ── Words ─────────────────────────────────────────

// GET /api/words — all unfamiliar words (global)
app.get("/words", async (c) => {
  const status = c.req.query("status") || "unfamiliar";
  const words = await Word.find({ status }).populate("markedFrom", "title");
  return c.json(words);
});

// GET /api/words/:word — single word definition
app.get("/words/:word", async (c) => {
  const word = await Word.findOne({ word: c.req.param("word") });
  if (!word) return c.json({ error: "Not found" }, 404);
  return c.json(word);
});

// GET /api/paragraphs/:id/words — unfamiliar words for a specific paragraph
app.get("/paragraphs/:id/words", async (c) => {
  const words = await Word.find({
    markedFrom: c.req.param("id"),
    status: "unfamiliar",
  });
  return c.json(words);
});

// POST /api/words/mark — mark a word as unfamiliar (or create it)
app.post("/words/mark", async (c) => {
  const { word, definition, paragraphId, wordIndex } = await c.req.json();

  const existing = await Word.findOne({ word });

  if (existing) {
    const update: Record<string, unknown> = {
      status: "unfamiliar",
      $inc: { timesMet: 1, unfamiliarity: 1 },
    };
    const updated = await Word.findOneAndUpdate({ word }, update, { new: true });

    // Upsert ParagraphWord
    await ParagraphWord.findOneAndUpdate(
      { paragraphId, wordIndex },
      { wordId: existing._id, status: "marked", markedAt: new Date() },
      { upsert: true }
    );

    return c.json(updated);
  }

  // New word: create it
  const created = await Word.create({
    word,
    definition: definition || "",
    status: "unfamiliar",
    markedFrom: [paragraphId],
    timesMet: 1,
    unfamiliarity: 1,
  });

  // Create ParagraphWord
  await ParagraphWord.create({
    paragraphId,
    wordId: created._id,
    wordIndex,
    status: "marked",
  });

  return c.json(created, 201);
});

// PATCH /api/words/:word/status — change word status
app.patch("/words/:word/status", async (c) => {
  const { status } = await c.req.json();
  const word = await Word.findOneAndUpdate(
    { word: c.req.param("word") },
    { status },
    { new: true }
  );
  if (!word) return c.json({ error: "Not found" }, 404);
  return c.json(word);
});

// POST /api/words/batch — lookup multiple words at once
app.post("/words/batch", async (c) => {
  const { words } = await c.req.json();
  const found = await Word.find({ word: { $in: words } }).select("word definition timesMet unfamiliarity");
  return c.json(found);
});

// POST /api/words/ignore — decrement unfamiliarity (timesMet stays)
app.post("/words/ignore", async (c) => {
  const { words, paragraphId, wordIndex } = await c.req.json();
  const results: { word: string; timesMet: number; unfamiliarity: number }[] = [];

  for (const w of words) {
    const doc = await Word.findOne({ word: w });
    if (!doc) continue;
    const newUnfamiliarity = Math.max(0, doc.unfamiliarity - 1);
    await Word.updateOne(
      { word: w },
      {
        unfamiliarity: newUnfamiliarity,
        ...(newUnfamiliarity === 0 ? { status: "known" } : {}),
      }
    );

    // Update ParagraphWord status
    if (paragraphId) {
      const query: Record<string, unknown> = { paragraphId, wordId: doc._id };
      if (wordIndex !== undefined) query.wordIndex = wordIndex;
      await ParagraphWord.findOneAndUpdate(
        query,
        { status: newUnfamiliarity === 0 ? "known" : "ignored" }
      );
    }

    results.push({ word: w, timesMet: doc.timesMet, unfamiliarity: newUnfamiliarity });
  }

  return c.json(results);
});

// POST /api/paragraph-words/batch — fetch ParagraphWord records for a paragraph
app.post("/paragraph-words/batch", async (c) => {
  const { paragraphId, wordIds } = await c.req.json();
  const records = await ParagraphWord.find({
    paragraphId,
    wordId: { $in: wordIds },
    status: "marked",
  });
  // Return as a map of wordIndex → status for the frontend
  const result: Record<number, string> = {};
  for (const r of records) result[r.wordIndex] = r.status;
  return c.json(result);
});

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const DELETE = handle(app);
export const PATCH = handle(app);
