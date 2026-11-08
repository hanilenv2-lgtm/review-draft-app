import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SYSTEM_PROMPT, LENGTH_TARGET, TONE_LABEL, LENGTH_LABEL } from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MOCK = process.env.MOCK_AI === "1";
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR || 10);
// 전체 사용자 합산 하루 생성 횟수 상한. 비용 폭주를 막는 마지막 안전장치.
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 300);

if (!MOCK && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY 환경변수가 필요합니다. (테스트만 하려면 MOCK_AI=1)");
  process.exit(1);
}
const client = MOCK ? null : new Anthropic(); // 키는 ANTHROPIC_API_KEY에서 읽음

const app = express();
app.disable("x-powered-by");
// 호스팅(Render 등)의 프록시 뒤에서 실제 사용자 IP를 읽는다. 없으면 모든 사용자가 한 IP로 묶인다.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
app.use((_req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
  next();
});
app.get("/healthz", (_req, res) => res.send("ok"));
// 사진은 메모리에서만 다루고 디스크에 쓰지 않는다. 요청 본문은 로그에 남기지 않는다.
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/vendor/sortable.min.js", (_req, res) =>
  res.sendFile(path.join(__dirname, "node_modules/sortablejs/Sortable.min.js")),
);

// ---- 간단한 IP별 호출 제한 (API 비용 보호) ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 50_000) hits.clear(); // 메모리 보호
  return list.length > RATE_LIMIT_PER_HOUR;
}
let day = new Date().toDateString(), dayCount = 0;
function overDailyLimit() {
  const today = new Date().toDateString();
  if (today !== day) { day = today; dayCount = 0; }
  return ++dayCount > DAILY_LIMIT;
}

// ---- 입력 검증 ----
const str = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v, maxItems, maxLen = 200) =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];

function validate(body) {
  const errors = [];
  const f = body?.fields || {};
  const fields = {
    name: str(f.name, 100),
    keywords: strList(f.keywords, 5, 30),
    price: str(f.price, 50),
    goods: strList(f.goods, 10),
    bads: strList(f.bads, 10),
    date: str(f.date, 30),
    location: str(f.location, 100),
    menu: str(f.menu, 200),
    wait: str(f.wait, 50),
    companion: str(f.companion, 50),
    revisit: str(f.revisit, 100),
    tone: TONE_LABEL[f.tone] ? f.tone : "comfy",
    length: LENGTH_TARGET[f.length] ? f.length : "normal",
    sample: str(f.sample, 3000),
  };
  if (body?.confirmed !== true) errors.push("사실 확인 체크박스를 선택해 주세요.");
  if (!fields.name) errors.push("업체명 또는 제품명을 입력해 주세요.");
  if (fields.keywords.length < 1) errors.push("키워드를 1개 이상 입력해 주세요.");
  if (!fields.price) errors.push("실제로 낸 금액을 입력해 주세요.");
  if (fields.goods.length < 1) errors.push("좋았던 점을 1개 이상 입력해 주세요.");
  if (fields.bads.length < 1) errors.push("아쉬웠던 점을 1개 이상 입력해 주세요.");

  const mode = ["new", "rewrite", "shorter"].includes(body?.mode) ? body.mode : "new";
  const rawPhotos = Array.isArray(body?.photos) ? body.photos : [];
  const photos = [];
  for (const p of rawPhotos.slice(0, 16)) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(p?.data || "");
    if (!m) { errors.push("사진 형식이 올바르지 않아요."); break; }
    if (m[2].length > 4_000_000) { errors.push("사진 한 장의 용량이 너무 커요."); break; }
    photos.push({ media_type: `image/${m[1]}`, data: m[2], memo: str(p.memo, 100) });
  }
  const photoCount = mode === "shorter" ? Number(body?.photoCount) || 0 : photos.length;
  if (mode !== "shorter" && (photos.length < 1 || photos.length > 15))
    errors.push("사진은 1~15장이어야 해요.");

  let previous = null;
  if (mode === "shorter") {
    previous = str(body?.previousBody, 8000);
    if (!previous) errors.push("줄일 본문이 없어요.");
    if (photoCount < 1 || photoCount > 15) errors.push("사진 수 정보가 올바르지 않아요.");
  }
  return { errors, fields, photos, mode, previous, photoCount };
}

