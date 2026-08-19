'use strict';

/**
 * proto/engine/engine.js
 *
 * ★룰 엔진 코어(포커 층) — 유일한 상태변경 진입점은 applyAction.
 * API: createEngine / applyAction / getLegalActions / getPublicView / decide /
 *      exportReplay / replay (+ autoPlayGame·runBatch 편의 함수)
 *
 * 리플레이 3원칙: ① 액션 로그(입력)/이벤트 로그(출력) 2계층 분리, 이벤트 로그는
 * applyAction(actions)로 재생산 가능하므로 원칙적 비보관 ② get*·preview*는 순수
 * (PRNG 미소비, state 불변) — PRNG는 applyAction 내부에서만 소비 ③ 카드 참조는
 * 논리 ID(`suit+rank+copyIndex`, 조커는 `JOKER#k`).
 */

const { createRngStreams, cloneStreams, fnv1a } = require('./rng');
const { DECK_SIZE, JOKER_COPIES, buildFreshDeckCards } = require('./cards');
const {
  RANK_CATEGORY_NAMES,
  evaluateHand,
  bestHand,
  compareEval,
  compareKeyCompare,
  resolveSuitEffects,
  submitCountFor, // ★A-2 — 제출 장수 계약의 유일한 정본(handEval.js). handleSubmit·getLegalActions가 공유.
  JOKER_SUBMIT_CAP, // ★R5① — 제출 조커 상한의 유일한 진실 원천(handEval.js). handleSubmit·getLegalActions·checkInvariants가 공유.
} = require('./handEval');
const { EVENT_TYPE, PHASE, SCHEMA_VERSION, mkEvent, mkDiagnosticEvent } = require('./events');
const { clamp, changeSp, healHp, maxHpFor } = require('./util');
const { applyStatus, tickStatuses, freezeExchangePenalty, rollBurn } = require('./status');
const draft = require('./draft');
const ai = require('./ai'); // ★S3 — L2/L3/프로브 4종. L1 로직 자체는 aiRandom.js에 있고 ai.js가 위임한다.

const DEFAULT_CONFIG = require('./config/current.json');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  // ★R7-A(2026-08-17) 실측 발견 — typeof null === 'object'(JS 함정)라 base가 null인
  // 리프(예: player.maxHpA의 기본값 null)를 override가 덮어쓰려 하면 이 조건이 "객체"로
  // 오판해 Object.keys(null)로 재귀해 죽는다(에러 재현: buildConfig({player:{maxHpA:100}})).
  // base===null도 명시적으로 리프 취급해야 한다 — 이 전까지 config에 null 기본값을 가진
  // 필드가 없어 잠들어 있던 결함(내가 처음으로 null 기본값을 도입하며 노출시켰다).
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] = Object.prototype.hasOwnProperty.call(override, k) ? deepMerge(base[k], override[k]) : base[k];
  }
  for (const k of Object.keys(override)) {
    if (!(k in out)) out[k] = override[k];
  }
  return out;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.getOwnPropertyNames(obj).forEach((key) => deepFreeze(obj[key]));
    Object.freeze(obj);
  }
  return obj;
}

/**
 * ★D1(FIX-2 §3·§10 B-3) — 「알려진 비호환」 명시 오류. `damage.defensePosition`·
 * `job.baseDefense`·`buff.defPerStack`·`multiplier.*`·`p5.*`(구 P5 개인배수)는 D1에서
 * 3좌표(config 키+resolveDamage 분기+DAMAGE 이벤트 필드) 동시 삭제됐다 — 구 export를
 * 조용히 무시하고 진행하면 로그 소비 스크립트가 `undefined`를 읽고도 통과한다(§3 금지
 * 사항). 사용자 config에 이 키들이 하나라도 남아 있으면(=구 레짐 export) 즉시 던진다.
 */
const KNOWN_INCOMPATIBLE_CONFIG_PATHS = [
  ['damage', 'defensePosition'],
  ['job', 'baseDefense'],
  ['buff', 'defPerStack'],
  ['multiplier'],
  ['p5'],
];
function assertNoKnownIncompatibleConfig(userConfig) {
  if (!userConfig || typeof userConfig !== 'object') return;
  for (const path of KNOWN_INCOMPATIBLE_CONFIG_PATHS) {
    let cur = userConfig;
    let found = true;
    for (const key of path) {
      if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, key)) {
        cur = cur[key];
      } else {
        found = false;
        break;
      }
    }
    if (found) {
      throw new Error(
        `KNOWN_INCOMPATIBLE_REPLAY: config.${path.join('.')} 는 D1(FIX-2 §3)에서 삭제된 구 레짐 키다 — ` +
          `이 config/export는 방어 축·구 P5 개인배수·구 팟(multiplier) 세계에서 만들어졌다. 조용한 무시 대신 명시적 비호환으로 처리한다.`
      );
    }
  }
}

/**
 * ★D1(FIX-2 §12-1 B2·[F9-24]) — 종료 산술 불변식: max(♥회복/라운드) < min(라운드당
 * 기대 피해)가 config만으로 판정 가능해야 한다(시드·배치 불요, 순수 함수). B2(회복
 * 스톨)를 D3의 대량 시뮬레이션까지 끌지 않고 D1에서 구조적으로 막는다.
 * ★근사(낮은 확신, 보고 대상) — "라운드당 기대 피해"의 정확한 값은 AI 정책의 뽑기
 * 선택 확률에 의존해 순수 config로는 진짜 기댓값을 낼 수 없다(뽑기가 winner의
 * 정당한 SP 임계 행동이 된 이후로는 「그 라운드 공격이 반드시 나온다」는 보장이
 * 없다). 여기서는 "승자가 실제로 공격을 택했을 때"의 구조적 최솟값(무버프·무팟·
 * 무크리·동급(d=0) 격차)을 하한으로 근사한다 — 실제 기대값은 이보다 항상 크거나
 * 같다(가장 보수적인 방향의 근사라 「실패해야 할 때 통과」할 위험은 낮지만, DRAW
 * 선택 확률이 높은 세계에서는 이 하한 자체가 무의미해질 수 있다).
 */
function checkTerminationArithmetic(config) {
  const maxHealPerRound = config.heal.perLevel * config.suit.levelCap;
  // ★정정(F15-26, PM 판정) — 이 근사는 「보수적 하한」이 목적이라 half-up round가 아니라
  // Math.floor가 의미상 맞다: 하한을 반올림으로 올리면(예 .5 절상) 근사가 실제 최소
  // 데미지보다 커질 수 있어 보수성이 깨진다. 데미지 파이프라인 본체의 half-up 반올림
  // (engine.js의 resolveDamage — §3 "정수화 = 최종 1회, half-up")과는 다른 지점이고
  // 다른 의미다 — 이 함수가 Math.floor로 바뀜으로써 「데미지 파이프라인의 반올림 =
  // Math.round 정확히 1곳」이 참이 된다.
  const minSingleAttackDamage = Math.max(config.damage.floor, Math.floor(config.job.baseAttack * config.gap.evenDelta));
  const ok = maxHealPerRound < minSingleAttackDamage;
  return { ok, maxHealPerRound, minRoundDamage: minSingleAttackDamage };
}

/** ★G8(잠정): 판 도중 config 변경 불허 — 판 시작 시 config를 deepFreeze해 스냅샷 고정한다. */
function buildConfig(userConfig) {
  assertNoKnownIncompatibleConfig(userConfig); // ★D1 — 구 export 명시적 비호환(§3)
  const merged = JSON.parse(JSON.stringify(deepMerge(DEFAULT_CONFIG, userConfig || {})));
  return deepFreeze(merged);
}

// ---------------------------------------------------------------------------
// state 초기화 · clone
// ---------------------------------------------------------------------------

function initPlayer(config, character, actor) {
  return {
    hp: maxHpFor(config, actor), // ★R7-A — 좌석 자기 max로 시작(미지정 시 config.player.maxHp와 동일)
    sp: 0,
    hand: [],
    cards: [],
    character: character || null, // ★J-5 — 'SMASH'|'SWAP'. 드래프트 풀 밖(고정 보유) — player.cards에는 절대 안 들어감.
    buffStacks: { '♠': 0, '♦': 0 },
    status: { BURN: null, FREEZE: null },
    pendingSubmission: null,
    pendingHandBefore: null,
    lastExchangeCount: 0,
    pendingA3Discards: 0, // ★A3(패 훔치기) 예약 폐기 카운터 — 다음 보충 직후 소비(카드문서 §2-A3 정정판)
    // ★W3(2026-08-17, 신규 카드 6종) — lastSubmittedCards: 이번 라운드 제출한 실카드
    // 객체 배열(A6 「환수」가 읽는다). ★cleanupSubmissionTemp는 이 필드를 건드리지
    // 않는다(pendingSubmission/pendingHandBefore와 분리 — ACTION_CHOICE 시점엔 이미
    // pendingSubmission이 null로 정리돼 있어 A6가 읽을 데이터가 없어지기 때문에 별도
    // 필드로 R5_BATTLE(ACTION_CHOICE)까지 생존시킨다). 다음 handleSubmit이 덮어쓴다.
    lastSubmittedCards: null,
    forcedSubmitMin: null, // ★A7(강요) — {value, remaining, source, appliedRound}|null. 다음 SUBMIT kMin 하한 강제.
    revealedTo: null, // ★A9(투시) — {byActor, ids[], expiresRound}|null. "발동한 쪽에만" 공개(D1 예외 ⓑ).
  };
}

function clonePlayer(p) {
  return {
    hp: p.hp,
    sp: p.sp,
    hand: p.hand.slice(),
    cards: p.cards.slice(),
    character: p.character, // ★J-5 — 문자열(불변) 값 복사
    buffStacks: { '♠': p.buffStacks['♠'], '♦': p.buffStacks['♦'] },
    status: {
      // ★appliedRound도 반드시 clone — 승자가 스킬로 상태이상을 걸고(이번 applyAction) 이후
      // 패자 턴에서 tickStatuses가 도는 경우(다음 applyAction), 두 호출 사이에 clonePlayer가
      // 끼어든다. 이 필드가 누락되면 "적용 라운드엔 틱 안 함" 버그 수정이 절반만 동작한다.
      BURN: p.status.BURN ? { remaining: p.status.BURN.remaining, source: p.status.BURN.source, appliedRound: p.status.BURN.appliedRound } : null,
      FREEZE: p.status.FREEZE ? { remaining: p.status.FREEZE.remaining, source: p.status.FREEZE.source, appliedRound: p.status.FREEZE.appliedRound } : null,
    },
    pendingSubmission: p.pendingSubmission ? p.pendingSubmission.slice() : null,
    pendingHandBefore: p.pendingHandBefore ? p.pendingHandBefore.slice() : null,
    lastExchangeCount: p.lastExchangeCount,
    pendingA3Discards: p.pendingA3Discards,
    lastSubmittedCards: p.lastSubmittedCards ? p.lastSubmittedCards.slice() : null, // ★W3(A6)
    forcedSubmitMin: p.forcedSubmitMin ? Object.assign({}, p.forcedSubmitMin) : null, // ★W3(A7)
    revealedTo: p.revealedTo ? { byActor: p.revealedTo.byActor, ids: p.revealedTo.ids.slice(), expiresRound: p.revealedTo.expiresRound } : null, // ★W3(A9)
  };
}

function cloneState(state) {
  return {
    v: state.v,
    gameId: state.gameId,
    seedRoot: state.seedRoot,
    config: state.config, // deepFreeze됨 — 판 내내 불변, 참조 공유 안전
    rng: cloneStreams(state.rng),
    seqCounter: state.seqCounter,
    round: state.round,
    deck: { id: state.deck.id, idCounter: state.deck.idCounter, cards: state.deck.cards.slice(), pointer: state.deck.pointer },
    players: { A: clonePlayer(state.players.A), B: clonePlayer(state.players.B) },
    pot: { value: state.pot.value }, // ★D1 — 구 state.multiplier 대체(팟, 공유 단일값)
    roundWins: { A: state.roundWins.A, B: state.roundWins.B }, // ★D1(§6-6 하드캡 판정승 체인)
    lastDecisiveWinner: state.lastDecisiveWinner, // ★D1(§6-6 판정승 체인 ③)
    floorReachedCount: state.floorReachedCount, // ★D1([F15-26]) — 피해 하한 도달 누적(불변식)
    capReachedCount: state.capReachedCount, // ★D2 잔여(곱 상한 선배선, off) — 상한 도달 누적(관찰 지표)
    matchId: state.matchId, // ★D1(§18 계측 substrate)
    gameIndexInMatch: state.gameIndexInMatch,
    draft: {
      pool: new Set(state.draft.pool),
      cycleCounter: state.draft.cycleCounter,
      forcedOff: state.draft.forcedOff,
      pendingOffer: state.draft.pendingOffer
        ? {
            list: state.draft.pendingOffer.list.slice(),
            loserEligible: state.draft.pendingOffer.loserEligible,
            winner: state.draft.pendingOffer.winner,
            loser: state.draft.pendingOffer.loser,
            _winnerDone: state.draft.pendingOffer._winnerDone,
            _loserDone: state.draft.pendingOffer._loserDone,
          }
        : null,
    },
    cardDrawOffer: state.cardDrawOffer // ★G-A-10 — 얕은 값 필드뿐이라 offered 배열만 slice, 나머지는 값 복사로 충분
      ? { actor: state.cardDrawOffer.actor, offered: state.cardDrawOffer.offered.slice(), isWinner: state.cardDrawOffer.isWinner, full: state.cardDrawOffer.full, eligibleCount: state.cardDrawOffer.eligibleCount }
      : null,
    pendingQueue: state.pendingQueue.map((q) => Object.assign({}, q)),
    actionLog: state.actionLog.slice(),
    terminal: state.terminal,
    terminalReason: state.terminalReason,
    winner: state.winner,
    prevOutcome: state.prevOutcome,
    roundCache: state.roundCache ? Object.assign({}, state.roundCache) : null,
    lastRevealedSubmission: state.lastRevealedSubmission ? JSON.parse(JSON.stringify(state.lastRevealedSubmission)) : null,
    cardAccounting: Object.assign({}, state.cardAccounting),
    forcedAssignmentSpec: state.forcedAssignmentSpec ? JSON.parse(JSON.stringify(state.forcedAssignmentSpec)) : null,
    forcedHandSpec: state.forcedHandSpec ? JSON.parse(JSON.stringify(state.forcedHandSpec)) : null, // ★SG-2 하네스
    matchCarryOverSpec: state.matchCarryOverSpec ? JSON.parse(JSON.stringify(state.matchCarryOverSpec)) : null, // ★D2-A(§6-1)
  };
}

// ---------------------------------------------------------------------------
// 덱 관리
// ---------------------------------------------------------------------------

function replaceDeck(state, events, pendingDealActor) {
  const remaining = state.deck.cards.slice(state.deck.pointer);
  const discardedCount = remaining.length;
  state.cardAccounting.discardedAtReplace += discardedCount;

  state.deck.idCounter += 1; // ★새 세대 번호 — 카드 id에 반영해 구세대 잔존 카드와 충돌을 막는다(cards.js 주석 참조)

  const drawsBefore = state.rng.deck.draws;
  const fresh = buildFreshDeckCards(state.deck.idCounter);
  state.rng.deck.shuffle(fresh); // ★새 덱은 셔플한다(딜 예측 불가) — "섞지 않는다"는 폐기 잔여를 다시 섞어 넣지 않는다는 뜻(§1-2)
  const drawsAfter = state.rng.deck.draws;

  state.deck.id = `deck-${state.deck.idCounter}`;
  state.deck.cards = fresh;
  state.deck.pointer = 0;

  events.push(
    mkEvent(state, {
      phase: PHASE.R2_EXCHANGE,
      actor: null,
      type: EVENT_TYPE.DECK_REPLACED,
      rng: { stream: 'deck', drawsBefore, drawsAfter },
      fields: {
        discardedRemaining: remaining.map((c) => c.id),
        discardedCount,
        newDeckId: state.deck.id,
        newDeckSize: DECK_SIZE,
        shuffled: false, // 폐기된 잔여를 새 덱에 다시 섞어 넣지 않았다는 뜻(§1-2) — 새 덱 자체의 내부 순서는 위에서 별도로 셔플됨
        pendingDealActor: pendingDealActor || null,
      },
    })
  );
}

function drawN(state, n, events, actor) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.pointer >= state.deck.cards.length) {
      replaceDeck(state, events, actor);
    }
    out.push(state.deck.cards[state.deck.pointer]);
    state.deck.pointer += 1;
  }
  return out;
}

function deckRemainingCount(state) {
  return state.deck.cards.length - state.deck.pointer;
}

function deckRemainingBySuit(state) {
  const counts = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
  for (let i = state.deck.pointer; i < state.deck.cards.length; i++) {
    const c = state.deck.cards[i];
    if (c.suit) counts[c.suit] += 1;
  }
  return counts;
}

function deckRemainingJokers(state) {
  let n = 0;
  for (let i = state.deck.pointer; i < state.deck.cards.length; i++) {
    if (state.deck.cards[i].isJoker) n += 1;
  }
  return n;
}

/**
 * ★W3(P6 「예지」) — 공유 덱 상단 n장(그대로, 셔플·소비 없음 — 순수 조회). P3
 * (deckRemainingBySuit — 집계)와 대상이 다르다: P6는 "다음에 뽑힐 실물 카드"를
 * 그대로 노출한다(S9 설계문서 §2-P6). getPublicView에서만 호출(순수 함수 — 리플레이
 * 3원칙 ②).
 */
