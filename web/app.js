'use strict';

/**
 * proto/web/app.js
 *
 * ★핵심 원칙 — 룰을 재구현하지 않는다. 이 파일에서 족보 판정·SP 계산·데미지
 * 산식은 단 한 줄도 계산하지 않는다. 전부 Engine.*(proto/engine/의 실제 함수)
 * 호출 결과를 그대로 표시하거나, 엔진이 이미 이벤트에 실어준 값(bestEquivalent
 * 등)을 집계할 뿐이다.
 *
 * "기록=전송" 규율: 액션 객체는 각 지점에서 정확히 한 번만 만들고(buildXxxAction류
 * 함수), applyActionRaw()에만 넘긴다 — 로그(uiEvents)는 그 applyAction 호출이
 * 반환한 events를 그대로 누적할 뿐, 별도로 재구성하지 않는다.
 */

let Engine = null;

// ---- 게임 세션 상태 ---------------------------------------------------------
let G = null; // { state, uiEvents[], lastReadout, deferred:{A:Set,B:Set}, submittedCards:{A:{round,cards}|null,B:{round,cards}|null}(P1 라운드 태그, 2026-08-19), sessionExportCommitted }

// ★세션 범위 export 누적(오너 안내문 3차 재심사 지적 반영) — G는 판마다 그대로
// 재할당된다(게임 로직 무변경). 이 배열만 판 종료 시점(terminal 도달)에 그 판의
// exportReplay() 결과를 밀어넣어 페이지 새로고침 전까지 누적 보존한다. 항목은
// { game: N, export: {seed, config, actions, opts} } — g2FromExport.js는 각 항목의
// .export만 떼어 그대로 넣으면 된다(단일 게임 형식 그대로 유지, PM이 배열을 순회).
let sessionExports = [];

// ---- D2-C: Bo3 매치 세션 상태 ------------------------------------------------
// ★verifier 지적(이 작업의 이유) — "matchId/gameIndexInMatch가 proto/web/*의 어디에도
// 없다"를 닫는다. 정본: docs/design/전투설계_신룰정본_v0_DRAFT.md §6(매치 경계 표) ·
// proto/sim/match.js(정본 로직 — 아래 함수들은 그 파일을 "따라" 동형 재구현한 것이지
// require()로 끌어오지 않는다: match.js는 Node 전용 CommonJS로 collect.js를 require하고,
// engine-loader.js는 proto/engine/*.js만 로드하는 화이트리스트라 proto/sim/*는 브라우저에
// 구조적으로 로드되지 않는다 — 그래서 시드 파생·이월 추출·판정승 집계 3개 함수만
// 최소 재구현했다, 파일 스코프 "proto/web/** 단독" 준수).
// ★단판 모드(matchMode===false, 기존 G 단독 흐름)는 이 블록이 전혀 관여하지 않는다 —
// startNewGame()이 matchMode=false·M=null로 되돌리는 것이 유일한 접점이다.
let matchMode = false;
let M = null; // { matchId, matchSeed, gamesWon:{A,B}, gameIndex, carryOver, characters, hpOverride,
//                matchOver, matchWinner, games:[], pendingNext, prevGameSummary, transitionSnapshot }

let humanActor = 'A';
let aiActor = 'B';
let aiTier = 'L2';
let autoRunMode = false;
let currentLegal = null;
let phaseInputStartTs = 0;

// ★오너 모드(?owner=1) — URL 쿼리스트링으로만 켜진다. G2(제출≠손패최강) 관련
// 실시간/누적 UI 3종만 화면 표시에서 숨긴다 — 내부 계측(uiEvents·export)은
// 절대 건드리지 않는다(문서: strings.js 상단 주석). 기본값 false = 지금까지와 동일.
let ownerMode = false;

// SUBMIT/EXCHANGE 화면의 임시 선택 상태(사람 입력 전용)
let selectedDiscardIds = new Set();
let selectedSubmitIds = new Set();
let draftPendingPick = null;

// ---- C-1: 보유 카드 클릭 → 효과 상세(표시 전용, 판정 무관) --------------------
let cardDetailOpen = { self: null, opponent: null }; // panelKey별로 열려있는 카드타입(없으면 null)

// ---- R9-W: 상태이상·버프 배지 클릭 → 효과 상세(C-1과 동일 패턴의 구조화 레지스트리) ----
// panelKey별로 열려있는 EFFECT_BADGES[].key(없으면 null) — cardDetailOpen과 완전히 별개
// 상태(카드 상세와 효과 상세를 동시에 열어둘 수 있다, 서로 간섭하지 않는다).
let effectDetailOpen = { self: null, opponent: null };

// ---- C-3: 전투 결과(기본 1줄 + 펼침 분해) 펼침 상태 ---------------------------
let battleLogExpanded = new Set(); // key = String(ACTION_CHOICE 이벤트 seq)

// ---- W2-2: 조커 2장 제출 차단(UI 3중째) ---------------------------------------
// ★엔진 쪽 2중(handleSubmit 거부·getLegalActions의 jokerSubmitCap 메타)은 이미 있다.
// 여기서는 "이미 조커 1장을 선택한 상태에서 두 번째 조커를 누르면 선택되지 않고
// 메시지가 뜬다"만 담당 — 제출 선택 시점에만 걸리고 보유·이월·교환·교체는 절대
// 건드리지 않는다(과잉 차단 금지, 오너 확정).
let jokerCapBlocked = false;

// ---- W2-4: 캐릭터 스킬 "교체"(CHAR_SWAP) 폐기 카드 선택 상태 -------------------
// ★R2 정규 교환(selectedDiscardIds)과 완전히 분리된 별도 Set — 둘을 헷갈리게 하지 않는다.
let charSwapSelectedIds = new Set();

// ---- 캐릭터 선택(Setup 화면 → 엔진 opts.characters) --------------------------
// ★2026-08-16 — 게임 시작 전 강타/교체 중 하나를 고른다. 상대는 자동으로 반대.
// ★2026-08-17 정정 — 이 주석은 "저장만 되고 엔진에 전달되지 않는다"고 서술했으나
// R4-W2(W2-1)에서 실제로 배선됐다. startNewGame이 Engine.createEngine(seed, config,
// { characters })로 넘긴다(아래 참조). W5 검증의 실플레이 5판(강타 2·교체 3)이
// 좌석별 캐릭터 배정을 실증했다. ★SG-A(R4-W1b) — 캐릭터 축 값은
// 엔진 정본과 맞춰 SMASH/SWAP을 쓴다(구 STRIKE/EXCHANGE는 skillId 축 CHAR_SMASH/
// CHAR_SWAP과 이름이 달라 S.card[skillId] 조회가 조용히 실패했다 — resolveSkillInfo 참조).
let selectedCharacter = 'SMASH';
function characterOpposite(c) {
  return c === 'SMASH' ? 'SWAP' : 'SMASH';
}

/** ★SG-A 정본 대응표 — 캐릭터 축(SMASH/SWAP)↔skillId 축(CHAR_SMASH/CHAR_SWAP)의
 * 대응을 코드 전체에서 "이 객체 하나"로만 결정한다(F17-05 요구: 대응이 흩어지면
 * 조용히 실패하는 지점이 여러 곳에 생긴다). */
const CHAR_SKILL_ID_TO_CHARACTER_KEY = { CHAR_SMASH: 'SMASH', CHAR_SWAP: 'SWAP' };
/** ★P0-1 수정(2026-08-19) — 위 대응표의 역방향. renderCharacterSelectPanel이
 * resolveSkillInfo(skillId, ...)를 거치려면 캐릭터 선택 화면의 키(SMASH/SWAP)를
 * skillId(CHAR_SMASH/CHAR_SWAP)로 바꿀 방법이 필요했다 — 새 대응을 발명하지 않고
 * 이미 있는 CHAR_SKILL_ID_TO_CHARACTER_KEY를 그대로 뒤집는다(값 자체는 무변경). */
const CHARACTER_KEY_TO_SKILL_ID = { SMASH: 'CHAR_SMASH', SWAP: 'CHAR_SWAP' };

/** ★W-신규6(2026-08-17, web-engineer) — strings.js의 card.*.desc는 {placeholder}를
 * 쓰는 템플릿이다(R9-W의 effectInfo.descTemplate와 동일 문법). 이 맵이 cardId →
 * "G.state.config(current.json)에서 실제로 읽을 값들"의 유일한 대응표다 — A1/A2가
 * S5→W4에서 이미 한 번 겪은 "정적 텍스트가 튜닝값과 어긋난다" 문제의 재발 방지
 * (strings.js card 섹션 헤더 코멘트 참조). 값이 없는 카드(P1~P4 등)는 fillTemplate이
 * 빈 값 맵을 받아도 {placeholder}가 아예 없으므로 원문을 그대로 통과시킨다. */
const CARD_DESC_VALUES = {
  A1: (cfg) => ({
    damage: cfg.card.a1.damage,
    applyChance: Math.round(cfg.card.a1.applyChance * 100),
    burnDuration: cfg.status.burn.duration,
    lossChance: Math.round(cfg.status.burn.lossChance * 100),
  }),
  A2: (cfg) => ({ damage: cfg.card.a2.damage, exchangePenalty: cfg.status.freeze.exchangePenalty }),
  A3: (cfg) => ({ damage: cfg.card.a3.damage }),
  // ★PM 지시(2026-08-19, 보완 1건) — short가 형용사 대신 수를 노출하도록 P1/P2/P4에
  // 새로 항목을 연다(기존엔 desc에 {placeholder}가 없어 이 맵에도 없었다 — short가
  // 생기며 처음으로 수치가 필요해졌다). 값은 전부 current.json 그대로, 계산 없음.
  P1: (cfg) => ({ bonus: cfg.player.handCapP1Bonus, max: cfg.submit.max }),
  P2: (cfg) => ({ bonus: cfg.card.p2.exchangeBonus }),
  P4: (cfg) => ({ suitLevelBonus: cfg.card.p4.suitLevelBonus }),
  // ★D2 정정(⑥, P5 재정의 — strings.js card.P5 헤더 코멘트 참조) — 구 P5는 placeholder가
  // 없는 정적 카드였다(HP조건부 배수). 신 P5(치명타 확률 패시브)는 stackBonus 수치가
  // 있어 여기 추가한다 — 없으면 A1/A2가 이미 한 번 겪은 "정적 텍스트가 config와
  // 어긋난다" 문제가 P5에서도 재발한다.
  // ★PM 지시(보완 1건) — chancePct 신설: short가 "♦ 스택 +N"(내부 단위)이 아니라
  // "치명타 확률 +N%p"(결과 단위)를 보여주도록 stackBonus×crit.chancePerStack을
  // %p로 환산한다. ★이 환산은 config 상수끼리의 산술일 뿐 룰 재구현이 아니다(엔진의
  // EFFECT_BADGES CRIT_BUFF.templateValues가 이미 같은 산술 `chancePerStack*100`을
  // 쓴다 — 새 계산 패턴 아님). ★단 이 값은 "치명타 확률 상한(chanceCap)"에 걸리면
  // 실제 적용은 더 작을 수 있다 — 그 캡 도달 여부는 라운드별 실제 ♦ 스택(런타임 상태)에
  // 달려 있어 카드 설명 시점엔 결정론적으로 알 수 없으므로 여기서 캡까지 반영한
  // "최종 실효값"은 계산하지 않는다(desc가 캡 존재 자체는 이미 명시).
  P5: (cfg) => ({ stackBonus: cfg.card.p5.stackBonus, chancePct: Math.round(cfg.card.p5.stackBonus * cfg.crit.chancePerStack * 100) }),
  P6: (cfg) => ({ peekCount: cfg.card.p6.peekCount }),
  P7: (cfg) => ({ stackCapBonus: cfg.card.p7.stackCapBonus, stackCap: cfg.buff.stackCap }),
  A6: (cfg) => ({ recoverCount: cfg.card.a6.recoverCount }),
  A7: (cfg) => ({ forcedMin: cfg.card.a7.forcedMin, duration: cfg.card.a7.duration }),
  // ★PM 지시(보완 1건) — growthMultiplier 신설: short의 "두 배"를 하드코딩 리터럴이
  // 아니라 raiseSteps에서 산출한 실제 배율로 바꾼다(2^raiseSteps — raiseSteps가
  // 나중에 튜닝되면 "두 배" 문구가 조용히 거짓말이 될 뻔한 지점이었다).
  A8: (cfg) => ({ raiseSteps: cfg.card.a8.raiseSteps, growthMultiplier: Math.pow(2, cfg.card.a8.raiseSteps) }),
  // ★D2 신설 — A10(치명타 크기 액티브, strings.js card.A10 헤더 코멘트 참조). 누락 시
  // CARD_DRAW_PICK 제시 화면에 raw 'A10'만 뜨는 D5류 회귀였다.
  A10: (cfg) => ({ damage: cfg.card.a10.damage, critSizeBonus: cfg.crit.factor }),
  A9: (cfg) => ({ revealCount: cfg.card.a9.revealCount, revealRounds: cfg.card.a9.revealRounds }),
  // ★PM 지시(보완 1건) — A4는 팟 상태(런타임)에 따라 최종 가산이 달라져 "고정된 결과
  // 수치"를 보여줄 수 없다(현재 판돈 배율을 몰라서). 대신 config에서 결정론적으로
  // 나오는 유일한 수 — 한계율(판돈 배율 1당 추가 데미지 factor) — 를 노출한다.
  A4: (cfg) => ({ factor: cfg.a4.factor }),
};

/** ★PM 지시(2026-08-19, 보완 1건 — "강타 short에 수가 빠졌다") — 캐릭터 스킬용
 * CARD_DESC_VALUES 대응표. 강타(CHAR_SMASH)는 배율이 아니라 "배율 前 가산"이므로
 * short에서 "1.2배" 같은 배수 표기를 쓰면 거짓말이 된다(오너 예시 문구를 흉내 내려고
 * 사실을 왜곡하지 말 것 — PM 지시 원문) — 그래서 damage를 그대로 노출한다(가산값,
 * cfg.character.smash.damage). 교체(CHAR_SWAP)의 count는 cfg.character.swap.count —
 * resolveCharacterSwap(engine.js)이 실제로 읽는 "1~count장" 상한 그대로다. */
const CHAR_DESC_VALUES = {
  CHAR_SMASH: (cfg) => ({ damage: cfg.character.smash.damage }),
  CHAR_SWAP: (cfg) => ({ count: cfg.character.swap.count }),
};

/** ★SG-A/D5 — 스킬 이름+설명 조회를 한 곳으로 통일한다. 드래프트 액티브 스킬(A1~A4,
 * S.card 네임스페이스)과 캐릭터 기본 스킬(CHAR_SMASH/CHAR_SWAP, S.character 네임스페이스)
 * 둘 다 이 함수를 거친다 — `S.card[skillId]` 단독 조회는 캐릭터 스킬에 대해 항상
 * undefined라 조용히 실패한다(그 실패가 D5·SG-A의 원인이었다). 반환: {name,desc,short} 또는
 * 미등록이면 null.
 *
 * ★W-신규6 — 세 번째 인자 cfg(옵션, G.state.config)를 주면 desc의 {placeholder}를
 * CARD_DESC_VALUES로 채운 실값 문자열을 돌려준다(카드류에 한함 — 캐릭터 스킬은
 * 원래부터 템플릿이 없어 그대로 반환). cfg를 생략하면(예: skillLabel처럼 name만
 * 쓰는 호출부) 미채움 원본을 그대로 돌려준다 — name은 애초에 placeholder가 없어
 * 어느 쪽이든 동일하다(fillTemplate 자체를 호출하지 않아도 되는 순수 조회 경로 유지).
 *
 * ★short(2026-08-19, web-engineer, 오너 요청 "스킬 설명 직관화") — desc(명세 문장)와
 * 별도로 strings.js가 신설한 "플레이 중 읽는 한 줄" 필드. desc와 완전히 같은
 * valuesFn(cfg)로 채운다({placeholder} 키가 같으므로 재계산 없음, CARD_DESC_VALUES
 * 재사용) — raw.short가 없는 항목(구조적으로 전 카드·캐릭터에 이제 다 있지만 방어적으로)은
 * raw.desc로 폴백해 화면에 빈 문자열이 뜨는 사고를 막는다. */
function resolveSkillInfo(skillId, S, cfg) {
  if (S.card[skillId]) {
    const raw = S.card[skillId];
    if (!cfg) return raw;
    const valuesFn = CARD_DESC_VALUES[skillId];
    const values = valuesFn ? valuesFn(cfg) : {};
    return { name: raw.name, desc: fillTemplate(raw.desc, values), short: fillTemplate(raw.short || raw.desc, values) };
  }
  const charKey = CHAR_SKILL_ID_TO_CHARACTER_KEY[skillId];
  if (charKey && S.character[charKey]) {
    const raw = S.character[charKey];
    if (!cfg) return raw;
    // ★PM 지시(2026-08-19, 보완 1건) — 캐릭터 스킬도 카드와 동일하게 CHAR_DESC_VALUES로
    // {placeholder}를 채운다. desc는 현재 placeholder가 없어(정적 문장) fillTemplate이
    // 그대로 통과시키고, short만 실제로 채워진다.
    const valuesFn = CHAR_DESC_VALUES[skillId];
    const values = valuesFn ? valuesFn(cfg) : {};
    return { name: raw.name, desc: fillTemplate(raw.desc, values), short: fillTemplate(raw.short || raw.desc, values) };
  }
  return null;
}

/** ★D5 — 미등록 skillId도 영문 enum을 그대로 내보내지 않고 strings.js 폴백을 쓴다. */
function skillLabel(skillId, S) {
  const info = resolveSkillInfo(skillId, S);
  return (info && info.name) || S.battle.unknownLabel;
}

/**
 * ★버그 수정(2026-08-19, web-engineer) — 승자/패자 판별 전용 헬퍼. PM 지시대로
 * "화면이 이미 소비 중인 ROUND_RESULT"(absorbEventForDisplay가 채우는
 * G.lastReadout.result — 위 ROUND_RESULT 분기 참조)에서 그대로 읽는다. 새 판정
 * 로직이 아니다 — 엔진이 이미 확정해 이벤트에 실어준 winner를 비교만 한다.
 * ★false를 반환하는 두 경우 다 안전한 기본값이다: ①무승부(winner=null) — 그 라운드는
 * 애초에 판돈 소진(승자 공격 전용 규칙)이 일어나지 않는다 ②아직 그 라운드가
 * 판정되지 않은 시점(G.lastReadout이 비었거나 이전 라운드 것) — 이 카드를 "지금"
 * 실제로 썼을 때 누가 승자일지 알 수 없으므로 기존 패자용 공식(현재 판돈값 기준,
 * 리셋 가정 없음)이 왜곡 없는 기본값이다.
 */
function isCurrentRoundWinner(actor) {
  return !!(G && G.lastReadout && G.lastReadout.result && G.lastReadout.result.winner === actor);
}

/**
 * ★verifier P0-2 FAIL 수정(2026-08-19) — P5/A8의 short가 상한(clamp)을 지나는데도
 * config만으로 고정된 수(P5 "10%p", A8 "2배")를 항상 보여줬다. verifier가 ♦ 실스택이
 * 이미 상한인 상태에서 P5를 드래프트해 실제 이득 0%p를 재현했는데 화면은 "10%p
 * 오름"을 그대로 냈다 — 이 함수가 그 틈을 닫는다.
 *
 * ★계산은 손으로 새 규칙을 만드는 게 아니라 engine.js가 이미 쓰는 두 함수를 좌표까지
 * 명시해 그대로 거울처럼 옮긴 것이다(같은 입력 field·같은 연산, 새 판정 로직 없음):
 *   - P5: engine.js:349-351 effectiveStackCap(player,cfg) = cfg.buff.stackCap +
 *     countCard(player,'P7')×cfg.card.p7.stackCapBonus. engine.js:686-696
 *     effectiveDiamondStack = min(실스택 + P5보유장수×stackBonus, 위 상한).
 *     ★app.js는 player 객체(엔진 내부 상태)에 접근할 수 없으므로 getPublicView가
 *     이미 공개한 대응 필드(view.self.cards/opp.cards → P7·P5 보유 장수 카운트,
 *     view.self.buffStacks['♦']/opp.buffStacks['♦'] → 실스택)로 같은 산술을 한다.
 *   - A8(패자 분기·무변경): engine.js:763-779 applyA8PotRaise = min(potBefore×2^
 *     raiseSteps, pot.cap). app.js는 view.shared.pot.value(=potBefore, 패자는 공격
 *     전 소진이 없어 이 값이 곧 raise의 실제 기저다)로 같은 산술을 비율로 환산한다.
 *   - A8(승자 분기·2026-08-19 신규): 승자는 resolveActiveSkill의 A8 분기가
 *     resolveDamage(role='winner')를 먼저 태우고, 그 안에서
 *     settlePotAfterWinnerAttack(engine.js:730-738)이 판돈을 즉시 cfg.pot.base까지
 *     소진한 뒤에야 applyA8PotRaise(engine.js:763-779)가 그 "소진된" base 위에서
 *     다음 라운드용 판돈을 새로 심는다(카드 설계 정본 S9_신규카드_6종설계.md
 *     §2-A8·§4-3 "A8→A4 2라운드 콤보" — 이번 공격 강화가 아니라 2라운드짜리 콤보
 *     카드). ★guard_screen_formula_parity.js가 신설 첫 실행에서 이 불일치를 실제로
 *     잡았다(구 코드는 리셋 前 potValue를 raise 기저로 오인) — director 판정: "엔진이
 *     옳다, 화면이 틀렸다." raise 기저는 getPublicView가 이미 노출한
 *     shared.pot.base(=cfg.pot.base, 소진 후 고정값)를 그대로 쓴다(새 계산 아님,
 *     engine.js:2798 getPublicView 확인). 이번 공격 자체엔 소진 前 현재 판돈
 *     배율(runtimeCtx.potValue)이 그대로 적용된다(engine.js:1093
 *     potMultiplier=state.pot.value — A8은 potMultiplierOverride를 안 씀).
 *
 * runtimeCtx = { cardTypes: string[](그 화면 주체가 보유한 카드 타입 배열, P7/P5
 * 카운팅용), diamondStack: number(그 주체의 실제 ♦ 스택), potValue: number(공유 팟
 * 현재값 — self/opp 무관 동일), isWinner: boolean(2026-08-19 신규 — A8 전용, 그
 * 주체가 "지금" 라운드의 승자인지. isCurrentRoundWinner(actor)로 채운다 —
 * G.lastReadout.result(ROUND_RESULT)에서 얻고 새로 계산하지 않는다. P5는 이 필드를
 * 쓰지 않는다) }.
 * mode: 'held'(이미 보유 — 보유분 전체가 지금 실제로 기여하는 양) |
 *       'offer'(아직 미보유 — 지금 이 1장을 더 고르면 붙는 한계 이득).
 * ★캡에 걸려 실제 이득이 0이면 형용사로 얼버무리지 않고 S.card.*.shortAtCap(정직한
 * "지금은 상한이라 효과 없음" 문구)로 바꿔치기한다(PM 지시 원문 그대로).
 */
