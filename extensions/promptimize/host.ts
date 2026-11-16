/**
 * Host adapter: this extension runs on both the pi coding agent
 * (github.com/earendil-works/pi) and oh-my-pi (github.com/can1357/oh-my-pi).
 * oh-my-pi remaps `@earendil-works/*` imports onto its bundled host packages, so the
 * module surface mostly matches; a few runtime APIs do not (settings, model listing,
 * thinking level, streamSimple, symbol theme). Everything host-specific lives here.
 */
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type Host = "pi" | "omp";

export interface HostSettings {
	/** Model for the popup, as `provider/id`. Default: the session model. */
	model?: string;
	/** Default of the "include recent session context" box. */
	includeContext?: boolean;
}

/** The model shape both hosts share (pi's/omp's Model<Api> are supersets of this). */
export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

/** Canonical record guard for this package; narrow parsed JSON and host objects with it. */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isModelLike(v: unknown): v is ModelLike {
	return isRecord(v) && typeof v.provider === "string" && typeof v.id === "string";
}

function hasGetSettings(pi: unknown): pi is { getSettings: () => unknown } {
	return isRecord(pi) && typeof pi.getSettings === "function";
}

/** Call a no-arg method by name on a host object; undefined when absent or not a string. */
function call0String(obj: unknown, key: string): string | undefined {
	if (!isRecord(obj)) return undefined;
	const fn = obj[key];
	if (typeof fn !== "function") return undefined;
	const out = (fn as () => unknown).call(obj);
	return typeof out === "string" && out ? out : undefined;
}

export function detectHost(pi: unknown): Host {
	return hasGetSettings(pi) ? "pi" : "omp";
}
/** Narrow an unknown host model object to ModelLike, or undefined. */
export function modelLike(v: unknown): ModelLike | undefined {
	return isModelLike(v) ? v : undefined;
}

export function isModelArray(v: unknown): ModelLike[] | undefined {
	return Array.isArray(v) ? v.filter(isModelLike) : undefined;
}

const PLUGIN_NAME = "pi-promptimize"; // mirrors package.json "name"; settings live under this key on omp

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

function settingsFrom(raw: unknown): HostSettings {
	if (!isRecord(raw)) return {};
	const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
	const includeContext = typeof raw.includeContext === "boolean" ? raw.includeContext : undefined;
	return { model, includeContext };
}

/**
 * Settings on oh-my-pi. There is no `promptimize` key in omp's settings; plugin config
 * lives in the plugins lockfile (`omp plugin config set pi-promptimize <key> <value>`),
 * optionally overridden per project in `<cwd>/.omp/plugin-overrides.json` (or the
 * `.claude`/`.codex`/`.gemini` project config dirs; the first existing one wins,
 * mirroring omp's own resolution order). PROMPTIMIZE_MODEL / PROMPTIMIZE_INCLUDE_CONTEXT
 * env vars act as a fallback when nothing is stored. Never throws.
 */
async function readOmpSettings(cwd: string): Promise<HostSettings> {
	const merged: HostSettings = {};
	// Exception (dynamic import): @oh-my-pi/pi-utils exists only under oh-my-pi; a static
	// import would fail at link time on pi before the host guard can run.
	let lockPath = path.join(os.homedir(), ".omp", "plugins", "omp-plugins.lock.json");
	try {
		const piUtils: unknown = await import("@oh-my-pi/pi-utils");
		const get = isRecord(piUtils) ? piUtils.getPluginsLockfile : undefined;
		const fromUtils = typeof get === "function" ? (get as () => unknown)() : undefined;
		if (typeof fromUtils === "string") lockPath = fromUtils;
	} catch {
		// keep the default path
	}
	const lock = await readJson(lockPath);
	const lockSettings = isRecord(lock) && isRecord(lock.settings) ? lock.settings : undefined;
	Object.assign(merged, settingsFrom(lockSettings?.[PLUGIN_NAME]));
	for (const base of [".omp", ".claude", ".codex", ".gemini"]) {
		const proj = await readJson(path.join(cwd, base, "plugin-overrides.json"));
		if (!isRecord(proj)) continue;
		const projSettings = isRecord(proj.settings) ? proj.settings : undefined;
		Object.assign(merged, settingsFrom(projSettings?.[PLUGIN_NAME]));
		break;
	}
	if (merged.model === undefined && process.env.PROMPTIMIZE_MODEL?.trim()) merged.model = process.env.PROMPTIMIZE_MODEL.trim();
	if (merged.includeContext === undefined && process.env.PROMPTIMIZE_INCLUDE_CONTEXT !== undefined)
		merged.includeContext = /^(1|true|yes|on)$/i.test(process.env.PROMPTIMIZE_INCLUDE_CONTEXT.trim());
	return merged;
}

