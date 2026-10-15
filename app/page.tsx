"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Span } from "@/src/lib/tokenize";
import { DEFAULT_POPOVER, placePopover } from "@/src/lib/ui/popover";
import { groupMeanings, meaningLabel } from "@/src/lib/ui/meanings";
import { liveCoverage } from "@/src/lib/ui/coverage-label";

interface VocabularyEntry {
  lemma: string;
  pos: string;
  gloss: string | null;
  glossGenerated: boolean | null;
  glossSource: string | null;
  /** Estimated part of speech of the translation, e.g. "verb". */
  glossTermPos: string | null;
  /** Part of speech of the headword this gloss belongs to. */
  glossPos: string | null;
  /** Every reading of this headword, each labelled, when the source distinguishes them. */
  meanings: Array<{ pos: string | null; termPos: string | null; text: string; source: string }>;
  level: string | null;
  levelEstimated: boolean;
  difficulty: number;
  /** Probability this learner knows the word now, from the ability model. */
  pKnown: number | null;
  article: string | null;
  plural: string | null;
  status: string;
  timesMet: number;
  unfamiliarity: number;
  lookupCount: number;
  exposureCount: number;
}

/** Per-language ability from the event log, alongside the item difficulties it is measured on. */
interface AbilityView {
  targetLang: string;
  theta: number;
  se: number;
  n: number;
  level: string | null;
  levelLow: string;
  levelHigh: string;
  /** True when the number came from another language and this one has no evidence yet. */
  fromTransfer: boolean;
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
  /** Lexical coverage from the learner model, measured server-side from per-word probabilities. */
  coverage: {
    coverage: number;
    tokens: number;
    unknownIn: number;
    verdict: "too_hard" | "supported" | "comfortable";
    /** False when no ability has been measured, so the number is a prediction rather than a result. */
    measured: boolean;
    basis: { theta: number; n: number; se: number } | null;
  };
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
  /** Per-language ability, derived from the event log. */
  ability?: AbilityView[];
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
    noGloss: "No translation yet.",
    level: "Level",
    placement: "Placement test",
    placementWarn:
      "Answer yes only if you are sure you know the word. Some of these are not real words, and claiming them lowers your result.",
    placementKnown: "I know it",
    placementUnknown: "Don't know",
    placementSubmit: "Score my level",
    placementCancel: "Cancel",
    placementAnswered: "answered",
    placementHits: "real words claimed",
    placementFalseAlarms: "fake words claimed",
    placementCorrected: "corrected score",
    placementClose: "Done",
    levelUnknown: "not measured yet",
    levelFromOther: "seeded from your other language",
    levelRange: "somewhere in",
    estimated: "estimated",
    coverage: "known",
    coverageUnmeasured: "not measured yet",
    coverageUnmeasuredHint: "take the placement test",
    oneIn: "1 in",
    unfamiliarWords: "unfamiliar",
    coverageHelp:
      "Coverage: the share of this text's words you probably know, from your level and your reading history. 98% or more reads comfortably, below 95% is hard going.",
    verdictTooHard: "hard",
    verdictSupported: "supported",
    verdictComfortable: "comfortable",
    levelBasis: "level from",
    compound: "compound",
    parts: "Parts",
    headWord: "base word",
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
    noGloss: "暂无译文。",
    level: "水平",
    placement: "定级测试",
    placementWarn: "只有在确定认识这个词时才选「认识」。其中一部分不是真词，选了会拉低结果。",
    placementKnown: "认识",
    placementUnknown: "不认识",
    placementSubmit: "计算我的水平",
    placementCancel: "取消",
    placementAnswered: "已作答",
    placementHits: "认识的真词",
    placementFalseAlarms: "误选的非词",
    placementCorrected: "校正后得分",
    placementClose: "完成",
    levelUnknown: "尚未测量",
    levelFromOther: "来自另一语言的水平",
    levelRange: "大致范围",
    estimated: "估算",
    coverage: "已知",
    coverageUnmeasured: "尚未测量",
    coverageUnmeasuredHint: "去做定级测试",
    oneIn: "每",
    unfamiliarWords: "词 1 个生词",
    coverageHelp:
      "覆盖率：根据你的水平与阅读记录，估算这段文字中你已掌握的词占比。98% 以上可轻松阅读，低于 95% 会比较吃力。",
    verdictTooHard: "偏难",
    verdictSupported: "有支持",
    verdictComfortable: "轻松",
    levelBasis: "水平依据",
    compound: "复合词",
    parts: "构词成分",
    headWord: "核心词",
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

/** Compact part-of-speech labels for the preview. */
const POS_SHORT: Record<string, string> = {
  verb: "v",
  noun: "n",
  adjective: "adj",
  adverb: "adv",
};

function posLabel(pos: string | null | undefined): string | null {
  if (!pos) return null;
  return POS_SHORT[pos] ?? pos;
}

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
  /**
   * Words already recorded as looked up in this paragraph view.
   *
   * A lookup is weak evidence and biased — people check words they half-know — so recording the
   * same word every time the pointer crosses it would let a nervous reader's mouse movements
   * dominate the estimate. "Looked it up while reading this" is the signal; how many times the
   * popover flickered open is not.
   */
  const lookedUp = useRef<Set<string>>(new Set());
  const sessionId = useRef<string>(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `s-${Date.now()}`,
  );

