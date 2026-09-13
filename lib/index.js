import { SessionId, deriveEventMessage, isAppendSurfaceEvent } from "@deepseek-ai/dsh-session";
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
//#region src/types.ts
/** Narrow helpers so renderers do not re-derive classifications. */
function asAssistant(message) {
	return message.role === "assistant" && message.source.kind === "model" ? message : void 0;
}
function asToolResult(message) {
	return message.source.kind === "tool" ? message : void 0;
}
//#endregion
//#region src/stats.ts
/** Format a duration in milliseconds as a compact human label. */
function formatDuration(ms) {
	if (ms < 1e3) return `${ms}ms`;
	const s = Math.floor(ms / 1e3);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}
/**
* Compute session-wide statistics from transcript entries.
* @param entries - Transcript entries in log order.
* @param pricing - Optional price table; cost fields appear only when both
*   per-million rates are set.
* @returns Aggregated statistics.
*/
function computeStats(entries, pricing) {
	let turns = 0;
	let toolCalls = 0;
	let failedToolCalls = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	const perTool = /* @__PURE__ */ new Map();
	const perAssistantTokens = [];
	/** callId → tool name, populated from assistant tool-call blocks. */
	const callTool = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		if (entry.message.role === "user" && entry.message.source.kind !== "tool") turns += 1;
		if (entry.message.role === "assistant") {
			for (const block of entry.message.content) if (block.type === "tool-call") {
				toolCalls += 1;
				callTool.set(String(block.id), block.name);
				const previous = perTool.get(block.name);
				perTool.set(block.name, {
					name: block.name,
					calls: (previous?.calls ?? 0) + 1,
					failures: previous?.failures ?? 0
				});
			}
			if (entry.usage !== void 0) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				perAssistantTokens.push(entry.usage.outputTokens);
			} else perAssistantTokens.push(0);
		}
		if (entry.error !== void 0) {
			failedToolCalls += 1;
			const name = callTool.get(String(entry.message.source.kind === "tool" ? entry.message.source.callId : ""));
			if (name !== void 0) {
				const stat = perTool.get(name);
				if (stat !== void 0) perTool.set(name, {
					...stat,
					failures: stat.failures + 1
				});
			}
		}
	}
	const first = entries[0];
	const last = entries[entries.length - 1];
	const startedAt = first?.time ?? null;
	const endedAt = last?.time ?? null;
	const currency = pricing?.currency ?? "$";
	const cost = pricing?.inputPerMillion !== void 0 && pricing?.outputPerMillion !== void 0 ? {
		input: inputTokens / 1e6 * pricing.inputPerMillion,
		output: outputTokens / 1e6 * pricing.outputPerMillion,
		total: 0,
		currency
	} : void 0;
	if (cost !== void 0) cost.total = cost.input + cost.output;
	return {
		messages: entries.length,
		turns,
		toolCalls,
		failedToolCalls,
		inputTokens,
		outputTokens,
		durationMs: startedAt !== null && endedAt !== null && endedAt > startedAt ? endedAt - startedAt : null,
		startedAt,
		endedAt,
		toolBreakdown: [...perTool.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
		perAssistantTokens,
		...cost !== void 0 ? { cost } : {}
	};
}
/** Sparkline glyph ramp (Unicode block elements, low → high). */
const SPARK_RAMP = [
	"▁",
	"▂",
	"▃",
	"▄",
	"▅",
	"▆",
	"▇",
	"█"
];
/**
* Render a numeric series as a compact sparkline string.
* @param series - Numbers (zero-safe; all-zero renders as a flat line).
* @returns One glyph per value.
*/
function sparkline(series) {
	if (series.length === 0) return "";
	const max = Math.max(...series);
	return series.map((value) => SPARK_RAMP[max === 0 ? 0 : Math.min(SPARK_RAMP.length - 1, Math.floor(value / max * SPARK_RAMP.length))]).join("");
}
/** Box-drawing bar ramp for tool rankings. */
const BAR_GLYPH = "█";
/**
* Render a horizontal bar of `filled`/`total` cells.
* @param filled - Filled cell count (clamped to total).
* @param total - Total cell count.
*/
function bar(filled, total) {
	const n = Math.max(0, Math.min(total, filled));
	return BAR_GLYPH.repeat(n) + "·".repeat(Math.max(0, total - n));
}
function bold(text, color) {
	return color ? `\x1b[1m${text}\x1b[22m` : text;
}
function red(text, color) {
	return color ? `\x1b[31m${text}\x1b[39m` : text;
}
function fmtTokens$1(n) {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
function fmtCost(n) {
	if (n >= 1) return n.toFixed(2);
	if (n >= .01) return n.toFixed(3);
	return n.toFixed(4);
}
/**
* Format statistics as a terminal card.
* @param stats - Computed session statistics.
* @param options - Card options.
* @returns Multi-line card text (no trailing newline).
*/
function formatStatsCard(stats, options) {
	const color = options?.color === true;
	const lines = [];
	const W = 52;
	lines.push(`┌${"─".repeat(W)}┐`);
	const row = (label, value) => {
		const text = `│ ${bold(label, color)} ${value}`;
		lines.push(`${text}${" ".repeat(Math.max(0, 53 - visibleWidth(text)))}│`);
	};
	const duration = stats.durationMs !== null ? formatDuration(stats.durationMs) : "—";
	row("Messages", `${stats.messages}`);
	row("Turns", `${stats.turns}`);
	row("Duration", duration);
	const failedNote = stats.failedToolCalls > 0 ? ` (${red(`${stats.failedToolCalls} failed`, color)})` : "";
	row("Tool calls", `${stats.toolCalls}${failedNote}`);
	row("Tokens", `${fmtTokens$1(stats.inputTokens)} in / ${fmtTokens$1(stats.outputTokens)} out`);
	if (stats.cost !== void 0) {
		const c = stats.cost;
		row("Cost ≈", `${c.currency}${fmtCost(c.total)} (in ${c.currency}${fmtCost(c.input)} / out ${c.currency}${fmtCost(c.output)})`);
	}
	if (stats.perAssistantTokens.length > 1) row("Output/turn", sparkline(stats.perAssistantTokens));
	if (stats.toolBreakdown.length > 0) {
		lines.push(`│${"─".repeat(W)}│`);
		const maxCalls = stats.toolBreakdown[0]?.calls ?? 1;
		for (const tool of stats.toolBreakdown.slice(0, 6)) {
			const cells = 18;
			const filled = Math.round(tool.calls / maxCalls * cells);
			const failNote = tool.failures > 0 ? ` ${red(`${tool.failures}✗`, color)}` : "";
			row(tool.name, `${bar(filled, cells)} ${tool.calls}${failNote}`);
		}
	}
	lines.push(`└${"─".repeat(W)}┘`);
	return lines.join("\n");
}
/** Visible width of a string with ANSI escapes and box glyphs stripped. */
function visibleWidth(text) {
	return text.replace(/\x1b\[[0-9;]*m/g, "").split("").reduce((width, char) => width + (char.charCodeAt(0) >= 4352 ? 2 : 1), 0);
}
//#endregion
//#region src/render/mermaid.ts
function id8$3(id) {
	return id.replace(/^session-/, "").slice(0, 8);
}
/** Sanitize a label for Mermaid node text (quotes + brackets break the DSL). */
function mermaidLabel(text) {
	return text.replace(/["\[\]{}()<>]/g, "").trim();
}
/**
* Render the lineage (ancestors + descendants + self) as a `graph TD` block.
* @param lineage - Lineage info from `traceSession`.
* @param selfId - This session's id (rendered as the highlighted root).
* @returns The Mermaid block, or null when the lineage is empty.
*/
function renderLineageMermaid(lineage, selfId) {
	if (lineage.ancestors.length === 0 && lineage.descendants.length === 0) return null;
	const lines = ["graph TD"];
	const node = (id) => `s${id8$3(id).replace(/[^a-zA-Z0-9]/g, "")}`;
	const chain = [...lineage.ancestors.map((a) => a.id)].reverse();
	let previous;
	for (const ancestorId of chain) {
		const current = node(ancestorId);
		lines.push(`  ${current}["${mermaidLabel(id8$3(ancestorId))}"]`);
		if (previous !== void 0) lines.push(`  ${previous} --> ${current}`);
		previous = current;
	}
	const self = node(selfId);
	lines.push(`  ${self}("${mermaidLabel(id8$3(selfId))} ← this session")`);
	if (previous !== void 0) lines.push(`  ${previous} --> ${self}`);
	const walk = (list, parent) => {
		for (const child of list) {
			const current = node(child.id);
			const label = child.origin === "subagent" ? `${id8$3(child.id)} subagent` : id8$3(child.id);
			lines.push(`  ${current}["${mermaidLabel(label)}"]`);
			lines.push(`  ${parent} --> ${current}`);
			walk(child.children, current);
		}
	};
	walk(lineage.descendants, self);
	lines.push("  classDef self fill:#fde68a,stroke:#d97706,stroke-width:2px");
	lines.push(`  class ${self} self`);
	return lines.join("\n");
}
/**
* Render per-turn durations as a `gantt` block. A turn spans from one user
* message to the next (the last turn ends at the final entry).
* @param entries - Transcript entries in log order.
* @returns The Mermaid block, or null with fewer than two turns.
*/
function renderTimelineMermaid(entries) {
	const turnStarts = entries.filter((entry) => entry.message.role === "user" && entry.message.source.kind !== "tool");
	if (turnStarts.length < 2) return null;
	const bounds = turnStarts.map((start, index) => {
		const end = turnStarts[index + 1]?.time ?? entries[entries.length - 1]?.time ?? start.time;
		return {
			index,
			start: start.time,
			end
		};
	});
	const lines = [
		"gantt",
		"  dateFormat X",
		"  axisFormat %H:%M",
		"  title Turn timeline"
	];
	for (const turn of bounds) {
		const durationS = Math.max(0, Math.round((turn.end - turn.start) / 1e3));
		lines.push(`  Turn ${turn.index + 1} :t${turn.index + 1}, ${Math.round(turn.start / 1e3)}, ${durationS}s`);
	}
	return lines.join("\n");
}
//#endregion
//#region src/render/diff.ts
/** Parse the raw JSON arguments string of a tool call; null when not JSON. */
function parseToolArguments(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
function diffLine(prefix, line) {
	return `${prefix}${line}`;
}
/**
* Build a ```diff fenced body for an editor replacement, or null when the
* arguments do not describe one.
*/
function renderEditorDiff(args) {
	if (typeof args !== "object" || args === null) return null;
	const a = args;
	const hasOld = typeof a.old_string === "string";
	const hasNew = typeof a.new_string === "string";
	const hasFileText = typeof a.file_text === "string";
	if (!hasNew && !hasFileText) return null;
	const header = typeof a.file_path === "string" ? a.file_path : "(unknown file)";
	const lines = [
		`--- a${pathPrefix(header)}`,
		`+++ b${pathPrefix(header)}`,
		"@@ str_replace @@"
	];
	if (hasOld && a.old_string !== void 0) for (const line of a.old_string.split("\n")) lines.push(diffLine("-", line));
	const added = hasFileText ? a.file_text : a.new_string;
	if (added !== void 0) for (const line of added.split("\n")) lines.push(diffLine("+", line));
	return lines.join("\n");
}
/** Diff header prefix: 'a/' for relative paths, 'a' + path for absolute ones. */
function pathPrefix(path) {
	return path.startsWith("/") ? path : `/${path}`;
}
/** Tool names whose arguments describe file mutations worth a diff view. */
const DIFF_TOOL_NAMES = /* @__PURE__ */ new Set([
	"str_replace_editor",
	"edit",
	"write"
]);
/**
* Render a tool call's arguments as a diff body when the tool is a known
* file-mutating editor (`str_replace_editor`, `edit`, or `write`); null for
* anything else or for arguments that describe no mutation. Deployment tool
* names differ (package names vs registered names), so all three are covered.
*/
function renderToolDiff(toolName, args) {
	if (!DIFF_TOOL_NAMES.has(toolName)) return null;
	if (typeof args !== "object" || args === null) return null;
	const a = args;
	const header = typeof a.file_path === "string" ? a.file_path : "(unknown file)";
	const lines = [
		`--- a${pathPrefix(header)}`,
		`+++ b${pathPrefix(header)}`,
		"@@ edit @@"
	];
	if (typeof a.old_string === "string") for (const line of a.old_string.split("\n")) lines.push(diffLine("-", line));
	const added = typeof a.new_string === "string" ? a.new_string : typeof a.file_text === "string" ? a.file_text : typeof a.content === "string" ? a.content : void 0;
	if (added === void 0) return null;
	for (const line of added.split("\n")) lines.push(diffLine("+", line));
	return lines.join("\n");
}
//#endregion
//#region src/util/truncate.ts
/** Truncate long text with an explicit marker of how much was cut. */
function truncate(text, limit) {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} more chars]`;
}
//#endregion
//#region src/render/markdown.ts
const defaultMarkdownOptions = {
	argCharLimit: 512,
	resultCharLimit: 2048
};
function fmtTime$1(epochMs) {
	return new Date(epochMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
function id8$2(id) {
	return id.slice(0, 8);
}
function renderHeaderBlock(input) {
	const h = input.header;
	const rows = [
		["Session", `\`${h.id}\``],
		["Project", h.cwd ?? "(no cwd)"],
		["Created", h.createdAt ? fmtTime$1(h.createdAt) : "(unknown)"]
	];
	if (h.agentPreset) rows.push(["Agent preset", h.agentPreset]);
	rows.push(["Messages", String(input.totals.messages)]);
	const failed = input.stats?.failedToolCalls;
	rows.push(["Tool calls", failed !== void 0 && failed > 0 ? `${input.totals.toolCalls} (${failed} failed)` : String(input.totals.toolCalls)]);
	rows.push(["Tokens (in/out)", `${input.totals.inputTokens.toLocaleString("en-US")} / ${input.totals.outputTokens.toLocaleString("en-US")}`]);
	if (input.stats?.durationMs !== void 0 && input.stats.durationMs !== null) rows.push(["Duration", formatDuration(input.stats.durationMs)]);
	if (input.stats?.cost !== void 0) {
		const c = input.stats.cost;
		rows.push(["Cost ≈", `${c.currency}${c.total.toFixed(4)} (in ${c.currency}${c.input.toFixed(4)} / out ${c.currency}${c.output.toFixed(4)})`]);
	}
	rows.push(["Exported", fmtTime$1(input.generatedAt)]);
	rows.push(["Generator", input.generator]);
	return [
		"# DSH Session Transcript",
		"",
		"| Key | Value |",
		"|---|---|",
		rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n"),
		""
	].join("\n");
}
function renderLineageNode(node, depth) {
	const origin = node.origin ? ` (${node.origin})` : "";
	return [`${"  ".repeat(depth)}- \`${id8$2(node.id)}\`${origin} — created ${fmtTime$1(node.createdAt)}`, ...node.children.flatMap((child) => renderLineageNode(child, depth + 1))];
}
function renderLineage(input) {
	const lineage = input.lineage;
	if (!lineage) return null;
	if (lineage.ancestors.length === 0 && lineage.descendants.length === 0) return null;
	const parts = ["## Lineage", ""];
	const graph = renderLineageMermaid(lineage, input.header.id);
	if (graph !== null) parts.push("```mermaid", graph, "```", "");
	if (lineage.ancestors.length > 0) {
		parts.push("Ancestors (root → this session):");
		parts.push("");
		const chain = lineage.ancestors.map((a) => `\`${id8$2(a.id)}\``).concat("**this session**").join(" → ");
		parts.push(chain, "");
	}
	if (lineage.descendants.length > 0) {
		parts.push("Subagent descendants:");
		parts.push("");
		for (const node of lineage.descendants) parts.push(...renderLineageNode(node, 0));
		parts.push("");
	}
	return parts.join("\n");
}
function fence(lang, body) {
	return `\`\`\`${lang}\n${body}\n\`\`\``;
}
function renderAssistantMessage(message, options, usageNote) {
	const parts = ["### 🤖 Assistant", ""];
	const provenance = `*${message.source.provider} / ${message.source.model}*`;
	parts.push(usageNote ? `${provenance} — ${usageNote}` : provenance, "");
	for (const block of message.content) if (block.type === "reasoning") parts.push("<details>", "<summary>Reasoning</summary>", "", block.text.trim(), "", "</details>", "");
	else if (block.type === "text") parts.push(block.text.trim(), "");
	else if (block.type === "tool-call") {
		parts.push(`#### 🔧 Tool Call — \`${block.name}\``, "");
		const parsed = parseToolArguments(block.arguments);
		const diff = renderToolDiff(block.name, parsed);
		if (diff) parts.push(fence("diff", truncate(diff, options.resultCharLimit)), "");
		else parts.push("**arguments**:", "", fence("json", truncate(block.arguments, options.argCharLimit)), "");
	} else parts.push(`> *(unsupported content block: ${JSON.stringify(block.type)})*`, "");
	return parts;
}
function renderToolResult(message, options, error) {
	const parts = [`### 🧾 Tool Result — call \`${id8$2(String(message.source.callId))}\`${error ? " ⚠️ ERROR" : ""}`, ""];
	if (error) parts.push(`> Tool failed: \`${error.name}\` (\`${error.code}\`)`, "");
	for (const block of message.content) {
		const inner = block.content.map((b) => b.type === "text" ? b.text : `*(block: ${JSON.stringify(b.type)})*`).join("\n");
		parts.push(fence("text", truncate(inner, options.resultCharLimit)), "");
		if (block.isError) parts.push("> ⚠️ result flagged as error", "");
	}
	return parts;
}
function renderEntry$1(entry, options) {
	const assistant = asAssistant(entry.message);
	if (assistant) return renderAssistantMessage(assistant, options, entry.usage ? `tokens: ${entry.usage.inputTokens.toLocaleString("en-US")} in / ${entry.usage.outputTokens.toLocaleString("en-US")} out` : void 0);
	const toolResult = asToolResult(entry.message);
	if (toolResult) return renderToolResult(toolResult, options, entry.error);
	if (entry.message.role === "user") {
		const parts = ["### 👤 User", ""];
		for (const block of entry.message.content) if (block.type === "text") parts.push(block.text.trim(), "");
		else parts.push(`> *(block: ${JSON.stringify(block.type)})*`, "");
		return parts;
	}
	return [`> *(unsupported message role: ${JSON.stringify(entry.message.role)})*`, ""];
}
function renderTimelineSection(input) {
	const gantt = renderTimelineMermaid(input.entries);
	if (gantt === null) return null;
	return [
		"## Timeline",
		"",
		"```mermaid",
		gantt,
		"```",
		""
	].join("\n");
}
function renderFilterNote$1(input) {
	if (input.filterNote === void 0) return null;
	return ["> ⚠ " + input.filterNote, ""].join("\n");
}
function renderLogOnly(input) {
	if (!input.logOnly || input.logOnly.length === 0) return null;
	const parts = [
		"## Log-only Events",
		"",
		"Events that never joined the model surface (command lifecycles, compaction markers, …).",
		""
	];
	for (const line of input.logOnly) {
		const summary = line.summary ? ` — ${line.summary}` : "";
		parts.push(`- \`${line.seq}\` · ${fmtTime$1(line.time)} · \`${line.type}\`${summary}`);
	}
	parts.push("");
	return parts.join("\n");
}
/** Render the complete Markdown transcript. */
function renderMarkdown(input, options) {
	const opts = {
		...defaultMarkdownOptions,
		...options
	};
	return `${[
		renderHeaderBlock(input),
		renderFilterNote$1(input),
		renderLineage(input),
		renderTimelineSection(input),
		["## Transcript", ""].join("\n"),
		input.entries.map((entry) => renderEntry$1(entry, opts).join("\n")).join("\n"),
		renderLogOnly(input)
	].filter((section) => section !== null).join("\n").trimEnd()}\n`;
}
//#endregion
//#region src/render/json.ts
function serializeEntry(entry) {
	return {
		seq: entry.seq,
		time: entry.time,
		kind: entry.kind,
		role: entry.message.role,
		source: entry.message.source,
		content: entry.message.content,
		...entry.usage !== void 0 ? { usage: entry.usage } : {},
		...entry.error !== void 0 ? { error: entry.error } : {}
	};
}
/** Render the complete JSON transcript document. */
function renderJson(input) {
	const doc = {
		format: "dsh-session-transcript",
		formatVersion: 1,
		generator: input.generator,
		generatedAt: input.generatedAt,
		session: input.header,
		totals: input.totals,
		...input.stats !== void 0 ? { stats: input.stats } : {},
		...input.filterNote !== void 0 ? { filterNote: input.filterNote } : {},
		...input.lineage !== void 0 ? { lineage: input.lineage } : {},
		transcript: input.entries.map(serializeEntry),
		...input.logOnly !== void 0 ? { logOnly: input.logOnly } : {}
	};
	return `${JSON.stringify(doc, null, 2)}\n`;
}
//#endregion
//#region src/render/html.ts
const defaultHtmlOptions = {
	argCharLimit: 512,
	resultCharLimit: 2048
};
function escapeHtml(text) {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}
function fmtTime(epochMs) {
	return new Date(epochMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
function fmtTokens(n) {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
function id8$1(id) {
	return id.replace(/^session-/, "").slice(0, 8);
}
const LABELS = {
	title: {
		en: "DSH session {id} — transcript",
		zh: "DSH 会话 {id} — 转录报告"
	},
	messages: {
		en: "Messages",
		zh: "消息"
	},
	toolCalls: {
		en: "Tool calls",
		zh: "工具调用"
	},
	tokensIn: {
		en: "Tokens in",
		zh: "输入 token"
	},
	tokensOut: {
		en: "Tokens out",
		zh: "输出 token"
	},
	duration: {
		en: "Duration",
		zh: "时长"
	},
	turns: {
		en: "Turns",
		zh: "轮次"
	},
	cost: {
		en: "Cost ≈",
		zh: "成本 ≈"
	},
	failedNote: {
		en: "{n} failed",
		zh: "{n} 次失败"
	},
	sparkline: {
		en: "Output tokens per assistant message",
		zh: "每条助手消息的输出 token"
	},
	turnTimeline: {
		en: "Turn timeline",
		zh: "轮次时间轴"
	},
	turn: {
		en: "Turn {n}",
		zh: "第 {n} 轮"
	},
	toolCallsSection: {
		en: "Tool calls",
		zh: "工具调用"
	},
	transcript: {
		en: "Transcript",
		zh: "转录"
	},
	user: {
		en: "User",
		zh: "用户"
	},
	assistant: {
		en: "Assistant",
		zh: "助手"
	},
	toolResult: {
		en: "Tool result",
		zh: "工具结果"
	},
	result: {
		en: "result",
		zh: "结果"
	},
	reasoning: {
		en: "Reasoning",
		zh: "推理"
	},
	toolFailed: {
		en: "Tool failed:",
		zh: "工具失败："
	},
	jumpError: {
		en: "⚠ {n} failed · jump to first",
		zh: "⚠ {n} 次失败 · 跳到第一个"
	},
	footer: {
		en: "Generated by {g} at {t} — print to PDF for archival copies.",
		zh: "由 {g} 于 {t} 生成 — 打印为 PDF 可存档。"
	},
	theme: {
		en: "◐ theme",
		zh: "◐ 主题"
	},
	tipMessages: {
		en: "Surface entries in log order",
		zh: "按日志顺序的表面条目数"
	},
	tipToolCalls: {
		en: "Tool calls issued by the assistant",
		zh: "助手发出的工具调用"
	},
	tipTokens: {
		en: "Sum of per-message usage records",
		zh: "按消息 usage 记录累加"
	},
	tipDuration: {
		en: "First entry → last entry, wall clock",
		zh: "首条 → 末条的墙钟时长"
	},
	tipTurns: {
		en: "User messages that started a turn",
		zh: "开启新一轮的用户消息数"
	},
	tipCost: {
		en: "Estimate from the configured price table",
		zh: "按配置价格表估算"
	},
	tipTurn: {
		en: "Turn {n} · {d}",
		zh: "第 {n} 轮 · {d}"
	},
	tipSpark: {
		en: "#{n} · {v} tokens",
		zh: "第 {n} 条 · {v} token"
	},
	tipTool: {
		en: "{n} calls",
		zh: "{n} 次调用"
	},
	entriesCount: {
		en: "{n} entries",
		zh: "{n} 条"
	},
	matches: {
		en: "{n} matches",
		zh: "{n} 条命中"
	},
	copyLabel: {
		en: "copy",
		zh: "复制"
	},
	copiedLabel: {
		en: "✓ copied",
		zh: "✓ 已复制"
	},
	searchPlaceholder: {
		en: "Search transcript…  (press /)",
		zh: "搜索转录…（按 / 聚焦）"
	},
	tocTop: {
		en: "Top",
		zh: "顶部"
	},
	tocTimeline: {
		en: "Timeline",
		zh: "时间轴"
	},
	tocTools: {
		en: "Tools",
		zh: "工具"
	},
	tocErrors: {
		en: "{n} failed",
		zh: "{n} 次失败"
	}
};
function t(key, lang) {
	return LABELS[key][lang];
}
function tf(key, lang, vars) {
	let out = LABELS[key][lang];
	for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
	return out;
}
const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false)\b|\bnull\b/g;
/** True when the full text parses as JSON (highlight gate; truncated views still render). */
function looksLikeJson(text) {
	if (text.length === 0) return false;
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}
/** Wrap JSON tokens in colored spans; every segment is HTML-escaped. */
function highlightJson(text) {
	let out = "";
	let last = 0;
	for (const match of text.matchAll(JSON_TOKEN)) {
		const index = match.index ?? 0;
		const token = match[0] ?? "";
		out += escapeHtml(text.slice(last, index));
		if (match[2] !== void 0) out += `<span class="hl-key">${escapeHtml(match[1] ?? "")}</span><span class="hl-punc">${escapeHtml(match[2])}</span>`;
		else if (token.startsWith("\"")) out += `<span class="hl-str">${escapeHtml(token)}</span>`;
		else if (token === "true" || token === "false") out += `<span class="hl-bool">${token}</span>`;
		else if (token === "null") out += "<span class=\"hl-null\">null</span>";
		else out += `<span class="hl-num">${escapeHtml(token)}</span>`;
		last = index + token.length;
	}
	out += escapeHtml(text.slice(last));
	return out;
}
/** Truncated, escaped code block — JSON gets token colors, everything else stays plain. */
function renderCode(raw, limit) {
	const shown = truncate(raw, limit);
	return looksLikeJson(raw) ? `<code class="json">${highlightJson(shown)}</code>` : `<code>${escapeHtml(shown)}</code>`;
}
/** KPI card row: the numbers that describe the session. */
function renderKpiGrid(input, lang) {
	const stats = input.stats;
	const cards = [
		{
			label: "messages",
			value: String(input.totals.messages),
			tip: "tipMessages"
		},
		{
			label: "toolCalls",
			value: String(input.totals.toolCalls),
			note: stats !== void 0 && stats.failedToolCalls > 0 ? tf("failedNote", lang, { n: stats.failedToolCalls }) : void 0,
			tip: "tipToolCalls"
		},
		{
			label: "tokensIn",
			value: fmtTokens(input.totals.inputTokens),
			tip: "tipTokens"
		},
		{
			label: "tokensOut",
			value: fmtTokens(input.totals.outputTokens),
			tip: "tipTokens"
		},
		{
			label: "duration",
			value: stats?.durationMs !== void 0 && stats.durationMs !== null ? formatDuration(stats.durationMs) : "—",
			tip: "tipDuration"
		},
		{
			label: "turns",
			value: stats !== void 0 ? String(stats.turns) : "—",
			tip: "tipTurns"
		}
	];
	const cost = stats?.cost;
	if (cost !== void 0) cards.push({
		label: "cost",
		value: `${cost.currency}${cost.total >= .01 ? cost.total.toFixed(2) : cost.total.toFixed(4)}`,
		tip: "tipCost"
	});
	const spark = stats !== void 0 ? renderSparklineSvg(stats.perAssistantTokens, lang) : "";
	return [
		"<section class=\"kpi-grid\">",
		...cards.map(({ label, value, note, tip }) => `<div class="kpi" title="${escapeHtml(t(tip, lang))}"><div class="kpi-label">${escapeHtml(t(label, lang))}</div><div class="kpi-value">${escapeHtml(value)}${note !== void 0 ? ` <span class="kpi-note">${escapeHtml(note)}</span>` : ""}</div></div>`),
		spark !== "" ? `<div class="kpi kpi-wide" title="${escapeHtml(t("tipTokens", lang))}"><div class="kpi-label">${escapeHtml(t("sparkline", lang))}</div>${spark}</div>` : "",
		"</section>"
	].join("\n");
}
/** Inline SVG bar sparkline: no JS, scales to card width, one tooltip per bar. */
function renderSparklineSvg(series, lang) {
	if (series.length < 2) return "";
	const max = Math.max(...series);
	const W = 320;
	const H = 40;
	const gap = 2;
	const barWidth = Math.max(1, (W - gap * (series.length - 1)) / series.length);
	const bars = series.map((value, index) => {
		const h = max === 0 ? 1 : Math.max(1, value / max * 38);
		const x = index * (barWidth + gap);
		const y = H - h;
		const tip = escapeHtml(tf("tipSpark", lang, {
			n: index + 1,
			v: value
		}));
		return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="1" title="${tip}"/>`;
	}).join("");
	return `<svg class="sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t("sparkline", lang))}">${bars}</svg>`;
}
/** Shared turn boundaries for the timeline, the TOC, and the folded transcript. */
function computeTurnSpans(entries) {
	const spans = [];
	let start = 0;
	for (let i = 1; i < entries.length; i += 1) {
		const message = entries[i]?.message;
		if (message !== void 0 && message.role === "user" && message.source.kind !== "tool") {
			spans.push({
				from: start,
				to: i - 1,
				startTime: entries[start]?.time ?? 0,
				endTime: entries[i - 1]?.time ?? 0
			});
			start = i;
		}
	}
	if (start < entries.length) spans.push({
		from: start,
		to: entries.length - 1,
		startTime: entries[start]?.time ?? 0,
		endTime: entries[entries.length - 1]?.time ?? 0
	});
	return spans;
}
function isEntryError(entry) {
	return entry.error !== void 0 || (asToolResult(entry.message)?.content.some((block) => block.isError === true) ?? false);
}
/** Turn timeline: one horizontal bar per user→next-user span, colored by duration share. */
function renderTimeline(input, lang) {
	const durationMs = input.stats?.durationMs;
	const spans = computeTurnSpans(input.entries);
	if (spans.length < 2 || durationMs === void 0 || durationMs === null) return "";
	const totalMs = durationMs;
	const rows = spans.map((span, index) => {
		const ms = Math.max(0, span.endTime - span.startTime);
		const pct = totalMs === 0 ? 0 : ms / totalMs * 100;
		const hue = 200 - Math.min(160, pct / 100 * 160);
		const tip = escapeHtml(tf("tipTurn", lang, {
			n: index + 1,
			d: formatDuration(ms)
		}));
		return `<div class="tl-row"><span class="tl-label">${escapeHtml(tf("turn", lang, { n: index + 1 }))}</span><div class="tl-track"><div class="tl-bar" style="width:${pct.toFixed(1)}%;background:hsl(${hue.toFixed(0)},65%,50%)" title="${tip}"></div></div><span class="tl-dur">${escapeHtml(formatDuration(ms))}</span></div>`;
	});
	return `<section class="card" id="timeline"><h2>${escapeHtml(t("turnTimeline", lang))}</h2>${rows.join("")}</section>`;
}
/** Tool ranking bars. */
function renderToolRanking(input, lang) {
	const breakdown = input.stats?.toolBreakdown ?? [];
	if (breakdown.length === 0) return "";
	const max = breakdown[0]?.calls ?? 1;
	const rows = breakdown.slice(0, 8).map((tool) => {
		const pct = tool.calls / max * 100;
		const fail = tool.failures > 0 ? ` <span class="fail">${tool.failures}✗</span>` : "";
		const tip = escapeHtml(`${tool.name} · ${tf("tipTool", lang, { n: tool.calls })}`);
		return `<div class="tool-row"><span class="tool-name" title="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}</span><div class="tool-track"><div class="tool-bar" style="width:${pct.toFixed(1)}%" title="${tip}"></div></div><span class="tool-count">${tool.calls}${fail}</span></div>`;
	});
	return `<section class="card" id="tools"><h2>${escapeHtml(t("toolCallsSection", lang))}</h2>${rows.join("")}</section>`;
}
function renderBlocks(blocks, options) {
	const lang = options.lang ?? "en";
	const parts = [];
	for (const block of blocks) if (block.type === "reasoning") parts.push(`<details class="reasoning"><summary>${escapeHtml(t("reasoning", lang))}</summary><div class="code-wrap"><pre>${escapeHtml(block.text.trim())}</pre><button class="copy" type="button">${escapeHtml(t("copyLabel", lang))}</button></div></details>`);
	else if (block.type === "text") parts.push(`<div class="msg-text">${escapeHtml(block.text.trim())}</div>`);
	else if (block.type === "tool-call") {
		const parsed = parseToolArguments(block.arguments);
		const diff = renderToolDiff(block.name, parsed);
		if (diff) parts.push(`<details class="tool"><summary>🔧 ${escapeHtml(block.name)}</summary><div class="code-wrap"><pre class="diff">${escapeHtml(truncate(diff, options.resultCharLimit))}</pre><button class="copy" type="button">${escapeHtml(t("copyLabel", lang))}</button></div></details>`);
		else parts.push(`<details class="tool"><summary>🔧 ${escapeHtml(block.name)}</summary><div class="code-wrap"><pre>${renderCode(block.arguments, options.argCharLimit)}</pre><button class="copy" type="button">${escapeHtml(t("copyLabel", lang))}</button></div></details>`);
	} else if ("content" in block) {
		const inner = block.content.map((inner2) => inner2.type === "text" ? inner2.text : `(${JSON.stringify(inner2.type)})`).join("\n");
		parts.push(`<details class="tool-result"${block.isError === true ? " open" : ""}><summary>🧾 ${escapeHtml(t("result", lang))}</summary><div class="code-wrap"><pre>${renderCode(inner, options.resultCharLimit)}</pre><button class="copy" type="button">${escapeHtml(t("copyLabel", lang))}</button></div></details>`);
	} else parts.push(`<div class="unsupported">(${escapeHtml(JSON.stringify(block.type))})</div>`);
	return parts;
}
function renderEntry(entry, options, errorNo) {
	const lang = options.lang ?? "en";
	const time = escapeHtml(fmtTime(entry.time));
	const message = entry.message;
	const anchor = errorNo !== void 0 ? ` id="error-${errorNo}"` : "";
	if (message.role === "assistant") {
		const assistant = asAssistant(message);
		const provenance = assistant !== void 0 ? `${assistant.source.provider} / ${assistant.source.model}` : "";
		const usage = entry.usage !== void 0 ? ` · ${fmtTokens(entry.usage.inputTokens)} in / ${fmtTokens(entry.usage.outputTokens)} out` : "";
		const body = renderBlocks(message.content, options).join("\n");
		return `<article class="entry assistant"><header>🤖 ${escapeHtml(t("assistant", lang))} <span class="prov">${escapeHtml(provenance)}${escapeHtml(usage)}</span> <time>${time}</time></header>${body}</article>`;
	}
	const toolResult = asToolResult(message);
	if (toolResult !== void 0) {
		const isError = entry.error !== void 0 || toolResult.content.some((block) => block.isError === true);
		const errorLine = entry.error !== void 0 ? `<div class="error-banner">${escapeHtml(t("toolFailed", lang))} <code>${escapeHtml(entry.error.name)}</code> (<code>${escapeHtml(entry.error.code)}</code>)</div>` : "";
		const body = renderBlocks(toolResult.content, options).join("\n");
		return `<article class="entry tool-result${isError ? " error" : ""}"${anchor}><header>🧾 ${escapeHtml(t("toolResult", lang))} <code>${escapeHtml(id8$1(String(toolResult.source.callId)))}</code>${isError ? " <span class=\"fail\">⚠ ERROR</span>" : ""} <time>${time}</time></header>${errorLine}${body}</article>`;
	}
	const body = renderBlocks(message.content, options).join("\n");
	return `<article class="entry user"><header>👤 ${escapeHtml(t("user", lang))} <time>${time}</time></header>${body}</article>`;
}
function renderFilterNote(input) {
	if (input.filterNote === void 0) return "";
	return `<div class="filter-note">⚠ ${escapeHtml(input.filterNote)}</div>`;
}
/** Fold the transcript into per-turn <details> sections (default open). */
function renderTurns(input, options) {
	const lang = options.lang ?? "en";
	return computeTurnSpans(input.entries).map((span, index) => {
		const slice = input.entries.slice(span.from, span.to + 1);
		const hasError = slice.some(isEntryError);
		const ms = Math.max(0, span.endTime - span.startTime);
		const body = slice.map((entry, offset) => renderEntry(entry, options, isEntryError(entry) ? errorNo(input, span.from + offset) : void 0)).join("\n");
		const flag = hasError ? " <span class=\"fail\">⚠</span>" : "";
		return `<details class="turn" id="turn-${index + 1}" open><summary>${escapeHtml(tf("turn", lang, { n: index + 1 }))} <span class="turn-meta">${escapeHtml(formatDuration(ms))} · ${escapeHtml(tf("entriesCount", lang, { n: slice.length }))}</span>${flag}</summary>${body}</details>`;
	}).join("\n");
}
/** Stable error ordinal for an entry: 1-based position among error entries. */
function errorNo(input, entryIndex) {
	let n = 0;
	for (let i = 0; i <= entryIndex; i += 1) if (isEntryError(input.entries[i])) n += 1;
	return n === 0 || !isEntryError(input.entries[entryIndex]) ? void 0 : n;
}
/** Sticky toolbar: TOC chips (top/timeline/tools/turns/errors) + live search box. */
function renderToolbar(input, options, errorCount) {
	const lang = options.lang ?? "en";
	const spans = computeTurnSpans(input.entries);
	if (!(input.entries.length >= 12 || spans.length >= 4)) return "";
	const chips = [
		`<a href="#top" title="${escapeHtml(t("tocTop", lang))}">◉</a>`,
		`<a href="#timeline" title="${escapeHtml(t("tocTimeline", lang))}">⏱</a>`,
		`<a href="#tools" title="${escapeHtml(t("tocTools", lang))}">🔧</a>`,
		...spans.map((_, index) => `<a href="#turn-${index + 1}">T${index + 1}</a>`)
	];
	if (errorCount > 0) chips.push(`<a class="err" href="#error-1" title="${escapeHtml(tf("tocErrors", lang, { n: errorCount }))}">⚠</a>`);
	return `<nav class="toc" id="toc">${chips.join("")}<span class="toc-search"><input class="search-box" type="search" placeholder="${escapeHtml(t("searchPlaceholder", lang))}" aria-label="${escapeHtml(t("searchPlaceholder", lang))}"><span class="search-count"></span></span></nav>`;
}
const CSS = `
:root{color-scheme:light;--bg:#f6f7f9;--card:#fff;--ink:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--fail:#dc2626;--bar:#93c5fd;--ok:#16a34a;--num:#b45309;--lit:#7c3aed}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#111317;--card:#1a1d23;--ink:#e5e7eb;--muted:#9ca3af;--line:#2a2e35;--accent:#60a5fa;--fail:#f87171;--bar:#3b82f6;--ok:#4ade80;--num:#fbbf24;--lit:#a78bfa}}
[data-theme=dark]{color-scheme:dark;--bg:#111317;--card:#1a1d23;--ink:#e5e7eb;--muted:#9ca3af;--line:#2a2e35;--accent:#60a5fa;--fail:#f87171;--bar:#3b82f6;--ok:#4ade80;--num:#fbbf24;--lit:#a78bfa}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0 auto;max-width:960px;padding:24px 20px 64px;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
h1{font-size:22px;margin:0 0 2px}
h2{font-size:15px;margin:0 0 12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.meta{color:var(--muted);font-size:13px;margin-bottom:18px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.kpi-value{font-size:22px;font-weight:700;margin-top:2px}
.kpi-note{font-size:12px;color:var(--fail);font-weight:400}
.kpi-wide{grid-column:1/-1}
.sparkline{width:100%;height:40px;margin-top:8px;fill:var(--accent);opacity:.75}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
.tl-row,.tool-row{display:flex;align-items:center;gap:10px;margin:6px 0}
.tl-label,.tool-name{width:110px;flex:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-track,.tool-track{flex:1;height:12px;background:var(--line);border-radius:6px;overflow:hidden}
.tl-bar,.tool-bar{height:100%;border-radius:6px}
.tool-bar{background:var(--accent);opacity:.8}
.tl-dur,.tool-count{width:86px;flex:none;text-align:right;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.fail{color:var(--fail);font-weight:700}
.jump-error{display:inline-block;margin:0 0 14px;color:var(--fail);text-decoration:none;border:1px solid var(--fail);border-radius:8px;padding:4px 10px;font-size:12px}
.jump-error:hover{background:rgba(220,38,38,.1)}
.entry{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
.entry.user{border-left-color:#10b981}
.entry.assistant{border-left-color:var(--accent)}
.entry.tool-result{border-left-color:var(--bar)}
.entry.error{border-left-color:var(--fail);border-color:var(--fail)}
.entry.error:target{box-shadow:0 0 0 3px rgba(220,38,38,.3)}
.entry header{font-size:12px;color:var(--muted);margin-bottom:6px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.entry time{margin-left:auto;font-variant-numeric:tabular-nums}
.prov{font-style:italic}
.msg-text{white-space:pre-wrap}
pre{background:rgba(127,127,127,.08);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:12.5px;line-height:1.5}
pre.diff{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hl-key{color:var(--accent);font-weight:600}
.hl-str{color:var(--ok)}
.hl-num{color:var(--num)}
.hl-bool,.hl-null{color:var(--lit)}
.hl-punc{color:var(--muted)}
details{margin:6px 0}
summary{cursor:pointer;font-size:13px;color:var(--muted)}
details[open] summary{color:var(--ink)}
.error-banner{background:rgba(220,38,38,.1);border:1px solid var(--fail);color:var(--fail);border-radius:8px;padding:8px 12px;margin:6px 0;font-size:13px}
.filter-note{background:rgba(217,119,6,.12);border:1px solid #d97706;color:#b45309;border-radius:8px;padding:8px 12px;margin:12px 0;font-size:13px}
.turn{border:1px solid var(--line);border-radius:10px;background:var(--card);margin:12px 0;padding:0 12px}
.turn>summary{cursor:pointer;padding:10px 2px;font-size:13px;font-weight:600;color:var(--ink);user-select:none;list-style:none;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.turn>summary::-webkit-details-marker{display:none}
.turn>summary::before{content:'▸';color:var(--muted);transition:transform .12s}
.turn[open]>summary::before{transform:rotate(90deg)}
.turn-meta{font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums}
.toc{position:sticky;top:0;z-index:8;display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow-x:auto;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 2px;margin:0 0 14px;scrollbar-width:thin}
.toc a{flex:none;font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:2px 8px;background:var(--card)}
.toc a:hover{color:var(--accent);border-color:var(--accent)}
.toc a.err{color:var(--fail);border-color:var(--fail)}
.toc-search{margin-left:auto;flex:none;display:flex;align-items:center;gap:6px}
.search-box{font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);width:180px}
.search-box:focus{outline:1.5px solid var(--accent);outline-offset:0}
.search-count{font-size:11px;color:var(--muted);min-width:52px;font-variant-numeric:tabular-nums}
.code-wrap{position:relative}
.code-wrap pre{margin:0}
.copy{position:absolute;top:6px;right:6px;font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--muted);cursor:pointer;opacity:0;transition:opacity .12s}
.code-wrap:hover .copy,details[open] .copy:focus{opacity:1}
.copy:hover{color:var(--accent);border-color:var(--accent)}
.hidden{display:none}
footer{margin-top:28px;color:var(--muted);font-size:12px}
.theme-toggle{position:fixed;top:14px;right:16px;z-index:9;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:5px 10px;cursor:pointer;font-size:12px}
[data-theme=light]{color-scheme:light}
[data-theme=dark]{color-scheme:dark}
@media print{.theme-toggle,.jump-error,.toc,.copy{display:none}body{background:#fff;color:#000;max-width:100%}.entry,.card,.kpi{break-inside:avoid;border-color:#bbb}pre{background:#f3f4f6}}
`;
/** Render the complete single-file HTML report. */
function renderHtml(input, options) {
	const opts = {
		...defaultHtmlOptions,
		...options
	};
	const lang = opts.lang ?? "en";
	const h = input.header;
	const errorCount = input.entries.filter(isEntryError).length;
	const turns = renderTurns(input, opts);
	const toolbar = renderToolbar(input, opts, errorCount);
	const jump = errorCount > 0 ? `<a class="jump-error" href="#error-1">${escapeHtml(tf("jumpError", lang, { n: errorCount }))}</a>` : "";
	const title = tf("title", lang, { id: id8$1(h.id) });
	return `<!doctype html>
<html lang="${lang === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body id="top">
<button class="theme-toggle" type="button" aria-label="${escapeHtml(t("theme", lang))}">${escapeHtml(t("theme", lang))}</button>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${escapeHtml(h.cwd ?? "")} · ${escapeHtml(h.createdAt ? fmtTime(h.createdAt) : "?")}${h.agentPreset !== void 0 ? ` · ${escapeHtml(h.agentPreset)}` : ""}</div>
${renderFilterNote(input)}
${renderKpiGrid(input, lang)}
${jump}
${toolbar}
${renderTimeline(input, lang)}
${renderToolRanking(input, lang)}
<section class="card"><h2>${escapeHtml(t("transcript", lang))}</h2>
${turns}
</section>
<footer>${escapeHtml(tf("footer", lang, {
		g: input.generator,
		t: fmtTime(input.generatedAt)
	}))}</footer>
<script>
(function(){
  var b=document.querySelector('.theme-toggle');
  var saved=null;try{saved=localStorage.getItem('dsh-theme')}catch(e){}
  if(saved){document.documentElement.dataset.theme=saved}
  b.addEventListener('click',function(){
    var cur=document.documentElement.dataset.theme||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
    var next=cur==='dark'?'light':'dark';
    document.documentElement.dataset.theme=next;
    try{localStorage.setItem('dsh-theme',next)}catch(e){}
  });
  window.addEventListener('beforeprint',function(){
    var d=document.querySelectorAll('details');for(var i=0;i<d.length;i++){d[i].open=true}
  });
  var COPIED=${JSON.stringify(t("copiedLabel", lang))},COPY=${JSON.stringify(t("copyLabel", lang))};
  function legacyCopy(text){
    var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    var ok=false;try{ok=document.execCommand('copy')}catch(e){}
    document.body.removeChild(ta);return ok;
  }
  document.addEventListener('click',function(e){
    var btn=e.target;while(btn&&btn!==document&&!(btn.classList&&btn.classList.contains('copy'))){btn=btn.parentNode}
    if(!btn||!btn.classList||!btn.classList.contains('copy'))return;
    var wrap=btn.parentElement;var pre=wrap?wrap.querySelector('pre'):null;
    if(!pre)return;
    var text=pre.textContent||'';
    function done(ok){btn.textContent=ok?COPIED:'✗';setTimeout(function(){btn.textContent=COPY},1200)}
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){done(true)},function(){done(legacyCopy(text))});
    }else{done(legacyCopy(text))}
  });
  var box=document.querySelector('.search-box'),count=document.querySelector('.search-count');
  if(box&&count){
    box.addEventListener('input',function(){
      var q=box.value.trim().toLowerCase(),n=0;
      var turns=document.querySelectorAll('.turn');
      for(var i=0;i<turns.length;i++){
        var turn=turns[i],vis=false,es=turn.querySelectorAll('.entry');
        for(var j=0;j<es.length;j++){
          var hit=!q||(es[j].textContent||'').toLowerCase().indexOf(q)>-1;
          es[j].classList.toggle('hidden',!hit);
          if(hit){vis=true;n++}
        }
        turn.classList.toggle('hidden',!vis);
        if(q&&vis){turn.open=true}
      }
      count.textContent=q?String(n):'';
    });
    box.addEventListener('keydown',function(e){if(e.key==='Escape'){box.value='';box.dispatchEvent(new Event('input'))}});
    document.addEventListener('keydown',function(e){
      if(e.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName||'')){e.preventDefault();box.focus()}
    });
  }
})();
<\/script>
</body>
</html>
`;
}
//#endregion
//#region src/mask.ts
/**
* Built-in rules. Ordered most-specific first; order matters only for rules
* that can overlap (Bearer header text also matching a prefixed key).
*/
const BUILTIN_RULES = [
	{
		name: "private-key",
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replacement: "[PRIVATE KEY REDACTED]"
	},
	{
		name: "bearer",
		pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g,
		replacement: "$1[REDACTED]"
	},
	{
		name: "prefixed-key",
		pattern: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
		replacement: "[REDACTED]"
	},
	{
		name: "email",
		pattern: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g,
		replacement: "[EMAIL]"
	}
];
function compileRules(options) {
	const extra = (options?.extraPatterns ?? []).map((source, index) => {
		try {
			return {
				name: `extra-${index}`,
				pattern: new RegExp(source, "g"),
				replacement: "[REDACTED]"
			};
		} catch {
			return null;
		}
	});
	return [...BUILTIN_RULES, ...extra.filter((rule) => rule !== null)];
}
/**
* Mask one free-text value in place under the compiled rules.
* @param text - Raw text.
* @param rules - Compiled rules.
* @returns Masked text (the same reference when nothing matched).
*/
function applyRules(text, rules) {
	let out = text;
	for (const rule of rules) out = out.replace(rule.pattern, rule.replacement);
	return out;
}
/**
* Mask user-visible text inside a message's content blocks. Structural
* fields (ids, names, kinds) stay verbatim so tool-call/result pairing
* and lineage references keep resolving.
* @param message - Message to mask (mutated in place for efficiency).
* @param rules - Compiled rules.
*/
function maskMessage(message, rules) {
	for (const block of message.content) if (block.type === "text" || block.type === "reasoning") block.text = applyRules(block.text, rules);
	else if (block.type === "tool-call") block.arguments = applyRules(block.arguments, rules);
	else if ("content" in block) {
		for (const inner of block.content) if (inner.type === "text") inner.text = applyRules(inner.text, rules);
	}
}
/**
* Mask a read-only entry list into a new array with masked copies.
* @param entries - Original entries (never mutated).
* @param options - Mask options.
* @returns New entry array with masked message content; entry/ordering metadata unchanged.
*/
function maskEntries(entries, options) {
	const rules = compileRules(options);
	return entries.map((entry) => ({
		...entry,
		message: (() => {
			const copy = structuredClone(entry.message);
			maskMessage(copy, rules);
			return copy;
		})()
	}));
}
/**
* Mask a bare string (exported for tests and direct use).
* @param text - Raw text.
* @param options - Mask options.
* @returns Masked text.
*/
function maskText(text, options) {
	return applyRules(text, compileRules(options));
}
//#endregion
//#region src/util/duration.ts
/**
* Duration-string parsing shared by `/transcript --last` and `/archive --since`.
*
* @module dsh-session-export/util/duration
*/
/**
* Parse `7d`/`12h`/`30m`/`90s` into an epoch-millisecond lower bound
* (now minus the duration).
* @param input - Raw token as typed by the user.
* @returns The lower-bound epoch milliseconds, or null when malformed.
*/
function parseDurationBound(input) {
	const match = /^(\d+)\s*([smhd])$/.exec(input.trim());
	if (match === null) return null;
	const n = Number(match[1]);
	const unit = match[2];
	const ms = unit === "s" ? n * 1e3 : unit === "m" ? n * 6e4 : unit === "h" ? n * 36e5 : n * 864e5;
	return Date.now() - ms;
}
//#endregion
//#region src/util/atomicWrite.ts
/**
* Write a file atomically: write to a sibling temp file, then rename over the
* destination. Readers never observe a partial transcript.
*/
async function atomicWriteFile(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, path);
}
/** Binary variant of {@link atomicWriteFile} for ZIP payloads. */
async function atomicWriteBytes(path, data) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
	await writeFile(tmp, data);
	await rename(tmp, path);
}
//#endregion
//#region src/command.ts
const USAGE = "Usage: /transcript [path] [--id <sessionId>] [--out <path>] [--json] [--md] [--html] [--full] [--last <duration>] [--errors-only] [--mask]";
/** Parse raw command input; returns args or a usage-error string. */
function parseTranscriptArgs(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return {
		json: false,
		md: true,
		html: false,
		full: false,
		errorsOnly: false,
		mask: false
	};
	const tokens = trimmed.split(/\s+/);
	const args = {
		json: false,
		md: false,
		html: false,
		full: false,
		errorsOnly: false,
		mask: false
	};
	let positional;
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === void 0) break;
		if (token === "--id") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) return `--id requires a session id value.\n${USAGE}`;
			if (args.sessionId !== void 0) return `--id may be given only once.\n${USAGE}`;
			args.sessionId = value;
			i += 2;
			continue;
		}
		if (token === "--out") {
			const rest = trimmed.slice(trimmed.indexOf("--out") + 5).trim();
			if (rest.length === 0) return `--out requires a path value.\n${USAGE}`;
			args.outPath = rest;
			break;
		}
		if (token === "--json") {
			args.json = true;
			i += 1;
			continue;
		}
		if (token === "--md") {
			args.md = true;
			i += 1;
			continue;
		}
		if (token === "--full") {
			args.full = true;
			i += 1;
			continue;
		}
		if (token === "--html") {
			args.html = true;
			i += 1;
			continue;
		}
		if (token === "--mask") {
			args.mask = true;
			i += 1;
			continue;
		}
		if (token === "--errors-only") {
			args.errorsOnly = true;
			i += 1;
			continue;
		}
		if (token === "--last") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) return `--last requires a duration (e.g. 30m, 12h, 7d).\n${USAGE}`;
			const bound = parseDurationBound(value);
			if (bound === null) return `--last expects a duration like 30m, 12h, or 7d.\n${USAGE}`;
			args.since = bound;
			i += 2;
			continue;
		}
		if (token.startsWith("--")) return `Unknown option: ${token}\n${USAGE}`;
		if (positional !== void 0) return `Unexpected extra positional argument: ${token}\n${USAGE}`;
		positional = token;
		i += 1;
	}
	if (args.outPath === void 0) args.outPath = positional;
	if (!args.json && !args.md && !args.html) args.md = true;
	return args;
}
function id8(id) {
	return id.replace(/^session-/, "").slice(0, 8);
}
function timestampSlug(epochMs) {
	const d = new Date(epochMs);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
/** Adapt append-origin surface events to renderer entries (drop nulls). */
function buildEntries(events) {
	const entries = [];
	for (const event of events) {
		if (!isAppendSurfaceEvent(event)) continue;
		const message = deriveEventMessage(event);
		if (message === null) continue;
		const data = event.data;
		const kind = message.role === "assistant" ? "assistant" : message.source.kind === "tool" ? "tool-result" : "user";
		entries.push({
			seq: event.seq,
			time: event.time,
			kind,
			message,
			...event.type === "assistant/message" && data.usage !== void 0 ? { usage: data.usage } : {},
			...event.type === "tool/result" && data.error !== void 0 ? { error: data.error } : {}
		});
	}
	return entries;
}
const LOG_ONLY_SUMMARY_TYPES = /* @__PURE__ */ new Set([
	"command/run",
	"command/done",
	"compaction/start",
	"compaction/end"
]);
/** Summarize log-only events for the --full appendix. */
function buildLogOnly(events) {
	const lines = [];
	for (const event of events) {
		if (!LOG_ONLY_SUMMARY_TYPES.has(event.type)) continue;
		const data = event.data;
		let summary;
		if (event.type === "command/run" && typeof data.name === "string") summary = `/${data.name}`;
		if (event.type === "command/done" && typeof data.kind === "string") summary = `/${String(data.name ?? "")} → ${data.kind}`.trim();
		if (event.type === "command/done" && typeof data.text === "string" && data.text.length > 0) summary = `${summary ?? ""} — ${data.text.slice(0, 80)}`.trim();
		lines.push({
			seq: event.seq,
			time: event.time,
			type: event.type,
			...summary !== void 0 ? { summary } : {}
		});
	}
	return lines;
}
function buildTotals(entries) {
	let toolCalls = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	for (const entry of entries) if (entry.message.role === "assistant") {
		for (const block of entry.message.content) if (block.type === "tool-call") toolCalls += 1;
		if (entry.usage !== void 0) {
			inputTokens += entry.usage.inputTokens;
			outputTokens += entry.usage.outputTokens;
		}
	}
	return {
		messages: entries.length,
		toolCalls,
		inputTokens,
		outputTokens
	};
}
function toLineageNode(node) {
	const children = Array.isArray(node.descendants) ? node.descendants : [];
	return {
		id: node.session.header.id,
		createdAt: node.session.header.createdAt,
		...node.session.header.origin !== void 0 ? { origin: node.session.header.origin } : {},
		children: children.map(toLineageNode)
	};
}
const GENERATOR = "dsh-session-export v1.1.0";
/** Execute the /transcript command against the session-query seam. */
async function executeTranscript(ctx, invocation, config) {
	const parsed = parseTranscriptArgs(invocation.rawInput);
	if (typeof parsed === "string") return {
		kind: "error",
		text: parsed
	};
	const args = parsed;
	const sessionIdRaw = args.sessionId ?? invocation.agent.session.id;
	const sessionId = SessionId(String(sessionIdRaw));
	let log;
	try {
		log = await ctx.sessionQuery.readSession(sessionId);
	} catch (error) {
		return {
			kind: "error",
			text: `Could not read session ${id8(String(sessionIdRaw))}: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	let lineage;
	try {
		const trace = await ctx.sessionQuery.traceSession(sessionId);
		lineage = {
			ancestors: trace.ancestors.map((record) => ({
				id: record.header.id,
				createdAt: record.header.createdAt,
				...record.header.origin !== void 0 ? { origin: record.header.origin } : {}
			})),
			descendants: trace.descendants.map(toLineageNode)
		};
	} catch {
		lineage = void 0;
	}
	let entries = buildEntries(log.events);
	if (args.errorsOnly) {
		const keep = /* @__PURE__ */ new Set();
		entries.forEach((entry, index) => {
			if (entry.error !== void 0) for (let w = Math.max(0, index - 2); w <= Math.min(entries.length - 1, index + 2); w += 1) keep.add(w);
		});
		entries = entries.filter((_, index) => keep.has(index));
	}
	if (args.since !== void 0) entries = entries.filter((entry) => entry.time >= args.since);
	const filterNote = args.errorsOnly && args.since !== void 0 ? "Filtered view: failed tool results with context, further limited by --last" : args.errorsOnly ? "Filtered view: failed tool results with a two-entry context window (--errors-only)" : args.since !== void 0 ? "Filtered view: entries within --last" : void 0;
	const totals = buildTotals(entries);
	const stats = computeStats(entries, config?.pricing);
	const renderedEntries = args.mask || config?.mask === true ? maskEntries(entries, { extraPatterns: config?.maskPatterns }) : entries;
	const input = {
		header: log.session,
		entries: renderedEntries,
		...lineage !== void 0 ? { lineage } : {},
		...args.full ? { logOnly: buildLogOnly(log.events) } : {},
		totals,
		stats,
		...filterNote !== void 0 ? { filterNote } : {},
		generator: GENERATOR,
		generatedAt: Date.now()
	};
	const baseDir = config?.defaultDir ?? log.session.cwd ?? process.cwd();
	const outputs = [];
	const slug = `transcript-${id8(String(sessionIdRaw))}-${timestampSlug(Date.now())}`;
	const defaultPath = args.outPath !== void 0 ? void 0 : `${baseDir}/dsh-transcripts/${slug}`;
	if (args.md) {
		const path = defaultPath !== void 0 ? `${defaultPath}.md` : requireExtension(args.outPath, ".md");
		outputs.push({
			path,
			content: renderMarkdown(input, config)
		});
	}
	if (args.html) {
		const path = defaultPath !== void 0 ? `${defaultPath}.html` : args.outPath !== void 0 && (args.md || args.json) ? requireExtension(args.outPath.replace(/\.(md|json)$/i, ""), ".html") : requireExtension(args.outPath, ".html");
		outputs.push({
			path,
			content: renderHtml(input, config)
		});
	}
	if (args.json) {
		const path = defaultPath !== void 0 ? `${defaultPath}.json` : args.outPath !== void 0 && (args.md || args.html) ? requireExtension(args.outPath.replace(/\.(md|html)$/i, ""), ".json") : requireExtension(args.outPath, ".json");
		outputs.push({
			path,
			content: renderJson(input)
		});
	}
	try {
		for (const output of outputs) await atomicWriteFile(output.path, output.content);
	} catch (error) {
		return {
			kind: "error",
			text: `Failed to write transcript: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	const written = outputs.map((output) => output.path).join(", ");
	return {
		kind: "success",
		text: `Exported ${totals.messages} messages (${totals.toolCalls} tool calls, ${totals.inputTokens + totals.outputTokens} tokens) → ${written}`
	};
}
function requireExtension(path, ext) {
	if (path === void 0) throw new Error("output path required");
	return path.toLowerCase().endsWith(ext) ? path : `${path}${ext}`;
}
//#endregion
//#region src/util/zip.ts
/**
* Minimal single-file ZIP writer (DEFLATE method 8, no external dependency).
*
* Emits one local-file header per entry plus the central directory and EOCD
* record — no data descriptors, no extra fields. Entries are compressed with
* raw DEFLATE (`node:zlib.deflateRawSync`, which is exactly the ZIP method 8
* stream) and CRC32-checked with `node:zlib.crc32`, both present in the
* supported Node range. `unzip` and standard extractors accept the output.
*
* @module dsh-session-export/util/zip
*/
const LFH_SIG = 67324752;
const CD_SIG = 33639248;
const EOCD_SIG = 101010256;
/** MS-DOS packed time/date used by the ZIP headers. */
function dosDateTime(epochMs) {
	const d = new Date(epochMs);
	return {
		time: d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1,
		date: d.getFullYear() - 1980 << 9 | d.getMonth() + 1 << 5 | d.getDate()
	};
}
/** Build one DEFLATE-compressed ZIP archive over the given entries. */
function buildZip(entries, nowMs = Date.now()) {
	const { time, date } = dosDateTime(nowMs);
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.from(entry.data);
		const deflated = deflateRawSync(raw);
		const checksum = crc32(raw) >>> 0;
		const lfh = Buffer.alloc(30);
		lfh.writeUInt32LE(LFH_SIG, 0);
		lfh.writeUInt16LE(20, 4);
		lfh.writeUInt16LE(0, 6);
		lfh.writeUInt16LE(8, 8);
		lfh.writeUInt16LE(time, 10);
		lfh.writeUInt16LE(date, 12);
		lfh.writeUInt32LE(checksum, 14);
		lfh.writeUInt32LE(deflated.length, 18);
		lfh.writeUInt32LE(raw.length, 22);
		lfh.writeUInt16LE(name.length, 26);
		lfh.writeUInt16LE(0, 28);
		locals.push(lfh, name, deflated);
		const cd = Buffer.alloc(46);
		cd.writeUInt32LE(CD_SIG, 0);
		cd.writeUInt16LE(20, 4);
		cd.writeUInt16LE(20, 6);
		cd.writeUInt16LE(0, 8);
		cd.writeUInt16LE(8, 10);
		cd.writeUInt16LE(time, 12);
		cd.writeUInt16LE(date, 14);
		cd.writeUInt32LE(checksum, 16);
		cd.writeUInt32LE(deflated.length, 20);
		cd.writeUInt32LE(raw.length, 24);
		cd.writeUInt16LE(name.length, 28);
		cd.writeUInt16LE(0, 30);
		cd.writeUInt16LE(0, 32);
		cd.writeUInt16LE(0, 34);
		cd.writeUInt16LE(0, 36);
		cd.writeUInt32LE(0, 38);
		cd.writeUInt32LE(offset, 42);
		centrals.push(cd, name);
		offset += lfh.length + name.length + deflated.length;
	}
	const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(EOCD_SIG, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cdSize, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);
	return Buffer.concat([
		...locals,
		...centrals,
		eocd
	]);
}
//#endregion
//#region src/archive.ts
const ARCHIVE_USAGE = "Usage: /archive [--id <sessionId>] [--all] [--since <duration>] [--out <dir>] [--no-descendants]";
const TOOL = "dsh-session-export";
const TOOL_VERSION = "1.1.0";
/** Slice an event to its canonical raw JSONL form (type/seq/time/data + surface fields). */
function eventToJsonlLine(event) {
	const line = {
		type: event.type,
		seq: event.seq,
		time: event.time,
		data: event.data
	};
	if ("sourceEventSeqs" in event && event.sourceEventSeqs !== void 0) line.sourceEventSeqs = event.sourceEventSeqs;
	if ("surfaceOp" in event && event.surfaceOp !== void 0) line.surfaceOp = event.surfaceOp;
	return JSON.stringify(line);
}
function dateSlug(epochMs) {
	const d = new Date(epochMs);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
/** `7d`/`12h`/`30m`/`90s` → epoch-millisecond lower bound, or a usage error. */
function parseDuration(input) {
	const bound = parseDurationBound(input);
	if (bound === null) return `--since expects a duration like 7d, 12h, 30m, or 90s.\n${ARCHIVE_USAGE}`;
	return bound;
}
/** Parse raw command input; returns args or a usage-error string. */
function parseArchiveArgs(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return {
		all: false,
		noDescendants: false
	};
	const args = {
		all: false,
		noDescendants: false
	};
	const outIndex = trimmed.indexOf("--out");
	let tokenSource = trimmed;
	if (outIndex !== -1) {
		const rest = trimmed.slice(outIndex + 5).trim();
		if (rest.length === 0) return `--out requires a directory path.\n${ARCHIVE_USAGE}`;
		args.outDir = rest;
		tokenSource = trimmed.slice(0, outIndex).trim();
	}
	const tokens = tokenSource.length === 0 ? [] : tokenSource.split(/\s+/);
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === void 0) break;
		if (token === "--id") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) return `--id requires a session id value.\n${ARCHIVE_USAGE}`;
			if (args.sessionId !== void 0) return `--id may be given only once.\n${ARCHIVE_USAGE}`;
			args.sessionId = value;
			i += 2;
			continue;
		}
		if (token === "--all") {
			args.all = true;
			i += 1;
			continue;
		}
		if (token === "--since") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) return `--since requires a duration (e.g. 7d, 12h, 30m).\n${ARCHIVE_USAGE}`;
			const parsed = parseDuration(value);
			if (typeof parsed === "string") return parsed;
			args.since = parsed;
			i += 2;
			continue;
		}
		if (token === "--no-descendants") {
			args.noDescendants = true;
			i += 1;
			continue;
		}
		if (token.startsWith("--")) return `Unknown option: ${token}\n${ARCHIVE_USAGE}`;
		return `Unexpected argument: ${token}\n${ARCHIVE_USAGE}`;
	}
	return args;
}
/** Target session + flattened descendant headers for a lineage archive. */
async function collectWithDescendants(ctx, sessionId, includeDescendants) {
	const trace = await ctx.sessionQuery.traceSession(sessionId);
	const headers = [trace.target.header];
	if (!includeDescendants) return headers;
	const walk = (nodes) => {
		for (const node of nodes) {
			headers.push(node.session.header);
			walk(node.descendants);
		}
	};
	walk(trace.descendants);
	return headers;
}
/** Build one session's archive ZIP; returns the bytes and the event count. */
async function buildArchiveZip(ctx, header) {
	const log = await ctx.sessionQuery.readSession(header.id);
	const jsonl = log.events.map(eventToJsonlLine).join("\n") + (log.events.length > 0 ? "\n" : "");
	const manifest = {
		schemaVersion: 1,
		tool: TOOL,
		toolVersion: TOOL_VERSION,
		sessionId: log.session.id,
		id8: id8(log.session.id),
		createdAt: log.session.createdAt,
		exportedAt: Date.now(),
		eventCount: log.events.length,
		...log.session.cwd !== void 0 ? { cwd: log.session.cwd } : {},
		...log.session.parentSession !== void 0 ? { parentSession: log.session.parentSession } : {},
		...log.session.origin !== void 0 ? { origin: log.session.origin } : {},
		...log.session.delegationDepth !== void 0 ? { delegationDepth: log.session.delegationDepth } : {}
	};
	return {
		zip: buildZip([{
			name: "session.jsonl",
			data: new TextEncoder().encode(jsonl)
		}, {
			name: "manifest.json",
			data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
		}]),
		eventCount: log.events.length
	};
}
/** Execute `/archive` against the session-query seam. */
async function executeArchive(ctx, invocation, config) {
	const parsed = parseArchiveArgs(invocation.rawInput);
	if (typeof parsed === "string") return {
		kind: "error",
		text: parsed
	};
	const args = parsed;
	const ownCwd = invocation.agent.session.header?.cwd;
	const outDir = args.outDir ?? config?.archiveDir ?? `${ownCwd ?? process.cwd()}/.dsh-archives`;
	const includeDescendants = (config?.includeDescendants ?? true) && !args.noDescendants;
	const maxSessions = config?.maxSessionsPerRun ?? 100;
	let targets;
	try {
		if (args.sessionId !== void 0) targets = await collectWithDescendants(ctx, SessionId(String(args.sessionId)), includeDescendants);
		else if (args.all || args.since !== void 0) {
			let headers = (await ctx.sessionQuery.listSessions()).map((record) => record.header);
			if (ownCwd !== void 0) headers = headers.filter((header) => header.cwd === ownCwd);
			const since = args.since;
			if (since !== void 0) headers = headers.filter((header) => header.createdAt >= since);
			targets = headers;
		} else targets = await collectWithDescendants(ctx, invocation.agent.session.id, includeDescendants);
	} catch (error) {
		return {
			kind: "error",
			text: `Could not list sessions to archive: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	if (targets.length === 0) return {
		kind: "success",
		text: "No sessions matched; nothing archived."
	};
	if (targets.length > maxSessions) return {
		kind: "error",
		text: `Refusing to archive ${targets.length} sessions (max ${maxSessions} per run); narrow with --since or --id.`
	};
	const written = [];
	const failures = [];
	let totalEvents = 0;
	for (const header of targets) try {
		const { zip, eventCount } = await buildArchiveZip(ctx, header);
		const path = `${outDir}/dsh-session-${id8(header.id)}-${dateSlug(Date.now())}.zip`;
		await atomicWriteBytes(path, zip);
		written.push(path);
		totalEvents += eventCount;
	} catch (error) {
		failures.push({
			id: id8(header.id),
			reason: error instanceof Error ? error.message : String(error)
		});
	}
	if (written.length === 0) {
		const detail = failures.map((f) => `${f.id}: ${f.reason}`).join("; ");
		return {
			kind: "error",
			text: `Archived nothing — all ${failures.length} sessions failed. ${detail}`
		};
	}
	const summary = written.length === 1 ? `Archived ${totalEvents} events → ${written[0]}` : `Archived ${written.length} sessions (${totalEvents} events) → ${outDir}`;
	if (failures.length === 0) return {
		kind: "success",
		text: summary
	};
	const failDetail = failures.map((f) => `${f.id}: ${f.reason}`).join("; ");
	return {
		kind: "success",
		text: `${summary}; ${failures.length} failed — ${failDetail}`
	};
}
//#endregion
//#region src/statsCommand.ts
const STATS_USAGE = "Usage: /stats [--id <sessionId>]";
/** Parse raw command input; returns args or a usage-error string. */
function parseStatsArgs(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return {};
	const tokens = trimmed.split(/\s+/);
	const args = {};
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token === void 0) break;
		if (token === "--id") {
			const value = tokens[i + 1];
			if (value === void 0 || value.startsWith("--")) return `--id requires a session id value.\n${STATS_USAGE}`;
			if (args.sessionId !== void 0) return `--id may be given only once.\n${STATS_USAGE}`;
			args.sessionId = value;
			i += 2;
			continue;
		}
		return `Unknown argument: ${token}\n${STATS_USAGE}`;
	}
	return args;
}
/** Execute the /stats command against the session-query seam. */
async function executeStats(ctx, invocation, config) {
	const parsed = parseStatsArgs(invocation.rawInput);
	if (typeof parsed === "string") return {
		kind: "error",
		text: parsed
	};
	const sessionIdRaw = parsed.sessionId ?? invocation.agent.session.id;
	const sessionId = SessionId(String(sessionIdRaw));
	let events;
	try {
		events = (await ctx.sessionQuery.readSession(sessionId)).events;
	} catch (error) {
		return {
			kind: "error",
			text: `Could not read session ${id8(String(sessionIdRaw))}: ${error instanceof Error ? error.message : String(error)}`
		};
	}
	return {
		kind: "success",
		text: formatStatsCard(computeStats(buildEntries(events), config?.pricing))
	};
}
//#endregion
//#region src/index.ts
const name = "session-export";
const inject = ["commands", "sessionQuery"];
/** Plugin entry: mount the /transcript and /archive commands. */
function apply(ctx, config) {
	ctx.effect(function* () {
		yield ctx.commands.register({
			name: "transcript",
			description: "Export this session (or another, via --id) as a Markdown/JSON transcript to a host path",
			handler: (invocation) => executeTranscript(ctx, invocation, config)
		});
		yield ctx.commands.register({
			name: "archive",
			description: "Archive raw session logs (any backend, incl. SQLite) as per-session ZIPs to a host path",
			handler: (invocation) => executeArchive(ctx, invocation, config)
		});
		yield ctx.commands.register({
			name: "stats",
			description: "Print a session stats card (messages, tools, tokens, duration, cost) — no files written",
			handler: (invocation) => executeStats(ctx, invocation, config)
		});
	}, "session-export lifecycle");
}
//#endregion
export { ARCHIVE_USAGE, STATS_USAGE, USAGE, apply, buildEntries, buildLogOnly, buildTotals, buildZip, computeStats, defaultHtmlOptions, defaultMarkdownOptions, formatDuration, formatStatsCard, id8, inject, maskEntries, maskText, name, parseArchiveArgs, parseStatsArgs, parseToolArguments, parseTranscriptArgs, renderEditorDiff, renderHtml, renderJson, renderLineageMermaid, renderMarkdown, renderTimelineMermaid, renderToolDiff, sparkline };
