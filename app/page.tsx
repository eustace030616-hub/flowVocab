"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Span } from "@/src/lib/tokenize";
import { DEFAULT_POPOVER, placePopover } from "@/src/lib/ui/popover";

interface VocabularyEntry {
  lemma: string;
  pos: string;
  gloss: string | null;
  glossGenerated: boolean | null;
  glossSource: string | null;
  level: string | null;
  levelEstimated: boolean;
  difficulty: number;
  article: string | null;
  plural: string | null;
  status: string;
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;
}

interface Paragraph {
  _id: string;
  targetLang: "en" | "de";
  title: string;
  topic: string;
  content: string;
  wordCount: number;
  level: string | null;
  spans: Span[];
  marked: Record<string, string>;
  vocabulary: Record<string, VocabularyEntry>;
}

/** The state the API recomputes from the event log and returns after a mark or unmark. */
interface DerivedState {
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;
  status: string;
}

interface Me {  userId: string;
  track: "zh-en" | "en-de";
  targetLang: "en" | "de";
  glossLang: "en" | "zh";
  uiLocale: "en" | "zh";
  label: string;
  tracks: Array<{ id: "zh-en" | "en-de"; label: string; targetLang: string }>;
}

interface ActiveItem {
  /** charStart of the span that owns this item (a verb owns its detached particle). */
  ownerStart: number;
  span: Span;
  rect: DOMRect;
}

const UI: Record<"en" | "zh", Record<string, string>> = {
  en: {
    appName: "Flowwing",
    loading: "Loading…",
    empty: "No paragraphs for this track yet. Run the seed script.",
    rollback: "Rollback",
    next: "Next paragraph",
    met: "met",
    unfamiliar: "unfamiliar",
    lookups: "looked up",
    exposures: "seen",
    noGloss: "No gloss yet — import the dictionary layer to fill this in.",
    estimated: "estimated",
    coverage: "coverage",
    compound: "compound",
    separable: "separable verb",
    falseFriend: "false friend",
    cognate: "cognate",
    mastered: "known",
    eventLog: "append-only event log",
    language: "Language",
  },
  zh: {
    appName: "Flowwing",
    loading: "加载中…",
    empty: "该学习方向暂无段落，请先运行 seed 脚本。",
    rollback: "上一段",
    next: "下一段",
    met: "遇见",
    unfamiliar: "生词",
    lookups: "查询",
    exposures: "扫过",
    noGloss: "暂无释义 — 导入词典数据后显示。",
    estimated: "估算",
    coverage: "覆盖率",
    compound: "复合词",
    separable: "可分动词",
    falseFriend: "假朋友",
    cognate: "同源词",
    mastered: "已掌握",
    eventLog: "追加式事件日志",
    language: "语言",
  },
};

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * Placement must be measured before paint, but React warns about `useLayoutEffect` during
 * server rendering, and this component is server-rendered even though the popover itself only
 * ever appears after a hover.
 */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Hover timing.
 *
 * The dwell is long enough that sweeping the pointer across a line of text does not flash the
 * preview on every word, and the close delay is a grace period so a small wobble off the word
 * does not dismiss it. The two are deliberately asymmetric: opening should feel considered,
 * closing should feel immediate.
 */
const HOVER_OPEN_DELAY_MS = 600;
const HOVER_CLOSE_DELAY_MS = 120;

function amberIntensity(count: number): string {
  if (count <= 0) return "bg-amber-100/60";
  if (count === 1) return "bg-amber-100";
  if (count === 2) return "bg-amber-200";
  if (count === 3) return "bg-amber-300";
  return "bg-amber-400";
}

/**
 * Read JSON defensively.
 *
 * An API that throws still returns *something*: a 500 with an HTML error page, or Hono's JSON
 * error object. Calling `res.json()` on the former throws a parse error inside the component and
 * blanks the page, which tells the reader nothing. Failing softly lets the UI explain itself.
 */
