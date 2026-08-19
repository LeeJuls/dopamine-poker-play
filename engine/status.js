'use strict';

/**
 * proto/engine/status.js
 *
 * 상태이상 2종 — 화상(BURN)·동결(FREEZE). S0 A-4 수치 그대로.
 *
 * ★S1 범위 고지: A1(파이어볼)·A2(서리 발톱)는 S2 카드다. S1에는 상태이상을
 * "거는" 카드가 없다 — 그래서 이 모듈은 메커니즘(적용·리필·틱·만료·교환 상호작용)만
 * 완전히 구현하고, 실제 적용은 엔진 내부 훅(applyStatus)으로 노출한다.
 * S2에서 A1/A2가 이 훅을 호출한다. TC는 이 훅을 직접 호출해 메커니즘만 검증한다.
 *
 * - 화상(BURN)   : 지속 2라운드 · 교환 수령 카드 각 25% 소실
 * - 동결(FREEZE) : 지속 1라운드(다음 라운드) · 교환 상한 −2
 * - 중첩: 동종 재적용 = ★지속 리필(남은 턴 = max(남은, 신규), 스택 없음)
 */

const { EVENT_TYPE, PHASE, mkEvent } = require('./events');

/**
 * 상태이상 1건을 대상에게 적용한다(결정론 — 확률 판정은 호출부 책임).
 * playerState.status[type] 구조: { remaining, source } | null
 */
function applyStatus(state, targetActor, type, sourceCardId, events) {
  const player = state.players[targetActor];
  const cfg = state.config.status[type.toLowerCase()];
  const duration = cfg.duration;
  const current = player.status[type];
  const remainingBefore = current ? current.remaining : 0;
  const refreshed = !!current;
  const durationSet = Math.max(remainingBefore, duration);
  // ★S2 버그 수정(발견 — 아래 tickStatuses 참조) — appliedRound를 기록해 "적용된 바로 그
  // 라운드의 R8"에서는 틱하지 않게 한다. 이게 없으면 duration=1(동결)은 "다음 라운드"가
  // 시작되기도 전에 만료돼 실효 노출이 0라운드가 된다.
  player.status[type] = { remaining: durationSet, source: sourceCardId || null, appliedRound: state.round };
  events.push(
    mkEvent(state, {
      phase: PHASE.R5_BATTLE,
      actor: targetActor,
      type: EVENT_TYPE.STATUS_APPLY,
      rng: null,
      // ★S2 버그 수정(발견 — S1은 이 훅을 호출하는 카드가 없어 미노출) — fields에 'type'
      // 키를 그대로 실으면 mkEvent의 Object.assign이 이벤트 봉투의 type(STATUS_APPLY)을
      // 상태이상 종류(BURN/FREEZE)로 덮어써 이벤트 타입 자체가 사라진다. statusType으로 개명.
      fields: { statusType: type, target: targetActor, sourceCard: sourceCardId || null, durationSet, remainingBefore, refreshed },
    })
  );
}

/**
 * 라운드 경계에서 양측의 활성 상태이상을 1턴씩 소모한다.
 * ★G4(미결): 무승부 라운드가 지속 턴을 소모하는가 — S1은 "소모한다"(매 라운드
 * 진행마다 tick, 승부/무승부 무관)로 구현한다. roundCounted는 항상 true로 찍어
 * 이 선택이 로그에 남게 하고, 규칙이 나중에 바뀌어도 재실행 없이 소급 판정 가능하게 한다.
 *
 * ★S2 버그 수정(발견 — S1은 이 훅을 호출하는 카드가 없어 미노출) — "적용된 바로 그
 * 라운드"의 R8에서는 틱을 건너뛴다. 안 그러면 카드문서가 명시한 "다음 라운드"(동결
 * duration=1) 노출이 시작되기도 전에 만료돼 실효 노출 0라운드가 된다(화상 duration=2도
 * 노출이 의도한 라운드 수보다 1라운드 적게 나온다 — 동일 사유). appliedRound와
 * state.round가 같은 라운드에서만 건너뛰고, 그다음 R8부터는 정상 소모한다.
 */
function tickStatuses(state, roundOutcome, events) {
  for (const actor of ['A', 'B']) {
    const player = state.players[actor];
    for (const type of ['BURN', 'FREEZE']) {
      const st = player.status[type];
      if (!st) continue;
      const skippedSameRoundApplication = st.appliedRound === state.round;
      if (!skippedSameRoundApplication) st.remaining -= 1;
      const remainingAfter = st.remaining;
      events.push(
        mkEvent(state, {
          phase: PHASE.R8_REFILL,
          actor,
          type: EVENT_TYPE.STATUS_TICK,
          rng: null,
          fields: { statusType: type, target: actor, remainingAfter, roundCounted: true, roundOutcome, skippedSameRoundApplication },
        })
      );
      if (!skippedSameRoundApplication && remainingAfter <= 0) {
        player.status[type] = null;
        events.push(
          mkEvent(state, {
            phase: PHASE.R8_REFILL,
            actor,
            type: EVENT_TYPE.STATUS_EXPIRE,
            rng: null,
            fields: { statusType: type, target: actor },
          })
        );
      }
    }
  }
}

/** 동결 −2 페널티(활성 시), 없으면 0 */
function freezeExchangePenalty(playerState, config) {
  return playerState.status.FREEZE ? config.status.freeze.exchangePenalty : 0;
}

/**
 * 화상 확률 판정 — 'status' RNG 스트림 소비. 반환: {applied: bool, roll: number}
 * roll은 로그(EXCHANGE.burned[].roll)에 그대로 남겨 카드 단위 판정임을 검증 가능하게 한다.
 */
function rollBurn(rngStreams, chance) {
  const roll = rngStreams.status.next();
  return { applied: roll < chance, roll };
}

module.exports = { applyStatus, tickStatuses, freezeExchangePenalty, rollBurn };
