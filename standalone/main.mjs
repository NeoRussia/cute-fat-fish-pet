#!/usr/bin/env node
/* 「蓝毛小女仆」独立模式启动器
 *
 * 目的：不装 DSH、不装 dsh-pet 插件，也能把这只桌宠跑起来。
 *
 * 做法（架构照抄上游 dsh-pet 0.3.6 的 src/standalone/）：
 *   伪 ctx（context.mjs） + 真 http 服务（server.mjs） + 三个 DSH 包替身（shims/）
 *   然后调用 app/lib/index.js 导出的 apply(ctx) —— 也就是插件原来那个「宿主半侧」。
 *
 * 关键点：**app/ 里一个字都不改**。上游是用 tsdown 构建期 alias 把
 * @deepseek-ai/dsh-home-paths / -credentials / -llm 指向 shim 的；我们没有构建链，
 * 所以用 Node 24 的 module.registerHooks 在运行期做同一件事。副作用是这份副本
 * 同时仍然可以作为 DSH 插件被加载（那时走 DSH 自己提供的三个包，钩子不参与）。
 *
 * 比上游多走一步：上游的独立模式把模型服务留成「明确不可用」，碎碎念/对话/
 * 屏幕监测点评全废。这里把 ctx.llm / ctx.get("attachments") / agentDefaultModel
 * 接到本机 Ollama（ollama.mjs），所以「会说话」的功能在独立模式下照样工作。
 */

import crypto from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStandaloneContext, createStandaloneLogger, STANDALONE_PROVIDER } from "./context.mjs";
import { currentModel, currentProvider, listOllamaModels, ollamaApi, LOCAL_PROVIDER } from "./ollama.mjs";
import { DEFAULT_STANDALONE_PORT, listenStandaloneServer } from "./server.mjs";
import { APP_NAME, DISPLAY_NAME, applyEnv, readDeviceProfile, resolvePaths, seedUserData } from "./paths.mjs";
import { BlockAssembler, createUserMessage } from "./shims/dsh-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_DIR = resolve(HERE, "..", "app");
const SHIM_DIR = join(HERE, "shims");
const REPO_ROOT = resolve(HERE, "..");

/* ── 发布版路径：程序目录只读，数据都在 %APPDATA%\<APP_NAME>（放 portable.txt 则改到程序目录） ── */
const PATHS = resolvePaths(HERE);
if (!process.env.DSH_HOME) applyEnv(PATHS);

/* 首次运行「自动适配」出来的性能档位：显存小的机器少给上下文、早些把模型请出显存。
 * 必须在动态 import app/lib/index.js 之前设好 —— 桌宠 helper 是本进程 spawn 的，会继承这些变量。 */
const DEVICE_PROFILE = readDeviceProfile(PATHS);
if (DEVICE_PROFILE?.tune) {
	if (!process.env.DSH_PET_NUM_CTX) process.env.DSH_PET_NUM_CTX = String(DEVICE_PROFILE.tune.numCtx);
	if (!process.env.DSH_PET_KEEPALIVE) process.env.DSH_PET_KEEPALIVE = String(DEVICE_PROFILE.tune.keepAlive);
	if (!process.env.DSH_PET_YIELD_VRAM) process.env.DSH_PET_YIELD_VRAM = DEVICE_PROFILE.tune.yieldVram ? "1" : "0";
}

/* 把自己是谁、在哪、什么模型写在这里，stop-pet.mjs / 快捷键 / 排查都靠它
 * （放用户数据目录，程序目录将来装进 Program Files 也不会写不动） */
const RUNTIME_FILE = join(PATHS.userRoot, "runtime.json");

/* 本地控制口令：HTTP 那个 /shutdown 要它（见 server.mjs 的来源门禁说明）。
 * 每次启动换一把，只写在本机 runtime.json 里 —— stop-pet.mjs 读同一份带上；
 * 网页读不到这个文件，所以「任何网页都能把她关掉」那条路被堵死了。 */
const CONTROL_TOKEN = crypto.randomBytes(24).toString("hex");

/** 数据目录是怎么定下来的（命令行/体检里显示用；规则见 paths.mjs 的 dataRootInfo） */
const DATA_NOTE =
	PATHS.dataRootSource === "portable"
		? "(portable mode: data lives inside the program folder)"
		: PATHS.dataRootSource === "file"
			? `(custom: from ${PATHS.dataRootFile})`
			: PATHS.dataRootSource === "env"
				? "(custom: from the DSH_PET_DATA_DIR environment variable)"
				: "";

