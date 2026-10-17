"""Own the four processes and shut down apps before their local datastores."""
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time

ROOT = Path('/var/data')
PG = '/usr/lib/postgresql/17/bin/'
children = []
stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


def launch(name, args, env=None):
    process = subprocess.Popen(args, env=env, start_new_session=True)
    children.append((name, process))
    return process


def run(args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def ready(args, process):
    for _ in range(120):
        if stopping or process.poll() is not None:
            raise RuntimeError('Dependency stopped during startup')
        if subprocess.run(args, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0:
            return
        time.sleep(0.5)
    raise RuntimeError('Dependency startup timed out')


def terminate(group, timeout):
    for name, process in group:
        if process.poll() is None:
            # PostgreSQL fast shutdown uses SIGINT; SIGTERM may wait on clients.
            try:
                os.killpg(process.pid, signal.SIGINT if name == 'postgres' else signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + timeout
    for _, process in group:
        try:
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'exec':
        env = dict(os.environ, **json.loads(Path('/run/cityweather-env.json').read_text()))
        os.execvpe(sys.argv[2], sys.argv[2:], env)

    for key in ('API_KEY', 'OPENWEATHER_API_KEY'):
        if not os.environ.get(key):
            raise RuntimeError('Missing required setting: ' + key)
    # Fail closed instead of silently creating an ephemeral database.
    if not os.path.ismount(ROOT):
        raise RuntimeError('/var/data must be a mounted persistent disk')
    ROOT.mkdir(exist_ok=True)
    password_file = ROOT / 'database-password'
    if not password_file.exists():
        if (ROOT / 'postgres' / 'PG_VERSION').exists():
            raise RuntimeError('Database password file missing; restore it from backup')
        password_file.write_text(secrets.token_hex(32))
    password_file.chmod(0o600)
    run(['chown', 'postgres:postgres', str(password_file)])
    for name, owner in [('postgres', 'postgres:postgres'), ('redis', 'redis:redis')]:
        path = ROOT / name
        path.mkdir(exist_ok=True, mode=0o700)
        run(['chown', owner, str(path)])
    if not (ROOT / 'postgres' / 'PG_VERSION').exists():
        run(['gosu', 'postgres', PG + 'initdb', '-D', str(ROOT / 'postgres'),
             '--username=cityweather', '--pwfile=' + str(password_file),
             '--auth-host=scram-sha-256', '--auth-local=trust'])

    pg = launch('postgres', ['gosu', 'postgres', PG + 'postgres',
        '-D', str(ROOT / 'postgres'), '-h', '127.0.0.1', '-k', '/tmp',
        '-c', 'shared_buffers=32MB', '-c', 'max_connections=30',
        '-c', 'work_mem=2MB', '-c', 'maintenance_work_mem=32MB'])
    ready([PG + 'pg_isready', '-h', '/tmp', '-U', 'cityweather', '-d', 'postgres'], pg)
    result = subprocess.check_output(['gosu', 'postgres', PG + 'psql', '-h', '/tmp',
        '-U', 'cityweather', '-d', 'postgres', '-tAc',
        "SELECT 1 FROM pg_database WHERE datname='cityweather'"])
    if result.strip() != b'1':
        run(['gosu', 'postgres', PG + 'createdb', '-h', '/tmp',
             '-U', 'cityweather', 'cityweather'])
    redis = launch('redis', ['gosu', 'redis', 'redis-server', '--bind', '127.0.0.1',
        '--dir', str(ROOT / 'redis'), '--appendonly', 'yes', '--appendfsync', 'always',
        '--maxmemory', '192mb', '--maxmemory-policy', 'noeviction', '--save', ''])
    ready(['redis-cli', 'ping'], redis)

    env = dict(os.environ)
    env['DATABASE_URL'] = ('postgresql://cityweather:' + password_file.read_text().strip()
                           + '@127.0.0.1:5432/cityweather?connection_limit=5')
    env['REDIS_URL'] = 'redis://127.0.0.1:6379'
    env.setdefault('PORT', '10000')
    # Render Shell operations can reuse credentials without displaying them.
    runtime_file = Path('/run/cityweather-env.json')
    runtime_file.write_text(json.dumps({key: env[key] for key in
        ('DATABASE_URL', 'REDIS_URL', 'PORT')}))
    runtime_file.chmod(0o600)
    migration = launch('migration', ['node', 'node_modules/prisma/build/index.js',
                                    'migrate', 'deploy'], env)
    while migration.poll() is None:
        if stopping or pg.poll() is not None or redis.poll() is not None:
            raise RuntimeError('Startup interrupted during migration')
        time.sleep(0.2)
    if migration.returncode:
        raise RuntimeError('Database migration failed')
    children.remove(('migration', migration))
    if stopping:
        return
    staging = Path(env['BULK_STAGING_DIR'])
    staging.mkdir(parents=True, exist_ok=True, mode=0o700)
    run(['chown', 'app:app', str(staging)])
    launch('worker', ['gosu', 'app', 'node', 'dist/src/bulk/worker.js'], env)
    launch('api', ['gosu', 'app', 'node', 'dist/src/server.js'], env)
    print('All four processes started.', flush=True)
    while not stopping:
        for name, process in children:
            if process.poll() is not None:
                raise RuntimeError(name + ' exited; restarting the whole service')
        time.sleep(0.5)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    code = 0
    try:
        main()
    except RuntimeError as error:
        # These messages are our own fixed diagnostics, without credentials.
        print(str(error), flush=True)
        code = 1
    except Exception:
        # Avoid printing subprocess arguments or credential-bearing exceptions.
        print('Container startup or process failure. Check preceding service logs.', flush=True)
        code = 1
    finally:
        terminate([(n, p) for n, p in children if n not in ('postgres', 'redis')], 12)
        terminate([(n, p) for n, p in children if n in ('postgres', 'redis')], 12)
    sys.exit(code)
