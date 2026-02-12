const els = {
  q: document.getElementById("q"),
  track: document.getElementById("track"),
  major: document.getElementById("major"),
  reset: document.getElementById("reset"),
  list: document.getElementById("list"),
  naverList: document.getElementById("naverList"),
  count: document.getElementById("count"),
  naverStatus: document.getElementById("naverStatus"),
};

let DB = [];
let lastNaverQuery = "";
let naverDebounceTimer = null;

const COVER_CACHE_PREFIX = "cover_v3:"; // 캐시 리셋 포함
const COVER_NEG_TTL_MS = 1000 * 60 * 60 * 24; // 24시간
const COVER_POS_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30일

function norm(s) { return (s ?? "").toString().trim(); }
function normSearch(s) { return norm(s).toLowerCase(); }

function escapeHtml(str) {
  return norm(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripTags(s) {
  return norm(s).replace(/<[^>]*>/g, "");
}

function buildMajorOptions(data, selectedTrack) {
  const majors = new Set();
  data.forEach(d => {
    if (!selectedTrack || d.track === selectedTrack) majors.add(d.major);
  });
  const sorted = [...majors].sort((a, b) => a.localeCompare(b, "ko"));
  els.major.innerHTML =
    `<option value="">학과 전체</option>` +
    sorted.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.exp || Date.now() > obj.exp) {
      localStorage.removeItem(key);
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

function cacheSet(key, value, ttlMs) {
  try {
    const obj = { value, exp: Date.now() + ttlMs };
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function coverCacheKey(d) {
  const base = `${norm(d.title)}|${norm(d.author)}|${norm(d.publisher)}`;
  return COVER_CACHE_PREFIX + base;
}

async function naverSearch(query, display = 10) {
  const url = `/.netlify/functions/naver-book?q=${encodeURIComponent(query)}&display=${display}&sort=sim`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Naver API error: ${res.status} ${text}`);
  }
  return await res.json();
}

// ===== 표지 매칭 정확도 향상 =====
function normalizeKey(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAuthor(s) {
  return normalizeKey(s)
    .replace(/\b(지음|저|글|엮음|편|편저|그림|역|옮김|번역|감수)\b/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCandidate(d, it) {
  const dTitle = normalizeKey(d.title);
  const dAuthor = normalizeAuthor(d.author);
  const dPub = normalizeKey(d.publisher);

  const itTitle = normalizeKey(stripTags(it.title));
  const itAuthor = normalizeAuthor(stripTags(it.author));
  const itPub = normalizeKey(stripTags(it.publisher));
  const itIsbn = normalizeKey(it.isbn || "");

  let score = 0;

  if (itTitle.includes(dTitle) || dTitle.includes(itTitle)) score += 70;
  else {
    const dWords = dTitle.split(" ").filter(Boolean);
    const hit = dWords.filter(w => w.length >= 2 && itTitle.includes(w)).length;
    score += Math.min(hit * 10, 40);
  }

  if (dAuthor && (itAuthor.includes(dAuthor) || dAuthor.includes(itAuthor))) score += 25;
  if (dPub && (itPub.includes(dPub) || dPub.includes(itPub))) score += 12;
  if (itIsbn) score += 3;

  return score;
}

function buildQueries(d) {
  const title = norm(d.title);
  const author = norm(d.author);
  const publisher = norm(d.publisher);

  const q1 = [title, author, publisher].filter(Boolean).join(" ").trim();
  const q2 = [title, author].filter(Boolean).join(" ").trim();
  const q3 = title;

  return [...new Set([q1, q2, q3].filter(Boolean))];
}

async function resolveCoverForItem(d) {
  const key = coverCacheKey(d);
  const cached = cacheGet(key);
  if (cached) return cached.value;

  const queries = buildQueries(d);
  if (queries.length === 0) {
    cacheSet(key, null, COVER_NEG_TTL_MS);
    return null;
  }

  try {
    const MAX_TRIES = 3;
    const PASS = 60;

    for (let i = 0; i < Math.min(queries.length, MAX_TRIES); i++) {
      const q = queries[i];
      const json = await naverSearch(q, 10);
      const items = Array.isArray(json.items) ? json.items : [];
      if (!items.length) continue;

      let best = null;
      let bestScore = -1;

      for (const it of items) {
        const sc = scoreCandidate(d, it);
        if (sc > bestScore) {
          bestScore = sc;
          best = it;
        }
      }

      const image = best?.image ? norm(best.image) : "";
      const link = best?.link ? norm(best.link) : "";

      if (image && bestScore >= PASS) {
        const value = { image, link };
        cacheSet(key, value, COVER_POS_TTL_MS);
        return value;
      }
    }

    cacheSet(key, null, COVER_NEG_TTL_MS);
    return null;
  } catch {
    cacheSet(key, null, 1000 * 60 * 10);
    return null;
  }
}

function renderEmpty(targetEl, msg) {
  targetEl.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
}

function renderLocal(items) {
  els.count.textContent = items.length.toString();

  if (items.length === 0) {
    renderEmpty(els.list, "검색 결과가 없습니다. 다른 키워드로 검색해 보세요.");
    return;
  }

  els.list.innerHTML = items.map((d, idx) => {
    const title = escapeHtml(d.title);
    const author = escapeHtml(d.author);
    const publisher = escapeHtml(d.publisher);
    const major = escapeHtml(d.major);
    const track = escapeHtml(d.track);
    const ck = escapeHtml(coverCacheKey(d));

    return `
      <article class="card" data-ck="${ck}" data-idx="${idx}">
        <div class="thumb">
          <div class="ph">표지 불러오는 중…</div>
        </div>
        <h3 class="title">${title}</h3>
        <p class="line"><strong>학과</strong> · ${major}</p>
        <p class="line"><strong>저자</strong> · ${author}</p>
        <p class="line"><strong>출판사</strong> · ${publisher}</p>
        <div class="badges"><span class="badge">${track}</span></div>
      </article>
    `;
  }).join("");

  const MAX_COVER_LOOKUPS = 30;
  const slice = items.slice(0, MAX_COVER_LOOKUPS);

  (async () => {
    for (let i = 0; i < slice.length; i++) {
      const d = slice[i];
      const cover = await resolveCoverForItem(d);
      const ck = coverCacheKey(d);

      const card = els.list.querySelector(`.card[data-ck="${CSS.escape(ck)}"]`);
      if (!card) continue;

      const thumb = card.querySelector(".thumb");
      if (!thumb) continue;

      if (!cover) {
        thumb.innerHTML = `<div class="ph">표지 없음</div>`;
        continue;
      }

      const img = `<img src="${escapeHtml(cover.image)}" alt="${escapeHtml(d.title)} 표지" loading="lazy" />`;
      if (cover.link) {
        thumb.innerHTML = `<a href="${escapeHtml(cover.link)}" target="_blank" rel="noopener noreferrer">${img}</a>`;
      } else {
        thumb.innerHTML = img;
      }
    }
  })();
}

function renderNaver(items, q) {
  if (!q.trim()) {
    renderEmpty(els.naverList, "검색어를 입력하면 네이버 도서 검색 결과가 표시됩니다.");
    return;
  }

  if (!items || items.length === 0) {
    renderEmpty(els.naverList, "네이버 검색 결과가 없습니다.");
    return;
  }

  els.naverList.innerHTML = items.map(it => {
    const title = escapeHtml(stripTags(it.title));
    const author = escapeHtml(stripTags(it.author));
    const publisher = escapeHtml(stripTags(it.publisher));
    const image = norm(it.image) ? escapeHtml(it.image) : "";
    const link = norm(it.link) ? escapeHtml(it.link) : "";

    const thumb = image
      ? `<img src="${image}" alt="${title} 표지" loading="lazy" />`
      : `<div class="ph">표지 없음</div>`;

    const thumbWrapped = link
      ? `<a href="${link}" target="_blank" rel="noopener noreferrer">${thumb}</a>`
      : thumb;

    return `
      <article class="card">
        <div class="thumb">${thumbWrapped}</div>
        <h3 class="title">${title}</h3>
        <p class="line"><strong>저자</strong> · ${author || "-"}</p>
        <p class="line"><strong>출판사</strong> · ${publisher || "-"}</p>
        <div class="badges"><span class="badge">네이버</span></div>
      </article>
    `;
  }).join("");
}

function applyLocalFilter() {
  const q = normSearch(els.q.value);
  const track = norm(els.track.value);
  const major = norm(els.major.value);

  let items = DB;
  if (track) items = items.filter(d => d.track === track);
  if (major) items = items.filter(d => d.major === major);

  if (q) {
    items = items.filter(d => {
      const hay = [d.track, d.major, d.title, d.author, d.publisher]
        .map(normSearch).join(" ");
      return hay.includes(q);
    });
  }

  renderLocal(items);
}

function scheduleNaverSearch() {
  const q = norm(els.q.value);

  if (!q) {
    els.naverStatus.textContent = "";
    renderNaver([], "");
    return;
  }

  if (naverDebounceTimer) clearTimeout(naverDebounceTimer);

  naverDebounceTimer = setTimeout(async () => {
    if (q === lastNaverQuery) return;
    lastNaverQuery = q;

    els.naverStatus.textContent = "네이버 도서 검색 중…";

    try {
      const json = await naverSearch(q, 12);
      const items = Array.isArray(json.items) ? json.items : [];
      renderNaver(items, q);
      els.naverStatus.textContent = "";
    } catch (e) {
      console.error(e);
      els.naverStatus.textContent = "네이버 검색 실패(환경변수/함수 배포 상태를 확인해주세요).";
      renderNaver([], q);
    }
  }, 450);
}

function resetAll() {
  els.q.value = "";
  els.track.value = "";
  buildMajorOptions(DB, "");
  els.major.value = "";
  lastNaverQuery = "";
  els.naverStatus.textContent = "";
  applyLocalFilter();
  renderNaver([], "");
}

async function init() {
  const res = await fetch("data.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`data.json load failed: ${res.status}`);
  DB = await res.json();

  DB = DB.map(d => ({
    track: norm(d.track),
    major: norm(d.major),
    title: norm(d.title),
    author: norm(d.author),
    publisher: norm(d.publisher),
  })).filter(d => d.track && d.major && d.title);

  buildMajorOptions(DB, "");

  applyLocalFilter();
  renderNaver([], "");

  els.q.addEventListener("input", () => {
    applyLocalFilter();
    scheduleNaverSearch();
  });

  els.track.addEventListener("change", () => {
    const selectedTrack = norm(els.track.value);
    buildMajorOptions(DB, selectedTrack);
    els.major.value = "";
    applyLocalFilter();
  });

  els.major.addEventListener("change", applyLocalFilter);
  els.reset.addEventListener("click", resetAll);
}

init().catch(err => {
  console.error(err);
  renderEmpty(els.list, "초기 로딩 실패: data.json 또는 script.js 오류를 확인해주세요.");
  renderEmpty(els.naverList, "초기 로딩 실패");
});
