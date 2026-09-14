import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionOf, iconFor } from '../src/file-kind.ts';

test('a file says what it is before you read its name', () => {
  assert.equal(iconFor('palette.ts', false), 'code');
  assert.equal(iconFor('hero.png', false), 'image');
  assert.equal(iconFor('invoice.PDF', false), 'pdf');       // case is not a kind
  assert.equal(iconFor('notes.md', false), 'text');
  assert.equal(iconFor('Brave.lnk', false), 'app');
  assert.equal(iconFor('setup.exe', false), 'exe');
});

test('a folder is a folder whatever it is called', () => {
  // ⚠️ Everything returns folders with dots in them — `nxm.public.www.2025` is
  // a real one on this machine, and reading its extension makes it a file.
  assert.equal(iconFor('nxm.public.www.2025', true), 'folder');
  assert.equal(iconFor('images', true), 'folder');
});

test('an unmapped extension degrades to the plain file glyph', () => {
  // The failure has to be soft: a missing entry stops helping, it never looks
  // broken.
  assert.equal(iconFor('data.qqq', false), 'file');
  assert.equal(iconFor('Makefile', false), 'file');
});

test('a dotfile has no extension', () => {
  // `.gitignore` is a file called .gitignore, not a "gitignore" file.
  assert.equal(extensionOf('.gitignore'), '');
  assert.equal(extensionOf('.env'), '');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('trailing.'), '');
  assert.equal(extensionOf('none'), '');
});
