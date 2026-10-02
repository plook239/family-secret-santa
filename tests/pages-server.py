"""Local-only Pages artifact test server. Never deploy this file.

Prepare the artifact with `node tests/pages.mjs`, then run this server and open
http://127.0.0.1:8001/pages-browser.html. Test-only HTML injection intercepts API
calls in the harness iframe; it never modifies the artifact or calls Supabase.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PROJECT = Path(__file__).resolve().parent.parent
ARTIFACT_ROOT = PROJECT / '.browser-test' / 'pages-root'
HOOK = "<script>if(parent!==window&&typeof parent.pagesTestFetch==='function'){window.fetch=(...args)=>parent.pagesTestFetch(...args);}</script>"


class PagesHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ARTIFACT_ROOT), **kwargs)

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == '/pages-browser.html':
            source = PROJECT / 'tests' / 'pages-browser.html'
            hook = False
        elif route in ['/family-secret-santa/', '/family-secret-santa/index.html', '/family-secret-santa/admin.html', '/family-secret-santa/reveal.html']:
            source = ARTIFACT_ROOT / route.lstrip('/')
            if source.is_dir():
                source = source / 'index.html'
            hook = True
        else:
            return super().do_GET()
        if not source.is_file():
            self.send_error(404, 'Run node tests/pages.mjs first.')
            return
        html = source.read_text(encoding='utf-8')
        if hook:
            html = html.replace('<head>', '<head>' + HOOK, 1)
        data = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    print('Local Pages path tests: http://127.0.0.1:8001/pages-browser.html', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8001), PagesHandler).serve_forever()
