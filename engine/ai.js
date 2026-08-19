'use strict';

/**
 * proto/engine/ai.js — S3: AI 3단(L1/L2/L3) + 측정 프로브 정책 4종.
 *
 * ★한 벌 원칙: 플레이어블 UI와 밸런스 시뮬 러너가 이 파일 하나를 공유한다 — 정책마다
 * 별도 구현을 두지 않고, 전부 동일한 `decide(view, legalActions, tier, policyStream, config)`
 * 인터페이스로 등록한다(L1~L3·프로브 4종 구분 없이 갈아끼울 수 있게).
 *
 * ★policy 스트림만 소비 — deck 스트림은 절대 건드리지 않는다(S1 "정책 교체 시 딜
 * 시퀀스 불변" 계약, S2 착수판정 RNG 스트림 고정 지침과 동일 원칙).
 *
 * ★의존 방향: ai.js → aiRandom.js/handEval.js/cards.js만(engine.js는 절대 require
 * 하지 않는다 — engine.js가 ai.js를 require하므로 역방향은 순환 참조가 된다).
 *
 * ★정보 접근 감사(persona 요구 #6): AI가 받는 관측 객체는 "타입 수준에서" 상대
 * 손패·덱 순서를 담지 않는다 — L2Observation은 getPublicView() 결과(view) 그대로이고
 * (view 자체가 이미 engine.js PUBLIC_VIEW_ALLOWED_PATHS로 감사됨 — opponent.hand
 * 같은 필드가 애초에 만들어지지 않는다), L3Observation은 buildL3Observation(view)가
 * `state`를 전혀 받지 않고 `view`의 필드만으로 파생시키므로 구조적으로(함수 시그니처
 * 자체가) 비공개 데이터에 접근할 수 없다 — "값이 비었다"가 아니라 "그 경로로는 애초에
 * 접근이 불가능하다".
 */

const aiRandom = require('./aiRandom');
const { bestHand, evaluateHand, combinations5, legalSubmitCombos, compareEval, compareKeyCompare, RANK_CATEGORY_NAMES } = require('./handEval');
const { SUITS, RANK_MIN, RANK_MAX, COPIES_PER_CARD, JOKER_COPIES } = require('./cards');

const FALLBACK_CONFIG = require('./config/current.json'); // ai.decide()를 config 없이 직접 부르는 경우의 방어적 기본값

// ---------------------------------------------------------------------------
// 탐색 예산 카운터 — ★L2 ≤300 / L3 ≤2,000 손패평가(evaluateHand 호출 수) 상한.
// 상한 초과 시 정책: "예외"가 아니라 "폴백"을 택한다(설계 판단, 보고 대상) — AI는
// 배치·UI 양쪽에서 게임을 완주시켜야 하는 컴포넌트라 예외로 중단시키면 S1 게이트③
// (완주 100%)·S4 배터리 완주 요구와 정면충돌한다. 초과分은 L1과 동일한 합법 무작위
// 결정으로 즉시 대체하고, 메타(fallback:true)에 그 사실을 남겨 관측 가능하게 한다.
// ---------------------------------------------------------------------------

function nCr5(n) {
  if (n < 5) return 0;
  return Math.round((n * (n - 1) * (n - 2) * (n - 3) * (n - 4)) / 120);
}

/** bestHand(hand) 호출 1회를 "budget" 카운터에 사전 과금(계산 자체를 하기 전에 비용을 예측해 넘으면 호출하지 않는다). */
function budgetedBestHand(hand, budget, limit, label, config) {
  if (hand.length < 5) return { result: null, over: false };
  const cost = nCr5(hand.length);
  if (budget.used + cost > limit) {
    return { result: null, over: true, label };
  }
  budget.used += cost;
  return { result: bestHand(hand, config), over: false }; // ★W1 — config 전달(submit.min/max 기본 미적용이면 완전히 동일하게 동작)
}

/**
 * ★W1(2026-08-17, director 스펙 A "AI 2단 분해" 2단계 — 장수/보존) — 1단계(구성 선택,
 * legalSubmitCombos/bestHand 재사용 — kMax짜리, 무변경)가 이미 고른 최선 조합에서
 * "몇 장을 실제로 낼지"를 정한다. ★handEval 재호출 없음 — evaluateRealCards의 그룹핑이
 * 카운트 기반이라(§2-2 예시·정정 이력 #4, §7 정정 3건①) 구성 카드(comboEval.constituent)
 * 밖의 킥커는 판정(등급·비교 키)에 전혀 기여하지 않는다는 사실이 이미 증명돼 있다 —
 * 그 카드들만 빼고 다시 evaluateHand를 불러도 100% 같은 결과가 나온다는 걸 재확인할
 * 필요가 없다(플러시/스트레이트/포하우스류처럼 constituent가 kMax장 전부인 조합은
 * 애초에 뺄 킥커가 없다 — paddingNeeded 분기가 자연히 0이 되어 그대로 전량 제출된다).
 * 킥커는 영구 소모(§1 R8)만 시킬 뿐 이번 라운드 승패엔 기여가 0이므로(#55 킥커 무관),
 * scoreFn(cardKeepScore 계열, 항상 ≥0)이 큰 카드를 쥐고 있는 쪽이 EV상 절대 손해가
 * 아니다 — kMin 충족에 필요한 최소 패딩만, 그마저도 값이 가장 낮은 킥커부터 채운다.
 * 반환: 실제로 제출할 카드 배열(comboCards의 부분집합, 길이 ∈ [min(constituent수,kMax), kMax]).
 */
function trimToMinimalSubmission(comboCards, comboEval, kMin, scoreFn) {
  const constituentSet = new Set(comboEval.constituent);
  const required = comboCards.filter((c) => constituentSet.has(c.id));
  const filler = comboCards.filter((c) => !constituentSet.has(c.id));
  const paddingNeeded = Math.max(0, kMin - required.length);
  if (paddingNeeded === 0) return required;
  const scoredFiller = filler
    .map((c) => ({ card: c, score: scoreFn(c) }))
    .sort((a, b) => a.score - b.score || (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0)); // ★값 동률이면 id로 결정론 타이브레이크
  const padding = scoredFiller.slice(0, paddingNeeded).map((s) => s.card);
  return required.concat(padding);
}

// ---------------------------------------------------------------------------
// 카드 스코어링 헬퍼(순수 함수 — PRNG 미소비, view의 self.hand만 사용)
// ---------------------------------------------------------------------------

function countBySuit(hand) {
  const out = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
  for (const c of hand) if (!c.isJoker && c.suit) out[c.suit] += 1;
  return out;
}

/** 카드 1장의 "보유 가치" 근사(자기 손패만 사용 — 페어·수트 시너지 반영). */
function cardKeepScore(card, hand, weights) {
  if (card.isJoker) return weights.jokerBaseValue;
  let sameRank = 0;
  let sameSuit = 0;
  for (const c of hand) {
    if (c.id === card.id) continue;
    if (!c.isJoker && c.rank === card.rank) sameRank++;
    if (!c.isJoker && c.suit === card.suit) sameSuit++;
  }
  return card.rank + weights.pairWeight * sameRank + weights.suitWeight * sameSuit;
}

/**
 * ★L3 전용(구현 중 발견 — 보고 대상) — cardKeepScore(페어·수트 클러스터)는 "연속 랭크"
 * (스트레이트/조커 스트레이트 재료) 신호를 아예 못 본다. L2는 이 축을 전혀 모른다 —
 * 카드 1장 주변 ±2 랭크 안에 다른(다른 랭크의) 카드가 몇 장 있는지를 세어 "런 근접도"로
 * 쓴다(스트레이트는 동일 랭크가 아니라 연속 랭크가 필요하므로 pairWeight로는 못 잡는 신호).
 */
function runProximity(card, hand) {
  if (card.isJoker || card.rank === null || card.rank === undefined) return 0;
  const nearbyRanks = new Set();
  for (const c of hand) {
    if (c.id === card.id || c.isJoker || c.rank === null) continue;
    const d = Math.abs(c.rank - card.rank);
    if (d >= 1 && d <= 2) nearbyRanks.add(c.rank);
  }
  return nearbyRanks.size; // 서로 다른 근접 랭크 수(중복 랭크는 스트레이트에 무의미하므로 집합으로 셈)
}

/** rankCategory·compareKey를 하나의 스칼라로 근사(카테고리 지배 유지 — hold_aware 전용 소프트 스코어). */
function scalarHandValue(evalResult) {
  let v = evalResult.rankCategory * 1000;
  let weight = 50; // 14*50=700 < 1000(카테고리 간격) — 카테고리 우선순위가 항상 지배하도록 보장
  for (const k of evalResult.compareKey) {
    const val = k === -Infinity ? 0 : k;
    v += val * weight;
    weight /= 20;
  }
  return v;
}

/** k개를 discard할 때, constituent(현재 최강 5장) 밖의 spare부터 스코어 낮은 순으로 뽑는다. 부족하면 constituent까지 잠식. */
function chooseDiscardIds(hand, constituentIds, k, scoreFn) {
  if (k <= 0) return [];
  const constituentSet = new Set(constituentIds);
  const spares = hand.filter((c) => !constituentSet.has(c.id));
  const scoredSpares = spares.map((c) => ({ id: c.id, score: scoreFn(c) })).sort((a, b) => a.score - b.score);
  const discardIds = scoredSpares.slice(0, Math.min(k, scoredSpares.length)).map((s) => s.id);
  if (discardIds.length < k) {
    const constituentCards = hand.filter((c) => constituentSet.has(c.id));
    const scoredConstituent = constituentCards.map((c) => ({ id: c.id, score: scoreFn(c) })).sort((a, b) => a.score - b.score);
    for (const item of scoredConstituent) {
      if (discardIds.length >= k) break;
      discardIds.push(item.id);
    }
  }
  return discardIds;
}

