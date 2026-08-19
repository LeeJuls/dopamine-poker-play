'use strict';

/**
 * proto/engine/aiRandom.js
 *
 * ★L1(합법 무작위) 결정 로직 — S1에서 engine.js `decide()`에 인라인으로 있던 코드를
 * ★그대로(로직 변경 0)★ 옮겨 이름 붙인 것뿐이다. S3에서 L2/L3/프로브 4종이 "지금 이
 * 축은 자기 전문이 아니다"라며 위임(fallback)할 공통 구현이 필요해졌는데, engine.js가
 * ai.js를 require하고 ai.js가 engine.js를 require하면 순환 참조가 생긴다 — 그래서 이
 * L1 로직을 순환 없는 이 저수준 모듈로 옮기고, engine.js의 `decide()`와 ai.js의 모든
 * "비전문 축" 모두가 이 함수들을 호출한다(같은 함수 = 같은 바이트 결과, 중복 없음).
 *
 * ★L1은 동결 대상이다(S3 plan 게이트②) — 이 파일의 4개 함수는 engine.js S1/S2에
 * 있던 코드를 문자 그대로 복사했고, 이후 임의 수정 금지(수정하려면 사유+동결 해제
 * 절차 필요 — PM 소관).
 *
 * ★2026-08-16 동결 해제(오너 지시 룰 변경 — J-4/J-5) — 수정 2건, 둘 다 "오너 지시
 * 룰 변경에 따른 합법성 유지"가 사유다(새 전략·최적화 아님):
 *  ① randomSubmit — J-4(조커 제출 상한 1)로 무작위 추출 모집단에서 여분 조커를
 *     걸러낸다. 안 걸러내면 손패에 조커가 2장 이상 있을 때 확률적으로 2장이 같이
 *     뽑혀 handleSubmit의 새 권위 검증(조커≥2 거부)에 걸린다 — L1이 완주 100%를
 *     못 지키게 되므로 "합법성 유지"가 곧 이 함수의 존재 이유(S1 게이트③)와 직결된다.
 *  ② randomActionChoice — J-5(캐릭터 기본 스킬)로 옵션 배열에 charSkillId가 항상
 *     섞여 있어 "균등 추출" 로직 자체는 무변경으로 이미 CHAR_SKILL을 자동 편입한다.
 *     단 선택 결과가 'CHAR_SWAP'이면 폐기할 카드(swapDiscard)도 함께 결정해야
 *     페이로드가 합법이 된다 — 이 분기만 추가.
 *  ③ ★W1(2026-08-17, 오너 지시 룰변경 — director 스펙 A ③ 가변 제출 2~5장, 동결
 *     해제 사유③) — randomSubmit이 이제 장수도 균등 무작위로 고른다(kMin..kMax,
 *     count 드로우 1회 추가). "L1(합법 무작위)만 합법 집합이 210으로 커진다"(스펙 A
 *     문언 그대로) — 이 파일에 combinationsK 열거를 새로 두지 않고, 장수를 먼저
 *     뽑은 뒤 그 장수만큼 sampleWithoutReplacement하는 것으로 "균등 무작위 부분집합"과
 *     동등한 커버리지를 얻는다(엄밀한 균등분포는 장수마다 조합 수가 달라 다르지만,
 *     L1의 정의는 "합법 무작위"이지 "균등 분포 무작위"가 아니다 — 기존 EXCHANGE도
 *     같은 방식: count 먼저 뽑고 그 수만큼 표본추출). ①②와 동일 성격 — "새 전략/
 *     최적화"가 아니라 "룰 변경에 따른 합법 공간 확장 반영".
 *  ④ ★G-A-10(2026-08-18, 오너 지시 룰변경 — "3장중 하나 뽑기!", 동결 해제 사유④)
 *     — randomActionChoice의 'DRAW' 분기에서 discard 결정 로직을 제거했다(선택
 *     결과가 'DRAW'였다는 사실 자체는 바뀌지 않는다 — payload가 단순히 `{choice:
 *     chosen}`으로 줄어 아래 catch-all else와 동형이 됐을 뿐). 뽑기가 더 이상
 *     "무작위 1장 즉시 획득"이 아니라 "3장 제시 → 별도 CARD_DRAW_PICK 액션으로 픽
 *     대기"로 바뀌어, 만석 시 버릴 카드를 정하는 시점 자체가 ACTION_CHOICE에서
 *     CARD_DRAW_PICK으로 옮겨갔다(그 RNG 소비도 함께 이전 — 새 함수 ⑤ randomCardDrawPick
 *     참조, 소비량 자체는 사라지지 않고 위치만 옮겼다) — "새 전략/최적화"가 아니라
 *     ①②③과 동일하게 "룰 변경에 따른 합법성 유지"다.
 *  ⑤ ★G-A-10 — randomCardDrawPick 신설(5번째 함수). CARD_DRAW_PICK은 이전에 존재하지
 *     않던 완전히 새로운 pending 타입이라 "수정"이 아니라 "추가"다 — 기존 4개 함수의
 *     로직은 이 신설로 바이트 하나 바뀌지 않는다.
 */

