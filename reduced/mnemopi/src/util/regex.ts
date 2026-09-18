/** Reduced port of packages/mnemopi/src/util/regex.ts — tokenization, stopwords, synonyms. */
const RECALL_TOKEN_RE = /[a-z0-9][a-z0-9_.:/+-]*/g;
export const FACT_MATCH_STOPWORDS: Record<string, true> = {
	a: true,
	an: true,
	and: true,
	are: true,
	as: true,
	at: true,
	be: true,
	by: true,
	can: true,
	could: true,
	did: true,
	do: true,
	does: true,
	for: true,
	from: true,
	had: true,
	has: true,
	have: true,
	how: true,
	i: true,
	in: true,
	is: true,
	it: true,
	its: true,
	me: true,
	my: true,
	of: true,
	on: true,
	or: true,
	our: true,
	related: true,
	should: true,
	that: true,
	the: true,
	their: true,
	there: true,
	this: true,
	to: true,
	totally: true,
	unrelated: true,
	use: true,
	uses: true,
	was: true,
	we: true,
	what: true,
	when: true,
	where: true,
	which: true,
	who: true,
	why: true,
	with: true,
	you: true,
	your: true,
};

export const RECALL_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
	branding: ["brand", "positioning", "identity", "wording"],
	preference: ["prefer", "prefers", "want", "wants", "reject", "rejects", "avoid", "grounded"],
	professional: ["software", "builder"],
	url: ["link", "profile"],
	current: ["now", "live", "latest"],
	feeling: ["feel", "feels"],
	imposter: ["self-doubt", "doubt", "insecure"],
};

export function recallTokens(text: string): string[] {
	RECALL_TOKEN_RE.lastIndex = 0;
	const tokens: string[] = [];
	const lower = text.toLowerCase();
	let match = RECALL_TOKEN_RE.exec(lower);
	while (match !== null) {
		const token = match[0];
		if (token.length >= 3 && FACT_MATCH_STOPWORDS[token] !== true && !isAsciiDigits(token)) tokens.push(token);
		match = RECALL_TOKEN_RE.exec(lower);
	}
	return tokens;
}

export function factMatchTokens(text: string): Set<string> {
	return new Set(recallTokens(text));
}

export function expandedQueryTokens(tokens: readonly string[]): string[] {
	const expanded: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		if (!seen.has(token)) {
			seen.add(token);
			expanded.push(token);
		}
		const synonyms = RECALL_SYNONYMS[token];
		if (synonyms === undefined) continue;
		for (const synonym of synonyms) {
			if (seen.has(synonym)) continue;
			seen.add(synonym);
			expanded.push(synonym);
		}
	}
	return expanded;
}

export function minimumRecallRelevance(queryTokens: readonly string[]): number {
	if (queryTokens.length >= 4) return 0.3;
	if (queryTokens.length === 3) return 0.5;
	return 0.15;
}

export function ftsQueryTerms(query: string): string[] {
	const terms: string[] = [];
	for (const term of expandedQueryTokens(recallTokens(query))) {
		const escaped = term.replaceAll('"', '""').trim();
		if (escaped) terms.push(`"${escaped}"`);
	}
	return terms;
}

function isAsciiDigits(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return false;
	}
	return value.length > 0;
}