/* 「完全独立」的注释保留在这里备查：以前默认把数据根锁在这份副本里（DSH_HOME=本副本）。
 * 发布版改成走 paths.mjs：DSH_HOME = %APPDATA%\<APP_NAME>，见上面那一行 applyEnv。
 * 想临时切回「数据就在程序目录」：把 DSH_HOME 显式设成这份副本即可（下面那行只在外部没设时才补）。 */
if (!process.env.DSH_HOME && existsSync(join(REPO_ROOT, "dsh-pet"))) process.env.DSH_HOME = REPO_ROOT;

/* ── 运行期 alias：三个 DSH 包指向本目录的替身 ───────────────────────────── */
const ALIASES = new Map([
	["@deepseek-ai/dsh-home-paths", join(SHIM_DIR, "dsh-home-paths.mjs")],
	["@deepseek-ai/dsh-credentials", join(SHIM_DIR, "dsh-credentials.mjs")],
	["@deepseek-ai/dsh-llm", join(SHIM_DIR, "dsh-llm.mjs")],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		const exact = ALIASES.get(specifier);
		if (exact) return { url: pathToFileURL(exact).href, shortCircuit: true };
		for (const [name, file] of ALIASES) {
			if (specifier.startsWith(name + "/")) return { url: pathToFileURL(file).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

/* ── 命令行 ──────────────────────────────────────────────────────────────── */
const USAGE = `"${DISPLAY_NAME}" standalone mode (no DSH required)\n\nUsage:\n  node main.mjs [--port N] [--app <package dir>] [--check] [--selftest]\n\nFor everyday use you don't type commands: open the "${DISPLAY_NAME}" console to start and stop (double-click the desktop shortcut),\nor double-click start-pet.vbs to start and stop-pet.vbs to stop.\nDouble-clicking again while running won't start a second pet — two pets sharing one Chromium userData would trample each other.\n\nOptions:\n  --port N        host route service port (default ${DEFAULT_STANDALONE_PORT}; if busy it advances automatically, up to 25 tries)\n  --app <dir>     plugin package root (default ../app)\n  --check         run the health check and exit: is the package complete, is the default config present, can Electron be found, where is the data folder\n  --selftest      only test the "model half": is local Ollama present, and can the plugin's three contracts\n                  (agentDefaultModel / attachments / llm.stream) really speak.\n                  Does not listen on a port or start the pet; purely read-only.\n  -h, --help      show this help\n\nWhile running it writes a runtime.json (pid / port / model / start time), removed on exit.\n\nEnvironment variables:\n  DSH_HOME                 user data folder (default %APPDATA%\\${APP_NAME}) —\n                           persona/memory/screen state in <DSH_HOME>\\dsh-pet, Electron in <DSH_HOME>\\electron\n  DSH_PET_ELECTRON_PATH    set the Electron executable (after install it uses the bundled electron\\electron.exe by default)\n  DSH_PET_STANDALONE_DEBUG=1   make logger.debug speak\n\nOn first run it seeds the default persona and auto-detects the GPU/VRAM and Ollama models in the console,\npicking a suitable "chat model" and "screen-watching (vision) model".\n\nWhere user data lives (customisable, four levels, high to low priority):\n  1) DSH_PET_DATA_DIR environment variable\n  2) data-root.txt in the program folder (one line: a path, absolute or relative to the program folder)\n  3) portable.txt in the program folder  → data goes to "program folder\\userdata" (portable mode)\n  4) default %APPDATA%\\BlueHairMaid\\\n\nAvailable in standalone mode: animations, physics dragging, right-click menu, multiple pets, custom assets and\n                pet kinds, screen watching, voice input, TTS, singing, AI director, global brain and chatter\n                (models go through local Ollama or the online model)\nNot available in standalone mode (fails clearly rather than pretending): balance lookup (needs DSH's credential\nstore), DSH session work status, system notifications\n`;

function parseArgs(argv) {
	const out = { port: DEFAULT_STANDALONE_PORT, app: DEFAULT_APP_DIR, check: false, selftest: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			out.help = true;
			continue;
		}
		if (arg === "--check") {
			out.check = true;
			continue;
		}
		if (arg === "--selftest") {
			out.selftest = true;
			continue;
		}
		if (arg === "--port" || arg.startsWith("--port=")) {
			const raw = arg === "--port" ? argv[++i] : arg.slice("--port=".length);
			const n = Number.parseInt(String(raw ?? ""), 10);
			if (!Number.isFinite(n) || n < 1 || n > 65535) return { error: `--port needs an integer from 1 to 65535, got: ${String(raw)}` };
			out.port = n;
			continue;
		}
		if (arg === "--app" || arg.startsWith("--app=")) {
			const raw = arg === "--app" ? argv[++i] : arg.slice("--app=".length);
			if (!raw) return { error: "--app needs a directory" };
			out.app = resolve(String(raw));
			continue;
		}
		return { error: `Unknown argument: ${arg}` };
	}
	return out;
}

/* ── 小工具 ──────────────────────────────────────────────────────────────── */
function stripJsonc(text) {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			}
			continue;
		}
		if (inBlock) {
			if (c === "*" && n === "/") {
				inBlock = false;
				i++;
			}
			continue;
		}
		if (inString) {
			out += c;
			if (c === "\\") {
				out += n ?? "";
				i++;
			} else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === "/" && n === "/") {
			inLine = true;
			i++;
			continue;
		}
		if (c === "/" && n === "*") {
			inBlock = true;
			i++;
			continue;
		}
		out += c;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

function readPets(configFile) {
	try {
		const cfg = JSON.parse(stripJsonc(readFileSync(configFile, "utf8")));
		const list = Array.isArray(cfg?.pets) ? cfg.pets : [];
		return list.map((p) => ({ id: p?.id ?? "?", name: p?.name ?? "", display: p?.display ?? "" }));
	} catch {
		return [];
	}
}

function dshHome() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.DSH_HOME || join(userProfile, ".dsh");
}

/* ── 单实例守卫 ──────────────────────────────────────────────────────────────
 * 两只一起跑是**真的会坏**：桌面 helper 的 Electron userData 是
 * %APPDATA%\dsh-pet-electron-helper（由 runtime/electron-helper/package.json 的
 * name 决定），两个 Electron 抢同一个 Chromium profile 会互相踩；数据根
 * （人设 / 记忆 / screen-watch）也是同一个。所以这里宁可什么都不做。
 */
function readRuntime() {
	try {
		const raw = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
		return raw && typeof raw === "object" ? raw : null;
	} catch {
		return null;
	}
}

function pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

async function probeHealth(port, timeoutMs = 1500) {
	if (!Number.isInteger(port) || port <= 0) return null;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const body = await res.json();
		return body && body.mode === "standalone" ? body : null;
	} catch {
		return null;
	}
}

