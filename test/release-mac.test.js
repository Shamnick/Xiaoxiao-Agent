'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectSigner, certifyImage, releaseConfig } = require('../scripts/release-mac.cjs');

const hash = 'A'.repeat(40);
const otherHash = 'B'.repeat(40);
const team = '123456ABCD';
const developer = '  1) ' + hash + ' "Developer ID Application: Studio (' + team + ')"';
const other = developer.replace(hash, otherHash);
const inputs = {app:'Xiaoxiao Agent.app', dmg:'image.dmg', team, profile:'fixture-profile'};

test('the distribution path pins a valid Developer ID identity and rejects ambiguous signers', () => {
  const development = developer.replace('Developer ID Application', 'Apple Development');
  assert.throws(() => selectSigner(development), /找不到/);
  assert.throws(() => selectSigner(developer + '\n' + other), /多个/);
  assert.throws(() => selectSigner(developer, otherHash), /找不到/);
  const signer = selectSigner([development, developer, other].join('\n'), otherHash.toLowerCase());
  assert.deepEqual(signer, {hash:otherHash, team});
  const config = releaseConfig(signer, 'stage');
  assert.equal(config.mac.identity, otherHash);
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.dmg.sign, true);
  assert.equal(config.dmg.writeUpdateInfo, false);
});

test('certification checks both signatures and the actual submitted disk image', () => {
  const calls = [];
  certifyImage(inputs, (file,args) => {
    calls.push([file,...args]);
    if (args[0] === 'notarytool') return '{"status":"Accepted","id":"fixture"}';
  });
  const submit = calls.findIndex(call => call.includes('submit'));
  const signatures = calls.slice(0,submit);
  assert(signatures.some(call => call.includes('--deep') && call.at(-1) === inputs.app));
  for (const file of [inputs.app,inputs.dmg]) {
    assert(signatures.some(call => call.at(-1) === file && call.some(arg => arg.startsWith('-R=') && arg.includes(team))));
  }
  assert(calls[submit].includes(inputs.dmg));
  assert(calls[submit].includes(inputs.profile));
  assert.deepEqual(calls.slice(submit + 1).map(call => [call[1],call.at(-1)]), [
    ['stapler',inputs.dmg],['stapler',inputs.dmg],['--verify',inputs.dmg],['--assess',inputs.dmg]
  ]);
  assert.equal(calls[submit + 1][2],'staple');
  assert.equal(calls[submit + 2][2],'validate');
});

test('invalid signatures, failed submissions, or missing tickets stop the release', () => {
  for (const step of ['--verify','submit','staple','validate','--assess']) {
    let last;
    assert.throws(() => certifyImage(inputs, (_,args) => {
      last = args;
      if (args.includes(step)) {
        if (step === 'submit') return '{"status":"Invalid","id":"example"}';
        throw Error(step);
      }
      if (args.includes('submit')) return '{"status":"Accepted"}';
    }));
    assert(last.includes(step));
  }
});