function deckTopCards(state, n) {
  const out = [];
  for (let i = state.deck.pointer; i < state.deck.cards.length && out.length < n; i++) {
    const c = state.deck.cards[i];
    out.push({ id: c.id, rank: c.rank, suit: c.suit, copyIndex: c.copyIndex, isJoker: c.isJoker });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 손패 상한 · 교환 상한(★S2 훅: computeExchangeCap)
// ---------------------------------------------------------------------------

/** 보유 카드 중 id와 정확히 일치하는 장수(존재 여부가 아니라 「장수」로 센다 — C4, §6-5). */
function countCard(player, id) {
  let n = 0;
  for (const c of player.cards) if (c === id) n += 1;
  return n;
}

/**
 * §1 R1: 8장(P1 보유 시 +1) — P1은 라운드 핵심규칙에 직접 명시돼 S1에서 배선한다.
 * ★D1(C4, §6-5) — 패시브 중복 보유는 중첩된다(존재 판정 indexOf → 「장수」 카운트).
 */
function getHandCap(player, config) {
  return config.player.handCapBase + countCard(player, 'P1') * config.player.handCapP1Bonus;
}

/**
 * ★W3(2026-08-17, 신규 카드 P7 「각인」) — 보유 기준 유효 수트 버프 상한(S9 설계문서
 * §8 "buff.stackCap을 보유 기준 유효값으로 읽는 경로 1곳"). P7은 상한(누적 한도)만
 * 올린다 — 발동 순간의 크기(레벨)를 올리는 P4와는 다른 축(§2-P7).
 * ★D1(C4, §6-5) — 패시브 중복 보유는 중첩(장수 카운트).
 */
function effectiveStackCap(player, config) {
  return config.buff.stackCap + countCard(player, 'P7') * config.card.p7.stackCapBonus;
}

/**
 * ★★W3(2026-08-17, P7 「각인」 구현 중 실측 적발 — 판단이 갈린 지점, PM 보고 대상) —
 * P7이 만든 상한 상승은 applySuitEffect가 스택을 쌓는 "그 순간"에만 반영된다. buffStacks
 * 를 줄이는 경로는 이 함수 하나뿐이라, "P7 보유 중 상한 3까지 쌓고 → 드래프트 만석
 * 스왑으로 P7을 잃는다"가 성립하면 유효 상한이 2로 되돌아가도 스택 3이 그대로 남아
 * BUFF_BOUNDS 불변식을 **영구히** 위반한다(회귀 배치 실측 적발: seed 2970013, B가
 * R3에 P7 픽·R25에 ♠스택 3 도달·R33에 P7을 P5로 드래프트 스왑, R34부터 위반 고착 —
 * verifier_regression_invariants.js가 640판 중 이 유형만으로 482건 검출).
 * ★설계문서(S9)에 이 케이스가 없어 판단해서 채웠다: "보유 카드가 만든 구조적 한도는
 * 그 카드를 잃으면 즉시 재적용된다"(상시 효과는 "보유 중"이 자연스러운 의미론 —
 * 카드 10종 §0 원칙과 정합). 반대 해석("한번 쌓은 스택은 카드를 잃어도 유지")도
 * 가능했으나 채택하지 않았다 — 그러면 BUFF_BOUNDS 자체를 "P7 보유 이력" 조건부로
 * 다시 설계해야 해 불변식 복잡도가 커지고, S9 §1-1 "구조적 정수" 철학(카드가 만드는
 * 보너스는 카드가 있을 때만 산다)과도 더 잘 맞는다. ★조용히 자르지 않는다 —
 * BUFF_STACK_RECONCILE 이벤트로 남긴다. finishRound/DRAW 양쪽에서 tickStatuses와
 * 나란히 매 라운드 호출(P1의 손패 상한은 이 문제가 없다 — refillOne이 매 라운드
 * "현재" cap까지만 채우고 SUBMIT이 먼저 손패를 cap 밑으로 줄여둬 구조적으로 안전한
 * 반면, buffStacks는 SUBMIT 같은 자연 감소 경로가 전혀 없어 P7만의 문제다).
 */
function reconcileBuffCaps(state, events) {
  for (const actor of ['A', 'B']) {
    const player = state.players[actor];
    const cap = effectiveStackCap(player, state.config);
    for (const suit of ['♠', '♦']) {
      const before = player.buffStacks[suit];
      if (before > cap) {
        player.buffStacks[suit] = cap;
        // ★D1(§9) — ♦는 방어 폐지, 표시값은 치명타 확률 기여로 대체(applySuitEffect와 동일 원칙).
        const perStack = suit === '♠' ? state.config.buff.atkPerStack : state.config.crit.chancePerStack;
        events.push(
          mkEvent(state, {
            phase: PHASE.R8_REFILL,
            actor,
            type: EVENT_TYPE.BUFF_STACK_RECONCILE,
            rng: null,
            fields: { suit, stackBefore: before, stackAfter: cap, cap, effectValueAfter: cap * perStack },
          })
        );
      }
    }
  }
}

function roleOf(state, actor) {
  if (state.round === 1) return null;
  if (state.prevOutcome === 'DRAW' || state.prevOutcome === null) return null;
  const winnerActor = state.prevOutcome === 'A_WIN' ? 'A' : 'B';
  return actor === winnerActor ? 'prevWinner' : 'prevLoser';
}

/**
 * ★S2 훅 — computeExchangeCap. S-11 clamp(base+P2−FREEZE, 0, handSize) 그대로.
 * ★P2(재고 정리, +1) 배선 — 기본5→6/승자4→5/패자6→7(카드문서 §1-P2).
 */
function computeExchangeCap(state, actor) {
  const player = state.players[actor];
  const role = roleOf(state, actor);
  let baseSource, baseValue;
  if (role === 'prevWinner') {
    baseSource = 'prevWinner';
    baseValue = state.config.exchange.prevWinner;
  } else if (role === 'prevLoser') {
    baseSource = 'prevLoser';
    baseValue = state.config.exchange.prevLoser;
  } else {
    baseSource = 'base';
    baseValue = state.config.exchange.base;
  }
  const capSources = [{ source: baseSource, delta: baseValue }];
  let capRaw = baseValue;
  const p2Count = countCard(player, 'P2'); // ★D1(C4) — 중복 보유 중첩(장수 카운트)
  if (p2Count > 0) {
    const bonus = state.config.card.p2.exchangeBonus * p2Count;
    capSources.push({ source: 'P2', delta: bonus, count: p2Count });
    capRaw += bonus;
  }
  const freezePenalty = freezeExchangePenalty(player, state.config);
  if (freezePenalty > 0) {
    capSources.push({ source: 'FREEZE', delta: -freezePenalty });
    capRaw -= freezePenalty;
  }
  const handSize = player.hand.length;
  const capEffective = clamp(capRaw, 0, handSize);
  return {
    capBase: state.config.exchange.base,
    capSources,
    capRaw,
    capEffective,
    clampedLow: capRaw < 0,
    clampedByHand: capRaw > handSize,
  };
}

// ---------------------------------------------------------------------------
// 라운드 순서(G1) · 큐 구성
// ---------------------------------------------------------------------------

/**
 * ★G1: 직전 승자→패자 순. 1라운드는 P1→P2 고정.
 * ★미확인(구현 중 발견 — 보고 대상): 직전 라운드가 "무승부"였을 때의 순서는
 * G1 원문에 없다. S1은 라운드1과 동일하게 P1(A)→P2(B) 고정으로 처리한다.
 */
function determineOrder(state) {
  if (state.round === 1) return ['A', 'B'];
  if (state.prevOutcome === 'DRAW' || state.prevOutcome === null) return ['A', 'B'];
  const winnerActor = state.prevOutcome === 'A_WIN' ? 'A' : 'B';
  const loserActor = winnerActor === 'A' ? 'B' : 'A';
  return [winnerActor, loserActor];
}

function buildRoundQueue(state) {
  const [first, second] = determineOrder(state);
  state.pendingQueue = [
    { type: 'EXCHANGE', actor: first },
    { type: 'EXCHANGE', actor: second },
    { type: 'SUBMIT', actor: first },
    { type: 'SUBMIT', actor: second },
  ];
}

// ---------------------------------------------------------------------------
// 교환(EXCHANGE)
// ---------------------------------------------------------------------------

function handleExchange(state, action, events) {
  const actor = action.actor;
  const player = state.players[actor];
  const payload = action.payload || {};
  const discardIds = payload.discard || [];

  const handIdSet = new Set(player.hand.map((c) => c.id));
  for (const id of discardIds) {
    if (!handIdSet.has(id)) throw new Error(`EXCHANGE: ${id}는 ${actor}의 손패에 없다`);
  }
  if (new Set(discardIds).size !== discardIds.length) throw new Error('EXCHANGE: discard id 중복');

  const capInfo = computeExchangeCap(state, actor);
  if (discardIds.length > capInfo.capEffective) {
    throw new Error(`EXCHANGE: ${actor} 요청 ${discardIds.length}장이 capEffective ${capInfo.capEffective}장을 초과`);
  }

  // ★W1(2026-08-17, director 스펙 A 부수 D-2) — 패시브 발동 정본 이벤트. P2(재고
  // 정리)를 들고 있으면 capSources에 이미 계산돼 있던 보너스를 "이번 라운드 실제로
  // 적용된 순간"으로 명시한다(재계산 없음 — capInfo.capSources에서 그대로 읽는다).
  const p2Source = capInfo.capSources.find((s) => s.source === 'P2');
  if (p2Source) {
    events.push(
      mkEvent(state, {
        phase: PHASE.R2_EXCHANGE,
        actor,
        type: EVENT_TYPE.PASSIVE_TRIGGER,
        rng: null,
        fields: { card: 'P2', effect: 'exchangeCapBonus', delta: p2Source.delta, capEffective: capInfo.capEffective },
      })
    );
  }

  const discardIdSet = new Set(discardIds);
  const discardedCards = player.hand.filter((c) => discardIdSet.has(c.id));
  player.hand = player.hand.filter((c) => !discardIdSet.has(c.id));
  player.lastExchangeCount = discardedCards.length;
  // ★교환으로 버린 카드는 덱으로도, 손패로도 돌아가지 않는다 — §1-2 "섞지 않는다"와
  // 정합되는 유일한 해석(카드 보존 회계에 반영, discovered gap — 보고 대상).
  state.cardAccounting.exchangeDiscarded += discardedCards.length;

  const burnActive = !!player.status.BURN;
  const received = [];
  const burned = [];
  const burnedSurvivorCandidates = []; // ★W3(SG-20 ⓐ) — {entry, card} 쌍, applied:true였던 카드만
  const statusDrawsBefore = state.rng.status.draws;

  for (let i = 0; i < discardedCards.length; i++) {
    const [card] = drawN(state, 1, events, actor);
    if (burnActive) {
      const { applied, roll } = rollBurn(state.rng, state.config.status.burn.lossChance);
      const entry = { cardId: card.id, roll, applied, spared: false };
      burned.push(entry);
      if (!applied) {
        player.hand.push(card);
        received.push(card);
      } else {
        // applied===true: 카드가 타서 소실 — 손패로도, 덱으로도 돌아가지 않는다(카드
        // 보존 회계에 반영됨). ★단 아래 SG-20 ⓐ 보정에서 최소 1장이 필요하면 여기서
        // 후보로 되살릴 수 있다(순서대로 보관 — 마지막 후보를 되살린다).
        burnedSurvivorCandidates.push({ entry, card });
      }
    } else {
      player.hand.push(card);
      received.push(card);
    }
  }
  const statusDrawsAfter = state.rng.status.draws;

  // ★★W3(2026-08-17, director SG-20 판정 — 처방 ⓐ) — "화상이 EXCHANGE 해소 종료
  // 시점 손패를 0장으로 만들 수 없다. 최소 1장 보존." 적용 범위는 EXCHANGE 화상
  // 소실 경로 한정(교환-화상이 SUBMIT 직전 유일한 손패 감소 경로 — director 코드
  // 확인: 라운드 큐가 EXCHANGE×2→SUBMIT×2라 A3 폐기(R8 refill 직후)·CHAR_SWAP(판정
  // 후)은 이 사이에 끼지 않는다). player.hand가 이 시점에 0장이라는 것은 "버리지
  // 않고 남겨둔 카드도 0장(전량 교환) ∧ 이번 교환으로 받은 카드도 전부 소실"이라는
  // 뜻 — 그 경우에만 개입한다(부분 교환이면 안 버린 카드가 이미 ≥1장이라 여기 도달
  // 자체가 안 된다).
  // ★RNG 처리 방식 — "소비-무시"(director가 제시한 두 선택지 중 채택, 근거는 아래
  // 판정 4 참조): 전 카드에 대해 rollBurn을 정상적으로 호출·소비했다(위 루프 — 스킵
  // 없음). 여기서는 이미 소비된 롤 중 하나의 *결과만* override한다 — status 스트림의
  // draws 수는 discardedCards.length 그대로 보존되고(스킵 방식이면 조건부로 1 적게
  // 소비돼 "이 라운드가 SG-20을 우연히 피해간 세계선"과 draws 수가 달라진다 — 그
  // 차이 자체가 감사에 소음이 된다). ★spared:true를 명시 필드로 남겨 "roll<lossChance
  // 인데 applied:false"가 감사 시점에 결함으로 오독되지 않게 한다(director 경고 그대로).
  if (player.hand.length === 0 && burnedSurvivorCandidates.length > 0) {
    const spare = burnedSurvivorCandidates[burnedSurvivorCandidates.length - 1];
    spare.entry.applied = false;
    spare.entry.spared = true;
    player.hand.push(spare.card);
    received.push(spare.card);
  }
  state.cardAccounting.burned += burned.filter((b) => b.applied).length;

  events.push(
    mkEvent(state, {
      phase: PHASE.R2_EXCHANGE,
      actor,
      type: EVENT_TYPE.EXCHANGE,
      rng: burnActive && discardedCards.length > 0 ? { stream: 'status', drawsBefore: statusDrawsBefore, drawsAfter: statusDrawsAfter } : null,
      fields: {
        requestedIds: discardIds,
        capBase: capInfo.capBase,
        capSources: capInfo.capSources,
        capRaw: capInfo.capRaw,
        capEffective: capInfo.capEffective,
        clampedLow: capInfo.clampedLow,
        clampedByHand: capInfo.clampedByHand,
        discarded: discardedCards,
        received,
        burned,
        handAfter: player.hand.map((c) => c.id),
      },
    })
  );
}

// ---------------------------------------------------------------------------
// 제출(SUBMIT) · 판정(HAND_EVAL/ROUND_RESULT) · 배수(MULTIPLIER)
// ---------------------------------------------------------------------------

function handleSubmit(state, action, events) {
  const actor = action.actor;
  const player = state.players[actor];
  const handBefore = player.hand.slice();
  const handSize = handBefore.length;
  const payload = action.payload || {};
  const requestedIds = payload.submitted || [];
  // ★J-4/S-8 갱신식(A-2: 유일한 정본 submitCountFor 사용) — 제출 장수 =
  // min(5, 비조커+min(조커,1))(조커 제출 상한 1). 구 공식 min(5,손패)는 "손패 5장 중
  // 조커 2장"류에서 합법 제출 자체를 불가능하게 만든다. ★getLegalActions(SUBMIT 메타)와
  // 반드시 같은 함수를 호출해야 한다 — 각자 따로 계산하면 한쪽만 갱신됐을 때 모든
  // 제출이 거부되어 판이 멈추는데 에러가 "계약 위반"이라 원인 추적이 어려워진다.
  // ★W1(2026-08-17, director 스펙 A — ③ 가변 제출 2~5장) — 제출 장수는 더 이상
  // 고정값이 아니라 [kMin,kMax] ★범위★다("제출 장수는 판정에 어떤 항으로도 들어가지
  // 않는다" — 비교 키가 킥커를 제외하므로 몇 장을 내든 evaluateHand가 그대로 판정).
  // kMax는 구 expectedCount와 정확히 같은 값(하위호환 별칭 유지, handEval.js 참조),
  // kMin=min(submit.min,kMax)가 결손 손패 퇴화 케이스를 닫는다.
  // ★W3(A7 「강요」) — 상대가 A7을 발동해 이번 라운드 forcedSubmitMin이 걸려 있으면
  // kMin이 그만큼 올라간다(submitCountFor 내부에서 재클램프 — handleSubmit·
  // getLegalActions가 반드시 같은 opts를 전달해야 한다, A-2 정본 원칙 그대로).
  const forcedMinOpt = player.forcedSubmitMin ? { forcedMin: player.forcedSubmitMin.value } : undefined;
  const { kMin, kMax } = submitCountFor(handBefore, state.config, forcedMinOpt);

  if (requestedIds.length < kMin || requestedIds.length > kMax) {
    throw new Error(
      `SUBMIT: ${actor}는 ${kMin}~${kMax}장을 내야 한다(받은 ${requestedIds.length}장) — W1 가변 제출(kMax=min(submit.max,비조커+min(조커,1)))`
    );
  }
  const idSet = new Set(requestedIds);
  if (idSet.size !== requestedIds.length) throw new Error('SUBMIT: 제출 id 중복');
  const handIdSet = new Set(handBefore.map((c) => c.id));
  for (const id of requestedIds) {
    if (!handIdSet.has(id)) throw new Error(`SUBMIT: ${id}는 ${actor}의 손패에 없다`);
  }

  const submittedCards = handBefore.filter((c) => idSet.has(c.id));
  // ★J-4① — 엔진 권위 검증. 조커는 보유·이월·교환·교체는 무제한, ★SUBMIT만 1장 상한
  // (오너 문언 "두 장 선택 시" = 제출 선택 시점 — 과잉 차단 금지, PM 판정 확인).
  const submittedJokerCount = submittedCards.filter((c) => c.isJoker).length;
  if (submittedJokerCount > JOKER_SUBMIT_CAP) {
    throw new Error(`SUBMIT: ${actor}는 조커를 ${JOKER_SUBMIT_CAP}장까지만 제출할 수 있다(받은 조커 ${submittedJokerCount}장) — J-4`);
  }
  // ★스펙 A "이월": 안 낸 카드는 전부(별도 상한 없이) 이월된다 — min 2가 상한 6을
  // 내장하므로(8장 손패 기준) carryover.cap을 여기서 적용하지 않는다(config에 자리만
  // 확보해둔 미적용 손잡이, current.json 참조).
  const deferredCards = handBefore.filter((c) => !idSet.has(c.id));
  player.hand = deferredCards;
  player.pendingSubmission = submittedCards;
  player.pendingHandBefore = handBefore;
  // ★W3(A6 「환수」) — pendingSubmission과 별개로 R5_BATTLE(ACTION_CHOICE)까지 생존하는
  // 사본. cleanupSubmissionTemp가 pendingSubmission을 지우기 전에 A6가 읽을 데이터가
  // 없어지는 것을 막는다(위 initPlayer 주석 참조). 다음 SUBMIT이 그때 다시 덮어쓴다.
  player.lastSubmittedCards = submittedCards;
  // ★R8 "낸 장수만큼 소모" — 제출 즉시 순환에서 영구히 빠진다(카드 보존 회계에 반영).
  state.cardAccounting.submitted += submittedCards.length;

  // ★W1 — shortSubmit은 이제 하드코딩 5가 아니라 "이 라운드 도달 가능했던 kMax보다
  // 적게 냈는가"다(조커 제약으로 kMax 자체가 5 미만인 라운드에서 kMax장을 낸 것은
  // "짧은 제출"이 아니다).
  const shortSubmit = submittedCards.length < kMax;
  events.push(
    mkEvent(state, {
      phase: PHASE.R3_SUBMIT,
      actor,
      type: EVENT_TYPE.SUBMIT,
      rng: null,
      fields: {
        handBefore: handBefore.map((c) => c.id),
        submitted: submittedCards.map((c) => c.id),
        deferred: deferredCards.map((c) => c.id),
        handSize,
        submitCount: submittedCards.length,
        kMin, // ★W1 — 신규(관측성)
        kMax, // ★W1 — 신규, 구 expectedCount와 동일값
        shortSubmit,
        forcedSubmitMin: forcedMinOpt ? forcedMinOpt.forcedMin : null, // ★W3(A7) — 이번 제출에 강요가 적용됐는지 관측성
      },
    })
  );
}

function indexById(cards) {
  const map = {};
  for (const c of cards) map[c.id] = c;
  return map;
}

/**
 * ★D1(FIX-2 §8) — ♦ 유효 스택(치명타 확률 계산 전용, 신 P5 패시브 가산 포함).
 * 유효 ♦ 스택 = min(실스택 + P5보유장수×stackBonus, 스택 상한[P7 보정 포함]) — 가산
 * 후 클램프(§8). 구 P5(벼랑 끝, 개인 HP 조건부 배수)는 이 함수와 함께 완전히
 * 폐지됐다 — ♦는 이제 순수 확률 가산 축이라 attacker 개념은 여전히 필요하지만
 * "배수"가 아니라 "확률"이라는 점이 다르다.
 */
function effectiveDiamondStack(state, actor) {
  const player = state.players[actor];
  const p5Count = countCard(player, 'P5');
  const bonus = p5Count * state.config.card.p5.stackBonus;
  const cap = effectiveStackCap(player, state.config);
  return Math.min(player.buffStacks['♦'] + bonus, cap);
}

/**
 * ★D1(FIX-2 §2-4·§3·판정4 §7) — 팟(공유 곱 슬롯). 구 state.multiplier(P5 개인배수와
 * 뒤섞여 attacker별로 비대칭이던 값)를 대체한다 — 팟은 순수 공유 자원 단일층이라
 * actor 인자가 없다(②P5 개인배수 ↔ 팟 분리).
 *
 * 누적은 무승부 판정 확정 시점(스텝1)마다 무조건 1회, 배수형(×growthFactor, 기하
 * 누적) — 상한 도달 시 클램프-유지(SP와 달리 별도 「증발」 사건 없음, §2-4).
 */
function applyPotGrowth(state, events) {
  const cfg = state.config.pot;
  const before = state.pot.value;
  const rawAfter = before * cfg.growthFactor;
  const after = Math.min(rawAfter, cfg.cap);
  const cappedOverflow = rawAfter > cfg.cap;
  state.pot.value = after;
  events.push(
    mkEvent(state, {
      phase: PHASE.R4_JUDGE,
      actor: null,
      type: EVENT_TYPE.POT_CHANGE,
      rng: null,
      fields: { trigger: 'DRAW_GROWTH', before, after, growthFactor: cfg.growthFactor, cap: cfg.cap, cappedOverflow },
    })
  );
}

/**
 * ★D1 — 승자 공격 1회 적용 직후 팟 소진(`resetPolicy=afterApply` 실배선, §5 ①·[F6-28]).
 * resolveDamage(role==='winner')가 매 호출 끝에 부른다 — A4 환전 가산 소진(§4 2행 각주)도
 * 이 동일 경로를 탄다(A4는 팟배율 자체는 ×1로 무변화지만 소진 자체는 여전히 일어난다).
 */
function settlePotAfterWinnerAttack(state, potValueUsed, events) {
  const cfg = state.config.pot;
  const before = state.pot.value;
  state.pot.value = cfg.base;
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor: null,
      type: EVENT_TYPE.POT_CHANGE,
      rng: null,
      fields: { trigger: 'WINNER_ATTACK_CONSUME', before, after: cfg.base, potValueUsed, cap: cfg.cap },
    })
  );
}

/** ★D1 — 승자가 뽑기(SP 임계 행동)를 고르면 팟은 적용 없이 소멸한다(§5 ②). */
function settlePotOnWinnerDraw(state, events) {
  const cfg = state.config.pot;
  const before = state.pot.value;
  if (before === cfg.base) return; // 이미 base — 소멸시킬 값이 없다(이벤트 소음 방지)
  state.pot.value = cfg.base;
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor: null,
      type: EVENT_TYPE.POT_CHANGE,
      rng: null,
      fields: { trigger: 'WINNER_DRAW_VANISH', before, after: cfg.base, cap: cfg.cap },
    })
  );
}

/** ★D1 — A8 「판 키우기」: 팟을 ×2^raiseSteps(클램프-유지, 승자·패자 무관 사용 가능). */
function applyA8PotRaise(state, actor, events) {
  const cfg = state.config.pot;
  const before = state.pot.value;
  const rawAfter = before * Math.pow(2, state.config.card.a8.raiseSteps);
  const after = Math.min(rawAfter, cfg.cap);
  const cappedOverflow = rawAfter > cfg.cap;
  state.pot.value = after;
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor,
      type: EVENT_TYPE.POT_CHANGE,
      rng: null,
      fields: { trigger: 'A8_RAISE', before, after, raiseSteps: state.config.card.a8.raiseSteps, cap: cfg.cap, cappedOverflow },
    })
  );
}

function applySuitEffect(state, actor, trig, events) {
  const player = state.players[actor];
  if (trig.suit === '♠' || trig.suit === '♦') {
    const before = player.buffStacks[trig.suit];
    const delta = trig.levelFinal;
    const p7Count = countCard(player, 'P7'); // ★D1(C4) — 중복 보유 중첩(장수 카운트)
    const hasP7 = p7Count > 0;
    const stackCap = effectiveStackCap(player, state.config); // ★W3(P7) — 보유 기준 유효 상한
    const after = Math.min(before + delta, stackCap);
    const cappedOverflow = Math.max(0, before + delta - stackCap);
    player.buffStacks[trig.suit] = after;
    // ★D1(§9) — ♦는 방어 폐지로 defPerStack이 사라졌다. 이벤트 표시값은 이제 "치명타
    // 확률 기여(스택당 chancePerStack)" — 실제 크리 확률 계산은 effectiveDiamondStack이
    // 별도로 담당한다(이 필드는 표시/계측용, 판정에 재사용되지 않는다).
    const perStack = trig.suit === '♠' ? state.config.buff.atkPerStack : state.config.crit.chancePerStack;
    events.push(
      mkEvent(state, {
        phase: PHASE.R4_JUDGE,
        actor,
        type: EVENT_TYPE.BUFF_STACK,
        rng: null,
        fields: { suit: trig.suit, stackBefore: before, delta, stackAfter: after, cappedOverflow, effectValue: after * perStack, stackCap },
      })
    );
    // ★W3(director 개정 스펙 B ⓑ 부수통합 — 패시브 발동 정본 이벤트에 P6·P7 편입) —
    // P7 보유 시 "이번 라운드 실제로 적용된 순간"(P2/P4와 동일 패턴 — 재계산 없음,
    // 위에서 이미 구한 stackCapBonus 그대로).
    if (hasP7) {
      events.push(
        mkEvent(state, {
          phase: PHASE.R4_JUDGE,
          actor,
          type: EVENT_TYPE.PASSIVE_TRIGGER,
          rng: null,
          fields: { card: 'P7', effect: 'stackCapBonus', delta: state.config.card.p7.stackCapBonus * p7Count, count: p7Count, stackCap },
        })
      );
    }
  } else if (trig.suit === '♥') {
    const amount = trig.levelFinal * state.config.heal.perLevel;
    healHp(state, actor, amount, trig.levelFinal, events, PHASE.R4_JUDGE);
  } else if (trig.suit === '♣') {
    const amount = trig.levelFinal * state.config.spGain.perLevel;
    changeSp(state, actor, amount, 'club', events, PHASE.R4_JUDGE);
  }
}

/**
 * ★D1 정정(verifier F13-31 실측 — 결정 라운드 1202건·무승부 87건 전부 SUIT_TRIGGER
 * 0건이던 결함) — 수트 효과 적용(§2 스텝2)의 단일 진입점. 정본 §1-2 "수트 효과는
 * 양측 지급(무승부에도)" · §2 스텝2 "양측 동시 지급, 무승부 포함"을 그대로 구현한다.
 * 종전 코드는 이 단계를 판정승 분기 안(승자 전용)에 잘못 배치해 패자·무승부 양측이
 * applySuitEffect를 영원히 호출하지 못했다(조용히 죽는 형태 — 구현자도 못 찾았다).
 * actor 자신이 제출한 손패(evalResult/cardsById)로 독립 계산하고, actor 자신의 P4
 * 보유만 그 actor의 레벨 보너스에 반영한다(상대 보유는 이 actor에 무관 — 대칭 호출로
 * 자동 보장).
 */
function applySuitEffectsForActor(state, actor, evalResult, cardsById, events) {
  const player = state.players[actor];
  const p4Count = countCard(player, 'P4'); // ★D1(C4) — 중복 보유 중첩(장수 카운트)
  const p4Bonus = p4Count * state.config.card.p4.suitLevelBonus;
  const suitRes = resolveSuitEffects(evalResult, cardsById, { levelCap: state.config.suit.levelCap, p4Bonus });
  events.push(
    mkEvent(state, {
      phase: PHASE.R4_JUDGE,
      actor,
      type: EVENT_TYPE.SUIT_TRIGGER,
      rng: null,
      fields: { triggers: suitRes.triggers, simultaneousCount: suitRes.simultaneousCount, constituentRef: suitRes.constituentRef },
    })
  );
  for (const trig of suitRes.triggers) applySuitEffect(state, actor, trig, events);

  // ★W1(2026-08-17, director 스펙 A 부수 D-2) — 패시브 발동 정본 이벤트. P4(문양
  // 집착)를 들고 있고 이번 라운드 수트가 실제로 하나 이상 발동했으면(levelAfterP4 값은
  // 이미 resolveSuitEffects가 계산해둔 그대로 — 재계산 없음), "이번 라운드 실제로
  // 적용된 순간"을 명시한다.
  if (p4Bonus > 0 && suitRes.triggers.length > 0) {
    events.push(
      mkEvent(state, {
        phase: PHASE.R4_JUDGE,
        actor,
        type: EVENT_TYPE.PASSIVE_TRIGGER,
        rng: null,
        fields: { card: 'P4', effect: 'suitLevelBonus', delta: p4Bonus, affectedSuits: suitRes.triggers.map((t) => t.suit) },
      })
    );
  }
  return suitRes;
}

function cleanupSubmissionTemp(state) {
  for (const actor of ['A', 'B']) {
    state.players[actor].pendingSubmission = null;
    state.players[actor].pendingHandBefore = null;
  }
}

function resolveJudgment(state, events) {
  const a = state.players.A;
  const b = state.players.B;
  const submittedA = a.pendingSubmission;
  const submittedB = b.pendingSubmission;

  const evalA = evaluateHand(submittedA);
  const evalB = evaluateHand(submittedB);
  const cardsByIdA = indexById(submittedA);
  const cardsByIdB = indexById(submittedB);

  // ★J-4/S-8 — bestHand()가 이제 조커 상한·짧은 손패(k<5)를 스스로 전부 처리하므로
  // (legalSubmitCombos), 구 "length>=5" 길이 가드는 불필요해졌다(hand.length<1일 때만 null).
  const bestA = bestHand(a.pendingHandBefore, state.config);
  const bestB = bestHand(b.pendingHandBefore, state.config);
  const bestEquivalentA = !bestA || compareEval(evalA, bestA.eval) === 0;
  const bestEquivalentB = !bestB || compareEval(evalB, bestB.eval) === 0;

  events.push(
    mkEvent(state, {
      phase: PHASE.R4_JUDGE,
      actor: 'A',
      type: EVENT_TYPE.HAND_EVAL,
      rng: null,
      fields: {
        evaluated: submittedA.map((c) => c.id),
        rankCategory: RANK_CATEGORY_NAMES[evalA.rankCategory],
        constituent: evalA.constituent,
        compareKey: evalA.compareKey,
        deadJokers: evalA.deadJokers,
        isJokerStraight: evalA.isJokerStraight,
        wildAssignment: evalA.wildAssignment, // ★J-1 관측성 — 조커가 어느 (수트,랭크)로 배정됐는지
        bestEquivalent: bestEquivalentA,
      },
    })
  );
  events.push(
    mkEvent(state, {
      phase: PHASE.R4_JUDGE,
      actor: 'B',
      type: EVENT_TYPE.HAND_EVAL,
      rng: null,
      fields: {
        evaluated: submittedB.map((c) => c.id),
        rankCategory: RANK_CATEGORY_NAMES[evalB.rankCategory],
        constituent: evalB.constituent,
        compareKey: evalB.compareKey,
        deadJokers: evalB.deadJokers,
        isJokerStraight: evalB.isJokerStraight,
        wildAssignment: evalB.wildAssignment, // ★J-1 관측성
        bestEquivalent: bestEquivalentB,
      },
    })
  );

  const sameCategory = evalA.rankCategory === evalB.rankCategory;
  const cmp = compareEval(evalA, evalB);
  const keysEqual = sameCategory && compareKeyCompare(evalA.compareKey, evalB.compareKey) === 0;
  let outcome, winner, decidedBy;
  if (keysEqual) {
    outcome = 'DRAW';
    winner = null;
    decidedBy = 'exactTie';
  } else if (cmp > 0) {
    outcome = 'A_WIN';
    winner = 'A';
    decidedBy = sameCategory ? 'compareKey' : 'category';
  } else {
    outcome = 'B_WIN';
    winner = 'B';
    decidedBy = sameCategory ? 'compareKey' : 'category';
  }

  events.push(
    mkEvent(state, {
      phase: PHASE.R4_JUDGE,
      actor: null,
      type: EVENT_TYPE.ROUND_RESULT,
      rng: null,
      fields: {
        outcome,
        decidedBy,
        winner,
        categories: { A: RANK_CATEGORY_NAMES[evalA.rankCategory], B: RANK_CATEGORY_NAMES[evalB.rankCategory] },
        keysEqual,
        sameCategory,
      },
    })
  );

  // ★D1(FIX-2 §2·§2-4·G-A-7) — 구 applyMultiplierTrigger(EXACT_TIE/CONTEST 배수 트리거)
  // 폐지. 팟 성장은 이제 무승부 판정 확정 시점(이 스텝, 「스텝1」)에서만·무조건 일어난다
  // (아래 DRAW 분기) — 승부 확정 시 팟 누적은 없다(§2-4).

  // ★D1 정정(§2 스텝2·F13-31) — 수트 효과 적용: 판정(스텝1) 직후, SP 정산(스텝3)·
  // 승부/무승부 분기보다 앞서 A·B 각자 자신의 제출 손패로 독립 계산·적용한다(양측
  // 동시 지급, 무승부 포함 — §1-2·§2). 승패와 무관한 단일 스텝이라 분기 이전에 한 번만 온다.
  applySuitEffectsForActor(state, 'A', evalA, cardsByIdA, events);
  applySuitEffectsForActor(state, 'B', evalB, cardsByIdB, events);

  // ★S-10 G2: 양측 제출 완료 시점 — 공개 뷰에 노출할 스냅샷을 여기서 갱신한다.
  state.lastRevealedSubmission = {
    round: state.round,
    A: { submitted: submittedA.map((c) => c.id), rankCategory: RANK_CATEGORY_NAMES[evalA.rankCategory], compareKey: evalA.compareKey },
    B: { submitted: submittedB.map((c) => c.id), rankCategory: RANK_CATEGORY_NAMES[evalB.rankCategory], compareKey: evalB.compareKey },
  };

  if (outcome === 'DRAW') {
    // ★D1(G-A-7·§2·§2-4·§4·[F9-29]) — 무승부 라운드 전투 스킵: 판정·수트 지급(★정정
    // — 양측 동시, 위에서 이미 완료)·SP 정산은 정상 수행하되 행동 게이트는 아예 열지
    // 않는다(ACTION_CHOICE 이벤트 0건 — pendingQueue를 세우지 않고 곧장 보충으로).
    applyPotGrowth(state, events); // §2-4 — 무조건 누적(스텝1), 조건 분기 불요(자명화)
    changeSp(state, 'A', state.config.sp.s, 'draw', events, PHASE.R6_SP); // ★D1 — 승/패/무 동일 s(§2 스텝3)
    changeSp(state, 'B', state.config.sp.s, 'draw', events, PHASE.R6_SP);
    draft.advanceDraftCycle(state, 'DRAW', events); // S-13: counted:false 관측(3턴 주기 자체는 폐지, 카운터 이력만 유지)
    cleanupSubmissionTemp(state);
    // ★N2 수정(qa-critic 적발 — TC_S2 §6-N2) — status.js 자체 주석("매 라운드 소모")과
    // 모순되게 DRAW 경로가 tickStatuses를 호출하지 않았다. finishRound(승부 경로)와
    // 동일하게 R8 경계에서 화상·동결을 1턴 소모시킨다 — 승부든 무승부든 매 라운드 소모.
    tickStatuses(state, 'DRAW', events);
    tickForcedSubmitMinBoth(state, events); // ★W3(A7) — 같은 원칙(매 라운드 소모, finishRound와 나란히)
    reconcileBuffCaps(state, events); // ★W3(P7 상실 재정합)
    state.roundCache = null; // ★D1 — 무승부는 승자/패자 개념이 없다(행동 게이트 정의역 자체가 없음, §2-2)
    refillBothHands(state, ['A', 'B'], events, 'refill');
    advanceRound(state, 'DRAW', events);
    return;
  }

  state.roundWins[winner] += 1; // ★D1(§6-6 판정승 체인 ②)
  state.lastDecisiveWinner = winner; // ★D1(§6-6 판정승 체인 ③)

  const loser = winner === 'A' ? 'B' : 'A';
  const winnerCategory = winner === 'A' ? evalA.rankCategory : evalB.rankCategory; // ★D1(§3) — 격차 배율 F/L 산식의 w
  const loserCategory = winner === 'A' ? evalB.rankCategory : evalA.rankCategory; // ★D1(§3)
  // ★D1 정정(F13-31) — 수트 효과(승자·패자 양쪽)는 위에서 판정 직후에 이미 적용
  // 완료됐다(applySuitEffectsForActor A·B 호출) — 여기서 다시 하지 않는다.

  cleanupSubmissionTemp(state);

  // ★D1(FIX-2 §2·§2-1·[F10-24]) — SP 정산을 전투(행동 게이트) 앞으로 이동. 이 라운드
  // 정산된 SP가 이 라운드의 만충 판정(아래 행동 게이트)에 즉시 들어간다 — 구현은
  // finishBattlePhase(전투 뒤)에서 여기로 옮겨왔다. 승/패 동일 s가 아니라 sp.win/sp.lose로
  // 갈리는 것은 §13-1 "Q-a 완전 동등 범위=수트+SP" 확정(교환 차등은 유지, SP는 균등)과
  // 별개 축 — sp.win/sp.lose 자체는 D0 이전부터의 기존 손잡이이고 이 라운드의 변경
  // 대상이 아니다(★단서: 무승부 sp.draw는 §2 스텝3에서 양측 동일 — 위 DRAW 분기 참조,
  // G-A-8 "승/패/무 동일" 확정은 무승부 지급에 한정된 문언이라 sp.win≠sp.lose와 모순 없음).
  changeSp(state, winner, state.config.sp.s, 'win', events, PHASE.R6_SP);
  changeSp(state, loser, state.config.sp.s, 'lose', events, PHASE.R6_SP);

  // ★D1(§3) — winnerCategory/loserCategory를 라운드 캐시에 고정한다(격차 배율 F/L은
  // 판정 시점 족보로만 결정되고, 배틀 페이즈 중 HP·팟이 바뀌어도 이 값은 불변).
  state.roundCache = { winner, loser, winnerCategory, loserCategory };
  state.pendingQueue = [{ type: 'ACTION_CHOICE', actor: winner }];
}

