import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGuide, checkLinks, slugify } from './check.ts';

const page = (body: string, front = 'title: A\ndescription: About A') => `---\n${front}\n---\n${body}\n`;
const SIDEBAR = JSON.stringify([{ label: 'All', items: ['', 'a'] }]);

/** Builds a repo root with docs/guide holding `files`, plus any extra repo files. */
function build(files: Record<string, string>, repo: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'guide-'));
  const dir = join(root, 'docs', 'guide');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  for (const [name, text] of Object.entries(repo)) writeFileSync(join(root, name), text);
  return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
}
const valid = (over: Record<string, string> = {}) => ({
  'index.md': page('Hello.'),
  'a.md': page('## One\n\ntext'),
  'sidebar.json': SIDEBAR,
  ...over,
});
function problems(files: Record<string, string>, repo: Record<string, string> = {}) {
  const b = build(files, repo);
  try {
    return checkGuide(b.dir, b.root);
  } finally {
    b.done();
  }
}

test('slugs follow GitHub', () => {
  assert.equal(slugify('Automatic approval (optional)'), 'automatic-approval-optional');
  assert.equal(slugify('What was tried against GitHub, and what was not'), 'what-was-tried-against-github-and-what-was-not');
  assert.equal(slugify('The file a team commits'), 'the-file-a-team-commits');
  assert.equal(slugify('The `.visto-ai.yml` file'), 'the-visto-aiyml-file');
  assert.equal(slugify('Backtest & replay'), 'backtest--replay');
  assert.equal(slugify('Read/write access'), 'readwrite-access');
  assert.equal(slugify('Version 1.2'), 'version-12');
  assert.equal(slugify('Café résumé'), 'café-résumé');
  assert.equal(slugify('snake_case - dash'), 'snake_case---dash');
});

test('a valid guide has no problems', () => {
  assert.deepEqual(problems(valid()), []);
});

