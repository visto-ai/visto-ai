import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { ConfigError, contractFile, parseConfig, repoConfigFor, repoSettingsFor, serviceConfig } from './load.ts';

const minimal = 'model:\n  apiKey: { env: MODEL_KEY }\n  model: vendor/model-a\n';

test('defaults', () => {
  const c = parseConfig(minimal, { MODEL_KEY: 'k' });
  assert.equal(c.model.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(c.model.apiKey, 'k');
  assert.deepEqual(c.limits, { inputTokensPerCall: 200000, batchesPerReview: 6, spendPerDay: 50, queueConcurrency: 2 });
  assert.equal(c.model.timeoutSeconds, 240);
});

test('an unknown key is an error that names it', () => {
  assert.throws(
    () => parseConfig(minimal + 'modle: {}\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e.issues.some((i) => i.includes('modle')),
  );
});

test('a missing secret names its variable and never prints a value', () => {
  assert.throws(
    () => parseConfig(minimal, { OTHER_KEY: 'sk-other-value-77' }),
    (e: ConfigError) =>
      e.issues.join().includes('MODEL_KEY') && !e.message.includes('sk-other-value-77') && !e.issues.join().includes('sk-other-value-77'),
  );
});

test('a secret written inline is rejected and never printed', () => {
  assert.throws(
    () => parseConfig('model:\n  apiKey: sk-inline\n  model: m\n', {}),
    (e: ConfigError) => e instanceof ConfigError && !e.message.includes('sk-inline') && !e.issues.join().includes('sk-inline'),
  );
});

test('effort fragments pass through untouched', () => {
  const c = parseConfig(minimal + '  effort:\n    elevated: { reasoning: { effort: high } }\n', { MODEL_KEY: 'k' });
  assert.deepEqual(c.model.effort.elevated, { reasoning: { effort: 'high' } });
});

test('repository overrides fall back to defaults', () => {
  const c = parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { primaryBranches: [trunk] }\n', { MODEL_KEY: 'k' });
  assert.deepEqual(repoConfigFor(c, 'acme/shop').primaryBranches, ['trunk']);
  assert.deepEqual(repoConfigFor(c, 'acme/other').primaryBranches, ['main', 'master']);
});

test('the example file parses', () => {
  const text = readFileSync(new URL('../../config.example.yml', import.meta.url), 'utf8');
  const c = parseConfig(text, { OPENROUTER_API_KEY: 'k' });
  assert.equal(c.model.apiKey, 'k');
});

// Removes the "# " after the indent of `first` from that line and from the commented lines that follow it at that indent.
function uncomment(text: string, first: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(first);
  assert.notEqual(start, -1, first);
  const indent = first.slice(0, first.indexOf('#'));
  for (let i = start; i < lines.length && lines[i]!.startsWith(`${indent}#`); i += 1) {
    lines[i] = indent + lines[i]!.slice(indent.length).replace(/^# ?/, '');
  }
  return lines.join('\n');
}
const example = (): string => readFileSync(new URL('../../config.example.yml', import.meta.url), 'utf8');
const exampleEnv = { OPENROUTER_API_KEY: 'k', SCORER_API_KEY: 'scorer-key' };

test('the example file as shipped names no scorer and has a threshold of 70', () => {
  const c = parseConfig(example(), exampleEnv);
  assert.equal(c.scorer, null);
  assert.equal(c.repositories.defaults.scoreThreshold, 70);
});

test('the example with its scorer block switched on is refused until its threshold is written', () => {
  const withScorer = uncomment(example(), '# scorer:');
  assert.throws(
    () => parseConfig(withScorer, exampleEnv),
    (e: ConfigError) => e.issues.includes('repositories.defaults.score.threshold: must be written when scorer is set'),
  );
  const c = parseConfig(uncomment(withScorer, '    # score:'), exampleEnv);
  assert.notEqual(c.scorer, null);
  assert.equal(c.repositories.defaults.scoreThreshold, 70);
});

test('a YAML syntax error never echoes file text', () => {
  const text = 'model:\n  apiKey: sk-SECRET123\n  model: [m\n';
  assert.throws(
    () => parseConfig(text, {}),
    (e: ConfigError) => e instanceof ConfigError && !e.message.includes('SECRET123') && !e.issues.join().includes('SECRET123') && !e.issues.join().includes('[m'),
  );
});

test('model.timeoutSeconds is at most 300', () => {
  assert.equal(parseConfig(minimal + '  timeoutSeconds: 300\n', { MODEL_KEY: 'k' }).model.timeoutSeconds, 300);
  assert.throws(
    () => parseConfig(minimal + '  timeoutSeconds: 301\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('model.timeoutSeconds')),
  );
});

test('limits.inputTokensPerCall is at least 10,000', () => {
  const at = (n: number): string => `${minimal}limits:\n  inputTokensPerCall: ${n}\n`;
  assert.equal(parseConfig(at(10_000), { MODEL_KEY: 'k' }).limits.inputTokensPerCall, 10_000);
  assert.throws(() => parseConfig(at(9_999), { MODEL_KEY: 'k' }), (e: ConfigError) => e.issues.some((i) => i.startsWith('limits.inputTokensPerCall')));
});

test('model.baseUrl must be an http or https URL', () => {
  const at = (url: string): string => `${minimal}  baseUrl: '${url}'\n`;
  assert.equal(parseConfig(at('http://localhost:8080/v1'), { MODEL_KEY: 'k' }).model.baseUrl, 'http://localhost:8080/v1');
  assert.equal(parseConfig(at('https://models.example.test/api'), { MODEL_KEY: 'k' }).model.baseUrl, 'https://models.example.test/api');
  for (const bad of ['not a url', 'ftp://models.example.test', 'file:///etc/models', 'javascript:alert(1)', '//models.example.test']) {
    assert.throws(() => parseConfig(at(bad), { MODEL_KEY: 'k' }), (e: ConfigError) => e.issues.some((i) => i.startsWith('model.baseUrl')) && !e.message.includes(bad), bad);
  }
});

const score = (body: string) => minimal + `repositories:\n  defaults: { score: ${body} }\n`;
const threshold = (name: string) => repoConfigFor(parseConfig(minimal, { MODEL_KEY: 'k' }), name).scoreThreshold;

test('the threshold defaults to 70', () => assert.equal(threshold('acme/shop'), 70));

test('a repository can lower it', () => {
  const c = parseConfig(
    minimal + 'repositories:\n  defaults: { score: { threshold: 80 } }\n  overrides:\n    acme/shop: { score: { threshold: 40 } }\n',
    { MODEL_KEY: 'k' },
  );
  assert.equal(repoConfigFor(c, 'acme/shop').scoreThreshold, 40);
  assert.equal(repoConfigFor(c, 'acme/other').scoreThreshold, 80);
});

test('an override that sets only primaryBranches keeps the default threshold', () => {
  const c = parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { primaryBranches: [trunk] }\n', { MODEL_KEY: 'k' });
  assert.deepEqual(repoConfigFor(c, 'acme/shop'), { primaryBranches: ['trunk'], scoreThreshold: 70 });
});

test('0, 101, 69.5 and an unknown key in score are errors', () => {
  for (const body of ['{ threshold: 0 }', '{ threshold: 101 }', '{ threshold: 69.5 }', '{ threshold: 70, auto: true }']) {
    assert.throws(
      () => parseConfig(score(body), { MODEL_KEY: 'k' }),
      (e: ConfigError) => e instanceof ConfigError && e.issues.some((i) => i.startsWith('repositories.defaults.score')),
      body,
    );
  }
  assert.throws(
    () => parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { score: { threshold: 101 } }\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('repositories.overrides.acme/shop.score')),
  );
});

test('a repository override applies whatever the letter case of the name', () => {
  const c = parseConfig(minimal + 'repositories:\n  overrides:\n    Acme/Shop: { score: { threshold: 40 } }\n', { MODEL_KEY: 'k' });
  assert.equal(repoConfigFor(c, 'acme/shop').scoreThreshold, 40);
  assert.equal(repoConfigFor(c, 'ACME/SHOP').scoreThreshold, 40);
  assert.equal(repoConfigFor(c, 'acme/other').scoreThreshold, 70);
});

test('two override keys that differ only by letter case are refused', () => {
  assert.throws(
    () => parseConfig(minimal + 'repositories:\n  overrides:\n    acme/shop: { score: { threshold: 40 } }\n    Acme/Shop: { score: { threshold: 90 } }\n', { MODEL_KEY: 'k' }),
    (e: ConfigError) => e instanceof ConfigError && e.issues.some((i) => i.startsWith('repositories.overrides')),
  );
});

const withScorer = minimal + 'scorer:\n  apiKey: { env: SCORER_KEY }\n  model: vendor/decider\n';
const writtenThreshold = 'repositories:\n  defaults:\n    score:\n      threshold: 80\n';
const scorerEnv = { MODEL_KEY: 'k', SCORER_KEY: 'scorer-secret-value' };

test('without a scorer block the scorer is null', () => {
  assert.equal(parseConfig(minimal, { MODEL_KEY: 'k' }).scorer, null);
});

test('a scorer block with the threshold written gets its defaults and its resolved key', () => {
  const c = parseConfig(withScorer + writtenThreshold, scorerEnv);
  assert.deepEqual(c.scorer, {
    baseUrl: 'https://openrouter.ai/api/alpha',
    apiKey: 'scorer-secret-value',
    model: 'vendor/decider',
    timeoutSeconds: 60,
  });
});

test('the review model gets the contract without block scores when a scorer is named, and both files exist', () => {
  const plain = contractFile(parseConfig(minimal, { MODEL_KEY: 'k' }));
  const scored = contractFile(parseConfig(withScorer + writtenThreshold, scorerEnv));
  assert.equal(plain, 'review-contract.md');
  assert.equal(scored, 'review-contract-scorer.md');
  for (const name of [plain, scored]) assert.ok(existsSync(new URL(`../../contract/${name}`, import.meta.url)), name);
});

test('a scorer key that is not set names its variable and prints no value', () => {
  for (const env of [{ MODEL_KEY: 'k' }, { MODEL_KEY: 'k', SCORER_KEY: '' }]) {
    assert.throws(
      () => parseConfig(withScorer + writtenThreshold, env),
      (e: ConfigError) => e.issues.includes('scorer.apiKey: environment variable SCORER_KEY is not set'),
    );
  }
});

test('an unknown key inside scorer is an error that names it', () => {
  assert.throws(
    () => parseConfig(withScorer + '  temperature: 0\n' + writtenThreshold, scorerEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('scorer') && i.includes('temperature')),
  );
});

test('scorer.baseUrl must be an http or https URL', () => {
  assert.throws(
    () => parseConfig(withScorer + '  baseUrl: ftp://x\n' + writtenThreshold, scorerEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('scorer.baseUrl') && !i.includes('ftp')),
  );
});

test('a scorer without a written threshold is refused and the message echoes no value', () => {
  assert.throws(
    () => parseConfig(withScorer, scorerEnv),
    (e: ConfigError) =>
      e.issues.includes('repositories.defaults.score.threshold: must be written when scorer is set') &&
      !e.message.includes('scorer-secret-value'),
  );
});

test('a threshold written only in an override does not satisfy the scorer rule', () => {
  const override = 'repositories:\n  overrides:\n    acme/shop:\n      score:\n        threshold: 80\n';
  assert.throws(
    () => parseConfig(withScorer + override, scorerEnv),
    (e: ConfigError) => e.issues.includes('repositories.defaults.score.threshold: must be written when scorer is set'),
  );
});

test('the threshold is not required while no scorer is named', () => {
  assert.equal(parseConfig(minimal, { MODEL_KEY: 'k' }).repositories.defaults.scoreThreshold, 70);
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const service = minimal + 'app:\n  id: 12345\n  privateKey: { env: APP_KEY }\n  webhookSecret: { env: HOOK }\ndatabase:\n  url: { env: DB_URL }\ndryRun: true\n';
const serviceEnv = { MODEL_KEY: 'k', APP_KEY: PEM, HOOK: 'hook-secret-value', DB_URL: 'postgres://u:db-password-value@db:5432/visto' };

test('without the service blocks app and database are null and the port is 8080', () => {
  const c = parseConfig(minimal, { MODEL_KEY: 'k' });
  assert.equal(c.app, null);
  assert.equal(c.database, null);
  assert.deepEqual(c.server, { port: 8080 });
});

test('the service blocks resolve their secrets', () => {
  const c = parseConfig(service, serviceEnv);
  assert.deepEqual(c.app, { id: '12345', privateKey: PEM, webhookSecret: 'hook-secret-value' });
  assert.equal(c.database?.url, serviceEnv.DB_URL);
});

test('server.port is read and must be a port number', () => {
  assert.equal(parseConfig(minimal + 'server:\n  port: 9000\n', { MODEL_KEY: 'k' }).server.port, 9000);
  for (const body of ['port: 0', 'port: 65536', 'port: 80.5', 'port: 80\n  host: x']) {
    assert.throws(
      () => parseConfig(minimal + `server:\n  ${body}\n`, { MODEL_KEY: 'k' }),
      (e: ConfigError) => e instanceof ConfigError && e.issues.some((i) => i.startsWith('server')),
      body,
    );
  }
});

test('an unset service variable names itself', () => {
  assert.throws(
    () => parseConfig(service, { MODEL_KEY: 'k', APP_KEY: PEM, DB_URL: serviceEnv.DB_URL }),
    (e: ConfigError) => e.issues.includes('app.webhookSecret: environment variable HOOK is not set'),
  );
  assert.throws(
    () => parseConfig(service, { MODEL_KEY: 'k', APP_KEY: PEM, HOOK: 'hook-secret-value' }),
    (e: ConfigError) => e.issues.includes('database.url: environment variable DB_URL is not set'),
  );
});

test('the database URL must be a postgres URL and is never printed', () => {
  assert.throws(
    () => parseConfig(service, { ...serviceEnv, DB_URL: 'mysql://u:db-password-value@db/x' }),
    (e: ConfigError) => e.issues.includes('database.url: must be a postgres URL') && !e.message.includes('db-password-value'),
  );
  for (const url of ['postgres://u:p@db/x', 'postgresql://u:p@db/x']) {
    assert.equal(parseConfig(service, { ...serviceEnv, DB_URL: url }).database?.url, url);
  }
});

test('a webhook secret written inline is rejected and never printed', () => {
  assert.throws(
    () => parseConfig(minimal + 'app:\n  webhookSecret: hook-secret-value\n', serviceEnv),
    (e: ConfigError) => e instanceof ConfigError && !e.message.includes('hook-secret-value'),
  );
});

test('an unknown key inside app or database names the key', () => {
  assert.throws(
    () => parseConfig(service + 'app2: {}\n', serviceEnv),
    (e: ConfigError) => e.issues.some((i) => i.includes('app2')),
  );
  assert.throws(
    () => parseConfig(minimal + 'app:\n  id: 12345\n  privateKey: { env: APP_KEY }\n  webhookSecret: { env: HOOK }\n  appId: 1\n', serviceEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('app') && i.includes('appId')),
  );
  assert.throws(
    () => parseConfig(minimal + 'database:\n  url: { env: DB_URL }\n  pool: 5\n', serviceEnv),
    (e: ConfigError) => e.issues.some((i) => i.startsWith('database') && i.includes('pool')),
  );
});

test('serviceConfig names each missing block and returns a complete config', () => {
  assert.throws(
    () => serviceConfig(parseConfig(`${minimal}dryRun: true\n`, { MODEL_KEY: 'k' })),
    (e: ConfigError) =>
      e instanceof ConfigError &&
      JSON.stringify(e.issues) === JSON.stringify(['app: required to run the service', 'database: required to run the service']),
  );
  const c = parseConfig(service, serviceEnv);
  assert.equal(serviceConfig(c), c);
});

test('the example file has no service blocks as shipped, and loads with them switched on', () => {
  const shipped = parseConfig(example(), exampleEnv);
  assert.equal(shipped.dryRun, true);
  assert.equal(shipped.app, null);
  assert.equal(shipped.database, null);
  assert.deepEqual(shipped.server, { port: 8080 });
  const text = uncomment(example(), '# app:');
  const env = { ...exampleEnv, APP_PRIVATE_KEY: PEM, ALERT_WEBHOOK_URL: 'https://alerts.example.test/in/abc', WEBHOOK_SECRET: 'hook-secret-value', DATABASE_URL: 'postgres://u:p@db:5432/visto' };
  const c = parseConfig(text, env);
  assert.equal(c.app?.webhookSecret, 'hook-secret-value');
  assert.equal(c.alerts?.webhook, env.ALERT_WEBHOOK_URL);
  assert.equal(c.database?.url, env.DATABASE_URL);
  assert.equal(c.server.port, 8080);
});

const SERVICE_YAML = `
model: { apiKey: { env: MODEL_KEY }, model: m }
app: { id: 12345, privateKey: { env: APP_KEY }, webhookSecret: { env: HOOK } }
database: { url: { env: DB } }
dryRun: true
`;
const ENV = { MODEL_KEY: 'k', APP_KEY: PEM, HOOK: 's', DB: 'postgres://u:p@db:5432/visto' };

test('the app block carries the id as text, the key and the secret', () => {
  assert.deepEqual(parseConfig(SERVICE_YAML, ENV).app, { id: '12345', privateKey: PEM, webhookSecret: 's' });
});
test('a private key written on one line with backslash-n is read as its lines', () => {
  assert.equal(parseConfig(SERVICE_YAML, { ...ENV, APP_KEY: PEM.replaceAll('\n', '\\n') }).app?.privateKey, PEM);
});
test('a private key that is not an RSA key is refused and never printed', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  for (const value of ['not-a-key-value', ec]) {
    assert.throws(() => parseConfig(SERVICE_YAML, { ...ENV, APP_KEY: value }), (e: unknown) =>
      e instanceof ConfigError && e.issues.length === 1 && e.issues[0] === 'app.privateKey: must be an RSA private key in PEM form'
      && !e.message.includes('not-a-key-value'));
  }
});
test('an app block without an id or a key is refused', () => {
  const yaml = SERVICE_YAML.replace('id: 12345, privateKey: { env: APP_KEY }, ', '');
  assert.throws(() => parseConfig(yaml, ENV), ConfigError);
});
test('what this plan adds has these defaults', () => {
  const c = parseConfig('model: { apiKey: { env: MODEL_KEY }, model: m }', ENV);
  assert.equal(c.dryRun, true);
  assert.equal(c.alerts, null);
  assert.deepEqual(c.limits, { inputTokensPerCall: 200000, batchesPerReview: 6, spendPerDay: 50, queueConcurrency: 2 });
  assert.deepEqual(c.repositories.defaults.ignoredAuthors, ['dependabot[bot]']);
  assert.deepEqual(c.repositories.defaults.baseBranches, []);
});
test('the alert webhook is read by reference, must be an http or https URL, and is never printed', () => {
  const yaml = `${SERVICE_YAML}alerts: { webhook: { env: HOOK_URL } }\n`;
  assert.deepEqual(parseConfig(yaml, { ...ENV, HOOK_URL: 'https://alerts.example.test/in/abc' }).alerts, { webhook: 'https://alerts.example.test/in/abc' });
  assert.throws(() => parseConfig(yaml, { ...ENV, HOOK_URL: 'ftp://alerts.example.test/abc' }), (e: unknown) =>
    e instanceof ConfigError && e.issues[0] === 'alerts.webhook: must be an http or https URL' && !e.message.includes('alerts.example.test'));
});
test('the queue concurrency is a whole number from 1 to 20, and the daily limit is positive', () => {
  for (const limits of ['{ queueConcurrency: 0 }', '{ queueConcurrency: 21 }', '{ queueConcurrency: 1.5 }', '{ spendPerDay: 0 }']) {
    assert.throws(() => parseConfig(`${SERVICE_YAML}limits: ${limits}\n`, ENV), ConfigError);
  }
});
test('a config with no dryRun key is in dry run, and only dryRun: false leaves it', () => {
  const none = SERVICE_YAML.replace('dryRun: true\n', '');
  assert.equal(serviceConfig(parseConfig(none, ENV)).dryRun, true);
  assert.equal(serviceConfig(parseConfig(none + 'dryRun: false\n', ENV)).dryRun, false);
  assert.throws(() => parseConfig(none + 'dryRun: no\n', ENV), ConfigError);
});
test('serviceConfig accepts a config in dry run and one out of it, and still names a missing block', () => {
  assert.equal(serviceConfig(parseConfig(SERVICE_YAML, ENV)).dryRun, true);
  assert.equal(serviceConfig(parseConfig(SERVICE_YAML.replace('dryRun: true', 'dryRun: false'), ENV)).dryRun, false);
  assert.throws(
    () => serviceConfig(parseConfig('model: { apiKey: { env: MODEL_KEY }, model: m }\ndryRun: false\n', ENV)),
    (e: unknown) => e instanceof ConfigError && JSON.stringify(e.issues) === JSON.stringify(['app: required to run the service', 'database: required to run the service']),
  );
});
test('repoSettingsFor applies an override key by key, and repoConfigFor still returns the two keys the engine reads', () => {
  const c = parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    Acme/Shop: { baseBranches: [main], ignoredAuthors: [] }\n`, ENV);
  assert.deepEqual(repoSettingsFor(c, 'acme/shop'), { primaryBranches: ['main', 'master'], scoreThreshold: 70, ignoredAuthors: [], baseBranches: ['main'], newHead: null });
  assert.deepEqual(repoSettingsFor(c, 'acme/other').ignoredAuthors, ['dependabot[bot]']);
  assert.deepEqual(repoConfigFor(c, 'acme/shop'), { primaryBranches: ['main', 'master'], scoreThreshold: 70 });
});
test('how a new head is reviewed can be set for all repositories or for one, and is not set otherwise', () => {
  const unset = parseConfig(SERVICE_YAML, ENV);
  assert.equal(repoSettingsFor(unset, 'acme/shop').newHead, null);
  const all = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { newHead: full }\n`, ENV);
  assert.deepEqual([repoSettingsFor(all, 'acme/shop').newHead, repoSettingsFor(all, 'acme/other').newHead], ['full', 'full']);
  const one = parseConfig(`${SERVICE_YAML}repositories:\n  defaults: { newHead: full }\n  overrides:\n    acme/shop: { newHead: incremental }\n`, ENV);
  assert.deepEqual([repoSettingsFor(one, 'acme/shop').newHead, repoSettingsFor(one, 'acme/other').newHead], ['incremental', 'full']);
  const onlyOne = parseConfig(`${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { newHead: full }\n`, ENV);
  assert.deepEqual([repoSettingsFor(onlyOne, 'acme/shop').newHead, repoSettingsFor(onlyOne, 'acme/other').newHead], ['full', null]);
});
test('another word for newHead is refused', () => {
  for (const yaml of [`${SERVICE_YAML}repositories:\n  defaults: { newHead: recheck }\n`, `${SERVICE_YAML}repositories:\n  overrides:\n    acme/shop: { newHead: partial }\n`]) {
    assert.throws(() => parseConfig(yaml, ENV), (e: unknown) => e instanceof ConfigError && e.issues.some((i) => i.includes('newHead')));
  }
});
