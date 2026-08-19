'use strict';

/**
 * proto/engine/normalize.js
 *
 * ★N-0b: diff 대상은 정규화 출력이다. 키 순서를 정렬해 diff가 삽입 순서 등
 * 우연한 차이에 흔들리지 않게 한다. 배열 순서는 의미(이벤트 seq·카드 나열
 * 순서 등)를 가지므로 건드리지 않는다.
 *
 * ★N-0a: 비결정 필드(타임스탬프·소요시간·절대경로·호스트 등)는 정규화 시 제거
 * 대상으로 선언한다. 엔진 이벤트 자체는 이런 필드를 만들지 않지만(decisionMs는
 * 뷰 A/UI 전용, 엔진 이벤트 스트림에 섞이지 않는다), 방어선으로 남겨둔다.
 */

const NON_DETERMINISTIC_KEYS = new Set(['decisionMs', 'timestamp', 'wallClockMs', 'hostId', 'pid', 'uiSeq']);

function stripNonDeterministic(value) {
  if (Array.isArray(value)) return value.map(stripNonDeterministic);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (NON_DETERMINISTIC_KEYS.has(k)) continue;
      out[k] = stripNonDeterministic(value[k]);
    }
    return out;
  }
  return value;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

function normalizeEvents(events) {
  return events.map((e) => sortKeysDeep(stripNonDeterministic(e)));
}

function normalizeToString(events) {
  return JSON.stringify(normalizeEvents(events));
}

/** 두 이벤트 로그를 정규화 후 비교. 다르면 첫 불일치 지점의 seq를 함께 반환(디버깅용). */
function diffEvents(eventsA, eventsB) {
  const na = normalizeEvents(eventsA);
  const nb = normalizeEvents(eventsB);
  const sa = JSON.stringify(na);
  const sb = JSON.stringify(nb);
  if (sa === sb) return { equal: true };
  const len = Math.min(na.length, nb.length);
  let firstDiffIndex = -1;
  for (let i = 0; i < len; i++) {
    if (JSON.stringify(na[i]) !== JSON.stringify(nb[i])) {
      firstDiffIndex = i;
      break;
    }
  }
  if (firstDiffIndex === -1) firstDiffIndex = len; // 길이 차이
  return {
    equal: false,
    firstDiffIndex,
    lengthA: na.length,
    lengthB: nb.length,
    eventA: na[firstDiffIndex] || null,
    eventB: nb[firstDiffIndex] || null,
  };
}

module.exports = { NON_DETERMINISTIC_KEYS, stripNonDeterministic, sortKeysDeep, normalizeEvents, normalizeToString, diffEvents };
