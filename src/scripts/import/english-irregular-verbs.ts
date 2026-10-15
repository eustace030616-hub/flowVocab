/**
 * Irregular English verb forms → their base.
 *
 * Found by generating real text: a paragraph measured 97.6% coverage and still showed "No
 * translation yet" for `got` and `grew`, while `get` (拿到) and `grow` (发展) were both in the
 * vocabulary. The English lemmatiser works by stripping suffixes, and irregular forms have none to
 * strip — `got` is not `get` plus anything. So the forms a learner is most likely to meet in real
 * prose were the ones the reader could not explain.
 *
 * This reuses the `Inflection` collection already built for German (`liest` → `lesen`): the
 * mechanism was general, only the data was missing.
 *
 * Regular forms are deliberately absent — the suffix rules already handle `walked`, `walking`,
 * `walks`. This is the residue the rules cannot reach.
 *
 * The complete source would be Wiktionary's `form_of` data for English, the same way German is
 * covered; this curated set is what closes the gap that actually appears in reading.
 *
 * Licence: authored for this project.
 */

/** Inflected form → base verb. Keys are lowercased surface forms. */
export const ENGLISH_IRREGULAR_FORMS: Record<string, string> = {
  // be
  am: "be", is: "be", are: "be", was: "be", were: "be", been: "be", being: "be",
  // have / do
  has: "have", had: "have", having: "have",
  does: "do", did: "do", done: "do", doing: "do",
  // say / go / get / make / know / think / take / see / come
  said: "say", says: "say",
  went: "go", gone: "go", goes: "go",
  got: "get", gotten: "get", gets: "get", getting: "get",
  made: "make", makes: "make", making: "make",
  knew: "know", known: "know", knows: "know",
  thought: "think", thinks: "think",
  took: "take", taken: "take", takes: "take", taking: "take",
  saw: "see", seen: "see", sees: "see",
  came: "come", comes: "come", coming: "come",
  // give / find / tell / become / leave / feel / put / bring
  gave: "give", given: "give", gives: "give", giving: "give",
  found: "find", finds: "find",
  told: "tell", tells: "tell",
  became: "become", becomes: "become", becoming: "become",
  left: "leave", leaves: "leave", leaving: "leave",
  felt: "feel", feels: "feel",
  puts: "put", putting: "put",
  brought: "bring", brings: "bring",
  // begin / keep / hold / write / stand / hear / let / mean
  began: "begin", begun: "begin", begins: "begin", beginning: "begin",
  kept: "keep", keeps: "keep",
  held: "hold", holds: "hold",
  wrote: "write", written: "write", writes: "write", writing: "write",
  stood: "stand", stands: "stand",
  heard: "hear", hears: "hear",
  lets: "let", letting: "let",
  meant: "mean", means: "mean",
  // set / meet / run / pay / sit / speak / read / grow / lose / fall
  sets: "set", setting: "set",
  met: "meet", meets: "meet",
  ran: "run", runs: "run", running: "run",
  paid: "pay", pays: "pay",
  sat: "sit", sits: "sit", sitting: "sit",
  spoke: "speak", spoken: "speak", speaks: "speak",
  reads: "read", reading: "read",
  grew: "grow", grown: "grow", grows: "grow",
  lost: "lose", loses: "lose", losing: "lose",
  fell: "fall", fallen: "fall", falls: "fall",
  // send / build / understand / draw / break / spend / cut / rise
  sent: "send", sends: "send",
  built: "build", builds: "build",
  understood: "understand", understands: "understand",
  drew: "draw", drawn: "draw", draws: "draw",
  broke: "break", broken: "break", breaks: "break",
  spent: "spend", spends: "spend",
  cuts: "cut", cutting: "cut",
  rose: "rise", risen: "rise", rises: "rise",
  // drive / buy / wear / choose / eat / drink / sing / swim / fly
  drove: "drive", driven: "drive", drives: "drive", driving: "drive",
  bought: "buy", buys: "buy",
  wore: "wear", worn: "wear", wears: "wear",
  chose: "choose", chosen: "choose", chooses: "choose",
  ate: "eat", eaten: "eat", eats: "eat",
  drank: "drink", drunk: "drink", drinks: "drink",
  sang: "sing", sung: "sing", sings: "sing",
  swam: "swim", swum: "swim", swims: "swim",
  flew: "fly", flown: "fly", flies: "fly",
  // throw / catch / teach / fight / forget / freeze / hide / hit
  threw: "throw", thrown: "throw", throws: "throw",
  caught: "catch", catches: "catch",
  taught: "teach", teaches: "teach",
  fought: "fight", fights: "fight",
  forgot: "forget", forgotten: "forget", forgets: "forget",
  froze: "freeze", frozen: "freeze", freezes: "freeze",
  hid: "hide", hidden: "hide", hides: "hide",
  hits: "hit", hitting: "hit",
  // hurt / quit / ride / ring / shake / shine / shoot / show
  hurts: "hurt", hurting: "hurt",
  quitting: "quit",
  rode: "ride", ridden: "ride", rides: "ride", riding: "ride",
  rang: "ring", rung: "ring", rings: "ring",
  shook: "shake", shaken: "shake", shakes: "shake",
  shone: "shine", shines: "shine",
  shot: "shoot", shoots: "shoot",
  showed: "show", shown: "show", shows: "show",
  // shut / sleep / steal / stick / strike / sweep / swear / wake
  shuts: "shut", shutting: "shut",
  slept: "sleep", sleeps: "sleep",
  stole: "steal", stolen: "steal", steals: "steal",
  stuck: "stick", sticks: "stick",
  struck: "strike", strikes: "strike",
  swept: "sweep", sweeps: "sweep",
  swore: "swear", sworn: "swear", swears: "swear",
  woke: "wake", woken: "wake", wakes: "wake",
  // win / lay / lead / lend / bear / beat / bite / blow
  won: "win", wins: "win", winning: "win",
  laid: "lay", lays: "lay",
  led: "lead", leads: "lead",
  lent: "lend", lends: "lend",
  bore: "bear", borne: "bear", bears: "bear",
  beat: "beat", beaten: "beat", beats: "beat",
  bit: "bite", bitten: "bite", bites: "bite",
  blew: "blow", blown: "blow", blows: "blow",
  // Common irregular nouns as well as verbs, since they fail the same way.
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose", people: "person", lives: "life", knives: "knife",
  wives: "wife", halves: "half", shelves: "shelf", wolves: "wolf",
};
