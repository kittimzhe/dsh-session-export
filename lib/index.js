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
function fmtTime(epochMs) {
	return new Date(epochMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
function id8$1(id) {
	return id.slice(0, 8);
}
function renderHeaderBlock(input) {
	const h = input.header;
	const rows = [
		["Session", `\`${h.id}\``],
		["Project", h.cwd ?? "(no cwd)"],
		["Created", h.createdAt ? fmtTime(h.createdAt) : "(unknown)"]
	];
	if (h.agentPreset) rows.push(["Agent preset", h.agentPreset]);
	rows.push(["Messages", String(input.totals.messages)]);
	rows.push(["Tool calls", String(input.totals.toolCalls)]);
	rows.push(["Tokens (in/out)", `${input.totals.inputTokens.toLocaleString("en-US")} / ${input.totals.outputTokens.toLocaleString("en-US")}`]);
	rows.push(["Exported", fmtTime(input.generatedAt)]);
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
	return [`${"  ".repeat(depth)}- \`${id8$1(node.id)}\`${origin} — created ${fmtTime(node.createdAt)}`, ...node.children.flatMap((child) => renderLineageNode(child, depth + 1))];
}
function renderLineage(input) {
	const lineage = input.lineage;
	if (!lineage) return null;
	if (lineage.ancestors.length === 0 && lineage.descendants.length === 0) return null;
	const parts = ["## Lineage", ""];
	if (lineage.ancestors.length > 0) {
		parts.push("Ancestors (root → this session):");
		parts.push("");
		const chain = lineage.ancestors.map((a) => `\`${id8$1(a.id)}\``).concat("**this session**").join(" → ");
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
	const parts = [`### 🧾 Tool Result — call \`${id8$1(String(message.source.callId))}\`${error ? " ⚠️ ERROR" : ""}`, ""];
	if (error) parts.push(`> Tool failed: \`${error.name}\` (\`${error.code}\`)`, "");
	for (const block of message.content) {
		const inner = block.content.map((b) => b.type === "text" ? b.text : `*(block: ${JSON.stringify(b.type)})*`).join("\n");
		parts.push(fence("text", truncate(inner, options.resultCharLimit)), "");
		if (block.isError) parts.push("> ⚠️ result flagged as error", "");
	}
	return parts;
}
function renderEntry(entry, options) {
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
		parts.push(`- \`${line.seq}\` · ${fmtTime(line.time)} · \`${line.type}\`${summary}`);
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
		renderLineage(input),
		["## Transcript", ""].join("\n"),
		input.entries.map((entry) => renderEntry(entry, opts).join("\n")).join("\n"),
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
		...input.lineage !== void 0 ? { lineage: input.lineage } : {},
		transcript: input.entries.map(serializeEntry),
		...input.logOnly !== void 0 ? { logOnly: input.logOnly } : {}
	};
	return `${JSON.stringify(doc, null, 2)}\n`;
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
const USAGE = "Usage: /transcript [path] [--id <sessionId>] [--out <path>] [--json] [--md] [--full]";
/** Parse raw command input; returns args or a usage-error string. */
function parseTranscriptArgs(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return {
		json: false,
		md: true,
		full: false
	};
	const tokens = trimmed.split(/\s+/);
	const args = {
		json: false,
		md: false,
		full: false
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
		if (token.startsWith("--")) return `Unknown option: ${token}\n${USAGE}`;
		if (positional !== void 0) return `Unexpected extra positional argument: ${token}\n${USAGE}`;
		positional = token;
		i += 1;
	}
	if (args.outPath === void 0) args.outPath = positional;
	if (!args.json && !args.md) args.md = true;
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
const GENERATOR = "dsh-session-export v0.2.0";
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
	const entries = buildEntries(log.events);
	const totals = buildTotals(entries);
	const input = {
		header: log.session,
		entries,
		...lineage !== void 0 ? { lineage } : {},
		...args.full ? { logOnly: buildLogOnly(log.events) } : {},
		totals,
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
	if (args.json) {
		const path = defaultPath !== void 0 ? `${defaultPath}.json` : args.outPath !== void 0 && args.md ? requireExtension(args.outPath.replace(/\.md$/i, ""), ".json") : requireExtension(args.outPath, ".json");
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
const TOOL_VERSION = "0.2.0";
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
	const match = /^(\d+)\s*([smhd])$/.exec(input.trim());
	if (match === null) return `--since expects a duration like 7d, 12h, 30m, or 90s.\n${ARCHIVE_USAGE}`;
	const n = Number(match[1]);
	const ms = match[2] === "s" ? n * 1e3 : match[2] === "m" ? n * 6e4 : match[2] === "h" ? n * 36e5 : n * 864e5;
	return Date.now() - ms;
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
	}, "session-export lifecycle");
}
//#endregion
export { ARCHIVE_USAGE, USAGE, apply, buildEntries, buildLogOnly, buildTotals, buildZip, defaultMarkdownOptions, id8, inject, name, parseArchiveArgs, parseToolArguments, parseTranscriptArgs, renderEditorDiff, renderJson, renderMarkdown, renderToolDiff };
