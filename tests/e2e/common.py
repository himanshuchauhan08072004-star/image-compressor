import os, re, subprocess, sys, tempfile, time
from PIL import Image
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FIX = os.path.join(ROOT, 'tests', 'e2e', 'fixtures')
tmp = tempfile.mkdtemp(); results = []
def check(name, cond, detail=''):
    results.append((bool(cond), name)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if (detail and not cond) else ''), flush=True)
def info(m): print('     ' + m, flush=True)
def fx(n): return os.path.join(FIX, n)
def txt(p, k): return p.inner_text(f'[data-r="{k}"]').strip()
def ready(p, t=180000):
    p.wait_for_timeout(350)
    p.wait_for_function("()=>{const l=document.querySelector('[data-r=barLabel]');return l&&l.textContent!=='processing…'}", timeout=t)
def notices(p): return ' | '.join(p.locator('.notice').all_inner_texts())
def load(p, base, name, path='/'):
    p.goto(base + path); p.set_input_files('input[type=file]', fx(name)); p.wait_for_selector('.workbench', timeout=120000); ready(p)
def nav(p, label): p.click(f'#toolNav a:text-is("{label}")'); p.wait_for_timeout(300); p.wait_for_selector('.workbench'); ready(p)
def download(p, name='x'):
    with p.expect_download() as d: p.click('button:text-is("Download result")')
    f = os.path.join(tmp, name + '_' + d.value.suggested_filename); d.value.save_as(f); return f, d.value.suggested_filename
def near(px, rgb, tol=40): return all(abs(a - b) <= tol for a, b in zip(px, rgb))
def start_server(port):
    s = subprocess.Popen(['node', 'tests/e2e/serve.mjs'], cwd=ROOT, env={**os.environ, 'PORT': str(port)}); time.sleep(1); return s
def finish():
    fails = [r for r in results if not r[0]]
    print(f'\n{len(results) - len(fails)}/{len(results)} passed')
    for f in fails: print('FAILED:', f[1])
    sys.exit(1 if fails else 0)
RED, BLUE, WHITE, GREEN = (255, 0, 0), (0, 0, 255), (255, 255, 255), (0, 255, 0)