test('a repeated heading gets -1, -2 for links', () => {
  const body = '## Same\n\n## Same\n\n## Same\n\n[x](#same) [y](#same-1) [z](#same-2) [w](#same-3)';
  const out = problems(valid({ 'a.md': page(body) }));
  assert.equal(out.length, 1);
  assert.match(out[0]!, /a\.md: .*#same-3/);
});

test('slugs with code, ampersand, slash, dot and accents resolve in links', () => {
  const body = '## The `.visto-ai.yml` file\n\n## Backtest & replay\n\n## Read/write\n\n## Café\n\n'
    + '[a](#the-visto-aiyml-file) [b](#backtest--replay) [c](#readwrite) [d](#café)';
  assert.deepEqual(problems(valid({ 'a.md': page(body) })), []);
});

test('a missing or empty frontmatter field is named', () => {
  assert.match(problems(valid({ 'a.md': page('## One', 'title: A') })).join('\n'), /a\.md: .*description/);
  assert.match(problems(valid({ 'a.md': page('## One', 'title: A\ndescription: ""') })).join('\n'), /a\.md: .*description/);
  assert.match(problems(valid({ 'a.md': page('## One', 'description: x') })).join('\n'), /a\.md: .*title/);
  assert.match(problems(valid({ 'a.md': '## One\n' })).join('\n'), /a\.md: .*title/);
});

test('a block-scalar description is accepted; one off the description line is refused', () => {
  assert.deepEqual(problems(valid({ 'a.md': page('## One', 'title: A\ndescription: >-\n  About A\n  and more') })), []);
  assert.deepEqual(problems(valid({ 'a.md': page('## One', 'title: A\ndescription: |\n  About A') })), []);
  assert.match(problems(valid({ 'a.md': page('## One', 'title: A\ndescription:\n  About A') })).join('\n'), /a\.md: .*on the `description:` line/);
  assert.match(problems(valid({ 'a.md': page('## One', 'title: A\n"description": About A') })).join('\n'), /a\.md: .*on the `description:` line/);
});

test('a body h1 outside fences is refused, inside fences is not', () => {
  assert.match(problems(valid({ 'a.md': page('# Big') })).join('\n'), /a\.md: .*# /);
  assert.deepEqual(problems(valid({ 'a.md': page('## One\n\n```sh\n# comment\n```') })), []);
  assert.deepEqual(problems(valid({ 'a.md': page('## One\n\n~~~\n# comment\n~~~') })), []);
});

test('a fence closes only on the same character, as long, without an info string', () => {
  // A ``` line inside a ~~~ fence, and a shorter or labelled ``` inside a longer one, do not close it.
  const body = '## One\n\n~~~\n```\n# still code\n~~~\n\n````\n```\n```sh\n# still code\n````\n\n## Two';
  assert.deepEqual(problems(valid({ 'a.md': page(body) })), []);
  const after = '## One\n\n```\n```\n# real heading';
  assert.match(problems(valid({ 'a.md': page(after) })).join('\n'), /a\.md: .*# /);
});

test('a level that skips is refused', () => {
  assert.match(problems(valid({ 'a.md': page('## A\n\n#### B') })).join('\n'), /a\.md: .*level/);
  assert.match(problems(valid({ 'a.md': page('### A') })).join('\n'), /a\.md: .*level/);
  assert.deepEqual(problems(valid({ 'a.md': page('## A\n\n### B\n\n#### C\n\n## D') })), []);
});

test('no index.md is refused', () => {
  const files: Record<string, string> = valid();
  delete files['index.md'];
  assert.match(problems(files).join('\n'), /index\.md/);
});

test('the sidebar must list every page once', () => {
  const sidebar = (items: string[]) => JSON.stringify([{ label: 'All', items }]);
  const extra = { 'b.md': page('## B') };
  assert.match(problems(valid({ ...extra, 'sidebar.json': sidebar(['', 'a']) })).join('\n'), /sidebar\.json: .*b/);
  assert.match(problems(valid({ 'sidebar.json': sidebar(['', 'a', 'ghost']) })).join('\n'), /sidebar\.json: .*ghost/);
  assert.match(problems(valid({ 'sidebar.json': sidebar(['', 'a', 'a']) })).join('\n'), /sidebar\.json: .*a.*more than once/);
  const noSidebar: Record<string, string> = valid();
  delete noSidebar['sidebar.json'];
  assert.match(problems(noSidebar).join('\n'), /sidebar\.json/);
});

test('a broken link or anchor is named', () => {
  const out = problems(valid({ 'a.md': page('## One\n\n[x](b.md) [y](a.md#nope) [z](#gone) [ok](a.md#one)') }));
  assert.equal(out.length, 3);
  assert.match(out.join('\n'), /a\.md: .*b\.md/);
  assert.match(out.join('\n'), /a\.md: .*#nope/);
  assert.match(out.join('\n'), /a\.md: .*#gone/);
});

test('links in code and absolute links are not checked', () => {
  const body = '## One\n\n`[x](nowhere.md)` and [web](https://example.com/x#y) [m](mailto:a@b.c)\n\n```\n[x](nowhere.md)\n```';
  assert.deepEqual(problems(valid({ 'a.md': page(body) })), []);
});

test('a link out of the guide resolves in the repo', () => {
  const readme = '# T\n\n## Licence\n';
  assert.deepEqual(problems(valid({ 'a.md': page('## One\n\n[x](../../README.md#licence)') }), { 'README.md': readme }), []);
  assert.match(problems(valid({ 'a.md': page('## One\n\n[x](../../README.md#nope)') }), { 'README.md': readme }).join('\n'), /#nope/);
  assert.match(problems(valid({ 'a.md': page('## One\n\n[x](../../MISSING.md)') }), { 'README.md': readme }).join('\n'), /MISSING/);
  assert.match(problems(valid({ 'a.md': page('## One\n\n[x](../../../outside.md)') })).join('\n'), /outside\.md/);
});

test('a link with a title is refused, naming the file and line', () => {
  const out = problems(valid({ 'a.md': page('## One\n\n[x](index.md "t")') }));
  assert.equal(out.length, 1);
  assert.match(out[0]!, /^a\.md: line \d+: .*title/);
});

test('a same-folder link to a file that is not a .md page is refused', () => {
  const out = problems(valid({ 'a.md': page('## One\n\n[x](sidebar.json)') }));
  assert.equal(out.length, 1);
  assert.match(out[0]!, /^a\.md: line \d+: .*sidebar\.json/);
});

test('a link into a subfolder is refused', () => {
  const b = build(valid({ 'a.md': page('## One\n\n[x](sub/x.md)') }));
  try {
    mkdirSync(join(b.dir, 'sub'));
    writeFileSync(join(b.dir, 'sub', 'x.md'), page('## X'));
    const out = checkGuide(b.dir, b.root);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /^a\.md: line \d+: .*sub\/x\.md/);
  } finally {
    b.done();
  }
});

test('anchors are checked only for .md targets', () => {
  assert.deepEqual(problems(valid({ 'a.md': page('## One\n\n[x](../../LICENSE#anything)') }), { LICENSE: 'MIT' }), []);
});

test('checkLinks runs the link check alone', () => {
  const b = build({}, { 'README.md': '# T\n\n## Docs\n\n[x](docs/guide/nope.md) [y](#docs) [z](#nope)\n' });
  try {
    const out = checkLinks(join(b.root, 'README.md'), b.root);
    assert.equal(out.length, 2);
    assert.match(out.join('\n'), /README\.md: .*nope\.md/);
    assert.match(out.join('\n'), /README\.md: .*#nope/);
  } finally {
    b.done();
  }
});

test('reference links, alerts and images are refused', () => {
  assert.match(problems(valid({ 'a.md': page('## One\n\n[x][r]\n\n[r]: https://example.com') })).join('\n'), /a\.md: .*reference/);
  assert.match(problems(valid({ 'a.md': page('## One\n\n> [!NOTE]\n> hi') })).join('\n'), /a\.md: .*alert/);
  assert.match(problems(valid({ 'a.md': page('## One\n\n![pic](../../x.png)') }), { 'x.png': '' }).join('\n'), /a\.md: .*image/);
  assert.deepEqual(problems(valid({ 'a.md': page('## One\n\n> A plain quote\n\n```\n![x](y)\n> [!NOTE]\n[r]: z\n```') })), []);
});

test('a # line the website reads as a heading is refused even when CommonMark sees code', () => {
  const longer = '## One\n\n````\n```\n# inside\n````';
  const info = '## One\n\n```\n```sh\n# inside\n```';
  const tab = '## One\n\n```\n\t```\n# inside\n```';
  for (const body of [longer, info, tab]) {
    const out = problems(valid({ 'a.md': page(body) }));
    assert.match(out.join('\n'), /a\.md: line \d+: .*body heading/, body);
  }
});

test('a link with a bad escape is a problem, not a crash', () => {
  assert.match(problems(valid({ 'a.md': page('## One\n\n[x](100%.md)') })).join('\n'), /a\.md: .*100%\.md/);
});

test('a bare # link is accepted', () => {
  assert.deepEqual(problems(valid({ 'a.md': page('## One\n\n[x](#)') })), []);
});

test('slugs trim and use only the text of a link', () => {
  assert.equal(slugify('  Spaced out  '), 'spaced-out');
  assert.equal(slugify('See [Status](#status)'), 'see-status');
});

test("the repository's guide is valid", () => {
  assert.deepEqual(checkGuide('docs/guide', '.'), []);
});

test("the README's links resolve", () => {
  assert.deepEqual(checkLinks('README.md', '.'), []);
});

test('the README links every page', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const page of readdirSync('docs/guide').filter((f) => f.endsWith('.md'))) {
    assert.ok(readme.includes(`docs/guide/${page}`), page);
  }
});

/**
 * The repository's Markdown and YAML files, found by walking the tree rather than asking git: CI runs the
 * tests in a container that has no git. Dependencies, build output, hidden folders other than `.github`,
 * and `docs/superpowers` (history, left as it was written) are skipped.
 */
function repoFiles(dir = '.'): string[] {
  const skip = new Set(['node_modules', 'dist', 'coverage']);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (skip.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) continue;
      if (path === 'docs/superpowers') continue;
      out.push(...repoFiles(path));
    } else if (/\.(md|yml)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

test('no file outside the history links to a gone README section or to docs/extensions.md', () => {
  const files = repoFiles();
  assert.ok(files.includes('README.md') && files.includes('docs/guide/index.md'), 'the walk found the repository');
  for (const file of files) {
    assert.deepEqual(checkLinks(file, '.'), [], file);
    assert.ok(!readFileSync(file, 'utf8').includes('docs/extensions.md'), `${file} names docs/extensions.md`);
  }
});
