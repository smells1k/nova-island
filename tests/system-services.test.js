'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const systemServices = require('../system-services');

test('ping target validation accepts IPs and safe hostnames, rejects shell-like input', () => {
  assert.equal(systemServices.validatePingTarget('8.8.8.8'), '8.8.8.8');
  assert.equal(systemServices.validatePingTarget('example.org'), 'example.org');
  assert.equal(systemServices.validatePingTarget('example.org.'), 'example.org');
  assert.equal(systemServices.validatePingTarget('8.8.8.8 & whoami'), '');
  assert.equal(systemServices.validatePingTarget('example.org\n-n 100'), '');
  assert.equal(systemServices.validatePingTarget('-n 100'), '');
  assert.equal(systemServices.validatePingTarget('a..b'), '');
});

test('ping output parser handles English and Russian Windows/Linux formats', () => {
  assert.equal(systemServices.parsePingTime('Reply from 8.8.8.8: time=12.4 ms'), 12.4);
  assert.equal(systemServices.parsePingTime('Ответ от 8.8.8.8: время=7мс'), 7);
  assert.equal(systemServices.parsePingTime('time<1ms'), 1);
  assert.equal(systemServices.parsePingTime('Request timed out'), null);
});

test('semantic release comparison detects only newer published versions', () => {
  assert.equal(systemServices.isVersionNewer('v1.4.0', '1.3.9'), true);
  assert.equal(systemServices.isVersionNewer('1.3.0', '1.3.0'), false);
  assert.equal(systemServices.isVersionNewer('v1.2.0', '1.3.0'), false);
  assert.equal(systemServices.isVersionNewer('release notes', '1.3.0'), false);
});

test('system monitor returns bounded CPU and memory measurements', async () => {
  const snapshot = await systemServices.getMachineSnapshot();
  assert.equal(snapshot.ok, true);
  assert.ok(snapshot.ramTotalBytes > 0);
  assert.ok(snapshot.ramUsedBytes >= 0);
  assert.ok(snapshot.ramPercent >= 0 && snapshot.ramPercent <= 100);
  assert.ok(snapshot.cpuPercent === null || (snapshot.cpuPercent >= 0 && snapshot.cpuPercent <= 100));
  assert.ok(snapshot.sampledAt > 0);
});

test('invalid ping input fails before invoking the operating system', async () => {
  const result = await systemServices.pingHost('bad host; echo unsafe');
  assert.equal(result.ok, false);
  assert.equal(result.host, '');
  assert.match(result.message, /корректный адрес/i);
});
