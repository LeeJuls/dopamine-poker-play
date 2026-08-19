'use strict';

/**
 * proto/web/engine-loader.js
 *
 * ★proto/engine/는 임포트만 — 이 파일은 proto/engine/*.js의 소스 텍스트를 fetch로
 * 읽어 그 자리에서 CommonJS 래퍼(require/module/exports)를 흉내내 평가할 뿐,
 * 엔진 파일을 단 한 글자도 수정하지 않는다("proto/engine/ 수정 금지" 규율 준수).
 *
 * 빌드체인 없음 — 번들러·트랜스파일 0. 브라우저가 fetch()로 텍스트를 읽고
 * new Function(...)으로 즉시 평가하는 것뿐이다(엔진 자신이 "브라우저 전역
 * 무의존"으로 설계돼 있어 이 방식이 성립한다 — engine.js 파일 헤더 주석).
 *
 * 의존 순서(수동 위상정렬, proto/engine/*.js의 require() 그래프 조사로 확정):
 *   events → cards → rng → util → status → handEval → draft → aiRandom → ai
 *   → engine → normalize → index
 * (cli.js는 Node 전용 — fs/path를 쓰므로 로드하지 않는다. 브라우저엔 필요 없다.)
 */

(function () {
  const BASE = '../engine/';
  const JS_MODULES = [
    'events', 'cards', 'rng', 'util', 'status', 'handEval',
    'draft', 'aiRandom', 'ai', 'engine', 'normalize', 'index',
  ];
  const JSON_MODULES = ['config/current.json', 'config/best.json'];

  const registry = {};

  function resolveSpecifier(spec) {
    return spec.replace(/^\.\//, '');
  }

  // ★R4-W2 실측 함정 재발 방지 — 이 fetch에 캐시 지정이 없으면 브라우저가 이전 방문의
  // proto/engine/*.js를 그대로 서빙해 "코드는 최신인데 테스트만 거짓"이 되는 사고가
  // 난다(실제로 겪음: player.character가 undefined로 나오고 AI가 캐릭터 스킬을 아예
  // 안 냈다 — 원인은 브라우저가 J-5 이전 엔진 스냅샷을 캐시에서 서빙한 것뿐, 코드는
  // 멀쩡했다). cache:'no-store'로 매 로드마다 서버의 현재 파일을 강제로 받는다.
  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`engine-loader: fetch 실패 ${url} (${res.status})`);
    return res.text();
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`engine-loader: fetch 실패 ${url} (${res.status})`);
    return res.json();
  }

  /** loadAll: proto/engine/index.js와 동일한 module.exports 형태의 객체를 반환한다. */
  async function loadAll() {
    for (const rel of JSON_MODULES) {
      registry[rel] = await fetchJson(BASE + rel);
    }

    for (const name of JS_MODULES) {
      const rel = `${name}.js`;
      const text = await fetchText(BASE + rel);
      const mod = { exports: {} };
      const localRequire = function (spec) {
        const key = resolveSpecifier(spec);
        if (Object.prototype.hasOwnProperty.call(registry, key)) return registry[key];
        throw new Error(`engine-loader: "${name}.js"가 미리 로드되지 않은 모듈을 require했다: ${spec}`);
      };
      // Node의 모듈 래퍼(function(exports, require, module, __filename, __dirname){...})를
      // 최소 재현 — require/module/exports 3개만 있으면 proto/engine/*.js가 그대로 돈다.
      const wrapped = new Function('require', 'module', 'exports', `${text}\n//# sourceURL=proto/engine/${rel}`);
      wrapped(localRequire, mod, mod.exports);
      registry[name] = mod.exports;
    }

    return registry['index'];
  }

  window.EngineLoader = { loadAll };
})();
