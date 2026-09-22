import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSafeErrorInfo, isTechnicalOrSensitive } from '../safeErrors.ts';

test('safeErrors: maps 401 status to unauthorized category', () => {
  const info = getSafeErrorInfo({ status: 401 });
  assert.equal(info.category, 'unauthorized');
  assert.equal(info.title, 'Session Expired');
  assert.equal(info.actionType, 'home');
});

test('safeErrors: maps 403 status to forbidden category with safe message', () => {
  const info = getSafeErrorInfo({ status: 403 });
  assert.equal(info.category, 'forbidden');
  assert.equal(info.title, 'Access Denied');
  assert.equal(info.message, "You don't have permission to perform this action.");
  assert.equal(info.actionType, 'back');
});

test('safeErrors: maps 404 status to not-found category', () => {
  const info = getSafeErrorInfo({ status: 404 });
  assert.equal(info.category, 'not-found');
  assert.equal(info.title, 'Page Not Found');
  assert.equal(info.actionType, 'home');
});

test('safeErrors: maps 429 status to rate-limited category', () => {
  const info = getSafeErrorInfo({ status: 429 });
  assert.equal(info.category, 'rate-limited');
  assert.equal(info.title, 'Too Many Requests');
  assert.equal(info.actionType, 'retry');
});

test('safeErrors: maps 500/503 status to server-error category without internal details', () => {
  const info = getSafeErrorInfo({ status: 500, message: 'SELECT * FROM users WHERE id = 123' });
  assert.equal(info.category, 'server-error');
  assert.equal(info.title, 'Service Unavailable');
  assert.match(info.message, /temporarily unavailable/);
  assert.equal(info.actionType, 'retry');
  assert.equal(isTechnicalOrSensitive(info.message), false);
});

test('safeErrors: maps fetch TypeError (network failure) to backend-unavailable', () => {
  const networkErr = new TypeError('Failed to fetch');
  const info = getSafeErrorInfo(networkErr);
  assert.equal(info.category, 'backend-unavailable');
  assert.equal(info.title, "Can't Connect");
  assert.equal(info.message, 'Pookie Chat is having trouble connecting right now. Please try again.');
  assert.equal(info.actionType, 'retry');
});

test('safeErrors: maps unknown error to generic safe error', () => {
  const info = getSafeErrorInfo(new Error('SyntaxError: Unexpected token < in JSON at position 0'));
  assert.equal(info.category, 'unknown');
  assert.equal(info.title, 'Something Went Wrong');
  assert.equal(info.message, "We couldn't complete that action. Please try again.");
  assert.equal(info.actionType, 'retry');
  assert.equal(isTechnicalOrSensitive(info.message), false);
});

test('safeErrors: detects browser offline state', () => {
  const origWindow = (globalThis as any).window;
  const origOnLine = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine');
  try {
    (globalThis as any).window = {};
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    const info = getSafeErrorInfo(new Error('Any error while offline'));
    assert.equal(info.category, 'offline');
    assert.equal(info.title, 'No Internet Connection');
    assert.equal(info.message, 'Check your connection and try again.');
    assert.equal(info.actionType, 'retry');
  } finally {
    (globalThis as any).window = origWindow;
    if (origOnLine) {
      Object.defineProperty(globalThis.navigator, 'onLine', origOnLine);
    } else {
      delete (globalThis.navigator as any).onLine;
    }
  }
});

