// MongoDB Collections and Documents Schema
// This file documents the schema for MongoDB collections used in the translation platform
// Similar to db-schema.sql for PostgreSQL, this defines the structure of MongoDB documents

// ==============================================
// Quality Assessments Collection
// ==============================================
// Collection: quality_assessments
// Purpose: 번역 품질 검토 결과를 저장하는 컬렉션
// Usage: 품질 검사 완료 시 결과 저장, 프로젝트별 최신 평가 조회

const qualityAssessmentsSchema = {
  _id: "ObjectId", // MongoDB 자동 생성 ID
  projectId: "String", // 연동 대상 프로젝트 ID (PostgreSQL documents 테이블과 연관)
  jobId: "String?", // 연동 대상 번역 작업 ID (PostgreSQL jobs 테이블과 연관) - 선택 사항
  assessmentId: "String", // nanoid로 생성된 고유 평가 ID
  timestamp: "Date", // 평가 실행 시점

  // 스냅샷 데이터 (평가 시점의 원작/번역문 보존)
  sourceText: "String", // 원작 텍스트 (평가 시점 스냅샷)
  translatedText: "String", // 번역문 텍스트 (평가 시점 스냅샷)

  // 품질 검토 결과 (OpenAI API 응답 구조)
  qualityResult: {
    overallScore: "Number", // 전체 품질 점수 (0-100)

    // 정량적 평가 (각 항목별 점수)
    quantitative: {
      Accuracy: "Number", // 정확성 점수
      Fluency: "Number", // 유창성 점수
      Consistency: "Number", // 일관성 점수
      Style: "Number", // 문체 점수
      Terminology: "Number", // 전문용어 점수
    },

    // 정성적 평가 (언어별 설명)
    qualitative: {
      korean: {
        strengths: ["String"], // 장점 목록
        improvements: ["String"], // 개선점 목록
        overall: "String", // 전체 평가 요약
      },
      english: {
        strengths: ["String"], // 장점 목록 (영문)
        improvements: ["String"], // 개선점 목록 (영문)
        overall: "String", // 전체 평가 요약 (영문)
      },
    },

    // 메타 정보
    meta: {
      modelUsed: "String", // 사용된 AI 모델명
      evaluationTime: "Number", // 평가 소요 시간 (ms)
      textLength: "Number", // 평가 대상 텍스트 길이
      language: "String", // 평가 언어 (ko/en)
    },
  },

  // 부가 정보
  translationMethod: "String", // 번역 방법 ('auto' | 'manual')
  modelUsed: "String", // 품질 검토에 사용된 AI 모델
  userId: "String", // 평가 실행 사용자 ID

  // 타임스탬프
  created_at: "Date", // 생성 시점
  updated_at: "Date", // 수정 시점
};

// 인덱스 설정
const qualityAssessmentsIndexes = [
  { projectId: 1, timestamp: -1 }, // 프로젝트별 최신 조회
  { userId: 1, timestamp: -1 }, // 사용자별 최신 조회
  { assessmentId: 1 }, // 고유 ID 조회
  { projectId: 1, userId: 1, timestamp: -1 }, // 복합 인덱스
];

// ==============================================
// Origin Files Collection (향후 확장용)
// ==============================================
// Collection: origin_files
// Purpose: 업로드된 원본 파일 정보를 저장하는 컬렉션
// Usage: 파일 업로드 시 메타데이터 저장, 파일 버전 관리

const originFilesSchema = {
  _id: "ObjectId",
  projectId: "String", // 연동 프로젝트 ID
  fileName: "String", // 원본 파일명
  fileSize: "Number", // 파일 크기 (bytes)
  fileType: "String", // 파일 타입 (MIME type)

  // 파일 내용
  content: "String", // 파일 텍스트 내용

  // 언어 정보
  detectedLanguage: "String?", // 자동 감지된 언어
  confirmedLanguage: "String?", // 사용자 확인 언어

  // 메타데이터
  uploadedAt: "Date", // 업로드 시점
  userId: "String", // 업로드 사용자

  // 타임스탬프
  created_at: "Date",
  updated_at: "Date",
};

// ==============================================
// Translation Cache Collection (향후 확장용)
// ==============================================
// Collection: translation_cache
// Purpose: 번역 결과 캐싱으로 성능 향상
// Usage: 동일한 텍스트 재번역 시 캐시 활용

const translationCacheSchema = {
  _id: "ObjectId",

  // 캐시 키 (원작 해시)
  sourceHash: "String", // 원작 텍스트의 해시값
  sourceText: "String", // 원작 텍스트

  // 번역 설정
  originLang: "String", // 원본 언어
  targetLang: "String", // 대상 언어
  modelUsed: "String", // 사용된 번역 모델

  // 번역 결과
  translatedText: "String", // 번역된 텍스트

  // 사용 통계
  hitCount: "Number", // 캐시 히트 횟수
  lastUsed: "Date", // 마지막 사용 시점

  // 타임스탬프
  created_at: "Date",
  updated_at: "Date",
};

// 인덱스 설정
const translationCacheIndexes = [
  { sourceHash: 1, originLang: 1, targetLang: 1 }, // 캐시 조회용 복합 인덱스
  { lastUsed: 1 }, // TTL 인덱스 (오래된 캐시 자동 삭제)
];

// ==============================================
// User Preferences Collection (향후 확장용)
// ==============================================
// Collection: user_preferences
// Purpose: 사용자별 설정 및 선호도 저장
// Usage: UI 설정, 번역 선호도, 언어 설정 등

