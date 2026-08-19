'use strict';

/**
 * proto/engine/index.js — 엔진 패키지 진입점.
 * Node.js CommonJS(require/module.exports), 외부 의존성 0, 브라우저 호환
 * (fs/path 등 Node 전용 API를 core 모듈 어디서도 쓰지 않는다 — cli.js만 예외).
 */

const engine = require('./engine');
const rng = require('./rng');
const cards = require('./cards');
const handEval = require('./handEval');
const events = require('./events');
const status = require('./status');
const draft = require('./draft');
const normalize = require('./normalize');
const util = require('./util');
const ai = require('./ai');
const aiRandom = require('./aiRandom');

module.exports = Object.assign(
  {},
  engine,
  {
    rng,
    cards,
    handEval,
    events,
    status,
    draft,
    normalize,
    util,
    ai,
    aiRandom,
  }
);