function clampInt(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function mkExchange(actor, discard) {
  return { type: 'EXCHANGE', actor, payload: { discard } };
}
function mkSubmit(actor, submitted) {
  return { type: 'SUBMIT', actor, payload: { submitted } };
}
/**
 * ★J-5 — swapDiscard(선택)는 choice==='CHAR_SWAP'일 때만 의미 있다(생략 시 기존과 동일 페이로드).
 * ★G-A-10(2026-08-18) — 구 drawDiscard 4번째 인자는 폐기했다(이력: choice==='DRAW'는
 * 이제 즉시 해소가 아니라 3장 제시로 이어져, "버릴 카드"는 ACTION_CHOICE 시점이 아니라
 * 뒤이은 별도 CARD_DRAW_PICK 액션(mkCardDrawPick)의 payload.discard로 옮겨갔다).
 */
function mkActionChoice(actor, choice, swapDiscard) {
  // aiRandom.randomActionChoice와 동일 관례 — BASIC_ATTACK은 payload:{}, 스킬은 { choice }.
  if (choice === 'BASIC_ATTACK') return { type: 'ACTION_CHOICE', actor, payload: {} };
  const payload = { choice };
  if (swapDiscard) payload.swapDiscard = swapDiscard;
  return { type: 'ACTION_CHOICE', actor, payload };
}

/** ★G-A-10 — CARD_DRAW_PICK 액션 생성. picked는 offered 중 하나, discard는 cardsFull일 때만 의미. */
function mkCardDrawPick(actor, picked, discard) {
  const payload = { picked };
  if (discard) payload.discard = discard;
  return { type: 'CARD_DRAW_PICK', actor, payload };
}

/**
 * ★D1(§7-1) 원형, ★G-A-10(2026-08-18)으로 호출 시점 이전(재사용, 로직 무변경) — 뽑기가
 * 만석 상태에서 해소될 때 버릴 카드 1장이 필요하다. 구현 당시엔 "뽑을 카드 자체가
 * 무작위라 최선의 버림을 계산할 근거가 없다"는 이유로 결정론 단순 규칙(보유 카드
 * 목록의 첫 항목)을 썼다 — G-A-10 이후로는 무엇을 뽑을지 이미 알고(정책 결정) 나서
 * 버릴 카드를 정하지만, "새 평가 체계를 만들지 마라" 지시에 따라 이 단순 규칙을
 * 그대로 재사용한다(더 똑똑한 버림 전략은 이번 작업 범위 밖). policy 스트림 미소비.
 */
function chooseDrawDiscard(view, legalActions) {
  const held = legalActions.heldCards || view.self.cards || [];
  return held.length > 0 ? held[0] : undefined;
}

// ---------------------------------------------------------------------------
// AI 관측 타입 — L2Observation / L3Observation(persona 요구 #6)
// ---------------------------------------------------------------------------

const SUIT_TOTAL_PER_GEN = (RANK_MAX - RANK_MIN + 1) * COPIES_PER_CARD; // 52
const FULL_DECK_APPROX = SUITS.length * SUIT_TOTAL_PER_GEN + JOKER_COPIES; // 212(단일 세대 근사 — deckGen 무관하게 매 세대 동일 구성)

/**
 * ★S-10 합법 정보만으로 수트별 잔여 매수를 추정(P3 미보유 시). 근거: 신선한 덱 1세대는
 * 수트당 52장 고정(공개 사실) · 자기 손패 수트 histogram은 자기 정보(합법) · 전체 덱
 * 잔량(shared.deckRemaining)은 공개(S-10). 상대 손패·비공개 버림의 정확한 수트 구성은
 * 모르므로, "자기 손패로 빠진 만큼을 뺀 상한"을 전체 잔량에 비례 배분하는 근사만 가능하다
 * (정확한 카운팅이 아니라 근사 — P3 보유 시엔 정확한 shared.deckRemainingBySuit를 그대로 쓴다).
 */
function estimateSuitBreakdown(view) {
  const selfCounts = countBySuit(view.self.hand);
  const upper = {};
  for (const s of SUITS) upper[s] = Math.max(0, SUIT_TOTAL_PER_GEN - selfCounts[s]);
  const sumUpper = SUITS.reduce((s, x) => s + upper[x], 0);
  const deckRemaining = view.shared.deckRemaining;
  const scale = sumUpper > 0 ? deckRemaining / sumUpper : 0;
  const out = {};
  for (const s of SUITS) out[s] = upper[s] * scale;
  return out;
}

function estimateJokerRemaining(view) {
  const selfJokers = view.self.hand.filter((c) => c.isJoker).length;
  const upper = Math.max(0, JOKER_COPIES - selfJokers);
  const denom = Math.max(1, FULL_DECK_APPROX - view.self.hand.length);
  const scale = view.shared.deckRemaining / denom;
  return upper * scale;
}

/**
 * L2Observation = getPublicView() 결과 그대로(추가 0). view 자체가 이미
 * engine.js PUBLIC_VIEW_ALLOWED_PATHS로 감사돼 상대 손패·덱 순서를 담지 않는다 —
 * 이 함수는 그 보장을 그대로 물려받을 뿐, 넓히지도 좁히지도 않는다.
 */
function buildL2Observation(view) {
  return view;
}

/**
 * L3Observation = L2Observation + 카운팅 파생값(합법 정보만, view의 필드만으로 계산).
 * ★state를 인자로 받지 않는다 — 이 함수의 시그니처 자체가 "비공개 state 접근 불가"를
 * 강제한다(런타임 필터링이 아니라 타입/함수 경계 수준의 차단).
 */
function buildL3Observation(view) {
  const selfSuitCounts = countBySuit(view.self.hand);
  const exact = !!view.shared.deckRemainingBySuit;
  const estimatedDeckSuitCounts = exact ? view.shared.deckRemainingBySuit : estimateSuitBreakdown(view);
  const estimatedDeckJokers = view.shared.deckRemainingJokers !== undefined ? view.shared.deckRemainingJokers : estimateJokerRemaining(view);
  return Object.assign({}, view, {
    counting: { selfSuitCounts, estimatedDeckSuitCounts, estimatedDeckJokers, exact },
  });
}

function suitValue(suit, l3obs) {
  const counts = l3obs.counting.estimatedDeckSuitCounts;
  const vals = SUITS.map((s) => counts[s] || 0);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (avg <= 0) return 1;
  return (counts[suit] || 0) / avg; // >1 풍부, <1 희소
}

/** ★정보 접근 감사용 — L3Observation의 `counting` 서브트리에 허용 안 된 경로가 있는지 검사(qa-critic/verifier 재사용 가능). */
const AI_COUNTING_ALLOWED_PATHS = new Set([
  'counting',
  'counting.selfSuitCounts',
  'counting.selfSuitCounts.♠',
  'counting.selfSuitCounts.♥',
  'counting.selfSuitCounts.♦',
  'counting.selfSuitCounts.♣',
  'counting.estimatedDeckSuitCounts',
  'counting.estimatedDeckSuitCounts.♠',
  'counting.estimatedDeckSuitCounts.♥',
  'counting.estimatedDeckSuitCounts.♦',
  'counting.estimatedDeckSuitCounts.♣',
  'counting.estimatedDeckJokers',
  'counting.exact',
]);
// ★정확히 이 경로이거나 이 경로의 하위(접두사+'.')일 때만 위반이다 — 문자열 부분일치가
// 아니다(구현 중 발견·수정 — 보고 대상: 최초 버전은 'opponent.hand'를 substring으로
// 검사해 합법 공개 필드인 'opponent.handSize'까지 오탐했다. S-10은 상대 "손패 장수"는
// 공개, "손패 내용"은 비공개라고 다르게 정한다 — 문자열 유사성과 공개 여부는 무관하다).
const AI_FORBIDDEN_PATH_ROOTS = ['opponent.hand', 'deck.cards', 'deckOrder', 'privateDiscard', 'hiddenHand'];
function isForbiddenPath(path) {
  return AI_FORBIDDEN_PATH_ROOTS.some((root) => path === root || path.indexOf(root + '.') === 0 || path.indexOf(root + '.*') === 0);
}

function collectPathsLocal(value, prefix, out) {
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) collectPathsLocal(value[0], `${prefix}.*`, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      collectPathsLocal(value[k], path, out);
    }
  }
}

/** obs = buildL2Observation(view) 또는 buildL3Observation(view)의 출력. */
function auditAiObservation(obs, tierLabel) {
  const emitted = new Set();
  collectPathsLocal(obs, '', emitted);
  const emittedKeys = Array.from(emitted);
  const forbidden = emittedKeys.filter(isForbiddenPath);
  const countingKeys = emittedKeys.filter((p) => p === 'counting' || p.indexOf('counting.') === 0);
  const countingViolations = countingKeys.filter((p) => !AI_COUNTING_ALLOWED_PATHS.has(p));
  return { tier: tierLabel, emittedKeys, forbidden, countingViolations, ok: forbidden.length === 0 && countingViolations.length === 0 };
}

// ---------------------------------------------------------------------------
// L2 — 기대값 휴리스틱(단순 탐욕, 자기 손패 정보만). 예산 ≤300.
// ---------------------------------------------------------------------------

function exchangeL2(view, legalActions, policyStream, config, budget) {
  const hand = view.self.hand;
  const capEffective = legalActions.capEffective;
  if (capEffective === 0 || hand.length === 0) {
    return { action: mkExchange(legalActions.actor, []), candidatesEvaluated: 0, handEvalCalls: 0 };
  }
  const limit = config.ai.budget.L2;
  const baseline = budgetedBestHand(hand, budget, limit, 'L2-exchange-classify');
  if (baseline.over || !baseline.result) {
    return {
      action: aiRandom.randomExchange(legalActions, policyStream),
      fallback: true,
      note: baseline.over ? 'budget-exceeded-classify' : 'hand-too-short',
      candidatesEvaluated: 0,
      handEvalCalls: budget.used,
    };
  }
  const R = baseline.result.eval.rankCategory;
  const constituentIds = baseline.result.combo.map((c) => c.id);
  const table = config.ai.l2.exchangeDiscardFractionByCategory;
  // ★L2·L3 우위의 실질 근거 #1(자가측정으로 확정 — 보고 대상) — L2는 "카테고리가
  // 강할수록 비율을 낮춘다"는 표만 따르고, 그 비율이 실제 spare(구성 밖 카드) 수를
  // 넘어서면 constituent(이미 만든 좋은 5장)까지 잠식한다는 사실을 모른다("단순 탐욕"의
  // 한계 — table[R]이 곧 안전하다고 가정). L3는 이 잠식을 명시적으로 계산해 방지한다
  // (아래 exchangeL3의 spareCount cap). 실측(2,500판+): 이 차이 하나로 L3 승률이
  // ~50%→~57%로 이동했다 — 표 계수를 서로 다르게 잡은 것과 무관하게, "구성을 깨는지
  // 아는가"가 진짜 정보 우위다.
  const k = clampInt(capEffective * table[R], 0, capEffective);
  // ★L2는 "몇 장을 버릴지"(카테고리→비율 표)는 알지만 "어느 카드를 버릴지"는 단순
  // 탐욕(랭크값만 — 스페어가 페어/수트 시너지를 만들고 있어도 못 본다). L3는 이 축에서
  // cardKeepScore(페어·수트 보너스)+카운팅(수트 희소성)까지 본다 — 실측(자가확인 보고)
  // 근거로 이 축을 L2/L3 우위 신호로 삼는다(단순 랭크 기준 vs 시너지 인지 기준).
  const scoreFn = (card) => (card.isJoker ? config.ai.cardValue.jokerBaseValue : card.rank);
  const discardIds = chooseDiscardIds(hand, constituentIds, k, scoreFn);
  return { action: mkExchange(legalActions.actor, discardIds), candidatesEvaluated: 1, handEvalCalls: budget.used };
}

/**
 * ★trimOpts(선택) — { scoreFn } 지정 시 trimToMinimalSubmission으로 2단계(장수/보존)를
 * 적용한다. ★submitAlwaysBest는 trimOpts를 넘기지 않는다 — "항상 최고 kMax장"이 그
 * 프로브의 정의 자체이고(F7-07 재실측용 기준선), 프로브 4종은 무변경 원칙(persona
 * 지시)이 적용된다. submitL2만 trimOpts를 넘겨 2단계를 켠다 — 코드 중복(budget
 * 소진·폴백 로직) 없이 stage①(구성 선택)을 그대로 공유한다.
 */
function submitBestHand(view, legalActions, policyStream, config, budget, limit, trimOpts) {
  const kMax = legalActions.kMax !== undefined ? legalActions.kMax : legalActions.count;
  const kMin = legalActions.kMin !== undefined ? legalActions.kMin : legalActions.count;
  const applyTrim = (comboCards, comboEval) => (trimOpts ? trimToMinimalSubmission(comboCards, comboEval, kMin, trimOpts.scoreFn) : comboCards);
  if (kMax < 5) {
    // ★J-4/S-8 갱신(R1 구현 중 발견) — kMax<5는 "손패가 짧다" 외에 "조커 상한으로
    // 줄었다"도 포함하므로, 손패 전량(legalActions.handIds 전부) 제출은 더 이상 항상
    // 합법이 아니다(조커 2장+가 섞여 있을 위험 — handleSubmit의 새 권위 검증에 걸린다).
    // bestHand()가 이미 합법 조합만 탐색하므로(legalSubmitCombos) 그 결과를 그대로 쓴다
    // — 이 구간은 원래도 탐색 후보 수가 작아 budget 없이 계산해도 무해하다.
    const r = bestHand(view.self.hand, config);
    if (!r) return { action: mkSubmit(legalActions.actor, legalActions.handIds.slice()), candidatesEvaluated: 0, handEvalCalls: 0 }; // 방어적(손패 0장)
    const submitted = applyTrim(r.combo, r.eval);
    return { action: mkSubmit(legalActions.actor, submitted.map((c) => c.id)), candidatesEvaluated: 1, handEvalCalls: 1 };
  }
  const hand = view.self.hand;
  const r = budgetedBestHand(hand, budget, limit, 'submit-best', config);
  if (r.over || !r.result) {
    return {
      action: aiRandom.randomSubmit(legalActions, policyStream),
      fallback: true,
      note: r.over ? 'budget-exceeded-submit' : 'hand-too-short',
      candidatesEvaluated: 0,
      handEvalCalls: budget.used,
    };
  }
  const submitted = applyTrim(r.result.combo, r.result.eval).map((c) => c.id);
  return { action: mkSubmit(legalActions.actor, submitted), candidatesEvaluated: budget.used, handEvalCalls: budget.used };
}

/**
 * ★W1(2026-08-17, director 스펙 A) — 2단 분해 적용. 1단계는 submitBestHand(무변경
 * 재사용, kMax짜리 legalSubmitCombos/bestHand). 2단계(장수/보존)는 cardKeepScore
 * (L2 자기 카드값 가중치)로 trimToMinimalSubmission — handEval 재호출 없음, 예산
 * 증설 없음(210 전량 열거를 하지 않는다).
 */
function submitL2(view, legalActions, policyStream, config, budget) {
  const weights = config.ai.cardValue;
  const scoreFn = (c) => cardKeepScore(c, view.self.hand, weights);
  return submitBestHand(view, legalActions, policyStream, config, budget, config.ai.budget.L2, { scoreFn });
}

// ---------------------------------------------------------------------------
// L3 — L2 + 카운팅(공개 파생값) + 예산을 쓴 국소 탐색. 예산 ≤2,000.
// ---------------------------------------------------------------------------

/**
 * ★설계 노트(구현 중 발견 — 보고 대상): 처음엔 "discard 개수(k) 자체를 국소 탐색"하는
 * 버전을 만들었는데, 실측(1,200판)에서 L3가 L2에 48.7%로 밀렸다 — 원인을 추적하니
 * capEffective가 spare(구성 밖 카드) 수 이내인 흔한 경우, spare만 버리는 한 constituent가
 * 그대로 남아 bestHand(keptHand)의 값이 discard 개수와 무관하게 "항상 baseline과 동일"
 * (제거 가능 근거: constituent 5장이 keptHand에 그대로 있으니 그 조합이 여전히 최선이라
 * bestHand가 그 이상도 이하도 찾을 수 없다). 즉 retained 항이 후보 사이에서 전혀 변별력이
 * 없고, 후보 비교가 사실상 drawBonus(버리는 장수에 비례해 단조 증가)만으로 결정돼 항상
 * "가장 많이 버리는 후보"가 이겼다 — 카테고리별 감쇠 스케줄(read-signal의 근거)을 탐색이
 * 매번 무력화하고 있었다. 국소 탐색을 폐기하고, 대신 진짜 정보 우위(수트 희소성 기반
 * 카드 선택 + compareKey 기반 카테고리 내 미세조정)로 L2 대비 우위를 만든다 — 국소 탐색은
 * 폐기했지만 예산 카운터 자체는 여전히 실제로 세고 상한을 존중한다(budgetedBestHand).
 */
