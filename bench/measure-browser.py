"""Chromium timings. Usage: python3 bench/measure-browser.py <project dir with dist/> [runs]  (run bench/make_fixtures.py first).
Reports median of N runs: open 12 MP JPG, open 12 MP HEIC, batch of 6 x 12 MP JPG (process + ZIP click->download), plus main-thread
long-task totals (>50 ms) as a responsiveness proxy. Headless Chromium on this sandbox: relative numbers only, not phone numbers."""
import os, sys, subprocess, time, statistics, shutil
from playwright.sync_api import sync_playwright
proj = os.path.abspath(sys.argv[1]); runs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
fx = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures'); PORT = 4210
srv = subprocess.Popen(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'e2e', 'serve.mjs')], cwd=proj, env={**os.environ, 'PORT': str(PORT)}); time.sleep(1)
BASE = f'http://127.0.0.1:{PORT}'
LT = "()=>{window.__lt=0;new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt+=e.duration}).observe({type:'longtask',buffered:true})}"
def ready(p): p.wait_for_function("()=>{const l=document.querySelector('[data-r=barLabel]');return l&&l.textContent!=='processing…'}", timeout=240000)
res = {k: [] for k in ('open_jpg_ms', 'open_jpg_longtask_ms', 'open_heic_ms', 'open_heic_longtask_ms', 'batch_process_ms', 'batch_longtask_ms', 'zip_ms')}
try:
  with sync_playwright() as pw:
    b = pw.chromium.launch(); 
    for r in range(runs):
      ctx = b.new_context(accept_downloads=True); p = ctx.new_page(); p.add_init_script(LT)
      for kind, f in (('jpg', 'photo12mp.jpg'), ('heic', 'photo12mp.heic')):
        p.goto(BASE + '/convert'); p.evaluate('window.__lt=0'); t = time.time()
        p.set_input_files('input[type=file]', os.path.join(fx, f)); p.wait_for_selector('.workbench', timeout=240000); ready(p)
        res[f'open_{kind}_ms'].append((time.time() - t) * 1000); res[f'open_{kind}_longtask_ms'].append(p.evaluate('window.__lt'))
      p.goto(BASE + '/batch'); p.wait_for_selector('.batch .dropzone')
      d = os.path.join('/tmp', 'bm'); os.makedirs(d, exist_ok=True)
      files = []
      for i in range(6): q = os.path.join(d, f'p{i}.jpg'); shutil.copy(os.path.join(fx, 'photo12mp.jpg'), q); files.append(q)
      p.set_input_files('.batch input[type=file]', files); p.wait_for_function("()=>document.querySelectorAll('.batch-item').length===6", timeout=60000); p.wait_for_timeout(2500)
      p.click('[aria-label="Batch resize"] button:text-is("Width")'); p.fill('#bw', '1600'); p.evaluate('window.__lt=0'); t = time.time(); p.click('#bprocess')
      p.wait_for_function("()=>{const b=document.querySelector('#bprocess');return b&&b.textContent!=='Processing…'&&/processed/.test(document.querySelector('#bstatus').textContent)}", timeout=600000)
      res['batch_process_ms'].append((time.time() - t) * 1000); res['batch_longtask_ms'].append(p.evaluate('window.__lt'))
      t = time.time()
      with p.expect_download() as dl: p.click('#bzip')
      res['zip_ms'].append((time.time() - t) * 1000); ctx.close()
    b.close()
finally: srv.terminate()
for k, v in res.items(): print(f'{k:24s} median {statistics.median(v):8.0f}   runs {[round(x) for x in v]}')
