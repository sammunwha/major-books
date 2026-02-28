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
// 반환값:
//   { matched: true,  image, link }          → 정확 매칭 성공 (자동 적용)
//   { matched: false, candidates: [...] }    → 후보 목록 (사용자가 선택)
//   null                                     → 검색 실패 or 결과 없음
async function resolveCoverForItem(d) {
  const key = coverCacheKey(d);
  const cached = cacheGet(key);
  if (cached) return cached.value;

  const q = `${norm(d.title)} ${norm(d.author)}`.trim();
  if (!q) {
    cacheSet(key, null, COVER_NEG_TTL_MS);
    return null;
  }

  try {
    const json = await naverSearch(q, 8);
    const items = Array.isArray(json.items) ? json.items : [];
    if (!items.length) {
      cacheSet(key, null, COVER_NEG_TTL_MS);
      return null;
    }

    // 괄호 앞 핵심 제목만 추출 (예: "넛지 (파이널 에디션...)" → "넛지")
    function coreTitle(s) {
      return normSearch(s).replace(/[(\[（［].*$/g, "").replace(/[=:：]/g, " ").trim();
    }

    const targetCore = coreTitle(d.title);
    const targetFull = normSearch(d.title);
    const targetAuthor = normSearch(d.author);

    function similarity(it) {
      const tFull = normSearch(stripTags(it.title));
      const tCore = coreTitle(stripTags(it.title));
      const a = normSearch(stripTags(it.author));
      let score = 0;

      // 제목 비교 (핵심 제목 기준 우선)
      if (tCore === targetCore && targetCore.length > 0) score += 100;
      else if (tFull === targetFull) score += 100;
      else if (tFull.includes(targetCore) || targetCore.includes(tCore)) score += 70;
      else if (tFull.includes(targetFull) || targetFull.includes(tCore)) score += 60;
      else {
        // 단어 단위 매칭
        const words = targetCore.split(/\s+/).filter(w => w.length > 0);
        const matched = words.filter(w => tFull.includes(w)).length;
        score += words.length > 0 ? (matched / words.length) * 50 : 0;
      }

      // 저자 보정
      if (targetAuthor) {
        const firstAuthor = targetAuthor.split(/[\s\^,]/)[0];
        if (firstAuthor && a.includes(firstAuthor)) score += 20;
      }

      return score;
    }

    const scored = items
      .filter(it => it.image)
      .map(it => ({ ...it, _score: similarity(it) }))
      .sort((a, b) => b._score - a._score);

    if (!scored.length) {
      cacheSet(key, null, COVER_NEG_TTL_MS);
      return null;
    }

    const best = scored[0];

    // 점수 40 이상이면 자동 적용 (기준 완화)
    if (best._score >= 40) {
      const value = { matched: true, image: norm(best.image), link: norm(best.link || "") };
      cacheSet(key, value, COVER_POS_TTL_MS);
      return value;
    }

    // 그 외: 후보 목록 반환 (표지 있는 것만)
    const candidates = scored.slice(0, 6).map(it => ({
      title: stripTags(it.title),
      author: stripTags(it.author),
      image: norm(it.image),
      link: norm(it.link || ""),
    }));

    // 후보가 있으면 보여주고, 없으면 그냥 첫 번째 결과 사용
    if (candidates.length > 0) {
      return { matched: false, candidates };
    }
    return null;

  } catch {
    cacheSet(key, null, 1000 * 60 * 10);
    return null;
  }
}

// 사용자가 후보 표지 선택 시 캐시에 저장
function selectCover(d, image, link) {
  const key = coverCacheKey(d);
  cacheSet(key, { matched: true, image, link }, COVER_POS_TTL_MS);
}

// 후보 표지 선택 UI 렌더링
function renderCandidateThumb(thumb, d, candidates) {
  thumb.innerHTML = `
    <div class="cover-candidates">
      <p class="cand-label">표지를 선택하세요</p>
      <div class="cand-list">
        ${candidates.map((c, i) => `
          <button class="cand-btn" data-ci="${i}" title="${escapeHtml(c.title)} / ${escapeHtml(c.author)}">
            <img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.title)}" loading="lazy" />
          </button>
        `).join("")}
      </div>
    </div>
  `;

  thumb.querySelectorAll(".cand-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const ci = parseInt(btn.dataset.ci, 10);
      const chosen = candidates[ci];
      selectCover(d, chosen.image, chosen.link);
      const img = `<img src="${escapeHtml(chosen.image)}" alt="${escapeHtml(d.title)} 표지" loading="lazy" />`;
      thumb.innerHTML = chosen.link
        ? `<a href="${escapeHtml(chosen.link)}" target="_blank" rel="noopener noreferrer">${img}</a>`
        : img;
    });
  });
}