// ---------------------------------------------------------------------------
// 전투(R5) — ★S2 훅: resolveDamage(sources[])
// ---------------------------------------------------------------------------

/**
 * ★D1(FIX-2 §3) — 신 룰 곱 파이프라인 정본(엔진 내부 단일 계산 지점, [F6-24]).
 * 최종 피해 = clamp(round_half_up(합산층 × 격차배율(F/L) × 팟배율 × 치명배율), 하한1, [상한: D3]).
 *
 * opts(★role 필수 — 전역/좌석 추론 금지, 인자로 명시 전달, [F6-26]):
 *  - role: 'winner' | 'loser' — 이 라운드 판정승/판정패 중 attacker의 역할.
 *  - potMultiplierOverride: 지정 시 팟배율을 이 값으로 강제(A4 "팟배율×1 무변화" — §3).
 *    미지정이면 role==='winner'일 때 살아있는 state.pot.value를, role==='loser'일 때는
 *    항상 1(팟은 패자 공격에 미적용, §2-4·§5 ③)을 쓴다.
 *  - isCritSizeAttack: 이 공격이 「크기 액티브」(A10) 자신의 공격이면 true — 치명배율
 *    내부 가산(cfg.crit.factor)이 걸린다(§3 "크기 액티브는 배율 내부 가산").
 *  - statusRng / statusRoll: A1처럼 상태이상 부여 확률 판정을 함께 실었으면
 *    {stream,drawsBefore,drawsAfter}/판정 상세를 DAMAGE 이벤트에 동봉(구 opts.rng 자리).
 *    ★주의: 이 이벤트의 최상위 rng 필드는 이제 항상 'crit' 스트림 소비 기록이다(아래) —
 *    status 스트림 소비는 fields.statusRng로 분리 기록한다(한 이벤트가 두 스트림을
 *    동시에 소비할 수 있어 O-0 단일 rng 봉투로는 둘 다 못 담는다).
 */
function resolveDamage(state, attacker, defender, extraSources, events, opts) {
  opts = opts || {};
  const role = opts.role;
  if (role !== 'winner' && role !== 'loser') {
    throw new Error(`resolveDamage: opts.role는 'winner'|'loser'여야 한다(받은 ${JSON.stringify(role)}) — 전역/좌석 추론 금지(§3 [F6-26])`);
  }
  const atkPlayer = state.players[attacker];
  const defPlayer = state.players[defender];
  const cfg = state.config;

  const sources = [{ kind: 'job', ref: null, value: cfg.job.baseAttack }];
  const atkBuff = atkPlayer.buffStacks['♠'] * cfg.buff.atkPerStack;
  if (atkBuff > 0) sources.push({ kind: 'suitBuff', ref: '♠', value: atkBuff });
  for (const s of extraSources || []) sources.push(s); // S2 훅: roguelike·스킬·A4 환전가산 등
  const skillBonus = (extraSources || []).reduce((s, x) => s + x.value, 0);

  const sumRaw = sources.reduce((s, x) => s + x.value, 0);

  // ---- 격차 배율: 승자 F / 패자 L(§3, G-A-4·G-A-6) ----
  const winnerCategory = state.roundCache.winnerCategory;
  const loserCategory = state.roundCache.loserCategory;
  const w = winnerCategory;
  const d = winnerCategory - loserCategory;
  const f = cfg.gap.winnerCurve;
  const delta = cfg.gap.evenDelta;
  const F = f[w] - f[w - d] + delta;
  let gapMultiplier, L;
  if (role === 'winner') {
    gapMultiplier = F;
    L = null;
  } else {
    const beta = cfg.gap.loserBeta;
    const lambdaMin = cfg.gap.loserFloor;
    L = clamp(1 - beta * (F - delta), lambdaMin, 1);
    gapMultiplier = L;
  }

  // ---- 팟 배율(§2-4·§3·§5) — 승자 공격에만, 패자 공격엔 항상 ×1 ----
  const hasPotOverride = opts.potMultiplierOverride !== undefined && opts.potMultiplierOverride !== null;
  const potMultiplier = role === 'winner' ? (hasPotOverride ? opts.potMultiplierOverride : state.pot.value) : 1;
  const potValueUsed = role === 'winner' ? state.pot.value : null;

  // ---- 치명타(§3·§8·§9) — 'crit' 전용 스트림, 매 공격 1드로우(결정론 균일 소비) ----
  const diamondStack = effectiveDiamondStack(state, attacker);
  const critChanceRaw = cfg.crit.baseChance + diamondStack * cfg.crit.chancePerStack;
  const critChanceCapped = Math.min(Math.max(critChanceRaw, 0), cfg.crit.chanceCap);
  const critChanceOverflow = Math.max(0, critChanceRaw - cfg.crit.chanceCap);
  const critDrawsBefore = state.rng.crit.draws;
  const critRolled = state.rng.crit.chance(critChanceCapped);
  const critDrawsAfter = state.rng.crit.draws;
  const critApplied = critRolled; // ★에스컬레이션 강제(§15) 미구현 — 현재는 항상 rolled와 동일
  const critSizeBonus = opts.isCritSizeAttack ? cfg.crit.factor : 0;
  const critMultiplier = critApplied ? cfg.crit.baseMultiplier + critSizeBonus : 1;

  // ---- 합산 → 곱 → 최종 1회 반올림(half-up) → 상한 클램프(존재 시) → 하한 클램프 ----
  const afterMultiplier = sumRaw * gapMultiplier * potMultiplier * critMultiplier;
  const rounded = Math.round(afterMultiplier); // ★half-up — 양수 전제(합산층·전 배율 항이 항상 ≥0)라 Math.round가 정확히 half-up
  const targetMaxHp = maxHpFor(cfg, defender); // ★R7-A — 피격자 자기 max(비대칭 HP에서 데미지비 소비자 왜곡 방지). ★D2 잔여 — 상한 클램프 기준 HP로도 재사용(판정2 §2 "기준 HP=피격자 자기 maxHp")

  // ---- ★D2 잔여(FIX-2 §15 곱 상한 선배선, off) — 정본 §3 예약 슬롯, 판정 2 그대로.
  // capRatio가 null/undefined면 클램프 자체가 실행되지 않는다(무동작 — 현행과 바이트 동일,
  // config/current.json _metaD2CapRatio 참조). 값이 있을 때만 maxHp 비율로 클램프한다
  // (절대값 금지 — HP 재앵커마다 의미가 조용히 변하는 경로를 소거).
  const capRatio = cfg.damage.capRatio;
  const capEnabled = capRatio !== undefined && capRatio !== null;
  let afterCap = rounded;
  let capped = false;
  if (capEnabled) {
    const capValue = Math.floor(targetMaxHp * capRatio); // ★상한값 정수화 = Math.floor(보수, 판정2 §2)
    afterCap = Math.min(rounded, capValue);
    capped = afterCap !== rounded;
    if (capped) state.capReachedCount += 1; // ★관찰 지표(불변식 아님) — 도달 자체는 합법, 빈발이 의심 신호
  }

  const floor = cfg.damage.floor;
  const final = Math.max(afterCap, floor);
  const floored = final !== afterCap;
  if (floored) state.floorReachedCount += 1; // ★D1([F15-26]) — 하한 도달은 불변식(DAMAGE_FLOOR_NOT_REACHED)이 감시

  const targetHpBefore = defPlayer.hp;
  const targetHpAfter = Math.max(0, targetHpBefore - final);
  const lethal = targetHpAfter <= 0;
  defPlayer.hp = targetHpAfter;

  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor: attacker,
      type: EVENT_TYPE.DAMAGE,
      rng: { stream: 'crit', drawsBefore: critDrawsBefore, drawsAfter: critDrawsAfter }, // ★이 이벤트는 항상 crit 스트림을 소비한다
      fields: Object.assign(
        {
          attacker,
          target: defender,
          role,
          sources,
          sumRaw,
          factors: { gap: gapMultiplier, pot: potMultiplier, crit: critMultiplier, skillBonus },
          gapDetail: { F, L, d, w, winnerCategory, loserCategory },
          potValueUsed,
          critChanceRaw,
          critChanceCapped,
          critChanceOverflow,
          critRolled,
          critApplied,
          afterMultiplier,
          beforeFloor: afterCap, // ★D2 잔여 — 상한 클램프가 반올림과 하한 사이에 끼어들어 "하한 직전 값"의 정의가 afterCap으로 이동(off일 때 afterCap===rounded라 값 무변화)
          final,
          floored,
          targetHpBefore,
          targetHpAfter,
          targetMaxHp,
          lethal,
          statusRng: opts.statusRng || null,
          statusRoll: opts.statusRoll || null,
        },
        capEnabled ? { capped } : {} // ★D2 잔여 — off면 이 필드 자체가 생성되지 않는다(draft.forcedOff 함정 회피, 판정 2 §2)
      ),
    })
  );

  // ---- 승자 공격 1회 적용 후 팟 소진(resetPolicy=afterApply 실배선, §5 ①) ----
  if (role === 'winner') {
    settlePotAfterWinnerAttack(state, potValueUsed, events);
  }

  return lethal;
}

function finalizeGameEnd(state, winner, reason, events, extraFields) {
  state.terminal = true;
  state.terminalReason = reason;
  state.winner = winner;
  events.push(
    mkEvent(state, {
      phase: PHASE.GAME_END,
      actor: null,
      type: EVENT_TYPE.GAME_END,
      rng: null,
      fields: Object.assign(
        {
          terminalReason: reason,
          winner,
          rounds: state.round,
          hpFinal: [state.players.A.hp, state.players.B.hp],
          // ★R7-A(2026-08-17) — 좌석별 오버라이드 가능해지면서 단일 스칼라로는 대표 불가.
          // {A,B} 객체로 정정(기존 소비자 조회: proto/sim/collect.js는 e.maxHp를 읽지 않는다 —
          // 검토 결과 무영향 확인, 커밋 diff에 근거 기록).
          maxHp: { A: maxHpFor(state.config, 'A'), B: maxHpFor(state.config, 'B') },
          hardCapValue: state.config.sim.roundHardCap,
          lastEventSeq: state.seqCounter,
          matchId: state.matchId, // ★D1(§18 계측 substrate)
          gameIndexInMatch: state.gameIndexInMatch,
        },
        extraFields || {} // ★D1(§6-6) — 하드캡 판정승 체인 상세(hardCapWinnerChain) 등
      ),
    })
  );
}

// ★S2: 액티브 스킬 4종(A1~A4). 배선 지점은 카드문서 §2 그대로.
// ★W3(2026-08-17, director 개정 스펙 B — 신규 카드 6종) — A6~A9 편입(A5는 영구
// 결번, S9_신규카드_6종설계.md §2 "판 뒤집기" 기각 ID 재사용 금지).
// ★D1(FIX-2, S9 §5-5) — A10(치명타 크기 액티브) 신설.
const ACTIVE_SKILL_IDS = ['A1', 'A2', 'A3', 'A4', 'A6', 'A7', 'A8', 'A9', 'A10'];
// ★D1(C4, §6-5) — 패시브 7종. 액티브(ACTIVE_SKILL_IDS)와 다르게 중복 보유·중첩이
// 허용된다(각 효과 기존 상한 준수) — countCard()로 「장수」를 센다.
const PASSIVE_CARD_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];

/**
 * ★N8(director 판정 — S-15, TC_S2 §6-N8) → ★★W1(2026-08-17, director 스펙 C)로 폐지.
 * 원래는 액티브 스킬의 공격/비공격 이분법을 명시 속성으로 선언해 공격형(isAttack:true
 * — A1·A2·A4)만 resolveDamage 파이프라인에 진입시키고 A3(isAttack:false, "피해 없음")는
 * 그 공식 자체에 미진입시켰었다.
 * ★스펙 C — "SP 임계 행동(캐릭터 기본 스킬+로그라이크 액티브)은 전부 기본 공격 1회를
 * 포함한다. 고유 효과는 그 공격에 부가된다." → isAttack 이분법 자체를 폐지한다(전부
 * 공격형). 아래는 전부 true로만 남긴다 — CARD_REGISTRY를 완전히 지우지 않은 이유는
 * ①이 상수를 그대로 참조하는 외부 소비자(ai.js 주석·web/app.js 주석)가 있어 즉시
 * 삭제하면 그 참조가 죽은 링크가 되고 ②"전부 true"라는 사실 자체가 스펙 C의 산 기록으로
 * 남는 편이 재발 방지에 낫다(director "미결로 표시한 항목은 조용히 증발할 수 있다" —
 * §7 정정 이력 #8의 교훈과 같은 이유로, "이분법이 있었다가 사라졌다"를 코드에 흔적으로
 * 남긴다). `damage.skillMode(config) ∈ {additive(기본)·replace}`는 이 변경과 무관하게
 * 그대로 유지(스펙 C 문언 "skillMode=additive 무변경").
 * ★★문서 정합성 경고(보고 대상, PM/wiki 담당) — `docs/design/전투설계_라운드구조_v0.md`
 * §2-1의 S-15 서브섹션 중 "비공격형 미진입"(구 규칙 2, A3만 해당) 절이 이제 **공집합**
 * 이다(A3도 공격형으로 전환됐으므로 그 절이 적용될 대상이 없다). 이 파일에서 문서를
 * 고치지 않는다(director 지시 — 문서 수정은 PM/wiki 담당) — 문언 개정 대상임을 여기
 * 남긴다.
 */
const CARD_REGISTRY = {
  A1: { isAttack: true },
  A2: { isAttack: true },
  A3: { isAttack: true }, // ★W1 — false→true(스펙 C, isAttack 이분법 폐지)
  A4: { isAttack: true },
  // ★W3(2026-08-17, 신규 카드 6종) — 전부 스펙 C 적용 대상으로 설계됐다(S9 §1-3 —
  // "신규 액티브 4종은 피해 항을 하나도 갖지 않는다 — 전부 공격+포커 층 효과").
  A6: { isAttack: true },
  A7: { isAttack: true },
  A8: { isAttack: true },
  A9: { isAttack: true },
  A10: { isAttack: true }, // ★D1(FIX-2, S9 §5-5) — 치명타 크기 액티브
};

/**
 * ★J-5(2026-08-16, director/오너 확정 #69) — 캐릭터 2종의 기본 스킬. CARD_REGISTRY(A1~A4,
 * 드래프트 액티브)와 완전히 분리된 별도 레지스트리 — 캐릭터 스킬은 드래프트 풀 밖(고정
 * 보유)이라 카드 레지스트리에 섞지 않는다(이 분리만으로 "player.cards에 절대 안 들어감"이
 * 자동 보장됨 — 버리기/획득/탈취/A3 폐기 대상 전부 별도 방어 코드 불요).
 * 강타(CHAR_SMASH) isAttack:true — ★배수 前 가산(오너 확정 2026-08-16): A1/A2와 같은
 * 계열(resolveDamage의 sources 가산 방식 그대로, A4의 "(배수−1)×factor" 방식이 아니다).
 * ★★W1(2026-08-17, director 스펙 C) — 교체(CHAR_SWAP)도 isAttack:false→true로 전환.
 * "SP 임계 행동은 전부 기본 공격 1회를 포함한다"가 캐릭터 기본 스킬에도 그대로
 * 적용된다(A3와 동일 패턴 — resolveCharacterSwap 참조). CARD_REGISTRY와 마찬가지로
 * isAttack 이분법 자체가 폐지됐다는 사실의 기록으로 필드는 남긴다(전부 true).
 */
const CHARACTER_SKILL_IDS = { SMASH: 'CHAR_SMASH', SWAP: 'CHAR_SWAP' };
const CHARACTER_SKILL_REGISTRY = {
  CHAR_SMASH: { isAttack: true },
  CHAR_SWAP: { isAttack: true }, // ★W1 — false→true(스펙 C)
};
const CHARACTER_IDS = ['SMASH', 'SWAP'];
const CHARACTER_OPPOSITE = { SMASH: 'SWAP', SWAP: 'SMASH' };
const DEFAULT_CHARACTERS = { A: 'SMASH', B: 'SWAP' }; // ★opts.characters 미지정 시 결정론 기본값(RNG 미소비 — 기존 시드재현·시뮬 배치 무영향)

/**
 * ★J-5 — 캐릭터 배정 해석. "시작 전 선택, 상대는 자동 반대"(오너 확정). spec에 한쪽만
 * 있으면 반대쪽을 자동 유도하고, 둘 다 있으면 서로 반대인지 검증한다. 둘 다 생략(opts
 * 미지정)이면 DEFAULT_CHARACTERS로 고정(RNG 미소비 — 결정론·기존 회귀 스크립트 무영향).
 * ★D2-A(FIX-2 §12-2 W6·TC[F19-21]) — 2번째 인자 allowMirror(기본 false, 옵션)는
 * "미러 매치업" 측정 전용 탈출구다. 실전은 캐릭터 2종+자동 반대라 SMASH-vs-SMASH가
 * 구조적으로 존재할 수 없고(오너 확정 규칙), 그래서 좌석(A/B)을 바꾸는 것과 캐릭터를
 * 바꾸는 것이 항상 같은 축으로 붕괴한다(§F19-21 "좌석 스왑 ≡ 캐릭터 스왑"). W6(강타
 * 고정가산 병리)을 좌석 편향과 분리해서 재려면 양쪽이 "같은" 캐릭터를 쓰는 진단 전용
 * 시나리오가 필요하다 — allowMirror=true면 A===B 동일 캐릭터를 허용한다(§6-4 "매치당
 * 1회 선택·상대 자동 반대"를 어기는 것이 아니라, 그 규칙이 적용되지 않는 별도의
 * 측정 전용 소집단으로 다룬다 — 실제 플레이 경로(web/app.js)는 이 옵션을 절대 넘기지
 * 않는다, opts로만 노출되고 UI 선택지가 아니다). 기본값 false는 기존 동작과 완전히
 * 동일(1-인자 호출부 전부 무영향).
 */
function resolveCharacters(spec, allowMirror) {
  spec = spec || {};
  let a = spec.A;
  let b = spec.B;
  if (a !== undefined && a !== null && CHARACTER_IDS.indexOf(a) === -1) throw new Error(`characters.A 알 수 없는 캐릭터 "${a}"`);
  if (b !== undefined && b !== null && CHARACTER_IDS.indexOf(b) === -1) throw new Error(`characters.B 알 수 없는 캐릭터 "${b}"`);
  if (a && b) {
    if (!allowMirror && CHARACTER_OPPOSITE[a] !== b) throw new Error(`characters: A(${a})와 B(${b})는 서로 반대 캐릭터여야 한다`);
  } else if (a && !b) {
    b = allowMirror ? a : CHARACTER_OPPOSITE[a];
  } else if (b && !a) {
    a = allowMirror ? b : CHARACTER_OPPOSITE[b];
  } else {
    a = DEFAULT_CHARACTERS.A;
    b = DEFAULT_CHARACTERS.B;
  }
  return { A: a, B: b };
}

/**
 * ★A3(패 훔치기) 예약 폐기 — 발동은 즉시 기록하지만 실제 폐기는 target의 "다음 보충
 * (R8) 완료 직후"로 미룬다(카드문서 §2-A3 정정판 — 발동 시점의 상대 손패는 이월 3장뿐
 * 이라 즉시 폐기는 사실상 확정 파괴가 되므로, 8장으로 회복된 뒤 무작위 1장을 폐기해
 * 원래 의도(아껴둔 카드를 맞출 확률 3/8)를 복원한다).
 */
function scheduleA3Discard(state, sourceActor, target, events) {
  state.players[target].pendingA3Discards += 1;
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor: sourceActor,
      type: EVENT_TYPE.A3_SCHEDULED,
      rng: null,
      fields: { source: sourceActor, target, pendingCountAfter: state.players[target].pendingA3Discards },
    })
  );
}

// ---------------------------------------------------------------------------
// ★W3(2026-08-17, director 개정 스펙 B — 신규 카드 6종) 신규 액티브 4종의 고유 효과
// (A6 환수·A7 강요·A8 판 키우기·A9 투시). 전부 스펙 C대로 resolveActiveSkill이 먼저
// resolveDamage(순수 기본공격, CHAR_SWAP과 동일하게 카드 성분 없음 — S9 §1-3)를
// 해소하고, lethal이면 아래 고유 효과를 생략한다(해소 순서 결정론, A3/CHAR_SWAP과
// 동형).
// ---------------------------------------------------------------------------

/**
 * ★W3(A6 「환수」) — 회수 대상 선택. S9 설계문서 §1-2·§2-A6("5장 중 최고를 고르고,
 * 2장 중에서만 고른다")를 **결정론적 자동 선택**으로 구현했다 — 조커 > 실카드
 * (랭크 내림차순), 동률은 id 오름차순. ★판단이 갈린 지점(정직 보고 대상) — 같은
 * 문서 §2-A6 "회수 대상이 A♠든 조커든 내가 고른다"는 플레이어 수동 선택도 함의할
 * 수 있다. 자동 선택으로 구현한 이유: ①§1-2가 "최고를 고른다"로 명시했고 이게
 * 카드의 핵심 가치 서술(장수가 클수록 후보가 넓다)과 직접 대응한다 ②수동 선택으로
 * 만들면 CHAR_SWAP의 swapDiscard처럼 새 payload가 필요해 aiRandom.js(L1, 동결
 * 대상 — PM 소관 해제 절차 필요)와 ai.js 양쪽에 새 인터랙션을 만들어야 해 이 윈도
 * 스코프(엔진 규칙 구현)를 UI/AI 인터랙션 설계까지 넓힌다. AI EV 계수와 무관한
 * 순수 카드 서열이라 "밸런스 수치를 건드리지 마라" 제약과도 충돌하지 않는다.
 */
function pickBestCardsForRecover(cards, count) {
  const sorted = cards.slice().sort((a, b) => {
    if (a.isJoker !== b.isJoker) return a.isJoker ? -1 : 1; // 조커 최우선(최고 취급)
    if (!a.isJoker && !b.isJoker && a.rank !== b.rank) return b.rank - a.rank; // 랭크 내림차순
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // 결정론 타이브레이크(PRNG 미소비)
  });
  return sorted.slice(0, Math.max(0, Math.min(count, sorted.length)));
}