const userPreferencesSchema = {
  _id: "ObjectId",
  userId: "String", // 사용자 ID (고유)

  // UI 설정
  ui: {
    language: "String", // 인터페이스 언어 (ko/en)
    theme: "String", // 테마 설정 (light/dark)
    sidebarCollapsed: "Boolean", // 사이드바 접힌 상태
  },

  // 번역 설정
  translation: {
    defaultOriginLang: "String", // 기본 원본 언어
    defaultTargetLang: "String", // 기본 대상 언어
    preferredModel: "String", // 선호 번역 모델
    autoSave: "Boolean", // 자동 저장 여부
  },

  // 품질 검토 설정
  quality: {
    autoEvaluate: "Boolean", // 번역 완료 시 자동 품질 검토
    preferredLanguage: "String", // 품질 검토 결과 언어
    detailLevel: "String", // 평가 상세도 (basic/detailed)
  },

  // 타임스탬프
  created_at: "Date",
  updated_at: "Date",
};

// 인덱스 설정
const userPreferencesIndexes = [
  { userId: 1 }, // 사용자별 고유 인덱스
];

// ==============================================
// eBook Files Collection
// ==============================================
// Collection: ebook_files
// Purpose: 생성된 eBook 파일(MongoDB 바이너리) 저장
// Usage: eBook 생성 API가 mock/실제 파일을 보관하고 향후 외부 저장소 연동 시 참조

const ebookFilesSchema = {
  _id: "ObjectId",
  ebook_id: "String", // PostgreSQL ebooks.ebook_id 참조
  project_id: "String",
  translation_file_id: "String",
  format: "String",
  filename: "String",
  mime_type: "String",
  size: "Number",
  content: "BinData",
  recommended_quality_assessment_id: "String?",
  created_at: "Date",
  updated_at: "Date",
};

const ebookFilesIndexes = [{ ebook_id: 1 }, { project_id: 1, format: 1 }];

// ==============================================
// Chat Messages Collection
// ==============================================
// Conversation history per project for LLM orchestration

const chatMessagesSchema = {
  _id: "ObjectId",
  project_id: "String",
  role: "String",
  content: "String",
  actions: ["Mixed"],
  metadata: "Object?",
  created_at: "Date",
};

const chatMessagesIndexes = [{ project_id: 1, created_at: 1 }];

// ==============================================
// 컬렉션 요약
// ==============================================

export const mongoSchemaDocumentation = {
  collections: {
    quality_assessments: {
      purpose: "번역 품질 검토 결과 저장",
      schema: qualityAssessmentsSchema,
      indexes: qualityAssessmentsIndexes,
      status: "implemented", // 현재 구현됨
    },

    origin_files: {
      purpose: "업로드된 원본 파일 메타데이터",
      schema: originFilesSchema,
      status: "planned", // 향후 구현 예정
    },

    translation_cache: {
      purpose: "번역 결과 캐싱",
      schema: translationCacheSchema,
      indexes: translationCacheIndexes,
      status: "planned",
    },

    user_preferences: {
      purpose: "사용자별 설정 및 선호도",
      schema: userPreferencesSchema,
      indexes: userPreferencesIndexes,
      status: "planned",
    },

    ebook_files: {
      purpose: "생성된 eBook 파일 바이너리 저장",
      schema: ebookFilesSchema,
      indexes: ebookFilesIndexes,
      status: "implemented",
    },

    chat_messages: {
      purpose: "프로젝트별 LLM 대화 히스토리 저장",
      schema: chatMessagesSchema,
      indexes: chatMessagesIndexes,
      status: "implemented",
    },
  },

  // PostgreSQL과의 연관 관계
  relationships: {
    quality_assessments: {
      projectId: "documents.project_id (PostgreSQL)",
      jobId: "jobs.id (PostgreSQL)",
      userId: "users.user_id (PostgreSQL)",
    },

    ebook_files: {
      ebook_id: "ebooks.ebook_id (PostgreSQL)",
      project_id: "translationprojects.project_id (PostgreSQL)",
    },
  },

  // 데이터 일관성 규칙
  consistencyRules: [
    "quality_assessments.projectId는 PostgreSQL documents 테이블의 project_id와 일치해야 함",
    "quality_assessments.userId는 PostgreSQL users 테이블의 user_id와 일치해야 함",
    "qualityResult는 JSON 스키마 검증을 통과해야 함",
    "timestamp는 UTC 기준으로 저장되어야 함",
    "ebook_files.ebook_id는 PostgreSQL ebooks.ebook_id와 일치해야 함",
  ],
};

// ==============================================
// 사용 예시
// ==============================================

const usageExamples = {
  // 품질 검토 저장
  saveQualityAssessment: {
    collection: "quality_assessments",
    operation: "insertOne",
    document: {
      projectId: "proj_abc123",
      assessmentId: "assess_xyz789",
      timestamp: new Date(),
      sourceText: "안녕하세요",
      translatedText: "Hello",
      qualityResult: {
        overallScore: 91,
        quantitative: {
          Accuracy: 95,
          Fluency: 90,
          Consistency: 88,
          Style: 92,
          Terminology: 90,
        },
      },
      translationMethod: "auto",
      modelUsed: "gpt-4o-mini",
      userId: "user_123",
    },
  },

  // 최신 품질 검토 조회
  getLatestAssessment: {
    collection: "quality_assessments",
    operation: "findOne",
    query: { projectId: "proj_abc123", userId: "user_123" },
    sort: { timestamp: -1 },
  },
};

export default mongoSchemaDocumentation;