/** The plugin's settings on the current host. Never throws; missing values mean "use the default". */
export async function readSettings(host: Host, pi: unknown, cwd: string): Promise<HostSettings> {
	try {
		if (host === "pi" && hasGetSettings(pi)) {
			const all = pi.getSettings();
			return settingsFrom(isRecord(all) ? all.promptimize : undefined);
		}
		return host === "omp" ? await readOmpSettings(cwd) : {};
	} catch {
		return {};
	}
}

/**
 * Structural view of the two hosts' extension contexts; both are supersets of this.
 * Members stay `unknown` on purpose — the hosts' registries are large SDK types we only
 * need four members of, and the popup runs without a type gate. Narrow at the boundary.
 */
export interface HostContext {
	readonly scopedModels?: unknown;
	readonly modelRegistry?: unknown;
	readonly models?: unknown;
	readonly thinkingLevel?: string;
	readonly cwd: string;
}

/** The registry slice both hosts provide. */
interface RegistryLike {
	getAvailable?: () => unknown;
	find?: (provider: string, modelId: string) => unknown;
	streamSimple?: (model: unknown, context: unknown, options: unknown) => unknown;
	resolver?: (model: unknown) => unknown;
}

// Extension contexts are supersets; this adapter only uses the members above.
function asRegistry(v: unknown): RegistryLike | undefined {
	return isRecord(v) ? (v as RegistryLike) : undefined;
}

/** The model list the popup offers: pi uses the session's scoped models (falling back to all with auth); omp has no scoped-models surface on the extension context, so it lists authenticated models (what `/model` picks from). */
export function listModels(host: Host, ctx: HostContext): ModelLike[] {
	if (host === "pi" && Array.isArray(ctx.scopedModels)) {
		const scoped = isModelArray(ctx.scopedModels.map((s: unknown) => (isRecord(s) ? s.model : undefined)));
		if (scoped?.length) return scoped;
	}
	if (host === "omp" && isRecord(ctx.models)) {
		const list = ctx.models.list;
		if (typeof list === "function") {
			const fromFacade = isModelArray((list as () => unknown).call(ctx.models));
			if (fromFacade) return fromFacade;
		}
	}
	const registry = asRegistry(ctx.modelRegistry);
	return (typeof registry?.getAvailable === "function" ? isModelArray(registry.getAvailable()) : undefined) ?? [];
}

/** Resolve a configured `provider/id` to a Model, on either host. */
export function findModel(ctx: HostContext, id: string): ModelLike | undefined {
	const slash = id.indexOf("/");
	if (slash <= 0) return undefined;
	const registry = asRegistry(ctx.modelRegistry);
	const found = typeof registry?.find === "function" ? registry.find(id.slice(0, slash), id.slice(slash + 1)) : undefined;
	return isModelLike(found) ? found : undefined;
}

/** The session's thinking level, or undefined (pi exposes it on the context, omp on the API as a method). */
export function thinkingLevel(pi: unknown, ctx: HostContext): string | undefined {
	const fromContext = ctx.thinkingLevel;
	if (typeof fromContext === "string" && fromContext) return fromContext;
	const level = call0String(pi, "getThinkingLevel");
	return level ? level : undefined;
}

/** What core.complete() needs back from a streaming call. */
interface SimpleStream {
	result(): Promise<{ stopReason: string; errorMessage?: string; content: ReadonlyArray<{ type: string; text?: string }> }>;
}

export type StreamSimpleFn = (model: unknown, context: unknown, options: Record<string, unknown>) => SimpleStream;

