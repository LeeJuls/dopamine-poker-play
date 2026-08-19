'use strict';

/**
 * proto/engine/util.js — 여러 모듈이 공유하는 저수준 헬퍼.
 * ★순수하거나(clamp) 명시적으로 전달된 state/events만 건드린다 — 숨은 전역 없음.
 */

const { EVENT_TYPE, PHASE, mkEvent } = require('./events');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * ★R7-A(오너 요청 — HP 직접 조절) — 좌석별 유효 maxHp. `config.player.maxHpA`/`maxHpB`가
 * null/undefined(미지정)면 공유 기본값 `config.player.maxHp`로 폴백한다 — 이게 하위
 * 호환의 전부다(미지정 시 기존 동작과 완전히 동일). engine.js·ai.js·util.js가 전부
 * 이 함수 하나만 거쳐 좌석 max를 읽는다 — HP 비율(P5 등)이 관여하는 계산에서
 * "공유 maxHp"를 직접 참조하는 새 코드를 추가하지 말 것(그러면 이 함수를 우회해
 * 비대칭 HP에서 다시 왜곡된다).
 */
function maxHpFor(config, actor) {
  const override = actor === 'A' ? config.player.maxHpA : config.player.maxHpB;
  return override === null || override === undefined ? config.player.maxHp : override;
}

/**
 * SP 변경 — ★SP는 spThreshold를 상한으로 클램프된다(O-12 SP_CHANGE.clampedAtThreshold의
 * 존재 자체가 클램프 메커니즘의 관측 수단이라는 뜻으로 해석 — 근거는 최종보고에 명시).
 */
function changeSp(state, actor, delta, reason, events, phase) {
  const player = state.players[actor];
  const before = player.sp;
  const threshold = state.config.player.spThreshold;
  const raw = before + delta;
  const after = delta >= 0 ? clamp(raw, 0, threshold) : Math.max(0, raw);
  const clampedAtThreshold = delta >= 0 && raw > threshold;
  // ★D1(FIX-2 [F9-29] ⓒ) — 만충 SP 증발량을 이벤트가 직접 들고 있게 한다(사후 재구성
  // 금지 — P-9 구조적 봉쇄). clampedAtThreshold일 때 raw−after만큼 증발한다.
  const evaporated = clampedAtThreshold ? raw - after : 0;
  player.sp = after;
  events.push(
    mkEvent(state, {
      phase: phase || PHASE.R6_SP,
      actor,
      type: EVENT_TYPE.SP_CHANGE,
      rng: null,
      fields: { before, after, delta: after - before, reason, clampedAtThreshold, evaporated },
    })
  );
  return after;
}

/** HP 변경(회복 전용 — 데미지는 engine.js의 applyDamage가 별도 처리) */
function healHp(state, actor, amount, sourceSuitLevel, events, phase) {
  const player = state.players[actor];
  const hpBefore = player.hp;
  const maxHp = maxHpFor(state.config, actor); // ★R7-A — 회복 상한도 좌석 자기 max 기준
  const hpAfter = Math.min(hpBefore + amount, maxHp);
  const clampedAtMax = hpBefore + amount > maxHp;
  player.hp = hpAfter;
  events.push(
    mkEvent(state, {
      phase: phase || PHASE.R4_JUDGE,
      actor,
      type: EVENT_TYPE.HEAL,
      rng: null,
      fields: { amount, hpBefore, hpAfter, clampedAtMax, sourceSuitLevel },
    })
  );
  return hpAfter;
}

/** 카드 배열 얕은 clone(카드 객체 자체는 불변으로 취급 — 참조 공유해도 안전) */
function cloneCardArray(arr) {
  return arr.slice();
}

module.exports = { clamp, changeSp, healHp, cloneCardArray, maxHpFor };
