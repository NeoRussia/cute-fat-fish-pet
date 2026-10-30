"use strict";
/**
 * 一键更新（1.2.0）—— 控制台自己问、自己下、自己装，主人只需要点一下。
 *
 * 为什么是这样做的：
 *   · 问：GET api.github.com/repos/<repo>/releases/latest（不带 token，匿名 60 次/小时，
 *     一次「检查更新」只花 1 次，够用）。拿回来的每个资产都带 digest: sha256:...，
 *     这个哈希就是后面校验安装包用的那个 —— 别去信 .sha256 附件（同一个源，多一次请求而已）。
 *   · 下：流式写进 <数据根>\updates\<版本>-setup.exe，边下边算 SHA-256，
 *     对不上就删掉重来（残缺 / 被中间人改过都拦在这里）。
 *   · 装：控制台不可能自己覆盖自己（electron.exe 正被自己锁着），所以
 *     写一个 apply-update.ps1 交给独立的 PowerShell：
 *       等本进程退出 → 停桌宠 → 安装包静默装回原目录 → 把控制台（和原本在跑的桌宠）拉回来。
 *     为什么要 .ps1 而不是 .cmd：路径里可能有中文，cmd 按系统 ANSI 码页读脚本会读成乱码，
 *     PowerShell 5.1 认 UTF-8 BOM（这里就是带 BOM 写的）。
 *   · 回读：装完的结果写在 updates\last-result.txt，下次控制台一起来就在终端里如实报一句
 *     （成功 / 失败 + 日志在哪），绝不"装完了却没人知道"。
 *
 * 只给自检用的环境变量（正常人用不到）：
 *   DSH_PET_UPDATE_FEED   一份 JSON（文件路径或 http 地址），形状同 GitHub 的 releases/latest
 *   DSH_PET_UPDATE_MIRROR 资产下载前缀（本地自检也可以用它把下载换成本机文件服务）
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const http = require("node:http");
const { spawn } = require("node:child_process");

const REPO_SLUG = "12we21/cute-fat-fish-pet";
const API_LATEST = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO_SLUG}/releases`;
const ALIAS_NAME = "cute-fat-fish-pet-setup.exe";
const UA = "cute-fat-fish-pet-console";
const MAX_JSON = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 版本号
// ---------------------------------------------------------------------------
function versionParts(v) {
	return String(v == null ? "" : v)
		.trim()
		.replace(/^v/i, "")
		.split(/[^\d]+/)
		.filter((s) => s !== "")
		.slice(0, 3)
		.map((s) => Number(s) || 0);
}

/** a>b → 1，a<b → -1，相等 → 0（只比前三位，1.2 与 1.2.0 当同一个） */
function compareVersions(a, b) {
	const pa = versionParts(a), pb = versionParts(b);
	for (let i = 0; i < 3; i++) {
		const x = pa[i] || 0, y = pb[i] || 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}

/** 1.2.0-beta.1 这种预览版不推给主人（除非主人自己就装着预览版） */
function isPrerelease(tag) {
	return /-/.test(String(tag == null ? "" : tag).trim().replace(/^v/i, ""));
}

// ---------------------------------------------------------------------------
// HTTP 小工具（不引依赖：https/http 都自带；测试里会连本机 127.0.0.1）
// ---------------------------------------------------------------------------
function openRequest(url, { timeoutMs = 20000, headers = {}, method = "GET" } = {}) {
	return new Promise((resolve, reject) => {
		let u;
		try {
			u = new URL(url);
		} catch {
			return reject(new Error("bad-url: " + url));
		}
		const mod = u.protocol === "http:" ? http : https;
		const req = mod.request(
			{
				protocol: u.protocol,
				hostname: u.hostname,
				port: u.port || undefined,
				path: u.pathname + u.search,
				method,
				headers: Object.assign({ "User-Agent": UA, Accept: "*/*" }, headers),
			},
			(res) => resolve({ res, req })
		);
		req.on("error", reject);
		req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
		req.end();
	});
}

function netReason(e) {
	const code = (e && e.code) || "";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "offline";
	if (String((e && e.message) || e) === "timeout") return "timeout";
	return "net-error";
}

/** 跟着跳转取 JSON（最多 5 跳），顺便把 GitHub 的限流信息带出来 */
async function getJson(url, { timeoutMs = 20000, redirects = 5 } = {}) {
	const { res } = await openRequest(url, { timeoutMs, headers: { Accept: "application/vnd.github+json" } });
	if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
		res.resume();
		const next = new URL(res.headers.location, url).href;
		return getJson(next, { timeoutMs, redirects: redirects - 1 });
	}
	let body = "";
	res.setEncoding("utf8");
	for await (const chunk of res) {
		body += chunk;
		if (body.length > MAX_JSON) {
			res.destroy();
			throw new Error("feed-too-big");
		}
	}
	if (res.statusCode !== 200) {
		const err = new Error("http-" + res.statusCode);
		err.status = res.statusCode;
		err.rateLeft = res.headers["x-ratelimit-remaining"];
		throw err;
	}
	try {
		return JSON.parse(body);
	} catch {
		throw new Error("bad-feed");
	}
}

