// db-schema-mongo-초기화.js: MongoDB 컬렉션 데이터 전체 삭제 스크립트 (users 관련 컬렉션 제외)
// 실행 전: 반드시 백업 권장!

const { MongoClient } = require("mongodb");

const uri = process.env.MONGO_URI || "mongodb://localhost:27017";
const dbName = process.env.MONGO_DB || "project_t1";

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);

    // 삭제 대상 컬렉션 목록 (users 관련 제외)
    const collections = [
      "quality_assessments",
      "origin_files",
      "translation_cache",
      "user_preferences",
      "translation_files",
      "translation_batches", // 반드시 포함: 각 번역 배치 데이터
    ];

    for (const col of collections) {
      const exists = await db.listCollections({ name: col }).hasNext();
      if (exists) {
        const res = await db.collection(col).deleteMany({});
        console.log(`[MongoDB] Cleared ${col}: ${res.deletedCount} docs`);
      } else {
        console.log(`[MongoDB] Collection not found: ${col}`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("[MongoDB] 초기화 오류:", err);
  process.exit(1);
});
