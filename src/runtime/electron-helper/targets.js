/* dsh-pet local patch: voice-targets@1
 *
 * 把「主人说出来的那个东西」分成三类之一：网址（url）/ 本机文件夹或文件（file）/ 软件名（app）。
 *
 * 为什么值得单独一个文件：
 *   ① 分类是**纯字符串**逻辑，抽到这里就能在 node 里直接跑断言（仓库里配了
 *      _accept/test-voice-targets.cjs），不用为了一句正则去启动 Electron 或哄麦克风说话；
 *   ② 规则只有这一份 —— sprite.js（渲染端）拿它决定「该问哪一项权限、往哪条路送」，
 *      main.js（主进程）只认分类结果，不再各自猜一遍；
 *   ③ 以前「打开A站首页」被当成"要找名叫『A站首页』的软件"（必然 not-found），
 *      「打开下载文件夹」也一样 —— 这两类话在语音里非常常见，值得有张表。
 *
 * 边界（与 pc-actions / pc-ipc 的安全口径一致）：
 *   - 只做**非破坏性**判断：这里不认识的一律回落成 app，由主进程的 ambiguous 红线
 *     （卸载类名字只列候选、绝不 openPath）兜住，绝不猜。
 *   - 站点表只放**确实是网站**的名字：steam / 音乐 / 浏览器 这类既是软件又是话题的词
 *     刻意不写（写了会把"打开蒸汽"从开 Steam 客户端带偏成开网页）。
 *   - 文件夹表里不放「音乐」这种既是文件夹又常指软件的词：只在带「文件夹/目录」后缀时才认
 *     （「打开音乐」仍然开音乐软件，「打开音乐文件夹」才开文件夹）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.DshPetTargets = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* 站点别名 → 网址。键都是「规范化后」的写法（小写、无空格）。 */
  var SITES = {
    acfun: 'https://www.acfun.cn',
    bilibili: 'https://www.bilibili.com',
    zhihu: 'https://www.zhihu.com',
    weibo: 'https://weibo.com',
    baidu: 'https://www.baidu.com',
    tieba: 'https://tieba.baidu.com',
    taobao: 'https://www.taobao.com',
    tmall: 'https://www.tmall.com',
    jd: 'https://www.jd.com',
    pinduoduo: 'https://www.pinduoduo.com',
    douban: 'https://www.douban.com',
    douyin: 'https://www.douyin.com',
    kuaishou: 'https://www.kuaishou.com',
    xiaohongshu: 'https://www.xiaohongshu.com',
    'tencent video': 'https://v.qq.com',
    iqiyi: 'https://www.iqiyi.com',
    youku: 'https://www.youku.com',
    'netease cloud music': 'https://music.163.com',
    'qq music': 'https://y.qq.com',
    wikipedia: 'https://en.wikipedia.org',
    bing: 'https://www.bing.com',
    github: 'https://github.com',
    youtube: 'https://www.youtube.com',
    twitter: 'https://x.com',
    x: 'https://x.com',
    facebook: 'https://www.facebook.com',
  };

  /* 系统文件夹令牌（主进程用 app.getPath 翻成真路径）。这几个名字本身就是文件夹，
   * 说「打开下载」几乎不可能是要开某个叫"下载"的软件。 */
  var FOLDERS = {
    downloads: 'downloads',
    downloadsfolder: 'downloads',
    downloadfolder: 'downloads',
    documents: 'documents',
    mydocuments: 'documents',
    pictures: 'pictures',
    photos: 'pictures',
    photoalbum: 'pictures',
    desktop: 'desktop',
    videos: 'videos',
    movies: 'videos',
    home: 'home',
    homefolder: 'home',
    userfolder: 'home',
    temp: 'temp',
    tempfolder: 'temp',
  };

  /* 带「文件夹/目录」后缀时才认的名字：这些词单独说更可能指软件（"打开音乐"＝开酷狗）。 */
  var FOLDERS_LOOSE = {
    music: 'music',
    songs: 'music',
    movies: 'videos',
    videos: 'videos',
    downloads: 'downloads',
    documents: 'documents',
    pictures: 'pictures',
    desktop: 'desktop',
    home: 'home',
    temp: 'temp',
  };

  /* 「B站首页」「知乎官网」这类说法：后缀先削掉再查表。 */
  var SITE_SUFFIX = ['homepage', 'home', 'official site', 'official website', 'site', 'Web', 'URL', 'official'];
  var FOLDER_SUFFIX = ['folder', 'folder', 'directory', 'dir'];
  /* 句尾语气词：语音识别经常把它们一并带出来（「打开B站吧」）。 */
  var TAIL = ['please', 'hey', 'ah', 'oh', 'oh', 'hmm', 'uh', 'right', 'then', 'ha', 'okay', 'now', '\'s', 'a'];

  var FILE_EXT = /\.(exe|lnk|url|txt|md|log|ini|bat|cmd|ps1|docx?|xlsx?|pptx?|pdf|csv|json|xml|html?|png|jpe?g|gif|bmp|webp|svg|mp4|mkv|avi|mov|flv|wmv|mp3|wav|flac|m4a|zip|rar|7z|tar|gz|webm|onnx|apk|iso)$/i;

  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '');
  }

  /** 削掉句尾语气词与「的」（只在末尾连着削，中间一个字不动）。 */
  function cleanTrailing(s) {
    var t = String(s == null ? '' : s).trim();
    var guard = 0;
    var changed = true;
    while (changed && guard++ < 8) {
      changed = false;
      for (var i = 0; i < TAIL.length; i++) {
        var suf = TAIL[i];
        if (suf && t.length > suf.length && t.toLowerCase().slice(-suf.length) === suf) {
          t = t.slice(0, -suf.length).trim();
          changed = true;
          break;
        }
      }
    }
    return t.trim();
  }

  function stripSuffix(s, list) {
    var t = s;
    var guard = 0;
    var hit = true;
    while (hit && guard++ < 6) {
      hit = false;
      for (var i = 0; i < list.length; i++) {
        var suf = norm(list[i]);
        if (t.length > suf.length && t.lastIndexOf(suf) === t.length - suf.length) {
          t = t.slice(0, -suf.length);
          hit = true;
          break;
        }
      }
    }
    return t;
  }

  /** 站点别名 → 网址；不认识返回空串。 */
  function siteUrl(name) {
    var raw = norm(name);
    if (!raw) return '';
    var k = stripSuffix(raw, SITE_SUFFIX);
    k = cleanTrailing(k);
    if (SITES[k]) return SITES[k];
    var k2 = cleanTrailing(raw);
    return SITES[k2] || '';
  }

  /** 盘符：D盘 / d: / D:\ → "D:\"；不认识返回空串。 */
  function driveRoot(name) {
    var t = stripSuffix(norm(name), ['root directory', 'disk', 'drive', 'drive letter']);
    var m = t.match(/^([a-z])(?::)?[\\/]?$/);
    return m ? m[1].toUpperCase() + ':\\' : '';
  }

  /** 系统文件夹令牌：downloads / documents / …；不认识返回空串。 */
  function folderToken(name) {
    var raw = norm(name);
    if (!raw) return '';
    if (FOLDERS[raw]) return FOLDERS[raw];
    var k = stripSuffix(raw, FOLDER_SUFFIX);
    if (k !== raw) {
      if (FOLDERS[k]) return FOLDERS[k];
      if (FOLDERS_LOOSE[k]) return FOLDERS_LOOSE[k];
    }
    return '';
  }

  /** 像不像一条本机路径（含分隔符 / 盘符 / 已知扩展名）。 */
  function looksLikePath(name) {
    var t = String(name == null ? '' : name).trim();
    if (!t) return false;
    if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
    if (/^\\\\/.test(t)) return true;
    if (/[\\/]/.test(t)) return true;
    return FILE_EXT.test(t);
  }

  /** 域名（带 www. 或形如 a.b/c）：注意必须有字母，免得把「3.5」当网址。 */
  function looksLikeDomain(t) {
    if (!/[a-z]/i.test(t)) return false;
    return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+([/?#].*)?$/i.test(t);
  }

  /** 分类：{kind:'url'|'file'|'app', value, label}；空输入返回 null。 */
  function classify(target) {
    var raw = String(target == null ? '' : target).trim();
    if (!raw) return null;
    var t = cleanTrailing(raw);
    if (!t) return null;
    /* 1) 网址 */
    if (/^https?:\/\//i.test(t)) return { kind: 'url', value: t, label: raw };
    if (/^www\./i.test(t)) return { kind: 'url', value: 'https://' + t, label: raw };
    if (looksLikeDomain(t)) return { kind: 'url', value: 'https://' + t, label: raw };
    /* 2) 盘符（放在路径之前，好把 "d:\" 归一成 "D:\"） */
    var dr = driveRoot(t);
    if (dr) return { kind: 'file', value: dr, label: raw };
    /* 3) 本机路径 / 带扩展名的文件（相对名字交给主进程在常用目录里找） */
    if (looksLikePath(t)) return { kind: 'file', value: t, label: raw };
    /* 4) 系统文件夹 */
    var fk = folderToken(t);
    if (fk) return { kind: 'file', value: fk, label: raw };
    /* 5) 站点别名（「A站首页」） */
    var su = siteUrl(t);
    if (su) return { kind: 'url', value: su, label: raw };
    /* 6) 其余当软件名（卸载类由主进程红线拦） */
    return { kind: 'app', value: t, label: raw };
  }

  /** 搜索词 → 搜索网址（默认必应；说了「百度」就用百度，和控制台 rec.js 的口径一致）。 */
  function searchUrl(query, baidu) {
    var q = String(query == null ? '' : query).trim();
    if (!q) return '';
    return baidu
      ? 'https://www.baidu.com/s?wd=' + encodeURIComponent(q)
      : 'https://www.bing.com/search?q=' + encodeURIComponent(q);
  }

  return {
    SITES: SITES,
    FOLDERS: FOLDERS,
    classify: classify,
    siteUrl: siteUrl,
    driveRoot: driveRoot,
    folderToken: folderToken,
    looksLikePath: looksLikePath,
    cleanTrailing: cleanTrailing,
    searchUrl: searchUrl,
  };
});