/** 조커 논리 id 판별 — cards.js cardId()의 `JOKER#<copyIndex>@g<gen>` 스킴 그대로(신규 의존성 없음). */
function isJokerId(id) {
  return typeof id === 'string' && id.indexOf('JOKER#') === 0;
}

/** EXCHANGE: 0..capEffective 균등 랜덤 장수 → 무작위 discard(중복 없이). */
function randomExchange(legalActions, rng) {
  const count = rng.nextInt(legalActions.capEffective + 1); // 0..capEffective 균등
  const discard = rng.sampleWithoutReplacement(legalActions.handIds, count);
  return { type: 'EXCHANGE', actor: legalActions.actor, payload: { discard } };
}

/**
 * SUBMIT: 손패에서 무작위 min(5,손패) 장 제출.
 * ★J-4(오너 지시 룰변경, 동결 해제 사유①) — 조커 제출 상한 1. handIds에 조커가
 * 2장 이상이면 policy 스트림으로 1장만 남기고 나머지는 추출 모집단에서 제외한 뒤
 * 기존 로직 그대로 진행한다(어떤 조커를 남길지도 시드로 재현 가능 — 결정론 유지).
 */
function randomSubmit(legalActions, rng) {
  const handIds = legalActions.handIds;
  const jokerIds = handIds.filter(isJokerId);
  let pool = handIds;
  if (jokerIds.length > 1) {
    const keepId = jokerIds[rng.nextInt(jokerIds.length)];
    const excluded = new Set(jokerIds.filter((id) => id !== keepId));
    pool = handIds.filter((id) => !excluded.has(id));
  }
  // ★W1(2026-08-17) — 장수 자체도 균등 무작위(kMin..kMax). kMin/kMax가 없는 구
  // legalActions(과거 스냅샷·구 TC 하네스 등)와의 하위호환으로 count(=kMax 별칭)에
  // 폴백한다 — 이 경우 span=0이라 draw 1회는 여전히 소비하고 count 그대로 뽑는다
  // (구 동작과 동일한 카드 수, RNG 소비 패턴만 이 함수 전체가 이미 바뀌어 있다).
  const kMax = legalActions.kMax !== undefined ? legalActions.kMax : legalActions.count;
  const kMin = legalActions.kMin !== undefined ? legalActions.kMin : legalActions.count;
  const span = Math.max(0, kMax - kMin);
  const count = kMin + rng.nextInt(span + 1);
  const submitted = rng.sampleWithoutReplacement(pool, count);
  return { type: 'SUBMIT', actor: legalActions.actor, payload: { submitted } };
}

/**
 * ACTION_CHOICE: 전 티어 공통(director 부수지침 1, S2) — 소지 스킬 중 균등 무작위
 * 1개(policy 스트림). basic-attack-only(options.length===1)도 동일 코드 경로로
 * draw 1회 소비(EXCHANGE/SUBMIT과 동일한 관례).
 * ★J-5(오너 지시 룰변경, 동결 해제 사유②) — options에 charSkillId가 이미 섞여 있어
 * 균등 추출은 로직 무변경으로 CHAR_SKILL을 자동 편입한다. 선택 결과가 'CHAR_SWAP'이면
 * 폐기할 카드도 함께 균등 무작위로 결정한다(장수 1~swapCount 균등, 카드도 균등 —
 * 둘 다 policy 스트림 소비, 결정론 유지).
 * ★D1(FIX-2 §7-1) — options에 'DRAW'가 항상 섞여 있다(§1-1 SP 임계 행동 총칭).
 * ★G-A-10(2026-08-18, 동결 해제 사유④) — 선택 결과가 'DRAW'여도 이제 여기서는
 * discard를 정하지 않는다(catch-all else와 동형인 `{choice: chosen}` 그대로) —
 * 뽑기가 "3장 제시 → 별도 CARD_DRAW_PICK 픽 대기"로 바뀌어 만석 시 버릴 카드 결정이
 * randomCardDrawPick(아래)으로 이전했다.
 */
