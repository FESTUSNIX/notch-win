import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calc, format } from '../src/palette-calc.ts';

const answer = text => calc(text)?.text ?? null;

test('it does the arithmetic this codebase is actually full of', () => {
  assert.equal(answer('1900 * 56/117'), '909.401709402');
  assert.equal(answer('56/117'), '0.4786324786');
  assert.equal(answer('470 + 2*62'), '594');
});

test('precedence and parentheses are the ordinary ones', () => {
  assert.equal(answer('2 + 3 * 4'), '14');
  assert.equal(answer('(2 + 3) * 4'), '20');
  assert.equal(answer('-3 + 10'), '7');
  // Right-associative, the way every calculator does it: 512, not 64.
  assert.equal(answer('2^3^2'), '512');
});

test('a percentage added to something means a percentage OF it', () => {
  // ⚠️ 103.5, not 90.15. It is the only reading anyone means when they type
  // it, and getting it wrong is worse than not offering it at all.
  assert.equal(answer('90 + 15%'), '103.5');
  assert.equal(answer('200 - 10%'), '180');
  // On its own a percentage is just the fraction, which is a real answer.
  assert.equal(answer('20% of 90'), '18');
  assert.equal(answer('15%'), '0.15');
});

test('it refuses anything that is not arithmetic, and that is the point', () => {
  // Every line that parses grows a row at the TOP of the palette, so a grammar
  // that says yes too readily buries what was being searched for.
  assert.equal(calc('today'), null);
  assert.equal(calc('2026'), null);          // a bare number is not a question
  assert.equal(calc('agents'), null);
  assert.equal(calc('add task 2 things'), null);
  assert.equal(calc(''), null);
  assert.equal(calc('2 +'), null);           // half an expression is not one
  assert.equal(calc('((2)'), null);
  assert.equal(calc('1/0'), null);           // Infinity is not an answer
});

test('it is a parser, never eval', () => {
  // The string is not hostile — you typed it — but eval answers questions
  // nobody asked, and turns an accident into a side effect.
  assert.equal(calc('alert(1)'), null);
  assert.equal(calc('window.x + 1'), null);
  assert.equal(calc('[]+1'), null);
});

test('the row is grouped for reading and the clipboard gets the plain number', () => {
  assert.equal(calc('1234 * 1000').text, '1,234,000');
  assert.equal(calc('1234 * 1000').value, '1234000');
  assert.equal(format(0.1 + 0.2), '0.3');   // and not 0.30000000000000004
});
