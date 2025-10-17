-- db-schema-초기화.sql: 모든 데이터 삭제(초기화), 단 users/service_plans/user_subscriptions 데이터는 보존

-- 1. FK 제약조건 해제 (필요시)
-- (PostgreSQL은 TRUNCATE CASCADE로도 가능)

-- 2. 데이터 삭제 (보존 테이블 제외)
TRUNCATE TABLE jobs RESTART IDENTITY CASCADE;
TRUNCATE TABLE licenses RESTART IDENTITY CASCADE;
TRUNCATE TABLE proofread_runs RESTART IDENTITY CASCADE;
TRUNCATE TABLE translation_memory_versions RESTART IDENTITY CASCADE;
TRUNCATE TABLE translation_memory RESTART IDENTITY CASCADE;
TRUNCATE TABLE translation_drafts RESTART IDENTITY CASCADE;
TRUNCATE TABLE translation_batches RESTART IDENTITY CASCADE;
TRUNCATE TABLE translationprojects RESTART IDENTITY CASCADE;
-- users, service_plans, user_subscriptions는 보존

-- 3. (선택) 시퀀스 리셋 (TRUNCATE RESTART IDENTITY로 대체)
-- ALTER SEQUENCE ... RESTART WITH 1;

-- 4. FK 제약조건 복구 (필요시)

-- 완료
