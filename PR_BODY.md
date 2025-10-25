요약
- 프로젝트 메타데이터(도서 제목: book_title, 저자: author_name, 번역자: translator_name)를 DB/서버/클라이언트에 추가합니다.
- 원문(origin) 업로드 분석(프로파일) 잡 상태를 타임라인 및 우측 패널에 표시합니다.
- 프로젝트 프로필 편집 UI를 재작성하고 자동저장(autosave), 검증, 상태 배지(저장중/저장됨/오류)를 도입했습니다. 번역자는 로그인 사용자명으로 기본값이 설정됩니다.
- 사용자의 UI 로케일(preferred_language)을 서버에 저장/불러오는 API와 훅을 추가했습니다.
- 번역 파이프라인 문서(`docs/2.번역프로세스상세.md`)를 새로 추가했습니다.

주요 변경사항 (파일/영역별 요약)
1) DB / 서버 (server)
- DB 스키마: `server/db-init.sql`, `server/db-postgredb-schema.sql`
  - `translationprojects`에 컬럼 추가: `book_title`, `author_name`, `translator_name` (NULL 허용)
- API · 로직: `server/index.ts`
  - 프로젝트 CRUD(POST/PUT/GET/list/latest) 쿼리와 응답에 새 필드 반영
  - 프로젝트 생성 시 입력 정리 및 기본값 보정(예: book_title 기본화, 번역자 기본: 현재 사용자)
  - PUT(업데이트)에서 기존 값 보존 및 입력 정리 구현
  - GET/PUT `/api/user/preferences` 추가 (preferred_language)
  - 헬퍼 추가: `trimOrNull`, `getUserDisplayName`
- 평가 라우트: `server/routes/evaluation.ts`
  - 프로젝트 프로필 로딩 시 book/author/translator 포함 + meta.author 통합 처리

2) 프론트엔드 (web)
- `web/src/components/project/ProjectProfileCard.tsx`
  - 프로필 폼 재구성: `bookTitle`, `authorName`, `translatorName`, `context`, `translationDirection`, `notes`
  - 자동저장(Auto-save) + 로컬 검증 + 상태 배지
  - 번역자 기본값: 로그인 사용자명(읽기전용)
- `web/src/components/layout/RightPanel.tsx`
  - origin 분석(job) 상태 반영(queued/inProgress/completed/failed/ready)
  - preview 탭/프로필 레이아웃 정리
- `web/src/components/chat/ChatOrchestrator.tsx`
  - 타임라인에 origin 단계 상태/상세 메시지 노출
- `web/src/hooks/useProjectContext.ts`
  - profile job(원문 분석) 상태 반영 로직 추가
- `web/src/hooks/useUILocale.ts`
  - preferred_language 서버 동기화(읽기/쓰기)
- `web/src/services/api.ts`
  - 프로젝트 update에 `book_title`, `author_name`, `translator_name` 필드 추가
  - `userPreferences` / `updateUserPreferences` 추가
- `web/src/types/domain.ts`
  - ProjectSummary/ProjectContent 등 타입 확장 (book/author/translator)
- `web/src/locales/en.json`, `web/src/locales/ko.json`
  - 타임라인 원문 분석 메시지 키 추가

3) 문서
- `docs/2.번역프로세스상세.md` 추가 — 번역 파이프라인(TDM/BDM) 상세 문서

DB 마이그레이션 (배포 전 필수)
- 운영 DB에 아래 SQL을 적용하세요:
```sql
ALTER TABLE translationprojects ADD COLUMN book_title TEXT;
ALTER TABLE translationprojects ADD COLUMN author_name TEXT;
ALTER TABLE translationprojects ADD COLUMN translator_name TEXT;
```

테스트 가이드 (핵심 시나리오)
- API / DB
  - 컬럼 추가 후 `POST /api/projects`에 새 필드 포함하여 생성 → `GET /api/projects/:id`에서 값 확인
  - `PUT /api/projects/:id`에서 필드 미전송 시 기존 값 유지되는지 확인
- 프론트엔드
  - `ProjectProfileCard` 입력 후 자동저장 동작, 상태 배지, 필수 입력 검증 확인
  - 원문 업로드 → profile job 생성 시 타임라인(queued → inProgress → completed/failed) 반영 확인
  - 로케일 변경 시 `user/preferences`가 업데이트되는지 확인

권장 PR 체크리스트
- [ ] DB ALTER 쿼리 적용 및 롤백 계획 준비
- [ ] 서버: 프로젝트 create/update/list/get에 새 필드 정상 반영
- [ ] 서버: `getUserDisplayName` 예외/로깅 처리 검토
- [ ] 웹: `ProjectProfileCard` autosave/검증/상태 배지 동작 확인
- [ ] UI: RightPanel/Chat 타임라인의 origin 상태 메시지 정상 노출
- [ ] i18n: en/ko 신규 키 반영 확인
- [ ] 문서: `docs/2.번역프로세스상세.md` 리뷰

간단한 PR 설명
- 프로젝트 메타(도서/저자/번역자) 필드 추가 — DB/서버/클라이언트 연동. 원문 분석(프로파일) 상태를 타임라인/우측 패널에 표시. 프로젝트 프로필 편집을 자동저장 방식으로 개선. 사용자 UI 로케일 동기화 추가. 번역 파이프라인 문서 추가.