// ---------------------------------------------------------------------------
// 安装包从哪来
// ---------------------------------------------------------------------------
/** 数据根里那个 update-mirror.txt（可选）：第一行非空、非 # 的 http 地址 → 资产下载走它 */
function readMirror(userRoot) {
	const fromEnv = String(process.env.DSH_PET_UPDATE_MIRROR || "").trim();
	if (/^https?:\/\//i.test(fromEnv)) return fromEnv.replace(/\/+$/, "");
	try {
		const line = String(fs.readFileSync(path.join(userRoot, "update-mirror.txt"), "utf8"))
			.replace(/^\uFEFF/, "")
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find((s) => s && !s.startsWith("#"));
		if (line && /^https?:\/\//i.test(line)) return line.replace(/\/+$/, "");
	} catch {
		/* 没这个文件就算了 */
	}
	return "";
}

function withMirror(url, mirror) {
	if (!mirror) return url;
	return mirror + "/" + String(url).replace(/^https?:\/\//i, "");
}

/** 从 assets 里挑出安装包：优先「本版号那个名字」，其次永远指向最新版的无版本号别名 */
function pickInstaller(assets, version) {
	const list = Array.isArray(assets) ? assets : [];
	const exact = `cute-fat-fish-pet-${version}-setup.exe`;
	return (
		list.find((a) => a && a.name === exact) ||
		list.find((a) => a && a.name === ALIAS_NAME) ||
		list.find((a) => a && /-setup\.exe$/i.test(a.name || "")) ||
		null
	);
}

/** GitHub 给的 digest: sha256:<64hex> */
function digestOf(asset) {
	const m = /^sha256:([0-9a-f]{64})$/i.exec(String((asset && asset.digest) || "").trim());
	return m ? m[1].toLowerCase() : "";
}

async function loadFeed() {
	const override = String(process.env.DSH_PET_UPDATE_FEED || "").trim();
	if (override) {
		if (/^https?:\/\//i.test(override)) return getJson(override, { timeoutMs: 20000 });
		return JSON.parse(fs.readFileSync(override.replace(/^file:\/\//i, ""), "utf8"));
	}
	return getJson(API_LATEST, { timeoutMs: 20000 });
}

/** 这份是不是"装出来"的（源码目录里没有 electron\electron.exe，也没法自我更新） */
function isInstalled(root) {
	try {
		return fs.existsSync(path.join(root, "electron", "electron.exe")) && fs.existsSync(path.join(root, "launcher", "main.js"));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// 1) 检查更新
// ---------------------------------------------------------------------------
async function check({ current = "", root = "", userRoot = "" } = {}) {
	const installed = isInstalled(root);
	let feed;
	try {
		feed = await loadFeed();
	} catch (e) {
		if (e && e.status) {
			return {
				ok: false,
				reason: e.status === 403 || e.status === 429 ? "rate-limit" : "http-" + e.status,
				message:
					e.status === 403 || e.status === 429
						? "GitHub says we're asking too often — try again in a moment."
						: `GitHub returned ${e.status}; something in between may be at fault — try again in a moment.`,
				page: RELEASES_PAGE,
				installed,
			};
		}
		const msg = String((e && e.message) || e);
		const reason = msg === "bad-feed" || msg === "feed-too-big" ? "bad-feed" : netReason(e);
		return {
			ok: false,
			reason,
			message:
				reason === "bad-feed"
					? "GitHub's release info is unreadable (possibly corrupted in transit) — try again in a moment."
					: reason === "offline"
						? "Can't reach GitHub (no network / blocked / needs a proxy). You can also click \"Open the releases page in a browser\" and download it yourself."
						: reason === "timeout"
							? "GitHub timed out — network too slow or blocked. Try again in a moment."
							: "Update check failed:" + msg,
			page: RELEASES_PAGE,
			installed,
		};
	}

	const tag = String(feed.tag_name || feed.tag || "").trim();
	const latest = tag.replace(/^v/i, "");
	if (!latest) {
		return { ok: false, reason: "bad-feed", message: "GitHub's version number is unreadable:" + JSON.stringify(tag), page: RELEASES_PAGE, installed, current };
	}
	const mirror = readMirror(userRoot);
	const asset = pickInstaller(feed.assets, latest);
	const hasUpdate = compareVersions(latest, current) > 0 && !(isPrerelease(tag) && compareVersions(current, latest) < 0);
	return {
		ok: true,
		installed,
		current,
		latest,
		tag,
		prerelease: isPrerelease(tag),
		hasUpdate,
		publishedAt: feed.published_at || "",
		page: feed.html_url || RELEASES_PAGE,
		notes: String(feed.body || "").slice(0, 4000),
		mirror,
		exe: asset
			? {
					name: asset.name,
					url: withMirror(asset.browser_download_url || asset.url || "", mirror),
					rawUrl: asset.browser_download_url || asset.url || "",
					size: Number(asset.size || 0),
					sha256: digestOf(asset),
				}
			: null,
	};
}

// ---------------------------------------------------------------------------
// 2) 下载（边下边校验）
// ---------------------------------------------------------------------------
function humanMB(bytes) {
	return (Number(bytes || 0) / 1024 / 1024).toFixed(1) + " MB";
}

async function download({ exe, userRoot, updatesDir = "", onProgress = null, timeoutMs = 30000, redirects = 5 } = {}) {
	if (!exe || !exe.url) return { ok: false, reason: "no-asset", message: "No installer attachment found for this version." };
	const dir = updatesDir || path.join(userRoot, "updates");
	const file = path.join(dir, exe.name);
	const expected = String(exe.sha256 || "").toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expected)) {
		return { ok: false, reason: "no-hash", message: "This version ships no SHA-256 for the installer, so it won't auto-install for safety (download it manually from the releases page).", page: RELEASES_PAGE };
	}
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (e) {
		return { ok: false, reason: "no-dir", message: "Couldn't create the update directory:" + String((e && e.message) || e) };
	}
	// 之前下好过、哈希还对得上就不再下一次（347 MB 呢）
	if (fs.existsSync(file)) {
		const got = await sha256File(file);
		if (got === expected) {
			return { ok: true, cached: true, path: file, size: fs.statSync(file).size, sha256: got };
		}
		try {
			fs.unlinkSync(file);
		} catch {
			/* 删不掉就让下面的 .part 覆盖 */
		}
	}

	const part = file + ".part";
	let res = null;
	try {
		res = (await openRequest(exe.url, { timeoutMs, headers: { Accept: "application/octet-stream" } })).res;
	} catch (e) {
		const reason = netReason(e);
		return {
			ok: false,
			reason,
			message: reason === "offline" ? "Download failed: unreachable (no network / blocked / needs a proxy)." : "Download failed:" + String((e && e.message) || e),
			page: RELEASES_PAGE,
		};
	}
	if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
		res.resume();
		const next = new URL(res.headers.location, exe.url).href;
		return download({ ...{ exe: { ...exe, url: next } }, userRoot, updatesDir: dir, onProgress, timeoutMs, redirects: redirects - 1 });
	}
	if (res.statusCode !== 200) {
		res.resume();
		return { ok: false, reason: "http-" + res.statusCode, message: `Download failed: GitHub returned ${res.statusCode}.`, page: RELEASES_PAGE };
	}

	const total = Number(res.headers["content-length"] || exe.size || 0);
	const hash = crypto.createHash("sha256");
	let received = 0;
	let lastTick = 0;
	const started = Date.now();
	const ws = fs.createWriteStream(part);
	const done = new Promise((resolve) => {
		res.on("data", (chunk) => {
			hash.update(chunk);
			received += chunk.length;
			// 落盘（带背压：写不动了就先把网络停一下，免得几百 MB 全堆在内存里）
			if (!ws.write(chunk)) {
				res.pause();
				ws.once("drain", () => res.resume());
			}
			const now = Date.now();
			if (onProgress && (now - lastTick > 400 || received === total)) {
				lastTick = now;
				const secs = Math.max(0.001, (now - started) / 1000);
				onProgress({
					received,
					total,
					percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
					mb: humanMB(received),
					totalMb: total ? humanMB(total) : "",
					speed: (received / 1024 / 1024 / secs).toFixed(1),
				});
			}
		});
		ws.on("error", (e) => resolve({ err: "write-failed:" + String((e && e.message) || e) }));
		res.on("error", (e) => resolve({ err: netReason(e) === "offline" ? "Download interrupted: network dropped." : "Download failed:" + String((e && e.message) || e) }));
		// 对方把连接掐了（短读）时 Node 不一定发 error，只发 aborted / close：
		// 不接住这两个事件的话 download() 会一直挂着不返回。
		res.on("aborted", () => resolve({ err: "Download interrupted: network dropped." }));
		res.on("close", () => {
			if (!res.complete) resolve({ err: "Download interrupted: network dropped." });
		});
		res.on("end", () => ws.end(() => resolve({})));
	});
	const r = await done;
	if (r.err) {
		try {
			ws.destroy();
			fs.unlinkSync(part);
		} catch {
			/* 无所谓 */
		}
		return { ok: false, reason: String(r.err).includes("Network") ? "offline" : "download-error", message: r.err };
	}
	if (total && received !== total) {
		try {
			fs.unlinkSync(part);
		} catch {
			/* 无所谓 */
		}
		return { ok: false, reason: "short-read", message: `Only downloaded ${humanMB(received)} (expected ${humanMB(total)}); the network dropped — click again.` };
	}
	const got = hash.digest("hex");
	if (got !== expected) {
		try {
			fs.unlinkSync(part);
		} catch {
			/* 无所谓 */
		}
		return {
			ok: false,
			reason: "sha-mismatch",
			message: `The downloaded installer fails verification (got ${got.slice(0, 16)}…, expected ${expected.slice(0, 16)}…); it was deleted, not installed.`,
		};
	}
	fs.renameSync(part, file);
	return { ok: true, path: file, size: received, sha256: got, elapsedSec: Math.round((Date.now() - started) / 1000) };
}

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const h = crypto.createHash("sha256");
		const rs = fs.createReadStream(file);
		rs.on("data", (c) => h.update(c));
		rs.on("error", reject);
		rs.on("end", () => resolve(h.digest("hex")));
	});
}

// ---------------------------------------------------------------------------
// 3) 装（写一个独立脚本，等控制台退出后静默装回原目录）
// ---------------------------------------------------------------------------
function psQuote(s) {
	return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'";
}

/**
 * 生成 apply-update.vbs 的正文（故意全用 ASCII：wscript 按系统码页读它）。
 * 为什么要多这一层：powershell.exe 是控制台程序，直接用 {detached:true}（= DETACHED_PROCESS）
 * 起它、又没有控制台时，它会**立刻退出码 0 却什么都不做**（本机实测：日志一个字都没写）。
 * wscript.exe 是 GUI 程序，用 wscript 去起 powershell 才能在后台真正跑起来，
 * 而且能活过控制台自己的退出（sh.Run 的第三个参数 False = 不等它）。
 * 这里的路径不写死：靠 WScript.ScriptFullName 找到自己所在的目录，
 * 所以中文用户名/带空格的目录都不用担心编码和引号。
 */
function buildVbsScript() {
	return [
		"' launcher for apply-update.ps1 (written by the console; the ps1 deletes it when done)",
		"' why this layer exists: powershell.exe is a console program. Started detached with no",
		"' console it exits 0 immediately and does nothing. wscript.exe is a GUI program, so it",
		"' really runs the hidden powershell in the background and survives the console quitting.",
		"Option Explicit",
		"Dim sh, fso, folder, ps1, f",
		'Set fso = CreateObject("Scripting.FileSystemObject")',
		'Set sh = CreateObject("WScript.Shell")',
		"folder = fso.GetParentFolderName(WScript.ScriptFullName)",
		'ps1 = folder & "\\apply-update.ps1"',
		"On Error Resume Next",
		'sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False',
		"If Err.Number <> 0 Then",
		'  Set f = fso.CreateTextFile(folder & "\\apply-vbs-error.txt", True)',
		'  f.WriteLine "Err " & Err.Number & ": " & Err.Description',
		"  f.Close",
		"End If",
		"",
	].join("\r\n");
}

/** 生成 apply-update.ps1 的正文（带 BOM 写盘，PS 5.1 才认得里面的中文路径） */
function buildApplyScript({ from, to, root, installer, logPath, resultPath, consolePid, petWasRunning }) {
	return (
		"# Cute Fat Fish Pet · one-click update (written by the console, deletes itself when done)\n" +
		"$ErrorActionPreference = 'Continue'\n" +
		`$from = ${psQuote(from)}\n` +
		`$to = ${psQuote(to)}\n` +
		`$root = ${psQuote(root)}\n` +
		`$installer = ${psQuote(installer)}\n` +
		`$logPath = ${psQuote(logPath)}\n` +
		`$resultPath = ${psQuote(resultPath)}\n` +
		`$consolePid = ${Number(consolePid) || 0}\n` +
		`$petWasRunning = $${petWasRunning ? "true" : "false"}\n` +
		"\n" +
		"$wscript = Join-Path $env:SystemRoot 'System32\\wscript.exe'\n" +
		"function Say([string]$t) {\n" +
		"  Add-Content -LiteralPath $logPath -Value ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $t) -Encoding UTF8\n" +
		"}\n" +
		"Say ('Starting update: ' + $from + ' -> ' + $to)\n" +
		"Say ('Install directory: ' + $root)\n" +
		"\n" +
		"# electron must not start with ELECTRON_RUN_AS_NODE (it would run as plain node and the window would flash and vanish)\n" +
		"Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue\n" +
		"Remove-Item Env:\\DSH_PET_SMOKE -ErrorAction SilentlyContinue\n" +
		"\n" +
		"# 1) Wait for the console to fully quit (up to 60 seconds)\n" +
		"$n = 0\n" +
		"while ($n -lt 120) {\n" +
		"  if (-not (Get-Process -Id $consolePid -ErrorAction SilentlyContinue)) { break }\n" +
		"  Start-Sleep -Milliseconds 500\n" +
		"  $n++\n" +
		"}\n" +
		"if (Get-Process -Id $consolePid -ErrorAction SilentlyContinue) {\n" +
		"  Say 'The console never quit, nothing was touched (retry later)'\n" +
		"  Set-Content -LiteralPath $resultPath -Encoding UTF8 -Value @(('ok=0'), ('exit=-1'), ('from=' + $from), ('to=' + $to), ('at=' + (Get-Date -Format 's')), ('log=' + $logPath))\n" +
		"  exit 2\n" +
		"}\n" +
		"Say 'The console has quit'\n" +
		"\n" +
		"# 2) The pet also starts from electron.exe in this folder, so while the files are in use nothing can install\n" +
		"if ($petWasRunning) {\n" +
		"  $stop = Join-Path $root 'standalone\\stop-pet.vbs'\n" +
		"  if (Test-Path -LiteralPath $stop) {\n" +
		"    Say 'Stopping the pet first...'\n" +
		"    & $wscript $stop | Out-Null\n" +
		"    Start-Sleep -Seconds 2\n" +
		"  }\n" +
		"}\n" +
		"\n" +
		"# 3) Silent install back into the same folder. NSIS's /D= must be the last argument and unquoted,\n" +
		"#    so paths with spaces use the 8.3 short path; if even that fails, just pass /S\n" +
		"#    (the installer reads Software\\BlueHairMaid\\InstallDir from the registry as its default).\n" +
		"$dest = $root\n" +
		"$withD = $true\n" +
		"if ($root -match '\\s') {\n" +
		"  $withD = $false\n" +
		"  try {\n" +
		"    $short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath\n" +
		"    if ($short -and ($short -notmatch '\\s')) { $dest = $short; $withD = $true }\n" +
		"  } catch { }\n" +
		"}\n" +
		"$installArgs = @('/S')\n" +
		"if ($withD) { $installArgs += ('/D=' + $dest) }\n" +
		"Say ('Starting silent install: ' + $installer + ' ' + ($installArgs -join ' '))\n" +
		"$proc = Start-Process -FilePath $installer -ArgumentList $installArgs -Wait -PassThru\n" +
		"$code = $proc.ExitCode\n" +
		"Say ('Installer exit code: ' + $code)\n" +
		"\n" +
		"# 4) Success: remove the 4 scripts left by the zip path (the uninstall entry already points to Uninstall.exe),\n" +
		"#    then delete the 347 MB installer; on failure keep the installer so it's easy to retry.\n" +
		"if ($code -eq 0) {\n" +
		"  foreach ($legacy in @('install.ps1', 'uninstall.ps1')) {\n" +
		"    $f = Join-Path $root $legacy\n" +
		"    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; Say ('Removed old script: ' + $legacy) }\n" +
		"  }\n" +
		"  foreach ($legacy in @('安装.cmd', '卸载.cmd')) {\n" +
		"    $f = Join-Path $root $legacy\n" +
		"    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; Say ('Removed old script: ' + $legacy) }\n" +
		"  }\n" +
		"  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue\n" +
		"}\n" +
		"\n" +
		"# 5) Result + hand the window back to master (if it failed, reopen the console as before — don't leave a black screen)\n" +
		"$okFlag = if ($code -eq 0) { '1' } else { '0' }\n" +
		"Set-Content -LiteralPath $resultPath -Encoding UTF8 -Value @(('ok=' + $okFlag), ('exit=' + $code), ('from=' + $from), ('to=' + $to), ('at=' + (Get-Date -Format 's')), ('log=' + $logPath))\n" +
		"$exe = Join-Path $root 'electron\\electron.exe'\n" +
		"if ($code -eq 0 -and $petWasRunning) {\n" +
		"  $start = Join-Path $root 'standalone\\start-pet.vbs'\n" +
		"  if (Test-Path -LiteralPath $start) { & $wscript $start | Out-Null; Say 'Pet restarted' }\n" +
		"}\n" +
		"if (Test-Path -LiteralPath $exe) {\n" +
		"  Start-Process -FilePath $exe -ArgumentList ('\"' + $root + '\\launcher\"') -WorkingDirectory $root\n" +
		"  Say 'Console reopened'\n" +
		"} else {\n" +
		"  Say ('Could not find ' + $exe + '; open the console from the desktop shortcut yourself')\n" +
		"}\n" +
		"Say 'Done'\n" +
		"try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue } catch { }\n" +
		"try { Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'apply-update.vbs') -Force -ErrorAction SilentlyContinue } catch { }\n"
	);
}

/** 让安装程序认得出"该装回哪个目录"：zip 那条路只登记了卸载项，没写这个键 */
function writeInstallDirKey(root) {
	return new Promise((resolve) => {
		try {
			const p = spawn("reg.exe", ["add", "HKCU\\Software\\BlueHairMaid", "/v", "InstallDir", "/t", "REG_SZ", "/d", root, "/f"], {
				stdio: "ignore",
				windowsHide: true,
			});
			p.on("error", () => resolve(false));
			p.on("exit", (code) => resolve(code === 0));
		} catch {
			resolve(false);
		}
	});
}

/**
 * 交给独立的 PowerShell 去装：本进程会立刻被要求退出（main.js 负责 quit）。
 * 调用前 main.js 已经把桌宠停掉了（停不掉也别硬来，ps1 里还会再试一次）。
 */
async function apply({ root, userRoot, installerPath, from = "", to = "", pid = 0, relaunchPet = false } = {}) {
	if (!isInstalled(root)) {
		return { ok: false, reason: "not-installed", message: "This is a source checkout (no electron\\electron.exe) — update with git pull yourself." };
	}
	if (!installerPath || !fs.existsSync(installerPath)) {
		return { ok: false, reason: "no-installer", message: "The update package isn't local yet — click \"Download and update\" first." };
	}
	const dir = path.join(userRoot, "updates");
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (e) {
		return { ok: false, reason: "no-dir", message: "Couldn't create the update directory:" + String((e && e.message) || e) };
	}
	const logPath = path.join(dir, `update-${to || "new"}.log`);
	const resultPath = path.join(dir, "last-result.txt");
	const scriptPath = path.join(dir, "apply-update.ps1");
	const vbsPath = path.join(dir, "apply-update.vbs");
	const body = buildApplyScript({
		from,
		to,
		root,
		installer: installerPath,
		logPath,
		resultPath,
		consolePid: pid,
		petWasRunning: !!relaunchPet,
	});
	try {
		fs.writeFileSync(scriptPath, "\uFEFF" + body, "utf8"); // BOM：PS 5.1 读中文路径靠它
		fs.writeFileSync(vbsPath, buildVbsScript(), "ascii"); // 纯 ASCII，wscript 按系统码页读也安全
		fs.writeFileSync(logPath, "", { flag: "a" });
	} catch (e) {
		return { ok: false, reason: "write-failed", message: "Failed to write the update script:" + String((e && e.message) || e) };
	}
	await writeInstallDirKey(root);
	try {
		// 用 wscript 起 powershell：本身就是 GUI 进程，能 detached 起来、也能活过本窗口退出。
		// （直接 detached 起 powershell.exe 的话，没控制台它会立刻退出码 0、什么都不做。）
		const child = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"), ["//nologo", vbsPath], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			cwd: dir,
		});
		child.unref();
	} catch (e) {
		return { ok: false, reason: "spawn-failed", message: "Failed to start the update script:" + String((e && e.message) || e) };
	}
	return {
		ok: true,
		to,
		log: logPath,
		script: scriptPath,
		vbs: vbsPath,
		message: `Closing this window now to install ${to}; it will reopen automatically (log: ${logPath})`,
	};
}

// ---------------------------------------------------------------------------
// 4) 下次启动回读上次的结局
// ---------------------------------------------------------------------------
function readResult({ userRoot, current = "" } = {}) {
	const file = path.join(userRoot, "updates", "last-result.txt");
	if (!fs.existsSync(file)) return null;
	let raw = "";
	try {
		raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
	} catch {
		return null;
	}
	const kv = {};
	for (const line of raw.split(/\r?\n/)) {
		const i = line.indexOf("=");
		if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	let ageMs = 0;
	try {
		ageMs = Date.now() - fs.statSync(file).mtimeMs;
	} catch {
		/* 无所谓 */
	}
	const claimed = kv.ok === "1";
	const landed = !!kv.to && compareVersions(current, kv.to) >= 0;
	try {
		fs.unlinkSync(file);
	} catch {
		/* 无所谓 */
	}
	// 太久以前（比如装完之后主人一直没开控制台，隔了一周）就别再念叨了
	if (ageMs > 7 * 24 * 3600 * 1000) return null;
	return {
		ok: claimed,
		landed,
		from: kv.from || "",
		to: kv.to || "",
		exit: Number(kv.exit || 0),
		at: kv.at || "",
		log: kv.log || "",
		current,
	};
}

module.exports = {
	check,
	download,
	apply,
	readResult,
	isInstalled,
	page: RELEASES_PAGE,
	api: API_LATEST,
	// 只给自检用
	_test: { compareVersions, isPrerelease, pickInstaller, digestOf, withMirror, psQuote, buildApplyScript, buildVbsScript, versionParts },
};