/**
 * ★W3(A7 「강요」) — 상대(target)의 다음 SUBMIT kMin 하한을 강제한다. duration
 * 라운드(잠정 1) 유지 — status.js(BURN/FREEZE)와 동일한 "적용된 그 라운드는 안
 * 틱한다" 패턴을 독립적으로 재구현했다(status.js는 config.status.*를 조회하는데
 * A7 손잡이는 card.a7.*에 있어 그 모듈의 config 조회 규약과 안 맞는다 — 네임스페이스를
 * 억지로 맞추기보다 작은 전용 tick을 둔다, tickForcedSubmitMinBoth 참조).
 */
function applyForcedSubmitMin(state, targetActor, sourceActor, events) {
  const cfg = state.config.card.a7;
  const player = state.players[targetActor];
  const refreshed = !!player.forcedSubmitMin;
  player.forcedSubmitMin = { value: cfg.forcedMin, remaining: cfg.duration, source: 'A7', appliedRound: state.round };
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor: sourceActor,
      type: EVENT_TYPE.FORCED_SUBMIT_MIN_APPLY,
      rng: null,
      fields: { target: targetActor, value: cfg.forcedMin, duration: cfg.duration, refreshed },
    })
  );
}

/**
 * ★W3(A7) — R8 경계에서 지속시간 1턴 소모. finishRound(승부 경로)·DRAW 경로 양쪽에서
 * tickStatuses와 나란히 호출한다(매 라운드 소모 — status.js G4 결정과 동일 원칙).
 */
function tickForcedSubmitMinBoth(state, events) {
  for (const actor of ['A', 'B']) {
    const player = state.players[actor];
    const st = player.forcedSubmitMin;
    if (!st) continue;
    const skippedSameRoundApplication = st.appliedRound === state.round;
    if (!skippedSameRoundApplication) st.remaining -= 1;
    const remainingAfter = st.remaining;
    events.push(
      mkEvent(state, {
        phase: PHASE.R8_REFILL,
        actor,
        type: EVENT_TYPE.FORCED_SUBMIT_MIN_TICK,
        rng: null,
        fields: { remainingAfter, skippedSameRoundApplication },
      })
    );
    if (!skippedSameRoundApplication && remainingAfter <= 0) {
      player.forcedSubmitMin = null;
      events.push(
        mkEvent(state, {
          phase: PHASE.R8_REFILL,
          actor,
          type: EVENT_TYPE.FORCED_SUBMIT_MIN_EXPIRE,
          rng: null,
          fields: {},
        })
      );
    }
  }
}

/**
 * ★W3(A8 「판 키우기」) → ★D1(FIX-2 §2-4) 재배선 — 무승부 배수(구 state.multiplier)가
 * 아니라 팟(state.pot.value)을 raiseSteps단(×2^raiseSteps) 올린다. 팟은 양측 공유
 * 자원 — A8은 그 값을 직접 "올리는" 유일한 액티브다(A4는 소비만 한다). 실제 이벤트
 * 발행은 applyA8PotRaise(§2-4 신규 함수군)에 위임.
 * ★★위험 주석(director 지시 — 구현은 하되 사실을 남긴다, 측정은 W4) — S9 설계문서
 * §2-A8: "A8 + A4 조합이 A4 즉사급 위험(위험 1)을 재점화한다. S5가 그 위험을 밴드
 * 안으로 판정한 근거가 '실전에서 그 배수까지 도달하는 빈도 자체가 낮다'였는데,
 * A8이 정확히 그 빈도를 올린다." 자연 완충 3중(배수 공유라 상대 A4도 강해짐·같은
 * 라운드에 A8+A4 동시 사용 불가·pot.cap 그대로 유지)은 있으나 재측정 없이
 * 결론 내지 않는다 — W4(balance-designer) 트랙.
 */
function applyA8Raise(state, actor, events) {
  applyA8PotRaise(state, actor, events);
}

/**
 * ★W3(A9 「투시」) — 상대(targetActor)의 현재 손패(=이월 — R5_BATTLE은 SUBMIT 이후·
 * REFILL 이전이라 player.hand가 정확히 "이번 라운드에 아낀 손패"다)에서 무작위
 * revealCount장을 발동자(actor)에게만 공개한다. ★결정론 — RNG는 status 스트림
 * 고정(S9 설계문서 §2-A9 "액티브 스킬 효과의 무작위성은 전부 status" — A1 화상
 * 판정·A3 무작위 폐기와 같은 계열, sampleWithoutReplacement 재사용). ★발동 시점
 * (R5) 1회만 뽑고 결과 ID를 state(target.revealedTo)에 고정한다 — "관측할 때마다
 * 다시 뽑기"는 리플레이 3원칙 ②(get*·preview*는 PRNG 미소비) 위반이라 금지(같은
 * 설계문서 §8). getPublicView가 읽을 때 target.hand에 더 이상 없는 id는 자연히
 * 걸러진다(A3가 공개된 카드를 나중에 부수는 경우 — 별도 규칙 불요, §2-A9 명시).
 */
function applyA9Reveal(state, actor, targetActor, events) {
  const cfg = state.config.card.a9;
  const target = state.players[targetActor];
  const drawsBefore = state.rng.status.draws;
  const revealed = state.rng.status.sampleWithoutReplacement(target.hand, Math.min(cfg.revealCount, target.hand.length));
  const drawsAfter = state.rng.status.draws;
  const ids = revealed.map((c) => c.id);
  const expiresRound = state.round + cfg.revealRounds;
  target.revealedTo = { byActor: actor, ids, expiresRound };
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor,
      type: EVENT_TYPE.A9_REVEAL,
      rng: drawsAfter > drawsBefore ? { stream: 'status', drawsBefore, drawsAfter } : null, // ★N-0d — PRNG 미소비 시 null(target.hand가 0장인 극단)
      fields: { target: targetActor, revealed: ids, revealCount: cfg.revealCount, targetHandSize: target.hand.length, expiresRound },
    })
  );
}

/**
 * 액티브 스킬 1개를 해소한다. 반환: lethal(bool).
 * ★A1/A2/A4는 정상 공격 파이프라인(resolveDamage)을 타 job/수트버프가 포함된다(카드문서
 * "피해 + …" 표현 그대로 — extraSources는 그 위에 얹는 보너스).
 * ★★W1(2026-08-17, director 스펙 C — "공격에 얹는다") — A3도 이제 같은 파이프라인을
 * 탄다. 카드문서의 구 "피해 없음"은 폐기(§7 정정 이력에 준하는 룰 개정, PM/wiki가
 * 문서 반영). card.a3.damage(현재 0, 원래부터 "밸런스 손잡이로 예비"였던 값)를 A1/A2와
 * 정확히 같은 자리(카드 효과 항)에 얹는다 — ★값 자체는 손대지 않았다(0 그대로, balance
 * 트랙 소관). ★해소 순서(스펙 C 문언 그대로, 결정론): 공격 해소 → 고유 효과(예약 폐기)
 * 해소. 공격으로 판이 끝나면(lethal) 고유 효과 해소를 생략한다 — 죽은 상대에게 카드
 * 파괴를 예약해봐야 다음 라운드가 없으므로 관측 가능한 부작용도 없다.
 */
function resolveActiveSkill(state, actor, opponent, skillId, events, role) {
  const cfg = state.config;

  if (skillId === 'A1') {
    const sources = [{ kind: 'card', ref: 'A1', value: cfg.card.a1.damage }];
    const drawsBefore = state.rng.status.draws;
    const { applied, roll } = rollBurn(state.rng, cfg.card.a1.applyChance); // ★status 스트림 고정(director 지침)
    const drawsAfter = state.rng.status.draws;
    const lethal = resolveDamage(state, actor, opponent, sources, events, {
      role,
      statusRng: { stream: 'status', drawsBefore, drawsAfter }, // ★D1 — 최상위 rng 봉투는 이제 crit 전용, status는 별도 필드
      statusRoll: { type: 'BURN', chance: cfg.card.a1.applyChance, roll, applied },
    });
    if (applied && !lethal) applyStatus(state, opponent, 'BURN', 'A1', events);
    return lethal;
  }

  if (skillId === 'A2') {
    const sources = [{ kind: 'card', ref: 'A2', value: cfg.card.a2.damage }];
    const lethal = resolveDamage(state, actor, opponent, sources, events, { role });
    if (!lethal) applyStatus(state, opponent, 'FREEZE', 'A2', events); // 확정 적용(확률 없음)
    return lethal;
  }

  if (skillId === 'A3') {
    // ★★W1(스펙 C) — 공격 해소 먼저(card.a3.damage=0을 A1/A2와 같은 자리에 가산,
    // 현재값 0이라 사실상 기본공격과 동일한 수치가 나가지만 배선은 A1/A2와 동일 계열).
    const sources = [{ kind: 'card', ref: 'A3', value: cfg.card.a3.damage }];
    const lethal = resolveDamage(state, actor, opponent, sources, events, { role });
    // 고유 효과(2단계 지연 파괴 예약) — 공격으로 판이 끝났으면 생략(해소 순서 결정론).
    if (!lethal) scheduleA3Discard(state, actor, opponent, events);
    return lethal;
  }

  if (skillId === 'A10') {
    // ★D1(FIX-2, S9 §5-5) — 치명타 크기 액티브: 순수 공격 + 이 공격이 크리로 터지면
    // 배율 내부 가산(cfg.crit.factor)이 얹힌다(§3 "크기 액티브는 배율 내부 가산" —
    // 별도 곱 층이 아니다). 정의역은 이 카드 자신의 공격에 한정(카드 개별 설계
    // 영역이라 낮은 확신 — 「보유 중이면 항상」이 아니라 「이 카드를 써서 공격할 때」로
    // 좁게 해석했다, 보고 대상).
    const sources = [{ kind: 'card', ref: 'A10', value: cfg.card.a10.damage }];
    return resolveDamage(state, actor, opponent, sources, events, { role, isCritSizeAttack: true });
  }

  if (skillId === 'A4') {
    // ★D1(FIX-2 §3) 재정의 — A4는 「팟을 곱 대신 가산으로 환전」하는 카드다. 팟배율
    // 자체는 ×1(무변화, potMultiplierOverride:1) + 합산층에 (팟값−cfg.pot.base)×factor를
    // 가산한다. ★패자·무팟 시점의 A4는 가산 0(구조적으로 자동 성립 — 라운드 구조상
    // 패자가 행동할 때는 승자가 이미 팟을 처리(소진/소멸)해 팟이 항상 base이므로
    // potBefore−base=0. 별도 role 분기 불요, 대수로 떨어진다). 팟 소진은 resolveDamage
    // 내부(role==='winner'일 때 settlePotAfterWinnerAttack)가 처리 — 여기서 별도 소비
    // 호출 불요(구 consumeMultiplierForA4 폐지).
    const potBefore = state.pot.value;
    const bonus = (potBefore - cfg.pot.base) * cfg.a4.factor;
    const sources = bonus !== 0 ? [{ kind: 'card', ref: 'A4', value: bonus }] : [];
    return resolveDamage(state, actor, opponent, sources, events, { role, potMultiplierOverride: 1 });
  }

  // ★★W3(2026-08-17, director 개정 스펙 B — 신규 카드 6종) — A6~A9. 전부 S9 §1-3대로
  // 카드 성분 없는 순수 기본공격(sources:[], CHAR_SWAP과 동일 패턴) 먼저, lethal이면
  // 고유 효과 생략(해소 순서 결정론, A3/CHAR_SWAP과 동형).
  if (skillId === 'A6') {
    // 「환수」— 이번 라운드 제출분에서 최고 카드(들)를 손패로 되돌린다.
    const lethal = resolveDamage(state, actor, opponent, [], events, { role });
    if (lethal) return true;
    const player = state.players[actor];
    const pool = player.lastSubmittedCards || [];
    const recoverCount = cfg.card.a6.recoverCount;
    const picked = pickBestCardsForRecover(pool, recoverCount);
    if (picked.length > 0) {
      const pickedIdSet = new Set(picked.map((c) => c.id));
      player.lastSubmittedCards = pool.filter((c) => !pickedIdSet.has(c.id));
      player.hand.push(...picked);
      // ★S9 설계문서 §8 — "회수 시 이 회계를 되돌리지 않으면 카드 보존 불변식이
      // 깨진다"(R8 "낸 장수만큼 소모"로 handleSubmit이 이미 +=picked.length 해둔 것을
      // 여기서 되돌린다).
      state.cardAccounting.submitted -= picked.length;
      events.push(
        mkEvent(state, {
          phase: PHASE.R5_BATTLE,
          actor,
          type: EVENT_TYPE.A6_RECOVER,
          rng: null,
          fields: { recovered: picked.map((c) => c.id), recoverCount, handAfter: player.hand.map((c) => c.id) },
        })
      );
    }
    return false;
  }

  if (skillId === 'A7') {
    // 「강요」— 상대의 다음 SUBMIT 하한을 강제한다.
    const lethal = resolveDamage(state, actor, opponent, [], events, { role });
    if (lethal) return true;
    applyForcedSubmitMin(state, opponent, actor, events);
    return false;
  }

  if (skillId === 'A8') {
    // 「판 키우기」— 팟을 올린다(양측 공유 자원, 승자·패자 무관 사용 가능 — ★A4 조합
    // 위험은 applyA8Raise 헤더 주석 참조).
    const lethal = resolveDamage(state, actor, opponent, [], events, { role });
    if (lethal) return true;
    applyA8Raise(state, actor, events);
    return false;
  }

  if (skillId === 'A9') {
    // 「투시」— 상대 이월 중 무작위 revealCount장을 발동자에게만 공개(고정).
    const lethal = resolveDamage(state, actor, opponent, [], events, { role });
    if (lethal) return true;
    applyA9Reveal(state, actor, opponent, events);
    return false;
  }

  throw new Error(`resolveActiveSkill: 알 수 없는 skillId ${skillId}`);
}

/**
 * ★J-5 — 강타(CHAR_SMASH). 오너 확정(2026-08-16) — ★배수 前 가산: A1/A2와 같은 계열로
 * resolveDamage의 sources에 char.smash.damage를 얹는다((직업10+♠버프+8)×배수−방어,
 * 하한1 — A4의 "(배수−1)×factor" 방식이 아니다). 상태이상 없음(강타는 순수 데미지형).
 */
function resolveCharacterSmash(state, actor, opponent, events, role) {
  const cfg = state.config;
  const sources = [{ kind: 'character', ref: 'CHAR_SMASH', value: cfg.character.smash.damage }];
  return resolveDamage(state, actor, opponent, sources, events, { role });
}

/**
 * ★J-5 — 교체(CHAR_SWAP). 발동 즉시 현재 손패(제출 후 이월분)에서 1~char.swap.count장을
 * 선택 폐기하고 즉시 재지급한다(EXCHANGE와 동일 수령 패턴 재사용 — 화상 25% 소실 롤).
 * ★오너 확정(2026-08-16) — R2 정규 교환과 별개·비소모(computeExchangeCap 미호출 —
 * 그 라운드 일반 교환을 그대로 소모하지 않은 채 남긴다, 사실상 교환 2회). FREEZE 페널티
 * 미적용(freezeExchangePenalty 미호출로 자연히 충족), BURN은 적용(수령 경로 재사용 —
 * 미적용이면 측정 안 된 화상 카운터가 된다).
 * ★★W1(2026-08-17, director 스펙 C) — isAttack:false→true. 이제 A3와 같은 패턴으로
 * 기본 공격 1회를 먼저 해소한다(카드 성분 없음 — character.swap에는 A3의 card.a3.damage에
 * 대응하는 예비 손잡이가 원래 없었고, "교체"는 카드문서 §2-6에서도 공식이 아니라
 * 폐기·재지급으로만 서술돼 있어 새 config 값을 발명하지 않는다 — job.baseAttack+♠버프만의
 * 순수 기본공격). ★해소 순서(결정론): 공격 → 고유 효과(폐기·재지급). 공격으로 판이
 * 끝나면 고유 효과 해소를 생략한다.
 * ★D1 정정(F16-55, PM 판정) — extraSources를 더 이상 빈 배열로 하드코딩하지 않는다.
 * 정본은 이 가산 슬롯을 「값이 0인 기존 항」이 아니라 신규 항으로 명시했으므로,
 * cfg.character.swap.damage(현재 0, TBD(balance/D3))를 항상 sources 엔트리로 싣는다 —
 * 값이 0이어도 계측(DAMAGE.fields.sources)에 항 자체는 잡혀야 D3가 값을 넣을 자리가
 * 있다("값 0"과 "항 없음"은 다르다).
 */
function resolveCharacterSwap(state, actor, opponent, payload, events, role) {
  const extraSources = [{ kind: 'character', ref: 'CHAR_SWAP', value: state.config.character.swap.damage }];
  const lethal = resolveDamage(state, actor, opponent, extraSources, events, { role }); // ★W1 — 공격 해소 먼저(가산 슬롯은 위 신설 항뿐, 카드 성분 없음)
  if (lethal) return true; // 고유 효과(폐기·재지급) 해소 생략

  const player = state.players[actor];
  const maxCount = state.config.character.swap.count;
  const discardIds = (payload && payload.swapDiscard) || [];

  if (discardIds.length < 1 || discardIds.length > maxCount) {
    throw new Error(`CHAR_SWAP: ${actor}는 1~${maxCount}장을 선택해야 한다(받은 ${discardIds.length}장)`);
  }
  if (new Set(discardIds).size !== discardIds.length) throw new Error('CHAR_SWAP: 선택 id 중복');
  const handIdSet = new Set(player.hand.map((c) => c.id));
  for (const id of discardIds) {
    if (!handIdSet.has(id)) throw new Error(`CHAR_SWAP: ${id}는 ${actor}의 손패에 없다`);
  }

  const discardIdSet = new Set(discardIds);
  const discardedCards = player.hand.filter((c) => discardIdSet.has(c.id));
  player.hand = player.hand.filter((c) => !discardIdSet.has(c.id));
  // ★EXCHANGE와 동일 원칙 — 폐기 카드는 덱으로도 손패로도 돌아가지 않는다(§1-2).
  state.cardAccounting.charSwapDiscarded += discardedCards.length;

  const burnActive = !!player.status.BURN;
  const received = [];
  const burned = [];
  const statusDrawsBefore = state.rng.status.draws;
  for (let i = 0; i < discardedCards.length; i++) {
    const [card] = drawN(state, 1, events, actor);
    if (burnActive) {
      const { applied, roll } = rollBurn(state.rng, state.config.status.burn.lossChance);
      burned.push({ cardId: card.id, roll, applied });
      if (!applied) {
        player.hand.push(card);
        received.push(card);
      }
    } else {
      player.hand.push(card);
      received.push(card);
    }
  }
  const statusDrawsAfter = state.rng.status.draws;
  state.cardAccounting.burned += burned.filter((b) => b.applied).length;

  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor,
      type: EVENT_TYPE.CHAR_SWAP,
      rng: burnActive && discardedCards.length > 0 ? { stream: 'status', drawsBefore: statusDrawsBefore, drawsAfter: statusDrawsAfter } : null,
      fields: {
        discarded: discardedCards.map((c) => c.id),
        discardCount: discardedCards.length,
        received: received.map((c) => c.id),
        burned,
        handAfter: player.hand.map((c) => c.id),
      },
    })
  );
  return false; // ★W1 — 여기 도달했다는 것 자체가 위 공격이 lethal:false였다는 뜻
}

/** 캐릭터 기본 스킬 1개를 해소한다. 반환: lethal(bool). resolveActiveSkill과 동일 계약. */
function resolveCharacterSkill(state, actor, opponent, skillId, payload, events, role) {
  if (skillId === 'CHAR_SMASH') return resolveCharacterSmash(state, actor, opponent, events, role);
  // ★W1(스펙 C) — CHAR_SWAP도 이제 공격 파이프라인을 타므로 실제 lethal 결과를
  // 그대로 전파한다(구 구현은 isAttack:false 전제로 항상 false를 하드코딩했었다).
  if (skillId === 'CHAR_SWAP') return resolveCharacterSwap(state, actor, opponent, payload, events, role);
  throw new Error(`resolveCharacterSkill: 알 수 없는 skillId ${skillId}`);
}

/**
 * ★전 티어 공통 스킬 사용 규칙 — ★N1 판정(director, TC_S2 §6 2026-08-14)으로 정정: SP
 * 임계 도달 + 소지 액티브 스킬 ≥1이어도 스킬 사용은 "강제"가 아니라 정본 §2의 "★선택"이다.
 * usePolicy='choice'(기본, config.skill.usePolicy)일 때 getLegalActions가
 * ['BASIC_ATTACK', charSkillId, ...heldSkills]를 합법 옵션으로 반환하고, 여기서
 * payload.choice로 그중 하나를 받는다 — 값이 없거나(aiRandom.randomActionChoice가
 * BASIC_ATTACK을 payload:{}로 보내는 동결된 관례, aiRandom.js는 S3 게이트②로 임의 수정
 * 금지) 명시적으로 'BASIC_ATTACK'이면 기본 공격, charSkillId면 캐릭터 기본 스킬
 * (★J-5, chose='CHAR_SKILL' — 'SKILL'과 분리해야 B3 스킬 순환 지표가 안 오염된다),
 * heldSkills 중 하나면 그 드래프트 액티브(chose='SKILL'). SP 리셋은 "스킬 사용 시"만
 * (정본 §2 "(사용 시 SP 0)", ★J-5로 기본 스킬도 동일 — 'SKILL'·'CHAR_SKILL' 양쪽 다)
 * — 기본 공격을 선택하면 SP는 임계에 그대로 유지된다. ★J-5로 기본 스킬(캐릭터)이
 * SP 임계 도달 시 항상 선택지에 있으므로 'FALLBACK_NO_SKILL'은 구조적으로 도달 불가능
 * (도달 시 불변식 위반 — 아래서 명시적으로 방어). usePolicy='forced'는 이전 구현(강제)을
 * config 전환만으로 되살릴 수 있게 보존한 분기(S-5 패턴 — 기본값 아님).
 */
/**
 * ★PM 판정 — SG-J5-1(2026-08-16, 조건부 불변식 정정). 원 스펙 "FALLBACK_NO_SKILL
 * 도달 불능"은 강타 캐릭터에는 참이지만 교체 캐릭터에는 거짓이다 — 화상으로 R2
 * 수령분이 전량 소실되면 손패가 0장까지 줄 수 있고(S-8), 그러면 교체(1장 이상 선택
 * 필요)도 합법 선택지에서 빠진다. 액티브도 0장 보유라면 charSkillId도 heldSkills도
 * 전부 없어 진짜로 선택지가 BASIC_ATTACK 하나뿐이게 된다 — 이 상태는 §2 "선택"의
 * 자유로운 기본공격이 아니라 구조적으로 강제된 것이므로(B3 스킬 순환 지표가 "선택
 * 가능했는데 기본공격을 골랐다"로 오독하면 안 된다) 'FALLBACK_NO_SKILL'로 별도 라벨링한다.
 * ★조건부 불변식(PM 판정) — FALLBACK_NO_SKILL은 오직 (이 시점 손패===0 ∧ 보유
 * 액티브===0)일 때만 정상이고, 그 외 도달은 위반이다. 사후 판별 가능하도록 두 값을
 * 이벤트에 그대로 남긴다(handLenAtChoice·noSkillAtAll).
 */
/**
 * ★D1(FIX-2 §4) — 행동 게이트 6분기의 옵션 빌더. getLegalActions와 handleActionChoice
 * 양쪽이 이 함수 하나만 호출한다 — 두 곳이 각자 재구현하면 갈릴 수 있다는 게 [F9-22]의
 * 핵심 경고였다("한쪽만 고치면 UI/AI와 엔진이 갈린다"). ★뽑기(DRAW)가 SP 임계 행동
 * 3요소(§1-1)의 하나로 always 포함된다 — 이로써 구 FALLBACK_NO_SKILL(교체 캐릭터+
 * 액티브0+손패0의 유일한 정당 도달 조건)이 구조적으로 도달 불가능해졌다(뽑기가 항상
 * 남는다) — 그 분기는 폐기했다(이력: 이 주석).
 */
function actionChoiceOptionsFor(state, actor, isWinner) {
  const player = state.players[actor];
  const spAtThreshold = player.sp >= state.config.player.spThreshold;
  const heldSkills = player.cards.filter((c) => ACTIVE_SKILL_IDS.indexOf(c) !== -1);
  const usePolicy = state.config.skill.usePolicy;
  const charSkillId = CHARACTER_SKILL_IDS[player.character];
  // ★S-8 극단(R1 구현 중 발견·PM 반영지시) — 덱 고갈로 이월 손패가 0장이면 CHAR_SWAP은
  // "1장 이상 선택"이 구조적으로 불가능해 합법 옵션에서 제외한다(CHAR_SMASH는 무관).
  const charSkillUsable = charSkillId !== 'CHAR_SWAP' || player.hand.length >= 1;

  let options;
  if (isWinner) {
    // ★§4 — 승자는 SP 무관 항상 1회(미만충 시 평타 강제, 만충 시 3택[평타/스킬/뽑기]).
    if (!spAtThreshold) {
      options = ['BASIC_ATTACK'];
    } else if (usePolicy === 'forced') {
      // ★구 구현 보존(N1 이전 강제 분기, S-5 패턴) — 평타 없이 스킬/뽑기 중 강제.
      options = (charSkillUsable ? [charSkillId] : []).concat(heldSkills).concat(['DRAW']);
    } else {
      options = ['BASIC_ATTACK'].concat(charSkillUsable ? [charSkillId] : []).concat(heldSkills).concat(['DRAW']);
    }
  } else {
    // ★§4 — 패자는 만충 시에만 게이트가 열린다(호출부가 보장). 평타권 없음 —
    // 옵션은 스킬(캐릭터 기본 스킬 포함)과 뽑기뿐이다.
    options = (charSkillUsable ? [charSkillId] : []).concat(heldSkills).concat(['DRAW']);
  }
  return { options, spAtThreshold, heldSkills, usePolicy, charSkillId, charSkillUsable };
}

/**
 * ★C4(§6-5) 전용 헬퍼 — 이번 순간 제시 가능한 카드 타입 목록(전역 유일성 반영).
 * 액티브는 양측 어느 쪽이든 이미 보유 중이면 제외(존재 판정, indexOf) — 패시브는
 * 무제한 가용(중복 보유 자체가 C4의 목적). presentCardDraw·AI 양쪽이 공유(재구현 금지).
 */