function writeRuntime(patch) {
	try {
		writeFileSync(RUNTIME_FILE, JSON.stringify({ ...patch, updatedAt: new Date().toISOString() }, null, 2), "utf8");
	} catch {
		/* 写不进去不影响运行 */
	}
}

function clearRuntime() {
	try {
		const cur = readRuntime();
		if (!cur || cur.pid === process.pid) unlinkSync(RUNTIME_FILE);
	} catch {
		/* ignore */
	}
}

function findElectron() {
	const candidates = [];
	if (process.env.DSH_PET_ELECTRON_PATH) candidates.push(process.env.DSH_PET_ELECTRON_PATH);
	candidates.push(join(dshHome(), "electron", "electron.exe"));
	candidates.push(join(REPO_ROOT, "electron", "electron.exe"));
	return candidates.find((p) => existsSync(p));
}

/* ── 体检 ────────────────────────────────────────────────────────────────── */
function inspect(appDir) {
	const checks = [];
	const add = (name, ok, detail) => checks.push({ name, ok, detail });

	const pkgFile = join(appDir, "package.json");
	const hostFile = join(appDir, "lib", "index.js");
	const clientFile = join(appDir, "lib", "client.js");
	const configFile = join(appDir, "assets", "config.jsonc");
	const helperFile = join(appDir, "runtime", "electron-helper", "main.js");
	const helperPkg = join(appDir, "runtime", "electron-helper", "package.json");
	const vendored = join(appDir, "node_modules", "@electron", "get");

	add("Package folder", existsSync(appDir), appDir);
	add("package.json", existsSync(pkgFile), pkgFile);
	add("host side lib/index.js", existsSync(hostFile), hostFile);
	add("browser side lib/client.js", existsSync(clientFile), clientFile);
	add("bundled default config assets/config.jsonc", existsSync(configFile), configFile);
	add("desktop helper main.js", existsSync(helperFile), helperFile);
	add("helper package.json", existsSync(helperPkg), helperPkg);
	add("bundled dependency @electron/get", existsSync(vendored), vendored);

	const electron = findElectron();
	add("Electron executable", Boolean(electron), electron ?? "not found (set DSH_PET_ELECTRON_PATH)");

	let version = "?";
	try {
		version = JSON.parse(readFileSync(pkgFile, "utf8")).version ?? "?";
	} catch {
		/* ignore */
	}

	/* 三个 DSH 包必须能被替身接住 —— 直接验证钩子生效 */
	const shimsOk = [...ALIASES.values()].every((p) => existsSync(p));
	add("three DSH package shims", shimsOk, [...ALIASES.values()].join(" | "));

	const home = dshHome();
	add("data root DSH_HOME", true, home);

	return { checks, version, electron, configFile, home };
}

