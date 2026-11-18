"""End-to-end check against a local dev server (moto S3 + in-process Postgres + login bypass).

Run:  python3 tests/e2e_local.py  (with `next dev` on :3000 and moto on :5055)
"""
import json, time, sys
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'
OUT = '/home/claude/polaroid-wall/tests/out/'
import os; os.makedirs(OUT, exist_ok=True)
log = {}

def errors_of(page, bucket):
    page.on('pageerror', lambda e: bucket.append(str(e)))
    page.on('console', lambda m: bucket.append(m.text) if m.type == 'error' else None)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = br.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page(); errs = []; errors_of(page, errs)

    # ---------- Public wall ----------
    page.goto(BASE + '/'); page.wait_for_timeout(2500)
    log['wall'] = page.evaluate("({z: window.__wall.z, minZ: window.__wall.minZ, n: window.__wall.prints.length, imgs: [...document.querySelectorAll('.print img')].filter(i => i.complete && i.naturalWidth > 0).length})")
    page.screenshot(path=OUT + 'wall.png')
    c = page.evaluate("(() => { const p = window.__wall.prints.find(q => q.n === '100'); const r = p.el.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()")
    page.mouse.click(c[0], c[1]); page.wait_for_timeout(1200)
    log['viewer'] = page.evaluate("({path: location.pathname, src: document.getElementById('vimg').getAttribute('src')})")
    page.screenshot(path=OUT + 'viewer.png')
    page.keyboard.press('Escape'); page.wait_for_timeout(700)
    log['closed_path'] = page.evaluate('location.pathname')
    page.goto(BASE + '/p/063'); page.wait_for_timeout(1800)
    log['deeplink'] = page.evaluate("({hidden: document.getElementById('viewer').hidden, alt: document.getElementById('vimg').alt, title: document.title})")
    page.screenshot(path=OUT + 'deeplink.png')
    log['og'] = page.evaluate("document.querySelector('meta[property=\"og:image\"]')?.content")
    log['wall_errors'] = errs[:]

    # ---------- Dashboard ----------
    errs.clear()
    page.goto(BASE + '/admin'); page.wait_for_timeout(2000)
    page.screenshot(path=OUT + 'library.png', full_page=False)
    log['library_rows'] = page.evaluate("document.querySelectorAll('.table tbody tr').length")
    # one-time storage rules (CORS) so the browser can PUT parts
    if page.locator('text=Apply upload rules').count():
        page.click('text=Apply upload rules'); page.wait_for_timeout(2500)
        log['setup'] = page.locator('.banner').inner_text() if page.locator('.banner').count() else 'banner gone (applied)'
    # upload: 16-bit TIFF bed scan, an exact duplicate, a disguised HEIC
    page.set_input_files('input[type=file]', ['/tmp/uploads-test/Instax wide -201.tif', '/tmp/uploads-test/Instax wide -070 copy.jpg', '/tmp/uploads-test/IMG_0412.jpg'])
    page.wait_for_timeout(1500)
    page.screenshot(path=OUT + 'uploading.png')
    log['rows_during'] = page.evaluate("[...document.querySelectorAll('.table tbody tr')].slice(0,4).map(r => r.innerText.replace(/\\s+/g,' ').slice(0,160))")
    # wait for processing of the TIFF
    for _ in range(60):
        page.wait_for_timeout(2000)
        txt = page.locator('.table').inner_text()
        if 'Instax wide -201.tif' in txt and 'Making web copies' not in txt and 'Uploading' not in txt and 'Finishing' not in txt and 'Waiting' not in txt:
            break
    page.reload(); page.wait_for_timeout(2000)
    page.screenshot(path=OUT + 'library_after.png')
    log['rows_after'] = page.evaluate("[...document.querySelectorAll('.table tbody tr')].slice(0,4).map(r => r.innerText.replace(/\\s+/g,' ').slice(0,200))")
    log['dash_errors'] = errs[:]

    # print detail of the uploaded TIFF
    errs.clear()
    page.click('text=Instax wide -201.tif'); page.wait_for_timeout(2500)
    page.screenshot(path=OUT + 'detail_tif.png')
    log['detail_tif'] = page.locator('.panel').inner_text()[:600]
    # a split bed scan
    page.goto(BASE + '/admin'); page.wait_for_timeout(1500)
    page.fill('.search', '111'); page.wait_for_timeout(300)
    page.locator('.table tbody tr').first.click(); page.wait_for_timeout(2500)
    page.screenshot(path=OUT + 'detail_111.png')
    log['detail_errors'] = errs[:]

    # wall editor
    errs.clear()
    page.goto(BASE + '/admin/wall'); page.wait_for_timeout(3000)
    page.screenshot(path=OUT + 'editor.png')
    log['editor_pending'] = page.locator('.pills').nth(1).inner_text()
    log['editor_errors'] = errs[:]

    # ---------- Phone ----------
    m = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True)
    mp = m.new_page(); merrs = []; errors_of(mp, merrs)
    mp.goto(BASE + '/'); mp.wait_for_timeout(2500)
    mp.screenshot(path=OUT + 'phone_wall.png')
    log['phone'] = mp.evaluate("({z: window.__wall.z, cls: document.querySelector('.wall-root').className})")
    log['phone_errors'] = merrs
    br.close()

print(json.dumps(log, indent=1))