function eligibleDrawTypes(state) {
  const heldActiveSet = new Set(
    state.players.A.cards.concat(state.players.B.cards).filter((c) => ACTIVE_SKILL_IDS.indexOf(c) !== -1)
  );
  return state.config.draft.cardTypes.filter((t) => (PASSIVE_CARD_IDS.indexOf(t) !== -1 ? true : !heldActiveSet.has(t)));
}

/**
 * ★G-A-10(2026-08-18, 오너 확정 "3장중 하나 뽑기!") — SP 뽑기(3턴 주기 드래프트 폐지의
 * 대체, [F10-25])를 「사적 3장 1택」으로 구현한다(구 「무작위 1장」 축소구현 폐기,
 * §17-1 #4 종결). 공격 없음 ⓐ. SP 전량 소비(W13, 뽑기를 "고르는" 이 순간 즉시 —
 * 무엇을 고를지와 무관) → C4 유일성 반영 최대 offerSize장 제시(draft 스트림, 결정론) →
 * ★대기 상태로 전환(pendingQueue에 CARD_DRAW_PICK을 얹는다 — 실제 1장 선택은
 * resolveCardDrawPick이 별도 액션으로 이어받는다) → 팟 처리(승자면 소멸 ⓑ, 패자면
 * 무관 ⓒ — §5 ②③, "뽑기를 골랐다" 그 자체가 트리거이므로 몇 장이 제시됐든·나중에
 * 무엇을 고르든 이 시점에 확정한다).
 * ★draft.js의 2단계 픽 흐름(runOffer/resolveDecision, 구 3턴 주기 드래프트 전용)은
 * 재사용하지 않는다(정본 명시) — 여기 신설한 소형 함수 2개(이 함수 + resolveCardDrawPick)
 * 로 완결한다. state.draft.pendingOffer(구 시스템 필드)와도 완전히 별개로
 * state.cardDrawOffer를 신설한다(이름 충돌·의미 혼동 방지).
 * 반환: 픽 대기 상태로 전환해 이후 처리를 미뤘으면 true(호출부는 여기서 return해야
 * 한다), 제시 가능한 카드가 0장이라 즉시 종결됐으면 false(호출부가 기존 lethal/턴
 * 전환 로직을 그대로 이어간다 — 구 방어적 분기와 동형).
 */
function presentCardDraw(state, actor, isWinner, events) {
  const player = state.players[actor];
  const spBefore = player.sp;
  changeSp(state, actor, -spBefore, 'spDraw', events, PHASE.R6_SP); // W13 — 뽑기도 SP 전량 소비(0 리셋), "고른 순간" 즉시

  const eligible = eligibleDrawTypes(state);
  const full = player.cards.length >= state.config.draft.slotsMax;

  if (eligible.length === 0) {
    // ★방어적 — 패시브가 항상 무제한 가용이라 구조적으로 거의 불가능(카드 레지스트리가
    // 비어야만 발생). 조용히 무시하지 않고 이벤트로 남긴다. 제시할 것이 없으므로
    // 픽 대기 단계 자체가 성립하지 않는다 — 구 「무작위 1장」의 방어 분기와 동형으로
    // 즉시 종결.
    events.push(
      mkEvent(state, {
        phase: PHASE.R5_BATTLE,
        actor,
        type: EVENT_TYPE.CARD_DRAW,
        rng: null,
        fields: { stage: 'EMPTY_POOL', offered: [], picked: null, eligibleCount: 0, full, discarded: null, isWinner, spGain: 0 },
      })
    );
    if (isWinner) settlePotOnWinnerDraw(state, events); // §5 ②③ — "뽑기를 골랐다"가 트리거, 결과 무관
    return false;
  }

  // ★결정론(오너 확정 요구) — 같은 시드·같은 액션열이면 항상 같은 offerSize장이
  // 같은 순서로 나온다: draft 스트림(새 스트림 신설 금지, 정본 명시)에서
  // sampleWithoutReplacement 1회. config.draft.offerSize(=3, 구 3턴 주기 드래프트가
  // 쓰던 값을 그대로 재배선 — 신규 키 아님)를 그대로 읽는다.
  const offerSize = Math.min(state.config.draft.offerSize, eligible.length);
  const drawsBefore = state.rng.draft.draws;
  const offered = state.rng.draft.sampleWithoutReplacement(eligible, offerSize);
  const drawsAfter = state.rng.draft.draws;
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor,
      type: EVENT_TYPE.CARD_DRAW,
      rng: { stream: 'draft', drawsBefore, drawsAfter },
      fields: { stage: 'OFFERED', offered: offered.slice(), eligibleCount: eligible.length, full, isWinner, spGain: 0 },
    })
  );

  // ★「사적」(G-A-10 핵심) — offered는 state.cardDrawOffer에만 보관한다. getPublicView는
  // 이 필드를 self 쪽에서만, 그것도 offer.actor===viewerActor일 때만 읽는다(self.deckTopPreview
  // 조건부 노출과 동일 패턴) — 상대 뷰는 이 필드 자체를 절대 만들지 않는다(화이트리스트
  // v6→v7 갱신·필수경로 무영향 — 조건부 필드는 REQUIRED에 넣지 않는다, 기존 관례).
  state.cardDrawOffer = { actor, offered: offered.slice(), isWinner, full, eligibleCount: eligible.length };
  state.pendingQueue = [{ type: 'CARD_DRAW_PICK', actor }];

  if (isWinner) settlePotOnWinnerDraw(state, events); // §5 ②③ — "뽑기를 골랐다"가 트리거, 나중에 무엇을 고르든 무관
  return true;
}

/**
 * ★G-A-10 — CARD_DRAW_PICK 액션 해소(presentCardDraw가 세운 대기 상태를 이어받는다).
 * offered 중 하나를 골라 보유 카드에 편입한다(만석이면 C4 만석 규약 그대로 — discard
 * 필요). PRNG 미소비(고르는 행위는 정책 결정, 난수 아님 — N-0d에 따라 rng:null).
 */
function resolveCardDrawPick(state, actor, payload, events) {
  const offer = state.cardDrawOffer;
  if (!offer || offer.actor !== actor) {
    throw new Error(`CARD_DRAW_PICK: ${actor}에 대한 대기 중인 뽑기 제시가 없다(내부 상태 오류)`);
  }
  const picked = payload && payload.picked;
  if (!picked || offer.offered.indexOf(picked) === -1) {
    throw new Error(`CARD_DRAW_PICK: 선택한 카드(${picked})가 제시 목록(${offer.offered.join(',')})에 없다`);
  }

  const player = state.players[actor];
  let discarded = null;
  if (offer.full) {
    const discardId = payload && payload.discard;
    if (!discardId || player.cards.indexOf(discardId) === -1) {
      throw new Error(`CARD_DRAW_PICK: ${actor}는 카드 슬롯(${state.config.draft.slotsMax})이 가득 차 버릴 카드(discard)를 지정해야 한다`);
    }
    player.cards.splice(player.cards.indexOf(discardId), 1);
    discarded = discardId;
  }
  player.cards.push(picked);
  const spGain = state.config.draft.pickSp;
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor,
      type: EVENT_TYPE.CARD_DRAW,
      rng: null,
      fields: {
        stage: 'PICKED',
        offered: offer.offered.slice(), // ★D3 요구 — 제시 3장 + 선택 1장을 이 이벤트 하나로 재구성 가능하게
        picked,
        eligibleCount: offer.eligibleCount,
        full: offer.full,
        discarded,
        slotsAfter: player.cards.length,
        isWinner: offer.isWinner,
        spGain,
      },
    })
  );
  changeSp(state, actor, spGain, 'cardDrawPick', events, PHASE.R6_SP);
  state.cardDrawOffer = null; // ★사적 채널 정리 — 해소 즉시 비운다(다음 getPublicView부터 self.cardDrawOffer 자체가 사라진다)

  finishActionChoiceTurn(state, actor, offer.isWinner, events);
}

/** applyAction 디스패치 진입점(handleExchange/handleSubmit/handleActionChoice와 동일 관례). */
function handleCardDrawPick(state, action, events) {
  resolveCardDrawPick(state, action.actor, action.payload || {}, events);
}

function handleActionChoice(state, action, events) {
  const actor = action.actor;
  const player = state.players[actor];
  const spBefore = player.sp;
  const isWinner = actor === state.roundCache.winner; // ★D1(§4) — roundCache에서 직접 읽는다(판정 시점에 고정된 값, 전역 추론 아님)
  const info = actionChoiceOptionsFor(state, actor, isWinner);
  const { options, spAtThreshold, heldSkills, usePolicy, charSkillId } = info;

  if (!isWinner && !spAtThreshold) {
    // ★호출부(resolveJudgment/handleActionChoice 자신의 이전 스텝)가 이 상태에선 애초에
    // 패자에게 ACTION_CHOICE를 큐에 넣지 않는다 — 도달하면 내부 불변식 위반(§4).
    throw new Error(`ACTION_CHOICE: 내부 불변식 위반 — 패자는 만충 상태일 때만 게이트가 열린다(actor=${actor}, sp=${spBefore})`);
  }

  const payload = action.payload || {};
  let chose, skillId;
  if (!spAtThreshold) {
    // isWinner && !spAtThreshold만 도달 가능(패자는 위에서 이미 막혔다).
    skillId = null;
    chose = 'BASIC_ATTACK';
  } else {
    const rawChoice = payload.choice;
    const choice = rawChoice === undefined || rawChoice === null ? (isWinner ? 'BASIC_ATTACK' : undefined) : rawChoice;
    if (options.indexOf(choice) === -1) {
      throw new Error(`ACTION_CHOICE: ${actor}(${isWinner ? '승자' : '패자'})는 [${options.join(',')}] 중 하나를 선택해야 한다(받은 ${choice}) — ★패스 없음(§4)`);
    }
    if (choice === 'BASIC_ATTACK') {
      skillId = null;
      chose = 'BASIC_ATTACK';
    } else if (choice === 'DRAW') {
      skillId = null;
      chose = 'DRAW';
    } else if (choice === charSkillId) {
      skillId = choice;
      chose = 'CHAR_SKILL';
    } else {
      skillId = choice;
      chose = 'SKILL';
    }
  }

  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor,
      type: EVENT_TYPE.ACTION_CHOICE,
      rng: null,
      fields: {
        spBefore,
        spAtThreshold,
        isWinner, // ★D1 — 6분기 판별용
        chose,
        skillId,
        charSkillId,
        slotsHeld: heldSkills.length,
        heldSkills: heldSkills.slice(),
        usePolicy,
        legalOptions: options.slice(), // ★D1([F11-26] ⓐ) — 분모를 이벤트가 직접 들고 있게(P-9 구조적 봉쇄)
        buffStacks: { '♠': player.buffStacks['♠'], '♦': player.buffStacks['♦'] }, // ★D1([F11-26] ⓑ)
        spAfter: chose === 'SKILL' || chose === 'CHAR_SKILL' || chose === 'DRAW' ? 0 : spBefore,
      },
    })
  );

  const opponent = actor === 'A' ? 'B' : 'A';
  const role = isWinner ? 'winner' : 'loser';
  let lethal = false;
  if (chose === 'DRAW') {
    // ★G-A-10 — 3장 제시 후 픽 대기로 전환하면(deferred:true) 이 턴은 아직 안 끝났다
    // (실제 카드 선택은 별도 CARD_DRAW_PICK 액션으로 온다) — resolveCardDrawPick이
    // 해소 시점에 finishActionChoiceTurn을 직접 부른다. eligible 0장(방어적, 거의
    // 도달 불가)이면 즉시 종결이라 deferred:false — 아래 공통 턴 마감으로 그대로 이어간다
    // (구 resolveCardDraw 즉시완결 동작과 동형, lethal 있을 수 없음 — 공격 없음 §4 3·5행).
    const deferred = presentCardDraw(state, actor, isWinner, events);
    if (deferred) return;
  } else if (chose === 'SKILL') {
    lethal = resolveActiveSkill(state, actor, opponent, skillId, events, role);
    changeSp(state, actor, -spBefore, 'skillUse', events, PHASE.R6_SP); // §2: 스킬 사용 시 SP 0
  } else if (chose === 'CHAR_SKILL') {
    lethal = resolveCharacterSkill(state, actor, opponent, skillId, payload, events, role);
    changeSp(state, actor, -spBefore, 'skillUse', events, PHASE.R6_SP); // ★J-5 오너 확정 — 기본 스킬도 SP 0
  } else {
    // BASIC_ATTACK — 승자 전용(§4, 옵션 목록 검증이 이미 패자 도달을 막았다)
    lethal = resolveDamage(state, actor, opponent, [], events, { role });
  }

  if (lethal) {
    finalizeGameEnd(state, actor, 'NATURAL', events);
    return;
  }

  finishActionChoiceTurn(state, actor, isWinner, events);
}

/**
 * ★D1(§4) 리팩터(G-A-10 부수, 로직 바이트 변경 없음 — 위치만 함수로 분리) — actor
 * 한 명의 ACTION_CHOICE 턴이 끝난 뒤 다음 단계를 정하는 공통 로직. handleActionChoice
 * 말미(즉시 종결 경로)와 resolveCardDrawPick 말미(픽 대기 해소 경로) 양쪽이 정확히
 * 같은 분기를 필요로 해 공유한다 — 두 곳이 각자 재구현하면 [F9-22]류로 갈린다.
 */
function finishActionChoiceTurn(state, actor, isWinner, events) {
  if (isWinner) {
    // ★D1(§4) — 패자는 만충 시에만 게이트가 열린다. 미만충이면 곧장 전투 종료(패자
    // 행동 자체가 없다 — 「패스」가 아니라 게이트 정의역 밖).
    const loserActor = state.roundCache.loser;
    if (state.players[loserActor].sp >= state.config.player.spThreshold) {
      state.pendingQueue = [{ type: 'ACTION_CHOICE', actor: loserActor }];
    } else {
      finishBattlePhase(state, events);
    }
  } else {
    finishBattlePhase(state, events);
  }
}

/**
 * ★D1(FIX-2 §2·§4) — 행동 게이트(전투) 종료 처리. SP 정산은 이제 판정 시점(resolveJudgment,
 * §2 스텝3)으로 이동했으므로 여기서는 하지 않는다(구 이중 정산점 단일화, [F10-24]).
 * ★3턴 주기 드래프트(구 draft.advanceDraftCycle/runOffer 자동 트리거) 폐지(§7-1) — SP
 * 뽑기(ACTION_CHOICE의 'DRAW' 옵션, presentCardDraw/resolveCardDrawPick)가 대체한다.
 * 이 함수는 이제 순수하게 finishRound로 넘어가는 얇은 경유지다(호출부 다형성 보존 —
 * handleActionChoice/finishActionChoiceTurn이 부른다).
 */
function finishBattlePhase(state, events) {
  const { winner, loser } = state.roundCache;
  finishRound(state, `${winner}_WIN`, events);
}

function finishRound(state, roundOutcome, events) {
  const { winner, loser } = state.roundCache;
  tickStatuses(state, roundOutcome, events); // ★R8 경계에서 화상·동결 1턴 소모(G4: 매 라운드 소모로 구현 — 보고 대상)
  tickForcedSubmitMinBoth(state, events); // ★W3(A7) — 동일 원칙(매 라운드 소모)
  reconcileBuffCaps(state, events); // ★W3(P7 상실 재정합)
  refillBothHands(state, [winner, loser], events, 'refill');
  advanceRound(state, roundOutcome, events);
}

// ---------------------------------------------------------------------------
// R8 보충 · 라운드 전진 · 전역 불변식(F15, 게이트 ⑦)
// ---------------------------------------------------------------------------

function refillOne(state, actor, events, reason) {
  const player = state.players[actor];
  const cap = getHandCap(player, state.config);
  const before = player.hand.length;
  const need = Math.max(0, cap - before);
  const dealt = need > 0 ? drawN(state, need, events, actor) : [];
  player.hand.push(...dealt);
  const handAfter = player.hand.slice();
  const shortfall = Math.max(0, cap - handAfter.length); // 공유 덱이 항상 보충하므로 구조상 0 — 방어적으로 유지(S-8)

  events.push(
    mkEvent(state, {
      phase: reason === 'initial' ? PHASE.GAME_START : PHASE.R8_REFILL,
      actor,
      type: EVENT_TYPE.DEAL,
      rng: null,
      fields: {
        reason,
        fillTarget: cap,
        dealt,
        handAfter: handAfter.map((c) => c.id),
        shortfall,
        deckRemaining: deckRemainingCount(state),
        deckRemainingBySuit: deckRemainingBySuit(state),
        deckRemainingJokers: deckRemainingJokers(state),
      },
    })
  );

  // ★A3(패 훔치기) 예약 폐기 해소 — "다음 보충(R8) 완료 직후"(카드문서 §2-A3 정정판).
  // 'initial'(게임 시작 최초 배분)은 pendingA3Discards가 항상 0이라 실질 도달 불가능한
  // 경로지만, 방어적으로 명시 제외한다(스킬은 게임 시작 이후에만 발동 가능하므로).
  if (reason !== 'initial' && player.pendingA3Discards > 0) {
    resolvePendingA3Discards(state, actor, events);
  }
}

/**
 * ★W1(2026-08-17, director 스펙 A/작업 C) — A3_DISCARD에 `source` 필드 추가. 2인
 * 게임이라 actor(target)의 유일한 상대가 항상 발동자다(A3는 자기 자신을 대상으로
 * 쓸 수 없다 — resolveActiveSkill의 A3 분기가 항상 opponent를 target으로 넘긴다) —
 * 계산이 아니라 구조적으로 자명한 값이지만, UI가 "누가 발동했는지" 기준으로 접근
 * 권한을 분기하려면(오너 확정 — 파괴된 카드는 발동한 쪽에만 공개) 매 이벤트에서 직접
 * 읽을 수 있는 명시 필드가 필요하다(A3_SCHEDULED까지 거슬러 올라가 매칭할 필요 없이).
 * ★getPublicView에 상대 손패를 새로 노출하는 게 아니다 — 이벤트 로그 필드 추가일
 * 뿐이고, "누구에게 보여줄지" 판단은 UI(web-engineer, 이 윈도 밖) 소관이다.
 */
function resolvePendingA3Discards(state, actor, events) {
  const player = state.players[actor];
  const source = actor === 'A' ? 'B' : 'A'; // ★W1 — 발동한 쪽(target의 유일한 상대)
  const n = Math.min(player.pendingA3Discards, player.hand.length);
  for (let i = 0; i < n; i++) {
    const handBefore = player.hand.map((c) => c.id);
    const drawsBefore = state.rng.status.draws;
    const removed = state.rng.status.pickAndRemove(player.hand); // ★status 스트림 고정(director 지침)
    const drawsAfter = state.rng.status.draws;
    state.cardAccounting.a3Discarded += 1;
    events.push(
      mkEvent(state, {
        phase: PHASE.R8_REFILL,
        actor,
        type: EVENT_TYPE.A3_DISCARD,
        rng: { stream: 'status', drawsBefore, drawsAfter },
        fields: { target: actor, source, discardedCardId: removed.id, handBefore, handAfter: player.hand.map((c) => c.id) },
      })
    );
  }
  player.pendingA3Discards -= n; // 정상 경로는 항상 0으로 수렴 — 손패 부족 극단(S-8)에서만 잔존 가능(방어적)
}

function refillBothHands(state, order, events, reason) {
  for (const actor of order) refillOne(state, actor, events, reason);
}

/**
 * ★★W3(2026-08-17, director SG-20 판정 3 — "불변식 위반이다. 단 지금 설계로는
 * 원리적으로 못 잡는다") — SUBMIT_COUNT_BOUNDS·CARRYOVER_BOUNDS 신설.
 *
 * ★★검사 시점 설계(director 지시 "검사를 handleSubmit 접수 시점(또는 직후)으로
 * 끌어와야 한다" — 이 함수가 그 답이다) — applyAction의 SUBMIT 분기에서
 * handleSubmit() 직후·resolveJudgment() 호출 전에 부른다(그 자리 자체가 아래 "왜
 * 여기인가"의 답). ★기존 checkInvariants(advanceRound에서만 호출)와는 **완전히
 * 분리**한다 — 통합하지 않는다. 이유 3가지:
 *   ① **데이터가 살아있는 유일한 창** — pendingSubmission/pendingHandBefore는
 *      resolveJudgment 도중 cleanupSubmissionTemp가 지운다(무승부 경로도, 승부
 *      경로도). advanceRound는 그 정리 이후에만 도달하므로, 거기 넣어도 이 두
 *      필드는 이미 null이라 검사할 데이터 자체가 없다 — 물리적으로 중복 실행이
 *      불가능하다(같은 라운드 안에서는).
 *   ② **바로 이 지점이 "위반 이벤트가 찍히기 전에 죽는" 구멍이었다** — SG-20
 *      크래시(hand=0 → evaluateHand throw)는 handleSubmit 접수 *이후*·
 *      resolveJudgment *이전* 사이에 존재하는 상태에서 발생했다. 그 틈에 정확히
 *      끼워 넣어야 "죽기 전에 위반을 남긴다"가 성립한다 — advanceRound(그 뒤)에
 *      넣으면 이미 죽은 뒤라 영원히 실행되지 않는다(director가 코드로 직접 확인한
 *      함정, 위 판정 3 원문).
 *   ③ **관심사가 다르다** — checkInvariants의 나머지 10종은 "라운드 경계 상태"
 *      전역 정합성(카드 총량·SP·HP·버프·손패 상한 등)이고, 이 2종은 "이번 SUBMIT
 *      트랜지션 하나"에 대한 국소 검증이다. 매 SUBMIT마다(라운드당 2회, actor별)
 *      독립적으로 찍히므로 라운드 경계 1회 검사와 빈도 자체가 다르다.
 * → ★결론: 이 함수는 checkInvariants의 "치환"이 아니라 "보완"이다. checkInvariants는
 * 무변경으로 advanceRound에 남고, 이 함수가 SUBMIT 트랜지션 전용으로 신설됐다.
 *
 * ★관측 가능성(director 요구 — "이 상태를 영원히 못 잡는다"의 반대를 만든다) —
 * 이 함수가 push하는 INVARIANT_VIOLATION은 applyAction의 로컬 events 배열에
 * 실린다. resolveJudgment가 *그 뒤*에 그래도 던지면(예: 이 검사 자체를 우회하는
 * 미지의 회귀) applyAction 함수 자체가 예외로 끝나 그 events가 호출부에 반환되지
 * 않는다 — 그래서 applyAction의 SUBMIT 분기가 resolveJudgment를 try/catch로 감싸고
 * (아래), 이미 수집된 events(이 검사의 위반 이벤트 포함)를 에러 객체에 실어
 * 재던진다. autoPlayGame이 그 events를 결과에 병합한다(아래 참조) — "위반이 찍힌
 * 채로 죽는다"가 이제 실제로 가능해졌다.
 *
 * ★SUBMIT_COUNT_BOUNDS — kMin>=1(=SG-20 ⓐ가 보장해야 하는 "제출 시점 손패>=1"의
 * 직접 관측 — kMax===0이면 kMin도 0이 되므로, kMin>=1 위반은 곧 "SUBMIT 시점에 낼
 * 카드가 0장이었다"는 뜻이다) ∧ 실제 제출 장수 ∈ [kMin,kMax](handleSubmit의 throw
 * 검증과 동형이지만, throw는 액션 자체를 막고 이 검사는 "막힌 뒤에도 상태가
 * 일관됐는가"를 남긴다).
 * ★CARRYOVER_BOUNDS — 이월(제출 후 남은 손패) 0 <= carryover <= handCap-kMin(스펙 A
 * "min 2가 상한 6을 내장" 문언의 직접 검증 — handCap=8이면 6, P1 보유 시 handCap=9면
 * kMin이 최소 1까지 내려갈 수 있어 상한이 최대 8이 아니라 handCap-kMin으로 A7
 * 강요가 걸려도 정확하다).
 */
function checkSubmitInvariants(state, events, actor) {
  const c = state.config;
  const player = state.players[actor];
  const handBefore = player.pendingHandBefore;
  const submitted = player.pendingSubmission;
  if (!handBefore || !submitted) return; // 방어적 — handleSubmit 직후 호출이 계약이라 항상 채워져 있어야 정상
  const forcedMinOpt = player.forcedSubmitMin ? { forcedMin: player.forcedSubmitMin.value } : undefined;
  const { kMin, kMax } = submitCountFor(handBefore, c, forcedMinOpt);
  const checks = [
    [
      'SUBMIT_COUNT_BOUNDS',
      () => {
        const ok = kMin >= 1 && submitted.length >= kMin && submitted.length <= kMax;
        return { ok, expected: `kMin>=1 ∧ submitCount∈[${kMin},${kMax}]`, actual: { kMin, kMax, submitCount: submitted.length, handBeforeSize: handBefore.length } };
      },
    ],
    [
      'CARRYOVER_BOUNDS',
      () => {
        const cap = getHandCap(player, c);
        const carryover = player.hand.length; // handleSubmit 직후 — 이월(제출 후 남은 손패), refill 전
        const upperBound = cap - kMin;
        const ok = carryover >= 0 && carryover <= upperBound;
        return { ok, expected: `[0,${upperBound}]`, actual: carryover };
      },
    ],
  ];
  for (const [id, fn] of checks) {
    const res = fn();
    if (!res.ok) {
      events.push(
        mkEvent(state, {
          phase: PHASE.R3_SUBMIT,
          actor,
          type: EVENT_TYPE.INVARIANT_VIOLATION,
          rng: null,
          fields: { invariantId: id, expected: res.expected, actual: res.actual, stateDump: null },
        })
      );
    }
  }
}