function printInspection(info) {
	console.log("");
	console.log("  Check results");
	console.log("  " + "-".repeat(66));
	for (const c of info.checks) {
		console.log(`  ${c.ok ? "[ OK ]" : "[FAIL]"}  ${c.name.padEnd(26)} ${c.detail}`);
	}
	console.log("  " + "-".repeat(66));
	const bad = info.checks.filter((c) => !c.ok);
	console.log(bad.length === 0 ? "  All passed." : `  ${bad.length} failed; standalone mode may not start.`);
	console.log("");
}

/* ── 模型自检：走插件真正会走的那三个契约（只读，不监听端口、不拉桌宠） ──── */
async function selfTest() {
	const logger = createStandaloneLogger("dsh-pet-standalone/selftest");
	const context = createStandaloneContext({ port: 0, logger });
	const ctx = context.ctx;

	const rows = [];
	const say = (ok, name, detail) => rows.push({ ok, name, detail });

	const api = ollamaApi();
	const probe = await listOllamaModels();
	say(
		probe.ok,
		"Local Ollama",
		probe.ok
			? `${api} (${probe.models.length} models: ${probe.models.slice(0, 4).join(", ")}${probe.models.length > 4 ? " …" : ""})`
			: `${api} —— ${probe.reason}`,
	);

	const sel = ctx.agentDefaultModel.currentSelection();
	say(
		Boolean(sel?.provider && sel?.model),
		"agentDefaultModel.currentSelection()",
		sel?.model
			? `${sel.provider} / ${sel.model} (from quipModel‖localModel in screen-watch/state.json)`
			: "No local model configured (quipModel / localModel are both empty in state.json)",
	);

	const att = ctx.get("attachments");
	say(Boolean(att && typeof att.saveImages === "function"), 'ctx.get("attachments").saveImages', att ? "present (screen watching can attach screenshots to messages)" : "Missing");

	/* 文本出话：调用形状与 app/lib/index.js:207-224 完全一致 */
	const model = sel?.model || currentModel();
	const provider = sel?.provider || LOCAL_PROVIDER;
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of ctx.llm.stream({
			provider,
			model,
			messages: [createUserMessage({ content: [{ type: "text", text: "Say hello to me in one line, under 20 words." }], source: { kind: "user" } })],
			system: "You are a desktop pet; keep replies short, no explanations.",
			temperature: 1,
			signal: AbortSignal.timeout(120000),
		})) {
			assembler.push(chunk);
		}
		const text = assembler.blocks().map((b) => (b.type === "text" ? b.text : "")).join("").trim();
		say(Boolean(text), "llm.stream text output", text ? `"${text}"` : "The model returned no text");
	} catch (error) {
		say(false, "llm.stream text output", error instanceof Error ? error.message : String(error));
	}

	/* 图片出话：屏幕监测那条路（attachments → {type:"image"} → Ollama images） */
	const shot = join(dshHome(), "dsh-pet", "screen-watch", "shot.jpg");
	if (existsSync(shot) && att) {
		const pixels = new Uint8Array(readFileSync(shot));
		try {
			const refs = await att.saveImages([{ data: pixels, mediaType: "image/jpeg", name: "screen.jpg" }]);
			const vision = new BlockAssembler();
			for await (const chunk of ctx.llm.stream({
				provider,
				model,
				messages: [
					createUserMessage({
						content: [
							{ type: "image", attachment: refs[0] },
							{ type: "text", text: "What is mainly in this screenshot? One line, under 25 words." },
						],
						source: { kind: "user" },
					}),
				],
				system: "You are a desktop pet; keep screen comments short.",
				temperature: 1,
				signal: AbortSignal.timeout(180000),
			})) {
				vision.push(chunk);
			}
			const text = vision.blocks().map((b) => (b.type === "text" ? b.text : "")).join("").trim();
			say(Boolean(text), "llm.stream image output", text ? `"${text}" (screenshot ${pixels.byteLength} B)` : "The model returned no text");
		} catch (error) {
			say(false, "llm.stream image output", error instanceof Error ? error.message : String(error));
		}
	} else {
		say(true, "llm.stream image output", `Skipped: ${shot} not found`);
	}

	console.log("");
	console.log("  \"Blue-Haired Little Maid\" standalone · model self-check");
	console.log("  " + "-".repeat(72));
	for (const row of rows) console.log(`  ${row.ok ? "[ OK ]" : "[FAIL]"}  ${row.name.padEnd(36)} ${row.detail}`);
	console.log("  " + "-".repeat(72));
	const bad = rows.filter((r) => !r.ok);
	console.log(bad.length === 0 ? "  Model path is healthy: screen watching / chatter / chat / AI director can all speak in standalone mode." : `  ${bad.length} failed.`);
	console.log("");
	return bad.length;
}

