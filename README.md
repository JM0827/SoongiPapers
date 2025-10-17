# TranslationStudio

TranslationStudio는 번역 프로젝트 관리, 번역 품질 평가, 자동 번역, 파일 업로드/드래그앤드롭, 프로젝트별 번역 이력 관리 등 다양한 기능을 제공하는 통합 번역 스튜디오입니다.

## 주요 폴더 구조

```
Project-T1/
├── web/            # 메인 프론트엔드(React+Vite, Tailwind, TypeScript)
│   ├── src/        # 페이지, 컴포넌트, hooks, store 등 UI 구현
│   ├── public/     # 정적 자산
│   ├── vite.config.ts
│   └── tsconfig.*
├── server/         # 백엔드(Fastify, TypeScript, PostgreSQL, MongoDB)
│   ├── routes/     # API 라우트
│   ├── agents/     # 번역·교정·품질 에이전트 구현
│   ├── models/     # DB 모델
│   └── services/   # 공통 서비스 & 설정
├── packages/
│   └── ai-image-gen  # 로컬 AI 이미지 생성 유틸(@bookko/ai-image-gen)
├── package.json    # 루트 패키지(모노레포)
├── pnpm-lock.yaml  # 패키지 락파일
├── .gitignore      # Git 무시 파일
└── README.md       # 프로젝트 설명서
```

## 주요 기능

- **프로젝트/번역 파일 관리**: 프로젝트 생성, 편집, 삭제, 번역 이력 관리
- **사이드바/메인 레이아웃**: 좌측 프로젝트 목록, 우측 번역/원문 에디터
- **드래그앤드롭/파일 업로드**: TXT 파일 업로드 및 자동 저장
- **언어 감지/자동 번역**: 원문 언어 자동 감지, 번역 API 연동
- **번역 품질 평가**: 번역 결과에 대한 품질 점수 및 시각화(차트)
- **MongoDB/PGSQL 하이브리드**: 번역 배치/결과를 MongoDB와 PostgreSQL에 동시 저장
- **반응형 UI**: 데스크탑/모바일 모두 지원

## 설치 및 실행

### 1. 의존성 설치

루트 및 각 패키지 폴더에서:

```bash
pnpm install
# 또는
npm install
```

루트에서 실행하면 로컬 패키지 `@bookko/ai-image-gen`(경로 `packages/ai-image-gen`)이 자동으로 링크됩니다.

### 2. 개발 서버 실행

프론트엔드:

```bash
cd web
npm run dev
```

백엔드:

```bash
cd server
npm run dev
```

### 3. 환경 변수

`.env` 파일을 각 패키지(web, server)에 복사/생성하여 API 키, DB 접속 정보 등 입력

### 4. DB 초기화(선택)

- PostgreSQL: `server/db-schema.sql`
- MongoDB: `server/db-schema-mongo.js`

## 배포

- 빌드: `npm run build` (web, server 각각)
- 배포: 빌드 산출물을 서버에 업로드

## 기여 및 문의

- Pull Request, Issue 환영
- 문의: GitHub Issue 또는 이메일

---

> 본 프로젝트는 번역 자동화 및 품질 평가를 위한 상용 목적이므로, 사용 승인이 필요합니다.


.env file 참조삼아 올려..
/web/.env
```
  VITE_HMR_HOST=project-t1.com
  VITE_ALLOWED_HOSTS=project-t1.com,project-t1.local,localhost
```
/server/.env
```
# Environment variables for Project-T1 backend
# NOTE: if your Postgres password contains special chars like '@', they must be percent-encoded in the DATABASE_URL
# Password in this file contains an '@' so it's encoded as %40 in DATABASE_URL below.
DATABASE_URL=postgresql://postgres:_<password>_@localhost:5432/postgres
# Also provide PG_* (used by some helpers) and PG_URI (used by db-init).
PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=_<password>_
PG_DATABASE=postgres
PG_URI=postgresql://postgres:_<password>_@localhost:5432/postgres

MONGO_URI=mongodb://localhost:27017/project_t1
MONGO_DB=project_t1

#google cloud console에 등록이 맞아야 함.
GOOGLE_CLIENT_ID=<클라이언트아이디>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<클라이언트 시크릿>
#GOOGLE_CALLBACK_URL=http://192.168.12.137:8080/api/auth/google/callback
#OAUTH_SUCCESS_REDIRECT=http://192.168.12.137:5174/oauth/callback

GOOGLE_CALLBACK_URL=http://project-t1.com:8080/api/auth/google/callback
OAUTH_SUCCESS_REDIRECT=http://project-t1.com:5174/oauth/callback
VITE_OAUTH_URL=http://project-t1.com:8080/api/auth/google
CLIENT_ORIGIN=http://project-t1.com:5174
# JWT secret for local dev (change before production)
JWT_SECRET=dev_jwt_secret_change_me

OPENAI_API_KEY=<OPENAI API KEY>
# OPENAI_MODEL=gpt-4.1-mini
OPENAI_EMBED_MODEL=text-embedding-3-small

# Optional overrides
# PORT=8080
```