  // Placement test session, held client-side while it is being taken. The item set carries no
  // signal about which entries are pseudowords — that is decided server-side.
  const [placement, setPlacement] = useState<{
    sessionId: string;
    items: Array<{ id: string; text: string }>;
  } | null>(null);
  const [placementAnswers, setPlacementAnswers] = useState<Record<string, boolean>>({});
  const [placementResult, setPlacementResult] = useState<{
    hits: number;
    falseAlarms: number;
    falseAlarmRate: number;
    corrected: number;
    dPrime: number;
    theta: number;
    se: number;
    level: string | null;
    levelLow: string;
    levelHigh: string;
    total: number;
  } | null>(null);
  const [placementBusy, setPlacementBusy] = useState(false);

  const paragraph = paragraphs[paraIndex] ?? null;
  const t = UI[me?.uiLocale ?? "en"];
  // Ability is per target language, so show the one for the content on screen.
  const activeAbility =
    me?.ability?.find((a) => a.targetLang === (paragraph?.targetLang ?? me?.targetLang)) ?? null;

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
    lookedUp.current.clear();

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

  /**
   * Record that the learner opened a word — `lookup`, the signal that was never sent.
   *
   * Deliberately not posted per hover event: once per word per paragraph view. The event log is
   * the source of truth for the ability model, and a log shaped by pointer jitter would be worse
   * than no log at all.
   */
  /**
   * Adopt an ability estimate the server returned.
   *
   * The header and the next paragraph both read `me.ability`, and marking is evidence — so the
   * response has to replace the stale copy rather than being discarded, which is what left the level
   * frozen while words were being marked.
   */
  const adoptAbility = useCallback((ability: AbilityView[] | undefined) => {
    if (!Array.isArray(ability) || ability.length === 0) return;
    setMe((prev) => (prev ? { ...prev, ability } : prev));
  }, []);

