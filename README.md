# 후기 초안 도우미

사진(1~15장)과 메모를 받아 네이버 블로그용 후기 초안(제목 3개, 본문, 해시태그, 사실 확인 목록)을 만드는 모바일용 한 페이지 웹앱.

## 실행

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

- `PORT` (기본 3000), `CLAUDE_MODEL` (기본 `claude-opus-5-5`), `RATE_LIMIT_PER_HOUR` (IP당, 기본 30)
- API 없이 화면만 확인: `MOCK_AI=1 npm start`

## 구조
- `prompt.js` 글쓰기 지시문 (원문 + 보충 규칙)
- `server.js` 입력 검증 → Claude 호출(사진 포함) → 결과 자동 점검(금지 표현, 이모지 수, 필수 문구, [사진 N] 누락, 글자 수)
- `public/` 화면. 사진은 브라우저에서 긴 변 1600px JPEG로 줄여서 보내고, 서버는 디스크에 쓰지 않음
