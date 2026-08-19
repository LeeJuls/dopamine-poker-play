'use strict';

/**
 * proto/engine/cards.js
 *
 * 카드 모델·덱 구성. ★카드 논리 ID = `suit+rank+deckCopyIndex`.
 * 조커는 `suit=null, rank=null, copyIndex 0~3` — id는 `JOKER#k`
 * (qa-critic 관측요구서 O-0 N-0c와 정확히 일치시켜 분석기가 조커를
 * 특수 취급 없이 통과시킬 수 있게 한다).
 */

const SUITS = ['♠', '♥', '♦', '♣']; // ♠ ♥ ♦ ♣
const RANK_MIN = 2;
const RANK_MAX = 14; // 14 = A
const COPIES_PER_CARD = 4; // 52 × 4벌
const JOKER_COPIES = 4;
const DECK_SIZE = SUITS.length * (RANK_MAX - RANK_MIN + 1) * COPIES_PER_CARD + JOKER_COPIES; // 208 + 4 = 212

/**
 * ★구현 중 발견한 룰 구멍(보고 대상) — 논리 ID 스킴 `suit+rank+copyIndex`
 * (조커 `JOKER#k`)는 "한 벌의 212장 덱" 안에서는 유일하지만, §1-2(덱 소진 시
 * 남은 카드를 버리고 새 212장을 만든다 — "덱 재생성")가 반복되는 실제 게임에서는
 * **재생성마다 정확히 같은 id 문자열이 다시 나타난다.** 구세대 카드가 아직
 * 플레이어 손패/이월에 남아 있는 상태에서 신세대 덱이 도는 순간, 같은 id를
 * 가진 서로 다른 물리 카드 2장이 동시에 존재해 SUBMIT 등에서 "카드 1장을 2번
 * 선택"과 구분 불가능한 충돌이 생긴다(실측: L1 자가대전에서 실제로 발생 —
 * round 90대에서 SUBMIT id 중복 예외).
 * → deckGen(덱 세대 번호, 1부터 시작)을 id에 포함시켜 세대 간 유일성을 보장한다.
 * `suit+rank+copyIndex` 자체는 여전히 카드의 "종류+벌"을 그대로 나타내고,
 * deckGen만 seed마다/세대마다 달라지는 접미사다 — qa-critic N-0c의 `JOKER#k`
 * 예시와 완전히 어긋나지 않도록 세대 접미사는 `@g<N>` 형태로 덧붙인다.
 */
function cardId(suit, rank, copyIndex, deckGen) {
  const gen = deckGen === undefined ? 1 : deckGen;
  if (suit === null) return `JOKER#${copyIndex}@g${gen}`;
  return `${suit}${rank}#${copyIndex}@g${gen}`;
}

function makeCard(suit, rank, copyIndex, deckGen) {
  return {
    id: cardId(suit, rank, copyIndex, deckGen),
    suit, // null이면 조커
    rank, // null이면 조커
    copyIndex,
    deckGen: deckGen === undefined ? 1 : deckGen,
    isJoker: suit === null,
  };
}

/** 정렬을 위한 안정적 문자열 키(논리 ID 그 자체) */
function idSortKey(card) {
  return card.id;
}

function sortCardsById(cards) {
  return cards.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sortCardsByRankDesc(cards) {
  return cards.slice().sort((a, b) => b.rank - a.rank || idSortKey(a).localeCompare(idSortKey(b)));
}

/**
 * 신규 212장 덱(순서는 정렬된 canonical order — 셔플은 별도 rng 스트림이 담당).
 * deckGen: 이 덱 "세대" 번호(1부터) — id 유일성 보장에 필요(위 cardId 주석 참조).
 */
function buildFreshDeckCards(deckGen) {
  const gen = deckGen === undefined ? 1 : deckGen;
  const cards = [];
  for (const suit of SUITS) {
    for (let rank = RANK_MIN; rank <= RANK_MAX; rank++) {
      for (let c = 0; c < COPIES_PER_CARD; c++) {
        cards.push(makeCard(suit, rank, c, gen));
      }
    }
  }
  for (let c = 0; c < JOKER_COPIES; c++) {
    cards.push(makeCard(null, null, c, gen));
  }
  if (cards.length !== DECK_SIZE) {
    throw new Error(`buildFreshDeckCards invariant broken: expected ${DECK_SIZE}, got ${cards.length}`);
  }
  return cards;
}

/** 랭크를 사람이 읽는 문자로(디버그·UI 보조용, 룰 판정에는 쓰지 않음) */
function rankLabel(rank) {
  if (rank === 14) return 'A';
  if (rank === 13) return 'K';
  if (rank === 12) return 'Q';
  if (rank === 11) return 'J';
  return String(rank);
}

module.exports = {
  SUITS,
  RANK_MIN,
  RANK_MAX,
  COPIES_PER_CARD,
  JOKER_COPIES,
  DECK_SIZE,
  cardId,
  makeCard,
  idSortKey,
  sortCardsById,
  sortCardsByRankDesc,
  buildFreshDeckCards,
  rankLabel,
};