function checkInvariants(state, events) {
  const c = state.config;
  const checks = [
    [
      'CARD_CONSERVATION',
      () => {
        // 카드 6가지 종착지: 덱 잔여 / 양측 손패 / 영구 소실(화상 소진·리셔플 시 폐기) /
        // 제출 후 소모(R8) / A3 예약 폐기(S2 신설 — 폐기형, S-9 director 재확인 사항) /
        // ★J-5 신설 — CHAR_SWAP 폐기(EXCHANGE와 동일 원칙, 폐기형).
        const total =
          deckRemainingCount(state) +
          state.players.A.hand.length +
          state.players.B.hand.length +
          state.cardAccounting.burned +
          state.cardAccounting.discardedAtReplace +
          state.cardAccounting.submitted +
          state.cardAccounting.exchangeDiscarded +
          state.cardAccounting.a3Discarded +
          state.cardAccounting.charSwapDiscarded;
        const expected = DECK_SIZE * state.deck.idCounter;
        return { ok: total === expected, expected, actual: total };
      },
    ],
    ['SP_RANGE_A', () => ({ ok: state.players.A.sp >= 0 && state.players.A.sp <= c.player.spThreshold, expected: `[0,${c.player.spThreshold}]`, actual: state.players.A.sp })],
    ['SP_RANGE_B', () => ({ ok: state.players.B.sp >= 0 && state.players.B.sp <= c.player.spThreshold, expected: `[0,${c.player.spThreshold}]`, actual: state.players.B.sp })],
    // ★R7-A — 좌석 자기 max 기준(maxHpFor). 미지정이면 c.player.maxHp와 동일값이라 기존 회귀 무영향.
    ['HP_BOUNDS_A', () => ({ ok: state.players.A.hp >= 0 && state.players.A.hp <= maxHpFor(c, 'A'), expected: `[0,${maxHpFor(c, 'A')}]`, actual: state.players.A.hp })],
    ['HP_BOUNDS_B', () => ({ ok: state.players.B.hp >= 0 && state.players.B.hp <= maxHpFor(c, 'B'), expected: `[0,${maxHpFor(c, 'B')}]`, actual: state.players.B.hp })],
    [
      // ★W3(P7 「각인」) — 상한이 보유 기준으로 달라지므로(effectiveStackCap) 고정
      // c.buff.stackCap 대신 좌석별 유효 상한으로 검사한다(안 그러면 P7 보유 시 정상
      // 상태를 거짓 위반으로 찍는다 — SG-20과 같은 유형의 함정, ①②의 상호의존 교훈
      // 재적용).
      'BUFF_BOUNDS_A',
      () => {
        const s = state.players.A.buffStacks;
        const cap = effectiveStackCap(state.players.A, c);
        const ok = s['♠'] >= 0 && s['♠'] <= cap && s['♦'] >= 0 && s['♦'] <= cap;
        return { ok, expected: `[0,${cap}]`, actual: s };
      },
    ],
    [
      'BUFF_BOUNDS_B',
      () => {
        const s = state.players.B.buffStacks;
        const cap = effectiveStackCap(state.players.B, c);
        const ok = s['♠'] >= 0 && s['♠'] <= cap && s['♦'] >= 0 && s['♦'] <= cap;
        return { ok, expected: `[0,${cap}]`, actual: s };
      },
    ],
    [
      // ★S2: A3 예약 폐기가 "다음 보충 직후"에 해소되므로, 해소 직후~다음 라운드 재보충
      // 전까지 손패가 cap보다 적은 결손 상태(카드문서 §2-A3 "결손 손패 7장")가 정상
      // 상태로 존재한다 — S1의 엄격 등호 검사는 이 정당한 상태를 오탐한다. 상한(cap 초과
      // 금지)만 유지하고 하한은 느슨화한다.
      'HAND_CAP_A',
      () => ({ ok: state.players.A.hand.length <= getHandCap(state.players.A, c), expected: `<=${getHandCap(state.players.A, c)}`, actual: state.players.A.hand.length }),
    ],
    [
      'HAND_CAP_B',
      () => ({ ok: state.players.B.hand.length <= getHandCap(state.players.B, c), expected: `<=${getHandCap(state.players.B, c)}`, actual: state.players.B.hand.length }),
    ],
    [
      // ★D1(C4, §6-5) 재정의 — 구 DRAFT_POOL_CONSERVATION(전역 유일 pool Set 기반)은
      // 패시브 중복 허용으로 전제 자체가 깨졌다(패시브는 더 이상 pool에서 빠지지 않는다).
      // 남은 진짜 불변은 "액티브는 전역 유일 — 양측이 동시에 같은 액티브를 보유할 수
      // 없다"는 것뿐이라 그 명제로 대체한다.
      'ACTIVE_CARD_UNIQUENESS',
      () => {
        const dupes = ACTIVE_SKILL_IDS.filter((id) => state.players.A.cards.indexOf(id) !== -1 && state.players.B.cards.indexOf(id) !== -1);
        return { ok: dupes.length === 0, expected: 'no active card id held by both A and B', actual: dupes };
      },
    ],
    [
      // ★D1(FIX-2 §2-4·판정4 §7) 재정의 — 구 MULTIPLIER_RANGE(P5 개인배수 포함)를
      // 대체한다. 팟은 이제 순수 공유 값 — base(=1, 무변화 기준)에서 growthFactor의
      // 정수 거듭제곱만큼 성장하고 cap에서 클램프-유지된다(증발 없음, §2-4).
      'POT_RANGE',
      () => {
        const value = state.pot.value;
        const base = c.pot.base;
        const cap = c.pot.cap;
        const inRange = value >= base && value <= cap;
        // base로부터 growthFactor의 음이 아닌 정수 거듭제곱(반올림 오차 허용)이거나 cap에서
        // 클램프된 값이어야 한다 — 그 외 값이면 팟이 곱 외 경로(가산 등)로 오염된 것.
        let isValidGeometricStep = value === cap; // cap 클램프-유지 상태는 항상 유효
        if (!isValidGeometricStep) {
          let probe = base;
          for (let i = 0; i < 64 && probe < cap; i++) {
            if (Math.abs(probe - value) < 1e-9) {
              isValidGeometricStep = true;
              break;
            }
            probe *= c.pot.growthFactor;
          }
          if (Math.abs(probe - value) < 1e-9) isValidGeometricStep = true;
        }
        return { ok: inRange && isValidGeometricStep, expected: `[${base},${cap}] ∧ base×growthFactor^n 또는 cap`, actual: value };
      },
    ],
    [
      // ★D1(FIX-2 §3·[F15-26]) 신설 — HP 정수 유지. 설계 시점 이 검사가 아예 없었다(소수
      // 배율 경로가 이미 존재해 HP가 소수가 되는 길이 열려 있었다) — 최종 1회 반올림
      // 정본화로 이제 정수가 구조적으로 보장돼야 한다.
      'HP_INTEGER',
      () => {
        const okA = Number.isInteger(state.players.A.hp);
        const okB = Number.isInteger(state.players.B.hp);
        return { ok: okA && okB, expected: 'HP ∈ ℤ (양측)', actual: { A: state.players.A.hp, B: state.players.B.hp } };
      },
    ],
    [
      // ★D1(FIX-2 §3·[F15-26]) 신설 — 피해 하한(floor) 도달은 프로브가 아니라 불변식이다.
      // state.floorReachedCount는 resolveDamage가 floored:true일 때마다 누적한다(§3
      // "하한 도달은... >0이면 즉시 중단" — 이 코드베이스의 불변식은 실행을 중단하지
      // 않고 INVARIANT_VIOLATION을 발행하는 방식이므로, "즉시 중단"은 "그 시점부터 매
      // 라운드 위반으로 계속 플래그"로 구현한다 — 조용히 묻히지 않는다는 취지를 보존).
      'DAMAGE_FLOOR_NOT_REACHED',
      () => ({ ok: state.floorReachedCount === 0, expected: '피해 하한(floor) 도달 0건', actual: state.floorReachedCount }),
    ],
    [
      // ★S2 신설(PM 지시 — TC_S1.md §4-3 적발 #2, ★치명) — CARD_CONSERVATION은 장수
      // 회계라 ID 충돌·오치환은 총량만 맞으면 통과한다. 덱 잔여 ∪ 양측 손패의 논리 카드
      // ID 다중집합에서 중복을 직접 검사한다(S1 `@g<세대>` 충돌류 버그의 재발 감지).
      'ID_UNIQUENESS',
      () => {
        const ids = [];
        for (let i = state.deck.pointer; i < state.deck.cards.length; i++) ids.push(state.deck.cards[i].id);
        for (const card of state.players.A.hand) ids.push(card.id);
        for (const card of state.players.B.hand) ids.push(card.id);
        const seen = new Set();
        const dupes = [];
        for (const id of ids) {
          if (seen.has(id)) dupes.push(id);
          else seen.add(id);
        }
        return { ok: dupes.length === 0, expected: 'no duplicate ids', actual: dupes };
      },
    ],
    [
      // ★S2 신설(PM 지시 — TC_S1.md §4-3 적발 #3, 양방향) — auditPublicView는 화이트리스트
      // 초과 노출(violations)만 잡았다. 여기서 missingRequired(필수 필드 누락)까지 같이
      // 걸어 양방향으로 만든다 — 매 라운드 자동 실행되므로 배치가 곧 공개 뷰 퍼징이 된다.
      'PUBLIC_VIEW_AUDIT_A',
      () => {
        const audit = auditPublicView(getPublicView(state, 'A'), 'A', 'invariantCheck');
        const ok = audit.violations.length === 0 && audit.missingRequired.length === 0;
        return { ok, expected: 'violations:[] ∧ missingRequired:[]', actual: { violations: audit.violations, missingRequired: audit.missingRequired } };
      },
    ],
    [
      'PUBLIC_VIEW_AUDIT_B',
      () => {
        const audit = auditPublicView(getPublicView(state, 'B'), 'B', 'invariantCheck');
        const ok = audit.violations.length === 0 && audit.missingRequired.length === 0;
        return { ok, expected: 'violations:[] ∧ missingRequired:[]', actual: { violations: audit.violations, missingRequired: audit.missingRequired } };
      },
    ],
    [
      'A3_PENDING_BOUNDS_A',
      () => ({ ok: state.players.A.pendingA3Discards >= 0, expected: '>=0', actual: state.players.A.pendingA3Discards }),
    ],
    [
      'A3_PENDING_BOUNDS_B',
      () => ({ ok: state.players.B.pendingA3Discards >= 0, expected: '>=0', actual: state.players.B.pendingA3Discards }),
    ],
    [
      // ★R5①(PM 지시 2026-08-16, G-엔진 FAIL 수정 — verifier 재현 F15-22) — 오너 확정 ④
      // ("조커 2장이면 제출 1장까지")가 지금까지 handleSubmit의 예외 하나에만 의존했다.
      // 그 경로를 우회하는 어떤 상태 변경(H5류 직접 변조 포함)도 검출되지 않았다
      // (TC_S1 §4-3 "검사 장치 부재" 계열 재발). ★상한은 JOKER_SUBMIT_CAP(handEval.js)
      // 정본에서만 가져온다 — 여기서 새 리터럴을 만들지 않는다. pendingSubmission이
      // null이면(제출 확정 전) 검사 대상이 없으므로 자명하게 통과.
      'JOKER_SUBMIT_LIMIT_A',
      () => {
        const sub = state.players.A.pendingSubmission;
        const jc = sub ? sub.filter((c) => c.isJoker).length : 0;
        return { ok: jc <= JOKER_SUBMIT_CAP, expected: `<=${JOKER_SUBMIT_CAP}`, actual: jc };
      },
    ],
    [
      'JOKER_SUBMIT_LIMIT_B',
      () => {
        const sub = state.players.B.pendingSubmission;
        const jc = sub ? sub.filter((c) => c.isJoker).length : 0;
        return { ok: jc <= JOKER_SUBMIT_CAP, expected: `<=${JOKER_SUBMIT_CAP}`, actual: jc };
      },
    ],
  ];
  for (const [id, fn] of checks) {
    const res = fn();
    if (!res.ok) {
      events.push(
        mkEvent(state, {
          phase: PHASE.R8_REFILL,
          actor: null,
          type: EVENT_TYPE.INVARIANT_VIOLATION,
          rng: null,
          fields: { invariantId: id, expected: res.expected, actual: res.actual, stateDump: null },
        })
      );
    }
  }
}

/**
 * ★D1(FIX-2 §6-6·B-6) — 하드캡 종료 판정승 체인. 구현 전에는 승자를 `null`로 고정했다
 * (`proto/test/S3_attempt3_finalgate.js:74`·`prediagnosis.js:152`가 `!state.winner`로
 * 하드캡 판을 셌다 — 이 배선으로 그 두 좌표는 조용히 0을 반환하게 된다. ★명시적
 * 비호환 — 조용한 통과 금지, 보고 대상). 체인: ①잔여 HP 다수 → ②라운드 승수 다수 →
 * ③마지막 승부 라운드 승자 → ④(전 라운드 무승부인 극단) 좌석 규약(A 우선).
 */
function resolveHardCapWinner(state) {
  const hpA = state.players.A.hp;
  const hpB = state.players.B.hp;
  if (hpA !== hpB) return { winner: hpA > hpB ? 'A' : 'B', method: 'HP' };
  const winsA = state.roundWins.A;
  const winsB = state.roundWins.B;
  if (winsA !== winsB) return { winner: winsA > winsB ? 'A' : 'B', method: 'ROUND_WINS' };
  if (state.lastDecisiveWinner) return { winner: state.lastDecisiveWinner, method: 'LAST_DECISIVE' };
  return { winner: 'A', method: 'SEAT_CONVENTION' }; // ★전 라운드 무승부인 극단(§6-6 ④)
}

function advanceRound(state, roundOutcome, events) {
  state.prevOutcome = roundOutcome;
  state.round += 1;
  checkInvariants(state, events);
  if (state.round > state.config.sim.roundHardCap) {
    const chain = resolveHardCapWinner(state);
    finalizeGameEnd(state, chain.winner, 'HARD_CAP', events, {
      hardCapWinnerChain: {
        method: chain.method,
        hp: { A: state.players.A.hp, B: state.players.B.hp },
        roundWins: { A: state.roundWins.A, B: state.roundWins.B },
        lastDecisiveWinner: state.lastDecisiveWinner,
      },
    });
    return;
  }
  buildRoundQueue(state);
}

// ---------------------------------------------------------------------------
// getLegalActions — ★순수(PRNG 미소비, state 불변)
// ---------------------------------------------------------------------------

function getLegalActions(state) {
  if (state.terminal) return null;
  const pending = state.pendingQueue[0];
  if (!pending) return null;
  const actor = pending.actor;
  const player = state.players[actor];

  if (pending.type === 'EXCHANGE') {
    const capInfo = computeExchangeCap(state, actor);
    return { type: 'EXCHANGE', actor, capEffective: capInfo.capEffective, handIds: player.hand.map((c) => c.id) };
  }
  if (pending.type === 'SUBMIT') {
    const handIds = player.hand.map((c) => c.id);
    // ★W1(2026-08-17, director 스펙 A) — handleSubmit과 반드시 같은 정본 submitCountFor
    // 호출. kMin/kMax가 신규 필드 — ★count는 kMax의 하위호환 별칭으로 그대로 남긴다
    // (proto/web/ UI가 legal.count를 "정확히 이만큼 선택" 기준으로 쓰는데, UI는 이번
    // 윈도에서 건드리지 않는다 — kMax를 그대로 제출하는 것은 여전히 항상 합법이므로
    // count=kMax 유지만으로 기존 UI 동작이 회귀 없이 보존된다). jokerSubmitCap은
    // 표시용 메타(강제력은 handleSubmit의 권위 검증이 갖는다) — ★R5① 값은
    // JOKER_SUBMIT_CAP(handEval.js) 정본에서만 가져온다.
    // ★W3(A7) — handleSubmit과 반드시 같은 forcedMin opts(A-2 정본 원칙).
    const legalForcedMinOpt = player.forcedSubmitMin ? { forcedMin: player.forcedSubmitMin.value } : undefined;
    const { kMin, kMax } = submitCountFor(player.hand, state.config, legalForcedMinOpt);
    return { type: 'SUBMIT', actor, handIds, count: kMax, kMin, kMax, jokerSubmitCap: JOKER_SUBMIT_CAP };
  }
  if (pending.type === 'ACTION_CHOICE') {
    // ★D1(FIX-2 §4) — actionChoiceOptionsFor가 유일한 옵션-빌드 정본이다. handleActionChoice가
    // 같은 함수를 호출한다(양쪽이 각자 재구현하면 갈린다 — [F9-22] 경고 그대로).
    const isWinner = actor === state.roundCache.winner;
    const info = actionChoiceOptionsFor(state, actor, isWinner);
    return {
      type: 'ACTION_CHOICE',
      actor,
      options: info.options,
      isWinner, // ★D1 — 6분기 판별용(AI/UI가 승자/패자 갈래를 다시 추론하지 않게)
      spAtThreshold: info.spAtThreshold,
      heldSkills: info.heldSkills.slice(),
      charSkillId: info.charSkillId,
      usePolicy: info.usePolicy,
      handIds: player.hand.map((c) => c.id), // ★J-5 — CHAR_SWAP 카드 선택(AI/UI)용
      swapCount: state.config.character.swap.count,
      cardsFull: player.cards.length >= state.config.draft.slotsMax, // ★D1(§7-1) — 'DRAW' 선택 시 discard 필요 여부(AI/UI용)
      heldCards: player.cards.slice(), // ★D1(§7-1) — 'DRAW' 만석 discard 후보
    };
  }
  if (pending.type === 'CARD_DRAW_PICK') {
    // ★G-A-10 — presentCardDraw가 세운 state.cardDrawOffer가 유일한 정본(재구현 아님,
    // 여기서 그대로 재노출). offered는 이미 actor 본인에게만 존재하는 사설 데이터라
    // getLegalActions(state)를 actor 자신이 호출하는 문맥(AI decide 루프·자기 UI)에서만
    // 의미가 있다 — getPublicView의 self.cardDrawOffer와 같은 원본을 공유한다.
    const offer = state.cardDrawOffer;
    if (!offer || offer.actor !== actor) throw new Error('getLegalActions: CARD_DRAW_PICK pending인데 state.cardDrawOffer가 없거나 actor가 다르다(내부 상태 오류)');
    return {
      type: 'CARD_DRAW_PICK',
      actor,
      offered: offer.offered.slice(),
      isWinner: offer.isWinner,
      cardsFull: offer.full, // ★기존 ACTION_CHOICE의 cardsFull과 동일 명명(AI/UI 재사용 편의)
      heldCards: player.cards.slice(),
    };
  }
  throw new Error(`getLegalActions: 알 수 없는 pending 타입 ${pending.type}`);
}

// ---------------------------------------------------------------------------
// getPublicView — ★순수, S-10/O-19 화이트리스트 그대로. AI/UI는 이 함수만 본다.
// ---------------------------------------------------------------------------

// ★J-5(PM 판정 ②, 2026-08-16) — character 노출로 v1→v2. 오너가 고르면 상대는 자동
// 반대라 양쪽 캐릭터는 구조적 공개 정보(숨길 것이 없고 UI가 필요) — 화이트리스트
// 버전 증가 + 감사 재실행 필요.
// ★R7-A(2026-08-17, rule-engineer — 오너 요청 'HP 직접 조절') — self.maxHp/opponent.maxHp
// 노출로 v2→v3. 좌석별 maxHp가 비대칭일 수 있게 되면서 "800 고정"을 전제로 HP바를
// 그리던 UI(web-engineer)가 실제 상한을 알 방법이 필요해졌다 — hp와 마찬가지로
// 구조적 공개 정보(양쪽 다 자기 HP를 보므로 숨길 이유 없음).
// ★W1(2026-08-17, director 스펙 A 부수 D-1/D-3) — v3→v4, 3개 필드 신규:
//  ① self.spAtThreshold/opponent.spAtThreshold — "액티브 사용 가능" 불리언. web/app.js
//     의 renderCardBadges가 이미 이 정확한 비교식(sp>=spThreshold)을 클라이언트에서
//     직접 재현하고 있었다(그 파일 주석이 스스로 "rule-engineer가 전용 필드를
//     getPublicView에 추가해야 한다"고 요청 — R10-W). ②로 조건이 늘어날 수 있어
//     엔진이 판정의 유일한 출처가 되게 한다.
//  ② shared.draftPreview — draft.cycleCounter의 파생값(다음 뽑기까지 남은 승부
//     라운드 수 등). UI가 주기를 자체 계산하면 룰 이중 구현이 된다(스펙 A 문언).
// ★W3(2026-08-17, director 개정 스펙 B — 신규 카드 6종) — v4→v5, 4개 필드 신규:
//  ① self.deckTopPreview — P6(예지) 보유 시 공유 덱 상단 peekCount장(S9 §2-P6). P3
//     (deckRemainingBySuit)와 같은 "보유 기준 조건부 노출" 패턴, self 스코프.
//  ② opponent.revealedCards — A9(투시) 발동자에게만, 상대 이월 중 공개된 카드
//     (D1 예외 ⓑ — S9 §2-A9 D1 예외 목록. 발동 대상이 아닌 뷰(피격자·제3자)에는
//     노출되지 않는다 — getPublicView가 viewer===byActor를 직접 검사).
//  ③ self.forcedSubmitMin / ④ opponent.forcedSubmitMin — A7(강요)이 걸려 있으면
//     다음 SUBMIT kMin 하한(S9 §2-A7). 자신이 강요당했는지 알아야 제출 계획이 서고,
//     상대에게 걸어둔 강요가 아직 유효한지도 알아야 한다(공유 규칙 상태 — 은닉
//     대상 아님, EXCHANGE capSources처럼 이미 공개되는 파생 규칙값과 같은 층).
// ★D1(FIX-2 [F11-26]) — v5→v6. shared.multiplier(P5 개인배수와 뒤섞였던 구 공유 배수)를
// shared.pot(순수 공유 팟)으로 교체하고, matchId/gameIndexInMatch(§18 매치 경계 계측
// substrate — 매치 Bo3 오케스트레이션 자체는 이번 윈도 범위 밖, 필드만 선배선)를
// 신설한다. 필수경로(REQUIRED_PATHS)도 동시 갱신 — 안 하면 매 라운드 불변식이 자동
// 위반된다(v5 갱신 시의 동일 경고 그대로).
// ★G-A-10(2026-08-18, 오너 확정 "3장중 하나 뽑기!") — v6→v7. self.cardDrawOffer 신규
// (「사적 3장 1택」의 핵심 요구 — 제시된 3장은 고르는 본인에게만 보인다). self.deckTopPreview
// (P6)와 완전히 같은 "보유/상태 조건부 self 전용 노출" 패턴 — presentCardDraw가
// state.cardDrawOffer.actor===viewerActor일 때만 채워진다(offer.actor가 다르면, 즉
// 상대 뷰에서는 이 경로 자체가 view.self에 생기지 않는다 — 존재 자체가 조건부라
// REQUIRED_PATHS에는 넣지 않는다, deckTopPreview·forcedSubmitMin과 동일 관례).
// 필수경로는 이번엔 무변경(조건부 필드라 REQUIRED 갱신 대상이 아니다).
// ★D2-A — v7→v8: shared.drawPoolPreview(항상 존재, ALLOWED+REQUIRED 동시 갱신) 신설.
const PUBLIC_VIEW_WHITELIST_VERSION = 'v8';
const PUBLIC_VIEW_ALLOWED_PATHS = new Set([
  'viewer',
  'round',
  'turn',
  'turn.actor',
  'turn.type',
  'turn.pickOrder',
  'self',
  'self.actor',
  'self.character',
  'self.hand',
  'self.hand.*',
  'self.hand.*.id',
  'self.hand.*.rank',
  'self.hand.*.suit',
  'self.hand.*.copyIndex',
  'self.hand.*.isJoker',
  'self.cards',
  'self.cards.*',
  'self.hp',
  'self.maxHp', // ★R7-A
  'self.sp',
  'self.spAtThreshold', // ★W1 — 액티브 사용 가능 불리언
  'self.buffStacks',
  'self.buffStacks.♠',
  'self.buffStacks.♦',
  'self.status',
  'self.status.BURN',
  'self.status.BURN.remaining',
  'self.status.BURN.source',
  'self.status.FREEZE',
  'self.status.FREEZE.remaining',
  'self.status.FREEZE.source',
  'self.forcedSubmitMin', // ★W3(A7) — 내가 강요당했으면 {value,remaining}
  'self.forcedSubmitMin.value',
  'self.forcedSubmitMin.remaining',
  'self.deckTopPreview', // ★W3(P6) — P6 보유 시에만 존재(조건부 노출, P3와 동일 패턴)
  'self.deckTopPreview.*',
  'self.deckTopPreview.*.id',
  'self.deckTopPreview.*.rank',
  'self.deckTopPreview.*.suit',
  'self.deckTopPreview.*.copyIndex',
  'self.deckTopPreview.*.isJoker',
  'self.cardDrawOffer', // ★G-A-10(v7) — CARD_DRAW_PICK 대기 중이고 이 뷰어가 그 뽑기의 actor일 때만 존재(조건부 노출, deckTopPreview와 동일 패턴). 카드 타입 문자열 배열(self.cards와 동일 원소형).
  'opponent',
  'opponent.actor',
  'opponent.character',
  'opponent.handSize',
  'opponent.cards',
  'opponent.cards.*',
  'opponent.hp',
  'opponent.maxHp', // ★R7-A
  'opponent.sp',
  'opponent.spAtThreshold', // ★W1
  'opponent.buffStacks',
  'opponent.buffStacks.♠',
  'opponent.buffStacks.♦',
  'opponent.status',
  'opponent.status.BURN',
  'opponent.status.BURN.remaining',
  'opponent.status.BURN.source',
  'opponent.status.FREEZE',
  'opponent.status.FREEZE.remaining',
  'opponent.status.FREEZE.source',
  'opponent.lastExchangeCount',
  'opponent.forcedSubmitMin', // ★W3(A7) — 내가 상대에게 건 강요가 아직 유효한지
  'opponent.forcedSubmitMin.value',
  'opponent.forcedSubmitMin.remaining',
  'opponent.revealedCards', // ★W3(A9) — 발동자(viewer===byActor)에게만, D1 예외 ⓑ
  'opponent.revealedCards.*',
  'opponent.revealedCards.*.id',
  'opponent.revealedCards.*.rank',
  'opponent.revealedCards.*.suit',
  'opponent.revealedCards.*.copyIndex',
  'opponent.revealedCards.*.isJoker',
  'shared',
  'shared.pot', // ★D1 — 구 shared.multiplier 대체(G-A-9 팟 가시화 요구의 데이터 원천, UI 표시는 D2 소관)
  'shared.pot.value',
  'shared.pot.base',
  'shared.pot.growthFactor',
  'shared.pot.cap',
  'shared.pot.atCap', // ★D1(§2-4 팟 계측 — 상한 도달 여부, G-A-9 UI 필수 3종 중 하나)
  'shared.matchId', // ★D1(§18 계측 substrate — 매치 오케스트레이션 자체는 미구현, 필드만 선배선)
  'shared.gameIndexInMatch',
  'shared.deckRemaining',
  'shared.deckRemainingBySuit',
  'shared.deckRemainingBySuit.♠',
  'shared.deckRemainingBySuit.♥',
  'shared.deckRemainingBySuit.♦',
  'shared.deckRemainingBySuit.♣',
  'shared.deckRemainingJokers',
  'shared.draftPreview', // ★W1 — cycleCounter 파생값(다음 뽑기까지 남은 승부 라운드 수)
  'shared.draftPreview.cycleCounter',
  'shared.draftPreview.cycleLength',
  'shared.draftPreview.roundsUntilNext',
  'shared.draftPreview.forcedOff',
  'shared.drawPoolPreview', // ★D2-A — eligibleDrawTypes(state) 그대로(양측 보유로 이미 유추 가능한 공개 정보)
  'shared.drawPoolPreview.remaining',
  'shared.drawPoolPreview.remaining.*',
  'shared.drawPoolPreview.remainingCount',
  'shared.lastRevealedSubmission',
  'shared.lastRevealedSubmission.round',
  'shared.lastRevealedSubmission.A',
  'shared.lastRevealedSubmission.A.submitted',
  'shared.lastRevealedSubmission.A.submitted.*',
  'shared.lastRevealedSubmission.A.rankCategory',
  'shared.lastRevealedSubmission.A.compareKey',
  'shared.lastRevealedSubmission.A.compareKey.*',
  'shared.lastRevealedSubmission.B',
  'shared.lastRevealedSubmission.B.submitted',
  'shared.lastRevealedSubmission.B.submitted.*',
  'shared.lastRevealedSubmission.B.rankCategory',
  'shared.lastRevealedSubmission.B.compareKey',
  'shared.lastRevealedSubmission.B.compareKey.*',
  'shared.terminal',
  'shared.terminalReason',
  'shared.winner',
]);

