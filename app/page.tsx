"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Span } from "@/src/lib/tokenize";
import { DEFAULT_POPOVER, placePopover } from "@/src/lib/ui/popover";
import { groupMeanings, meaningLabel } from "@/src/lib/ui/meanings";
import { liveCoverage } from "@/src/lib/ui/coverage-label";
import { passageBand, unknownWords } from "@/src/lib/learner/band";
import { truncateWords } from "@/src/lib/ui/truncate";

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
  /** The level at θ, always present — shown as an estimate while the interval is wide. */
  levelPoint: string;
  levelLow: string;
  levelHigh: string;
  /** True when the number came from another language and this one has no evidence yet. */
  fromTransfer: boolean;
}

/** One entry in the history list: enough to show it, not enough to render it. */
interface ParagraphSummary {
  _id: string;
  title: string;
  topic?: string | null;
  level: string | null;
  wordCount: number;
  source: string;
  createdAt: string;
  starred: boolean;
  markedCount: number;
}

interface Paragraph {
  starred?: boolean;
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
    empty: "Nothing here yet — press Generate to write the first passage.",
    history: "History",
    historyEmpty: "Nothing yet — generate a paragraph to start.",
    historyMarked: "marked",
    met: "met",
    unfamiliar: "unfamiliar",
    lookups: "looked up",
    exposures: "seen",
    noGloss: "No translation yet.",
    current: "Current",
    words: "words",
    partOfSpeech: "POS",
    form: "Form",
    placementNext: "Next",
    placementFinish: "Finish",
    placementWasFake: "Not a real word",
    placementFakeHint: "Invented for this test — claiming it lowers your result.",
    placementNoGloss: "No translation yet.",
    placementKeepGoing: "Keep going for a more accurate estimate",
    older: "Older",
    newer: "Newer",
    star: "Keep this passage",
    unstar: "Stop keeping this passage",
    dontKnow: "Don't know this",
    iKnowThis: "I know this",
    level: "Level",
    generate: "Generation",
    generating: "Writing…",
    generateFailed: "Could not write one that measures up",
    placement: "Placement test",
    test: "Test",
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
    placementExit: "Exit",
    placementRetake: "Take it again",
    placementOneAtATime: "Answer for this word",
    placementPartial: "answered — a shorter test gives a wider interval, not a wrong one",
    levelUnknown: "N/A",
    levelFromOther: "seeded from your other language",
    levelRange: "somewhere in",
    estimated: "estimated",
    coverage: "known",
    coverageUnmeasured: "not measured yet",
    newWords: "new words",
    bandEasy: "easy",
    bandHard: "hard",
    bandVeryHard: "very hard",
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
    met: "遇见",
    unfamiliar: "生词",
    lookups: "查询",
    exposures: "扫过",
    noGloss: "暂无译文。",
    current: "当前",
    history: "历史",
    historyEmpty: "还没有内容 — 先生成一段。",
    historyMarked: "已标记",
    words: "词",
    partOfSpeech: "词性",
    form: "形式",
    placementNext: "下一个",
    placementFinish: "结束",
    placementWasFake: "这不是一个真实的词",
    placementFakeHint: "为本次测试编造 — 声称认识会降低结果。",
    placementNoGloss: "暂无译文。",
    placementKeepGoing: "继续作答，结果会更准确",
    older: "更早",
    newer: "更新",
    star: "收藏这段",
    unstar: "取消收藏",
    dontKnow: "不认识",
    iKnowThis: "我认识",
    level: "水平",
    generate: "生成",
    generating: "生成中…",
    generateFailed: "暂时写不出合格的段落",
    placement: "定级测试",
    test: "测试",
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
    placementExit: "退出",
    placementRetake: "重新测试",
    placementOneAtATime: "请判断这个词",
    placementPartial: "已作答 — 题目越少区间越宽，但不会偏。",
    levelUnknown: "N/A",
    levelFromOther: "来自另一语言的水平",
    levelRange: "大致范围",
    estimated: "估算",
    coverage: "已知",
    coverageUnmeasured: "尚未测量",
    newWords: "个生词",
    bandEasy: "简单",
    bandHard: "偏难",
    bandVeryHard: "很难",
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
  /**
   * The short list, and the one passage open.
   *
   * Previously the client loaded every paragraph in full and paged through them by index, which is
   * what the rollback button was for. Now the reader only ever moves forward: the list is a light
   * summary (no spans, no vocabulary) and opening an entry fetches that passage alone. A history that
   * grows without limit cannot be shipped to the client in full.
   */
  const [history, setHistory] = useState<ParagraphSummary[]>([]);
  /**
   * The live passage, and whether the reader is looking at history instead.
   *
   * Two modes rather than one list, because they are used differently. The current passage is where
   * reading happens — you generate, you mark, you move on. History is where you go back to something,
   * and going back should not mean the app has forgotten which passage was live: you need a way back
   * to it, and it is not in the list you are browsing.
   *
   * "Current" is the newest passage for the language, so it needs no flag in the database and there
   * is nothing to keep in sync — generating makes the new one current and the previous one history,
   * which is exactly the mental model.
   */
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * Something is being fetched for the reader.
   *
   * Switching language is the case that made this necessary: the old passage stayed on screen while
   * the new track's list and passage arrived, so the reader watched the previous language's text sit
   * there and then swap. A placeholder that occupies the same space is better than a stale page and
   * better than an empty one.
   */
  const [loading, setLoading] = useState(true);
  const [paragraph, setParagraph] = useState<Paragraph | null>(null);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  /** Whether the open passage is kept on purpose. Mirrors `paragraph.starred`, and moves on tap. */
  const [starred, setStarred] = useState(false);
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
  /** Which word of the test is on screen. One at a time: the judgement is meant to be fast. */
  const [placementIndex, setPlacementIndex] = useState(0);
  const [placementResult, setPlacementResult] = useState<{
    hits: number;
    falseAlarms: number;
    falseAlarmRate: number;
    corrected: number;
    answered: number;
    sessionSize: number;
    dPrime: number;
    theta: number;
    se: number;
    level: string | null;
    levelLow: string;
    levelHigh: string;
    total: number;
  } | null>(null);
  const [placementBusy, setPlacementBusy] = useState(false);
  /**
   * What the item turned out to be, shown only after it has been answered.
   *
   * The reveal is the second half of the question: a word the reader admitted not knowing is worth
   * more to them translated than counted, and a fake word is worth naming as one — the protocol is
   * easier to trust when it shows its work.
   */
  const [placementReveal, setPlacementReveal] = useState<{
    gloss: string | null;
    isPseudoword: boolean;
  } | null>(null);
  /** The estimate as it moves. The test has no length; this is what it is saying so far. */
  const [placementEstimate, setPlacementEstimate] = useState<{
    theta: number;
    se: number;
    level: string | null;
    levelLow: string;
    levelHigh: string;
    answered: number;
  } | null>(null);
  /** True while the generator is writing; it makes one to four model calls, so it is not instant. */
  const [generating, setGenerating] = useState(false);