function applyRuntimeShortOverride(ct, info, cfg, runtimeCtx, S, mode) {
  if (!info || !runtimeCtx) return info;
  if (ct === 'P5') {
    const p7Count = runtimeCtx.cardTypes.filter((c) => c === 'P7').length;
    const effCap = cfg.buff.stackCap + p7Count * cfg.card.p7.stackCapBonus; // engine.js:349-351 동형
    const stackBonus = cfg.card.p5.stackBonus;
    const realStack = runtimeCtx.diamondStack;
    let before, after;
    if (mode === 'held') {
      const p5Count = runtimeCtx.cardTypes.filter((c) => c === 'P5').length;
      before = realStack;
      after = realStack + p5Count * stackBonus;
    } else {
      const existingP5Count = runtimeCtx.cardTypes.filter((c) => c === 'P5').length;
      before = realStack + existingP5Count * stackBonus;
      after = before + stackBonus;
    }
    const gainStacks = Math.max(0, Math.min(after, effCap) - Math.min(before, effCap)); // engine.js:686-696 동형(min 클램프)
    const gainPct = Math.round(gainStacks * cfg.crit.chancePerStack * 100);
    const short = gainPct > 0 ? fillTemplate(S.card.P5.short, { chancePct: gainPct }) : S.card.P5.shortAtCap;
    return { ...info, short };
  }
  if (ct === 'A8') {
    // ★버그 수정(2026-08-19) — 승자 분기 신규. 위 함수 헤더 주석 "A8(승자 분기)" 참조.
    if (runtimeCtx.isWinner) {
      const currentMultiplier = runtimeCtx.potValue; // 소진 前 — 이번 공격에 그대로 적용되는 배율
      const potBaseAfterConsume = cfg.pot.base; // 승자 공격 공통 규칙으로 소진된 뒤의 기저(= shared.pot.base)
      const rawAfter = potBaseAfterConsume * Math.pow(2, cfg.card.a8.raiseSteps);
      const nextPot = Math.min(rawAfter, cfg.pot.cap); // engine.js:763-779 동형(min 클램프)
      const values = { currentMultiplier: fmtNum(currentMultiplier), nextPot: fmtNum(nextPot) };
      const short = nextPot > potBaseAfterConsume ? fillTemplate(S.card.A8.shortWinner, values) : fillTemplate(S.card.A8.shortWinnerAtCap, values);
      return { ...info, short };
    }
    // 패자(또는 승패 미확정) 분기 — 무변경(가드 PASS 확인된 기존 로직 그대로).
    const potBefore = runtimeCtx.potValue;
    const rawAfter = potBefore * Math.pow(2, cfg.card.a8.raiseSteps);
    const cappedAfter = Math.min(rawAfter, cfg.pot.cap); // engine.js:763-779 동형(min 클램프)
    const ratio = potBefore > 0 ? cappedAfter / potBefore : 1;
    const short = ratio > 1 ? fillTemplate(S.card.A8.short, { growthMultiplier: fmtNum(ratio) }) : S.card.A8.shortAtCap;
    return { ...info, short };
  }
  return info;
}

// ---- 부트스트랩 -------------------------------------------------------------
async function boot() {
  ownerMode = new URLSearchParams(location.search).get('owner') === '1'; // ★표시 전용 스위치 — 판정/계측 로직에는 무영향
  applyStaticStrings();
  applyOwnerModeVisibility(); // ★오너 모드: 자동 진행 체크박스+힌트를 화면에서 완전히 숨김(기능 자체는 무변경)
  wireSetupControls();
  wireCardDetailDelegation(); // C-1
  wireEffectDetailDelegation(); // R9-W
  wireBattleLogDelegation(); // C-3
  wireCharacterSelectDelegation(); // 캐릭터 선택 골격
  renderCharacterSelectPanel(); // 게임 시작 전에도 항상 보여야 하므로 부트 시점에 1회 렌더
  try {
    Engine = await window.EngineLoader.loadAll();
    console.log('[web-engineer] 엔진 로드 완료 — AI_POLICY_IDS:', Engine.AI_POLICY_IDS);
    // ★P0-1 수정 — 부트 시점 1차 렌더(위)는 cfg 없이 desc로 그렸다. 엔진 로드가
    // 끝난 지금 cfg(Engine.DEFAULT_CONFIG)가 생겼으니 즉시 다시 그려 short로 갱신한다.
    renderCharacterSelectPanel();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('action-panel');
    el.textContent = window.STR.errors.engineLoadFailed + ': ' + err.message;
    return;
  }
  document.getElementById('btn-newgame').disabled = false;
  document.getElementById('btn-newmatch').disabled = false; // ★D2-C
  // ★R7-W — HP 입력칸의 초기값은 엔진 기본 config(Engine.DEFAULT_CONFIG.player.maxHp)에서
  // 읽는다(하드코딩 금지). 엔진 로드 전에는 이 값을 알 수 없어 입력칸을 비워두고,
  // 로드가 끝난 지금 이 시점에 채운다 — "기본값" 버튼도 같은 값을 쓴다(applyDefaultHp).
  document.getElementById('in-hp-self').value = Engine.DEFAULT_CONFIG.player.maxHp;
  document.getElementById('in-hp-opponent').value = Engine.DEFAULT_CONFIG.player.maxHp;
  document.getElementById('btn-hp-default').disabled = false;
  updateHpStatusHint();
  renderIdle();
}

function applyStaticStrings() {
  const S = window.STR;
  document.getElementById('app-title').textContent = S.app.title;
  document.getElementById('lbl-seed').textContent = S.app.seedLabel;
  document.getElementById('lbl-difficulty').textContent = S.app.difficultyLabel;
  document.getElementById('lbl-hp-self').textContent = S.app.hpSelfLabel; // ★R7-W
  document.getElementById('lbl-hp-opponent').textContent = S.app.hpOpponentLabel; // ★R7-W
  document.getElementById('btn-hp-default').textContent = S.app.hpDefaultButton; // ★R7-W
  document.getElementById('lbl-autorun').textContent = S.app.autoRunLabel;
  document.getElementById('autorun-hint').textContent = S.app.autoRunHint;
  document.getElementById('btn-newgame').textContent = S.app.newGame;
  document.getElementById('btn-newmatch').textContent = S.app.newMatch; // ★D2-C
  document.getElementById('mode-hint').textContent = S.app.modeHint; // ★D2-C
  document.getElementById('match-panel-title').textContent = S.match.panelTitle; // ★D2-C
  document.getElementById('export-title').textContent = S.app.exportLabel;
  document.getElementById('btn-export').textContent = S.app.exportButton;
  document.getElementById('btn-selfcheck').textContent = S.app.selfcheckButton;
  document.getElementById('instrument-title').textContent = S.summary.instrumentTitle;
  document.getElementById('battle-log-title').textContent = S.battle.title; // C-3
  document.getElementById('character-select-title').textContent = S.character.title;
  document.getElementById('character-select-desc').textContent = S.character.desc;

  const diffSel = document.getElementById('in-difficulty');
  diffSel.options[0].textContent = S.tier.L1;
  diffSel.options[1].textContent = S.tier.L2;
  diffSel.options[2].textContent = S.tier.L3;
}

/** ★오너 모드에서 "자동 진행" 체크박스+툴팁(autorun-hint)을 화면에서 완전히 숨긴다
 * (요소 자체를 렌더하지 않음). hidden 프로퍼티만으로는 부족하다 — style.css의
 * `#setup-panel label { display:flex }`가 id+type 선택자로 걸려 있어, 오리진 우선순위상
 * author 스타일이 UA stylesheet의 `[hidden]{display:none}`을 이긴다(실측 확인:
 * hidden=true인데도 getComputedStyle().display==='flex'로 남음). 그래서 인라인
 * style.display='none'까지 같이 건다(인라인 스타일이 선택자 기반 author 규칙을 이김).
 * 일반 모드(쿼리파라미터 없음)에서는 이 함수가 아무것도 하지 않아 기존과 완전히 동일하다
 * (회귀 없음). autoRunMode 로직·이벤트 리스너 자체는 그대로 남아있다 — 화면 노출만 막는다
 * (엔진/판정 로직 무변경 원칙 준수). */
function applyOwnerModeVisibility() {
  if (!ownerMode) return;
  const autorunCheckboxLabel = document.getElementById('in-autorun').closest('label');
  if (autorunCheckboxLabel) {
    autorunCheckboxLabel.hidden = true;
    autorunCheckboxLabel.style.display = 'none';
  }
  const hint = document.getElementById('autorun-hint');
  hint.hidden = true;
  hint.style.display = 'none';
}

function wireSetupControls() {
  document.getElementById('btn-newgame').disabled = true;
  document.getElementById('btn-newmatch').disabled = true; // ★D2-C — 엔진 로드 전에는 매치도 시작 불가(boot()에서 함께 해제)
  document.getElementById('btn-newgame').addEventListener('click', () => {
    const seed = Number(document.getElementById('in-seed').value || 1);
    aiTier = document.getElementById('in-difficulty').value;
    autoRunMode = document.getElementById('in-autorun').checked;
    // ★캐릭터 선택 — 상대는 항상 반대 캐릭터. startNewGame이 엔진 opts.characters로 넘긴다.
    const characterChoice = { A: selectedCharacter, B: characterOpposite(selectedCharacter) };

    // ★R7-W — 입력값 검증(양수 정수만). 잘못됐으면 시작을 막는다(strings.js 키 메시지).
    // ★★대회 치명 버그 수정 — alert() 대신 setup-error-hint 인라인 표시(문구 무변경).
    const hpSelf = parseHpInput('in-hp-self');
    const hpOpponent = parseHpInput('in-hp-opponent');
    if (hpSelf === null || hpOpponent === null) {
      showSetupError(window.STR.errors.invalidHp);
      return;
    }
    clearSetupError();
    const hpOverride = buildHpOverride(hpSelf, hpOpponent);
    startNewGame(seed, characterChoice, hpOverride);
  });
  // ★D2-C — "새 매치 시작"(Bo3). 입력칸(시드·난이도·자동진행·HP·캐릭터)은 "새 판 시작"과
  // 완전히 동일하게 재사용한다(신규 입력 UI 없음 — 시드 입력칸이 매치 모드에서는
  // matchSeed로 해석될 뿐, mode-hint가 그 이중 용도를 안내한다).
  document.getElementById('btn-newmatch').addEventListener('click', () => {
    const matchSeed = Number(document.getElementById('in-seed').value || 1);
    aiTier = document.getElementById('in-difficulty').value;
    autoRunMode = document.getElementById('in-autorun').checked;
    const characterChoice = { A: selectedCharacter, B: characterOpposite(selectedCharacter) };
    const hpSelf = parseHpInput('in-hp-self');
    const hpOpponent = parseHpInput('in-hp-opponent');
    if (hpSelf === null || hpOpponent === null) {
      showSetupError(window.STR.errors.invalidHp);
      return;
    }
    clearSetupError();
    const hpOverride = buildHpOverride(hpSelf, hpOpponent);
    startNewMatch(matchSeed, characterChoice, hpOverride);
  });
  document.getElementById('in-autorun').addEventListener('change', (e) => {
    autoRunMode = e.target.checked;
    if (G && !G.state.terminal) runLoop();
  });
  document.getElementById('in-difficulty').addEventListener('change', (e) => {
    aiTier = e.target.value; // ★선택값이 실제로 엔진 decide() tier 인자로 전달된다(게이트⑤)
  });
  // ★R7-W — HP 입력칸: 값이 바뀔 때마다 "기본값과 같은지" 표시만 갱신(판정 로직 없음).
  document.getElementById('in-hp-self').addEventListener('input', updateHpStatusHint);
  document.getElementById('in-hp-opponent').addEventListener('input', updateHpStatusHint);
  document.getElementById('btn-hp-default').addEventListener('click', () => {
    // ★800을 여기서 하드코딩하지 않는다 — Engine.DEFAULT_CONFIG.player.maxHp(엔진 정본)을 그대로 읽는다.
    const def = Engine.DEFAULT_CONFIG.player.maxHp;
    document.getElementById('in-hp-self').value = def;
    document.getElementById('in-hp-opponent').value = def;
    updateHpStatusHint();
  });
  document.getElementById('btn-export').addEventListener('click', renderExportBlock);
  document.getElementById('btn-selfcheck').addEventListener('click', runSelfCheck);
}

/** ★R7-W — HP 입력값 파싱+검증(양수 정수만). 실패 시 null(호출부가 시작을 막는다). */
function parseHpInput(id) {
  const raw = document.getElementById(id).value;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** ★R7-W — 입력값이 엔진 기본값(Engine.DEFAULT_CONFIG.player.maxHp)과 같으면 null을 실어
 * 넘긴다(=오버라이드 아님). Engine.createEngine 계약(②기본값 복원: 필드 자체 생략 또는
 * null)을 그대로 따른다 — "800을 다시 800으로 입력"과 "기본값 복원 버튼"이 결과적으로
 * 완전히 동일하게 취급돼야, export의 maxHpOverridden 플래그가 실제로 값이 바뀐 판만
 * 정확히 표시한다(숫자가 같은데도 오버라이드로 잘못 표시되면 F17-05류 문제가 재발한다). */
function buildHpOverride(hpSelf, hpOpponent) {
  const def = Engine.DEFAULT_CONFIG.player.maxHp;
  return {
    maxHpA: hpSelf === def ? null : hpSelf,
    maxHpB: hpOpponent === def ? null : hpOpponent,
  };
}

/** ★R7-W — 오너가 "지금 값이 기본값인지"를 화면에서 바로 알 수 있게(과잉 경고 없이,
 * 평이한 문구만). 엔진 로드 전(Engine===null)에는 판단할 기준이 없어 아무것도 하지 않는다. */
function updateHpStatusHint() {
  if (!Engine) return;
  const S = window.STR;
  const def = Engine.DEFAULT_CONFIG.player.maxHp;
  const selfVal = Number(document.getElementById('in-hp-self').value);
  const oppVal = Number(document.getElementById('in-hp-opponent').value);
  const isDefault = selfVal === def && oppVal === def;
  document.getElementById('hp-status-hint').textContent = isDefault ? S.app.hpStatusDefault : S.app.hpStatusCustom;
}

function renderIdle() {
  document.getElementById('action-panel').textContent = '';
  document.getElementById('status-bar').textContent = '';
}

// ---- 캐릭터 선택 UI(엔진 배선 완료 — 위 startNewGame 참조) --------------------
/** ★게임 시작 전(그리고 언제든) 항상 조작 가능 — G(게임 세션) 유무와 무관하게 동작한다.
 * ★와일드 배정 표시(조커→구체 카드 배정 결과)는 여기서 절대 다루지 않는다 — 그건
 * R4-W2(rule-engineer 인계)에서 "제출 확정 후에만" 노출해야 하는 별개 항목이다
 * (qa-critic 지적 — 제출 전 프리뷰에 배정이 뜨면 최강패 힌트가 된다). */
/** ★verifier P0-1 FAIL 수정(2026-08-19) — 이 함수가 resolveSkillInfo()를 거치지
 * 않고 `S.character[key]`를 그대로 읽어 short의 {damage}/{count}가 화면에 미채움
 * 리터럴로 떴다(desc는 placeholder가 없어 무해했지만 short는 다르다). 두 지점 모두
 * 고쳐야 한다:
 *   ① 부트 시점(boot()가 Engine 로드 전에 1회 호출) — 이때 cfg 자체가 없다.
 *   ② 캐릭터 클릭 후 재렌더(wireCharacterSelectDelegation) — cfg 인자를 아예 안 썼다.
 * ★수정: cfg를 매 호출마다 `Engine`(전역, 로드 전이면 null)에서 다시 구한다
 * (Engine.DEFAULT_CONFIG — R7-W가 HP 기본값에 이미 쓰던 같은 소스, G.state.config는
 * 게임 시작 전이라 존재하지 않는다). ★cfg가 없으면(엔진 로드 전) short 대신
 * desc(placeholder 없는 원문 — 무해)로 폴백한다 — {damage}가 뜨는 경로를 원천 차단.
 * boot()가 Engine 로드 직후 이 함수를 다시 호출해(아래 boot() 참조) cfg가 준비되는
 * 즉시(체감상 거의 동시) short로 갱신된다. */
function renderCharacterSelectPanel() {
  const S = window.STR;
  const box = document.getElementById('character-select-buttons');
  const opts = ['SMASH', 'SWAP'];
  const cfg = Engine ? Engine.DEFAULT_CONFIG : null;
  box.innerHTML = opts
    .map((key) => {
      const info = resolveSkillInfo(CHARACTER_KEY_TO_SKILL_ID[key], S, cfg) || S.character[key];
      const shortOrSafeDesc = cfg ? info.short : info.desc; // ★cfg 없으면 desc로(placeholder 無, 안전)
      const selected = selectedCharacter === key;
      return `<button type="button" class="character-card${selected ? ' selected' : ''}" data-character="${key}">
        <div class="character-card-name">${info.name}</div>
        <div class="character-card-desc">${shortOrSafeDesc}</div>
        ${selected ? `<div class="character-card-tag">${S.character.selectedNote}</div>` : ''}
      </button>`;
    })
    .join('');
  const opp = characterOpposite(selectedCharacter);
  document.getElementById('character-select-opponent-note').textContent = `${S.panel.opponent}: ${S.character[opp].name}`;
}

function wireCharacterSelectDelegation() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.character-card[data-character]');
    if (!btn) return;
    selectedCharacter = btn.dataset.character;
    renderCharacterSelectPanel();
  });
}

// ---- 새 판 시작 --------------------------------------------------------------
// ★D2(③ 구 배수 잔재 정리) — D1이 남겨둔 multiplierMode 인자를 여기서 마저 걷어낸다.
// 구 multiplier.mode(가/다 배수 모드)는 engine.js KNOWN_INCOMPATIBLE_CONFIG_PATHS에
// 올라 있다(§3 "구 export 명시적 비호환") — D1이 applyMultiplierTrigger 자체를
// 폐지해 이 개념에 대응하는 신 키가 없다("구 applyMultiplierTrigger(EXACT_TIE/CONTEST
// 배수 트리거) 폐지"). userConfig에 multiplier를 싣지 않던 동작은 그대로 유지하되,
// 이제 그 값을 애초에 받지도 않는다(무엇을 골라도 결과가 같은 죽은 드롭다운을
// index.html/strings.js에서 함께 제거 — 실측 재세션 중 오너를 오도할 위험 차단).
/** ★D2-C(리팩터, 행동 무변경) — 기존 startNewGame() 본문 중 "state/events → G 세션
 * 객체 조립" 부분을 그대로 뽑아낸 헬퍼. Bo3 매치 흐름(startGameInMatch)도 판마다
 * 같은 조립이 필요해서 공유한다 — 로직 한 글자도 안 바뀜(순수 추출), 단판 동작은
 * 100% 동일하게 유지된다. engineOpts는 Engine.createEngine의 세 번째 인자 그대로
 * (characters 필수, matchId/gameIndexInMatch/matchCarryOver는 매치 모드에서만 추가).
 */
function buildGameSession(seed, userConfig, engineOpts) {
  const { state, events } = Engine.createEngine(seed >>> 0, userConfig, engineOpts);
  // ★R7-W — GAME_START.maxHpOverridden을 판 시작 시점에 그대로 꺼내 G에 보관한다(엔진
  // 산출물은 그대로 두고, UI 쪽 상태에만 형제 필드로 들고 있다가 export에 실을 때 쓴다).
  const gameStartEvent = events.find((e) => e.type === 'GAME_START');
  return {
    state,
    uiEvents: events.slice(),
    lastReadout: null,
    deferred: { A: new Set(), B: new Set() },
    submittedCards: { A: null, B: null },
    sessionExportCommitted: false, // ★이 판의 export가 sessionExports에 이미 반영됐는지(중복 push 방지)
    characterSelection: engineOpts.characters,
    submitToggleCounts: {}, // ★D7 — 라운드별 제출 카드 선택 토글 횟수(표시 안 함, export 전용)
    maxHpOverridden: gameStartEvent ? gameStartEvent.maxHpOverridden : { A: false, B: false }, // ★R7-W
    matchGameRecorded: false, // ★D2-C — 이 판의 매치 집계(recordMatchGameEndIfNeeded)가 이미 반영됐는지(단판 모드에서는 참조 안 됨)
  };
}

/** ★D2-C(리팩터, 행동 무변경) — 새 판마다 리셋해야 하는 "판 전용 UI 토글 상태"(엔진
 * 상태가 아니라 순수 표시 상태) 초기화. 단판·매치 판 전환 양쪽에서 동일하게 필요하다. */
function resetUiTransientState() {
  cardDetailOpen = { self: null, opponent: null }; // C-1
  effectDetailOpen = { self: null, opponent: null }; // R9-W
  battleLogExpanded = new Set(); // C-3
  jokerCapBlocked = false; // ★W2-2
  charSwapSelectedIds = new Set(); // ★W2-4
}

function startNewGame(seed, characterChoice, hpOverride) {
  // ★D2-C(④ 단판 모드 보존) — 매치 세션이 남아 있으면 화면에서 완전히 걷어낸다. 이
  // 함수 자체(엔진 호출·G 조립)는 이 두 줄 추가를 제외하면 매치 기능 도입 전과 100%
  // 동일하다 — D3 프로브·기존 검증이 이 경로에 그대로 의존한다.
  matchMode = false;
  M = null;
  document.getElementById('match-panel').hidden = true;

  const userConfig = {};
  // ★R7-W — 좌석별 HP 오버라이드(둘 다 null이면 엔진 기본값 그대로 — buildHpOverride 참조).
  if (hpOverride) {
    userConfig.player = { maxHpA: hpOverride.maxHpA, maxHpB: hpOverride.maxHpB };
  }
  // ★W2-1 — 캐릭터 선택을 실제로 엔진에 전달한다(이전까지는 G.characterSelection에
  // 저장만 되고 opts.characters로 안 넘어갔다). 엔진의 resolveCharacters()가 A/B가
  // 서로 반대인지 검증하므로, characterOpposite()로 이미 반대로 맞춰 넘긴다.
  const characters = characterChoice || { A: 'SMASH', B: 'SWAP' };
  G = buildGameSession(seed, userConfig, { characters });
  resetUiTransientState();
  document.getElementById('summary-panel').hidden = true;
  document.getElementById('selfcheck-result').textContent = '';
  // ★export-block은 여기서 지우지 않는다 — sessionExports(세션 누적 배열)는 새 판 시작으로
  // 초기화되지 않으므로, 화면 표시도 지울 이유가 없다(다음 "내보내기 갱신" 클릭 시 최신 상태로 갱신됨).
  runLoop();
}