/**
 * ★조커 희소성(S3 게이트② 재확보 시도 3/3 — 착수 선행 진단 후 개선 항목 2, 새 신호).
 * L3Observation.counting.estimatedDeckJokers는 buildL3Observation이 이미 계산해
 * 두지만(S3 원 구현부터 존재) 지금까지 아무 데도 쓰이지 않았다(구현 중 발견 — 보고
 * 대상). suitValue와 같은 "희소하면 지킨다" 원리를 조커 축에 적용한다 — 덱에 남은
 * 조커가 적을수록 지금 손에 든 조커를 잃으면 재보충이 어려워지므로(조커 스트레이트는
 * A-2 최상위 등급 — 놓치면 기회비용이 크다) 보유 가치를 올린다. 0(전량 잔존 — 흔함,
 * 추가 보너스 없음)~1(잔존 0 — 지금 든 게 사실상 마지막, 최대 보너스) 클램프.
 * ★S-10 공개 파생값만 사용(정보 접근 감사 게이트④ 유지) — l3obs.counting은 이미
 * 감사 대상 경로(AI_COUNTING_ALLOWED_PATHS)에 등재돼 있어 새 비공개 경로 0.
 */
function jokerScarcityFactor(l3obs) {
  const remaining = l3obs.counting.estimatedDeckJokers;
  return clamp01(1 - remaining / JOKER_COPIES);
}

/**
 * ★L3 전용 카드 보유가치(시도 3/3 개선 항목 1 — 카운팅 가중치를 더 정교하게).
 * cardKeepScore(base — ★hold_aware 프로브와 공유하는 원본 함수. 이 함수 자체는 절대
 * 수정하지 않는다, persona 지시 "프로브 4종 무변경") + 카운팅 파생 보너스 3종(연속랭크
 * 근접·수트 희소성·조커 희소성 위 jokerScarcityFactor). exchangeL3(어느 spare를
 * 버릴지)와 submitL3(동률 후보 중 무엇을 남길지 — 아래) 양쪽이 이 함수 하나를
 * 공유한다 — "무엇을 보유할 가치가 있는가"의 정의가 L3 안에서 갈라지면 한 벌 원칙
 * 위반이라, 시도3 이전엔 exchangeL3에만 인라인으로 있던 걸(runBonus+suitBonus) 여기로
 * 승격해 공유한다. ★비-조커 카드는 조커 보너스 항이 0이라 기존 exchangeL3 인라인
 * 버전과 값이 완전히 동일(회귀 없음) — 조커 카드만 새 보너스 항이 더해진다(신규 신호).
 */
function l3KeepScore(card, hand, l3obs, config) {
  const base = cardKeepScore(card, hand, config.ai.cardValue);
  const runBonus = config.ai.l3.runWeight * runProximity(card, hand);
  const suitBonus = card.isJoker || !card.suit ? 0 : config.ai.l3.suitScarcityWeight * (suitValue(card.suit, l3obs) - 1);
  const jokerBonus = card.isJoker ? config.ai.l3.jokerScarcityWeight * jokerScarcityFactor(l3obs) : 0;
  return base + runBonus + suitBonus + jokerBonus;
}

function exchangeL3(view, legalActions, policyStream, config, budget) {
  const hand = view.self.hand;
  const capEffective = legalActions.capEffective;
  if (capEffective === 0 || hand.length === 0) {
    return { action: mkExchange(legalActions.actor, []), candidatesEvaluated: 0, handEvalCalls: 0 };
  }
  const limit = config.ai.budget.L3;
  const baseline = budgetedBestHand(hand, budget, limit, 'L3-exchange-classify');
  if (baseline.over || !baseline.result) {
    return {
      action: aiRandom.randomExchange(legalActions, policyStream),
      fallback: true,
      note: baseline.over ? 'budget-exceeded-classify' : 'hand-too-short',
      candidatesEvaluated: 0,
      handEvalCalls: budget.used,
    };
  }
  const R = baseline.result.eval.rankCategory;
  const constituentIds = baseline.result.combo.map((c) => c.id);
  const table = config.ai.l3.exchangeDiscardFractionByCategory;

  // ★L2에는 없는 신호 — 같은 카테고리 안에서도 compareKey(구성 랭크) 첫 항이 높을수록
  // "이미 강하다"고 보고 더 보수적으로(덜 버리게) 미세조정한다(예: 페어A vs 페어2는
  // 같은 ONE_PAIR라도 다르게 취급). 카테고리 스케줄이 만드는 큰 계단을, 이 조정이
  // 계단 안에서 완만하게 다듬는다 — 카테고리 순서를 절대 뒤집지 않는다(작은 가중치).
  const firstKey = baseline.result.eval.compareKey[0];
  const normalizedKey = firstKey === -Infinity || firstKey === undefined ? 0 : clamp01((firstKey - RANK_MIN) / (RANK_MAX - RANK_MIN));
  const withinCategoryAdjust = 1 - config.ai.l3.withinCategoryWeight * normalizedKey;
  const rawK = clampInt(capEffective * table[R] * withinCategoryAdjust, 0, capEffective);

  // ★L2에는 없는 두 번째 신호(구현 중 발견 — 보고 대상) — 실측(1,200판)으로 원인을
  // 추적한 결과: discard 개수가 spare(구성 밖 카드) 수를 넘으면 chooseDiscardIds가
  // constituent(현재 최선 5장)까지 잠식해 "이미 만든 좋은 패를 갈아엎는" 실착이 된다.
  // ONE_PAIR 이상(R>=1)에서는 이 잠식을 원천 차단(discard 상한 = spare 수) — HIGH_CARD만
  // (거의 손패랄 게 없어 잠식 리스크가 사실상 0) 원래 스케줄 그대로 허용한다. L2는
  // 이 보호가 없다 — "구성 밖 spare만 정리할 줄 아는가"가 L2 대비 L3의 실질 우위다.
  const spareCount = hand.length - constituentIds.length;
  const kTarget = R >= 1 ? Math.min(rawK, spareCount) : rawK;

  // ★카운팅 파생값(L2엔 없음) — 어떤 spare를 버릴지 고를 때 희소 수트를 우선 정리하고
  // 풍부한 수트는 남긴다(향후 수트 발동 가능성이 남아있는 카드를 우대 보유). ★시도3부터
  // l3KeepScore로 승격(조커 희소성 보너스 추가 — 비-조커는 값 불변, 위 함수 주석 참고).
  const l3obs = buildL3Observation(view);
  const scoreFn = (card) => l3KeepScore(card, hand, l3obs, config);

  const discardIds = chooseDiscardIds(hand, constituentIds, kTarget, scoreFn);
  return { action: mkExchange(legalActions.actor, discardIds), candidatesEvaluated: 1, handEvalCalls: budget.used };
}

/**
 * ★L3 제출 — L2와 달리 "동률 중 무엇을 낼지"까지 본다(구현 중 발견 — 보고 대상).
 * bestHand()는 동률 후보 중 하나만 대표로 반환한다(handEval.js 주석: "동률이면 먼저
 * 찾은 조합을 반환"). 4벌 덱이라 동일 rankCategory+compareKey 동률이 드물지 않게
 * 생긴다(예: 같은 랭크 카드가 여러 장 있어 하이카드 키가 같은 5장 조합이 둘 이상).
 * ★이번 판 승패엔 영향이 0(동률은 정의상 동일 강도)이므로 "이번 판을 희생해 이월을
 * 챙긴다"가 아니라 "공짜로 얻을 수 있는 이월 가치를 챙긴다" — L2가 놓치는 순수 이득이다.
 * 동률 후보 전수(C(n,5)) + 잔존 카드 스코어링만 추가 비용, L3 예산(2000) 안에서 충분.
 */
function submitL3(view, legalActions, policyStream, config, budget) {
  // ★W1(2026-08-17, director 스펙 A) — kMin/kMax(하위호환: 없으면 count 폴백).
  const kMax = legalActions.kMax !== undefined ? legalActions.kMax : legalActions.count;
  const kMin = legalActions.kMin !== undefined ? legalActions.kMin : legalActions.count;
  // ★W1 — 지연 평가(lazy). trimToMinimalSubmission은 paddingNeeded===0(구성 카드만으로
  // kMin을 이미 채운 흔한 경우 — 플러시/스트레이트/포하우스류는 항상 이 경우)이면
  // scoreFn을 단 한 번도 호출하지 않는다. buildL3Observation을 인자 평가 시점에
  // 즉시(eager) 계산하면 그 경우에도 항상 비용을 치르므로, 실제로 스코어링이 필요한
  // 첫 호출까지 미룬다(호출 자체가 없으면 계산 자체가 없다).
  const l3ScoreFnFor = (hand) => {
    let l3obs = null;
    return (c) => {
      if (!l3obs) l3obs = buildL3Observation(view);
      return l3KeepScore(c, hand, l3obs, config);
    };
  };
  if (kMax < 5) {
    // ★J-4/S-8 갱신(R1 구현 중 발견) — submitBestHand와 동일 사유(위 주석 참조):
    // 손패 전량 제출은 더 이상 항상 합법이 아니다. bestHand()가 이미 합법 조합만
    // 탐색하므로 그 결과를 그대로 쓴다(동률 이월 미세조정은 이 좁은 구간에선 표본이
    // 작아 이득도 작다 — L2 대비 우위의 핵심은 count>=5 구간, 아래 그대로 유지).
    const r = bestHand(view.self.hand, config);
    if (!r) return { action: mkSubmit(legalActions.actor, legalActions.handIds.slice()), candidatesEvaluated: 0, handEvalCalls: 0 };
    // ★W1 2단계(장수/보존) — L2와 동일 원리, L3는 l3KeepScore(카운팅 파생 신호 포함)로.
    const trimmed = trimToMinimalSubmission(r.combo, r.eval, kMin, l3ScoreFnFor(view.self.hand));
    return { action: mkSubmit(legalActions.actor, trimmed.map((c) => c.id)), candidatesEvaluated: 1, handEvalCalls: 1 };
  }
  const hand = view.self.hand;
  const limit = config.ai.budget.L3;
  // ★nCr5(hand.length)는 이제 실제 합법조합 수(legalSubmitCombos 길이)의 안전한 상한
  // 근사다(조커 2장+ 조합을 배제하므로 legalSubmitCombos.length <= nCr5(hand.length)
  // 항상 성립) — 과소과금 위험 없이 보수적으로만 어긋난다(성능 보고 대상, 변경 안 함).
  const cost = nCr5(hand.length);
  if (hand.length < 5 || budget.used + cost > limit) {
    return {
      action: aiRandom.randomSubmit(legalActions, policyStream),
      fallback: true,
      note: 'budget-exceeded-submit',
      candidatesEvaluated: 0,
      handEvalCalls: budget.used,
    };
  }
  budget.used += cost;
  const combos = legalSubmitCombos(hand, config); // ★J-4 — 조커 ≤1 합법 조합만(combinations5 대신)
  let bestEval = null;
  const evaluated = [];
  for (const combo of combos) {
    const ev = evaluateHand(combo);
    evaluated.push({ combo, ev });
    if (!bestEval || compareEval(ev, bestEval) > 0) bestEval = ev;
  }
  const tied = evaluated.filter((e) => compareEval(e.ev, bestEval) === 0);
  let winner = tied[0];
  if (tied.length > 1) {
    // ★시도 3/3 개선 항목 1(착수 선행 진단 — SUBMIT 결정 불일치율 49.2%, 그중 상당수가
    // 바로 이 "동률 처리" 지점, proto/test/S3_attempt3_prediagnosis.js 실측) — 잔존
    // (이월) 가치 평가를 exchangeL3와 같은 l3KeepScore로 승격(카운팅 파생 신호 공유,
    // "한 벌" 원칙). 이전엔 cardKeepScore(base)만 써 exchangeL3가 이미 검증한 수트
    // 희소성·연속랭크 근접 신호를 여기서는 못 봤다. ★이번 판 승패에는 영향 0(동률은
    // 정의상 이번 라운드 강도가 완전히 같다) — residual 비교 기준만 바뀐다, 위험 없음.
    const l3obs = buildL3Observation(view);
    let bestResidual = -Infinity;
    for (const t of tied) {
      const comboIdSet = new Set(t.combo.map((c) => c.id));
      const deferred = hand.filter((c) => !comboIdSet.has(c.id));
      const residual = deferred.reduce((s, c) => s + l3KeepScore(c, hand, l3obs, config), 0);
      if (residual > bestResidual) {
        bestResidual = residual;
        winner = t;
      }
    }
  }
  // ★W1(2026-08-17, director 스펙 A) — 2단계(장수/보존). winner는 이미 stage①
  // (구성 선택 + 동률 타이브레이크)로 확정된 kMax짜리 조합 — 여기서 kMin까지 잘라낸다.
  const trimmed = trimToMinimalSubmission(winner.combo, winner.ev, kMin, l3ScoreFnFor(hand));
  return {
    action: mkSubmit(legalActions.actor, trimmed.map((c) => c.id)),
    candidatesEvaluated: combos.length,
    handEvalCalls: budget.used,
  };
}