/**
 * ★S2 신설(PM 지시 — TC_S1.md §4-3 적발 #3) — auditPublicView가 초과 노출뿐 아니라
 * "반드시 있어야 하는" 필드의 누락도 잡도록 만드는 필수 경로 목록. P3 게이트 필드
 * (shared.deckRemainingBySuit 등)나 배열 원소 와일드카드(self.hand.*.id 등)처럼 게임
 * 상태에 따라 조건부로만 존재하는 경로는 여기 넣지 않는다 — 항상 존재해야 하는
 * 구조적/스칼라 경로만(S-10·정본 §2-3이 "반드시 공개"라 명시한 것: 양측 HP/SP/배수/
 * 보유스킬/덱잔량·opponent.lastExchangeCount 등).
 */
const PUBLIC_VIEW_REQUIRED_PATHS = new Set([
  'viewer',
  'round',
  'turn',
  'self',
  'self.actor',
  'self.character', // ★J-5 — 구조적 공개 정보(항상 존재)
  'self.hand',
  'self.cards',
  'self.hp',
  'self.maxHp', // ★R7-A
  'self.sp',
  'self.spAtThreshold', // ★W1 — 구조적 공개 정보(항상 존재)
  'self.buffStacks',
  'self.buffStacks.♠',
  'self.buffStacks.♦',
  'self.status',
  'self.status.BURN',
  'self.status.FREEZE',
  'opponent',
  'opponent.actor',
  'opponent.character', // ★J-5
  'opponent.handSize',
  'opponent.cards',
  'opponent.hp',
  'opponent.maxHp', // ★R7-A
  'opponent.sp',
  'opponent.spAtThreshold', // ★W1
  'opponent.buffStacks',
  'opponent.buffStacks.♠',
  'opponent.buffStacks.♦',
  'opponent.status',
  'opponent.status.BURN',
  'opponent.status.FREEZE',
  'opponent.lastExchangeCount',
  'shared',
  'shared.pot', // ★D1 — 구 shared.multiplier 대체
  'shared.pot.value',
  'shared.pot.base',
  'shared.pot.growthFactor',
  'shared.pot.cap',
  'shared.pot.atCap',
  'shared.matchId', // ★D1(§18 계측 substrate)
  'shared.gameIndexInMatch',
  'shared.deckRemaining',
  'shared.draftPreview', // ★W1 — 구조적 공개 정보(항상 존재)
  'shared.draftPreview.cycleCounter',
  'shared.draftPreview.cycleLength',
  'shared.draftPreview.roundsUntilNext',
  'shared.drawPoolPreview', // ★D2-A — 구조적 공개 정보(항상 존재, eligibleDrawTypes가 빈 배열조차 필드는 만든다)
  'shared.drawPoolPreview.remaining',
  'shared.drawPoolPreview.remainingCount',
  'shared.lastRevealedSubmission',
  'shared.terminal',
  'shared.terminalReason',
  'shared.winner',
]);

function getPublicView(state, viewerActor) {
  if (viewerActor !== 'A' && viewerActor !== 'B') throw new Error('getPublicView: viewerActor는 "A" 또는 "B"');
  const opponentActor = viewerActor === 'A' ? 'B' : 'A';
  const me = state.players[viewerActor];
  const opp = state.players[opponentActor];

  const pending = state.pendingQueue[0];
  const turn = state.terminal || !pending ? null : { actor: pending.actor, type: pending.type, pickOrder: pending.pickOrder === undefined ? null : pending.pickOrder };
  // ★D2-A — 1회만 계산(getPublicView는 AI 결정마다 호출되는 핫패스라 중복 호출 방지).
  const drawPoolRemaining = eligibleDrawTypes(state);

  const view = {
    viewer: viewerActor,
    round: state.round,
    turn,
    self: {
      actor: viewerActor,
      character: me.character, // ★J-5 — 구조적 공개 정보(PM 판정②)
      hand: me.hand.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit, copyIndex: c.copyIndex, isJoker: c.isJoker })),
      cards: me.cards.slice(),
      hp: me.hp,
      maxHp: maxHpFor(state.config, viewerActor), // ★R7-A
      sp: me.sp,
      spAtThreshold: me.sp >= state.config.player.spThreshold, // ★W1 — handleActionChoice의 spAtThreshold와 동일 술어(정본 판정, 재구현 아님)
      buffStacks: { '♠': me.buffStacks['♠'], '♦': me.buffStacks['♦'] },
      status: {
        BURN: me.status.BURN ? { remaining: me.status.BURN.remaining, source: me.status.BURN.source } : null,
        FREEZE: me.status.FREEZE ? { remaining: me.status.FREEZE.remaining, source: me.status.FREEZE.source } : null,
      },
      forcedSubmitMin: me.forcedSubmitMin ? { value: me.forcedSubmitMin.value, remaining: me.forcedSubmitMin.remaining } : null, // ★W3(A7)
    },
    opponent: {
      actor: opponentActor,
      character: opp.character, // ★J-5
      handSize: opp.hand.length,
      cards: opp.cards.slice(),
      hp: opp.hp,
      maxHp: maxHpFor(state.config, opponentActor), // ★R7-A
      sp: opp.sp,
      spAtThreshold: opp.sp >= state.config.player.spThreshold, // ★W1
      buffStacks: { '♠': opp.buffStacks['♠'], '♦': opp.buffStacks['♦'] },
      status: {
        BURN: opp.status.BURN ? { remaining: opp.status.BURN.remaining, source: opp.status.BURN.source } : null,
        FREEZE: opp.status.FREEZE ? { remaining: opp.status.FREEZE.remaining, source: opp.status.FREEZE.source } : null,
      },
      lastExchangeCount: opp.lastExchangeCount,
      forcedSubmitMin: opp.forcedSubmitMin ? { value: opp.forcedSubmitMin.value, remaining: opp.forcedSubmitMin.remaining } : null, // ★W3(A7)
    },
    shared: {
      // ★D1(FIX-2 §2-4·G-A-9) — 구 shared.multiplier 대체. 팟은 순수 공유 값(actor 비대칭
      // 없음) — G-A-9 UI 필수 3종(현재값·성장 사건·상한 도달)의 데이터 원천.
      pot: { value: state.pot.value, base: state.config.pot.base, growthFactor: state.config.pot.growthFactor, cap: state.config.pot.cap, atCap: state.pot.value >= state.config.pot.cap },
      matchId: state.matchId, // ★D1(§18 계측 substrate)
      gameIndexInMatch: state.gameIndexInMatch,
      deckRemaining: deckRemainingCount(state),
      // ★W1(2026-08-17, director 스펙 A 부수 D-1) — draft.cycleCounter의 파생값("다음
      // 뽑기까지 남은 승부 라운드 수"). draft.js advanceDraftCycle과 완전히 같은 카운트
      // 규약(무승부는 세지 않는다, S-13)을 그대로 읽을 뿐 재구현이 아니다 — UI가 이
      // 주기를 자체 계산하면 룰 이중 구현이 된다(스펙 A 문언). forcedOff(게이트⑥
      // 강제배정 모드)면 드래프트 자체가 발동하지 않으므로 roundsUntilNext는 의미가
      // 없다는 신호로 그대로 노출한다(UI가 숨길지 말지는 UI 소관).
      draftPreview: {
        cycleCounter: state.draft.cycleCounter,
        cycleLength: state.config.draft.cycle,
        roundsUntilNext: Math.max(0, state.config.draft.cycle - state.draft.cycleCounter),
        forcedOff: state.draft.forcedOff,
      },
      // ★D2-A(FIX-2 §12-1 D2-②) — "언제 뽑나" 정책의 EV 앵커 보강. DRAW를 선택하면
      // 실제로 제시될 3장(state.cardDrawOffer)은 그 순간까지 RNG 미소비라 원리적으로
      // 알 수 없다("사적" 채널, G-A-10) — 그러나 "무엇이 제시될 수 있는가"의 모집단
      // (eligibleDrawTypes, C4 전역 유일성 반영)은 양측 보유 카드로부터 항상 순수하게
      // 계산 가능한 공개 정보다(양쪽 다 view.self.cards/opponent.cards로 이미 상대의
      // 보유를 본다 — 이 필드가 추가로 새는 비밀은 없다, 재구현이 아니라 같은
      // eligibleDrawTypes를 뷰에 실어 AI가 중복 계산하지 않게 한 것뿐). ai.js가
      // newCardValue 상수의 flat 근사를 이 모집단 기준 기댓값으로 대체하는 데 쓴다.
      drawPoolPreview: {
        remaining: drawPoolRemaining,
        remainingCount: drawPoolRemaining.length,
      },
      lastRevealedSubmission: state.lastRevealedSubmission,
      terminal: state.terminal,
      terminalReason: state.terminalReason,
      winner: state.winner,
    },
  };

  // ★D1(C4, F12-22 PM 판정) — P3(수트별 잔여수 공개)는 count화하지 않는다: 이 패시브의
  // 효과는 "수트별 잔여수 뷰가 켜지느냐 꺼지느냐"뿐인 이진 정보라, 스케일할 파라미터
  // 자체가 없다(몇 장을 들었든 노출되는 deckRemainingBySuit 값은 동일) — 존재 판정
  // (indexOf)이 구조적으로 맞고, 「장수」로 세는 C4 중첩 대상이 아니다. 아래 P6(딥프리뷰
  // 매수)는 peekCount라는 스케일 가능한 파라미터가 있어 count화한다(대비 참조).
  if (me.cards.indexOf('P3') !== -1) {
    view.shared.deckRemainingBySuit = deckRemainingBySuit(state);
    view.shared.deckRemainingJokers = deckRemainingJokers(state);
  }

  // ★D1 정정(C4, F12-22 — verifier 실측 "카운트 시 명백히 스케일 가능한 파라미터라
  // 중첩 누락이 실질적") — P6(딥프리뷰 매수)는 P1/P4/P7과 동일하게 「장수」로 센다
  // (존재 판정 indexOf → countCard). 1장 보유 시 peekCount 그대로(종전과 동치) ·
  // 2장 이상이면 peekCount가 그만큼 배로 늘어난다(§6-5 C4 — 패시브 중복은 중첩).
  const p6Count = countCard(me, 'P6'); // ★D1(C4) — 중복 보유 중첩(장수 카운트)
  if (p6Count > 0) {
    view.self.deckTopPreview = deckTopCards(state, p6Count * state.config.card.p6.peekCount);
  }

  // ★G-A-10(2026-08-18, 오너 확정 "3장중 하나 뽑기!") — 「사적」의 실제 구현부.
  // state.cardDrawOffer는 뽑기를 고른 그 actor 1인 전용 사설 상태다 — 이 뷰어가
  // 바로 그 actor일 때만(offer.actor===viewerActor) self.cardDrawOffer를 채운다.
  // 상대 뷰(viewerActor가 offer.actor와 다름)에서는 이 if가 거짓이라 필드 자체가
  // view.self에 생성되지 않는다 — auditPublicView가 이 경로를 "초과 노출"로 잡을
  // 방법도 없다(값을 지우는 게 아니라 애초에 안 만든다, self.deckTopPreview와 동형).
  if (state.cardDrawOffer && state.cardDrawOffer.actor === viewerActor) {
    view.self.cardDrawOffer = state.cardDrawOffer.offered.slice();
  }

  // ★W3(A9 「투시」) — D1 예외 ⓑ: 발동자(byActor===viewerActor)에게만 노출. 상대의
  // 현재 손패에 더 이상 없는 id는 자연히 제외한다(A3 폐기 등으로 사라진 카드 —
  // §2-A9 "공개 ID가 손패에 없으면 표시하지 않는다"). 만료(state.round>expiresRound)도
  // 여기서 조용히 필터링(별도 tick 불요 — 읽기 시점 필터).
  if (opp.revealedTo && opp.revealedTo.byActor === viewerActor && state.round <= opp.revealedTo.expiresRound) {
    const oppHandIdSet = new Set(opp.hand.map((c) => c.id));
    const stillPresent = opp.revealedTo.ids.filter((id) => oppHandIdSet.has(id));
    if (stillPresent.length > 0) {
      const oppCardsById = indexById(opp.hand);
      view.opponent.revealedCards = stillPresent.map((id) => {
        const c = oppCardsById[id];
        return { id: c.id, rank: c.rank, suit: c.suit, copyIndex: c.copyIndex, isJoker: c.isJoker };
      });
    }
  }

  return view;
}

function collectPaths(value, prefix, out) {
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) collectPaths(value[0], `${prefix}.*`, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      collectPaths(value[k], path, out);
    }
  }
}