// ---- 프롬프트 조립 ----
function factsText(f, photoCount) {
  const line = (k, v) => (v ? `- ${k}: ${v}\n` : "");
  return (
    "<user_input>\n" +
    line("업체명/제품명", f.name) +
    line("키워드", f.keywords.join(", ")) +
    line("실제로 낸 금액", f.price) +
    `- 좋았던 점:\n${f.goods.map((g) => `  - ${g}`).join("\n")}\n` +
    `- 아쉬웠던 점:\n${f.bads.map((b) => `  - ${b}`).join("\n")}\n` +
    line("방문일/구매일", f.date) +
    line("위치", f.location) +
    line("주문 메뉴/구매 옵션", f.menu) +
    line("대기시간", f.wait) +
    line("같이 간 사람", f.companion) +
    line("재방문/재구매 의사", f.revisit) +
    "</user_input>\n" +
    "입력되지 않은 항목은 사용자가 알려주지 않은 것이다. 추측해서 채우지 않는다.\n\n" +
    `- 말투: ${TONE_LABEL[f.tone]}\n` +
    `- 글 길이: ${LENGTH_LABEL[f.length]} (본문 공백 포함 ${LENGTH_TARGET[f.length]}자 안팎)\n` +
    `- 사진 수: ${photoCount}장 ([사진 1]~[사진 ${photoCount}])\n` +
    (f.sample ? `\n<writing_sample>\n${f.sample}\n</writing_sample>\n` : "")
  );
}

function buildContent(v) {
  const { fields, photos, mode, previous, photoCount } = v;
  if (mode === "shorter") {
    const target = Math.round(Math.min(LENGTH_TARGET[fields.length], previous.length) * 0.6);
    return [{
      type: "text",
      text:
        factsText(fields, photoCount) +
        `\n<previous_body>\n${previous}\n</previous_body>\n\n` +
        `위 본문을 공백 포함 ${target}자 안팎으로 줄여서 다시 써라. 새로운 사실을 더하지 말고, ` +
        `[사진 1]~[사진 ${photoCount}] 표시와 아쉬웠던 점, 마지막 요약, "직접 비용을 내고 이용한 후기입니다." 문장은 유지한다. ` +
        `제목·해시태그·사실 확인 목록도 줄인 본문에 맞게 다시 출력한다. ` +
        `사진은 이번에 다시 보내지 않았으므로, 기존 본문에 없던 사진 내용은 새로 쓰지 않는다.`,
    }];
  }
  const content = [];
  photos.forEach((p, i) => {
    content.push({ type: "text", text: `[사진 ${i + 1}]${p.memo ? ` 사용자 메모: ${p.memo}` : ""}` });
    content.push({ type: "image", source: { type: "base64", media_type: p.media_type, data: p.data } });
  });
  content.push({
    type: "text",
    text:
      factsText(fields, photos.length) +
      (mode === "rewrite"
        ? "\n같은 사실로 이전과 다른 구성과 문장으로 다시 써라. 사실은 더하지 않는다."
        : "\n위 사진과 입력으로 블로그 후기 초안을 써라."),
  });
  return content;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    titles: { type: "array", items: { type: "string" } },
    body: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
    check_items: { type: "array", items: { type: "string" } },
  },
  required: ["titles", "body", "hashtags", "check_items"],
  additionalProperties: false,
};

async function callModel(content) {
  if (MOCK) return mockResult(content);
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new UserError("이 내용으로는 글을 만들 수 없어요. 입력을 확인해 주세요.");
  if (res.stop_reason === "max_tokens") throw new UserError("글이 너무 길어 중간에 끊겼어요. 다시 시도해 주세요.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return parseJson(text);
}

class UserError extends Error {}

function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new UserError("AI 응답을 읽지 못했어요. 다시 시도해 주세요.");
}

// ---- 생성 결과 점검: 모델이 규칙을 어겨도 사용자에게 보이게 한다 ----
const BANNED = [
  [/오늘은[^.\n]{0,40}소개해\s*드리/, "\"오늘은 ~를 소개해 드리겠습니다\""],
  [/결론적으로/, "\"결론적으로\""],
  [/강력\s*추천/, "\"강력 추천\""],
  [/인생\s*맛집/, "\"인생 맛집\""],
  [/라고\s*할\s*수\s*있습니다/, "\"~라고 할 수 있습니다\""],
];
const DISCLOSURE = "직접 비용을 내고 이용한 후기입니다.";
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

