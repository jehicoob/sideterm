"""Real Chromium + real extension code + real PTYs; VS Code API is mocked.

Requires Playwright and Chromium ONLY on the development/test machine.
The HTTP fixture and polling below are test infrastructure, not extension code.
"""
import asyncio
import json
import re
from pathlib import Path
import shlex
import shutil
import time
import urllib.request
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


async def main():
    proc = await asyncio.create_subprocess_exec('node', str(ROOT/'tests/fixture-server.cjs'), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    url = (await asyncio.wait_for(proc.stdout.readline(), 5)).decode().strip()
    assert url.startswith('http://127.0.0.1:'), url
    results = []
    errors = []
    async def request(route, body=None):
        def work():
            payload = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(url+route, data=payload, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read())
        return await asyncio.to_thread(work)
    async def stats(): return await request('/stats')
    async def wait(predicate, timeout=8, detail='condition'):
        start = time.monotonic()
        while not await predicate():
            if time.monotonic() - start > timeout:
                raise AssertionError('Timeout: '+detail+'\n'+json.dumps(await stats(), ensure_ascii=False)[-6000:])
            await asyncio.sleep(.025)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = await browser.new_page(viewport={'width': 510, 'height': 860}, device_scale_factor=1)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda e: errors.append('console: '+e.text) if e.type == 'error' else None)
        await page.expose_binding('__sideSend', lambda source, value: request('/input', value))
        await page.evaluate("window.__outbound = Promise.resolve(); window.acquireVsCodeApi = () => ({postMessage: value => {window.__outbound = window.__outbound.then(() => window.__sideSend(value));}});")
        pumping = True
        async def pump():
            while pumping:
                try:
                    messages = await request('/messages')
                    if messages:
                        await page.evaluate('(messages) => {for (const data of messages) window.postMessage(data, "*")}', messages)
                except Exception:
                    if not pumping: return
                await asyncio.sleep(.015)
        task = asyncio.create_task(pump())
        async def visible_text():
            return await page.locator('.terminal-pane:not([hidden])').inner_text() if await page.locator('.terminal-pane:not([hidden])').count() else ''
        async def contains(text): return text in await visible_text()
        async def output(text, timeout=8): await wait(lambda: contains(text), timeout, detail='visible '+text)
        async def typed(command):
            await page.locator('.tab.active[data-state=running]').wait_for(state='attached',timeout=8000)
            await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus()
            await page.keyboard.insert_text(command)
            await page.keyboard.press('Enter')
        async def count_running(n): return len([s for s in (await stats())['sessions'] if s['state']=='running']) == n
        async def named_tab(name):
            names = await page.locator('.tab-label').all_text_contents()
            return any(value == name or value.startswith(name + ' · ') for value in names)
        async def load_local_page():
            # Browser navigation is restricted in this test environment. Render
            # only our generated HTML in about:blank; never change browser policy.
            def read_html():
                with urllib.request.urlopen(url, timeout=5) as response:
                    return response.read().decode()
            html = await asyncio.to_thread(read_html)
            vendor = (ROOT/'media/vendor/xterm-fit.mjs').read_text()
            vendor = vendor.replace('export{ke as default};', 'const xterm = ke;')
            application = (ROOT/'media/main.js').read_text().replace("import xterm from './vendor/xterm-fit.mjs';", '').replace("import { installFileDrop } from './drop.js';", '').replace("import {installFileDrop} from './drop.js';", '')
            drop_code = (ROOT/'media/drop.js').read_text().replace('export function ', 'function ')
            application = drop_code + '\n' + application
            scripts = (vendor + '\n' + application).replace('</script', '<\\/script')
            nonce = re.search(r'<script nonce="([^"]+)"', html).group(1)
            html = re.sub(r'<link rel="stylesheet" href="[^"]+">', '', html)
            css = (ROOT/'media/vendor/xterm.css').read_text() + (ROOT/'media/style.css').read_text()
            html = html.replace('</head>', '<style>' + css + '</style></head>')
            html = re.sub(r'<script nonce=[^>]+></script>', lambda _: '<script nonce="'+nonce+'" type="module">'+scripts+'</script>', html)
            await page.set_content(html, wait_until='load')
            await asyncio.sleep(.15)
        try:
            await load_local_page()
            await page.evaluate("""() => {
              const colors={'foreground':'#d4d4d4','editor-background':'#181818','editor-foreground':'#d4d4d4','descriptionForeground':'#9c9c9c','focusBorder':'#007fd4','panel-border':'#333333','sideBar-background':'#202020','button-background':'#0e639c','button-foreground':'#ffffff','button-hoverBackground':'#1177bb','toolbar-hoverBackground':'#333333','tab-inactiveForeground':'#969696','tab-activeForeground':'#eeeeee','tab-activeBackground':'#181818','terminal-foreground':'#cccccc','terminal-ansiGreen':'#23d18b','terminal-ansiRed':'#f14c4c','editorGroupHeader-tabsBackground':'#202020','terminal-selectionBackground':'#264f78','notifications-background':'#252526','notifications-foreground':'#cccccc'};
              for (const [k,v] of Object.entries(colors)) document.body.style.setProperty('--vscode-'+k,v);
              document.body.style.setProperty('--vscode-font-family','Arial, sans-serif');
            }""")
            await asyncio.sleep(.15)
            assert (await stats()).get('pid') is None
            assert await page.get_by_text('Tu terminal, a un lado.').is_visible()
            results.append('01 Empty view starts no shell or helper')
            await page.screenshot(path=str(ROOT/'docs/ui-empty.png'))

            await page.get_by_role('button', name='Nueva terminal', exact=True).last.click()
            await wait(lambda: count_running(1), detail='first shell')
            await typed('stty -echo; printf "BROWSER_READY\\n"')
            await output('BROWSER_READY')
            first = (await stats())['sessions'][0]['id']; broker_pid = (await stats())['pid']
            results.append('02 New tab runs a real interactive shell')
            async def widths():
                return await page.evaluate('''() => ({width:document.getElementById('tabs').clientWidth,
                  scroll:document.getElementById('tabs').scrollWidth,
                  tabs:[...document.querySelectorAll('.tab')].map(t=>t.getBoundingClientRect().width)})''')
            sizes=await widths()
            assert abs(sizes['tabs'][0]-sizes['width']) < 2, sizes
            results.append('16 One tab fills all available width')

            await typed("printf '\\033[31mRED_RESULT\\033[0m\\n'; printf 'Español: café 漢字 😀\\n'")
            await output('RED_RESULT'); await output('café')
            assert not errors, errors
            results.append('03 ANSI rendering and Unicode output')

            await typed('export SIDETERM_TEST=A; printf "TAB_ONE_READY\\n"')
            await output('TAB_ONE_READY')
            await page.locator('#new').click(); await wait(lambda: count_running(2), detail='second shell')
            await typed('stty -echo; printf "TAB_TWO=%s\\n" "${SIDETERM_TEST:-unset}"')
            await output('TAB_TWO=unset')
            assert (await stats())['pid'] == broker_pid
            second = (await stats())['sessions'][1]['id']
            await page.locator('[role=tab]').first.click(); await output('TAB_ONE_READY')
            results.append('04 Two independent tabs share one PTY helper')
            sizes=await widths()
            assert len(sizes['tabs'])==2 and max(sizes['tabs'])-min(sizes['tabs']) < 1, sizes
            assert abs(sum(sizes['tabs'])-sizes['width']) < 2, sizes
            await page.locator('#new').click(); await wait(lambda: count_running(3), detail='third shell')
            sizes=await widths()
            assert max(sizes['tabs'])-min(sizes['tabs']) < 1 and abs(sum(sizes['tabs'])-sizes['width']) < 2, sizes
            results.append('17 Two and three tabs divide the width equally')
            await page.locator('#new').click(); await wait(lambda: count_running(4), detail='fourth shell')
            sizes=await widths()
            assert min(sizes['tabs']) >= 140 and sizes['scroll'] > sizes['width'], sizes
            await request('/config', {'tabMinWidth':180})
            await asyncio.sleep(.15)
            sizes=await widths(); assert min(sizes['tabs']) >= 180, sizes
            await page.locator('[role=tab]').last.scroll_into_view_if_needed()
            assert await page.locator('[role=tab]').last.get_by_role('button').is_visible()
            results.append('18 Minimum tab width, overflow and live setting work')
            await request('/config', {'tabMinWidth':140})
            for _ in range(2):
                await page.locator('[role=tab]').last.get_by_role('button').click()
                await asyncio.sleep(.15)
            await wait(lambda: count_running(2), detail='return to two shells')
            await page.locator('[role=tab]').first.click()

            start_cwd = (await stats())['sessions'][0]['cwd']
            actual = Path(start_cwd)/'actual café'; actual.mkdir()
            await typed('cd '+shlex.quote(str(actual)))
            await wait(lambda: named_tab('bash · actual café'),detail='dynamic folder')
            assert str(actual) in await page.locator('[role=tab]').first.get_attribute('title')
            results.append('19 cd updates folder and full-path tooltip in the real UI')
            for program,label in [('opencode','OpenCode'),('claude','Claude')]:
                (actual/program).symlink_to(shutil.which('sleep'))
                await typed('./'+program+' 30')
                await wait(lambda: named_tab(label+' · actual café'),detail='foreground '+label)
                await page.keyboard.press('Control+c')
                await wait(lambda: named_tab('bash · actual café'),detail='return from '+label)
            results.append('20 Controlled OpenCode/Claude executables update names and return to shell')

            # A real generic Node process emits one OSC title (no logged-in AI).
            script=actual/'generic.js'
            script.write_text("process.stdout.write('\\x1b]2;Claude Code\\x07'); setTimeout(()=>{},30000);")
            await typed(shlex.quote(shutil.which('node'))+' '+shlex.quote(str(script)))
            await wait(lambda: named_tab('Claude · actual café'),detail='OSC fallback from generic node')
            await page.keyboard.press('Control+c')
            await wait(lambda: named_tab('bash · actual café'),detail='no stale OSC title after return')
            results.append('21 OSC startup title reaches host without stale shell/process association')
            await page.screenshot(path=str(ROOT/'docs/ui-dynamic-tabs.png'))

            await page.locator('[role=tab]').first.dblclick()
            await wait(lambda: named_tab('Agente principal'), detail='rename')
            results.append('05 Double-click rename updates tab safely')
            await typed('cd '+shlex.quote(start_cwd))
            await wait(lambda: named_tab('Agente principal · '+Path(start_cwd).name),detail='manual alias with dynamic folder')
            await request('/command', {'command':'sideterm.resetName'})
            await wait(lambda: named_tab('bash · '+Path(start_cwd).name),detail='restore automatic title')
            results.append('22 Manual aliases preserve dynamic folder; automatic title can be restored')

            old = (await stats())['sessions'][0]
            await page.set_viewport_size({'width': 660, 'height': 720})
            async def resized():
                value = (await stats())['sessions'][0]
                return value['cols'] != old['cols'] and value['rows'] != old['rows']
            await wait(resized, detail='PTY resize')
            current = (await stats())['sessions'][0]
            await typed('stty size'); await output(f"{current['rows']} {current['cols']}")
            results.append('06 Resize propagates actual dimensions to stty')

            await typed('sleep 30'); await asyncio.sleep(.12)
            await page.keyboard.press('Control+c')
            await typed('printf "AFTER_CTRL_C\\n"'); await output('AFTER_CTRL_C')
            results.append('07 Ctrl+C interrupts the foreground process, not shell')

            await request('/answers', {'clipboard': 'printf "PASTE_ACCEPTED\\n"\n', 'confirm': False})
            await page.locator('#paste').click(); await asyncio.sleep(.15)
            assert 'PASTE_ACCEPTED' not in await visible_text()
            await request('/answers', {'confirm': True})
            await page.locator('#paste').click(); await asyncio.sleep(.2)
            await page.keyboard.press('Enter'); await output('PASTE_ACCEPTED')
            results.append('08 Clipboard path and multiline confirmation')

            await request('/answers', {'clipboard': 'KEEP_CLIPBOARD'})
            await typed("printf '\\033]0;<img src=x onerror=alert(1)>\\007'; printf '\\033]52;c;SEFDS0VE\\007'; printf 'OSC_TEST_DONE\\n'")
            await output('OSC_TEST_DONE')
            assert (await stats())['answers']['clipboard'] == 'KEEP_CLIPBOARD'
            assert await page.locator('img').count() == 0
            results.append('09 OSC 52 blocked; title text never becomes HTML')

            await typed('python3 ' + shlex.quote(str(ROOT/'tests/demo_tui.py')))
            await output('TUI_READY')
            await page.set_viewport_size({'width': 600, 'height': 850})
            await asyncio.sleep(.2); await page.keyboard.press('x')
            await output('TUI_READY'); await page.keyboard.press('q'); await output('TUI_EXIT_OK')
            results.append('10 Curses TUI alternate screen, resize and keyboard')

            # Ask for a real cursor-position report in a non-selected tab.
            await page.locator('[role=tab]').nth(1).click()
            script = "import os,termios,tty,select; old=termios.tcgetattr(0); tty.setraw(0); os.write(1,b'\\x1b[6n'); ok=select.select([0],[],[],2)[0]; data=os.read(0,64) if ok else b'TIMEOUT'; termios.tcsetattr(0,termios.TCSANOW,old); print('DSR_REPLY='+repr(data))"
            await request('/input', {'type':'input','id':first,'text':'python3 -c '+shlex.quote(script)+'\n'})
            await asyncio.sleep(.4)
            await page.locator('[role=tab]').first.click(); await output('DSR_REPLY=')
            assert 'TIMEOUT' not in await visible_text()
            results.append('11 Inactive tab parses output and answers terminal queries')

            await typed("python3 -c \"[print('BULK_%04d'%i) for i in range(4000)]\"")
            await output('BULK_3999', timeout=15)
            async def drained(): return all(s['outstanding'] == 0 for s in (await stats())['sessions'])
            await wait(drained, detail='drained flow control')
            results.append('12 Sustained output drains through bounded output credits')

            await request('/visibility', {'visible':False})
            await request('/input', {'type':'input','id':first,'text':'printf "HIDDEN_OUTPUT_OK\\n"\n'})
            await asyncio.sleep(.2)
            await request('/visibility', {'visible':True}); await output('HIDDEN_OUTPUT_OK')
            assert (await stats())['pid'] == broker_pid
            results.append('13 Visibility event does not close sessions (API fixture)')

            await page.set_viewport_size({'width':510, 'height':860})
            await asyncio.sleep(.2)
            await typed("clear; printf 'SideTerm Local · Terminal lateral\\n\\n'; printf 'Sesión real en Linux / WSL\\nPestañas independientes · Historial acotado\\n\\n'; pwd")
            await output('Pestañas independientes')
            await page.screenshot(path=str(ROOT/'docs/ui-running.png'))

            # Synthetic browser DragEvents, actual app/host code, actual files and PTY.
            await page.evaluate("""() => {window.__dropEvents=[]; window.addEventListener('message',e=>{
              if (['fileDropResult','paste','notice'].includes(e.data?.type)) window.__dropEvents.push(e.data);
            });}""")
            async def drop(entries=None, file_data=None):
                return await page.evaluate("""({entries,files}) => {
                  const dt = new DataTransfer();
                  for(const [k,v] of Object.entries(entries || {})) dt.setData(k,v);
                  for(const file of files || []) dt.items.add(new File([new Uint8Array(file.bytes)], file.name));
                  const target=document.getElementById('terminals');
                  for(const type of ['dragenter','dragover','drop']) {
                    const e=new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt});target.dispatchEvent(e);
                    if(!e.defaultPrevented) throw Error('drop escaped handling: '+type);
                  }
                }""", {'entries': entries or {}, 'files': file_data or []})
            async def pasted_count():
                return await page.evaluate("window.__dropEvents.filter(e=>e.type==='paste').length")
            async def has_pastes(n): return await pasted_count() >= n
            async def capture_prefix(marker):
                await page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea').focus()
                await page.keyboard.insert_text("printf '%s\\n' > "+shlex.quote(str(marker))+" ")
            p1=Path(start_cwd)/"archivo café ' prueba.png";p1.write_bytes(b'image bytes')
            p2=Path(start_cwd)/'second.py';p2.write_text('print(1)')
            marker=Path(start_cwd)/'drop-argv.txt'
            await capture_prefix(marker)
            await drop({'application/vnd.code.uri-list':p1.as_uri()+'\n'+p2.as_uri(),
                        'text/uri-list':p1.as_uri(),
                        'CodeEditors':json.dumps([{'resource':{'scheme':'file','path':'/tmp/EDITOR_ABIERTO_NO_USAR.txt'}}])})
            await wait(lambda:has_pastes(1),detail='paths dropped')
            assert not marker.exists(), 'Drop executed Enter without permission'
            await page.keyboard.press('Enter')
            async def marker_ready(): return marker.exists() and len(marker.read_text().splitlines())==2
            await wait(marker_ready,detail='explicit dropped paths reach shell')
            assert marker.read_text().splitlines()==[str(p1),str(p2)]
            results.append('23 Drag two actual files: only explicit paths, accents/quotes, no active-editor fallback and no automatic Enter')
            before=await pasted_count()
            await drop({'text/plain':'not-a-path'})
            await asyncio.sleep(.15)
            assert await pasted_count()==before
            assert 'No se' in await page.locator('#notice').inner_text()
            results.append('24 Unresolvable drag warns instead of using active file or clipboard')

            await request('/answers',{'confirm':False})
            await drop(file_data=[{'name':'cancel.png','bytes':[1,2,3]}])
            await asyncio.sleep(.2)
            assert await pasted_count()==before
            results.append('25 External File without path requires explicit copy confirmation; cancel sends nothing')
            await request('/answers',{'confirm':True})
            marker2=Path(start_cwd)/'drop-copy-argv.txt'
            await capture_prefix(marker2)
            payload=[i%256 for i in range(65536+137)]
            await drop(file_data=[{'name':'external.bin','bytes':payload}])
            await wait(lambda:has_pastes(before+1),timeout=15,detail='streamed file paste')
            pasted=await page.evaluate("window.__dropEvents.filter(e=>e.type==='paste').at(-1)")
            staged_paths=[Path(x) for x in shlex.split(pasted['text'])]
            assert staged_paths[0].read_bytes()==bytes(payload)
            assert staged_paths[0].stat().st_mode & 0o777 == 0o600
            assert not marker2.exists()
            await page.keyboard.press('Enter')
            async def marker2_ready(): return marker2.exists() and marker2.read_text().strip()==str(staged_paths[0])
            await wait(marker2_ready,detail='copied file path reaches shell')
            results.append('26 OS File streamed in 64 KiB chunks to private temporary copy; exact bytes and path pasted without Enter')
            assert not errors,errors
            await page.screenshot(path=str(ROOT/'docs/ui-file-drop.png'))

            # A view recreation deliberately closes unreachable sessions.
            await page.close()
            page = await browser.new_page(viewport={'width': 510, 'height': 860})
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.expose_binding('__sideSend', lambda source, value: request('/input', value))
            await page.evaluate("window.__outbound = Promise.resolve(); window.acquireVsCodeApi = () => ({postMessage: value => {window.__outbound = window.__outbound.then(() => window.__sideSend(value));}});")
            await load_local_page()
            async def cleared(): return not (await stats())['sessions'] and (await stats()).get('pid') is None
            await wait(cleared, detail='renderer reload cleanup')
            results.append('14 Renderer replacement cleans up processes')
            assert all(not p.exists() for p in staged_paths)
            results.append('27 Renderer/session disposal removes completed temporary copies')

            assert not errors, errors
            results.append('15 No JavaScript errors or CSP violations')
        except Exception:
            (ROOT/'docs/browser-failure-text.txt').write_text(await page.locator('body').inner_text())
            await page.screenshot(path=str(ROOT/'docs/browser-failure.png'))
            raise
        finally:
            pumping = False; await task
            await browser.close()
            proc.terminate(); await asyncio.wait_for(proc.wait(), 4)
    report = {'passed':len(results), 'results':results, 'browser':'Chromium executable on Linux', 'scope':'VS Code APIs mocked; Chromium renders a local inline test bundle in about:blank. Extension code and PTYs are real.', 'errors':errors}
    (ROOT/'docs/browser-test-results.json').write_text(json.dumps(report, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == '__main__': asyncio.run(main())