// ---- D2-C: Bo3 매치 오케스트레이션 -------------------------------------------
/**
 * ★시드 파생 — proto/sim/match.js의 deriveGameSeed와 동형(byte-identical 산식) 재구현.
 * ★★그 파일 헤더 주석의 오프셋 수정 이력을 그대로 따른다 — 최초 구현은 104729(1만번째
 * 소수) 오프셋을 썼다가, matchSeed가 탐색 대역(2,000,000~2,999,999) 상단 근처일 때
 * 판2/3 시드가 확정 대역 인접의 금지 대역(3,000,000번대)으로 튈 수 있음을 실측으로
 * 발견해 오프셋을 97(작은 소수)로 줄였다 — createRngStreams(rng.js)가 seedRoot를 매
 * 스트림마다 avalanche 해시(fnv1a)하므로 오프셋 크기 자체는 스트림 독립성에 영향이
 * 없다(오프셋을 키울 실익이 없다). 발주서 지시대로 이 값을 새로 만들지 않고 그대로
 * 가져왔다 — match.js를 import하지 않으므로(위 헤더 주석 근거) 산식만 복제, 로직 자체는
 * 이 한 줄이 전부라 "재구현"이 곧 "복붙 없는 준수"다.
 */
function deriveGameSeedForMatch(matchSeed, gameIndexInMatch) {
  return ((matchSeed >>> 0) + (gameIndexInMatch - 1) * 97) >>> 0;
}

/** ★match.js extractCarryOver와 동형 — §6-1 이월 대상 정확히 둘(빌드 카드 + 도파민 카드
 * 풀)만 뽑는다. pool은 state.draft.pool이 아니라 Engine.eligibleDrawTypes(라이브 권위,
 * match.js 헤더 주석 "새로 발견한 것" 그대로 재사용 — state.draft.pool은 G-A-10 이후
 * 죽은 필드라 여기서도 참조하지 않는다). */
function extractCarryOverForMatch(finalState) {
  return {
    build: { A: finalState.players.A.cards.slice(), B: finalState.players.B.cards.slice() },
    pool: Engine.eligibleDrawTypes(finalState),
  };
}

/** ★D2-C① — "새 매치 시작" 버튼 핸들러가 부르는 진입점. 캐릭터는 매치당 1회만 여기서
 * 확정하고(§6-4) M.characters에 고정 — 판마다 다시 묻지 않는다(startGameInMatch가 매
 * 판 M.characters를 그대로 재사용). HP 오버라이드도 매치 전체에 동일하게 적용(오너가
 * 검증 속도를 위해 쓰는 손잡이 — 판마다 다시 물을 이유가 없다). */
function startNewMatch(matchSeed, characterChoice, hpOverride) {
  matchMode = true;
  M = {
    matchId: `match${matchSeed >>> 0}`, // ★match.js playMatch 기본 matchId 형식과 동일
    matchSeed: matchSeed >>> 0,
    gamesWon: { A: 0, B: 0 },
    gameIndex: 1,
    carryOver: null, // 판1은 이월 없음(match.js와 동일 — spec.carryOver===null이면 opts.matchCarryOver 자체를 안 넘긴다)
    characters: characterChoice || { A: 'SMASH', B: 'SWAP' }, // ★§6-4 — 매치 전체 고정
    hpOverride: hpOverride || null,
    matchOver: false,
    matchWinner: null,
    games: [], // {gameIndexInMatch, seed, winner, terminalReason, rounds, hpFinal, hardCapWinnerChain}
    pendingNext: false,
    prevGameSummary: null,
    transitionSnapshot: null,
  };
  document.getElementById('match-panel').hidden = false;
  startGameInMatch();
}

/** ★D2-C① — 매치 내 판 1개 시작(내부용, startNewMatch·"다음 판" 버튼 둘 다 호출).
 * match.js의 playGameInMatch와 동형: matchId(고정)·gameIndexInMatch(M.gameIndex)·
 * characters(매치 고정)·carryOver(있으면만 opts.matchCarryOver로 전달)를 그대로
 * Engine.createEngine에 싣는다 — §6-2 리셋 6항은 createEngine이 매 판 새 state를
 * 만드는 것 자체로 이미 이행된다(추가 코드 없음, match.js와 동일 원칙). */
function startGameInMatch() {
  const seed = deriveGameSeedForMatch(M.matchSeed, M.gameIndex);
  const userConfig = {};
  if (M.hpOverride) userConfig.player = { maxHpA: M.hpOverride.maxHpA, maxHpB: M.hpOverride.maxHpB };
  const engineOpts = { matchId: M.matchId, gameIndexInMatch: M.gameIndex, characters: M.characters };
  const carryOverForThisGame = M.carryOver;
  if (carryOverForThisGame) engineOpts.matchCarryOver = carryOverForThisGame;

  G = buildGameSession(seed, userConfig, engineOpts);
  resetUiTransientState();
  document.getElementById('summary-panel').hidden = true;
  document.getElementById('selfcheck-result').textContent = '';

  // ★D2-C② — 이월·리셋을 "읽을 수 있게" 이 판 시작 시점에 1회 스냅샷을 캡처해 M에
  // 고정 보관한다(매 render()마다 다시 읽으면 라운드가 진행되며 HP/SP가 바뀌어 "리셋
  // 직후 값"이 아니라 "지금 값"으로 변질된다 — 오너가 판정하려는 건 정확히 리셋 시점
  // 값이다). getPublicView는 순수 조회라 이 시점에 불러도 RNG를 소비하지 않는다.
  M.transitionSnapshot = buildTransitionSnapshot(carryOverForThisGame, M.prevGameSummary);

  runLoop();
}

/** ★D2-C② — 판 시작 직후 스냅샷 1건 조립(판정 없음 — Engine.getPublicView가 이미
 * 계산해 준 필드를 그대로 옮겨 담을 뿐). carryOver/prevGameSummary가 둘 다 null이면
 * 판1(이월·직전 판 비교 대상이 아직 없음) — renderMatchPanel이 이 경우 배너 자체를
 * 그리지 않는다. */
function buildTransitionSnapshot(carryOver, prevGameSummary) {
  const view = Engine.getPublicView(G.state, 'A');
  return {
    gameIndex: M.gameIndex,
    carryOver,
    prevGameSummary,
    hp: { A: view.self.hp, maxA: view.self.maxHp, B: view.opponent.hp, maxB: view.opponent.maxHp },
    sp: { A: view.self.sp, B: view.opponent.sp },
    buffStacks: { A: view.self.buffStacks, B: view.opponent.buffStacks },
    pot: view.shared.pot.value,
    status: { A: view.self.status, B: view.opponent.status },
    handSize: { A: view.self.hand.length, B: view.opponent.handSize },
    deckRemaining: view.shared.deckRemaining,
  };
}

/** ★D2-C③ — 상태이상 없음/있음을 한 줄로("없음" 또는 이름 나열). 판정 없음(존재 여부
 * 나열뿐), S.status[key] 정본 이름 재사용(새 이름 신설 없음). */
function summarizeStatusForMatch(status, S) {
  const list = [];
  if (status.BURN) list.push(S.status.BURN);
  if (status.FREEZE) list.push(S.status.FREEZE);
  return list.length ? list.join(', ') : S.match.resetStatusNone;
}

/** ★D2-C③ — 판 종료 감지 시(render()가 G.state.terminal && matchMode일 때 호출) 매치
 * 집계에 1회만 반영한다(G.matchGameRecorded로 중복 반영 방지 — terminal 상태는 다음
 * "판 시작" 전까지 여러 번 render()될 수 있다). match.js playMatch의 WINS_NEEDED=2·
 * MAX_GAMES=3과 동일 조건으로 매치 종료를 판정한다. state.winner는 D1(§6-6 하드캡
 * 판정승 체인)이 NATURAL/HARD_CAP 불문 항상 'A'|'B'로 확정해둔 값을 그대로 센다
 * (match.js playMatch 주석과 동일 근거 — 이 파일이 승자를 다시 계산하지 않는다). */
function recordMatchGameEndIfNeeded() {
  if (!M || G.matchGameRecorded) return;
  G.matchGameRecorded = true;

  const endEvent = [...G.uiEvents].reverse().find((e) => e.type === 'GAME_END');
  const winner = G.state.winner;
  const rec = {
    gameIndexInMatch: M.gameIndex,
    seed: G.state.seedRoot,
    winner,
    terminalReason: G.state.terminalReason,
    rounds: endEvent ? endEvent.rounds : G.state.round,
    hpFinal: endEvent ? endEvent.hpFinal : [G.state.players.A.hp, G.state.players.B.hp],
    // ★§6-6 — 하드캡으로 끝난 판만 이 필드가 채워진다(engine.js finalizeGameEnd의
    // extraFields — HARD_CAP 분기에서만 hardCapWinnerChain을 싣는다).
    hardCapWinnerChain: endEvent && endEvent.hardCapWinnerChain ? endEvent.hardCapWinnerChain : null,
  };
  M.games.push(rec);
  if (winner === 'A' || winner === 'B') M.gamesWon[winner] += 1;

  if (M.gamesWon.A >= 2 || M.gamesWon.B >= 2 || M.gameIndex >= 3) {
    M.matchOver = true;
    M.matchWinner = M.gamesWon.A > M.gamesWon.B ? 'A' : M.gamesWon.B > M.gamesWon.A ? 'B' : null;
    M.pendingNext = false;
  } else {
    // ★§6-1 — 다음 판으로 넘길 이월을 여기서 미리 추출해둔다("다음 판" 버튼 클릭
    // 시점에 startGameInMatch가 이 값을 그대로 opts.matchCarryOver로 싣는다).
    M.carryOver = extractCarryOverForMatch(G.state);
    M.prevGameSummary = { winner: rec.winner, terminalReason: rec.terminalReason, hpFinal: rec.hpFinal, rounds: rec.rounds };
    M.pendingNext = true;
  }
}

/** ★D2-C③ — 매치 스코어보드 + 이월/리셋 배너 + 매치 종료 요약. 판정 없음(전부 M·
 * getPublicView가 이미 계산해 준 값의 조립) — 오너 모드에서도 숨기지 않는다(이 UI
 * 자체가 이번 발주의 목적물이라 "개발용 표시"가 아니다, applyOwnerModeVisibility가
 * 숨기는 기존 3종 — G2·isBestNow·bestHandHint — 과는 무관한 별개 패널). */
function renderMatchPanel() {
  const S = window.STR;
  const panel = document.getElementById('match-panel');
  if (!M) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const charName = (key) => (S.character[key] || {}).name || key;
  const cardName = (ct) => {
    const info = resolveSkillInfo(ct, S);
    return (info && info.name) || ct;
  };

  const scoreHtml = `<div class="match-scoreboard">
    <span>${S.match.matchLabel}: <b>${M.matchId}</b></span>
    <span>${S.match.gameIndexLabel}: <b>${M.gameIndex} / 3</b></span>
    <span>${S.match.scoreLabel}: <b>A ${M.gamesWon.A} : ${M.gamesWon.B} B</b></span>
    <span>${S.match.charactersLabel}: A ${charName(M.characters.A)} · B ${charName(M.characters.B)}</span>
  </div>`;

  // ★판이 방금 끝났고 다음 판 대기 중 — "무엇이 넘어갈 예정인지"(carryOver, 아직 다음
  // 판에 적용 전) + 진행 버튼.
  let pendingHtml = '';
  if (M.pendingNext) {
    const carry = M.carryOver;
    pendingHtml = `<div class="match-box carry">
      <h4>${fillTemplate(S.match.gameEndedTitle, { n: M.games[M.games.length - 1].gameIndexInMatch })}</h4>
      <div>${S.match.lastWinnerLabel}: <b>${M.games[M.games.length - 1].winner}</b> (${S.terminalReason[M.games[M.games.length - 1].terminalReason] || M.games[M.games.length - 1].terminalReason})</div>
      <div>${S.match.carryOverTitle}</div>
      <div>A: ${carry.build.A.length ? carry.build.A.map(cardName).join(', ') : S.match.carryOverNone}</div>
      <div>B: ${carry.build.B.length ? carry.build.B.map(cardName).join(', ') : S.match.carryOverNone}</div>
      <div>${S.match.poolRemainingLabel}: ${carry.pool.length}</div>
      <button id="btn-next-game">${fillTemplate(S.match.nextGameButton, { n: M.gameIndex + 1 })}</button>
    </div>`;
  }

  // ★현재 판이 이월을 실제로 적용받은 판(gameIndex>=2)이면, 판 시작 시점에 캡처해둔
  // transitionSnapshot으로 "실제 적용됨" + "리셋됨"을 함께 보여준다(startGameInMatch
  // 참조 — 이 값은 그 판이 끝날 때까지 고정, 매 렌더마다 재계산하지 않는다).
  let startedHtml = '';
  const snap = M.transitionSnapshot;
  if (snap && snap.gameIndex === M.gameIndex && (snap.carryOver || snap.prevGameSummary)) {
    const carry = snap.carryOver;
    const prev = snap.prevGameSummary;
    startedHtml = `<div class="match-box carry">
      <h4>${fillTemplate(S.match.startedBannerTitle, { n: M.gameIndex })}</h4>
      <div>${S.match.carryOverAppliedTitle}</div>
      <div>A: ${carry.build.A.length ? carry.build.A.map(cardName).join(', ') : S.match.carryOverNone}</div>
      <div>B: ${carry.build.B.length ? carry.build.B.map(cardName).join(', ') : S.match.carryOverNone}</div>
      <div>${S.match.poolRemainingLabel}: ${carry.pool.length}</div>
    </div>
    <div class="match-box reset">
      <h4>${S.match.resetTitle}</h4>
      <div>${fillTemplate(S.match.resetHpLine, { hpA: snap.hp.A, maxA: snap.hp.maxA, hpB: snap.hp.B, maxB: snap.hp.maxB, prevA: prev.hpFinal[0], prevB: prev.hpFinal[1] })}</div>
      <div>${fillTemplate(S.match.resetSpLine, { spA: snap.sp.A, spB: snap.sp.B })}</div>
      <div>${fillTemplate(S.match.resetStackLine, { stackAtk: snap.buffStacks.A['♠'], stackCrit: snap.buffStacks.A['♦'], oppStackAtk: snap.buffStacks.B['♠'], oppStackCrit: snap.buffStacks.B['♦'] })}</div>
      <div>${fillTemplate(S.match.resetPotLine, { pot: snap.pot })}</div>
      <div>${fillTemplate(S.match.resetStatusLine, { statusA: summarizeStatusForMatch(snap.status.A, S), statusB: summarizeStatusForMatch(snap.status.B, S) })}</div>
      <div>${fillTemplate(S.match.resetHandLine, { handA: snap.handSize.A, handB: snap.handSize.B, deck: snap.deckRemaining })}</div>
    </div>`;
  }

  let summaryHtml = '';
  if (M.matchOver) {
    const rows = M.games
      .map((g) => {
        const chain = g.hardCapWinnerChain ? ` (${S.match.hardCapMethod[g.hardCapWinnerChain.method] || g.hardCapWinnerChain.method})` : '';
        return `<tr><td>${g.gameIndexInMatch}</td><td>${g.winner}</td><td>${S.terminalReason[g.terminalReason] || g.terminalReason}${chain}</td><td>${g.rounds}</td><td>A=${g.hpFinal[0]} / B=${g.hpFinal[1]}</td></tr>`;
      })
      .join('');
    summaryHtml = `<div class="match-winner-banner">${S.match.matchOverTitle} — ${S.match.matchWinnerLabel}: ${M.matchWinner || '—'}</div>
    <table class="log-table"><tr><th>${S.match.gameIndexHeader}</th><th>${S.summary.winner}</th><th>${S.summary.terminalReason}</th><th>${S.summary.rounds}</th><th>${S.summary.hpFinal}</th></tr>${rows}</table>`;
  }

  document.getElementById('match-body').innerHTML = scoreHtml + startedHtml + pendingHtml + summaryHtml;

  if (M.pendingNext) {
    // ★★대회 치명 버그 수정 — 전수 확인 중 발견한 두 번째 사례(오너 지시 ③). 이 버튼도
    // 매 render()마다 innerHTML로 통째로 다시 그려지므로, 더블클릭 시 위 EXCHANGE와
    // 동일한 스테일 DOM 노드 재발화가 일어날 수 있다. 여기서는 alert()는 없었지만
    // (엔진 턴 검증을 거치지 않는 경로라 예외는 안 던진다) M.gameIndex가 조용히 2번
    // 증가해 매치 한 판이 통째로 건너뛰는 조용한 정합성 버그였다 — M.pendingNext를
    // 첫 클릭에서 즉시 false로 내리고, 낡은(스테일) 재발화는 이 값으로 가드한다.
    document.getElementById('btn-next-game').addEventListener('click', () => {
      if (!M.pendingNext) return; // 이미 처리된 낡은 클릭 — 무시
      M.pendingNext = false;
      M.gameIndex += 1;
      startGameInMatch();
    });
  }
}

// ---- 고정 정책("최소 결정 경로") --------------------------------------------
// ★verifier가 고정 시퀀스로 반복 재현할 수 있게: 항상 최소 교환(0장) · 항상
// 손패 최강 조합 제출(Engine.handEval.bestHand 호출 — 재계산 없음, ★W2-3: 조커
// 보유 시 5장 미만이 정상이라 "5장"을 못 박지 않는다) · ACTION_CHOICE는 옵션에
// BASIC_ATTACK이 있으면 그것(승자), 없으면 legal.options[0](패자 — 평타 자체가
// 옵션에 없다, ★D2 정정: 구판은 무조건 BASIC_ATTACK을 보내 패자 SP 만충 자동
// 진행에서 엔진이 던지는 걸 그대로 두었다, 실측 재현) · 항상 첫 제시 카드 픽
// (CARD_DRAW_PICK, 만석이면 보유 카드 중 첫 번째를 버림). 이 함수는 판정 로직을
// 전혀 담지 않는다(배열 인덱싱 + 엔진 함수 호출뿐).
function buildMinimalAction(view, legal) {
  if (legal.type === 'EXCHANGE') {
    return { type: 'EXCHANGE', actor: legal.actor, payload: { discard: [] } };
  }
  if (legal.type === 'SUBMIT') {
    // ★W2-3 — 구판의 "hand.length>=5" 분기는 5장 미만+조커≥2 손패에서 else 분기
    // (naive slice)로 빠져 조커 2장 이상이 그대로 제출 후보에 섞일 수 있었다(잠재
    // 결함 — engine.js handleSubmit이 최종 거부하긴 하지만 자동 진행이 그 자리에서
    // 멈춘다). bestHand()는 legalSubmitCombos()로 이 전부를 이미 올바르게 처리하므로
    // (조커≤1 강제, 장수=submitCountFor 그대로) hand.length>=1이면 항상 이것만 쓴다.
    const best = Engine.handEval.bestHand(view.self.hand); // ★엔진 함수 호출
    const ids = best ? best.combo.map((c) => c.id) : [];
    return { type: 'SUBMIT', actor: legal.actor, payload: { submitted: ids } };
  }
  if (legal.type === 'ACTION_CHOICE') {
    // ★D2(⑤ 행동 게이트 6분기) 정정 — 패자는 SP 만충일 때만 이 화면에 도달하고,
    // legal.options에 'BASIC_ATTACK'이 없다(actionChoiceOptionsFor, engine.js §4 —
    // 평타 없음). 구판은 무조건 BASIC_ATTACK을 보내 이 경로에서 handleActionChoice가
    // "옵션 중 하나를 선택해야 한다" 에러를 던졌다(★실측 재현 — humanActor가 패자
    // 자리이고 autoRunMode인 조합에서 runLoop 전체가 멈췄다). options에 있으면
    // BASIC_ATTACK을 우선(기존 결정 경로 보존), 없으면 첫 옵션(캐릭터 스킬 →
    // 액티브 → DRAW 순, actionChoiceOptionsFor의 배열 순서 그대로)으로 결정론 유지.
    const choice = legal.options.indexOf('BASIC_ATTACK') !== -1 ? 'BASIC_ATTACK' : legal.options[0];
    return { type: 'ACTION_CHOICE', actor: legal.actor, payload: { choice } };
  }
  if (legal.type === 'CARD_DRAW_PICK') {
    // ★D2(① 게이트) 신설 — 구 DRAFT_PICK 분기를 대체한다(legal.offer→legal.offered·
    // legal.full→legal.cardsFull, G-A-10 신 스키마). 패스 경로는 없다(3장 중 반드시
    // 1장 — renderCardDrawPickPanel 헤더 코멘트와 동일 근거).
    const picked = legal.offered[0];
    if (legal.cardsFull) {
      const discard = legal.heldCards[0];
      return { type: 'CARD_DRAW_PICK', actor: legal.actor, payload: { picked, discard } };
    }
    return { type: 'CARD_DRAW_PICK', actor: legal.actor, payload: { picked } };
  }
  throw new Error('buildMinimalAction: 알 수 없는 legal.type ' + legal.type);
}

// ---- 엔진 진행 루프 ----------------------------------------------------------
function applyActionRaw(action) {
  const res = Engine.applyAction(G.state, action);
  G.state = res.state;
  for (const e of res.events) {
    G.uiEvents.push(e);
    absorbEventForDisplay(e);
  }
}

function absorbEventForDisplay(e) {
  // ★판정 없음 — 엔진이 이미 계산해 이벤트에 실어준 필드를 표시용으로 그대로 옮겨 담을 뿐.
  if (e.type === 'SUBMIT') {
    G.deferred[e.actor] = new Set(e.deferred);
  }
  if (e.type === 'HAND_EVAL' || e.type === 'ROUND_RESULT' || e.type === 'SUIT_TRIGGER') {
    if (!G.lastReadout || G.lastReadout.round !== e.round) G.lastReadout = { round: e.round };
    if (e.type === 'HAND_EVAL') G.lastReadout[e.actor] = e;
    if (e.type === 'ROUND_RESULT') G.lastReadout.result = e;
    // ★버그 수정(2026-08-19, web-engineer — 오너 요청 "턴 종료 후 수트 효과가 어떻게
    // 추가되는지" 대응 중 발견) — applySuitEffectsForActor(engine.js)는 매 라운드
    // A·B 각자에게 독립적으로(무승부 포함, §1-2·§2 스텝2 정본) SUIT_TRIGGER를 1건씩
    // 낸다. 구코드 `G.lastReadout.suitTrigger = e`는 단일 필드라 같은 라운드의 두 번째
    // 이벤트가 첫 번째를 덮어써(actor 하나만 저장) 화면에 한쪽 수트 획득만 보였다 —
    // ★실측 확인(엔진 SUIT_TRIGGER 2건/라운드 vs 화면 표시 1건). actor별 키로 둘 다
    // 보존한다(엔진 이벤트 재계산 없음 — 저장 구조만 A/B 둘로 나눔).
    if (e.type === 'SUIT_TRIGGER') {
      if (!G.lastReadout.suitTrigger) G.lastReadout.suitTrigger = {};
      G.lastReadout.suitTrigger[e.actor] = e;
    }
  }
}

/** 한 스텝만 진행(AI 또는 자동모드의 사람 쪽) — 실제 사람 입력이 필요하면 false. */
function stepEngine() {
  if (G.state.terminal) return false;
  const legal = Engine.getLegalActions(G.state);
  if (!legal) return false;
  const actor = legal.actor;
  const isAiTurn = actor === aiActor;
  const isAutoHuman = actor === humanActor && autoRunMode;
  if (!isAiTurn && !isAutoHuman) return false;

  const view = Engine.getPublicView(G.state, actor);
  const t0 = performance.now();
  let action;
  if (isAutoHuman) {
    action = buildMinimalAction(view, legal);
  } else {
    action = Engine.decide(view, legal, aiTier, G.state.rng.policy, G.state.config); // ★엔진 AI 함수만 호출
  }
  action.decisionMs = Math.round(performance.now() - t0); // ★보조 증거만 — diff 판정에 절대 미사용
  rememberSubmittedCardsIfAny(actor, view, action);
  applyActionRaw(action);
  return true;
}

