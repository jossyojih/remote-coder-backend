import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { systemdDeploymentStarter } from '../src/deployment.js';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

async function deploymentRepository() {
  const root = await mkdtemp(join(tmpdir(), 'deployment-git-'));
  const remote = join(root, 'remote.git');
  const author = join(root, 'author');
  const deployed = join(root, 'deployed');
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['clone', remote, author]);
  await git(author, 'config', 'user.email', 'test@example.com');
  await git(author, 'config', 'user.name', 'Test');
  await git(author, 'checkout', '-b', 'main');
  await writeFile(join(author, 'version'), 'previous\n');
  await git(author, 'add', 'version'); await git(author, 'commit', '-m', 'previous');
  const previous = await git(author, 'rev-parse', 'HEAD');
  await git(author, 'push', '-u', 'origin', 'main');
  await exec('git', ['clone', '--branch', 'main', remote, deployed]);
  await writeFile(join(author, 'version'), 'approved\n');
  await git(author, 'commit', '-am', 'approved');
  const approved = await git(author, 'rev-parse', 'HEAD');
  await writeFile(join(author, 'version'), 'newer\n');
  await git(author, 'commit', '-am', 'newer'); await git(author, 'push');
  return { deployed, previous, approved };
}

async function deploymentGit() {
  const url = pathToFileURL(join(process.cwd(), 'scripts/deploy-backend.mjs')).href;
  return import(url) as Promise<{
    checkoutApprovedCommit: (deployment: object) => string;
    restorePreviousCommit: (deployment: object, previous: string) => void;
  }>;
}

test('successful deployment keeps the target branch attached at exactly the approved commit', async () => {
  const repository = await deploymentRepository();
  const { checkoutApprovedCommit } = await deploymentGit();
  const previous = checkoutApprovedCommit({ sourcePath: repository.deployed, remoteName: 'origin', targetBranch: 'main', commitSha: repository.approved });
  assert.equal(previous, repository.previous);
  assert.equal(await git(repository.deployed, 'branch', '--show-current'), 'main');
  assert.equal(await git(repository.deployed, 'rev-parse', 'HEAD'), repository.approved);
  assert.notEqual(await git(repository.deployed, 'rev-parse', 'origin/main'), repository.approved);
});

test('deployment rollback restores the previous commit with the target branch attached', async () => {
  const repository = await deploymentRepository();
  const { checkoutApprovedCommit, restorePreviousCommit } = await deploymentGit();
  const deployment = { sourcePath: repository.deployed, remoteName: 'origin', targetBranch: 'main', commitSha: repository.approved };
  const previous = checkoutApprovedCommit(deployment);
  restorePreviousCommit(deployment, previous);
  assert.equal(await git(repository.deployed, 'branch', '--show-current'), 'main');
  assert.equal(await git(repository.deployed, 'rev-parse', 'HEAD'), repository.previous);
});

test('systemd handoff invokes systemctl directly with the constrained unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deployment-systemctl-'));
  const executable = join(root, 'systemctl');
  const output = join(root, 'args');
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > "${output}"\n`);
  await chmod(executable, 0o755);
  await systemdDeploymentStarter(executable)('12345678-1234-1234-1234-123456789abc');
  assert.deepEqual((await readFile(output, 'utf8')).trim().split('\n'), [
    'start', '--no-block', 'remote-coder-deploy@12345678-1234-1234-1234-123456789abc.service',
  ]);
});

test('deployment assets retain hardening and narrowly scope Polkit authorization', async () => {
  const service = await readFile('deploy/remote-coder-deploy@.service', 'utf8');
  const rules = await readFile('deploy/50-remote-coder-deployment.rules', 'utf8');
  const script = await readFile('scripts/deploy-backend.mjs', 'utf8');

  assert.match(service, /^User=ubuntu$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(rules, /subject\.user !== "ubuntu"/);
  assert.match(rules, /verb === "start".*remote-coder-deploy@/s);
  assert.match(rules, /verb === "restart".*remote-coder-backend\.service/s);
  assert.match(rules, /return polkit\.Result\.NO;/);
  assert.doesNotMatch(script, /\/usr\/bin\/sudo/);
  assert.match(script, /body === undefined \? \{\} : \{ 'content-type': 'application\/json' \}/);
  assert.match(script, /request\(`\/internal\/deployments\/\$\{id\}\/claim`\)/);
  assert.match(script, /request\(`\/internal\/deployments\/\$\{id\}\/state`, \{ status, stage/);
  assert.equal(script.match(/run\('\/usr\/bin\/systemctl', \['restart', 'remote-coder-backend\.service'\]/g)?.length, 2);

  let authorize: ((action: { id: string; lookup: (key: string) => string }, subject: { user: string }) => string) | undefined;
  vm.runInNewContext(rules, {
    polkit: {
      Result: { YES: 'yes', NO: 'no', NOT_HANDLED: 'not_handled' },
      addRule: (rule: typeof authorize) => { authorize = rule; },
    },
  });
  assert.ok(authorize);
  const check = (user: string, verb: string, unit: string, actionId = 'org.freedesktop.systemd1.manage-units') =>
    authorize!({ id: actionId, lookup: (key) => key === 'verb' ? verb : unit }, { user });
  assert.equal(check('ubuntu', 'start', 'remote-coder-deploy@abc.service'), 'yes');
  assert.equal(check('ubuntu', 'restart', 'remote-coder-backend.service'), 'yes');
  assert.equal(check('ubuntu', 'restart', 'remote-coder-deploy@abc.service'), 'no');
  assert.equal(check('ubuntu', 'start', 'remote-coder-backend.service'), 'no');
  assert.equal(check('ubuntu', 'start', 'other.service'), 'no');
  assert.equal(check('remote-coder', 'start', 'remote-coder-deploy@abc.service'), 'not_handled');
  assert.equal(check('ubuntu', 'start', 'remote-coder-deploy@abc.service', 'org.freedesktop.systemd1.manage-unit-files'), 'no');
  assert.equal(check('ubuntu', 'start', 'remote-coder-deploy@abc.service', 'other.action'), 'not_handled');
});
