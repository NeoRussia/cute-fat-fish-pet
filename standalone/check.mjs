#!/usr/bin/env node
// 「蓝毛小女仆」独立版自检 —— 确认这只桌宠真的不依赖宿主环境。
//
//   ..\node\bin\node.exe check.mjs
//
// 它只做只读检查：不启动、不停止、不改任何文件。桌宠没在跑时也会检查"零件齐不齐"。
// 退出码 0 = 全部通过；1 = 有不通过项（每项都会说明为什么）。

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const NODE_EXE = join(REPO, "node", "bin", "node.exe");
const ELECTRON_EXE = join(REPO, "electron", "electron.exe");
const APP_DIR = join(REPO, "app");
const DATA_DIR = join(REPO, "dsh-pet");
const RUNTIME_FILE = join(HERE, "runtime.json");

let failed = 0;
const ok = (what, extra = "") => console.log(`  [ OK ] ${what}${extra ? "  " + extra : ""}`);
const bad = (what, why) => {
	failed++;
	console.log(`  [FAIL] ${what}`);
	if (why) console.log(`         ${why}`);
};
const info = (s) => console.log(`         ${s}`);

const under = (p) => typeof p === "string" && resolve(p).toLowerCase().startsWith(REPO.toLowerCase() + sep);

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === "EPERM"; // 存在但不属于我们，也算活着
	}
}

async function getJson(url, timeoutMs = 4000) {
	const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	const text = await res.text();
	return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

console.log("Blue-Haired Little Maid · standalone self-check");
console.log("Copy root:" + REPO);
console.log("");

// ---- 1. 零件齐不齐（和桌宠跑不跑无关）---------------------------------------
console.log("1) Bundled parts");
for (const [label, p, dir] of [["Node", NODE_EXE, false], ["Electron", ELECTRON_EXE, false], ["pet engine app\\", APP_DIR, true], ["data root dsh-pet\\", DATA_DIR, true]]) {
	if (!existsSync(p)) { bad(label, "Not found:" + p); continue; }
	const st = statSync(p);
	if (dir && !st.isDirectory()) { bad(label, "Not a directory:" + p); continue; }
	ok(label, dir ? `${p}  (${st.mtime.toISOString().slice(0, 10)})` : `${p}  ${(st.size / 1048576).toFixed(1)} MB`);
}
for (const rel of ["lib/index.js", "runtime/electron-helper/main.js", "runtime/electron-helper/sprite.js", join("assets", "config.jsonc")]) {
	const p = join(APP_DIR, rel);
	existsSync(p) ? ok("app\\" + rel.replace(/\\/g, "/"), `${statSync(p).size} B`) : bad("app\\" + rel, "Missing");
}

// ---- 2. 正在跑吗 ----------------------------------------------------------
console.log("");
console.log("2) Run state");
if (!existsSync(RUNTIME_FILE)) {
	ok("runtime.json", "Not running right now — double-click \"Blue-Haired Little Maid (standalone)\" on the desktop to start");
	console.log("");
	console.log(failed ? `Result: ${failed} part check(s) failed.` : "Result: all parts present, not running.");
	process.exit(failed ? 1 : 0);
}
let rt = null;
try { rt = JSON.parse(readFileSync(RUNTIME_FILE, "utf8")); } catch (e) { bad("runtime.json", "Parse failed:" + e.message); }
if (rt) {
	ok("runtime.json", `pid=${rt.pid} port=${rt.port} started at ${rt.startedAt}`);
	pidAlive(Number(rt.pid)) ? ok("Process", `pid ${rt.pid} is alive`) : bad("Process", `The pid ${rt.pid} in runtime.json is gone (a leftover lock; the next double-click clears it)`);
	under(rt.app) ? ok("Recorded engine path is inside the program folder", rt.app) : bad("Recorded engine path", `is outside the program folder: ${rt.app}`);

	// ---- 3. HTTP 面 ------------------------------------------------------
	console.log("");
	console.log("3) HTTP surface (port " + rt.port + ")");
	try {
		const h = await getJson(`http://127.0.0.1:${rt.port}/health`);
		if (h.status === 200 && h.json?.mode === "standalone" && h.json?.pid === rt.pid) {
			ok("/health", `effects=${h.json.effects} failures=${h.json.failures?.length ?? "?"} model=${h.json.model?.provider}/${h.json.model?.model}`);
		} else {
			bad("/health", `HTTP ${h.status}, content mismatch: ${h.text.slice(0, 200)}`);
		}
		const m = await getJson(`http://127.0.0.1:${rt.port}${h.json?.routes?.[0]?.replace(/^prefix /, "") ?? "/dsh-pet-7340"}/config/meta`);
		if (m.status === 200 && m.json) {
			const user = m.json.user, animations = m.json.animations, pkg = m.json.storage?.find((s) => s.key === "package")?.path;
			under(user) ? ok("Persona file is inside the program folder", user) : bad("Persona file", `is outside the program folder: ${user}`);
			under(animations) ? ok("Animation config is inside the program folder", animations) : bad("Animation config", `is outside the program folder: ${animations}`);
			under(pkg) ? ok("Plugin package is inside the program folder", pkg) : bad("Plugin package", `is outside the program folder: ${pkg}`);
			for (const s of m.json.storage ?? []) {
				if (!under(s.path) && s.key !== "desktopCache" && s.key !== "electronCache") {
					bad("Storage item " + s.key, `is outside the copy: ${s.path}`);
				}
			}
			const outside = (m.json.storage ?? []).filter((s) => !under(s.path));
			if (outside.length) info("Storage items outside the copy (standard Windows caches, normal):" + outside.map((s) => s.key).join(", "));
		} else {
			bad("/config/meta", `HTTP ${m.status}`);
		}
	} catch (e) {
		bad("HTTP request", e.message + "(process alive but the port doesn't respond; see run.err.log)");
	}
}

console.log("");
console.log(failed ? `Result: ${failed} item(s) failed, see the [FAIL] lines above.` : "Result: all checks passed — this pet lives entirely inside the program folder.");
process.exit(failed ? 1 : 0);