function rememberSubmittedCardsIfAny(actor, view, action) {
  if (action.type !== 'SUBMIT') return;
  const ids = new Set(action.payload.submitted);
  // ★verifier FAIL 수정(2026-08-19, P1) — G.submittedCards[actor]는 그 actor가 다음
  // 라운드에 다시 제출하는 순간 덮어써지는 가변 전역이다. renderReadout()의 lineFor는
  // "그 라운드 판정"(G.lastReadout, HAND_EVAL 시점에 고정)과 이 값을 나란히 쓰는데,
  // 직전 판정 결과가 아직 화면에 남아있는 채로(다음 라운드 판정 전) 어느 한쪽이 이미
  // 다음 라운드를 제출하면 카드는 새 라운드 것, 족보명은 이전 라운드 것으로 갈린다
  // (verifier 실측: K♠K♦K♥7♠7♣가 표시됐는데 라벨은 "플러시"). round 태그를 함께
  // 저장해 lineFor가 "이 라운드 것이 맞는지" 확인하고 아니면 hv.evaluated(그 라운드
  // HAND_EVAL 이벤트에 고정된 값)로 폴백하게 한다 — 새 소스를 만들지 않고 기존
  // 폴백 경로(hv.evaluated)를 정확한 조건에서만 쓰게 고치는 것.
  G.submittedCards[actor] = { round: view.round, cards: view.self.hand.filter((c) => ids.has(c.id)) };
}

function runLoop() {
  let guard = 0;
  while (stepEngine()) {
    guard++;
    if (guard > 50000) {
      console.error('runLoop: guard(50000) 초과 — 무한루프 의심, 중단');
      break;
    }
  }
  render();
}

// ---- ★★대회 치명 버그 수정(2026-08-19) — 더블클릭 시 콘솔 에러 + 네이티브 alert ----
// ★verifier 실측 재현: 「교환 확정」을 빠르게 2번 누르면 applyAction이 "턴 오류 —
// 기대 type=SUBMIT, 받은=EXCHANGE"를 던지고 alert()가 뜬다. 원인: render()가 매번
// currentLegal을 새 객체로 재할당하는데(renderStatusBar — Engine.getLegalActions는
// 매 호출 새 객체를 반환, 참조 재사용 없음, engine.js 확인), 각 확정 버튼의 클릭
// 핸들러는 그 버튼을 그렸을 때의 legal 객체를 클로저로 물고 있다. 버튼을 2회 연속
// 누르면(같은 DOM 노드에 자바스크립트로 두 번 .click()을 걸거나, 첫 클릭의 동기 처리
// 중 el.innerHTML이 패널을 통째로 새로 그려 원래 버튼 노드가 detach된 뒤에도 그
// 노드에 붙어있던 리스너가 재발화하는 경우) 첫 클릭은 정상 처리되고 currentLegal이
// 다음 턴 값으로 바뀌지만, 두 번째(낡은) 클릭은 여전히 "그릴 때의" legal로 액션을
// 다시 만들어 엔진에 넣는다 — 엔진은 이미 다음 턴을 기다리므로 타입 불일치로 예외를
// 던진다.
//
// 근본 처방(오너 지시 ①②) — ①확정 버튼은 누르는 즉시 disabled(bindOnceClick)로
// 재진입 자체를 막는다. ②그래도 스테일 DOM 노드가 재발화하는 경우까지 대비해
// submitPlayerAction 자체가 "제출 시점의 legal 스냅샷"과 "지금의 currentLegal"을
// 비교해 다르면(=이미 다음 턴으로 넘어갔다는 뜻) 엔진에 아예 넣지 않고 조용히
// 무시한다 — "거부하는 방식(에러+alert)"이 아니라 "제출 자체를 만들지 않는다."
// ③그래도 엔진이 실제로 예외를 던지는 경로(①②가 다 뚫리는 미지의 경우)까지 대비해
// alert() 대신 화면 안 배너(action-error-banner)로 표시한다 — 심사 중 네이티브
// 팝업은 그 자체로 감점 요인이라는 지시 그대로.

/** ★버튼 클릭 즉시 disabled로 만들어 재진입을 막는 공통 헬퍼. fn은 그 버튼이 해야 할
 * 제출/처리 1회분. 이미 disabled면(=이미 한 번 처리됨) 아무것도 하지 않는다. */
function bindOnceClick(btn, fn) {
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;
    fn();
  });
}

/** alert() 대체 — action-panel 위 배너에 인라인으로 띄운다. */
function showActionError(message) {
  const el = document.getElementById('action-error-banner');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}
function clearActionError() {
  const el = document.getElementById('action-error-banner');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

/** alert() 대체 — 설정 패널(HP 입력 검증 등)용 인라인 에러. wireSetupControls에서
 * "새 판/새 매치 시작" 입력값 검증 실패 시 사용(★★대회 치명 버그 수정 — 이 alert()도
 * 같은 이유로 제거). */
function showSetupError(message) {
  const el = document.getElementById('setup-error-hint');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}
function clearSetupError() {
  const el = document.getElementById('setup-error-hint');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

/** 사람의 실제 클릭에서만 호출 — 액션을 "한 번" 만들어 그대로 넘긴다.
 * ★legalSnapshot(옵션) — 호출부가 그 버튼을 그릴 때 쓴 legal 객체를 그대로 넘기면,
 * 지금의 currentLegal과 참조가 다를 때(=이미 다음 턴으로 넘어간 낡은 제출) 엔진 호출
 * 자체를 건너뛴다(위 헤더 코멘트 ② 참조). 넘기지 않은 호출부(레거시 호환)는 이 검사를
 * 그냥 건너뛴다 — 기존 동작 그대로.
 */
function submitPlayerAction(action, legalSnapshot) {
  if (legalSnapshot && legalSnapshot !== currentLegal) {
    console.warn('submitPlayerAction: 낡은 턴 스냅샷 — 무시(더블클릭/스테일 DOM 방어)');
    return;
  }
  clearActionError();
  action.decisionMs = Math.round(performance.now() - phaseInputStartTs);
  const view = Engine.getPublicView(G.state, action.actor);
  rememberSubmittedCardsIfAny(action.actor, view, action);
  try {
    applyActionRaw(action);
  } catch (err) {
    console.error('applyAction 실패:', err);
    showActionError(fillTemplate(window.STR.errors.actionFailedPrefix, { message: err.message }));
    return;
  }
  selectedDiscardIds = new Set();
  selectedSubmitIds = new Set();
  draftPendingPick = null;
  runLoop();
}

// ---- 렌더링 ------------------------------------------------------------------
function render() {
  if (!G) return;
  renderStatusBar();
  renderBattlefield();
  if (G.state.terminal) {
    commitSessionExportIfNeeded(); // ★판 종료 시점 — G가 다음 판 시작 때 재할당되기 전에 이 판의 export를 세션 배열에 반영
    renderSummary();
    document.getElementById('action-panel').innerHTML = '';
    if (matchMode) recordMatchGameEndIfNeeded(); // ★D2-C — 매치 집계(중복 반영은 G.matchGameRecorded가 막는다)
  } else {
    document.getElementById('summary-panel').hidden = true;
    renderActionPanel();
  }
  renderReadout();
  renderBattleLogPanel(); // ★C-3
  renderInstrumentPanel();
  if (matchMode) renderMatchPanel(); // ★D2-C — 스코어보드 + 이월/리셋 배너 + 매치 종료 요약
}

// ★D1 정정(인계분) → ★D2가 마저 완성 — 구 shared.multiplier{base,effective,mode,cap}는
// D1에서 shared.pot{value,base,growthFactor,cap,atCap}으로 대체됐다(engine.js
// getPublicView 주석 — "구 shared.multiplier 대체"). 아래 렌더 함수들은 기존 배수 라벨
// (panel.multiplier* — 로컬라이제이션 키 그대로 재사용, 값만 '판돈'으로 정정, 신규
// 하드코딩 없음)에 pot.* 값을 그대로 옮겨 그린다(재계산 0). mode는 D1이
// applyMultiplierTrigger 자체를 폐지해 대응 개념이 없으므로 표시에서 뺀다(setup 화면의
// 죽은 드롭다운도 함께 제거 — startNewGame 주석 참조).
//
// ★D2(② 판돈 가시화, G-A-9 오너 직접 지시·F18-24) — 팟 전용 UI 3종: ⓐ현재 팟값(위
// panel.multiplier* 그대로) ⓑ성장 사건 ⓒ상한 도달. ⓑ는 "가장 최근에 처리된 POT_CHANGE가
// DRAW_GROWTH였는가"로 판별한다(getLastPotChangeEvent) — runLoop()가 무승부 판정부터
// 다음 실제 입력 대기 지점까지를 한 번의 render()로 묶어 처리하므로, 이 판별이 바로
// "무승부 판정 직후 그 라운드 안에서" 노출을 만족시킨다(판 종료 요약이 아니라 매
// render()마다 최신 상태). ⓒ는 view.shared.pot.atCap(엔진이 이미 계산해 주는 값)을
// 그대로 읽을 뿐 — 두 표시 다 UI 재계산 0.
function getLastPotChangeEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'POT_CHANGE') return events[i];
  }
  return null;
}

/** ★D2(② 판돈 가시화, 성장 사건) — 가장 최근 POT_CHANGE가 DRAW_GROWTH일 때만 배너를
 * 낸다(그 외 트리거 — WINNER_ATTACK_CONSUME/WINNER_DRAW_VANISH/A8_RAISE — 는 팟이
 * "커진" 사건이 아니므로 대상이 아니다). before/after는 이벤트 필드를 그대로 옮길 뿐
 * (fmtNum은 표시 자릿수만 정리, D4 정책 재사용) — UI가 배수·거듭제곱을 다시 계산하지
 * 않는다. */
function renderPotGrowthBanner(events, S) {
  const last = getLastPotChangeEvent(events);
  if (!last || last.trigger !== 'DRAW_GROWTH') return '';
  return `<div class="pot-growth-banner">${fillTemplate(S.pot.growthBanner, { before: fmtNum(last.before), after: fmtNum(last.after) })}</div>`;
}

function renderStatusBar() {
  const S = window.STR;
  const view = Engine.getPublicView(G.state, humanActor);
  const legal = Engine.getLegalActions(G.state);
  currentLegal = legal;
  const turnText = G.state.terminal
    ? '—'
    : `${legal.actor === humanActor ? S.panel.you : legal.actor} / ${S.phase[legal.type] || legal.type}`;
  const lastPotChange = getLastPotChangeEvent(G.uiEvents);
  const growthFlag = lastPotChange && lastPotChange.trigger === 'DRAW_GROWTH' ? `<span class="pot-growth-flag">${S.pot.growthLabel}</span>` : '';
  const capFlag = view.shared.pot.atCap ? `<span class="pot-cap-flag">${S.pot.capLabel}</span>` : '';
  document.getElementById('status-bar').innerHTML = `
    <span>${S.panel.round}: <b>${view.round}</b></span>
    <span>${S.panel.turnIndicator}: <b class="turn-flag">${turnText}</b></span>
    <span>${S.panel.multiplier}: <b>${S.panel.multiplierBase} ×${view.shared.pot.base} / ${S.panel.multiplierEffective} ×${view.shared.pot.value}</b> (${S.panel.multiplierCap} ×${view.shared.pot.cap}) ${growthFlag}${capFlag}</span>
    <span>${S.panel.deck}: <b>${view.shared.deckRemaining}</b>${renderDeckBySuit(view)}</span>
    ${renderDraftPreviewNote(view, S)}
  `;
}

function renderDeckBySuit(view) {
  if (!view.shared.deckRemainingBySuit) return '';
  const d = view.shared.deckRemainingBySuit;
  return ` (♠${d['♠']} ♥${d['♥']} ♦${d['♦']} ♣${d['♣']} JK${view.shared.deckRemainingJokers})`;
}

/** ★W-신규6(2026-08-17, web-engineer — 오너 원문 "다음 턴이 도파민 카드 뽑기라는 걸
 * 알려줬음 좋겠어") — shared.draftPreview(W1 엔진 노출, getPublicView v4)를 그대로
 * 읽어 표시만 한다. ★주기(draft.cycle)를 여기서 재계산하지 않는다 — roundsUntilNext는
 * 엔진(draft.js advanceDraftCycle과 완전히 같은 규약)이 이미 계산해 준 값이다("UI가
 * 주기를 자체 계산하면 룰 이중 구현이 된다", director 스펙 A 문언 그대로). forcedOff
 * (게이트⑥ 강제 배정 모드)면 드래프트 자체가 발동하지 않으므로 표시하지 않는다. */
function renderDraftPreviewNote(view, S) {
  const dp = view.shared.draftPreview;
  if (!dp || dp.forcedOff) return '';
  if (dp.roundsUntilNext <= 1) {
    return `<span class="draft-preview imminent">${S.panel.draftPreviewImminent}</span>`;
  }
  return `<span class="draft-preview">${S.panel.draftPreviewLabel}: ${dp.roundsUntilNext}${S.panel.round}</span>`;
}

function renderBattlefield() {
  const S = window.STR;
  const view = Engine.getPublicView(G.state, humanActor);
  const cfg = G.state.config;
  // ★verifier P0-2 FAIL 수정 — P5/A8 런타임 실제값 계산에 필요한 최소 컨텍스트.
  // cardTypes/buffStacks는 getPublicView가 self·opponent 양쪽에 이미 공개한 필드
  // 그대로(view.self.cards·view.opponent.cards·[...].buffStacks — 새 노출 아님).
  // potValue(view.shared.pot.value)는 공유 자원이라 self/opp 어느 쪽 컨텍스트든 동일값.
  // ★버그 수정(2026-08-19) — isWinner도 각자 관점(actor)으로 채운다(A8 승자 분기
  // 전용, isCurrentRoundWinner 헤더 주석 참조 — G.lastReadout.result에서 얻는다).
  const oppRuntimeCtx = { cardTypes: view.opponent.cards, diamondStack: view.opponent.buffStacks['♦'], potValue: view.shared.pot.value, isWinner: isCurrentRoundWinner(view.opponent.actor) };
  const selfRuntimeCtx = { cardTypes: view.self.cards, diamondStack: view.self.buffStacks['♦'], potValue: view.shared.pot.value, isWinner: isCurrentRoundWinner(view.self.actor) };

  // 상대 패널 — ★손패 뒷면 + 직전 교환 장수
  // ★D2(⑥ 하드코딩 감사 중 발견, 내 작업 범위 밖의 기존 잔재지만 즉시 정정) — 아래
  // opponentLastExchange 줄의 '장' 리터럴을 S.battle.cardCountWord로 교체했다(중복
  // 문자열 신설 없음 — 이미 다른 여러 지점이 같은 키를 쓴다).
  const opp = view.opponent;
  const oppBacks = Array.from({ length: opp.handSize }).map(() => '<div class="card-back"></div>').join('');
  document.getElementById('panel-opponent').innerHTML = `
    <h3>${S.panel.opponent} (${opp.actor})</h3>
    <div>${S.panel.character}: <b>${(S.character[opp.character] || {}).name || opp.character}</b></div>
    ${renderBar(S.panel.hp, opp.hp, opp.maxHp, 'hp')}
    ${renderBar(S.panel.sp, opp.sp, cfg.player.spThreshold, 'sp')}
    <div>${S.panel.opponentLastExchange}: <b>${opp.lastExchangeCount}</b>${S.battle.cardCountWord}</div>
    <div class="status-badges">${renderEffectBadges(opp, cfg, 'opponent')}</div>
    <div id="opp-effect-detail">${renderEffectDetailBox('opponent', opp, cfg)}</div>
    ${renderForcedSubmitMinNote(opp.forcedSubmitMin, S)}
    <div>${S.panel.opponentHandBack} (${opp.handSize})</div>
    <div class="opp-hand-backs">${oppBacks}</div>
    ${renderRevealedCardsNote(opp.revealedCards, S)}
    <div>${S.panel.cards} (${opp.cards.length}/${cfg.draft.slotsMax})</div>
    <div class="card-groups">${renderCardBadges(opp.cards, 'opponent', opp.sp, cfg.player.spThreshold, cfg, oppRuntimeCtx)}</div>
    <div id="opp-card-detail">${renderCardDetailBox('opponent', cfg, oppRuntimeCtx)}</div>
  `;

  // 공유 패널 — ★D1 정정(인계분) → ★D2가 마저 완성 — shared.multiplier → shared.pot,
  // 값만 옮겨 그린다(renderStatusBar 상단 주석과 동일 근거). ★D2(② 판돈 가시화) —
  // 성장 사건·상한 도달 배너를 여기 전체 폭으로 붙인다(status-bar의 짧은 플래그와
  // 같은 데이터 출처, 재계산 0 — 이중 노출로 놓칠 확률을 낮춘다).
  document.getElementById('panel-shared').innerHTML = `
    <h3>${S.panel.multiplier}</h3>
    <div>${S.panel.multiplierBase}: ×${view.shared.pot.base}</div>
    <div>${S.panel.multiplierEffective}: ×${view.shared.pot.value}</div>
    <div>${S.panel.multiplierCap}: ×${view.shared.pot.cap}</div>
    ${renderPotGrowthBanner(G.uiEvents, S)}
    ${view.shared.pot.atCap ? `<div class="pot-cap-banner">${fillTemplate(S.pot.capBanner, { cap: view.shared.pot.cap })}</div>` : ''}
    <div style="margin-top:8px">${S.panel.deck}: ${view.shared.deckRemaining}</div>
    ${view.shared.deckRemainingBySuit ? `<div>${S.panel.deckBySuit}: ♠${view.shared.deckRemainingBySuit['♠']} ♥${view.shared.deckRemainingBySuit['♥']} ♦${view.shared.deckRemainingBySuit['♦']} ♣${view.shared.deckRemainingBySuit['♣']} JK${view.shared.deckRemainingJokers}</div>` : ''}
  `;

  // 내 패널
  const self = view.self;
  document.getElementById('panel-self').innerHTML = `
    <h3>${S.panel.self} (${self.actor})</h3>
    <div>${S.panel.character}: <b>${(S.character[self.character] || {}).name || self.character}</b></div>
    ${renderBar(S.panel.hp, self.hp, self.maxHp, 'hp')}
    ${renderBar(S.panel.sp, self.sp, cfg.player.spThreshold, 'sp')}
    <div class="status-badges">${renderEffectBadges(self, cfg, 'self')}</div>
    <div id="self-effect-detail">${renderEffectDetailBox('self', self, cfg)}</div>
    ${renderForcedSubmitMinNote(self.forcedSubmitMin, S)}
    <div>${S.panel.cards} (${self.cards.length}/${cfg.draft.slotsMax})</div>
    <div class="card-groups">${renderCardBadges(self.cards, 'self', self.sp, cfg.player.spThreshold, cfg, selfRuntimeCtx)}</div>
    <div id="self-card-detail">${renderCardDetailBox('self', cfg, selfRuntimeCtx)}</div>
  `;
}

/** ★W-신규6(A7 쥐어짜기, 구 「강요」) — self/opponent.forcedSubmitMin(W3 엔진 노출, getPublicView v5)을
 * 그대로 읽는다. 값·계산 없음(fillTemplate 조립뿐) — SUBMIT 화면의 kMin이 왜 갑자기
 * 늘었는지 원인을 밝혀준다(이 노출이 없으면 A7의 효과가 화면에서 "안 느껴진다"). */
function renderForcedSubmitMinNote(forcedSubmitMin, S) {
  if (!forcedSubmitMin) return '';
  return `<div class="forced-min-note">${fillTemplate(S.panel.forcedSubmitMinNote, { value: forcedSubmitMin.value, remaining: forcedSubmitMin.remaining })}</div>`;
}

/** ★W-신규6(A9 밑장 보기, 구 「투시」, D1 예외 ⓑ) — opponent.revealedCards(getPublicView v5)만 읽는다.
 * ★이 필드는 엔진이 이미 "발동한 쪽에만" 걸러 준 값이다(viewer===byActor 검사가
 * engine.js getPublicView에 있다) — 여기서 추가로 숨기거나 걸러낼 것이 없다. 그 밖의
 * 상대 손패는 이 함수가 절대 참조하지 않는다(opp.hand 자체가 getPublicView에 없다). */
function renderRevealedCardsNote(revealedCards, S) {
  if (!revealedCards || !revealedCards.length) return '';
  return `<div class="revealed-cards">${S.panel.revealedCardsLabel}: <b>${cardGlyphs(revealedCards)}</b></div>`;
}

/** ★카드 배열 → "7♠ JK★" 형태 글리프 문자열. renderReadout의 제출 카드 표시와
 * renderRevealedCardsNote(A9)가 공유한다(중복 로직 제거) — 판정 없음, 표시 조립뿐. */
function cardGlyphs(cards) {
  return cards.map((c) => (c.isJoker ? 'JK★' : `${Engine.cards.rankLabel(c.rank)}${c.suit}`)).join(' ');
}

/** ★속성값 이스케이프 — 카드 desc에 큰따옴표가 섞여 있으면(예: A1/A2의 S5 정정문
 * `원안 "+8"에서…`) title="${desc}" 조합 시 속성이 그 자리에서 끊겨 태그가 깨진다
 * (실측 확인 — 이 헬퍼 추가 전 A1/A2 title이 첫 " 앞에서 잘렸었다). */