// ---------------------------------------------------------------------------
// ACTION_CHOICE(기본공격 vs 스킬) 기대값 정책 — ★L2/L3 전용(S3 게이트② 재확보 시도
// 1/3, 2026-08-15). N1(director) 이후 SP 임계+스킬보유 시 [BASIC_ATTACK, ...heldSkills]가
// 정본대로 복원됐는데, 이 지점을 L1·L2·L3·프로브 4종 전부가 동일한 균등무작위
// 폴백(actionChoiceFallback)으로 처리하던 것이 L3vL2 단조성 재실패(56.2%→55.00%,
// CI하한54.11%)의 실측 원인이었다(진행로그 "S2/S3 통합 수정 라운드 완료" 항목).
// L2/L3의 정체성이 "기대값 휴리스틱"(exchangeL2/L3·submitL2/L3가 이미 그 패턴)이므로
// 같은 사고를 여기에도 적용한다.
//
// ★L1은 절대 불변(정본 균등무작위가 L1의 정의, persona 지시) — POLICY_TABLE.L2/L3의
// ACTION_CHOICE만 아래 핸들러로 교체한다. ★프로브 4종(always_best·hold_aware·
// rank_first·suit_first)은 ★의도적으로 그대로 둔다(actionChoiceFallback 유지) — 프로브의
// 존재 이유가 "측정하려는 축 하나만 빼고 전부 L1 대조군으로 통제"하는 것이기 때문이다
// (바로 위 "측정 프로브 정책 4종" 헤더 주석 그대로) — ACTION_CHOICE까지 EV화하면 그
// 대조군 통제가 깨져 always_best/hold_aware가 "제출 축만 다른" 실험이 아니게 된다.
//
// ★engine.js를 require하지 않는다(파일 상단 순환참조 금지 원칙) — resolveDamage의
// 공식(§2-1: (직업+수트+카드)×배수−방어, 하한1)을 가볍게 재근사한다. exchange/submit
// L2/L3도 이미 같은 방식(handEval 직접 호출, engine.js 비의존)이라 신규 패턴이 아니다.
// ---------------------------------------------------------------------------

/**
 * ★D1(FIX-2 §3·[F6-25]) — resolveDamage(engine.js) 신 곱 파이프라인의 순수 근사(방어
 * 축 없음 — 3-인자였던 구 공식에서 defenseTotal이 사라지고 gap/pot/crit 3배율로
 * 교체됐다). RNG·이벤트 기록 없이 최종 데미지 스칼라만 — [F6-25]가 요구하는 「엔진 ↔
 * ai.js 동형」 검사 대상은 이 함수의 산술 자체다(순수 함수 대조, 시드 불요).
 */
function estimateDamage(sumRaw, gapMultiplier, potMultiplier, critExpectedMultiplier, config, targetMaxHp) {
  const floor = config.damage.floor;
  const raw = sumRaw * gapMultiplier * potMultiplier * critExpectedMultiplier;
  // ★정정(F6-25, verifier 실측 — crit on 472건 중 91건(19%)·crit off 612건 중 373건(61%)만
  // 일치) — engine.js resolveDamage의 half-up 최종 반올림(engine.js:1106
  // `Math.round(afterMultiplier)`) 단계가 이 근사에서 누락돼 있었다. 같은 절차를 반영해
  // 엔진과 동형을 회복한다(같은 입력 → 같은 출력, 순수 함수 대조).
  const rounded = Math.round(raw);
  // ★D2 잔여(FIX-2 §15 곱 상한 선배선, off) — engine.js resolveDamage와 동형(§3 예약 슬롯,
  // 판정 2 그대로: 반올림→상한클램프→하한). config.damage.capRatio가 null/undefined면
  // 무동작(현행과 완전 동일값 반환) — targetMaxHp 인자 신설이 기존 11개 호출부 시그니처를
  // 넓히지만 capRatio off인 한 반환값에 영향 없다.
  const capRatio = config.damage.capRatio;
  let afterCap = rounded;
  if (capRatio !== undefined && capRatio !== null && targetMaxHp !== undefined && targetMaxHp !== null) {
    afterCap = Math.min(rounded, Math.floor(targetMaxHp * capRatio)); // ★상한값 정수화 = Math.floor(보수)
  }
  return Math.max(afterCap, floor);
}

/**
 * ★D1(FIX-2 §3) — 이 라운드 자신의 역할(승자/패자)과 격차 배율(F/L)을 view만으로
 * 추정한다(순수 함수, RNG 미소비). ACTION_CHOICE는 판정(R4) 이후라
 * view.shared.lastRevealedSubmission이 이번 라운드 양측 rankCategory/compareKey를
 * 이미 담고 있다 — 그것으로 역할을 재구성한다(엔진은 state.roundCache로 직접 알지만
 * AI는 공개 뷰만 본다 — S-10 원칙, 재구현이 아니라 같은 사실의 다른 관측 경로).
 * ★확신 낮음(보고 대상) — lastRevealedSubmission이 비정상적으로 없으면(방어적,
 * 정상 흐름에서는 항상 채워져 있어야 한다) role='winner'·F=δ로 안전 폴백한다.
 */
function estimateRoundGap(view, config) {
  const rev = view.shared.lastRevealedSubmission;
  const selfActor = view.self.actor;
  const oppActor = view.opponent.actor;
  const f = config.gap.winnerCurve;
  const delta = config.gap.evenDelta;
  if (!rev || !rev[selfActor] || !rev[oppActor]) {
    return { role: 'winner', gapMultiplier: delta, isWinner: true };
  }
  const selfCat = RANK_CATEGORY_NAMES.indexOf(rev[selfActor].rankCategory);
  const oppCat = RANK_CATEGORY_NAMES.indexOf(rev[oppActor].rankCategory);
  const isWinner = selfCat !== oppCat ? selfCat > oppCat : compareKeyCompare(rev[selfActor].compareKey, rev[oppActor].compareKey) >= 0;
  const winnerCat = isWinner ? selfCat : oppCat;
  const loserCat = isWinner ? oppCat : selfCat;
  const d = winnerCat - loserCat;
  const F = f[winnerCat] - f[winnerCat - d] + delta;
  if (isWinner) return { role: 'winner', gapMultiplier: F, isWinner: true };
  const beta = config.gap.loserBeta;
  const lambdaMin = config.gap.loserFloor;
  const L = Math.min(1, Math.max(lambdaMin, 1 - beta * (F - delta)));
  return { role: 'loser', gapMultiplier: L, isWinner: false };
}

/** ★D1 — 승자 공격에만 팟이 곱해진다(§2-4·§5) — potMultiplierOverride 없는 일반 케이스. */
function computePotMultiplier(view, isWinner) {
  return isWinner ? view.shared.pot.value : 1;
}

/**
 * ★D1(FIX-2 §8·§9) — ♦ 유효 스택 기반 치명타 확률 근사(P5 신규 패시브 가산 포함,
 * count 기반 — C4 중복 중첩). 정확한 effectiveStackCap(engine.js)과 같은 산식을
 * view 필드만으로 재구성한다.
 */
function computeCritChance(view, config) {
  const p5Count = view.self.cards.filter((c) => c === 'P5').length;
  const p7Count = view.self.cards.filter((c) => c === 'P7').length;
  const stackCap = config.buff.stackCap + p7Count * config.card.p7.stackCapBonus;
  const diamondStack = Math.min((view.self.buffStacks['♦'] || 0) + p5Count * config.card.p5.stackBonus, stackCap);
  const raw = config.crit.baseChance + diamondStack * config.crit.chancePerStack;
  return Math.min(Math.max(raw, 0), config.crit.chanceCap);
}

/** ★D1 — 치명타 기대 배율(EV) = (1−p)×1 + p×critMult. RNG 미소비 순수 근사. */
function computeCritExpectedMultiplier(view, config, hasCritSizeBonus) {
  const chance = computeCritChance(view, config);
  const critMult = config.crit.baseMultiplier + (hasCritSizeBonus ? config.crit.factor : 0);
  return 1 + chance * (critMult - 1);
}

/**
 * ★핵심 설계 제약(persona 지시) — A3(피해 0, 예약 폐기형 견제 카드)를 "기대 데미지
 * 0"으로 두면 순진한 비교에서 AI가 절대 A3를 선택하지 않는다 — 정본 취지(A3는 이월
 * 견제용 타이밍 유틸리티, N8 판정) 왜곡. 그래서 A3에는 데미지 대신
 * config.ai.actionChoice.statusValue.a3Denial(잠정 8)을 고정 근사치로 준다 — 이 값은
 * ★임의 상수가 아니라 card.a1/a2.damage(둘 다 8)와 ★의도적으로 같은 스케일이다. 근거:
 * 카드문서 §2-A3 "피해 없음(잠정 — 소량 피해는 밸런스 손잡이로 예비)" — A3의 "피해
 * 없음"은 무가치 특례가 아니라 다른 액티브의 카드 성분(damage)과 동급 자리에 있는데
 * 형태만 데미지가 아니라 카드 견제로 나온 것이라는 신호로 읽었다. BURN(A1)은 같은
 * 스케일 값을 적용확률(card.a1.applyChance)로 기대치화하고, FREEZE(A2, 확정 적용)는
 * 전액을 더한다. "무보유 스킬 없음 폴백"과 "전부 균등무작위"의 중간 — 카드 성격별
 * ★최소한의 값어치 근사이지 게임트리 탐색이 아니다(탐색 예산 0 소비 — 아래 핸들러).
 */
/**
 * ★R5②(PM 지시 2026-08-16, G-엔진 FAIL 수정) — CHAR_SWAP EV를 상태 의존적으로 만든다.
 * 기존엔 `config.ai.actionChoice.statusValue.charSwapValue`(고정 8)가 EV 전부였다 —
 * BASIC_ATTACK EV(estimateDamage(job.baseAttack=10+♠버프,…))가 구조적으로 항상 그보다
 * 커서 tie조차 나지 않았다(verifier 실측: L2vL2 2,000판에서 CHAR_SWAP 0건). 상수를
 * 올리면(예: 20) 이번엔 항상 교체만 고르는 거울상 결함이 된다(PM 지시 — 상수를 키우지
 * 말 것) — 둘 다 "선택"이 형해화된 상태다.
 *
 * ★설계: 교체의 가치는 "지금 이월분이 얼마나 나쁜가"에 달려 있다. ACTION_CHOICE는
 * R5_BATTLE 페이즈(R3_SUBMIT 이후·R8_REFILL 이전)에서 일어나므로 `view.self.hand`는
 * 정확히 "이번 라운드에 낸 뒤 남은 이월 손패"다(engine.js handleActionChoice와 동일
 * 시점 관측). cardKeepScore(기존 exchangeL2/L3·chooseCharSwapDiscard가 이미 쓰는
 * 공유 함수 — 신규 발명 아님)로 손패 평균 가치를 재구성하고, 그 값이 기준선
 * (qualityBaseline)보다 낮을수록(=이월분이 나쁠수록) 값어치를 base 위로 올린다.
 * 기준선 이상(=이월분이 쓸 만함)이면 badness=0이라 base(기존 charSwapValue, 제거
 * 아니라 흡수)만 남아 예전과 동일하게 낮은 값에 머문다 — "좋은 패면 교체할 이유가
 * 없다"는 요구를 자연히 만족한다.
 *
 * ★계수 전부 config(character.swap 하위) — balance-designer가 코드 안 건드리고
 * 조정 가능. ★PRNG 미소비(view.self.hand는 이미 확정된 관측값 — 새 확률적 판단을
 * 추가하지 않는다, 기존 시드 재현 무영향).
 */
function charSwapQualityValue(view, config) {
  const sv = config.ai.actionChoice.statusValue;
  const swapCfg = config.character.swap;
  const base = sv.charSwapValue; // ★기존 정본 흡수(제거 아님) — badness=0일 때의 하한값
  const hand = view.self.hand;
  if (!hand || hand.length === 0) return base; // 방어적 — 손패0장은 애초 선택지에서 제외됨(engine.js handleActionChoice charSkillUsable)
  const weights = config.ai.cardValue;
  const avgQuality = hand.reduce((s, c) => s + cardKeepScore(c, hand, weights), 0) / hand.length;
  const badness = Math.max(0, swapCfg.qualityBaseline - avgQuality); // 이월분이 기준선보다 나쁜 만큼만(음수 없음)
  return base + swapCfg.badnessCoefficient * badness;
}

