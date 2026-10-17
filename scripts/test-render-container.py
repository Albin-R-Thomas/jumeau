"""Integration test for the built all-in-one image; needs Docker, no provider key.

Run: python scripts/test-render-container.py [cityweather-render:test]
Creates and removes only uniquely named test containers/volumes.
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else 'cityweather-render:test'
name = 'cityweather-render-check-' + uuid.uuid4().hex[:10]
volume = name + '-data'
base = ''


def docker(*args):
    return subprocess.check_output(['docker', *args], stderr=subprocess.STDOUT).decode().strip()


def http(path, auth=True, data=None, content_type=None):
    headers = {'X-API-Key': 'deployment-test-key'} if auth else {}
    if content_type:
        headers['Content-Type'] = content_type
    request = urllib.request.Request(base + path, headers=headers, data=data)
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def wait_health():
    for _ in range(120):
        try:
            if http('/health', False)[0] == 200:
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    raise AssertionError('Health did not become ready')


def start():
    global base
    docker('run', '-d', '--name', name, '--memory', '2g', '--cpus', '1',
           '--mount', 'source=' + volume + ',target=/var/data',
           '-p', '127.0.0.1::10000', '-e', 'API_KEY=deployment-test-key',
           '-e', 'OPENWEATHER_API_KEY=unused-test-placeholder',
           '-e', 'BULK_WORKER_CONCURRENCY=1',
           '-e', 'BULK_DB_BATCH_SIZE=100', '-e', 'BULK_DISPATCH_BATCH_SIZE=100',
           '-e', 'BULK_UPLOAD_MAX_BYTES=10485760', '-e', 'BULK_UPLOAD_MAX_ROWS=100000', image)
    port = docker('port', name, '10000/tcp').rsplit(':', 1)[1]
    base = 'http://127.0.0.1:' + port
    wait_health()


def sql(query):
    return docker('exec', name, 'gosu', 'postgres', 'psql', '-h', '/tmp',
                  '-U', 'cityweather', '-d', 'cityweather', '-tAc', query)


def worker_signal(sig):
    code = ("import os,signal; "
            "pids=[int(p) for p in os.listdir('/proc') if p.isdigit() "
            "and os.path.exists('/proc/'+p+'/cmdline') "
            "and b'dist/src/bulk/worker.js' in open('/proc/'+p+'/cmdline','rb').read().split(b'\\0')]; "
            "assert len(pids)==1,pids; os.kill(pids[0],signal." + sig + ')')
    docker('exec', name, 'python3', '-c', code)


try:
    docker('volume', 'create', volume)
    start()
    assert http('/history', False)[0] == 401
    assert http('/history')[0] == 200
    # Exercise admission beyond the assignment's 10k+ requirement. Duplicate
    # records avoid spending provider quota or queuing thousands of test cities.
    boundary = 'cityweather-large-boundary'
    large_payload = (('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; '
                     'filename="large.csv"\r\nContent-Type: text/csv\r\n\r\n')
                     + '"Large Test City,ZZ"\n' * 10001
                     + '\r\n--' + boundary + '--\r\n').encode()
    status, accepted_large = http('/bulk/import', data=large_payload,
                                  content_type='multipart/form-data; boundary=' + boundary)
    assert status == 202, (status, accepted_large)
    _, large_status = http('/bulk/jobs/' + accepted_large['job_id'])
    assert large_status['input_rows'] == 10001, large_status
    assert large_status['admission_duplicate_rows'] == 10000, large_status
    print('PASS: 10,001-row CSV accepted with exact row and duplicate counts', flush=True)
    # Country ZZ fails locally, so the worker can finish without provider calls.
    boundary = 'cityweather-test-boundary'
    payload = ('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; '
               'filename="test.csv"\r\nContent-Type: text/csv\r\n\r\n'
               '"Test City,ZZ"\n\r\n--' + boundary + '--\r\n').encode()
    status, accepted = http('/bulk/import', data=payload,
                            content_type='multipart/form-data; boundary=' + boundary)
    assert status == 202, (status, accepted)
    job = accepted['job_id']
    for _ in range(60):
        status, result = http('/bulk/jobs/' + job)
        if result['status'] == 'done':
            break
        time.sleep(0.5)
    assert result['status'] == 'done' and result['failed'] == 1, result
    sql('CREATE TABLE deployment_test (value text); INSERT INTO deployment_test VALUES (\'persisted\')')
    docker('exec', name, 'redis-cli', 'SET', 'deployment-test', 'persisted')
    docker('exec', name, 'gosu', 'postgres', 'pg_dump', '-h', '/tmp',
           '-U', 'cityweather', '-d', 'cityweather', '-Fc', '-f', '/tmp/backup.dump')
    assert 'TABLE' in docker('exec', name, 'pg_restore', '--list', '/tmp/backup.dump')
    print('PASS: migrations, health, auth, worker completion, logical backup', flush=True)

    docker('stop', '-t', '40', name)
    assert docker('inspect', '-f', '{{.State.ExitCode}}', name) == '0'
    docker('rm', name)
    start()
    assert sql('SELECT value FROM deployment_test') == 'persisted'
    assert docker('exec', name, 'redis-cli', 'GET', 'deployment-test') == 'persisted'
    assert http('/bulk/jobs/' + job)[1]['status'] == 'done'
    print('PASS: graceful shutdown and database/Redis/job persistence after replacement', flush=True)

    worker_signal('SIGSTOP')
    time.sleep(33)
    assert http('/health', False)[0] == 503
    worker_signal('SIGKILL')
    for _ in range(60):
        state = json.loads(docker('inspect', '-f', '{{json .State}}', name))
        if not state['Running']:
            break
        time.sleep(0.5)
    assert not state['Running'] and state['ExitCode'] == 1, state
    print('PASS: stalled worker fails health; worker crash stops the container', flush=True)
    docker('start', name)
    # Docker can assign a new random host port when a container is restarted.
    base = 'http://127.0.0.1:' + docker('port', name, '10000/tcp').rsplit(':', 1)[1]
    wait_health()
    assert http('/bulk/jobs/' + job)[1]['status'] == 'done'
    print('PASS: recovery after worker crash', flush=True)
    print(docker('stats', '--no-stream', '--format', 'Memory: {{.MemUsage}}', name), flush=True)
except Exception:
    try:
        print(docker('logs', '--tail', '60', name))
    except subprocess.CalledProcessError:
        pass
    raise
finally:
    subprocess.run(['docker', 'rm', '-f', '-v', name], capture_output=True)
    subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True)
