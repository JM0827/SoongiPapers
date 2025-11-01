import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeTargetExcerpt } from "../proofreadingAgent";

test("returns target when it differs from source and is English", () => {
  const source =
    "엄마의 얼굴엔 피곤이 노인의 상념이 되어 잠겨 들어가고 있었다.";
  const target =
    "Fatigue crept over Mother’s face, sinking in like an old man lost in thought.";

  const result = sanitizeTargetExcerpt(source, target);

  assert.equal(result, target);
});

test("returns null when target matches source text", () => {
  const source = "어머, 어머님 걷는게 왜 그러세요? 다리 다치신 거 아니에요?";
  const target = "어머, 어머님 걷는게 왜 그러세요? 다리 다치신 거 아니에요?";

  const result = sanitizeTargetExcerpt(source, target);

  assert.equal(result, null);
});

test("returns null when target is predominantly Hangul with little Latin text", () => {
  const source = "식사하는 내내 엄마의 어색한 걸음이 신경 쓰였다.";
  const target = "엄마의 어색한 걸음이 너무 걱정돼요 omg";

  const result = sanitizeTargetExcerpt(source, target);

  assert.equal(result, null);
});

test("returns null when target is empty or whitespace", () => {
  const source =
    "사람들은 두어 명씩 열을 지어 이동하며 공항 출구에서 기다리고 있던 버스에 올라탔다.";

  assert.equal(sanitizeTargetExcerpt(source, ""), null);
  assert.equal(sanitizeTargetExcerpt(source, "   \n  "), null);
});

test("returns null when target only differs by trailing whitespace", () => {
  const source =
    "나는 해수가 잘 앉아 있는지 불편한 곳은 아닌지 연거푸 돌아보았다.";
  const target =
    "나는 해수가 잘 앉아 있는지 불편한 곳은 아닌지 연거푸 돌아보았다.   ";

  const result = sanitizeTargetExcerpt(source, target);

  assert.equal(result, null);
});

test("returns target when English text includes some Hangul but enough Latin characters", () => {
  const source = "식사하는 내내 엄마의 어색한 걸음이 신경 쓰였다.";
  const target =
    "Watching eomma limp through the terminal made me worry even more about her pace.";

  const result = sanitizeTargetExcerpt(source, target);

  assert.equal(result, target);
});