/**
 * The `streamSimple` half of the plugin. pi exposes it on the registry (which resolves
 * credentials itself); oh-my-pi does not, so call pi-ai's streamSimple with the registry's
 * stateless per-request key resolver — the same pattern omp uses for one-off model calls.
 */
export function makeStreamSimple(host: Host, ctx: HostContext, ompStreamSimple: unknown): StreamSimpleFn {
	const registry = asRegistry(ctx.modelRegistry);
	if (host === "pi") {
		if (typeof registry?.streamSimple !== "function") throw new Error("modelRegistry.streamSimple is not available on this pi build");
		const piStream = registry.streamSimple;
		return (model, context, options) => {
			// pi's AssistantMessageEventStream exposes .result(); host types differ by design here.
			const stream = piStream.call(registry, model, context, options);
			return stream as SimpleStream;
		};
	}
	if (typeof ompStreamSimple !== "function") throw new Error("streamSimple could not be loaded from @earendil-works/pi-ai");
	const ompStream = ompStreamSimple as (m: unknown, c: unknown, o: Record<string, unknown>) => SimpleStream; // pi-ai's AssistantMessageEventStream exposes .result()
	const resolverFn = registry?.resolver;
	const resolve = typeof resolverFn === "function" ? (m: unknown) => resolverFn.call(registry, m) : undefined;
	return (model, context, options) =>
		ompStream(model, context, { ...options, ...(resolve ? { apiKey: resolve(model) } : {}) });
}

/** Load oh-my-pi's streamSimple. pi never calls this: its pi-ai root has no such export. */
export async function loadOmpStreamSimple(): Promise<unknown> {
	// Exception (dynamic import): the pi host uses its registry instead; a static import of the
	// pi-ai root would fail at link time on pi, which exports no streamSimple from its root.
	const mod: unknown = await import("@earendil-works/pi-ai");
	const stream = isRecord(mod) ? mod.streamSimple : undefined;
	if (typeof stream !== "function") throw new Error("streamSimple not found in @earendil-works/pi-ai");
	return stream;
}

export interface BoxSymbolsLike {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
	teeDown: string;
	teeUp: string;
	teeLeft: string;
	teeRight: string;
	cross: string;
}

/** The subset of omp's SymbolTheme the Editor/SelectList read (or that SelectList falls back to). */
export interface SymbolThemeLike {
	cursor: string;
	inputCursor: string;
	boxRound: Pick<BoxSymbolsLike, "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | "horizontal" | "vertical">;
	boxSharp: BoxSymbolsLike;
	table: BoxSymbolsLike;
	quoteBorder: string;
	hrChar: string;
	spinnerFrames: string[];
}

/** Minimal ASCII fallback for omp when its themed symbol preset cannot be resolved. */
const ASCII_SYMBOLS: SymbolThemeLike = {
	cursor: "> ",
	inputCursor: "|",
	boxRound: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|" },
	boxSharp: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", teeDown: "+", teeUp: "+", teeLeft: "+", teeRight: "+", cross: "+" },
	table: { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", teeDown: "+", teeUp: "+", teeLeft: "+", teeRight: "+", cross: "+" },
	quoteBorder: "|",
	hrChar: "-",
	spinnerFrames: ["-", "\\", "|", "/"],
};

/** Resolve oh-my-pi's active symbol theme (unicode/ascii aware), falling back to ASCII glyphs. */
export async function resolveSymbols(): Promise<SymbolThemeLike> {
	// Exception (dynamic import): @oh-my-pi/pi-tui exists only under oh-my-pi; a static import
	// would fail at link time on pi before the host guard can run.
	try {
		const mod: unknown = await import("@oh-my-pi/pi-tui");
		const get = isRecord(mod) ? mod.getSymbolTheme : undefined;
		const theme: unknown = typeof get === "function" ? (get as () => unknown)() : undefined;
		// Sanity-check the two keys Editor dereferences unguarded before trusting the theme.
		if (isRecord(theme) && typeof theme.inputCursor === "string" && isRecord(theme.boxRound)) return theme as SymbolThemeLike;
	} catch {
		// fall through to ASCII
	}
	return ASCII_SYMBOLS;
}
