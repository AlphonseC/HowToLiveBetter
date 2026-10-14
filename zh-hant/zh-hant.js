/* 繁體切換：本 fork 自己加的，上游沒有。index.html、selfcheck.html 的 <head> 各引一次。
 *
 * 只在畫面輸出那一層轉繁體，正文和程式內部一律維持簡體。檢索頁的解析、篩選、交叉引用全靠
 * 簡體關鍵字比對（「说人话」「来源」「第 X 节第 Y 条」），先轉正文會全部失效。所以改成盯著 DOM：
 * 新出現的文字節點，以及 title、placeholder、aria-label、alt 屬性，一律就地轉換。data-* 不碰，
 * 篩選按鈕的值才對得上。搜尋反過來：讀者輸入繁體，index.html 的 apply() 先用 zhToHans 轉回簡體。
 *
 * 只轉字形，不換詞彙（OpenCC cn→tw，不用 twp）。這本書講的是中國大陸的法規和行政流程，
 * twp 會把「简易程序」轉成「簡易程式」、「注销户口」轉成「登出戶口」、「参保对象」轉成「參保物件」，
 * 全書實測一千多處意思跑掉。
 *
 * 同一段文字只能轉一次。cn→tw 不是冪等的：已經轉好的「干預」再轉一次會變成「幹預」。
 * 轉出來的字串都記在 OUT，再看到就跳過，例如術語浮窗的內容是從轉好的 title 複製過去的。
 *
 * 檢索頁 699 張卡片佔了九成文字，正文一到就全轉，主執行緒要卡將近一秒（手機三四秒）。
 * 所以卡片先記在 PENDING，只轉畫面上下 1200px 內的；其餘捲到附近時或空閒時再轉，約兩秒轉完。
 *
 * 切回簡體直接重新載入：整頁到處是轉過的文字，逐一還原比重載容易漏。
 * 偏好存在 localStorage 的 zh-script；沒選過就看瀏覽器語言，zh-TW、zh-HK、zh-MO、zh-Hant 用繁體。
 * 繁體模式下，字典（約 500 KB gzip）載完、畫面轉完之前先把頁面藏起來，免得先閃一下簡體；
 * 最多藏 4 秒，字典載不到就照簡體顯示。
 */