  const recordLookup = useCallback(
    (span: Span) => {
      const key = `${paragraph?._id ?? "?"}:${span.lemmaKey}`;
      if (lookedUp.current.has(key)) return;
      lookedUp.current.add(key);

      void fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "lookup",
          // The content's language, not the user's current track: a German paragraph is German
          // wherever it is displayed from.
          targetLang: paragraph?.targetLang,
          paragraphId: paragraph?._id,
          sessionId: sessionId.current,
          surface: span.surface,
          lemmaKey: span.lemmaKey,
          charStart: span.start,
          charEnd: span.end,
        }),
      });
    },
    [paragraph],
  );

  const startPlacement = useCallback(async () => {
    setPlacementBusy(true);
    setPlacementResult(null);
    setPlacementAnswers({});
    try {
      const res = await fetch("/api/placement", { method: "POST" });
      if (!res.ok) return;
      const session = (await res.json()) as {
        sessionId: string;
        items: Array<{ id: string; text: string }>;
      };
      setPlacement({ sessionId: session.sessionId, items: session.items });
    } finally {
      setPlacementBusy(false);
    }
  }, []);

  const submitPlacement = useCallback(async () => {
    if (!placement) return;
    setPlacementBusy(true);
    try {
      const res = await fetch("/api/placement/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: placement.sessionId,
          responses: placement.items.map((item) => ({
            id: item.id,
            yes: placementAnswers[item.id] === true,
          })),
        }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { result: NonNullable<typeof placementResult> };
      setPlacementResult(data.result);
      setPlacement(null);
      // The placement is now evidence, so the header's estimate is stale until it is re-read.
      const meRes = await fetch("/api/me");
      if (meRes.ok) setMe((await meRes.json()) as Me);
    } finally {
      setPlacementBusy(false);
    }
  }, [placement, placementAnswers]);

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
        // The dwell passed, so this is a real consultation rather than the pointer passing through.
        recordLookup(span);
      }, HOVER_OPEN_DELAY_MS);
    },
    [active, findSpan, recordLookup],
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
    const data = await readJson<{ state?: DerivedState; ability?: AbilityView[] }>(res);
    if (!data) {
      setError(describeFailure(url, res));
      return;
    }
    // The mark is evidence about ability as well as about this word, so the estimate comes back
    // with it. Adopting it is what makes the level stateful: the header moves now, and the next
    // paragraph is scored against the updated level rather than the one from before the mark.
    adoptAbility(data.ability);

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
  }, [paragraph, me, marked, liveState, adoptAbility]);

  /**
   * The words the learner has marked in this paragraph.
   *
   * A mark is stored against the occurrence, because that is what the tint has to follow — but the
   * learner's statement is about the *word*, so coverage needs the set of lemmas, not of spans.
   */
  const markedLemmas = useMemo(() => {
    const set = new Set<string>();
    for (const span of paragraph?.spans ?? []) {
      if (marked.has(ownerOf(span))) set.add(span.lemmaKey);
    }
    return set;
  }, [paragraph, marked, ownerOf]);

  /**
   * Lexical coverage of the paragraph, live.
   *
   * Previously computed from marked words alone — "unknown" meant "the learner clicked it" — which
   * ignored everything the event log knows and counted the word under the cursor. It now starts from
   * the model's per-word probability and applies this session's marks on top, recomputing the
   * verdict as it goes: the percentage moves with every mark, so a verdict fixed at load time made
   * the badge contradict itself.
   *
   * Whether the *ability* behind the probabilities was measured cannot change while reading, so that
   * still comes from the server.
   */
  const coverage = useMemo(() => {
    const server = paragraph?.coverage;
    if (!paragraph || !server) return null;

    const units = paragraph.spans.filter((s) => s.kind === "word");
    if (units.length === 0) return null;

    return {
      total: units.length,
      ...liveCoverage(
        units,
        (lemmaKey) => paragraph.vocabulary[lemmaKey]?.pKnown ?? undefined,
        markedLemmas,
      ),
      measured: server.measured,
      basis: server.basis,
    };
  }, [paragraph, markedLemmas]);

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
          {/* The ability estimate, from the event log. A single level is shown only when the
              interval is narrow enough to justify one; otherwise a range, or not measured at all. */}
          {activeAbility && (
            <span
              className="text-xs text-zinc-400"
              title={`θ=${activeAbility.theta.toFixed(2)} ± ${activeAbility.se.toFixed(2)} · n=${activeAbility.n.toFixed(1)}`}
            >
              {t.level}:{" "}
              {activeAbility.level ? (
                <span className="font-medium text-zinc-600">{activeAbility.level}</span>
              ) : activeAbility.n === 0 ? (
                <span>{t.levelUnknown}</span>
              ) : (
                <span>
                  {t.levelRange} {activeAbility.levelLow}–{activeAbility.levelHigh}
                </span>
              )}
              {activeAbility.fromTransfer && (
                <span className="ml-1 text-zinc-300">({t.levelFromOther})</span>
              )}
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
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    !coverage.measured
                      ? "bg-zinc-100 text-zinc-500"
                      : coverage.verdict === "too_hard"
                        ? "bg-amber-50 text-amber-700"
                        : coverage.verdict === "supported"
                          ? "bg-sky-50 text-sky-700"
                          : "bg-emerald-50 text-emerald-700"
                  }`}
                  title={
                    `${t.coverageHelp}\n` +
                    (coverage.measured && coverage.basis
                      ? `${t.levelBasis} θ=${coverage.basis.theta.toFixed(2)} ± ${coverage.basis.se.toFixed(2)} · n=${coverage.basis.n.toFixed(0)}`
                      : t.coverageUnmeasured)
                  }
                >
                  {coverage.measured ? (
                    <>
                      {t.coverage} {coverage.percent}%
                      {coverage.oneIn !== null && (
                        <>
                          {" · "}
                          {t.oneIn} {coverage.oneIn} {t.unfamiliarWords}
                        </>
                      )}
                      {" · "}
                      {coverage.verdict === "too_hard"
                        ? t.verdictTooHard
                        : coverage.verdict === "supported"
                          ? t.verdictSupported
                          : t.verdictComfortable}
                    </>
                  ) : (
                    <>
                      {t.coverage} {t.coverageUnmeasured}
                      {" · "}
                      <button
                        onClick={() => void startPlacement()}
                        className="underline hover:text-zinc-700"
                      >
                        {t.coverageUnmeasuredHint}
                      </button>
                    </>
                  )}
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
                recordLookup(clicked);
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
                    // Which entry was clicked: "train" is a noun and a verb, and they gloss
                    // differently, so the reading should be visible.
                    const label = posLabel(activeVocab?.glossPos);
                    if (!label) return null;
                    return (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 font-mono">
                        {label}
                      </span>
                    );
                  })()}
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
                      {t.compound}
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
                    // ONE template for every case. A word can have several readings — "train" is a
                    // noun (火车) and a verb (训练) — and a running-text token carries no part of
                    // speech, so the readings are grouped and labelled rather than one being picked
                    // silently. Previously the multi-reading case put the label on the left and the
                    // single-reading case put a different label on the right, which is why the same
                    // preview looked like "n 训练", "情绪化 adj" and "— 陪伴" in turn.
                    //
                    // Layout: a fixed-width label column, then the translations. The column is
                    // empty when no part of speech is known, so the text still lines up.
                    const groups = groupMeanings(vocab.meanings);
                    const rows =
                      groups.length > 0
                        ? groups
                        : [{ pos: vocab.glossPos, termPos: vocab.glossTermPos, texts: [vocab.gloss] }];
                    return (
                      <>
                        <div className="border-t border-zinc-100 my-2" />
                        <ul className="space-y-1">
                          {rows.map((group, index) => (
                            <li
                              key={`${group.pos ?? "-"}-${index}`}
                              className="flex items-baseline gap-2"
                            >
                              <span className="w-8 shrink-0 font-mono text-[10px] text-zinc-400">
                                {posLabel(meaningLabel(group)) ?? ""}
                              </span>
                              <span className="text-sm text-zinc-600">
                                {group.texts.join(", ")}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-[10px] text-zinc-400 mt-1">
                          {vocab.glossSource}
                          {vocab.glossGenerated ? " · machine-generated" : ""}
                        </p>
                      </>
                    );
                  }
                  // A compound without a direct entry is not missing anything: the breakdown
                  // below is the explanation, so apologising for a missing gloss there would
                  // contradict what is on screen.
                  if (active.span.compoundParts?.length) return null;
                  return (
                    <p className="text-xs text-zinc-400 mt-2 italic">{t.noGloss}</p>
                  );
                })()}

                {active.span.compoundParts && active.span.compoundParts.length > 0 && (
                  <>
                    <div className="border-t border-zinc-100 my-2" />
                    <p className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                      {t.parts}
                    </p>
                    <ul className="space-y-1">
                      {active.span.compoundParts.map((part, index) => {
                        const partVocab = paragraph?.vocabulary[part];
                        const groups = groupMeanings(partVocab?.meanings);
                        const meaning =
                          groups[0]?.texts.join(", ") ?? partVocab?.gloss ?? null;
                        const label = posLabel(
                          groups[0]?.pos ??
                            groups[0]?.termPos ??
                            partVocab?.glossPos ??
                            partVocab?.glossTermPos ??
                            null,
                        );
                        // German compounds are head-final: the last element is the base word and
                        // it is what fixes the gender and the plural.
                        const isHead = index === active.span.compoundParts!.length - 1;
                        return (
                          <li key={part} className="flex items-baseline gap-2">
                            <span className="w-8 shrink-0 font-mono text-[10px] text-zinc-400">
                              {label ?? ""}
                            </span>
                            <span className="text-sm text-zinc-700">
                              {partVocab?.article ? `${partVocab.article} ` : ""}
                              {partVocab?.lemma ?? part}
                              {meaning && <span className="text-zinc-500"> — {meaning}</span>}
                              {isHead && (
                                <span className="ml-1 text-[10px] text-zinc-400">
                                  ({t.headWord})
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

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
            <button
              onClick={() => void startPlacement()}
              disabled={placementBusy || !me}
              className="mt-3 h-8 px-3 text-xs font-medium border border-zinc-200 text-zinc-600 rounded-lg hover:bg-zinc-100 disabled:opacity-50 transition-colors"
            >
              {t.placement}
            </button>
          </div>

          <div className="h-1/2 flex flex-col items-center justify-center p-4 gap-2">
            <p className="text-[10px] uppercase tracking-wide text-zinc-400">{t.eventLog}</p>
            <p className="text-xs text-zinc-500 text-center break-words">
              {lastEvent ?? "—"}
            </p>
          </div>
        </aside>
      </div>

      {/*
        The placement test. A grid rather than one word at a time: 100 items on one screen is
        answered in a couple of minutes, and the yes/no decision is meant to be fast and instinctive
        — the protocol warns against over-claiming, and deliberating invites it.
      */}
      {(placement || placementResult) && (
        <div className="fixed inset-0 z-50 bg-white/98 backdrop-blur-sm flex flex-col">
          <div className="w-full max-w-5xl mx-auto flex flex-col flex-1 overflow-hidden px-8 py-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-zinc-800">{t.placement}</h2>
              {placement && (
                <span className="text-xs text-zinc-400">
                  {Object.keys(placementAnswers).length}/{placement.items.length} {t.placementAnswered}
                </span>
              )}
            </div>

            {placement && (
              <>
                <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3">
                  {t.placementWarn}
                </p>
                <div className="flex-1 overflow-auto mt-4 -mx-1 px-1">
                  <div className="grid grid-cols-4 gap-2">
                    {placement.items.map((item) => {
                      const answer = placementAnswers[item.id];
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-2 border border-zinc-200 rounded-lg px-3 py-2"
                        >
                          <span className="text-sm text-zinc-700 truncate">{item.text}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() =>
                                setPlacementAnswers((prev) => ({ ...prev, [item.id]: true }))
                              }
                              className={`text-[10px] px-2 py-1 rounded ${
                                answer === true
                                  ? "bg-emerald-600 text-white"
                                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                              }`}
                            >
                              {t.placementKnown}
                            </button>
                            <button
                              onClick={() =>
                                setPlacementAnswers((prev) => ({ ...prev, [item.id]: false }))
                              }
                              className={`text-[10px] px-2 py-1 rounded ${
                                answer === false
                                  ? "bg-zinc-700 text-white"
                                  : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                              }`}
                            >
                              {t.placementUnknown}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 pt-4">
                  <button
                    onClick={() => setPlacement(null)}
                    className="h-9 px-4 text-sm text-zinc-500 hover:text-zinc-700"
                  >
                    {t.placementCancel}
                  </button>
                  <button
                    onClick={() => void submitPlacement()}
                    disabled={placementBusy}
                    className="h-9 px-4 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {t.placementSubmit}
                  </button>
                </div>
              </>
            )}

            {placementResult && (
              <div className="flex-1 flex flex-col justify-center">
                <div className="max-w-md">
                  {/* The level is only named when the interval supports it; otherwise the range,
                      which is the same honesty rule the header follows. */}
                  <p className="text-3xl font-semibold text-zinc-800">
                    {placementResult.level ?? `${placementResult.levelLow}–${placementResult.levelHigh}`}
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">
                    θ={placementResult.theta.toFixed(2)} ± {placementResult.se.toFixed(2)}
                    {placementResult.level ? "" : ` · ${t.levelRange}`}
                  </p>
                  <dl className="mt-6 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-zinc-500">{t.placementHits}</dt>
                      <dd className="text-zinc-700">
                        {placementResult.hits}/{placementResult.total}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-zinc-500">{t.placementFalseAlarms}</dt>
                      <dd className="text-zinc-700">
                        {placementResult.falseAlarms} ({(placementResult.falseAlarmRate * 100).toFixed(0)}%)
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-zinc-500">{t.placementCorrected}</dt>
                      <dd className="text-zinc-700">{placementResult.corrected}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-zinc-500">d′</dt>
                      <dd className="text-zinc-700">{placementResult.dPrime.toFixed(2)}</dd>
                    </div>
                  </dl>
                  <button
                    onClick={() => setPlacementResult(null)}
                    className="mt-6 h-9 px-4 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-800"
                  >
                    {t.placementClose}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
