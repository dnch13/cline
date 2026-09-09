/**
 * Auto-derived short task titles.
 *
 * Builds a 2-3 word title from a task's initial request so history lists are
 * scannable without requiring the user to rename each task manually. This is a
 * deterministic heuristic (no LLM call): strip markdown/code noise, drop
 * conversational filler words, title-case what's left.
 *
 * Shared between the extension host and the webview — must stay free of any
 * Node-only imports.
 */

/** Conversational filler words that carry no meaning in a short title. */
const FILLER_WORDS = new Set([
	// articles / conjunctions
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"if",
	"then",
	"else",
	// prepositions
	"to",
	"of",
	"in",
	"on",
	"at",
	"by",
	"for",
	"with",
	"from",
	"into",
	"onto",
	"about",
	"as",
	// be/have/do
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"am",
	"do",
	"does",
	"did",
	"done",
	"have",
	"has",
	"had",
	// modals
	"will",
	"would",
	"shall",
	"should",
	"can",
	"could",
	"may",
	"might",
	"must",
	// pronouns
	"i",
	"im",
	"i'm",
	"i’m",
	"ive",
	"i've",
	"me",
	"my",
	"mine",
	"myself",
	"we",
	"us",
	"our",
	"ours",
	"you",
	"u",
	"your",
	"yours",
	"he",
	"him",
	"his",
	"she",
	"her",
	"it",
	"its",
	"they",
	"them",
	"their",
	"this",
	"that",
	"these",
	"those",
	"there",
	"here",
	// greetings / politeness
	"please",
	"pls",
	"plz",
	"hey",
	"hi",
	"hello",
	"yo",
	"sup",
	// hedges
	"so",
	"just",
	"now",
	"also",
	"too",
	"very",
	"really",
	"some",
	"any",
	"let",
	"lets",
	"let's",
	"let’s",
	"need",
	"needs",
	"needed",
	"want",
	"wants",
	"wanted",
	"help",
	"make",
	"makes",
	"made",
	// question words
	"what",
	"when",
	"where",
	"why",
	"how",
	"which",
	"who",
	"whom",
	"whose",
	// acknowledgements
	"ok",
	"okay",
])

/** Longest single word kept in a title (long paths/tokens get truncated). */
const MAX_WORD_LENGTH = 32
/** Longest total title before words are dropped from the end. */
const MAX_TITLE_LENGTH = 42

/**
 * Returns the first sentence of a line, cutting at `.`, `!`, `?`, or `;`.
 * A `.` between word characters is part of a token (decimals like `3.5`,
 * versions like `v1.2`, file names like `Button.tsx`), not a sentence end.
 */
function splitFirstSentence(line: string): string {
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		if (ch === "!" || ch === "?" || ch === ";") {
			return line.slice(0, i)
		}
		if (ch === ".") {
			const prev = line[i - 1]
			const next = line[i + 1]
			const insideToken = prev && next && /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next)
			if (!insideToken) {
				return line.slice(0, i)
			}
		}
	}
	return line
}

/**
 * Capitalizes a word only when it is entirely lowercase (and contains no
 * digits), so identifiers like `OAuth2`, `iPhone`, or `3.5` keep their casing
 * while ordinary words like `fix` become `Fix`.
 */
function capitalizeWord(word: string): string {
	return /^[a-z][a-z._/-]*$/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

/**
 * Derives a short title from a task's initial request.
 *
 * @param prompt The raw initial user request text.
 * @param maxWords Maximum number of meaningful words to keep (default 3).
 * @returns The derived title, or "" when nothing meaningful remains.
 */
export function deriveAutoTitle(prompt?: string, maxWords = 3): string {
	if (!prompt || typeof prompt !== "string") {
		return ""
	}

	// Drop fenced/inline code, images, and HTML tags; keep link text.
	let text = prompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<\/?[a-zA-Z][^>]*>/g, " ")

	// Strip markdown decorations (headings, emphasis, blockquotes, list markers).
	text = text.replace(/^[#>\s-]+/gm, " ").replace(/[*_~]{1,3}/g, "")

	const firstLine =
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""

	const words = splitFirstSentence(firstLine)
		.split(/\s+/)
		.map((word) =>
			// Trim leading/trailing punctuation, keeping characters that are
			// meaningful inside identifiers and paths (- _ . # / +).
			word.replace(/^[^\p{L}\p{N}_#./+-]+|[^\p{L}\p{N}_#./+-]+$/gu, ""),
		)
		.filter((word) => word.length > 0 && !FILLER_WORDS.has(word.toLowerCase()))

	const picked: string[] = []
	for (const word of words) {
		picked.push(word.length > MAX_WORD_LENGTH ? word.slice(0, MAX_WORD_LENGTH) : word)
		if (picked.length >= maxWords) {
			break
		}
	}

	// Keep the title within a single line; drop trailing words rather than
	// truncating mid-word.
	while (picked.length > 1 && picked.join(" ").length > MAX_TITLE_LENGTH) {
		picked.pop()
	}
	if (picked.length === 1 && picked[0].length > MAX_TITLE_LENGTH) {
		picked[0] = picked[0].slice(0, MAX_TITLE_LENGTH)
	}

	return picked.map(capitalizeWord).join(" ")
}