function randomActionChoice(legalActions, rng) {
  const options = legalActions.options;
  const idx = rng.nextInt(options.length);
  const chosen = options[idx];
  let payload;
  if (chosen === 'BASIC_ATTACK') {
    payload = {};
  } else if (chosen === 'CHAR_SWAP') {
    const handIds = legalActions.handIds || [];
    const maxCount = Math.min(legalActions.swapCount || 1, handIds.length);
    if (maxCount < 1) {
      // 방어적 — getLegalActions가 손패0장이면 이미 CHAR_SWAP을 옵션에서 뺀다(도달 극히 드묾).
      payload = { choice: chosen, swapDiscard: [] };
    } else {
      const count = 1 + rng.nextInt(maxCount); // 1..maxCount 균등
      const swapDiscard = rng.sampleWithoutReplacement(handIds, count);
      payload = { choice: chosen, swapDiscard };
    }
  } else {
    // ★G-A-10 — 'DRAW'도 이 catch-all로 떨어진다(구 discard 분기 폐기, 위 함수 주석 참조).
    payload = { choice: chosen };
  }
  return { type: 'ACTION_CHOICE', actor: legalActions.actor, payload };
}

/**
 * ★G-A-10(2026-08-18, 오너 확정 "3장중 하나 뽑기!") 신설 — CARD_DRAW_PICK: offered
 * (≤3장) 중 균등 무작위 1장. 만석이면(legalActions.cardsFull) 버릴 카드도 균등
 * 무작위(heldCards 중 1장) — 구 randomActionChoice의 'DRAW' 분기가 하던 일을 그대로
 * 옮겨왔다(로직 동형, 위치만 이전).
 */
function randomCardDrawPick(legalActions, rng) {
  const offered = legalActions.offered || [];
  const picked = offered[rng.nextInt(offered.length)];
  let payload;
  if (legalActions.cardsFull) {
    const heldCards = legalActions.heldCards || [];
    const discard = heldCards.length > 0 ? heldCards[rng.nextInt(heldCards.length)] : undefined;
    payload = { picked, discard };
  } else {
    payload = { picked };
  }
  return { type: 'CARD_DRAW_PICK', actor: legalActions.actor, payload };
}

/** DRAFT_PICK: 전 티어 공통. 만석이면 50% 포기, 아니면 제시 중 무작위 픽(+버릴 카드 무작위). */
function randomDraftPick(legalActions, rng) {
  if (legalActions.full) {
    const doPass = rng.chance(0.5);
    if (doPass || legalActions.offer.length === 0) {
      return { type: 'DRAFT_PICK', actor: legalActions.actor, payload: { decision: 'pass' } };
    }
    const cardType = legalActions.offer[rng.nextInt(legalActions.offer.length)];
    const discard = legalActions.heldCards[rng.nextInt(legalActions.heldCards.length)];
    return { type: 'DRAFT_PICK', actor: legalActions.actor, payload: { decision: 'pick', cardType, discard } };
  }
  const cardType = legalActions.offer[rng.nextInt(legalActions.offer.length)];
  return { type: 'DRAFT_PICK', actor: legalActions.actor, payload: { decision: 'pick', cardType } };
}

/** legalActions.type으로 위 5개 중 하나로 라우팅(L1 자체 및 타 정책의 "비전문 축" 폴백 공용). */
function dispatch(legalActions, rng) {
  if (legalActions.type === 'EXCHANGE') return randomExchange(legalActions, rng);
  if (legalActions.type === 'SUBMIT') return randomSubmit(legalActions, rng);
  if (legalActions.type === 'ACTION_CHOICE') return randomActionChoice(legalActions, rng);
  if (legalActions.type === 'DRAFT_PICK') return randomDraftPick(legalActions, rng);
  if (legalActions.type === 'CARD_DRAW_PICK') return randomCardDrawPick(legalActions, rng); // ★G-A-10
  throw new Error(`aiRandom.dispatch: 알 수 없는 legalActions.type ${legalActions.type}`);
}

module.exports = { randomExchange, randomSubmit, randomActionChoice, randomDraftPick, randomCardDrawPick, dispatch };
