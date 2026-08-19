'use strict';

/**
 * proto/engine/events.js
 *
 * 이벤트 타입 enum + O-0 공통 봉투 팩토리.
 * qa-critic 관측요구서 확정본(O-0·O-M·O-1~O-20)의 필드명을 그대로 따른다.
 * ★enum 문자열은 S0 정식 명칭표와 1:1(BURN/FREEZE/MULTIPLIER 등) — 금지 표기 없음.
 */

const SCHEMA_VERSION = 1;

const EVENT_TYPE = Object.freeze({
  GAME_START: 'GAME_START',
  DEAL: 'DEAL',
  EXCHANGE: 'EXCHANGE',
  STATUS_APPLY: 'STATUS_APPLY',
  STATUS_TICK: 'STATUS_TICK',
  STATUS_EXPIRE: 'STATUS_EXPIRE',
  SUBMIT: 'SUBMIT',
  HAND_EVAL: 'HAND_EVAL',
  ROUND_RESULT: 'ROUND_RESULT',
  SUIT_TRIGGER: 'SUIT_TRIGGER',
  BUFF_STACK: 'BUFF_STACK',
  MULTIPLIER: 'MULTIPLIER',
  DAMAGE: 'DAMAGE',
  HEAL: 'HEAL',
  SP_CHANGE: 'SP_CHANGE',
  ACTION_CHOICE: 'ACTION_CHOICE',
  DRAFT_CYCLE: 'DRAFT_CYCLE',
  DRAFT_OFFER: 'DRAFT_OFFER',
  DRAFT_PICK: 'DRAFT_PICK',
  DRAFT_PASS: 'DRAFT_PASS',
  DRAFT_SKIPPED: 'DRAFT_SKIPPED',
  DECK_REPLACED: 'DECK_REPLACED',
  GAME_END: 'GAME_END',
  // ★F16-06(c)(2026-08-17) — 진단 전용. mkEvent가 아니라 mkDiagnosticEvent로만 만들고,
  // 사이드카(예: autoPlayGame의 result.diagnostics)에만 담는다 — 정본 이벤트 스트림
  // (result.events)에 섞으면 replay()가 재생성하지 못해 seq가 어긋난다. 아래 함수
  // 정의부의 계약 주석 참조.
  AI_DECISION: 'AI_DECISION',
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
  PUBLIC_VIEW_AUDIT: 'PUBLIC_VIEW_AUDIT',
  // ★S2 신설
  A3_SCHEDULED: 'A3_SCHEDULED', // A3(패 훔치기) 발동 — 폐기 예약(카드문서 §2-A3 정정판)
  A3_DISCARD: 'A3_DISCARD', // A3 예약 폐기 해소 — 대상의 "다음 보충 직후"
  FORCED_ASSIGN: 'FORCED_ASSIGN', // 강제 배정 모드(게이트 ⑥) — actor별 카드 배정
  FORCED_ASSIGN_MODE: 'FORCED_ASSIGN_MODE', // 강제 배정 모드 진입 요약(draftOff 등)
  // ★J-5(2026-08-16, 조커 와일드화+캐릭터 신설) 신규
  CHAR_SWAP: 'CHAR_SWAP', // 캐릭터 기본 스킬 "교체" 발동 — 폐기·재지급 카드 ID 기록(결정론 재현용)
  FORCED_HAND: 'FORCED_HAND', // ★SG-2 하네스 — 특정 실카드/조커를 초기 손패에 강제 주입(테스트 전용)
  // ★W1(2026-08-17, director 스펙 A 부수 D-2) — 상시(패시브) 효과가 "이번 라운드
  // 실제로 적용된 순간"을 알리는 정본 이벤트. P2(교환 상한 보너스)·P4(수트 레벨
  // 보너스)류 — 기존엔 이 정보가 EXCHANGE.capSources/SUIT_TRIGGER.triggers[].levelAfterP4
  // 안에 이미 있었지만(계산 자체는 이전부터 정확), "하이라이트할 전용 이벤트"가 없어
  // UI가 매번 그 필드를 역산해야 했다. ★정본 룰 이벤트(mkEvent)로 발행 — replay()가
  // 재생성하는 대상이다. F16-06의 AI_DECISION(mkDiagnosticEvent, 정본 seq 공간 밖)과
  // 혼동 금지 — 이건 그 반대다.
  PASSIVE_TRIGGER: 'PASSIVE_TRIGGER',
  // ★W3(2026-08-17, director 개정 스펙 B/신규 카드 6종) — 신규 액티브 4종의 고유 효과
  // 해소 이벤트. 전부 정본 룰 이벤트(mkEvent) — replay()가 재생성하는 대상.
  A6_RECOVER: 'A6_RECOVER', // A6(환수) — 이번 라운드 제출분에서 카드를 손패로 복원
  FORCED_SUBMIT_MIN_APPLY: 'FORCED_SUBMIT_MIN_APPLY', // A7(강요) — 상대의 다음 SUBMIT 하한을 강제
  FORCED_SUBMIT_MIN_TICK: 'FORCED_SUBMIT_MIN_TICK', // A7 — R8 경계 지속시간 소모(STATUS_TICK과 동일 패턴)
  FORCED_SUBMIT_MIN_EXPIRE: 'FORCED_SUBMIT_MIN_EXPIRE', // A7 — 지속시간 만료
  A9_REVEAL: 'A9_REVEAL', // A9(투시) — 상대 이월 손패 중 무작위 revealCount장을 발동자에게만 공개(고정)
  // ★W3(2026-08-17, P7 「각인」 구현 중 실측 적발 — seed 2970013) — P7을 드래프트
  // 스왑으로 잃으면 유효 스택 상한이 되돌아가는데, buffStacks는 applySuitEffect
  // 밖에서 감소하는 경로가 없어 옛 상한으로 쌓인 스택이 새 상한을 영구히 넘는 채로
  // 고착된다(BUFF_BOUNDS 불변식 영구 위반). 매 라운드 R8 경계에서 재정합 —
  // 정상 이벤트로 기록(조용히 자르지 않는다).
  BUFF_STACK_RECONCILE: 'BUFF_STACK_RECONCILE',
  // ★D1(FIX-2 §3/§4/§5) — 신 룰 정본 이벤트 3종.
  // POT_CHANGE: 팟(공유 곱 슬롯) 상태 변화 전부(무승부 성장·승자 공격 소진·A8 증액)를
  // 하나의 이벤트 타입으로 통일 — 기존 MULTIPLIER(P5/구 배수 트리거)는 P5 개인배수
  // 메커니즘 자체가 소멸하며 함께 폐지된다(§2-4·§8, 신 정본 §6-5). trigger 필드로
  // 'DRAW_GROWTH'|'WINNER_ATTACK_CONSUME'|'A4_CONVERT_CONSUME'|'A8_RAISE' 구분.
  POT_CHANGE: 'POT_CHANGE',
  // CARD_DRAW: SP 임계 행동 「뽑기」(§7-1 W13·§1-1 총칭 3요소 중 하나) — 3턴 주기
  // 드래프트(DRAFT_OFFER/DRAFT_CYCLE 등, 폐지)를 대체한다.
  // ★G-A-10(2026-08-18, 오너 확정 "3장중 하나 뽑기!") — 「사적 3장 1택」으로 전면
  // 교체(구 「무작위 1장」 축소구현 폐기). POT_CHANGE와 같은 원칙(단일 타입 + 판별
  // 필드로 단계 구분, 신규 타입 난립 금지)으로 `stage` 필드 하나에 3단계를 싣는다:
  //  'OFFERED'    — 제시 순간(draft 스트림에서 offerSize장을 뽑는다). fields.offered에
  //                 제시된 카드 타입 배열, rng에 draft 스트림 drawsBefore/After.
  //  'PICKED'     — 실제 선택 해소(별도 CARD_DRAW_PICK 액션으로 도착). fields.offered에
  //                 원래 제시 3장을 그대로 다시 싣고 fields.picked에 고른 1장을 함께
  //                 실어, D3가 이 이벤트 하나만 봐도 "무엇을 제시받고 무엇을 골랐나"를
  //                 재구성할 수 있게 한다(이벤트 조인 불요). rng는 null(PRNG 미소비 —
  //                 고르는 행위 자체는 정책 결정이지 난수가 아니다).
  //  'EMPTY_POOL' — C4 전역 유일성으로 제시 가능한 카드가 0장일 때의 방어적 즉시 종결
  //                 (구현 거의 도달 불가 — 카드 레지스트리가 실제로 비어야 발생).
  CARD_DRAW: 'CARD_DRAW',
});

