'use strict';

/**
 * proto/engine/handEval.js
 *
 * 족보 판정기 — ★순수 함수만(PRNG 절대 미소비). S0 결정표 S-1~S-4, A-2 + ★2026-08-16
 * director 스펙 J-1~J-4(조커 완전 와일드화) 그대로.
 *
 * - S-1  "최고 5장" = C(n,5) 전수 평가에서 (①족보 등급 → ②비교 키) 사전식 최대.
 *        수트 레벨·기대 데미지 불포함. R4 판정과 동일 키를 쓴다.
 *        ★J-4/S-8 — "5장"은 이제 min(5, 비조커+min(조커,1))(제출 조커 상한 1)로
 *        정정됐다. `bestHand`/`legalSubmitCombos`는 이 갱신식을 그대로 따른다.
 * - S-2  구성 랭크 비교 키 + "킥커 없음" = 구성 집합 밖 카드는 비교에 불참.
 *        서열(낮→높): 하이카드<원페어<투페어<트리플<스트레이트<플러시<풀하우스
 *        <포카드<스트레이트플러시<★조커 스트레이트(A-2, 최상위).
 *        파이브카드(동일 랭크 5장)는 불인정 — 포카드로 판정, 구성 4장은
 *        논리 ID 정렬 앞 4장.
 * - S-3(★J-2로 정정) 조커 스트레이트 성립 시 최우선. 미성립 시(조커 1장, 조건 미달)
 *        = ★와일드 탐색(J-1) — 조커를 (랭크2~14×수트4) 임의 1장으로 간주해 엔진이
 *        자동으로 최적 배정을 찾는다(특권·페널티 없음, 해당 등급 그대로 비교). 조커
 *        2장 이상 포함된 조합(제출 자체는 J-4로 금지되나 `bestHand`의 손패 내부 후보
 *        탐색에는 등장 가능)은 기존대로 전부 죽은 카드(조합 폭발 방지 — J-1 산술이
 *        "제출 조커 ≤1"을 전제하므로 이 경계를 넘지 않는다).
 * - S-4  다중 수트 동시 발동(전부) + 레벨 상한(6, P4 보정 포함 최종값 클램프).
 *        ★J-3 — 와일드 배정된 조커도 배정 수트 1개의 1장으로 트리거·레벨에 참여
 *        (resolveSuitEffects가 evalResult.wildAssignment를 반영).
 * - A-2  조커 스트레이트 = 별도 최상위 등급, 효과 레벨 = 각 수트 lv2
 *        (조커를 4수트 각각의 1장으로 간주 — 1+1=2, ★JS 전용 특권으로 유지).
 */

const { SUITS, RANK_MIN, RANK_MAX, sortCardsById, sortCardsByRankDesc } = require('./cards');

const RANK_CATEGORY = Object.freeze({
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_KIND: 7,
  STRAIGHT_FLUSH: 8,
  JOKER_STRAIGHT: 9,
});

const RANK_CATEGORY_NAMES = [
  'HIGH_CARD',
  'ONE_PAIR',
  'TWO_PAIR',
  'TRIPS',
  'STRAIGHT',
  'FLUSH',
  'FULL_HOUSE',
  'FOUR_KIND',
  'STRAIGHT_FLUSH',
  'JOKER_STRAIGHT',
];

function compareKeyCompare(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] === undefined ? -Infinity : a[i];
    const bv = b[i] === undefined ? -Infinity : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

function compareEval(a, b) {
  if (a.rankCategory !== b.rankCategory) return a.rankCategory - b.rankCategory;
  return compareKeyCompare(a.compareKey, b.compareKey);
}

/**
 * 연속 run 탐색(휠 A 인정, 랩어라운드 금지).
 * distinctRanksDesc: 중복 없는 랭크 배열(내림차순, 2~14 포함 가능)
 * runLen: 필요한 연속 길이(5=일반 스트레이트, 4=조커 스트레이트)
 * 반환: 성립하는 최고 run의 "최고 카드"(휠이면 5, 아니면 실제 랭크) 또는 null
 */
function findStraightHigh(distinctRanksDesc, runLen) {
  const candidates = new Set(distinctRanksDesc);
  if (candidates.has(14)) candidates.add(1); // 휠: A를 1로도 사용 가능
  const sortedDesc = Array.from(candidates).sort((a, b) => b - a);
  for (const high of sortedDesc) {
    let ok = true;
    for (let k = 0; k < runLen; k++) {
      if (!candidates.has(high - k)) {
        ok = false;
        break;
      }
    }
    if (ok) return high;
  }
  return null;
}

