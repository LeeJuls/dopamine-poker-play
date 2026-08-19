'use strict';

/**
 * proto/engine/rng.js
 *
 * 시드 기반 결정론 PRNG. ★Math.random() 직접 호출 절대 금지 — 이 파일과
 * 이 파일이 만든 RngStream 인스턴스를 통해서만 난수를 소비한다.
 *
 * ★RNG 4스트림 분리(S1 게이트 ①): deck / status / policy / draft.
 * 각 스트림은 seedRoot로부터 결정론적으로 파생된 독립 시드를 갖는다 —
 * "정책만 바꿔도 딜 시퀀스가 불변"이려면 policy 스트림 소비가 deck 스트림에
 * 전혀 영향을 주지 않아야 한다(스트림 간 완전 격리).
 */

// FNV-1a 32bit 해시 — 문자열(스트림 이름) + 루트 시드로 스트림별 독립 시드를 파생한다.
function fnv1a(str, seed) {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ★D1(F14-24/F14-26) — 'crit' 스트림 신설(치명타 판정 전용). fnv1a(이름, root)로
// 독립 파생하므로 기존 4스트림의 파생 시드 자체는 안 움직인다 — 단 각 스트림의
// "소비량"은 그 스트림을 실제로 쓰는 코드가 달라지지 않는 한 별개로 불변이다.
// 치명타 판정을 status/policy/draft/deck 어디에도 얹지 않는다(§3 계약).
const STREAM_NAMES = ['deck', 'status', 'policy', 'draft', 'crit'];

/**
 * 단일 결정론 스트림. mulberry32 알고리즘 — 내부 상태를 인스턴스 필드(this.state)로
 * 들고 있어(클로저 아님) clone()이 값 복사만으로 완전 재현된다(조회 함수 순수성·
 * 상태 스냅샷/롤백에 필요).
 */
class RngStream {
  constructor(name, seed) {
    this.name = name;
    this.seed = seed >>> 0;
    this.state = this.seed;
    this.draws = 0; // 이 스트림이 소비된 횟수 — O-0 rng.drawsBefore/After의 근거
  }

  /** [0,1) 실수 1개 소비 */
  next() {
    this.draws++;
    let a = this.state;
    a = (a + 0x6d2b79f5) | 0;
    this.state = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0,n) 정수 1개 소비 */
  nextInt(n) {
    if (!(n > 0)) throw new Error('RngStream.nextInt requires n > 0, got ' + n);
    return Math.floor(this.next() * n);
  }

  /** [0,1) 확률 판정: p 미만이면 true */
  chance(p) {
    return this.next() < p;
  }

  /** 배열을 제자리에서 Fisher-Yates 셔플(각 스왑이 1드로우) */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** 배열에서 무작위 원소 1개를 뽑아 제거하고 반환 */
  pickAndRemove(arr) {
    const idx = this.nextInt(arr.length);
    const removed = arr.splice(idx, 1);
    return removed[0];
  }

  /** 배열에서 중복 없이 k개를 무작위로 뽑아 반환(원본 배열은 변경하지 않음) */
  sampleWithoutReplacement(arr, k) {
    const pool = arr.slice();
    const out = [];
    const n = Math.min(k, pool.length);
    for (let i = 0; i < n; i++) out.push(this.pickAndRemove(pool));
    return out;
  }

  clone() {
    const c = new RngStream(this.name, this.seed);
    c.state = this.state;
    c.draws = this.draws;
    return c;
  }

  toJSON() {
    return { name: this.name, seed: this.seed, state: this.state, draws: this.draws };
  }

  static fromJSON(json) {
    const c = new RngStream(json.name, json.seed);
    c.state = json.state;
    c.draws = json.draws;
    return c;
  }
}

/** seedRoot로부터 4개 독립 스트림을 생성한다. */
function createRngStreams(seedRoot) {
  const root = seedRoot >>> 0;
  const streams = {};
  for (const name of STREAM_NAMES) {
    streams[name] = new RngStream(name, fnv1a(name, root));
  }
  return streams;
}

function cloneStreams(streams) {
  const out = {};
  for (const name of STREAM_NAMES) out[name] = streams[name].clone();
  return out;
}

module.exports = {
  fnv1a,
  STREAM_NAMES,
  RngStream,
  createRngStreams,
  cloneStreams,
};