async function readJson<T>(res: Response): Promise<T | null> {
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("application/json")) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function describeFailure(path: string, res: Response): string {
  return `${path} returned ${res.status} ${res.statusText}. The API could not reach the database, or a query failed. Check that MongoDB is running.`;
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [paragraphs, setParagraphs] = useState<Paragraph[]>([]);
  const [ready, setReady] = useState(false);
  const [paraIndex, setParaIndex] = useState(0);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [hoveredOwner, setHoveredOwner] = useState<number | null>(null);
  const [active, setActive] = useState<ActiveItem | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Live per-lemma state after a mark, kept OUT of `paragraphs`.
   *
   * Marking must not create a new paragraph object: the reset effect keys off the paragraph, so
   * a new identity re-ran it and reverted the mark that had just been applied — the tint flashed
   * and disappeared, and the click looked like it did nothing.
   */
  const [liveState, setLiveState] = useState<Record<string, Partial<VocabularyEntry>>>({});

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOnPopover = useRef(false);
  /** One exposure batch per paragraph per session. */
  const exposed = useRef<Set<string>>(new Set());
  const sessionId = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `s-${Date.now()}`,
  );

  const paragraph = paragraphs[paraIndex] ?? null;
  const t = UI[me?.uiLocale ?? "en"];

  const load = useCallback(async (track?: string) => {
    setError(null);

    const meRes = await fetch("/api/me");
    let meData = await readJson<Me>(meRes);
    if (!meData || !Array.isArray(meData.tracks)) {
      setMe(null);
      setParagraphs([]);
      setError(describeFailure("/api/me", meRes));
      setReady(true);
      return;
    }

    if (track && track !== meData.track) {
      const patched = await readJson<Partial<Me>>(
        await fetch("/api/me/track", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ track }),
        }),
      );
      // Merge rather than replace: the response carries the new track and its languages, and
      // requiring it to also carry `tracks` silently left the UI on the old track.
      if (patched?.targetLang) meData = { ...meData, ...patched } as Me;
    }
    setMe(meData);

    const res = await fetch(`/api/paragraphs?targetLang=${meData.targetLang}`);
    const data = await readJson<Paragraph[]>(res);
    if (!data) {
      setParagraphs([]);
      setError(describeFailure("/api/paragraphs", res));
    } else {
      setParagraphs(data);
    }

    setParaIndex(0);
    setReady(true);
  }, []);

  useEffect(() => {
    void load();
    // Both dimensions, kept current: placement clamps against the viewport, so a stale size
    // shows up as a popover in the wrong place.
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [load]);

  // Sync local marks + record exposure when the displayed paragraph changes.
  //
  // Deliberately keyed on the paragraph *identity*, not on every state update: `paragraphs` is
  // only replaced by `load()`, so this runs when the learner turns the page or switches track,
  // and not when they mark a word.
  useEffect(() => {
    if (!paragraph) return;
    const next = new Set<number>();
    for (const [start, status] of Object.entries(paragraph.marked)) {
      if (status === "marked") next.add(Number(start));
    }
    setMarked(next);
    setLiveState({});
    setActive(null);
    setHoveredOwner(null);

    if (!me || exposed.current.has(paragraph._id)) return;
    exposed.current.add(paragraph._id);

    const items = paragraph.spans
      .filter((s) => s.kind === "word" || s.kind === "number")
      .map((s) => ({
        surface: s.surface,
        lemmaKey: s.lemmaKey,
        charStart: s.start,
        charEnd: s.end,
      }));
    if (items.length === 0) return;

    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "exposure",
        targetLang: paragraph.targetLang,
        paragraphId: paragraph._id,
        sessionId: sessionId.current,
        items,
      }),
    });
  }, [paragraph, me]);

  /** A span's item identity: a detached particle belongs to the verb that absorbed it. */
  const ownerOf = useCallback((span: Span) => span.absorbedInto ?? span.start, []);

  const findSpan = useCallback(
    (ownerStart: number): Span | null =>
      paragraph?.spans.find((s) => s.start === ownerStart) ?? null,
    [paragraph],
  );

  const clearHoverTimer = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const raw = el?.closest("[data-owner]") as HTMLElement | null;
      const ownerStart = raw?.dataset.owner ? Number(raw.dataset.owner) : null;
      setHoveredOwner(ownerStart);

      if (active && ownerStart !== active.ownerStart && !isOnPopover.current) {
        clearHoverTimer();
        leaveTimer.current = setTimeout(() => {
          setActive(null);
          leaveTimer.current = null;
        }, HOVER_CLOSE_DELAY_MS);
      }
      if (active && ownerStart === active.ownerStart && leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      if (ownerStart === null || ownerStart === active?.ownerStart) return;

      clearHoverTimer();
      hoverTimer.current = setTimeout(() => {
        const span = findSpan(ownerStart);
        if (!span) return;
        const rect = (raw as HTMLElement).getBoundingClientRect();
        setActive({ ownerStart, span, rect });
      }, HOVER_OPEN_DELAY_MS);
    },
    [active, findSpan],
  );

  const handleBoxLeave = () => {
    setHoveredOwner(null);
    clearHoverTimer();
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const toggleMark = useCallback(async (ownerStart: number) => {
    if (!paragraph || !me) return;
    const span = paragraph.spans.find((s) => s.start === ownerStart);
    if (!span) return;
    const isMarked = marked.has(span.start);
    const vocab = { ...paragraph.vocabulary[span.lemmaKey], ...liveState[span.lemmaKey] };
    const body = {
      targetLang: paragraph.targetLang,
      lemmaKey: span.lemmaKey,
      lemma: span.lemma,
      // Sending the part of speech lets the server attach to the existing vocabulary entry
      // rather than creating a second row for the same word.
      pos: vocab?.pos ?? "",
      surface: span.surface,
      paragraphId: paragraph._id,
      charStart: span.start,
      charEnd: span.end,
    };

    setMarked((prev) => {
      const next = new Set(prev);
      if (isMarked) next.delete(span.start);
      else next.add(span.start);
      return next;
    });

    const url = isMarked ? "/api/words/ignore" : "/api/words/mark";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson<{ state?: DerivedState }>(res);
    if (!data) {
      setError(describeFailure(url, res));
      return;
    }
    const state = data.state;
    if (state) {
      setLastEvent(
        `${isMarked ? "unmark" : "mark"} → met ${state.timesMet}, unfamiliar ${state.unfamiliarity}, ${state.status}`,
      );
      // Overlay the recomputed state. Rebuilding the paragraph object here would change its
      // identity, re-run the reset effect below, and revert the mark that was just applied.
      setLiveState((prev) => ({
        ...prev,
        [span.lemmaKey]: {
          pos: vocab?.pos ?? "",
          status: state.status,
          timesMet: state.timesMet,
          unfamiliarity: state.unfamiliarity,
          lookupCount: state.lookupCount,
          exposureCount: state.exposureCount,
        },
      }));
    }
  }, [paragraph, me, marked, liveState]);

  const coverage = useMemo(() => {
    if (!paragraph) return null;
    const units = paragraph.spans.filter((s) => s.kind === "word" || s.kind === "number");
    if (units.length === 0) return null;
    let unknown = 0;
    for (const s of units) if (marked.has(ownerOf(s))) unknown += 1;
    return { total: units.length, unknown, value: (units.length - unknown) / units.length };
  }, [paragraph, marked, ownerOf]);

  /** Server vocabulary, with this session's post-mark overlay applied. */
  const vocabOf = (span: Span): VocabularyEntry | undefined => {
    const base = paragraph?.vocabulary[span.lemmaKey];
    const live = liveState[span.lemmaKey];
    if (!base && !live) return undefined;
    return { ...base, ...live } as VocabularyEntry;
  };

  const activeVocab = active ? vocabOf(active.span) : undefined;

  /**
   * The popover is positioned by an explicit top-left corner, computed from the word's own rect.
   *
   * `useLayoutEffect` so the measurement happens before paint: the box is rendered hidden for one
   * frame and then placed, which avoids a visible jump. An earlier version positioned it with a
   * `bottom` offset derived from the viewport height instead — that anchors it *above* the word, and
   * if the value is ever invalid the element falls back to its static position and appears to float
   * in the middle of the page.
   */
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (!active) {
      setPopoverPos(null);
      return;
    }
    const box = popoverRef.current;
    const size = box
      ? { width: box.offsetWidth, height: box.offsetHeight }
      : DEFAULT_POPOVER;
    const { top, left } = placePopover({
      anchor: active.rect,
      viewport,
      popover: size,
    });

    // Bail out when nothing moved. `setPopoverPos` with a fresh object always re-renders, and a
    // re-render re-runs this effect, so an unconditional set is an infinite loop.
    setPopoverPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    // Deliberately NOT depending on `activeVocab`: it is rebuilt as a fresh object on every render
    // (server vocabulary merged with the session overlay), so using it as a dependency made this
    // effect fire on every render and loop. Geometry depends on the anchor, the viewport and the
    // measured box — never on the text inside it.
  }, [active, viewport]);

  const isActiveOwner = (span: Span) => active?.ownerStart === ownerOf(span);
  const isHoveredOwner = (span: Span) => hoveredOwner === ownerOf(span);

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50">
      <header className="w-full h-14 bg-white border-b border-zinc-200 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-zinc-800">{t.appName}</h1>
          {me && (
            <span className="text-xs text-zinc-400">
              {me.track} · {t.language}: {me.targetLang}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {me?.tracks?.map((track) => (
            <button
              key={track.id}
              onClick={() => void load(track.id)}
              className={`h-8 px-3 text-xs font-medium rounded-lg transition-colors ${
                me.track === track.id
                  ? "bg-zinc-900 text-white"
                  : "border border-zinc-200 text-zinc-500 hover:bg-zinc-100"
              }`}
            >
              {track.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-4/5 flex flex-col p-6 overflow-auto">
          <div className="flex items-center justify-between h-10 mb-3">
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-500 font-medium">
                {paragraph ? `${paragraph.title} · ${paragraph.topic}` : t.empty}
              </span>
              {paragraph && (
                <span className="text-xs text-zinc-400">
                  {paragraph.wordCount} words ({paraIndex + 1}/{paragraphs.length})
                  {paragraph.level ? ` · ${paragraph.level}` : ""}
                </span>
              )}
              {coverage && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
                  {t.coverage} {(coverage.value * 100).toFixed(0)}% · {coverage.unknown}/
                  {coverage.total}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setParaIndex((i) => (i === 0 ? paragraphs.length - 1 : i - 1))}
                disabled={paragraphs.length === 0}
                className="h-8 px-4 text-sm font-medium border border-zinc-200 text-zinc-500 rounded-lg hover:bg-zinc-100 disabled:opacity-50 transition-colors"
              >
                {t.rollback}
              </button>
              <button
                onClick={() => setParaIndex((i) => (i + 1) % Math.max(paragraphs.length, 1))}
                disabled={paragraphs.length === 0}
                className="h-8 px-4 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 disabled:opacity-50 transition-colors"
              >
                {t.next}
              </button>
            </div>
          </div>

          <div
            className="flex-1 bg-white border border-zinc-200 rounded-xl p-6 overflow-auto"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleBoxLeave}
            onClick={(e) => {
              // Resolve the word from the click itself. Previously the handler used the hover
              // popover's state, so a plain click before the 350 ms hover delay did nothing.
              const el = (e.target as HTMLElement).closest("[data-owner]") as HTMLElement | null;
              const owner = el?.dataset.owner;
              if (owner === undefined || !el) return;
              const ownerStart = Number(owner);
              // Open the popover for the clicked word too, so the result of the click is visible
              // without waiting for a hover.
              const clicked = paragraph?.spans.find((s) => s.start === ownerStart);
              if (clicked) {
                setActive({ ownerStart, span: clicked, rect: el.getBoundingClientRect() });
              }
              void toggleMark(ownerStart);
            }}
          >
            {paragraph ? (
              <p className="text-lg leading-relaxed text-zinc-800 select-text">
                {paragraph.spans.map((span) => {
                  if (span.kind === "punct") {
                    return <span key={span.start}>{span.surface}</span>;
                  }
                  const owner = ownerOf(span);
                  const isMarked = marked.has(owner);
                  const vocab = vocabOf(span);
                  const unfam = vocab?.unfamiliarity ?? 0;
                  const highlight = isMarked
                    ? amberIntensity(unfam)
                    : isHoveredOwner(span) || isActiveOwner(span)
                      ? "bg-amber-100"
                      : "";
                  const border =
                    span.absorbedInto !== undefined
                      ? "border-b border-dashed border-amber-400"
                      : "";
                  const compound = span.compoundParts ? "border-b border-dotted border-sky-400" : "";
                  return (
                    <span
                      key={span.start}
                      data-owner={owner}
                      title={span.lemma}
                      className={`cursor-pointer rounded px-0.5 ${highlight} ${border} ${compound}`}
                    >
                      {span.surface}
                    </span>
                  );
                })}
              </p>
            ) : (
              <div className="text-lg text-zinc-400 italic">
                {error ? (
                  <div className="not-italic">
                    <p className="text-rose-600 text-sm font-medium mb-1">
                      Could not load the app
                    </p>
                    <p className="text-xs text-zinc-500">{error}</p>
                  </div>
                ) : ready ? (
                  t.empty
                ) : (
                  t.loading
                )}
              </div>
            )}

            {active && (
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
                  setActive(null);
                }}
                onClick={(e) => e.stopPropagation()}
                ref={popoverRef}
                className="fv-popover fixed z-50 bg-white border border-zinc-200 rounded-lg shadow-lg p-3 min-w-[200px] max-w-[320px]"
                style={{
                  top: popoverPos?.top ?? 0,
                  left: popoverPos?.left ?? 0,
                  // Hidden for the single frame before it is measured, so it never paints misplaced.
                  visibility: popoverPos ? "visible" : "hidden",
                  // Fades in only once it is placed, so the animation is not wasted on the hidden frame.
                  animation: popoverPos ? "fv-popover-in 140ms ease-out" : undefined,
                }}
              >
                <p className="text-lg font-semibold text-zinc-800">
                  {(() => {
                    const vocab = activeVocab;
                    return vocab?.article ? `${vocab.article} ` : "";
                  })()}
                  {active.span.lemma}
                  {(() => {
                    const vocab = activeVocab;
                    return vocab?.plural ? (
                      <span className="text-xs font-normal text-zinc-400">
                        {" "}
                        · pl. {vocab.plural}
                      </span>
                    ) : null;
                  })()}
                </p>

                <div className="flex flex-wrap gap-1 mt-1">
                  {(() => {
                    const vocab = activeVocab;
                    if (!vocab?.level) return null;
                    return (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 font-medium">
                        {vocab.level}
                        {vocab.levelEstimated ? ` (${t.estimated})` : ""}
                      </span>
                    );
                  })()}
                  {active.span.compoundParts && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">
                      {t.compound}: {active.span.compoundParts.join(" + ")}
                    </span>
                  )}
                  {active.span.detached && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                      {t.separable}
                    </span>
                  )}
                  {(() => {
                    const vocab = activeVocab;
                    if (!vocab) return null;
                    const flags: string[] = [];
                    if (vocab.status === "known") flags.push(t.mastered);
                    return flags.map((f) => (
                      <span
                        key={f}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700"
                      >
                        {f}
                      </span>
                    ));
                  })()}
                </div>

                {(() => {
                  const vocab = activeVocab;
                  if (vocab?.gloss) {
                    return (
                      <>
                        <div className="border-t border-zinc-100 my-2" />
                        <p className="text-sm text-zinc-600">{vocab.gloss}</p>
                        <p className="text-[10px] text-zinc-400 mt-1">
                          {vocab.glossSource}
                          {vocab.glossGenerated ? " · machine-generated" : ""}
                        </p>
                      </>
                    );
                  }
                  return (
                    <p className="text-xs text-zinc-400 mt-2 italic">{t.noGloss}</p>
                  );
                })()}

                {(() => {
                  const vocab = activeVocab;
                  if (!vocab) return null;
                  return (
                    <p className="text-[10px] text-zinc-400 mt-2">
                      {t.met} {vocab.timesMet} · {t.unfamiliar} {vocab.unfamiliarity} · {t.lookups}{" "}
                      {vocab.lookupCount} · {t.exposures} {vocab.exposureCount}
                    </p>
                  );
                })()}
              </div>
            )}
          </div>
        </div>

        <aside className="w-1/5 bg-white border-l border-zinc-200 flex flex-col shrink-0">
          <div className="h-1/2 flex flex-col items-center justify-center gap-3 p-4 border-b border-zinc-200">
            <div className="w-16 h-16 rounded-full bg-zinc-200 flex items-center justify-center text-zinc-400 text-2xl">
              ?
            </div>
            <span className="text-sm text-zinc-500">
              {me ? `${me.track}` : "…"}
            </span>
            <div className="flex items-center gap-1 mt-2">
              <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 font-medium">
                {me?.targetLang ?? "…"}
              </span>
              <span className="text-xs text-zinc-400">→</span>
              <span className="text-xs text-zinc-400">{me?.glossLang ?? "…"}</span>
            </div>
          </div>

          <div className="h-1/2 flex flex-col items-center justify-center p-4 gap-2">
            <p className="text-[10px] uppercase tracking-wide text-zinc-400">{t.eventLog}</p>
            <p className="text-xs text-zinc-500 text-center break-words">
              {lastEvent ?? "—"}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