const PHASE = Object.freeze({
  GAME_START: 'GAME_START',
  R1_HAND: 'R1',
  R2_EXCHANGE: 'R2',
  R3_SUBMIT: 'R3',
  R4_JUDGE: 'R4',
  R5_BATTLE: 'R5',
  R6_SP: 'R6',
  R7_DRAFT: 'R7',
  R8_REFILL: 'R8',
  GAME_END: 'GAME_END',
});

/**
 * O-0 공통 봉투를 채워 이벤트 객체를 만든다.
 * state.seqCounter를 전역 단조 증가시킨다(부수효과 — 호출부가 이미 clone된 state에서만 부른다).
 *
 * rngInfo: null 이거나 { stream, drawsBefore, drawsAfter }.
 *   ★N-0d — 이 이벤트가 PRNG를 소비하지 않았으면 반드시 null(조회 순수성의 직접 관측 수단).
 */
function mkEvent(state, { phase, actor, type, rng = null, fields = {} }) {
  state.seqCounter += 1;
  return Object.assign(
    {
      v: SCHEMA_VERSION,
      seq: state.seqCounter,
      gameId: state.gameId,
      round: state.round,
      phase,
      actor: actor === undefined ? null : actor,
      type,
      rng,
    },
    fields
  );
}

/**
 * ★F16-06(c)(2026-08-17, director 판정4 채택 — 진행로그 S8 "director 판정 4건") —
 * ★★오라클 계약: 정본 이벤트 스트림(= mkEvent가 만드는 것)은 **룰 이벤트만**이다.
 * seq는 그 정본 스트림 안에서만 단조 연속이어야 하고("배열 순서 = seq 순서" 불변,
 * replay()가 액션 로그만 재적용해 같은 seq 수열을 재생산할 수 있어야 함), 그 계약이
 * M2에서 UE가 "룰을 재현"했는지 판정하는 오라클(observationHash가 아니라 이벤트
 * 로그 diff)의 기반이다.
 *
 * AI_DECISION처럼 **진단용**(그 판을 어떻게 재생했는지가 아니라 "AI가 왜 그렇게
 * 골랐는지"를 남기는 부가 정보)인 이벤트는 mkEvent를 쓰면 안 된다 — mkEvent는
 * state.seqCounter를 증가시키는데, AI_DECISION은 replay()가 액션 로그만으로는
 * 재생성하지 않으므로(재생성하려면 AI를 다시 실행해야 하고, 그건 "룰 재현"이 아니라
 * "JS 런타임 재현"을 오라클 계약에 섞는 최악의 방향 — 기각안 (b)) 같은 seq 공간을
 * 나눠 쓰면 그 지점 이후 정본 seq가 replay 결과와 어긋난다(F16-06 결함의 원인).
 *
 * ★그래서 mkDiagnosticEvent는 seqCounter를 건드리지 않는다 — 대신 `seq: null`로
 * "이 이벤트는 정본 seq 공간 밖"임을 명시하고, `afterSeq`에 "이 진단이 발생한
 * 시점 직전까지의 정본 seq"를 남겨 시간순 상관관계를 잃지 않게 한다(정본 스트림을
 * 오염시키지 않으면서도 디버깅 시 "이 AI_DECISION이 어느 정본 이벤트 다음에
 * 일어났는가"를 알 수 있다). 호출부는 반드시 사이드카 배열(예: result.diagnostics)에
 * 담아야 한다 — result.events(정본)에 섞으면 이 함수를 쓰는 의미가 없다.
 *
 * ★다음에 진단용 이벤트를 새로 추가할 때: mkEvent가 아니라 이 함수를 쓸 것. 정본
 * 이벤트 스트림에 진단 이벤트를 또 섞으면 이 결함(F16-06)이 재발한다.
 */
function mkDiagnosticEvent(state, { phase, actor, type, rng = null, fields = {} }) {
  return Object.assign(
    {
      v: SCHEMA_VERSION,
      seq: null, // ★정본 seq 공간 밖 — replay()로 재생성되지 않는 이벤트라는 뜻
      afterSeq: state.seqCounter, // 참고용 — 이 진단 직전까지의 정본 seq(디버깅 상관관계용, 계약 아님)
      gameId: state.gameId,
      round: state.round,
      phase,
      actor: actor === undefined ? null : actor,
      type,
      rng,
    },
    fields
  );
}

module.exports = { SCHEMA_VERSION, EVENT_TYPE, PHASE, mkEvent, mkDiagnosticEvent };
