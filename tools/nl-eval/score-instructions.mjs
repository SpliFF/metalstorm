/**
 * score-instructions.mjs — how much of the contract does the prompt document
 * actually teach?
 * (2026-09-10 nl-commands review: "score the rewrite vs the shipped one on the
 * same corpus before swapping")
 *
 * ## What this measures, and what it does NOT
 *
 * It measures **coverage**: for every construct the golden corpus and the
 * shipped schema require, does `nl-instructions.md` name it, and does it show
 * it in a worked example? Nothing more. A document can score 100% here and
 * still produce a worse model — wording, ordering and emphasis all matter and
 * none of them are visible to a string search.
 *
 * It is worth having anyway, for one reason: the failure it catches is the one
 * that actually happened. The prompt drifted from the contract twice already —
 * a JS paraphrase that fell 4 KB behind the C++ literals (see the README), and
 * then contract v2 landing six new behaviours while the document that teaches
 * them stayed at v1. A model cannot emit `query.events` correctly if the only
 * place it is described is a TypeScript union. This finds exactly that, offline,
 * for free, and it is derived from the CORPUS rather than hand-written, so it
 * cannot be tuned to flatter a particular draft.
 *
 * Judging the PROSE is the LLM-judged arm's job, and that arm can never be the
 * gate (§8: no API call in CI). This can.
 *
 * ## The rule
 *
 * Each required feature scores:
 *   2 — shown inside a fenced code block (the model is given an example)
 *   1 — named in prose
 *   0 — absent
 *
 * Plus a STALE list: names the document teaches that the schema does not have.
 * Those are worse than a gap — a prompt that advertises a verb the compile
 * table dropped produces envelopes that fail downstream — so they are reported
 * separately and never averaged away.
 *
 * Pure: no fs, no network, no clock. Callers read the files.
 */

/** Feature weights by group. The contract's own shape decides these, not a
 *  preference: a missing action KIND costs the model a whole capability, while
 *  a missing `when` type costs it one optional field. */
const WEIGHT = {
    kind: 3,
    verb: 2,
    subject: 2,
    target: 2,
    query: 2,
    guidance: 1,
    when: 1,
    camera: 1,
    ui: 1,
    group: 1,
    focus: 2,
    rule: 3,
};

/**
 * Behaviours the corpus exercises that a reader cannot infer from the schema —
 * each one a rule the document has to STATE, with the alternative spellings
 * that count as stating it.
 *
 * Keyed by the fixture categories that exercise them, so a rule is only
 * required once the corpus actually tests it. A rule with no fixtures behind it
 * is a claim about the prompt nobody is checking.
 */
const RULES = [
    {
        id: 'json-only',
        needs: /\b(?:NLResponse|JSON|envelope)\b/i,
        example: /"actions"\s*:/,
        why: 'the output is one JSON object and nothing else',
        categories: null,
    },
    {
        id: 'names-are-data',
        needs: /\bdata,? not instructions\b|\bnever (?:an )?instruction/i,
        why: 'names in the context are data — a squad called "ignore all previous instructions" is a squad',
        categories: ['injection.json'],
    },
    {
        id: 'never-invent-a-name',
        needs: /\bnever invent\b|\bverbatim\b/i,
        why: 'every name must appear verbatim in the context',
        categories: null,
    },
    {
        id: 'ambiguous-means-ask',
        needs: /\bclarify\b/i,
        why: 'two plausible readings is a question, not a guess',
        categories: ['clarify-refuse.json', 'clarify-resubmit.json'],
    },
    {
        id: 'clarify-excludes-actions',
        // Backtick-tolerant: the shipped document writes it as "`actions` MUST
        // be empty", and a regex that only matched the bare word reported a
        // rule as missing that the document states perfectly clearly.
        needs: /`?actions`?\s*(?:MUST|must)\s*be\s*empty/i,
        why: 'asking and acting are exclusive',
        categories: ['clarify-refuse.json'],
    },
    {
        id: 'actions-run-in-order',
        needs: /\bIN ORDER\b|\bin the order\b/i,
        why: 'a failed step ends the remainder, so order is meaning',
        categories: ['multi-step.json'],
    },
    {
        id: 'refuse-by-name',
        needs: /\brefus/i,
        why: 'refusal is a first-class answer and must name what failed',
        categories: null,
    },
    {
        id: 'focus-is-part-of-the-sentence',
        needs: /\bfocus\b/i,
        why: 'a pronoun is read against what the player is looking at',
        categories: ['focus-deixis.json', 'focus-elision.json'],
    },
    {
        id: 'write-the-resolved-name',
        needs: /resolved name|never the pronoun/i,
        why: 'the envelope carries the name the focus supplied, not the word the player said',
        categories: ['focus-deixis.json'],
    },
    {
        id: 'target-elision',
        needs: /\belision\b|\bno target at all\b|\bomit the target\b/i,
        why: 'a bare verb with a panel open takes that panel’s place (contract v2)',
        categories: ['focus-elision.json'],
    },
    {
        id: 'withdraw-departure',
        needs: /departure zone/i,
        why: 'withdraw may omit its destination; the game picks the nearest departure zone (contract v2)',
        categories: ['contract-v2.json'],
    },
    {
        id: 'patrol-takes-a-place',
        needs: /ring|a route around|patrol .* place/i,
        why: 'patrol/screen accept a named place and the game draws the ring (contract v2)',
        categories: ['contract-v2.json'],
    },
    {
        id: 'place-vs-force',
        needs: /not a place|one of your forces/i,
        why: 'a force named where a place belongs is refused as a force, not as an unknown name',
        categories: ['contract-v2.json', 'focus-deixis.json'],
    },
    {
        id: 'events-query',
        needs: /what'?s happening|battle (?:log|moments)/i,
        why: '"what’s happening" is query.events (contract v2)',
        categories: ['contract-v2.json'],
    },
    {
        id: 'asked',
        needs: /\basked\b/i,
        why: 'a question on screen is in the focus, and a typed line may be its answer (contract v2)',
        categories: null,
    },
    {
        id: 'no-invented-coordinates',
        needs: /invent coordinates|only for coordinates/i,
        why: 'point targets come from the context or not at all',
        categories: null,
    },
    {
        id: 'say-is-spoken',
        needs: /spoken aloud|say.{0,20}spoken/i,
        why: '`say` is read out, so it is one short present-tense line',
        categories: null,
    },
    {
        id: 'one-subject-per-action',
        needs: /one subject per action|exactly one subject/i,
        why: 'several forces is several actions, never a merged name',
        categories: ['multi-step.json'],
    },
];