function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ★C-1 — 카드 배지를 <button>으로 렌더한다(클릭 → 효과 상세 토글, renderCardDetailBox
 * 참조). panelKey는 'self' | 'opponent' — cardDetailOpen 상태를 패널별로 독립 관리해
 * 상대 카드 상세를 열어도 내 카드 상세가 안 닫히게(그 반대도 동일). title 속성도 남겨
 * 마우스 호버로도 미리보기가 되게 한다(클릭이 주 상호작용, 호버는 보조).
 * ★short(2026-08-19) — 이 title 호버 미리보기는 short(플레이 중 한 줄)를 쓴다. desc
 * 전문은 클릭으로 여는 renderCardDetailBox에서만 노출한다(정보 손실 0 유지).
 *
 * ★R10-W(2026-08-17, 오너 요청 "보유 스킬 가시성" + "패시브/액티브 구분이 안 느껴졌다") —
 * 이 함수(C-1)를 확장해 패시브/액티브를 별도 그룹으로 나눠 렌더한다. R9-W의 EFFECT_BADGES
 * 레지스트리를 세 번째로 복제하지 않았다 — 카드는 이미 C-1이 있고 상태이상·버프처럼
 * "항목별 표시 로직이 서로 다른" 확장 압력이 없어(전부 이름+설명 카드 배지, 균일 구조)
 * 레지스트리화가 필요 없다고 판단, 기존 함수를 그대로 넓혔다.
 *
 * 분류 기준은 하드코딩된 'P'/'A' 접두사 문자열 검사가 아니라 엔진이 실제로 export하는
 * Engine.ACTIVE_SKILL_IDS(proto/engine/engine.js — ACTION_CHOICE에서 heldSkills를 가를 때
 * 엔진 스스로 쓰는 그 목록, N8/CARD_REGISTRY와 같은 반열의 정본 상수)를 그대로 참조한다 —
 * 카드 10종 확충(별도 라인 진행 중)이 새 액티브/패시브를 추가해도 이 UI는 그 목록만
 * 따라간다(엔진 값 우회 금지 원칙 준수).
 *
 * 액티브 그룹에는 "사용 가능"(SP 임계 도달) 표시를 곁들인다. sp/spThreshold는 둘 다
 * getPublicView(self.sp/opp.sp)·G.state.config(player.spThreshold)에서 그대로 읽은 원시
 * 값이고 — renderBar가 그리는 SP 게이지가 이미 이 두 값으로 100% 채움을 그린다 — 비교식
 * `sp >= spThreshold` 자체는 엔진 내부 spAtThreshold(engine.js L1099·L1550, ACTION_CHOICE
 * 큐잉·heldSkills 판정에 쓰이는 그 술어)를 문자 그대로 재현한 것이다. 족보 판정·데미지
 * 공식처럼 여러 분기·와일드카드·상한이 얽힌 룰이 아니라 이미 화면에 떠 있는 숫자 둘의 단순
 * 부등식이라 "룰 이중 구현"으로 보지 않았다 — 다만 getPublicView가 이 불리언 자체를 필드로
 * 노출하지는 않으므로(원시값 sp/spThreshold만 공개), 더 엄격한 기준을 원하면 rule-engineer가
 * 전용 필드를 getPublicView에 추가해야 한다(작업 보고에 그대로 적어 알린다). */
/** ★verifier P0-2 FAIL 수정 — runtimeCtx(cardTypes/diamondStack/potValue, mode='held')를
 * 받으면 applyRuntimeShortOverride로 P5/A8의 short를 "지금 실제로 얼마"로 다시 계산한다.
 * runtimeCtx가 없으면(호출부가 안 줬으면) 기존처럼 정적 short를 그대로 쓴다 — 방어적
 * 하위호환(이 함수를 호출하는 다른 지점이 생겨도 즉시 깨지지 않는다). */
function renderCardBadges(cardTypes, panelKey, sp, spThreshold, cfg, runtimeCtx) {
  const S = window.STR;
  const activeIds = Engine.ACTIVE_SKILL_IDS; // ★엔진 정본 목록 — 접두사 하드코딩 아님(15종 전부 포함)
  const passives = cardTypes.filter((ct) => activeIds.indexOf(ct) === -1);
  const actives = cardTypes.filter((ct) => activeIds.indexOf(ct) !== -1);
  const activeReady = sp >= spThreshold; // ★엔진 spAtThreshold와 동일 술어(위 주석 참조)

  const renderOne = (ct, groupClass, readyFlag) => {
    let info = resolveSkillInfo(ct, S, cfg) || {}; // ★W-신규6 — cfg를 주면 desc의 {placeholder}가 실값으로 채워진다
    info = applyRuntimeShortOverride(ct, info, cfg, runtimeCtx, S, 'held'); // ★P0-2 — 보유 중이므로 'held'(보유분 전체의 현재 실제 기여도)
    const isOpen = cardDetailOpen[panelKey] === ct;
    const cls = ['badge', 'card', groupClass];
    if (readyFlag) cls.push('ready');
    if (isOpen) cls.push('open');
    return `<button type="button" class="${cls.join(' ')}" data-card="${ct}" data-panel="${panelKey}" title="${escapeAttr(info.short || '')}">${info.name || ct}</button>`;
  };
  const renderGroup = (list, groupClass, readyFlag) =>
    list.length ? list.map((ct) => renderOne(ct, groupClass, readyFlag)).join('') : '<span style="color:#777">—</span>';

  return `
    <div class="card-group">
      <div class="card-group-header passive"><span class="group-dot"></span>${S.panel.cardsPassiveLabel} (${passives.length})</div>
      <div class="card-badges">${renderGroup(passives, 'passive', false)}</div>
    </div>
    <div class="card-group">
      <div class="card-group-header active"><span class="group-dot"></span>${S.panel.cardsActiveLabel} (${actives.length})${actives.length && activeReady ? ` <span class="active-ready-pill">${S.panel.activeReadyLabel}</span>` : ''}</div>
      <div class="card-badges">${renderGroup(actives, 'active', activeReady)}</div>
    </div>`;
}

/** ★C-1 — panelKey에서 현재 열려있는 카드의 이름+효과 설명을 박스로 반환(없으면 빈 문자열).
 * ★W-신규6 — cfg(G.state.config)를 주면 renderCardBadges와 동일하게 {placeholder}를 채운다.
 * ★short(2026-08-19) — 클릭으로 여는 이 박스가 "상세를 보고 싶을 때"의 유일한 지점이라
 * short(플레이 중 한 줄)를 헤드라인으로 먼저 보여주고, desc(명세 문장 — 정보 손실 0
 * 유지)를 보조 줄로 이어 붙인다. 배지 title 호버(renderCardBadges)는 short만 보여주므로
 * desc 전문은 이 박스가 유일한 노출 경로다.
 * ★verifier P0-2 FAIL 수정 — renderCardBadges와 같은 runtimeCtx를 받아 같은 override를
 * 적용한다(배지 title과 상세박스가 서로 다른 숫자를 보여주면 그 자체로 새 불일치가 된다). */
function renderCardDetailBox(panelKey, cfg, runtimeCtx) {
  const S = window.STR;
  const ct = cardDetailOpen[panelKey];
  if (!ct) return '';
  let info = resolveSkillInfo(ct, S, cfg) || {};
  info = applyRuntimeShortOverride(ct, info, cfg, runtimeCtx, S, 'held');
  return `<div class="card-detail-box"><b>${info.name || ct}</b><div>${info.short || ''}</div><div class="card-detail-full">${info.desc || ''}</div></div>`;
}

/** ★C-1 — 카드 배지 클릭 위임(boot()에서 1회 등록). 엔진 스텝 없이 표시 상태만 토글하고
 * renderBattlefield()만 다시 그린다(게임 진행에 영향 없음 — 순수 UI 토글). */
function wireCardDetailDelegation() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.badge.card[data-card]');
    if (!btn) return;
    const panelKey = btn.dataset.panel;
    const ct = btn.dataset.card;
    cardDetailOpen[panelKey] = cardDetailOpen[panelKey] === ct ? null : ct;
    if (G) renderBattlefield();
  });
}

// ---- R9-W: 상태이상·버프 배지 클릭 → 효과 상세(C-1 구조를 그대로 확장) --------------
/**
 * ★오너 요청 "구조화" — 새 상태이상/버프가 생기면 이 배열에 항목 1건만 추가하면
 * 된다(strings.js effectInfo에 descTemplate 1건 추가와 세트, 그게 절차의 전부).
 * 각 항목:
 *   key            — strings.js effectInfo의 키 겸 effectDetailOpen에 저장되는 식별자.
 *   cssClass       — 배지 색상 클래스(style.css).
 *   isActive(view) — 이 효과가 지금 배지로 뜰 상태인가(상태이상은 존재 여부, 버프는 항상 true — 기존 동작 유지).
 *   name(S)        — 배지 이름. ★반드시 기존 정본 레지스트리(S.status/S.suit)를 재사용한다 —
 *                     여기서 이름 문자열을 새로 정의하지 않는다(드리프트 방지, strings.js 주석 참조).
 *   badgeText(view,cfg,S)    — 배지 버튼에 찍히는 실측값 포함 라벨. 상태이상 2종은 기존
 *                              renderStatusBadges(제거됨)와 문구 동일 유지. 수트 버프 2종은
 *                              이름을 S.panel.buffAtk/buffDef(구 하드코딩 병용 문구, 폐기)에서
 *                              S.suit['♠']/['♦']로 통일했다 — 라운드 판정 리드아웃(renderReadout)의
 *                              같은 수트 표시명과 갈리지 않게(오너 지적 — 표시명 드리프트 금지).
 *                              opponent 패널도 이제 self와 동일하게 실효값(+N)을 함께 보여준다
 *                              (buffStacks는 이미 getPublicView 공개 필드라 정보 노출 문제 없음).
 *   detailCurrent(view,cfg,S) — 상세 박스의 "현재" 줄(실측값).
 *   templateValues(cfg)     — effectInfo[key].descTemplate의 {placeholder}를 채울 값.
 *                              ★G.state.config(current.json)에서 읽기만 한다 — 계산은 산술
 *                              변환(퍼센트 환산 등) 뿐, 룰 로직은 없다. 엔진 수정 금지 원칙과
 *                              무관(읽기 전용).
 */
const EFFECT_BADGES = [
  {
    key: 'BURN',
    cssClass: 'burn',
    isActive: (view) => !!view.status.BURN,
    name: (S) => S.status.BURN,
    badgeText: (view, cfg, S) => `${S.status.BURN} (${S.status.remaining} ${view.status.BURN.remaining})`,
    detailCurrent: (view, cfg, S) => `${S.status.remaining} ${view.status.BURN.remaining}`,
    templateValues: (cfg) => ({ lossChance: Math.round(cfg.status.burn.lossChance * 100), duration: cfg.status.burn.duration }),
  },
  {
    key: 'FREEZE',
    cssClass: 'freeze',
    isActive: (view) => !!view.status.FREEZE,
    name: (S) => S.status.FREEZE,
    badgeText: (view, cfg, S) => `${S.status.FREEZE} (${S.status.remaining} ${view.status.FREEZE.remaining})`,
    detailCurrent: (view, cfg, S) => `${S.status.remaining} ${view.status.FREEZE.remaining}`,
    templateValues: (cfg) => ({ exchangePenalty: cfg.status.freeze.exchangePenalty, duration: cfg.status.freeze.duration }),
  },
  {
    key: 'ATK_BUFF',
    cssClass: 'buff-atk',
    isActive: () => true, // ★기존 동작 유지 — 버프 배지는 스택 0이어도 항상 표시(상태이상과 다름)
    name: (S) => S.suit['♠'],
    badgeText: (view, cfg, S) => `${S.suit['♠']} ${view.buffStacks['♠']}(+${fmtNum(view.buffStacks['♠'] * cfg.buff.atkPerStack)})`,
    detailCurrent: (view, cfg, S) =>
      `${S.effectInfo.applied.stackLabel} ${view.buffStacks['♠']} (${S.effectInfo.applied.effectLabel} +${fmtNum(view.buffStacks['♠'] * cfg.buff.atkPerStack)})`,
    templateValues: (cfg) => ({ atkPerStack: cfg.buff.atkPerStack, stackCap: cfg.buff.stackCap }),
  },
  // ★D2 정정(⑥ ♦=방어 전수 정정, F18-22) — 구 DEF_BUFF(방어력, cfg.buff.defPerStack)는
  // D1이 config에서 아예 삭제했다(방어 축 폐지, current.json buff._metaD1 실측 대조) —
  // 남겨두면 cfg.buff.defPerStack이 undefined라 fmtNum(N*undefined)=NaN이 배지에 그대로
  // 떴다(★실측 확인 — 이 정정 전 코드로 재현). CRIT_BUFF(치명타 확률 가산)로 개명하고
  // crit.chancePerStack에서 값을 읽는다.
  {
    key: 'CRIT_BUFF',
    cssClass: 'buff-crit',
    isActive: () => true,
    name: (S) => S.suit['♦'],
    badgeText: (view, cfg, S) => `${S.suit['♦']} ${view.buffStacks['♦']}(+${Math.round(view.buffStacks['♦'] * cfg.crit.chancePerStack * 100)}%)`,
    detailCurrent: (view, cfg, S) =>
      `${S.effectInfo.applied.stackLabel} ${view.buffStacks['♦']} (${S.effectInfo.applied.effectLabel} +${Math.round(view.buffStacks['♦'] * cfg.crit.chancePerStack * 100)}%)`,
    templateValues: (cfg) => ({
      chancePerStackPct: Math.round(cfg.crit.chancePerStack * 100),
      stackCap: cfg.buff.stackCap,
      chanceCapPct: Math.round(cfg.crit.chanceCap * 100),
    }),
  },
];

/** ★{key} 자리표시자를 values로 치환하는 순수 문자열 치환(계산 없음, 조립만). strings.js
 * effectInfo.descTemplate(배지 상세)와 effectInfo.applied.cappedOverflowNote(리드아웃)
 * 양쪽에서 공용으로 쓴다. */
function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in values ? values[k] : `{${k}}`));
}

/** ★R9-W — 상태이상·버프 배지를 <button>으로 렌더(클릭 → 효과 상세 토글, C-1의
 * renderCardBadges와 동일 패턴). panelKey는 'self'|'opponent' — effectDetailOpen 상태를
 * 패널별로 독립 관리한다. cfg는 G.state.config(읽기 전용, 엔진 수정 없음). */
function renderEffectBadges(view, cfg, panelKey) {
  const S = window.STR;
  const parts = [];
  for (const def of EFFECT_BADGES) {
    if (!def.isActive(view)) continue;
    const isOpen = effectDetailOpen[panelKey] === def.key;
    const desc = fillTemplate(S.effectInfo[def.key].descTemplate, def.templateValues(cfg));
    const label = def.badgeText(view, cfg, S);
    parts.push(
      `<button type="button" class="badge effect ${def.cssClass}${isOpen ? ' open' : ''}" data-effect="${def.key}" data-panel="${panelKey}" title="${escapeAttr(desc)}">${label}</button>`
    );
  }
  return parts.join('');
}

/** ★R9-W — panelKey에서 현재 열려있는 효과의 이름+설명(config 조립)+현재 실측값을
 * 박스로 반환(없으면 빈 문자열). C-1의 renderCardDetailBox와 동일 패턴. */
function renderEffectDetailBox(panelKey, view, cfg) {
  const S = window.STR;
  const key = effectDetailOpen[panelKey];
  if (!key) return '';
  const def = EFFECT_BADGES.find((d) => d.key === key);
  if (!def || !def.isActive(view)) return ''; // 상태 소멸(예: 화상 만료) 등으로 사라지면 자동으로 닫힌 것처럼 표시
  const desc = fillTemplate(S.effectInfo[key].descTemplate, def.templateValues(cfg));
  const current = def.detailCurrent(view, cfg, S);
  return `<div class="card-detail-box"><b>${def.name(S)}</b><div>${desc}</div><div>${current}</div></div>`;
}

/** ★R9-W — 효과 배지 클릭 위임(boot()에서 1회 등록). 엔진 스텝 없이 표시 상태만
 * 토글하고 renderBattlefield()만 다시 그린다(게임 진행에 영향 없음 — 순수 UI 토글,
 * C-1의 wireCardDetailDelegation과 동일 패턴). */
function wireEffectDetailDelegation() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.badge.effect[data-effect]');
    if (!btn) return;
    const panelKey = btn.dataset.panel;
    const key = btn.dataset.effect;
    effectDetailOpen[panelKey] = effectDetailOpen[panelKey] === key ? null : key;
    if (G) renderBattlefield();
  });
}

function renderBar(label, value, max, cls) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  // ★표시 전용 반올림 — 엔진 state의 실수 값(예: p5.factor=1.25 적용 데미지)은 그대로 두고
  // 화면 문자열만 정수로 보이게 한다. 바 너비(pct)는 정밀도를 유지해도 무방하므로 그대로 둔다.
  return `<div class="bar-row"><span class="bar-label">${label}</span><div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div><span class="bar-value">${Math.round(value)}/${max}</span></div>`;
}

// ---- 행동 패널 ---------------------------------------------------------------
function renderActionPanel() {
  const S = window.STR;
  const el = document.getElementById('action-panel');
  const legal = currentLegal;
  if (!legal) {
    el.innerHTML = '';
    return;
  }
  if (legal.actor !== humanActor || autoRunMode) {
    el.innerHTML = `<div>${legal.actor === aiActor ? S.panel.aiThinking : S.app.autoRunLabel + '…'}</div>`;
    return;
  }

  // ★사람의 실제 입력 차례가 시작되는 시점 — decisionMs 기산점.
  phaseInputStartTs = performance.now();

  if (legal.type === 'EXCHANGE') return renderExchangePanel(el, legal);
  if (legal.type === 'SUBMIT') return renderSubmitPanel(el, legal);
  if (legal.type === 'ACTION_CHOICE') return renderActionChoicePanel(el, legal);
  // ★D2(① 게이트 최우선) — 구 legal.type==='DRAFT_PICK' 분기는 삭제한다(엔진이 그
  // 타입을 다시는 반환하지 않는다 — renderCardDrawPickPanel 헤더 코멘트 참조). 실제
  // 도달하는 타입은 'CARD_DRAW_PICK'.
  if (legal.type === 'CARD_DRAW_PICK') return renderCardDrawPickPanel(el, legal);
  el.textContent = 'unknown legal type ' + legal.type;
}

function suitClass(suit) {
  return suit === '♥' || suit === '♦' ? 'suit-red' : 'suit-black';
}

function makeCardEl(card, { selected, deferred, onClick }) {
  const div = document.createElement('div');
  div.className = 'card ' + (card.isJoker ? 'joker' : suitClass(card.suit));
  if (selected) div.classList.add('selected');
  if (deferred) div.classList.add('deferred-badge');
  div.dataset.id = card.id;
  const rank = document.createElement('div');
  rank.className = 'rank';
  rank.textContent = card.isJoker ? 'JK' : Engine.cards.rankLabel(card.rank); // ★엔진 표시용 함수 재사용
  const suit = document.createElement('div');
  suit.className = 'suit';
  suit.textContent = card.isJoker ? '★' : card.suit;
  div.appendChild(rank);
  div.appendChild(suit);
  if (onClick) div.addEventListener('click', onClick);
  return div;
}

function renderExchangePanel(el, legal) {
  const S = window.STR;
  const view = Engine.getPublicView(G.state, humanActor);
  el.innerHTML = `<h3>${S.phase.EXCHANGE} — ${S.panel.exchangeCapLabel}: <b>${legal.capEffective}</b></h3>
    <div>${S.panel.selectedCount}: <span id="exch-count">0</span> / ${legal.capEffective}</div>
    <div class="hand-grid" id="exch-hand"></div>
    <button id="btn-confirm-exchange">${S.action.confirmExchange}</button>
    <button class="secondary" id="btn-clear-exchange">${S.action.clearSelection}</button>`;

  const grid = document.getElementById('exch-hand');
  view.self.hand.forEach((card) => {
    const isDeferred = G.deferred[humanActor].has(card.id);
    const elCard = makeCardEl(card, {
      selected: selectedDiscardIds.has(card.id),
      deferred: isDeferred,
      onClick: () => {
        if (selectedDiscardIds.has(card.id)) {
          selectedDiscardIds.delete(card.id);
        } else if (selectedDiscardIds.size < legal.capEffective) {
          selectedDiscardIds.add(card.id);
        }
        renderExchangePanel(el, legal);
      },
    });
    grid.appendChild(elCard);
  });
  document.getElementById('exch-count').textContent = String(selectedDiscardIds.size);
  // ★★대회 치명 버그 수정 — bindOnceClick(클릭 즉시 disabled) + legal 스냅샷 전달(더블클릭
  // 시 콘솔 에러+alert 재현 지점, 위 submitPlayerAction 헤더 코멘트 참조).
  bindOnceClick(document.getElementById('btn-confirm-exchange'), () => {
    submitPlayerAction({ type: 'EXCHANGE', actor: legal.actor, payload: { discard: Array.from(selectedDiscardIds) } }, legal);
  });
  document.getElementById('btn-clear-exchange').addEventListener('click', () => {
    selectedDiscardIds = new Set();
    renderExchangePanel(el, legal);
  });
}

/** ★D7 — 라운드별 "제출 카드 선택 토글 횟수" 계측(PM 판정, §5-3 D7 후속). 오너가 선택
 * 5장을 바꿔가며 프리뷰(족보+수트레벨)를 반복 조회하면(=수동 전수 탐색) 이 카운터가
 * 커진다. ★화면에는 절대 표시하지 않는다(표시하면 그 자체로 오너 행동이 바뀐다 —
 * 측정 오염) — export 블록에만 싣는다. G.uiEvents(엔진 이벤트, 정규화 해시 대조 대상)
 * 와는 완전히 분리된 G.submitToggleCounts에만 적재한다. */
function recordSubmitToggle(round) {
  if (!G) return;
  G.submitToggleCounts[round] = (G.submitToggleCounts[round] || 0) + 1;
}

/** ★W2-2 — 이미 선택된 조커 수(제출 선택 집합 안에서만). 보유/이월/교환/교체 쪽은
 * 이 함수를 아예 호출하지 않는다(과잉 차단 금지 — 오너 확정: 제한은 제출 선택
 * 시점에만 건다). */
function countSelectedJokers(cardsById) {
  let n = 0;
  selectedSubmitIds.forEach((id) => {
    if (cardsById[id] && cardsById[id].isJoker) n++;
  });
  return n;
}

/** ★W1-UI — 가변 제출(kMin~kMax) 범위 문구 조립. kMin===kMax(결손 손패로 폭이 0인
 * 경우 — 조커 상한/손패 부족)면 숫자 하나만 보여준다. '~'는 번역이 필요한 단어가
 * 아니라 기호라 strings.js로 옮기지 않는다(기존 코드의 '×'·'—'·'/' 등 기호 하드코딩
 * 관례와 동일 — 단어(장)만 S.battle.cardCountWord에서 가져와 재사용한다, 새 중복
 * 키를 만들지 않는다). */
function formatSubmitRange(kMin, kMax) {
  return kMin === kMax ? `${kMax}` : `${kMin}~${kMax}`;
}