/** 조커 스트레이트 성립 판정: 조커 아닌 카드 정확히 4장, 수트 전부 다름, 랭크 연속 4 */
function jokerStraightHigh(nonJokerFour) {
  if (nonJokerFour.length !== 4) return null;
  const suitSet = new Set(nonJokerFour.map((c) => c.suit));
  if (suitSet.size !== 4) return null;
  const ranks = nonJokerFour.map((c) => c.rank);
  const distinct = new Set(ranks);
  if (distinct.size !== 4) return null;
  const distinctDesc = Array.from(distinct).sort((a, b) => b - a);
  return findStraightHigh(distinctDesc, 4);
}

/**
 * "실카드"(조커 제외) N장(0~5)의 족보를 평가한다.
 * 스트레이트/플러시/스트레이트플러시는 N===5(전원 실카드)일 때만 가능.
 * 파이브카드(동일 랭크 5장)는 포카드로 강등, 구성 4장 = 논리 ID 정렬 앞 4장.
 */
// ★D-4(SG-J3, PM 지시 2026-08-16) — 결손(실카드 0장, 조커 2장+ 죽은 카드) 방어 케이스의
// compareKey 센티넬. 원래 -Infinity였으나 JSON.stringify(-Infinity)===null이라 이벤트
// 로그·export가 조용히 깨질 위험이 있었다(J-4의 min(5,비조커+min(조커,1))으로 4장 이하
// 제출이 이제 정상 경로가 되며 이 위험이 실재화 — S-8 결손이 더는 희귀 케이스가 아님).
// 유한 값(-1)으로 교체 — 모든 실제 compareKey 값(랭크 2~14 등, 항상 양수)보다 항상
// 작으므로 "어떤 실제 카드와 비교해도 항상 진다"는 의미가 완전히 보존된다.
// ★결손 손패(실카드 0장)에는 와일드 탐색을 적용하지 않는다(명시 — jokers.length가
// 0이거나 2장 이상일 때만 이 분기에 온다. jokers.length===1이면 evaluateHand가 항상
// findWildAssignment로 가상 카드 1장을 채워 넣어 real.length가 여기서 0이 될 수 없다).
const EMPTY_HAND_COMPARE_KEY_SENTINEL = -1;