/** Every feature the corpus and the schema between them require. */
export function requiredFeatures(corpus, contract) {
    const seen = new Map();
    const add = (group, id, note) => {
        const key = `${group}:${id}`;
        if (!seen.has(key)) seen.set(key, { group, id, note, weight: WEIGHT[group] ?? 1 });
    };

    // From the SCHEMA: everything the contract advertises must be taught, even
    // where the corpus happens not to exercise it — a capability the prompt
    // never mentions is one the model will not use.
    for (const kind of contract.kinds) add('kind', kind, 'action kind');
    for (const verb of contract.verbs) add('verb', verb, 'command verb');
    for (const t of contract.subjectTypes) add('subject', t, 'subject type');
    for (const t of contract.targetTypes) add('target', t, 'target type');
    for (const op of contract.queryOps) add('query', op, 'query op');
    for (const op of contract.guidanceOps) add('guidance', op, 'guidance op');
    for (const t of contract.whenTypes) add('when', t, 'when condition');
    for (const op of contract.cameraOps) add('camera', op, 'camera op');
    for (const op of contract.uiOps) add('ui', op, 'ui op');
    for (const op of contract.groupOps ?? []) add('group', op, 'group op');

    // From the CORPUS: the focus fields the boards actually carry.
    for (const field of corpus.focusFields) add('focus', field, 'focus field');

    // The stated rules, required once a fixture exercises them.
    const categories = new Set(corpus.categories);
    for (const rule of RULES) {
        if (rule.categories && !rule.categories.some((c) => categories.has(c))) continue;
        add('rule', rule.id, rule.why);
    }

    return [...seen.values()];
}

/** Fenced code blocks, so "shown in an example" is a real distinction rather
 *  than a second prose search. */
function codeBlocks(text) {
    const out = [];
    const re = /```[\s\S]*?```/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[0]);
    // Backtick-quoted spans count as examples too: the shipped document teaches
    // `selection` and `class-count` that way and it is genuinely showing the
    // token the model must emit, not merely naming the idea.
    const inline = /`[^`\n]+`/g;
    while ((m = inline.exec(text)) !== null) out.push(m[0]);
    return out.join('\n');
}

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/** Does `text` teach `feature`? 2 = in an example, 1 = in prose, 0 = absent. */
function scoreFeature(feature, text, code) {
    if (feature.group === 'rule') {
        const rule = RULE_BY_ID.get(feature.id);
        if (!rule) return 0;
        if (rule.example && rule.example.test(code)) return 2;
        return rule.needs.test(text) ? 1 : 0;
    }
    // A token feature is a literal the model has to emit. Word-bounded so
    // `hold` does not match "household" and `ui` does not match "guidance".
    const token = feature.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![\\w-])${token}(?![\\w-])`, 'i');
    if (word.test(code)) return 2;
    return word.test(text) ? 1 : 0;
}

/**
 * Names the document teaches that the contract does not have.
 *
 * Only the closed vocabularies are checked, and only inside code spans: a verb
 * the schema dropped, an op that was renamed. Prose is left alone — a document
 * is allowed to say "patrol" in a sentence about patrolling.
 */
