#!/usr/bin/env node
'use strict';

/**
 * proto/engine/cli.js — 헤드리스 리플레이 CLI (S1 게이트 ⑤: 공통 검증 인프라).
 * 계약: --seed=N [--batch=M] [--policyA=L1] [--policyB=L1] [--replay=path.json]
 *       [--diff] [--out=path.json] [--config=path.json]
 *
 * exit code: 0 = 성공(요청한 동작이 전부 기대대로 끝남), 1 = 실패/예외.
 * 표준출력은 사람이 읽는 요약, --out을 주면 그 경로에 JSON 결과를 남긴다
 * (기계판독 형식 — verifier가 이 JSON을 파싱해 PASS/FAIL을 판정한다).
 */

const fs = require('fs');
const path = require('path');
const engine = require('./index');
const { diffEvents, normalizeToString } = require('./normalize');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function loadConfig(p) {
  if (!p) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeOut(outPath, obj) {
  if (!outPath) return;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2), 'utf8');
}

function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig(args.config);
  const policyA = args.policyA || 'L1';
  const policyB = args.policyB || 'L1';

  if (args.replay) {
    const spec = JSON.parse(fs.readFileSync(args.replay, 'utf8'));
    const { state, events } = engine.replay(spec.seed, spec.config, spec.actions, spec.opts);
    const result = {
      mode: 'replay',
      seed: spec.seed,
      rounds: state.round,
      terminal: state.terminal,
      terminalReason: state.terminalReason,
      winner: state.winner,
      eventCount: events.length,
      normalizedHash: require('crypto').createHash('sha256').update(normalizeToString(events)).digest('hex'),
    };
    console.log(JSON.stringify(result, null, 2));
    writeOut(args.out, result);
    process.exit(0);
    return;
  }

  if (args.diff) {
    // --diff: 같은 시드로 2회 실행해 이벤트 로그 diff를 확인(게이트 ①)
    const seed = Number(args.seed || 1);
    const run1 = engine.autoPlayGame(seed, config, policyA, policyB);
    const run2 = engine.autoPlayGame(seed, config, policyA, policyB);
    const d = diffEvents(run1.events, run2.events);
    const result = { mode: 'diff', seed, equal: d.equal, detail: d.equal ? null : d };
    console.log(JSON.stringify(result, null, 2));
    writeOut(args.out, result);
    process.exit(d.equal ? 0 : 1);
    return;
  }

  const seed = Number(args.seed || 1);
  const batch = Number(args.batch || 1);
  const { results, summary } = engine.runBatch(seed, batch, config, policyA, policyB);

  const terminalReasons = {};
  for (const r of results) {
    if (r.exception) continue;
    terminalReasons[r.state.terminalReason] = (terminalReasons[r.state.terminalReason] || 0) + 1;
  }

  const out = {
    mode: 'batch',
    seedStart: seed,
    count: batch,
    policyA,
    policyB,
    summary,
    terminalReasons,
    exceptions: results.filter((r) => r.exception).map((r, i) => ({ seed: seed + i, message: r.exception })),
  };
  console.log(JSON.stringify(out, null, 2));
  writeOut(args.out, out);
  process.exit(summary.exceptions === 0 ? 0 : 1);
}

main();
