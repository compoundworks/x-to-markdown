// ==UserScript==
// @name         X 記事・ポスト取得（Markdownコピー）
// @namespace    sofuri.x.grabber
// @version      1.0.8
// @description  Xの記事(長文Articles)や通常ポスト/スレッド/引用RTのタイトル・本文を、画面のボタン一発でMarkdownとしてクリップボードにコピーする
// @author       Sofuri
// @homepageURL  https://github.com/sofuri-tokyo/x-to-markdown
// @supportURL   https://github.com/sofuri-tokyo/x-to-markdown/issues
// @downloadURL  https://raw.githubusercontent.com/sofuri-tokyo/x-to-markdown/main/x-to-markdown.user.js
// @updateURL    https://raw.githubusercontent.com/sofuri-tokyo/x-to-markdown/main/x-to-markdown.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ───────────────────────────────────────────────
  // CONFIG — 実DOMに合わせて調整する場合はここを触る
  // ───────────────────────────────────────────────
  const CFG = {
    btnLabel: '📋 取得',
    // localStorage に xgrab_debug=1 を入れると console に詳細ログを出す
    debug: localStorage.getItem('xgrab_debug') === '1',
  };

  const log = (...a) => CFG.debug && console.log('[xgrab]', ...a);
  const abs = (href) => {
    try { return new URL(href, location.origin).href; } catch { return href || ''; }
  };

  // ───────────────────────────────────────────────
  // クリップボード
  // ───────────────────────────────────────────────
  function copy(text) {
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; }
    } catch (_) {}
    if (navigator.clipboard) { navigator.clipboard.writeText(text).catch(() => {}); return true; }
    return false;
  }

  // ───────────────────────────────────────────────
  // 通常ポスト（テキスト抽出）
  //   ハッシュタグ/メンションはプレーン文字、絵文字はalt、改行は維持
  // ───────────────────────────────────────────────
  function tweetTextToText(el) {
    let s = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) { s += n.textContent; return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const t = n.tagName.toLowerCase();
      if (t === 'img') s += n.getAttribute('alt') || '';
      else if (t === 'br') s += '\n';
      else if (t === 'a') s += n.textContent;
      else s += tweetTextToText(n);
    });
    return s;
  }

  // 指定セレクタの最初の要素を返す。ただし exclude（引用元コンテナ）の内側は飛ばす。
  function firstNotIn(scope, selector, exclude) {
    for (const el of scope.querySelectorAll(selector)) {
      if (!exclude || !exclude.contains(el)) return el;
    }
    return null;
  }

  // 引用リツイートの「引用元」コンテナを探す。実DOM(2026-06-18)では
  // 外側ツイート内の <div role="link"> で、中に tweetText / User-Name を持つもの。
  // （著者バッジ等の div[role=link] は本文も著者も持たないので自然に除外される）
  function findQuoted(articleEl) {
    for (const l of articleEl.querySelectorAll('div[role="link"]')) {
      if (l.querySelector('[data-testid="tweetText"]') || l.querySelector('[data-testid="User-Name"]')) return l;
    }
    return null;
  }

  function extractPost(articleEl, exclude) {
    const nameBlock = firstNotIn(articleEl, '[data-testid="User-Name"]', exclude);
    let displayName = '', handle = '';
    if (nameBlock) {
      const texts = Array.from(nameBlock.querySelectorAll('span'))
        .map((s) => s.textContent.trim()).filter(Boolean);
      handle = texts.find((t) => t.startsWith('@')) || '';
      displayName = texts.find((t) => !t.startsWith('@') && t !== '·') || '';
    }
    const textEl = firstNotIn(articleEl, '[data-testid="tweetText"]', exclude);
    const text = textEl ? tweetTextToText(textEl).trim() : '';

    // 外側の時刻は「引用元の time」より後ろにある → exclude で引用元の time を飛ばす
    const timeEl = firstNotIn(articleEl, 'time', exclude);
    let dateStr = '';
    if (timeEl && timeEl.getAttribute('datetime')) {
      const d = new Date(timeEl.getAttribute('datetime'));
      if (!isNaN(d)) dateStr = d.toLocaleString();
    }
    let permalink = '';
    const tweetLink = timeEl && timeEl.closest('a');
    if (tweetLink) permalink = abs(tweetLink.getAttribute('href'));

    // 画像（tweetPhoto）。引用元(exclude)の画像は外側に混ぜない。記事本文画像は extractArticle 側で扱う
    const images = [];
    articleEl.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((im) => {
      if (exclude && exclude.contains(im)) return;
      const src = im.getAttribute('src'); if (src) images.push(abs(src));
    });

    return { displayName, handle, text, dateStr, permalink, images };
  }

  function postToMd(p) {
    const head = `**${p.displayName || '(名前不明)'}**${p.handle ? ` (${p.handle})` : ''}`;
    const meta = [p.dateStr, p.permalink].filter(Boolean).join('\n');
    let md = `${head}\n${meta}\n\n${p.text}`.trim();
    if (p.images && p.images.length) md += '\n\n' + p.images.map((s, i) => `![image${i + 1}](${s})`).join('\n');
    return md;
  }

  // 外側ポスト ＋ 引用元（あれば blockquote で）の Markdown
  function fullPostToMd(main, quoted) {
    let md = postToMd(main);
    const q = quoted;
    if (q && (q.text || q.displayName)) {
      const head = `引用元: **${q.displayName || ''}**${q.handle ? ` (${q.handle})` : ''}`.trim();
      const lines = [head];
      const sub = [q.dateStr, q.permalink].filter(Boolean).join(' · ');
      if (sub) lines.push(sub);
      if (q.text) { lines.push(''); q.text.split('\n').forEach((l) => lines.push(l)); }
      (q.images || []).forEach((s, i) => lines.push(`![image${i + 1}](${s})`));
      md += '\n\n' + lines.map((l) => (l ? '> ' + l : '>')).join('\n');
    }
    return md;
  }

  // 1つの article 要素 → 外側＋引用元をまとめた Markdown（permalink が取れなければ fallback）
  function articleToFullMd(articleEl, fallbackPermalink) {
    const quoted = findQuoted(articleEl);
    const main = extractPost(articleEl, quoted);
    if (!main.permalink && fallbackPermalink) main.permalink = fallbackPermalink;
    const q = quoted ? extractPost(quoted, null) : null;
    return fullPostToMd(main, q);
  }

  // ───────────────────────────────────────────────
  // メインの通常ポストを選ぶ
  //   status ページ → 先頭(=フォーカスされた投稿)＋同一著者の連続スレッド
  //   それ以外      → ビューポート中央に一番近い投稿
  // ───────────────────────────────────────────────
  function pickMainTweet() {
    const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (!arts.length) return null;
    // 個別ページ：URL の status ID と一致するリンクを持つ投稿＝注目の投稿。
    // （返信ページでは先頭=親投稿になってしまうので、先頭固定にしない）
    const m = location.pathname.match(/\/status\/(\d+)/);
    if (m) {
      const id = m[1];
      for (const a of arts) {
        for (const link of a.querySelectorAll('a[href*="/status/"]')) {
          const lm = (link.getAttribute('href') || '').match(/\/status\/(\d+)/);
          if (lm && lm[1] === id) return a;
        }
      }
      return arts[0]; // 念のためのフォールバック
    }
    // タイムライン：ビューポート中央に一番近い投稿
    const cy = innerHeight / 2;
    let best = null, bestD = Infinity;
    for (const a of arts) {
      const r = a.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const d = Math.abs((r.top + r.bottom) / 2 - cy);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best || arts[0];
  }

  // ───────────────────────────────────────────────
  // 記事（長文 Articles） — 実DOM(2026-06-18 ground truth)に合わせて確定
  //   記事リーダー本体 : [data-testid="twitterArticleReadView"]
  //   タイトル         : [data-testid="twitter-article-title"]（h1 ではない）
  //   本文(リッチ)     : [data-testid="longformRichTextComponent"]
  //   表紙画像         : 本文の外側の [data-testid="tweetPhoto"] img
  // ───────────────────────────────────────────────

  function inlineMd(el) {
    let s = '';
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) { s += n.textContent; return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const t = n.tagName.toLowerCase();
      if (t === 'a') {
        const href = n.getAttribute('href'); const txt = inlineMd(n);
        s += href ? `[${txt}](${abs(href)})` : txt;
      } else if (t === 'strong' || t === 'b') s += `**${inlineMd(n)}**`;
      else if (t === 'em' || t === 'i') s += `*${inlineMd(n)}*`;
      else if (t === 'code') s += '`' + n.textContent + '`';
      else if (t === 'br') s += '\n';
      else if (t === 'img') s += n.getAttribute('alt') || '';
      else s += inlineMd(n);
    });
    return s;
  }

  function extractLongform(component) {
    // longform 本文は wrapper > [段落ブロック...] の形。
    // 各段落 = <div><div><span><span>text</span></span></div></div>、空行は <br> のみのブロック。
    const wrapper = component.firstElementChild || component;
    const out = [];
    Array.from(wrapper.children).forEach((blk) => {
      const img = blk.querySelector('[data-testid="tweetPhoto"] img, img');
      const txt = inlineMd(blk).replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/ /g, ' ').trim();
      if (img && !txt) {
        const src = img.getAttribute('src');
        out.push(src ? `![${img.getAttribute('alt') || ''}](${abs(src)})` : '');
      } else {
        out.push(txt); // br のみは '' になり段落区切りになる
      }
    });
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractArticle(article) {
    const readView = article.querySelector('[data-testid="twitterArticleReadView"]') || article;
    const titleEl = readView.querySelector('[data-testid="twitter-article-title"]');
    const title = titleEl ? inlineMd(titleEl).trim() : '(無題)';
    const comp = readView.querySelector('[data-testid="longformRichTextComponent"]');

    const parts = [];
    // 表紙画像（本文の外側にある tweetPhoto）
    const cover = Array.from(readView.querySelectorAll('[data-testid="tweetPhoto"] img'))
      .find((im) => !comp || !comp.contains(im));
    if (cover && cover.getAttribute('src')) parts.push(`![${cover.getAttribute('alt') || 'cover'}](${abs(cover.src)})`);

    let body = comp ? extractLongform(comp) : '';
    if (!body) {
      const rtv = readView.querySelector('[data-testid="twitterArticleRichTextView"]');
      body = rtv ? (rtv.innerText || '').trim() : '';
    }
    if (body) parts.push(body);

    const meta = extractPost(article); // 著者・日時・リンク（本文/画像は使わない）
    log('article:', title, '| body len:', body.length);
    return { title, meta, content: parts.join('\n\n') };
  }

  function articleToMd(a) {
    const m = a.meta || {};
    const head = `**${m.displayName || ''}**${m.handle ? ` (${m.handle})` : ''}`.trim();
    const sub = [m.dateStr, m.permalink].filter(Boolean).join('\n');
    return `# ${a.title}\n\n${[head, sub].filter(Boolean).join('\n')}\n\n${a.content}`.trim();
  }

  // ───────────────────────────────────────────────
  // クリック時の本処理（記事 → ポスト/スレッドの順で判定）
  // ───────────────────────────────────────────────
  function grab() {
    // ① 記事の全文リーダーが開いていれば最優先（実DOMで確定した目印）
    const readView = document.querySelector('[data-testid="twitterArticleReadView"]');
    if (readView) {
      const article = readView.closest('article[data-testid="tweet"]') || readView;
      const a = extractArticle(article);
      if (a.content && a.content.length > 0) {
        copy(articleToMd(a));
        return `記事「${a.title.slice(0, 20)}」を取得しました（本文 ${a.content.length} 字）`;
      }
      copy(articleToMd({ ...a, content: '(本文が読み込まれていません。少し下にスクロールして本文を表示してから、もう一度取得してください)' }));
      return 'タイトルのみ取得。本文を表示してから再取得してください';
    }

    // ② 通常ポスト / 引用RT / スレッド
    const main = pickMainTweet();
    if (main) {
      const quotedProbe = findQuoted(main);
      const probe = extractPost(main, quotedProbe);
      // 記事のプレビュー（本文未展開）を踏んだ場合
      if (!probe.text && !quotedProbe && main.querySelector('a[href*="/article/"]')) {
        return '記事のようです。タイトルか表紙をクリックして全文を開いてから、もう一度取得してください';
      }
      // 個別ページなら、フォーカス投稿に続く「同一著者の連投」をスレッドとしてまとめる
      if (/\/status\/\d+/.test(location.pathname)) {
        const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
        const startIdx = arts.indexOf(main);
        const thread = [];
        for (let i = startIdx; i < arts.length; i++) {
          const p = extractPost(arts[i], findQuoted(arts[i]));
          if (i > startIdx && p.handle !== probe.handle) break; // 別人＝返信なので打ち切り
          thread.push(arts[i]);
        }
        if (thread.length > 1) {
          const md = thread.map((el, i) => articleToFullMd(el, i === 0 ? location.href : '')).join('\n\n---\n\n');
          copy(md);
          return `スレッド ${thread.length} 件を取得しました`;
        }
      }
      copy(articleToFullMd(main, location.href));
      return 'ポストを取得しました';
    }
    return '取得できる記事/ポストが見つかりませんでした';
  }

  // ───────────────────────────────────────────────
  // UI（フローティングボタン + トースト）
  // ───────────────────────────────────────────────
  // X は CSP が厳しく <style> 要素や style 属性がブロックされることがあるため、
  // スタイルは CSSOM（element.style）で直接当てる（CSP の style-src の影響を受けない）。
  // X 自身のボタンが右下隅(bottom:24px / 78px あたり)に2つ常駐するので、その上に置く
  const BTN_CSS =
    'position:fixed;right:20px;bottom:148px;z-index:2147483647;' +
    'font:600 14px/1 -apple-system,system-ui,sans-serif;color:#fff;' +
    'background:#1d9bf0;border:none;border-radius:9999px;padding:12px 18px;' +
    'box-shadow:0 2px 12px rgba(0,0,0,.35);cursor:pointer;opacity:.96;';

  const TOAST_CSS =
    'position:fixed;right:20px;bottom:202px;z-index:2147483647;' +
    'font:500 13px/1.4 -apple-system,system-ui,sans-serif;color:#0f1419;' +
    'background:#fff;border:1px solid #e1e8ed;border-radius:10px;padding:10px 14px;' +
    'max-width:280px;box-shadow:0 4px 16px rgba(0,0,0,.2);' +
    'opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;' +
    'pointer-events:none;';

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('xgrab-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'xgrab-toast';
      el.style.cssText = TOAST_CSS;
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; }, 2200);
  }

  function ensureButton() {
    if (document.getElementById('xgrab-btn')) return;
    if (!document.body) return;
    const btn = document.createElement('button');
    btn.id = 'xgrab-btn';
    btn.type = 'button';
    btn.textContent = CFG.btnLabel;
    btn.title = 'この記事/ポストをMarkdownでコピー';
    btn.style.cssText = BTN_CSS;
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { toast(grab()); }
      catch (err) { console.error('[xgrab]', err); toast('取得に失敗しました（コンソール参照）'); }
    });
    document.body.appendChild(btn);
    log('button injected');
  }

  // ───────────────────────────────────────────────
  // デバッグ：いま開いている画面の DOM 構造を吸い出してコピーする。
  //   推測でセレクタを書くのをやめ、実物の構造に合わせるための地ならし。
  //   class（X は難読化されてて無意味）は捨て、data-testid / role / aria-label /
  //   alt / datetime / href など「目印になる属性」だけ残す。
  // ───────────────────────────────────────────────
  function domDump() {
    const root = document.querySelector('[data-testid="primaryColumn"]') || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll('svg, path, script, style, link, video, source').forEach((e) => e.remove());
    clone.querySelectorAll('img').forEach((im) => { im.removeAttribute('src'); im.removeAttribute('srcset'); });
    const KEEP = /^(data-testid|role|aria-label|alt|datetime|href|lang|dir)$/;
    clone.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((at) => { if (!KEEP.test(at.name)) el.removeAttribute(at.name); });
    });
    let html = clone.outerHTML.replace(/\s+\n/g, '\n');
    if (html.length > 20000) html = html.slice(0, 20000) + '\n…(以降カット)';
    copy('=== X DOM DUMP ===\nURL: ' + location.href + '\n\n' + html);
    return 'DOM構造をコピーしました（' + html.length + '字）。チャットに貼ってください';
  }

  // フローティングボタンが何かに邪魔されても使えるよう、
  // Tampermonkey のメニューからも「取得」できるようにする（拡張アイコンの一覧に出る）
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('📋 この記事/ポストを取得', () => {
      try {
        const msg = grab();
        toast(msg);
        alert('[X取得] ' + msg);
      } catch (err) {
        console.error('[xgrab]', err);
        alert('[X取得] 失敗: ' + err.message);
      }
    });
    GM_registerMenuCommand('🔧 DOM構造をコピー（デバッグ）', () => {
      try { const m = domDump(); toast(m); alert('[X取得] ' + m); }
      catch (err) { console.error('[xgrab]', err); alert('[X取得] dump失敗: ' + err.message); }
    });
  }

  // SPA なので body に居続けるが、念のため定期的に存在チェックして再注入
  const obs = new MutationObserver(() => ensureButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
  log('loaded');
})();
