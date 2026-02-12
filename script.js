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

const COVER_CACHE_PREFIX = "cover_v1:"; // 로컬 캐시 키 prefix
const COVER_NEG_TTL_MS = 1000 * 60 * 60 * 24; // 24시간: 못 찾았을 때도 캐시(재조회 과다 방지)
const COVER_POS_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30일: 찾은 표지 캐시

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

// 네이버 결과에는 <b>가 들어오는 경우가 있어 제거
function stripTags(s) {
  return norm(s).replace(/<[^>]*>/g, "");
}

function buildMajorOptions(data, selectedTrack) {
  const majors = new Set();
  data.forEach(d => {
    if (!selectedTrack || d.track === selectedTrack) majors.add(d.major);
  });
  const sorted = [...majors].sort((a,b) => a.localeCompare(b, "ko"));
  els.major.innerHTML = `<option value="">학과 전체</option>` +
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
    // localStorage 꽉 찼을 때 등은 그냥 무시
  }
}

function coverCacheKey(d) {
  // title+author+publisher 조합으로 키 생성
  const base = `${norm(d.title)}|${norm(d.author)}|${norm(d.publisher)}`;
  return COVER_CACHE_PREFIX + base;
}

// 네이버 API(프록시 함수) 호출
async function naverSearch(query, display = 10) {
  const url = `/.netlify/functions/naver-book?q=${encodeURIComponent(query)}&display=${display}&sort=sim`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Naver API error: ${res.status} ${text}`);
  }
  return await res.json();
}

// “내 DB 카드” 표지 매칭: 도서명 + 저자 중심으로 검색
async function resolveCoverForItem(d) {
  const key = coverCacheKey(d);
  const cached = cacheGet(key);
  if (cached) return cached.value; // {image, link} 또는 null

  // 검색어는 너무 길게 쓰지 않는 게 오히려 정확합니다.
  // (저자명까지 포함)
  const q = `${norm(d.title)} ${norm(d.author)}`.trim();
  if (!q) {
    cacheSet(key, null, COVER_NEG_TTL_MS);
    return null;
  }

  try {
    const json = await naverSearch(q, 5);
    const items = Array.isArray(json.items) ? json.items : [];
    if (!items.length) {
      cacheSet(key, null, COVER_NEG_TTL_MS);
      return null;
    }

    // 1순위: title이 유사한 항목
    const targetTitle = normSearch(d.title);
    let best = items.find(it => normSearch(stripTags(it.title)).includes(targetTitle));

    // 없으면 첫 번째
    if (!best) best = items[0];

    const image = best?.image ? norm(best.image) : "";
    const link = best?.link ? norm(best.link) : "";

    if (!image) {
      cacheSet(key, null, COVER_NEG_TTL_MS);
      return null;
    }

    const value = { image, link };
    cacheSet(key, value, COVER_POS_TTL_MS);
    return value;
  } catch {
    // 실패해도 과호출 방지 위해 짧게 negative 캐시
    cacheSet(key, null, 1000 * 60 * 10); // 10분
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

  // 우선 표지 없는 상태로 렌더링
  els.list.innerHTML = items.map((d, idx) => {
    const title = escapeHtml(d.title);
    const author = escapeHtml(d.author);
    const publisher = escapeHtml(d.publisher);
    const major = escapeHtml(d.major);
    const track = escapeHtml(d.track);

    // data-ck로 캐시키 저장(후처리로 이미지 주입)
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

  // 표지 매칭은 “필터링 결과 상위 일부만” 수행(과호출 방지)
  // 필요 시 숫자 조정 가능
  const MAX_COVER_LOOKUPS = 18;
  const slice = items.slice(0, MAX_COVER_LOOKUPS);

  // 순차 호출(동시성 높이면 초당 제한에 걸릴 수 있어 안전하게)
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

      // 표지 클릭 시 네이버 링크로 이동(원치 않으면 아래 <a> 제거)
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

  // 네이버 검색은 “검색어가 있을 때만”
  if (!q) {
    els.naverStatus.textContent = "";
    renderNaver([], "");
    return;
  }

  // 이전 타이머 취소 후 디바운스
  if (naverDebounceTimer) clearTimeout(naverDebounceTimer);

  naverDebounceTimer = setTimeout(async () => {
    // 동일 검색어 재호출 방지
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
  DB = await res.json();

  DB = DB.map(d => ({
    track: norm(d.track),
    major: norm(d.major),
    title: norm(d.title),
    author: norm(d.author),
    publisher: norm(d.publisher),
  })).filter(d => d.track && d.major && d.title);

  buildMajorOptions(DB, "");

  // 초기 렌더
  applyLocalFilter();
  renderNaver([], "");

  // 이벤트
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
  renderEmpty(els.list, "초기 로딩 실패: data.json을 확인해주세요.");
  renderEmpty(els.naverList, "초기 로딩 실패");
});