  const t = UI[me?.uiLocale ?? "en"];
  // The ability estimate is deliberately not read here. It still runs the app — it chooses the level
  // of the next passage and scores coverage — but it is not displayed: the header shows the band, and
  // the one place a level is named is the placement test's own result, which is what the test is for.

  /**
   * Open one passage by id.
   *
   * One passage at a time, fetched in the shape the reader renders. `null` clears the view — a track
   * with nothing in it yet.
   */
  /**
   * What the reader shows while something is being fetched.
   *
   * Bars in the reading measure — same type size, same leading, same box padding — so the passage
   * arrives into exactly the space the placeholder occupied. Three blocks, because a passage is
   * three paragraphs and the height should be roughly right as well as the position.
   */
  const skeleton = (blocks = 3) => (
    <div className="space-y-8" aria-hidden="true">
      {Array.from({ length: blocks }).map((_, block) => (
        <div key={block} className="space-y-4">
          {[100, 94, 98, 62].map((width, line) => (
            <div
              key={line}
              className="h-4 rounded-none bg-zinc-100 animate-pulse"
              style={{ width: `${width}%`, animationDelay: `${(block * 4 + line) * 60}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );

  /** One bar sized like a line of chrome, for the heading and the metadata. */
  const skeletonLine = (width: string) => (
    <span
      className="inline-block h-3 rounded-none bg-zinc-100 animate-pulse"
      style={{ width }}
      aria-hidden="true"
    />
  );

  /** History as the reader sees it: everything except the passage they are living in. */
  const browsableHistory = useMemo(
    () => history.filter((item) => item._id !== currentId),
    [history, currentId],
  );

  /**
   * Where the open passage sits in the browsable list, counted from the newest.
   *
   * Null at the live passage, which is not in the list, and null if the list has moved on without it
   * (a passage pruned between the list being fetched and a row being clicked).
   */
  const historyPosition = useMemo(() => {
    if (!browsing || !paragraph) return null;
    const index = browsableHistory.findIndex((item) => item._id === paragraph._id);
    if (index === -1) return null;
    return { index, total: browsableHistory.length };
  }, [browsing, paragraph, browsableHistory]);

  /** Open a stored passage, and remember that the reader is in history rather than at the live one. */
  const openHistoryPassage = useCallback(
    async (id: string) => {
      setBrowsing(true);
      await openParagraph(id);
    },
    // `openParagraph` is stable; listing it keeps the lint honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * Step through history from whatever is open.
   *
   * The list is newest first, so a positive step is *older*. The ends are disabled rather than
   * wrapping: wrapping in a list you are navigating by memory is how you lose your place.
   */
  const stepHistory = useCallback(
    async (direction: 1 | -1) => {
      const openId = paragraph?._id;
      const index = browsableHistory.findIndex((item) => item._id === openId);
      const next = browsableHistory[(index === -1 ? 0 : index) + direction];
      if (!next) return;
      await openParagraph(next._id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [browsableHistory, paragraph?._id],
  );

  const openParagraph = useCallback(async (id: string | null): Promise<Paragraph | null> => {
    // The placeholder is raised here rather than by each caller, because a caller that forgets is a
    // path that fetches with the previous passage still on screen — which is exactly what going back
    // from history to the live passage did.
    setLoading(true);
    if (!id) {
      setParagraph(null);
      setLoading(false);
      return null;
    }
    const res = await fetch(`/api/paragraphs/${id}`);
    const data = await readJson<Paragraph>(res);
    if (!data) {
      setError(describeFailure(`/api/paragraphs/${id}`, res));
      setLoading(false);
      return null;
    }
    setParagraph(data);
    setLoading(false);
    return data;
  }, []);

  const load = useCallback(async (track?: string) => {
    setError(null);
    setLoading(true);

    const meRes = await fetch("/api/me");
    let meData = await readJson<Me>(meRes);
    if (!meData || !Array.isArray(meData.tracks)) {
      setMe(null);
      setHistory([]);
      setParagraph(null);
      setError(describeFailure("/api/me", meRes));
      setLoading(false);
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

    const res = await fetch(`/api/paragraphs?targetLang=${meData.targetLang}&summary=1`);
    const summaries = await readJson<ParagraphSummary[]>(res);
    if (!summaries) {
      setHistory([]);
      setError(describeFailure("/api/paragraphs", res));
      setLoading(false);
      return null;
    }

    setHistory(summaries);

    // Open the newest passage — the one just generated, or the last one read. The list is newest
    // first, so index 0 is the most recent, and it is "current" rather than history.
    setCurrentId(summaries[0]?._id ?? null);
    setBrowsing(false);
    const open = await openParagraph(summaries[0]?._id ?? null);
    setLoading(false);
    return open;
  }, [openParagraph]);

  useEffect(() => {
    void load();
    // Both dimensions, kept current: placement clamps against the viewport, so a stale size
    // shows up as a popover in the wrong place.
    const measure = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [load]);

  /**
   * Reset the per-view state when the displayed paragraph changes.
   *
   * Keyed on the paragraph's *identity string*, never on the `me` object or on the paragraph object
   * itself. Both were tried and both broke marking, in the same way: the effect resets `marked` from
   * the server's copy of the paragraph, so anything that re-ran it reverted the mark the learner had
   * just made. `me` re-ran it whenever an ability estimate came back from a mark — the click applied
   * and then visibly unapplied itself — and the paragraph object re-ran it whenever the paragraph
   * list was updated.
   */
  useEffect(() => {
    if (!paragraph) return;

    const next = new Set<number>();
    for (const [start, status] of Object.entries(paragraph.marked)) {
      if (status === "marked") next.add(Number(start));
    }
    setMarked(next);
    setStarred(Boolean(paragraph.starred));
    setLiveState({});
    setActive(null);
    setHoveredOwner(null);
    lookedUp.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on identity on purpose
  }, [paragraph?._id]);

  /**
   * Record exposure once per paragraph per session.
   *
   * Depends on the learner's id rather than the learner object, for the same reason: an ability
   * estimate arriving mid-read is not a new reader.
   */
  useEffect(() => {
    if (!paragraph || !me) return;
    // Not while browsing history.
    //
    // Exposure is the app's strongest passive signal — read past a word without marking it and it
    // counts as known, at 0.9 against a mark's 2.0. That is right for a passage the reader was given
    // to read and wrong for one they are stepping through: ten old passages visited in a minute would
    // say "I know every word in all of these", and the estimate would climb on navigation. The two
    // cannot be told apart from here, so the signal is only taken where the reading was intended.
    if (browsing) return;
    if (exposed.current.has(paragraph._id)) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the paragraph's identity, not its contents
  }, [paragraph?._id, me?.userId]);

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

  /**
   * Whether this device can hover.
   *
   * The reader was built for a pointer: dwelling on a word opens its meaning, and clicking marks it.
   * A phone has no hover, so a tap did both — you tapped a word to read its meaning and the app
   * recorded that you do not know it. A mark is the strongest negative signal in the model, so
   * inspecting words quietly taught the app that the passage was too hard for you.
   *
   * On a touch device a tap only opens; marking is a button in the popover, which is a deliberate act
   * on any device. On a pointer device the old behaviour stays.
   */
  const [canHover, setCanHover] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const apply = () => setCanHover(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  /**
   * Star the open passage, or unstar it.
   *
   * Optimistic, because it is a statement about the passage rather than evidence about the learner:
   * nothing downstream depends on it, so the icon can move on the tap and the request catch up. The
   * history list is updated too, so the exemption is visible where it matters.
   */
  const toggleStar = useCallback(async () => {
    if (!paragraph || !me) return;
    const next = !starred;
    setStarred(next);
    setHistory((prev) =>
      prev.map((item) => (item._id === paragraph._id ? { ...item, starred: next } : item)),
    );
    const res = await fetch(`/api/paragraphs/${paragraph._id}/star`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: next }),
    });
    if (!res.ok) {
      // Put it back rather than leaving the icon claiming something the server did not record.
      setStarred(!next);
      setHistory((prev) =>
        prev.map((item) => (item._id === paragraph._id ? { ...item, starred: !next } : item)),
      );
      setError(describeFailure(`/api/paragraphs/${paragraph._id}/star`, res));
    }
  }, [paragraph, me, starred]);

  /**
   * The strongest positive signal there is: the reader says they know this word.
   *
   * Also retracts a mark, because "I know this" contradicts "I do not know this" and leaving both in
   * the log would cancel out (a mark is −2.0, a confirmation +1.5) rather than mean either thing.
   */
  const recordConfirmed = useCallback(
    async (span: Span) => {
      if (!paragraph || !me) return;
      const body = {
        targetLang: paragraph.targetLang,
        lemmaKey: span.lemmaKey,
        lemma: span.lemma,
        pos: paragraph.vocabulary[span.lemmaKey]?.pos ?? "",
        surface: span.surface,
        paragraphId: paragraph._id,
        charStart: span.start,
        charEnd: span.end,
        sessionId: sessionId.current,
      };

      const confirmed = await readJson<{ ability?: AbilityView[] }>(
        await fetch("/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, type: "confirmed" }),
        }),
      );
      adoptAbility(confirmed?.ability);

      if (marked.has(span.start)) {
        const retracted = await readJson<{ ability?: AbilityView[] }>(
          await fetch("/api/words/ignore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        adoptAbility(retracted?.ability);
        setMarked((prev) => {
          const next = new Set(prev);
          next.delete(span.start);
          return next;
        });
        setParagraph((prev) =>
          prev && prev._id === paragraph._id
            ? { ...prev, marked: { ...prev.marked, [String(span.start)]: "ignored" } }
            : prev,
        );
        setHistory((prev) =>
          prev.map((item) =>
            item._id === paragraph._id
              ? { ...item, markedCount: Math.max(0, item.markedCount - 1) }
              : item,
          ),
        );
      }
    },
    [paragraph, me, marked, adoptAbility],
  );

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

  /**
   * Ask the server to write a new paragraph, then show it.
   *
   * No limit by design: every press draws a fresh topic and therefore a new brief, so a new paragraph
   * arrives each time. The server only returns one that passed the rubric and the coherence judge —
   * a failure comes back with its reasons rather than as text.
   */
  const generateParagraph = useCallback(async () => {
    if (!me) return;
    setGenerating(true);
    setError(null);
    try {
      // A deliberate pause, hardcoded rather than real: a pregenerated passage is served instantly,
      // and an instantaneous button both reads as fake and lets one determined press drain the stock
      // faster than it can be refilled. Two to three seconds is roughly what writing one costs and
      // keeps the pace honest.
      const pause = 2000 + Math.random() * 1000;

      const [res] = await Promise.all([
        fetch("/api/paragraphs/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetLang: paragraph?.targetLang ?? me.targetLang }),
        }),
        new Promise((resolve) => setTimeout(resolve, pause)),
      ]);
      const data = await readJson<{
        paragraphId?: string;
        title?: string;
        error?: string;
        issues?: string[];
      }>(res);

      if (!data?.paragraphId) {
        setError(
          data?.error
            ? `${t.generateFailed}: ${data.error}${data.issues?.length ? ` — ${data.issues[0]}` : ""}`
            : describeFailure("/api/paragraphs/generate", res),
        );
        return;
      }

      // Refresh the list and open what was just written. Forward is the only direction now, so this
      // is the reader's way onward.
      const summaries = await readJson<ParagraphSummary[]>(
        await fetch(`/api/paragraphs?targetLang=${paragraph?.targetLang ?? me.targetLang}&summary=1`),
      );
      if (summaries) setHistory(summaries);
      // A generated passage is the live one; whatever was live before it joins history.
      setCurrentId(data.paragraphId);
      setBrowsing(false);
      await openParagraph(data.paragraphId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "generation failed");
    } finally {
      setGenerating(false);
    }
  }, [me, paragraph, openParagraph, t.generateFailed]);

  const startPlacement = useCallback(async () => {
    setPlacementBusy(true);
    setPlacementResult(null);
    setPlacementAnswers({});
    setPlacementIndex(0);
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

  const submitPlacement = useCallback(async (answers: Record<string, boolean> = placementAnswers) => {
    if (!placement) return;
    setPlacementBusy(true);
    try {
      const res = await fetch("/api/placement/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: placement.sessionId,
          // Only the items actually answered. Sending the rest as "no" would score a learner who
          // exited early as if they had denied every word they never reached.
          responses: placement.items
            .filter((item) => answers[item.id] !== undefined)
            .map((item) => ({ id: item.id, yes: answers[item.id] === true })),
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

  /**
   * Answer the word on screen.
   *
   * Advancing on the answer is the whole interaction: the yes/no judgement is meant to be fast and
   * instinctive, and the protocol warns against over-claiming precisely because deliberation invites
   * it. The last answer submits rather than leaving a finished test waiting on a button.
   */
  /**
   * Answer the current word, then show what it was.
   *
   * The server is asked rather than the answer being recorded locally, because two things come back
   * that only the server knows: the translation (or that the word is fake), and the estimate so far.
   * It may also return more items — the queue is topped up around wherever the estimate has moved,
   * which is what makes the test open-ended.
   */
  const answerPlacement = useCallback(
    async (yes: boolean) => {
      if (!placement || placementReveal) return;
      const item = placement.items[placementIndex];
      if (!item) return;

      setPlacementAnswers((prev) => ({ ...prev, [item.id]: yes }));
      const res = await fetch("/api/placement/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: placement.sessionId, itemId: item.id, yes }),
      });
      const data = await readJson<{
        gloss: string | null;
        isPseudoword: boolean;
        answered: number;
        served: number;
        items: Array<{ id: string; text: string }>;
        estimate?: { theta: number; se: number; level: string | null; levelLow: string; levelHigh: string };
      }>(res);
      if (!data) {
        setError(describeFailure("/api/placement/answer", res));
        return;
      }
      setPlacementReveal({ gloss: data.gloss, isPseudoword: data.isPseudoword });
      if (data.estimate) {
        setPlacementEstimate({ ...data.estimate, answered: data.answered });
      }
      if (data.items?.length) {
        setPlacement((prev) =>
          prev ? { ...prev, items: [...prev.items, ...data.items] } : prev,
        );
      }
    },
    [placement, placementIndex, placementReveal],
  );

  /** Move to the next word, clearing the reveal. */
  const nextPlacementItem = useCallback(() => {
    setPlacementReveal(null);
    setPlacementIndex((index) => index + 1);
  }, []);

  /**
   * Leave the test. Whatever was answered is scored; nothing answered simply closes it.
   *
   * Abandoning silently would throw away real evidence, and a partial test is not an invalid one —
   * rates over the answered subset are unbiased, and the interval widens to say so.
   */
  const exitPlacement = useCallback(() => {
    if (!placement) return;
    if (Object.keys(placementAnswers).length === 0) {
      setPlacement(null);
      return;
    }
    void submitPlacement();
  }, [placement, placementAnswers, submitPlacement]);

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

    // Persist the mark into the paragraph list as well as the live overlay. The overlay tints the
    // current view; the list is what a later visit to this paragraph reads. Updating it no longer
    // resets anything, because the reset is keyed on the paragraph's identity string.
    // Record it on the open passage as well as in the live overlay: the overlay tints what is on
    // screen now, the passage's own `marked` map is what a later visit reads.
    setParagraph((prev) =>
      prev && prev._id === paragraph._id
        ? {
            ...prev,
            marked: { ...prev.marked, [String(span.start)]: isMarked ? "ignored" : "marked" },
          }
        : prev,
    );
    // And keep the history list's mark count honest without refetching it.
    setHistory((prev) =>
      prev.map((item) =>
        item._id === paragraph._id
          ? { ...item, markedCount: Math.max(0, item.markedCount + (isMarked ? -1 : 1)) }
          : item,
      ),
    );

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

    const pKnownOf = (lemmaKey: string) => paragraph.vocabulary[lemmaKey]?.pKnown ?? undefined;

    // The same count the server computes, recomputed as the reader marks: the share they can read,
    // and how many words are actually new to them.
    const unknown = unknownWords(paragraph.spans, {
      pKnownOf,
      isMarked: (lemmaKey) => markedLemmas.has(lemmaKey),
    });

    return {
      total: units.length,
      ...liveCoverage(units, pKnownOf, markedLemmas),
      unknown: { count: unknown.count, band: passageBand(unknown.count) },
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
  const isActiveMarked = active ? marked.has(active.ownerStart) : false;

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
    // `h-[100dvh]` rather than `min-h-screen`: the shell is exactly the viewport and never scrolls,
    // so the header, the badge and the buttons hold still while the passage scrolls inside its own
    // box. `dvh` because a phone's viewport changes height as the browser chrome hides and shows, and
    // `vh` would leave the buttons half under it.
    <div className="fv-safe-bottom h-[100dvh] flex flex-col bg-white text-zinc-900 overflow-hidden">
      {/* A 2px rule under the header, the way a section is marked in print — the header is not a
          panel with a shadow, it is the top of the page. */}
      <header className="w-full min-h-16 fv-rule-bottom bg-white flex items-center justify-between gap-2 px-4 sm:px-6 py-4 shrink-0">
        <div className="flex items-center gap-4">
          {/* The hero course name: the style's second deliberate exception, and the only text on
              the page that carries the misregistration fringe. */}
          <h1 className="fv-hero text-xl font-medium tracking-tight text-zinc-900">{t.appName}</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* On a phone the sidebar is hidden, so its two actions live here instead. */}
          <button
            onClick={() => setHistoryOpen(true)}
            disabled={!me || loading}
            className="fv-touch md:hidden h-8 px-2 text-xs font-medium border border-zinc-200 text-zinc-600 rounded-none hover:bg-zinc-100 disabled:opacity-50 transition-colors"
          >
            {t.history}
            {history.length > 0 && <span className="ml-1 text-zinc-400">{history.length}</span>}
          </button>
          {/* Not in history. A placement test is something you sit down to from the live passage,
              and its result would arrive while you are looking at something else. */}
          {!browsing && (
            <button
              onClick={() => void startPlacement()}
              disabled={placementBusy || generating || loading || !me}
              className="fv-touch md:hidden h-8 px-2 text-xs font-medium border border-zinc-200 text-zinc-600 rounded-none hover:bg-zinc-100 disabled:opacity-50 transition-colors"
            >
              {t.test}
            </button>
          )}
          {/* In history the language control gives way to the way back: switching track while
              browsing a stored passage would leave the reader nowhere. One tap returns to the live
              passage, which is the one thing you want from here. */}
          {browsing && (
            <button
              onClick={() => {
                if (currentId) void openParagraph(currentId);
                setBrowsing(false);
              }}
              className="fv-touch h-8 px-4 text-xs font-medium bg-zinc-900 text-white rounded-none hover:bg-zinc-800 transition-colors"
            >
              {t.current}
            </button>
          )}
          {!browsing && me?.tracks && me.tracks.length > 0 && (
            <div className="flex h-8 rounded-none border border-zinc-200 overflow-hidden">
              {me.tracks.map((track) => (
                <button
                  key={track.id}
                  onClick={() => void load(track.id)}
                  disabled={loading}
                  className={`fv-touch px-2 text-xs font-medium transition-colors disabled:opacity-50 ${
                    me.track === track.id
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-500 hover:bg-zinc-100"
                  }`}
                >
                  {track.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
        <div className="w-full md:w-4/5 flex flex-col min-h-0 p-4 sm:p-4 md:p-6">
          {/*
            Two rows, because the reader is doing two different things.

            Row one says what you are looking at and where you are: the topic, and — in history — how
            far through the list you have walked. Row two is the metadata on the left and the actions
            on the right, with room to be tapped on a phone. The level is gone from both, and the space
            it and the test button used is what this format is made of.
          */}
          <div className="flex flex-col gap-1 mb-2 shrink-0">
            <div className="flex items-center justify-between gap-4 min-w-0">
              <span
                className="text-sm font-medium text-zinc-700 truncate"
                title={paragraph ? (paragraph.topic ?? paragraph.title) : undefined}
              >
                {loading
                  ? skeletonLine("72px")
                  : paragraph
                    ? truncateWords(paragraph.topic ?? paragraph.title)
                    : t.empty}
              </span>

              {/* Where you are in the list. Navigating history by memory with no position is how you
                  lose your place, and the count is the one thing the list view cannot tell you once
                  it is closed. */}
              {browsing && historyPosition && (
                <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                  {historyPosition.index + 1} / {historyPosition.total}
                </span>
              )}
            </div>

            <div className="flex items-end justify-between gap-2">
              {/* The count and the band sit together on the action row, so the whole line reads
                  left to right as one statement: how long it is, how hard it is, what you can do. */}
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-zinc-400 truncate">
                  {loading
                    ? skeletonLine("56px")
                    : paragraph
                      ? `${paragraph.wordCount} ${t.words}`
                      : ""}
                </span>
                {loading && <span className="shrink-0">{skeletonLine("48px")}</span>}
                {!loading && coverage && (
                  // A label with a hairline, not a coloured pill: colour would compete with the one
                  // accent the style allows, and the word already carries the verdict.
                  <span
                    className="shrink-0 text-xs px-2 py-0.5 font-medium border fv-hairline text-zinc-600"
                    title={
                      `${t.coverageHelp}\n` +
                      (coverage.measured
                        ? `${t.coverage} ${coverage.percent}%` +
                          (coverage.oneIn !== null
                            ? ` · ${t.oneIn} ${coverage.oneIn} ${t.unfamiliarWords}`
                            : "") +
                          ` · ${
                            coverage.verdict === "too_hard"
                              ? t.verdictTooHard
                              : coverage.verdict === "supported"
                                ? t.verdictSupported
                                : t.verdictComfortable
                          }` +
                          ` · ${coverage.unknown.count} ${t.newWords}`
                        : t.coverageUnmeasured)
                    }
                  >
                    {coverage.measured
                      ? coverage.unknown.band === "easy"
                        ? t.bandEasy
                        : coverage.unknown.band === "hard"
                          ? t.bandHard
                          : t.bandVeryHard
                      : t.coverageUnmeasured}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {/* Keep this one. The only thing here that is about the passage rather than the words
                    in it, and the only exemption from being forgotten once it is old and unmarked. */}
                {paragraph && (
                  <button
                    onClick={() => void toggleStar()}
                    disabled={!me || loading}
                    aria-pressed={starred}
                    title={starred ? t.unstar : t.star}
                    className={`fv-touch h-8 w-8 text-sm leading-none rounded-none border transition-colors disabled:opacity-50 ${
                      starred
                        ? "border-[#da291c] text-[#da291c]"
                        : "border-zinc-200 text-zinc-400 hover:bg-zinc-100"
                    }`}
                  >
                    {starred ? "★" : "☆"}
                  </button>
                )}

                {/* Two modes, one button position. At the live passage this generates — forward is
                    still the only direction there — and in history it walks the stored ones instead,
                    because generating from inside history would strand you somewhere you did not
                    choose to be. */}
                {browsing ? (
                  <>
                    <button
                      onClick={() => void stepHistory(1)}
                      disabled={!historyPosition || historyPosition.index >= historyPosition.total - 1}
                      className="fv-touch h-8 px-2 text-xs font-medium border border-zinc-200 text-zinc-600 rounded-none hover:bg-zinc-100 disabled:opacity-40 transition-colors"
                    >
                      ‹ {t.older}
                    </button>
                    <button
                      onClick={() => void stepHistory(-1)}
                      disabled={!historyPosition || historyPosition.index <= 0}
                      className="fv-touch h-8 px-2 text-xs font-medium border border-zinc-200 text-zinc-600 rounded-none hover:bg-zinc-100 disabled:opacity-40 transition-colors"
                    >
                      {t.newer} ›
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => void generateParagraph()}
                    disabled={generating || loading || !me}
                    className="fv-touch h-8 px-4 text-xs font-medium bg-zinc-900 text-white rounded-none hover:bg-zinc-800 disabled:opacity-50 transition-colors"
                  >
                    {generating ? t.generating : t.generate}
                  </button>
                )}
              </div>
            </div>
          </div>

          <div
            className="fv-reader flex-1 min-h-0 bg-white border border-zinc-200 rounded-none p-4 sm:p-6 overflow-y-auto overscroll-contain"
            onMouseMove={canHover ? handleMouseMove : undefined}
            onMouseLeave={canHover ? handleBoxLeave : undefined}
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
              // On a touch device a tap only opens the word. Marking is a button in the popover,
              // because a tap that both reveals a meaning and declares ignorance turns every glance
              // into evidence that the passage was too hard.
              if (canHover) void toggleMark(ownerStart);
            }}
          >
            {loading ? (
              skeleton()
            ) : paragraph ? (
              <p className="text-lg leading-relaxed text-zinc-800 select-text whitespace-pre-line">
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
                ) : (
                  t.empty
                )}
              </div>
            )}

            {/* On a touch device nothing closes the popover by itself — there is no pointer to leave
                with — so a tap anywhere else does it, which is what a phone user expects. It sits under
                the popover and above the page, and only exists where hovering is impossible. */}
            {active && !canHover && (
              <div
                className="fixed inset-0 z-40"
                onPointerDown={() => setActive(null)}
                aria-hidden="true"
              />
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
                className="fv-popover fixed z-50 bg-white border border-zinc-200 rounded-none p-4 min-w-[200px] max-w-[320px]"
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

                <dl className="grid grid-cols-[64px_1fr] gap-x-4 gap-y-2 mt-4 pt-4 border-t fv-hairline text-left">
                  {(() => {
                    const label = posLabel(activeVocab?.glossPos);
                    if (!label) return null;
                    return (
                      <>
                        <dt className="text-[10px] uppercase tracking-wide text-zinc-400 pt-0.5">
                          {t.partOfSpeech}
                        </dt>
                        <dd className="text-xs text-zinc-700 font-mono">{label}</dd>
                      </>
                    );
                  })()}
                  {(() => {
                    const vocab = activeVocab;
                    if (!vocab?.level) return null;
                    return (
                      <>
                        <dt className="text-[10px] uppercase tracking-wide text-zinc-400 pt-0.5">
                          {t.level}
                        </dt>
                        <dd className="text-xs text-zinc-700">
                          {vocab.level}
                          {vocab.levelEstimated ? ` (${t.estimated})` : ""}
                        </dd>
                      </>
                    );
                  })()}
                  {(active.span.compoundParts || active.span.detached) && (
                    <>
                      <dt className="text-[10px] uppercase tracking-wide text-zinc-400 pt-0.5">
                        {t.form}
                      </dt>
                      <dd className="text-xs text-zinc-700">
                        {[
                          active.span.compoundParts ? t.compound : null,
                          active.span.detached ? t.separable : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </dd>
                    </>
                  )}
                </dl>

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

                {/* The deliberate act, and the only way to mark on a phone — where a tap opens the
                    word and nothing else. On a pointer device the click still marks, so this is the
                    explicit alternative rather than the only route. */}
                <div className="flex items-center gap-2 mt-4 pt-4 border-t border-zinc-100">
                  {isActiveMarked ? (
                    <button
                      onClick={() => void recordConfirmed(active.span)}
                      className="h-8 px-4 text-xs font-medium rounded-none bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors"
                    >
                      {t.iKnowThis}
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => void toggleMark(active.ownerStart)}
                        className="h-8 px-4 text-xs font-medium rounded-none bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
                      >
                        {t.dontKnow}
                      </button>
                      <button
                        onClick={() => void recordConfirmed(active.span)}
                        className="h-8 px-4 text-xs font-medium rounded-none border border-zinc-200 text-zinc-600 hover:bg-zinc-100 transition-colors"
                      >
                        {t.iKnowThis}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="hidden md:flex md:w-1/5 bg-white border-l fv-hairline flex-col shrink-0">
          <div className="h-1/2 flex flex-col items-center justify-center gap-4 p-4 border-b border-zinc-200">
            <div className="w-16 h-16 rounded-none bg-zinc-200 flex items-center justify-center text-zinc-400 text-2xl">
              ?
            </div>
            <span className="text-sm text-zinc-500">
              {me ? `${me.track}` : "…"}
            </span>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs px-2 py-0.5 rounded-none bg-zinc-100 text-zinc-600 font-medium">
                {me?.targetLang ?? "…"}
              </span>
              <span className="text-xs text-zinc-400">→</span>
              <span className="text-xs text-zinc-400">{me?.glossLang ?? "…"}</span>
            </div>
            {/* History, not generation: the way onward is the button in the header now, and this
                is how you get back to something you read before. */}
            <button
              onClick={() => setHistoryOpen(true)}
              disabled={!me}
              className="fv-touch mt-4 h-8 px-4 text-xs font-medium border border-zinc-200 text-zinc-600 rounded-none hover:bg-zinc-100 disabled:opacity-50 transition-colors"
            >
              {t.history} {history.length > 0 && <span className="text-zinc-400">{history.length}</span>}
            </button>
            {/* Hidden while browsing, for the same reason as the header's: the test belongs to the
                live passage, not to the archive. */}
            {!browsing && (
              <button
                onClick={() => void startPlacement()}
                disabled={placementBusy || generating || !me}
                className="mt-2 h-8 px-4 text-xs font-medium border border-zinc-200 text-zinc-600 rounded-none hover:bg-zinc-100 disabled:opacity-50 transition-colors"
              >
                {t.placement}
              </button>
            )}
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
        History: every passage for this track, newest first, as a short list. Choosing one opens it in
        the reader — with its marks already tinted, because the passage's own `marked` map comes back
        with it and the tint reads from that.
      */}
      {historyOpen && (
        <div className="fixed inset-0 z-40 bg-white/98 backdrop-blur-sm flex flex-col">
          <div className="w-full max-w-3xl mx-auto flex flex-col flex-1 overflow-hidden px-8 py-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold text-zinc-800">
                {t.history} <span className="text-zinc-400 text-sm">{history.length}</span>
              </h2>
              <button
                onClick={() => setHistoryOpen(false)}
                className="h-8 px-4 text-sm text-zinc-500 hover:text-zinc-700"
              >
                {t.placementClose}
              </button>
            </div>

            <div className="flex-1 overflow-auto mt-4">
              {history.length === 0 ? (
                <p className="text-sm text-zinc-400">{t.historyEmpty}</p>
              ) : (
                <ul className="space-y-1">
                  {browsableHistory.map((item) => (
                    <li key={item._id}>
                      <button
                        onClick={() => {
                          void openHistoryPassage(item._id);
                          setHistoryOpen(false);
                        }}
                        className="w-full text-left flex items-center justify-between gap-4 px-4 py-2 rounded-none hover:bg-zinc-100 transition-colors"
                      >
                        <span className="text-sm text-zinc-700 truncate">{item.title}</span>
                        <span className="text-xs text-zinc-400 shrink-0 flex items-center gap-2">
                          {item.level && (
                            <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500">
                              {item.level}
                            </span>
                          )}
                          <span>{item.wordCount}w</span>
                          {item.markedCount > 0 && (
                            <span className="text-amber-600">
                              {item.markedCount} {t.historyMarked}
                            </span>
                          )}
                          {item.source === "agent" && <span title="generated">✦</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/*
        The placement test: one word at a time, yes or no, exitable at any point. A grid of 100
        items was tried and rejected — a wall of words invites scanning and over-claiming, where a
        single word on a blank page asks the only question the test is about.
      */}
      {(placementBusy || placement || placementResult) && (
        <div className="fixed inset-0 z-50 bg-white/98 backdrop-blur-sm flex flex-col">
          <div className="w-full max-w-5xl mx-auto flex flex-col flex-1 overflow-hidden px-8 py-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-medium tracking-tight text-zinc-900">{t.placement}</h2>
            </div>

            {placement && (
              <>
                {/* One word at a time, and the space under it is the reveal: the translation if the
                    word has one, or the admission that it was never a word. The gap is reserved from
                    the start so the word does not jump up the page when the answer lands. */}
                <div className="flex-1 flex flex-col items-center justify-center">
                  <p className="text-4xl font-medium tracking-tight text-zinc-900">
                    {placement.items[placementIndex]?.text ?? ""}
                  </p>

                  <div className="h-40 flex flex-col items-center justify-center gap-2">
                    {placementReveal ? (
                      <>
                        <p
                          className={`text-lg ${
                            placementReveal.isPseudoword ? "text-zinc-400" : "text-zinc-700"
                          }`}
                        >
                          {placementReveal.isPseudoword
                            ? t.placementWasFake
                            : (placementReveal.gloss ?? t.placementNoGloss)}
                        </p>
                        {placementReveal.isPseudoword && (
                          <p className="text-xs text-zinc-400">{t.placementFakeHint}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-zinc-400">{t.placementOneAtATime}</p>
                    )}
                  </div>

                  {placementReveal ? (
                    <button
                      onClick={nextPlacementItem}
                      className="h-11 w-full max-w-md text-sm font-medium bg-zinc-900 text-white rounded-none hover:bg-zinc-800"
                    >
                      {t.placementNext}
                    </button>
                  ) : (
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => void answerPlacement(true)}
                        className="h-11 px-8 text-sm font-medium bg-zinc-900 text-white rounded-none hover:bg-zinc-800"
                      >
                        {t.placementKnown}
                      </button>
                      <button
                        onClick={() => void answerPlacement(false)}
                        className="h-11 px-8 text-sm font-medium border border-zinc-300 text-zinc-600 rounded-none hover:bg-zinc-100"
                      >
                        {t.placementUnknown}
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-4">
                  <button
                    onClick={exitPlacement}
                    disabled={placementBusy}
                    className="fv-touch h-8 px-2 text-xs font-medium text-zinc-500 hover:text-zinc-700 disabled:opacity-50"
                  >
                    {t.placementFinish}
                  </button>

                  {/* What the test is concluding, as it concludes it — and a nudge once it has
                      enough to be worth something. There is no end, so the reader needs a reason to
                      keep going and a way to stop. */}
                  <div className="flex items-center gap-4 text-xs">
                    {placementEstimate && placementEstimate.answered >= 3 && (
                      <span className="tabular-nums text-zinc-500">
                        {t.level}{" "}
                        <span className="font-medium text-zinc-800">
                          {placementEstimate.level ??
                            `${placementEstimate.levelLow}–${placementEstimate.levelHigh}`}
                        </span>
                      </span>
                    )}
                    {placementEstimate && placementEstimate.answered >= 10 && (
                      <span className="text-zinc-400">{t.placementKeepGoing}</span>
                    )}
                  </div>
                </div>
              </>
            )}

            {placementResult && (
              <div className="flex-1 flex flex-col justify-center">
                <div className="max-w-md">
                  {/* The level is only named when the interval supports it; otherwise the range,
                      which is the same honesty rule the header follows. */}
                  <p className="text-4xl font-medium tracking-tight text-zinc-900">
                    {placementResult.level ?? `${placementResult.levelLow}–${placementResult.levelHigh}`}
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">
                    θ={placementResult.theta.toFixed(2)} ± {placementResult.se.toFixed(2)}
                    {placementResult.level ? "" : ` · ${t.levelRange}`}
                  </p>
                  {placementResult.answered < placementResult.sessionSize && (
                    <p className="text-xs text-zinc-400 mt-1">
                      {placementResult.answered}/{placementResult.sessionSize} {t.placementPartial}
                    </p>
                  )}
                  {/* Label column, content column, flush left — the same shape as the word popover's
                      metadata. Right-aligned values across a wide gap make the eye travel for every
                      line; a column does not. */}
                  <dl className="grid grid-cols-[144px_1fr] gap-x-4 gap-y-2 mt-8 text-sm">
                    <dt className="text-zinc-500">{t.placementHits}</dt>
                    <dd className="text-zinc-800 tabular-nums">
                      {placementResult.hits}/{placementResult.total}
                    </dd>
                    <dt className="text-zinc-500">{t.placementFalseAlarms}</dt>
                    <dd className="text-zinc-800 tabular-nums">
                      {placementResult.falseAlarms} ({(placementResult.falseAlarmRate * 100).toFixed(0)}%)
                    </dd>
                    <dt className="text-zinc-500">{t.placementCorrected}</dt>
                    <dd className="text-zinc-800 tabular-nums">{placementResult.corrected}</dd>
                    <dt className="text-zinc-500">d′</dt>
                    <dd className="text-zinc-800 tabular-nums">{placementResult.dPrime.toFixed(2)}</dd>
                  </dl>
                  <div className="flex items-center gap-2 mt-8">

                    <button
                      onClick={() => setPlacementResult(null)}
                      className="fv-touch h-8 px-4 text-sm font-medium bg-zinc-900 text-white rounded-none hover:bg-zinc-800"
                    >
                      {t.placementClose}
                    </button>
                    {/* Retaking replaces the previous result rather than averaging with it: only the
                        newest completed test is folded into the estimate. */}
                    <button
                      onClick={() => void startPlacement()}
                      className="fv-touch h-8 px-4 text-sm text-zinc-500 hover:text-zinc-700"
                    >
                      {t.placementRetake}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