function renderSubmitPanel(el, legal) {
  const S = window.STR;
  const view = Engine.getPublicView(G.state, humanActor);
  const cardsById = {};
  view.self.hand.forEach((c) => (cardsById[c.id] = c));
  const rangeLabel = formatSubmitRange(legal.kMin, legal.kMax) + S.battle.cardCountWord;
  el.innerHTML = `<h3>${S.phase.SUBMIT} — ${rangeLabel}</h3>
    <div>${S.panel.selectedCount}: <span id="sub-count">0</span> / ${rangeLabel}</div>
    <div class="hand-grid" id="sub-hand"></div>
    ${jokerCapBlocked ? `<div class="joker-cap-warn">${S.errors.jokerSubmitCap}</div>` : ''}
    <div class="readout-box" id="sub-preview"></div>
    <button id="btn-confirm-submit">${S.action.confirmSubmit}</button>
    <button class="secondary" id="btn-clear-submit">${S.action.clearSelection}</button>
    ${ownerMode ? '' : `<button class="secondary" id="btn-best-submit">${S.panel.bestHandHint}</button>`}`;

  const grid = document.getElementById('sub-hand');
  view.self.hand.forEach((card) => {
    const isDeferred = G.deferred[humanActor].has(card.id);
    const elCard = makeCardEl(card, {
      selected: selectedSubmitIds.has(card.id),
      deferred: isDeferred,
      onClick: () => {
        if (selectedSubmitIds.has(card.id)) {
          selectedSubmitIds.delete(card.id);
          jokerCapBlocked = false;
        } else if (selectedSubmitIds.size < legal.kMax) {
          // ★W2-2 — UI 3중째: 조커를 이미 1장(legal.jokerSubmitCap, 엔진 메타) 선택한
          // 상태에서 두 번째 조커를 누르면 "선택되지 않고" 메시지만 뜬다. 엔진 handleSubmit의
          // 권위 검증(2중)과 getLegalActions의 jokerSubmitCap 메타(엔진값, 하드코딩 아님)를
          // 그대로 따른다 — 조커가 아닌 카드나 상한 미만 조커 선택은 그대로 통과.
          if (card.isJoker && countSelectedJokers(cardsById) >= legal.jokerSubmitCap) {
            jokerCapBlocked = true;
          } else {
            selectedSubmitIds.add(card.id);
            jokerCapBlocked = false;
          }
        }
        recordSubmitToggle(view.round); // ★D7 — 표시 없음, export 전용 계측
        renderSubmitPanel(el, legal);
      },
    });
    grid.appendChild(elCard);
  });
  document.getElementById('sub-count').textContent = String(selectedSubmitIds.size);
  renderSubmitPreview(view, legal);

  // ★W1-UI — 제출 버튼은 [kMin,kMax] 범위 안이면 활성(구판은 legal.count 정확히
  // 일치만 허용). kMax===0(SG-20 크래시 경로 — 손패 0장)일 때도 kMin=0이라
  // size===0으로 즉시 활성화돼 화면이 멈추지 않는다(엔진이 0장 제출을 합법으로 본다).
  const canConfirm = selectedSubmitIds.size >= legal.kMin && selectedSubmitIds.size <= legal.kMax;
  const btnConfirm = document.getElementById('btn-confirm-submit');
  btnConfirm.disabled = !canConfirm;
  // ★★대회 치명 버그 수정 — 클릭 즉시 disabled(재진입 차단) + legal 스냅샷 전달. 기존
  // kMin/kMax 범위 가드(btnConfirm.disabled)는 그대로 유지 — 여기서 disabled였던
  // 버튼은 애초에 이 콜백까지 오지 않는다(둘 다 "if (btn.disabled) return"과 동치).
  btnConfirm.addEventListener('click', () => {
    if (btnConfirm.disabled) return;
    if (selectedSubmitIds.size < legal.kMin || selectedSubmitIds.size > legal.kMax) return;
    btnConfirm.disabled = true;
    submitPlayerAction({ type: 'SUBMIT', actor: legal.actor, payload: { submitted: Array.from(selectedSubmitIds) } }, legal);
  });
  document.getElementById('btn-clear-submit').addEventListener('click', () => {
    selectedSubmitIds = new Set();
    jokerCapBlocked = false;
    renderSubmitPanel(el, legal);
  });
  if (!ownerMode) {
    document.getElementById('btn-best-submit').addEventListener('click', () => {
      // ★W2-3 — 구판은 "hand.length>=5"를 게이트로 썼는데, J-4 이후 조커≥2 보유 손패는
      // 5장 미만에서도 손패 전량이 아니라 "합법 제출(조커≤1)"을 골라야 한다(구판 else
      // 분기는 hand 전체를 그대로 선택해 손패<5+조커≥2 조합에서 조커 2장 이상이 선택될
      // 수 있었다 — 잠재 결함). bestHand()는 legalSubmitCombos()로 이미 이 전부를
      // 처리하므로(hand.length<1일 때만 null) 특수 분기를 없애고 항상 엔진 함수를 쓴다.
      const best = Engine.handEval.bestHand(view.self.hand); // ★엔진 함수 호출(재구현 아님)
      if (best) selectedSubmitIds = new Set(best.combo.map((c) => c.id));
      jokerCapBlocked = false;
      renderSubmitPanel(el, legal);
    });
  }
}

/** ★실시간 족보·수트 프리뷰 — Engine.handEval.evaluateHand/resolveSuitEffects/bestHand
 * 만 호출한다. 이 함수는 판정 로직을 담지 않는다(표시 문자열 조립뿐). */
function renderSubmitPreview(view, legal) {
  const S = window.STR;
  const box = document.getElementById('sub-preview');
  // ★W1-UI — kMin장 이상이면 미리보기를 띄운다(구판은 legal.count 정확히 일치만
  // 허용해 2~4장 제출 시 무슨 족보인지 전혀 보이지 않았다 — 오너 제보③의 핵심).
  // ★evaluateHand는 0장을 거부한다(throw) — kMax===0(SG-20 크래시 경로)로 kMin도
  // 0이 되는 극단에서는 Math.max(1, legal.kMin)로 1장 미만 호출을 막는다(화면만
  // 안 죽으면 된다는 지시 — 근본 처방은 director 판정 대기).
  if (selectedSubmitIds.size < Math.max(1, legal.kMin) || selectedSubmitIds.size > legal.kMax) {
    box.innerHTML = `<i>${fillTemplate(S.panel.submitPreviewHint, { min: legal.kMin })}</i>`;
    return;
  }
  const cardsById = {};
  view.self.hand.forEach((c) => (cardsById[c.id] = c));
  const selectedCards = Array.from(selectedSubmitIds).map((id) => cardsById[id]);
  const evalResult = Engine.handEval.evaluateHand(selectedCards); // ★엔진 함수
  const catName = Engine.handEval.RANK_CATEGORY_NAMES[evalResult.rankCategory]; // evaluateHand는 숫자 enum을 반환 — 이름 배열도 엔진 것
  const p4Bonus = view.self.cards.indexOf('P4') !== -1 ? G.state.config.card.p4.suitLevelBonus : 0;
  const suitRes = Engine.handEval.resolveSuitEffects(evalResult, cardsById, {
    levelCap: G.state.config.suit.levelCap,
    p4Bonus,
  }); // ★엔진 함수

  let bestNote = '';
  // ★W2-3 — 구판은 "hand.length>=5"를 게이트로 썼다. bestHand()는 legalSubmitCombos()로
  // 조커≥2 보유·4장 이하 제출까지 전부 스스로 처리하므로(hand.length<1일 때만 null),
  // 5장 기준을 없애고 "손패가 비어있지 않은가"만 확인한다(가드가 없으면 hand=0일 때
  // best===null이라 best.eval에서 예외가 난다).
  if (!ownerMode && view.self.hand.length >= 1) {
    // ★오너 모드에서는 이 블록 자체를 스킵 — G2 실시간 판정 표시를 화면에 내지 않는다.
    // (아래 계산은 표시용 파생값일 뿐 G.uiEvents/계측에는 영향 없음 — 스킵해도 내부 로그는 그대로)
    const best = Engine.handEval.bestHand(view.self.hand); // ★엔진 함수
    const isBest = Engine.handEval.compareEval(evalResult, best.eval) === 0; // ★엔진 함수
    bestNote = `<div>${isBest ? S.panel.isBestNow : S.panel.isNotBestNow}</div>`;
  }

  // ★verifier 지적(2026-08-19, P2-2) — 리터럴 ' (상한 초과분 N 버림)'을 없앤다.
  // S.effectInfo.applied.cappedOverflowNote가 이미 같은 문구의 키를 갖고 있다
  // (EFFECT_BADGES 배지 상세가 쓰는 그 키 — 재사용, 새 키 신설 아님).
  const triggerLines = suitRes.triggers
    .map(
      (t) =>
        `${S.suit[t.suit]} Lv.${t.levelFinal}${
          t.cappedOverflow ? ` (${fillTemplate(S.effectInfo.applied.cappedOverflowNote, { n: t.cappedOverflow })})` : ''
        }`
    )
    .join(' · ');

  const deferredIds = view.self.hand.filter((c) => !selectedSubmitIds.has(c.id)).map((c) => c.id);
  box.innerHTML = `
    <div class="rankcat">${S.rank[catName] || catName}</div>
    <div>${S.panel.suitTriggerPreview}: ${triggerLines || S.panel.suitTriggerNone}</div>
    ${bestNote}
    <div>${S.panel.deferredCards}(${deferredIds.length}): ${deferredIds.length ? S.panel.deferredNote : '—'}</div>
  `;
}

/** ★D2(⑤ 행동 게이트 6분기 화면) — legal.options는 getLegalActions/actionChoiceOptionsFor
 * (engine.js 정본)가 이미 6분기(승자 SP미만충 강제평타 / 승자 3택 / 패자 2택[SP만충
 * 전용, 평타 없음])를 반영해 필터링해 준 값이다 — 여기서 분기를 재구현하지 않고
 * legal.isWinner/legal.spAtThreshold로 어느 분기인지 설명문만 붙인다(판정 로직 0).
 * ★opt==='DRAW'는 구 3턴 주기 드래프트가 아니라 G-A-10(CARD_DRAW_PICK, 사적 3장 1택)의
 * 진입점이다 — resolveSkillInfo가 이 값을 모르므로(S.card/캐릭터 레지스트리 어디에도
 * 없음) 여기서 먼저 분기해 S.phase.CARD_DRAW_PICK 라벨을 붙인다(안 그러면 D5류로
 * unknownLabel "알 수 없음"이 뜬다 — ★실측 확인, 이 정정 전 코드로 재현). */
function renderActionChoicePanel(el, legal) {
  const S = window.STR;
  const view = Engine.getPublicView(G.state, humanActor);
  const cfg = G.state.config;
  // ★verifier P0-2 FAIL 수정 — 이 화면의 스킬 옵션은 전부 이미 보유 중인 카드(또는
  // 캐릭터 스킬)라 mode='held'. A8이 옵션에 뜰 수 있는 유일한 액티브라(P5는 패시브라
  // 여기 절대 안 뜬다 — 아래 override는 A8이 아니면 그냥 no-op으로 통과한다).
  // ★버그 수정(2026-08-19) — isWinner 추가(A8 승자 분기 전용, isCurrentRoundWinner
  // 헤더 주석 참조). 이 화면은 항상 그 라운드 판정 직후(R5_BATTLE)에만 뜨므로
  // G.lastReadout.result는 항상 "지금 이 라운드"의 값이다(이전 라운드 값이 새는
  // 시점이 아니다).
  const runtimeCtx = { cardTypes: view.self.cards, diamondStack: view.self.buffStacks['♦'], potValue: view.shared.pot.value, isWinner: isCurrentRoundWinner(view.self.actor) };
  const subtitle = !legal.spAtThreshold
    ? S.panel.actionGateForced
    : legal.isWinner
    ? S.panel.actionGateWinnerChoice
    : S.panel.actionGateLoserChoice;
  // ★표시 전용 반올림 — renderBar와 동일 원칙(state.sp 자체는 미변경)
  el.innerHTML = `<h3>${S.phase.ACTION_CHOICE}</h3><div class="hint">${subtitle}</div><div>${S.panel.sp}: ${Math.round(view.self.sp)}</div><div id="ac-buttons"></div><div id="ac-swap-picker"></div>`;
  const box = document.getElementById('ac-buttons');
  legal.options.forEach((opt) => {
    const btn = document.createElement('button');
    if (opt === 'BASIC_ATTACK') {
      btn.textContent = S.action.basicAttack;
    } else if (opt === 'DRAW') {
      btn.textContent = `${S.phase.CARD_DRAW_PICK} — ${S.action.drawHint}`;
    } else {
      let info = resolveSkillInfo(opt, S, cfg); // ★SG-A — 드래프트 스킬·캐릭터 스킬 통합 조회. ★W-신규6: cfg를 줘 {placeholder} 채움
      info = applyRuntimeShortOverride(opt, info, cfg, runtimeCtx, S, 'held');
      // ★short(2026-08-19, 오너 요청) — 전투 중 실제로 뭘 쓸지 결정하는 버튼이라 short를 쓴다.
      btn.textContent = info ? `${info.name} — ${info.short}` : S.battle.unknownLabel;
    }
    // ★★대회 치명 버그 수정 — 클릭 즉시 disabled(재진입 차단). CHAR_SWAP은 즉시
    // 제출하지 않고 하위 선택 패널을 여는 분기라 여기서는 disabled를 걸지 않는다
    // (그 패널의 btn-confirm-swap이 자체적으로 같은 방어를 갖는다, 아래 참조).
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      // ★W2-4 — CHAR_SWAP은 다른 옵션과 달리 "어느 카드를 버릴지"를 오너가 먼저
      // 골라야 payload.swapDiscard가 채워진다(engine.js resolveCharacterSwap 요구
      // 사항). 다른 옵션(기본공격·드래프트 액티브·강타)은 즉시 제출한다 — 카드
      // 선택이 필요한 건 CHAR_SWAP 하나뿐이다.
      if (opt === 'CHAR_SWAP') {
        renderCharSwapPicker(view, legal);
        return;
      }
      btn.disabled = true;
      submitPlayerAction({ type: 'ACTION_CHOICE', actor: legal.actor, payload: { choice: opt } }, legal);
    });
    box.appendChild(btn);
  });
}

/** ★W2-4 — 캐릭터 스킬 "교체"(CHAR_SWAP) 전용 카드 선택 서브패널. 이월분(view.self.hand)
 * 에서 1~legal.swapCount장을 골라 확정하면 payload.swapDiscard로 실어 제출한다.
 * ★R2 정규 교환(selectedDiscardIds, renderExchangePanel)과 완전히 별개의 선택 상태
 * (charSwapSelectedIds)를 쓴다 — 같은 라운드에 정규 교환을 이미 했어도 이 선택에는
 * 전혀 영향이 없다(오너 확정 "R2와 별개"). 엔진 함수(handleSubmit류)를 재구현하지
 * 않는다 — 여기서 하는 일은 카드 id를 모아 payload로 넘기는 것뿐, 폐기/재지급/화상
 * 판정은 전부 engine.js resolveCharacterSwap()이 한다. */
function renderCharSwapPicker(view, legal) {
  const S = window.STR;
  const picker = document.getElementById('ac-swap-picker');
  if (!picker) return;
  picker.innerHTML = `<h4>${S.character.SWAP.name} — ${S.action.charSwapPrompt}</h4>
    <div>${S.panel.swapCapLabel}: <b>${legal.swapCount}</b></div>
    <div>${S.panel.selectedCount}: <span id="swap-count">0</span> / ${legal.swapCount}</div>
    <div class="hand-grid" id="swap-hand"></div>
    <button id="btn-confirm-swap">${S.action.confirmCharSwap}</button>
    <button class="secondary" id="btn-cancel-swap">${S.action.cancelCharSwap}</button>`;

  const grid = document.getElementById('swap-hand');
  view.self.hand.forEach((card) => {
    const elCard = makeCardEl(card, {
      selected: charSwapSelectedIds.has(card.id),
      deferred: false,
      onClick: () => {
        if (charSwapSelectedIds.has(card.id)) {
          charSwapSelectedIds.delete(card.id);
        } else if (charSwapSelectedIds.size < legal.swapCount) {
          charSwapSelectedIds.add(card.id);
        }
        renderCharSwapPicker(view, legal);
      },
    });
    grid.appendChild(elCard);
  });
  document.getElementById('swap-count').textContent = String(charSwapSelectedIds.size);
  // ★★대회 치명 버그 수정 — 클릭 즉시 disabled + legal 스냅샷 전달. 0장 선택 상태의
  // 클릭(원래도 무시하던 케이스)은 disabled를 걸지 않는다 — bindOnceClick을 그대로
  // 쓰면 "선택 0장인 채로 확정을 눌러본" 클릭 한 번에 버튼이 영구 비활성화돼(카드를
  // 다시 골라 패널이 재렌더되기 전까지) 불필요한 회귀가 생긴다.
  const btnConfirmSwap = document.getElementById('btn-confirm-swap');
  btnConfirmSwap.addEventListener('click', () => {
    if (btnConfirmSwap.disabled) return;
    if (charSwapSelectedIds.size < 1) return; // 엔진 요구: 1장 이상(resolveCharacterSwap)
    btnConfirmSwap.disabled = true;
    const ids = Array.from(charSwapSelectedIds);
    charSwapSelectedIds = new Set();
    submitPlayerAction({ type: 'ACTION_CHOICE', actor: legal.actor, payload: { choice: 'CHAR_SWAP', swapDiscard: ids } }, legal);
  });
  document.getElementById('btn-cancel-swap').addEventListener('click', () => {
    charSwapSelectedIds = new Set();
    picker.innerHTML = '';
  });
}

/** ★D2(① CARD_DRAW_PICK 화면 — 게이트 최우선 항목) — SP 만충에서 'DRAW'를 고른 뒤
 * 도달하는 legal.type==='CARD_DRAW_PICK' 화면. ★구 renderDraftPanel(legal.type===
 * 'DRAFT_PICK')을 대체한다 — 구 3턴 주기 드래프트는 getLegalActions가 그 타입을
 * 다시는 반환하지 않는다(engine.js 확인, pendingQueue에 'DRAFT_PICK'을 세우는 지점이
 * 0건) — 그 상태에서 사람이 SP 만충 뽑기를 고르면 실제로 도달하는 타입은
 * 'CARD_DRAW_PICK'인데 renderActionPanel이 그걸 몰라 "unknown legal type
 * CARD_DRAW_PICK"으로 멈췄다(★실측 재현 — 이 정정 전 코드로 확인).
 *
 * 필드 대응(구→신, 값 의미는 같다): legal.offer→legal.offered · legal.full→
 * legal.cardsFull · legal.heldCards는 동일. ★G-A-10 "3장중 하나 뽑기" — 패스 경로가
 * 없다(resolveCardDrawPick은 offered에 없는 선택을 전부 거부, engine.js 확인) — 구판의
 * 패스 버튼(action.draftPass)은 여기서 없앤다(있으면 눌러도 엔진이 거부하는 죽은
 * 버튼이 된다). payload도 신 스키마({picked, discard?})로 보낸다.
 *
 * ★cardDrawOffer(조건부 필드) 자체는 여기서 읽지 않는다 — legal.offered가 이미
 * getLegalActions(engine.js)를 거쳐 나온 같은 원본이라(§ "getPublicView의
 * self.cardDrawOffer와 같은 원본을 공유") 중복 조회할 이유가 없다. 그 필드가
 * 조건부(뽑기 대기 중 + 본인일 때만)라는 사실은 renderActionPanel 쪽 dispatch가
 * legal.type==='CARD_DRAW_PICK'일 때만 이 함수를 부르는 것으로 이미 지켜진다. */
function renderCardDrawPickPanel(el, legal) {
  const S = window.STR;
  el.innerHTML = `<h3>${S.phase.CARD_DRAW_PICK}</h3><div id="draft-offer"></div>`;
  const offerBox = document.getElementById('draft-offer');
  const cfg = G.state.config;
  // ★verifier P0-2 FAIL 수정 — 이 화면은 항상 humanActor 본인 차례에만 뜬다
  // (renderActionPanel 디스패치가 legal.actor!==humanActor면 여기 오지도 않는다,
  // renderActionChoicePanel과 동일 전제). 아직 안 뽑은 카드라 mode='offer'(지금 이
  // 1장을 더 고르면 붙는 한계 이득) — 이미 보유한 카드 수는 view.self.cards에서 그대로 읽는다.
  // ★버그 수정(2026-08-19) — isWinner 추가(A8이 제시될 수 있어 renderActionChoicePanel과
  // 동일 근거). 이 화면도 항상 그 라운드 판정 직후에만 뜬다(같은 전제).
  const view = Engine.getPublicView(G.state, humanActor);
  const runtimeCtx = { cardTypes: view.self.cards, diamondStack: view.self.buffStacks['♦'], potValue: view.shared.pot.value, isWinner: isCurrentRoundWinner(view.self.actor) };

  function redraw() {
    offerBox.innerHTML = '';
    legal.offered.forEach((ct) => {
      // ★W-신규6 계승 — 제시 카드도 패시브/액티브 태그를 붙인다(R10-W가 보유 카드
      // 트레이에 이미 적용한 구분과 동일 규약, Engine.ACTIVE_SKILL_IDS 정본만 참조).
      const isActive = Engine.ACTIVE_SKILL_IDS.indexOf(ct) !== -1;
      let info = resolveSkillInfo(ct, S, cfg) || {};
      info = applyRuntimeShortOverride(ct, info, cfg, runtimeCtx, S, 'offer');
      const btn = document.createElement('button');
      btn.className = 'draft-offer-btn ' + (isActive ? 'active' : 'passive');
      // ★short(2026-08-19, 오너 요청) — 3장 중 1장을 고르는 판단 지점이라 short를 쓴다.
      btn.innerHTML = `<span class="draft-offer-tag">${isActive ? S.panel.cardsActiveLabel : S.panel.cardsPassiveLabel}</span><span class="draft-offer-name">${info.name || ct}</span><span class="draft-offer-desc">${info.short || ''}</span>`;
      if (draftPendingPick === ct) btn.classList.add('selected');
      // ★★대회 치명 버그 수정 — 만석이 아니면 이 클릭이 곧 확정 제출이므로 클릭 즉시
      // disabled + legal 스냅샷 전달. 만석이면 여기선 제출이 아니라 draftPendingPick만
      // 고르는 것(진짜 확정은 아래 heldCards 버튼)이라 disabled를 걸지 않는다.
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        if (!legal.cardsFull) {
          btn.disabled = true;
          submitPlayerAction({ type: 'CARD_DRAW_PICK', actor: legal.actor, payload: { picked: ct } }, legal);
          return;
        }
        draftPendingPick = ct;
        redraw();
      });
      offerBox.appendChild(btn);
    });

    if (legal.cardsFull) {
      const prompt = document.createElement('div');
      prompt.textContent = S.action.draftDiscardPrompt;
      offerBox.appendChild(prompt);
      // ★verifier UX 지적(2026-08-19) — 버릴 카드 버튼들이 처음엔 전부 disabled인데,
      // 순서를 모르면 "아무 반응 없는 버튼"으로 보인다. 구조 변경 없이(엔진 스키마상
      // picked 없이 discard만 보낼 수 없다 — resolveCardDrawPick 요구) 안내 문구
      // 한 줄만 추가. draftPendingPick이 이미 정해지면(=버튼이 활성화되면) 숨긴다.
      if (!draftPendingPick) {
        const orderHint = document.createElement('div');
        orderHint.className = 'hint';
        orderHint.textContent = S.action.draftDiscardOrderHint;
        offerBox.appendChild(orderHint);
      }
      legal.heldCards.forEach((ct) => {
        const btn = document.createElement('button');
        btn.className = 'secondary';
        btn.textContent = (resolveSkillInfo(ct, S) || {}).name || ct;
        btn.disabled = !draftPendingPick;
        // ★★대회 치명 버그 수정 — 클릭 즉시 disabled + legal 스냅샷 전달.
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          btn.disabled = true;
          submitPlayerAction(
            {
              type: 'CARD_DRAW_PICK',
              actor: legal.actor,
              payload: { picked: draftPendingPick, discard: ct },
            },
            legal
          );
        });
        offerBox.appendChild(btn);
      });
      // ★G-A-10 — 만석이어도 패스는 없다(3장 중 1장은 반드시 고르고, 버릴 카드만
      // 추가로 지정한다) — 구판의 draftPass 버튼을 의도적으로 재현하지 않는다.
    }
  }
  redraw();
}

