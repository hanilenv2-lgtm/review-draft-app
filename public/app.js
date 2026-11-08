"use strict";
const $ = (s, el = document) => el.querySelector(s);
const MAX_PHOTOS = 15, MAX_SIDE = 1600, JPEG_Q = 0.85;

const state = { photos: [], lastFields: null, result: null, bodyDirty: false, busy: false };
let nextId = 1;

// ---------- 사진 ----------
async function decode(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

// 긴 변 1600px 이하 JPEG로 다시 그린다. 캔버스로 다시 그리면 EXIF(GPS 위치 등)도 빠진다.
async function resize(file) {
  const src = await decode(file);
  const w = src.width, h = src.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const canvas = document.createElement("canvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(src, 0, 0, cw, ch);
  if (src.close) src.close();
  return canvas.toDataURL("image/jpeg", JPEG_Q);
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  const room = MAX_PHOTOS - state.photos.length;
  if (list.length > room) toast(`사진은 최대 ${MAX_PHOTOS}장이에요. ${Math.max(room, 0)}장만 추가할게요.`);
  let failed = 0;
  for (const f of list.slice(0, Math.max(room, 0))) {
    try {
      state.photos.push({ id: nextId++, data: await resize(f), memo: "" });
      renderPhotos();
    } catch { failed++; }
  }
  if (failed) toast(`${failed}장은 열 수 없었어요. HEIC라면 JPG로 바꾸거나 '가장 호환성 높은' 형식으로 촬영해 주세요.`);
  refresh();
}

function renderPhotos() {
  const ol = $("#photoList");
  ol.innerHTML = "";
  state.photos.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "photo";
    li.dataset.id = p.id;
    li.innerHTML = `
      <span class="handle" aria-label="순서 바꾸기">≡</span>
      <img alt="">
      <div class="meta"><span class="num">[사진 ${i + 1}]</span>
        <input type="text" maxlength="100" placeholder="한 줄 메모 (선택)" aria-label="사진 ${i + 1} 메모"></div>
      <button type="button" class="del" aria-label="사진 ${i + 1} 삭제">✕</button>`;
    $("img", li).src = p.data;
    const memo = $("input", li);
    memo.value = p.memo;
    memo.addEventListener("input", () => { p.memo = memo.value; });
    $(".del", li).addEventListener("click", () => {
      state.photos = state.photos.filter((x) => x.id !== p.id);
      renderPhotos(); refresh();
    });
    ol.appendChild(li);
  });
  $("#photoCount").textContent = `${state.photos.length}/${MAX_PHOTOS}`;
}

Sortable.create($("#photoList"), {
  handle: ".handle", animation: 150, ghostClass: "sortable-ghost",
  onEnd() {
    const order = [...$("#photoList").children].map((li) => Number(li.dataset.id));
    state.photos.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    renderPhotos();
  },
});

$("#fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
const drop = $("#drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });

// ---------- 여러 줄 입력 (좋았던 점 / 아쉬웠던 점) ----------
document.querySelectorAll(".multi").forEach((box) => {
  const rows = $(".rows", box);
  const ph = box.dataset.key === "goods" ? "예: 국물이 진하고 고기가 많았어요" : "예: 점심시간 대기 30분";
  const addRow = (focus) => {
    if (rows.children.length >= 10) return;
    const r = document.createElement("div");
    r.className = "r";
    r.innerHTML = `<input type="text" maxlength="200" placeholder="${ph}"><button type="button" aria-label="삭제">✕</button>`;
    $("input", r).addEventListener("input", refresh);
    $("button", r).addEventListener("click", () => {
      if (rows.children.length > 1) r.remove(); else $("input", r).value = "";
      refresh();
    });
    rows.appendChild(r);
    if (focus) $("input", r).focus();
  };
  addRow(false);
  $(".add", box).addEventListener("click", () => addRow(true));
});

// ---------- 입력 수집 / 검증 ----------
const val = (id) => $("#" + id).value.trim();
const multiVals = (key) => [...document.querySelectorAll(`.multi[data-key=${key}] input`)].map((i) => i.value.trim()).filter(Boolean);
const keywords = () => [...new Set(val("keywords").split(/[,，\n]/).map((s) => s.trim()).filter(Boolean))];

function collect() {
  return {
    name: val("name"), keywords: keywords(), price: val("price"),
    goods: multiVals("goods"), bads: multiVals("bads"),
    date: val("date"), location: val("location"), menu: val("menu"), wait: val("wait"),
    companion: val("companion"), revisit: val("revisit"),
    tone: $("input[name=tone]:checked").value, length: $("input[name=length]:checked").value,
    sample: val("sample"),
  };
}

function missingList(f) {
  const m = [];
  if (state.photos.length < 1) m.push("사진 1장 이상");
  if (!f.name) m.push("업체명 또는 제품명");
  if (f.keywords.length < 1) m.push("키워드 1개 이상");
  if (f.keywords.length > 5) m.push("키워드는 5개까지");
  if (!f.price) m.push("실제로 낸 금액");
  if (f.goods.length < 1) m.push("좋았던 점 1개 이상");
  if (f.bads.length < 1) m.push("아쉬웠던 점 1개 이상");
  return m;
}

function refresh() {
  const kws = keywords();
  $("#kwChips").innerHTML = "";
  kws.forEach((k, i) => {
    const c = document.createElement("span");
    c.className = "chip" + (i >= 5 ? " over" : "");
    c.textContent = k;
    $("#kwChips").appendChild(c);
  });
  // 체크박스를 선택하지 않으면 생성 버튼 비활성화
  $("#generate").disabled = !$("#confirmed").checked || state.busy;
  $("#missing").textContent = "";
}
["name", "keywords", "price", "confirmed"].forEach((id) => $("#" + id).addEventListener("input", refresh));
$("#confirmed").addEventListener("change", refresh);

// ---------- 생성 ----------
async function request(payload, label) {
  state.busy = true; refresh();
  $("#loadingText").textContent = label;
  $("#loading").hidden = false;
  try {
    const res = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ error: "서버 응답을 읽지 못했어요." }));
    if (!res.ok) throw new Error(data.error || "오류가 났어요.");
    return data;
  } finally {
    state.busy = false; $("#loading").hidden = true; refresh();
  }
}

