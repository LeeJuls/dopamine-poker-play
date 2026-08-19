'use strict';

/**
 * proto/engine/draft.js
 *
 * 로그라이크 드래프트 — S0 A-3(고갈 분기 3개·만석 시 포기 허용) + S-12(풀=종류당
 * 물리 1장) + S-13(주기 카운터는 승부 라운드만 증가) 그대로.
 *
 * ★S1 범위 고지: 실제 카드 9종의 "효과"는 S2 스코프다. S1은 드래프트 메커니즘
 * (제시·픽 순서·고갈 3분기·만석 포기·풀 복귀)을 config.draft.cardTypes 레지스트리
 * (P1~P5·A1~A4, A5 제외 9종)로 완전히 구현한다 — 타입만 오가고 효과는 미배선.
 * ★단 P1(손패+1)만은 §1 R1에 직접 명시된 핵심 라운드 규칙이라 engine.js의
 * getHandCap()에서 실제로 반영한다(다른 8종은 S2가 배선).
 */

const { EVENT_TYPE, PHASE, mkEvent } = require('./events');
const { changeSp } = require('./util');

function initDraftState(config) {
  return {
    pool: new Set(config.draft.cardTypes),
    cycleCounter: 0,
    forcedOff: false, // ★S2 게이트 ⑥ — 강제 배정 모드에서 true(기본). engine.js applyForcedAssignment가 설정.
    pendingOffer: null, // { list[], loserEligible, winner, loser }
  };
}

/**
 * S-13: 라운드 종료마다 호출 — 승부 라운드만 카운터 증가, 무승부는 카운트 제외.
 * 항상 DRAFT_CYCLE 이벤트를 남긴다(무승부의 counted:false 관측이 목적).
 * 반환: 이번 라운드에 드래프트를 발동해야 하면 true.
 * ★S2: forcedOff(강제 배정 모드, 게이트 ⑥ "드래프트 off")면 카운터는 정상 갱신하되
 * 절대 트리거하지 않는다 — 이벤트에 forcedOff를 실어 관측 가능하게 한다.
 */
function advanceDraftCycle(state, roundOutcome, events) {
  const counterBefore = state.draft.cycleCounter;
  const counted = roundOutcome !== 'DRAW';
  const counterAfterIncrement = counted ? counterBefore + 1 : counterBefore;
  const triggers = !state.draft.forcedOff && counted && counterAfterIncrement >= state.config.draft.cycle;
  events.push(
    mkEvent(state, {
      phase: PHASE.R7_DRAFT,
      actor: null,
      type: EVENT_TYPE.DRAFT_CYCLE,
      rng: null,
      fields: { counterBefore, counterAfter: counterAfterIncrement, counted, roundOutcome, forcedOff: state.draft.forcedOff },
    })
  );
  state.draft.cycleCounter = triggers ? 0 : counterAfterIncrement;
  return triggers;
}

/**
 * 드래프트 제시 — 'draft' RNG 스트림 소비. 풀 고갈 3분기(A-3)를 여기서 전부 처리한다.
 * 반환: 이번 라운드에 픽 단계가 필요하면 true(list.length>=1), 아니면 false(스킵 완료).
 */
function runOffer(state, winner, loser, events, rngStreams) {
  const drawsBefore = rngStreams.draft.draws;
  const pool = Array.from(state.draft.pool);
  const offerSize = Math.min(state.config.draft.offerSize, pool.length);

  if (offerSize === 0) {
    events.push(
      mkEvent(state, {
        phase: PHASE.R7_DRAFT,
        actor: null,
        type: EVENT_TYPE.DRAFT_SKIPPED,
        rng: null,
        fields: { reason: 'POOL_EMPTY', counterReset: true },
      })
    );
    state.draft.pendingOffer = null;
    return false;
  }

  const offered = rngStreams.draft.sampleWithoutReplacement(pool, offerSize);
  const drawsAfter = rngStreams.draft.draws;
  events.push(
    mkEvent(state, {
      phase: PHASE.R7_DRAFT,
      actor: null,
      type: EVENT_TYPE.DRAFT_OFFER,
      rng: { stream: 'draft', drawsBefore, drawsAfter },
      fields: { offered, offerSize, poolRemaining: pool.length - offered.length },
    })
  );

  state.draft.pendingOffer = {
    list: offered.slice(),
    loserEligible: offered.length >= 2, // A-3: 1장이면 패자 0픽
    winner,
    loser,
  };
  return true;
}