// ---- 패→효과 리드아웃 --------------------------------------------------------
/**
 * ★R9-W2(2026-08-17, PM 전달 — 오너 2건째 제보 "얼마 회복/방어 버프 했는지 표시
 * 필요") — renderReadout이 "발동 효과" 줄에 실제 적용값을 붙이려고 그 라운드의
 * HEAL·BUFF_STACK·SP_CHANGE(reason==='club') 이벤트를 찾는다.
 *
 * ★오염 경계(qa-critic C3-3류 지적과 동일 원칙 적용) — 이 함수가 G.uiEvents에서
 * 읽는 이벤트 타입은 위 세 종류뿐이다. HAND_EVAL·ROUND_RESULT·SUIT_TRIGGER는
 * renderReadout 자신이 이미 정당하게 소비하는 지점(호출부에서 r.suitTrigger로 넘어옴)
 * 이라 예외지만, 이 함수 자체는 그 셋을 스캔하지 않는다. bestEquivalent·compareKey·
 * suitScore는 이 함수 어디서도 참조하지 않는다.
 *
 * 매칭 규칙(엔진 코드 확인 — engine.js applySuitEffect/resolveJudgment):
 *   - ♠/♦: BUFF_STACK, e.suit로 구분(한 라운드에 ♠·♦ 동시 트리거 가능 — simultaneousCount).
 *   - ♥: HEAL(그 라운드·그 actor에 최대 1건 — resolveSuitEffects가 승자에게만 적용).
 *   - ♣: SP_CHANGE 중 reason==='club'인 것만(같은 라운드에 win/lose/skillUse SP_CHANGE도
 *        섞여 있어 reason 없이 매칭하면 엉뚱한 값을 붙인다 — 실제로 확인된 함정).
 */
function findSuitAppliedEvent(events, round, actor, suit) {
  if (suit === '♠' || suit === '♦') {
    return events.find((e) => e.round === round && e.actor === actor && e.type === 'BUFF_STACK' && e.suit === suit) || null;
  }
  if (suit === '♥') {
    return events.find((e) => e.round === round && e.actor === actor && e.type === 'HEAL') || null;
  }
  if (suit === '♣') {
    return events.find((e) => e.round === round && e.actor === actor && e.type === 'SP_CHANGE' && e.reason === 'club') || null;
  }
  return null;
}

/** ★적용값 문구 조립 — S.effectInfo.applied(R9-W 배지 상세와 공유하는 용어, strings.js
 * 참조)만 쓴다. 값은 이벤트 필드를 그대로 옮길 뿐(effectValue/amount/delta는 엔진이 이미
 * 계산한 값 — fmtNum은 표시 자릿수만 정리할 뿐 산술을 하지 않는다, D4 정책 재사용). */
function renderSuitAppliedNote(suit, e, S) {
  if (!e) return '';
  const A = S.effectInfo.applied;
  if (suit === '♠' || suit === '♦') {
    const overflowNote = e.cappedOverflow > 0 ? ` (${fillTemplate(A.cappedOverflowNote, { n: e.cappedOverflow })})` : '';
    // ★D2 정정(⑥, ★실측 재현으로 발견) — BUFF_STACK.effectValue는 ♠일 때 정수 데미지
    // (after*atkPerStack)지만 ♦일 때는 D1이 확률(after*crit.chancePerStack, 0~1 소수)로
    // 재정의했다(engine.js applySuitEffect 실측 대조). fmtNum을 그대로 쓰면 "+0.1"처럼
    // 확률을 소수 그대로 노출해, 같은 개념을 %로 보여주는 배지 패널(EFFECT_BADGES
    // CRIT_BUFF.badgeText)과 라운드 리드아웃이 서로 다른 단위로 갈린다 — ♦만 %로 통일.
    const effectStr = suit === '♦' ? `${Math.round(e.effectValue * 100)}%` : fmtNum(e.effectValue);
    return ` · ${A.stackLabel} ${e.stackBefore}→${e.stackAfter} (${A.effectLabel} +${effectStr})${overflowNote}`;
  }
  if (suit === '♥') {
    const clampNote = e.clampedAtMax ? ` (${A.clampedAtMaxNote})` : '';
    return ` · ${A.healLabel} +${fmtNum(e.amount)} (${fmtNum(e.hpBefore)}→${fmtNum(e.hpAfter)})${clampNote}`;
  }
  if (suit === '♣') {
    const clampNote = e.clampedAtThreshold ? ` (${A.clampedAtThresholdNote})` : '';
    return ` · ${A.spGainLabel} +${fmtNum(e.delta)}${clampNote}`;
  }
  return '';
}

function renderReadout() {
  const S = window.STR;
  const el = document.getElementById('readout-panel');
  const r = G.lastReadout;
  if (!r || !r.A || !r.B || !r.result) {
    el.innerHTML = `<i>${S.panel.readoutNoResultYet}</i>`;
    return;
  }
  const lineFor = (actor) => {
    const hv = r[actor];
    // ★P1 수정 — round가 일치할 때만 G.submittedCards를 쓴다(위 rememberSubmittedCardsIfAny
    // 헤더 코멘트 참조). 불일치(다음 라운드가 이미 제출된 상태에서 이 판정 박스를 보는
    // 경우)면 raw id 목록(hv.evaluated, 그 라운드 HAND_EVAL에 고정)으로 안전하게
    // 폴백한다 — 덜 예쁘지만(글리프 대신 원시 id) 항상 정확하다.
    const rec = G.submittedCards[actor];
    const cards = rec && rec.round === r.round ? rec.cards : null;
    const glyphs = cards ? cardGlyphs(cards) : hv.evaluated.join(' '); // ★cardGlyphs — A9 공개표시(renderRevealedCardsNote)와 공유(중복 로직 제거)
    // ★hv.rankCategory는 engine.js가 이미 RANK_CATEGORY_NAMES로 문자열화해 이벤트에 실은 값(예: "ONE_PAIR").
    // ★오너 모드에서는 이 라운드별 "최강조합/최강 아님" 표시도 스킵 — G2 실시간 노출 4번째 지점(PM 지시,
    // 2026-08-15 스코프 확장). hv.bestEquivalent 자체는 손대지 않는다 — 표시 문자열만 조건부.
    const bestNote = ownerMode ? '' : ` (${hv.bestEquivalent ? S.panel.readoutBestNote : S.panel.readoutNotBestNote})`;
    // ★W2-5 — 와일드 배정(조커→구체 카드) 표시. ★타이밍: 이 함수(renderReadout)는
    // HAND_EVAL 이벤트가 이미 기록된 "제출 확정 後"에만 호출된다(G.lastReadout은
    // resolveJudgment가 판정을 끝낸 뒤에만 채워진다) — 제출 前 프리뷰(renderSubmitPreview)는
    // 이 필드를 절대 참조하지 않는다(qa-critic 지적: 프리뷰에 뜨면 "이 조합이 최강"이라는
    // 힌트가 된다). ★상대 라인은 배정을 보여주지 않는다 — TC_UI F19-07이 "상대 배정
    // 노출은 F11 정보 공개 위반"이라 명시했다(상대 제출 카드 자체는 쇼다운으로 이미
    // 공개되지만, 조커의 배정 해석은 별개 판단이라 자기 라인에만 노출 — 판단 근거는
    // 보고에 기록).
    const wildNote =
      actor === humanActor && hv.wildAssignment
        ? ` <span class="wild-assign">(${S.panel.wildAssignmentLabel}: ${S.panel.jokerLabel}→${hv.wildAssignment.suit}${Engine.cards.rankLabel(hv.wildAssignment.rank)})</span>`
        : '';
    // ★수트 효과 양측 표시(2026-08-19, web-engineer — 오너 요청 "턴 종료 후 수트
    // 효과가 어떻게 추가되는지") — r.suitTrigger[actor](위 absorbEventForDisplay 수정,
    // A/B 각자의 SUIT_TRIGGER)에서 이 actor 몫만 뽑는다. 로직은 구판(R9-W2)과 동일 —
    // findSuitAppliedEvent가 찾은 BUFF_STACK/HEAL/SP_CHANGE 이벤트의 실제 적용값을
    // 그대로 붙일 뿐 재계산하지 않는다. 승자·패자·무승부 구분 없이 둘 다 항상 그린다
    // (D1 확정 "수트는 양측 지급" — 내 것만 보이면 안 된다는 요구를 그대로 반영).
    const trig = r.suitTrigger && r.suitTrigger[actor];
    const suitLine =
      trig && trig.triggers && trig.triggers.length
        ? trig.triggers
            .map((t) => {
              const applied = findSuitAppliedEvent(G.uiEvents, r.round, actor, t.suit);
              return `${S.suit[t.suit]} Lv.${t.levelFinal}${renderSuitAppliedNote(t.suit, applied, S)}`;
            })
            .join(' · ')
        : '';
    return `<div>
      <div><b>${actor}</b>: ${glyphs} → <span class="rankcat">${S.rank[hv.rankCategory] || hv.rankCategory}</span>${bestNote}${wildNote}</div>
      ${suitLine ? `<div class="suit-applied-line">${S.panel.appliedEffectsLabel}: ${suitLine}</div>` : ''}
    </div>`;
  };
  el.innerHTML = `
    <h3>${S.panel.round} ${r.round} ${S.panel.roundResultTitle}</h3>
    ${lineFor('A')}
    ${lineFor('B')}
    <div>${S.outcome[r.result.outcome]} (${r.result.decidedBy})</div>
  `;
}

// ---- C-3: 전투 결과(기본 1줄 + 펼침 분해) --------------------------------------
/**
 * ★오염 차단(qa-critic C3-3 파생 재구성 지적 반영) — 이 섹션이 순회·참조하는 이벤트
 * 타입은 오직 ACTION_CHOICE·DAMAGE·STATUS_APPLY·A3_SCHEDULED·A3_DISCARD·SP_CHANGE·
 * HEAL·POT_CHANGE(★D2 정정 — 구 MULTIPLIER, D1이 전면 대체)·CHAR_SWAP(W2-4, 교체 발동
 * 폐기/재지급 기록)·★A6_RECOVER·FORCED_SUBMIT_MIN_APPLY·A9_REVEAL(W-신규6, 전부 이미
 * 공개된 이벤트 — D1과 무관, A9_REVEAL은 revealed 필드를 읽지 않고 장수만 노출)뿐이다. HAND_EVAL·
 * ROUND_RESULT·SUIT_TRIGGER는 이 섹션 어디서도 참조하지 않는다 — bestEquivalent·
 * compareKey는 물론, 제출 판정의 suitScore(=SUIT_TRIGGER의 levelFinal)도 여기
 * 등장하지 않는다. DAMAGE.sources[kind==='suitBuff']는 "버프 스택"
 * (과거 라운드까지 누적·상한(config.buff.stackCap, 현재 6)으로 캡핑된 값)일 뿐 이번
 * 제출의 원본 수트 레벨이 아니고, 이미 renderBattlefield()의 self/opponent 패널에
 * 상시 노출돼 있던 값과 동일하다(신규 노출 아님). 이 섹션은 자기 손패 전량이나 제출
 * 카드 5장을 렌더하지 않는다(그 둘은 각각 renderSubmitPanel/renderReadout의 별개
 * 코드가 맡고, 이 섹션은 그 코드를 호출하지도 재사용하지도 않는다) — ⓐ손패 ⓑ제출
 * 카드 ⓒ판정키/suitScore 3요소가 이 패널 하나에서 동시에 조립되는 경로 자체가 없다.
 * ★CHAR_SWAP도 같은 원칙 — discarded/received는 그 라운드 그 actor의 "이월분→새로
 * 뽑은 카드"일 뿐 손패 전량도 제출 카드 전량도 아니고, 상대 것이면 A3_DISCARD와
 * 동일하게 ID를 가린다(renderSubLines 참조). ★A6_RECOVER는 다르다 — 회수 대상은
 * "이번 라운드에 이미 제출해 쇼다운으로 공개된" 카드이므로(shared.lastRevealedSubmission
 * 경유로 양측에 이미 공개) actor 구분 없이 ID를 그대로 보여준다(D1 예외가 아니라
 * D1 적용 범위 밖 — 애초에 은닉 대상이 아니었던 카드).
 *
 * ★D3 정정(R4-W1b) — 구판은 이 섹션이 G.lastReadout(HAND_EVAL·ROUND_RESULT·
 * SUIT_TRIGGER만이 채우는 캐시)의 `.round`를 읽어 위 방어 주석("HAND_EVAL·ROUND_RESULT는
 * 참조하지 않는다")과 모순됐다(bestEquivalent까지 한 줄 거리). 지금은
 * findLastBattleRound()가 G.uiEvents를 직접 스캔해 ACTION_CHOICE(전투 라운드)·
 * ★D2 정정 — 구 MULTIPLIER(appliedThisRound) 대신 POT_CHANGE(trigger==='DRAW_GROWTH',
 * 무승부 라운드) 두 이벤트에서만 라운드 번호를 얻는다 — G.lastReadout을 아예 참조하지
 * 않는다. POT_CHANGE는 before/after/trigger/cap 등 판돈 수치만 실을 뿐 bestEquivalent·
 * compareKey·suitScore 무엇도 담지 않으므로 위 오염 차단 원칙과 충돌하지 않는다
 * (renderInstrumentPanel이 이미 같은 이벤트 타입을 원시로 읽던 선례가 있다).
 */

/** ★D4 — 표시 전용 반올림 정책(F6-18 재발 방지, D4). 원본 dmg/HP 값은 절대 변경하지
 * 않는다(엔진 state·이벤트 그대로 — 이 함수는 문자열 조립 직전에만 쓰인다).
 *
 * 정책: 정수면 정수 그대로, 비정수면 소수 4자리에서 반올림해 부동소수 노이즈만
 * 제거하고(예: 0.1+0.2류 오차가 27.500000000000004로 새어나오는 것을 막는다)
 * trailing 0은 String()이 자연히 잘라낸다 — 즉 "값이 원래 갖고 있던 자릿수 그대로"
 * 보여준다. ★고정 소수점 자릿수(예: toFixed(1))는 시도했다가 기각했다 — p5.factor=1.25
 * 처럼 소수 2자리가 필요한 값을 1자리로 자르면 배수가 1.3으로 보이는데 22×1.3=28.6은
 * 화면의 최종값 27.5(=22×1.25)와 안 맞아 보인다. 이건 renderBar처럼 정수로 뭉개는 것과
 * 똑같은 실패 — "분해식이 산수로 안 맞아 보인다"는 이 항목 자체가 막으려는 문제다.
 * 이 정책은 반대로 "필요한 자릿수는 그대로 보존"하므로 분해식·최종값·HP 전부가
 * 항상 실제 곱셈·뺄셈과 맞게 보인다(TC F18-12 반증 조건: 27.5류 표기 자체는 정상 —
 * 반올림 때문에 산수가 어긋나 보이는 것만 FAIL). */
function fmtNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n);
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10000) / 10000);
}

/** ACTION_CHOICE를 행 기준으로 삼아, 같은 라운드의 후속 이벤트를 그 행에 붙인다.
 * SUBMIT/HAND_EVAL/ROUND_RESULT/SUIT_TRIGGER/BUFF_STACK 등 첫 ACTION_CHOICE 이전
 * 이벤트는 current===null이라 자동 스킵된다. SP_CHANGE(win/lose)·STATUS_TICK·DEAL 등은
 * 캡처 목록에서 명시적으로 제외해 라운드 끝의 정산 이벤트가 마지막 행에 잘못 흡수되는
 * 것을 막는다. A3_DISCARD(대상의 "다음 보충" 완료 직후 발생 — 같은 라운드 안이지만
 * 위치가 뒤로 밀림)만 target 매칭으로 2차 패스에서 원래 행에 붙인다.
 * ★W2-4 — CHAR_SWAP(캐릭터 스킬 "교체")도 화이트리스트에 추가. isAttack:false라
 * DAMAGE가 없어 A3와 동일하게 이 캡처가 없으면 "교체" 사용이 로그에 아예 안 뜬다. */
function buildBattleLogForRound(events, round) {
  const roundEvents = events.filter((e) => e.round === round);
  const rows = [];
  let current = null;
  const scheduledByTarget = {};
  for (const e of roundEvents) {
    if (e.type === 'ACTION_CHOICE') {
      current = { actionEvent: e, sub: [] };
      rows.push(current);
      continue;
    }
    if (!current) continue;
    if (e.type === 'DAMAGE' || e.type === 'STATUS_APPLY') {
      current.sub.push(e);
    } else if (e.type === 'A3_SCHEDULED') {
      current.sub.push(e);
      scheduledByTarget[e.target] = current;
    } else if (e.type === 'SP_CHANGE' && e.reason === 'skillUse' && e.actor === current.actionEvent.actor) {
      current.sub.push(e);
    } else if (e.type === 'HEAL' && e.actor === current.actionEvent.actor) {
      current.sub.push(e); // ★현재 9종 카드로는 도달 불가 경로 — 미래 스킬 대비 방어적으로 포함
    } else if (e.type === 'CHAR_SWAP' && e.actor === current.actionEvent.actor) {
      current.sub.push(e); // ★W2-4 — 교체 발동 즉시(같은 ACTION_CHOICE 처리 안) 기록되는 이벤트
    } else if (e.type === 'A6_RECOVER' && e.actor === current.actionEvent.actor) {
      current.sub.push(e); // ★W-신규6(A6 물리기, 구 「환수」)
    } else if (e.type === 'FORCED_SUBMIT_MIN_APPLY' && e.actor === current.actionEvent.actor) {
      current.sub.push(e); // ★W-신규6(A7 쥐어짜기, 구 「강요」)
    } else if (e.type === 'POT_CHANGE' && e.trigger === 'A8_RAISE' && e.actor === current.actionEvent.actor) {
      // ★D2(③ 구 배수 잔재 정리) — 구 MULTIPLIER는 D1이 POT_CHANGE로 전면 대체했다
      // (engine.js EVENT_TYPE.POT_CHANGE). trigger 값('A8_RAISE')은 그대로 보존돼
      // 이 필터는 유지된다 — 타입명만 정정.
      current.sub.push(e); // ★W-신규6(A8 불지르기, 구 「판 키우기」)
    } else if (e.type === 'A9_REVEAL' && e.actor === current.actionEvent.actor) {
      current.sub.push(e); // ★W-신규6(A9 밑장 보기, 구 「투시」)
    }
  }
  for (const e of roundEvents) {
    if (e.type === 'A3_DISCARD') {
      const row = scheduledByTarget[e.target];
      if (row) row.sub.push(e);
    }
  }
  return rows;
}

/** ★D5 — 미등록 kind도 영문 enum을 그대로 내보내지 않는다(strings.js 폴백). */
function sourceLabel(s, S) {
  if (s.kind === 'job') return S.battle.sourceJob;
  if (s.kind === 'suitBuff') return `${s.ref}${S.battle.sourceSuitBuff}`;
  if (s.kind === 'card') return `${S.battle.sourceCard}(${s.ref})`;
  if (s.kind === 'character') return skillLabel(s.ref, S); // ★D5/F18-13 — 강타(CHAR_SMASH) 등
  return S.battle.unknownLabel;
}

/** ★D2(④ 데미지 표기 분해, F18-21) — 구 "직업10 + ♠버프12 = 22 × 배수1 − 방어0 = 22"
 * (dmg.multiplierApplied/defense/defensePosition 참조)는 D1이 폐지한 필드를 그대로
 * 읽고 있었다(★실측 확인 — 이 정정 전 코드로 renderBreakdown을 호출하면 세 필드 다
 * undefined라 화면에 "×undefined − undefined"가 그대로 떴다, 방어 축 자체가
 * config.buff.defPerStack과 함께 삭제됐다). 정본 4층 곱 파이프라인(resolveDamage,
 * engine.js 실측 대조) 그대로 4항을 분해해 보여준다 — 한 숫자로 뭉치지 않는다:
 *   기본+♠버프(=sources 합·sumRaw)  |  격차 배율(F/L)  |  판돈 배율  |  치명타 배율
 * dmg.factors{gap,pot,crit,skillBonus}(D1 신설)를 그대로 표시할 뿐 재계산하지 않는다.
 * ★role별 격차 배율 라벨 — 승자는 F, 패자는 L(dmg.role, dmg.gapDetail 그대로 — 두
 * 기호는 design doc §3의 수식 이름 그 자체라 번역 대상이 아니다, 기존 '×'·'−' 기호
 * 하드코딩 관례와 동일). ★치명타가 실제로 터진 순간(dmg.critApplied)은 강조 클래스로
 * 눈에 띄게 한다(요구사항 ④ "치명타가 터진 순간이 눈에 띄어야 한다"). */
function renderBreakdown(dmg, S) {
  const parts = dmg.sources.map((s) => `${sourceLabel(s, S)}${fmtNum(s.value)}`).join(' + ');
  const gapLabel = dmg.role === 'loser' ? 'L' : 'F';
  const gapPart = `${S.battle.gapMultiplierWord}(${gapLabel})${fmtNum(dmg.factors.gap)}`;
  const potPart = `${S.battle.potMultiplierWord}${fmtNum(dmg.factors.pot)}`;
  const critPartPlain = `${S.battle.critWord}${fmtNum(dmg.factors.crit)}`;
  const critPart = dmg.critApplied ? `<b class="crit-hit">${critPartPlain} (${S.battle.critHitTag})</b>` : critPartPlain;
  let text = `${parts} = ${fmtNum(dmg.sumRaw)} × ${gapPart} × ${potPart} × ${critPart} = ${fmtNum(dmg.final)}`;
  if (dmg.floored) text += ` ${S.battle.flooredNote}`;
  return text;
}

