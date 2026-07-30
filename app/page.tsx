"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Paragraph {
  _id: string;
  title: string;
  content: string;
  topic: string;
  wordCount: number;
}

interface ActiveWord {
  index: number;
  word: string;
  rect: DOMRect;
  timesMet: number;
  unfamiliarity: number;
  definition: string;
  mastered: boolean;
}

interface WordRecord {
  _id: string;
  word: string;
  definition: string;
  timesMet: number;
  unfamiliarity: number;
}

function getWordIndexAtPoint(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const idx = (el as HTMLElement).dataset.wordIndex;
  return idx !== undefined ? parseInt(idx, 10) : null;
}

function amberIntensity(count: number): string {
  if (count <= 0) return "";
  if (count === 1) return "bg-amber-100";
  if (count === 2) return "bg-amber-200";
  if (count === 3) return "bg-amber-300";
  return "bg-amber-400";
}

export default function Home() {
  const [paragraphs, setParagraphs] = useState<Paragraph[]>([]);
  const [ready, setReady] = useState(false);
  const [paraIndex, setParaIndex] = useState(0);
  const [hoveredWord, setHoveredWord] = useState<number | null>(null);
  const [activeWord, setActiveWord] = useState<ActiveWord | null>(null);
  const [winHeight, setWinHeight] = useState(0);

  // Track marked words this session (indices), + DB-backed word records for lookups
  const [markedThisSession, setMarkedThisSession] = useState<Set<number>>(new Set());
  const [wordDB, setWordDB] = useState<Map<string, WordRecord>>(new Map());

  // Keep ref in sync so timer closures always read latest
  const updateWordDB = (fn: (prev: Map<string, WordRecord>) => Map<string, WordRecord>) => {
    setWordDB((prev) => {
      const next = fn(prev);
      wordDBRef.current = next;
      return next;
    });
  };

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOnPopover = useRef(false);
  const wordDBRef = useRef<Map<string, WordRecord>>(new Map());

  const paragraph = paragraphs[paraIndex] || null;
  const words = paragraph ? paragraph.content.split(" ") : [];

  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  // Fetch all paragraphs on mount
  const fetchParagraphs = async () => {
    const res = await fetch("/api/paragraphs");
    const data = await res.json();
    setParagraphs(data);
    setReady(true);
    if (data.length > 0) {
      setParaIndex(0);
      setMarkedThisSession(new Set());
      lookupWords(data[0].content, data[0]._id);
    }
  };

  // Look up all words from a paragraph in the Word DB, and restore persisted marks
  const lookupWords = async (content: string, pid: string) => {
    const uniqueWords = [...new Set(content.toLowerCase().split(" "))];

    // Batch lookup word records
    const res = await fetch("/api/words/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: uniqueWords }),
    });
    const records: WordRecord[] = await res.json();
    const map = new Map<string, WordRecord>();
    const wordIdToRecord: Map<string, WordRecord> = new Map();
    for (const r of records) {
      map.set(r.word, r);
      wordIdToRecord.set(r._id, r);
    }
    updateWordDB(() => map);

    // Fetch persisted ParagraphWord marks and restore markedThisSession
    if (wordIdToRecord.size > 0) {
      const pwRes = await fetch("/api/paragraph-words/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paragraphId: pid,
          wordIds: [...wordIdToRecord.keys()],
        }),
      });
      const markedStatus: Record<number, string> = await pwRes.json();
      // Keys are wordIndex values — use them directly
      const newMarks = new Set<number>();
      for (const key of Object.keys(markedStatus)) {
        if (markedStatus[Number(key)] === "marked") {
          newMarks.add(Number(key));
        }
      }
      setMarkedThisSession(newMarks);
    } else {
      setMarkedThisSession(new Set());
    }
  };

  const handleGenerate = async () => {
    if (!paragraph) return;
    if (paraIndex >= paragraphs.length - 1) return; // don't cycle past last

    // Figure out which words in this paragraph were ignored
    const allWords = [...new Set(paragraph.content.toLowerCase().split(" "))];
    const ignoredWords: string[] = [];

    for (let i = 0; i < words.length; i++) {
      const w = words[i].toLowerCase();
      const record = wordDB.get(w);
      if (record && !markedThisSession.has(i)) {
        ignoredWords.push(w);
      }
    }

    // Send ignored words to decrement counts
    if (ignoredWords.length > 0) {
      await fetch("/api/words/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: [...new Set(ignoredWords)], paragraphId: paragraph._id }),
      });
    }

    // Move to next paragraph (cycle)
    const nextIndex = (paraIndex + 1) % paragraphs.length;
    setParaIndex(nextIndex);
    setMarkedThisSession(new Set());
    setHoveredWord(null);
    setActiveWord(null);
    clearHoverTimer();
    lookupWords(paragraphs[nextIndex].content, paragraphs[nextIndex]._id);
  };

  useEffect(() => {
    fetchParagraphs();
    setWinHeight(window.innerHeight);
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const idx = getWordIndexAtPoint(e.clientX, e.clientY);
      setHoveredWord(idx);

      if (activeWord && idx !== activeWord.index && !isOnPopover.current) {
        clearHoverTimer();
        leaveTimer.current = setTimeout(() => {
          setActiveWord(null);
          leaveTimer.current = null;
        }, 50);
      }

      if (activeWord && idx === activeWord.index && leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }

      if (idx !== null && idx !== activeWord?.index) {
        clearHoverTimer();
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
        if (el) {
          const wordEl = el.closest("[data-word-index]") as HTMLElement;
          const wordStr = words[idx].toLowerCase();
          const record = wordDBRef.current.get(wordStr);
          hoverTimer.current = setTimeout(() => {
            const rect = wordEl?.getBoundingClientRect();
            if (rect && idx < words.length) {
              const isMarkedPersisted = markedThisSession.has(idx);
              setActiveWord({
                index: idx,
                word: words[idx],
                rect,
                timesMet: record?.timesMet || 0,
                unfamiliarity: record?.unfamiliarity || 0,
                definition: record?.definition || "",
                mastered: isMarkedPersisted && (record?.unfamiliarity || 0) === 0 && (record?.timesMet || 0) > 0,
              });
            }
          }, 400);
        }
      }
    },
    [activeWord, words, markedThisSession]
  );

  const handleBoxLeave = () => {
    setHoveredWord(null);
    clearHoverTimer();
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const handleClick = useCallback(async () => {
    if (hoveredWord === null || !paragraph) return;
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    const word = words[hoveredWord].toLowerCase();
    const isCurrentlyMarked = markedThisSession.has(hoveredWord);

    if (isCurrentlyMarked) {
      // Un-mark
      setMarkedThisSession((prev) => {
        const next = new Set(prev);
        next.delete(hoveredWord);
        return next;
      });
      fetch("/api/words/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: [word], paragraphId: paragraph._id, wordIndex: hoveredWord }),
      });
      updateWordDB((prevDB) => {
        const copy = new Map(prevDB);
        const existing = copy.get(word);
        if (existing) copy.set(word, { ...existing, unfamiliarity: Math.max(0, existing.unfamiliarity - 1) });
        return copy;
      });
    } else {
      // Mark — wait for API before allowing navigation away
      setMarkedThisSession((prev) => {
        const next = new Set(prev);
        next.add(hoveredWord);
        return next;
      });
      try {
        const res = await fetch("/api/words/mark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ word, paragraphId: paragraph._id, wordIndex: hoveredWord }),
        });
        const updated: WordRecord = await res.json();
        updateWordDB((prevDB) => {
          const copy = new Map(prevDB);
          copy.set(word, { word, definition: updated.definition, timesMet: updated.timesMet, unfamiliarity: updated.unfamiliarity, _id: updated._id });
          return copy;
        });
        // Update popover counter immediately
        setActiveWord((prev) =>
          prev?.index === hoveredWord
            ? { ...prev, timesMet: updated.timesMet, unfamiliarity: updated.unfamiliarity, mastered: updated.unfamiliarity === 0 && updated.timesMet > 0 }
            : prev
        );
      } catch { /* API call failed, but session mark is saved locally */ }
    }
  }, [hoveredWord, words, paragraph, markedThisSession]);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50">
      <header className="w-full h-14 bg-white border-b border-zinc-200 flex items-center px-6 shrink-0">
        <h1 className="text-lg font-semibold text-zinc-800">Vocab App</h1>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-4/5 flex flex-col p-6 overflow-auto">
          <div className="flex items-center justify-between h-10 mb-3">
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-500 font-medium">
                {paragraph ? `${paragraph.title} · ${paragraph.topic}` : "No paragraphs"}
              </span>
              <span className="text-xs text-zinc-400">
                {paragraph ? `${words.length} words (${paraIndex + 1}/${paragraphs.length})` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (paragraphs.length === 0) return;
                  const prevIndex = paraIndex === 0 ? paragraphs.length - 1 : paraIndex - 1;
                  setParaIndex(prevIndex);
                  setMarkedThisSession(new Set());
                  setHoveredWord(null);
                  setActiveWord(null);
                  clearHoverTimer();
                  lookupWords(paragraphs[prevIndex].content, paragraphs[prevIndex]._id);
                }}
                className="h-8 px-4 text-sm font-medium border border-zinc-200 text-zinc-500 rounded-lg hover:bg-zinc-100 transition-colors"
              >
                Rollback
              </button>
              <button className="h-8 px-4 text-sm font-medium border border-zinc-200 text-zinc-500 rounded-lg hover:bg-zinc-100 transition-colors">
                Topic ▼
              </button>
              <button
                onClick={handleGenerate}
                disabled={paragraphs.length === 0 || paraIndex >= paragraphs.length - 1}
                className="h-8 px-4 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 disabled:opacity-50 transition-colors"
              >
                Generate
              </button>
            </div>
          </div>

          <div
            className="flex-1 bg-white border border-zinc-200 rounded-xl p-6 overflow-auto"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleBoxLeave}
            onClick={handleClick}
          >
            {paragraph ? (
              <p className="text-lg leading-relaxed text-zinc-800 select-text">
                {words.map((word, i) => {
                  const record = wordDB.get(word.toLowerCase());
                  const unfam = record?.unfamiliarity || 0;
                  const isMarked = markedThisSession.has(i);
                  const isHovered = hoveredWord === i;

                  // Intensity comes from unfamiliarity. Marked-but-mastered → faint.
                  if (isMarked) {
                    const intensity =
                      unfam > 0
                        ? amberIntensity(unfam)
                        : "bg-amber-100/50";
                    return (
                      <mark
                        key={i}
                        data-word-index={i}
                        className={`${intensity} text-zinc-800 rounded px-0.5`}
                      >
                        {word}{" "}
                      </mark>
                    );
                  }
                  return (
                    <span
                      key={i}
                      data-word-index={i}
                      className={isHovered ? "bg-amber-100 rounded" : ""}
                    >
                      {word}{" "}
                    </span>
                  );
                })}
              </p>
            ) : !ready ? (
              <p className="text-lg text-zinc-400 italic">
                Loading...
              </p>
            ) : (
              <p className="text-lg text-zinc-400 italic">
                No paragraphs found. Run the seed script first.
              </p>
            )}

            {activeWord && (
              <div
                onMouseEnter={() => {
                  isOnPopover.current = true;
                  if (leaveTimer.current) {
                    clearTimeout(leaveTimer.current);
                    leaveTimer.current = null;
                  }
                }}
                onMouseLeave={() => {
                  isOnPopover.current = false;
                  if (leaveTimer.current) {
                    clearTimeout(leaveTimer.current);
                    leaveTimer.current = null;
                  }
                  setActiveWord(null);
                }}
                className="fixed z-50 bg-white border border-zinc-200 rounded-lg shadow-lg p-3 min-w-[120px]"
                style={{
                  left: activeWord.rect.left + activeWord.rect.width / 2,
                  bottom: winHeight - activeWord.rect.top + 8,
                  transform: "translateX(-50%)",
                }}
              >
                <p className="text-lg font-semibold text-zinc-800">
                  {activeWord.word}
                </p>
                {activeWord.timesMet > 0 || activeWord.mastered ? (
                  <p className="text-xs text-zinc-400">
                    Met {activeWord.timesMet} times
                    {activeWord.mastered
                      ? " · Mastered"
                      : activeWord.unfamiliarity > 0
                        ? ` · Unfamiliar ${activeWord.unfamiliarity}`
                        : ""}
                  </p>
                ) : null}
                {activeWord.definition && (
                  <>
                    <div className="border-t border-zinc-100 my-2" />
                    <p className="text-xs text-zinc-500">{activeWord.definition}</p>
                  </>
                )}
                {!activeWord.definition && activeWord.timesMet === 0 && (
                  <p className="text-xs text-zinc-400 mt-0.5">Definition coming soon</p>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="w-1/5 bg-white border-l border-zinc-200 flex flex-col shrink-0">
          <div className="h-1/2 flex flex-col items-center justify-center gap-3 p-4 border-b border-zinc-200">
            <div className="w-16 h-16 rounded-full bg-zinc-200 flex items-center justify-center text-zinc-400 text-2xl">
              ?
            </div>
            <span className="text-sm text-zinc-500">Guest</span>
            <button className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
              Sign in →
            </button>
            <div className="flex items-center gap-1 mt-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 font-medium">
                Learning
              </span>
              <span className="text-xs text-zinc-400">/</span>
              <span className="text-xs text-zinc-400">Review</span>
            </div>
          </div>

          <div className="h-1/2 flex flex-col items-center justify-center p-4">
            <p className="text-xs text-zinc-400 text-center">
              Questions will appear here after you finish reading.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