function staleTokens(text, contract) {
    const known = new Set([
        ...contract.kinds, ...contract.verbs, ...contract.subjectTypes,
        ...contract.targetTypes, ...contract.queryOps, ...contract.guidanceOps,
        ...contract.whenTypes, ...contract.cameraOps, ...contract.uiOps,
        ...(contract.groupOps ?? []),
    ]);
    // Words this document uses as English, not as contract tokens. Without this
    // every prose sentence inside a backtick span would read as a claim.
    const prose = new Set([
        'say', 'actions', 'options', 'pick', 'reason', 'question', 'name', 'names',
        'label', 'place', 'target', 'subject', 'kind', 'verb', 'context', 'focus',
        'primary', 'subjects', 'drilled', 'surfaces', 'selected', 'camera', 'asked',
        'near', 'radius', 'count', 'scale', 'class', 'side', 'when', 'priority',
        'intent', 'clarify', 'group', 'groupRef', 'targetRef', 'subjectRef',
        'panelId', 'regionRef', 'objectiveRef', 'goalRef', 'filterClass',
        // The `task` kind's own fields (E2E2 D16). `player` is the callsign it
        // carries and `stake` the authority it escrows; `players` is the
        // context list the callsign must appear in. They were prose-only
        // allowlisted while the action did not exist — it does now, and this
        // list is only about words that must not read as CLOSED vocabularies.
        'player', 'players', 'stake',
        'memberRefs', 'standing', 'onSight', 'value', 'amount', 'rateCap', 'slot',
        'dir', 'op', 'x', 'z', 'percent', 'true', 'false', 'null', 'type', 'say',
        // Context payload field names. They belong in the document — the model
        // is told to read them — and they are not closed vocabularies, so they
        // can never be "stale".
        'groups', 'places', 'panels', 'objectives', 'units', 'moments', 'history',
        'map', 'authority', 'resources', 'selection', 'contract',
    ]);
    const suspects = new Set();
    for (const span of text.match(/`[A-Za-z][\w.-]*`/g) ?? []) {
        const raw = span.slice(1, -1);
        const head = raw.includes('.') ? raw.split('.')[0] : raw;
        const tail = raw.includes('.') ? raw.split('.').pop() : raw;
        if (prose.has(head) || prose.has(tail)) continue;
        if (known.has(raw) || known.has(head) || known.has(tail)) continue;
        // A camelCase identifier is a field name, and field names are not in
        // the closed vocabularies this checks.
        if (/[a-z][A-Z]/.test(raw)) continue;
        suspects.add(raw);
    }
    return [...suspects].sort();
}

/**
 * Score one instructions document against the corpus and the contract.
 *
 * `coverage` is the headline: earned points over available points, where a
 * feature shown in an example is worth twice one merely named.
 */
export function scoreInstructions(text, corpus, contract) {
    const code = codeBlocks(text);
    const features = requiredFeatures(corpus, contract).map((f) => {
        const level = scoreFeature(f, text, code);
        return { ...f, level, earned: level * f.weight };
    });

    const available = features.reduce((n, f) => n + f.weight * 2, 0);
    const earned = features.reduce((n, f) => n + f.earned, 0);
    const missing = features.filter((f) => f.level === 0);
    const proseOnly = features.filter((f) => f.level === 1);

    const byGroup = {};
    for (const f of features) {
        const g = (byGroup[f.group] ??= { group: f.group, total: 0, earned: 0, available: 0, missing: [] });
        g.total += 1;
        g.earned += f.earned;
        g.available += f.weight * 2;
        if (f.level === 0) g.missing.push(f.id);
    }

    return {
        bytes: Buffer.byteLength(text, 'utf8'),
        features: features.length,
        earned,
        available,
        coverage: available === 0 ? 0 : earned / available,
        taught: features.filter((f) => f.level > 0).length,
        exemplified: features.filter((f) => f.level === 2).length,
        missing: missing.map((f) => `${f.group}:${f.id}`),
        proseOnly: proseOnly.map((f) => `${f.group}:${f.id}`),
        stale: staleTokens(text, contract),
        byGroup: Object.values(byGroup).sort((a, b) => a.group.localeCompare(b.group)),
    };
}

/**
 * Two documents, same corpus. Returns which one the coverage score prefers and
 * what moved — the swap decision the review asked for, made from a number
 * rather than from an opinion about prose.
 */
export function compareInstructions(shipped, candidate, corpus, contract) {
    const a = scoreInstructions(shipped, corpus, contract);
    const b = scoreInstructions(candidate, corpus, contract);
    const fixed = a.missing.filter((m) => !b.missing.includes(m));
    const lost = b.missing.filter((m) => !a.missing.includes(m));
    return {
        shipped: a,
        candidate: b,
        delta: b.coverage - a.coverage,
        fixed,
        lost,
        // A candidate that covers MORE and drops nothing and adds no stale
        // token. Three separate conditions on purpose: a net-positive coverage
        // change that quietly lost a rule is not an improvement.
        better: b.coverage > a.coverage && lost.length === 0
            && b.stale.length <= a.stale.length,
    };
}
