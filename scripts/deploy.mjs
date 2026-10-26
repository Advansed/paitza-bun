import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const KEY = join(homedir(), '.ssh', 'id_kz_work');
const HOST = 'ubuntu@paitza.com';
const REMOTE_STAGING = 'paitza-bun-staging';
const setupOnly = process.argv.includes('--setup-only');

const sshOpts = [
  '-i', KEY,
  '-o', 'HostName=194.238.43.155',
  '-o', 'HostKeyAlias=paitza.com',
  '-o', 'ServerAliveInterval=60',
  '-o', 'ServerAliveCountMax=20',
  '-o', 'ConnectTimeout=300',
  '-o', 'TCPKeepAlive=yes',
  '-o', 'BatchMode=yes',
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      windowsHide: true,
      cwd: ROOT,
      ...opts,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

function ssh(remoteCommand) {
  return run('ssh', [...sshOpts, HOST, remoteCommand]);
}

if (!existsSync(KEY)) {
  console.error(`Нет SSH-ключа: ${KEY}`);
  process.exit(1);
}

if (!existsSync(join(ROOT, 'package.json')) || !existsSync(join(ROOT, 'prisma', 'schema.prisma'))) {
  console.error('Запускайте из корня paitza-bun (нужны package.json и prisma/schema.prisma)');
  process.exit(1);
}

const remoteScript = readFileSync(join(__dirname, 'remote-deploy.sh'), 'utf8');
const remoteB64 = Buffer.from(remoteScript, 'utf8').toString('base64');

function remoteBash(mode) {
  // base64 — без heredoc, стабильно из Windows OpenSSH
  return `printf %s ${remoteB64} | base64 -d | bash -s -- ${mode}`;
}

console.log('Настройка paitza-bun на paitza.com…');
await ssh(remoteBash('setup'));

if (setupOnly) {
  console.log('Сервер настроен. Дальше: npm run deploy');
  process.exit(0);
}

console.log(`Загрузка исходников в ~/${REMOTE_STAGING}…`);
await ssh(`rm -rf ~/${REMOTE_STAGING} && mkdir -p ~/${REMOTE_STAGING}`);

const sshForRsync = ['ssh', ...sshOpts].join(' ');
const excludes = [
  '--exclude', 'node_modules',
  '--exclude', '.git',
  '--exclude', '.env',
  '--exclude', '.env.*',
  '--exclude', 'dist',
  '--exclude', 'logs',
  '--exclude', '.cursor',
  '--exclude', 'coverage',
];

try {
  await run('rsync', [
    '-az',
    '--delete',
    ...excludes,
    '-e', sshForRsync,
    `${ROOT}/`,
    `${HOST}:${REMOTE_STAGING}/`,
  ]);
} catch (err) {
  console.warn('rsync недоступен или упал, пробую scp…', err instanceof Error ? err.message : err);
  // scp не умеет exclude — копируем ключевые каталоги/файлы
  const parts = [
    'package.json',
    'package-lock.json',
    'bun.lockb',
    'bun.lock',
    'tsconfig.json',
    'prisma',
    'src',
  ].filter((name) => existsSync(join(ROOT, name)));

  for (const name of parts) {
    const local = join(ROOT, name);
    await run('scp', [...sshOpts, '-r', local, `${HOST}:${REMOTE_STAGING}/`]);
  }
}

console.log('Установка зависимостей, prisma generate, restart…');
await ssh(remoteBash('publish'));

console.log('Готово: API на paitza.com (каталог ~/paitza-bun)');