/**
 * ★D1(FIX-2 §3, [F6-25]) 전면 재작성 — 방어 축(defenseTotal) 삭제, 격차(F/L)·팟·크리
 * 3배율 EV로 교체. 신설 옵션 'DRAW'(§7-1)·'A10'(치명타 크기 액티브, S9 §5-5) 편입.
 * 전 옵션이 estimateRoundGap(role/F-L)·computePotMultiplier·computeCritExpectedMultiplier
 * 3개 헬퍼를 공유한다 — 신구 스코어링 비일관 위험을 원천 차단.
 *
 * ★★D2-A(FIX-2 §12-1 D2-② — 8-스케일 EV 상수 재도출) — 구조적 버그 수정, ★수치는
 * 무변경(재도출 결과가 "기존 값 유지"). 근거:
 *   statusValue.burn/freeze/a3Denial·newCardValue.a6~a9·charSwapQualityValue는 전부
 *   "card.a1/a2.damage(8)·character.smash.damage(8)와 같은 8-스케일"이라는 명시적
 *   설계 의도로 도출된 상수다(config _metaW4/_metaW43 원문 — a3Denial=14는 "a1=8+
 *   applyChance×burn=12, a2=8+freeze=16" 사이 중점으로 도출됐다). 그런데 그 도출은
 *   전부 **m=1**(=격차배율 F가 거의 항상 1이던 구 P5 개인배수 세계) 가정 위에서
 *   이뤄졌고, 코드는 이 상수들을 estimateDamage(=F·팟·크리 3배율) **밖에서** 더하고
 *   있었다(post-multiply) — 반면 card.a1/a2/a3/a10.damage·character.smash.damage·A4의
 *   팟환전 bonus는 전부 baseSources **안에서**(pre-multiply) 더해진다. D1에서 F가
 *   상시 곱이 되면서 이 자리 불일치가 실제 버그로 발현됐다: 옵션별 점수를
 *     post: sumRaw_i·M + k_i        (k_i가 M과 무관 — M이 커질수록 k_i 기여가 상대적으로 0에 수렴)
 *     pre : (sumRaw_i + k_i)·M = sumRaw_i·M + k_i·M
 *   로 쓰면, pre 방식은 전 옵션이 같은 M(대부분의 옵션이 estimateRoundGap·
 *   computePotMultiplier·computeCritExpectedMultiplier(hasCritSizeBonus=false)를
 *   공유해 M이 동일)을 공유하는 한 argmax(어떤 옵션이 최댓값인가)가 **M에 무관**해진다
 *   (공통 양의 배율은 순서를 안 바꾼다) — 즉 m=1에서 도출된 상수 그대로 M이 얼마든
 *   "m=1이었다면 어떤 순서였을지"가 그대로 보존된다. 이게 원래 도출이 암묵적으로
 *   전제했던 것과 정확히 같다. ★그래서 처방은 "상수를 새로 실측"이 아니라 "상수가
 *   들어가는 자리를 A4/A10/character.smash.damage와 같은 자리(baseSources 안)로
 *   옮긴다"이다 — 새 평가체계가 아니라 기존 6개 지점의 **배치만** 6곳 통일했다.
 *   (A4·A10은 원래부터 pre-multiply라 무변경. A8의 potMultiplier override[potMultiplier=1
 *   그대로]·cap 포화 0가산 분기도 무변경.)
 * ★확신 낮음(보고 대상) — CHAR_SWAP은 gapInfo.role이 'loser'일 수 있는 유일한 옵션
 *   (패자도 CHAR_SWAP을 고를 수 있다) — pre-multiply면 이월 손패 품질 보너스가 L(≤1)
 *   에도 곱혀 패자 상태에서 그 보너스가 원래보다 작게 반영된다. 승자만 이 옵션을 쓰는
 *   세계였다면 무관했을 차이라 별도 실측 없이 "방향은 합리적(패자는 전반적으로
 *   깎인 세계관이라 일관적), 크기는 미검증"으로만 보고한다.
 */