/** 점 경로 문자열로 obj를 내려가며 값을 읽는다(N6 값 검증용 — 와일드카드 `*` 경로는 쓰지 않는다). */
function getByPath(obj, path) {
  if (path === '') return obj;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * ★N6 — PUBLIC_VIEW_REQUIRED_PATHS 중 값이 null이어도 정상인 경로(진짜로 "아직 없음"을
 * 뜻하는 상태). 이 집합 밖의 필수 경로는 null도 undefined와 마찬가지로 결함이다.
 */
const PUBLIC_VIEW_NULLABLE_REQUIRED_PATHS = new Set([
  'turn', // 종료 상태(terminal) 또는 대기 액션 없음 → null이 정상
  'self.status.BURN', // 비활성 상태이상 → null이 정상
  'self.status.FREEZE',
  'opponent.status.BURN',
  'opponent.status.FREEZE',
  'shared.lastRevealedSubmission', // 라운드1 판정 전 → null이 정상
  'shared.terminalReason', // 게임 진행 중 → null이 정상
  'shared.winner', // 게임 진행 중 → null이 정상
]);

/**
 * O-19(b): getPublicView 출력 감사(순수 유틸) — ★양방향(S2, PM 지시).
 * violations: 화이트리스트를 벗어난 초과 노출(기존 S1 기능 그대로).
 * missingRequired: PUBLIC_VIEW_REQUIRED_PATHS 중 이번 출력에 없거나(경로 자체 부재,
 * 기존 S2 기능) ★값이 유효하지 않은 경로(N6 신설 — qa-critic 적발: 기존엔 키 존재만
 * 확인해 값이 undefined/null이어도 통과시켰다). undefined는 이 스키마 어디서도 의도된
 * 값이 아니므로 항상 결함 — null은 PUBLIC_VIEW_NULLABLE_REQUIRED_PATHS에 있는 경로만
 * 정상(그 밖의 필수 경로에서 null은 undefined와 동급으로 결함 처리한다).
 */
function auditPublicView(view, viewer, phase) {
  const emitted = new Set();
  collectPaths(view, '', emitted);
  const emittedKeys = Array.from(emitted);
  const violations = emittedKeys.filter((p) => !PUBLIC_VIEW_ALLOWED_PATHS.has(p));
  const missingKeys = Array.from(PUBLIC_VIEW_REQUIRED_PATHS).filter((p) => !emitted.has(p));
  const invalidValueKeys = Array.from(PUBLIC_VIEW_REQUIRED_PATHS)
    .filter((p) => emitted.has(p))
    .filter((p) => {
      const v = getByPath(view, p);
      if (v === undefined) return true;
      if (v === null) return !PUBLIC_VIEW_NULLABLE_REQUIRED_PATHS.has(p);
      return false;
    });
  const missingRequired = missingKeys.concat(invalidValueKeys);
  return { viewer, phase, emittedKeys, whitelistVersion: PUBLIC_VIEW_WHITELIST_VERSION, violations, missingRequired };
}

// ---------------------------------------------------------------------------
// decide — ★AI 공통 시그니처. S3: L1(합법 무작위)/L2(기대값 휴리스틱)/L3(L2+카운팅)
// + 측정 프로브 4종(always_best·hold_aware·rank_first·suit_first) 전부 ai.js가
// 실제 구현을 갖고 있다(★한 벌 원칙 — 이 함수는 얇은 재노출일 뿐, 로직을 여기 두지
// 않는다). L1은 aiRandom.js로 옮겨졌지만 로직은 S1/S2 당시 이 함수에 있던 것과
// 바이트 단위로 동일하다(디스패치만 aiRandom.dispatch로 위임) — S3 게이트②
// "L1 동결"이 요구하는 대로, 이후 이 파일에서 L1 관련 코드를 건드릴 일이 없다.
// ★입력은 PlayerView뿐(뷰 B 접근 경로 없음) · 'policy' 스트림만 소비.
// ★config는 5번째(선택) 인자 — S1/S2 당시의 4-인자 호출부(예: proto/test/
// S1_TC_reanalysis.js)는 전부 tier='L1'만 쓰므로 config 누락이 영향 없다(L1은
// config를 아예 참조하지 않는다). L2/L3/프로브는 config.ai.*를 참조하며, 생략 시
// ai.js가 config/current.json을 방어적 기본값으로 쓴다.
// ---------------------------------------------------------------------------

function decide(view, legalActions, tier, policyStream, config) {
  return ai.decide(view, legalActions, tier, policyStream, config);
}

// ---------------------------------------------------------------------------
// createEngine / applyAction / exportReplay / replay
// ---------------------------------------------------------------------------

/**
 * ★D2-A(FIX-2 §6-1 — Bo3 매치 판 사이 이월) — 매치 오케스트레이터(proto/sim/match.js)가
 * 판N의 최종 state에서 뽑아 판N+1의 opts.matchCarryOver로 넘기는 값을 새 게임의
 * 초기 state에 적용한다. §6-1이 명시하는 이월 대상은 정확히 둘뿐이다:
 *   ① 스킬·패시브(빌드 카드) — spec.build: { A?: string[], B?: string[] }
 *   ② 도파민 카드 풀 상태 — spec.pool: string[](물리 1장 규약이라 배열=Set 그대로)
 * §6-2 리셋 6항(HP·수트스택·SP·팟·상태이상·손패/덱)은 이 함수가 손대지 않는다 —
 * createEngine이 매 판 initPlayer·새 덱으로 새로 시작하는 것 자체가 그 리셋이라
 * 추가 코드가 필요 없다(반대로 여기서 그 6항 중 하나라도 건드리면 그게 버그다).
 *
 * ★spec.pool은 가산이 아니라 치환이다 — createEngine이 만든 신선한(전체 cardTypes)
 * 풀을 이 집합으로 덮어쓴다. spec.build.A/B는 신선한(빈 배열) player.cards에 그대로
 * 얹는다(둘 다 매치 시작 시점의 판1에서는 opts.matchCarryOver 자체를 안 넘기면 되므로
 * "판1은 빈 이월"이 자연히 성립 — 별도 분기 불요).
 * ★forcedAssignment(TC 하네스)와는 호출부(createEngine)에서 상호배타로 막는다 — 같은
 * 지점(player.cards/draft.pool)을 서로 다른 의미로 건드려 조용히 뒤섞이면 안 된다.
 * ★★새로 발견한 것(보고 대상) — `state.draft.pool`은 G-A-10(사적 3장 1택) 실배선
 * 이후로는 라이브 뽑기 경로에서 참조되지 않는 죽은 필드다: `presentCardDraw`가 제시
 * 후보를 고를 때 부르는 `eligibleDrawTypes(state)`는 `state.config.draft.cardTypes`
 * (전체 16종 정적 목록)에서 "지금 양측 중 누군가 액티브로 보유 중인 타입"만 빼는
 * 구조라 `state.draft.pool`을 아예 안 읽는다(패시브는 전량 무제한 — C4). 즉 §6-1이
 * "카드가 이월되므로 풀 소모 상태도 함께 이월"이라 쓴 그 인과관계가 라이브 메커니즘
 * 에서는 이미 자동으로 성립한다 — spec.build만 올바르게 넘기면 eligibleDrawTypes가
 * 다음 판에서도 저절로 옳게 계산된다(이월된 보유 카드가 곧 "이번 판 제외 대상"이라
 * 별도 배관이 필요 없다). 아래 `state.draft.pool` 덮어쓰기는 그래서 라이브 규칙에는
 * 영향이 없다 — `applyForcedAssignment`(TC 하네스)·`cloneState`의 구조적 필드 정합성
 * (그리고 이 함수가 §6-1을 "문서 그대로" 이행했다는 사실 자체의 기록)을 위해서만
 * 유지한다. proto/sim/match.js는 spec.pool을 만들 때 `state.draft.pool`이 아니라
 * `engine.eligibleDrawTypes(finalState)`(라이브 권위)를 쓴다.
 */
function applyMatchCarryOver(state, spec, events) {
  spec = spec || {};
  if (spec.pool !== undefined) {
    if (!Array.isArray(spec.pool)) throw new Error('매치 이월: spec.pool은 배열이어야 한다');
    const poolSet = new Set(spec.pool);
    for (const t of poolSet) {
      if (state.config.draft.cardTypes.indexOf(t) === -1) {
        throw new Error(`매치 이월: 풀 카드 타입 "${t}"이 config.draft.cardTypes에 없다`);
      }
    }
    state.draft.pool = poolSet;
  }
  const appliedTo = [];
  for (const actor of ['A', 'B']) {
    const list = spec.build && spec.build[actor];
    if (!list || !list.length) continue;
    for (const ct of list) {
      if (state.config.draft.cardTypes.indexOf(ct) === -1) {
        throw new Error(`매치 이월: ${actor} 이월 빌드 카드 타입 "${ct}"이 config.draft.cardTypes에 없다`);
      }
    }
    if (list.length > state.config.draft.slotsMax) {
      throw new Error(`매치 이월: ${actor} 이월 빌드(${list.length}장)가 슬롯 상한(${state.config.draft.slotsMax})을 초과`);
    }
    appliedTo.push(actor);
    state.players[actor].cards = list.slice();
    events.push(
      mkEvent(state, {
        phase: PHASE.GAME_START,
        actor,
        // ★새 EVENT_TYPE을 신설하지 않는다(파일 스코프 — events.js 무접촉) — 기존
        // FORCED_ASSIGN을 mode:'carryOver'로 재사용한다. FORCED_ASSIGN 소비자는
        // mode 필드로 이미 분기하는 관례라(applyForcedAssignment의 'specified'|'random')
        // 신규 값 추가가 계약 파괴가 아니다.
        type: EVENT_TYPE.FORCED_ASSIGN,
        rng: null,
        fields: { mode: 'carryOver', cardTypes: list.slice(), slotsAfter: state.players[actor].cards.length },
      })
    );
  }
  events.push(
    mkEvent(state, {
      phase: PHASE.GAME_START,
      actor: null,
      type: EVENT_TYPE.FORCED_ASSIGN_MODE,
      rng: null,
      // ★draftOff:false — 매치 진행 중인 판2·판3도 정상 드래프트(SP 뽑기)가 계속 돈다.
      // state.draft.forcedOff는 건드리지 않는다(기본값 false 그대로 — createEngine이
      // 이 함수를 부르지 않으면 forcedOff도 안 건드리는 기존 동작과 동일선상).
      fields: { draftOff: false, appliedTo, mode: 'carryOver', poolRemainingCount: state.draft.pool.size },
    })
  );
}

/**
 * ★게이트 ⑥ — 강제 배정 모드. 드래프트 off + 시작 시 카드 무작위/지정 배정(director
 * S2 착수판정 R-4: 구현 순서 선두 배치 — 이게 있어야 뒤 카드 항목의 TC를 드래프트
 * 확률에 기대지 않고 강제 세팅으로 검증할 수 있다).
 *
 * spec: { draftOff?: boolean(기본 true), A?: AssignSpec, B?: AssignSpec }
 * AssignSpec: { cards: string[] } (지정) | { random: number } (무작위, draft 스트림 소비)
 *
 * ★draftOff:false로 쓰면 "카드는 미리 강제로 채워두되 드래프트 사이클은 계속 돈다" —
 * qa-critic 관측요구서 R-2("강제 배정 모드 또는 문서화된 상태 주입 하네스")가 요구하는
 * "한쪽 5칸 만석 + 풀 잔여 ≥1 + 드래프트 발동" 시나리오를 바로 이 옵션으로 구성할 수
 * 있다 — 게이트 ⑥ 자체(카드문서 표기 그대로)는 draftOff:true가 기본값이다.
 */
function applyForcedAssignment(state, spec, events) {
  const draftOff = spec.draftOff === undefined ? true : !!spec.draftOff;
  const appliedTo = [];
  for (const actor of ['A', 'B']) {
    const actorSpec = spec[actor];
    if (!actorSpec) continue;
    appliedTo.push(actor);
    const player = state.players[actor];
    let cardTypes, mode, rngInfo;
    rngInfo = null;

    if (Array.isArray(actorSpec.cards)) {
      mode = 'specified';
      cardTypes = actorSpec.cards.slice();
      for (const ct of cardTypes) {
        if (!state.draft.pool.has(ct)) {
          throw new Error(`강제 배정: ${actor}에게 지정한 카드 "${ct}"가 풀에 없다(중복 지정이거나 존재하지 않는 종류)`);
        }
      }
      if (new Set(cardTypes).size !== cardTypes.length) {
        throw new Error(`강제 배정: ${actor} 지정 목록에 중복이 있다(${cardTypes.join(',')})`);
      }
    } else if (typeof actorSpec.random === 'number') {
      mode = 'random';
      const n = actorSpec.random;
      const pool = Array.from(state.draft.pool);
      if (n > pool.length) throw new Error(`강제 배정: ${actor} 무작위 요청(${n})이 풀 잔량(${pool.length})을 초과`);
      const drawsBefore = state.rng.draft.draws;
      cardTypes = state.rng.draft.sampleWithoutReplacement(pool, n);
      const drawsAfter = state.rng.draft.draws;
      rngInfo = { stream: 'draft', drawsBefore, drawsAfter };
    } else {
      throw new Error(`강제 배정: ${actor}의 spec은 {cards:[...]} 또는 {random:N} 형태여야 한다`);
    }

    if (player.cards.length + cardTypes.length > state.config.draft.slotsMax) {
      throw new Error(`강제 배정: ${actor} 보유가 상한(${state.config.draft.slotsMax})을 초과(${player.cards.length}+${cardTypes.length})`);
    }
    for (const ct of cardTypes) {
      state.draft.pool.delete(ct);
      player.cards.push(ct);
    }
    events.push(
      mkEvent(state, {
        phase: PHASE.GAME_START,
        actor,
        type: EVENT_TYPE.FORCED_ASSIGN,
        rng: rngInfo,
        fields: { mode, cardTypes: cardTypes.slice(), slotsAfter: player.cards.length },
      })
    );
  }
  state.draft.forcedOff = draftOff;
  events.push(
    mkEvent(state, {
      phase: PHASE.GAME_START,
      actor: null,
      type: EVENT_TYPE.FORCED_ASSIGN_MODE,
      rng: null,
      fields: { draftOff, appliedTo },
    })
  );
}

/**
 * ★SG-2 하네스(qa-critic TC 실행 전제, PM 지시 2026-08-16) — 특정 실카드/조커를
 * 초기 손패에 강제 주입한다(테스트 전용). `forcedAssignment`(드래프트 카드 종류
 * P1~P5/A1~A4)와는 완전히 별개다 — 이건 "물리 카드"(실카드 랭크·수트 또는 조커) 주입.
 * spec: { A?: CardSpec[], B?: CardSpec[] }, CardSpec: {suit,rank} | {joker:true}
 * ★초기 딜(refillOne 'initial') 직전에만 호출한다 — 아직 아무것도 안 뽑힌(pointer=0)
 * 셔플된 덱에서 지정 카드를 직접 꺼내 손패에 먼저 놓고, 나머지는 정상 초기딜이 채운다
 * (카드 보존 불변식 자연 성립 — 덱→손패로 이동만, 소실 없음).
 */
function applyForcedHand(state, spec, events) {
  for (const actor of ['A', 'B']) {
    const list = spec[actor];
    if (!list || !list.length) continue;
    const player = state.players[actor];
    const forced = [];
    for (const want of list) {
      const idx = state.deck.cards.findIndex((c, i) => {
        if (i < state.deck.pointer) return false;
        return want.joker ? c.isJoker : !c.isJoker && c.suit === want.suit && c.rank === want.rank;
      });
      if (idx === -1) {
        throw new Error(`강제 손패 주입: ${actor}에게 요청한 카드(${JSON.stringify(want)})를 덱에서 찾을 수 없다(재고 소진 또는 중복 요청)`);
      }
      const [card] = state.deck.cards.splice(idx, 1);
      forced.push(card);
    }
    player.hand.push(...forced);
    events.push(
      mkEvent(state, {
        phase: PHASE.GAME_START,
        actor,
        type: EVENT_TYPE.FORCED_HAND,
        rng: null,
        fields: { requested: list.slice(), cards: forced.map((c) => c.id) },
      })
    );
  }
}

function createEngine(seed, userConfig, opts) {
  opts = opts || {};
  const config = buildConfig(userConfig);
  const rng = createRngStreams(seed >>> 0);
  const gameId = `g${seed >>> 0}`;
  // ★D1(FIX-2 §18·[F11-26] ⓕ) — matchId/gameIndexInMatch 계측 substrate. opts 미지정
  // 시 기존 단일 게임 호출부와 완전히 하위호환(matchId는 gameId 파생값, gameIndexInMatch=1).
  // ★D2-A(FIX-2 §6-1·§6-2) — 매치(Bo3) 오케스트레이션 자체(누가 언제 createEngine을
  // 몇 번 부르는가)는 이 판 하나의 책임이 아니다 — proto/sim/match.js가 판N 종료 후
  // 판N+1을 opts.matchId(동일)·gameIndexInMatch(+1)·opts.matchCarryOver로 호출하는
  // 식으로 얹는다(아래 applyMatchCarryOver 참조). 리셋 6항(HP·수트스택·SP·팟·상태이상·
  // 손패/덱)은 이 함수가 매 판마다 새로 만드는 state 자체가 이미 그 리셋이라 별도
  // 코드가 필요 없다 — opts.matchCarryOver 미지정 시(기존 전 호출부) 완전히 하위호환.
  const matchId = opts.matchId !== undefined && opts.matchId !== null ? opts.matchId : `m${seed >>> 0}`;
  const gameIndexInMatch = opts.gameIndexInMatch !== undefined && opts.gameIndexInMatch !== null ? opts.gameIndexInMatch : 1;
  // ★J-5 — "시작 전 선택, 상대는 자동 반대"(오너 확정). opts.characters 미지정 시
  // 고정 기본값(RNG 미소비 — 결정론·기존 회귀 스크립트 무영향).
  // ★D2-A(§12-2 W6) — opts.characterMirror(기본 false·측정 전용)는 resolveCharacters의
  // allowMirror를 그대로 전달한다. 실전 경로는 이 opts를 절대 안 쓴다.
  const characters = resolveCharacters(opts.characters, !!opts.characterMirror);

  const state = {
    v: SCHEMA_VERSION,
    gameId,
    matchId, // ★D1(§18 계측 substrate)
    gameIndexInMatch,
    seedRoot: seed >>> 0,
    config,
    rng,
    seqCounter: 0,
    round: 1,
    deck: { id: null, idCounter: 0, cards: [], pointer: 0 },
    players: { A: initPlayer(config, characters.A, 'A'), B: initPlayer(config, characters.B, 'B') },
    pot: { value: config.pot.base }, // ★D1 — 구 multiplier 대체(팟, 공유 단일값)
    roundWins: { A: 0, B: 0 }, // ★D1(§6-6 판정승 체인 ②)
    lastDecisiveWinner: null, // ★D1(§6-6 판정승 체인 ③) — 마지막 승부(무승부 아닌) 라운드의 승자
    floorReachedCount: 0, // ★D1([F15-26]) — 피해 하한 도달 누적(불변식)
    capReachedCount: 0, // ★D2 잔여(곱 상한 선배선, off) — 상한 도달 누적(불변식 아님, 관찰 지표). capRatio가 null이면 영구 0.
    draft: draft.initDraftState(config),
    cardDrawOffer: null, // ★G-A-10 — presentCardDraw가 세우는 사설(actor 전용) 픽 대기 상태. state.draft.pendingOffer(구 3턴 주기 드래프트)와 완전히 별개.
    pendingQueue: [],
    actionLog: [],
    terminal: false,
    terminalReason: null,
    winner: null,
    prevOutcome: null,
    roundCache: null,
    lastRevealedSubmission: null,
    cardAccounting: { burned: 0, discardedAtReplace: 0, submitted: 0, exchangeDiscarded: 0, a3Discarded: 0, charSwapDiscarded: 0 },
    forcedAssignmentSpec: null,
    forcedHandSpec: null,
    matchCarryOverSpec: null, // ★D2-A(§6-1) — exportReplay 재현 경로 통일용(forcedAssignmentSpec과 동일 관례)
  };
  const events = [];

  // 최초 덱 구성(세대 1) + 셔플(★deck 스트림 소비) — "교체"가 아니라 최초 구성이므로 DECK_REPLACED는 쓰지 않는다.
  const fresh = buildFreshDeckCards(1);
  state.rng.deck.shuffle(fresh);
  state.deck = { id: 'deck-1', idCounter: 1, cards: fresh, pointer: 0 };

  events.push(
    mkEvent(state, {
      phase: PHASE.GAME_START,
      actor: null,
      type: EVENT_TYPE.GAME_START,
      rng: null,
      fields: {
        deckId: state.deck.id,
        deckSize: DECK_SIZE,
        handCap: config.player.handCapBase,
        // ★R7-A(2026-08-17) — 좌석별 오버라이드 가능해지면서 단일 스칼라로는 대표 불가.
        // {A,B} 객체로 정정(GAME_END.maxHp와 동일 형태로 통일). maxHpOverridden — 이 판이
        // 기본값(config.player.maxHp)과 다른 HP로 시작했는지 소비자가 한눈에 판별하는 플래그
        // (밸런스·재미 판정 표본에서 제외해야 하는 판을 조용히 섞이지 않게 하는 목적).
        maxHp: { A: maxHpFor(config, 'A'), B: maxHpFor(config, 'B') },
        maxHpOverridden: { A: config.player.maxHpA !== null && config.player.maxHpA !== undefined, B: config.player.maxHpB !== null && config.player.maxHpB !== undefined },
        spThreshold: config.player.spThreshold,
        exchangeBase: config.exchange.base,
        jokerCount: JOKER_COPIES,
        characters, // ★J-5 — {A,B} 캐릭터 배정(구조적 공개 정보, PM 판정)
        matchId, // ★D1(§18 계측 substrate)
        gameIndexInMatch,
      },
    })
  );

  // ★D1(FIX-2 §12-1 B2·[F9-24]) — 종료 산술 불변식(config만으로 판정, 시드·배치 불요).
  // 게임 시작 시점에 1회 평가해 위반이면 즉시 알린다 — D3의 대량 시뮬레이션까지 끌지 않는다.
  const termArith = checkTerminationArithmetic(config);
  if (!termArith.ok) {
    events.push(
      mkEvent(state, {
        phase: PHASE.GAME_START,
        actor: null,
        type: EVENT_TYPE.INVARIANT_VIOLATION,
        rng: null,
        fields: {
          invariantId: 'TERMINATION_ARITHMETIC',
          expected: `maxHealPerRound(${termArith.maxHealPerRound}) < minRoundDamage(${termArith.minRoundDamage})`,
          actual: termArith,
          stateDump: null,
        },
      })
    );
  }

  // ★N3 수정(qa-critic 적발 — TC_S2 §6-N3) — 강제 배정이 초기 딜 이후에 적용되면 P1
  // (손패 상한 +1)을 강제 배정해도 getHandCap이 그 시점에 아직 P1을 못 봐 라운드1 딜이
  // 8장 기준으로 이뤄진다(정상은 9장). 강제 배정을 초기 딜 전으로 옮겨 딜 자체가 최종
  // 카드 보유 상태를 기준으로 이뤄지게 한다.
  // ★D2-A(§6-1) — matchCarryOver(매치 판 사이 이월)와 forcedAssignment(TC 하네스)는
  // 서로 다른 목적의 같은 지점(player.cards/draft.pool 선점) 개입이라 동시 지정을
  // 명시적으로 막는다(조용히 한쪽을 무시하지 않는다).
  if (opts.matchCarryOver && opts.forcedAssignment) {
    throw new Error('createEngine: opts.matchCarryOver와 opts.forcedAssignment는 동시 지정할 수 없다');
  }
  if (opts.matchCarryOver) {
    state.matchCarryOverSpec = opts.matchCarryOver;
    applyMatchCarryOver(state, opts.matchCarryOver, events);
  } else if (opts.forcedAssignment) {
    state.forcedAssignmentSpec = opts.forcedAssignment;
    applyForcedAssignment(state, opts.forcedAssignment, events);
  }
  // ★SG-2 — forcedHand도 동일 이유로 초기 딜 전(같은 이유: 덱 pointer=0 전제).
  if (opts.forcedHand) {
    state.forcedHandSpec = opts.forcedHand;
    applyForcedHand(state, opts.forcedHand, events);
  }

  refillOne(state, 'A', events, 'initial');
  refillOne(state, 'B', events, 'initial');

  buildRoundQueue(state);

  return { state, events };
}

function applyAction(inputState, action) {
  if (inputState.terminal) throw new Error('applyAction: 게임이 이미 종료됐다');
  const pending = inputState.pendingQueue[0];
  if (!pending) throw new Error('applyAction: 대기 중인 액션이 없다(내부 상태 오류)');
  if (pending.actor !== action.actor) throw new Error(`applyAction: 턴 오류 — 기대 actor=${pending.actor}, 받은=${action.actor}`);
  if (pending.type !== action.type) throw new Error(`applyAction: 턴 오류 — 기대 type=${pending.type}, 받은=${action.type}`);

  const state = cloneState(inputState);
  const events = [];
  state.pendingQueue = state.pendingQueue.slice(1);

  if (action.type === 'EXCHANGE') {
    handleExchange(state, action, events);
  } else if (action.type === 'SUBMIT') {
    handleSubmit(state, action, events);
    // ★W3(SG-20 판정 3) — handleSubmit 접수 직후·resolveJudgment 전(설계는 위
    // checkSubmitInvariants 헤더 주석 참조).
    checkSubmitInvariants(state, events, action.actor);
    if (state.pendingQueue.length === 0) {
      try {
        resolveJudgment(state, events);
      } catch (err) {
        // ★W3 — resolveJudgment가 그래도 던지면(미지의 회귀) 여기서 수집된 events
        // (이번 SUBMIT의 INVARIANT_VIOLATION 포함)를 에러에 실어 재던진다 — 안 그러면
        // applyAction 자체가 예외로 끝나 이 함수의 지역 events가 호출부(autoPlayGame
        // 등)에 영원히 도달하지 못한다(director "위반 이벤트가 찍히기 전에 죽는다"의
        // 실제 원인이었다 — 이 catch가 그 구멍을 막는다). state도 함께 실어 사후 분석
        // 가능하게 한다.
        err.partialEvents = events.slice();
        err.partialState = state;
        throw err;
      }
    }
  } else if (action.type === 'ACTION_CHOICE') {
    handleActionChoice(state, action, events);
    // ★D1(FIX-2 §7-1) — 구 DRAFT_PICK(3턴 주기 드래프트) 디스패치는 폐지했다(handleDraftPickAction
    // 삭제, 이력: 이 주석). ★G-A-10(2026-08-18) — SP 뽑기(ACTION_CHOICE의 'DRAW')는 더
    // 이상 단일 사설로 즉시 해소되지 않는다 — 3장을 제시하고 별도 CARD_DRAW_PICK
    // 액션으로 픽 대기를 이어받는다(아래 분기).
  } else if (action.type === 'CARD_DRAW_PICK') {
    handleCardDrawPick(state, action, events);
  } else {
    throw new Error(`applyAction: 알 수 없는 action.type ${action.type}`);
  }

  state.actionLog.push(action);
  return { state, events };
}

function exportReplay(state) {
  // ★강제 배정 모드(forcedAssignment)·강제 손패 주입(forcedHand, SG-2)·캐릭터 배정(J-5)은
  // 전부 게임 시작 시점의 opts라 액션 로그에 안 잡힌다 — 리플레이가 정확히 재현되려면
  // exportReplay/replay 양쪽에서 함께 실어야 한다. characters는 항상(미지정이었어도
  // 확정된 실제 배정값을) 싣는다 — resolveCharacters의 결정론 기본값도 명시적으로
  // 고정해 재현 경로를 하나로 통일한다.
  const opts = { characters: { A: state.players.A.character, B: state.players.B.character } };
  // ★D2-A(§12-2 W6) — characterMirror 진단 경로(A===B)로 만들어진 게임은 replay()가
  // 그대로 resolveCharacters(opts.characters)를 호출해도 실전 규칙(자동 반대)이 아니라
  // 이 값을 인정해야 한다 — 안 실으면 재생 시 "서로 반대여야 한다" 에러로 죽는다.
  if (state.players.A.character && state.players.A.character === state.players.B.character) {
    opts.characterMirror = true;
  }
  if (state.forcedAssignmentSpec) opts.forcedAssignment = JSON.parse(JSON.stringify(state.forcedAssignmentSpec));
  if (state.forcedHandSpec) opts.forcedHand = JSON.parse(JSON.stringify(state.forcedHandSpec));
  if (state.matchCarryOverSpec) opts.matchCarryOver = JSON.parse(JSON.stringify(state.matchCarryOverSpec)); // ★D2-A(§6-1)
  opts.matchId = state.matchId; // ★D1(§18 계측 substrate) — 재현 경로 통일
  opts.gameIndexInMatch = state.gameIndexInMatch;
  return {
    seed: state.seedRoot,
    config: JSON.parse(JSON.stringify(state.config)),
    opts,
    actions: state.actionLog.slice(),
  };
}

function replay(seed, config, actions, opts) {
  const init = createEngine(seed, config, opts);
  let state = init.state;
  const allEvents = init.events.slice();
  for (const action of actions) {
    const res = applyAction(state, action);
    state = res.state;
    for (const e of res.events) allEvents.push(e);
  }
  return { state, events: allEvents };
}

// ---------------------------------------------------------------------------
// autoPlayGame / runBatch — 헤드리스 자가대전 편의 함수(S1 게이트 ③·L1 미러 100판용)
// ★AI_DECISION(O-17) 기록 — decide()가 state를 못 만지므로 이 루프가 대신 남긴다.
// ★F16-06(c)(2026-08-17) — AI_DECISION은 진단 사이드카(result.diagnostics)에만
// 담긴다. 정본 이벤트 스트림(result.events)에는 절대 섞지 않는다 — events.js의
// mkDiagnosticEvent 계약 주석 참조. 이 계약이 깨지면(=AI_DECISION을 다시 result.events에
// 넣으면) export→replay diff가 다시 어긋난다(F16-06 재발 — proto/test/verifier_tc_j5.js가 검출).
// ---------------------------------------------------------------------------

const DECISION_TYPE_PHASE = {
  EXCHANGE: PHASE.R2_EXCHANGE,
  SUBMIT: PHASE.R3_SUBMIT,
  ACTION_CHOICE: PHASE.R5_BATTLE,
  DRAFT_PICK: PHASE.R7_DRAFT,
  CARD_DRAW_PICK: PHASE.R5_BATTLE, // ★G-A-10 — 뽑기 픽 대기 해소는 R5_BATTLE 소속(구 R7_DRAFT 폐지 이후 신설 축)
};

function mkAiDecisionEvent(state, info) {
  const canonical = JSON.stringify(info.view, Object.keys(info.view).sort());
  const observationHash = String(fnv1a(canonical, 0));
  // ★N1 수정(qa-critic 적발 — TC_S2 §6-N1 3) — S2는 payload.choice **존재 유무**로
  // SKILL/BASIC을 구분했는데, N1 판정 이후 BASIC_ATTACK이 임계+스킬보유 상황에서도
  // choice 값('BASIC_ATTACK' 또는 미기재)으로 명시적으로 올 수 있어 그 로직이면 SKILL로
  // 오분류된다. ★choice 값 자체(스킬ID 소속 여부)로 분류한다 — undefined/null/'BASIC_ATTACK'은
  // 전부 BASIC_ATTACK, ACTIVE_SKILL_IDS에 속하면 SKILL.
  const choiceVal = info.chosen.payload && info.chosen.payload.choice;
  const decisionType =
    info.legalActions.type === 'ACTION_CHOICE'
      ? (choiceVal && ACTIVE_SKILL_IDS.indexOf(choiceVal) !== -1 ? 'SKILL' : 'BASIC_ATTACK')
      : info.legalActions.type;
  // ★S3 — meta는 ai.decideWithMeta()가 채운 실측치(L1은 여전히 candidatesEvaluated:1·
  // handEvalCalls:0, L2/L3/프로브는 실제 탐색량). meta 미제공 호출부(과거 호환)는 L1과
  // 동일한 기본값으로 방어.
  const meta = info.meta || { candidatesEvaluated: 1, handEvalCalls: 0, budgetUsed: 0, budgetLimit: null, fallback: false };
  return mkDiagnosticEvent(state, {
    phase: DECISION_TYPE_PHASE[info.legalActions.type] || PHASE.R2_EXCHANGE,
    actor: info.actor,
    type: EVENT_TYPE.AI_DECISION,
    rng: { stream: 'policy', drawsBefore: info.drawsBefore, drawsAfter: info.drawsAfter },
    fields: {
      tier: info.tier,
      policyId: info.tier,
      decisionType,
      observationHash,
      candidatesEvaluated: meta.candidatesEvaluated,
      handEvalCalls: meta.handEvalCalls,
      budgetUsed: meta.budgetUsed || 0,
      budgetLimit: meta.budgetLimit === undefined ? null : meta.budgetLimit,
      budgetFallback: !!meta.fallback,
      chosen: info.chosen,
      rngStream: 'policy',
    },
  });
}

/**
 * 헤드리스 1판 자가대전. policyA/policyB는 'L1'만 지금 지원.
 * 반환: { state, events, exception? } — exception이 있으면 그 판은 예외로 중단된 것.
 */
function autoPlayGame(seed, config, policyA, policyB, opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps || 200000;
  const init = createEngine(seed, config, opts); // ★opts.forcedAssignment가 있으면 createEngine이 그대로 읽는다
  let state = init.state;
  const allEvents = init.events.slice();
  const diagnostics = []; // ★F16-06(c) — AI_DECISION 전용 사이드카. result.events(정본)에는 절대 안 섞는다.
  let steps = 0;

  try {
    while (!state.terminal) {
      steps += 1;
      if (steps > maxSteps) throw new Error(`autoPlayGame: maxSteps(${maxSteps}) 초과 — 무한루프 의심`);
      const legal = getLegalActions(state);
      if (!legal) break;
      const actor = legal.actor;
      const tier = actor === 'A' ? policyA : policyB;
      const view = getPublicView(state, actor);
      const drawsBefore = state.rng.policy.draws;
      const decision = ai.decideWithMeta(view, legal, tier, state.rng.policy, state.config);
      const action = decision.action;
      const drawsAfter = state.rng.policy.draws;
      const res = applyAction(state, action);
      for (const e of res.events) allEvents.push(e);
      diagnostics.push(
        mkAiDecisionEvent(res.state, { actor, tier, view, legalActions: legal, chosen: action, drawsBefore, drawsAfter, meta: decision.meta })
      );
      state = res.state;
    }
    return { state, events: allEvents, diagnostics };
  } catch (err) {
    // ★W3(SG-20 판정 3) — applyAction이 resolveJudgment의 예외에 events/state를 실어
    // 재던지면(위 applyAction SUBMIT 분기 참조) 여기서 병합한다. err.partialEvents가
    // 있으면 그 판(applyAction 내부에서 진행 중이던 이벤트, 이번 SUBMIT의
    // INVARIANT_VIOLATION 포함)이 아직 allEvents에 안 실린 상태이므로 여기서 붙인다.
    if (err.partialEvents) {
      for (const e of err.partialEvents) allEvents.push(e);
    }
    return { state: err.partialState || state, events: allEvents, diagnostics, exception: err.message };
  }
}

/** N게임 배치 — S1 게이트 ③(완주 100/100) 자가검증용. */
function runBatch(seedStart, count, config, policyA, policyB, opts) {
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(autoPlayGame(seedStart + i, config, policyA, policyB, opts));
  }
  const summary = {
    total: count,
    completed: results.filter((r) => !r.exception && r.state.terminal).length,
    exceptions: results.filter((r) => r.exception).length,
    natural: results.filter((r) => !r.exception && r.state.terminalReason === 'NATURAL').length,
    hardCap: results.filter((r) => !r.exception && r.state.terminalReason === 'HARD_CAP').length,
    rounds: results.filter((r) => !r.exception).map((r) => r.state.round),
    invariantViolations: results.reduce((s, r) => s + r.events.filter((e) => e.type === EVENT_TYPE.INVARIANT_VIOLATION).length, 0),
  };
  return { results, summary };
}

module.exports = {
  // API 6종(요구 스펙 그대로)
  createEngine,
  applyAction,
  getLegalActions,
  getPublicView,
  decide,
  exportReplay,
  replay,
  // S2 훅 4종
  computeExchangeCap,
  resolveDamage,
  resolveSuitEffects,
  DRAFT_CARD_TYPES: DEFAULT_CONFIG.draft.cardTypes,
  // ★S3 — AI 3단 + 프로브 4종 레지스트리(발견 편의용, 실제 로직은 ai.js/aiRandom.js)
  AI_POLICY_IDS: ai.AI_POLICY_IDS,
  // 편의·검증용
  autoPlayGame,
  runBatch,
  getHandCap,
  // ★D1 — 구 getEffectiveMultiplier/isP5Active(P5 개인배수) 폐지. 팟·크리 관련 신규
  // 노출(테스트·검증용):
  effectiveDiamondStack,
  countCard,
  resolveHardCapWinner, // ★D1(§6-6)
  checkTerminationArithmetic, // ★D1([F9-24]) — 순수 config 함수
  maxHpFor, // ★R7-A — 좌석별 유효 maxHp(config.player.maxHpA/B → 미지정 시 maxHp로 폴백)
  ACTIVE_SKILL_IDS,
  PASSIVE_CARD_IDS, // ★D1(C4)
  CARD_REGISTRY, // ★N8 — isAttack 이분법(S-15)
  eligibleDrawTypes, // ★G-A-10 — C4 전역 유일성 반영 제시 후보(테스트·검증용)
  // ★J-5 — 캐릭터 2종
  CHARACTER_IDS,
  CHARACTER_SKILL_IDS,
  CHARACTER_SKILL_REGISTRY,
  CHARACTER_OPPOSITE,
  DEFAULT_CHARACTERS,
  resolveCharacters,
  auditPublicView,
  PUBLIC_VIEW_WHITELIST_VERSION,
  PUBLIC_VIEW_ALLOWED_PATHS,
  PUBLIC_VIEW_REQUIRED_PATHS,
  PUBLIC_VIEW_NULLABLE_REQUIRED_PATHS, // ★N6
  checkInvariants,
  deckRemainingCount,
  deckRemainingBySuit,
  deckRemainingJokers,
  cloneState,
  buildConfig,
  DEFAULT_CONFIG,
};