const photoPayload = () => state.photos.map((p) => ({ data: p.data, memo: p.memo.trim() }));

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!$("#confirmed").checked) return;
  const fields = collect();
  const miss = missingList(fields);
  if (miss.length) { $("#missing").textContent = "아직 필요한 항목: " + miss.join(", "); return; }
  try {
    const data = await request({ mode: "new", confirmed: true, fields, photos: photoPayload() }, "글을 쓰는 중이에요… (30초~1분)");
    state.lastFields = fields; state.lastPhotoCount = state.photos.length;
    showResult(data);
  } catch (err) { toast(err.message, 4000); }
});

$("#rewrite").addEventListener("click", async () => {
  if (state.bodyDirty && !confirm("다시 쓰면 본문에서 고친 내용이 사라져요. 계속할까요?")) return;
  if (state.photos.length !== state.lastPhotoCount) {
    toast("사진 수가 바뀌었어요. '입력 수정'에서 다시 만들어 주세요."); return;
  }
  try {
    const data = await request({ mode: "rewrite", confirmed: true, fields: state.lastFields, photos: photoPayload() }, "다시 쓰는 중이에요…");
    showResult(data);
  } catch (err) { toast(err.message, 4000); }
});

$("#shorter").addEventListener("click", async () => {
  try {
    // 사진은 다시 보내지 않고, 화면에서 고친 본문을 기준으로 줄인다.
    const data = await request({
      mode: "shorter", confirmed: true, fields: state.lastFields,
      previousBody: $("#body").value, photoCount: state.lastPhotoCount,
    }, "줄이는 중이에요…");
    showResult(data);
  } catch (err) { toast(err.message, 4000); }
});

$("#backToForm").addEventListener("click", () => { $("#form").hidden = false; $("#result").hidden = true; window.scrollTo(0, 0); });

// ---------- 결과 표시 ----------
function showResult(d) {
  state.result = d; state.bodyDirty = false;
  const t = $("#titles");
  t.innerHTML = "";
  d.titles.forEach((title, i) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="radio" name="pickTitle" ${i === 0 ? "checked" : ""} aria-label="제목 ${i + 1} 선택"><input type="text" aria-label="제목 ${i + 1}">`;
    $("input[type=text]", l).value = title;
    t.appendChild(l);
  });
  $("#body").value = d.body;
  $("#hashtags").value = d.hashtags.join(" ");
  updateCount();

  const w = $("#warnings"); w.innerHTML = "";
  d.warnings.forEach((x) => { const li = document.createElement("li"); li.textContent = x; w.appendChild(li); });
  $("#warnBox").hidden = d.warnings.length === 0;

  const c = $("#checks"); c.innerHTML = "";
  const items = d.check_items.length ? d.check_items : ["확인 필요: 본문의 사실(금액·메뉴·날짜)이 입력과 같은지 한 번 더 봐 주세요."];
  items.forEach((x) => {
    const li = document.createElement("li");
    const m = /^(사진 추정|확인 필요|가림 필요)\s*:\s*/.exec(x);
    li.innerHTML = `<input type="checkbox" aria-label="확인함">${m ? `<span class="tag${m[1] === "가림 필요" ? " mask" : ""}"></span>` : ""}<span class="txt"></span>`;
    if (m) $(".tag", li).textContent = m[1];
    $(".txt", li).textContent = m ? x.slice(m[0].length) : x;
    c.appendChild(li);
  });

  $("#form").hidden = true; $("#result").hidden = false;
  window.scrollTo(0, 0);
}

function updateCount() {
  const n = $("#body").value.length;
  const target = { short: 500, normal: 900, long: 1500 }[state.lastFields?.length || "normal"];
  $("#bodyCount").textContent = `${n.toLocaleString()}자 / 목표 ${target}자 안팎`;
}
$("#body").addEventListener("input", () => { state.bodyDirty = true; updateCount(); });

// ---------- 복사 ----------
const pickedTitle = () => {
  const r = $("#titles input[type=radio]:checked");
  return r ? $("input[type=text]", r.parentElement).value.trim() : "";
};
const tagText = () => $("#hashtags").value.trim();

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}

document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  const kind = b.dataset.copy;
  const body = $("#body").value.trim();
  const text = { all: [pickedTitle(), body, tagText()].filter(Boolean).join("\n\n"), title: pickedTitle(), body, tags: tagText() }[kind];
  if (!text) return toast("복사할 내용이 없어요.");
  toast((await copy(text)) ? "복사했어요. 사진은 [사진 번호] 위치에 직접 넣어주세요." : "복사하지 못했어요. 길게 눌러 직접 복사해 주세요.");
}));

// ---------- 공통 ----------
let toastTimer;
function toast(msg, ms = 2500) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

window.addEventListener("beforeunload", (e) => { if (state.photos.length || state.result) { e.preventDefault(); e.returnValue = ""; } });
refresh();
