/**
 * 可爱大肥鱼桌宠 · 发布版自校验
 *   node verify.mjs            （在安装目录里跑，比如 %LOCALAPPDATA%\BlueHairMaid）
 * 逐字节核对几棵树的整树指纹，再逐个核对关键文件的大小与 sha256，最后确认那些
 * **不该出现在包里**的开发期/运行期文件真的没有。退出码 0 = 全部一致。
 *
 * 这是独立仓库（源码即成品，没有「上游蓝本 + 补丁」那回事），所以期望值就是
 * 本仓库构建出来的样子；每趟重新打包后，用下面这条命令重算并写入：
 *     node build\check-release.mjs --emit --write      （在仓库里跑）
 * 它同时会证明 stage\ 与 src\ launcher\ standalone\ defaults\ assets\ 逐字节一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// >>>GENERATED 由 build\check-release.mjs --emit --write 生成，别手改这一段
const EXPECT = {
  app: { files: 598, bytes: 74691830, treeSha256: "973be8f1649d15c1f0c3f2de6fb96b1b1d8d5222bd75be034f16af273115d634" },
  launcher: { files: 10, bytes: 406162, treeSha256: "b256d4af8ce58f43f1c8f97bba8f912de309c6a38f99cb6bb1d8d31ec3eaf4a7" },
  standalone: { files: 14, bytes: 108717, treeSha256: "3c1dedfc207206ca23e96a02992297eca7c3c5b658216052d0f48941299b9e0a" },
  defaults: { files: 4, bytes: 14171, treeSha256: "5fbae451c060b9c19ca3f6171a06c756cca4b0c780244a2e23f58abc6f72bde7" },
};

// 我们自己写的那些关键文件：大小 + sha256（不含 verify.mjs 自己 —— 它一改哈希就变）
const OURS = {
  'app/lib/index.js': [132857, 'f8042c8ad3d25c4c32f5f0025dc2d637cf989f000099856c7d9a64c582adf4a6'],
  'app/runtime/electron-helper/main.js': [142850, '94d147ff3a0b25031322ab8b075a7c270f9917204729402237a0b510dfc789b4'],
  'app/runtime/electron-helper/sprite.js': [254837, 'e42c81595c27a15ba482917b788adb14cc31e1407df55e0a48a76f4f79bcd90e'],
  'app/runtime/electron-helper/targets.js': [9403, 'caac7e913a418466ac3e50afbbc9c3c95b5d2ed05dd3e8dfc0b9476d82050636'],
  'app/runtime/electron-helper/shared-core.js': [54397, '9c82f0ca15958008ebb20dde83055e875088b5a7e7c6ad609280b8d5bbd2ca76'],
  'app/runtime/electron-helper/events.js': [18485, 'd61d6e84eb3448210892c4edc8bc2ad8d430372a099d15c5580db965a2be9d0e'],
  'launcher/main.js': [41984, '733fd3ca022b714c895c9cf3bbcda6592fcfc35024ce9e0f127fc615778d388f'],
  'launcher/index.html': [120740, 'c17c7d1a55f4e404be6e61985089f6779a300005f6c5c79a6ed918bba29f5e6f'],
  'launcher/preload.js': [4452, '26633162c436037f4a6c0e3a39712933a823423efbad4b79778b4cee06ec6bc5'],
  'launcher/paths.js': [4216, '2bc08e2d6c24fe09fd2ad578d5081bd60dc9c548e612fa0e9e07f22c60dfda41'],
  'launcher/update.js': [28253, 'ba1b6a08ececcfc00ee8af04318ffa57b78b38a7f305ff7f253b8e7aa193fadf'],
  'launcher/pet-api.js': [17138, 'ad2deac754e6177f45484544051d29885eb6a07e50d422465b0a524282f23c5f'],
  'launcher/rec.js': [23269, '43ea65a1646a87648294c893aa575e1ebce1d64eacdee536ff779eeb579a3716'],
  'launcher/agent.js': [23321, '26cf916b282bdc6a45643687fd37c2e1d7dd71263f2d5f1908f3ff55ade95524'],
  'launcher/pet.ico': [142521, 'b727ea4dcec32409cb6bc4709489276b5daaf90fe180184298e598b35bcfc6c0'],
  'launcher/package.json': [268, '4578d61bd425dc76922d7a330d3d634c5fe269e1c6e67b7fd82f5ad254e42ff9'],
  'standalone/main.mjs': [27197, '912a54d9861e1406e44ada6f049fe9f72837c90b7557292e4baf2cf1f077cf4c'],
  'standalone/server.mjs': [8935, '31a59c6ae4fc8511c8972572bc613353bec27d8cde56e5d34f83d9cdf400b3ec'],
  'standalone/context.mjs': [12394, '720b7a2fdcb283a50f5c445d42c4c3e90456821f7d7a6592cee6132148a5a734'],
  'standalone/detect.mjs': [15912, '39cf425f909ac8ee4581b969879dea72492de1a3ea130ca5aa5c6db93486c52a'],
  'standalone/paths.mjs': [5921, '7a2fc4e59a1dad87d7b466fcbc84e5a9efc022806f791b3f290869f2d0fd0f5f'],
  'standalone/online.mjs': [14572, '606c6be06627386f2ec29f1d9eeed8dacd8ff89cf35930aeee1278a29b5ed928'],
  'standalone/ollama.mjs': [8991, 'fa9ed8665660e70b215de6102324c848995a551f25b75afc871af0e2e7666bb9'],
  'standalone/check.mjs': [5917, 'ab6d6614211720923910a8c91ddd8ed208c92c1e222ac4fbce0eaefab7006e6b'],
  'standalone/stop-pet.mjs': [3389, '70e59245c87f223757566e4cca71999076e4cfad55411a6a63d04784cd4c5309'],
  'standalone/start-pet.vbs': [1252, '6567c05d4648696b3e0c7c59aabbabaacaf58612816dc1a96197952dfb90844a'],
  'standalone/stop-pet.vbs': [1194, '633b7c027793a4fef0cf1c148ec90708df51ae3b2c1b9fab50a85c8017096a75'],
};
// <<<GENERATED

// 开发期草稿 / 运行期数据：这些一旦出现在安装目录里就是事故（要么把作者私人路径带出去了，
// 要么把上一台机器的密钥、日志、记忆一起打包了）。
const MUST_NOT_EXIST = [
  'patched', // 老发布仓那棵草稿堆（早就不该有了）
  'launcher/cli-result.json', // 控制台跑完一次留下的私人记录（含本机 ollama.exe 绝对路径）
  'standalone/online.json', // 联网模型的 API Key
  'standalone/runtime.json', // 上一只桌宠的 pid/端口
  'standalone/pet-control.json',
  'dsh-pet', // 数据根（人设/记忆/聊天记录）绝不能跟着程序走
  'userdata',
  'launcher/userdata',
];

/** 整树指纹。算法与 build\filters.mjs 的 treeFingerprint 一致：路径 + \0 + 内容 sha + \n */
function fingerprint(dir) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  })(dir);
  files.sort();
  const h = crypto.createHash('sha256');
  let total = 0;
  for (const f of files) {
    const b = fs.readFileSync(f);
    total += b.length;
    h.update(path.relative(dir, f).split(path.sep).join('/') + '\0' + crypto.createHash('sha256').update(b).digest('hex') + '\n');
  }
  return { files: files.length, bytes: total, treeSha256: h.digest('hex') };
}