/* ── 主流程 ──────────────────────────────────────────────────────────────── */
async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.error) {
		console.error("[dsh-pet-standalone] " + options.error);
		console.error("");
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		console.log(USAGE);
		return;
	}

	const appDir = options.app;
	const logger = createStandaloneLogger();
	/* 首次运行：把 defaults\dsh-pet\ 里的默认人设/配置铺进用户数据目录（只补缺的，绝不覆盖已有） */
	if (!options.check && !options.selftest) {
		const seeded = seedUserData(PATHS);
		if (seeded > 0) console.log(`[dsh-pet-standalone] first run: seeded ${seeded} default data files → ${PATHS.dataRoot}`);
	}
	const info = inspect(appDir);

	if (options.check) {
		console.log(`"${DISPLAY_NAME}" standalone · check`);
		console.log(`  Package folder: ${appDir}`);
		console.log(`  Data folder: ${PATHS.dataRoot}${DATA_NOTE}`);
		console.log(`  Runtime folder: ${PATHS.userRoot}`);
		printInspection(info);
		if (info.checks.some((c) => !c.ok)) process.exitCode = 1;
		return;
	}

	if (options.selftest) {
		process.exitCode = await selfTest();
		return;
	}

	/* 单实例守卫：已经在跑就什么都不做（双击两次不该变成两只） */
	const running = readRuntime();
	if (running && pidAlive(running.pid)) {
		const health = await probeHealth(running.port);
		if (health) {
			console.log(`[dsh-pet-standalone] already running; not starting again.`);
			console.log(`  pid ${running.pid} · port ${running.port} · started at ${running.startedAt ?? "?"} · model ${running.provider ?? "?"} / ${running.model ?? "?"}`);
			console.log(`  To restart: run stop-pet.vbs / stop-pet.mjs first, wait for it to fully exit, then start-pet.vbs.`);
			return;
		}
		logger.warn(`runtime.json records pid ${running.pid}; the process is alive but /health doesn't answer (${running.port}) — treating it as not fully exited and continuing to start.`);
	}

	/* 上游 cli.ts 同款预检：包内默认配置缺失就直接退出，别跑到一半才炸 */
	const defaultConfig = join(appDir, "assets", "config.jsonc");
	if (!existsSync(defaultConfig)) {
		console.error(`[dsh-pet-standalone] bundled default config missing: ${defaultConfig}`);
		console.error("  This copy is incomplete; run verify.mjs, or restore from snapshot/.");
		process.exitCode = 1;
		return;
	}
	const hostEntry = join(appDir, "lib", "index.js");
	if (!existsSync(hostEntry)) {
		console.error(`[dsh-pet-standalone] host entry not found: ${hostEntry}`);
		process.exitCode = 1;
		return;
	}

	/* 顺序很重要：先监听、后 apply —— 插件在 apply 里会读 ctx.webServer.port */
	const modelProbe = await listOllamaModels();
	const model = currentModel();
	const provider = currentProvider();
	const routes = [];
	const portRef = { value: options.port };
	const context = createStandaloneContext({ port: () => portRef.value, logger, routes });

	let shuttingDown = false;
	const shutdown = async (reason) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`\n[dsh-pet-standalone] shutting down (${reason})…`);
		try {
			context.dispose();
		} catch (error) {
			logger.error("dispose failed:" + (error instanceof Error ? error.message : String(error)));
		}
		try {
			await server.close();
		} catch {
			/* ignore */
		}
		clearRuntime();
		process.exit(0);
	};

	const server = await listenStandaloneServer({
		routes,
		logger,
		port: options.port,
		status: () => ({
			ok: true,
			mode: "standalone",
			provider: STANDALONE_PROVIDER,
			port: server.port,
			routes: routes.map((r) => `${r.kind} ${r.path}`),
			effects: context.effectCount,
			failures: context.failures,
			pid: process.pid,
			model: { provider, model, ollama: modelProbe.ok, ollamaApi: ollamaApi(), models: modelProbe.models },
		}),
		onShutdown: () => void shutdown("http /shutdown"),
		token: CONTROL_TOKEN,
	});
	portRef.value = server.port;
	writeRuntime({
		pid: process.pid,
		port: server.port,
		host: "127.0.0.1",
		token: CONTROL_TOKEN,
		app: appDir,
		version: info.version,
		provider,
		model,
		startedAt: new Date().toISOString(),
	});

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("uncaughtException", (error) => {
		logger.error("uncaughtException:" + (error?.stack ?? String(error)));
	});
	process.on("unhandledRejection", (reason) => {
		logger.error("unhandledRejection:" + (reason instanceof Error ? reason.stack : String(reason)));
	});

	/* 现在才加载插件：此时钩子已装好、端口已就绪 */
	const mod = await import(pathToFileURL(hostEntry).href);
	const apply = mod?.apply ?? mod?.default?.apply;
	if (typeof apply !== "function") {
		await server.close();
		throw new Error(`host side did not export apply(): ${hostEntry}`);
	}

	apply(context.ctx);

	const pets = readPets(defaultConfig).filter((p) => p.display === "desktop" || p.display === "both");
	const base = `http://127.0.0.1:${server.port}`;

	console.log("");
	console.log("  ╭──────────────────────────────────────────────────────────────╮");
	console.log("  │  Blue-Haired Little Maid · standalone                                        │");
	console.log("  ╰──────────────────────────────────────────────────────────────╯");
	console.log(`  Package version ${info.version}   (${appDir})`);
	console.log(`  Route service   ${base}   (${routes.length} routes)`);
	for (const r of routes) console.log(`                  ${r.kind.padEnd(7)} ${r.path}`);
	console.log(`  Health check    ${base}/health`);
	console.log(`  Data root       ${PATHS.dataRoot}${DATA_NOTE}`);
	if (DEVICE_PROFILE?.picks) {
		const gb = DEVICE_PROFILE.vramMB ? `${(DEVICE_PROFILE.vramMB / 1024).toFixed(1)} GB VRAM` : "VRAM not readable";
		console.log(`  Auto-fit        ${gb} → chat ${DEVICE_PROFILE.picks.chat || "?"} / watch ${DEVICE_PROFILE.picks.vision || "?"}`);
	}
	console.log(`  Desktop pets    ${pets.map((p) => `${p.id}${p.name ? `(${p.name})` : ""}`).join(", ") || "(default: entries with display=desktop/both in config.jsonc)"}`);
	console.log(`  Electron        ${info.electron ?? "not found"}`);
	console.log(
		`  Local model     ${model ? `${provider} / ${model}` : "not configured (quipModel / localModel in state.json are empty)"}` +
			`   ${modelProbe.ok ? `Ollama online (${modelProbe.models.length} models)` : `Ollama not responding: ${modelProbe.reason}`}`,
	);
	console.log(`  created ${context.effectCount} effect(s)`);
	if (context.failures.length > 0) {
		console.log("  note: the following initialisation steps failed (continued via the plugin's fallback paths)");
		for (const f of context.failures) console.log(`    · ${f}`);
	}
	console.log("");
	console.log("  Not available in standalone mode (needs DSH credentials / session; reports clearly rather than pretending):");
	console.log("    · balance lookup      · DSH session work status      · system notifications");
	console.log("  Everything else works: animations, dragging, right-click menu, multiple pets, screen watching, voice input, TTS, singing, AI director, chatter, chat;");
	console.log("  The speech-capable ones use local Ollama (offline, no quota).");
	console.log("");
	console.log("  Exit: close this window, or Ctrl+C, or double-click stop-pet.vbs (node standalone\\stop-pet.mjs in a terminal)");
	console.log("");
}

const isMain = import.meta.main === true || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
	main().catch((error) => {
		console.error("[dsh-pet-standalone] startup failed: " + (error?.stack ?? String(error)));
		process.exitCode = 1;
	});
}