function renderEmpty(targetEl, msg) {
  targetEl.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
}

// AI 탐구 주제 생성 함수
async function fetchExploreTopics(book) {
  // Netlify 프록시 함수를 통해 Claude API 호출 (CORS 방지)
  const response = await fetch("/.netlify/functions/claude-explore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: book.title,
      author: book.author,
      major: book.major,
      track: book.track,
    })
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = await response.json();
  return data.text || "탐구 주제를 생성하지 못했습니다.";
}

// 탐구 주제 모달 표시
function showExploreModal(book) {
  // 기존 모달 제거
  document.getElementById("exploreModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "exploreModal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <div>
          <div class="modal-badge">AI 탐구 주제</div>
          <h2 class="modal-title">${escapeHtml(book.title)}</h2>
          <p class="modal-sub">${escapeHtml(book.major)} · ${escapeHtml(book.author)}</p>
        </div>
        <button class="modal-close" id="modalClose">✕</button>
      </div>
      <div class="modal-body">
        <div class="modal-loading">
          <div class="spinner"></div>
          <span>AI가 탐구 주제를 생성하고 있습니다…</span>
        </div>
        <div class="modal-result" id="modalResult" style="display:none"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // 닫기
  document.getElementById("modalClose").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });

  // AI 호출
  fetchExploreTopics(book).then(text => {
    const loading = modal.querySelector(".modal-loading");
    const result = document.getElementById("modalResult");
    if (!loading || !result) return;

    // 마크다운 숫자 목록 → HTML 변환
    const html = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^(\d+)\.\s+\[(.+?)\][:：]\s*(.+)$/gm,
        `<div class="topic-item"><span class="topic-num">$1</span><div><strong class="topic-head">$2</strong><p class="topic-desc">$3</p></div></div>`)
      .replace(/^(\d+)\.\s+(.+)$/gm,
        `<div class="topic-item"><span class="topic-num">$1</span><p class="topic-plain">$2</p></div>`);

    loading.style.display = "none";
    result.innerHTML = html;
    result.style.display = "block";
  }).catch(() => {
    const loading = modal.querySelector(".modal-loading");
    const result = document.getElementById("modalResult");
    if (loading) loading.style.display = "none";
    if (result) { result.innerHTML = `<p style="color:#c00">탐구 주제 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.</p>`; result.style.display = "block"; }
  });
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
        <button class="btn-explore" data-idx="${idx}">✦ AI 탐구 주제 보기</button>
      </article>
    `;
  }).join("");

  // 탐구 주제 버튼 이벤트 위임 (이벤트 위임 방식 - 카드 자체에 직접 바인딩)
  els.list.querySelectorAll(".btn-explore").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      showExploreModal(items[idx]);
    });
  });

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

      // 후보 선택 UI
      if (cover.matched === false) {
        renderCandidateThumb(thumb, d, cover.candidates);
        continue;
      }

      // 정확 매칭 또는 구버전 캐시 형식({ image, link }) 모두 처리
      const coverImage = cover.image;
      const coverLink = cover.link || "";
      if (!coverImage) {
        thumb.innerHTML = `<div class="ph">표지 없음</div>`;
        continue;
      }
      const img = `<img src="${escapeHtml(coverImage)}" alt="${escapeHtml(d.title)} 표지" loading="lazy" />`;
      if (coverLink) {
        thumb.innerHTML = `<a href="${escapeHtml(coverLink)}" target="_blank" rel="noopener noreferrer">${img}</a>`;
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