function evaluateRealCards(real) {
  const n = real.length;
  if (n === 0) {
    // 조커만 2장 이상(혹은 죽은 조커로 실카드 0장) — 원리상 드문 방어적 케이스
    // (실제 SUBMIT은 J-4로 조커 ≤1이라 도달 불가, 직접 evaluateHand 호출(TC 등)에서만
    // 도달). 어떤 실제 카드와 비교해도 항상 지는 최하위 키를 부여한다.
    return { rankCategory: RANK_CATEGORY.HIGH_CARD, compareKey: [EMPTY_HAND_COMPARE_KEY_SENTINEL], constituentIds: [] };
  }

  const byRank = new Map();
  for (const c of real) {
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  const groups = Array.from(byRank.entries()).map(([rank, list]) => ({
    rank,
    count: list.length,
    cards: sortCardsById(list),
  }));
  groups.sort((a, b) => b.count - a.count || b.rank - a.rank);

  const distinctRanksDesc = groups.map((g) => g.rank).sort((a, b) => b - a);
  const suitSet = new Set(real.map((c) => c.suit));
  const isFlush = n === 5 && suitSet.size === 1;
  const straightHigh = n === 5 && distinctRanksDesc.length === 5 ? findStraightHigh(distinctRanksDesc, 5) : null;
  const isStraight = straightHigh !== null;

  if (isStraight && isFlush) {
    return {
      rankCategory: RANK_CATEGORY.STRAIGHT_FLUSH,
      compareKey: [straightHigh],
      constituentIds: sortCardsById(real).map((c) => c.id),
    };
  }

  const top = groups[0];
  const second = groups[1];

  if (top.count >= 4) {
    // 4장 이상(파이브카드 포함) → 포카드로 강등. 구성 4장 = 논리 ID 정렬 앞 4장(S-2).
    const four = top.cards.slice(0, 4);
    return { rankCategory: RANK_CATEGORY.FOUR_KIND, compareKey: [top.rank], constituentIds: four.map((c) => c.id) };
  }

  if (top.count === 3 && second && second.count >= 2) {
    const pairCards = second.cards.slice(0, 2);
    return {
      rankCategory: RANK_CATEGORY.FULL_HOUSE,
      compareKey: [top.rank, second.rank],
      constituentIds: [...top.cards, ...pairCards].map((c) => c.id),
    };
  }

  if (isFlush) {
    const desc = sortCardsByRankDesc(real);
    return { rankCategory: RANK_CATEGORY.FLUSH, compareKey: desc.map((c) => c.rank), constituentIds: desc.map((c) => c.id) };
  }

  if (isStraight) {
    return {
      rankCategory: RANK_CATEGORY.STRAIGHT,
      compareKey: [straightHigh],
      constituentIds: sortCardsById(real).map((c) => c.id),
    };
  }

  if (top.count === 3) {
    return { rankCategory: RANK_CATEGORY.TRIPS, compareKey: [top.rank], constituentIds: top.cards.map((c) => c.id) };
  }

  if (top.count === 2 && second && second.count === 2) {
    const hi = top.rank > second.rank ? top : second;
    const lo = top.rank > second.rank ? second : top;
    return {
      rankCategory: RANK_CATEGORY.TWO_PAIR,
      compareKey: [hi.rank, lo.rank],
      constituentIds: [...hi.cards, ...lo.cards].map((c) => c.id),
    };
  }

  if (top.count === 2) {
    return { rankCategory: RANK_CATEGORY.ONE_PAIR, compareKey: [top.rank], constituentIds: top.cards.map((c) => c.id) };
  }

  // 하이카드: 구성 집합 = 최고 1장뿐(S-2) → 2장 조건 미달로 수트 미발동이 자동 도출된다.
  const highest = sortCardsByRankDesc(real)[0];
  return { rankCategory: RANK_CATEGORY.HIGH_CARD, compareKey: [highest.rank], constituentIds: [highest.id] };
}

/**
 * ★J-1 — 조커 와일드 배정 탐색(순수 함수, PRNG 미소비). 조커 1장 + 실카드 n장(0~4)이
 * 주어지면, 조커를 (랭크 2~14 × 수트 4) = 52개 후보 중 하나로 간주해 evaluateRealCards
 * 결과가 최대가 되는 배정을 고른다.
 * 비교 순서: ①판정 키(rankCategory→compareKey, compareEval) 최대 → ②동률 시 suitScore
 * (구성 내 동일 수트 2장+ 그룹의 장수 합, cap/P4 보정 전 원시값) 최대 → ③그래도 동률이면
 * 갱신하지 않는다 — 후보 순회 자체가 SUITS(♠♥♦♣) 순서 × rank 오름차순 고정이라
 * "최초 발견 유지"가 곧 "고정 서열(♠♥♦♣ × 최저 랭크) 결정론 타이브레이크"다(별도 분기 불요).
 * 반환: { suit, rank, result:{rankCategory,compareKey,constituentIds}, suitScore }
 */
function computeSuitScoreForConstituent(constituentIds, cardsById) {
  const bySuit = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
  for (const id of constituentIds) {
    const c = cardsById[id];
    if (c && c.suit) bySuit[c.suit] += 1;
  }
  let score = 0;
  for (const suit of SUITS) if (bySuit[suit] >= 2) score += bySuit[suit];
  return score;
}

function findWildAssignment(joker, nonJokers) {
  let best = null;
  for (const suit of SUITS) {
    for (let rank = RANK_MIN; rank <= RANK_MAX; rank++) {
      const virtualCard = { id: joker.id, suit, rank, isJoker: false };
      const combined = nonJokers.concat([virtualCard]);
      const result = evaluateRealCards(combined);
      const cardsByIdLocal = {};
      for (const c of combined) cardsByIdLocal[c.id] = c;
      const suitScore = computeSuitScoreForConstituent(result.constituentIds, cardsByIdLocal);
      if (best === null) {
        best = { suit, rank, result, suitScore };
        continue;
      }
      const catCmp = compareEval(result, best.result); // rankCategory→compareKey만 참조(사전식)
      if (catCmp > 0) {
        best = { suit, rank, result, suitScore };
      } else if (catCmp === 0 && suitScore > best.suitScore) {
        best = { suit, rank, result, suitScore };
      }
      // 그 외(패배 또는 동률+suitScore 이하)는 갱신 안 함 — 위 주석의 ③ 고정 서열 타이브레이크.
    }
  }
  return best;
}

/**
 * 정확히 5장 이하(제출/후보/S-8 결손)를 평가한다.
 * 반환: { rankCategory, compareKey, constituent[](id 배열), deadJokers[](id 배열),
 *         isJokerStraight, wildAssignment:{jokerId,suit,rank}|null }
 */
function evaluateHand(cards) {
  if (cards.length > 5 || cards.length < 1) {
    // 정상 경로는 항상 정확히 5장이다(제출/후보). S-8 극단 결손(손패<5)만 1~4장으로
    // 들어올 수 있다 — evaluateRealCards가 n<5를 이미 우아하게 처리하므로 여기서는
    // 상한(5 초과)만 방어적으로 막는다.
    throw new Error(`evaluateHand: 1~5장만 허용, got ${cards.length}`);
  }
  const jokers = cards.filter((c) => c.isJoker);
  const nonJokers = cards.filter((c) => !c.isJoker);

  if (jokers.length === 1) {
    const high = jokerStraightHigh(nonJokers);
    if (high !== null) {
      return {
        rankCategory: RANK_CATEGORY.JOKER_STRAIGHT,
        compareKey: [high],
        constituent: sortCardsById([...jokers, ...nonJokers]).map((c) => c.id),
        deadJokers: [],
        isJokerStraight: true,
        wildAssignment: null,
      };
    }
    // ★J-2 폴백 — "죽은 카드"(구 S-3) → "와일드 탐색"(J-1)으로 교체. 와일드로 만든
    // 일반 족보는 특권·페널티 없이 해당 등급 그대로(자연 패와 동급 비교).
    const wa = findWildAssignment(jokers[0], nonJokers);
    return {
      rankCategory: wa.result.rankCategory,
      compareKey: wa.result.compareKey,
      constituent: wa.result.constituentIds,
      deadJokers: [],
      isJokerStraight: false,
      wildAssignment: { jokerId: jokers[0].id, suit: wa.suit, rank: wa.rank },
    };
  }

  // 조커 0장, 또는 2장 이상(제출 자체는 J-4로 금지되나 bestHand 내부 C(n,k) 후보 탐색에는
  // 등장 가능) → 기존 S-3 그대로: 전부 죽은 카드. J-1의 조합 폭발 방지 전제(제출 조커 ≤1)와
  // 정합 — 여기서 와일드 탐색을 2장 이상으로 확장하면 그 전제가 깨진다.
  const dead = jokers.map((c) => c.id);
  const result = evaluateRealCards(nonJokers);
  return {
    rankCategory: result.rankCategory,
    compareKey: result.compareKey,
    constituent: result.constituentIds,
    deadJokers: dead,
    isJokerStraight: false,
    wildAssignment: null,
  };
}

/** 일반 조합 생성기(k장, 순서 무관) — combinations5는 이제 이 함수의 k=5 특수형이다. */
function combinationsK(arr, k) {
  if (k < 0) return [];
  if (k === 0) return [[]];
  const result = [];
  const n = arr.length;
  const combo = [];
  (function rec(start) {
    if (combo.length === k) {
      result.push(combo.slice());
      return;
    }
    if (n - start < k - combo.length) return; // 가지치기: 남은 카드로 k장을 채울 수 없으면 중단
    for (let i = start; i < n; i++) {
      combo.push(arr[i]);
      rec(i + 1);
      combo.pop();
    }
  })(0);
  return result;
}

function combinations5(arr) {
  return combinationsK(arr, 5);
}

/**
 * ★R5①(PM 지시 2026-08-16, G-엔진 FAIL 수정) — 제출 조커 상한의 유일한 진실 원천.
 * 오너 확정 ④("조커 2장이면 제출 1장까지")의 숫자값은 여기 **한 곳**에만 존재한다.
 * `submitCountFor`(바로 아래)·`engine.js`의 `handleSubmit`(권위 검증)·`getLegalActions`
 * (메타 `jokerSubmitCap`)·`checkInvariants`(신규 JOKER_SUBMIT_LIMIT_A/B)가 전부 이
 * 상수 하나를 참조한다 — 예전에는 세 곳에 리터럴 `1`이 따로 박혀 있었다(같은 값이 우연히
 * 일치했을 뿐인 "두 번째·세 번째 진실 원천"). 값 자체는 오너 확정 수치라 config로 빼지
 * 않는다(config는 balance-designer가 조정할 잠정치용 — 이건 룰 확정치).
 */
const JOKER_SUBMIT_CAP = 1;

// ★W1(2026-08-17, director 스펙 A — ③ 가변 제출 2~5장) — 룰 확정치의 기본값.
// config.submit.min/max가 있으면 그걸 쓰고, 없으면(또는 config 인자 자체를 생략하면)
// 이 값으로 폴백한다 — "config에 외부화하되 기본 미적용"(director 스펙 A 문언 그대로):
// 기존 하드코딩 5·신규 하한 2와 바이트 단위로 동일하게 동작해야 한다.
const DEFAULT_SUBMIT_MIN = 2;
const DEFAULT_SUBMIT_MAX = 5;

function submitBounds(config) {
  const submitCfg = (config && config.submit) || {};
  const max = submitCfg.max === undefined || submitCfg.max === null ? DEFAULT_SUBMIT_MAX : submitCfg.max;
  const min = submitCfg.min === undefined || submitCfg.min === null ? DEFAULT_SUBMIT_MIN : submitCfg.min;
  return { min, max };
}

/**
 * ★A-2(PM 지시 2026-08-16) — 제출 장수 계약의 유일한 정본. engine.js의
 * `handleSubmit`(권위 검증)·`getLegalActions`(메타)·g2Analyzer.js(정의역/기대장수)가
 * 전부 이 함수 하나를 호출한다 — 계약이 여러 곳에 따로 박히면 한쪽만 갱신됐을 때
 * "어떤 제출도 통과 못 해 판이 멈추는데 에러 메시지는 엉뚱한 데를 가리키는" 사고가 난다.
 * ★A-1(PM 지시) — 조커 실제 보유 수는 4장 상한이 아니다(덱 리셔플이 구세대 카드를
 * 손패에 남긴 채 새 조커 4장을 또 만들 수 있어 한 손패에 5장 이상도 이론상 가능) —
 * 이 함수는 jokerCount 값 자체에 어떤 상한 가정도 두지 않는다(min(joker,JOKER_SUBMIT_CAP)만 쓴다).
 *
 * ★W1(2026-08-17, director 스펙 A) — ③ 가변 제출(2~5장) 갱신식.
 *   kMax = min(submit.max, 손패, 비조커+min(조커,JOKER_SUBMIT_CAP))
 *   kMin = kMax===0 ? 0 : max(1, min(submit.min, kMax))   ← "결손 손패 퇴화 케이스"
 *          (합법 최대가 1장뿐이면 1장 제출이 합법)를 이 식이 닫는다 — ★단 kMax===0
 *          (물리적으로 낼 카드가 0장)일 때만 kMin도 0(아래 SG-20 문단 참조. 그 밖의
 *          모든 kMax>=1 상태에서는 max(1,…)이 0장 제출을 원천 차단한다).
 * ★하위호환 — `expectedCount`는 kMax의 별칭으로 그대로 남긴다(구 소비자
 * g2Analyzer.js가 "정확히 5장" 전제로 이 필드를 읽는다 — G2 3분류 재정의는 W2
 * 트랙 소관이라 이 윈도에서 그 파일을 고치지 않는다. 가변 제출이 실제로 5장 미만을
 * 내면 g2Analyzer가 계약 위반으로 예외를 던지는 게 지금은 ★기대된 동작이다 — "버그"가
 * 아니라 "전제 변경"으로 보고한다).
 * ★config는 선택 인자 — 생략하면(구 호출부 전부) submit.min=2/max=5로 완전히 동일하게
 * 동작한다.
 *
 * ★★SG-20 수정(2026-08-17, qa-critic 적발 → PM 회부 → 반영) — ★★차단성★★. 원래
 * `kMin = min(submit.min, kMax)`였는데, 손패가 0장이면 kMax=0 → kMin=0이 되어
 * "0장 제출이 합법"이 성립해버린다. 이는 director가 명시적으로 기각한 설계("0장
 * 제출/패스 = 사실상 폴드, 확정 #35·#67 및 쇼다운 강제 원칙과 정면 충돌")를 하한식
 * 하나로 조용히 되살리는 구멍이었다.
 * ★수정: kMax>=1이면 kMin=max(1,min(submit.min,kMax)) — 카드가 1장이라도 있으면
 * 반드시 최소 1장은 낸다(폴드 경로 원천 차단).
 * ★★W3(2026-08-17, director SG-20 처방ⓐ 판정) — ★kMax===0 분기는 이제 **엔진 도달
 * 불가, TC 전용 정의역**이다(director 자기 정정 — 확정 문언 "kMin = max(1, min(submit.min,
 * kMax)) + 엔진은 SUBMIT 시점 kMax≥1을 보장한다"). 근거: SUBMIT 직전 유일한 손패 감소
 * 경로(EXCHANGE의 화상 수령 소실, engine.js handleExchange)가 이제 "해소 종료 시점
 * 손패 0장"을 만들 수 없도록 최소 1장을 보존한다(director 판정 1 — 이것은 폴드가
 * 아니라 물리적 쇼다운 불능이라 "전제조건 복구"로 처방했다). 그래도 이 함수는 순수
 * 함수 총정의성(어떤 hand 배열이 들어와도 정의된 값을 반환)을 위해 kMax===0 분기를
 * 존치한다 — TC/분석기가 결손 손패(예: 조커만 남은 손패)를 직접 두드릴 때만 이 분기에
 * 온다. ★이 경계 하나만 예외로 남기고(kMin=0), 그 밖의 모든 kMax>=1 상태에서는
 * 최소 1장을 강제한다.
 * ★A7(강요, W3 신규) — opts.forcedMin이 있으면(상대가 A7을 발동해 이번 라운드
 * 제출 하한이 올라간 상태) kMin = max(base kMin, min(forcedMin, kMax))로 재클램프한다
 * (S9 설계문서 §2-A7 "실제 하한 = min(forcedMin, kMax)" — 조커 결손 손패 퇴화 케이스를
 * 같은 min() 패턴으로 닫는다). kMax===0이면 forcedMin이 있어도 kMin은 여전히 0
 * (강요할 대상 자체가 없다 — 위 SG-20 경계와 동일 원칙).
 * ★도달 가능성 실측·보고(PM 요청, W1 기록) — SG-20 이전에는 hand.length===0 @SUBMIT이
 * 이론상 도달 가능했다(A3 예약폐기+EXCHANGE cap 우연 일치+BURN 전량 소실 조합,
 * 0.25^k 규모). ★W3 ⓐ 처방(handleExchange 최소 1장 보존)이 그 유일한 경로를 봉쇄해
 * 위 문단대로 "엔진 도달 불가"로 격상됐다 — director 판정(2026-08-17 SG-20 판정 3)
 * 참조.
 */
function submitCountFor(hand, config, opts) {
  const { min: minCfg, max: maxCfg } = submitBounds(config);
  const nonJokerCount = hand.filter((c) => !c.isJoker).length;
  const jokerCount = hand.length - nonJokerCount;
  const kMax = Math.max(0, Math.min(maxCfg, hand.length, nonJokerCount + Math.min(jokerCount, JOKER_SUBMIT_CAP)));
  // ★SG-20 — kMax===0(물리적으로 낼 카드가 없음, W3 이후 엔진 도달 불가·TC 전용 정의역)
  // 일 때만 kMin=0. 그 외에는 최소 1장 강제.
  let kMin = kMax === 0 ? 0 : Math.max(1, Math.min(minCfg, kMax));
  // ★W3(A7 「강요」) — 강요된 하한(forcedMin)이 있으면 base kMin과의 max, kMax와의
  // min으로 재클램프. kMax===0이면 낼 카드가 없으므로 forcedMin이 있어도 무시한다.
  const forcedMin = opts && opts.forcedMin;
  if (kMax > 0 && forcedMin) {
    kMin = Math.max(kMin, Math.min(forcedMin, kMax));
  }
  return { nonJokerCount, jokerCount, kMax, kMin, expectedCount: kMax };
}

/**
 * ★J-4/S-8 — 손패에서 만들 수 있는 "합법 제출 중 kMax짜리(구성 선택 1단계)" 조합
 * 전부를 생성한다. 장수 k = kMax(submitCountFor 그대로), 조커는 최대 1장까지만
 * 구성에 포함될 수 있다(2장 이상 포함 조합은 애초에 생성하지 않는다 — 제출 불가능한
 * 조합을 후보에 안 넣어야 bestHand()/AI 탐색/G2 "최강" 정의가 실제 합법 제출 공간과
 * 정확히 일치한다).
 * ★W1(2026-08-17, director 스펙 A "기둥 정리") — k<kMax(예: k=2~4)는 여기서 열거하지
 * 않는다. 비교 키가 킥커를 제외하므로 "도달 가능한 최강 키 = kMax에서 만든 조합의 키"와
 * 항상 같다(k장 부분집합의 키 ≤ 그것을 포함한 kMax장의 키) — k<kMax 열거는 "최강이
 * 무엇인가"를 구하는 데 불필요하다. 실제 제출은 kMax짜리 조합 중 일부만 낼 수도 있는데
 * (가변 제출), 그 "몇 장을 낼지" 결정은 이 함수의 소관이 아니다(engine.js handleSubmit의
 * 권위 검증은 장수 범위[kMin,kMax]+조커 상한만 보고, AI의 "장수/보존" 결정은
 * ai.js의 2단계 — cardKeepScore 계열 — 가 담당한다. 전부 이 함수 위에서 조립된다).
 */
function legalSubmitCombos(hand, config) {
  const nonJokers = hand.filter((c) => !c.isJoker);
  const jokers = hand.filter((c) => c.isJoker);
  const { kMax: k } = submitCountFor(hand, config);
  if (k < 1) return [];
  const combos = [];
  if (nonJokers.length >= k) {
    for (const c of combinationsK(nonJokers, k)) combos.push(c);
  }
  if (jokers.length >= 1 && nonJokers.length >= k - 1) {
    const bases = combinationsK(nonJokers, k - 1);
    for (const b of bases) {
      for (const j of jokers) combos.push(b.concat([j]));
    }
  }
  return combos;
}

/**
 * S-1: 손패(8장, P1이면 9장)에서 "최강의 합법 제출(kMax짜리)"을 고른다.
 * ★J-4/S-8 — legalSubmitCombos()(조커 ≤1, 장수 = kMax)를 전수
 * 평가 → (①등급 ②비교 키) 사전식 최대. 동률이면 먼저 찾은 조합을 반환한다(동률 후보
 * 전부가 필요한 곳은 C그룹 분석기 — 엔진 자체는 대표 1개만 반환).
 * ★D-5(SG-J2, PM 지시) — suitScore(J-1 ②단계) 타이브레이크는 "조커의 와일드 배정"
 * 선택에서만 작동한다(findWildAssignment 내부). 이 함수(어느 5장 "조합"을 고를지
 * 결정하는 층)에는 suitScore 기준이 없다 — 등급·키가 동률인 서로 다른 조합 중 수트가
 * 약한 쪽이 반환될 수 있다(현행 유지, ★의도적). 정본 J-1은 "조커 배정"의 순위만
 * 규정했고 "조합 선택"의 동률 타이브레이크는 스펙 공백이다 — 임의로 여기에 suitScore를
 * 넣으면 기존 제출 거동이 바뀌어 회귀 범위가 폭발한다(스코프 밖, PM/director 판단 필요).
 * 손패가 0장이면 null(호출부가 방어적으로 처리).
 * ★config는 선택 인자(submitCountFor·legalSubmitCombos로 그대로 전달) — 생략하면
 * 기존과 완전히 동일하게 동작한다.
 */
function bestHand(hand, config) {
  if (!hand || hand.length < 1) return null;
  const combos = legalSubmitCombos(hand, config);
  let best = null;
  for (const combo of combos) {
    const ev = evaluateHand(combo);
    if (!best || compareEval(ev, best.eval) > 0) {
      best = { combo, eval: ev };
    }
  }
  return best;
}

/**
 * S-4: 다중 수트 동시 발동 + 레벨 상한.
 * evalResult: evaluateHand()의 반환값. cardsById: 그 5장(id→card)의 조회 맵.
 * opts: { levelCap, p4Bonus } — p4Bonus는 S2 훅(문양 집착 카드), S1에서는 항상 0.
 * 반환: { triggers:[{suit,countInConstituent,levelBase,levelAfterP4,levelFinal,cappedOverflow,sourceCardIds}],
 *         simultaneousCount, constituentRef }
 * ★순수 함수 — PRNG 미소비.
 */
function resolveSuitEffects(evalResult, cardsById, opts) {
  const levelCap = (opts && opts.levelCap) || 6;
  const p4Bonus = (opts && opts.p4Bonus) || 0;
  const triggers = [];

  if (evalResult.isJokerStraight) {
    // A-2: 조커를 4수트 각각의 1장으로 간주 — 실카드 1장(해당 수트) + 조커 가상 1장 = lv2
    for (const suit of SUITS) {
      const levelBase = 2;
      const levelAfterP4 = levelBase + p4Bonus;
      const levelFinal = Math.min(levelAfterP4, levelCap);
      const cappedOverflow = Math.max(0, levelAfterP4 - levelCap);
      const sourceCardIds = evalResult.constituent.filter((id) => {
        const c = cardsById[id];
        return c && c.suit === suit;
      });
      triggers.push({ suit, countInConstituent: 1, levelBase, levelAfterP4, levelFinal, cappedOverflow, sourceCardIds });
    }
    return { triggers, simultaneousCount: triggers.length, constituentRef: evalResult.constituent.slice() };
  }

  // ★J-3 버그 수정(R1 구현 중 발견) — cardsById는 실제 제출 카드 객체(물리 조커는
  // suit:null)로 만들어지므로, 와일드 배정 수트는 원래 여기서 조용히 누락됐다(조커가
  // 배정 수트의 1장으로 트리거·레벨에 참여한다는 J-3/오너 확정②가 구현돼도 작동하지
  // 않는 상태였음). evalResult.wildAssignment가 있으면 그 조커 id만 배정 수트로 직접
  // 계상하고, 그 외 카드는 기존대로 cardsById에서 수트를 읽는다.
  const wildSuit = evalResult.wildAssignment ? evalResult.wildAssignment.suit : null;
  const wildId = evalResult.wildAssignment ? evalResult.wildAssignment.jokerId : null;
  const bySuit = { '♠': [], '♥': [], '♦': [], '♣': [] };
  for (const id of evalResult.constituent) {
    if (id === wildId) {
      bySuit[wildSuit].push(id);
      continue;
    }
    const c = cardsById[id];
    if (c && c.suit) bySuit[c.suit].push(id);
  }
  for (const suit of SUITS) {
    const count = bySuit[suit].length;
    if (count >= 2) {
      const levelBase = count;
      const levelAfterP4 = levelBase + p4Bonus;
      const levelFinal = Math.min(levelAfterP4, levelCap);
      const cappedOverflow = Math.max(0, levelAfterP4 - levelCap);
      triggers.push({ suit, countInConstituent: count, levelBase, levelAfterP4, levelFinal, cappedOverflow, sourceCardIds: bySuit[suit] });
    }
  }
  return { triggers, simultaneousCount: triggers.length, constituentRef: evalResult.constituent.slice() };
}

module.exports = {
  RANK_CATEGORY,
  RANK_CATEGORY_NAMES,
  compareKeyCompare,
  compareEval,
  findStraightHigh,
  jokerStraightHigh,
  evaluateRealCards,
  evaluateHand,
  combinationsK,
  combinations5,
  submitCountFor, // ★A-2 — 제출 장수 계약의 유일한 정본(engine.js·g2Analyzer.js 공유)
  JOKER_SUBMIT_CAP, // ★R5① — 제출 조커 상한의 유일한 진실 원천(engine.js가 공유 — 하드코딩 재발 방지)
  submitBounds, // ★W1(2026-08-17) — config.submit.min/max 해석(기본 2/5). 진단·TC에서 직접 두드려볼 수 있게 노출.
  DEFAULT_SUBMIT_MIN,
  DEFAULT_SUBMIT_MAX,
  legalSubmitCombos, // ★J-4/S-8 — 합법 제출 조합 생성기(조커 ≤1). AI/G2 분석기가 combinations5 대신 이걸 쓴다.
  EMPTY_HAND_COMPARE_KEY_SENTINEL, // ★D-4 — 결손 손패 compareKey 센티넬 값(JSON-safe)
  findWildAssignment, // ★J-1 — 와일드 배정 탐색(테스트·검증에서 직접 두드려볼 수 있게 노출)
  computeSuitScoreForConstituent,
  bestHand,
  resolveSuitEffects,
};