/**
 * 다음 픽 순서(pickOrder 1|2)와 그 actor. pendingOffer가 없거나 그 단계가
 * 필요 없으면 null(예: 1장 제시 후 승자 픽 완료 → 패자 단계 없음).
 */
function nextPickStep(state) {
  const po = state.draft.pendingOffer;
  if (!po) return null;
  if (po._winnerDone === undefined) return { pickOrder: 1, actor: po.winner };
  if (po._winnerDone && !po._loserDone) {
    if (!po.loserEligible) return null; // 1장 제시였음 — 패자 단계 없음
    if (po.list.length === 0) return null; // 승자가 유일한 1장을 이미 픽함
    return { pickOrder: 2, actor: po.loser };
  }
  return null;
}

/**
 * 한 플레이어의 드래프트 결정을 처리한다.
 * payload: { decision: 'pick', cardType } | { decision: 'pass' }
 */
function resolveDecision(state, actor, pickOrder, payload, events) {
  const po = state.draft.pendingOffer;
  const player = state.players[actor];
  const slotsMax = state.config.draft.slotsMax;
  const full = player.cards.length >= slotsMax;

  if (payload.decision === 'pass') {
    if (!full) throw new Error('DRAFT_PASS는 5칸이 가득 찼을 때만 합법이다');
    events.push(
      mkEvent(state, {
        phase: PHASE.R7_DRAFT,
        actor,
        type: EVENT_TYPE.DRAFT_PASS,
        rng: null,
        fields: { pickOrder, reason: 'slotsFull_declined', spGain: 0 },
      })
    );
  } else if (payload.decision === 'pick') {
    const cardType = payload.cardType;
    if (!po || !po.list.includes(cardType)) {
      throw new Error(`선택한 카드(${cardType})가 현재 제시 목록에 없다`);
    }
    po.list = po.list.filter((c) => c !== cardType);
    state.draft.pool.delete(cardType);

    const slotsBefore = player.cards.length;
    let discarded = null;
    let discardReturnedToPool = false;
    if (full) {
      const discardType = payload.discard;
      if (!discardType || !player.cards.includes(discardType)) {
        throw new Error('5칸이 가득 찼으면 보유 카드 중 1개를 버릴 대상으로 지정해야 한다');
      }
      player.cards = player.cards.filter((c) => c !== discardType);
      state.draft.pool.add(discardType);
      discarded = discardType;
      discardReturnedToPool = true;
    }
    player.cards.push(cardType);
    const slotsAfter = player.cards.length;
    const spGain = state.config.draft.pickSp;

    events.push(
      mkEvent(state, {
        phase: PHASE.R7_DRAFT,
        actor,
        type: EVENT_TYPE.DRAFT_PICK,
        rng: null,
        fields: { pickOrder, picked: cardType, slotsBefore, slotsAfter, discarded, discardReturnedToPool, spGain },
      })
    );
    changeSp(state, actor, spGain, 'draftPick', events, PHASE.R7_DRAFT);
  } else {
    throw new Error(`알 수 없는 드래프트 decision: ${payload.decision}`);
  }

  if (pickOrder === 1) po._winnerDone = true;
  else po._loserDone = true;
}

/** 이번 라운드의 드래프트 단계가 전부 끝났는가(더 이상 필요한 픽 단계 없음) */
function isDraftResolved(state) {
  return nextPickStep(state) === null;
}

module.exports = { initDraftState, advanceDraftCycle, runOffer, nextPickStep, resolveDecision, isDraftResolved };
