#!/usr/bin/env node
/* 「蓝毛小女仆」独立模式 —— 停止器
 *
 * 优先走 http://127.0.0.1:<port>/shutdown（main.mjs 会 context.dispose() →
 * 顺带停掉 Electron helper → 关服务 → 删 runtime.json）；
 * 连不上就按 runtime.json 里的 pid 兜底 kill。
 *
 * 也可以在命令行手动跑：node stop-pet.mjs
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "./paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATHS = resolvePaths(HERE);
const RUNTIME_FILE = join(PATHS.userRoot, "runtime.json");
const LOG_FILE = join(PATHS.userRoot, "logs", "pet-control.log");
try {
	mkdirSync(dirname(LOG_FILE), { recursive: true });
} catch {
	/* ignore */
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(message) {
	const line = `[${new Date().toISOString()}] ${message}`;
	console.log(line);
	try {
		appendFileSync(LOG_FILE, line + "\n", "utf8");
	} catch {
		/* ignore */
	}
}

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

const rt = readRuntime();
if (!rt) {
	say("No runtime.json — the pet doesn't seem to be running (or was already stopped).");
	process.exit(0);
}

const { pid, port, token } = rt;
let graceful = false;

if (Number.isInteger(port) && port > 0) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
			method: "POST",
			/* /shutdown 从 1.1.0 起要口令（来源门禁 + token，见 server.mjs）。
			   口令就在 runtime.json 里，网页读不到。老版本没有 token 字段就照旧不带。 */
			headers: typeof token === "string" && token ? { authorization: `Bearer ${token}`, "x-pet-token": token } : undefined,
			signal: AbortSignal.timeout(8000),
		});
		graceful = res.ok;
		say(`POST http://127.0.0.1:${port}/shutdown → ${res.status}${res.ok ? " (shutdown requested)" : ""}`);
	} catch (error) {
		say(`/shutdown didn't answer (${error instanceof Error ? error.message : String(error)}); falling back to pid.`);
	}
}

/* 等它自己退干净：helper 退出 + 服务关闭一般 1~5 秒 */
for (let i = 0; i < 30 && pidAlive(pid); i++) await sleep(500);

if (pidAlive(pid)) {
	say(`pid ${pid} is still alive; killing it.`);
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		say(`SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	await sleep(1500);
	if (pidAlive(pid)) {
		try {
			process.kill(pid, "SIGKILL");
			await sleep(500);
		} catch {
			/* ignore */
		}
	}
}

const alive = pidAlive(pid);
say(alive ? `Didn't stop (pid ${pid} still there). Check run.err.log.` : `Stopped (pid ${pid}${graceful ? ", graceful" : ""}).`);
if (!alive && existsSync(RUNTIME_FILE)) {
	try {
		unlinkSync(RUNTIME_FILE);
		say("runtime.json cleaned up.");
	} catch {
		/* ignore */
	}
}
process.exit(alive ? 1 : 0);
