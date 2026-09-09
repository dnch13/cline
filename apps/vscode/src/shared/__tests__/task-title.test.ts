import { describe, expect, test } from "bun:test"
import { deriveAutoTitle } from "../task-title"

describe("deriveAutoTitle", () => {
	test("extracts meaningful words from a simple request", () => {
		expect(deriveAutoTitle("fix the login bug in auth.ts")).toBe("Fix Login Bug")
	})

	test("drops conversational filler words", () => {
		expect(deriveAutoTitle("hey can you help me understand the auth flow?")).toBe("Understand Auth Flow")
	})

	test("preserves internal casing of identifiers", () => {
		expect(deriveAutoTitle("add OAuth2 support for the GitHub API")).toBe("Add OAuth2 Support")
	})

	test("keeps iPhone-style casing intact", () => {
		expect(deriveAutoTitle("fix the iPhone layout")).toBe("Fix iPhone Layout")
	})

	test("strips markdown decorations and inline code", () => {
		expect(deriveAutoTitle("### Fix `crash` on startup\n\nSome extra detail here")).toBe("Fix Crash Startup")
	})

	test("drops fenced code blocks entirely", () => {
		expect(deriveAutoTitle('update config:\n```json\n{"a":1}\n```\nthanks')).toBe("Update Config")
	})

	test("keeps link text but drops the url", () => {
		expect(deriveAutoTitle("check [the docs](https://example.com) for details")).toBe("Check Docs Details")
	})

	test("does not split decimals or versions at sentence boundary", () => {
		expect(deriveAutoTitle("use 3.5 version of node")).toBe("Use 3.5 Version")
	})

	test("splits at the first sentence", () => {
		expect(deriveAutoTitle("fix the crash! it happens on load")).toBe("Fix Crash")
	})

	test("returns empty string for empty input", () => {
		expect(deriveAutoTitle(undefined)).toBe("")
		expect(deriveAutoTitle("")).toBe("")
		expect(deriveAutoTitle("   \n  ")).toBe("")
	})

	test("returns empty string for code-only prompts", () => {
		expect(deriveAutoTitle("```\nconst x = 1\n```")).toBe("")
	})

	test("truncates very long single words", () => {
		const longWord = "a".repeat(60)
		expect(deriveAutoTitle(longWord)).toHaveLength(32)
	})

	test("drops trailing words to stay within one line", () => {
		const long = `fix ${"supercalifragilisticexpialidocious".repeat(1)} authentication breakdown issue now`
		const result = deriveAutoTitle(long)
		expect(result.length).toBeLessThanOrEqual(42)
		expect(result.split(" ").length).toBeLessThanOrEqual(3)
	})

	test("respects the maxWords parameter", () => {
		expect(deriveAutoTitle("fix the login bug in auth module", 2)).toBe("Fix Login")
		expect(deriveAutoTitle("fix the login bug in auth module", 1)).toBe("Fix")
	})

	test("returns fewer words when the request is short", () => {
		expect(deriveAutoTitle("test it")).toBe("Test")
	})

	test("keeps paths and file names as single words", () => {
		expect(deriveAutoTitle("update src/components/Button.tsx props")).toBe("Update src/components/Button.tsx Props")
	})
})