function renderSubLines(row, S) {
  const lines = [];
  for (const e of row.sub) {
    if (e.type === 'STATUS_APPLY') {
      const statusName = S.status[e.statusType] || e.statusType;
      const refreshedNote = e.refreshed ? ` — ${S.battle.statusRefreshed}` : '';
      lines.push(`${statusName} ${S.battle.statusAppliedWord}(${e.durationSet}${S.battle.turnsWord})${refreshedNote}`);
    } else if (e.type === 'A3_SCHEDULED') {
      lines.push(S.battle.a3ScheduledNote);
    } else if (e.type === 'A3_DISCARD') {
      // ★D1 — 상대 손패 카드는 어떤 경로로도 수트·랭크(카드 ID)가 드러나면 안 된다.
      // e.target(=e.actor, 폐기당한 쪽)이 humanActor면 자기 카드라 ID를 보여도 되고,
      // 아니면 "누구의 카드인지"만 밝히고 "무엇인지"는 가린다(getPublicView 화이트리스트
      // 우회 금지 — F18-16/F19-06).
      const isOwn = e.target === humanActor;
      const whoLabel = isOwn ? S.panel.self : S.panel.opponent;
      lines.push(
        isOwn
          ? `${S.battle.a3DiscardNote} (${whoLabel}): ${e.discardedCardId}`
          : `${S.battle.a3DiscardNote} (${whoLabel}) — ${S.battle.a3DiscardHidden}`
      );
    } else if (e.type === 'SP_CHANGE') {
      lines.push(`${S.panel.sp} ${fmtNum(e.before)}→${fmtNum(e.after)} (${S.battle.spUseNote})`); // ★D6 — 'SP' 하드코딩 제거(S.panel.sp 재사용)
    } else if (e.type === 'HEAL') {
      lines.push(`${S.panel.hp} +${fmtNum(e.amount)} (${fmtNum(e.hpBefore)}→${fmtNum(e.hpAfter)})`);
    } else if (e.type === 'CHAR_SWAP') {
      // ★W2-4 — A3_DISCARD와 동일 원칙(D1/F19-06). discarded/received는 그 actor
      // 자신의 손패 카드 ID다 — 자기 것(actor===humanActor)이면 그대로, 상대 것이면
      // 장수만 보여주고 ID는 가린다(getPublicView 화이트리스트 우회 금지).
      const isOwn = e.actor === humanActor;
      const burnedCount = e.burned.filter((b) => b.applied).length;
      const detail = isOwn ? `${e.discarded.join(', ')} → ${e.received.join(', ')}` : S.battle.a3DiscardHidden;
      const burnNote = burnedCount > 0 ? ` · ${S.battle.charSwapBurnLossWord} ${burnedCount}${S.battle.cardCountWord}` : '';
      lines.push(
        `${S.battle.charSwapDiscardWord} ${e.discardCount}${S.battle.cardCountWord} → ${S.battle.charSwapReceiveWord} ${e.received.length}${S.battle.cardCountWord} (${detail})${burnNote}`
      );
    } else if (e.type === 'A6_RECOVER') {
      // ★A6(물리기, 구 「환수」) — 회수 대상은 이번 라운드 쇼다운으로 이미 양측에 공개된 카드다(위
      // buildBattleLogForRound 헤더 주석 참조) — D1 예외가 아니라 애초에 은닉 대상이
      // 아니었던 카드라 actor 구분 없이 ID를 그대로 보여준다.
      lines.push(`${S.battle.a6RecoverNote} (${e.recovered.length}${S.battle.cardCountWord}): ${e.recovered.join(', ')}`);
    } else if (e.type === 'FORCED_SUBMIT_MIN_APPLY') {
      // ★A7(쥐어짜기, 구 「강요」) — 공개 규칙값(D1과 무관, self/opponent.forcedSubmitMin과 같은 층).
      lines.push(`${S.battle.a7ForceNote} → ${e.target} (${e.duration}${S.panel.round}, ${e.value}${S.battle.cardCountWord})`);
    } else if (e.type === 'POT_CHANGE' && e.trigger === 'A8_RAISE') {
      // ★D2(③ 구 배수 잔재 정리) — 구 MULTIPLIER → POT_CHANGE(D1 전면 대체, 타입명만 정정).
      lines.push(`${S.battle.a8RaiseNote} ×${fmtNum(e.before)} → ×${fmtNum(e.after)}`);
    } else if (e.type === 'A9_REVEAL') {
      // ★A9(밑장 보기, 구 「투시」) — ★D1 예외 ⓑ 준수: revealed(실제 카드 ID 목록)는 여기서 읽지 않는다
      // (내용은 opponent.revealedCards 경유 전용 표시 하나로만 노출 — renderRevealedCardsNote).
      // 여기서는 "무엇을 했는지"(장수·대상)만 보여준다.
      const isOwnTarget = e.target === humanActor;
      lines.push(`${S.battle.a9RevealNote} (${e.revealCount}${S.battle.cardCountWord}, ${isOwnTarget ? S.panel.self : S.panel.opponent})`);
    }
  }
  const dmg = row.sub.find((e) => e.type === 'DAMAGE');
  // ★D2(④ 치명타 표기, D1 신설 critRolled/critApplied/critChanceCapped) — 기존
  // statusRoll 판정 줄(화상 등 카드 확률)과 동일 관례로 매 DAMAGE마다 치명타 판정
  // 결과를 보여준다(항상 — 미발동도 보여야 발동 순간이 "대비돼" 눈에 띈다).
  // ★critRolled와 critApplied가 다를 수 있는 미래(에스컬레이션 강제, §15 TBD)를
  // 대비해 실제 적용 여부(critApplied)를 판정 결과로 쓴다 — 현재 구현은 항상 동일.
  if (dmg) {
    const critWord = dmg.critApplied ? S.battle.statusRollSuccess : S.battle.statusRollFail;
    const critLine = `${S.battle.critWord} ${S.battle.statusRollLabel}: ${critWord} (${Math.round(dmg.critChanceCapped * 100)}%)`;
    lines.push(dmg.critApplied ? `<b class="crit-hit">${critLine}</b>` : critLine);
  }
  if (dmg && dmg.statusRoll) {
    const sr = dmg.statusRoll;
    const statusName = S.status[sr.type] || sr.type;
    const resultWord = sr.applied ? S.battle.statusRollSuccess : S.battle.statusRollFail;
    // ★D6 — 원시 난수(sr.roll)는 화면에서 뺀다(오너에게 내부값을 보여줄 이유가 없다 —
    // 성공/실패면 충분). 내부 로그·export(dmg.statusRoll.roll)는 그대로 유지, 표시만 변경.
    lines.push(`${statusName} ${S.battle.statusRollLabel}: ${resultWord} (${Math.round(sr.chance * 100)}%)`);
  }
  return lines;
}

/** ★행동 종류(기본공격/스킬명)는 필수 노출(오너 문언 "어떤 공격을 해서") — chose==='SKILL'이면
 * 카드 이름, 아니면(BASIC_ATTACK·FALLBACK_NO_SKILL 둘 다 동일하게 기본공격으로 귀결) 기본 공격. */
function renderActionSummary(row, S) {
  const ae = row.actionEvent;
  const dmg = row.sub.find((e) => e.type === 'DAMAGE');
  // ★SG-A — 'CHAR_SKILL'(강타/교체)도 'SKILL'과 동일하게 라벨 조회가 필요하다. 구판은
  // 이 분기가 없어 강타/교체 사용이 항상 "기본 공격"으로 잘못 표시됐다.
  const label = ae.chose === 'SKILL' || ae.chose === 'CHAR_SKILL' ? skillLabel(ae.skillId, S) : S.action.basicAttack;
  if (dmg) {
    // ★D4 — fmtNum()으로 표시 통일(원본 dmg 값은 미변경).
    // ★D2(④ 치명타 표기) — 접힌 한 줄 요약에도 치명타 태그를 붙인다(펼치지 않아도
    // "터진 순간"이 보이게 — 요구사항 ④, renderBreakdown/renderSubLines와 동일 태그).
    const critTag = dmg.critApplied ? ` <b class="crit-hit">${S.battle.critHitTag}</b>` : '';
    return `${ae.actor}${S.battle.subjectParticle} [${label}] → ${dmg.target}${S.battle.targetParticle} ${fmtNum(dmg.final)} ${S.battle.damageWord}${critTag} (${S.battle.hpPrefix} ${fmtNum(dmg.targetHpBefore)}→${fmtNum(dmg.targetHpAfter)})`;
  }
  return `${ae.actor}${S.battle.subjectParticle} [${label}] ${S.battle.usedNoDamage}`;
}

function renderBattleLogRow(row, S) {
  const ae = row.actionEvent;
  const key = String(ae.seq);
  const expanded = battleLogExpanded.has(key);
  const summary = renderActionSummary(row, S);
  const dmg = row.sub.find((e) => e.type === 'DAMAGE');
  let detail = '';
  if (expanded) {
    const lines = [];
    if (dmg) lines.push(renderBreakdown(dmg, S));
    lines.push(...renderSubLines(row, S));
    detail = `<div class="battle-log-detail">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
  }
  return `<div class="battle-log-row">
    <button type="button" class="battle-log-toggle" data-seq="${key}">${expanded ? '▾' : '▸'} ${summary}</button>
    ${detail}
  </div>`;
}

/** ★D3 — 라운드 번호를 G.lastReadout이 아니라 G.uiEvents에서 직접 얻는다. 전투 라운드는
 * ACTION_CHOICE의 최대 round. 무승부 라운드는 "그 라운드에 ACTION_CHOICE가 아예 없다"는
 * 엔진 불변식(engine.js resolveJudgment()의 DRAW 분기는 ACTION_CHOICE를 만들기 전에
 * return한다)을 이용해, ★D2 정정(③ 구 배수 잔재 정리) — 구 MULTIPLIER(appliedThisRound)는
 * D1이 폐지했다(engine.js에 EVENT_TYPE.MULTIPLIER를 발행하는 코드가 0건 — 실측 grep
 * 대조, POT_CHANGE로 전면 대체). ★실측 확인한 회귀: 이 필드가 죽어 있어 maxMultRound가
 * 항상 -Infinity로 남고, 그 결과 무승부 라운드가 findLastBattleRound에서 절대 감지되지
 * 않아 battle-log 패널이 "아직 진행된 전투가 없습니다"(직전 판정이 실제로는 무승부인데도
 * 초기 상태 문구)로 잘못 표시되거나, 그 앞 전투 라운드가 마지막으로 잘못 표시됐다(오너
 * 보고 증상 "무승부 직후 배틀로그가 「전투」로 잘못 분류"의 원인 그대로). 대체 판별자:
 * POT_CHANGE 중 trigger==='DRAW_GROWTH'는 오직 무승부 판정 분기(resolveJudgment의 DRAW
 * 분기, applyPotGrowth 호출부)에서만 발행된다(engine.js 실측 대조 — 승부 판정 경로는
 * 이 trigger를 절대 발행하지 않는다) — 그 최대 round가 ACTION_CHOICE의 최대 round보다
 * 크면 그 라운드가 무승부였다고 판정한다. 반환: null(아직 판정된 라운드 없음) |
 * {kind:'combat', round} | {kind:'draw', round, before, after}. */
function findLastBattleRound(events) {
  let maxActionRound = -Infinity;
  let maxDrawRound = -Infinity;
  let drawEvent = null;
  for (const e of events) {
    if (e.type === 'ACTION_CHOICE' && e.round > maxActionRound) maxActionRound = e.round;
    if (e.type === 'POT_CHANGE' && e.trigger === 'DRAW_GROWTH' && e.round >= maxDrawRound) {
      maxDrawRound = e.round;
      drawEvent = e;
    }
  }
  if (maxActionRound === -Infinity && maxDrawRound === -Infinity) return null;
  if (maxDrawRound > maxActionRound) return { kind: 'draw', round: maxDrawRound, before: drawEvent.before, after: drawEvent.after };
  return { kind: 'combat', round: maxActionRound };
}

/** ★가장 최근에 "판정이 끝난" 라운드 하나만 보여준다(누적 이력 아님, 정보 과다 방지 —
 * director 확정 설계) — 라운드가 넘어갈 때마다 자동으로 최신 라운드로 갱신된다.
 * ★D2 — 무승부 라운드(ACTION_CHOICE 0건)를 "아직 진행된 전투가 없습니다"(초기 상태
 * 문구, noRound)로 오인시키지 않는다. 무승부는 판돈을 쌓는 핵심 이벤트이므로 전용
 * 문구 + 판돈 변화(before→after)를 낸다(② 판돈 가시화의 세 번째 노출 지점 — status-bar
 * 플래그·panel-shared 배너와 함께, 이 배틀로그 줄도 같은 데이터를 재확인시켜 준다). */
function renderBattleLogPanel() {
  const S = window.STR;
  const el = document.getElementById('battle-log-body');
  const last = findLastBattleRound(G.uiEvents);
  if (!last) {
    el.innerHTML = `<i>${S.battle.noRound}</i>`;
    return;
  }
  if (last.kind === 'draw') {
    el.innerHTML = `<i>${S.panel.round} ${last.round}: ${S.outcome.DRAW} — ${S.battle.drawNoBattle} (${S.panel.multiplier} ×${fmtNum(last.before)} → ×${fmtNum(last.after)})</i>`;
    return;
  }
  const rows = buildBattleLogForRound(G.uiEvents, last.round);
  if (!rows.length) {
    el.innerHTML = `<i>${S.battle.noRound}</i>`;
    return;
  }
  el.innerHTML = rows.map((row) => renderBattleLogRow(row, S)).join('');
}

/** ★펼침 토글 클릭 위임(boot()에서 1회 등록) — 엔진 스텝 없이 battleLogExpanded만
 * 갱신하고 renderBattleLogPanel()만 다시 그린다. */
function wireBattleLogDelegation() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.battle-log-toggle[data-seq]');
    if (!btn) return;
    const seq = btn.dataset.seq;
    if (battleLogExpanded.has(seq)) battleLogExpanded.delete(seq);
    else battleLogExpanded.add(seq);
    if (G) renderBattleLogPanel();
  });
}

// ---- 판 종료 요약 -------------------------------------------------------------
function renderSummary() {
  const S = window.STR;
  const el = document.getElementById('summary-panel');
  el.hidden = false;
  const endEvent = [...G.uiEvents].reverse().find((e) => e.type === 'GAME_END');
  if (!endEvent) {
    el.innerHTML = `<i>${S.summary.noEndEvent}</i>`;
    return;
  }
  el.innerHTML = `
    <h2>${S.summary.title}</h2>
    <div>${S.summary.winner}: <b>${endEvent.winner}</b></div>
    <div>${S.summary.rounds}: ${endEvent.rounds}</div>
    <div>${S.summary.hpFinal}: A=${endEvent.hpFinal[0]} / B=${endEvent.hpFinal[1]}</div>
    <div>${S.summary.terminalReason}: ${S.terminalReason[endEvent.terminalReason] || endEvent.terminalReason}</div>
  `;
}

// ---- 판정 계측(G1~G4 보조) ----------------------------------------------------
/**
 * ★W2-6 — 스킬 사용 집계가 'SKILL'(드래프트 액티브 A1~A4)만 세고 'CHAR_SKILL'(캐릭터
 * 기본 스킬, 강타/교체)을 제외했었다. 캐릭터 기본 스킬이 생긴 지금 "스킬을 몇 번
 * 썼나"를 CHAR_SKILL 없이 보여주면 실제 사용량과 어긋난다.
 *
 * ★선택: 두 종류를 합쳐서 "총 N건"으로 한 테이블에 보여주되, 열 하나("구분")로
 * 액티브/기본을 나눠 표시한다(완전 통합도, 완전 분리도 아닌 절충). 이유:
 *  ⓐ 완전 통합(구분 없이 하나로 뭉침)은 "스킬을 몇 번 썼나"라는 원래 질문에는
 *    답이 되지만, 강타/교체는 항상 선택지에 있어 SP 임계마다 사실상 상시 후보인
 *    반면 드래프트 액티브는 "그 라운드에 실제로 보유했는가"부터 걸린다 — 성격이
 *    달라 뭉치면 "이 판은 스킬을 많이 썼다"가 사실은 "캐릭터 기본만 계속 눌렀다"
 *    인 경우를 가릴 수 있다.
 *  ⓑ 완전 분리(테이블 2개)는 화면 공간을 늘리고, 어차피 표는 최근 10건 미리보기일
 *    뿐이라(전체 집계는 카운트 줄이 이미 담당) 분리 이득이 크지 않다.
 *  ⓒ ★내부 계측(G.uiEvents의 chose:'SKILL'|'CHAR_SKILL' 구분, B3 분자 정의 보호)은
 *    이 함수가 전혀 건드리지 않는다 — 여기서 하는 일은 표시용 필터링·라벨 조회뿐이다.
 * 라벨 조회는 resolveSkillInfo()(SG-A 정본 대응표)로 통일한다 — 구판의
 * `(S.card[e.skillId]||{}).name||e.skillId`는 CHAR_SMASH/CHAR_SWAP에 대해 항상
 * undefined라 이 집계에 CHAR_SKILL을 그냥 섞기만 했으면 영문 enum이 그대로 샜을 것이다.
 */
function renderInstrumentPanel() {
  const S = window.STR;
  const el = document.getElementById('instrument-body');
  const handEvals = G.uiEvents.filter((e) => e.type === 'HAND_EVAL');
  const notBest = handEvals.filter((e) => e.bestEquivalent === false);
  // ★D2(③ 구 배수 잔재 정리) — 구 MULTIPLIER(appliedThisRound)는 D1이 폐지했다(발행
  // 코드 0건 — findLastBattleRound 헤더 코멘트와 동일 실측 근거). POT_CHANGE 4종
  // trigger 전부(DRAW_GROWTH·WINNER_ATTACK_CONSUME·WINNER_DRAW_VANISH·A8_RAISE)를
  // 계측 대상으로 넓힌다 — 이 표는 "판돈에 무슨 일이 있었는지"를 보여주는 계측
  // 로그라 소진·소멸도 성장 못지않게 유의미하다(사용자 눈에 띄는 1차 표시는
  // renderStatusBar/renderBattlefield의 성장 배너·상한 배지가 담당 — 이 표는 2차
  // 상세 로그).
  const potEvents = G.uiEvents.filter((e) => e.type === 'POT_CHANGE');
  const skillUses = G.uiEvents.filter((e) => e.type === 'ACTION_CHOICE' && (e.chose === 'SKILL' || e.chose === 'CHAR_SKILL'));
  const activeCount = skillUses.filter((e) => e.chose === 'SKILL').length;
  const charCount = skillUses.filter((e) => e.chose === 'CHAR_SKILL').length;

  const g2rate = handEvals.length ? ((notBest.length / handEvals.length) * 100).toFixed(1) : '0.0';

  const potRows = potEvents
    .slice(-10)
    // ★D5와 동일 원칙 — trigger 영문 enum을 그대로 노출하지 않고 S.pot.trigger 대응표를 거친다.
    .map((e) => `<tr><td>${e.round}</td><td>×${fmtNum(e.before)}→×${fmtNum(e.after)}</td><td>${S.pot.trigger[e.trigger] || e.trigger}</td></tr>`)
    .join('');
  const skillRows = skillUses
    .slice(-10)
    .map((e) => {
      const info = resolveSkillInfo(e.skillId, S); // ★SG-A — 드래프트 스킬·캐릭터 스킬 통합 조회(D5 재발 방지)
      const kind = e.chose === 'CHAR_SKILL' ? S.summary.skillUsageCharLabel : S.summary.skillUsageActiveLabel;
      return `<tr><td>${e.round}</td><td>${e.actor}</td><td>${kind}</td><td>${(info && info.name) || e.skillId}</td></tr>`;
    })
    .join('');

  el.innerHTML = `
    ${ownerMode ? '' : `<div>${S.summary.g2Label}: <b>${notBest.length} / ${handEvals.length} (${g2rate}%)</b></div>`}
    <div style="margin-top:6px">${S.summary.multiplierEventsLabel} (최근 10건 / 총 ${potEvents.length}건)</div>
    <table class="log-table"><tr><th>${S.panel.round}</th><th>${S.panel.multiplier}</th><th>${S.panel.triggerHeader}</th></tr>${potRows}</table>
    <div style="margin-top:6px">${S.summary.skillUsageLabel} — ${S.summary.skillUsageActiveLabel} ${activeCount}건 / ${S.summary.skillUsageCharLabel} ${charCount}건 (최근 10건 / 총 ${skillUses.length}건)</div>
    <table class="log-table"><tr><th>${S.panel.round}</th><th>${S.panel.actorHeader}</th><th>${S.panel.skillKindHeader}</th><th>${S.panel.skillHeader}</th></tr>${skillRows}</table>
  `;
}

// ---- 로그 export(화면 텍스트 블록) --------------------------------------------
/** ★이번 판이 이미 terminal인데 아직 세션 배열에 반영 안 됐으면(예: 판 종료 렌더 직후
 * 바로 "내보내기 갱신"을 누른 경우) 먼저 반영한다 — 중복 push는 sessionExportCommitted로 방지. */
function commitSessionExportIfNeeded() {
  if (!G || !G.state.terminal || G.sessionExportCommitted) return;
  const replay = Engine.exportReplay(G.state); // ★엔진 함수 — {seed, config, actions, opts}, 재구현 없음
  sessionExports.push({
    game: sessionExports.length + 1,
    export: replay,
    // ★D7 — 엔진 replay 구조(export)와 완전히 분리된 필드. runSelfCheck()는 이 필드를
    // 전혀 참조하지 않고 Engine.exportReplay(G.state)를 독립적으로 다시 호출해
    // G.uiEvents와 비교하므로, 이 필드의 존재 여부는 정규화 해시 대조(diffEvents)
    // 결과에 어떤 영향도 주지 않는다. ★화면에는 절대 표시하지 않는다(export 전용).
    submitToggleCounts: G.submitToggleCounts,
    // ★R7-W — GAME_START.maxHpOverridden을 형제 필드로 실어 보낸다(exportReplay 출력 자체는
    // 무변경 — submitToggleCounts와 동일 패턴). 목적: HP를 바꾼 판은 재미·밸런스 판정
    // 표본에서 제외돼야 하는데, 이 기록이 없으면 정상 판과 조용히 섞인다(오너 요청 근거).
    maxHpOverridden: G.maxHpOverridden,
  });
  G.sessionExportCommitted = true;
}

/** "내보내기 갱신" 버튼 — 현재 판 하나가 아니라 세션에서 지금까지 끝난 "모든 판"의
 * export를 한 번에 보여준다(오너 안내문 3차 재심사 지적: 판마다 덮어써지던 문제 수정).
 * 각 항목의 .export는 g2FromExport.js가 그대로 받는 {seed, config, actions, opts} 형식 그대로다. */
function renderExportBlock() {
  commitSessionExportIfNeeded();
  document.getElementById('export-block').textContent = JSON.stringify(sessionExports, null, 2);
}

// ---- 브라우저 내 자기검증(엔진 공유 실증) --------------------------------------
async function runSelfCheck() {
  const S = window.STR;
  const el = document.getElementById('selfcheck-result');
  // ★verifier 지적(2026-08-19, P2-2) — 상시 노출 버튼인데 리터럴 4종을 갖고 있었다.
  // strings.js summary.replayCheck*로 옮긴다({count}/{seq}/{lenA}/{lenB}/{message}는
  // 전부 엔진 diff 결과·Error.message 그대로 — 재계산 없음).
  el.textContent = S.summary.replayCheckRunning;
  try {
    const replaySpec = Engine.exportReplay(G.state);
    const replayed = Engine.replay(replaySpec.seed, replaySpec.config, replaySpec.actions, replaySpec.opts); // ★엔진 함수
    const diff = Engine.normalize.diffEvents(G.uiEvents, replayed.events); // ★엔진 함수 — UI는 비교 안 함
    if (diff.equal) {
      el.innerHTML = `<span class="ok">${fillTemplate(S.summary.replayCheckOk, { count: G.uiEvents.length })}</span>`;
    } else {
      el.innerHTML = `<span class="fail">${fillTemplate(S.summary.replayCheckFail, { seq: diff.firstDiffIndex, lenA: diff.lengthA, lenB: diff.lengthB })}</span>`;
      console.error('selfcheck diff:', diff);
    }
  } catch (err) {
    el.innerHTML = `<span class="fail">${fillTemplate(S.summary.replayCheckError, { message: err.message })}</span>`;
    console.error(err);
  }
}

window.addEventListener('DOMContentLoaded', boot);