let bad = 0;
console.log('可爱大肥鱼桌宠 · 发布版自校验  ' + new Date().toISOString());
console.log('安装目录：' + ROOT);
console.log('（源码：https://github.com/12we21/cute-fat-fish-pet —— MIT，作者 Mikolu）');

for (const [name, exp] of Object.entries(EXPECT)) {
  const dir = path.join(ROOT, name);
  if (!fs.existsSync(dir)) {
    console.log(`\n[${name}] 目录不存在（安装目录里少了 ${name}\\）`);
    bad++;
    continue;
  }
  const got = fingerprint(dir);
  const ok = got.files === exp.files && got.bytes === exp.bytes && got.treeSha256 === exp.treeSha256;
  if (!ok) bad++;
  console.log(`\n[${name}] ${ok ? 'OK' : 'DRIFT'}`);
  console.log(`  files ${got.files} (期望 ${exp.files})   bytes ${got.bytes} (期望 ${exp.bytes})`);
  console.log(`  tree-sha256 ${got.treeSha256}`);
  if (!ok) console.log(`  期望        ${exp.treeSha256}`);
}

console.log('\n[关键文件]');
for (const [rel, [expSize, expHash]] of Object.entries(OURS)) {
  const f = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(f)) { console.log(`  MISSING ${rel}`); bad++; continue; }
  const st = fs.statSync(f);
  const gotHash = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const okSize = st.size === expSize;
  const okHash = gotHash === expHash;
  if (!okSize || !okHash) bad++;
  console.log(
    `  ${okSize && okHash ? 'OK   ' : 'DRIFT'} ${rel}  ${st.size} (期望 ${expSize})` +
      (okHash ? '  sha256 对' : `  sha256 ${gotHash} 期望 ${expHash}`),
  );
}

console.log('\n[不该出现在包里的东西]');
for (const rel of MUST_NOT_EXIST) {
  const f = path.join(ROOT, rel.split('/').join(path.sep));
  const there = fs.existsSync(f);
  if (there) bad++;
  console.log(`  ${there ? 'DRIFT' : 'OK   '} ${rel}${there ? '  ← 居然在！' : '  不在'}`);
}

console.log(
  '\n结果：' +
    (bad === 0
      ? `全部一致 —— ${Object.keys(EXPECT).length} 棵树的整树指纹 + ${Object.keys(OURS).length} 个关键文件都对得上，开发期/私人文件一个都没混进来`
      : `${bad} 处漂移 —— 这份副本已被改动过`),
);
process.exit(bad === 0 ? 0 : 1);