(function(){
  const KEY = 'zh-script';
  const BASE = document.currentScript.src.replace(/[^/]*$/, '');
  const ROOT = document.documentElement;
  let pref = null;
  try { pref = localStorage.getItem(KEY); } catch (e) {}
  const want = pref ? pref === 'hant'
    : (navigator.languages || [navigator.language]).some(l => /^zh-(tw|hk|mo|hant)\b/i.test(l));

  let on = false, toHant = null, toHans = null;
  // 反向轉換器第一次搜尋才建，開頁時省一百多毫秒
  window.zhToHans = s => {
    if (!on || !s) return s;
    toHans ??= OpenCC.Converter({ from: 'tw', to: 'cn' });
    return toHans(s);
  };

  const css = document.createElement('style');
  css.textContent = 'html.zh-pending body{visibility:hidden}'
    + '.zh-btn{flex:none;width:36px;height:36px;border-radius:8px;display:grid;place-items:center;font-size:15px;font-weight:600;color:var(--t2);transition:background .25s,color .25s}'
    + '.zh-btn:hover{background:var(--bg-soft);color:var(--t1)}'
    // 手機頂欄多了這顆按鈕，搜尋框文字區從 55px 掉到 11px。上游手機版已藏起「/」提示，收回它右邊那 44px 留白
    + '@media (max-width:960px){.nav .search input{padding-right:12px}.zh-btn{width:30px}}';
  document.head.appendChild(css);

  /* ---------- 轉換 ---------- */
  // OpenCC 靠詞典斷詞，全書實測有 82 個字轉錯：「樓道里」被斷成哈爾濱的道里區、「人里約三成」
  // 被斷成里約熱內盧、「單位制作」被斷成單位制、「這裡麵包括」被斷成麵包，「系安全帶」詞典沒收。
  // 原文照常交給 OpenCC，轉完再按位置改；先改原文會打亂斷詞，「里面包括」會變成「裡麵包括」。
  // 每條規則匹配到單一個字就換成右邊的字，匹配到多字的詞是保護名單，原樣不動。
  // 「里」除了保護名單一律用「裡」；以後碰到別的地名、人名被轉錯，加進第一條那串。
  const FIX = [
    [/公里|英里|海里|千里|万里|华里|里程|邻里|故里|乡里|卡路里|索马里|里昂|里约热内卢|佛罗里达|斯里兰卡|马里兰|里氏|里斯本|阿里巴巴|阿里云|里根|里/g, '裡'],
    [/系(?=安全带|犬绳|没系)|(?<=[都没要])系(?=[，。；、）」\s]|$)/g, '繫'],
    [/(?<![抑控限])制(?=剂)|制(?=作(?![用为出]))/g, '製'],
    [/(?<=里)面(?=包[括含])/g, '面'],
  ];
  function fix(s, out){
    if (out.length !== s.length || !/[里系制面]/.test(s)) return out;
    const at = [];
    for (const [re, ch] of FIX) for (const m of s.matchAll(re)) if (m[0].length === 1) at.push([m.index, ch]);
    if (!at.length) return out;
    let r = '', last = 0;
    for (const [i, ch] of at.sort((x, y) => x[0] - y[0])) { r += out.slice(last, i) + ch; last = i + 1; }
    return r + out.slice(last);
  }
  // 程式碼和樣式不轉；切換按鈕標了 data-zh-skip，「繁」「简」兩個字要維持原樣
  const SKIP = 'script,style,noscript,textarea,[data-zh-skip]';
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const HAN = /\p{Script=Han}/u;
  // 同一段字反覆出現（目錄和卡片標題、徽章、欄位名），記下轉過的結果，2.8 萬段卡片文字只有 9 千多段不同
  const MEMO = new Map(), OUT = new Set();
  const conv = (s) => {
    if (!s || OUT.has(s) || !HAN.test(s)) return s;
    let t = MEMO.get(s);
    if (t === undefined){ t = toHant(s); MEMO.set(s, t); OUT.add(t); }
    return t;
  };
  const setText = (n) => { const t = conv(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; };
  const setAttr = (el, a) => { const v = el.getAttribute(a), t = conv(v); if (t !== v) el.setAttribute(a, t); };
  const PENDING = new Set();
  const IO = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) flush(e.target);
    MO.takeRecords();
  }, { rootMargin: '1200px 0px' });
  function convTree(node){
    if (node.nodeType === 3){ if (!node.parentElement?.closest(SKIP)) setText(node); return; }
    if (node.nodeType !== 1 || node.closest(SKIP)) return;
    const w = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n =>
      n.nodeType !== 1 ? NodeFilter.FILTER_ACCEPT
      : n.matches(SKIP) ? NodeFilter.FILTER_REJECT
      : n.classList.contains('card') ? (PENDING.add(n), IO.observe(n), NodeFilter.FILTER_REJECT)
      : NodeFilter.FILTER_ACCEPT });
    const list = [node];
    while (w.nextNode()) list.push(w.currentNode);
    for (const n of list){
      if (n.nodeType === 3) setText(n);
      else for (const a of ATTRS) if (n.hasAttribute(a)) setAttr(n, a);
    }
  }
  function flush(card){ if (PENDING.delete(card)){ IO.unobserve(card); convTree(card); } }
  let drainT = 0;
  function settle(){
    for (const c of PENDING){
      const r = c.getBoundingClientRect();
      if (r.height && r.bottom > -1200 && r.top < innerHeight + 1200) flush(c);
    }
    if (PENDING.size && !drainT) drainT = setTimeout(drain, 300);
  }
  function drain(){
    const end = performance.now() + 8;
    for (const c of PENDING){ flush(c); if (performance.now() > end) break; }
    MO.takeRecords();
    drainT = PENDING.size ? setTimeout(drain, 30) : 0;
  }
  // IntersectionObserver 的通知排在畫面繪製之後，剛開頁就跳到遠處的條目，會先閃兩幀簡體。
  // 所以篩選改了 hidden、或頁面捲動時（scroll 事件在繪製前），先同步轉畫面附近的卡片
  const MO = new MutationObserver(records => {
    const n0 = PENDING.size; let shown = false;
    for (const r of records){
      if (r.type === 'childList') r.addedNodes.forEach(n => convTree(n));
      else if (r.type === 'characterData') convTree(r.target);
      else if (r.attributeName === 'hidden') shown = true;
      else if (!r.target.closest(SKIP) && r.target.hasAttribute(r.attributeName)) setAttr(r.target, r.attributeName);
    }
    if (PENDING.size > n0 || (shown && PENDING.size)) settle();
    MO.takeRecords();   // 上面自己改的文字和屬性也會排進佇列，丟掉，免得再查一遍
  });
  // 台灣字形：把 --font 裡的簡體字型換成繁體字型（「說」「骨」「戶」兩邊寫法不同）
  function twFont(){
    const f = getComputedStyle(ROOT).getPropertyValue('--font');
    if (f) ROOT.style.setProperty('--font', f.replace(/PingFang SC/g, 'PingFang TC').replace(/"Hiragino Sans GB",\s*/g, '')
      .replace(/Microsoft YaHei/g, 'Microsoft JhengHei').replace(/Noto Sans SC/g, 'Noto Sans TC'));
  }

  /* ---------- 開關 ---------- */
  let btn = null;
  const domReady = new Promise(r => document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', r, { once: true }) : r());
  const load = () => window.OpenCC ? Promise.resolve() : new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = BASE + 'opencc-js-1.4.2/full.js';
    s.onload = ok; s.onerror = () => fail(new Error('載不到 ' + s.src));
    document.head.appendChild(s);
  });
  function start(){
    const cc = OpenCC.Converter({ from: 'cn', to: 'tw' });
    toHant = s => fix(s, cc(s));
    on = true;
    ROOT.lang = 'zh-TW'; twFont();
    convTree(ROOT);
    settle();
    MO.observe(ROOT, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'hidden'] });
    addEventListener('scroll', () => { if (PENDING.size){ settle(); MO.takeRecords(); } }, { passive: true });
    label();
    // 網址帶著繁體搜尋詞（?q=）進來時，檢索頁的第一次篩選可能比字典早跑，那次比對不到，重新觸發一次
    const q = document.getElementById('q');
    if (q && q.value) q.dispatchEvent(new Event('input'));
  }
  function label(){
    if (!btn) return;
    btn.textContent = on ? '简' : '繁';
    const tip = on ? '切換為簡體中文' : '切换为繁体中文';
    btn.title = tip; btn.setAttribute('aria-label', tip);
  }
  domReady.then(() => {
    const host = document.querySelector('.nav-r') || document.querySelector('header.nav');
    if (!host) return;
    btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'zh-btn'; btn.dataset.zhSkip = '';
    label();
    host.insertBefore(btn, host.querySelector(':scope > #theme'));
    btn.addEventListener('click', () => {
      try { localStorage.setItem(KEY, on ? 'hans' : 'hant'); } catch (e) {}
      if (on){ location.reload(); return; }
      btn.disabled = true;
      load().then(start).catch(err => console.warn('繁體切換失敗', err)).finally(() => { btn.disabled = false; });
    });
  });
  if (want){
    ROOT.classList.add('zh-pending');
    const show = () => ROOT.classList.remove('zh-pending');
    setTimeout(show, 4000);
    Promise.all([load(), domReady]).then(start).catch(err => console.warn('繁體切換失敗，維持簡體', err)).finally(show);
  }
})();