function evaluateActionChoiceOption(option, view, config) {
  if (option === 'DRAW') {
    return estimateDrawOptionValue(view, config); // ★D2-A — 아래 정의(§D2-② "언제 뽑나")
  }

  const gapInfo = estimateRoundGap(view, config);
  const potMultiplier = computePotMultiplier(view, gapInfo.isWinner);
  const atkBuff = (view.self.buffStacks['♠'] || 0) * config.buff.atkPerStack;
  const baseSources = config.job.baseAttack + atkBuff;
  const sv = config.ai.actionChoice.statusValue;
  const ncv = config.ai.actionChoice.newCardValue; // ★W4-①(2026-08-17) — 신규 액티브 4종 EV 가산치(balance-designer 실측, config._meta 참조)

  if (option === 'BASIC_ATTACK') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    return estimateDamage(baseSources, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'A1') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    // ★D2-A — 화상 기대치(applyChance×burn)를 baseSources 안으로 이동(pre-multiply,
    // 위 함수 헤더 근거). 적용 확률 기대치화 자체는 무변경.
    return estimateDamage(baseSources + config.card.a1.damage + config.card.a1.applyChance * sv.burn, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'A2') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    // ★D2-A — 동결(확정 적용, 확률 없음)도 baseSources 안으로 이동.
    return estimateDamage(baseSources + config.card.a2.damage + sv.freeze, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'A3') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    // ★D2-A — a3Denial도 baseSources 안으로 이동(A3는 damage=0 고정이라 사실상
    // a3Denial 단독이 이 옵션의 전체 카드 성분이 된다).
    return estimateDamage(baseSources + config.card.a3.damage + sv.a3Denial, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'A4') {
    // ★D1(§3) 재정의 — 팟배율 자체는 ×1(무변화), 팟값을 가산으로 환전. 패자 시점은
    // gapInfo.isWinner===false라 bonus가 구조적으로 0(potBefore가 항상 base — §5 근거는
    // 엔진과 동일, 여기서도 명시 role 분기로 안전하게 재확인한다). ★원래부터 pre-multiply — 무변경.
    const potBefore = view.shared.pot.value;
    const bonus = gapInfo.isWinner ? (potBefore - config.pot.base) * config.a4.factor : 0;
    const critMult = computeCritExpectedMultiplier(view, config, false);
    return estimateDamage(baseSources + bonus, gapInfo.gapMultiplier, 1, critMult, config, view.opponent.maxHp); // potMultiplierOverride=1(엔진과 동일)
  }
  if (option === 'A10') {
    // ★D1(FIX-2, S9 §5-5) — 치명타 크기 액티브. 이 공격 자신에게만 크리 내부 가산이 걸린다.
    // ★원래부터 pre-multiply — 무변경.
    const critMult = computeCritExpectedMultiplier(view, config, true);
    return estimateDamage(baseSources + config.card.a10.damage, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  // ★J-5(2026-08-16) — 캐릭터 기본 스킬 2종. 강타는 A1/A2와 같은 계열(배수 前 가산,
  // 오너 확정)이라 estimateDamage에 자연 편입된다("EV에 가산 피해로 자연 편입" 요건).
  // ★원래부터 pre-multiply — 무변경.
  if (option === 'CHAR_SMASH') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    return estimateDamage(baseSources + config.character.smash.damage, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'CHAR_SWAP') {
    // ★W1(스펙 C) — 카드 성분 없이 순수 기본공격만(resolveCharacterSwap 참조).
    // ★D2-A — charSwapQualityValue(이월 손패 품질 근사치)를 baseSources 안으로 이동
    // (위 함수 헤더 "확신 낮음" 참조 — role이 loser일 수 있는 유일한 옵션이라 L이
    // 곱히는 것이 이 재배치의 유일한 새 부작용이다).
    const critMult = computeCritExpectedMultiplier(view, config, false);
    return estimateDamage(baseSources + charSwapQualityValue(view, config), gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  // ★W4-①(2026-08-17) — A6~A9. S9 §1-3대로 카드 성분이 전혀 없는 순수 기본공격.
  // ★D2-A — ncv.a6~a9 전부 baseSources 안으로 이동(공통 처리).
  if (option === 'A6') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    return estimateDamage(baseSources + ncv.a6, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'A7') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    return estimateDamage(baseSources + ncv.a7, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'A8') {
    // ★D1 재배선 — A8이 올리는 것은 이제 state.pot.value(구 state.multiplier.base)다.
    // cap 포화 분기(newCardValue._meta 인계 사항)는 그대로 유지 — 이미 cap이면 가산 0
    // (0을 더하는 것이라 pre/post 이동이 이 분기 자체의 의미를 바꾸지 않는다).
    const critMult = computeCritExpectedMultiplier(view, config, false);
    const capSaturated = view.shared.pot.value >= config.pot.cap;
    return estimateDamage(baseSources + (capSaturated ? 0 : ncv.a8), gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  if (option === 'A9') {
    const critMult = computeCritExpectedMultiplier(view, config, false);
    return estimateDamage(baseSources + ncv.a9, gapInfo.gapMultiplier, potMultiplier, critMult, config, view.opponent.maxHp);
  }
  throw new Error(`evaluateActionChoiceOption: 알 수 없는 옵션 ${option}`);
}

/**
 * ★★D2-A(FIX-2 §12-1 D2-② — "언제 뽑나" 정책) — DRAW 선택지 EV. 발주서 요구:
 * "D1에 3장 1택이 들어왔으니 무엇을 제시받았나가 판단에 들어가야 한다." 실제 제시될
 * 3장(state.cardDrawOffer)은 그 순간까지 RNG 미소비라 원리적으로 알 수 없다(§G-A-10
 * "사적" 설계) — 대신 "무엇이 제시될 **수** 있는가"의 모집단은 순수 공개 정보다
 * (view.shared.drawPoolPreview, engine.js 신설 — eligibleDrawTypes 그대로. 양측
 * 보유 카드는 이미 self.cards/opponent.cards로 보이므로 이 필드가 추가로 새는
 * 비밀은 없다).
 *
 * ★신규 평가체계 금지 — evaluateDrawCardOption(기존 함수, cardDrawPickHandler가
 * CARD_DRAW_PICK에서 이미 쓰는 것과 완전히 동일)을 그대로 재사용해 모집단 각 원소를
 * 채점하고, 집계만 새로 한다. 실제 정책(cardDrawPickHandler)이 "제시된 offerSize장
 * 중 최댓값을 고른다"이므로, "모집단에서 offerSize장 비복원추출했을 때 최댓값의
 * 기댓값"이 정확한 대응값이다 — 그러나 그 조합기댓값 자체를 계산하는 것은 이 함수
 * 하나만을 위한 새 통계 공식이 되어 "새 평가체계 금지"에 저촉될 소지가 있다. 대신
 * ★상위 offerSize개의 평균(내림차순 정렬 후 앞 offerSize개)을 쓴다 — 3장이 실제
 * 제시되면 그중 최댓값이 선택되므로 참값(최댓값의 기댓값)은 이 근사보다 항상 크거나
 * 같다(방향이 있는 보수적 하한 — "언제 뽑나"를 과소평가하는 쪽으로만 치우친다,
 * B2 회복 스톨 쪽으로 안전한 방향).
 * ★모집단이 비어 있거나(구조적으로 거의 불가능 — 패시브 7종은 항상 eligible) 뷰에
 * drawPoolPreview 자체가 없는(구 버전 view를 재생한 리플레이 등) 방어적 경로는 구
 * 고정 상수(newCardValue.draw)로 폴백한다 — 폴백값 자체도 무변경(재도출 대상 아님,
 * 위 함수 헤더 "수치는 무변경" 원칙과 동형).
 */
function estimateDrawOptionValue(view, config) {
  const preview = view.shared && view.shared.drawPoolPreview;
  const fallback = config.ai.actionChoice.newCardValue.draw;
  if (!preview || !preview.remaining || preview.remaining.length === 0) return fallback;
  const offerSize = Math.max(1, Math.min(config.draft.offerSize, preview.remaining.length));
  const values = preview.remaining.map((t) => evaluateDrawCardOption(t, view, config)).sort((a, b) => b - a);
  const top = values.slice(0, offerSize);
  return top.reduce((s, v) => s + v, 0) / top.length;
}

/**
 * ★J-5 — CHAR_SWAP 카드 선택("단순 휴리스틱", 구현 재량 — 이월 기여 최하 카드부터).
 * L2/L3 공용(스펙이 티어 구분을 요구하지 않는다). cardKeepScore(기존 exchangeL2/L3
 * 공유 함수) 기준 최하위 min(swapCount,손패)장을 고른다 — handEval 호출 0(예산 무관).
 */
function chooseCharSwapDiscard(view, legalActions, config) {
  const hand = view.self.hand;
  const maxCount = legalActions.swapCount || 1;
  const count = Math.min(maxCount, hand.length);
  if (count <= 0) return [];
  const scored = hand.map((c) => ({ id: c.id, score: cardKeepScore(c, hand, config.ai.cardValue) })).sort((a, b) => a.score - b.score);
  return scored.slice(0, count).map((s) => s.id);
}

/**
 * L2/L3 공용 ACTION_CHOICE 핸들러 — 옵션별 기대값 중 최댓값을 결정론적으로 고른다
 * (동률은 배열 순서상 먼저 나온 쪽 — options=['BASIC_ATTACK', charSkillId, ...heldSkills]라
 * BASIC_ATTACK이 항상 먼저이므로 동률이면 기본공격을 우선한다 — "스킬이 항상 기본
 * 공격보다 좋으면 그건 선택이 아니다"라는 balance 요구, N1 판정 근거②와 정합).
 * ★policy 스트림 미소비(순수 함수) — persona 지시("결정론적, 단 policy 스트림 소비는
 * 허용")의 허용 범위 안에서 이 축은 소비가 필요 없다(exchangeL2/L3·submitL2/L3도 이미
 * fallback 경로 외엔 policy 스트림을 안 쓴다 — 신규 패턴 아님).
 */
function actionChoiceEvHandler(view, legalActions, policyStream, config) {
  const options = legalActions.options;
  let bestOption = options[0];
  let bestValue = evaluateActionChoiceOption(options[0], view, config);
  for (let i = 1; i < options.length; i++) {
    const v = evaluateActionChoiceOption(options[i], view, config);
    if (v > bestValue) {
      bestValue = v;
      bestOption = options[i];
    }
  }
  // ★G-A-10 — 'DRAW'의 버릴 카드는 더 이상 여기서 정하지 않는다(3장 제시 이후,
  // 별도 CARD_DRAW_PICK 단계에서 cardDrawPickHandler가 chooseDrawDiscard를 재사용한다).
  const swapDiscard = bestOption === 'CHAR_SWAP' ? chooseCharSwapDiscard(view, legalActions, config) : undefined;
  return { action: mkActionChoice(legalActions.actor, bestOption, swapDiscard), candidatesEvaluated: options.length, handEvalCalls: 0 };
}

/**
 * ★★D2-A(FIX-2 §12-1 D2-③ — 회복 스톨 전용 정책, plan §2 D2 체크리스트 3) — "판을
 * 일부러 안 끝내려는" AI. D3가 이걸로 회복 스톨(B2·리스크1: "♥ lv6 48 > 신승 피해
 * 23") 위험을 측정한다 — balance가 자기 정책으로 자기 위험을 재면 자가검증이라
 * rule-engineer 스코프(여기)에서 만든다.
 *
 * ★레버는 정확히 하나 — DRAW(§7-1 "공격 없음, 카드 성분 없음")는 이번 라운드
 * 데미지 자체를 0으로 만드는 유일한 ACTION_CHOICE 옵션이다. DRAW가 합법(=spAtThreshold)
 * 이면 무조건 DRAW를 고른다(다른 옵션의 EV와 무관 — "제일 데미지가 적어서"가 아니라
 * "데미지가 0이라서" 고정 선택, always_best류 고정 정책과 동일 패턴). DRAW가 합법이
 * 아니면(SP 미충전) 남은 옵션 중 evaluateActionChoiceOption 점수가 **최소**인 것을
 * 고른다(부호를 actionChoiceEvHandler와 반대로 — "최선"이 아니라 "최소 피해"). 승자가
 * !spAtThreshold면 옵션이 BASIC_ATTACK 하나뿐이라(§4) 이 분기 도달은 게임 극초반
 * 몇 라운드뿐이다.
 * ★픽 점수화 불가침(발주서 명시) — EXCHANGE/SUBMIT/CARD_DRAW_PICK은 이 정책이 새로
 * 만들지 않는다(POLICY_TABLE 등록 시 L2의 기존 핸들러를 그대로 재사용 — 아래 참조).
 * 이 정책의 유일한 차이는 ACTION_CHOICE 하나, 그리고 그 안에서도 "DRAW 최우선"이라는
 * 배치 규칙뿐 — evaluateActionChoiceOption 자체(각 옵션의 점수 계산식)는 무접촉이다.
 */
function actionChoiceStall(view, legalActions, policyStream, config) {
  const options = legalActions.options;
  if (options.indexOf('DRAW') !== -1) {
    return { action: mkActionChoice(legalActions.actor, 'DRAW'), candidatesEvaluated: options.length, handEvalCalls: 0 };
  }
  let worstOption = options[0];
  let worstValue = evaluateActionChoiceOption(options[0], view, config);
  for (let i = 1; i < options.length; i++) {
    const v = evaluateActionChoiceOption(options[i], view, config);
    if (v < worstValue) {
      worstValue = v;
      worstOption = options[i];
    }
  }
  const swapDiscard = worstOption === 'CHAR_SWAP' ? chooseCharSwapDiscard(view, legalActions, config) : undefined;
  return { action: mkActionChoice(legalActions.actor, worstOption, swapDiscard), candidatesEvaluated: options.length, handEvalCalls: 0 };
}

// ---------------------------------------------------------------------------
// ★L3 전용 ACTION_CHOICE 확장(S3 게이트② 재확보 시도 2/3, 2026-08-15) — L2와 완전히
// 같은 공식을 공유했던 시도 1의 근본 문제(진행로그 "시도 1/3 — 실패, 원인 명확")를
// 고친다. evaluateActionChoiceOption(L2 베이스)은 그대로 재사용하고, 그 위에 카운팅
// 파생 신호 2종만 L3에 추가한다 — "새 공식"이 아니라 "L2 공식 + L3만 아는 보정"이다.
//
// ★수치 근거를 실측으로 먼저 확인했다(구현 전 진단, 보고 대상): 현재 공식에서
// BASIC_ATTACK은 A4를 항상 동률이거나 항상 이긴다 — 증명: A4 값 = baseSources +
// (mult-1)*a4.factor, BASIC 값 = baseSources*mult(둘 다 -defense는 상쇄). 둘의 차는
// (mult-1)*(atkBuff + baseAttack - a4.factor)이고 현재 config는 baseAttack(10)=
// a4.factor(10)라 atkBuff>=0이므로 이 차는 항상 0 이상 — A4가 BASIC을 이기는 경우가
// 원리적으로 없다(동률만 가능, 동률은 배열 순서상 BASIC 우선이라 A4는 선택될 수
// 없다). 300판 실측(L2vsL3, 3843/3870 ACTION_CHOICE 표본)에서 A4 선택 0건으로 확인—
// L2·L3 공용이라 두 티어 다 0%였다. A1/A2는 반대로 card.damage(양수)가 그대로
// ×mult로 얹혀 BASIC을 항상 이긴다(비교 우위가 없는 게 아니라 압도적이라 티어 차가
// 안 생겼다) — 그래서 L3 보정은 A1/A2엔 작은 보수적 할인만, A4엔 "그 자체로 이길 수
// 있는" 새 신호를 준다.
// ---------------------------------------------------------------------------

/**
 * ★카운팅 파생 신호 #1 — "다음 라운드에도 수트 발동이 이어질 가능성"(자기 손패의
 * 수트 뭉침 × 그 수트의 잔여 덱 풍부도, L3Observation.counting 사용). 발동 조건
 * (§2-2, resolveSuitEffects)이 "구성 5장 중 동일 수트 2장+"이므로, 손패에 이미
 * 2장 이상 뭉친 수트가 있고 그 수트가 덱에도 풍부하면(향후 교환으로 유지·보강하기
 * 쉬움) 모멘텀을 높게 본다. L2는 이 신호를 계산할 수 없다(counting이 없다).
 *
 * ★구현 중 발견(보고 대상) — 처음엔 이 신호를 A1/A2(화상/동결)에 소폭 할인으로
 * 적용했었다. 실측(calibrate.js, 2000판 페어드)으로 확인하니 그 지점은 완전히
 * 불활성이었다 — A1/A2 값(baseSources+8, ×mult, +상태이상 기대치)이 BASIC을
 * 항상 최소 8점(×mult) 이상 앞서는 압도적 우위라, 방향을 반대로 걸어도(가중치를
 * 인위적으로 5배까지 올려도) 단 한 건의 선택도 안 바뀌었다(동일 시드 2224/4000로
 * 완전히 동일) — "노이즈가 아니라 죽은 코드"였다. 이 함수는 대신 A3(견제 유틸리티,
 * BASIC과 유일하게 근소한 축 — 실측: BASIC 값 10~22 vs A3 고정 8, 상대 방어스택에
 * 따라 뒤집힘)에 적용한다 — evaluateActionChoiceOptionL3 참조.
 */
function estimateSuitMomentum(view, l3obs) {
  const counts = countBySuit(view.self.hand);
  let momentum = 0;
  for (const s of SUITS) {
    if (counts[s] >= 2) momentum += clamp01(suitValue(s, l3obs) / 2); // suitValue 1(평균)~2+(풍부)→0.5~1.0
  }
  return clamp01(momentum / SUITS.length); // 4수트 전부 뭉쳐야 1.0 근접(현실적으로 드묾 — 대개 0~0.5 구간)
}

/**
 * ★카운팅/공개정보 파생 신호 #2 — A4 "지금 vs 대기" 타이밍. state.multiplier.base는
 * ★양측 공유 자원이다(engine.js consumeMultiplierForA4가 전역 리셋) — 내가 지금
 * BASIC_ATTACK으로 아껴도(공식상 A4와 동률 이하이므로 아낄 이유가 항상 있다) 상대가
 * A4를 들고 있고 SP 임계에 가까우면(둘 다 공개정보: opponent.cards·opponent.sp,
 * S-10) ★상대가 먼저 이 배수를 채갈 위험이 실재한다. 내가 지금 선점하면 상대가 그
 * 배수로 나를 크게 때릴 기회 자체를 지운다(denial) — 이건 "내 이번 공격의 기대값"
 * 비교에는 안 잡히는, 상대 관점의 부가가치다. 여기에 "1스텝 더 쌓일 근사 확률"
 * (growthProb, S5 튜닝 상수)로 상대가 채갈 몫을 살짝 상향한다 — 지금 쌓인 배수보다
 * 조금 더 쌓인 채로 상대에게 넘어갈 수 있다는 뜻이므로 거부 가치가 그만큼 크다.
 * ★상대가 A4를 안 갖고 있거나(hasA4 false) 배수가 아직 1(모을 게 없음)이면 0 —
 * 근거 없는 편향 금지, 위험이 실재할 때만 작동한다.
 *
 * ★실측 한계(구현 중 발견, 보고 대상 — 정직하게 남긴다) — multiplier.mode="exact"
 * (DRAW만 트리거)라 배수가 1을 넘는 ACTION_CHOICE 시점 자체가 극히 드물다(2000판
 * 실측: 7713건 중 71건, 0.9%). 거기에 "상대도 A4 보유"까지 겹치는 경우는 2000판
 * 전체에서 표본상 0건이었다(mult>1 & A4옵션보유 84건을 전수 조사 — oppHasA4 전부
 * false). 즉 이 신호는 원리적으로 옳고(A4가 BASIC에 항상 지거나 비기는 근본 문제를
 * 실제로 푸는 유일한 방향) 위험하지 않지만(항상 ≥0이라 A4를 더 나쁘게 만들 수는
 * 없다), ★이 config(exact 모드)에서는 승률 지표에 거의 기여하지 못한다 — L3vL2 격차
 * 확보는 아래 A3 신호가 주로 담당한다. multiplier.mode를 "contest"로 바꾸면 훨씬 자주
 * 발동하겠지만 그건 AI 정책이 아니라 게임 밸런스 변경이라 이 작업 범위 밖이다(PM/
 * balance-designer 보고 대상으로만 남긴다).
 */
function estimateA4TimingBonus(view, config) {
  // ★D1(FIX-2 §2-4) — state.multiplier.base → state.pot.value(shared.pot). 「기준값」은
  // 이제 cfg.pot.base(무변화, =1이 아니라 config 값)다 — bonus 공식도 A4 재정의(§3)를
  // 그대로 따른다: (potValue−pot.base)×a4.factor.
  const c = config.ai.actionChoiceL3.a4Timing;
  const potValue = Math.min(view.shared.pot.value, config.pot.cap);
  const hasA4 = view.opponent.cards.indexOf('A4') !== -1;
  if (!hasA4 || potValue <= config.pot.base) return 0;
  const spRatio = clamp01(view.opponent.sp / config.player.spThreshold);
  const risk = c.riskFloor + (1 - c.riskFloor) * spRatio; // 상대 SP가 임계에 가까울수록 위험 상향, 보유만 해도 최소 riskFloor
  const growthAdjustedPot = potValue < config.pot.cap ? Math.min(potValue * (1 + c.growthProb), config.pot.cap) : potValue;
  const potentialBonusToOpponent = (growthAdjustedPot - config.pot.base) * config.a4.factor;
  return risk * potentialBonusToOpponent * c.denialWeight; // denialWeight<1 — 전면 반영 아닌 부분 반영(과대편향 방지)
}

/**
 * L2 베이스(evaluateActionChoiceOption) 위에 L3 전용 보정만 얹는다 — 공식을 새로
 * 만들지 않고 "L2가 이미 맞는 부분"은 그대로 상속한다.
 *  - A3: suitMomentum을 여기 적용한다(A1/A2가 아니라 — 위 estimateSuitMomentum
 *    주석의 실측 근거). BASIC vs A3는 이 게임에서 유일하게 "근소한" 축(BASIC이
 *    상대 방어스택에 따라 8 안팎을 오르내리고, A3는 고정 8이라 자주 뒤집힌다) —
 *    momentum 보정이 실제로 선택을 바꿀 수 있는 유일한 지점이다. 방향(sign)은
 *    calibrate.js 실측으로 정했다: momentum이 높을 때(내 손패가 이미 좋은 수트로
 *    뭉쳐 있어 곧 추가 버프/증식이 온다는 신호) A3(견제 유틸리티, 즉시 이득이
 *    작음)를 더 선호하도록 ★가산(할인 아님)한다 — 이미 우세가 예약된 상황에서는
 *    당장의 한 방보다 상대 견제(패 훔치기로 상대의 다음 반등 확률을 낮추는 것)의
 *    상대적 가치가 커진다는 근거(실측이 이 방향에서 유의미한 개선을 보였다, 보고
 *    참조) — 반대 방향(할인)은 실측상 A3 선택률을 더 낮추기만 하고 승률 개선은
 *    없었다(둘 다 calibrate.js로 직접 대조).
 *  - A4: estimateA4TimingBonus를 그대로 더한다(항상 ≥0 — A4가 BASIC보다 "더
 *    나빠지는" 방향으로는 절대 작동하지 않는다). 실측상 기여가 작지만(위 주석)
 *    원리적으로 옳고 해가 없어 유지 — A4를 "BASIC에 항상 지는 함정"에서 최소한
 *    "상황에 따라 이길 수 있는" 옵션으로 만든다.
 */
function evaluateActionChoiceOptionL3(option, view, momentum, a4TimingBonus, config) {
  const base = evaluateActionChoiceOption(option, view, config);
  const c = config.ai.actionChoiceL3;
  if (option === 'A3') {
    return base * (1 + c.a3Momentum.weight * momentum);
  }
  if (option === 'A4') {
    return base + a4TimingBonus;
  }
  return base;
}

/**
 * L3 전용 ACTION_CHOICE 핸들러 — L2와 분리(POLICY_TABLE.L3만 사용). 카운팅 파생값은
 * buildL3Observation(view) 1회로만 뽑고(감사 대상 경로 재사용, 새 필드 추가 없음),
 * 옵션별 보정은 O(1)이라 옵션 수(≤5)만큼만 순회 — handEval 호출 0(예산 무관, L3≤2000
 * 상한과 별개로 항상 0 소비, exchangeL3/submitL3의 실제 예산 소비와 합산돼도 여유).
 * ★policy 스트림 미소비(L2 핸들러와 동일 원칙).
 */
function actionChoiceEvHandlerL3(view, legalActions, policyStream, config) {
  const options = legalActions.options;
  const l3obs = buildL3Observation(view);
  const momentum = estimateSuitMomentum(view, l3obs);
  const a4TimingBonus = estimateA4TimingBonus(view, config);
  let bestOption = options[0];
  let bestValue = evaluateActionChoiceOptionL3(options[0], view, momentum, a4TimingBonus, config);
  for (let i = 1; i < options.length; i++) {
    const v = evaluateActionChoiceOptionL3(options[i], view, momentum, a4TimingBonus, config);
    if (v > bestValue) {
      bestValue = v;
      bestOption = options[i];
    }
  }
  // ★J-5 — CHAR_SMASH/CHAR_SWAP은 evaluateActionChoiceOptionL3에 특수 분기가 없어(위
  // 함수의 최종 `return base`로 자연 상속) L2와 동일 기대값을 쓴다("자연 편입"/"단순
  // 휴리스틱" 요건과 정합, L3 전용 보정은 이번 범위 아님 — 정밀화는 이월).
  // ★G-A-10 — 'DRAW'의 버릴 카드는 더 이상 여기서 정하지 않는다(3장 제시 이후,
  // 별도 CARD_DRAW_PICK 단계에서 cardDrawPickHandler가 chooseDrawDiscard를 재사용한다).
  const swapDiscard = bestOption === 'CHAR_SWAP' ? chooseCharSwapDiscard(view, legalActions, config) : undefined;
  return { action: mkActionChoice(legalActions.actor, bestOption, swapDiscard), candidatesEvaluated: options.length, handEvalCalls: 0 };
}

// ---------------------------------------------------------------------------
// ★G-A-10(2026-08-18, 오너 확정 "3장중 하나 뽑기!") — CARD_DRAW_PICK(사적 3장 1택)
// AI 정책. 지시 그대로 "기존 픽 점수화(newCardValue 등)를 재사용, 새 평가 체계 금지"를
// 따른다 — 액티브 9종(A1~A4·A6~A10)은 evaluateActionChoiceOption을 그대로 재호출한다
// (통계값 재사용: card.aX.damage·statusValue.burn/freeze/a3Denial·newCardValue.a6~a10 —
// ACTION_CHOICE 옵션 스코어러와 완전히 같은 수식, 새로 만들지 않았다). 패시브 7종
// (P1~P7)은 evaluateActionChoiceOption에 대응 옵션 자체가 없다(액션이 아니라 상시
// 효과라 EV 공식이 없다) — 새 테이블을 만드는 대신 기존 config.ai.actionChoice.
// newCardValue.draw(뽑기 EV 근사 8, A3Denial과 같은 "값어치 근사 상수" 관례)를 그대로
// 재사용한다. ★확신 낮음(보고 대상) — 패시브 전부가 이 단일 고정값으로 묶이는 것은
// "패시브 간 우열을 가리지 않는다"는 뜻이라, 패시브 2장이 동시에 제시되면 배열 순서로만
// 갈린다(균등하게 나쁜 근사, 게임을 깨진 방향으로 왜곡하지는 않는다 — balance/D3 이월).
// ---------------------------------------------------------------------------

const DRAW_SCORABLE_ACTIVE_IDS = new Set(['A1', 'A2', 'A3', 'A4', 'A6', 'A7', 'A8', 'A9', 'A10']);

/** 제시된 카드 타입 1개(액티브 또는 패시브)의 "뽑을 가치" 근사. 재사용만, 신규 공식 없음. */
function evaluateDrawCardOption(cardType, view, config) {
  if (DRAW_SCORABLE_ACTIVE_IDS.has(cardType)) return evaluateActionChoiceOption(cardType, view, config);
  return config.ai.actionChoice.newCardValue.draw; // 패시브 — 대응 EV 공식이 없어 기존 "뽑기 EV 근사" 상수를 재사용
}

/**
 * L2/L3 공용 CARD_DRAW_PICK 핸들러 — offered(≤3장) 중 evaluateDrawCardOption 최댓값을
 * 결정론적으로 고른다(동률은 배열 순서상 먼저 나온 쪽, actionChoiceEvHandler와 동일
 * 관례). 만석이면 chooseDrawDiscard(기존 함수, 재사용)로 버릴 카드를 함께 정한다.
 * ★policy 스트림 미소비(순수 함수) — actionChoiceEvHandler와 동일 원칙.
 */
function cardDrawPickHandler(view, legalActions, policyStream, config) {
  const offered = legalActions.offered;
  let bestType = offered[0];
  let bestValue = evaluateDrawCardOption(offered[0], view, config);
  for (let i = 1; i < offered.length; i++) {
    const v = evaluateDrawCardOption(offered[i], view, config);
    if (v > bestValue) {
      bestValue = v;
      bestType = offered[i];
    }
  }
  const discard = legalActions.cardsFull ? chooseDrawDiscard(view, legalActions) : undefined;
  return { action: mkCardDrawPick(legalActions.actor, bestType, discard), candidatesEvaluated: offered.length, handEvalCalls: 0 };
}

/** ★G-A-10 — L1 및 EV 탐색을 하지 않는 프로브 티어의 CARD_DRAW_PICK 폴백(draftPickFallback과 동일 관례). */
function cardDrawPickFallback(view, legalActions, policyStream) {
  return { action: aiRandom.randomCardDrawPick(legalActions, policyStream), candidatesEvaluated: 1, handEvalCalls: 0 };
}

// ---------------------------------------------------------------------------
// 측정 프로브 정책 4종 — L1~L3와 동일 decide 인터페이스. 지정하지 않은 축은 L1(균등
// 무작위)로 폴백한다(★설계 판단 — probe는 "그 축을 어떻게 고정 관측할지"만 특화하고
// 나머지 축은 전부 동일 대조군으로 통제해야 F7-07류 재실측이 "그 축 하나만 바뀐"
// 결과라고 해석 가능하다).
// ---------------------------------------------------------------------------

function exchangeFallback(view, legalActions, policyStream) {
  return { action: aiRandom.randomExchange(legalActions, policyStream), candidatesEvaluated: 1, handEvalCalls: 0 };
}
function submitFallback(view, legalActions, policyStream) {
  return { action: aiRandom.randomSubmit(legalActions, policyStream), candidatesEvaluated: 1, handEvalCalls: 0 };
}
function actionChoiceFallback(view, legalActions, policyStream) {
  return { action: aiRandom.randomActionChoice(legalActions, policyStream), candidatesEvaluated: 1, handEvalCalls: 0 };
}
function draftPickFallback(view, legalActions, policyStream) {
  return { action: aiRandom.randomDraftPick(legalActions, policyStream), candidatesEvaluated: 1, handEvalCalls: 0 };
}

/** 제출 프로브 — always_best: 항상 최고 5장(F7-07 재실측용, S1 게이트④ L1 무작위 대비 기준선). */
function submitAlwaysBest(view, legalActions, policyStream, config, budget) {
  const limit = (config.ai.probes.alwaysBest && config.ai.probes.alwaysBest.budget) || config.ai.budget.L2;
  return submitBestHand(view, legalActions, policyStream, config, budget, limit);
}

/**
 * 제출 프로브 — hold_aware: 이번 판 승리값 + 이월(잔존 손패) 가치를 함께 고려.
 * ★J-4 합법성 패치(2026-08-16, R1 — 프로브 "측정 축" 로직은 무수정, 조커 적법성만
 * 최소 수정) — combinations5(불법 2조커+ 조합 포함 가능) → legalSubmitCombos로,
 * count<5 폴백(구 "손패 전량 제출")을 bestHand() 기반으로 교체. 안 고치면 조커가
 * 낀 판에서 이 프로브가 handleSubmit의 새 권위 검증에 걸려 완주 자체가 깨진다 —
 * "프로브 4종 무변경" 원칙(측정 축 보존)과 "완주 100%"(S1 게이트③) 둘 다 지키는
 * 최소 교집합이 이 패치다. residualWeight·스코어링 공식·잔존가치 정의는 전부 그대로.
 */
function submitHoldAware(view, legalActions, policyStream, config, budget) {
  if (legalActions.count < 5) {
    const r = bestHand(view.self.hand);
    if (!r) return { action: mkSubmit(legalActions.actor, legalActions.handIds.slice()), candidatesEvaluated: 0, handEvalCalls: 0 };
    return { action: mkSubmit(legalActions.actor, r.combo.map((c) => c.id)), candidatesEvaluated: 1, handEvalCalls: 1 };
  }
  const hand = view.self.hand;
  const cfg = (config.ai.probes && config.ai.probes.holdAware) || {};
  const limit = cfg.budget || 300;
  const residualWeight = cfg.residualWeight === undefined ? 0.08 : cfg.residualWeight;
  const weights = config.ai.cardValue;
  const combos = legalSubmitCombos(hand); // ★J-4 — 조커 ≤1 합법 조합만(combinations5 대신)

  let best = null;
  let evals = 0;
  for (const combo of combos) {
    if (budget.used + 1 > limit) break; // 소프트 캡 — 더 이상 후보를 보지 않고 지금까지의 최선으로 확정
    budget.used += 1;
    evals += 1;
    const comboIdSet = new Set(combo.map((c) => c.id));
    const ev = evaluateHand(combo);
    const thisRoundValue = scalarHandValue(ev);
    const deferred = hand.filter((c) => !comboIdSet.has(c.id));
    const residual = deferred.reduce((s, c) => s + cardKeepScore(c, hand, weights), 0);
    const score = thisRoundValue + residualWeight * residual;
    if (!best || score > best.score) best = { combo, score };
  }
  if (!best) {
    return {
      action: aiRandom.randomSubmit(legalActions, policyStream),
      fallback: true,
      note: 'budget-exceeded-before-any-eval',
      candidatesEvaluated: 0,
      handEvalCalls: 0,
    };
  }
  return { action: mkSubmit(legalActions.actor, best.combo.map((c) => c.id)), candidatesEvaluated: evals, handEvalCalls: evals };
}

/**
 * ★제출 프로브 — hold_aware_v2: hold_aware의 ★진단 전용 변형(S5 T3 통합진단 판정②,
 * 진행로그 "S5 T3 통합진단 (director)" 2026-08-15). **기존 `hold_aware`(submitHoldAware
 * 위)는 절대 수정하지 않는다** — 프로브 4종 무변경 지시(plan) 승계. 이 함수는 완전히
 * 별도 신설이고 POLICY_TABLE에도 별도 정책 ID로만 등록한다(B4 공식 판정에는 쓰지
 * 않는다 — PM/director 소관).
 *
 * 원본에서 코드 실물로 확인된 결함 2건(D-1·D-2)을 여기서만 고친다:
 *  ★D-1(문맥 오류): 원본은 `cardKeepScore(c, hand, weights)` — 시너지 카운트 기준이
 *    제출로 떠나는 5장까지 포함한 **전체 손패**였다(교환용 함수 `cardKeepScore`의 재사용
 *    부작용 — 그 함수 자체는 "손패가 유지되는" 문맥을 가정한다). 실제 이월 보유가치는
 *    "남는 3장 집합 안"의 시너지여야 한다 — 여기서는 ★`deferred`(이번 라운드에 실제로
 *    이월되는 카드만)를 문맥으로 넘긴다. 떠나는 파트너를 시너지로 세지 않으므로 "페어를
 *    쪼개서 이월에 남기는" 과대평가가 사라진다.
 *  ★D-2(런 신호 부재): 원본 `cardKeepScore`는 연속 랭크(스트레이트/조커 스트레이트
 *    재료) 신호가 0이다(ai.js:79-83 주석 — `runProximity`가 L3 전용으로 따로 존재하는
 *    이유 그대로). 여기서는 `runProximity(c, deferred)`를 residual에 더한다 — D-1과
 *    같은 이유로 문맥은 `deferred`로 통일한다(떠나는 카드를 "근접 랭크"로도 세지 않는다).
 *
 * config 자유도는 hold_aware(θ 1개)보다 1개 많다(residualWeight + runWeight) — 이건
 * "룰 속성을 재는" 프로브가 아니라 "프로브 결함 여부를 판별"하는 진단 도구라 정당하다
 * (합격선 §5-2의 "1파라미터 고정" 요구는 hold_aware 전용).
 */
// ★J-4 합법성 패치(2026-08-16, R1) — submitHoldAware와 동일 사유(위 주석 참조):
// combinations5→legalSubmitCombos, count<5 폴백을 bestHand() 기반으로. D-1/D-2
// 진단 로직·config 자유도는 전부 무수정.
function submitHoldAwareV2(view, legalActions, policyStream, config, budget) {
  if (legalActions.count < 5) {
    const r = bestHand(view.self.hand);
    if (!r) return { action: mkSubmit(legalActions.actor, legalActions.handIds.slice()), candidatesEvaluated: 0, handEvalCalls: 0 };
    return { action: mkSubmit(legalActions.actor, r.combo.map((c) => c.id)), candidatesEvaluated: 1, handEvalCalls: 1 };
  }
  const hand = view.self.hand;
  const cfg = (config.ai.probes && config.ai.probes.holdAwareV2) || {};
  const limit = cfg.budget || 300;
  const residualWeight = cfg.residualWeight === undefined ? 0.08 : cfg.residualWeight;
  const runWeight = cfg.runWeight === undefined ? 3 : cfg.runWeight;
  const weights = config.ai.cardValue;
  const combos = legalSubmitCombos(hand); // ★J-4 — 조커 ≤1 합법 조합만(combinations5 대신)

  let best = null;
  let evals = 0;
  for (const combo of combos) {
    if (budget.used + 1 > limit) break; // 소프트 캡 — 더 이상 후보를 보지 않고 지금까지의 최선으로 확정
    budget.used += 1;
    evals += 1;
    const comboIdSet = new Set(combo.map((c) => c.id));
    const ev = evaluateHand(combo);
    const thisRoundValue = scalarHandValue(ev);
    const deferred = hand.filter((c) => !comboIdSet.has(c.id));
    // ★D-1+D-2 수정 지점 — 문맥은 `deferred`(실제 이월 3장)로 통일, runProximity 항 추가.
    const residual = deferred.reduce(
      (s, c) => s + cardKeepScore(c, deferred, weights) + runWeight * runProximity(c, deferred),
      0
    );
    const score = thisRoundValue + residualWeight * residual;
    if (!best || score > best.score) best = { combo, score };
  }
  if (!best) {
    return {
      action: aiRandom.randomSubmit(legalActions, policyStream),
      fallback: true,
      note: 'budget-exceeded-before-any-eval',
      candidatesEvaluated: 0,
      handEvalCalls: 0,
    };
  }
  return { action: mkSubmit(legalActions.actor, best.combo.map((c) => c.id)), candidatesEvaluated: evals, handEvalCalls: evals };
}

function cardRankValue(card, config) {
  if (card.isJoker) {
    const cfg = config.ai.probes.rankFirst;
    return (cfg && cfg.jokerRankValue) || 15;
  }
  return card.rank;
}

/** 교환 프로브 — rank_first: 항상 랭크가 낮은 카드부터 버린다(장수는 L1과 동일 분포 롤). */
function exchangeRankFirst(view, legalActions, policyStream, config) {
  const hand = view.self.hand;
  const capEffective = legalActions.capEffective;
  const count = policyStream.nextInt(capEffective + 1);
  const sorted = hand.slice().sort((a, b) => cardRankValue(a, config) - cardRankValue(b, config) || (a.id < b.id ? -1 : 1));
  const discard = sorted.slice(0, count).map((c) => c.id);
  return { action: mkExchange(legalActions.actor, discard), candidatesEvaluated: 1, handEvalCalls: 0 };
}

/** 교환 프로브 — suit_first: 손패 내 소수 수트(장수가 적은 수트)부터 버린다(수트 집중 전략). */
function exchangeSuitFirst(view, legalActions, policyStream, config) {
  const hand = view.self.hand;
  const capEffective = legalActions.capEffective;
  const count = policyStream.nextInt(capEffective + 1);
  const suitCounts = countBySuit(hand);
  const cfg = config.ai.probes.suitFirst;
  const jokerAbundance = (cfg && cfg.jokerAbundance) || 99;
  const sorted = hand.slice().sort((a, b) => {
    const sa = a.isJoker ? jokerAbundance : suitCounts[a.suit];
    const sb = b.isJoker ? jokerAbundance : suitCounts[b.suit];
    if (sa !== sb) return sa - sb;
    return cardRankValue(a, config) - cardRankValue(b, config);
  });
  const discard = sorted.slice(0, count).map((c) => c.id);
  return { action: mkExchange(legalActions.actor, discard), candidatesEvaluated: 1, handEvalCalls: 0 };
}

// ---------------------------------------------------------------------------
// 정책 레지스트리 + 디스패치
// ---------------------------------------------------------------------------

// ★G-A-10 — CARD_DRAW_PICK 행 추가(모든 티어). L2/L3만 EV 기반(cardDrawPickHandler),
// 나머지는 전부 cardDrawPickFallback(L1 균등 무작위) — 기존 DRAFT_PICK 행과 동일 분포 원칙.
const POLICY_TABLE = {
  L2: { EXCHANGE: exchangeL2, SUBMIT: submitL2, ACTION_CHOICE: actionChoiceEvHandler, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickHandler },
  L3: { EXCHANGE: exchangeL3, SUBMIT: submitL3, ACTION_CHOICE: actionChoiceEvHandlerL3, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickHandler },
  always_best: { EXCHANGE: exchangeFallback, SUBMIT: submitAlwaysBest, ACTION_CHOICE: actionChoiceFallback, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickFallback },
  hold_aware: { EXCHANGE: exchangeFallback, SUBMIT: submitHoldAware, ACTION_CHOICE: actionChoiceFallback, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickFallback },
  // ★hold_aware_v2 — 진단 전용 신규 등록(위 submitHoldAwareV2 주석 참조). 기존 4종
  // (L2/L3/always_best·hold_aware·rank_first·suit_first에 대응하는 프로브 4종)은 이 행
  // 추가와 무관하게 전부 그대로다.
  hold_aware_v2: { EXCHANGE: exchangeFallback, SUBMIT: submitHoldAwareV2, ACTION_CHOICE: actionChoiceFallback, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickFallback },
  rank_first: { EXCHANGE: exchangeRankFirst, SUBMIT: submitFallback, ACTION_CHOICE: actionChoiceFallback, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickFallback },
  suit_first: { EXCHANGE: exchangeSuitFirst, SUBMIT: submitFallback, ACTION_CHOICE: actionChoiceFallback, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickFallback },
  // ★★D2-A(§12-1 D2-③) — 회복 스톨 진단 전용(다른 프로브 4종과 동일 지위 — 실전 AI가
  // 아니라 D3 위험측정 하네스 전용). EXCHANGE/SUBMIT/CARD_DRAW_PICK은 L2 그대로 재사용
  // (픽 점수화 불가침) — ACTION_CHOICE만 actionChoiceStall로 교체.
  stall: { EXCHANGE: exchangeL2, SUBMIT: submitL2, ACTION_CHOICE: actionChoiceStall, DRAFT_PICK: draftPickFallback, CARD_DRAW_PICK: cardDrawPickHandler },
};

const AI_POLICY_IDS = ['L1', 'L2', 'L3', 'always_best', 'hold_aware', 'hold_aware_v2', 'rank_first', 'suit_first', 'stall'];

function budgetLimitFor(tier, type, config) {
  if (tier === 'L2') return config.ai.budget.L2;
  if (tier === 'L3') return config.ai.budget.L3;
  if (tier === 'always_best' && type === 'SUBMIT') return (config.ai.probes.alwaysBest && config.ai.probes.alwaysBest.budget) || config.ai.budget.L2;
  if (tier === 'hold_aware' && type === 'SUBMIT') return (config.ai.probes.holdAware && config.ai.probes.holdAware.budget) || 300;
  if (tier === 'hold_aware_v2' && type === 'SUBMIT') return (config.ai.probes.holdAwareV2 && config.ai.probes.holdAwareV2.budget) || 300;
  if (tier === 'stall') return config.ai.budget.L2; // ★D2-A — EXCHANGE/SUBMIT은 L2 핸들러 그대로 재사용(위 POLICY_TABLE)
  return null;
}

/**
 * ★풍부한 반환(engine.js autoPlayGame이 AI_DECISION 이벤트의 candidatesEvaluated/
 * handEvalCalls/budgetUsed/budgetLimit/fallback을 실측치로 채우는 데 쓴다).
 */
function decideWithMeta(view, legalActions, tier, policyStream, config) {
  config = config || FALLBACK_CONFIG;
  if (tier === 'L1') {
    const action = aiRandom.dispatch(legalActions, policyStream);
    return { action, meta: { candidatesEvaluated: 1, handEvalCalls: 0, budgetUsed: 0, budgetLimit: null, fallback: false, note: null } };
  }
  const table = POLICY_TABLE[tier];
  if (!table) throw new Error(`ai.decide: 알 수 없는 AI tier "${tier}" — 등록된 정책: ${AI_POLICY_IDS.join(', ')}`);
  const handler = table[legalActions.type];
  if (!handler) throw new Error(`ai.decide: tier "${tier}"에 legalActions.type "${legalActions.type}" 핸들러가 없다`);
  const budget = { used: 0 };
  const result = handler(view, legalActions, policyStream, config, budget);
  return {
    action: result.action,
    meta: {
      candidatesEvaluated: result.candidatesEvaluated || 0,
      handEvalCalls: result.handEvalCalls !== undefined ? result.handEvalCalls : budget.used,
      budgetUsed: budget.used,
      budgetLimit: budgetLimitFor(tier, legalActions.type, config),
      fallback: !!result.fallback,
      note: result.note || null,
    },
  };
}

/** 공개 API 형태(action 객체만) — engine.js `decide()`가 이걸 그대로 재노출한다. */
function decide(view, legalActions, tier, policyStream, config) {
  return decideWithMeta(view, legalActions, tier, policyStream, config).action;
}

module.exports = {
  decide,
  decideWithMeta,
  AI_POLICY_IDS,
  // 관측 타입 + 감사(정보 접근 감사 — persona 요구 #6)
  buildL2Observation,
  buildL3Observation,
  auditAiObservation,
  AI_COUNTING_ALLOWED_PATHS,
  AI_FORBIDDEN_PATH_ROOTS,
  // 예산(테스트·자가검증용)
  nCr5,
  budgetedBestHand,
  // 내부 헬퍼(테스트·자가검증에서 직접 두드려볼 수 있게 노출)
  cardKeepScore,
  scalarHandValue,
  chooseDiscardIds,
  estimateSuitBreakdown,
  estimateJokerRemaining,
  suitValue,
  // ACTION_CHOICE EV 정책(S3 게이트② 재확보 — 테스트·자가검증·측정 스크립트 재사용)
  estimateDamage,
  // ★D1 — 구 computeOwnEffectiveMultiplier(P5 개인배수) 폐지. 대체 헬퍼:
  estimateRoundGap,
  computePotMultiplier,
  computeCritChance,
  computeCritExpectedMultiplier,
  evaluateActionChoiceOption,
  actionChoiceEvHandler,
  chooseDrawDiscard, // ★D1(§7-1)
  // ★G-A-10(2026-08-18) — CARD_DRAW_PICK(사적 3장 1택) 정책(테스트·자가검증·측정 스크립트 재사용)
  evaluateDrawCardOption,
  cardDrawPickHandler,
  cardDrawPickFallback,
  mkCardDrawPick,
  // L3 전용 ACTION_CHOICE 확장(시도 2/3)
  estimateSuitMomentum,
  estimateA4TimingBonus,
  evaluateActionChoiceOptionL3,
  actionChoiceEvHandlerL3,
  // 교환·제출 축 L3 강화(시도 3/3 — 테스트·자가검증·측정 스크립트 재사용)
  jokerScarcityFactor,
  l3KeepScore,
  // ★hold_aware_v2(S5 T3 진단 전용 — director 판정②, 2026-08-15). 기존 hold_aware 무변경.
  submitHoldAwareV2,
  // ★J-5(2026-08-16) — 캐릭터 기본 스킬 CHAR_SWAP 카드 선택(테스트·자가검증 재사용)
  chooseCharSwapDiscard,
  // ★★D2-A(§12-1 D2-②③) — "언제 뽑나" 정책 앵커 재도출 + 회복 스톨 전용 정책(테스트·자가검증·측정 스크립트 재사용)
  estimateDrawOptionValue,
  actionChoiceStall,
};