function postProcess(raw, photoCount, length) {
  const warnings = [];
  const out = {
    titles: strList(raw?.titles, 3, 200),
    body: typeof raw?.body === "string" ? raw.body.trim() : "",
    hashtags: [],
    check_items: strList(raw?.check_items, 30, 400),
  };
  if (!out.body) throw new UserError("본문이 비어 있어요. 다시 시도해 주세요.");
  while (out.titles.length < 3) out.titles.push(out.titles[0] || "");

  const tags = [...new Set(strList(raw?.hashtags, 15, 40)
    .map((t) => "#" + t.replace(/^#+/, "").replace(/\s+/g, "")).filter((t) => t.length > 1))];
  out.hashtags = tags.slice(0, 10);
  if (out.hashtags.length < 5) warnings.push(`해시태그가 ${out.hashtags.length}개예요. 5개 이상으로 채워 주세요.`);

  if (!out.body.includes(DISCLOSURE)) {
    out.body = `${DISCLOSURE}\n\n${out.body}`;
    warnings.push("필수 문구가 빠져 있어 본문 첫머리에 자동으로 넣었어요.");
  }
  for (const [re, label] of BANNED) if (re.test(out.body)) warnings.push(`금지 표현 ${label}이 들어 있어요. 고쳐 주세요.`);

  const emojis = out.body.match(EMOJI_RE) || [];
  if (emojis.length > 3) warnings.push(`이모지가 ${emojis.length}개예요. 3개 이하로 줄여 주세요.`);

  const used = new Set([...out.body.matchAll(/\[사진\s*(\d+)\]/g)].map((m) => Number(m[1])));
  const missing = [];
  for (let i = 1; i <= photoCount; i++) if (!used.has(i)) missing.push(i);
  const extra = [...used].filter((n) => n < 1 || n > photoCount);
  if (missing.length) warnings.push(`본문에 [사진 ${missing.join("], [사진 ")}] 위치가 없어요.`);
  if (extra.length) warnings.push(`없는 사진 번호 [사진 ${extra.join("], [사진 ")}]가 들어 있어요.`);

  const target = LENGTH_TARGET[length];
  const len = out.body.length;
  if (len > target * 1.5) warnings.push(`본문이 ${len}자로 목표(${target}자 안팎)보다 길어요.`);
  return { ...out, warnings };
}

// ---- API ----
app.post("/api/generate", async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: "요청이 너무 많아요. 잠시 후 다시 시도해 주세요." });
  const v = validate(req.body);
  if (v.errors.length) return res.status(400).json({ error: v.errors.join("\n") });
  if (overDailyLimit()) return res.status(503).json({ error: "오늘 사용량이 모두 찼어요. 내일 다시 이용해 주세요." });
  try {
    const raw = await callModel(buildContent(v));
    res.json(postProcess(raw, v.photoCount, v.fields.length));
  } catch (err) {
    if (err instanceof UserError) return res.status(422).json({ error: err.message });
    if (err instanceof Anthropic.RateLimitError) return res.status(503).json({ error: "AI 사용량이 많아요. 잠시 후 다시 시도해 주세요." });
    if (err instanceof Anthropic.APIConnectionError) return res.status(503).json({ error: "AI 서버에 연결하지 못했어요." });
    if (err instanceof Anthropic.APIError) {
      console.error("Claude API error", err.status, err.message);
      return res.status(502).json({ error: "AI 호출 중 오류가 났어요. 다시 시도해 주세요." });
    }
    console.error("unexpected", err?.message);
    res.status(500).json({ error: "알 수 없는 오류가 났어요." });
  }
  // v.photos는 이 함수가 끝나면 참조가 사라져 메모리에서 정리된다. 저장하지 않는다.
});

// ---- 테스트용 가짜 응답 (MOCK_AI=1) ----
function mockResult(content) {
  const n = content.filter((c) => c.type === "image").length || 3;
  const marks = Array.from({ length: n }, (_, i) => `[사진 ${i + 1}]\n사진 ${i + 1}에 대한 설명 문단입니다.`).join("\n\n");
  return {
    titles: ["테스트 제목 하나", "테스트 제목 둘", "테스트 제목 셋"],
    body: `${DISCLOSURE}\n\n퇴근길에 들른 곳이에요.\n\n${marks}\n\n낸 금액: 18,000원 / 좋았던 점: 국물이 진함 / 아쉬웠던 점: 대기 30분`,
    hashtags: ["테스트", "#후기", "맛집", "점심", "국밥"],
    check_items: ["사진 추정: 사진 2의 메뉴판 가격은 흐려서 확인이 필요해요.", "가림 필요: 사진 3에 다른 손님 얼굴이 보여요."],
  };
}

app.listen(PORT, () => console.log(`http://localhost:${PORT} (${MOCK ? "MOCK" : MODEL})`));
